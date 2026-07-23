/*
 * Dominion AI - Long-Run Harness item 5: budget circuit breakers with REAL billing.
 * (SOW docs/LONG-RUN-HARNESS-SOW.md, decision D2; FITS pack docs/LONGRUN-BILLING-FITS.md.)
 *
 * The tranche is a fuse, never a job cap: cheap models burning a $1 tranche slowly is the
 * system working, and a paused job resumes with one approval. Money flows through the SAME
 * engine as every chat turn (billing.chargeTurn for credit users, users.addSponsoredSpend for
 * sponsored, owner never metered); this module only does job-scoped tranche accounting, in an
 * append-only budget.jsonl beside the job's ledger, folded on read so a crash loses nothing.
 *
 * HIGH blast radius (money): pure module, all money deps injected, tested without Stripe.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// D2, locked 2026-07-22. Amounts are suggestions inside Fred's "never exceed ~$2 for guests"
// rule; changing them is a one-line edit here and nowhere else.
export const GUEST_TRANCHE_USD = 1;
export const GUEST_TRANCHE_CEILING_USD = 2;
export const GUEST_MAX_OUTSTANDING_TRANCHES = 10;
export const OWNER_TRANCHE_USD = 5;

// Clamp a requested tranche size to the caller's role. Guests can pick smaller fuses than the
// default but never larger than the ceiling; the owner picks freely (floor 1 cent keeps a zero
// or garbage request from minting an always-tripped fuse).
export function tranchePolicy(role, requestedUsd) {
  const isOwner = role === "owner";
  const def = isOwner ? OWNER_TRANCHE_USD : GUEST_TRANCHE_USD;
  const usd = Number(requestedUsd) > 0 ? Number(requestedUsd) : def;
  if (isOwner) return Math.max(0.01, usd);
  return Math.max(0.01, Math.min(usd, GUEST_TRANCHE_CEILING_USD));
}

/*
 * Job-scoped budget accounting over an append-only file. Every approval and every spend is one
 * JSON line; state is a fold, so two instances (or a crash) can never disagree with the disk.
 *   createJobBudget({ jobDir, role, trancheUsd?, now? })
 *     .approve(count, by)  -> { ok, approvedUsd, outstandingTranches } | { error }
 *     .spend(usd, unit)    -> { spentUsd, remainingUsd }
 *     .remaining()         -> usd remaining (the runJob fuse: <= 0 pauses)
 *     .state()             -> honest summary for the /jobs surface
 */
export function createJobBudget({ jobDir, role = "credit", trancheUsd, now = Date.now }) {
  if (!jobDir) throw new Error("createJobBudget needs jobDir");
  mkdirSync(jobDir, { recursive: true });
  const path = join(jobDir, "budget.jsonl");
  const perTranche = tranchePolicy(role, trancheUsd);
  const isOwner = role === "owner";

  function fold() {
    let approvedUsd = 0, spentUsd = 0, tranches = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "approve") { approvedUsd += e.usd; tranches += e.count; }
        else if (e.type === "spend") spentUsd += e.usd;
      }
    }
    return { approvedUsd, spentUsd, tranches, remainingUsd: approvedUsd - spentUsd };
  }
  const append = (e) => appendFileSync(path, JSON.stringify({ at: now(), ...e }) + "\n");

  function approve(count = 1, by = "") {
    const n = Math.max(1, Math.trunc(Number(count) || 1));
    const f = fold();
    if (!isOwner) {
      // Guest cap is on OUTSTANDING (approved but unspent) tranches, so a long job keeps
      // resuming one approval at a time; it can never stack more than 10 fuses of headroom.
      const outstanding = Math.ceil(Math.max(0, f.remainingUsd) / perTranche);
      if (outstanding + n > GUEST_MAX_OUTSTANDING_TRANCHES) {
        const room = GUEST_MAX_OUTSTANDING_TRANCHES - outstanding;
        if (room <= 0) return { error: "You already have " + outstanding + " unspent tranches approved (the guest limit is " + GUEST_MAX_OUTSTANDING_TRANCHES + "). Let the job spend them first." };
        return approve(room, by);
      }
    }
    append({ type: "approve", count: n, usd: n * perTranche, by: String(by || "") });
    const after = fold();
    return { ok: true, approvedTranches: n, approvedUsd: n * perTranche, totalApprovedUsd: after.approvedUsd, remainingUsd: after.remainingUsd };
  }

  function spend(usd, unit, note = "") {
    const v = Math.max(0, Number(usd) || 0);
    if (v > 0) append({ type: "spend", usd: v, unit: unit ?? null, note: String(note || "") });
    const f = fold();
    return { spentUsd: f.spentUsd, remainingUsd: f.remainingUsd };
  }

  return {
    approve, spend,
    remaining: () => fold().remainingUsd,
    perTrancheUsd: perTranche,
    state: () => {
      const f = fold();
      return { perTrancheUsd: perTranche, approvedUsd: f.approvedUsd, spentUsd: f.spentUsd,
        remainingUsd: f.remainingUsd, tranchesApproved: f.tranches,
        role: isOwner ? "owner" : "guest" };
    },
  };
}

