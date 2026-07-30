/*
 * BATTALION self-test (ARSENAL Wave 6) — run: node battalion_test.mjs
 * Part 1 unit-tests the swarm engine against a scripted callSeat: the assess gate, the
 * plan/split/synthesize path, announced seat replacement, synthesis-failure stitching, and the
 * all-fail honesty contract. Part 2 checks roster integrity against the live catalog. Part 3
 * boots the REAL server with a MOCK NVIDIA endpoint (NVIDIA_URL) and drives a full swarm turn
 * over /chat: picker row present, privacy refusal, streamed tokens, and the $0 manifest.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createBattalion, extractPlan, historyTail } from "./battalion.mjs";
import { MODELS, BATTALION_ROSTER, battalionRosterIds, BATTALION_COPY } from "./models.catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

/* ================= Part 1: the engine ================= */
function scriptedSeat(script) {
  // script: (catalogId, messages) => { ok, content } — records every call.
  const calls = [];
  return {
    calls,
    callSeat: async (id, messages, opts, onDelta) => {
      calls.push({ id, messages, opts });
      const r = await script(id, messages, calls);
      if (r.ok && onDelta) onDelta(r.content);
      return { transport: "nvidia", usage: null, ...r };
    },
  };
}
const ROSTER = {
  assess: "seat/assess", orchestrator: "seat/orch", synthesizer: "seat/orch",
  single: "seat/single", workers: ["seat/w1", "seat/w2", "seat/w3"],
};

await t("simple ask goes straight to ONE seat — no war council", async () => {
  const s = scriptedSeat(async (id) => ({ ok: true, content: id === "seat/single" ? "the answer" : "WRONG" }));
  const b = createBattalion({ callSeat: s.callSeat, roster: ROSTER, isSimple: () => true });
  let streamed = "";
  const r = await b.run({ question: "what is 2+2", onToken: (d) => streamed += d });
  if (!r.ok || r.manifest.mode !== "single") throw new Error(JSON.stringify(r.manifest));
  if (streamed !== "the answer") throw new Error("streamed: " + streamed);
  if (s.calls.length !== 1 || s.calls[0].id !== "seat/single") throw new Error("calls: " + s.calls.map((c) => c.id).join(","));
});

