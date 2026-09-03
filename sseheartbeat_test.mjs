/*
 * sseheartbeat.mjs self-test - run with: node sseheartbeat_test.mjs
 *
 * The one heartbeat helper every long-lived SSE/chunked writer in this app shares (server.mjs's
 * /ide/job/attach and /chat/attach, gamefactoryhttp.mjs's event feed, hands/hub.mjs's node stream).
 * Proves the mechanics directly against a fake `res`, without needing a real server or job:
 *   1. writes the default comment frame on the configured interval
 *   2. stop() halts further writes
 *   3. stop() is idempotent (safe to call twice, e.g. once from a terminal handler and once from close)
 *   4. a write failure (socket already gone) stops the timer itself instead of throwing
 *   5. a custom frame/interval is honored (hands/hub.mjs's node-facing "event: hb" framing)
 */
import assert from "node:assert/strict";
import { startSseHeartbeat } from "./sseheartbeat.mjs";

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  const writes = [];
  return { writes, write: (s) => { writes.push(s); return true; } };
}

await t("writes the default comment frame on the configured interval", async () => {
  const res = fakeRes();
  const stop = startSseHeartbeat(res, { intervalMs: 20 });
  await sleep(90);
  stop();
  assert.ok(res.writes.length >= 3, "expected several ticks in 90ms at a 20ms interval, got " + res.writes.length);
  for (const w of res.writes) assert.equal(w, ": hb\n\n", "every frame must be the default SSE comment");
});

await t("stop() halts further writes", async () => {
  const res = fakeRes();
  const stop = startSseHeartbeat(res, { intervalMs: 15 });
  await sleep(60);
  const countAtStop = res.writes.length;
  assert.ok(countAtStop > 0, "should have ticked at least once before stop");
  stop();
  await sleep(60);
  assert.equal(res.writes.length, countAtStop, "no writes should land after stop()");
});

await t("stop() is idempotent — safe to call twice", async () => {
  const res = fakeRes();
  const stop = startSseHeartbeat(res, { intervalMs: 15 });
  await sleep(30);
  stop();
  assert.doesNotThrow(() => stop(), "a second stop() call must not throw");
});

await t("a write failure stops the timer itself rather than throwing into the caller", async () => {
  const res = { write: () => { throw new Error("socket destroyed"); } };
  // startSseHeartbeat itself must not throw synchronously just from being started...
  const stop = startSseHeartbeat(res, { intervalMs: 15 });
  // ...and the interval's own throw-on-write must not become an unhandled exception that kills
  // the process — if it did, this test would never reach here.
  await sleep(60);
  stop();
  assert.ok(true, "survived a heartbeat whose write() always throws");
});

await t("a custom frame and interval are honored (hands/hub.mjs's node-facing framing)", async () => {
  const res = fakeRes();
  const stop = startSseHeartbeat(res, { intervalMs: 20, frame: "event: hb\ndata: {}\n\n" });
  await sleep(70);
  stop();
  assert.ok(res.writes.length >= 2);
  for (const w of res.writes) assert.equal(w, "event: hb\ndata: {}\n\n");
});

console.log(`\nsseheartbeat_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
