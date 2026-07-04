/*
 * Durable chat-job self-test — run with: node chatjobs_test.mjs
 * Boots the REAL server.mjs (child process, temp data dirs) against a MOCK slow Ollama and proves:
 *   1. /chat emits {type:"job"} first, then streams tokens
 *   2. killing the client socket mid-stream does NOT kill the turn — the job completes
 *      server-side (attach replay ends with done, full answer intact)
 *   3. /chat/attach?from=N replays exactly events[N..]; pre-kill deltas + resumed deltas
 *      reassemble the complete answer with no gap and no duplication
 *   4. unknown job -> one {type:"gone"} event, then end
 *   5. POST /chat/stop aborts the in-flight model call (mock sees the upstream abort) and
 *      seals the job with a stopped event, long before the mock's delay elapses
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 18808, MOCK_PORT = 18809;

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

// ---- mock Ollama: /api/chat answers after a configurable delay (the "slow model") ----
const mock = { delayMs: 600, answer: "", inflightAborted: false };
const mockSrv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    if (req.url === "/api/chat") {
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { role: "assistant", content: mock.answer }, prompt_eval_count: 12, eval_count: 80, total_duration: 1e9 }));
      }, mock.delayMs);
      res.on("close", () => { clearTimeout(timer); if (!res.writableEnded) mock.inflightAborted = true; });
      return;
    }
    // /api/embed and anything else: harmless empty JSON (retrieval degrades to lexical)
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => mockSrv.listen(MOCK_PORT, "127.0.0.1", r));

// ---- boot the real server against the mock, with all data dirs in a temp sandbox ----
const dir = mkdtempSync(join(tmpdir(), "dominion-chatjobs-test-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  OLLAMA_URL: "http://127.0.0.1:" + MOCK_PORT,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  SYNC_SECRET: "test", RUN_PASSWORD: "",
};
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = "";
child.stdout.on("data", (d) => (bootLog += d));
child.stderr.on("data", (d) => (bootLog += d));

async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/toolruns" }, (rs) => { rs.resume(); r(rs.statusCode === 200); });
      rq.on("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}

// ---- tiny SSE client: collect events; onEvent can return false to kill the socket mid-stream ----
function sseRequest(path, { method = "GET", body = null, onEvent = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        let buf = ""; const events = [];
        res.on("data", (d) => {
          buf += d.toString();
          const lines = buf.split("\n"); buf = lines.pop() || "";
          for (const line of lines) {
            const s = line.trim(); if (!s.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
            events.push(ev);
            if (onEvent && onEvent(ev, events) === false) { req.destroy(); finish({ events, killed: true }); return; }
          }
        });
        res.on("end", () => finish({ events, killed: false }));
        res.on("error", () => finish({ events, killed: true }));
      }
    );
    req.on("error", () => finish({ events: [], killed: true }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
function postJson(path, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on("error", () => resolve({ status: 0, body: {} }));
    req.write(JSON.stringify(body)); req.end();
  });
}

await waitForBoot();

// ================= scenario A: kill the client mid-stream, then reattach =================
// mode:"normal" skips the light-model router; explicit long answer -> ~1.8s of token chunking.
mock.delayMs = 600;
mock.answer = "The quick brown fox jumps over the lazy dog. ".repeat(140);   // ~6300 chars
const expected = mock.answer.trim();   // the server trims via stripThink()

let jobId = null, preKillCount = 0;
const r1 = await sseRequest("/chat", {
  method: "POST",
  body: { messages: [{ role: "user", content: "durable job test" }], mode: "normal", model: "auto", chatId: "testchat1" },
  onEvent: (ev, events) => {
    if (ev.type === "job") jobId = ev.id;
    if (events.filter((e) => e.type === "token").length >= 5) { preKillCount = events.length; return false; }   // die mid-stream
  },
});

await t("A1: /chat emits {type:\"job\"} first and streams tokens", () => {
  assert.ok(jobId, "job id arrived");
  assert.equal(r1.events[0].type, "job");
  assert.ok(r1.killed, "client socket was killed mid-stream");
  assert.ok(preKillCount > 5);
  assert.ok(!r1.events.some((e) => e.type === "done"), "we died before done");
});

// Attach immediately (job very likely still generating): replay from 0 + live-tail to the end.
const r2 = await sseRequest("/chat/attach?job=" + jobId + "&from=0");
await t("A2: job completed server-side despite the dead client (attach from=0 replays all -> done)", () => {
  assert.equal(r2.killed, false, "attach stream ended cleanly");
  assert.equal(r2.events[0].type, "job", "replay starts at the very first buffered event");
  assert.ok(r2.events.some((e) => e.type === "done"), "buffer contains done");
  const text = r2.events.filter((e) => e.type === "token").map((e) => e.delta).join("");
  assert.equal(text, expected, "the full answer was generated and buffered");
});

await t("A3: reattach from index N resumes exactly where the dead client left off", async () => {
  const r3 = await sseRequest("/chat/attach?job=" + jobId + "&from=" + preKillCount);
  const pre = r1.events.filter((e) => e.type === "token").map((e) => e.delta).join("");
  const post = r3.events.filter((e) => e.type === "token").map((e) => e.delta).join("");
  assert.equal(pre + post, expected, "no gap, no duplication");
  assert.equal(r3.events.length, r2.events.length - preKillCount, "exactly the missed events");
  assert.equal(r3.events[r3.events.length - 1].type, "done");
});

await t("A4: tail replay returns exactly the requested slice", async () => {
  const from = r2.events.length - 3;
  const r4 = await sseRequest("/chat/attach?job=" + jobId + "&from=" + from);
  assert.deepEqual(r4.events.map((e) => e.type), r2.events.slice(from).map((e) => e.type));
});

await t("B: unknown job -> {type:\"gone\"} then end", async () => {
  const r = await sseRequest("/chat/attach?job=job_doesnotexist&from=0");
  assert.deepEqual(r.events, [{ type: "gone" }]);
});

// ================= scenario C: explicit stop aborts the in-flight model call =================
mock.delayMs = 20000;   // the model would take 20s — stop must cut it off
mock.answer = "this should never arrive";
mock.inflightAborted = false;
let jobId2 = null;
const t0 = Date.now();
const r5 = await sseRequest("/chat", {
  method: "POST",
  body: { messages: [{ role: "user", content: "slow one to stop" }], mode: "normal", model: "auto", chatId: "testchat2" },
  onEvent: (ev) => {
    if (ev.type === "job") { jobId2 = ev.id; setTimeout(() => postJson("/chat/stop", { jobId: ev.id }), 400); }
  },
});
const elapsed = Date.now() - t0;

await t("C1: /chat/stop seals the turn with a stopped event, fast", () => {
  assert.ok(jobId2, "second job id arrived");
  assert.equal(r5.killed, false, "stream ended cleanly (server closed it)");
  assert.ok(r5.events.some((e) => e.type === "stopped"), "stopped event emitted: " + r5.events.map((e) => e.type).join(","));
  assert.ok(!r5.events.some((e) => e.type === "done"), "never claimed completion");
  assert.ok(elapsed < 10000, "ended in " + elapsed + "ms, not the mock's 20s");
});

await t("C2: the abort reached the in-flight upstream model call", () => {
  assert.equal(mock.inflightAborted, true, "mock saw its /api/chat request destroyed");
});

await t("C3: the stopped job's buffer is sealed and replayable", async () => {
  const r = await sseRequest("/chat/attach?job=" + jobId2 + "&from=0");
  assert.equal(r.killed, false);
  assert.equal(r.events[r.events.length - 1].type, "stopped");
});

await t("C4: /chat/stop on a finished job answers alreadyDone; unknown job 404s", async () => {
  const a = await postJson("/chat/stop", { jobId: jobId2 });
  assert.equal(a.status, 200); assert.equal(a.body.alreadyDone, true);
  const b = await postJson("/chat/stop", { jobId: "job_doesnotexist" });
  assert.equal(b.status, 404);
});

// ---- teardown ----
child.kill();
mockSrv.close();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\nchatjobs_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
