/*
 * billing self-test — run: node billing_test.mjs
 * Covers the money paths deterministically with a mock users store and a mock charge (no real Stripe):
 * pricing math, grant/deduct, floor at zero, both code types, redemption + role activation, revoke,
 * and the auto-recharge / lock state machine.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBilling, creditsForUsd, creditsForCostUsd, usdValueOfCredits, MIN_TOPUP_USD } from "./billing.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// mock users store — records role/status/cap changes
function mockUsers() {
  const state = {};
  const u = (e) => (state[e] = state[e] || { role: "credit", status: "active", cap: 20 });
  return {
    _state: state,
    ensure: (e) => u(e),
    setRole: (e, r) => { u(e).role = r; return { ok: true }; },
    setStatus: (e, s) => { u(e).status = s; return { ok: true }; },
    setSponsoredCap: (e, c) => { u(e).cap = c; return { ok: true }; },
  };
}

// ---- pricing math ----
await t("pricing: $12.50 buys 1000 credits (25% markup)", () => {
  assert.equal(creditsForUsd(12.5), 1000);
  assert.equal(creditsForUsd(25), 2000);
  assert.equal(usdValueOfCredits(1000), 10);           // 1000 credits = $10 of token value
});
/*
 * A turn deducts EXACTLY what it cost (Fred, 2026-07-31: "I've never authorized a minimum spend").
 * The old rule was Math.max(1, ceil(usd * 100)), which charged a whole credit for a turn costing a
 * fraction of one and, worse, charged a whole credit for a turn that cost nothing, so the free
 * NVIDIA fleet quietly billed a credit per message. These assertions are the shape of the fix:
 * proportional below one credit, and zero when the turn was free.
 */
await t("pricing: a turn deducts cost x 100 exactly, with no minimum", () => {
  assert.equal(creditsForCostUsd(0.5), 50);
  assert.equal(creditsForCostUsd(0.00005), 0.005);     // Fred's example: .005 credits, charged as .005
  assert.equal(creditsForCostUsd(0.001), 0.1);         // a tenth of a credit, not a whole one
  assert.equal(creditsForCostUsd(0), 0);               // free is free
  assert.equal(creditsForCostUsd(-1), 0);              // never a negative charge
});
await t("pricing: a free model costs the user nothing across a whole conversation", () => {
  // The reported bug: four messages on a free model took four credits.
  let charged = 0;
  for (let turn = 0; turn < 4; turn++) charged += creditsForCostUsd(0);
  assert.equal(charged, 0, "four free turns must cost nothing");
});

const dir = mkdtempSync(join(tmpdir(), "billing-"));

await t("grant + balance + deduct + floor at zero", () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "a"), users });
  assert.equal(b.balance("x@y.com"), 0);
  b.grantUsd("x@y.com", 12.5, "topup");
  assert.equal(b.balance("x@y.com"), 1000);
  const r = b.chargeTurn("x@y.com", 2);                 // $2 cost -> 200 credits
  assert.equal(r.deducted, 200); assert.equal(r.balance, 800); assert.equal(r.low, false);
  b.chargeTurn("x@y.com", 100);                          // overspend -> floors at 0, never negative
  assert.equal(b.balance("x@y.com"), 0);
});

await t("chargeTurn flags low at/below the $1 threshold", () => {
  const b = createBilling({ dir: join(dir, "b"), users: mockUsers() });
  b.grantUsd("z@y.com", 12.5);                           // 1000 credits
  b.chargeTurn("z@y.com", 9.5);                          // -950 -> 50 left (<=100)
  assert.equal(b.balance("z@y.com"), 50);
  const r = b.chargeTurn("z@y.com", 0);                  // deduct 1 -> 49, low
  assert.equal(r.low, true);
});

await t("invite code: redeem activates a CREDIT user but HOLDS promo as a welcome bonus (pay-before-access)", () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "c"), users });
  const code = b.mintCode({ type: "invite", credits: 500, note: "friend" });
  assert.match(code.code, /^DOMI-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const r = b.redeem(code.code, "friend@x.com");
  assert.equal(r.ok, true); assert.equal(r.role, "credit");
  assert.equal(r.pendingPromo, 500);
  assert.equal(users._state["friend@x.com"].role, "credit");
  assert.equal(users._state["friend@x.com"].status, "active");
  assert.equal(b.balance("friend@x.com"), 0);            // NOT spendable yet
  assert.equal(b.canChat("friend@x.com"), false);         // chat locked until first purchase
  assert.equal(b.hasPaid("friend@x.com"), false);
  assert.equal(b.account("friend@x.com").pendingPromo, 500);
});

/*
 * UPDATED 2026-08-12 on Fred's instruction ("yes it should", about a deliberate switch-off sticking).
 *
 * This used to turn auto-recharge OFF before the purchase, with the comment "even if they opted out
 * pre-purchase", and assert the purchase turned it back on as mandatory. That was the real behaviour
 * and it was the defect: a user could ask Altana to switch off automatic top-off, be told plainly it
 * was off, buy credits an hour later, and have it silently back on with nothing said. The app was
 * reporting one state and holding another, which is the shape of bug this whole project keeps finding.
 *
 * The purchase still ARMS it for anyone who has not touched the switch, because a long job dying at
 * the balance floor is a worse experience than a top-up nobody minded. It no longer overrides an
 * explicit no. Both halves are asserted below, and billing_retry_test.mjs walks the full opt-out story.
 */
