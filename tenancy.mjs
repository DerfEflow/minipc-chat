/*
 * Dominion AI — tenancy (multi-tenant identity + users/roles). SOW items 1-2.
 *
 * Identity comes from Cloudflare Access: every request that reaches the app has already passed the
 * Access login (the Cloudflare Tunnel is the only ingress), so the verified email arrives in the
 * `Cf-Access-Authenticated-User-Email` header. That header is the ONLY identity source. A request
 * with no verified email is an anonymous no-state visitor (default-deny): it can load the shell but
 * gets no tenant, no stores, no tools.
 *
 * Roles:
 *   owner     — Fred. Full access, his machines, local model, dollars, no caps. (OWNER_EMAIL)
 *   sponsored — Fred covers cost (kids + coupon holders). No card, no local model, monthly $ ceiling.
 *   credit    — everyone else. Prepaid credits + mandatory auto-recharge, no local model.
 *
 * The users store is a tiny append-safe SQLite table (node:sqlite). Balances/ledger live in the
 * credits store (SOW item 8); this store is identity + role + status + onboarding + caps only.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ROLES = ["owner", "sponsored", "credit"];
export const HEADER = "cf-access-authenticated-user-email";
// A stable, filesystem-safe, privacy-preserving id for a user's data namespace (/data/users/<id>).
export const userIdFor = (email) => createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 16);

export function createUsersStore({ dir, ownerEmail }) {
  mkdirSync(dir, { recursive: true });
  const OWNER = String(ownerEmail || "").trim().toLowerCase();
  const db = new DatabaseSync(join(dir, "users.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, uid TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'credit',
    status TEXT NOT NULL DEFAULT 'active',        -- active | paused | locked
    consented INTEGER NOT NULL DEFAULT 0,          -- one-time notice acknowledged
    sponsoredCapUsd REAL NOT NULL DEFAULT 20,       -- monthly ceiling Fred covers (sponsored)
    sponsoredSpentUsd REAL NOT NULL DEFAULT 0,      -- rolling monthly spend against the cap
    capPeriod TEXT,                                 -- YYYY-MM the spend window applies to
    createdAt TEXT, updatedAt TEXT )`);
  const now = () => new Date().toISOString();
  const stmt = {
    get: db.prepare("SELECT * FROM users WHERE email=?"),
    insert: db.prepare("INSERT INTO users (email,uid,role,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?)"),
    setRole: db.prepare("UPDATE users SET role=?, updatedAt=? WHERE email=?"),
    setStatus: db.prepare("UPDATE users SET status=?, updatedAt=? WHERE email=?"),
    consent: db.prepare("UPDATE users SET consented=1, updatedAt=? WHERE email=?"),
    setCap: db.prepare("UPDATE users SET sponsoredCapUsd=?, updatedAt=? WHERE email=?"),
    addSpend: db.prepare("UPDATE users SET sponsoredSpentUsd=?, capPeriod=?, updatedAt=? WHERE email=?"),
    all: db.prepare("SELECT * FROM users ORDER BY createdAt"),
  };

  // Resolve (and lazily create) the user record for an email. Owner is forced regardless of the row.
  function ensure(email, defaults = {}) {
    const e = String(email || "").trim().toLowerCase();
    if (!e) return null;
    let row = stmt.get.get(e);
    if (!row) {
      const role = e === OWNER ? "owner" : (defaults.role || "credit");
      stmt.insert.run(e, userIdFor(e), role, "active", now(), now());
      row = stmt.get.get(e);
    }
    if (e === OWNER && row.role !== "owner") { stmt.setRole.run("owner", now(), e); row = stmt.get.get(e); }
    return row;
  }

  // The identity a request carries. No header => anonymous (no tenant).
  function identify(req, { autocreate = true } = {}) {
    const email = String((req && req.headers && req.headers[HEADER]) || "").trim().toLowerCase();
    if (!email) return { email: "", uid: "", role: "anon", status: "anon", isOwner: false };
    const row = autocreate ? ensure(email) : stmt.get.get(email);
    if (!row) return { email, uid: userIdFor(email), role: "credit", status: "active", isOwner: email === OWNER };
    return { email: row.email, uid: row.uid, role: row.role, status: row.status, consented: !!row.consented,
      isOwner: row.role === "owner", sponsoredCapUsd: row.sponsoredCapUsd, sponsoredSpentUsd: row.sponsoredSpentUsd, capPeriod: row.capPeriod };
  }

  // Roll the sponsored monthly spend into the cap; returns { over, spent, cap } after adding usd.
  function addSponsoredSpend(email, usd, period) {
    const e = String(email).toLowerCase(); const row = stmt.get.get(e); if (!row) return { over: false };
    const p = period || new Date().toISOString().slice(0, 7);
    const spent = (row.capPeriod === p ? row.sponsoredSpentUsd : 0) + (Number(usd) || 0);
    stmt.addSpend.run(spent, p, now(), e);
    const over = spent >= row.sponsoredCapUsd;
    if (over && row.status === "active") stmt.setStatus.run("paused", now(), e);
    return { over, spent, cap: row.sponsoredCapUsd };
  }

  return {
    identify, ensure,
    get: (email) => stmt.get.get(String(email || "").toLowerCase()),
    setRole: (email, role) => { if (!ROLES.includes(role)) return { error: "bad role" }; stmt.setRole.run(role, now(), String(email).toLowerCase()); return { ok: true }; },
    setStatus: (email, status) => { stmt.setStatus.run(status, now(), String(email).toLowerCase()); return { ok: true }; },
    markConsented: (email) => { stmt.consent.run(now(), String(email).toLowerCase()); return { ok: true }; },
    setSponsoredCap: (email, usd) => { stmt.setCap.run(Number(usd) || 0, now(), String(email).toLowerCase()); return { ok: true }; },
    resetSponsoredSpend: (email) => { stmt.addSpend.run(0, new Date().toISOString().slice(0, 7), now(), String(email).toLowerCase()); return { ok: true }; },
    addSponsoredSpend,
    list: () => stmt.all.all(),
    OWNER,
  };
}
