/*
 * Rolling task pool self-test - run: node idepool_test.mjs
 * This is the scheduling truth of the build engine (server.mjs imports it), so the properties
 * Fred's 2026-08-03 audit demanded are proven here against the REAL code, not a mirror:
 *   1. rolling starts: a dep-satisfied task starts while an unrelated slow task still runs
 *   2. the cookie rule at run time: file-sharing tasks never run concurrently
 *   3. failure forks: retry re-runs failed tasks, skip abandons them honestly, stop stops
 *   4. two-strike: a task that keeps failing is not offered for retry forever
 *   5. dependents of a failed task never start, and are reported skipped with the reason
 *   6. abort and carve drain without starting anything new
 *   7. the gate caps concurrent entries and preserves FIFO wake order
 */
import assert from "node:assert/strict";
import { runTaskPool, createGate } from "./idepool.mjs";

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A task set: 1 is slow and independent; 2 is fast; 3 needs only 2. Under the old wave
// barrier, 3 could never start until 1 finished. Under the pool it must.
await t("a task starts the moment its needs are done, even while an unrelated task still runs", async () => {
  const log = [];
  const pool = await runTaskPool({
    tasks: [
      { n: 1, title: "slow", files: ["a"], needs: [] },
      { n: 2, title: "fast", files: ["b"], needs: [] },
      { n: 3, title: "needs fast", files: ["c"], needs: [2] },
    ],
    runTask: async (task) => {
      log.push("start " + task.n);
      await sleep(task.n === 1 ? 120 : 15);
      log.push("end " + task.n);
      return { ok: true };
    },
  });
  assert.equal(pool.outcome, "drained");
  assert.equal(pool.done.size, 3);
  assert.ok(log.indexOf("start 3") < log.indexOf("end 1"), "task 3 started before slow task 1 ended: " + log.join(", "));
});

await t("file-sharing tasks never run at the same time (the cookie rule at run time)", async () => {
  let concurrent = 0, maxConcurrent = 0;
  const pool = await runTaskPool({
    tasks: [
      { n: 1, title: "left", files: ["shared.ts"], needs: [] },
      { n: 2, title: "right", files: ["shared.ts"], needs: [] },
    ],
    runTask: async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(25);
      concurrent--;
      return { ok: true };
    },
  });
  assert.equal(pool.done.size, 2);
  assert.equal(maxConcurrent, 1, "both claimed shared.ts yet ran together");
});

await t("disjoint independent tasks DO run at the same time", async () => {
  let concurrent = 0, maxConcurrent = 0;
  await runTaskPool({
    tasks: [
      { n: 1, title: "a", files: ["a"], needs: [] },
      { n: 2, title: "b", files: ["b"], needs: [] },
      { n: 3, title: "c", files: ["c"], needs: [] },
    ],
    runTask: async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(30);
      concurrent--;
      return { ok: true };
    },
  });
  assert.equal(maxConcurrent, 3, "independent disjoint tasks were serialized");
});

await t("retry at the fork re-runs the failed task and it can succeed the second time", async () => {
  let tries = 0;
  const asked = [];
  const pool = await runTaskPool({
    tasks: [{ n: 1, title: "flaky", files: ["a"], needs: [] }],
    runTask: async () => {
      tries++;
      return tries === 1 ? { ok: false, reason: "endpoint down" } : { ok: true };
    },
    askRetry: async (list) => { asked.push(list); return "retry"; },
  });
  assert.equal(pool.outcome, "drained");
  assert.equal(tries, 2);
  assert.ok(pool.done.has(1));
  assert.equal(pool.hardFailed.size, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0].reason, "endpoint down", "the fork names why the task failed");
});

await t("skip at the fork abandons honestly: failed stays failed, dependents reported skipped", async () => {
  const failedRows = [];
  const pool = await runTaskPool({
    tasks: [
      { n: 1, title: "dies", files: ["a"], needs: [] },
      { n: 2, title: "waits on 1", files: ["b"], needs: [1] },
    ],
    runTask: async (task) => task.n === 1 ? { ok: false, reason: "boom" } : { ok: true },
    onTaskFailed: (task, reason) => failedRows.push(task.n + ":" + reason),
    askRetry: async () => "skip",
  });
  assert.equal(pool.outcome, "drained");
  assert.ok(pool.hardFailed.has(1));
  assert.equal(pool.skipped.length, 1);
  assert.equal(pool.skipped[0].t.n, 2);
  assert.deepEqual(pool.skipped[0].missing, [1]);
  assert.deepEqual(failedRows, ["1:boom"]);
});

