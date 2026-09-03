/*
 * GX10 relay first-token watchdog + rung-3 fallback -- EXECUTION test. Run: node gx10_watchdog_test.mjs
 *
 * Lead follow-up (2026-09-03 production evidence): a chat on gx10/gpt-oss-120b through the hands
 * relay produced NO first token for 150s and the client aborted, because gx10HandsChatStream had
 * no watchdog of its own (unlike cloudChatStream's generic branch) and the hub's own dispatch
 * deadline runs up to 10 minutes with no interim "queued" signal.
 *
 * Two scenarios, both against a REAL booted server.mjs with a REAL hands hub (no mocked fetch --
 * the hands relay is inbound SSE, so this test plays a minimal fake hands NODE that speaks the
 * hub's real wire protocol: GET /hands/stream?node=<name> to connect, event:"job" frames arrive on
 * that stream, POST /hands/result would answer one. hands/hub.mjs and hands/hands.mjs are NOT
 * touched or imported here -- this is a from-scratch client using only documented endpoints):
 *
 *   1. NODE CONNECTED BUT NEVER ANSWERS ("queued behind another job"): the fake node connects,
 *      receives the job event, and simply never posts a result or streams a chunk. Proves the
 *      round loop falls back to the next seat within ~10s (the watchdog ceiling), not 30s and
 *      nowhere near the hub's own 590s dispatch deadline.
 *   2. NODE NOT CONNECTED AT ALL: no fake node ever connects. Proves the hub's synchronous
 *      "not connected" check reaches the fallback ladder near-instantly, not the current time bill
 *      of a single provider-specific error, and without waiting on any watchdog timer.
 *
 * Both must end with a `served` event naming the fallback seat and zero `error` events -- the
 * spec's exact requirement: a busy or unreachable GX10 must never end a turn in silence or error.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8975, MOCK = 8976;
const OWNER = "owner@gx10watch.local";
const HANDS_TOKEN = "gx10-watchdog-test-token";
const GX10_NODE = "gx10";
const dataDir = mkdtempSync(join(tmpdir(), "gx10watch-"));
let passed = 0;
const ok = (n) => { console.log("  ok  " + n); passed++; };

// ---- mock "deepseek" provider: the fallback target (gx10/gpt-oss-120b -> deepseek/deepseek-v4-pro
// per chatfailover.mjs) always answers cleanly and fast. ----
const requestLog = [];
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(b || "{}"); } catch {}
    requestLog.push({ model: body.model, ts: Date.now() });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "FALLBACK-FROM-DEEPSEEK " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "the GX10 seat did not answer in time." }, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  });
});
await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));

const env = {
  ...process.env,
  PORT: String(APP), HOST: "127.0.0.1",
  DATA_DIR: dataDir, MEMORY_DIR: join(dataDir, "memory"), CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"), PERSONA_DIR: join(dataDir, "corpus"),
  PERSONA_STAGING: join(dataDir, "staging"), FLYWHEEL_DIR: join(dataDir, "flywheel"),
  LOG_DIR: join(dataDir, "logs"), SANDBOX_DIR: join(dataDir, "sandbox"), CHATJOBS_DIR: join(dataDir, "chatjobs"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", BILLING_RETRY_ENABLED: "0",
  OPENROUTER_CAPS_WARM_ENABLED: "0",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER, ACCESS_JWT: "prefer",
  // The hands relay is enabled (HANDS_TOKEN set) but no real hands node connects except the fake
  // one this test drives itself for scenario 1. GX10_LLM_URL stays unset so cloudChatStream routes
  // gx10 models through the relay (gx10HandsChatStream), exactly the path the lead's report named.
  HANDS_TOKEN, GX10_NODE,
  DEEPSEEK_URL: `http://127.0.0.1:${MOCK}`, DEEPSEEK_AI_DOMINION_UI_APIKEY: "test-key-not-real",
  OLLAMA_URL: "http://127.0.0.1:1",
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "",
  MOONSHOT_API_KEY: "", NVIDIA_API_KEY: "", STRIPE_SECRET_KEY: "",
};

const server = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
let serverExited = null;
server.on("exit", (code) => { serverExited = code; });

let fakeNodeReq = null;
function cleanup() {
  try { fakeNodeReq && fakeNodeReq.destroy(); } catch {}
  try { server.kill(); } catch {}
  try { mock.close(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  if (serverExited !== null) break;
  try {
    const r = await fetch(`http://127.0.0.1:${APP}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) up = true;
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) {
  console.error("server never came up. Log:\n" + serverLog.slice(-2000));
  cleanup(); process.exit(1);
}

/* A minimal fake hands node: connects over the hub's real SSE wire protocol, then goes silent --
 * receives whatever the hub sends (the "job" event included) and never posts a result. This is
 * exactly "the box is busy/queued" from the hub's point of view: the connection is healthy, a job
 * was handed to it, and nothing ever comes back. */
