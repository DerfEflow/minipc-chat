/*
 * Chat-turn smoke test - run with: node chat_smoke_test.mjs
 *
 * WHY THIS EXISTS. On 2026-07-20 I shipped a ReferenceError into handleChat: a `let` was read
 * twenty lines before its own declaration, so EVERY chat turn threw on entry and the socket died
 * with no events. It reached production and sat there. Ten test suites and 105 checks were green
 * the whole time, because not one of them ever sent a message to the app.
 *
 * /api/version kept answering 200 the entire outage, because it never enters handleChat. That is
 * the trap this file exists to close: liveness is not function. A health check that cannot tell
 * the difference between "the process is up" and "the product works" is a health check that will
 * one day tell you everything is fine while nothing is.
 *
 * So this boots a REAL server against a mock Ollama and sends REAL turns down /chat, asserting:
 *   1. an anonymous turn is refused cleanly (job -> error:no_identity -> stopped), not by dying
 *   2. an owner turn reaches a terminal event rather than a dead socket
 *   3. the Wildfire branches fire - this is the exact code path that crashed
 *   4. THE SERVER IS STILL ALIVE at the end
 *
 * Check 4 is the load-bearing one. The bug killed the process outright; a crash-on-entry cannot
 * hide from "is it still running".
 *
 * No cloud API keys needed. The model call fails for want of a key, which is fine: an `error`
 * event is a terminal event and proves the turn got all the way through routing, the Wildfire
 * gate, context assembly, and out the other side.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8971, MOCK = 8972;
const OWNER = "owner@smoke.local", GUEST = "guest@smoke.local";
const dataDir = mkdtempSync(join(tmpdir(), "chatsmoke-"));
let passed = 0;
const ok = (n) => { console.log("  ok  " + n); passed++; };

// Mock Ollama so boot and any local call is harmless and instant.
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/api/chat"
      ? JSON.stringify({ message: { role: "assistant", content: "mock reply" }, eval_count: 3 })
      : "{}");
  });
});
await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));

const env = {
  ...process.env,
  PORT: String(APP), HOST: "127.0.0.1", OLLAMA_URL: "http://127.0.0.1:" + MOCK,
  DATA_DIR: dataDir, MEMORY_DIR: join(dataDir, "memory"), CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"), PERSONA_DIR: join(dataDir, "corpus"),
  PERSONA_STAGING: join(dataDir, "staging"), FLYWHEEL_DIR: join(dataDir, "flywheel"),
  LOG_DIR: join(dataDir, "logs"), SANDBOX_DIR: join(dataDir, "sandbox"),
  CHATJOBS_DIR: join(dataDir, "chatjobs"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER, ACCESS_JWT: "prefer",
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "",
  DEEPSEEK_AI_DOMINION_UI_APIKEY: "", STRIPE_SECRET_KEY: "", HANDS_TOKEN: "",
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

// Wait for boot.
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

/* Send one turn and collect its SSE event types. Returns after a terminal event or the deadline.
 * A dead socket with no terminal event is the exact signature of a crash inside handleChat. */
async function turn(body, { email = null, ms = 20000 } = {}) {
  const headers = { "content-type": "application/json" };
  if (email) headers["cf-access-authenticated-user-email"] = email;
  const events = [], detail = {};
  let streamError = null;
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
          events.push(o.type);
          if (o.type === "wildfire") detail.wildfire = o;
          if (o.type === "error") detail.error = o;
        } catch { /* partial frame */ }
      }
      if (events.some((e) => e === "done" || e === "stopped" || e === "error")) break;
    }
    try { reader.cancel(); } catch {}
  } catch (e) { streamError = String(e && e.message || e); }
  return { events, detail, streamError };
}

const TERMINAL = (evs) => evs.some((e) => e === "done" || e === "stopped" || e === "error");