/*
 * Charge one unit's real cost to the right account, through the SAME paths as a chat turn
 * (meterTurn's law, restated at job scale): owner never metered; credit users pay ceil(cost x
 * 100) credits with auto-recharge fired when low; sponsored users draw Fred's monthly cap.
 * Charged at result time, BEFORE validation: tokens were spent whether or not the unit counts
 * (FITS assumed-fact, W2 orders the writes so money is never overstated). Never throws.
 */
export function chargeUnit({ T, billing, users, costUsd, jobId, unit }) {
  const usd = Math.max(0, Number(costUsd) || 0);
  if (!T || T.isOwner || usd === 0) return { charged: false, usd };
  try {
    if (T.role === "credit") {
      const m = billing.chargeTurn(T.email, usd);
      if (m.low) billing.autoRecharge(T.email).catch(() => {});
      return { charged: true, usd, credits: m.deducted, balance: m.balance };
    }
    if (T.role === "sponsored") {
      users.addSponsoredSpend(T.email, usd);
      return { charged: true, usd, sponsored: true };
    }
  } catch {}
  return { charged: false, usd };
}

// Can this caller approve a tranche right now? Credit users must hold credits covering the new
// approval (floor-at-zero would otherwise let spend past the balance go unbilled: wargame W3).
export function canApprove({ T, billing, usd }) {
  if (!T) return { ok: false, error: "no identity" };
  if (T.isOwner) return { ok: true };
  if (T.role === "sponsored") return { ok: true };   // spend draws the cap; the cap is the wall
  const need = Math.ceil(Math.max(0, Number(usd) || 0) * 100);
  const have = billing.balance(T.email);
  if (have < need) return { ok: false, error: "Approving this tranche needs " + need + " credits and you have " + have + ". Add credits in Setup first.", code: "needs_credits" };
  return { ok: true };
}

/*
 * The one call the next phase (real callUnit glue) uses. Returns runJob-ready deps:
 *   budget  - the fuse (remaining() folds from disk every check)
 *   meter   - wrap a unit result: charges the account AND counts the tranche, one place only
 */
export function makeRunDeps({ store, jobId, T, billing, users, now = Date.now }) {
  const budget = createJobBudget({ jobDir: join(store.dir, jobId), role: T && T.isOwner ? "owner" : (T && T.role) || "credit", now });
  return {
    budget,
    meter: (result, unit) => {
      const usd = Math.max(0, Number(result && result.costUsd) || 0);
      const charged = chargeUnit({ T, billing, users, costUsd: usd, jobId, unit: unit && unit.unit });
      if (usd > 0) budget.spend(usd, unit && unit.unit, charged.charged ? "charged" : "unmetered");
      return charged;
    },
  };
}
