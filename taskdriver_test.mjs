/*
 * Task driver self-test — run with: node taskdriver_test.mjs
 * Drives the loop by hand (calling tick() directly) against fake handlers, so every guarantee is
 * deterministic. Proves the behaviour that keeps a paid generation from evaporating:
 *   1. a provider job finishes with NO browser attached
 *   2. a handler that throws costs a retry, never the user's task
 *   3. a task only dies of old age, and dies loudly
 *   4. one broken handler cannot stop the other tasks in the same tick
 *   5. a slow tick never overlaps itself
 *   6. notifications fire exactly once, and a failing notifier retries instead of swallowing
 *   7. concurrency is capped so a backlog cannot open unlimited provider sockets
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskKernel } from "./taskkernel.mjs";
import { createTaskDriver } from "./taskdriver.mjs";

let passed = 0, failed = 0;
const dirs = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); }
}
function freshDir() { const d = mkdtempSync(join(tmpdir(), "taskdriver-")); dirs.push(d); return d; }
function clockAt(start) { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; }
const sink = () => { const seen = []; return { seen, fn: async (note) => { seen.push(note); } }; };

console.log("task driver");

await t("a provider job finishes with no browser attached", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  let calls = 0;
  k.register("video", {
    poll: async () => (++calls < 3 ? {} : { done: true, resultRef: "video/p1/clip.mp4" }),
    describe: () => "Your video is ready",
    href: (task) => `/?video=1&project=${task.anchor}`,
  });
  const notes = sink();
  const d = createTaskDriver({ kernel: k, now: c.now, onNotify: notes.fn });
  k.createTask({ id: "v1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", pollAt: c.now() });

  // Three ticks, each after the backoff has elapsed. No client ever connects.
  for (let i = 0; i < 3; i++) { await d.tick(); c.advance(60000); }
  const row = k.get("v1");
  assert.equal(row.status, "done", "the job should have settled with nobody watching");
  assert.equal(row.resultRef, "video/p1/clip.mp4", "the artifact location must be recorded");
  assert.equal(notes.seen.length, 1, "finishing should notify exactly once");
  assert.equal(notes.seen[0].href, "/?video=1&project=p1", "the notice must lead back to its own screen");
});

await t("a handler that throws costs a retry, never the task", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  let calls = 0;
  k.register("video", { poll: async () => { if (++calls <= 2) throw new Error("provider 503"); return { done: true }; } });
  const d = createTaskDriver({ kernel: k, now: c.now });
  k.createTask({ id: "v1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", pollAt: c.now() });

  await d.tick(); c.advance(60000);
  assert.equal(k.get("v1").status, "running", "a transient provider error must not fail the task");
  await d.tick(); c.advance(60000);
  assert.equal(k.get("v1").status, "running", "still surviving the second blip");
  await d.tick();
  assert.equal(k.get("v1").status, "done", "the task should complete once the provider recovers");
});

await t("a task dies of old age, and dies loudly", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("video", { poll: async () => ({}), maxAgeMs: 60000, describe: () => "Video failed" });
  const notes = sink();
  const d = createTaskDriver({ kernel: k, now: c.now, onNotify: notes.fn });
  k.createTask({ id: "v1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", pollAt: c.now() });

  await d.tick();
  assert.equal(k.get("v1").status, "running", "not expired yet");
  c.advance(120000);
  await d.tick();
  const res = k.resultFor("v1");
  assert.equal(res.status, "failed", "past its deadline the task must fail");
  assert.ok(res.errors.some((e) => /longer than it should/i.test(e)), "the user must be told why: " + res.errors);
  assert.equal(notes.seen.length, 1, "a task that never arrives must still notify");
});

await t("one broken handler cannot stop the others in the same tick", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("bad", { poll: async () => { throw new Error("boom"); } });
  k.register("good", { poll: async () => ({ done: true }) });
  const d = createTaskDriver({ kernel: k, now: c.now });
  k.createTask({ id: "b1", kind: "bad", surface: "x", anchor: "", uid: "u1", status: "running", pollAt: c.now() });
  k.createTask({ id: "g1", kind: "good", surface: "y", anchor: "", uid: "u1", status: "running", pollAt: c.now() });
  k.createTask({ id: "g2", kind: "good", surface: "y", anchor: "", uid: "u1", status: "running", pollAt: c.now() });

  await d.tick();
  assert.equal(k.get("g1").status, "done", "a healthy task must finish despite a sibling throwing");
  assert.equal(k.get("g2").status, "done");
  assert.equal(k.get("b1").status, "running", "the throwing task retries rather than dying");
});

await t("a slow tick never overlaps itself", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  let inFlight = 0, maxInFlight = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  k.register("slow", { poll: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await gate; inFlight--; return { done: true }; } });
  const d = createTaskDriver({ kernel: k, now: c.now });
  k.createTask({ id: "s1", kind: "slow", surface: "x", anchor: "", uid: "u1", status: "running", pollAt: c.now() });

  const first = d.tick();          // enters the handler and parks on the gate
  await Promise.resolve();
  await d.tick();                  // second tick while the first is still running
  release();
  await first;
  assert.equal(maxInFlight, 1, "a re-entrant tick must not double-poll a task");
});

await t("notifications fire once, and a failing notifier retries instead of swallowing", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("image", { poll: async () => ({ done: true }), describe: () => "Image ready", href: () => "/?images=1" });
  let attempts = 0;
  const delivered = [];
  const flaky = async (note) => { if (++attempts === 1) throw new Error("push endpoint down"); delivered.push(note); };
  const d = createTaskDriver({ kernel: k, now: c.now, onNotify: flaky });
  k.createTask({ id: "i1", kind: "image", surface: "images", anchor: "", uid: "u1", status: "running", pollAt: c.now() });

  await d.tick();
  assert.equal(delivered.length, 0, "the first delivery failed");
  assert.equal(k.get("i1").notifiedAt, 0, "a failed delivery must NOT mark the task notified");
  c.advance(60000);
  await d.tick();
  assert.equal(delivered.length, 1, "the retry should deliver the notice the user is owed");
  c.advance(60000);
  await d.tick();
  assert.equal(delivered.length, 1, "and it must never be delivered twice");
});

await t("concurrency is capped", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  let inFlight = 0, maxInFlight = 0;
  k.register("video", {
    poll: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--; return { done: true };
    },
  });
  const d = createTaskDriver({ kernel: k, now: c.now, concurrency: 3, batch: 50 });
  for (let i = 0; i < 12; i++) k.createTask({ id: "v" + i, kind: "video", surface: "video", anchor: "p" + i, uid: "u1", status: "running", pollAt: c.now() });

  await d.tick();
  assert.ok(maxInFlight <= 3, `a backlog must not open unlimited sockets, saw ${maxInFlight}`);
  assert.equal(k.liveFor("u1").length, 0, "all twelve should have settled");
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
