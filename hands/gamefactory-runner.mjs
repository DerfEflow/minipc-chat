/* Detached, restart-independent executor for hands/gamefactory-worker.mjs. */
import {
  appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  GAME_FACTORY_TERMINAL_STATES, appendRunState, assertWorkerPathBoundary, buildWorkerSandboxCommand, collectRunArtifacts, killWorkerTree,
  normalizeWorkerRequest, readCancelRequest, readRunRequest, readRunState,
  probeWorkerSandbox, redactWorkerText, sanitizeWorkerEnvironment, workerPathIdentity, workerRequestHash,
} from "./gamefactory-worker.mjs";

const runDir = resolve(String(process.argv[2] || ""));
const request = readRunRequest(runDir);
if (!request || request.protocol !== "game-factory-worker/1") process.exit(2);
if (!request.requestHash || request.requestHash !== workerRequestHash(request)) process.exit(3);

const maxLogBytes = Math.min(Math.max(Number(request.policy?.maxLogBytes) || 5_000_000, 64_000), 20_000_000);
let stdoutBytes = 0, stderrBytes = 0;
const pending = { "stdout.log": "", "stderr.log": "" };
const privateKeyBlock = { "stdout.log": false, "stderr.log": false };
const runtimeHomeInput = String(process.env.GAME_FACTORY_RUNTIME_HOME || "").trim();
if (!runtimeHomeInput) process.exit(4);
const runtimeHome = resolve(runtimeHomeInput);
const sandboxProgram = String(process.env.GAME_FACTORY_SANDBOX_PROGRAM || "").trim();
const sandboxRequired = process.platform === "linux" || process.env.GAME_FACTORY_SANDBOX_REQUIRED === "1";
const sandboxSha256 = String(process.env.GAME_FACTORY_SANDBOX_SHA256 || "").trim();
const sandboxAppArmorProfile = String(process.env.GAME_FACTORY_SANDBOX_APPARMOR_PROFILE || "").trim();
const sandboxSeccompPath = String(process.env.GAME_FACTORY_SANDBOX_SECCOMP_PATH || "").trim();
const sandboxSeccompSha256 = String(process.env.GAME_FACTORY_SANDBOX_SECCOMP_SHA256 || "").trim();
mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
try { chmodSync(runtimeHome, 0o700); } catch {}

function appendRedacted(name, value) {
  const lines = String(value).split(/(?<=\n)/);
  let safe = "";
  for (const line of lines) {
    if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(line)) {
      privateKeyBlock[name] = true;
      safe += "[redacted-private-key]\n";
      if (/-----END [^-\r\n]*PRIVATE KEY-----/i.test(line)) privateKeyBlock[name] = false;
      continue;
    }
    if (privateKeyBlock[name]) {
      if (/-----END [^-\r\n]*PRIVATE KEY-----/i.test(line)) privateKeyBlock[name] = false;
      continue;
    }
    safe += redactWorkerText(line, Math.max(line.length, 1));
  }
  const buf = Buffer.from(safe);
  const used = name === "stdout.log" ? stdoutBytes : stderrBytes;
  if (used >= maxLogBytes) return;
  const part = buf.subarray(0, maxLogBytes - used);
  try { appendFileSync(resolve(runDir, name), part, { mode: 0o600 }); } catch {}
  if (name === "stdout.log") stdoutBytes += part.length; else stderrBytes += part.length;
}

function writeLog(name, chunk, flush = false) {
  pending[name] += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  let cut = flush ? pending[name].length : pending[name].lastIndexOf("\n") + 1;
  // An unbroken line cannot be redacted safely across an arbitrary cut boundary. Drop it instead
  // of risking half of a token or PEM marker reaching disk.
  if (!flush && cut <= 0 && pending[name].length > 131_072) {
    pending[name] = "";
    appendRedacted(name, "[redacted-oversize-unbroken-log-line]\n");
    return;
  }
  if (cut <= 0) return;
  const ready = pending[name].slice(0, cut);
  pending[name] = pending[name].slice(cut);
  appendRedacted(name, ready);
}

function validStoredStep(step) {
  try {
    const checked = normalizeWorkerRequest({ ...request, resumeFrom: null, plan: { steps: [step], collect: [] } }, {
      roots: [request.workspaceRoot], allowedPrograms: request.policy.allowedPrograms,
    });
    return checked.plan.steps.length === 1;
  } catch { return false; }
}

