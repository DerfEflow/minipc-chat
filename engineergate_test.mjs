/*
 * Engineer gate tests — run with: node --test engineergate_test.mjs
 * Fred's hard rule (2026-07-25): the Engineer interface requires Automatic Top-Off, armed with one
 * click inside Engineer, disarmed only in settings — and disarming blocks Engineer immediately.
 * Money-adjacent, so every rule is pinned against createIdeFeature with a mocked billing ledger.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdeFeature, createIdeGate } from "./ide.mjs";

function rig({ autorecharge = false, hasCard = false } = {}) {
  const acct = { autorecharge, hasCard, topupUsd: 12.5 };
  const calls = [];
  const prefs = { engaged: true, mode: "", language: "technical", assignments: {} };
  const feature = createIdeFeature({
    gate: createIdeGate("all"),
    storeFor: () => ({
      prefs: () => ({ ...prefs }),
      setPrefs: (p) => { for (const k of Object.keys(p)) if (p[k] !== undefined) prefs[k] = p[k]; return { ...prefs }; },
      list: () => [],
    }),
    jobs: { listFor: () => [] },
    billing: { account: () => ({ ...acct }), setAutorecharge: (email, on, usd) => { calls.push({ email, on, usd }); acct.autorecharge = !!on; return { ok: true }; } },
    multiTenant: true,
  });
  return { feature, acct, calls, prefs };
}
const CREDIT = { role: "credit", isOwner: false, email: "guest@example.com", uid: "u1", invited: true };
const SPONSORED = { role: "sponsored", isOwner: false, email: "kid@example.com", uid: "u2", invited: true };
const OWNER = { role: "owner", isOwner: true, email: "fred@example.com", uid: "owner", invited: true };

test("credit user without top-off: Engineer entry refused with the enable payload", () => {
  const { feature } = rig({ autorecharge: false, hasCard: false });
  const r = feature.setPrefs(CREDIT, { mode: "engineer" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "engineer_topoff_required");
  assert.equal(r.body.needsCard, true, "no card -> the panel routes to Setup");
});

test("card saved but auto-recharge off: still refused, needsCard false (one click arms it)", () => {
  const { feature } = rig({ autorecharge: false, hasCard: true });
  const r = feature.setPrefs(CREDIT, { mode: "engineer" });
  assert.equal(r.status, 403);
  assert.equal(r.body.needsCard, false);
});

test("one-click arm: topoffEnable flips auto-recharge on, then Engineer opens", () => {
  const { feature, calls } = rig({ autorecharge: false, hasCard: true });
  const e = feature.topoffEnable(CREDIT);
  assert.equal(e.body.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].on, true);
  const r = feature.setPrefs(CREDIT, { mode: "engineer" });
  assert.equal(r.status, 200, "gate passes the moment top-off is armed");
  assert.equal(r.body.prefs.mode, "engineer");
});

test("topoffEnable without a card: honest needsCard, nothing armed", () => {
  const { feature, calls } = rig({ autorecharge: false, hasCard: false });
  const e = feature.topoffEnable(CREDIT);
  assert.equal(e.body.ok, false);
  assert.equal(e.body.needsCard, true);
  assert.equal(calls.length, 0);
});

test("disarming later blocks Engineer immediately (live re-check, no cached grant)", () => {
  const { feature, acct } = rig({ autorecharge: true, hasCard: true });
  assert.equal(feature.setPrefs(CREDIT, { mode: "engineer" }).status, 200);
  acct.autorecharge = false;   // user turns it off in settings
  const r = feature.setPrefs(CREDIT, { mode: "engineer" });
  assert.equal(r.status, 403, "the gate reads live billing state every time");
  assert.ok(feature.engineerGate(CREDIT), "engineerGate reports the lapse for downgrade-on-read");
});

test("sponsored accounts cannot arm it and are told plainly", () => {
  const { feature } = rig({});
  const r = feature.setPrefs(SPONSORED, { mode: "engineer" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "engineer_unavailable");
  assert.equal(feature.topoffEnable(SPONSORED).status, 403);
});

test("the owner is exempt; single-tenant mode is fully dormant", () => {
  const { feature } = rig({});
  assert.equal(feature.setPrefs(OWNER, { mode: "engineer" }).status, 200);
  assert.equal(feature.topoffEnable(OWNER).body.exempt, true);
  const single = createIdeFeature({ gate: createIdeGate("all"),
    storeFor: () => ({ prefs: () => ({}), setPrefs: (p) => p, list: () => [] }),
    jobs: { listFor: () => [] }, billing: null, multiTenant: false });
  assert.equal(single.setPrefs(CREDIT, { mode: "engineer" }).status, 200, "no tenancy -> no gate");
});

test("non-engineer modes pass through untouched (the gate guards one door only)", () => {
  const { feature } = rig({});
  for (const m of ["beginner", "vibe", ""]) {
    const r = feature.setPrefs(CREDIT, { mode: m });
    assert.equal(r.status, 200, "mode " + JSON.stringify(m) + " must not be gated");
  }
});
