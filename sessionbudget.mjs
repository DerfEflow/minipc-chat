/*
 * Dominion AI — session budgets: the transparent per-conversation spending gate (Fred's spec,
 * 2026-07-25). HIGH blast radius (money), so like billing.mjs the logic is deterministic,
 * SQLite-backed, and unit-tested; the server only calls in, it never does budget math itself.
 *
 * The model:
 *   - ONE account balance (billing.mjs). Chat, image generation, and Crucible all draw from it.
 *   - A SESSION = one chat conversation (or one Crucible project). Each session carries a budget:
 *     guests in CREDITS (default 1000 = $10 of token value), the owner in USD (default $5 — the
 *     owner has no credit pool; OpenRouter is his true backstop, so his budget is a cap only).
 *   - EARMARK RULE: while a session is RUNNING (a turn in flight), its unspent budget
 *     (budget - spent) is HELD against the account. available = balance - sum(other running holds).
 *     The same credits can never be committed to two sessions at once.
 *   - REDUCING a running session's budget releases the freed credits immediately. The floor is what
 *     the session has already spent — money already gone can never be "released".
 *   - Hitting a cap PAUSES work (the server's job) — this module just answers "over or not".
 *   - Image generation has NO budget cap: it draws from AVAILABLE (un-earmarked) credits only;
 *     imageAllowance() is the one call it needs.
 *   - Transparency is a feature: overBudgetDetail() returns every number (total, held, available,
 *     who holds what) and buildOverBudgetMessage() words it the way Fred specified — the server and
 *     the UI show the SAME sentence, never a vague "not enough credits".
 *
 * What this module does NOT do: it never charges anyone. billing.chargeTurn stays the single source
 * of truth for real deductions; recordSpend() here mirrors the deduction it was told about, so the
 * budget ledger can never drift from the money ledger by doing its own estimating.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const GUEST_DEFAULT_CREDITS = 1000;   // = $10 of token value (100 credits = $1, billing.mjs)
export const OWNER_DEFAULT_USD = 5;

export function createSessionBudgets({ dir, defaults = {}, now = () => new Date().toISOString() }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "session-budgets.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    email TEXT NOT NULL, sessionId TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    title TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL,                            -- 'credits' (guests) | 'usd' (owner)
    budget REAL NOT NULL,
    spent REAL NOT NULL DEFAULT 0,
    running INTEGER NOT NULL DEFAULT 0,            -- 1 while a turn is in flight (the earmark window)
    status TEXT NOT NULL DEFAULT 'active',         -- active | closed
    createdAt TEXT, updatedAt TEXT,
    PRIMARY KEY (email, sessionId) )`);

  const guestDefault = Number(defaults.guestCredits) > 0 ? Number(defaults.guestCredits) : GUEST_DEFAULT_CREDITS;
  const ownerDefault = Number(defaults.ownerUsd) > 0 ? Number(defaults.ownerUsd) : OWNER_DEFAULT_USD;

  const q = {
    get: db.prepare("SELECT * FROM sessions WHERE email=? AND sessionId=?"),
    ins: db.prepare("INSERT INTO sessions (email,sessionId,kind,title,unit,budget,spent,running,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,0,0,'active',?,?)"),
    setBudget: db.prepare("UPDATE sessions SET budget=?, updatedAt=? WHERE email=? AND sessionId=?"),
    setSpent: db.prepare("UPDATE sessions SET spent=?, updatedAt=? WHERE email=? AND sessionId=?"),
    setRunning: db.prepare("UPDATE sessions SET running=?, updatedAt=? WHERE email=? AND sessionId=?"),
    setTitle: db.prepare("UPDATE sessions SET title=?, updatedAt=? WHERE email=? AND sessionId=?"),
    setStatus: db.prepare("UPDATE sessions SET status=?, updatedAt=? WHERE email=? AND sessionId=?"),
    runningFor: db.prepare("SELECT * FROM sessions WHERE email=? AND running=1 AND status='active'"),
    clearAllRunning: db.prepare("UPDATE sessions SET running=0, updatedAt=? WHERE running=1"),
  };
  const lc = (e) => String(e || "").trim().toLowerCase();
  const sid = (s) => String(s || "").slice(0, 80);

  // ---- holds ----------------------------------------------------------------------------------
  // A session's hold = its unspent budget, but ONLY while it is running. Fred's rule verbatim:
  // "the budget committed in the first session is treated as spent and unavailable" — while it runs.
  const holdOf = (row) => (row && row.running && row.status === "active") ? Math.max(0, row.budget - row.spent) : 0;

  // Every OTHER running session's hold for this account (exceptId = the session asking).
  function holdsFor(email, exceptId = "") {
    const rows = q.runningFor.all(lc(email));
    return rows
      .filter((r) => r.sessionId !== sid(exceptId))
      .map((r) => ({ sessionId: r.sessionId, title: r.title || "another chat", hold: holdOf(r) }))
      .filter((h) => h.hold > 0);
  }

  // available = balance minus everything earmarked elsewhere. balance is INJECTED per call (the
  // billing ledger owns it); this module never reads the money ledger directly.
  function available(email, balance, exceptId = "") {
    const held = holdsFor(email, exceptId).reduce((n, h) => n + h.hold, 0);
    return Math.max(0, (Number(balance) || 0) - held);
  }

  // ---- the transparent over-budget message (Fred's wording, all three numbers + the holder) ----
  function buildOverBudgetMessage({ requested, balance, avail, holders, unit }) {
    const u = unit === "usd" ? (n) => "$" + (+n).toFixed(2) : (n) => Math.floor(n) + " credits";
    // Two honest cases, never conflated: funds EARMARKED elsewhere vs simply not enough balance.
    if (holders && holders.length) {
      const top = holders.map((h) => `"${h.title}" has ${u(h.hold)} earmarked and still running`).join("; ");
      return `${top}, so those funds cannot be committed again here. Your account holds ${u(balance)} total, ` +
        `which leaves ${u(avail)} available for this session. Add more credits for a larger budget, ` +
        `or set this session's budget to ${u(avail)} or less.`;
    }
    return `Your account holds ${u(balance)}, which covers a session budget of up to ${u(avail)}. ` +
      `Add more credits for a larger budget${avail > 0 ? `, or set this session's budget to ${u(avail)} or less` : ""}.`;
  }

  // ---- sessions -------------------------------------------------------------------------------
  // ensure(): create-or-fetch. On CREATE for a guest, the default budget clamps to what is actually
  // available right now ("everything recalculated based on actual current numbers"); shortfall=true
  // tells the server to raise the big transparent popup. The owner never clamps (no pool).
  function ensure(email, sessionId, { isOwner = false, kind = "chat", title = "", balance = 0 } = {}) {
    const e = lc(email), s = sid(sessionId);
    if (!e || !s) return null;
    let row = q.get.get(e, s);
    if (!row) {
      const unit = isOwner ? "usd" : "credits";
      let budget = isOwner ? ownerDefault : guestDefault;
      let shortfall = null;
      if (!isOwner) {
        const avail = available(e, balance, s);
        if (avail < budget) {
          shortfall = { wanted: budget, avail, balance: Number(balance) || 0, holders: holdsFor(e, s) };
          budget = avail;   // never earmark money the account doesn't have free
        }
      }
      q.ins.run(e, s, kind, String(title || "").slice(0, 120), unit, budget, now(), now());
      row = q.get.get(e, s);
      return { ...state(row), created: true, shortfall };
    }
    if (title && title !== row.title) { q.setTitle.run(String(title).slice(0, 120), now(), e, s); row = q.get.get(e, s); }
    return { ...state(row), created: false, shortfall: null };
  }

  const state = (row) => row ? ({
    sessionId: row.sessionId, kind: row.kind, title: row.title, unit: row.unit,
    budget: row.budget, spent: row.spent, remaining: Math.max(0, row.budget - row.spent),
    running: !!row.running, status: row.status,
  }) : null;

  const get = (email, sessionId) => state(q.get.get(lc(email), sid(sessionId)));

  // setBudget(): raise or lower. Lowering RELEASES the difference instantly (the hold is derived,
  // so no bookkeeping to undo); the floor is spent. Raising re-validates against available for
  // guests and returns the full transparent detail on refusal — nothing vague, ever.
  function setBudget(email, sessionId, requested, { balance = 0 } = {}) {
    const e = lc(email), s = sid(sessionId);
    const row = q.get.get(e, s);
    if (!row) return { error: "no_session" };
    let want = Number(requested);
    if (!Number.isFinite(want) || want < 0) return { error: "bad_amount" };
    want = Math.max(want, row.spent);   // floor: money already spent can never be released
    if (row.unit === "credits") {
      want = Math.floor(want);
      const avail = available(e, balance, s);          // own hold excluded — we're replacing it
      if (want - row.spent > avail) {
        const holders = holdsFor(e, s);
        const maxAllowable = Math.floor(row.spent + avail);
        return { error: "over_available", requested: want, balance: Number(balance) || 0, avail,
                 holders, maxAllowable, unit: row.unit,
                 message: buildOverBudgetMessage({ requested: want, balance, avail, holders, unit: row.unit }) };
      }
    }
    q.setBudget.run(want, now(), e, s);
    return { ok: true, ...state(q.get.get(e, s)) };
  }

  // recordSpend(): mirror what billing ACTUALLY deducted (credits) or what the turn ACTUALLY cost
  // (owner USD). Returns over=true when the cap is reached — the server's cue to pause-and-raise.
  function recordSpend(email, sessionId, amount) {
    const e = lc(email), s = sid(sessionId);
    const row = q.get.get(e, s);
    if (!row) return { error: "no_session" };
    const add = Math.max(0, Number(amount) || 0);
    const spent = row.spent + add;
    q.setSpent.run(spent, now(), e, s);
    return { spent, remaining: Math.max(0, row.budget - spent), over: spent >= row.budget };
  }

  // The earmark window: the server flips running on when a turn starts and off when it ends.
  function setRunning(email, sessionId, on) {
    q.setRunning.run(on ? 1 : 0, now(), lc(email), sid(sessionId));
    return { ok: true };
  }

  // Boot sweep: a crash mid-turn must not leave a ghost hold haunting the balance forever.
  function sweepRunning() { q.clearAllRunning.run(now()); return { ok: true }; }

  function close(email, sessionId) { q.setStatus.run("closed", now(), lc(email), sid(sessionId)); return { ok: true }; }

  // Image generation's one question: how much is free RIGHT NOW (no cap of its own, earmarks honored).
  function imageAllowance(email, balance) {
    const avail = available(email, balance, "");
    return { available: avail, holders: holdsFor(email, "") };
  }

  return { ensure, get, setBudget, recordSpend, setRunning, sweepRunning, close,
           available, holdsFor, imageAllowance, buildOverBudgetMessage,
           defaults: { guestCredits: guestDefault, ownerUsd: ownerDefault } };
}
