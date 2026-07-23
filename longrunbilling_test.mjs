/*
 * longrun billing self-test - run: node longrunbilling_test.mjs
 * Item 5 money paths, deterministically, no Stripe and no model: D2 policy clamps, append-only
 * fold durability (incl. a simulated crash re-fold), the guest outstanding-tranche cap, the
 * zero-balance approve gate, chargeUnit routing (owner/credit/sponsored), and the full runJob
 * integration: a job that trips its fuse mid-run, pauses honestly, resumes on approval.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLongRun } from "./longrun.mjs";
import {
  tranchePolicy, createJobBudget, chargeUnit, canApprove, makeRunDeps,
  GUEST_TRANCHE_USD, GUEST_TRANCHE_CEILING_USD, GUEST_MAX_OUTSTANDING_TRANCHES, OWNER_TRANCHE_USD,
} from "./longrunbilling.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };
const tmp = () => mkdtempSync(join(tmpdir(), "lrb-"));

// Mock billing: real-ish math (ceil x100, min 1, floor at zero), records every charge.
function mockBilling(initial = {}) {
  const bal = { ...initial };
  const charges = [];
  return {
    charges,
    balance: (e) => bal[e] || 0,
    chargeTurn: (e, usd) => {
      const ded = Math.max(1, Math.ceil((Number(usd) || 0) * 100));
      bal[e] = Math.max(0, (bal[e] || 0) - ded);
      charges.push({ email: e, usd, deducted: ded });
      return { balance: bal[e], deducted: ded, low: bal[e] <= 100 };
    },
    autoRecharge: async () => ({ attempted: false }),
  };
}
function mockUsers() {
  const spends = [];
  return { spends, addSponsoredSpend: (e, usd) => spends.push({ email: e, usd }) };
}

// ---- D2 policy ----
await t("policy: guest default $1, ceiling $2, owner default $5, owner free choice", () => {
  assert.equal(tranchePolicy("credit"), GUEST_TRANCHE_USD);
  assert.equal(tranchePolicy("credit", 5), GUEST_TRANCHE_CEILING_USD);
  assert.equal(tranchePolicy("credit", 0.5), 0.5);
  assert.equal(tranchePolicy("owner"), OWNER_TRANCHE_USD);
  assert.equal(tranchePolicy("owner", 50), 50);
  assert.equal(tranchePolicy("credit", -3), GUEST_TRANCHE_USD);
});

// ---- fold durability ----
await t("budget: approvals and spends fold from disk; a second instance agrees exactly", () => {
  const dir = tmp();
  const b1 = createJobBudget({ jobDir: dir, role: "credit" });
  b1.approve(2, "test");                       // $2 approved
  b1.spend(0.37, 0); b1.spend(0.5, 1);
  assert.ok(Math.abs(b1.remaining() - 1.13) < 1e-9);
  const b2 = createJobBudget({ jobDir: dir, role: "credit" });   // "after the crash"
  assert.ok(Math.abs(b2.remaining() - 1.13) < 1e-9);
  assert.equal(b2.state().tranchesApproved, 2);
  rmSync(dir, { recursive: true, force: true });
});

// ---- guest outstanding cap ----
await t("budget: guest outstanding tranches cap at 10; overflow clamps with an honest message", () => {
  const dir = tmp();
  const b = createJobBudget({ jobDir: dir, role: "credit" });
  const r1 = b.approve(10, "submit");
  assert.equal(r1.approvedTranches, 10);
  const r2 = b.approve(1, "greedy");
  assert.ok(r2.error && r2.error.includes("limit is 10"));
  b.spend(9.5, 0);                             // burn most of it down
  const r3 = b.approve(10, "again");           // 0.5 unspent = 1 outstanding -> room for 9
  assert.equal(r3.approvedTranches, 9);
  const owner = createJobBudget({ jobDir: tmp(), role: "owner" });
  assert.equal(owner.approve(100, "fred").approvedTranches, 100);   // owner unlimited
  rmSync(dir, { recursive: true, force: true });
});

// ---- approve gate ----
await t("gate: zero-balance credit user cannot approve; funded can; sponsored and owner always", () => {
  const billing = mockBilling({ "poor@x.com": 0, "rich@x.com": 500 });
  const usd = 1;
  assert.equal(canApprove({ T: { role: "credit", email: "poor@x.com" }, billing, usd }).ok, false);
  assert.equal(canApprove({ T: { role: "credit", email: "poor@x.com" }, billing, usd }).code, "needs_credits");
  assert.equal(canApprove({ T: { role: "credit", email: "rich@x.com" }, billing, usd }).ok, true);
  assert.equal(canApprove({ T: { role: "sponsored", email: "s@x.com" }, billing, usd }).ok, true);
  assert.equal(canApprove({ T: { isOwner: true }, billing, usd }).ok, true);
});

// ---- chargeUnit routing ----
await t("chargeUnit: owner never metered; credit pays ceil x100; sponsored draws the cap", () => {
  const billing = mockBilling({ "c@x.com": 500 });
  const users = mockUsers();
  assert.equal(chargeUnit({ T: { isOwner: true }, billing, users, costUsd: 1 }).charged, false);
  const r = chargeUnit({ T: { role: "credit", email: "c@x.com" }, billing, users, costUsd: 0.037 });
  assert.equal(r.credits, 4);                  // ceil(3.7) = 4 credits
  assert.equal(billing.balance("c@x.com"), 496);
  chargeUnit({ T: { role: "sponsored", email: "s@x.com" }, billing, users, costUsd: 0.25 });
  assert.deepEqual(users.spends, [{ email: "s@x.com", usd: 0.25 }]);
  assert.equal(chargeUnit({ T: { role: "credit", email: "c@x.com" }, billing, users, costUsd: 0 }).charged, false);
});

// ---- the full integration: fuse trips mid-job, approval resumes ----
await t("runJob: real fuse pauses at exhaustion, approve-tranche + resume completes the job", async () => {
  const dir = tmp();
  const store = createLongRun({ dir });
  const T = { role: "credit", email: "c@x.com" };
  const billing = mockBilling({ "c@x.com": 10000 });   // $100 of credits, plenty
  const users = mockUsers();
  const job = store.createJob({ mission: "write three chapters", plan: [
    { title: "ch1" }, { title: "ch2" }, { title: "ch3" },
  ] });
  const deps = makeRunDeps({ store, jobId: job.id, T, billing, users });
  assert.equal(deps.budget.perTrancheUsd, GUEST_TRANCHE_USD);
  deps.budget.approve(1, "submit");            // one $1 tranche
  // Each unit costs $0.60: units 0 and 1 exhaust the $1 tranche (spend 1.20, remaining -0.20),
  // so the check before unit 2 trips.
  const text = "a healthy paragraph of perfectly ordinary prose that repeats nothing at all " +
    "and carries enough words to pass every degeneration screen with room to spare";
  const callUnit = async (unit) => {
    const r = { text: text + " unit " + unit.unit, costUsd: 0.6, tokens: 900 };
    deps.meter(r, unit);                       // glue-phase law: meter at result time
    return r;
  };
  const r1 = await store.runJob(job.id, { callUnit, budget: deps.budget });
  assert.equal(r1.state, "paused");
  assert.match(r1.reason, /tranche exhausted/);
  assert.equal(store.progress(job.id).done.size, 2);       // two units landed before the trip
  assert.equal(billing.charges.length, 2);                 // and both were REALLY charged
  const ap = deps.budget.approve(1, "fred said go");
  assert.equal(ap.ok, true);
  store.resumeJob(job.id);
  const r2 = await store.runJob(job.id, { callUnit, budget: deps.budget });
  assert.equal(r2.state, "done");
  assert.equal(r2.units, 3);
  assert.equal(billing.charges.length, 3);
  const st = deps.budget.state();
  assert.ok(Math.abs(st.spentUsd - 1.8) < 1e-9);
  rmSync(dir, { recursive: true, force: true });
});

// ---- sabotage: runaway cost trips in one unit, never kills, resumes exactly ----
await t("sabotage: a runaway unit burns the fuse immediately; the job pauses, never dies", async () => {
  const dir = tmp();
  const store = createLongRun({ dir });
  const T = { role: "credit", email: "c@x.com" };
  const billing = mockBilling({ "c@x.com": 10000 });
  const users = mockUsers();
  const job = store.createJob({ mission: "sabotage", plan: [{ title: "u0" }, { title: "u1" }] });
  const deps = makeRunDeps({ store, jobId: job.id, T, billing, users });
  deps.budget.approve(1, "submit");
  const callUnit = async (unit) => {
    const r = { text: "ordinary healthy output with plenty of distinct words in a row here", costUsd: 9.99 };
    deps.meter(r, unit);                       // runaway: one unit devours the whole tranche
    return r;
  };
  const r = await store.runJob(job.id, { callUnit, budget: deps.budget });
  assert.equal(r.state, "paused");             // paused, not halted, not dead
  assert.equal(store.progress(job.id).done.size, 1);       // the unit that ran still COUNTS
  assert.ok(deps.budget.remaining() < 0);      // overshoot is visible and honest
  rmSync(dir, { recursive: true, force: true });
});

// ---- torn-line refold, done properly ----
await t("budget: fold survives a torn trailing line from a mid-append kill", async () => {
  const { appendFileSync } = await import("node:fs");
  const dir = tmp();
  const b = createJobBudget({ jobDir: dir, role: "credit" });
  b.approve(2, "t");
  b.spend(0.25, 0);
  appendFileSync(join(dir, "budget.jsonl"), '{"type":"spend","usd":0.5');   // the kill
  const b2 = createJobBudget({ jobDir: dir, role: "credit" });
  assert.ok(Math.abs(b2.remaining() - 1.75) < 1e-9);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nlongrunbilling: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
