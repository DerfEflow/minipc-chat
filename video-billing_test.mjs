import assert from "node:assert/strict";
import test from "node:test";
import { createVideoChargeSettler } from "./video-billing.mjs";

function fixture({ balance = 0, autorecharge = true, topup = 50, rechargeOk = true } = {}) {
  let current = balance;
  let charges = 0;
  let recharges = 0;
  const billing = {
    account: () => ({ balance: current, autorecharge }),
    autoRecharge: async () => {
      recharges += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (!rechargeOk) return { attempted: true, ok: false };
      current += topup;
      return { attempted: true, ok: true, credited: topup };
    },
    chargeTurn: (_email, usd) => {
      charges += 1;
      const deducted = usd * 10;
      current = Math.max(0, current - deducted);
      return { deducted, balance: current, low: false };
    },
  };
  return {
    billing,
    state: () => ({ balance: current, charges, recharges }),
  };
}

const tenant = { role: "credit", email: "Maker@Example.com" };

test("an underfunded completed video is topped up before the exact debit", async () => {
  const f = fixture({ balance: 5, topup: 50 });
  const settle = createVideoChargeSettler({ billing: f.billing, creditsForCostUsd: (usd) => usd * 10 });
  const result = await settle(tenant, 3);
  assert.equal(result.charged.deducted, 30);
  assert.deepEqual(f.state(), { balance: 25, charges: 1, recharges: 1 });
});

test("a failed top-up never reaches the clamping debit", async () => {
  const f = fixture({ balance: 5, rechargeOk: false });
  const settle = createVideoChargeSettler({ billing: f.billing, creditsForCostUsd: (usd) => usd * 10 });
  await assert.rejects(() => settle(tenant, 3), (error) => error.code === "VIDEO_AUTOTOPUP_FAILED" && error.safeToRetry === false);
  assert.deepEqual(f.state(), { balance: 5, charges: 0, recharges: 1 });
});

test("settlements for the same account serialize funding and exact debits", async () => {
  const f = fixture({ balance: 0, topup: 50 });
  const settle = createVideoChargeSettler({ billing: f.billing, creditsForCostUsd: (usd) => usd * 10 });
  await Promise.all([settle(tenant, 3), settle(tenant, 3)]);
  assert.deepEqual(f.state(), { balance: 40, charges: 2, recharges: 2 });
});

test("owner and sponsored settlement preserve their distinct contracts", async () => {
  const f = fixture();
  let sponsored = 0;
  const settle = createVideoChargeSettler({
    billing: f.billing,
    users: { addSponsoredSpend: (_email, usd) => { sponsored += usd; } },
    creditsForCostUsd: (usd) => usd * 10,
  });
  assert.equal((await settle({ isOwner: true }, 2)).owner, true);
  assert.equal((await settle({ role: "sponsored", email: "free@example.com" }, 2)).sponsored, true);
  assert.equal(sponsored, 2);
  assert.equal(f.state().charges, 0);
});
