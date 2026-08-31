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
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "gamefactory-runner.mjs");
const IS_WIN = process.platform === "win32";
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
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|TZ|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|JAVA_HOME|JDK_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|DEVELOPER_DIR|SDKROOT)$/i;
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
  if (normalizedProgram === "node" && real && real === existingRealpath(process.execPath)) return real;
  if (normalizedProgram === "node" && !/[\\/]/.test(program) && !isAbsolute(program)) return existingRealpath(process.execPath) || process.execPath;
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
    program: trustedProgram(program, normalizedProgram, workspace), programName: normalizedProgram, args, cwd, timeoutMs,
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
    attempt, workspaceRoot: workspace,
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
    let real, st;
    try { real = realpathSync(path); st = statSync(real); } catch { continue; }
    if (!isUnder(real, request.workspaceRoot) || !st.isFile()) continue;
    if (st.size > 100_000_000) {
      out.push({ path: rel, size: st.size, skipped: "file exceeds 100 MB manifest hashing limit" });
      continue;
    }
    const bytes = readFileSync(real);
    out.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
  }
  return out;
}

function publicState(state) {
  if (!state) return null;
  const {
    runId, taskId, projectId, capability, status, revision, createdAt, startedAt, endedAt,
    updatedAt, runnerPid, childPid, currentStep, checkpoint, result, error, exitCode,
    cancelMode, artifacts,
  } = state;
  return sanitizeWorkerValue({
    runId, taskId, projectId, capability, status, revision, createdAt, startedAt, endedAt,
    updatedAt, runnerPid, childPid, currentStep, checkpoint, result, error, exitCode,
    cancelMode, artifacts,
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
  allowedPrograms = DEFAULT_PROGRAMS, maxConcurrent = 1, log = () => {},
} = {}) {
  const configuredDir = clean(stateDir, 2000);
  const configuredRuntimeDir = clean(runtimeDir, 2000);
  const attested = isolationAttested === true;
  const attestedToolchain = toolchainAttested === true;
  const nodeName = clean(node, 160).toLowerCase();
  const programs = [...new Set((Array.isArray(allowedPrograms) ? allowedPrograms : DEFAULT_PROGRAMS).map(programName).filter(Boolean))];
  const concurrency = Math.min(Math.max(Number(maxConcurrent) || 1, 1), 4);

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
    return { stateRoot, runtimeRoot };
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
      workspaceRoot: prior.request.workspaceRoot, plan: prior.request.plan,
    };
    const currentPlan = {
      taskId: request.taskId, projectId: request.projectId,
      buildId: request.buildId || "", capability: request.capability,
      workspaceRoot: request.workspaceRoot, plan: request.plan,
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
    const executionConfigured = configured() && !!configuredRuntimeDir && attested && attestedToolchain;
    return {
      protocol: GAME_FACTORY_WORKER_PROTOCOL, configured: configured(), node: nodeName,
      programs: programs.slice(), maxConcurrent: concurrency,
      state: !configured() ? "disabled" : executionConfigured ? "ready" : "blocked",
      isolation: "sanitized-process-environment-plus-external-attestation",
      isolationAttested: attested, separateRuntimeDirectory: !!configuredRuntimeDir,
      toolchainAttested: attestedToolchain,
      secureForUntrustedCode: false,
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

  function launch(runDir, request, state = null) {
    const runtimeHome = join(existingRealpath(configuredRuntimeDir) || resolve(configuredRuntimeDir), "run-" + sha256(request.runId).slice(0, 32));
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    try { chmodSync(runtimeHome, 0o700); } catch {}
    let next = state || appendRunState(runDir, {
      runId: request.runId, taskId: request.taskId, projectId: request.projectId,
      capability: request.capability, status: "STARTING", createdAt: request.createdAt,
      checkpoint: request.resumeFrom || { completedSteps: 0 }, runnerPid: 0, childPid: 0,
    });
    let child;
    try {
      child = spawn(process.execPath, [RUNNER, runDir], {
        detached: true, windowsHide: true, stdio: "ignore",
        env: { ...sanitizeWorkerEnvironment(process.env, { homeDir: runtimeHome }), GAME_FACTORY_RUNTIME_HOME: runtimeHome },
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
      const request = normalizeWorkerRequest(input || {}, { roots, pathGuard, allowedPrograms: programs });
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
        if (!existing.state) existing.state = launch(runDir, prior);
        else if (existing.state.status === "STARTING" && existing.state.runnerPid && processAlive(existing.state.runnerPid) && !existsSync(join(runDir, "launch.json"))) {
          // Recover a crash after the runner pid was journaled but before its launch latch.
          writeDurableNew(join(runDir, "launch.json"), json({ runnerPid: existing.state.runnerPid, launchedAt: new Date().toISOString(), recovered: true }));
        } else if (existing.state.status === "STARTING" && !existing.state.runnerPid) {
          existing.state = launch(runDir, prior, existing.state);
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
      const state = launch(runDir, request);
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
