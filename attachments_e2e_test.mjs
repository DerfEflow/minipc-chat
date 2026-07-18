/*
 * Attachments END-TO-END self-test — run: node attachments_e2e_test.mjs
 * Boots the REAL server (MULTI_TENANT=1, mock Ollama) plus a MOCK OpenRouter endpoint that
 * records every request body and streams a canned SSE completion. Proves, over real HTTP:
 *   - a picture on a vision-flagged model leaves the server as OpenAI multimodal parts
 *     (image_url data URL preserved, text part present) and the answer streams back;
 *   - text-file attachments inline as fenced blocks for ANY model;
 *   - a picture on a non-vision model is refused (attachments_unsupported) BEFORE any
 *     provider call (hit counter stays flat), never silently dropped or substituted;
 *   - the invite gate still fires before the vision gate for un-invited guests;
 *   - the sanitizer strips oversized/bad-mime attachments and non-user attachments;
 *   - history pruning caps carried pixels at 12 images, older ones become honest markers;
 *   - a plain no-attachment chat is byte-identical string content (regression).
 * No real cloud calls, no keys, no cost.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8700 + Math.floor(process.uptime() * 7) % 200;
const MOCK_OLLAMA = PORT + 1;
const MOCK_OR = PORT + 2;
const OWNER = "owner@test.com";
const VISION_MODEL = "qwen/qwen3-vl-8b-instruct";        // openrouter, vision:true, toolCapable (category)
const TEXT_MODEL = "qwen/qwen3-235b-a22b-2507";          // openrouter, no vision
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- mock Ollama (harmless boot + any local utility call) ----
const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

// ---- mock OpenRouter: records bodies, streams a canned SSE completion ----
const orBodies = [];
const mockOr = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    try { orBodies.push(JSON.parse(b)); } catch { orBodies.push({ parseError: b.slice(0, 200) }); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"Seen."}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":5}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mockOr.listen(MOCK_OR, "127.0.0.1", r));

// ---- boot the real server ----
const dir = mkdtempSync(join(tmpdir(), "dominion-att-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  OPENROUTER_API_KEY: "test-key-attachments", OPENROUTER_URL: "http://127.0.0.1:" + MOCK_OR + "/v1/chat/completions",
  OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", DEEPSEEK_AI_DOMINION_UI_APIKEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

const H = (email) => (email ? { "cf-access-authenticated-user-email": email } : {});
function req(method, path, { email = "", body = null } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...H(email) } },
      (res) => { let b = ""; res.on("data", (d) => b += d); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j }); }); });
    r.on("error", () => resolve({ status: 0, body: null }));
    if (data) r.write(data); r.end();
  });
}
// POST /chat, gather the full SSE event list.
function chat(email, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const evs = []; let done = false;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...H(email) } },
      (res) => { let buf = ""; res.on("data", (d) => { buf += d; const ls = buf.split("\n"); buf = ls.pop() || ""; for (const l of ls) { const s = l.trim(); if (!s.startsWith("data:")) continue; try { evs.push(JSON.parse(s.slice(5).trim())); } catch {} } }); res.on("end", () => { done = true; resolve(evs); }); });
    r.on("error", () => resolve(evs));
    r.write(data); r.end();
    setTimeout(() => { if (!done) { try { r.destroy(); } catch {} resolve(evs); } }, 15000);
  });
}
const codesOf = (evs) => evs.filter((e) => e.type === "error").map((e) => e.code || "provider_error");
const tokensOf = (evs) => evs.filter((e) => e.type === "token").map((e) => e.delta).join("");

async function waitForBoot() {
  for (let i = 0; i < 150; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}

try {
  await waitForBoot();

  await t("catalog payload carries verified vision flags", async () => {
    const r = await req("GET", "/api/models", { email: OWNER });
    const all = (r.body.groups || []).flatMap((g) => g.models);
    const vl = all.find((m) => m.id === VISION_MODEL), q235 = all.find((m) => m.id === TEXT_MODEL);
    assert(vl && vl.vision === true, "qwen3-vl should be vision:true");
    assert(q235 && q235.vision === false, "qwen3-235b should be vision:false");
  });

  await t("picture + vision model -> multimodal parts reach the provider, answer streams", async () => {
    const before = orBodies.length;
    const evs = await chat(OWNER, { model: VISION_MODEL, mode: "normal", messages: [
      { role: "user", content: "What is in this picture?", attachments: [{ kind: "image", name: "tiny.png", mime: "image/png", dataUrl: PNG }] },
    ] });
    assert(orBodies.length === before + 1, "provider should be called exactly once, saw " + (orBodies.length - before));
    const msgs = orBodies[orBodies.length - 1].messages;
    const user = msgs[msgs.length - 1];
    assert(Array.isArray(user.content), "user content should be a parts array");
    const img = user.content.find((p) => p.type === "image_url");
    assert(img && img.image_url && img.image_url.url === PNG, "image_url part must carry the exact data URL");
    const txt = user.content.find((p) => p.type === "text");
    assert(txt && txt.text.includes("What is in this picture?"), "text part must carry the prompt");
    assert(tokensOf(evs).includes("Seen."), "the canned answer should stream back");
    assert(evs.some((e) => e.type === "done"), "done meta should arrive");
  });

  await t("text file inlines as a fenced block on a NON-vision model (string content)", async () => {
    const before = orBodies.length;
    const evs = await chat(OWNER, { model: TEXT_MODEL, mode: "normal", messages: [
      { role: "user", content: "Summarize the file.", attachments: [{ kind: "text", name: "notes.md", text: "alpha bravo charlie" }] },
    ] });
    assert(orBodies.length === before + 1, "provider should be called once");
    const user = orBodies[orBodies.length - 1].messages.slice(-1)[0];
    assert(typeof user.content === "string", "content must stay a plain string for text-only models");
    assert(user.content.includes("[Attached file: notes.md]") && user.content.includes("alpha bravo charlie"), "fenced file block missing");
    assert(evs.some((e) => e.type === "done"), "done should arrive");
  });

  await t("picture + NON-vision model -> honest refusal, zero provider calls, zero charge", async () => {
    const before = orBodies.length;
    const evs = await chat(OWNER, { model: TEXT_MODEL, mode: "normal", messages: [
      { role: "user", content: "look", attachments: [{ kind: "image", name: "tiny.png", mime: "image/png", dataUrl: PNG }] },
    ] });
    assert(codesOf(evs).includes("attachments_unsupported"), "expected attachments_unsupported, got " + JSON.stringify(codesOf(evs)));
    assert(orBodies.length === before, "provider must NOT be called on a refused turn");
    const err = evs.find((e) => e.type === "error");
    assert(/can't view pictures/i.test(err.message || ""), "refusal should explain itself");
  });

  await t("picture + LOCAL model -> honest refusal (local has no vision)", async () => {
    const evs = await chat(OWNER, { model: "auto", mode: "fast", messages: [
      { role: "user", content: "look", attachments: [{ kind: "image", name: "tiny.png", mime: "image/png", dataUrl: PNG }] },
    ] });
    assert(codesOf(evs).includes("attachments_unsupported"), "expected attachments_unsupported for local, got " + JSON.stringify(codesOf(evs)));
  });

  await t("no-attachment chat unchanged: plain string content (regression)", async () => {
    const before = orBodies.length;
    const evs = await chat(OWNER, { model: TEXT_MODEL, mode: "normal", messages: [{ role: "user", content: "plain hello" }] });
    assert(orBodies.length === before + 1, "provider called once");
    const user = orBodies[orBodies.length - 1].messages.slice(-1)[0];
    assert(user.content === "plain hello", "string content must pass through byte-identical");
    assert(tokensOf(evs).includes("Seen."), "answer streams");
  });

  await t("invite gate fires BEFORE the vision gate for un-invited guests", async () => {
    const evs = await chat("stranger@test.com", { model: VISION_MODEL, mode: "normal", messages: [
      { role: "user", content: "hi", attachments: [{ kind: "image", name: "tiny.png", mime: "image/png", dataUrl: PNG }] },
    ] });
    const codes = codesOf(evs);
    assert(codes.includes("needs_invite"), "expected needs_invite, got " + JSON.stringify(codes));
    assert(!codes.includes("attachments_unsupported"), "vision gate must not leapfrog the invite gate");
  });

  await t("sanitizer strips bad mime + oversized + non-user attachments", async () => {
    const before = orBodies.length;
    const bigFake = "data:image/png;base64," + "A".repeat(9 * 1024 * 1024);   // ~6.75MB decoded, over cap
    const evs = await chat(OWNER, { model: VISION_MODEL, mode: "normal", messages: [
      { role: "assistant", content: "prior answer", attachments: [{ kind: "image", name: "sneak.png", mime: "image/png", dataUrl: PNG }] },
      { role: "user", content: "check these", attachments: [
        { kind: "image", name: "vector.svg", mime: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
        { kind: "image", name: "huge.png", mime: "image/png", dataUrl: bigFake },
        { kind: "weird", name: "x", payload: "??" },
      ] },
    ] });
    assert(orBodies.length === before + 1, "provider called once");
    const body = orBodies[orBodies.length - 1];
    const flat = JSON.stringify(body.messages);
    assert(!flat.includes("svg"), "svg data must be stripped");
    assert(!flat.includes(bigFake.slice(30, 60)), "oversized image must be stripped");
    assert(!flat.includes("image_url") , "nothing should survive as an image part");
    assert(evs.some((e) => e.type === "done"), "turn still completes as plain text");
  });

  await t("history pruning: only the newest 12 pictures ride as pixels, older become markers", async () => {
    const before = orBodies.length;
    const imgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ kind: "image", name: tag + "-" + i + ".png", mime: "image/png", dataUrl: PNG }));
    const evs = await chat(OWNER, { model: VISION_MODEL, mode: "normal", messages: [
      { role: "user", content: "batch one", attachments: imgs(4, "one") },
      { role: "assistant", content: "ok1" },
      { role: "user", content: "batch two", attachments: imgs(4, "two") },
      { role: "assistant", content: "ok2" },
      { role: "user", content: "batch three", attachments: imgs(4, "three") },
      { role: "assistant", content: "ok3" },
      { role: "user", content: "batch four", attachments: imgs(2, "four") },
    ] });
    assert(orBodies.length === before + 1, "provider called once");
    const body = orBodies[orBodies.length - 1];
    let parts = 0; let markers = 0;
    for (const m of body.messages) {
      if (Array.isArray(m.content)) parts += m.content.filter((p) => p.type === "image_url").length;
      const txt = Array.isArray(m.content) ? (m.content.find((p) => p.type === "text") || {}).text || "" : String(m.content || "");
      markers += (txt.match(/no longer carried in context/g) || []).length;
    }
    assert(parts === 12, "expected exactly 12 image parts, got " + parts);
    assert(markers === 2, "expected 2 pruned-image markers, got " + markers);
    assert(evs.some((e) => e.type === "done"), "turn completes");
  });

  await t("/api/ocr: owner happy path — per-page vision calls, page tags, honesty note", async () => {
    const before = orBodies.length;
    const r = await req("POST", "/api/ocr", { email: OWNER, body: { name: "scan.pdf", privacyMode: "normal", pages: [PNG, PNG] } });
    assert(r.status === 200, "expected 200, got " + r.status + " " + JSON.stringify(r.body));
    assert(orBodies.length === before + 2, "one provider call per page (got " + (orBodies.length - before) + ")");
    const call = orBodies[orBodies.length - 1];
    assert(call.model === "qwen/qwen3-vl-8b-instruct", "normal-mode OCR should use the cheap vision model");
    const user = call.messages.find((m) => m.role === "user");
    assert(Array.isArray(user.content) && user.content.some((p) => p.type === "image_url"), "page image must reach the provider");
    assert(JSON.stringify(call.messages).includes("Transcribe ALL text"), "OCR instruction missing");
    assert(r.body.text.includes("[Page 1 of 2]") && r.body.text.includes("[Page 2 of 2]"), "page tags missing");
    assert(r.body.text.includes("Transcribed from a scanned PDF"), "honesty note missing");
    assert(r.body.text.includes("Seen."), "mock transcription should appear");
    assert(typeof r.body.costUsd === "number", "cost must be reported");
  });

  await t("/api/ocr: Private mode refuses (no cloud OCR), zero provider calls", async () => {
    const before = orBodies.length;
    const r = await req("POST", "/api/ocr", { email: OWNER, body: { name: "scan.pdf", privacyMode: "private", pages: [PNG] } });
    assert(r.status === 403 && r.body.code === "privacy_mode_block", "expected privacy refusal, got " + r.status + " " + JSON.stringify(r.body));
    assert(orBodies.length === before, "no provider call in private mode");
  });

  await t("/api/ocr: un-invited guest is refused before any spend", async () => {
    const before = orBodies.length;
    const r = await req("POST", "/api/ocr", { email: "stranger@test.com", body: { name: "scan.pdf", privacyMode: "normal", pages: [PNG] } });
    assert(r.status === 403 && r.body.code === "needs_invite", "expected needs_invite, got " + r.status + " " + JSON.stringify(r.body));
    assert(orBodies.length === before, "no provider call for gated guests");
  });

  await t("/api/ocr: page cap holds and junk pages are stripped", async () => {
    const before = orBodies.length;
    const fourteen = Array.from({ length: 14 }, () => PNG);
    const r = await req("POST", "/api/ocr", { email: OWNER, body: { name: "big.pdf", privacyMode: "normal", pages: fourteen } });
    assert(r.status === 200, "expected 200, got " + r.status);
    assert(r.body.pages === 12, "cap should trim to 12 pages, got " + r.body.pages);
    assert(orBodies.length === before + 12, "exactly 12 provider calls");
    const junk = await req("POST", "/api/ocr", { email: OWNER, body: { name: "junk.pdf", privacyMode: "normal", pages: ["data:image/svg+xml;base64,PHN2Zz4=", 42] } });
    assert(junk.status === 400, "all-junk pages should 400, got " + junk.status);
  });

  await t("/estimate prices pictures in and mirrors the vision gate", async () => {
    const ok = await req("POST", "/estimate", { email: OWNER, body: { model: VISION_MODEL, mode: "normal", images: 2, messages: [{ role: "user", content: "hi" }] } });
    assert(ok.body && ok.body.backend === "cloud", "vision estimate should be a normal cloud estimate");
    assert(ok.body.tokensIn > 2200, "two pictures should add ~2200 estimated tokens, got " + ok.body.tokensIn);
    const blocked = await req("POST", "/estimate", { email: OWNER, body: { model: TEXT_MODEL, mode: "normal", images: 1, messages: [{ role: "user", content: "hi" }] } });
    assert(blocked.body && blocked.body.backend === "blocked" && blocked.body.blocked === "attachments_unsupported", "estimate must mirror the gate");
  });

} finally {
  try { child.kill(); } catch {}
  try { mockOllama.close(); mockOr.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
