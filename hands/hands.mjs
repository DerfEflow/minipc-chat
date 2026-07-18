/*
 * Dominion AI — hands node (Phase 1 of the cloud migration).
 *
 * One of these runs on each of Fred's machines (mini-PC always-on, laptop when awake). It DIALS OUT
 * to the orchestrator (server.mjs, later on Railway) and holds one long-lived SSE stream open; the
 * orchestrator pushes tool jobs down that stream and this node POSTs results back. No inbound port
 * ever opens on Fred's machines, and the hands do not ride the tailnet (Fred, 2026-07-14: Tailscale
 * is scoped to Qwen access + updates only).
 *
 * Design guarantees (mirror machines.mjs where they overlap):
 *   - The ironclad carve-outs from tools.mjs are ported VERBATIM and enforced here on every job,
 *     even though the hub also checks before dispatch. Defense in depth: a compromised or buggy
 *     orchestrator still cannot reach D:\, the backups, or a customer DB through this node.
 *   - The node refuses to write into its own install dir or the live app dir (C:\minipc-chat by
 *     default) — the box is the mission's fallback and nothing on it gets deleted until one clean
 *     week has passed on Railway.
 *   - Filesystem reach is limited to HANDS_ROOTS (explicit, env-set). Everything resolves through
 *     the roots check before it touches disk.
 *   - A dead stream is detected by heartbeat lapse (the hub beats every 20s; we give it 50s) and
 *     answered with a jittered, capped reconnect loop. Never a retry storm, never a silent zombie.
 *   - HANDS_TOKEN is required. No token, no node — auth exists before the surface does (L-017).
 *
 * Config (env only — this file runs standalone, no .env parsing, no npm deps):
 *   HANDS_URL     orchestrator base, e.g. https://dominion.up.railway.app  (required)
 *   HANDS_TOKEN   shared bearer secret (required; never logged)
 *   HANDS_NODE    node name in the hub registry (default: os.hostname(), lowercased)
 *   HANDS_ROOTS   comma-separated allowed filesystem roots, e.g. "C:\,E:\"  (default: none —
 *                 fs tools refuse until roots are set deliberately)
 *   HANDS_PROTECT extra comma-separated paths to refuse writes under (adds to the built-ins)
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join, sep, dirname } from "node:path";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

const HANDS_URL = String(process.env.HANDS_URL || "").replace(/\/$/, "");
const HANDS_TOKEN = process.env.HANDS_TOKEN || "";
const NODE_NAME = (process.env.HANDS_NODE || hostname() || "unnamed").toLowerCase();
const VERSION = "hands/1";
// Optional Cloudflare Access service token — when the orchestrator sits behind Access, the node
// presents these so its dial-out passes the Access layer; HANDS_TOKEN still authorizes at the app.
const CF_ID = process.env.HANDS_CF_CLIENT_ID || "";
const CF_SECRET = process.env.HANDS_CF_CLIENT_SECRET || "";
const authHeaders = (extra = {}) => {
  const h = { authorization: "Bearer " + HANDS_TOKEN, ...extra };
  if (CF_ID && CF_SECRET) { h["cf-access-client-id"] = CF_ID; h["cf-access-client-secret"] = CF_SECRET; }
  return h;
};

// ---- roots: max-access per Fred's spec ("almost everything, with the same exceptions") --------
// HANDS_MAX_ACCESS=1 gives the node the whole machine EXCEPT the ironclad carve-outs (D:\ backups,
// app/db backups, customer DBs, pg_dump/restore — enforced separately below and never widened).
// Windows: every fixed drive root that exists, minus D:\ (the backup SSD, also carve-out-blocked).
// Linux/container: the filesystem root ("/") — in Docker that is the container's view, so what the
// node can reach is exactly what the run mounts in (see hands/Dockerfile). Explicit HANDS_ROOTS is
// unioned on top, so you can pin narrower roots and still add specific extra paths.
function discoverMaxRoots() {
  if (!IS_WIN) return ["/"];
  const out = [];
  for (let c = 67; c <= 90; c++) {            // C: .. Z:  (A:/B: are legacy floppies; skip)
    const letter = String.fromCharCode(c);
    if (letter === "D") continue;             // the backup drive — carve-out territory, never a root
    const root = letter + ":\\";
    try { if (existsSync(root)) out.push(root); } catch {}
  }
  return out;
}
const MAX_ACCESS = String(process.env.HANDS_MAX_ACCESS || "") === "1";
// ROOTS is mutable: the owner sets it via env (HANDS_ROOTS / HANDS_MAX_ACCESS), and a per-user node
// receives it at runtime from the folder picker via the set_roots job (bounded by carve-outs below).
let ROOTS = [
  ...(MAX_ACCESS ? discoverMaxRoots() : []),
  ...String(process.env.HANDS_ROOTS || "").split(",").map((s) => s.trim()).filter(Boolean),
];

// ---- ironclad carve-out guard — ported VERBATIM from tools.mjs (ALWAYS on, even under LAX) ----
// Two resources the assistant must NEVER touch: (1) customer/production databases,
// (2) app backups (mini-PC D: + the backup system). Conservative patterns to avoid false-denials.
const PROTECTED_RE = [
  /(^|[^a-z0-9])d:[\\/]/i,        // mini-PC D: = the backup SSD
  /app[-_ ]?backups?/i,          // the app-backup system
  /\bdb[-_ ]?backups?\b/i,
  /pg_dump|pg_restore/i,         // dumping/restoring a (prod) DB
];
export function assertNotProtected(args) {
  const blob = JSON.stringify(args || {});
  for (const re of PROTECTED_RE) {
    if (re.test(blob)) return { ok: false, reason: "references a protected resource (app backups / customer DB) — hard carve-out, never touched" };
  }
  return { ok: true };
}

// ---- self-protection: this node must not be able to damage its own host -----------------------
// The live app dir is the mission's fallback; the node's own dir is the node. Writes under either
// are refused, and shell commands that pair a destructive verb with either path are refused.
// (A shell command is opaque — we cannot prove it safe, only refuse the recognizable footguns.
//  The carve-out scan above still applies to the full command text.)
const SELF_PROTECT = [
  HERE,
  IS_WIN ? "C:\\minipc-chat" : "/opt/minipc-chat",
  ...String(process.env.HANDS_PROTECT || "").split(",").map((s) => s.trim()).filter(Boolean),
].map((p) => norm(p));
const DESTRUCTIVE_RE = /(remove-item|\brmdir\b|\brd\b|\brm\b|\bdel\b|format-volume|\bformat\b|\bmklink\b)/i;

// ---- Wave 3 surfaces: browser + desktop -------------------------------------------------------
// The browser profile PERSISTS so sites logged into once stay logged in. Screenshots land in a
// dedicated dir on the node. Desktop control is OFF unless deliberately switched on, because it
// reaches below the tool-boundary carve-outs (see the header of hands/desktop.mjs).
const BROWSER_PROFILE = String(process.env.HANDS_BROWSER_PROFILE || join(HERE, ".browser"));
const SHOT_DIR = String(process.env.HANDS_SHOT_DIR || join(HERE, ".shots"));
const DESKTOP_ON = String(process.env.HANDS_DESKTOP || "") === "1";

function norm(p) { const r = resolve(String(p || "")); return IS_WIN ? r.toLowerCase() : r; }
function underAny(target, dirs) {
  const t = norm(target);
  return dirs.some((d) => t === d || t.startsWith(d.endsWith(sep) ? d : d + sep));
}
export function withinRoots(p) {
  if (!ROOTS.length) return { ok: false, reason: "no HANDS_ROOTS configured on this node — filesystem reach is off until roots are set deliberately" };
  const t = norm(p);
  const ok = ROOTS.some((r) => { const n = norm(r); return t === n || t.startsWith(n.endsWith(sep) ? n : n + sep); });
  return ok ? { ok: true } : { ok: false, reason: `outside this node's allowed roots (${ROOTS.join(", ")})` };
}
const refuse = (reason) => ({ ok: false, refused: true, reason });

// ---- shell (PowerShell on Windows via -EncodedCommand — the machines.mjs quoting-proof trick) --
function runShell(command, timeoutMs = 60000) {
  return new Promise((res) => {
    const t0 = Date.now();
    // The child must never see the hands secret.
    const env = { ...process.env }; delete env.HANDS_TOKEN;
    let cmd, args;
    if (IS_WIN) {
      const b64 = Buffer.from(String(command), "utf16le").toString("base64");
      cmd = "powershell"; args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64];
    } else {
      cmd = "sh"; args = ["-c", String(command)];
    }
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, env }); }
    catch (e) { return res({ ok: false, error: "could not launch shell: " + (e && e.message) }); }
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (done) return; done = true; try { child.kill(); } catch {} res(r); };
    const cap = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 600000);
    const timer = setTimeout(() => finish({ ok: false, timedOut: true, code: -1, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), ms: Date.now() - t0 }), cap);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: String(e && e.message || e), ms: Date.now() - t0 }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ ok: code === 0, code, stdout: stdout.slice(0, 64000), stderr: stderr.slice(0, 16000), ms: Date.now() - t0 }); });
  });
}

// ---- the executor: one job in, one result out. Exported so tests hit it directly. -------------
export async function executeJob(tool, args = {}) {
  // Carve-outs first, on the raw args blob, for EVERY tool — same order as the tool bus.
  const guard = assertNotProtected(args);
  if (!guard.ok) return refuse(guard.reason);
  try {
    switch (tool) {
      case "node_info":
        return { ok: true, node: NODE_NAME, host: hostname(), platform: process.platform, roots: ROOTS, protectedDirs: SELF_PROTECT.length, pid: process.pid, uptimeSec: Math.round(process.uptime()), version: VERSION };
      case "set_roots": {
        // The folder picker sets which folders this node may touch. Carve-outs and self-protect are
        // never overridable: a protected or self-protected path is dropped, not honored.
        const incoming = (Array.isArray(args.roots) ? args.roots : []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 40);
        const accepted = incoming.filter((r) => assertNotProtected({ path: r }).ok && !underAny(r, SELF_PROTECT));
        ROOTS = accepted;
        return { ok: true, roots: ROOTS, dropped: incoming.length - accepted.length };
      }
      case "fs_browse": {
        // Folder navigation for the picker: list DRIVES (no path) or immediate SUBFOLDERS of a path.
        // Returns folder names only (no file contents), NOT gated by ROOTS so the user can choose from
        // their whole machine, but carve-outs still hard-deny protected locations.
        if (!args.path) return { ok: true, path: "", dirs: (IS_WIN ? discoverMaxRoots() : ["/"]).map((d) => ({ name: d, path: d })) };
        const w = assertNotProtected({ path: args.path }); if (!w.ok) return refuse(w.reason);
        if (!existsSync(args.path)) return { ok: false, error: "not found: " + args.path };
        let ents = [];
        try { ents = readdirSync(args.path, { withFileTypes: true }); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        const dirs = ents.filter((e) => { try { return e.isDirectory(); } catch { return false; } })
          .map((e) => e.name).filter((n) => !n.startsWith("$")).slice(0, 500)
          .map((n) => ({ name: n, path: join(args.path, n) }))
          .filter((d) => assertNotProtected({ path: d.path }).ok);
        return { ok: true, path: args.path, dirs };
      }
      case "fs_read": {
        const w = withinRoots(args.path); if (!w.ok) return refuse(w.reason);
        const max = Math.min(Number(args.maxBytes) || 2_000_000, 20_000_000);
        if (!existsSync(args.path)) return { ok: false, error: "not found: " + args.path };
        const st = statSync(args.path);
        if (st.isDirectory()) return { ok: false, error: "that is a directory — use fs_list" };
        if (st.size > max) return { ok: false, error: `file is ${st.size} bytes (> ${max} cap)` };
        const buf = readFileSync(args.path);
        return args.base64 ? { ok: true, path: args.path, bytes: buf.length, base64: buf.toString("base64") }
                           : { ok: true, path: args.path, bytes: buf.length, text: buf.toString("utf8") };
      }
      case "fs_write": {
        const w = withinRoots(args.path); if (!w.ok) return refuse(w.reason);
        if (underAny(args.path, SELF_PROTECT)) return refuse("write under a self-protected dir (the live app / this node) — the box is the mission's fallback");
        const buf = args.base64 ? Buffer.from(String(args.content || ""), "base64") : Buffer.from(String(args.content ?? ""), "utf8");
        mkdirSync(dirname(resolve(args.path)), { recursive: true });
        writeFileSync(args.path, buf);
        return { ok: true, path: args.path, bytes: buf.length };
      }
      case "fs_append": {
        // Chunked transfer: append a base64 chunk to a file. truncate:true starts a fresh file
        // (first chunk), then subsequent calls append. Lets large files (e.g. the ~88MB corpus
        // backup) cross the SSE job channel in bounded pieces instead of one giant frame.
        const w = withinRoots(args.path); if (!w.ok) return refuse(w.reason);
        if (underAny(args.path, SELF_PROTECT)) return refuse("append under a self-protected dir (the live app / this node)");
        const buf = Buffer.from(String(args.content || ""), args.base64 === false ? "utf8" : "base64");
        mkdirSync(dirname(resolve(args.path)), { recursive: true });
        if (args.truncate) writeFileSync(args.path, buf); else appendFileSync(args.path, buf);
        let total = 0; try { total = statSync(args.path).size; } catch {}
        return { ok: true, path: args.path, appended: buf.length, totalBytes: total };
      }
      case "fs_list": {
        const w = withinRoots(args.path); if (!w.ok) return refuse(w.reason);
        const entries = readdirSync(args.path, { withFileTypes: true }).slice(0, 500).map((e) => {
          let size = null; try { if (e.isFile()) size = statSync(join(args.path, e.name)).size; } catch {}
          return { name: e.name, type: e.isDirectory() ? "dir" : "file", size };
        });
        return { ok: true, path: args.path, entries };
      }
      case "fs_tree": {
        const w = withinRoots(args.path); if (!w.ok) return refuse(w.reason);
        const depth = Math.min(Math.max(Number(args.depth) || 3, 1), 6);
        const lines = [];
        const walk = (dir, pre, d) => {
          if (d > depth || lines.length >= 800) return;
          let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (lines.length >= 800) return;
            lines.push(pre + e.name + (e.isDirectory() ? "/" : ""));
            if (e.isDirectory()) walk(join(dir, e.name), pre + "  ", d + 1);
          }
        };
        walk(String(args.path), "", 1);
        return { ok: true, path: args.path, tree: lines, truncated: lines.length >= 800 };
      }
      case "shell_run": {
        const cmdText = String(args.command || "");
        if (!cmdText.trim()) return { ok: false, error: "empty command" };
        if (DESTRUCTIVE_RE.test(cmdText) && SELF_PROTECT.some((d) => cmdText.toLowerCase().includes(d))) {
          return refuse("destructive command against a self-protected dir (the live app / this node)");
        }
        return await runShell(cmdText, args.timeoutMs);
      }

      // ---- Wave 3: real browser + desktop reach (Fred's option 2, 2026-07-18) ----
      // browser_* drives a persistent Chrome profile over the DevTools Protocol (hands/browser.mjs).
      // desktop_* drives the actual mouse/keyboard/screen (hands/desktop.mjs). Both already had the
      // carve-out scan run against their args at the top of executeJob.
      case "browser_control": {
        const { browserOp } = await import("./browser.mjs");
        return await browserOp(String(args.op || "read"), args, { profileDir: BROWSER_PROFILE, shotDir: SHOT_DIR });
      }
      case "desktop_control": {
        if (!DESKTOP_ON) return refuse("desktop control is switched off on this node (set HANDS_DESKTOP=1 to enable it)");
        const { desktopOp } = await import("./desktop.mjs");
        return await desktopOp(String(args.op || "screenshot"), args, { shotDir: SHOT_DIR, runShell });
      }

      default: return { ok: false, error: "unknown tool: " + tool };
    }
  } catch (e) {
    return { ok: false, error: `hands ${tool} failed: ` + (e && e.message || e) };
  }
}

// ---- the dial-out loop: one SSE stream in, results POSTed back --------------------------------
const log = (m) => console.log(`[hands:${NODE_NAME}] ${m}`);
let backoffMs = 1000;
const HEARTBEAT_LAPSE_MS = 50000;   // hub beats every 20s; two misses + slack = dead stream

async function postResult(jobId, result) {
  try {
    const r = await fetch(HANDS_URL + "/hands/result", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ node: NODE_NAME, jobId, result }),
    });
    if (!r.ok) log(`result POST for ${jobId} -> HTTP ${r.status}`);
  } catch (e) { log(`result POST for ${jobId} failed: ${e && e.message}`); }
}

async function handleEvent(ev, data) {
  if (ev !== "job") return;   // hb and unknown events only feed the liveness timer
  let job; try { job = JSON.parse(data); } catch { return log("unparseable job event"); }
  const t0 = Date.now();
  const result = await executeJob(job.tool, job.args || {});
  log(`job ${job.id} ${job.tool} -> ${result.ok ? "ok" : (result.refused ? "REFUSED" : "error")} (${Date.now() - t0}ms)`);
  await postResult(job.id, result);
}

async function connectOnce() {
  const ac = new AbortController();
  let lastBeat = Date.now();
  const lapse = setInterval(() => { if (Date.now() - lastBeat > HEARTBEAT_LAPSE_MS) { log("heartbeat lapsed — recycling the stream"); ac.abort(); } }, 5000);
  try {
    const r = await fetch(HANDS_URL + "/hands/stream?node=" + encodeURIComponent(NODE_NAME), {
      headers: authHeaders({ accept: "text/event-stream" }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error("hub refused the stream: HTTP " + r.status);
    log("connected to " + HANDS_URL);
    backoffMs = 1000;   // a good connection resets the backoff
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      lastBeat = Date.now();
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = "message", data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
        }
        handleEvent(ev, data);   // fire-and-forget: jobs run concurrently, results POST independently
      }
    }
    throw new Error("stream ended");
  } finally { clearInterval(lapse); }
}

async function main() {
  if (!HANDS_URL || !HANDS_TOKEN) {
    console.error("[hands] HANDS_URL and HANDS_TOKEN are required. Refusing to start without auth (L-017).");
    process.exit(1);
  }
  if (!ROOTS.length) log("NOTE: no HANDS_ROOTS and HANDS_MAX_ACCESS unset — fs tools will refuse until roots are configured deliberately.");
  log(`starting  ·  access=${MAX_ACCESS ? "MAX (all drives minus carve-outs)" : "scoped"}  ·  roots=${ROOTS.join(", ") || "(none)"}  ·  self-protected dirs=${SELF_PROTECT.length}  ·  platform=${process.platform}`);
  for (;;) {
    try { await connectOnce(); }
    catch (e) { log(`disconnected: ${e && e.message}`); }
    const jitter = Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, backoffMs + jitter));
    backoffMs = Math.min(backoffMs * 2, 30000);   // capped, jittered — never a retry storm
  }
}

// Run only when launched directly (tests import the executor without starting the loop).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
