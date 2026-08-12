/*
 * billing retry self-test. Run: node billing_retry_test.mjs
 *
 * Fred, 2026-08-12: "yes, fix it", about the retry schedule billing.mjs has always documented and
 * never had. Its own header promises that a failed auto-recharge "retries every few days for about a
 * week, then stops trying". Before this, `nextRetryAt` was written on every failure and read by
 * nothing anywhere in the app, so BOTH halves of that sentence were false:
 *
 *   - nothing ever retried, because there was no sweep, no cron and no timer, and after the third
 *     failure the account locks and a locked account cannot chat, so the only code path that could
 *     have retried was unreachable by construction;
 *   - nothing waited either, because meterTurn calls autoRecharge on EVERY low turn and autoRecharge
 *     had no idea a retry was already scheduled, so a declining card was charged three times inside a
 *     couple of minutes and the account locked almost immediately.
 *
 * The second one is the one that hurt customers, and it is why the two halves had to land together:
 * adding the backoff without the sweep would mean nothing ever retries at all.
 *
 * The Stripe charger is injected, as it is everywhere in this module, so no test can touch real money.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBilling } from "./billing.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };

const dirs = [];
function rig({ charge } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "billing-retry-"));
  dirs.push(dir);
  const statuses = new Map();
  const users = {
    setStatus: (email, s) => statuses.set(String(email).toLowerCase(), s),
    get: (email) => ({ status: statuses.get(String(email).toLowerCase()) || "active" }),
  };
  const calls = [];
  // ONE place records a call. The first version had the default charger push as well as the wrapper,
  // so every charge counted twice and two assertions failed against the rig rather than the code.
  const charger = charge || (async () => ({ ok: false, error: "card_declined" }));
  const billing = createBilling({ dir, users, charge: async (a) => { calls.push(a); return charger(a); } });
  return { billing, users, calls, statuses, dir };
}

// A card user with auto-recharge armed and a card on file: the state a real paying customer is in.
function readyCustomer(billing, email = "a@b.c") {
  billing.grantUsd(email, 12.5, "seed");
  billing.setStripe(email, "cus_123", "pm_123");
  billing.setAutorecharge(email, true, 25);
  return email;
}

console.log("\n=== the backoff: a declining card is not charged three times in two minutes ===");

await t("a first failure schedules a retry and does not lock", async () => {
  const { billing } = rig();
  const email = readyCustomer(billing);
  const r = await billing.autoRecharge(email);
  assert.equal(r.attempted, true);
  assert.equal(r.ok, false);
  assert.equal(r.fails, 1);
  assert.ok(!r.locked, "one decline must not lock an account");
  assert.equal(billing.account(email).rechargeFails, 1);
});

await t("THE BUG: a second attempt straight afterwards is refused, not charged", async () => {
  const { billing, calls } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const chargesAfterFirst = calls.length;

  // This is what meterTurn does on the very next low turn, seconds later.
  const second = await billing.autoRecharge(email);
  assert.equal(second.attempted, false, "the card was charged again immediately");
  assert.equal(second.reason, "backoff");
  assert.ok(second.retryAt, "a backoff refusal must say when it will try again");
  assert.equal(calls.length, chargesAfterFirst, "a charge reached the provider during the backoff");
  assert.equal(billing.account(email).rechargeFails, 1, "a refused attempt must not burn a retry");
});

await t("a hundred low turns during the backoff produce zero further charges", async () => {
  const { billing, calls } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const after = calls.length;
  for (let i = 0; i < 100; i++) await billing.autoRecharge(email);
  assert.equal(calls.length, after, "the old behaviour: a busy account hammering a declined card");
});

await t("force bypasses the backoff, because a finished video still has to be paid for", async () => {
  const { billing, calls } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const after = calls.length;
  const forced = await billing.autoRecharge(email, { force: true });
  assert.equal(forced.attempted, true, "the settlement path was blocked by a backoff it must ignore");
  assert.equal(calls.length, after + 1);
});

await t("a success clears the backoff and the fail counter, and unlocks", async () => {
  let ok = false;
  const { billing, statuses } = rig({ charge: async () => (ok ? { ok: true, id: "pi_1" } : { ok: false, error: "card_declined" }) });
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  assert.equal(billing.account(email).rechargeFails, 1);

  ok = true;
  const good = await billing.autoRecharge(email, { force: true });
  assert.equal(good.ok, true);
  assert.equal(billing.account(email).rechargeFails, 0, "a success must clear the counter");
  assert.equal(statuses.get(email) || "active", "active");
  // And with the counter cleared there is no backoff left to trip over.
  const next = await billing.autoRecharge(email);
  assert.equal(next.attempted, true, "a recovered account is still stuck behind a stale backoff");
});

console.log("\n=== the sweep: the retry that the header has always promised ===");

await t("nothing is due before its retry time", async () => {
  const { billing } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  assert.equal(billing.dueForRetry(new Date().toISOString()).length, 0,
    "an account became due immediately, so the schedule means nothing");
});

await t("it becomes due once the retry time passes", async () => {
  const { billing } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const later = new Date(Date.now() + 4 * 86400000).toISOString();   // 4 days, one interval on
  const due = billing.dueForRetry(later);
  assert.equal(due.length, 1, "the account never became due, which is the original bug");
  assert.equal(due[0].email, email);
});

await t("the sweep retries a due account and recovers it", async () => {
  let ok = false;
  const { billing, statuses } = rig({ charge: async () => (ok ? { ok: true, id: "pi_2" } : { ok: false, error: "card_declined" }) });
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const balanceBefore = billing.balance(email);

  ok = true;   // the customer fixed their card
  const later = new Date(Date.now() + 4 * 86400000).toISOString();
  const r = await billing.retryDueRecharges({ at: later });
  assert.equal(r.due, 1);
  assert.equal(r.ok, 1, "the sweep did not recover a recoverable account");
  assert.ok(billing.balance(email) > balanceBefore, "credits were never granted");
  assert.equal(billing.account(email).rechargeFails, 0);
  assert.equal(statuses.get(email) || "active", "active");
});

await t("a still-declining card is counted, rescheduled, and eventually locked, then left alone", async () => {
  const { billing, statuses } = rig();
  const email = readyCustomer(billing);

  await billing.autoRecharge(email);                       // fail 1
  assert.equal(billing.account(email).rechargeFails, 1);

  let at = new Date(Date.now() + 4 * 86400000).toISOString();
  let r = await billing.retryDueRecharges({ at });          // fail 2
  assert.equal(r.due, 1); assert.equal(r.failed, 1); assert.equal(r.locked, 0);
  assert.equal(billing.account(email).rechargeFails, 2);
  assert.notEqual(statuses.get(email), "locked", "two failures must not lock");

  at = new Date(Date.now() + 8 * 86400000).toISOString();
  r = await billing.retryDueRecharges({ at });              // fail 3 -> locked
  assert.equal(r.failed, 1);
  assert.equal(r.locked, 1, "the third failure must lock the account");
  assert.equal(statuses.get(email), "locked");

  // "then stops trying": a locked account has no retry time, so it is never due again.
  at = new Date(Date.now() + 60 * 86400000).toISOString();
  assert.equal(billing.dueForRetry(at).length, 0, "a locked account is still being chased");
  assert.equal((await billing.retryDueRecharges({ at })).due, 0);
});

await t("the whole documented schedule is about a week, and no longer", async () => {
  const { billing } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  let attempts = 1;
  for (let day = 1; day <= 30 && billing.account(email).rechargeFails < 3; day++) {
    const at = new Date(Date.now() + day * 86400000).toISOString();
    const r = await billing.retryDueRecharges({ at });
    attempts += r.due;
  }
  assert.equal(attempts, 3, "the card was tried " + attempts + " times, not the documented three");
});

console.log("\n=== a deliberate switch-off survives a purchase ===");

await t("buying credits arms auto top-off for someone who never touched the setting", async () => {
  const { billing } = rig();
  const email = "fresh@b.c";
  const r = billing.grantSession("sess_1", email, 1000);
  assert.equal(r.ok, true);
  assert.equal(billing.account(email).autorecharge, true,
    "a first purchase should arm top-off, so a long job does not die at the floor");
  assert.equal(billing.account(email).topOffOptOut, false);
});

await t("THE FIX: a purchase does NOT undo a deliberate switch-off", async () => {
  const { billing } = rig();
  const email = "optout@b.c";
  billing.grantSession("sess_2", email, 1000);          // first purchase arms it
  billing.setAutorecharge(email, false, 25);             // the user deliberately turns it off
  assert.equal(billing.account(email).autorecharge, false);
  assert.equal(billing.account(email).topOffOptOut, true, "the opt-out was not recorded");

  const r = billing.grantSession("sess_3", email, 1000); // ...and buys credits an hour later
  assert.equal(r.ok, true, "the purchase itself must still work");
  assert.equal(billing.account(email).autorecharge, false,
    "buying credits silently switched top-off back on, which is exactly what the user was told would not happen");
  assert.equal(r.topOffOptOut, true, "the grant did not report that it respected the opt-out");
  assert.ok(billing.balance(email) > 1000, "the credits were not actually granted");
});

await t("turning it back on clears the opt-out, so it behaves normally again", async () => {
  const { billing } = rig();
  const email = "backon@b.c";
  billing.setAutorecharge(email, false, 25);
  assert.equal(billing.account(email).topOffOptOut, true);
  billing.setAutorecharge(email, true, 25);
  assert.equal(billing.account(email).topOffOptOut, false, "the opt-out outlived the user turning it back on");
  assert.equal(billing.account(email).autorecharge, true);
  // And a later purchase is free to re-arm it, because there is no standing "no" any more.
  billing.grantSession("sess_4", email, 1000);
  assert.equal(billing.account(email).autorecharge, true);
});

await t("an opted-out account is never chased by the retry sweep either", async () => {
  const { billing } = rig();
  const email = readyCustomer(billing, "optout2@b.c");
  await billing.autoRecharge(email);                     // fails, schedules a retry
  billing.setAutorecharge(email, false, 25);             // then the user opts out
  const later = new Date(Date.now() + 4 * 86400000).toISOString();
  assert.equal(billing.dueForRetry(later).length, 0,
    "a user who opted out is still in the retry queue and would be charged");
});

await t("the opt-out defaults to off, so every existing account keeps today's behaviour", async () => {
  const { billing } = rig();
  const email = "legacy@b.c";
  billing.grantUsd(email, 12.5, "seed");
  assert.equal(billing.account(email).topOffOptOut, false,
    "the migration changed behaviour for accounts that never used the switch");
});

console.log("\n=== who the sweep refuses to touch ===");

await t("an account that switched auto-recharge off is never chased", async () => {
  const { billing } = rig();
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  billing.setAutorecharge(email, false, 25);
  const later = new Date(Date.now() + 4 * 86400000).toISOString();
  assert.equal(billing.dueForRetry(later).length, 0, "a user who opted out is still being charged");
});

await t("an account with no saved card is never chased", async () => {
  const { billing } = rig();
  const email = "nocard@b.c";
  billing.grantUsd(email, 12.5, "seed");
  billing.setAutorecharge(email, true, 25);
  const r = await billing.autoRecharge(email);
  assert.equal(r.reason, "no_payment_method");
  const later = new Date(Date.now() + 4 * 86400000).toISOString();
  assert.equal(billing.dueForRetry(later).length, 0,
    "an account with nothing to charge is in the sweep, so it would relock every hour");
});

await t("a healthy account is never in the sweep", async () => {
  const { billing } = rig({ charge: async () => ({ ok: true, id: "pi_ok" }) });
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const later = new Date(Date.now() + 400 * 86400000).toISOString();
  assert.equal(billing.dueForRetry(later).length, 0, "a paying customer is in the retry queue");
});

await t("the sweep is bounded, so a backlog cannot stampede the provider", async () => {
  const { billing, calls } = rig();
  for (let i = 0; i < 12; i++) {
    const email = "u" + i + "@b.c";
    readyCustomer(billing, email);
    await billing.autoRecharge(email);
  }
  const before = calls.length;
  const later = new Date(Date.now() + 4 * 86400000).toISOString();
  const r = await billing.retryDueRecharges({ at: later, limit: 5 });
  assert.equal(r.due, 5, "the batch limit was ignored");
  assert.equal(calls.length - before, 5, "more charges were sent than the batch allowed");
});

await t("an empty sweep is cheap and silent", async () => {
  const { billing, calls } = rig();
  const r = await billing.retryDueRecharges({});
  assert.deepEqual(r, { due: 0, ok: 0, failed: 0, locked: 0 });
  assert.equal(calls.length, 0);
});

await t("the sweep never throws, whatever it is handed", async () => {
  const { billing } = rig({ charge: async () => { throw new Error("provider exploded"); } });
  const email = readyCustomer(billing);
  await billing.autoRecharge(email);
  const later = new Date(Date.now() + 4 * 86400000).toISOString();
  await billing.retryDueRecharges({ at: later });
  await billing.retryDueRecharges({ at: "not a date" });
  await billing.retryDueRecharges({ at: later, limit: -5 });
  await billing.retryDueRecharges({ at: later, limit: 99999 });
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\nbilling_retry_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
