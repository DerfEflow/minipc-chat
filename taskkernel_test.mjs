/*
 * Task kernel self-test — run with: node taskkernel_test.mjs
 * Pure store/registry test (no server, no network): a temp SQLite dir per run. Proves the
 * guarantees every surface will inherit from the kernel:
 *   1. a task is durable from birth, and reopening the DB sees it
 *   2. events coalesce and replay from an offset with no gap and no duplication
 *   3. concurrency is per-user and per-kind, so a video, a build and a chat coexist
 *   4. the driver claim is exclusive: two overlapping ticks never hand out the same task twice
 *   5. backoff grows and caps, so a stuck provider job cannot become a billing surprise
 *   6. a process that dies mid-run leaves orphans with partial output preserved, not silence
 *   7. terminal tasks queue exactly one notification each, carrying a deep link back
 *   8. retention frees events but surrenders resultRefs so the caller can delete the artifacts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskKernel, coalesceEvents, backoffMs, TERMINAL } from "./taskkernel.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); }
}

const dirs = [];
function freshDir() { const d = mkdtempSync(join(tmpdir(), "taskkernel-")); dirs.push(d); return d; }
// A controllable clock: every time-dependent guarantee here is deterministic on purpose, because a
// backoff test that depends on real elapsed time is a flaky test waiting to happen in CI.
function clockAt(start) { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; }

console.log("task kernel");

// ---- 1. durability across a reopen ----------------------------------------------------------
t("a task survives the store being closed and reopened", () => {
  const dir = freshDir();
  const k1 = createTaskKernel({ dir });
  k1.register("video", {});
  k1.createTask({ id: "v1", kind: "video", surface: "video", anchor: "proj-9", title: "Opening shot", uid: "u1", email: "a@b.c" });
  const k2 = createTaskKernel({ dir });
  const row = k2.get("v1");
  assert.ok(row, "task missing after reopen");
  assert.equal(row.anchor, "proj-9");
  assert.equal(row.title, "Opening shot");
});

// ---- 2. event replay -------------------------------------------------------------------------
t("token runs coalesce and replay from an offset without gaps or duplication", () => {
  const k = createTaskKernel({ dir: freshDir() });
  k.register("chat", {});
  k.createTask({ id: "c1", kind: "chat", surface: "chat", anchor: "chat-1", uid: "u1" });
  const events = [
    { type: "token", delta: "Hello" }, { type: "token", delta: " " }, { type: "token", delta: "world" },
    { type: "tool", name: "search", status: "ok" },
    { type: "token", delta: "!" },
  ];
  const rows = coalesceEvents(events, 0);
  k.appendRows("c1", rows, events.length, 12);
  const full = k.replayRows("c1", 0);
  const text = full.filter((r) => r.ev.type === "token").map((r) => r.ev.delta).join("");
  assert.equal(text, "Hello world!", "full replay text wrong: " + text);
  // The three-token run must be ONE row spanning 3, which is what keeps an 18h run from
  // becoming hundreds of thousands of rows.
  assert.equal(full[0].span, 3, "leading token run did not coalesce");
  const tail = k.replayRows("c1", 3);
  assert.ok(tail.every((r) => r.seq + r.span > 3), "replay returned rows entirely before the cursor");
  assert.ok(tail.some((r) => r.ev.type === "tool"), "structural event lost in offset replay");
});

// ---- 3. concurrency across surfaces ----------------------------------------------------------
t("one user runs a video, a build and a chat at the same time", () => {
  const k = createTaskKernel({ dir: freshDir() });
  ["video", "build", "chat"].forEach((kind) => k.register(kind, {}));
  k.createTask({ id: "a", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running" });
  k.createTask({ id: "b", kind: "build", surface: "crucible", anchor: "w1", uid: "u1", status: "running" });
  k.createTask({ id: "c", kind: "chat", surface: "chat", anchor: "ch1", uid: "u1", status: "running" });
  assert.equal(k.liveFor("u1").length, 3, "three concurrent tasks should be live");
  assert.equal(k.liveCountFor("u1", "video"), 1);
  // Per-anchor is where exclusivity belongs: two builds in ONE workspace is a real conflict,
  // two builds in different workspaces is the whole point of the feature.
  assert.ok(k.liveAtAnchor("crucible", "w1"), "anchor lookup should find the live build");
  assert.equal(k.liveAtAnchor("crucible", "w2"), null, "a different workspace must look free");
  assert.equal(k.liveFor("u2").length, 0, "another user must not see these");
});

// ---- 4. exclusive claim ----------------------------------------------------------------------
t("overlapping driver ticks never claim the same task twice", () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("video", {});
  k.createTask({ id: "v1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", pollAt: c.now() });
  const first = k.claimDue(10);
  assert.equal(first.length, 1, "first tick should claim the due task");
  const second = k.claimDue(10);
  assert.equal(second.length, 0, "a second overlapping tick must claim nothing");
  // It comes back only once its backoff has elapsed.
  c.advance(backoffMs(1) + 1);
  assert.equal(k.claimDue(10).length, 1, "task should be due again after its backoff");
});

t("finished tasks stop being polled", () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("video", {});
  k.createTask({ id: "v1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", pollAt: c.now() });
  k.finish("v1", "done");
  c.advance(600000);
  assert.equal(k.claimDue(10).length, 0, "a finished task must never be polled again");
});

// ---- 5. backoff ------------------------------------------------------------------------------
t("backoff grows and caps", () => {
  assert.equal(backoffMs(0), 2000, "first retry should be prompt");
  assert.ok(backoffMs(3) > backoffMs(1), "backoff must grow");
  assert.equal(backoffMs(50), 30000, "backoff must cap so a stuck job cannot hammer a provider");
  assert.ok(backoffMs(-5) >= 2000, "a nonsense attempt count must not produce a hot loop");
});

// ---- 6. orphan sweep -------------------------------------------------------------------------
t("a process that dies mid-run leaves honest orphans with partial output intact", () => {
  const dir = freshDir();
  const k1 = createTaskKernel({ dir });
  k1.register("chat", {});
  k1.createTask({ id: "c1", kind: "chat", surface: "chat", anchor: "ch1", uid: "u1", status: "running" });
  const partial = [{ type: "token", delta: "half an answ" }];
  k1.appendRows("c1", coalesceEvents(partial, 0), 1, 12);
  // No finish() call: this is the crash.
  const k2 = createTaskKernel({ dir });
  const row = k2.get("c1");
  assert.equal(row.status, "orphaned", "a task left running by a dead process must be sealed orphaned");
  const res = k2.resultFor("c1");
  assert.ok(res.text.startsWith("half an answ"), "partial output must survive the crash: " + res.text);
  assert.ok(res.errors.some((e) => /restart/i.test(e)), "the orphan must explain itself");
  assert.ok(TERMINAL.has(row.status));
});

// ---- 7. notifications ------------------------------------------------------------------------
t("each terminal task queues exactly one notification carrying a deep link", () => {
  const k = createTaskKernel({ dir: freshDir() });
  k.register("video", {
    describe: (task) => `Your video "${task.title}" is ready`,
    href: (task) => `/?video=1&project=${task.anchor}`,
  });
  k.createTask({ id: "v1", kind: "video", surface: "video", anchor: "p7", title: "Opening shot", uid: "u1", status: "running" });
  assert.equal(k.pendingNotifications().length, 0, "a live task owes no notification");
  k.finish("v1", "done");
  const pending = k.pendingNotifications();
  assert.equal(pending.length, 1, "a finished task owes exactly one notification");
  const note = k.notificationFor(pending[0]);
  assert.equal(note.title, 'Your video "Opening shot" is ready');
  assert.equal(note.href, "/?video=1&project=p7", "the notification must deep-link back to its own screen");
  k.markNotified("v1");
  assert.equal(k.pendingNotifications().length, 0, "a notified task must not buzz twice");
  // Notified is not the same as seen: the popup still owes the user a card until they look.
  assert.equal(k.unseenFor("u1").length, 1, "an unseen result should still be offered in-app");
  k.markSeen("v1");
  assert.equal(k.unseenFor("u1").length, 0);
});

t("failures notify too, and say so", () => {
  const k = createTaskKernel({ dir: freshDir() });
  k.register("image", { describe: (t2) => (t2.status === "failed" ? "Image generation failed" : "Image ready"), href: () => "/?images=1" });
  k.createTask({ id: "i1", kind: "image", surface: "images", anchor: "", uid: "u1", status: "running" });
  k.finish("i1", "failed", { error: "provider 502" });
  const [row] = k.pendingNotifications();
  assert.equal(k.notificationFor(row).title, "Image generation failed", "a hard failure must notify, not disappear");
  assert.equal(k.resultFor("i1").meta.error, "provider 502", "the failure reason must survive for the user to read");
});

t("a handler that throws cannot break the notifier", () => {
  const k = createTaskKernel({ dir: freshDir() });
  k.register("bad", { describe: () => { throw new Error("boom"); }, href: () => { throw new Error("boom"); } });
  k.createTask({ id: "b1", kind: "bad", surface: "x", anchor: "", uid: "u1", status: "running", title: "fallback title" });
  k.finish("b1", "done");
  const note = k.notificationFor(k.pendingNotifications()[0]);
  assert.equal(note.title, "fallback title", "a broken describe() must fall back, not throw");
  assert.equal(note.href, "/", "a broken href() must fall back to somewhere safe");
});

// ---- 8. retention ----------------------------------------------------------------------------
t("retention frees events and surrenders artifact refs for deletion", () => {
  const c = clockAt(1_000_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("image", {});
  k.createTask({ id: "i1", kind: "image", surface: "images", anchor: "", uid: "u1", status: "running" });
  k.bindMeta("i1", { resultRef: "images/u1/i1.png" });
  k.appendRows("i1", coalesceEvents([{ type: "token", delta: "x" }], 0), 1, 1);
  k.finish("i1", "done");
  k.collect("i1");
  c.advance(2 * 86400000);
  const swept = k.gcRetention({ collectedTtlMs: 86400000 });
  assert.equal(swept.events, 1, "a collected task's events should be freed");
  assert.ok(k.get("i1"), "the bare row should linger for the history trail");
  // Only once the row itself goes does the caller learn it may delete the bytes, which is what
  // stops a retention sweep from orphaning files nobody will ever clean up.
  c.advance(8 * 86400000);
  const later = k.gcRetention({ collectedTtlMs: 86400000 });
  assert.ok(later.orphanedRefs.includes("images/u1/i1.png"), "the artifact ref must be surrendered for deletion");
  assert.equal(k.get("i1"), null, "the row should be gone once its artifact was surrendered");
});

t("a live task is never touched by retention", () => {
  const c = clockAt(1_000_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("build", {});
  k.createTask({ id: "b1", kind: "build", surface: "crucible", anchor: "w1", uid: "u1", status: "running" });
  c.advance(400 * 86400000);
  k.gcRetention({ collectedTtlMs: 1, uncollectedTtlMs: 1 });
  assert.ok(k.get("b1"), "a running task must survive any retention sweep, at any age");
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