// 1. Anonymous: refused cleanly. A crash and a refusal look identical from outside unless you
//    check that the refusal actually ARRIVED as an event.
{
  const t = await turn({ messages: [{ role: "user", content: "ping" }] });
  assert.equal(t.streamError, null, "anonymous turn should not error the stream: " + t.streamError);
  assert.ok(t.events.length > 0, "anonymous turn returned NO events - handleChat almost certainly threw");
  assert.ok(t.events.includes("job"), "expected a job event, got: " + t.events.join(","));
  assert.ok(TERMINAL(t.events), "no terminal event, got: " + t.events.join(","));
  assert.equal(t.detail.error && t.detail.error.code, "no_identity", "expected a clean no_identity refusal");
  ok("anonymous turn is refused cleanly (job -> error:no_identity -> stopped)");
}

// 2. Owner: the turn runs all the way through. THIS is the check that was missing.
{
  const t = await turn({ messages: [{ role: "user", content: "hello" }] }, { email: OWNER });
  assert.equal(t.streamError, null, "owner turn stream error: " + t.streamError);
  assert.ok(t.events.length > 0, "owner turn returned NO events - handleChat threw on entry");
  assert.ok(t.events.includes("job"), "expected a job event, got: " + t.events.join(","));
  assert.ok(TERMINAL(t.events), "owner turn never reached a terminal event: " + t.events.join(","));
  ok("owner turn reaches a terminal event (handleChat runs end to end)");
}

// 3. Wildfire, armed on a model that is not on the roster. This is the precise code that crashed:
//    the block reads forgeExtra, and reading it too early is what took production down.
{
  const t = await turn({ messages: [{ role: "user", content: "build the project" }],
                         model: "mistralai/mistral-nemo", wildfire: true }, { email: OWNER });
  assert.ok(t.events.includes("wildfire"), "expected a wildfire event, got: " + t.events.join(","));
  assert.equal(t.detail.wildfire.kind, "blocked", "arming a non-rostered model must be blocked");
  assert.match(t.detail.wildfire.text, /roster/i, "the refusal should explain why");
  assert.match(t.detail.wildfire.text, /Claude Opus 4\.8/, "and name the models that qualify");
  ok("Wildfire refuses to arm on a non-rostered model, and says which ones qualify");
}

// 4. The nudge: rostered model, machine work asked for, Wildfire left off.
{
  const t = await turn({ messages: [{ role: "user", content: "go fix the build on my laptop" }],
                         model: "anthropic/claude-opus-4-8" }, { email: OWNER });
  assert.ok(t.events.includes("wildfire"), "expected the nudge, got: " + t.events.join(","));
  assert.equal(t.detail.wildfire.kind, "nudge");
  ok("Wildfire nudges when a starred model is asked for machine work unarmed");
}

// 5. Ordinary conversation stays quiet. A nudge that cries wolf gets switched off in a day.
{
  const t = await turn({ messages: [{ role: "user", content: "what is a good name for a cat" }],
                         model: "anthropic/claude-opus-4-8" }, { email: OWNER });
  assert.ok(!t.events.includes("wildfire"), "the nudge must not fire during ordinary chat");
  ok("no Wildfire nudge during ordinary conversation");
}

// 6. A guest cannot arm Wildfire even by posting the flag directly.
{
  const t = await turn({ messages: [{ role: "user", content: "build the project" }],
                         model: "anthropic/claude-opus-4-8", wildfire: true }, { email: GUEST });
  const armed = t.detail.wildfire && t.detail.wildfire.armed === true;
  assert.ok(!armed, "a guest must never end up armed");
  ok("a guest posting wildfire:true is never armed");
}

// 7. THE LOAD-BEARING CHECK. A crash inside handleChat killed the process outright. If the server
//    is still serving after all of the above, it did not throw its way out of the room.
{
  assert.equal(serverExited, null, "the server process EXITED during the run (code " + serverExited + "). Log tail:\n" + serverLog.slice(-1200));
  const r = await fetch(`http://127.0.0.1:${APP}/api/version`, { signal: AbortSignal.timeout(5000) });
  assert.equal(r.ok, true, "server stopped answering after the turns");
  assert.ok(!/ReferenceError|is not defined|before initialization/.test(serverLog),
    "the server logged a ReferenceError during the run:\n" + (serverLog.match(/.*(?:ReferenceError|before initialization).*/g) || []).join("\n"));
  ok("server survived every turn with no ReferenceError in its log");
}

cleanup();
console.log(`\nchat_smoke_test: ${passed} passed, 0 failed`);
process.exit(0);
