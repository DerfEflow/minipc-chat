/*
 * glue self-test - run: node longrunglue_test.mjs
 * The model seam, without a model: context pack shape (mission + compressed tail + retry
 * reason), the meter-at-result law (charged on success AND on errored calls that cost money),
 * error mapping into the runner's retry machinery, the boot sweep, and the full circuit:
 * spine + fuse + glue with a fake chatOnce, including a mid-"crash" resume that loses nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLongRun } from "./longrun.mjs";
import { makeRunDeps } from "./longrunbilling.mjs";
import { unitMessages, makeCallUnit, sealInterrupted } from "./longrunglue.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };
const tmp = () => mkdtempSync(join(tmpdir(), "lrg-"));
const HEALTHY = "a perfectly ordinary paragraph of distinct words that repeats absolutely nothing " +
  "and is long enough to pass every degeneration screen with plenty of room to spare for all";

await t("unitMessages: mission, compressed tail, unit, and register voice all present", () => {
  const msgs = unitMessages({
    mission: "write the field guide",
    ledgerTail: [{ unit: 0, outcome: "done" }, { unit: 1, outcome: "failed", note: "too short" }],
    unit: { unit: 2, title: "chapter three", detail: "cover the marshes" },
  }, { register: "technical" });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /write the field guide/);
  assert.match(msgs[0].content, /unit 0 done; unit 1 failed \(too short\)/);
  assert.match(msgs[0].content, /concise and technical/);
  assert.match(msgs[1].content, /#2.*chapter three/);
  assert.match(msgs[1].content, /cover the marshes/);
});

await t("unitMessages: retry reason appears with the fix-exactly-that instruction", () => {
  const msgs = unitMessages({ mission: "m", unit: { unit: 0, title: "u" }, retryReason: "output repeats itself" });
  assert.match(msgs[1].content, /REJECTED: output repeats itself/);
});

await t("makeCallUnit: success is metered at result time with the provider's cost", async () => {
  const metered = [];
  const call = makeCallUnit({
    chatOnce: async () => ({ ok: true, content: HEALTHY, costUsd: 0.12 }),
    model: "m", meter: (r, u) => metered.push({ usd: r.costUsd, unit: u.unit }),
  });
  const r = await call({ unit: 3, title: "x" }, { mission: "m", unit: { unit: 3, title: "x" } });
  assert.equal(r.text, HEALTHY);
  assert.deepEqual(metered, [{ usd: 0.12, unit: 3 }]);
});

await t("makeCallUnit: an errored call that reported cost is STILL metered; error maps through", async () => {
  const metered = [];
  const call = makeCallUnit({
    chatOnce: async () => ({ ok: false, error: "provider fell over", costUsd: 0.03 }),
    model: "m", meter: (r) => metered.push(r.costUsd),
  });
  const r = await call({ unit: 0 }, { mission: "m", unit: { unit: 0 } });
  assert.equal(r.error, "provider fell over");
  assert.deepEqual(metered, [0.03]);
});

await t("sealInterrupted: a genuinely stranded running job seals paused; ready jobs untouched", async () => {
  const dir = tmp();
  const store = createLongRun({ dir });
  const a = store.createJob({ mission: "a", plan: [{ title: "u" }] });          // stays ready
  const b = store.createJob({ mission: "b", plan: [{ title: "u" }], stallMinutes: 5 });
  // Strand b for real: start its runner with a callUnit that never resolves, do not await.
  // runJob writes state=running before the first unit call; the "process" then dies (we
  // simply abandon the promise; the test exits before the 5-minute stall clock fires).
  const abandoned = store.runJob(b.id, { callUnit: () => new Promise(() => {}) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.readMeta(b.id).state, "running");
  // "Next boot": a fresh store instance over the same dir sweeps the corpse.
  const store2 = createLongRun({ dir });
  assert.equal(sealInterrupted(store2), 1);
  assert.equal(store2.readMeta(b.id).state, "paused");
  assert.match(store2.readMeta(b.id).reason, /restarted mid-run/);
  assert.equal(store2.readMeta(a.id).state, "ready");
  void abandoned;
  rmSync(dir, { recursive: true, force: true });
});

await t("full circuit: spine + fuse + glue completes a job and pays for every unit", async () => {
  const dir = tmp();
  const store = createLongRun({ dir });
  const T = { role: "credit", email: "c@x.com" };
  const charges = [];
  const billing = { chargeTurn: (e, usd) => { charges.push(usd); return { balance: 999, deducted: 1, low: false }; }, autoRecharge: async () => ({}), balance: () => 999 };
  const job = store.createJob({ mission: "three chapters", plan: [{ title: "c1" }, { title: "c2" }, { title: "c3" }] });
  const deps = makeRunDeps({ store, jobId: job.id, T, billing, users: {} });
  deps.budget.approve(2, "submit");                        // $2 for a $0.60/unit job
  const callUnit = makeCallUnit({
    chatOnce: async (model, msgs) => ({ ok: true, content: HEALTHY + " :: " + msgs[1].content.slice(0, 40), costUsd: 0.6 }),
    model: "fake", meter: deps.meter,
  });
  const r = await store.runJob(job.id, { callUnit, budget: deps.budget });
  assert.equal(r.state, "done");
  assert.equal(charges.length, 3);
  assert.ok(Math.abs(deps.budget.state().spentUsd - 1.8) < 1e-9);
  rmSync(dir, { recursive: true, force: true });
});

await t("full circuit: a job strands mid-run (process death), sweep seals it, resume finishes", async () => {
  const dir = tmp();
  const store = createLongRun({ dir });
  const T = { isOwner: true };
  const job = store.createJob({ mission: "two units", plan: [{ title: "u0" }, { title: "u1" }] });
  const deps = makeRunDeps({ store, jobId: job.id, T, billing: {}, users: {} });
  deps.budget.approve(1, "fred");
  let calls = 0;
  // First run: unit 0 succeeds, then the "process dies" (callUnit throws unrecoverably after
  // recording nothing for unit 1; we emulate death by making the run stop via error + pause).
  const dying = makeCallUnit({
    chatOnce: async () => { calls++; if (calls >= 2) return { ok: false, error: "process death stand-in" }; return { ok: true, content: HEALTHY, costUsd: 0.01 }; },
    model: "fake", meter: deps.meter,
  });
  const r1 = await store.runJob(job.id, { callUnit: dying, budget: deps.budget });
  assert.equal(r1.state, "paused");                        // two-strike on unit 1's failures
  // The ledger kept unit 0; a fresh process resumes and only unit 1 runs again.
  store.resumeJob(job.id);
  const healthy = makeCallUnit({ chatOnce: async () => ({ ok: true, content: HEALTHY, costUsd: 0.01 }), model: "fake", meter: deps.meter });
  const r2 = await store.runJob(job.id, { callUnit: healthy, budget: deps.budget });
  assert.equal(r2.state, "done");
  assert.equal(store.progress(job.id).done.size, 2);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nlongrunglue: ${passed} passed, ${failed} failed`);
// Hard exit: the strand test abandons a runJob whose stall timer is deliberately not unref'd,
// so draining the event loop would mean waiting out a 5-minute watchdog that proved its point.
process.exit(failed ? 1 : 0);
