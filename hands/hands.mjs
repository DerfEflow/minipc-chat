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
import { initSnapshots, beforeMutation, listSnapshots, restoreSnapshot, journal } from "./snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

const HANDS_URL = String(process.env.HANDS_URL || "").replace(/\/$/, "");
const HANDS_TOKEN = process.env.HANDS_TOKEN || "";
const NODE_NAME = (process.env.HANDS_NODE || hostname() || "unnamed").toLowerCase();
const VERSION = "hands/2";   // hands/2: preview_fetch (the Crucible's live-preview relay)
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

// ---- reversibility: nothing mutates this machine without a snapshot first ----------------------
// Fred's standing rule. See hands/snapshot.mjs for exactly what is and is not recoverable: file
// writes are exact, shell commands get a git anchor when they touch a repo, everything is
// journalled. Snapshots live off the node dir by default so a rollback of the node itself does
// not take the snapshots with it.
const SNAP_DIR = String(process.env.HANDS_SNAP_DIR || join(HERE, ".snapshots"));
initSnapshots({ dir: SNAP_DIR });

// Create the parent directory for a file we are about to write, unless it already exists. The
// existsSync guard matters at a drive root: on Windows, mkdir("C:\\") throws EPERM even under
// recursive:true, so calling it unconditionally made a write to any drive root impossible.
function ensureDir(p) {
  const dir = dirname(resolve(String(p || "")));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

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

// ---- cancellation: Stop must cut the legs off, not wait politely ------------------------------
// Every running shell is tracked by job id so a cancel event can reach it. Killing the immediate
// child is not enough on Windows: PowerShell spawns its own children (npm, git, node), and killing
// the parent orphans them. taskkill /T takes the whole tree.
const RUNNING = new Map();   // jobId -> { child, cancelled }
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  } catch { try { child.kill("SIGKILL"); } catch {} }
}

// ---- shell (PowerShell on Windows via -EncodedCommand — the machines.mjs quoting-proof trick) --
function runShell(command, timeoutMs = 60000, jobId = null) {
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
    try { child = spawn(cmd, args, { windowsHide: true, env, detached: !IS_WIN }); }
    catch (e) { return res({ ok: false, error: "could not launch shell: " + (e && e.message) }); }
    const track = jobId ? { child, cancelled: false } : null;
    if (jobId) RUNNING.set(jobId, track);
    let stdout = "", stderr = "", done = false;
    const finish = (r) => {
      if (done) return; done = true;
      if (jobId) RUNNING.delete(jobId);
      killTree(child);
      res(track && track.cancelled ? { ...r, ok: false, cancelled: true, error: "stopped by the user" } : r);
    };
    const cap = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 600000);
    const timer = setTimeout(() => finish({ ok: false, timedOut: true, code: -1, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), ms: Date.now() - t0 }), cap);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: String(e && e.message || e), ms: Date.now() - t0 }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ ok: code === 0, code, stdout: stdout.slice(0, 64000), stderr: stderr.slice(0, 16000), ms: Date.now() - t0 }); });
  });
}

