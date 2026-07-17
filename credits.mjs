/*
 * Dominion AI — credits + coupons/invites (SOW item 8; the money engine).
 *
 * HIGH blast radius: this decides what users are charged and when they're cut off. It is provider-
 * agnostic (no Stripe here) so it is fully unit-testable; stripe.mjs performs the actual charge and
 * calls grantTopup() / recordRechargeResult() on the outcome.
 *
 * Fred's model (locked):
 *   - 100 credits = $1 of token VALUE. Users are charged token cost x 100 credits per turn.
 *   - Credits are SOLD at a 25% markup: $1.25 paid per $1 of value. So $12.50 paid -> 1000 credits.
 *   - Auto-recharge is mandatory for 'credit' users: at or below $1 (100 credits) we charge the saved
 *     card for the user's chosen top-up amount (min $12.50).
 *   - If balance is under $1 and auto-recharge FAILS, the account LOCKS until a manual top-up. We keep
 *     retrying every couple of days for about a week, then stop.
 *   - A single-use coupon/invite code activates the FREE tier (role -> sponsored, Fred covers cost up
 *     to the monthly cap). Once redeemed a code is burned.
 *
 * Owner and sponsored users are never metered here (owner = unlimited; sponsored = capped in dollars
 * by tenancy.mjs). Only 'credit' users draw down a balance.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const CREDITS_PER_USD = 100;     // 100 credits = $1 of token value
export const MARKUP = 1.25;             // sold at $1.25 per $1 of value
export const LOW_WATERMARK = 100;       // <= $1 triggers auto-recharge
export const MIN_TOPUP_USD = 12.50;     // smallest allowed top-up (price paid)
export const DEFAULT_TOPUP_USD = 25;    // default auto-recharge amount (assumed; user-adjustable)
export const MAX_RECHARGE_FAILS = 4;    // ~a week of retries before we stop and stay locked
export const DEFAULT_SPONSOR_CAP_USD = 20;

// ---- pricing helpers (pure) ----
export const valueUsdFromPricePaid = (pricePaid) => (Number(pricePaid) || 0) / MARKUP;
export const creditsFromPricePaid = (pricePaid) => Math.round(valueUsdFromPricePaid(pricePaid) * CREDITS_PER_USD);
export const pricePaidFromCredits = (credits) => +(((Number(credits) || 0) / CREDITS_PER_USD) * MARKUP).toFixed(2);
export const creditsForTurnCost = (costUsd) => Math.max(0, Math.ceil((Number(costUsd) || 0) * CREDITS_PER_USD));
// The credit tiers the picker offers (price PAID -> credits granted). Custom amounts >= MIN allowed.
export const TOPUP_TIERS = [12.50, 25, 50, 100].map((usd) => ({ priceUsd: usd, credits: creditsFromPricePaid(usd) }));

// A non-descript, non-guessable single-use code (e.g. "DMN-7F3K-Q2P9").
function genCode() {
  const a = randomBytes(8).toString("base64").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8);
  return `DMN-${a.slice(0, 4)}-${a.slice(4, 8)}`;
}

export function createCreditsStore({ dir }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "credits.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    uid TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',            -- active | locked
    autoRecharge INTEGER NOT NULL DEFAULT 1,
    autoAmountUsd REAL NOT NULL DEFAULT ${DEFAULT_TOPUP_USD},
    stripeCustomerId TEXT, hasCard INTEGER NOT NULL DEFAULT 0,
    rechargeFailCount INTEGER NOT NULL DEFAULT 0, lastRechargeAttempt TEXT,
    lifetimeTopupCredits INTEGER NOT NULL DEFAULT 0, createdAt TEXT, updatedAt TEXT )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, ts TEXT NOT NULL,
    delta INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT, balanceAfter INTEGER NOT NULL )`);
  db.exec(`CREATE TABLE IF NOT EXISTS coupons (
    code TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'free_tier', capUsd REAL NOT NULL DEFAULT ${DEFAULT_SPONSOR_CAP_USD},
    redeemedByUid TEXT, redeemedByEmail TEXT, redeemedAt TEXT, createdAt TEXT NOT NULL )`);
  const now = () => new Date().toISOString();
  const q = {
    get: db.prepare("SELECT * FROM accounts WHERE uid=?"),
    ins: db.prepare("INSERT INTO accounts (uid,createdAt,updatedAt) VALUES (?,?,?)"),
    setBal: db.prepare("UPDATE accounts SET balance=?, updatedAt=? WHERE uid=?"),
    setStatus: db.prepare("UPDATE accounts SET status=?, updatedAt=? WHERE uid=?"),
    setAuto: db.prepare("UPDATE accounts SET autoRecharge=?, autoAmountUsd=?, updatedAt=? WHERE uid=?"),
    setCard: db.prepare("UPDATE accounts SET stripeCustomerId=?, hasCard=?, updatedAt=? WHERE uid=?"),
    topup: db.prepare("UPDATE accounts SET balance=?, lifetimeTopupCredits=lifetimeTopupCredits+?, status='active', rechargeFailCount=0, updatedAt=? WHERE uid=?"),
    fail: db.prepare("UPDATE accounts SET rechargeFailCount=rechargeFailCount+1, lastRechargeAttempt=?, status=?, updatedAt=? WHERE uid=?"),
    led: db.prepare("INSERT INTO ledger (uid,ts,delta,kind,note,balanceAfter) VALUES (?,?,?,?,?,?)"),
    ledList: db.prepare("SELECT * FROM ledger WHERE uid=? ORDER BY id DESC LIMIT ?"),
    allAcct: db.prepare("SELECT * FROM accounts ORDER BY updatedAt DESC"),
    coup: db.prepare("SELECT * FROM coupons WHERE code=?"),
    coupIns: db.prepare("INSERT INTO coupons (code,kind,capUsd,createdAt) VALUES (?,?,?,?)"),
    coupRedeem: db.prepare("UPDATE coupons SET redeemedByUid=?, redeemedByEmail=?, redeemedAt=? WHERE code=? AND redeemedByUid IS NULL"),
    coupAll: db.prepare("SELECT * FROM coupons ORDER BY createdAt DESC"),
  };

  function ensure(uid) {
    if (!uid) throw new Error("uid required");
    let a = q.get.get(uid);
    if (!a) { q.ins.run(uid, now(), now()); a = q.get.get(uid); }
    return a;
  }
  const balance = (uid) => ensure(uid).balance;
  function record(uid, delta, kind, note = "") {
    const a = ensure(uid);
    const after = a.balance + delta;
    q.setBal.run(after, now(), uid);
    q.led.run(uid, now(), delta, kind, note.slice(0, 200), after);
    return after;
  }
  // Meter a completed turn. Returns { balance, low, wentNegative }.
  function deductTurn(uid, costUsd, note = "") {
    const credits = creditsForTurnCost(costUsd);
    if (credits <= 0) { const b = ensure(uid).balance; return { balance: b, low: b <= LOW_WATERMARK, charged: 0 }; }
    const after = record(uid, -credits, "deduct", note || `turn cost $${(Number(costUsd) || 0).toFixed(4)}`);
    return { balance: after, low: after <= LOW_WATERMARK, wentNegative: after < 0, charged: credits };
  }
  // Grant credits for a successful payment (price PAID in USD). Unlocks + clears fail count.
  function grantTopup(uid, pricePaidUsd, note = "", { stripeRef = "" } = {}) {
    const credits = creditsFromPricePaid(pricePaidUsd);
    const a = ensure(uid);
    const after = a.balance + credits;
    q.topup.run(after, credits, now(), uid);
    q.led.run(uid, now(), credits, "topup", (note || `top-up $${Number(pricePaidUsd).toFixed(2)}`).slice(0, 200) + (stripeRef ? ` [${stripeRef}]` : ""), after);
    return { balance: after, granted: credits };
  }
  // Only 'credit' users with auto-recharge, a saved card, low balance, and an active account qualify.
  function needsRecharge(uid) {
    const a = ensure(uid);
    return a.status === "active" && !!a.autoRecharge && !!a.hasCard && a.balance <= LOW_WATERMARK;
  }
  // Record the outcome of an auto-recharge charge attempt. On repeated failure, lock the account.
  function recordRechargeResult(uid, ok, note = "") {
    const a = ensure(uid);
    if (ok) { q.topup.run(a.balance, 0, now(), uid); return { status: "active" }; }   // grantTopup does the credit add; this just clears fail state on success path callers may skip
    const willLock = a.rechargeFailCount + 1 >= MAX_RECHARGE_FAILS;
    q.fail.run(now(), willLock ? "locked" : a.status, now(), uid);
    q.led.run(uid, now(), 0, "recharge_fail", (note || "auto-recharge failed").slice(0, 200), a.balance);
    return { status: willLock ? "locked" : a.status, failCount: a.rechargeFailCount + 1, locked: willLock };
  }
  function setCard(uid, stripeCustomerId, hasCard = true) { ensure(uid); q.setCard.run(stripeCustomerId || null, hasCard ? 1 : 0, now(), uid); return { ok: true }; }
  function setAutoRecharge(uid, on, amountUsd) {
    ensure(uid);
    const amt = Math.max(MIN_TOPUP_USD, Number(amountUsd) || DEFAULT_TOPUP_USD);
    q.setAuto.run(on ? 1 : 0, amt, now(), uid);
    return { ok: true, autoRecharge: !!on, autoAmountUsd: amt };
  }
  const lock = (uid) => { ensure(uid); q.setStatus.run("locked", now(), uid); return { ok: true }; };
  const unlock = (uid) => { ensure(uid); q.setStatus.run("active", now(), uid); return { ok: true }; };

  // ---- coupons / invites ----
  function createCoupons(n = 10, capUsd = DEFAULT_SPONSOR_CAP_USD) {
    const codes = [];
    for (let i = 0; i < n; i++) { let c; do { c = genCode(); } while (q.coup.get(c)); q.coupIns.run(c, "free_tier", capUsd, now()); codes.push(c); }
    return codes;
  }
  // Redeem a single-use code. Burns the code and (via the caller's usersStore) flips the user to the
  // free 'sponsored' tier. Returns { ok, capUsd } or { error }.
  function redeemCoupon(uid, email, code) {
    const c = q.coup.get(String(code || "").trim().toUpperCase());
    if (!c) return { error: "That code isn't valid." };
    if (c.redeemedByUid) return { error: "That code has already been used." };
    const r = q.coupRedeem.run(uid, String(email || "").toLowerCase(), now(), c.code);
    if (!r.changes) return { error: "That code has already been used." };   // lost the race
    return { ok: true, capUsd: c.capUsd, kind: c.kind };
  }

  return {
    ensure, balance, record, deductTurn, grantTopup, needsRecharge, recordRechargeResult,
    setCard, setAutoRecharge, lock, unlock,
    account: (uid) => ensure(uid),
    ledger: (uid, limit = 50) => q.ledList.all(uid, limit),
    accounts: () => q.allAcct.all(),
    createCoupons, redeemCoupon, coupons: () => q.coupAll.all(),
    couponStats: () => { const all = q.coupAll.all(); return { total: all.length, redeemed: all.filter((c) => c.redeemedByUid).length, open: all.filter((c) => !c.redeemedByUid).length }; },
    _db: db,
  };
}
