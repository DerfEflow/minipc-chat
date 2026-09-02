/*
 * Durable game-factory worker protocol for a Dominion Hands node.
 *
 * The Hands request is only a control message. Actual work runs in a detached helper which owns
 * the child process and appends immutable state records under GAME_FACTORY_WORKER_DIR. The Hands
 * node can therefore disconnect or restart without losing the run's identity, status, checkpoint,
 * or bounded logs. A machine reboot is reported as INTERRUPTED; it is never guessed to have
 * succeeded.
 *
 * Security boundaries:
 *   - no shell strings; every step is an executable plus an argv array;
 *   - workspaces/cwds/collected files must remain under an explicitly allowed Hands root;
 *   - a small toolchain allowlist is enforced here and again by the detached runner;
 *   - credential-looking environment variables are stripped before build code starts;
 *   - request identity is immutable and start is idempotent by runId + request hash.
 */
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "gamefactory-runner.mjs");
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const MAX_STEPS = 24;
const MAX_ARGS = 160;
const MAX_ARG_CHARS = 16_000;
const MAX_COLLECT = 100;
const MAX_LOG_BYTES = 5_000_000;
const STARTUP_GRACE_MS = 12_000;
const HEARTBEAT_STALE_MS = 60_000;
const MAX_REQUEST_CHARS = 512_000;

export const GAME_FACTORY_WORKER_PROTOCOL = "game-factory-worker/1";
export const GAME_FACTORY_TERMINAL_STATES = Object.freeze([
  "SUCCEEDED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED",
]);

const DEFAULT_PROGRAMS = Object.freeze([
  "godot", "godot4", "gradle", "java", "node", "xcodebuild",
]);

const clean = (value, max = 500) => String(value == null ? "" : value).trim().slice(0, max);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const SECRET_NAME = /(authorization|cookie|credential|password|passwd|private.?key|recovery.?code|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret|(^|[_-])pat($|[_-]))/i;