// ---- the executor: one job in, one result out. Exported so tests hit it directly. -------------
export async function executeJob(tool, args = {}, meta = {}) {
  // Carve-outs first, on the raw args blob, for every tool that TOUCHES the machine. The Ollama
  // passthrough (fix C, 2026-07-20) is exempt: its args are model I/O — chat messages and prompts —
  // not filesystem paths. Scanning them would falsely refuse a legitimate question that merely
  // mentions "D:\" or "backups", which is the model talking about a topic, not reaching a path.
  if (!String(tool).startsWith("ollama_")) {
    const guard = assertNotProtected(args);
    if (!guard.ok) return refuse(guard.reason);
  }
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
      case "preview_fetch": {
        /*
         * The live-preview proxy (Crucible iteration 2, ruling 3a): the phone taps through the
         * built app via the cloud relay. This tool reaches ONE address only, the local preview
         * server the build engine launches on 37311. It is not a general proxy: any other port
         * or host is refused, bodies are bounded, and websockets are out of scope by design.
         */
        const port = Number(args.port) || 37311;
        if (port !== 37311) return refuse("preview proxy reaches only the preview port");
        const path = String(args.path || "/");
        if (!path.startsWith("/")) return { ok: false, error: "path must start with /" };
        const method = String(args.method || "GET").toUpperCase();
        if (!["GET", "POST", "HEAD"].includes(method)) return { ok: false, error: "method not supported: " + method };
        const headers = {};
        if (args.contentType) headers["content-type"] = String(args.contentType).slice(0, 200);
        let body;
        if (method === "POST" && args.body) {
          body = Buffer.from(String(args.body), "base64");
          if (body.length > 2_000_000) return { ok: false, error: "request body too large" };
        }
        try {
          const r = await fetch("http://127.0.0.1:" + port + path, { method, headers, body, redirect: "manual" });
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 6_000_000) return { ok: false, error: "response too large for the preview relay (" + buf.length + " bytes)" };
          return { ok: true, status: r.status, contentType: r.headers.get("content-type") || "",
                   location: r.headers.get("location") || "", base64: buf.toString("base64") };
        } catch (e) {
          return { ok: false, error: "preview not answering: " + String((e && e.message) || e).slice(0, 200) };
        }
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
        const snap = beforeMutation("fs_write", args, { node: NODE_NAME });
        ensureDir(args.path);
        writeFileSync(args.path, buf);
        return { ok: true, path: args.path, bytes: buf.length, snapshot: snap.id, snapshotMethod: snap.method };
      }
      case "fs_append": {
        // Chunked transfer: append a base64 chunk to a file. truncate:true starts a fresh file
        // (first chunk), then subsequent calls append. Lets large files (e.g. the ~88MB corpus
        // backup) cross the SSE job channel in bounded pieces instead of one giant frame.
        const w = withinRoots(args.path); if (!w.ok) return refuse(w.reason);
        if (underAny(args.path, SELF_PROTECT)) return refuse("append under a self-protected dir (the live app / this node)");
        const buf = Buffer.from(String(args.content || ""), args.base64 === false ? "utf8" : "base64");
        // Only the FIRST chunk of a chunked transfer is a real mutation of prior state; snapshotting
        // every appended chunk of an 88MB corpus would be absurd and would blow the retention cap.
        const snap = args.truncate ? beforeMutation("fs_append", args, { node: NODE_NAME }) : { id: null, method: "append-chunk" };
        ensureDir(args.path);
        if (args.truncate) writeFileSync(args.path, buf); else appendFileSync(args.path, buf);
        let total = 0; try { total = statSync(args.path).size; } catch {}
        return { ok: true, path: args.path, appended: buf.length, totalBytes: total, snapshot: snap.id, snapshotMethod: snap.method };
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
        // Best-effort anchor before an opaque command. See snapshot.mjs for the honest limits:
        // a repo gets a real rollback point, anything else gets a journal line and nothing more.
        const snap = beforeMutation("shell_run", args, { node: NODE_NAME, jobId: meta.jobId });
        const out = await runShell(cmdText, args.timeoutMs, meta.jobId);
        return { ...out, snapshot: snap.id, snapshotMethod: snap.method, snapshotAnchors: (snap.anchors || []).length || undefined };
      }

      // ---- reversibility surface: inspect and undo what this node changed --------------------
      case "snapshot_list":
        return { ok: true, node: NODE_NAME, snapshots: listSnapshots(args.limit) };
      case "snapshot_restore": {
        if (!args.id) return { ok: false, error: "which snapshot? pass id (get one from snapshot_list)" };
        return restoreSnapshot(String(args.id));
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

      // Streaming self-test hook (not a real capability). Emits N ordered chunks via the emit()
      // sink then returns the concatenation as the terminal result. Lets hands_stream_test drive
      // the whole chunk path deterministically without depending on Ollama being up.
      case "__echo_stream": {
        const n = Math.min(Math.max(Number(args.count) || 3, 1), 50);
        const parts = [];
        for (let i = 0; i < n; i++) {
          const piece = "chunk" + i + " ";
          parts.push(piece);
          if (meta.emit) meta.emit(piece);
          await new Promise((r) => setTimeout(r, 10));
        }
        return { ok: true, text: parts.join(""), chunks: parts.length };
      }

      /*
       * claude_code (2026-07-20): run Claude Code headless in a repo on this machine. This is the
       * capability that lets Command Deck's work orders (and Dominion's own models) reach ONE
       * machine-access channel instead of the parallel bridge. It mirrors the bridge poller's
       * execClaude exactly: a git baseline snapshot BEFORE any change so rollback always exists, the
       * same headless `claude -p` invocation, the same delete-protection restore, and a plain summary.
       * Output streams back (Step 3) so a long agent run keeps the hub deadline alive.
       *
       * Roots + carve-outs still hold: dir must be within an allowed root, and the args blob was
       * already scanned for D:/backups at the top of executeJob.
       */
      case "claude_code": {
        const dir = String(args.dir || args.repo || "");
        if (!dir) return { ok: false, error: "claude_code needs a dir (the repo folder to work in)" };
        const w = withinRoots(dir); if (!w.ok) return refuse(w.reason);
        if (!existsSync(dir)) return { ok: false, error: "not found: " + dir };
        const canDelete = args.canDelete === true;
        const instructions = String(args.instructions || args.title || "").trim();
        if (!instructions) return { ok: false, error: "claude_code needs instructions" };
        return await runClaudeCode({ dir, title: args.title, instructions, canDelete, emit: meta.emit, timeoutMs: args.timeoutMs });
      }

      // ---- fix C (2026-07-20): local Ollama passthrough ----
      // The Railway container binds Ollama to 127.0.0.1 only and has no tailnet, so the cloud app
      // cannot reach the model. This node can reach it trivially. The app dispatches ollama_chat /
      // ollama_embed; we make the local call and (for chat) stream tokens back so a long 30B answer
      // keeps the hub deadline alive. The full assembled response is the terminal result — truth —
      // and the streamed deltas are live text on top.
      case "ollama_chat":
        return await localOllamaChat(args.payload || {}, meta.emit);
      case "ollama_embed":
        return await localOllamaEmbed(args.payload || {});

      default: return { ok: false, error: "unknown tool: " + tool };
    }
  } catch (e) {
    return { ok: false, error: `hands ${tool} failed: ` + (e && e.message || e) };
  }
}

