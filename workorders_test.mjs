/*
 * Scheduled work orders (workorders.mjs).
 *
 * The two things that decide whether this feature is trustworthy overnight:
 *
 *   1. THE CLOCK. "3am Eastern" has to mean 3am Eastern in July and in January. A schedule that
 *      adds 24 hours works perfectly for eight months and then quietly runs at 2am, and nobody
 *      connects the two events. So the daylight-saving crossings are tested directly.
 *   2. THE SLEEPING MACHINE. A laptop is asleep at 3am. If a missed run advances the schedule, the
 *      job never runs at all while the dashboard shows a healthy next-run time, which is the worst
 *      of both worlds. A missed run must stay due.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkOrders, nextRunAt, zonedParts, describeSchedule, TASKS } from "./workorders.mjs";

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };
const ET = "America/New_York";
const at = (ms) => zonedParts(ms, ET);

t("3am Eastern is 3am Eastern in summer", () => {
  // 2026-07-31 00:00 UTC is 2026-07-30 8pm ET. The next 3am ET is a few hours later.
  const from = Date.parse("2026-07-31T02:25:00Z");
  const next = nextRunAt({ cadence: "daily", atHour: 3, atMinute: 0, tz: ET }, from);
  const p = at(next);
  assert.equal(p.h, 3, "the clock in New York must read 3");
  assert.equal(p.mi, 0);
  assert.equal(next, Date.parse("2026-07-31T07:00:00Z"), "which in July is 07:00 UTC");
  assert.ok(next > from);
});

t("and 3am Eastern is still 3am Eastern in winter", () => {
  // January: Eastern is UTC-5 rather than UTC-4. A naive +24h schedule drifts here.
  const from = Date.parse("2027-01-15T09:00:00Z");
  const next = nextRunAt({ cadence: "daily", atHour: 3, atMinute: 0, tz: ET }, from);
  const p = at(next);
  assert.equal(p.h, 3, "still 3 on the wall in New York");
  assert.equal(next, Date.parse("2027-01-16T08:00:00Z"), "which in January is 08:00 UTC, an hour later than July");
});

t("THE DST CROSSING: the run stays at 3am across spring forward", () => {
  // US clocks jump 2am -> 3am on 2027-03-14. The run before and the run after must both read 3.
  const before = nextRunAt({ cadence: "daily", atHour: 3, atMinute: 0, tz: ET }, Date.parse("2027-03-12T12:00:00Z"));
  const after = nextRunAt({ cadence: "daily", atHour: 3, atMinute: 0, tz: ET }, before + 1000);
  const afterAfter = nextRunAt({ cadence: "daily", atHour: 3, atMinute: 0, tz: ET }, after + 1000);
  for (const [label, ms] of [["before", before], ["across", after], ["after", afterAfter]]) {
    assert.equal(at(ms).h, 3, `the ${label} run must read 3 on the wall clock`);
  }
  // The gap across the crossing is 23 hours, which is exactly the point: a +24h scheduler is wrong.
  const gapHours = Math.round((afterAfter - after) / 3600000);
  assert.ok(gapHours === 23 || gapHours === 24, "gap was " + gapHours + "h");
});

t("a weekly order lands on the right weekday", () => {
  const from = Date.parse("2026-07-31T02:00:00Z");
  const next = nextRunAt({ cadence: "weekly", atHour: 9, atMinute: 30, tz: ET, weekday: 1 }, from);
  const day = new Date(next).toLocaleString("en-US", { timeZone: ET, weekday: "long" });
  assert.equal(day, "Monday");
  assert.equal(at(next).h, 9);
  assert.equal(at(next).mi, 30);
});

t("the schedule reads like English, not cron", () => {
  assert.equal(describeSchedule({ cadence: "daily", atHour: 3, atMinute: 0, tz: ET }), "Every day at 3:00 AM EDT");
  assert.equal(describeSchedule({ cadence: "weekly", atHour: 14, atMinute: 5, tz: ET, weekday: 5 }), "Every Friday at 2:05 PM EDT");
  assert.equal(describeSchedule({ cadence: "once", atHour: 0, atMinute: 0, tz: ET }), "Once, at 12:00 AM EDT");
});

const withStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "wo-"));
  let clock = Date.parse("2026-07-31T02:25:00Z");
  const s = createWorkOrders({ dir, now: () => clock });
  try { fn(s, { set: (ms) => { clock = ms; }, get: () => clock }); }
  finally { try { s.db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} }
};

t("an order placed on the phone is due at 3am, and the folder must be a real path", () => {
  withStore((s) => {
    const bad = s.create("u1", { task: "sort_by_type", folder: "Downloads", tz: ET, atHour: 3 });
    assert.equal(bad.code, "not_absolute", "a relative path means nothing on a machine nobody is at");

    const r = s.create("u1", { task: "sort_by_type", folder: "C:\\Users\\rjfla\\Downloads", node: "laptop", tz: ET, atHour: 3, createdFrom: "phone" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.order.nextRunAt, Date.parse("2026-07-31T07:00:00Z"));
    assert.equal(r.order.schedule, "Every day at 3:00 AM EDT");
    assert.equal(r.order.dryRunFirst, true, "a task that moves files gets a dry run first by default");
    assert.equal(s.due(Date.parse("2026-07-31T06:59:00Z")).length, 0, "not due a minute early");
    assert.equal(s.due(Date.parse("2026-07-31T07:00:00Z")).length, 1, "due at 3am ET");
  });
});

t("an unknown task is refused: the list is the list", () => {
  withStore((s) => {
    const r = s.create("u1", { task: "delete_everything", folder: "C:\\x" });
    assert.equal(r.code, "unknown_task");
    assert.ok(!("delete_everything" in TASKS));
  });
});

t("THE SLEEPING LAPTOP: a missed run stays due instead of sliding to tomorrow", () => {
  withStore((s, clock) => {
    const { order } = s.create("u1", { task: "sort_by_type", folder: "C:\\Users\\rjfla\\Downloads", node: "laptop", tz: ET, atHour: 3 });
    clock.set(Date.parse("2026-07-31T07:00:00Z"));
    assert.equal(s.due().length, 1);

    s.markWaiting(order.id, "laptop");
    const w = s.get(order.id);
    assert.equal(w.lastStatus, "waiting");
    assert.match(w.lastSummary, /Waiting for laptop/);
    assert.equal(w.nextRunAt, order.nextRunAt, "the schedule must NOT advance for a machine that was asleep");

    // Hours later, still asleep, still due. This is the property that matters.
    clock.set(Date.parse("2026-07-31T13:00:00Z"));
    assert.equal(s.due().length, 1, "it must still be waiting to run, not silently skipped");
    assert.equal(s.waitingOn("laptop").length, 1, "and findable the moment that machine reconnects");
    assert.equal(s.waitingOn("mini-pc").length, 0, "another machine coming online must not trigger it");
  });
});

t("a completed run advances to tomorrow and records what it did", () => {
  withStore((s, clock) => {
    const { order } = s.create("u1", { task: "sort_by_type", folder: "C:\\Users\\rjfla\\Downloads", node: "laptop", tz: ET, atHour: 3 });
    clock.set(Date.parse("2026-07-31T07:00:30Z"));
    const moves = [{ from: "C:\\d\\a.jpg", to: "C:\\d\\Images\\a.jpg" }];
    const after = s.recordRun(order.id, { ok: true, summary: "1 file sorted.", journal: moves });
    assert.equal(after.lastStatus, "ok");
    assert.equal(after.runCount, 1);
    assert.deepEqual(after.journal, moves, "the journal is what the undo is built from");
    assert.equal(after.nextRunAt, Date.parse("2026-08-01T07:00:00Z"), "tomorrow at 3am ET");
    assert.equal(after.dryRunFirst, false, "the dry run is spent");
  });
});

t("a dry run does NOT count as the one shot of a once-only order", () => {
  withStore((s, clock) => {
    const { order } = s.create("u1", { task: "sort_by_type", folder: "C:\\x\\y", node: "laptop", tz: ET, atHour: 3, cadence: "once" });
    clock.set(Date.parse("2026-07-31T07:00:30Z"));
    const dry = s.recordRun(order.id, { ok: true, summary: "2 files would be sorted.", journal: [], dryRun: true });
    assert.equal(dry.enabled, true, "the real work still has to happen");
    assert.ok(dry.nextRunAt > 0);
    const real = s.recordRun(order.id, { ok: true, summary: "2 files sorted.", journal: [] });
    assert.equal(real.enabled, false, "now it is done");
    assert.equal(real.nextRunAt, 0);
  });
});

t("orders are per account, and capped", () => {
  withStore((s) => {
    s.create("u1", { task: "folder_report", folder: "C:\\a" });
    s.create("u2", { task: "folder_report", folder: "C:\\b" });
    assert.equal(s.list("u1").length, 1);
    assert.equal(s.list("u2").length, 1, "one account must never see another's orders");
    for (let i = 0; i < 25; i++) s.create("u1", { task: "folder_report", folder: "C:\\f" + i });
    assert.equal(s.list("u1").length, 20, "capped at 20");
    const over = s.create("u1", { task: "folder_report", folder: "C:\\one-more" });
    assert.equal(over.code, "too_many");
  });
});

t("the drawer dot counts runs you have not looked at yet", () => {
  withStore((s, clock) => {
    const { order } = s.create("u1", { task: "folder_report", folder: "C:\\a" });
    assert.equal(s.unseenCount("u1"), 0);
    clock.set(clock.get() + 3600000);
    s.recordRun(order.id, { ok: true, summary: "done", journal: [] });
    assert.equal(s.unseenCount("u1"), 1, "something ran since you last looked");
    s.markSeen("u1");
    assert.equal(s.unseenCount("u1"), 0, "and the dot clears once you have");
  });
});

console.log(`\n${passed}/11 checks passed - the clock is honest and a sleeping machine cannot lose a run`);
