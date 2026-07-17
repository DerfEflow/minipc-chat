/*
 * Credits engine self-test — run: node credits_test.mjs
 * HIGH blast radius: verifies the pricing math, per-turn metering, low-balance + lock state machine,
 * and single-use coupon burn. All pure/deterministic (no Stripe).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCreditsStore, creditsFromPricePaid, pricePaidFromCredits, creditsForTurnCost, TOPUP_TIERS, LOW_WATERMARK, MIN_TOPUP_USD, MAX_RECHARGE_FAILS } from "./credits.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const dir = mkdtempSync(join(tmpdir(), "credits-"));
const c = createCreditsStore({ dir });

t("pricing: $12.50 paid -> 1000 credits (25% markup on $10 value)", () => {
  assert.equal(creditsFromPricePaid(12.50), 1000);
  assert.equal(pricePaidFromCredits(1000), 12.50);
  assert.equal(creditsFromPricePaid(25), 2000);
});
t("per-turn cost converts to credits by ceil(costUsd * 100)", () => {
  assert.equal(creditsForTurnCost(0.0123), 2);   // 1.23 -> 2
  assert.equal(creditsForTurnCost(1), 100);
  assert.equal(creditsForTurnCost(0), 0);
});
t("topup tiers start at the minimum and price up", () => {
  assert.equal(TOPUP_TIERS[0].priceUsd, MIN_TOPUP_USD);
  assert.equal(TOPUP_TIERS[0].credits, 1000);
});

t("grantTopup adds credits and records the ledger", () => {
  const r = c.grantTopup("u1", 12.50, "first top-up");
  assert.equal(r.granted, 1000); assert.equal(r.balance, 1000);
  assert.equal(c.balance("u1"), 1000);
  assert.equal(c.ledger("u1")[0].kind, "topup");
});
t("deductTurn draws down and flags low at/below $1", () => {
  const r1 = c.deductTurn("u1", 5.00);   // 500 credits -> 500 left
  assert.equal(r1.charged, 500); assert.equal(r1.balance, 500); assert.equal(r1.low, false);
  const r2 = c.deductTurn("u1", 4.10);   // 410 -> 90 left, low
  assert.equal(r2.balance, 90); assert.equal(r2.low, true);
});
t("needsRecharge only when active + autoRecharge + card + low", () => {
  assert.equal(c.needsRecharge("u1"), false);          // no card yet
  c.setCard("u1", "cus_test", true);
  assert.equal(c.needsRecharge("u1"), true);           // now low + card + auto(default on)
  c.setAutoRecharge("u1", false);
  assert.equal(c.needsRecharge("u1"), false);          // auto off
  c.setAutoRecharge("u1", true, 25);
  assert.equal(c.needsRecharge("u1"), true);
});
t("successful top-up clears low and unlocks", () => {
  c.grantTopup("u1", 25, "recharge");
  const a = c.account("u1");
  assert.ok(a.balance > LOW_WATERMARK); assert.equal(a.status, "active"); assert.equal(a.rechargeFailCount, 0);
});
t("auto-recharge failures accumulate and LOCK after the retry window", () => {
  c.setCard("u2", "cus_x", true);
  c.grantTopup("u2", 12.50);
  let res;
  for (let i = 0; i < MAX_RECHARGE_FAILS; i++) res = c.recordRechargeResult("u2", false, "card declined");
  assert.equal(res.locked, true);
  assert.equal(c.account("u2").status, "locked");
});
t("setAutoRecharge enforces the minimum top-up amount", () => {
  const r = c.setAutoRecharge("u3", true, 5);   // below MIN
  assert.equal(r.autoAmountUsd, MIN_TOPUP_USD);
});

t("coupons: created unique, single redeem, then burned", () => {
  const codes = c.createCoupons(5, 20);
  assert.equal(codes.length, 5);
  assert.equal(new Set(codes).size, 5);
  const r1 = c.redeemCoupon("userA_uid", "a@x.com", codes[0]);
  assert.equal(r1.ok, true); assert.equal(r1.capUsd, 20);
  const r2 = c.redeemCoupon("userB_uid", "b@x.com", codes[0]);   // already used
  assert.ok(r2.error);
  const bad = c.redeemCoupon("userC_uid", "c@x.com", "DMN-NOPE-NOPE");
  assert.ok(bad.error);
  const st = c.couponStats();
  assert.equal(st.redeemed, 1); assert.equal(st.open, 4);
});
t("coupon redeem is case-insensitive and trims", () => {
  const [code] = c.createCoupons(1, 20);
  const r = c.redeemCoupon("uid_ci", "ci@x.com", "  " + code.toLowerCase() + "  ");
  assert.equal(r.ok, true);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\ncredits_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