// ---- claude_code: headless Claude Code runner (the single-channel consolidation, 2026-07-20) ----
// Mirrors command-deck/bridge/poller.mjs execClaude so behaviour is identical to the bridge it
// replaces: git baseline first, `claude -p` headless, delete-protection restore, plain summary.
const CLAUDE_CMD = process.env.HANDS_CLAUDE_CMD || "claude";
const CLAUDE_ARGS = String(process.env.HANDS_CLAUDE_ARGS || "--permission-mode acceptEdits").split(/\s+/).filter(Boolean);
const CLAUDE_TIMEOUT_MS = Number(process.env.HANDS_CLAUDE_TIMEOUT_MS || 15 * 60 * 1000);
const NOHOOKS_DIR = join(HERE, ".nohooks");

/*
 * Claude Code auth: the machine's OAuth login was revoked, so headless runs use ANTHROPIC_API_KEY
 * instead, which Fred placed in the wallet (~/.app-secrets.env) on both machines. An API key does
 * not expire the way an interactive OAuth session can, which is the right choice for an always-on
 * agent. We read it from the env first, then the wallet, and inject ONLY that one key into Claude's
 * child env — never the whole wallet. NOTE: this bills work orders against the API key.
 */
function walletValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const txt = readFileSync(join(home, ".app-secrets.env"), "utf8");
    const m = txt.match(new RegExp("^\\s*(?:export\\s+)?" + name + "\\s*=\\s*(.*)$", "m"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* no wallet on this box */ }
  return "";
}

function gitIn(dir, gitArgs, timeoutMs = 30000) {
  return new Promise((res) => {
    // Committer identity MUST match the bridge's ("Command Deck Bridge" / Fred's real email): a
    // fresh git repo has no user.name/email so commits fail without it, AND the existing revert
    // safety gate (poller.mjs revertJob) only rolls back commits authored by that exact name. Same
    // email so Vercel team-deploys are not blocked by an unrecognized author.
    const child = spawn("git", [
      "-c", "safe.directory=*", "-c", "core.hooksPath=" + NOHOOKS_DIR, "-c", "core.fsmonitor=false",
      "-c", "user.email=fredwolfe@gmail.com", "-c", "user.name=Command Deck Bridge",
      ...gitArgs,
    ], { cwd: dir, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "", err = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); res({ code: -1, out, err: String(e && e.message) }); });
    child.on("close", (code) => { clearTimeout(t); res({ code, out, err }); });
  });
}

