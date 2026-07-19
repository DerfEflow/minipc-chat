/*
 * Dominion Forge Images END-TO-END self-test — run: node images_test.mjs
 * Boots the REAL server with MULTI_TENANT=1, a mock Ollama, and a MOCK OpenAI images API
 * (OPENAI_IMAGES_BASE), then drives /api/images/* over HTTP with simulated Access identities:
 * the four-gate wall, the content wall on prompts, owner + credit-user generation with real
 * metering math, and the whole batch lifecycle (submit -> poll -> paged collect, charged ONCE).
 * No real OpenAI calls and no API spend.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8700 + Math.floor(process.uptime() * 7) % 200;
const MOCK_OLLAMA = PORT + 1;
const MOCK_OPENAI = PORT + 2;
const OWNER = "owner@test.com";
const USER = "artist@test.com";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// ---- mock Ollama (harmless boot target)
const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

// ---- mock OpenAI: /v1/images/generations, /v1/files, /v1/batches, batch output download
const seen = { generations: [], uploadedJsonl: "", batchCreates: [], batchPolls: 0 };
let batchStatus = "in_progress";
const mockOpenAI = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    const send = (o, code = 200, raw = false) => { res.writeHead(code, { "content-type": raw ? "application/octet-stream" : "application/json" }); res.end(raw ? o : JSON.stringify(o)); };
    if (req.url === "/v1/images/generations" && req.method === "POST") {
      const body = JSON.parse(b);
      seen.generations.push(body);
      const n = body.n || 1;
      return send({ created: 1, data: Array.from({ length: n }, () => ({ b64_json: PNG })), usage: { input_tokens: 12, output_tokens: 272 * n } });
    }
    if (req.url === "/v1/files" && req.method === "POST") {
      seen.uploadedJsonl = b;
      return send({ id: "file-in-1", purpose: "batch" });
    }
    if (req.url === "/v1/batches" && req.method === "POST") {
      seen.batchCreates.push(JSON.parse(b));
      return send({ id: seen.batchCreates.length === 1 ? "batch_mock1" : "batch_mock2", status: "validating" });
    }
    if (req.url === "/v1/batches/batch_mock1" && req.method === "GET") {
      seen.batchPolls++;
      if (batchStatus !== "completed") return send({ id: "batch_mock1", status: batchStatus });
      return send({ id: "batch_mock1", status: "completed", output_file_id: "file-out-1", request_counts: { total: 3, completed: 2, failed: 1 } });
    }
    if (req.url === "/v1/batches/batch_mock2" && req.method === "GET") {
      return send({ id: "batch_mock2", status: "failed" });
    }
    if (req.url === "/v1/files/file-out-1/content" && req.method === "GET") {
      const line = (i) => JSON.stringify({ custom_id: "dfi-" + i, response: { status_code: 200, body: { data: [{ b64_json: PNG }], usage: { input_tokens: 10, output_tokens: 272 } } } });
      const errLine = JSON.stringify({ custom_id: "dfi-2", response: { status_code: 500, body: null }, error: { message: "boom" } });
      return send([line(0), line(1), errLine].join("\n"), 200, true);
    }
    return send({ error: { message: "unexpected mock call " + req.method + " " + req.url } }, 500);
  });
});
await new Promise((r) => mockOpenAI.listen(MOCK_OPENAI, "127.0.0.1", r));

// ---- boot the real server
const dir = mkdtempSync(join(tmpdir(), "dominion-images-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  OPEN_AI_DOMINION_UI_APIKEY: "test-key-not-real",
  OPENAI_IMAGES_BASE: "http://127.0.0.1:" + MOCK_OPENAI,
  OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
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
async function waitForBoot() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}
await waitForBoot();

const balanceOf = async (email) => (await req("GET", "/account", { email })).body.credits.balance;

await t("config publishes the OpenAI tables (tokens, prices, batch discount)", async () => {
  const r = await req("GET", "/api/images/config");
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  if (!r.body.available) throw new Error("not available with key set");
  if (r.body.model !== "gpt-image-2") throw new Error("model: " + r.body.model);
  if (r.body.tokens.high.portrait !== 5500 || r.body.prices.low.square !== 0.006) throw new Error("published tables wrong");
  if (r.body.batch.discount !== 0.5) throw new Error("batch discount wrong");
});

await t("anon is refused (no_identity)", async () => {
  const r = await req("POST", "/api/images/generate", { body: { prompt: "a lighthouse" } });
  if (r.status !== 401 || r.body.code !== "no_identity") throw new Error(r.status + " " + JSON.stringify(r.body));
});

await t("un-invited user is refused (needs_invite)", async () => {
  const r = await req("POST", "/api/images/generate", { email: USER, body: { prompt: "a lighthouse" } });
  if (r.status !== 403 || r.body.code !== "needs_invite") throw new Error(r.status + " " + JSON.stringify(r.body));
});

await t("owner generates 2 images; request carries exact quality/size; usage-based cost", async () => {
  const r = await req("POST", "/api/images/generate", { email: OWNER, body: { prompt: "a brass lighthouse in a storm", quality: "low", aspect: "portrait", n: 2 } });
  if (r.status !== 200) throw new Error("HTTP " + r.status + " " + JSON.stringify(r.body));
  if (r.body.images.length !== 2 || r.body.images[0].b64 !== PNG) throw new Error("images wrong");
  const g = seen.generations.at(-1);
  if (g.model !== "gpt-image-2" || g.quality !== "low" || g.size !== "1024x1536" || g.n !== 2) throw new Error("payload wrong: " + JSON.stringify(g));
  // usage: 12 in * $5/1M + 544 out * $30/1M
  const expect = +(((12 * 5 + 544 * 30) / 1e6)).toFixed(6);
  if (r.body.costUsd !== expect) throw new Error("cost " + r.body.costUsd + " != " + expect);
});

await t("bad inputs are rejected (quality, aspect, empty prompt)", async () => {
  for (const body of [{ prompt: "x", quality: "ultra" }, { prompt: "x", aspect: "panorama" }, { prompt: "" }]) {
    const r = await req("POST", "/api/images/generate", { email: OWNER, body });
    if (r.status !== 400) throw new Error(JSON.stringify(body) + " -> " + r.status);
  }
});

let inviteCode;
await t("credit user activates (mint + redeem + owner credit grant)", async () => {
  const inv = await req("POST", "/admin/codes/mint", { email: OWNER, body: { type: "invite", credits: 0 } });
  inviteCode = inv.body.codes[0].code;
  const red = await req("POST", "/account/redeem", { email: USER, body: { code: inviteCode } });
  if (!red.body.ok) throw new Error("redeem failed: " + JSON.stringify(red.body));
  await req("POST", "/admin/user", { email: OWNER, body: { email: USER, adjustCredits: 300 } });
  if ((await balanceOf(USER)) !== 300) throw new Error("balance not granted");
});

await t("content wall screens image prompts for non-owners (restricted tier)", async () => {
  const r = await req("POST", "/api/images/generate", { email: USER, body: { prompt: "generate erotica of two strangers meeting" } });
  if (r.status !== 403 || r.body.code !== "content_blocked") throw new Error(r.status + " " + JSON.stringify(r.body));
});

await t("credit user is METERED: balance drops by ceil(costUsd*100)", async () => {
  const before = await balanceOf(USER);
  const r = await req("POST", "/api/images/generate", { email: USER, body: { prompt: "a copper gear city", quality: "low", aspect: "square", n: 1 } });
  if (r.status !== 200) throw new Error("HTTP " + r.status + " " + JSON.stringify(r.body));
  const after = await balanceOf(USER);
  const expectCredits = Math.max(1, Math.ceil(r.body.costUsd * 100));
  if (before - after !== expectCredits) throw new Error(`balance ${before}->${after}, expected -${expectCredits}`);
});

await t("batch: too-expensive submission is refused up front (needs_credits)", async () => {
  const items = Array.from({ length: 40 }, () => ({ prompt: "castle", quality: "high", aspect: "landscape" }));
  const r = await req("POST", "/api/images/batch", { email: USER, body: { items } }); // est 40*$0.0825 = $3.30 = 330 credits > balance
  if (r.status !== 402 || r.body.code !== "needs_credits") throw new Error(r.status + " " + JSON.stringify(r.body));
});

let est, submitCharged;
await t("batch submit uploads JSONL, creates the job, and CHARGES AT SUBMIT", async () => {
  const before = await balanceOf(USER);
  const items = [
    { prompt: "a lighthouse at dawn", quality: "medium", aspect: "square" },
    { prompt: "a lighthouse at dusk", quality: "medium", aspect: "square" },
    { prompt: "a lighthouse at night", quality: "medium", aspect: "square" },
  ];
  const r = await req("POST", "/api/images/batch", { email: USER, body: { items } });
  if (r.status !== 200 || r.body.id !== "batch_mock1") throw new Error(r.status + " " + JSON.stringify(r.body));
  est = r.body.estUsd;
  if (est !== +(3 * 0.053 * 0.5).toFixed(6)) throw new Error("estUsd " + est);
  submitCharged = Math.max(1, Math.ceil(est * 100));
  if (r.body.chargedCredits !== submitCharged) throw new Error("chargedCredits " + r.body.chargedCredits);
  const after = await balanceOf(USER);
  if (before - after !== submitCharged) throw new Error(`submit charge ${before}->${after}, expected -${submitCharged}`);
  const lines = seen.uploadedJsonl.split("\n").filter((l) => l.includes("custom_id"));
  if (lines.length !== 3) throw new Error("jsonl lines " + lines.length);
  if (!seen.uploadedJsonl.includes('"url": "/v1/images/generations"') && !seen.uploadedJsonl.includes('"url":"/v1/images/generations"')) throw new Error("jsonl endpoint wrong");
  if (seen.batchCreates.at(-1).endpoint !== "/v1/images/generations") throw new Error("batch endpoint wrong");
});

await t("in-progress batch polls honestly (no images yet, no extra charge)", async () => {
  const before = await balanceOf(USER);
  const r = await req("GET", "/api/images/batch/batch_mock1", { email: USER });
  if (r.status !== 200 || r.body.status !== "in_progress" || r.body.settled) throw new Error(JSON.stringify(r.body));
  if ((await balanceOf(USER)) !== before) throw new Error("poll changed the balance");
});

await t("collection settles ONCE against real usage: overcharge comes back as credits", async () => {
  batchStatus = "completed";
  const before = await balanceOf(USER);
  const p1 = await req("GET", "/api/images/batch/batch_mock1?offset=0&limit=1", { email: USER });
  if (p1.status !== 200 || p1.body.total !== 2 || p1.body.failed !== 1) throw new Error("page1 " + JSON.stringify({ s: p1.status, t: p1.body.total, f: p1.body.failed }));
  if (p1.body.images.length !== 1 || p1.body.done) throw new Error("page1 shape wrong");
  // actual: 2 ok lines * (10*$5 + 272*$30)/1M * 0.5
  const expectCost = +((2 * ((10 * 5 + 272 * 30) / 1e6)) * 0.5).toFixed(6);
  if (Math.abs(p1.body.costUsd - expectCost) > 1e-9) throw new Error("costUsd " + p1.body.costUsd + " != " + expectCost);
  const actualCredits = Math.max(1, Math.ceil(expectCost * 100));
  const expectRefund = submitCharged - actualCredits;
  if (expectRefund <= 0) throw new Error("test premise broken: expected an overcharge to refund");
  if (p1.body.refundedCredits !== expectRefund) throw new Error("refundedCredits " + p1.body.refundedCredits + " != " + expectRefund);
  const afterFirst = await balanceOf(USER);
  if (afterFirst - before !== expectRefund) throw new Error(`refund ${before}->${afterFirst}, expected +${expectRefund}`);
  const p2 = await req("GET", "/api/images/batch/batch_mock1?offset=1&limit=4", { email: USER });
  if (p2.body.images.length !== 1 || !p2.body.done) throw new Error("page2 shape wrong: " + JSON.stringify({ n: p2.body.images.length, done: p2.body.done }));
  if ((await balanceOf(USER)) !== afterFirst) throw new Error("settled twice");
});

await t("a FAILED batch refunds the submit charge in full, once", async () => {
  const before = await balanceOf(USER);
  const items = [{ prompt: "doomed lighthouse", quality: "low", aspect: "square" }];
  const sub = await req("POST", "/api/images/batch", { email: USER, body: { items } });
  if (sub.status !== 200 || sub.body.id !== "batch_mock2") throw new Error(JSON.stringify(sub.body));
  const charged = sub.body.chargedCredits;
  if ((await balanceOf(USER)) !== before - charged) throw new Error("submit charge missing");
  const poll = await req("GET", "/api/images/batch/batch_mock2", { email: USER });
  if (poll.body.status !== "failed" || poll.body.refundedCredits !== charged) throw new Error(JSON.stringify(poll.body));
  if ((await balanceOf(USER)) !== before) throw new Error("full refund missing");
  await req("GET", "/api/images/batch/batch_mock2", { email: USER });
  if ((await balanceOf(USER)) !== before) throw new Error("refunded twice");
});

await t("jobs list is tenant-scoped", async () => {
  const mine = await req("GET", "/api/images/batches", { email: USER });
  if (mine.body.jobs.length !== 2) throw new Error("user should see 2 jobs, saw " + mine.body.jobs.length);
  const owner = await req("GET", "/api/images/batches", { email: OWNER });
  if (owner.body.jobs.length !== 0) throw new Error("owner should see none of the user's jobs");
});

console.log(`\nimages e2e: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
mockOpenAI.close();
process.exit(failed ? 1 : 0);