function sameIdentity(left, right) {
  return !!left && !!right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function openVerifiedDirectory(path, expected, label) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  const metadata = fstatSync(fd, { bigint: true });
  const actual = { dev: String(metadata.dev), ino: String(metadata.ino) };
  if (!metadata.isDirectory() || !sameIdentity(actual, expected)) {
    closeSync(fd);
    throw new Error(`${label} directory identity changed after request authorization`);
  }
  return fd;
}

function processStep(step, index) {
  return new Promise((done) => {
    const started = Date.now();
    let child;
    const inherited = [];
    try {
      const childEnvironment = sanitizeWorkerEnvironment(process.env, { homeDir: runtimeHome });
      let launch;
      let stdio = ["ignore", "pipe", "pipe"];
      if (sandboxProgram) {
        assertWorkerPathBoundary(request.workspaceRoot);
        assertWorkerPathBoundary(runtimeHome);
        const workspaceFd = openVerifiedDirectory(request.workspaceRoot, request.workspaceIdentity, "workspace");
        const runtimeFd = openVerifiedDirectory(runtimeHome, readRunState(runDir)?.runtimeIdentity, "runtime");
        const cwdFd = openVerifiedDirectory(step.cwd, step.cwdIdentity, "step cwd");
        const seccompFd = openSync(sandboxSeccompPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        inherited.push(workspaceFd, runtimeFd, cwdFd, seccompFd);
        launch = buildWorkerSandboxCommand(step, {
          program: sandboxProgram, workspaceRoot: request.workspaceRoot,
          runtimeHome, environment: childEnvironment,
          workspaceFd: 3, runtimeFd: 4, cwdFd: 5, seccompFd: 6,
        });
        stdio = ["ignore", "pipe", "pipe", ...inherited];
      } else {
        launch = { program: step.program, args: step.args, env: childEnvironment };
      }
      child = spawn(launch.program, launch.args, {
        cwd: step.cwd, env: launch.env, windowsHide: true,
        detached: process.platform !== "win32", stdio,
      });
    } catch (error) {
      return done({ ok: false, code: -1, error: redactWorkerText(error && error.message || error, 1200), ms: Date.now() - started });
    } finally {
      for (const fd of inherited) try { closeSync(fd); } catch {}
    }
    appendRunState(runDir, { status: "RUNNING", runnerPid: process.pid, childPid: child.pid || 0, currentStep: index });
    child.stdout.on("data", (chunk) => writeLog("stdout.log", chunk));
    child.stderr.on("data", (chunk) => writeLog("stderr.log", chunk));
    let settled = false;
    const flushLogs = () => { writeLog("stdout.log", "", true); writeLog("stderr.log", "", true); };
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); done(value); };
    const timer = setTimeout(() => {
      killWorkerTree(child.pid);
      flushLogs();
      finish({ ok: false, code: -1, timedOut: true, error: `step timed out after ${step.timeoutMs}ms`, ms: Date.now() - started });
    }, step.timeoutMs);
    child.on("error", (error) => {
      flushLogs();
      finish({ ok: false, code: -1, error: redactWorkerText(error && error.message || error, 1200), ms: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      flushLogs();
      finish({
        ok: code === 0, code: Number.isInteger(code) ? code : -1, signal: signal || "",
        error: code === 0 ? "" : `step exited with code ${code == null ? "unknown" : code}`,
        ms: Date.now() - started,
      });
    });
  });
}

async function main() {
  // Parent records the detached pid before releasing this latch. This eliminates a startup race in
  // which a tiny task could finish before STARTING was durably recorded by the Hands process.
  const latch = resolve(runDir, "launch.json");
  const latchDeadline = Date.now() + 10_000;
  while (!existsSync(latch) && Date.now() < latchDeadline) await new Promise((r) => setTimeout(r, 10));
  if (!existsSync(latch)) {
    appendRunState(runDir, { status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0, error: "worker launch latch was not published" });
    return;
  }
  let launch = null;
  try { launch = JSON.parse(readFileSync(latch, "utf8")); } catch {}
  // Only the exact detached pid recorded by the parent may consume this launch. This prevents an
  // orphan from a spawn-before-journal crash from waking on a later recovery runner's latch.
  if (!launch || Number(launch.runnerPid) !== process.pid) return;
  const latchedState = readRunState(runDir);
  if (!latchedState || Number(latchedState.runnerPid) !== process.pid) return;
  if (sandboxRequired && !sandboxProgram) {
    appendRunState(runDir, {
      status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0,
      error: "worker sandbox was required but the measured sandbox program was not delivered to the runner",
    });
    return;
  }
  if (sandboxRequired) {
    const measured = probeWorkerSandbox({
      program: sandboxProgram, sha256: sandboxSha256, appArmorProfile: sandboxAppArmorProfile,
      seccompPath: sandboxSeccompPath, seccompSha256: sandboxSeccompSha256,
      protectedRoots: [dirname(runDir), runtimeHome, "/app"],
    });
    const expected = request.policy?.sandbox;
    const actual = measured.ok ? {
      kind: "bubblewrap", version: measured.version, sha256: measured.sha256,
      appArmorProfile: measured.appArmorProfile, seccompSha256: measured.seccompSha256,
    } : null;
    if (!measured.ok || !expected || JSON.stringify(actual) !== JSON.stringify(expected)) {
      appendRunState(runDir, {
        status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0,
        error: measured.error || "stored sandbox identity does not match the measured executor sandbox",
      });
      return;
    }
  }
  if (!request.plan.steps.every(validStoredStep)) {
    appendRunState(runDir, { status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0, error: "stored worker recipe failed runner-side policy validation" });
    return;
  }
  const prior = readRunState(runDir);
  if (prior && GAME_FACTORY_TERMINAL_STATES.includes(prior.status)) return;
  const resume = Number(request.resumeFrom?.completedSteps ?? prior?.checkpoint?.completedSteps ?? 0);
  const completed = Math.min(Math.max(Number.isInteger(resume) ? resume : 0, 0), request.plan.steps.length);
  appendRunState(runDir, {
    status: "RUNNING", runnerPid: process.pid, childPid: 0,
    startedAt: prior?.startedAt || new Date().toISOString(),
    checkpoint: { completedSteps: completed, safeBoundary: true }, currentStep: completed,
  });
  const heartbeat = setInterval(() => {
    try { writeFileSync(resolve(runDir, "heartbeat.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { mode: 0o600 }); } catch {}
  }, 2_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  try { writeFileSync(resolve(runDir, "heartbeat.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n", { mode: 0o600 }); } catch {}

  try {
  for (let index = completed; index < request.plan.steps.length; index++) {
    const before = readCancelRequest(runDir);
    if (before) {
      appendRunState(runDir, {
        status: before.mode === "immediate" ? "CANCELLED" : "PAUSED", cancelMode: before.mode,
        endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0,
        checkpoint: { completedSteps: index, safeBoundary: true }, result: { reason: before.reason, safeBoundary: true },
      });
      return;
    }
    writeLog("stdout.log", `\n[game-factory] ${request.plan.steps[index].label}\n`);
    const result = await processStep(request.plan.steps[index], index);
    if (!result.ok) {
      appendRunState(runDir, {
        status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0,
        currentStep: index, checkpoint: { completedSteps: index, safeBoundary: true }, exitCode: result.code,
        error: result.error, result: { step: request.plan.steps[index].label, ...result },
      });
      return;
    }
    appendRunState(runDir, {
      status: "RUNNING", runnerPid: process.pid, childPid: 0, currentStep: index + 1,
      checkpoint: { completedSteps: index + 1, lastStep: request.plan.steps[index].label, safeBoundary: true },
      result: { lastStep: request.plan.steps[index].label, ms: result.ms },
    });
    const after = readCancelRequest(runDir);
    if (after) {
      appendRunState(runDir, {
        status: after.mode === "immediate" ? "CANCELLED" : "PAUSED", cancelMode: after.mode,
        endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0,
        checkpoint: { completedSteps: index + 1, lastStep: request.plan.steps[index].label, safeBoundary: true },
        result: { reason: after.reason, safeBoundary: true },
      });
      return;
    }
  }

  const artifacts = collectRunArtifacts(request);
  appendRunState(runDir, {
    status: "SUCCEEDED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0,
    currentStep: request.plan.steps.length,
    checkpoint: { completedSteps: request.plan.steps.length, complete: true, safeBoundary: true },
    result: { stepsCompleted: request.plan.steps.length }, artifacts,
  });
  } finally { clearInterval(heartbeat); }
}

process.on("uncaughtException", (error) => {
  try { appendRunState(runDir, { status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0, error: redactWorkerText(error && error.message || error, 1200) }); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  try { appendRunState(runDir, { status: "FAILED", endedAt: new Date().toISOString(), runnerPid: 0, childPid: 0, error: redactWorkerText(error && error.message || error, 1200) }); } catch {}
  process.exit(1);
});

await main();
