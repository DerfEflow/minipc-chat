/*
 * Dominion AI — billing: the credit ledger, the invite/free code system, and the auto-recharge and
 * lock state machine. HIGH blast radius (money), so the logic is deterministic and unit-tested, and
 * the actual Stripe charge is INJECTED (`charge`) so tests never touch a real payment.
 *
 * The model (Fred's spec):
 *   - 100 credits = $1 of token value (credits are billed at COST).
 *   - Credits are SOLD at a 25% markup: $1.25 buys 100 credits. So usd -> credits = usd / 1.25 * 100
 *     (a $12.50 top-up = 1000 credits = $10 of token value; the 25% is the margin).
 *   - Each turn deducts cost x 100 credits (the raw token cost, in credits).
 *   - Mandatory auto-recharge at or below $1 (100 credits). Minimum top-up $12.50; tiers + custom.
 *   - If a user drops below $1 and auto-recharge FAILS, the app LOCKS until topped off manually; it
 *     retries every few days for about a week, then stops trying.
 *   - Two code types, minted at will:
 *       invite -> a paid "credit" user (must load credits to use it; optional promo credits attached)
 *       free   -> a comp "sponsored" user (Fred's wallet covers it up to the $20 monthly cap)
 *     Every code is single-use and burns on redemption.
 *
 * Balances live here; identity/role/status/caps live in tenancy.mjs (the users store), which this
 * module drives on redemption and on lock.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const CREDITS_PER_USD = 100;          // 100 credits = $1 of token value (billed at cost)
export const MARKUP = 1.25;                   // sold at $1.25 per $1 of value (25% margin)
export const RECHARGE_THRESHOLD = 100;        // <= $1 in credits triggers auto-recharge
export const MIN_TOPUP_USD = 12.5;            // minimum top-up (and default auto-recharge amount)
export const TOPUP_TIERS = [12.5, 25, 50, 100];
export const FREE_CAP_USD = 20;               // default monthly ceiling Fred covers for a free/sponsored user
const MAX_RECHARGE_FAILS = 3;                 // after this many failed retries, stop trying (about a week at ~3 days apart)
const RETRY_INTERVAL_DAYS = 3;

// usd a buyer pays -> credits granted (markup applied here, at purchase). Purchases stay whole
// credits: a top-up is a round number the buyer chose, not a measurement.
export const creditsForUsd = (usd) => Math.round((Number(usd) || 0) / MARKUP * CREDITS_PER_USD);
// credits -> the token-value dollars they represent (at cost, no markup).
export const usdValueOfCredits = (credits) => (Number(credits) || 0) / CREDITS_PER_USD;
/*
 * CREDIT PRECISION. A deduction is a MEASUREMENT of what a turn actually cost, so it is carried to
 * six decimal places of a credit, one part in 10^8 of a dollar. That is far finer than any real
 * token cost and fine enough that rounding cannot accumulate into a cent over a lifetime of turns.
 */
const CREDIT_DP = 1e6;
export const roundCredits = (n) => Math.round((Number(n) || 0) * CREDIT_DP) / CREDIT_DP;
/*
 * Token cost dollars for a turn -> credits to deduct. EXACT: no floor, no rounding up.
 *
 * This was Math.max(1, Math.ceil(usd * 100)), a one-credit minimum on every turn however little it
 * cost, including turns that cost nothing at all. That quietly made the free NVIDIA fleet cost
 * money: the preflight estimate said "Free", the ledger then took a credit per turn, and a guest
 * chatting briefly on a free model was billed four credits for four messages. The same floor
 * overcharged every cheap turn on a paid model too, which is the identical defect wearing a
 * smaller number. Fred, 2026-07-31: "I've never authorized a minimum spend... if they use .005
 * credits, that's how much should be deducted. and yes, free models are free."
 *
 * Zero in, zero out, so "free is free" falls out of the arithmetic instead of relying on a special
 * case that a later edit could forget.
 */
export const creditsForCostUsd = (usd) => {
  const n = Number(usd) || 0;
  if (n <= 0) return 0;
  return roundCredits(n * CREDITS_PER_USD);
};

// A friendly single-use code, e.g. DOMI-7QK4-9F2M. Ambiguous chars removed.
function genCode() {
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alpha[b[i] % alpha.length];
  return `DOMI-${s.slice(0, 4)}-${s.slice(4)}`;
}