await t("stop at the fork stops; nothing else starts", async () => {
  let ran = 0;
  const pool = await runTaskPool({
    tasks: [
      { n: 1, title: "dies", files: ["a"], needs: [] },
      { n: 2, title: "after", files: ["b"], needs: [1] },
    ],
    runTask: async () => { ran++; return { ok: false, reason: "x" }; },
    askRetry: async () => "stop",
  });
  assert.equal(pool.outcome, "stopped");
  assert.equal(ran, 1, "the dependent must never have started");
});

await t("two-strike: a task that always fails is retried a bounded number of times, then kept failed", async () => {
  let tries = 0, forks = 0;
  const pool = await runTaskPool({
    tasks: [{ n: 1, title: "cursed", files: ["a"], needs: [] }],
    runTask: async () => { tries++; return { ok: false, reason: "always" }; },
    maxRetryRounds: 2,
    maxAttemptsPerTask: 3,
    askRetry: async () => { forks++; return "retry"; },
  });
  assert.equal(pool.outcome, "drained");
  assert.ok(pool.hardFailed.has(1));
  assert.equal(forks, 2, "the fork is bounded");
  assert.equal(tries, 3, "one first try plus two sanctioned retries, never more");
});

await t("a sealed question (job died while asking) surfaces as sealed", async () => {
  const pool = await runTaskPool({
    tasks: [{ n: 1, title: "dies", files: ["a"], needs: [] }],
    runTask: async () => ({ ok: false }),
    askRetry: async () => null,
  });
  assert.equal(pool.outcome, "sealed");
});

await t("abort drains without starting new tasks", async () => {
  let aborted = false, started = [];
  const pool = await runTaskPool({
    tasks: [
      { n: 1, title: "first", files: ["a"], needs: [] },
      { n: 2, title: "second", files: ["b"], needs: [1] },
    ],
    isAborted: () => aborted,
    runTask: async (task) => {
      started.push(task.n);
      await sleep(10);
      aborted = true;
      return { ok: true };
    },
  });
  assert.equal(pool.outcome, "aborted");
  assert.deepEqual(started, [1], "task 2 must not start after the abort");
});

await t("a carve verdict is fatal: pool reports carve, later tasks never start", async () => {
  const started = [];
  const pool = await runTaskPool({
    tasks: [
      { n: 1, title: "hits the wall", files: ["a"], needs: [] },
      { n: 2, title: "after", files: ["b"], needs: [1] },
    ],
    runTask: async (task) => { started.push(task.n); return { ok: false, carve: true }; },
  });
  assert.equal(pool.outcome, "carve");
  assert.deepEqual(started, [1]);
});

await t("a runTask that THROWS is a failed task, not a dead pool", async () => {
  const pool = await runTaskPool({
    tasks: [{ n: 1, title: "throws", files: ["a"], needs: [] }],
    runTask: async () => { throw new Error("kaboom"); },
    askRetry: async () => "skip",
  });
  assert.equal(pool.outcome, "drained");
  assert.ok(pool.hardFailed.has(1));
  assert.match(pool.failReason.get(1), /kaboom/);
});

await t("the gate caps concurrency at its limit and wakes waiters as slots free", async () => {
  const gate = createGate(2);
  let inside = 0, maxInside = 0;
  const work = Array.from({ length: 6 }, () => (async () => {
    await gate.enter();
    try { inside++; maxInside = Math.max(maxInside, inside); await sleep(15); }
    finally { inside--; gate.leave(); }
  })());
  await Promise.all(work);
  assert.equal(maxInside, 2, "the gate let more than its limit through");
  assert.equal(gate.inFlight, 0, "every entry was matched by a leave");
});

console.log("\nidepool: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
