/*
 * Dominion AI - network transport (multi-machine "hands").
 *
 * The robust replacement for the old Command Deck "bridge" poller. The coordinator reaches every
 * machine the SAME proven way Fred already deploys with: SSH over Tailscale. Each machine is just an
 * OpenSSH target on the tailnet - no poll loop, no localhost poke, no `tailscale serve` mapping, no
 * self-heal task. Those were the fragile parts; they are gone.
 *
 * Design guarantees:
 *   - Nothing here runs until a tool calls it.
 *   - A machine that is asleep/off returns { ok:false, offline:true } - NEVER a throw, never a hang
 *     (ssh BatchMode + ConnectTimeout). "That machine is offline" is an honest result, not a crash.
 *   - The SSH private key path is read from config/env at runtime and is never inlined or logged.
 *   - Windows targets run commands via `powershell -EncodedCommand <base64-utf16le>` so arbitrary
 *     command text survives ssh -> cmd -> powershell with zero quoting hazards. Linux targets run
 *     the command through the login shell directly.
 *
 * The confirm-gate + protected-resource carve-outs in tools.mjs still govern WHAT may run; this
 * module only governs WHERE it runs and how reliably.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = process.env.COORDINATOR_SSH_KEY || join(homedir(), ".ssh", "id_ed25519");

// ---- registry -------------------------------------------------------------------------------
// name -> { host, user, keyPath, os, shell, enabled, notes }. Loaded from machines.json next to
// this file when present (that is where Phase-2 wire-up writes the real laptop entries), else the
// built-in default: just the mini-PC, which Fred already SSHes into today.
const DEFAULTS = {
  "mini-pc": {
    host: "nucbox-k8-plus", user: "Fred", keyPath: DEFAULT_KEY,
    os: "windows", shell: "powershell", enabled: true,
    notes: "GMKtec K8 Plus. Fred's existing deploy target (ssh Fred@nucbox-k8-plus).",
  },
};

let REGISTRY = loadRegistry();
export function loadRegistry() {
  let reg = { ...DEFAULTS };
  try {
    const p = join(HERE, "machines.json");
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const src = j && j.machines ? j.machines : j;
      if (src && typeof src === "object") reg = { ...reg, ...src };
    }
  } catch {}
  // Normalize + fill defaults; never let a bad entry crash the load.
  for (const [name, m] of Object.entries(reg)) {
    reg[name] = {
      host: String(m.host || name), user: String(m.user || "Fred"), keyPath: m.keyPath || DEFAULT_KEY,
      os: (m.os === "linux" ? "linux" : "windows"), shell: m.shell || (m.os === "linux" ? "sh" : "powershell"),
      enabled: m.enabled !== false, notes: String(m.notes || ""),
    };
  }
  REGISTRY = reg;
  return reg;
}

// Public, key-path-free view for the UI / a registry endpoint.
export function listMachines() {
  return Object.entries(REGISTRY).map(([name, m]) => ({ name, host: m.host, os: m.os, enabled: m.enabled, notes: m.notes }));
}
export const getMachine = (name) => REGISTRY[name] || null;

// ---- low-level spawn helper -----------------------------------------------------------------
function spawnCapture(cmd, args, { timeoutMs = 60000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return resolve({ code: -1, stdout: "", stderr: String(e && e.message || e), spawnError: true }); }
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (done) return; done = true; try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ code: -1, stdout, stderr, timedOut: true }), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); finish({ code: -1, stdout, stderr: String(e && e.message || e), spawnError: true }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
    if (input != null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

// ssh exit 255 + these substrings = the box is unreachable (asleep/off/not on the tailnet), which is
// a normal, honest outcome - distinct from a command that ran and failed.
const OFFLINE_RE = /(Connection timed out|Connection refused|Could not resolve|No route to host|Operation timed out|port 22: (?:Connection|Network)|kex_exchange_identification|Host key verification failed)/i;

function sshArgs(m, remoteCommand) {
  return [
    "-i", m.keyPath,
    "-o", "BatchMode=yes",              // never prompt (would hang a server) - fail fast instead
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=accept-new",
    `${m.user}@${m.host}`,
    remoteCommand,
  ];
}

// Wrap a command for the target's shell. Windows -> powershell -EncodedCommand (quoting-proof).
function wrapForShell(m, command) {
  if (m.os === "windows") {
    const b64 = Buffer.from(String(command), "utf16le").toString("base64");
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
  }
  return String(command); // linux: ssh runs it through the login shell
}

// ---- the one call every tool uses -----------------------------------------------------------
// runOnMachine(name, command) -> { ok, offline, machine, code, stdout, stderr, ms, error }
export async function runOnMachine(name, command, { timeoutMs = 60000, raw = false } = {}) {
  const t0 = Date.now();
  const m = getMachine(name);
  if (!m) return { ok: false, machine: name, error: `Unknown machine "${name}". Known: ${Object.keys(REGISTRY).join(", ")}` };
  if (!m.enabled) return { ok: false, machine: name, error: `Machine "${name}" is disabled in the registry.` };
  const remote = raw ? String(command) : wrapForShell(m, command);
  const r = await spawnCapture("ssh", sshArgs(m, remote), { timeoutMs });
  const ms = Date.now() - t0;
  if (r.timedOut) return { ok: false, offline: true, machine: name, ms, error: `${name} did not respond within ${Math.round(timeoutMs / 1000)}s (asleep, off, or off the tailnet).` };
  if (r.code === 255 && OFFLINE_RE.test(r.stderr || "")) return { ok: false, offline: true, machine: name, ms, stderr: r.stderr.trim(), error: `${name} is offline (asleep, off, or not on the tailnet).` };
  if (r.spawnError) return { ok: false, machine: name, ms, error: `Could not launch ssh on the coordinator: ${r.stderr}` };
  return { ok: r.code === 0, machine: name, code: r.code, stdout: (r.stdout || "").replace(/\r\n/g, "\n"), stderr: (r.stderr || "").replace(/\r\n/g, "\n"), ms };
}

// Fast liveness probe - short timeout, cheap command. Returns a compact status for the UI/registry.
export async function reachable(name) {
  const r = await runOnMachine(name, "Write-Output ok", { timeoutMs: 10000 });
  return { name, online: !!r.ok, offline: !!r.offline, ms: r.ms || null, error: r.error || null };
}
export async function reachableAll() {
  const names = Object.entries(REGISTRY).filter(([, m]) => m.enabled).map(([n]) => n);
  return Promise.all(names.map((n) => reachable(n)));
}

// ---- file helpers (base64 round-trip = binary-safe, quoting-safe) ----------------------------
export async function readFileOn(name, path, { maxBytes = 2_000_000 } = {}) {
  const m = getMachine(name);
  if (!m) return { ok: false, error: `Unknown machine "${name}".` };
  const cmd = m.os === "windows"
    ? `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psLit(path)}))`
    : `base64 -w0 ${shLit(path)}`;
  const r = await runOnMachine(name, cmd);
  if (!r.ok) return r;
  try {
    const buf = Buffer.from((r.stdout || "").trim(), "base64");
    if (buf.length > maxBytes) return { ok: false, error: `File is ${buf.length} bytes (> ${maxBytes} cap).` };
    return { ok: true, machine: name, path, bytes: buf.length, text: buf.toString("utf8") };
  } catch (e) { return { ok: false, error: "Could not decode remote file: " + String(e.message || e) }; }
}
export async function writeFileOn(name, path, content) {
  const m = getMachine(name);
  if (!m) return { ok: false, error: `Unknown machine "${name}".` };
  const b64 = Buffer.from(String(content), "utf8").toString("base64");
  const cmd = m.os === "windows"
    ? `[IO.File]::WriteAllBytes(${psLit(path)}, [Convert]::FromBase64String('${b64}'))`
    : `printf %s '${b64}' | base64 -d > ${shLit(path)}`;
  const r = await runOnMachine(name, cmd);
  return r.ok ? { ok: true, machine: name, path, bytes: Buffer.byteLength(String(content)) } : r;
}

// Minimal literal escaping for embedding a path inside the wrapped command.
const psLit = (s) => "'" + String(s).replace(/'/g, "''") + "'";       // PowerShell single-quoted literal
const shLit = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";    // POSIX single-quoted literal

export default { loadRegistry, listMachines, getMachine, runOnMachine, reachable, reachableAll, readFileOn, writeFileOn };
