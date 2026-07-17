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

// usd a buyer pays -> credits granted (markup applied here, at purchase).
export const creditsForUsd = (usd) => Math.round((Number(usd) || 0) / MARKUP * CREDITS_PER_USD);
// credits -> the token-value dollars they represent (at cost, no markup).
export const usdValueOfCredits = (credits) => (Number(credits) || 0) / CREDITS_PER_USD;
// token cost dollars for a turn -> credits to deduct (rounded up; never free).
export const creditsForCostUsd = (usd) => Math.max(1, Math.ceil((Number(usd) || 0) * CREDITS_PER_USD));

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
  db.exec(`CREATE TABLE IF NOT EXISTS credits (
    email TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0,
    autorecharge INTEGER NOT NULL DEFAULT 1, topupUsd REAL NOT NULL DEFAULT ${MIN_TOPUP_USD},
    stripeCustomer TEXT, defaultPm TEXT,
    rechargeFails INTEGER NOT NULL DEFAULT 0, nextRetryAt TEXT,
    createdAt TEXT, updatedAt TEXT )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT, balanceAfter INTEGER NOT NULL, ts TEXT NOT NULL )`);
  db.exec(`CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unused',
    capUsd REAL, credits INTEGER NOT NULL DEFAULT 0, note TEXT,
    createdAt TEXT, redeemedBy TEXT, redeemedAt TEXT )`);
  // Idempotency for paid Checkout sessions (return handler AND webhook may both fire).
  db.exec(`CREATE TABLE IF NOT EXISTS paid_sessions ( id TEXT PRIMARY KEY, email TEXT, credits INTEGER, ts TEXT )`);

  const q = {
    get: db.prepare("SELECT * FROM credits WHERE email=?"),
    ins: db.prepare(`INSERT INTO credits (email,balance,createdAt,updatedAt) VALUES (?,?,?,?)`),
    setBal: db.prepare("UPDATE credits SET balance=?, updatedAt=? WHERE email=?"),
    setRecharge: db.prepare("UPDATE credits SET autorecharge=?, topupUsd=?, updatedAt=? WHERE email=?"),
    setStripe: db.prepare("UPDATE credits SET stripeCustomer=?, defaultPm=?, updatedAt=? WHERE email=?"),
    setFails: db.prepare("UPDATE credits SET rechargeFails=?, nextRetryAt=?, updatedAt=? WHERE email=?"),
    ledgerIns: db.prepare("INSERT INTO ledger (email,delta,reason,balanceAfter,ts) VALUES (?,?,?,?,?)"),
    ledgerFor: db.prepare("SELECT * FROM ledger WHERE email=? ORDER BY id DESC LIMIT ?"),
    codeIns: db.prepare("INSERT INTO codes (code,type,status,capUsd,credits,note,createdAt) VALUES (?,?,?,?,?,?,?)"),
    codeGet: db.prepare("SELECT * FROM codes WHERE code=?"),
    codeRedeem: db.prepare("UPDATE codes SET status='redeemed', redeemedBy=?, redeemedAt=? WHERE code=?"),
    codeRevoke: db.prepare("UPDATE codes SET status='revoked' WHERE code=? AND status='unused'"),
    codeAll: db.prepare("SELECT * FROM codes ORDER BY createdAt DESC LIMIT ?"),
    sessGet: db.prepare("SELECT id FROM paid_sessions WHERE id=?"),
    sessIns: db.prepare("INSERT INTO paid_sessions (id,email,credits,ts) VALUES (?,?,?,?)"),
  };

  const lc = (e) => String(e || "").trim().toLowerCase();
  function ensure(email) {
    const e = lc(email); if (!e) return null;
    let row = q.get.get(e);
    if (!row) { q.ins.run(e, 0, now(), now()); row = q.get.get(e); }
    return row;
  }
  const balance = (email) => (ensure(email) || {}).balance || 0;

  function apply(email, delta, reason) {
    const e = lc(email); const row = ensure(e);
    const next = Math.max(0, row.balance + Math.trunc(delta));
    q.setBal.run(next, now(), e);
    q.ledgerIns.run(e, Math.trunc(delta), reason || "", next, now());
    return next;
  }

  // Grant purchased/promo credits from a USD amount (markup applied).
  function grantUsd(email, usd, reason) { return apply(email, creditsForUsd(usd), reason || `top-up $${usd}`); }
  // Idempotent grant for a paid Checkout session (safe to call from BOTH the return handler and the
  // webhook). Grants exactly the credits recorded on the session, once.
  function grantSession(id, email, credits) {
    const sid = String(id || ""); if (!sid) return { error: "no_session" };
    if (q.sessGet.get(sid)) return { already: true, balance: balance(email) };
    q.sessIns.run(sid, lc(email), Math.trunc(credits) || 0, now());
    const bal = apply(email, Math.trunc(credits) || 0, `top-up session ${sid}`);
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
  async function autoRecharge(email) {
    const e = lc(email); const row = ensure(e);
    if (!row.autorecharge) return { attempted: false, reason: "autorecharge_off" };
    if (!charge) return { attempted: false, reason: "no_charger" };
    if (!row.stripeCustomer || !row.defaultPm) {
      // No saved card: cannot recharge -> lock so the user tops off manually.
      if (users) users.setStatus(e, "locked");
      return { attempted: false, reason: "no_payment_method", locked: true };
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
    if (row.credits > 0) grantUsd_credits(e, row.credits, `code ${row.code}`);
    return { ok: true, type: row.type, role: row.type === "free" ? "sponsored" : "credit", credits: row.credits };
  }
  function grantUsd_credits(email, credits, reason) { return apply(email, credits, reason); }   // raw-credit grant (promo)

  return {
    // ledger
    balance, canChat, grantUsd, grantSession, chargeTurn, autoRecharge, apply,
    adminAdjust: (email, credits, reason) => apply(email, credits, reason || "admin adjust"),
    ledger: (email, limit = 50) => q.ledgerFor.all(lc(email), limit),
    account: (email) => { const r = ensure(email); return { balance: r.balance, usdValue: usdValueOfCredits(r.balance), autorecharge: !!r.autorecharge, topupUsd: r.topupUsd, hasCard: !!r.defaultPm, rechargeFails: r.rechargeFails }; },
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
