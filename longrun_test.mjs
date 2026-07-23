/*
 * Long-Run Harness spine self-test — run: node longrun_test.mjs
 * Proves the SOW rev B acceptance shapes at unit scale: a forced loop halts with an honest
 * report, gibberish is caught at the unit level (retry once with the reason shown, then an
 * honest pause), and a killed run resumes purely from the ledger with zero lost units. Clock is
 * injected, so the 20-minute stall clock tests in milliseconds.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLongRun, watchdogVerdict, degenerationScreen, repetitionRatio, fingerprint, STALL_MINUTES_DEFAULT } from "./longrun.mjs";

const WORK = mkdtempSync(join(tmpdir(), "longrun-"));
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const plan5 = () => Array.from({ length: 5 }, (_, i) => ({ title: "unit " + i }));
const goodCall = async (u) => ({ text: "Solid work on " + u.title + ": the widget was measured, the report was written, and the numbers were checked twice." });

await t("D1 default stall clock is Fred's 20 minutes", async () => {
  assert.equal(STALL_MINUTES_DEFAULT, 20);
});

await t("job needs a mission line; ledger appends and reads back in order", async () => {
  const lr = createLongRun({ dir: join(WORK, "a") });
  assert.throws(() => lr.createJob({ mission: "  " }), /mission/);
  const j = lr.createJob({ mission: "test the ledger", plan: plan5() });
  lr.appendLedger(j.id, { unit: 0, outcome: "done", fp: "x1" });
  lr.appendLedger(j.id, { unit: 1, outcome: "done", fp: "x2" });
  const entries = lr.readLedger(j.id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].unit, 0);
  assert.ok(entries[0].at <= entries[1].at);
});

await t("watchdog: three identical fingerprints = loop, named honestly", async () => {
  const fp = fingerprint("read", { path: "x" }, "same result");
  const entries = [1, 2, 3].map(() => ({ at: 1000, unit: 4, action: "read", outcome: "done", fp }));
  const v = watchdogVerdict({ entries, nowMs: 2000, lastActivityMs: 0, stallMs: 60000 });
  assert.equal(v.verdict, "loop");
  assert.match(v.detail, /identical/);
});

await t("watchdog: 20 minutes of silence = stalled", async () => {
  const entries = [{ at: 0, unit: 0, outcome: "done", fp: "a" }];
  const v = watchdogVerdict({ entries, nowMs: 21 * 60000, lastActivityMs: 0, stallMs: 20 * 60000 });
  assert.equal(v.verdict, "stalled");
  assert.match(v.detail, /21 minutes/);
});

await t("watchdog: same unit failed twice = two-strike", async () => {
  const entries = [
    { at: 1, unit: 3, outcome: "failed", note: "no such file", fp: "a" },
    { at: 2, unit: 3, outcome: "failed", note: "no such file", fp: "b" },
  ];
  const v = watchdogVerdict({ entries, nowMs: 3, lastActivityMs: 0, stallMs: 60000 });
  assert.equal(v.verdict, "two-strike");
});

await t("degeneration screen: looping text fails, honest prose passes, junk bytes fail", async () => {
  const loop = ("the same five words again and " ).repeat(40);
  assert.equal(degenerationScreen(loop).ok, false);
  assert.match(degenerationScreen(loop).reason, /repeats itself/);
  const prose = "The measurements page parses aerial data through two components. The first handles manual entry with validation on each field. The second calls the aerial provider and reconciles its polygons against the roof plan, flagging any face whose area differs by more than five percent.";
  assert.equal(degenerationScreen(prose).ok, true);
  assert.equal(degenerationScreen("ok\u0000\u0001\u0002garbage\uFFFD\uFFFD").ok, false);
  assert.ok(repetitionRatio(loop) > 0.8, "loop ratio should be extreme");
});

await t("happy path: 5 units run, ledger holds 5 done lines, job ends done", async () => {
  const lr = createLongRun({ dir: join(WORK, "b") });
  const j = lr.createJob({ mission: "five clean units", plan: plan5() });
  const events = [];
  const r = await lr.runJob(j.id, { callUnit: goodCall, onEvent: (t2, d) => events.push(t2) });
  assert.equal(r.state, "done");
  assert.equal(lr.readLedger(j.id).filter((e) => e.outcome === "done").length, 5);
  assert.ok(events.includes("unit-start") && events.includes("unit-done") && events.includes("done"));
});

await t("SABOTAGE gibberish: caught at unit level, one retry WITH the reason, then honest pause", async () => {
  const lr = createLongRun({ dir: join(WORK, "c") });
  const j = lr.createJob({ mission: "catch the gibberish", plan: plan5() });
  const retryReasons = [];
  const r = await lr.runJob(j.id, {
    callUnit: async (u, pack) => {
      if (pack.retryReason) retryReasons.push(pack.retryReason);
      if (u.unit === 2) return { text: ("broken record broken record broken record and again " ).repeat(30) };
      return goodCall(u);
    },
  });
  assert.equal(r.state, "paused");
  assert.equal(r.unit, 2);
  assert.match(r.reason, /repeats itself/);
  assert.equal(retryReasons.length, 1, "the retry must carry the validation failure");
  const meta = lr.readMeta(j.id);
  assert.match(meta.reason, /failed validation twice/);
  assert.equal(lr.readLedger(j.id).filter((e) => e.outcome === "done").length, 2, "units 0 and 1 landed before the pause");
});

await t("retry recovers: first attempt gibberish, second clean, job completes", async () => {
  const lr = createLongRun({ dir: join(WORK, "d") });
  const j = lr.createJob({ mission: "self-correct", plan: plan5() });
  let flubbed = false;
  const r = await lr.runJob(j.id, {
    callUnit: async (u, pack) => {
      if (u.unit === 1 && !flubbed) { flubbed = true; return { text: ("loops and loops and loops and loops again " ).repeat(30) }; }
      return goodCall(u);
    },
  });
  assert.equal(r.state, "done");
  assert.equal(lr.readLedger(j.id).filter((e) => e.outcome === "done").length, 5);
});

await t("SABOTAGE kill: a dead process resumes from the ledger with zero lost units", async () => {
  const dirE = join(WORK, "e");
  const lr1 = createLongRun({ dir: dirE });
  const plan = Array.from({ length: 8 }, (_, i) => ({ title: "unit " + i }));
  const j = lr1.createJob({ mission: "survive the crash", plan });
  // The process dies mid-run: callUnit throws hard on unit 4 both attempts, job pauses.
  const r1 = await lr1.runJob(j.id, {
    callUnit: async (u) => { if (u.unit === 4) throw new Error("process killed"); return goodCall(u); },
  });
  assert.equal(r1.state, "paused");
  assert.equal(lr1.readLedger(j.id).filter((e) => e.outcome === "done").length, 4);
  // A FRESH store instance = a restarted server. Resume; ledger is the only memory.
  const lr2 = createLongRun({ dir: dirE });
  lr2.resumeJob(j.id);
  const r2 = await lr2.runJob(j.id, { callUnit: goodCall });
  assert.equal(r2.state, "done");
  const dones = lr2.readLedger(j.id).filter((e) => e.outcome === "done");
  assert.equal(dones.length, 8, "every unit exactly once");
  assert.equal(new Set(dones.map((e) => e.unit)).size, 8, "no unit ran twice");
});

await t("SABOTAGE loop: runner halts on the watchdog's loop verdict before spending more", async () => {
  const lr = createLongRun({ dir: join(WORK, "f") });
  const j = lr.createJob({ mission: "halt the loop", plan: plan5() });
  const fp = fingerprint("wedged", null, "identical");
  for (let i = 0; i < 3; i++) lr.appendLedger(j.id, { unit: 9, action: "wedged", outcome: "working", fp });
  const r = await lr.runJob(j.id, { callUnit: goodCall });
  assert.equal(r.state, "halted");
  assert.equal(r.verdict, "loop");
  assert.match(lr.readMeta(j.id).reason, /identical/);
});

await t("stall clock catches a HANGING unit: the race abandons it and halts honestly", async () => {
  const lr = createLongRun({ dir: join(WORK, "g") });
  // 0.02 minutes = 1.2s stall clock, so the test proves the mechanism without waiting 20 minutes.
  const j = lr.createJob({ mission: "stall out", plan: plan5(), stallMinutes: 0.02 });
  const r = await lr.runJob(j.id, {
    callUnit: (u) => u.unit === 1 ? new Promise(() => {}) : goodCall(u),   // unit 1 hangs forever
  });
  assert.equal(r.state, "halted");
  assert.equal(r.verdict, "stalled");
  assert.match(r.detail, /produced nothing/);
  assert.equal(lr.readLedger(j.id).filter((e) => e.outcome === "done").length, 1, "unit 0 landed before the hang");
});

await t("resume after a long pause never false-reads as stalled from old ledger stamps", async () => {
  let clock = 1_000_000;
  const lr = createLongRun({ dir: join(WORK, "g2"), now: () => clock });
  const j = lr.createJob({ mission: "sleep then resume", plan: plan5(), stallMinutes: 20 });
  await lr.runJob(j.id, { callUnit: async (u) => { if (u.unit === 2) throw new Error("die"); return goodCall(u); } });
  clock += 48 * 3600000;   // two days later
  lr.resumeJob(j.id);
  const r = await lr.runJob(j.id, { callUnit: goodCall });
  assert.equal(r.state, "done");
});

await t("budget fuse: exhausted tranche pauses honestly, approval resumes to done", async () => {
  const lr = createLongRun({ dir: join(WORK, "h") });
  const j = lr.createJob({ mission: "trip the fuse", plan: plan5() });
  let spent = 0;
  const r1 = await lr.runJob(j.id, {
    callUnit: async (u) => { spent++; return goodCall(u); },
    budget: { remaining: () => 2 - spent },
  });
  assert.equal(r1.state, "paused");
  assert.match(r1.reason, /tranche/);
  assert.equal(lr.readLedger(j.id).filter((e) => e.outcome === "done").length, 2);
  lr.resumeJob(j.id);
  const r2 = await lr.runJob(j.id, { callUnit: goodCall });
  assert.equal(r2.state, "done");
});

await t("tenant isolation: jobs live under their own dir, lists never cross", async () => {
  const lrA = createLongRun({ dir: join(WORK, "i", "userA") });
  const lrB = createLongRun({ dir: join(WORK, "i", "userB") });
  lrA.createJob({ mission: "A's job" });
  assert.equal(lrA.listJobs().length, 1);
  assert.equal(lrB.listJobs().length, 0);
});

await t("pause and resume are honest state transitions", async () => {
  const lr = createLongRun({ dir: join(WORK, "j") });
  const j = lr.createJob({ mission: "state machine" });
  lr.pauseJob(j.id, "owner asked");
  assert.equal(lr.readMeta(j.id).state, "paused");
  const r = await lr.runJob(j.id, { callUnit: goodCall });
  assert.match(r.reason, /resume it first/);
  lr.resumeJob(j.id);
  assert.equal(lr.readMeta(j.id).state, "ready");
});

rmSync(WORK, { recursive: true, force: true });
console.log(`\nlongrun: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