export function redactWorkerText(value, max = 20_000) {
  return String(value == null ? "" : value).slice(0, max)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, "[redacted-private-key]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[redacted-token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-access-key]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, "[redacted-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[redacted-token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, "[redacted-token]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/("(?:authorization|cookie|credential|password|passwd|private.?key|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/('(?:authorization|cookie|credential|password|passwd|private.?key|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret)'\s*:\s*)'(?:\\.|[^'\\])*'/gi, "$1'[redacted]'")
    .replace(/\b((?:database|redis|postgres|mysql|mongo(?:db)?|amqp)_?url|connection_?string|aws_access_key_id|aws_secret_access_key|gh_pat|client_?secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(access_?token|api_?key|password|passwd|private_?key|secret|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export function sanitizeWorkerValue(value, depth = 0, key = "") {
  if (SECRET_NAME.test(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactWorkerText(value);
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeWorkerValue(item, depth + 1));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  if (typeof value !== "object") return redactWorkerText(value);
  return Object.fromEntries(Object.entries(value).slice(0, 200)
    .map(([name, item]) => [clean(name, 120), sanitizeWorkerValue(item, depth + 1, name)]));
}

function safeError(value, max = 1200) {
  return redactWorkerText(value && value.message !== undefined ? value.message : value, max).trim();
}

function exactIdentifier(value, name, max = 240, { optional = false } = {}) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw && optional) return "";
  const normalized = clean(value, max);
  if (!normalized) throw new Error(`${name} is required`);
  if (raw !== normalized) throw new Error(`${name} exceeds the worker protocol limit`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} contains control characters`);
  if (redactWorkerText(normalized, Math.max(normalized.length, 1)) !== normalized) throw new Error(`${name} contains credential material`);
  return normalized;
}

function writeDurableNew(path, value, mode = 0o600) {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // POSIX needs the parent directory entry flushed as well. Windows may refuse directory handles,
  // so this is a best-effort supplement to the fully-synchronous file write.
  try {
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {}
}

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
function withFileLock(dir, name, fn, { waitMs = 5_000, staleMs = 30_000 } = {}) {
  const lockPath = join(dir, name);
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  while (true) {
    try {
      writeDurableNew(lockPath, json({ token, pid: process.pid, createdAt: new Date().toISOString() }));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = parseJsonFile(lockPath);
        const age = Date.now() - statSync(lockPath).mtimeMs;
        stale = age > staleMs && (!owner?.pid || !processAlive(owner.pid));
      } catch { stale = true; }
      if (stale) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        const busy = new Error("worker journal is busy");
        busy.code = "WORKER_LOCK_BUSY";
        throw busy;
      }
      Atomics.wait(LOCK_WAIT, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (parseJsonFile(lockPath)?.token === token) unlinkSync(lockPath);
    } catch {}
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function workerRequestHash(value) {
  const copy = { ...(value || {}) };
  delete copy.createdAt;
  delete copy.requestHash;
  return sha256(JSON.stringify(stable(copy)));
}

function programName(value) {
  let name = basename(clean(value, 1000)).toLowerCase();
  name = name.replace(/\.(exe|com)$/i, "");
  return name;
}

function safeRunDir(stateDir, runId) {
  return join(stateDir, "run-" + sha256(String(runId)).slice(0, 32));
}

function isUnder(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function existingRealpath(path) {
  try { return realpathSync(path); } catch { return ""; }
}

function mountPath(value) {
  return String(value || "").replace(/\\(040|011|012|134)/g, (_, code) => ({
    "040": " ", "011": "\t", "012": "\n", "134": "\\",
  })[code]);
}

function mountTargets() {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => mountPath(line.split(" ")[4])).filter(Boolean);
  } catch { return []; }
}

export function workerPathIdentity(path) {
  const metadata = statSync(path, { bigint: true });
  if (!metadata.isDirectory()) throw new Error("worker path identity requires a directory");
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

function samePathIdentity(left, right) {
  return !!left && !!right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

export function assertWorkerPathBoundary(path, { maxEntries = 200_000 } = {}) {
  const root = existingRealpath(path);
  if (!root || !statSync(root).isDirectory()) throw new Error("worker boundary path must be an existing directory");
  if (IS_LINUX) {
    const nested = mountTargets().find((target) => target !== root && isUnder(target, root));
    if (nested) throw new Error(`worker boundary contains a descendant mount: ${nested}`);
  }
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > maxEntries) throw new Error("worker boundary exceeds the safe filesystem-entry scan limit");
      const child = join(dir, entry.name);
      const metadata = lstatSync(child);
      if (metadata.isSocket() || metadata.isFIFO() || metadata.isBlockDevice() || metadata.isCharacterDevice()) {
        throw new Error(`worker boundary contains a forbidden special filesystem node: ${child}`);
      }
      if (metadata.isDirectory()) stack.push(child);
    }
  }
  return { root, identity: workerPathIdentity(root), entries: seen };
}

function pathOnReadOnlyMount(path) {
  try {
    const mounts = readFileSync("/proc/self/mountinfo", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
      const fields = line.split(" ");
      return { target: mountPath(fields[4]), options: new Set(String(fields[5] || "").split(",")) };
    }).filter((mount) => mount.target && isUnder(path, mount.target))
      .sort((left, right) => right.target.length - left.target.length);
    return mounts[0]?.options.has("ro") === true;
  } catch { return false; }
}

function nearestExistingRealpath(path) {
  let cursor = resolve(path);
  while (true) {
    const real = existingRealpath(cursor);
    if (real) return real;
    const parent = dirname(cursor);
    if (parent === cursor) return "";
    cursor = parent;
  }
}

function stateFiles(runDir) {
  try {
    return readdirSync(runDir).filter((name) => /^state-\d{8}-[a-f0-9-]+\.json$/i.test(name));
  } catch { return []; }
}

function parseJsonFile(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readRunRequest(runDir) {
  return parseJsonFile(join(runDir, "request.json"));
}

export function readRunState(runDir) {
  let best = null;
  for (const name of stateFiles(runDir)) {
    const state = parseJsonFile(join(runDir, name));
    if (!state || !Number.isInteger(state.revision)) continue;
    if (!best || state.revision > best.revision ||
        (state.revision === best.revision && String(state.updatedAt) > String(best.updatedAt))) best = state;
  }
  return best;
}

export function appendRunState(runDir, patch = {}) {
  return withFileLock(runDir, ".state.lock", () => {
    const prior = readRunState(runDir);
    const revision = (Number(prior && prior.revision) || 0) + 1;
    const next = sanitizeWorkerValue({
      ...(prior || {}), ...patch, revision,
      updatedAt: new Date().toISOString(),
    });
    const file = `state-${String(revision).padStart(8, "0")}-${randomUUID()}.json`;
    writeDurableNew(join(runDir, file), json(next));
    return next;
  });
}

export function readCancelRequest(runDir) {
  let best = null;
  try {
    for (const name of readdirSync(runDir).filter((n) => /^cancel-.*\.json$/i.test(n))) {
      const item = parseJsonFile(join(runDir, name));
      if (item && (!best || String(item.requestedAt) > String(best.requestedAt))) best = item;
    }
  } catch {}
  return best;
}

function writeCancelRequest(runDir, mode, reason) {
  const item = {
    mode, reason: redactWorkerText(reason, 1000).trim() || (mode === "immediate" ? "stop requested" : "pause requested"),
    requestedAt: new Date().toISOString(),
  };
  writeDurableNew(join(runDir, `cancel-${Date.now()}-${randomUUID()}.json`), json(item));
  return item;
}

export function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

export function killWorkerTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try {
    if (IS_WIN) {
      const killed = spawnSync("taskkill", ["/PID", String(n), "/T", "/F"], {
        windowsHide: true, stdio: "ignore", timeout: 10_000,
      });
      return killed.status === 0 || !processAlive(n);
    } else {
      try { process.kill(-n, "SIGKILL"); } catch { process.kill(n, "SIGKILL"); }
    }
    return true;
  } catch { return false; }
}

function killRecordedRun(state) {
  const targets = [...new Set([Number(state?.childPid), Number(state?.runnerPid)].filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!targets.length) return false;
  let confirmed = true;
  // The detached step owns its own POSIX process group, so terminate it before the runner group.
  for (const pid of targets) if (processAlive(pid) && !killWorkerTree(pid)) confirmed = false;
  return confirmed;
}

export function sanitizeWorkerEnvironment(source = process.env, { homeDir = "" } = {}) {
  const out = {};
  // This is deliberately an allowlist. A blacklist missed common secret containers such as
  // DATABASE_URL, AWS_ACCESS_KEY_ID and vendor-specific short names (for example GH_PAT).
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|TZ|XDG_DATA_HOME|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|JAVA_HOME|JDK_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|DEVELOPER_DIR|SDKROOT)$/i;
  for (const [key, value] of Object.entries(source || {})) {
    if (allowed.test(key) && typeof value === "string") out[key] = value;
  }
  if (homeDir) {
    const isolated = resolve(homeDir);
    out.HOME = isolated;
    out.USERPROFILE = isolated;
    out.APPDATA = join(isolated, "appdata");
    out.LOCALAPPDATA = join(isolated, "localappdata");
    out.XDG_CONFIG_HOME = join(isolated, "config");
    out.XDG_CACHE_HOME = join(isolated, "cache");
    out.GRADLE_USER_HOME = join(isolated, "gradle");
    out.ANDROID_USER_HOME = join(isolated, "android");
  }
  out.CI = "1";
  out.GAME_FACTORY_WORKER = "1";
  return out;
}

const FD_LAUNCHER_PATH = "/opt/dominion-sandbox/fd-launcher";
const NODE_FILTER_PATH = "/opt/dominion-sandbox/node-seccomp.bpf";
const GODOT_FILTER_PATH = "/opt/dominion-sandbox/godot-seccomp.bpf";
const APPARMOR_COMPONENTS = Object.freeze({
  launcher: Object.freeze(["dominion-gx10-gamefactory-executor", "dominion-gx10-fd-launcher"]),
  node: Object.freeze(["dominion-gx10-gamefactory-executor", "dominion-gx10-fd-launcher", "dominion-gx10-payload-node"]),
  godot: Object.freeze(["dominion-gx10-gamefactory-executor", "dominion-gx10-fd-launcher", "dominion-gx10-payload-godot"]),
});

function exactImmutableArtifact(path, expectedPath, expectedSha256, expectedMode) {
  const digest = String(expectedSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`immutable artifact ${expectedPath} lacks a pinned SHA-256`);
  const real = existingRealpath(path);
  const metadata = real ? statSync(real) : null;
  if (real !== expectedPath || !metadata?.isFile() || metadata.uid !== 0 || metadata.gid !== 0
      || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== expectedMode || !pathOnReadOnlyMount(real)) {
    throw new Error(`immutable artifact ${expectedPath} has an invalid path, owner, mode, link count, or mount`);
  }
  const actual = createHash("sha256").update(readFileSync(real)).digest("hex");
  if (actual !== digest) throw new Error(`immutable artifact ${expectedPath} differs from its pinned SHA-256`);
  return { path: real, sha256: actual };
}

function appArmorComponentSet(value) {
  const label = String(value || "").trim();
  if (!label.endsWith(" (enforce)")) return null;
  const components = label.slice(0, -10).split("//&").filter(Boolean).sort();
  return components.length === new Set(components).size ? components : null;
}

export function buildWorkerSandboxCommand(step, {
  program = "", workspaceRoot = "", runtimeHome = "", environment = {},
  workspaceFd = -1, runtimeFd = -1, cwdFd = -1, nodeSeccompFd = -1, godotSeccompFd = -1,
} = {}) {
  if (!IS_LINUX) throw new Error("fd-launcher worker isolation is available only on Linux");
  const launcher = existingRealpath(program);
  if (launcher !== FD_LAUNCHER_PATH) throw new Error("configured worker sandbox is not the exact immutable fd-launcher");
  const workspace = existingRealpath(workspaceRoot), runtime = existingRealpath(runtimeHome);
  if (!workspace || !runtime) throw new Error("launcher workspace and fixed runtime must already exist");
  if (isUnder(workspace, runtime) || isUnder(runtime, workspace)) throw new Error("launcher workspace and runtime must not overlap");
  const cwd = existingRealpath(step?.cwd);
  if (!cwd || !isUnder(cwd, workspace)) throw new Error("launcher cwd is outside the exact workspace");
  const programId = programName(step?.program);
  if (!['node', 'godot'].includes(programId)) throw new Error("launcher payload program is not node or godot");
  const descriptorNumbers = [workspaceFd, runtimeFd, cwdFd, nodeSeccompFd, godotSeccompFd];
  if (descriptorNumbers.some((fd) => !Number.isInteger(fd) || fd < 3)
      || new Set(descriptorNumbers).size !== descriptorNumbers.length) {
    throw new Error("launcher requires five distinct inherited directory/filter descriptors");
  }
  const relativeCwd = relative(workspace, cwd).split(sep).join("/") || ".";
  if (relativeCwd === ".." || relativeCwd.startsWith("../") || isAbsolute(relativeCwd)) throw new Error("launcher relative cwd escaped its workspace");
  return {
    program: launcher,
    args: [
      "--program", programId,
      "--workspace-fd", String(workspaceFd),
      "--runtime-fd", String(runtimeFd),
      "--cwd-fd", String(cwdFd),
      "--node-seccomp-fd", String(nodeSeccompFd),
      "--godot-seccomp-fd", String(godotSeccompFd),
      "--cwd-relative", relativeCwd,
      "--", ...(step?.args || []).map(String),
    ],
    env: sanitizeWorkerEnvironment(environment),
  };
}

export async function probeWorkerSandbox({
  program = "", sha256 = "", protectedRoots = [], workspaceRoot = "", runtimeHome = "",
  nodeSeccompPath = "", nodeSeccompSha256 = "", godotSeccompPath = "", godotSeccompSha256 = "",
} = {}) {
  if (!program) return { ok: false, configured: false, error: "worker fd-launcher is not configured" };
  if (!IS_LINUX) return { ok: false, configured: true, error: "fd-launcher worker isolation is available only on Linux" };
  const probeArtifacts = [];
  try {
    const launcher = exactImmutableArtifact(program, FD_LAUNCHER_PATH, sha256, 0o555);
    const nodeFilter = exactImmutableArtifact(nodeSeccompPath, NODE_FILTER_PATH, nodeSeccompSha256, 0o444);
    const godotFilter = exactImmutableArtifact(godotSeccompPath, GODOT_FILTER_PATH, godotSeccompSha256, 0o444);
    if ((protectedRoots || []).map(existingRealpath).filter(Boolean).some((root) => isUnder(launcher.path, root))) {
      throw new Error("fd-launcher resolves inside a protected worker root");
    }
    const workspace = existingRealpath(workspaceRoot), runtime = existingRealpath(runtimeHome);
    if (!workspace || !runtime || isUnder(workspace, runtime) || isUnder(runtime, workspace)) {
      throw new Error("sandbox probe requires exact non-overlapping workspace and runtime roots");
    }
    const probeNonce = randomUUID().replace(/-/g, "");
    const probePrefix = `.dominion-probe-${probeNonce}`;
    const peerFile = `${probePrefix}-peers`;
    const nodeWorkspaceFile = `${probePrefix}-node-workspace`;
    const nodeRuntimeFile = `${probePrefix}-node-runtime`;
    const nodeReadyFile = `${probePrefix}-node-ready`;
    const godotWorkspaceFile = `${probePrefix}-godot-workspace`;
    const godotRuntimeFile = `${probePrefix}-godot-runtime`;
    const godotReadyFile = `${probePrefix}-godot-ready`;
    probeArtifacts.push(
      join(workspace, peerFile), join(workspace, nodeWorkspaceFile), join(workspace, godotWorkspaceFile),
      join(runtime, nodeRuntimeFile), join(runtime, nodeReadyFile), join(runtime, godotRuntimeFile), join(runtime, godotReadyFile),
    );
    const peerPids = readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid).map(Number);
    if (!peerPids.includes(1)) throw new Error("sandbox probe could not capture the container init peer");
    writeFileSync(join(workspace, peerFile), JSON.stringify(peerPids) + "\n", { mode: 0o600, flag: "wx" });
    const nodeCode = [
      `const fs=require("node:fs"),net=require("node:net"),{Worker}=require("node:worker_threads");`,
      `for(const path of ["/commands","/replies","/app","/proc/self/status","/proc/self/attr/current","/proc/self/maps"]){try{fs.openSync(path,"r");process.exit(65)}catch(error){if(!["EACCES","EPERM"].includes(error.code))process.exit(66)}}`,
      `const expectedEnv=["CI","GAME_FACTORY_WORKER","HOME","LANG","LC_ALL","PATH","TEMP","TMP","TMPDIR","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME"].sort();if(JSON.stringify(Object.keys(process.env).sort())!==JSON.stringify(expectedEnv))process.exit(64);`,
      `const peers=JSON.parse(fs.readFileSync(${JSON.stringify(peerFile)},"utf8"));if(!peers.includes(process.ppid)||!peers.includes(1))process.exit(69);for(const pid of peers){for(const suffix of ["environ","cmdline","root","cwd","fd","mem","maps"]){try{fs.openSync("/proc/"+pid+"/"+suffix,"r");process.exit(70)}catch(error){if(pid===process.ppid&&!["EACCES","EPERM"].includes(error.code))process.exit(71)}}}try{process.kill(process.ppid,0);process.exit(72)}catch(error){if(error.code!=="EPERM")process.exit(73)}`,
      `fs.writeFileSync(${JSON.stringify(nodeWorkspaceFile)},"workspace-write-ok\\n");fs.writeFileSync(${JSON.stringify(`/runtime/payload/${nodeRuntimeFile}`)},"runtime-write-ok\\n");fs.writeFileSync(${JSON.stringify(`/runtime/payload/${nodeReadyFile}`)},"ready\\n");`,
      `const done=()=>setTimeout(()=>{process.stdout.write(JSON.stringify({ok:true})+"\\n");process.exit(0)},500);const network=()=>{try{const socket=net.createConnection({host:"198.51.100.1",port:9});socket.once("connect",()=>process.exit(67));socket.once("error",done);setTimeout(()=>process.exit(68),1000)}catch{done()}};const thread=new Worker('require("node:worker_threads").parentPort.postMessage("ok")',{eval:true});thread.once("message",network);thread.once("error",()=>process.exit(74));`,
    ].join("");
    const run = async (step, expectedComponents, lifecycleSignal = "") => {
      const fds = []; let child;
      try {
        fds.push(openSync(workspace, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)));
        fds.push(openSync(runtime, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)));
        fds.push(openSync(workspace, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)));
        fds.push(openSync(nodeFilter.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)));
        fds.push(openSync(godotFilter.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)));
        const launch = buildWorkerSandboxCommand(step, { program: launcher.path, workspaceRoot: workspace,
          runtimeHome: runtime, environment: process.env, workspaceFd: 3, runtimeFd: 4, cwdFd: 5,
          nodeSeccompFd: 6, godotSeccompFd: 7 });
        child = spawn(launch.program, launch.args, { cwd: workspace, env: launch.env, detached: false,
          stdio: ["ignore", "pipe", "pipe", ...fds] });
      } finally { for (const fd of fds) try { closeSync(fd); } catch {} }
      let stdout = "", stderr = "", exited = null, starttime = "", observations = 0, spawnError = null;
      let firstObservedAt = 0, lastObservedAt = 0, measurementError = null, result = null;
      child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16_000); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
      child.on("error", (error) => { spawnError = error; });
      const exit = new Promise((done) => child.once("close", (status, signal) => { exited = { status, signal }; done(exited); }));
      const boundedExit = (milliseconds) => Promise.race([
        exit, new Promise((done) => setTimeout(() => done(null), milliseconds)),
      ]);
      try {
      const expected = [...expectedComponents].sort(); const deadline = Date.now() + 30_000;
      while (!exited && Date.now() < deadline) {
        try {
          const label = readFileSync(`/proc/${child.pid}/attr/current`, "utf8");
          const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
          const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
          const current = appArmorComponentSet(label), currentStart = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
          const filters = /^Seccomp_filters:\s*(\d+)$/m.exec(status);
          if (JSON.stringify(current) === JSON.stringify(expected)) {
            if (!currentStart || (starttime && starttime !== currentStart)) throw new Error("payload PID starttime changed during readiness measurement");
            starttime ||= currentStart;
            const observedAt = Date.now();
            firstObservedAt ||= observedAt; lastObservedAt = observedAt; observations++;
            if (!/^NoNewPrivs:\s*1$/m.test(status) || !/^Seccomp:\s*2$/m.test(status) || !filters || Number(filters[1]) < 2) {
              throw new Error("payload did not retain NNP plus both outer and raw seccomp filters");
            }
            for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
              if (!new RegExp(`^${field}:\\s*0+\\s*$`, "mi").test(status)) throw new Error("payload retained Linux capabilities");
            }
            if (lifecycleSignal && !lifecycleSignal.startsWith("sent:") && observations >= 2
                && lastObservedAt - firstObservedAt >= 200) {
              child.kill(lifecycleSignal); lifecycleSignal = `sent:${lifecycleSignal}`;
            }
          }
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
        }
        await new Promise((done) => setTimeout(done, 10));
      }
      if (!exited) throw new Error("long-running payload readiness canary exceeded its 30 second deadline");
      await exit;
      if (spawnError) throw spawnError;
      if (observations < 2 || !starttime || lastObservedAt - firstObservedAt < 200) {
        throw new Error("scheduler never measured a stable long-running payload AppArmor/PID/seccomp identity");
      }
      if (lifecycleSignal.startsWith("sent:") && exited.signal !== lifecycleSignal.slice(5)) {
        throw new Error("scheduler lifecycle signal did not terminate and reap the payload as measured");
      }
      result = { status: exited.status, signal: exited.signal, stdout, stderr, observed: true };
      } catch (error) {
        measurementError = error;
      } finally {
        if (!exited && child?.pid) {
          try { killWorkerTree(child.pid); } catch {}
          await boundedExit(2_000);
        }
        if (!exited && child?.pid) {
          try { child.kill("SIGKILL"); } catch {}
          await boundedExit(2_000);
        }
        if (!exited && !measurementError) measurementError = new Error("payload readiness process could not be reaped");
      }
      if (measurementError) throw measurementError;
      return result;
    };
    const expectedNode = [...APPARMOR_COMPONENTS.node].sort();
    const node = await run({ program: "node", cwd: workspace, args: ["-e", nodeCode] }, expectedNode);
    if (node.status !== 0) throw new Error(`Node payload isolation canary failed${safeError(node.stderr || node.error, 400) ? `: ${safeError(node.stderr || node.error, 400)}` : ` with exit ${node.status}`}`);
    const parsedNode = JSON.parse(String(node.stdout || "").trim());
    if (!parsedNode.ok || !node.observed || readFileSync(join(runtime, nodeReadyFile), "utf8").trim() !== "ready") {
      throw new Error("Node payload canary did not complete after external identity measurement");
    }
    const nodeLifecycle = await run({ program: "node", cwd: workspace,
      args: ["-e", "setInterval(()=>{},1000)"] }, expectedNode, "SIGTERM");
    if (nodeLifecycle.signal !== "SIGTERM") throw new Error("Node payload TERM lifecycle canary failed");
    const expectedGodot = [...APPARMOR_COMPONENTS.godot].sort();
    const godot = await run({ program: "godot", cwd: workspace,
      args: ["--headless", "--script", "/opt/dominion-canary/godot-profile-probe.gd", "--", probeNonce] }, expectedGodot);
    if (godot.status !== 0) throw new Error(`Godot payload isolation canary failed${safeError(godot.stderr || godot.error, 400) ? `: ${safeError(godot.stderr || godot.error, 400)}` : ` with exit ${godot.status}`}`);
    if (!godot.observed || readFileSync(join(runtime, godotReadyFile), "utf8").trim() !== "ready") throw new Error("Godot payload canary did not complete after external identity measurement");
    const godotLifecycle = await run({ program: "godot", cwd: workspace,
      args: ["--headless", "--script", "/opt/dominion-canary/godot-profile-probe.gd", "--", probeNonce] }, expectedGodot, "SIGKILL");
    if (godotLifecycle.signal !== "SIGKILL") throw new Error("Godot payload KILL lifecycle canary failed");
    return { ok: true, configured: true, kind: "fd-launcher", version: "dominion-fd-launcher/1",
      program: launcher.path, sha256: launcher.sha256,
      appArmorComponents: Object.fromEntries(Object.entries(APPARMOR_COMPONENTS).map(([key, value]) => [key, [...value].sort()])),
      seccomp: { node: nodeFilter, godot: godotFilter } };
  } catch (error) {
    return { ok: false, configured: true, error: safeError(error, 1200) || "fd-launcher isolation probe failed" };
  } finally {
    for (const path of probeArtifacts) try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function credentialLikeArgument(value) {
  const text = String(value || "");
  return redactWorkerText(text, Math.max(text.length, 1)) !== text
    || /\[redacted(?:-[^\]]+)?\]/i.test(text)
    || /-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(text)
    || /\bBearer\s+\S+/i.test(text)
    || /(?:^|[?&])(?:access_?token|api_?key|key|password|secret|signature)=/i.test(text)
    || /^(?:--?)(?:access-?token|api-?key|password|passwd|private-?key|secret|signature|credential|auth)(?:=|$)/i.test(text)
    || /(?:^|[._-])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|storepassword|keypassword)(?:[._-][a-z0-9]+)*\s*[:=]/i.test(text)
    || /\b(?:database_url|connection_string|aws_access_key_id|aws_secret_access_key|gh_pat)\s*[:=]/i.test(text)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i.test(text);
}

function trustedProgram(program, normalizedProgram, workspace) {
  const real = existingRealpath(program);
  if (IS_LINUX && normalizedProgram === "node") {
    const node = existingRealpath("/opt/dominion-payload/node");
    if (!node || isUnder(node, workspace)) throw new Error("allowed payload Node binary is unavailable or resolves inside the workspace");
    if ((/[\\/]/.test(program) || isAbsolute(program)) && real !== node) throw new Error("absolute Node path does not match the immutable payload binary");
    return node;
  }
  if (normalizedProgram === "node" && real && real === existingRealpath(process.execPath)) return real;
  if (normalizedProgram === "node" && !/[\\/]/.test(program) && !isAbsolute(program)) return existingRealpath(process.execPath) || process.execPath;
  if (IS_LINUX && normalizedProgram === "godot") {
    const godot = existingRealpath("/opt/dominion-payload/godot");
    if (!godot || isUnder(godot, workspace)) throw new Error("allowed Godot binary is unavailable or resolves inside the workspace");
    if ((/[\\/]/.test(program) || isAbsolute(program)) && real !== godot) throw new Error("absolute Godot path does not match the immutable executor binary");
    return godot;
  }
  const qualified = /[\\/]/.test(program) || isAbsolute(program);
  const finder = IS_WIN ? "where.exe" : "which";
  const found = spawnSync(finder, [normalizedProgram], {
    encoding: "utf8", timeout: 3_000, windowsHide: true,
    env: sanitizeWorkerEnvironment(process.env),
  });
  const candidates = String(found.stdout || "").split(/\r?\n/).map((item) => existingRealpath(item.trim())).filter(Boolean);
  const resolvedProgram = qualified ? candidates.find((candidate) => candidate === real) || "" : candidates[0] || "";
  if (qualified && !resolvedProgram) throw new Error("absolute executable path does not match the worker's trusted PATH resolution");
  if (!resolvedProgram) throw new Error(`allowed program ${normalizedProgram} is not available on the worker PATH`);
  if (isUnder(resolvedProgram, workspace)) throw new Error(`allowed program ${normalizedProgram} resolves inside the executable workspace`);
  return resolvedProgram;
}

function validateNodeStep(step, workspace, allowedPrograms, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`step ${index + 1} must be an object`);
  const rawProgram = String(step.program == null ? "" : step.program).trim();
  const program = clean(step.program, 1000);
  if (rawProgram !== program) throw new Error(`step ${index + 1} executable path exceeds the worker limit`);
  const normalizedProgram = programName(program);
  if (!program || !allowedPrograms.includes(normalizedProgram)) {
    throw new Error(`step ${index + 1} program is not allowed on this worker`);
  }
  if (redactWorkerText(program, 1000).trim() !== program) throw new Error(`step ${index + 1} executable path contains credential material`);
  const args = Array.isArray(step.args) ? step.args.map((arg) => String(arg)) : [];
  if (args.length > MAX_ARGS || args.some((arg) => arg.length > MAX_ARG_CHARS || arg.includes("\0"))) {
    throw new Error(`step ${index + 1} arguments exceed the worker limit`);
  }
  if (args.some(credentialLikeArgument)) throw new Error(`step ${index + 1} contains credential material; use a platform secret binding instead`);
  if (args.some((arg) => arg.startsWith("@"))) throw new Error(`step ${index + 1} uses a forbidden response-file argument`);
  const rawCwd = String(step.cwd || workspace).trim();
  const cwdInput = clean(step.cwd || workspace, 2000);
  if (rawCwd !== cwdInput) throw new Error(`step ${index + 1} cwd exceeds the worker limit`);
  if (redactWorkerText(cwdInput, 2000).trim() !== cwdInput) throw new Error(`step ${index + 1} cwd contains credential material`);
  const cwd = existingRealpath(isAbsolute(cwdInput) ? cwdInput : resolve(workspace, cwdInput));
  if (!cwd || !isUnder(cwd, workspace)) throw new Error(`step ${index + 1} cwd is outside the workspace`);
  for (const arg of args) {
    const candidate = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    const pathCandidates = [candidate, ...(IS_WIN ? candidate.split(";") : candidate.split(":"))];
    for (const pathCandidate of pathCandidates) {
      const resolvedCandidate = isAbsolute(pathCandidate) ? resolve(pathCandidate) : resolve(cwd, pathCandidate);
      if (isAbsolute(pathCandidate) && !isUnder(resolvedCandidate, workspace)) {
        throw new Error(`step ${index + 1} argument contains an absolute path outside the workspace`);
      }
      if (pathCandidate.split(/[\\/]/).includes("..") && !isUnder(resolvedCandidate, workspace)) {
        throw new Error(`step ${index + 1} argument escapes the workspace`);
      }
      const realCandidate = nearestExistingRealpath(resolvedCandidate);
      if (realCandidate && !isUnder(realCandidate, workspace)) {
        throw new Error(`step ${index + 1} argument resolves through a link outside the workspace`);
      }
    }
  }

  // Node is useful for deterministic project scripts and tests, but inline evaluation/loader
  // injection would turn this narrow argv protocol back into a shell. Script paths stay in-root.
  if (normalizedProgram === "node") {
    const scriptIndex = args.findIndex((arg) => !arg.startsWith("-"));
    const runtimeArgs = scriptIndex < 0 ? args : args.slice(0, scriptIndex);
    const safeRuntimeFlag = /^(?:--|-c|--check|--test|--test-only|--watch|--no-warnings|--trace-warnings|--enable-source-maps|--version|--test-concurrency=\d+|--test-name-pattern=.{1,500}|--test-shard=\d+\/\d+|--unhandled-rejections=(?:strict|throw|warn|none)|--stack-trace-limit=\d+)$/;
    if (runtimeArgs.some((arg) => !safeRuntimeFlag.test(arg))) {
      throw new Error(`step ${index + 1} uses a forbidden Node execution flag`);
    }
    const scriptArg = scriptIndex < 0 ? "" : args[scriptIndex];
    if (scriptArg) {
      const script = existingRealpath(isAbsolute(scriptArg) ? scriptArg : resolve(cwd, scriptArg));
      if (!script || !isUnder(script, workspace)) throw new Error(`step ${index + 1} script is outside the workspace`);
    }
  }
  if (normalizedProgram === "java" && args.some((arg) => /^(?:-javaagent:|-agentpath:|-agentlib:|-Xrun|-Xbootclasspath(?::|\/a:|\/p:)|--upgrade-module-path(?:=|$)|--patch-module(?:=|$))/i.test(arg))) {
    throw new Error(`step ${index + 1} uses a forbidden Java agent or boot-module flag`);
  }
  if (normalizedProgram === "gradle" && args.some((arg) => /^(?:-I(?:=|[^-])|--init-script(?:=|$)|-(?:p|b|c|g).+)/i.test(arg))) {
    throw new Error(`step ${index + 1} uses a forbidden Gradle init-script or compact path flag`);
  }
  const timeoutMs = Math.min(Math.max(Number(step.timeoutMs) || 10 * 60_000, 1_000), 30 * 60_000);
  return {
    label: redactWorkerText(step.label, 160).trim() || `step ${index + 1}`,
    program: trustedProgram(program, normalizedProgram, workspace), programName: normalizedProgram, args, cwd,
    cwdIdentity: workerPathIdentity(cwd), timeoutMs,
  };
}

export function normalizeWorkerRequest(input, { roots = [], pathGuard = null, allowedPrograms = DEFAULT_PROGRAMS } = {}) {
  const runId = exactIdentifier(input && input.runId, "runId", 240);
  const taskId = exactIdentifier(input && input.taskId, "taskId", 240);
  const projectId = exactIdentifier(input && input.projectId, "projectId", 240);
  const buildId = exactIdentifier(input && input.buildId, "buildId", 240, { optional: true });
  const capability = exactIdentifier(input && input.capability, "capability", 100);
  const attempt = input?.attempt == null ? 1 : Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1_000_000_000) throw new Error("attempt must be a positive protocol integer");

  const rawWorkspace = String(input.workspaceRoot == null ? "" : input.workspaceRoot).trim();
  const workspaceInput = clean(input.workspaceRoot, 2000);
  if (rawWorkspace !== workspaceInput) throw new Error("workspaceRoot exceeds the worker protocol limit");
  if (redactWorkerText(workspaceInput, 2000).trim() !== workspaceInput) throw new Error("workspaceRoot contains credential material");
  const workspace = existingRealpath(workspaceInput);
  if (!workspace || !statSync(workspace).isDirectory()) throw new Error("workspaceRoot must be an existing directory");
  const dynamicRoots = typeof roots === "function" ? roots() : roots;
  const realRoots = (Array.isArray(dynamicRoots) ? dynamicRoots : []).map(existingRealpath).filter(Boolean);
  const rootAllowed = realRoots.some((root) => isUnder(workspace, root));
  if (!rootAllowed) throw new Error("workspaceRoot is outside the worker's configured roots");
  if (typeof pathGuard === "function") {
    const guard = pathGuard(workspace);
    if (!guard || guard.ok === false) throw new Error(safeError(guard && (guard.reason || guard.error), 1000) || "workspaceRoot was refused by the Hands policy");
  }

  const programs = [...new Set((Array.isArray(allowedPrograms) ? allowedPrograms : DEFAULT_PROGRAMS).map(programName).filter(Boolean))];
  const plan = input.plan && typeof input.plan === "object" ? input.plan : {};
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!rawSteps.length || rawSteps.length > MAX_STEPS) throw new Error(`plan.steps must contain 1-${MAX_STEPS} steps`);
  const steps = rawSteps.map((step, index) => validateNodeStep(step, workspace, programs, index));
  if (JSON.stringify(steps).length > MAX_REQUEST_CHARS) throw new Error("worker recipe exceeds the aggregate request limit");

  const rawCollect = Array.isArray(plan.collect) ? plan.collect : [];
  if (rawCollect.length > MAX_COLLECT) throw new Error(`plan.collect exceeds the ${MAX_COLLECT}-artifact limit`);
  const collect = rawCollect.map((item) => {
    const raw = String(item == null ? "" : item).trim();
    const rel = clean(item, 2000);
    if (raw !== rel) throw new Error("collected artifact path exceeds the worker protocol limit");
    if (!rel || isAbsolute(rel)) throw new Error("collected artifact paths must be relative to the workspace");
    if (redactWorkerText(rel, 2000).trim() !== rel) throw new Error("collected artifact path contains credential material");
    const absolute = resolve(workspace, rel);
    if (!isUnder(absolute, workspace)) throw new Error("collected artifact path escapes the workspace");
    return rel.replace(/\\/g, "/");
  });

  let resumeFrom = null;
  if (input.resumeFrom && typeof input.resumeFrom === "object") {
    const completedSteps = input.resumeFrom.completedSteps == null ? 0 : Number(input.resumeFrom.completedSteps);
    if (!Number.isInteger(completedSteps) || completedSteps < 0 || completedSteps > steps.length) {
      throw new Error("resumeFrom.completedSteps must be an in-range protocol integer");
    }
    const rawLastStep = String(input.resumeFrom.lastStep == null ? "" : input.resumeFrom.lastStep).trim();
    const lastStep = redactWorkerText(input.resumeFrom.lastStep, 160).trim();
    if (lastStep !== rawLastStep || lastStep !== clean(input.resumeFrom.lastStep, 160)) throw new Error("resumeFrom.lastStep contains credential material or exceeds the protocol limit");
    const complete = input.resumeFrom.complete === true;
    if (complete && completedSteps !== steps.length) throw new Error("a complete resume checkpoint must cover every step");
    resumeFrom = { completedSteps, lastStep, complete, safeBoundary: input.resumeFrom.safeBoundary === true };
  }

  const normalized = {
    protocol: GAME_FACTORY_WORKER_PROTOCOL,
    runId, taskId, projectId, buildId, capability,
    attempt, workspaceRoot: workspace, workspaceIdentity: workerPathIdentity(workspace),
    plan: { steps, collect },
    resumeFrom,
    policy: { allowedPrograms: programs, maxLogBytes: MAX_LOG_BYTES },
    createdAt: new Date().toISOString(),
  };
  if (JSON.stringify(normalized).length > MAX_REQUEST_CHARS) throw new Error("worker request exceeds the aggregate protocol limit");
  return normalized;
}

export function collectRunArtifacts(request) {
  const out = [];
  for (const rel of request?.plan?.collect || []) {
    const path = resolve(request.workspaceRoot, rel);
    if (!isUnder(path, request.workspaceRoot)) continue;
    let fd = -1;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const st = fstatSync(fd);
      const fdPath = IS_LINUX ? existingRealpath(`/proc/self/fd/${fd}`) : existingRealpath(path);
      if (!fdPath || !isUnder(fdPath, request.workspaceRoot) || !st.isFile() || st.nlink !== 1) continue;
      if (st.size > 100_000_000) {
        out.push({ path: rel, size: st.size, skipped: "file exceeds 100 MB manifest hashing limit" });
        continue;
      }
      const bytes = Buffer.alloc(Number(st.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (offset !== bytes.length || after.size !== st.size || after.ino !== st.ino || after.dev !== st.dev || after.nlink !== 1) continue;
      out.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
    } catch { continue; }
    finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  return out;
}

function publicState(state) {
  if (!state) return null;
  const {
    runId, taskId, projectId, capability, status, revision, createdAt, startedAt, endedAt,
    updatedAt, runnerPid, childPid, currentStep, checkpoint, result, error, exitCode,
    cancelMode, artifacts, sandbox,
  } = state;
  return sanitizeWorkerValue({
    runId, taskId, projectId, capability, status, revision, createdAt, startedAt, endedAt,
    updatedAt, runnerPid, childPid, currentStep, checkpoint, result, error, exitCode,
    cancelMode, artifacts, sandbox,
  });
}

function tail(path, maxBytes = 64_000) {
  try {
    const buf = readFileSync(path);
    return redactWorkerText(buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8"), maxBytes);
  } catch { return ""; }
}

export function createGameFactoryWorker({
  stateDir = "", runtimeDir = "", isolationAttested = false, toolchainAttested = false, node = "", roots = [], pathGuard = null, stateGuard = null,
  allowedPrograms = DEFAULT_PROGRAMS, maxConcurrent = 1, sandboxProgram = "", sandboxSha256 = "",
  nodeSeccompPath = "", nodeSeccompSha256 = "", godotSeccompPath = "", godotSeccompSha256 = "",
  sandboxRequired = false, externalExecutor = false, log = () => {},
} = {}) {
  const configuredDir = clean(stateDir, 2000);
  const configuredRuntimeDir = clean(runtimeDir, 2000);
  const attested = isolationAttested === true;
  const attestedToolchain = toolchainAttested === true;
  const nodeName = clean(node, 160).toLowerCase();
  const programs = [...new Set((Array.isArray(allowedPrograms) ? allowedPrograms : DEFAULT_PROGRAMS).map(programName).filter(Boolean))];
  const concurrency = Math.min(Math.max(Number(maxConcurrent) || 1, 1), 4);
  const configuredSandboxProgram = clean(sandboxProgram, 2000);
  const configuredSandboxSha256 = clean(sandboxSha256, 64).toLowerCase();
  const configuredNodeSeccompPath = clean(nodeSeccompPath, 2000);
  const configuredNodeSeccompSha256 = clean(nodeSeccompSha256, 64).toLowerCase();
  const configuredGodotSeccompPath = clean(godotSeccompPath, 2000);
  const configuredGodotSeccompSha256 = clean(godotSeccompSha256, 64).toLowerCase();
  const requireSandbox = IS_LINUX || sandboxRequired === true;
  const useExternalExecutor = externalExecutor === true;
  const requireExternalExecutor = IS_LINUX;
  let measuredSandbox = { ok: false, configured: !!configuredSandboxProgram, error: "worker sandbox has not been measured" };

  function sandboxIdentity(value) {
    if (!value) return null;
    return {
      kind: "fd-launcher", version: clean(value.version, 160), sha256: clean(value.sha256, 64).toLowerCase(),
      appArmorComponents: value.appArmorComponents,
      seccomp: { node: { sha256: clean(value.seccomp?.node?.sha256, 64).toLowerCase() },
        godot: { sha256: clean(value.seccomp?.godot?.sha256, 64).toLowerCase() } },
    };
  }

  function readExecutorReadiness(stateRoot) {
    const ready = parseJsonFile(join(stateRoot, "executor-ready.json"));
    if (!ready || ready.protocol !== "game-factory-executor/1" || !ready.executorId) {
      throw new Error("external game-factory executor has not published a valid readiness record");
    }
    if (Date.now() - Date.parse(ready.updatedAt || 0) > 10_000) {
      throw new Error("external game-factory executor readiness heartbeat is stale");
    }
    const identity = sandboxIdentity(ready.sandbox);
    if (!identity || identity.sha256 !== configuredSandboxSha256
        || identity.seccomp.node.sha256 !== configuredNodeSeccompSha256
        || identity.seccomp.godot.sha256 !== configuredGodotSeccompSha256) {
      throw new Error("external executor sandbox identity does not match the controller's pinned policy");
    }
    return { ...identity, ok: true, configured: true, program: configuredSandboxProgram, executorId: clean(ready.executorId, 160) };
  }

  function configured() {
    return !!configuredDir;
  }

  function ensureConfigured() {
    if (!configured()) throw new Error("game factory worker is disabled: set GAME_FACTORY_WORKER_DIR on this Hands node");
    mkdirSync(configuredDir, { recursive: true, mode: 0o700 });
    try { chmodSync(configuredDir, 0o700); } catch {}
    const stateRoot = existingRealpath(configuredDir) || resolve(configuredDir);
    if (typeof stateGuard === "function") {
      const guard = stateGuard(stateRoot);
      if (!guard || guard.ok === false) throw new Error(safeError(guard && (guard.reason || guard.error), 1000) || "worker state directory was refused by the Hands policy");
    }
  }

  function ensureExecutionReady() {
    ensureConfigured();
    if (!attested) throw new Error("game factory execution requires an explicit external isolation attestation");
    if (!configuredRuntimeDir) throw new Error("game factory execution requires a separate GAME_FACTORY_WORKER_RUNTIME_DIR");
    if (!attestedToolchain) throw new Error("game factory execution requires an explicit toolchain attestation");
    if (requireExternalExecutor && !useExternalExecutor) {
      throw new Error("Linux game factory execution requires the static external executor cgroup");
    }
    mkdirSync(configuredRuntimeDir, { recursive: true, mode: 0o700 });
    try { chmodSync(configuredRuntimeDir, 0o700); } catch {}
    const stateRoot = existingRealpath(configuredDir) || resolve(configuredDir);
    const runtimeRoot = existingRealpath(configuredRuntimeDir) || resolve(configuredRuntimeDir);
    if (isUnder(runtimeRoot, stateRoot) || isUnder(stateRoot, runtimeRoot)) {
      throw new Error("worker runtime and journal directories must not overlap");
    }
    if (typeof stateGuard === "function") {
      const guard = stateGuard(runtimeRoot);
      if (!guard || guard.ok === false) throw new Error(safeError(guard && (guard.reason || guard.error), 1000) || "worker runtime directory was refused by the Hands policy");
    }
    const dynamicRoots = typeof roots === "function" ? roots() : roots;
    const protectedRoots = [stateRoot, runtimeRoot, HERE, ...(Array.isArray(dynamicRoots) ? dynamicRoots : [])];
    if (requireSandbox && !configuredSandboxProgram) {
      measuredSandbox = { ok: false, configured: false, error: "worker sandbox is required but GAME_FACTORY_WORKER_SANDBOX_PROGRAM is not configured" };
      throw new Error(measuredSandbox.error);
    }
    if (useExternalExecutor) {
      measuredSandbox = readExecutorReadiness(stateRoot);
    } else if (configuredSandboxProgram) {
      measuredSandbox = { ok: false, configured: true,
        error: "direct in-process sandbox execution is retired; Linux requires the static tokenless external executor" };
      throw new Error(measuredSandbox.error);
    } else {
      measuredSandbox = { ok: false, configured: false, error: "worker sandbox is not configured" };
    }
    return { stateRoot, runtimeRoot, sandbox: measuredSandbox.ok ? measuredSandbox : null };
  }

  function find(runId) {
    ensureConfigured();
    const exactRunId = exactIdentifier(runId, "runId", 240);
    const runDir = safeRunDir(configuredDir, exactRunId);
    const request = readRunRequest(runDir);
    if (!request || request.runId !== exactRunId) return null;
    return { runDir, request, state: readRunState(runDir) };
  }

  function heartbeatIsFresh(run) {
    try { return Date.now() - statSync(join(run.runDir, "heartbeat.json")).mtimeMs < HEARTBEAT_STALE_MS; }
    catch { return Date.now() - Date.parse(run.state?.startedAt || run.state?.updatedAt || 0) < HEARTBEAT_STALE_MS; }
  }

  function verifyResumeLineage(request) {
    const resume = request.resumeFrom;
    if (!resume || Number(resume.completedSteps) <= 0) return;
    if (request.attempt <= 1 || resume.safeBoundary !== true) {
      throw new Error("nonzero resume requires a prior worker-confirmed safe boundary");
    }
    let prior = null;
    try {
      for (const name of readdirSync(configuredDir).filter((item) => item.startsWith("run-"))) {
        const runDir = join(configuredDir, name);
        const candidate = readRunRequest(runDir);
        if (!candidate || candidate.taskId !== request.taskId || candidate.projectId !== request.projectId
            || Number(candidate.attempt) !== request.attempt - 1) continue;
        prior = { request: candidate, state: readRunState(runDir) };
        break;
      }
    } catch {}
    if (!prior?.state || !["PAUSED", "FAILED", "INTERRUPTED", "CANCELLED"].includes(prior.state.status)) {
      throw new Error("resume lineage has no eligible prior terminal attempt on this worker");
    }
    const priorPlan = {
      taskId: prior.request.taskId, projectId: prior.request.projectId,
      buildId: prior.request.buildId || "", capability: prior.request.capability,
      workspaceRoot: prior.request.workspaceRoot, workspaceIdentity: prior.request.workspaceIdentity,
      plan: prior.request.plan, sandbox: prior.request.policy?.sandbox,
    };
    const currentPlan = {
      taskId: request.taskId, projectId: request.projectId,
      buildId: request.buildId || "", capability: request.capability,
      workspaceRoot: request.workspaceRoot, workspaceIdentity: request.workspaceIdentity,
      plan: request.plan, sandbox: request.policy?.sandbox,
    };
    if (sha256(JSON.stringify(stable(priorPlan))) !== sha256(JSON.stringify(stable(currentPlan)))) {
      throw new Error("resume lineage does not match the immutable prior recipe");
    }
    const checkpoint = prior.state.checkpoint || {};
    if (checkpoint.safeBoundary !== true || Number(checkpoint.completedSteps) !== Number(resume.completedSteps)
        || clean(checkpoint.lastStep, 160) !== clean(resume.lastStep, 160)
        || (checkpoint.complete === true) !== (resume.complete === true)) {
      throw new Error("resume checkpoint does not match the prior worker-confirmed boundary");
    }
  }

  function reconcile(run) {
    if (!run || !run.state || GAME_FACTORY_TERMINAL_STATES.includes(run.state.status)) return run;
    const state = run.state;
    if (useExternalExecutor) {
      if (["STARTING", "RUNNING", "CANCEL_REQUESTED"].includes(state.status) && !heartbeatIsFresh(run)) {
        run.state = {
          ...state, status: "INTERRUPTION_PENDING",
          error: "external executor heartbeat is stale; the executor must reconcile this run before it is retried",
        };
      }
      return run;
    }
    const heartbeatFresh = !["RUNNING", "CANCEL_REQUESTED"].includes(state.status) || heartbeatIsFresh(run);
    if (["STARTING", "RUNNING", "CANCEL_REQUESTED"].includes(state.status) &&
        state.runnerPid && (!processAlive(state.runnerPid) || !heartbeatFresh)) {
      const age = Date.now() - Date.parse(state.updatedAt || state.createdAt || 0);
      if (age >= STARTUP_GRACE_MS) {
        // A stale heartbeat does not prove the pid still belongs to this runner; operating systems
        // reuse pids. Never kill or publish terminal truth without current identity evidence.
        if (processAlive(state.runnerPid) && !heartbeatFresh) {
          run.state = {
            ...state, status: "INTERRUPTION_PENDING",
            error: "worker heartbeat is stale; process identity and termination are not confirmed",
          };
          return run;
        }
        run.state = appendRunState(run.runDir, {
          status: "INTERRUPTED", endedAt: new Date().toISOString(),
          error: "worker runner is no longer alive; completion was not assumed",
          checkpoint: state.checkpoint || { completedSteps: 0 }, runnerPid: 0, childPid: 0,
        });
      }
    }
    const cancel = readCancelRequest(run.runDir);
    if (cancel && cancel.mode === "safe" && run.state && !GAME_FACTORY_TERMINAL_STATES.includes(run.state.status)) {
      run.state = { ...run.state, status: "CANCEL_REQUESTED", cancelMode: "safe" };
    }
    return run;
  }

  function describe() {
    const sandboxGate = (!configuredSandboxProgram && !requireSandbox) || measuredSandbox.ok === true;
    const executionConfigured = configured() && !!configuredRuntimeDir && attested && attestedToolchain && sandboxGate;
    return {
      protocol: GAME_FACTORY_WORKER_PROTOCOL, configured: configured(), node: nodeName,
      programs: programs.slice(), maxConcurrent: concurrency,
      state: !configured() ? "disabled" : executionConfigured ? "ready" : "blocked",
      isolation: "sanitized-process-environment-plus-external-attestation",
      isolationAttested: attested, separateRuntimeDirectory: !!configuredRuntimeDir,
      toolchainAttested: attestedToolchain,
      sandboxRequired: requireSandbox, sandboxConfigured: !!configuredSandboxProgram,
      externalExecutor: useExternalExecutor, externalExecutorRequired: requireExternalExecutor,
      sandboxReady: measuredSandbox.ok === true,
      sandbox: measuredSandbox.ok ? {
        kind: "fd-launcher", program: measuredSandbox.program, version: measuredSandbox.version,
        sha256: measuredSandbox.sha256, appArmorComponents: measuredSandbox.appArmorComponents,
        seccomp: measuredSandbox.seccomp, executorId: measuredSandbox.executorId || "",
      } : null,
      secureForUntrustedCode: attested && attestedToolchain && measuredSandbox.ok === true,
    };
  }

  function probe() {
    if (!configured()) return { ok: false, node: nodeName, ...describe(), error: "GAME_FACTORY_WORKER_DIR is not configured" };
    try { ensureExecutionReady(); }
    catch (error) { return { ok: false, node: nodeName, ...describe(), isolationRequired: true, error: safeError(error, 1200) }; }
    const command = IS_WIN ? "where.exe" : "which";
    const detected = {};
    for (const program of programs) {
      const r = spawnSync(command, [program], {
        encoding: "utf8", timeout: 3000, windowsHide: true,
        env: sanitizeWorkerEnvironment(process.env),
      });
      detected[program] = r.status === 0 ? String(r.stdout || "").trim().split(/\r?\n/)[0] : "";
    }
    const missingPrograms = programs.filter((program) => !detected[program]);
    if (missingPrograms.length) {
      return {
        ok: false, node: nodeName, ...describe(), detected, missingPrograms, toolchainRequired: true,
        error: `configured worker programs are unavailable: ${missingPrograms.join(", ")}`,
      };
    }
    let runs = 0, active = 0;
    try {
      for (const name of readdirSync(configuredDir).filter((n) => n.startsWith("run-"))) {
        runs++;
        const state = readRunState(join(configuredDir, name));
        if (state && !GAME_FACTORY_TERMINAL_STATES.includes(state.status)) active++;
      }
    } catch {}
    return { ok: true, node: nodeName, ...describe(), detected, runs, active };
  }

  function launch(runDir, request, state = null, sandbox = null) {
    const runtimeHome = join(existingRealpath(configuredRuntimeDir) || resolve(configuredRuntimeDir), "run-" + sha256(request.runId).slice(0, 32));
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    try { chmodSync(runtimeHome, 0o700); } catch {}
    const exactSandbox = sandboxIdentity(sandbox);
    const runtimeIdentity = workerPathIdentity(runtimeHome);
    let next = state || appendRunState(runDir, {
      runId: request.runId, taskId: request.taskId, projectId: request.projectId,
      capability: request.capability, status: useExternalExecutor ? "QUEUED" : "STARTING", createdAt: request.createdAt,
      checkpoint: request.resumeFrom || { completedSteps: 0 }, runnerPid: 0, childPid: 0,
      sandbox: exactSandbox || { kind: "none" }, runtimeIdentity,
    });
    if (useExternalExecutor) {
      const launchPath = join(runDir, "launch-request.json");
      if (!existsSync(launchPath)) writeDurableNew(launchPath, json({
        protocol: "game-factory-executor/1", runId: request.runId,
        requestHash: request.requestHash || workerRequestHash(request), requestedAt: new Date().toISOString(),
        sandbox: exactSandbox,
      }));
      return next;
    }
    let child;
    try {
      child = spawn(process.execPath, [RUNNER, runDir], {
        detached: true, windowsHide: true, stdio: "ignore",
        env: {
          ...sanitizeWorkerEnvironment(process.env, { homeDir: runtimeHome }),
          GAME_FACTORY_RUNTIME_HOME: runtimeHome,
          GAME_FACTORY_SANDBOX_REQUIRED: sandbox ? "1" : "0",
          ...(sandbox ? {
            GAME_FACTORY_SANDBOX_PROGRAM: sandbox.program,
            GAME_FACTORY_SANDBOX_SHA256: configuredSandboxSha256,
            GAME_FACTORY_SANDBOX_NODE_SECCOMP_PATH: configuredNodeSeccompPath,
            GAME_FACTORY_SANDBOX_NODE_SECCOMP_SHA256: configuredNodeSeccompSha256,
            GAME_FACTORY_SANDBOX_GODOT_SECCOMP_PATH: configuredGodotSeccompPath,
            GAME_FACTORY_SANDBOX_GODOT_SECCOMP_SHA256: configuredGodotSeccompSha256,
          } : {}),
        },
      });
      child.unref();
      next = appendRunState(runDir, { status: "STARTING", runnerPid: child.pid || 0 });
      // The runner verifies this latch belongs to its own pid. If the Hands process crashes in
      // the tiny spawn-before-state window, that orphan cannot consume a later runner's latch.
      writeDurableNew(join(runDir, "launch.json"), json({ runnerPid: child.pid || 0, launchedAt: new Date().toISOString() }));
    } catch (error) {
      next = appendRunState(runDir, {
        status: "FAILED", endedAt: new Date().toISOString(),
        error: "could not launch durable runner: " + safeError(error, 1000),
      });
    }
    return next;
  }

  function start(input) {
    try {
      const execution = ensureExecutionReady();
      const normalizedRequest = normalizeWorkerRequest(input || {}, { roots, pathGuard, allowedPrograms: programs });
      const request = {
        ...normalizedRequest,
        policy: {
          ...normalizedRequest.policy,
          sandbox: sandboxIdentity(execution.sandbox),
          executor: useExternalExecutor ? "external-static" : "local",
        },
      };
      const { stateRoot, runtimeRoot } = execution;
      if (isUnder(request.workspaceRoot, stateRoot) || isUnder(stateRoot, request.workspaceRoot)) {
        throw new Error("workspaceRoot and the worker state directory must not overlap");
      }
      if (isUnder(request.workspaceRoot, runtimeRoot) || isUnder(runtimeRoot, request.workspaceRoot)) {
        throw new Error("workspaceRoot and the worker runtime directory must not overlap");
      }
      verifyResumeLineage(request);
      return withFileLock(configuredDir, ".start.lock", () => {
      const runDir = safeRunDir(configuredDir, request.runId);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      try { chmodSync(runDir, 0o700); } catch {}
      const hash = workerRequestHash(request);
      const prior = readRunRequest(runDir);
      if (prior) {
        if (prior.requestHash !== hash) {
          return { ok: false, conflict: true, node: nodeName, runId: request.runId, error: "runId already belongs to a different immutable request" };
        }
        let existing = reconcile({ runDir, request: prior, state: readRunState(runDir) });
        const expectedReplaySandbox = sandboxIdentity(execution.sandbox) || { kind: "none" };
        if (existing.state?.sandbox && JSON.stringify(existing.state.sandbox) !== JSON.stringify(expectedReplaySandbox)) {
          return { ok: false, conflict: true, retryable: false, node: nodeName, runId: request.runId, error: "stored run sandbox identity differs from the measured external executor" };
        }
        if (!existing.state) existing.state = launch(runDir, prior, null, execution.sandbox);
        else if (!useExternalExecutor && existing.state.status === "STARTING" && existing.state.runnerPid && processAlive(existing.state.runnerPid) && !existsSync(join(runDir, "launch.json"))) {
          // Recover a crash after the runner pid was journaled but before its launch latch.
          writeDurableNew(join(runDir, "launch.json"), json({ runnerPid: existing.state.runnerPid, launchedAt: new Date().toISOString(), recovered: true }));
        } else if (!useExternalExecutor && existing.state.status === "STARTING" && !existing.state.runnerPid) {
          existing.state = launch(runDir, prior, existing.state, execution.sandbox);
        }
        return { ok: true, replayed: true, node: nodeName, ...publicState(existing.state) };
      }
      // runId idempotency alone is insufficient: a caller could choose a second runId for the
      // same durable task attempt and execute the recipe twice. The start lock makes this
      // task/project/attempt ownership check atomic with publishing the new request intent.
      try {
        for (const name of readdirSync(configuredDir).filter((item) => item.startsWith("run-"))) {
          const other = readRunRequest(join(configuredDir, name));
          if (other && other.runId !== request.runId && other.projectId === request.projectId
              && other.taskId === request.taskId && Number(other.attempt) === request.attempt) {
            return {
              ok: false, conflict: true, retryable: false, node: nodeName, runId: request.runId,
              error: "this task attempt already belongs to a different immutable runId",
            };
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      let active = 0;
      try {
        for (const name of readdirSync(configuredDir).filter((n) => n.startsWith("run-"))) {
          const otherDir = join(configuredDir, name);
          const other = reconcile({ runDir: otherDir, request: readRunRequest(otherDir), state: readRunState(otherDir) });
          if (other && other.state && !GAME_FACTORY_TERMINAL_STATES.includes(other.state.status)) active++;
        }
      } catch {}
      if (active >= concurrency) {
        return { ok: false, busy: true, retryable: true, node: nodeName, runId: request.runId, error: `worker concurrency limit (${concurrency}) is busy` };
      }
      const stored = { ...request, requestHash: hash };
      writeDurableNew(join(runDir, "request.json"), json(stored));
      const state = launch(runDir, request, null, execution.sandbox);
      return { ok: state.status !== "FAILED", node: nodeName, ...publicState(state) };
      });
    } catch (error) {
      const busy = error?.code === "WORKER_LOCK_BUSY";
      return {
        ok: false, node: nodeName, busy, retryable: busy,
        error: safeError(error, 1200) || "invalid worker request",
      };
    }
  }

  function status(runId) {
    try {
      const run = reconcile(find(runId));
      if (!run) return { ok: false, node: nodeName, runId: clean(runId, 240), notFound: true, error: "unknown game factory run" };
      if (!run.state) return { ok: false, retryable: true, node: nodeName, runId: clean(runId, 240), notFound: true, error: "run intent exists but launch state is missing" };
      if (run.state.status === "INTERRUPTION_PENDING") return { ok: false, retryable: true, node: nodeName, ...publicState(run.state) };
      return { ok: true, node: nodeName, ...publicState(run.state) };
    } catch (error) {
      return { ok: false, node: nodeName, runId: clean(runId, 240), error: safeError(error, 1200) };
    }
  }

  function cancel(runId, { mode = "safe", reason = "" } = {}) {
    try {
      const run = reconcile(find(runId));
      if (!run) return { ok: false, node: nodeName, runId: clean(runId, 240), notFound: true, error: "unknown game factory run" };
      if (GAME_FACTORY_TERMINAL_STATES.includes(run.state.status)) {
        return { ok: true, replayed: true, node: nodeName, ...publicState(run.state) };
      }
      const cancelMode = String(mode).toLowerCase() === "immediate" ? "immediate" : "safe";
      writeCancelRequest(run.runDir, cancelMode, reason);
      if (cancelMode === "immediate") {
        if (useExternalExecutor) {
          return { ok: true, node: nodeName, ...publicState({ ...readRunState(run.runDir), status: "CANCEL_REQUESTED", cancelMode }) };
        }
        if (run.state.runnerPid && processAlive(run.state.runnerPid) && !heartbeatIsFresh(run)) {
          return {
            ok: false, retryable: true, node: nodeName, runId: clean(runId, 240),
            status: "CANCEL_REQUESTED", error: "stale heartbeat prevents safe process-identity confirmation",
          };
        }
        const killed = killRecordedRun(run.state);
        if (!killed) {
          const latest = readRunState(run.runDir);
          if (latest && GAME_FACTORY_TERMINAL_STATES.includes(latest.status)) {
            return { ok: true, replayed: true, node: nodeName, ...publicState(latest) };
          }
          return {
            ok: false, retryable: true, node: nodeName, runId: clean(runId, 240),
            status: "CANCEL_REQUESTED", error: "could not confirm immediate process-tree termination",
          };
        }
        const state = appendRunState(run.runDir, {
          status: "CANCELLED", cancelMode, endedAt: new Date().toISOString(),
          error: redactWorkerText(reason, 1000).trim() || "stopped immediately by the owner",
          runnerPid: 0, childPid: 0,
        });
        return { ok: true, node: nodeName, ...publicState(state) };
      }
      // cancel-*.json is itself the durable request. Do not append a competing state record here:
      // the runner may be publishing SUCCEEDED at this exact boundary, and terminal truth must win.
      return { ok: true, node: nodeName, ...publicState({ ...readRunState(run.runDir), status: "CANCEL_REQUESTED", cancelMode: "safe" }) };
    } catch (error) {
      return { ok: false, node: nodeName, runId: clean(runId, 240), error: safeError(error, 1200) };
    }
  }

  function collect(runId) {
    try {
      const run = reconcile(find(runId));
      if (!run) return { ok: false, node: nodeName, runId: clean(runId, 240), notFound: true, error: "unknown game factory run" };
      const artifacts = run.state.artifacts || collectRunArtifacts(run.request);
      return {
        ok: true, node: nodeName, ...publicState({ ...run.state, artifacts }),
        stdout: tail(join(run.runDir, "stdout.log")),
        stderr: tail(join(run.runDir, "stderr.log")),
      };
    } catch (error) {
      return { ok: false, node: nodeName, runId: clean(runId, 240), error: safeError(error, 1200) };
    }
  }

  return { describe, probe, start, status, cancel, collect };
}