export function createBilling({ dir, users, charge = null, now = () => new Date().toISOString() }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "billing.db"));
  db.exec("PRAGMA journal_mode=WAL");
  /*
   * balance/delta/balanceAfter are REAL: a turn can cost a fraction of a credit. Existing
   * databases keep their INTEGER declaration and need no rebuild, because SQLite's NUMERIC
   * affinity stores a value that cannot be exactly represented as an integer as a REAL, losslessly
   * (verified against this exact schema before the change: 1000 minus four 0.005 deductions reads
   * back as 999.98). Rebuilding a live money table would have been the riskier way to get the same
   * result.
   */
  db.exec(`CREATE TABLE IF NOT EXISTS credits (
    email TEXT PRIMARY KEY, balance REAL NOT NULL DEFAULT 0,
    autorecharge INTEGER NOT NULL DEFAULT 1, topupUsd REAL NOT NULL DEFAULT ${MIN_TOPUP_USD},
    stripeCustomer TEXT, defaultPm TEXT,
    rechargeFails INTEGER NOT NULL DEFAULT 0, nextRetryAt TEXT,
    createdAt TEXT, updatedAt TEXT )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, delta REAL NOT NULL,
    reason TEXT, balanceAfter REAL NOT NULL, ts TEXT NOT NULL )`);
  db.exec(`CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unused',
    capUsd REAL, credits INTEGER NOT NULL DEFAULT 0, note TEXT,
    createdAt TEXT, redeemedBy TEXT, redeemedAt TEXT )`);
  // Idempotency for paid Checkout sessions (return handler AND webhook may both fire).
  db.exec(`CREATE TABLE IF NOT EXISTS paid_sessions ( id TEXT PRIMARY KEY, email TEXT, credits INTEGER, ts TEXT )`);
  // Additive migration: pay-before-access. Promo credits on an invite code are held here and released
  // by the FIRST purchase, so handing out codes costs nothing until the guest actually subscribes.
  try { db.exec("ALTER TABLE credits ADD COLUMN pendingPromo INTEGER NOT NULL DEFAULT 0"); } catch {}

  const q = {
    get: db.prepare("SELECT * FROM credits WHERE email=?"),
    ins: db.prepare(`INSERT INTO credits (email,balance,createdAt,updatedAt) VALUES (?,?,?,?)`),
    setBal: db.prepare("UPDATE credits SET balance=?, updatedAt=? WHERE email=?"),
    setRecharge: db.prepare("UPDATE credits SET autorecharge=?, topupUsd=?, updatedAt=? WHERE email=?"),
    setStripe: db.prepare("UPDATE credits SET stripeCustomer=?, defaultPm=?, updatedAt=? WHERE email=?"),
    setFails: db.prepare("UPDATE credits SET rechargeFails=?, nextRetryAt=?, updatedAt=? WHERE email=?"),
    /*
     * The accounts a retry is actually DUE on. Every clause earns its place:
     *   autorecharge=1        a user who switched it off is not chased
     *   nextRetryAt <= now    the whole point; this column existed and nothing ever read it
     *   rechargeFails < MAX   after the last failure nextRetryAt is null anyway, so this is belt and
     *                         braces against a row written by an older version of the code
     *   defaultPm NOT NULL    no saved card means there is nothing to charge and the account is
     *                         already locked; retrying would only relock it every hour
     */
    dueForRetry: db.prepare(`SELECT email, rechargeFails, nextRetryAt FROM credits
      WHERE autorecharge = 1 AND nextRetryAt IS NOT NULL AND nextRetryAt <= ?
        AND rechargeFails > 0 AND rechargeFails < ? AND defaultPm IS NOT NULL
      ORDER BY nextRetryAt ASC LIMIT ?`),
    ledgerIns: db.prepare("INSERT INTO ledger (email,delta,reason,balanceAfter,ts) VALUES (?,?,?,?,?)"),
    ledgerFor: db.prepare("SELECT * FROM ledger WHERE email=? ORDER BY id DESC LIMIT ?"),
    codeIns: db.prepare("INSERT INTO codes (code,type,status,capUsd,credits,note,createdAt) VALUES (?,?,?,?,?,?,?)"),
    codeGet: db.prepare("SELECT * FROM codes WHERE code=?"),
    codeRedeem: db.prepare("UPDATE codes SET status='redeemed', redeemedBy=?, redeemedAt=? WHERE code=?"),
    codeRevoke: db.prepare("UPDATE codes SET status='revoked' WHERE code=? AND status='unused'"),
    codeAll: db.prepare("SELECT * FROM codes ORDER BY createdAt DESC LIMIT ?"),
    sessGet: db.prepare("SELECT id FROM paid_sessions WHERE id=?"),
    sessIns: db.prepare("INSERT INTO paid_sessions (id,email,credits,ts) VALUES (?,?,?,?)"),
    sessByEmail: db.prepare("SELECT id FROM paid_sessions WHERE email=? LIMIT 1"),
    setPending: db.prepare("UPDATE credits SET pendingPromo=?, updatedAt=? WHERE email=?"),
  };

  const lc = (e) => String(e || "").trim().toLowerCase();
  function ensure(email) {
    const e = lc(email); if (!e) return null;
    let row = q.get.get(e);
    if (!row) { q.ins.run(e, 0, now(), now()); row = q.get.get(e); }
    return row;
  }
  const balance = (email) => (ensure(email) || {}).balance || 0;

  /*
   * Math.trunc used to sit on both writes here, from when a credit was the smallest unit that
   * existed. Left in place it would defeat exact charging completely: a 0.005 deduction truncates
   * to 0 and the turn becomes free, which is the same class of error as the floor it replaced,
   * pointed the other way. Deltas are now carried at full precision and only rounded to the credit
   * precision, so what the ledger records is what the balance moved by.
   */
  function apply(email, delta, reason) {
    const e = lc(email); const row = ensure(e);
    const d = roundCredits(delta);
    const next = Math.max(0, roundCredits((Number(row.balance) || 0) + d));
    q.setBal.run(next, now(), e);
    q.ledgerIns.run(e, d, reason || "", next, now());
    return next;
  }

  // Grant purchased/promo credits from a USD amount (markup applied).
  function grantUsd(email, usd, reason) { return apply(email, creditsForUsd(usd), reason || `top-up $${usd}`); }
  // Has this user ever completed a paid Checkout? (Pay-before-access: chat wording + the app-door
  // redirect key off this; auto-recharge grants can only exist after a first purchase anyway.)
  const hasPaid = (email) => !!q.sessByEmail.get(lc(email));
  // Idempotent grant for a paid Checkout session (safe to call from BOTH the return handler and the
  // webhook). Grants exactly the credits recorded on the session, once. The FIRST purchase also
  // releases any held welcome bonus and turns mandatory auto-recharge on.
  function grantSession(id, email, credits) {
    const sid = String(id || ""); if (!sid) return { error: "no_session" };
    if (q.sessGet.get(sid)) return { already: true, balance: balance(email) };
    q.sessIns.run(sid, lc(email), Math.trunc(credits) || 0, now());
    let bal = apply(email, Math.trunc(credits) || 0, `top-up session ${sid}`);
    const row = ensure(email);
    if (row.pendingPromo > 0) {
      bal = apply(email, row.pendingPromo, "welcome bonus (released by first purchase)");
      q.setPending.run(0, now(), lc(email));
    }
    q.setRecharge.run(1, Math.max(MIN_TOPUP_USD, row.topupUsd || MIN_TOPUP_USD), now(), lc(email));
    return { ok: true, credited: Math.trunc(credits) || 0, balance: bal };
  }
  // Deduct a turn's token cost (USD) in credits. Returns { balance, deducted, low }.
  function chargeTurn(email, costUsd) {
    const deducted = creditsForCostUsd(costUsd);
    const bal = apply(email, -deducted, `turn cost $${(Number(costUsd) || 0).toFixed(6)}`);
    return { balance: bal, deducted, low: bal <= RECHARGE_THRESHOLD };
  }

  // Can this credit user run a turn? (Sponsored/owner are gated elsewhere by role/cap, not credits.)
  const canChat = (email) => balance(email) > 0;

  function setStripe(email, customer, pm) { ensure(email); q.setStripe.run(customer || null, pm || null, now(), lc(email)); return { ok: true }; }
  function setAutorecharge(email, on, topupUsd) {
    ensure(email);
    const usd = Math.max(MIN_TOPUP_USD, Number(topupUsd) || MIN_TOPUP_USD);
    q.setRecharge.run(on ? 1 : 0, usd, now(), lc(email));
    return { ok: true, topupUsd: usd };
  }

  // Auto-recharge: called when a credit user is at/below the threshold. Uses the injected `charge`.
  // On success: grant credits, clear the fail counter, unlock. On failure: count it, schedule a retry,
  // and LOCK after MAX_RECHARGE_FAILS. Returns a small status object; never throws.
  async function autoRecharge(email, { force = false } = {}) {
    const e = lc(email); const row = ensure(e);
    if (!row.autorecharge) return { attempted: false, reason: "autorecharge_off" };
    if (!charge) return { attempted: false, reason: "no_charger" };
    if (!row.stripeCustomer || !row.defaultPm) {
      // No saved card: cannot recharge -> lock so the user tops off manually.
      if (users) users.setStatus(e, "locked");
      return { attempted: false, reason: "no_payment_method", locked: true };
    }
    /*
     * HONOUR THE BACKOFF (2026-08-12). `nextRetryAt` has been written since this function was first
     * written and read by nothing at all, which broke the documented behaviour in the more damaging
     * direction rather than the harmless one.
     *
     * The header above promises "it retries every few days for about a week". What actually happened:
     * meterTurn calls this on EVERY low turn, this function had no idea a retry was already scheduled,
     * so a customer whose card was declining got all three attempts inside a couple of minutes and
     * locked almost immediately. Three declines in quick succession is also precisely the pattern card
     * networks and issuers penalise, so the app was hammering a card it had already been told no by,
     * and spending the user's whole retry allowance before they could react.
     *
     * `force` exists for the video settlement path, which deliberately tops up repeatedly to fund one
     * expensive job. A SUCCESSFUL charge clears nextRetryAt below, so that loop is unaffected in the
     * normal case and now stops after the first decline instead of trying twenty-five times.
     */
    if (!force && row.nextRetryAt) {
      const due = Date.parse(row.nextRetryAt);
      if (Number.isFinite(due) && due > Date.now()) {
        return { attempted: false, reason: "backoff", retryAt: row.nextRetryAt, fails: row.rechargeFails };
      }
    }
    let res;
    try { res = await charge({ email: e, usd: row.topupUsd, customer: row.stripeCustomer, pm: row.defaultPm }); }
    catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    if (res && res.ok) {
      grantUsd(e, row.topupUsd, "auto-recharge");
      q.setFails.run(0, null, now(), e);
      if (users) users.setStatus(e, "active");
      return { attempted: true, ok: true, credited: creditsForUsd(row.topupUsd) };
    }
    const fails = row.rechargeFails + 1;
    const next = new Date(Date.now() + RETRY_INTERVAL_DAYS * 86400000).toISOString();
    q.setFails.run(fails, fails >= MAX_RECHARGE_FAILS ? null : next, now(), e);
    if (fails >= MAX_RECHARGE_FAILS && users) users.setStatus(e, "locked");
    return { attempted: true, ok: false, fails, locked: fails >= MAX_RECHARGE_FAILS, error: res && res.error };
  }

  /*
   * THE RETRY THAT THE HEADER HAS ALWAYS PROMISED, and which did not exist until 2026-08-12.
   *
   * "it retries every few days for about a week, then stops trying" was true of the DATA and false of
   * the BEHAVIOUR: a retry time was written on every failure and read by nothing, there was no cron,
   * no boot sweep and no timer anywhere in the app. Recovery could only happen opportunistically on
   * the user's next metered turn, and after the third failure the account is locked and a locked
   * account cannot chat, so the path that would have retried was unreachable by construction.
   *
   * Deliberately boring. It asks the database which accounts are due, charges each once, and stops.
   * `limit` is a stampede guard: after an outage a hundred accounts can come due in the same minute
   * and firing a hundred charges at once is how you get an issuer to start declining all of them.
   *
   * Every attempt goes through autoRecharge, so success, failure, counting, scheduling and locking
   * all stay in the one place that has always owned them. This function decides WHO and WHEN, never
   * what happens.
   */
  async function retryDueRecharges({ at = new Date().toISOString(), limit = 25, log = () => {} } = {}) {
    let due = [];
    try { due = q.dueForRetry.all(String(at), MAX_RECHARGE_FAILS, Math.max(1, Math.min(200, Number(limit) || 25))); }
    catch (err) { log("[billing] retry sweep could not read due accounts: " + (err && err.message)); return { due: 0, ok: 0, failed: 0, locked: 0 }; }
    if (!due.length) return { due: 0, ok: 0, failed: 0, locked: 0 };

    let okCount = 0, failed = 0, locked = 0;
    for (const row of due) {
      // Sequential on purpose. These are card charges, not page loads.
      const r = await autoRecharge(row.email, { force: true });
      if (r && r.ok) { okCount++; log("[billing] retry succeeded for " + row.email + ", account unlocked"); }
      else {
        failed++;
        if (r && r.locked) { locked++; log("[billing] retry failed for " + row.email + " (attempt " + r.fails + "), account locked, no further retries"); }
        else log("[billing] retry failed for " + row.email + " (attempt " + ((r && r.fails) || "?") + "), next one scheduled");
      }
    }
    log("[billing] retry sweep: " + due.length + " due, " + okCount + " recovered, " + failed + " failed, " + locked + " locked out");
    return { due: due.length, ok: okCount, failed, locked };
  }

  // ----- codes (invite + free) -----
  function mintCode({ type, capUsd, credits = 0, note = "" } = {}) {
    const t = type === "free" ? "free" : "invite";
    let code = genCode();
    for (let i = 0; i < 5 && q.codeGet.get(code); i++) code = genCode();   // avoid the rare collision
    q.codeIns.run(code, t, "unused", t === "free" ? (Number(capUsd) || FREE_CAP_USD) : null, Math.max(0, Math.trunc(credits)), note, now());
    return q.codeGet.get(code);
  }
  // Redeem a code for an authenticated email: burns the code, activates + roles the user, grants any
  // attached credits. Returns { ok, type, role } or { error }.
  function redeem(code, email) {
    const e = lc(email); if (!e) return { error: "no_email" };
    const row = q.codeGet.get(String(code || "").trim().toUpperCase());
    if (!row) return { error: "invalid_code" };
    if (row.status !== "unused") return { error: row.status === "redeemed" ? "code_used" : "code_revoked" };
    q.codeRedeem.run(e, now(), row.code);
    if (users) {
      if (row.type === "free") { users.ensure(e); users.setRole(e, "sponsored"); if (row.capUsd) users.setSponsoredCap(e, row.capUsd); }
      else { users.ensure(e); users.setRole(e, "credit"); }
      users.setStatus(e, "active");
      if (users.markInvited) users.markInvited(e);   // redeeming any code passes the invite gate
    }
    // Pay-before-access: an invite code's promo credits are HELD as a welcome bonus and released by
    // the first purchase (grantSession), so unredeemed generosity never spends Fred's money. Free
    // codes are the deliberate comp path and are unaffected (their spend is capped, not credited).
    if (row.credits > 0 && row.type !== "free") {
      const r = ensure(e);
      q.setPending.run((r.pendingPromo || 0) + row.credits, now(), e);
    } else if (row.credits > 0) {
      apply(e, row.credits, `code ${row.code}`);
    }
    return { ok: true, type: row.type, role: row.type === "free" ? "sponsored" : "credit", credits: row.credits,
      pendingPromo: row.type !== "free" ? row.credits : 0 };
  }

  return {
    // ledger
    balance, canChat, hasPaid, grantUsd, grantSession, chargeTurn, autoRecharge, apply,
    retryDueRecharges,
    // Exposed so the sweep, the tests and any future dashboard all ask the same question.
    dueForRetry: (at = new Date().toISOString(), limit = 25) =>
      q.dueForRetry.all(String(at), MAX_RECHARGE_FAILS, Math.max(1, Math.min(200, Number(limit) || 25))),
    adminAdjust: (email, credits, reason) => apply(email, credits, reason || "admin adjust"),
    ledger: (email, limit = 50) => q.ledgerFor.all(lc(email), limit),
    account: (email) => { const r = ensure(email); return { balance: r.balance, usdValue: usdValueOfCredits(r.balance), autorecharge: !!r.autorecharge, topupUsd: r.topupUsd, hasCard: !!r.defaultPm, rechargeFails: r.rechargeFails, pendingPromo: r.pendingPromo || 0, hasPaid: hasPaid(email) }; },
    // payment wiring
    setStripe, setAutorecharge,
    // codes
    mintCode, redeem,
    revokeCode: (code) => { q.codeRevoke.run(String(code || "").toUpperCase()); return { ok: true }; },
    getCode: (code) => q.codeGet.get(String(code || "").toUpperCase()),
    listCodes: (limit = 200) => q.codeAll.all(limit),
    // constants (for the UI + estimates)
    pricing: { CREDITS_PER_USD, MARKUP, RECHARGE_THRESHOLD, MIN_TOPUP_USD, TOPUP_TIERS, FREE_CAP_USD },
  };
}
