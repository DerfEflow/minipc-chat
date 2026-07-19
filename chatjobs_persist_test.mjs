/*
 * Durable-across-restart self-test — run with: node chatjobs_persist_test.mjs
 * Boots the REAL server.mjs against a MOCK Ollama, then KILLS and REBOOTS it on the SAME data dirs
 * to prove the durability the in-RAM job map alone can't give:
 *   P1. a run that finished while the client was away survives a hard server restart: after reboot,
 *       /chat/attach?from=0 replays the whole answer and ends done; /chat/result returns it too.
 *   P2. a run still generating when the server dies comes back ORPHANED after reboot: attach yields
 *       the preserved partial + a server_restart error + stopped (what the client renders as an
 *       interrupted answer with a Continue affordance) — never a silent disappearance.
 *   P3. a post-restart attach with a stale from>N cursor still reconstructs the full text exactly
 *       (reset + compacted replay), no gap, no duplication.
 *   P4. the durable store lets a second concurrent run start (owner is exempt from the per-user cap)
 *       — i.e. concurrency isn't accidentally blocked by the new gate.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 18818, MOCK_PORT = 18819;

let passed = 0, failed = 0;
async function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

// ---- mock Ollama ----
const mock = { delayMs: 400, answer: "" };
const mockSrv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    if (req.url === "/api/chat") {
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { role: "assistant", content: mock.answer }, prompt_eval_count: 12, eval_count: 80, total_duration: 1e9 }));
      }, mock.delayMs);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
});
await new Promise((r) => mockSrv.listen(MOCK_PORT, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "dominion-chatjobs-persist-"));
const baseEnv = {
  ...process.env,
  PORT: String(PORT),
  OLLAMA_URL: "http://127.0.0.1:" + MOCK_PORT,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"),
  DATA_DIR: join(dir, "data"), CHATJOBS_DIR: join(dir, "chatjobs"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  SYNC_SECRET: "test", RUN_PASSWORD: "",
};

let child = null;
function boot(extraEnv = {}) {
  const c = spawn(process.execPath, [join(HERE, "server.mjs")], { env: { ...baseEnv, ...extraEnv }, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", () => {}); c.stderr.on("data", () => {});
  return c;
}
async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/toolruns" }, (rs) => { rs.resume(); r(rs.statusCode === 200); });
      rq.on("error", () => r(false));
    });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up");
}
async function hardRestart(extraEnv) {
  await new Promise((r) => { child.on("exit", r); child.kill("SIGKILL"); });
  await new Promise((r) => setTimeout(r, 300));
  child = boot(extraEnv); await waitForBoot();
}

// ---- SSE + JSON helpers ----
function sseRequest(path, { method = "GET", body = null, onEvent = null } = {}) {
  return new Promise((resolve) => {
    let settled = false; const finish = (o) => { if (!settled) { settled = true; resolve(o); } };
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let buf = ""; const events = [];
      res.on("data", (d) => {
        buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          const s = line.trim(); if (!s.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
          events.push(ev);
          if (onEvent && onEvent(ev, events) === false) { req.destroy(); finish({ events, killed: true }); return; }
        }
      });
      res.on("end", () => finish({ events, killed: false }));
      res.on("error", () => finish({ events, killed: true }));
    });
    req.on("error", () => finish({ events: [], killed: true }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
function getJson(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on("error", () => resolve({ status: 0, body: {} }));
  });
}
const tokenText = (events) => events.filter((e) => e.type === "token").map((e) => e.delta).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child = boot(); await waitForBoot();

// ================= P1: finished run survives a hard restart =================
mock.delayMs = 300;
mock.answer = "Persisted answer that must survive a server reboot. ".repeat(30);
const expected1 = mock.answer.trim();
let jobId1 = null;
await sseRequest("/chat", {
  method: "POST",
  body: { messages: [{ role: "user", content: "persist me" }], mode: "normal", model: "auto", chatId: "pchat1" },
  onEvent: (ev, events) => { if (ev.type === "job") jobId1 = ev.id; if (events.filter((e) => e.type === "token").length >= 3) return false; },   // die mid-stream
});
// Let it finish server-side, then confirm the durable store shows it done.
for (let i = 0; i < 60; i++) { const j = (await getJson("/chat/jobs?chatId=pchat1")).body.jobs || []; if (j[0] && j[0].status === "done") break; await sleep(200); }

await hardRestart();

await t("P1: after a hard restart, /chat/attach?from=0 replays the whole finished answer", async () => {
  const r = await sseRequest("/chat/attach?job=" + jobId1 + "&from=0");
  assert.equal(r.killed, false);
  assert.equal(r.events[0].type, "job", "replay opens with the buffered job event");
  assert.equal(tokenText(r.events), expected1, "full answer reconstructed from the DB");
  assert.ok(r.events.some((e) => e.type === "done"), "ends done");
  assert.equal(r.events[r.events.length - 1].type, "cursor", "DB replay closes with a cursor");
});
await t("P1b: /chat/result returns the finished answer after restart", async () => {
  const r = await getJson("/chat/result?job=" + jobId1);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "done");
  assert.equal(r.body.text.trim(), expected1);
});
await t("P1c: /chat/jobs lists the restored job for its chat", async () => {
  const r = await getJson("/chat/jobs?chatId=pchat1");
  assert.ok((r.body.jobs || []).some((j) => j.id === jobId1 && j.status === "done"));
});

// ================= P3: stale from>N cursor after restart -> reset + exact rebuild =================
await t("P3: attach with a mid-answer cursor after restart reconstructs consistently, no dup", async () => {
  // Depending on where `from` lands, the server either slices cleanly (returns the suffix from that
  // cursor) or, if the cursor straddles a coalesced token row, resets and re-sends from zero. Both
  // are correct — what must never happen is duplicated or garbled text. Assert the invariant that
  // holds either way: the returned token text is a non-empty suffix of the full answer (a reset
  // returns the whole thing, which is a suffix of itself).
  const r = await sseRequest("/chat/attach?job=" + jobId1 + "&from=4");
  const txt = tokenText(r.events);
  assert.ok(txt.length > 0 && expected1.endsWith(txt), "clean-slice suffix or full reset, never a dup");
  if (r.events.some((e) => e.type === "reset")) assert.equal(txt, expected1, "a reset must resend the entire answer");
  // Whatever the mode, the replay ends with the authoritative resume cursor.
  assert.equal(r.events[r.events.length - 1].type, "cursor");
});

// ================= P2: run in flight when the server dies comes back orphaned =================
mock.delayMs = 60000;   // the model would take a minute — we kill the server first
mock.answer = "never returns";
let jobId2 = null;
await sseRequest("/chat", {
  method: "POST",
  body: { messages: [{ role: "user", content: "orphan me" }], mode: "normal", model: "auto", chatId: "pchat2" },
  onEvent: (ev) => { if (ev.type === "job") { jobId2 = ev.id; return false; } },   // grab id, drop socket; run keeps going
});
// Make sure it's registered as running before we pull the plug.
for (let i = 0; i < 40; i++) { const j = (await getJson("/chat/jobs?chatId=pchat2")).body.jobs || []; if (j[0] && j[0].status === "running") break; await sleep(150); }

await hardRestart();

await t("P2: a run interrupted by restart is orphaned, not lost", async () => {
  const jobs = (await getJson("/chat/jobs?chatId=pchat2")).body.jobs || [];
  const j = jobs.find((x) => x.id === jobId2);
  assert.ok(j, "the orphaned job is still listed");
  assert.equal(j.status, "orphaned");
});
await t("P2b: attaching the orphan yields the server_restart explanation + stopped", async () => {
  const r = await sseRequest("/chat/attach?job=" + jobId2 + "&from=0");
  assert.equal(r.killed, false);
  assert.ok(r.events.some((e) => e.type === "error" && e.code === "server_restart"), "carries the honest restart error");
  assert.ok(r.events.some((e) => e.type === "stopped"), "sealed with stopped (client keeps the partial, offers Continue)");
});

// ================= P4: concurrency isn't accidentally blocked (owner exempt) =================
await t("P4: two runs in different chats generate concurrently", async () => {
  mock.delayMs = 500; mock.answer = "concurrent";
  const p1 = sseRequest("/chat", { method: "POST", body: { messages: [{ role: "user", content: "one" }], mode: "normal", model: "auto", chatId: "cc1" } });
  const p2 = sseRequest("/chat", { method: "POST", body: { messages: [{ role: "user", content: "two" }], mode: "normal", model: "auto", chatId: "cc2" } });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1.events.some((e) => e.type === "done"), "first run completed");
  assert.ok(r2.events.some((e) => e.type === "done"), "second concurrent run completed (not refused)");
  assert.ok(!r1.events.some((e) => e.type === "error" && e.code === "too_many_jobs"));
  assert.ok(!r2.events.some((e) => e.type === "error" && e.code === "too_many_jobs"));
});

// ================= P5: RAM tail spill -> compacted catch-up from the durable store =================
// Reboot with a tiny RAM tail so a normal-length answer overflows it; a cursor that fell off the
// tail must still reconstruct the whole answer (mode-2 replay: reset + DB compaction, in-RAM job).
await hardRestart({ CHATJOBS_TAIL: "8" });
await t("P5: a cursor that fell off the RAM tail rebuilds the full answer (reset + compaction)", async () => {
  mock.delayMs = 300; mock.answer = "Tail spill answer segment. ".repeat(40);
  const expected5 = mock.answer.trim();
  let jobId5 = null;
  const r0 = await sseRequest("/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "spill" }], mode: "normal", model: "auto", chatId: "pchat5" },
    onEvent: (ev) => { if (ev.type === "job") jobId5 = ev.id; },
  });
  assert.ok(r0.events.some((e) => e.type === "done"), "the run finished (record stays in RAM with a spilled tail)");
  // from=2 is now well behind tailStart (tail capped at 8 over dozens of token events).
  const r = await sseRequest("/chat/attach?job=" + jobId5 + "&from=2");
  assert.ok(r.events.some((e) => e.type === "reset"), "fell off the tail -> reset");
  assert.equal(tokenText(r.events), expected5, "compacted DB catch-up rebuilds the whole answer exactly once");
  assert.ok(r.events.some((e) => e.type === "cursor"), "resync cursor emitted");
  assert.ok(r.events.some((e) => e.type === "done"), "still ends done");
});

// ---- teardown ----
child.kill(); mockSrv.close();
await sleep(300);
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nchatjobs_persist_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