await t("complex ask: assess -> plan -> parallel parts -> synthesis, manifest true", async () => {
  const s = scriptedSeat(async (id, messages) => {
    if (id === "seat/assess") return { ok: true, content: "COMPLEX" };
    if (id === "seat/orch" && messages.some((m) => /Split the user's request/.test(m.content || ""))) {
      return { ok: true, content: 'Here is the plan: {"parts":[{"title":"Alpha","instructions":"do alpha"},{"title":"Beta","instructions":"do beta"}]}' };
    }
    if (id === "seat/orch") return { ok: true, content: "MERGED: alpha-part beta-part" };   // synthesis
    return { ok: true, content: id + "-output" };                                          // workers
  });
  const b = createBattalion({ callSeat: s.callSeat, roster: ROSTER, isSimple: () => false });
  let streamed = "";
  const q = "Build a full multi-part thing with many sections and files. ".repeat(8);
  const r = await b.run({ question: q, onToken: (d) => streamed += d });
  if (!r.ok) throw new Error(r.error);
  if (r.manifest.mode !== "swarm" || r.manifest.parts !== 2) throw new Error(JSON.stringify(r.manifest));
  if (!/^MERGED/.test(streamed)) throw new Error("synthesis did not stream: " + streamed.slice(0, 60));
  if (r.manifest.models.length < 3) throw new Error("models used: " + r.manifest.models.join(","));
  const workerCalls = s.calls.filter((c) => /seat\/w/.test(c.id));
  if (workerCalls.length !== 2) throw new Error("worker calls: " + workerCalls.length);
});

await t("a failed part is replaced from the bench, ANNOUNCED in the manifest", async () => {
  const s = scriptedSeat(async (id, messages) => {
    if (id === "seat/assess") return { ok: true, content: "COMPLEX" };
    if (id === "seat/orch" && messages.some((m) => /Split the user's request/.test(m.content || ""))) {
      return { ok: true, content: '{"parts":[{"title":"A","instructions":"a"},{"title":"B","instructions":"b"}]}' };
    }
    if (id === "seat/orch") return { ok: true, content: "MERGED" };
    if (id === "seat/w1") return { ok: false, error: "seat exploded" };   // part 1 primary dies
    return { ok: true, content: id + "-output" };
  });
  const b = createBattalion({ callSeat: s.callSeat, roster: ROSTER, isSimple: () => false });
  const r = await b.run({ question: "Big multi part request with lots of details needing a split ".repeat(6), onToken: () => {} });
  if (!r.ok) throw new Error(r.error);
  if (!r.manifest.notes.some((n) => /seat\/w1 failed; seat\/w2 took it over/.test(n))) throw new Error("replacement not announced: " + JSON.stringify(r.manifest.notes));
});

await t("synthesis failure stitches surviving parts as sections, announced", async () => {
  const s = scriptedSeat(async (id, messages) => {
    if (id === "seat/assess") return { ok: true, content: "COMPLEX" };
    if (id === "seat/orch" && messages.some((m) => /Split the user's request/.test(m.content || ""))) {
      return { ok: true, content: '{"parts":[{"title":"A","instructions":"a"},{"title":"B","instructions":"b"}]}' };
    }
    if (id === "seat/orch") return { ok: false, error: "synth died" };
    return { ok: true, content: id + "-output" };
  });
  const b = createBattalion({ callSeat: s.callSeat, roster: ROSTER, isSimple: () => false });
  let streamed = "";
  const r = await b.run({ question: "Another large splittable request with many independent halves ".repeat(6), onToken: (d) => streamed += d });
  if (!r.ok) throw new Error(r.error);
  if (!/## A/.test(streamed) || !/## B/.test(streamed)) throw new Error("parts not stitched: " + streamed.slice(0, 80));
  if (!r.manifest.notes.some((n) => /synthesis seat failed/.test(n))) throw new Error("not announced");
});

await t("every seat dead = honest ok:false, nothing streamed", async () => {
  const s = scriptedSeat(async () => ({ ok: false, error: "lane down" }));
  const b = createBattalion({ callSeat: s.callSeat, roster: ROSTER, isSimple: () => true });
  let streamed = "";
  const r = await b.run({ question: "hello", onToken: (d) => streamed += d });
  if (r.ok) throw new Error("should have failed");
  if (streamed) throw new Error("streamed despite failure: " + streamed);
});

await t("extractPlan survives prose-wrapped JSON, caps parts, rejects garbage", async () => {
  const p = extractPlan('Sure! Here you go: {"parts":[{"title":"T","instructions":"I"}]} hope that helps');
  if (!p || p.parts.length !== 1 || p.parts[0].title !== "T") throw new Error(JSON.stringify(p));
  const many = extractPlan(JSON.stringify({ parts: Array.from({ length: 9 }, (_, i) => ({ title: "t" + i, instructions: "x" })) }));
  if (many.parts.length !== 4) throw new Error("cap failed: " + many.parts.length);
  if (extractPlan("no json here") !== null) throw new Error("garbage accepted");
});

await t("historyTail keeps the most recent turns under the char cap", async () => {
  const h = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "turn " + i + " " + "x".repeat(2000) }));
  const tail = historyTail(h);
  if (tail.length >= 40) throw new Error("no cap applied");
  if (!/turn 39/.test(tail[tail.length - 1].content)) throw new Error("did not keep the most recent");
});

/* ================= Part 2: roster integrity ================= */
await t("every BATTALION seat exists in the catalog and rides a free lane", async () => {
  const byId = new Map(MODELS.map((m) => [m.id, m]));
  for (const id of battalionRosterIds()) {
    const m = byId.get(id);
    if (!m) throw new Error("roster seat not in catalog: " + id);
    if (m.provider !== "nvidia") throw new Error("roster seat not on the free lane: " + id + " (" + m.provider + ")");
  }
  if (!/for free$/.test(BATTALION_COPY)) throw new Error("Fred's copy drifted: " + BATTALION_COPY);
});

/* ================= Part 3: the server, end to end ================= */
const PORT = 8800 + (process.pid * 3) % 180;
const MOCK_OLLAMA = PORT + 1;
const MOCK_NVIDIA = PORT + 2;
const OWNER = "owner@test.com";

const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

// Mock NVIDIA chat-completions: answers by DIRECT id with OpenAI-shaped SSE.
const nvSeen = [];
const mockNvidia = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    const body = JSON.parse(b);
    nvSeen.push(body.model);
    const say = (text) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const CH = 24;
      for (let i = 0; i < text.length; i += CH) {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + CH) }, finish_reason: null }] }) + "\n\n");
      }
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const sys = (body.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (body.model === "openai/gpt-oss-20b" && /Classify the user's request/.test(sys)) return say("COMPLEX");
    if (/Split the user's request/.test(sys)) return say('{"parts":[{"title":"History","instructions":"write the history"},{"title":"Design","instructions":"write the design"}]}');
    if (/one specialist in BATTALION/.test(sys)) return say("PART-CONTENT for " + body.model);
    if (/BATTALION editor/.test(sys)) return say("THE MERGED ANSWER, one voice, both parts included.");
    return say("plain answer from " + body.model);
  });
});
await new Promise((r) => mockNvidia.listen(MOCK_NVIDIA, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "dominion-battalion-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  NVIDIA_API_KEY: "test-nvidia-key", NVIDIA_URL: "http://127.0.0.1:" + MOCK_NVIDIA + "/v1/chat/completions",
  NVIDIA_EMBED_BASE: "http://127.0.0.1:1",   // embed lane dark -> ollama fallback, keeps the test hermetic
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

function req(method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method,
      headers: { "cf-access-authenticated-user-email": OWNER, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } },
      (res) => { let buf = ""; res.on("data", (d) => buf += d); res.on("end", () => resolve({ status: res.statusCode, text: buf })); });
    r.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    if (data) r.write(data); r.end();
  });
}
const sseEvents = (text) => text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);