async function claudeBaseline(dir) {
  try { mkdirSync(NOHOOKS_DIR, { recursive: true }); } catch {}
  const isRepo = (await gitIn(dir, ["rev-parse", "--is-inside-work-tree"])).out.trim() === "true";
  if (!isRepo) {
    await gitIn(dir, ["init"]);
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "--allow-empty", "-m", "hands: baseline snapshot"]);
  } else {
    const dirty = (await gitIn(dir, ["status", "--porcelain"])).out.trim();
    if (dirty) { await gitIn(dir, ["add", "-A"]); await gitIn(dir, ["commit", "-m", "hands: pre-job snapshot"]); }
  }
  return (await gitIn(dir, ["rev-parse", "HEAD"])).out.trim();
}

async function runClaudeCode({ dir, title, instructions, canDelete, emit, timeoutMs }) {
  const baseline = await claudeBaseline(dir);
  const deleteRule = canDelete ? "" :
    "IMPORTANT: This folder is delete-protected. You may create and edit files, but do NOT delete files or remove their contents wholesale.\n";
  const prompt =
    "You are Claude Code running headless on Fred's machine via the Dominion hands node.\n" +
    'Work order: "' + (title || "(untitled)") + '"\n' + deleteRule +
    "If the request is unclear, contradictory, unsafe, or you cannot do it correctly, make NO changes and instead explain the problem in plain language. Do not guess. Do NOT run git or commit; the node handles version control. End with a short, plain-English summary of exactly what you did, or why you couldn't.\n\n" +
    "--- INSTRUCTIONS ---\n" + instructions;

  const cap = Math.min(Math.max(Number(timeoutMs) || CLAUDE_TIMEOUT_MS, 5000), 30 * 60 * 1000);
  const scrubbed = { ...process.env }; delete scrubbed.HANDS_TOKEN; delete scrubbed.HANDS_CF_CLIENT_SECRET;
  // Give Claude Code the API key from the wallet (OAuth on these machines is revoked).
  const apiKey = walletValue("ANTHROPIC_API_KEY");
  if (apiKey) scrubbed.ANTHROPIC_API_KEY = apiKey;
  const useShell = IS_WIN;
  let child;
  try {
    child = useShell
      ? spawn([CLAUDE_CMD, ...CLAUDE_ARGS, "-p"].join(" "), [], { cwd: dir, shell: true, env: scrubbed, windowsHide: true })
      : spawn(CLAUDE_CMD, [...CLAUDE_ARGS, "-p"], { cwd: dir, shell: false, env: scrubbed, windowsHide: true });
  } catch (e) { return { ok: false, error: "could not launch Claude Code: " + (e && e.message) }; }

  let out = "", err = "";
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, cap);
  try { child.stdin.write(prompt); child.stdin.end(); } catch {}
  child.stdout.on("data", (d) => { const s = d.toString(); out += s; if (emit) emit(s); });
  child.stderr.on("data", (d) => (err += d.toString()));
  const code = await new Promise((r) => { child.on("error", (e) => { err += "\n" + e.message; r(-1); }); child.on("close", r); });
  clearTimeout(killer);

  const text = (out + (err ? "\n[stderr]\n" + err : "")).trim();
  const summary = text.split("\n").filter(Boolean).slice(-12).join("\n") || "Done.";
  if (code !== 0) return { ok: false, baseline, error: "Claude Code couldn't finish (exit " + code + "). " + text.slice(0, 240), log: text.slice(-6000) };

  // Delete-protection: restore anything Claude removed under a protected root.
  const restored = [];
  if (!canDelete) {
    const st = await gitIn(dir, ["-c", "core.quotepath=false", "-c", "status.renames=false", "status", "--porcelain", "-z"]);
    const deleted = st.out.split("\0").filter(Boolean).filter((e) => e.slice(0, 2).includes("D")).map((e) => e.slice(3)).filter(Boolean);
    for (const f of deleted) { const co = await gitIn(dir, ["checkout", "--", f]); if (co.code === 0) restored.push(f); }
  }
  // Record the post-work state as a rollback point (the node commits, so revert is always possible).
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "-m", "hands: " + String(title || "work order").slice(0, 60)]);
  const head = (await gitIn(dir, ["rev-parse", "HEAD"])).out.trim();
  return { ok: true, baseline, commit: head, summary, restored, chars: text.length };
}

