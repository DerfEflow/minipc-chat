/*
 * Exact settlement for completed video generations.
 *
 * Video providers report their final cost after the expensive work has already
 * completed.  The generic chat ledger intentionally clamps balances at zero,
 * so callers must make sure the full debit is funded before calling chargeTurn.
 * This adapter serializes that sequence per account and keeps the media meter's
 * at-most-once claim unresolved when funding cannot be completed safely.
 */

function codedError(code, message, safeToRetry = false) {
  const error = new Error(message);
  error.code = code;
  error.safeToRetry = safeToRetry;
  return error;
}

export function createVideoChargeSettler({
  multiTenant = true,
  billing,
  users,
  creditsForCostUsd,
  maxTopups = 25,
} = {}) {
  if (!billing || typeof billing.account !== "function" || typeof billing.chargeTurn !== "function"
    || typeof billing.autoRecharge !== "function") {
    throw new Error("Video charge settlement requires the billing account, charge, and auto-recharge contracts.");
  }
  if (typeof creditsForCostUsd !== "function") {
    throw new Error("Video charge settlement requires the exact cost-to-credit conversion.");
  }

  const locks = new Map();

  const serialized = async (key, operation) => {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    try {
      return await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  };

  return async function settleVideoCharge(tenant, rawCostUsd) {
    const costUsd = Number(rawCostUsd);
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw codedError("VIDEO_COST_INVALID", "The provider returned an invalid video cost.", false);
    }
    if (!multiTenant || !tenant || tenant.isOwner) return { owner: true, costUsd };

    if (tenant.role === "sponsored") {
      if (!users || typeof users.addSponsoredSpend !== "function") {
        throw codedError("VIDEO_SPONSORED_BILLING_UNAVAILABLE", "Sponsored video billing is unavailable.", false);
      }
      users.addSponsoredSpend(tenant.email, costUsd);
      return { sponsored: true, costUsd };
    }

    const email = String(tenant.email || "").trim().toLowerCase();
    if (tenant.role !== "credit" || !email) {
      throw codedError("VIDEO_ACCOUNT_NOT_BILLABLE", "This account cannot be billed for video work.", false);
    }

    return serialized(email, async () => {
      const required = Number(creditsForCostUsd(costUsd));
      if (!Number.isFinite(required) || required < 0) {
        throw codedError("VIDEO_COST_INVALID", "The provider cost could not be converted to credits.", false);
      }

      const recharges = [];
      let account = billing.account(email);
      for (let attempt = 0; Number(account.balance) + 1e-9 < required; attempt += 1) {
        if (!account.autorecharge) {
          throw codedError("VIDEO_AUTOTOPUP_REQUIRED", "Auto top-up must be enabled to settle this video.", true);
        }
        if (attempt >= maxTopups) {
          throw codedError("VIDEO_AUTOTOPUP_LIMIT", "The video needs more credit than the configured auto top-up limit can supply.", true);
        }

        const before = Number(account.balance) || 0;
        /*
         * `force` skips the retry backoff added to billing.mjs on 2026-08-12, and this is the one
         * call site that should. The backoff exists to stop the low-balance path hammering a card
         * that has already declined. This path is different in kind: the expensive work is FINISHED
         * and has to be paid for, so refusing to try because of a scheduled retry would leave a real
         * cost unsettled. It also cannot hammer anything, because the loop below throws on the first
         * charge that does not increase the balance.
         */
        const recharge = await billing.autoRecharge(email, { force: true });
        recharges.push(recharge);
        account = billing.account(email);
        if (!recharge || recharge.ok !== true || Number(account.balance) <= before) {
          throw codedError(
            "VIDEO_AUTOTOPUP_FAILED",
            "Auto top-up could not add enough credit to settle the completed video.",
            false,
          );
        }
      }

      // No await occurs between the final balance check and this synchronous
      // debit, so another request cannot consume the reserved balance here.
      const beforeCharge = Number(account.balance) || 0;
      const charged = billing.chargeTurn(email, costUsd);
      if (Math.abs(Number(charged.deducted) - required) > 1e-6
        || Math.abs((beforeCharge - Number(charged.balance)) - required) > 1e-6
        || Number(charged.balance) < -1e-6) {
        throw codedError("VIDEO_SETTLEMENT_MISMATCH", "The video charge did not match the provider cost.", false);
      }

      let thresholdRecharge = null;
      if (charged.low && billing.account(email).autorecharge) {
        thresholdRecharge = await billing.autoRecharge(email);
      }
      return { charged, recharges, recharge: thresholdRecharge };
    });
  };
}
