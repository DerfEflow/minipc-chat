/*
 * Cross-model fallback ladder — EXECUTION test. Run: node chatfailover_ladder_test.mjs
 *
 * chatfailover_test.mjs already locks the pure DECISION function (pickFallbackModel): given a
 * dead seat, which model does Dominion hand the turn to next. This file locks the part that
 * actually matters to a user — that server.mjs's /chat round loop WIRES that decision in
 * correctly (lane/chat required behavior #1, acceptance criteria: "pre-token failure falls back
 * with no error event (mocked fetch)" and "mid-stream failure continues on fallback").
 *
 * Both scenarios below reuse deepseek/deepseek-v4-pro -> deepseek/deepseek-v4-flash, the first
 * entry in chatfailover.mjs's CHAT_SEAT_FALLBACKS map. Both models resolve to the SAME provider
 * ("deepseek"), so one mock HTTP server standing in for DEEPSEEK_URL can play every rung: it
 * reads `model` out of the posted JSON body and answers accordingly. Neither scenario triggers
 * server.mjs's own same-seat retry schedule, widen-pool, or same-model OpenRouter reroute (all of
 * those require either a retryable-shaped error or an OpenRouter-carried/OPENROUTER_FALLBACK_
 * PROVIDERS-listed provider, neither of which applies to a plain deepseek 400 or a premature
 * stream end) — so both turns fall straight through to the rung-3 cross-model fallback this lane
 * added, with no sleeps, so this file runs fast and deterministically.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8973, MOCK = 8974;
const OWNER = "owner@ladder.local";
const dataDir = mkdtempSync(join(tmpdir(), "chatladder-"));
let passed = 0;
const ok = (n) => { console.log("  ok  " + n); passed++; };

// ---- mock "deepseek" provider: behavior keyed by which model was requested ----
// scenario is swapped between the two tests below; requestLog records every hit for inspection.
let scenario = "pretoken";
const requestLog = [];
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(b || "{}"); } catch {}
    requestLog.push({ model: body.model, messages: body.messages });
    const isPro = body.model === "deepseek-v4-pro";
    const isFlash = body.model === "deepseek-v4-flash";

    if (scenario === "pretoken" && isPro) {
      // The exact production error text from DEFICIENCIES.md item 6, verbatim. A plain 400 with
      // no "system"/network/overload wording so server.mjs's own retryableProviderError() reads
      // it as NOT retryable -> zero same-seat retries -> straight to the rung-3 fallback below.
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
    }
    if (scenario === "midstream" && isPro) {
      // Stream two content deltas, THEN close with no finish_reason at all — the exact production
      // shape from DEFICIENCIES.md item 6 ("stream ended before finish reason"). content is
      // non-empty, so this resolves with { ok:false, partial:true, ... }.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "the roof inspection found " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "three areas of concern" } }] })}\n\n`);
      return res.end();   // no finish_reason, no [DONE] — a dead wire mid-answer
    }
    if (isFlash) {
      // The fallback seat: always answers cleanly, whichever scenario is running.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "FALLBACK-ANSWER " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "served the seat that was actually up." }, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }
    // Anything unexpected: fail loudly rather than hang the test.
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unexpected mock call: " + body.model } }));
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
  // deepseek is the ONLY reachable cloud lane: its URL points at the mock, its key is a harmless
  // dummy (just needs to be non-empty), and every other provider is keyless so nothing else could
  // possibly answer this turn if the fallback wiring were broken.
  DEEPSEEK_URL: `http://127.0.0.1:${MOCK}`, DEEPSEEK_AI_DOMINION_UI_APIKEY: "test-key-not-real",
  OLLAMA_URL: "http://127.0.0.1:1", // no local model either — the cloud fallback ladder must be what saves this turn
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "",
  MOONSHOT_API_KEY: "", NVIDIA_API_KEY: "", STRIPE_SECRET_KEY: "", HANDS_TOKEN: "",
};

const server = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
let serverExited = null;
server.on("exit", (code) => { serverExited = code; });

function cleanup() {
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

async function turn(body, { email = OWNER, ms = 20000 } = {}) {
  const headers = { "content-type": "application/json", "cf-access-authenticated-user-email": email };
  const events = [], detail = {};
  let streamError = null, answer = "";
  try {
    const r = await fetch(`http://127.0.0.1:${APP}/chat`, { method: "POST", headers, body: JSON.stringify(body) });
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = "", t0 = Date.now();
    while (Date.now() - t0 < ms) {
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
  return { events, detail, answer, streamError };
}

const TYPES = (evs) => evs.map((e) => e.type);

// ---- 1. PRE-TOKEN failure: deepseek-v4-pro refuses before a single token, on-catalog fallback
//         (deepseek-v4-flash) answers cleanly. Acceptance: no error event, a served event names
//         the seat that actually answered, and the answer text is the fallback seat's own text. ----
{
  scenario = "pretoken";
  requestLog.length = 0;
  const t = await turn({ messages: [{ role: "user", content: "what did the inspection find" }], model: "deepseek/deepseek-v4-pro", mode: "normal" });
  assert.equal(t.streamError, null, "stream error: " + t.streamError);
  assert.ok(!t.events.some((e) => e.type === "error"), `pre-token fallback must never surface an error event, got: ${TYPES(t.events).join(",")}`);
  assert.ok(t.detail.served, "expected a served event announcing the fallback seat");
  assert.equal(t.detail.served.model, "deepseek/deepseek-v4-flash", "served event named the wrong model");
  assert.equal(t.detail.served.provider, "deepseek", "served event named the wrong provider");
  assert.match(t.answer, /FALLBACK-ANSWER/, "the visible answer did not come from the fallback seat");
  assert.ok(t.detail.done, "turn must still reach a normal done event, not a checkpoint/error stop");
  assert.equal(requestLog.filter((r) => r.model === "deepseek-v4-pro").length, 1, "the dead seat should be tried exactly once before falling back (no wasted retries on a non-retryable 400)");
  ok("pre-token failure falls back to the next seat with no error event (mocked deepseek 400 -> deepseek-v4-flash)");
}

// ---- 2. MID-STREAM failure: deepseek-v4-pro streams two chunks then dies with no finish_reason.
//         The fallback call must receive the partial text folded into the transcript as a
//         "continue exactly from here" notice, and the final visible answer must contain BOTH the
//         partial piece and the fallback's continuation — never an error, never a restart. ----
{
  scenario = "midstream";
  requestLog.length = 0;
  const t = await turn({ messages: [{ role: "user", content: "summarize the inspection" }], model: "deepseek/deepseek-v4-pro", mode: "normal" });
  assert.equal(t.streamError, null, "stream error: " + t.streamError);
  assert.ok(!t.events.some((e) => e.type === "error"), `mid-stream fallback must never surface an error event, got: ${TYPES(t.events).join(",")}`);
  assert.ok(t.detail.served, "expected a served event announcing the fallback seat");
  assert.equal(t.detail.served.model, "deepseek/deepseek-v4-flash", "served event named the wrong model");
  assert.match(t.answer, /the roof inspection found three areas of concern/, "the partial text streamed before the crash must survive into the visible answer");
  assert.match(t.answer, /FALLBACK-ANSWER/, "the continuation from the fallback seat must also be visible");
  assert.ok(t.detail.done, "turn must still reach a normal done event, not a checkpoint/error stop");
  const flashCall = requestLog.find((r) => r.model === "deepseek-v4-flash");
  assert.ok(flashCall, "the fallback seat was never called");
  const msgs = (flashCall.messages || []).map((m) => String(m.content || "")).join(" | ");
  assert.match(msgs, /the roof inspection found three areas of concern/, "the partial assistant text was not folded into the transcript handed to the fallback seat");
  assert.match(msgs, /[Cc]ontinue exactly from here/, "the fallback seat was not told this is a continuation, not a fresh turn");
  ok("mid-stream failure continues on the fallback model from the exact cutoff, no restart, no error event");
}

assert.equal(serverExited, null, "the server process exited during the run (code " + serverExited + "). Log tail:\n" + serverLog.slice(-1200));

cleanup();
console.log(`\nchatfailover_ladder_test: ${passed} passed, 0 failed`);
process.exit(0);