// ---- local Ollama passthrough (fix C) ---------------------------------------------------------
// The node reaches Ollama on loopback; the cloud app cannot. OLLAMA_LOCAL_URL overrides the default
// only if Ollama is bound somewhere unusual on this box.
const OLLAMA_LOCAL = String(process.env.OLLAMA_LOCAL_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
async function localOllamaChat(payload, emit) {
  // Force stream:true so we can forward tokens (liveness + hub-deadline rearm). The assembled
  // message is returned as the terminal result, identical in shape to a stream:false /api/chat
  // response, so the server's callers (which read message.content / tool_calls / eval_count) are
  // unchanged.
  const body = JSON.stringify({ ...payload, stream: true });
  let res;
  try { res = await fetch(OLLAMA_LOCAL + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body }); }
  catch (e) { return { ok: false, error: "could not reach local Ollama: " + (e && e.message || e) }; }
  if (!res.ok) return { ok: false, error: "ollama /api/chat HTTP " + res.status };
  const dec = new TextDecoder();
  let buf = "", content = "", toolCalls = null, tail = {};
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.message) {
          if (o.message.content) { content += o.message.content; if (emit) emit(o.message.content); }
          if (o.message.tool_calls) toolCalls = o.message.tool_calls;   // arrive complete in a chunk
        }
        if (o.done) tail = o;   // final chunk carries eval_count etc.
      }
    }
  } catch (e) { return { ok: false, error: "ollama stream broke: " + (e && e.message || e) }; }
  const message = { role: "assistant", content };
  if (toolCalls) message.tool_calls = toolCalls;
  return { ok: true, response: { ...tail, message }, chars: content.length };
}
async function localOllamaEmbed(payload) {
  const body = JSON.stringify({ model: payload.model, input: payload.input });
  let res;
  try { res = await fetch(OLLAMA_LOCAL + "/api/embed", { method: "POST", headers: { "content-type": "application/json" }, body }); }
  catch (e) { return { ok: false, error: "could not reach local Ollama: " + (e && e.message || e) }; }
  if (!res.ok) return { ok: false, error: "ollama /api/embed HTTP " + res.status };
  let j; try { j = await res.json(); } catch (e) { return { ok: false, error: "embed parse: " + (e && e.message) }; }
  const vec = (j.embeddings && j.embeddings[0]) || j.embedding || null;
  return { ok: true, embedding: vec, dim: Array.isArray(vec) ? vec.length : 0 };
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

/*
 * Stream a delta back for a long-running or token-producing tool (added 2026-07-20). Fire and
 * forget: a lost chunk must never stall generation, and the terminal /hands/result is what
 * actually settles the job. Chunks are best-effort liveness plus live text; the result is truth.
 */
async function postChunk(jobId, seq, delta) {
  try {
    await fetch(HANDS_URL + "/hands/chunk", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ node: NODE_NAME, jobId, seq, delta }),
    });
  } catch { /* a dropped chunk is not fatal; the final result carries the whole answer */ }
}

async function handleEvent(ev, data) {
  // Stop has to reach the machine. A cancel arrives on the same stream as the job and kills the
  // child process TREE, because killing a PowerShell parent leaves whatever it spawned running.
  // id "*" is the Fire Alarm: kill everything this node is doing, no questions.
  if (ev === "cancel") {
    let c; try { c = JSON.parse(data); } catch { return log("unparseable cancel event"); }
    const ids = c.id === "*" ? [...RUNNING.keys()] : [c.id];
    for (const id of ids) {
      const entry = RUNNING.get(id);
      if (!entry) continue;
      killTree(entry.child);
      entry.cancelled = true;
      log(`job ${id} CANCELLED (${c.reason || "no reason given"})`);
    }
    return;
  }
  if (ev !== "job") return;   // hb and unknown events only feed the liveness timer
  let job; try { job = JSON.parse(data); } catch { return log("unparseable job event"); }
  const t0 = Date.now();
  // When the hub dispatched with streaming on, hand the executor an emit() that POSTs ordered
  // chunks. When it did not, emit is a no-op, so a tool can always call it without checking.
  let seq = 0;
  const emit = job.stream ? (delta) => { postChunk(job.id, seq++, String(delta || "")); } : () => {};
  const result = await executeJob(job.tool, job.args || {}, { jobId: job.id, emit, streaming: !!job.stream });
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
