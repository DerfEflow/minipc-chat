/*
 * Dominion AI — per-user Forge store (SOW item: "let users act as I do, on their own folders").
 *
 * Each non-owner who turns on Forge runs their OWN hands node on their OWN machine, authenticated by a
 * per-user token minted here. The hub binds that node connection to the user's uid, so a user's chat
 * can reach ONLY their own node, never another user's machine. The user picks which folders the node
 * may touch (one to twenty); those roots are stored here and pushed to the node, always still bounded
 * by the global ironclad carve-outs (D:, backups, customer DBs) which the node and hub re-enforce.
 *
 * HIGH blast radius (machine access + cross-tenant isolation), so token verification and the roots cap
 * are unit-tested, and the token is stored only as a SHA-256 hash (the plaintext is shown once).
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const MAX_ROOTS = 20;               // Fred: "one or 20, up to them"
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const mkToken = () => "dfk_" + randomBytes(24).toString("hex");   // Dominion ForKe (per-user hands token)

export function createForgeStore({ dir, now = () => new Date().toISOString() }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "forge.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS forge (
    uid TEXT PRIMARY KEY, tokenHash TEXT, roots TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 0, createdAt TEXT, updatedAt TEXT )`);
  const q = {
    get: db.prepare("SELECT * FROM forge WHERE uid=?"),
    byToken: db.prepare("SELECT uid FROM forge WHERE tokenHash=?"),
    ins: db.prepare("INSERT INTO forge (uid,roots,enabled,createdAt,updatedAt) VALUES (?,?,?,?,?)"),
    setToken: db.prepare("UPDATE forge SET tokenHash=?, updatedAt=? WHERE uid=?"),
    setRoots: db.prepare("UPDATE forge SET roots=?, updatedAt=? WHERE uid=?"),
    setEnabled: db.prepare("UPDATE forge SET enabled=?, updatedAt=? WHERE uid=?"),
  };
  function ensure(uid) {
    const u = String(uid || ""); if (!u) return null;
    let row = q.get.get(u);
    if (!row) { q.ins.run(u, "[]", 0, now(), now()); row = q.get.get(u); }
    return row;
  }
  // Mint a fresh per-user hands token (invalidates the previous one). Returns the plaintext ONCE.
  function generateToken(uid) {
    ensure(uid);
    const tok = mkToken();
    q.setToken.run(sha(tok), now(), String(uid));
    return tok;
  }
  // Resolve a presented bearer token to a uid, or null. (The stored value is the token's hash.)
  function verifyToken(token) {
    const t = String(token || ""); if (!t.startsWith("dfk_")) return null;
    const row = q.byToken.get(sha(t));
    return row ? row.uid : null;
  }
  // Save the user's chosen folders (validated: absolute-ish strings, capped at MAX_ROOTS, deduped).
  function setRoots(uid, roots) {
    ensure(uid);
    const clean = [...new Set((Array.isArray(roots) ? roots : [])
      .map((r) => String(r || "").trim()).filter((r) => r && r.length <= 400))].slice(0, MAX_ROOTS);
    q.setRoots.run(JSON.stringify(clean), now(), String(uid));
    return { ok: true, roots: clean, capped: (Array.isArray(roots) ? roots.length : 0) > MAX_ROOTS };
  }
  function getRoots(uid) { const r = ensure(uid); try { return JSON.parse(r.roots) || []; } catch { return []; } }
  function setEnabled(uid, on) { ensure(uid); q.setEnabled.run(on ? 1 : 0, now(), String(uid)); return { ok: true, enabled: !!on }; }
  function status(uid) {
    const r = ensure(uid);
    let roots = []; try { roots = JSON.parse(r.roots) || []; } catch {}
    return { enabled: !!r.enabled, hasToken: !!r.tokenHash, roots, maxRoots: MAX_ROOTS };
  }
  return { generateToken, verifyToken, setRoots, getRoots, setEnabled, status, MAX_ROOTS };
}