await (async function waitForBoot() {
  for (let i = 0; i < 150; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
})();

await t("e2e: /api/models carries the BATTALION row with Fred's copy", async () => {
  const r = await req("GET", "/api/models");
  const j = JSON.parse(r.text);
  const g = (j.groups || [])[0];
  if (!g || !/BATTALION/.test(g.category)) throw new Error("battalion group missing: " + JSON.stringify((j.groups || []).map((x) => x.category).slice(0, 3)));
  const m = g.models[0];
  if (m.id !== "battalion" || m.params !== BATTALION_COPY) throw new Error(JSON.stringify(m));
  if (m.inCost || m.outCost) throw new Error("battalion must be free");
});

await t("e2e: trusted privacy mode refuses BATTALION honestly", async () => {
  const r = await req("POST", "/chat", { body: { model: "battalion", privacyMode: "trusted", messages: [{ role: "user", content: "hi" }] } });
  const evs = sseEvents(r.text);
  const err = evs.find((e) => e.type === "error");
  if (!err || err.code !== "privacy_mode_block") throw new Error(JSON.stringify(evs.slice(0, 4)));
});

await t("e2e: a complex turn convenes the swarm and returns the $0 manifest", async () => {
  const question = "Please produce a two-part deliverable: first a detailed history of the forge, second a full design proposal for its replacement. Make both parts thorough and independent, suitable for splitting between specialists. " +
    "Cover the following requirement in depth, with sections, sub-sections, examples, and edge cases spelled out in full detail. ".repeat(40);
  const r = await req("POST", "/chat", { body: { model: "battalion", messages: [{ role: "user", content: question }], chatId: "bt-e2e-1" } });
  const evs = sseEvents(r.text);
  const route = evs.find((e) => e.type === "route");
  if (!route || route.model !== "battalion") throw new Error("no battalion route event");
  const text = evs.filter((e) => e.type === "token").map((e) => e.delta).join("");
  if (!/MERGED ANSWER/.test(text)) throw new Error("synthesis did not reach the stream: " + text.slice(0, 120));
  const done = evs.find((e) => e.type === "done");
  if (!done || !done.meta || !done.meta.battalion) throw new Error("no manifest on done");
  const mf = done.meta.battalion;
  if (done.meta.costUsd !== 0) throw new Error("battalion billed: " + done.meta.costUsd);
  if (mf.mode !== "swarm" || mf.parts !== 2 || mf.models.length < 2) throw new Error(JSON.stringify(mf));
  // The wire really carried the roster's direct ids (assess + orchestrator + workers + synth).
  if (!nvSeen.includes("openai/gpt-oss-20b") || !nvSeen.includes("nvidia/nemotron-3-ultra-550b-a55b")) throw new Error("seats on the wire: " + [...new Set(nvSeen)].join(","));
});

console.log(`\nbattalion: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
mockNvidia.close();
process.exit(failed ? 1 : 0);