function connectFakeStuckNode() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: APP, path: `/hands/stream?node=${GX10_NODE}`, method: "GET",
        headers: { authorization: "Bearer " + HANDS_TOKEN } },
      (res) => {
        if (res.statusCode !== 200) { reject(new Error("fake node connect failed: HTTP " + res.statusCode)); return; }
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("event: hb") && !resolve.__fired) { resolve.__fired = true; resolve(req); }
          // event: job frames are read and silently discarded -- the whole point of this node.
        });
        res.on("error", () => {});
      }
    );
    req.on("error", reject);
    req.end();
    fakeNodeReq = req;
  });
}

async function turn(body, { email = OWNER, ms = 20000 } = {}) {
  const headers = { "content-type": "application/json", "cf-access-authenticated-user-email": email };
  const events = [], detail = {};
  let streamError = null, answer = "";
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${APP}/chat`, { method: "POST", headers, body: JSON.stringify(body) });
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = "", t1 = Date.now();
    while (Date.now() - t1 < ms) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const o = JSON.parse(line.slice(5));
          events.push(o);
          if (o.type === "served") detail.served = o;
          if (o.type === "error") detail.error = o;
          if (o.type === "token" && o.delta) answer += o.delta;
          if (o.type === "done") detail.done = o;
        } catch { /* partial frame */ }
      }
      if (events.some((e) => e.type === "done" || e.type === "stopped" || e.type === "error")) break;
    }
    try { reader.cancel(); } catch {}
  } catch (e) { streamError = String(e && e.message || e); }
  return { events, detail, answer, streamError, elapsedMs: Date.now() - t0 };
}

const TYPES = (evs) => evs.map((e) => e.type);

// ---- 1. Node connected, receives the job, never answers. Must fall back at the ~10s watchdog
//         ceiling, not the 30s generic default and nowhere near the hub's own 590s deadline. ----
{
  await connectFakeStuckNode();
  requestLog.length = 0;
  const t = await turn({ messages: [{ role: "user", content: "what should I check on an old roof" }], model: "gx10/gpt-oss-120b", mode: "normal" });
  assert.equal(t.streamError, null, "stream error: " + t.streamError);
  assert.ok(!t.events.some((e) => e.type === "error"), `a busy GX10 must never surface an error event, got: ${TYPES(t.events).join(",")}`);
  assert.ok(t.detail.served, "expected a served event announcing the fallback seat");
  assert.ok(/^deepseek\//.test(String(t.detail.served.model)), "served event named the wrong fallback model: " + t.detail.served.model);
  assert.match(t.answer, /FALLBACK-FROM-DEEPSEEK/, "the visible answer did not come from the fallback seat");
  assert.ok(t.detail.done, "turn must still reach a normal done event, not a checkpoint/error stop");
  assert.ok(t.elapsedMs < 15000, `expected the watchdog to fire near its 10s ceiling, took ${t.elapsedMs}ms (would be ~30s+ on the generic default, or minutes on the hub's own 590s dispatch deadline)`);
  ok(`a GX10 node that accepted the job but never answered falls back within the watchdog ceiling (${t.elapsedMs}ms, not 30s/590s)`);
  try { fakeNodeReq && fakeNodeReq.destroy(); } catch {}
  fakeNodeReq = null;
}

// ---- 2. Node never connects at all ("not connected"). Must fall back near-instantly, not wait
//         for any watchdog timer -- the hub's own synchronous check already knows. ----
{
  requestLog.length = 0;
  const t = await turn({ messages: [{ role: "user", content: "quick roofing question" }], model: "gx10/gpt-oss-120b", mode: "normal" });
  assert.equal(t.streamError, null, "stream error: " + t.streamError);
  assert.ok(!t.events.some((e) => e.type === "error"), `an unreachable GX10 must never surface an error event, got: ${TYPES(t.events).join(",")}`);
  assert.ok(t.detail.served, "expected a served event announcing the fallback seat");
  assert.ok(/^deepseek\//.test(String(t.detail.served.model)), "served event named the wrong fallback model: " + t.detail.served.model);
  assert.match(t.answer, /FALLBACK-FROM-DEEPSEEK/, "the visible answer did not come from the fallback seat");
  assert.ok(t.elapsedMs < 5000, `"not connected" must be treated as an immediate pre-token failure, took ${t.elapsedMs}ms`);
  ok(`a GX10 node that was never connected falls back near-instantly (${t.elapsedMs}ms), no watchdog wait needed`);
}

assert.equal(serverExited, null, "the server process exited during the run (code " + serverExited + "). Log tail:\n" + serverLog.slice(-1200));
assert.ok(!/ReferenceError|is not defined|before initialization/.test(serverLog), "server logged a ReferenceError during the run");

cleanup();
console.log(`\ngx10_watchdog_test: ${passed} passed, 0 failed`);
process.exit(0);
