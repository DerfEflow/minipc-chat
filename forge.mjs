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
import { zipBuffer } from "./docwriters.mjs";

export const MAX_ROOTS = 20;               // Fred: "one or 20, up to them"
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const mkToken = () => "dfk_" + randomBytes(24).toString("hex");   // Dominion ForKe (per-user hands token)

/*
 * Beginner installer zip — one download, token baked in, nothing to type. No Cloudflare Access
 * fields: the split documented in server.mjs's /forge/token handler means a bare HANDS_URL +
 * HANDS_TOKEN is the whole story for a per-user node.
 *
 * PERSISTENCE (guest report, 2026-08-08: "as soon as he closes the program and reopens it, all his
 * connectors disconnect"). The first cut of this zip ran only while its black window stayed open,
 * so every reboot or closed window silently unplugged the machine and every chat after that hit
 * "your machine is disconnected". The connection now survives the daily cycle:
 *   - the main bat offers (default YES) a Startup-folder entry, so the node reconnects on every
 *     login without anyone remembering a window;
 *   - "Dominion Forge Quiet Start.cmd" is the background runner it points at — minimized, and it
 *     restarts the node if it ever crashes (but NOT when the server said the token is dead, exit
 *     code 2, because looping on a revoked token is a zombie);
 *   - "Stop Auto Connect.bat" is the honest off-switch, named in the window and the README.
 * The Startup entry is rewritten on every run of the main bat, so moving the extracted folder heals
 * itself the next time the user double-clicks the bat. No elevation anywhere: the Startup folder is
 * the user's own (%APPDATA%), which is exactly the blast radius a guest node should have.
 */
const STARTUP_POINTER = "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Dominion Forge.cmd";
export function buildInstallerZip({ url, token, nodeName, handsSrc, snapshotSrc }) {
  const bat = [
    "@echo off",
    "setlocal",
    "title Connect this computer to Dominion Forge",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo.",
    "  echo   This computer does not have Node yet. Node is a free program",
    "  echo   Dominion needs in order to run on your computer.",
    "  echo.",
    "  echo   1. Go to https://nodejs.org",
    "  echo   2. Click the big green button to download it",
    "  echo   3. Run the installer it downloads, click Next through it",
    "  echo   4. Come back here and double-click this file again",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "set HANDS_URL=" + url,
    "set HANDS_TOKEN=" + token,
    "set HANDS_NODE=" + nodeName,
    "echo.",
    "echo   Dominion can reconnect this computer automatically every time",
    "echo   it starts, so you never have to remember to open this window.",
    "echo.",
    "choice /c YN /n /t 20 /d Y /m \"  Turn that on? Press Y or N (Y happens by itself in 20 seconds) \"",
    "if errorlevel 2 goto skipauto",
    "> \"" + STARTUP_POINTER + "\" echo @echo off",
    ">> \"" + STARTUP_POINTER + "\" echo start \"Dominion Forge\" /min \"%~dp0Dominion Forge Quiet Start.cmd\"",
    "echo.",
    "echo   Done. This computer will reconnect to Dominion whenever it starts.",
    "echo   To undo that later, double-click \"Stop Auto Connect.bat\" in this folder.",
    ":skipauto",
    "echo.",
    "echo   Connecting this computer to Dominion...",
    "echo   Leave this window open. Minimize it if you like.",
    "echo   To disconnect for now, just close this window.",
    "echo.",
    "node \"%~dp0hands.mjs\"",
    "if errorlevel 2 (",
    "  echo.",
    "  echo   Dominion no longer accepts this connection file. That usually means a",
    "  echo   newer installer was downloaded for this account - each download replaces",
    "  echo   the one before it. Get a fresh one from Dominion: Setup, Your machine.",
    ")",
    "echo.",
    "echo   Disconnected.",
    "pause",
    "",
  ].join("\r\n");
  // The background runner the Startup entry launches. Restarts a crashed node after 15s; stops for
  // good when the node exits 2 (the hub rejected the token — retrying that forever is a zombie).
  const quiet = [
    "@echo off",
    "setlocal",
    "title Dominion Forge (connected in the background)",
    "where node >nul 2>nul",
    "if errorlevel 1 exit /b 1",
    "set HANDS_URL=" + url,
    "set HANDS_TOKEN=" + token,
    "set HANDS_NODE=" + nodeName,
    ":loop",
    "node \"%~dp0hands.mjs\"",
    "if errorlevel 2 exit /b 2",
    "timeout /t 15 /nobreak >nul",
    "goto loop",
    "",
  ].join("\r\n");
  const stopAuto = [
    "@echo off",
    "title Stop connecting to Dominion automatically",
    "if exist \"" + STARTUP_POINTER + "\" del \"" + STARTUP_POINTER + "\"",
    "echo.",
    "echo   Done. This computer will no longer connect to Dominion on its own.",
    "echo   You can still connect any time with \"Connect Me To Dominion.bat\".",
    "echo.",
    "pause",
    "",
  ].join("\r\n");
  const readme = [
    "HOW TO CONNECT YOUR COMPUTER TO DOMINION FORGE",
    "",
    "1. Right-click this zip file (the one you downloaded) and choose \"Extract All\"",
    "2. Open the new folder it creates",
    "3. Double-click \"Connect Me To Dominion.bat\"",
    "4. A black window opens. Leave it open, that means it is working.",
    "5. It will offer to reconnect automatically whenever this computer starts.",
    "   Say yes (or just wait) and the connection comes back on its own after",
    "   every restart. \"Stop Auto Connect.bat\" turns that off again.",
    "6. Go back to Dominion and pick which folders it may use.",
    "",
    "To stop for now, just close the black window.",
    "If you move this folder somewhere else, double-click \"Connect Me To Dominion.bat\"",
    "once from its new home so the automatic reconnect learns the new address.",
    "This file is yours alone. If you ever lose it, download a fresh one from Dominion; the old one",
    "stops working the moment you do.",
    "",
  ].join("\r\n");
  return zipBuffer([
    { name: "Connect Me To Dominion.bat", data: bat },
    { name: "Dominion Forge Quiet Start.cmd", data: quiet },
    { name: "Stop Auto Connect.bat", data: stopAuto },
    { name: "READ ME FIRST.txt", data: readme },
    { name: "hands.mjs", data: handsSrc },
    { name: "snapshot.mjs", data: snapshotSrc },
  ]);
}

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