await t("first purchase releases the welcome bonus and arms auto-recharge by default", () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "c2"), users });
  const code = b.mintCode({ type: "invite", credits: 500 });
  b.redeem(code.code, "payer@x.com");
  const g = b.grantSession("cs_test_1", "payer@x.com", 1000);   // $12.50 purchase
  assert.equal(g.ok, true);
  assert.equal(b.balance("payer@x.com"), 1500);           // purchase + released bonus
  assert.equal(b.hasPaid("payer@x.com"), true);
  assert.equal(b.canChat("payer@x.com"), true);
  const a = b.account("payer@x.com");
  assert.equal(a.pendingPromo, 0);
  assert.equal(a.autorecharge, true);                     // armed for a user who never touched it
  assert.equal(a.topOffOptOut, false);
  const again = b.grantSession("cs_test_1", "payer@x.com", 1000);   // idempotent replay
  assert.equal(again.already, true);
  assert.equal(b.balance("payer@x.com"), 1500);           // bonus NOT double-released
});

await t("a deliberate switch-off survives a later purchase", () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "c3"), users });
  const code = b.mintCode({ type: "invite", credits: 500 });
  b.redeem(code.code, "nope@x.com");
  b.setAutorecharge("nope@x.com", false);                 // the user says no, on purpose
  const g = b.grantSession("cs_test_2", "nope@x.com", 1000);
  assert.equal(g.ok, true, "the purchase itself must still work");
  assert.equal(b.balance("nope@x.com"), 1500, "the welcome bonus must still be released");
  const a = b.account("nope@x.com");
  assert.equal(a.autorecharge, false, "buying credits silently overrode a setting the user was told was off");
  assert.equal(a.topOffOptOut, true);
});

await t("free code: redeem activates a SPONSORED user with the cap", () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "d"), users });
  const code = b.mintCode({ type: "free", capUsd: 20, note: "family" });
  const r = b.redeem(code.code, "mom@x.com");
  assert.equal(r.ok, true); assert.equal(r.role, "sponsored");
  assert.equal(users._state["mom@x.com"].role, "sponsored");
  assert.equal(users._state["mom@x.com"].cap, 20);
});

await t("codes are single-use and revocable", () => {
  const b = createBilling({ dir: join(dir, "e"), users: mockUsers() });
  const code = b.mintCode({ type: "invite" });
  assert.equal(b.redeem(code.code, "a@x.com").ok, true);
  assert.equal(b.redeem(code.code, "b@x.com").error, "code_used");
  assert.equal(b.redeem("DOMI-NOPE-NOPE", "b@x.com").error, "invalid_code");
  const c2 = b.mintCode({ type: "free" });
  b.revokeCode(c2.code);
  assert.equal(b.redeem(c2.code, "b@x.com").error, "code_revoked");
});

await t("auto-recharge with no saved card LOCKS the account", async () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "f"), users, charge: async () => ({ ok: true }) });
  b.grantUsd("nocard@x.com", 1); // tiny
  const r = await b.autoRecharge("nocard@x.com");
  assert.equal(r.locked, true);
  assert.equal(users._state["nocard@x.com"].status, "locked");
});

await t("auto-recharge with a working card grants credits and stays active", async () => {
  const users = mockUsers();
  let charged = 0;
  const b = createBilling({ dir: join(dir, "g"), users, charge: async ({ usd }) => { charged = usd; return { ok: true }; } });
  b.setStripe("ok@x.com", "cus_1", "pm_1");
  b.setAutorecharge("ok@x.com", true, 25);
  const r = await b.autoRecharge("ok@x.com");
  assert.equal(r.ok, true); assert.equal(charged, 25);
  assert.equal(b.balance("ok@x.com"), creditsForUsd(25));  // 2000
});

/*
 * UPDATED 2026-08-12, and the update IS the fix rather than an accommodation of it.
 *
 * This called autoRecharge three times in a row and asserted the third one locked the account. That
 * passed because autoRecharge ignored its own `nextRetryAt`, so a declining card could be charged
 * three times inside one loop. The header of billing.mjs has always promised the opposite: retries
 * "every few days for about a week". So the test was pinning the bug, and pinning it in the direction
 * that hurt customers, because meterTurn runs that same loop on every low turn and a real declining
 * card was hit three times in about two minutes before locking.
 *
 * Three failures still lock the account. They now have to be three ATTEMPTS ON DIFFERENT DAYS, which
 * is what the documentation always said and what billing_retry_test.mjs walks day by day. `force`
 * here stands in for the sweep arriving after the retry time has passed.
 */
await t("auto-recharge that keeps failing locks after the retry limit", async () => {
  const users = mockUsers();
  const b = createBilling({ dir: join(dir, "h"), users, charge: async () => ({ ok: false, error: "card_declined" }) });
  b.setStripe("bad@x.com", "cus_2", "pm_2");
  let last;
  for (let i = 0; i < 3; i++) last = await b.autoRecharge("bad@x.com", { force: true });
  assert.equal(last.locked, true);
  assert.equal(users._state["bad@x.com"].status, "locked");
});

await t("a declining card is NOT charged three times in a row without the retry wait", async () => {
  const users = mockUsers();
  let charges = 0;
  const b = createBilling({ dir: join(dir, "h2"), users, charge: async () => { charges++; return { ok: false, error: "card_declined" }; } });
  b.setStripe("bad2@x.com", "cus_3", "pm_3");
  for (let i = 0; i < 3; i++) await b.autoRecharge("bad2@x.com");
  assert.equal(charges, 1, "the card was charged " + charges + " times in one burst; the retry wait is not being honoured");
  assert.notEqual(users._state["bad2@x.com"] && users._state["bad2@x.com"].status, "locked",
    "the account locked inside one burst instead of over the documented week");
});

await t("setAutorecharge enforces the minimum top-up", () => {
  const b = createBilling({ dir: join(dir, "i"), users: mockUsers() });
  const r = b.setAutorecharge("m@x.com", true, 5);       // below min
  assert.equal(r.topupUsd, MIN_TOPUP_USD);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nbilling_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
