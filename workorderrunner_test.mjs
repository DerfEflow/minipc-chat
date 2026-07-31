/*
 * Running a work order against a machine (workorderrunner.mjs), driven by a fake machine so the
 * awkward cases can all be reached: asleep, back online, refusing, and answering nonsense.
 *
 * The claim under everything else: a job that did not happen must never look like a job that did.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkOrders } from "./workorders.mjs";
import { createWorkOrderRunner } from "./workorderrunner.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  PASS  " + name); passed++; };
const ET = "America/New_York";
const THREE_AM = Date.parse("2026-07-31T07:00:00Z");

// A machine that answers like the real node does: a stdout string carrying the marked JSON line.
function fakeMachine({ online = ["laptop"], moved = 2, fail = false, garbage = false } = {}) {
  const calls = [];
  const dispatch = async (node, tool, args) => {
    calls.push({ node, tool, command: String(args.command || "") });
    if (fail) return { ok: false, error: "the shell refused" };
    if (garbage) return { ok: true, stdout: "PowerShell said something unexpected and stopped" };
    const isDry = /\$DryRun = \$true/.test(args.command);
    const isUndo = /\$Journal =/.test(args.command);
    if (isUndo) return { ok: true, stdout: `DOMINION_RESULT {"ok":true,"restored":["C:\\\\d\\\\a.jpg"],"skipped":[]}` };
    const list = Array.from({ length: moved }, (_, i) => ({ from: `C:\\d\\f${i}.jpg`, to: `C:\\d\\Images\\f${i}.jpg`, ...(isDry ? { planned: true } : {}) }));
    return { ok: true, stdout: `DOMINION_RESULT ${JSON.stringify({ ok: true, root: "C:\\d", dryRun: isDry, moved: list, skipped: [], created: ["Images"], scanned: moved })}` };
  };
  return { dispatch, calls, nodeOnline: () => online };
}

const withRig = async (opts, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "wor-"));
  let clock = Date.parse("2026-07-31T02:25:00Z");
  const store = createWorkOrders({ dir, now: () => clock });
  const m = fakeMachine(opts);
  const runner = createWorkOrderRunner({ store, dispatch: m.dispatch, nodeOnline: m.nodeOnline });
  try { await fn({ store, runner, m, setClock: (x) => { clock = x; } }); }
  finally { try { store.db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} }
};

const place = (store, extra = {}) =>
  store.create("u1", { task: "sort_by_type", folder: "C:\\Users\\rjfla\\Downloads", node: "laptop", tz: ET, atHour: 3, ...extra }).order;

await t("THE FIRST RUN IS A DRY RUN: it reports the moves and changes nothing", async () => {
  await withRig({}, async ({ store, runner, m, setClock }) => {
    const o = place(store);
    setClock(THREE_AM);
    const r = await runner.tick(THREE_AM);
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, true);
    assert.equal(r[0].dryRun, true, "a task that moves files must not do it unattended the first time");
    assert.match(r[0].summary, /^Dry run\. /);
    assert.ok(/\$DryRun = \$true/.test(m.calls[0].command), "and the machine must actually be told it is a dry run");
    assert.deepEqual(store.get(o.id).journal, [], "a dry run leaves nothing to undo, because it moved nothing");
  });
});

await t("the second run does the real work and leaves an undoable journal", async () => {
  await withRig({}, async ({ store, runner, m, setClock }) => {
    const o = place(store);
    setClock(THREE_AM);
    await runner.tick(THREE_AM);                                   // the dry run
    setClock(Date.parse("2026-08-01T07:00:00Z"));
    const r = await runner.tick(Date.parse("2026-08-01T07:00:00Z"));
    assert.equal(r[0].dryRun, false, "the dry run is spent");
    assert.ok(/\$DryRun = \$false/.test(m.calls[1].command));
    const after = store.get(o.id);
    assert.equal(after.journal.length, 2, "every move recorded");
    assert.equal(after.lastStatus, "ok");
  });
});

await t("THE SLEEPING LAPTOP: nothing runs, nothing is lost, and it fires on reconnect", async () => {
  await withRig({ online: [] }, async ({ store, runner, m, setClock }) => {
    const o = place(store);
    setClock(THREE_AM);
    const r = await runner.tick(THREE_AM);
    assert.equal(r[0].waiting, true);
    assert.equal(m.calls.length, 0, "an offline machine must not be dispatched to");
    const parked = store.get(o.id);
    assert.equal(parked.lastStatus, "waiting");
    assert.equal(parked.nextRunAt, o.nextRunAt, "the schedule must not slide to tomorrow");

    // Fred opens the lid at 8am.
    m.nodeOnline = () => ["laptop"];
    const runner2 = createWorkOrderRunner({ store, dispatch: m.dispatch, nodeOnline: () => ["laptop"] });
    const caught = await runner2.onNodeOnline("laptop");
    assert.equal(caught.length, 1, "the parked order runs the moment the machine is back");
    assert.equal(caught[0].ok, true);
    assert.equal(store.get(o.id).lastStatus, "dry-run");
  });
});

await t("a different machine coming online does not trigger somebody else's order", async () => {
  await withRig({ online: [] }, async ({ store, runner, m, setClock }) => {
    place(store);
    setClock(THREE_AM);
    await runner.tick(THREE_AM);
    const r = await createWorkOrderRunner({ store, dispatch: m.dispatch, nodeOnline: () => ["mini-pc"] }).onNodeOnline("mini-pc");
    assert.equal(r.length, 0, "an order pinned to the laptop must wait for the laptop");
    assert.equal(m.calls.length, 0);
  });
});

await t("NO QUIET ZERO: an unreadable answer is a failure, with the raw text kept", async () => {
  await withRig({ garbage: true }, async ({ store, runner, setClock }) => {
    const o = place(store);
    setClock(THREE_AM);
    const r = await runner.tick(THREE_AM);
    assert.equal(r[0].ok, false, "a job whose result cannot be read has NOT succeeded");
    assert.match(r[0].error, /could not be read/);
    assert.equal(store.get(o.id).lastStatus, "failed");
    assert.ok(r[0].raw, "the raw text is kept so it can be diagnosed");
  });
});

await t("a machine that refuses is recorded as a failure in plain words", async () => {
  await withRig({ fail: true }, async ({ store, runner, setClock }) => {
    const o = place(store);
    setClock(THREE_AM);
    const r = await runner.tick(THREE_AM);
    assert.equal(r[0].ok, false);
    assert.match(store.get(o.id).lastSummary, /refused or failed/);
  });
});

await t("the undo puts the files back, and refuses when the machine is away", async () => {
  await withRig({}, async ({ store, runner, m, setClock }) => {
    const o = place(store, { dryRunFirst: false });
    setClock(THREE_AM);
    await runner.tick(THREE_AM);
    const done = store.get(o.id);
    assert.equal(done.journal.length, 2);

    const u = await runner.undo(done);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.match(u.summary, /put back/);

    const offline = createWorkOrderRunner({ store, dispatch: m.dispatch, nodeOnline: () => [] });
    const u2 = await offline.undo(done);
    assert.equal(u2.ok, false);
    assert.match(u2.error, /not online/);
  });
});

await t("the report task never asks the machine to move anything", async () => {
  await withRig({}, async ({ store, runner, m, setClock }) => {
    store.create("u1", { task: "folder_report", folder: "C:\\Users\\rjfla\\Downloads", node: "laptop", tz: ET, atHour: 3 });
    setClock(THREE_AM);
    await runner.tick(THREE_AM);
    assert.ok(/\$DryRun = \$true/.test(m.calls[0].command), "a report must always run in the mode that changes nothing");
  });
});

await t("the folder path never appears in the command text", async () => {
  await withRig({}, async ({ store, runner, m, setClock }) => {
    store.create("u1", { task: "sort_by_type", folder: "C:\\Users\\rjfla\\Fred's [stuff] & co", node: "laptop", tz: ET, atHour: 3 });
    setClock(THREE_AM);
    await runner.tick(THREE_AM);
    assert.ok(!m.calls[0].command.includes("Fred's"),
      "the path rides in base64 and is decoded inside PowerShell, so no quoting can ever break it");
  });
});

console.log(`\n${passed}/9 checks passed - a job that did not happen never looks like one that did`);
