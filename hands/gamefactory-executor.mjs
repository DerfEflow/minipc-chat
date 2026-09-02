/* Tokenless, networkless executor for the directional game-factory filesystem spool. */
import {
  chmodSync, chownSync, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, statSync, writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  assertWorkerPathBoundary, buildWorkerSandboxCommand, collectRunArtifacts,
  killWorkerTree, normalizeWorkerRequest, probeWorkerSandbox, redactWorkerText, sanitizeWorkerEnvironment,
} from "./gamefactory-worker.mjs";
import {
  GAME_FACTORY_EXECUTOR_PROTOCOL, GAME_FACTORY_SPOOL_GID, GAME_FACTORY_TERMINAL_STATES, durableNoReplace, durableReplace,
  readSpoolEvents, readTrustedJson, recoverDurableTree, sha256Text, spoolCommandHash, stableValue, workerRequestHash,
} from "./gamefactory-ipc.mjs";

const PROTOCOL = GAME_FACTORY_EXECUTOR_PROTOCOL;
const commands = resolve(process.env.GAME_FACTORY_EXECUTOR_COMMAND_DIR || "/commands");
const replies = resolve(process.env.GAME_FACTORY_EXECUTOR_REPLY_DIR || "/replies");
const workspace = resolve(process.env.GAME_FACTORY_EXECUTOR_WORKSPACE_ROOT || "/workspace");
const runtime = resolve(process.env.GAME_FACTORY_EXECUTOR_RUNTIME_ROOT || "/runtime");
const sandboxProgram = String(process.env.GAME_FACTORY_WORKER_SANDBOX_PROGRAM || "").trim();
const sandboxSha256 = String(process.env.GAME_FACTORY_WORKER_SANDBOX_SHA256 || "").trim();
const nodeSeccompPath = String(process.env.GAME_FACTORY_WORKER_NODE_SECCOMP_PATH || "").trim();
const nodeSeccompSha256 = String(process.env.GAME_FACTORY_WORKER_NODE_SECCOMP_SHA256 || "").trim();
const godotSeccompPath = String(process.env.GAME_FACTORY_WORKER_GODOT_SECCOMP_PATH || "").trim();
const godotSeccompSha256 = String(process.env.GAME_FACTORY_WORKER_GODOT_SECCOMP_SHA256 || "").trim();
const appArmorPolicySha256 = String(process.env.GAME_FACTORY_APPARMOR_POLICY_SHA256 || "").trim().toLowerCase();
const outerSeccompSha256 = String(process.env.GAME_FACTORY_OUTER_SECCOMP_SHA256 || "").trim().toLowerCase();
const allowedPrograms = String(process.env.GAME_FACTORY_WORKER_PROGRAMS || "node,godot").split(",").map((v) => v.trim()).filter(Boolean);
const controllerUid = Number(process.env.GAME_FACTORY_CONTROLLER_UID || 10001);
const executorId = randomUUID();
const stable = stableValue;
const sha256 = sha256Text;

function appendEvent(runKey, input) {
  const dir = join(replies, `run-${runKey}`);
  mkdirSync(dir, { recursive: true, mode: 0o2750 });
  chmodSync(dir, 0o2750);
  if (process.platform !== "win32") chownSync(dir, -1, GAME_FACTORY_SPOOL_GID);
  const events = readSpoolEvents(replies, runKey, { ownerUid: process.getuid?.() ?? 10002,
    ownerGid: GAME_FACTORY_SPOOL_GID, quarantine: true });
  const first = events[0];
  const event = { protocol: PROTOCOL, runKey, sequence: events.length + 1, previousHash: events.at(-1)?.eventHash || "",
    runId: input.runId || first?.runId, requestHash: input.requestHash || first?.requestHash,
    policyHash: input.policyHash || first?.policyHash, executorId, at: new Date().toISOString(), ...input };
  if (!event.runId || !/^[a-f0-9]{64}$/.test(event.requestHash || "") || !/^[a-f0-9]{64}$/.test(event.policyHash || "")) {
    throw new Error("executor event is missing its immutable run/request/policy identity");
  }
  event.eventHash = sha256(JSON.stringify(stable(event)));
  durableNoReplace(join(dir, `event-${String(event.sequence).padStart(8, "0")}-${randomUUID()}.json`), JSON.stringify(event, null, 2) + "\n");
  return event;
}

function verifyControllerCommand(path, expected = "") {
  const value = readTrustedJson(path, { ownerUid: controllerUid, ownerGid: GAME_FACTORY_SPOOL_GID, maxBytes: 1_000_000 });
  if (!value || value.protocol !== PROTOCOL || value.commandHash !== spoolCommandHash(value) || (expected && value.command !== expected)) {
    throw new Error("controller command hash or protocol is invalid");
  }
  return value;
}

export function selectExecutorCancellation(items) {
  const immediate = items.filter((item) => item.mode === "immediate");
  const candidates = immediate.length ? immediate : items.filter((item) => item.mode === "safe");
  return candidates.sort((left, right) => String(left.requestedAt).localeCompare(String(right.requestedAt))).at(-1) || null;
}

function latestCancel(runKey, runId, requestHash) {
  let names;
  try { names = readdirSync(commands).filter((name) => name.startsWith(`cancel-${runKey}-`)).sort(); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const items = [];
  for (const name of names) {
    const match = new RegExp(`^cancel-${runKey}-(safe|immediate)[.]json$`).exec(name);
    if (!match) throw new Error("cancellation filename is invalid");
    const value = verifyControllerCommand(join(commands, name), "CANCEL");
    const expectedId = sha256(`${runId}\n${requestHash}\n${match[1]}`);
    if (value.commandId !== expectedId || value.runId !== runId || value.requestHash !== requestHash
        || value.mode !== match[1] || !Number.isFinite(Date.parse(value.requestedAt || ""))) {
      throw new Error("cancellation identity or mode is invalid");
    }
    items.push(value);
  }
  return selectExecutorCancellation(items);
}

function sameIdentity(left, right) {
  return !!left && !!right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}
function openVerifiedDirectory(path, expected, label) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  const metadata = fstatSync(fd, { bigint: true });
  if (!metadata.isDirectory() || !sameIdentity({ dev: String(metadata.dev), ino: String(metadata.ino) }, expected)) {
    closeSync(fd); throw new Error(`${label} directory identity changed after executor authorization`);
  }
  return fd;
}

function logWriter(path, maxBytes = 5_000_000) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o640);
  const metadata = fstatSync(fd);
  if (!metadata.isFile() || metadata.nlink !== 1) { closeSync(fd); throw new Error("executor log path is not a single-link regular file"); }
  if (metadata.size > maxBytes) { closeSync(fd); throw new Error("executor log already exceeds its durable byte bound"); }
  fchmodSync(fd, 0o640); if (process.platform !== "win32") fchownSync(fd, -1, GAME_FACTORY_SPOOL_GID);
  let pending = "", used = metadata.size, privateBlock = false, closed = false;
  const writeBounded = (value) => {
    const source = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const bytes = source.subarray(0, Math.max(0, maxBytes - used));
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw new Error("executor log write made no progress");
      offset += count; used += count;
    }
    const after = fstatSync(fd);
    if (!after.isFile() || after.nlink !== 1 || after.size !== used
        || (process.platform !== "win32" && ((after.mode & 0o777) !== 0o640 || after.gid !== GAME_FACTORY_SPOOL_GID))) {
      throw new Error("executor log metadata changed while writing");
    }
  };
  return (chunk, flush = false) => {
    if (closed) return;
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    let cut = flush ? pending.length : pending.lastIndexOf("\n") + 1;
    if (!flush && cut <= 0 && pending.length > 131_072) {
      pending = ""; cut = 0; writeBounded("[redacted-oversize-unbroken-log-line]\n"); return;
    }
    if (cut <= 0) {
      if (flush) { fsyncSync(fd); closeSync(fd); closed = true; }
      return;
    }
    const ready = pending.slice(0, cut); pending = pending.slice(cut);
    let safe = "";
    for (const line of ready.split(/(?<=\n)/)) {
      if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(line)) { privateBlock = true; safe += "[redacted-private-key]\n"; continue; }
      if (privateBlock) { if (/-----END [^-\r\n]*PRIVATE KEY-----/i.test(line)) privateBlock = false; continue; }
      safe += redactWorkerText(line, Math.max(1, line.length));
    }
    writeBounded(Buffer.from(safe));
    if (flush) { fsyncSync(fd); closeSync(fd); closed = true; }
  };
}

async function processStep(step, request, runKey, runHome, childFilters, cancelHash) {
  assertWorkerPathBoundary(request.workspaceRoot);
  assertWorkerPathBoundary(runHome);
  const inherited = [];
  let child;
  const out = logWriter(join(replies, `run-${runKey}`, "stdout.log"));
  const err = logWriter(join(replies, `run-${runKey}`, "stderr.log"));
  try {
    const workspaceFd = openVerifiedDirectory(request.workspaceRoot, request.workspaceIdentity, "workspace");
    const runtimeIdentity = assertWorkerPathBoundary(runHome).identity;
    const runtimeFd = openVerifiedDirectory(runHome, runtimeIdentity, "runtime");
    const cwdFd = openVerifiedDirectory(step.cwd, step.cwdIdentity, "step cwd");
    const nodeFilterFd = openSync(childFilters.node, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const godotFilterFd = openSync(childFilters.godot, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    inherited.push(workspaceFd, runtimeFd, cwdFd, nodeFilterFd, godotFilterFd);
    const environment = sanitizeWorkerEnvironment(process.env, { homeDir: runHome });
    const launch = buildWorkerSandboxCommand(step, { program: sandboxProgram, workspaceRoot: request.workspaceRoot,
      runtimeHome: runHome, environment, workspaceFd: 3, runtimeFd: 4, cwdFd: 5,
      nodeSeccompFd: 6, godotSeccompFd: 7 });
    child = spawn(launch.program, launch.args, { cwd: step.cwd, env: launch.env, detached: false,
      stdio: ["ignore", "pipe", "pipe", ...inherited] });
  } catch (error) {
    try { out("", true); err("", true); } catch {}
    throw error;
  } finally { for (const fd of inherited) try { closeSync(fd); } catch {} }
  child.stdout.on("data", (chunk) => out(chunk)); child.stderr.on("data", (chunk) => err(chunk));
  return await new Promise((resolveDone) => {
    let settled = false, immediate = null, forcedError = "";
    const finish = (value) => {
      if (settled) return;
      settled = true; clearInterval(cancelTimer); clearTimeout(timeout);
      try { out("", true); err("", true); resolveDone(value); }
      catch (error) { resolveDone({ ok: false, interrupted: true, code: -1, error: redactWorkerText(error.message || error, 1200) }); }
    };
    const cancelTimer = setInterval(() => {
      try { const cancel = latestCancel(runKey, request.runId, cancelHash); if (cancel?.mode === "immediate") { immediate = cancel; killWorkerTree(child.pid); } }
      catch (error) { forcedError = `cancellation channel verification failed: ${redactWorkerText(error.message || error, 800)}`; killWorkerTree(child.pid); }
    }, 200);
    const timeout = setTimeout(() => { forcedError = "step timed out"; killWorkerTree(child.pid); }, step.timeoutMs);
    child.on("error", (error) => finish({ ok: false, code: -1, error: redactWorkerText(error.message || error, 1200) }));
    child.on("close", (code) => finish(forcedError ? { ok: false, interrupted: true, code: -1, error: forcedError }
      : immediate ? { ok: false, cancelled: true, cancel: immediate, code: -1 }
      : { ok: code === 0, code: Number.isInteger(code) ? code : -1, error: code === 0 ? "" : `step exited with code ${code}` }));
  });
}

let sandbox;
let executorAttestation;
function fileAttestation(path) {
  const real = realpathSync(path); const metadata = statSync(real, { bigint: true });
  if (!metadata.isFile()) throw new Error("toolchain path is not a regular file");
  return { path: real, sha256: sha256(readFileSync(real)), dev: String(metadata.dev), ino: String(metadata.ino) };
}
function measureExecutorAttestation() {
  if (JSON.stringify(allowedPrograms) !== JSON.stringify(["node", "godot"])) throw new Error("executor toolchain allowlist is not the reviewed node,godot set");
  const detected = { node: realpathSync("/opt/dominion-payload/node"), godot: realpathSync("/opt/dominion-payload/godot") };
  const workspaceMetadata = statSync(workspace, { bigint: true });
  return { detected, workspace: { path: workspace, dev: String(workspaceMetadata.dev), ino: String(workspaceMetadata.ino) },
    toolchain: { node: fileAttestation(detected.node), godot: fileAttestation(detected.godot) } };
}
function recheckExecutorAttestation(expected) {
  const current = measureExecutorAttestation();
  if (sha256(JSON.stringify(stable(current))) !== sha256(JSON.stringify(stable(expected)))) {
    throw new Error("executor workspace or toolchain identity changed after command authorization");
  }
}
function publishReadiness() {
  durableReplace(join(replies, "executor-ready.json"), JSON.stringify({ protocol: PROTOCOL, executorId,
    updatedAt: new Date().toISOString(), programs: allowedPrograms, detected: executorAttestation.detected,
    workspace: executorAttestation.workspace, toolchain: executorAttestation.toolchain,
    sandbox: { kind: "fd-launcher", version: sandbox.version, sha256: sandbox.sha256,
      appArmorComponents: sandbox.appArmorComponents,
      seccomp: { node: { sha256: sandbox.seccomp.node.sha256 }, godot: { sha256: sandbox.seccomp.godot.sha256 } },
      appArmorPolicySha256, outerSeccompSha256 },
    boundary: "directional-spool-separate-cgroup-no-network" }, null, 2) + "\n");
}

export function classifyExecutorRecovery(events, stepCount) {
  const latest = events.at(-1);
  if (!latest) return { action: "accept", completedSteps: 0 };
  if (GAME_FACTORY_TERMINAL_STATES.includes(latest.status)) {
    return { action: "terminal", completedSteps: Number(latest.checkpoint?.completedSteps) || 0 };
  }
  if (latest.status === "STEP_STARTED") {
    return { action: "interrupt", completedSteps: Number(latest.checkpoint?.completedSteps) || 0 };
  }
  if (!["ACCEPTED", "STEP_SUCCEEDED"].includes(latest.status)) throw new Error("executor recovery state is invalid");
  const completedSteps = Number(latest.checkpoint?.completedSteps);
  if (!Number.isInteger(completedSteps) || completedSteps < 0 || completedSteps > stepCount) {
    throw new Error("executor recovery checkpoint is invalid");
  }
  return { action: "resume", completedSteps };
}

async function executeCommand(path) {
  const command = verifyControllerCommand(path, "START");
  if (command.requestHash !== workerRequestHash(command.request)) throw new Error("controller request hash is invalid");
  const runKey = sha256(command.request.runId).slice(0, 32);
  if (path !== join(commands, `start-${runKey}.json`)) throw new Error("START filename is not bound to its runId");
  const events = readSpoolEvents(replies, runKey, { ownerUid: process.getuid?.() ?? 10002,
    ownerGid: GAME_FACTORY_SPOOL_GID, quarantine: true });
  let latest = events.at(-1);
  if (latest && GAME_FACTORY_TERMINAL_STATES.includes(latest.status)) return;

  const expectedSandbox = command.request.policy?.sandbox;
  const measuredSandbox = { kind: "fd-launcher", version: sandbox.version, sha256: sandbox.sha256,
    appArmorComponents: sandbox.appArmorComponents,
    seccomp: { node: { sha256: sandbox.seccomp.node.sha256 }, godot: { sha256: sandbox.seccomp.godot.sha256 } },
    appArmorPolicySha256, outerSeccompSha256 };
  if (sha256(JSON.stringify(stable(expectedSandbox))) !== sha256(JSON.stringify(stable(measuredSandbox)))) {
    throw new Error("command sandbox policy differs from the measured executor");
  }
  if (JSON.stringify(command.request.policy?.allowedPrograms) !== JSON.stringify(allowedPrograms)
      || command.request.policy?.executor !== "external-static") {
    throw new Error("controller command policy is not the reviewed external executor policy");
  }
  const normalized = normalizeWorkerRequest(command.request, { roots: [workspace], allowedPrograms });
  const request = { ...normalized,
    policy: { ...normalized.policy, ...command.request.policy, sandbox: measuredSandbox, executor: "external-static" },
    controllerRequestHash: command.requestHash };
  const expectedExecutorAttestation = { detected: executorAttestation.detected,
    workspace: command.request.policy?.executorWorkspace, toolchain: command.request.policy?.toolchain };
  recheckExecutorAttestation(expectedExecutorAttestation);
  if (request.workspaceIdentity.dev !== expectedExecutorAttestation.workspace?.dev
      || request.workspaceIdentity.ino !== expectedExecutorAttestation.workspace?.ino) {
    throw new Error("executor workspace identity differs from the controller-pinned readiness record");
  }
  const authorizedPolicyHash = sha256(JSON.stringify(stable(command.request.policy)));
  if (!latest) {
    latest = appendEvent(runKey, { runId: request.runId, taskId: request.taskId, projectId: request.projectId,
      capability: request.capability, status: "ACCEPTED", requestHash: command.requestHash, policyHash: authorizedPolicyHash,
      sandbox: measuredSandbox, checkpoint: { completedSteps: 0, safeBoundary: true } });
  }
  const recoveryEvents = events.length ? events : [latest];
  const recovery = classifyExecutorRecovery(recoveryEvents, request.plan.steps.length);
  if (recovery.action === "interrupt") {
    appendEvent(runKey, { runId: request.runId, status: "INTERRUPTED", endedAt: new Date().toISOString(),
      error: "executor stopped after STEP_STARTED; the step was not automatically replayed",
      checkpoint: latest.checkpoint, sandbox: measuredSandbox });
    return;
  }
  let completed = recovery.completedSteps;
  const runHome = join(runtime, "payload");
  mkdirSync(runHome, { recursive: true, mode: 0o700 }); chmodSync(runHome, 0o700);
  for (const name of ["tmp", "config", "cache", "data"]) {
    const path = join(runHome, name); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  }

  try {
    for (let index = completed; index < request.plan.steps.length; index++) {
      recheckExecutorAttestation(expectedExecutorAttestation);
      const before = latestCancel(runKey, request.runId, command.requestHash);
      if (before) {
        appendEvent(runKey, { runId: request.runId, status: before.mode === "immediate" ? "CANCELLED" : "PAUSED",
          cancelMode: before.mode, endedAt: new Date().toISOString(), result: { reason: before.reason },
          checkpoint: { completedSteps: index, safeBoundary: true }, sandbox: measuredSandbox }); return;
      }
      latest = appendEvent(runKey, { runId: request.runId, status: "STEP_STARTED",
        startedAt: latest.startedAt || new Date().toISOString(), currentStep: index,
        checkpoint: { completedSteps: index, safeBoundary: true }, sandbox: measuredSandbox });
      const result = await processStep(request.plan.steps[index], request, runKey, runHome,
        { node: sandbox.seccomp.node.path, godot: sandbox.seccomp.godot.path }, command.requestHash);
      const atExit = latestCancel(runKey, request.runId, command.requestHash);
      if (result.cancelled || atExit?.mode === "immediate") {
        appendEvent(runKey, { runId: request.runId, status: "CANCELLED", cancelMode: "immediate",
          endedAt: new Date().toISOString(), checkpoint: { completedSteps: index, safeBoundary: false }, sandbox: measuredSandbox }); return;
      }
      if (result.interrupted) {
        appendEvent(runKey, { runId: request.runId, status: "INTERRUPTED", endedAt: new Date().toISOString(),
          currentStep: index, error: result.error, checkpoint: { completedSteps: index, safeBoundary: false }, sandbox: measuredSandbox }); return;
      }
      if (!result.ok) {
        appendEvent(runKey, { runId: request.runId, status: "FAILED", endedAt: new Date().toISOString(),
          currentStep: index, exitCode: result.code, error: result.error,
          checkpoint: { completedSteps: index, safeBoundary: true }, sandbox: measuredSandbox }); return;
      }
      completed = index + 1;
      latest = appendEvent(runKey, { runId: request.runId, status: "STEP_SUCCEEDED", currentStep: completed,
        checkpoint: { completedSteps: completed, lastStep: request.plan.steps[index].label, safeBoundary: true }, sandbox: measuredSandbox });
      const after = latestCancel(runKey, request.runId, command.requestHash);
      if (after) {
        appendEvent(runKey, { runId: request.runId, status: after.mode === "immediate" ? "CANCELLED" : "PAUSED",
          cancelMode: after.mode, endedAt: new Date().toISOString(), checkpoint: latest.checkpoint,
          result: { reason: after.reason }, sandbox: measuredSandbox }); return;
      }
    }
    let finalCancel = latestCancel(runKey, request.runId, command.requestHash);
    const artifacts = collectRunArtifacts(request);
    finalCancel = latestCancel(runKey, request.runId, command.requestHash) || finalCancel;
    if (finalCancel) {
      appendEvent(runKey, { runId: request.runId, status: finalCancel.mode === "immediate" ? "CANCELLED" : "PAUSED",
        cancelMode: finalCancel.mode, endedAt: new Date().toISOString(), checkpoint: latest.checkpoint,
        result: { reason: finalCancel.reason }, sandbox: measuredSandbox }); return;
    }
    appendEvent(runKey, { runId: request.runId, status: "SUCCEEDED", endedAt: new Date().toISOString(),
      checkpoint: { completedSteps: completed, complete: true, safeBoundary: true }, result: { stepsCompleted: completed },
      artifacts, sandbox: measuredSandbox });
  } catch (error) {
    const current = readSpoolEvents(replies, runKey, { ownerUid: process.getuid?.() ?? 10002,
      ownerGid: GAME_FACTORY_SPOOL_GID, quarantine: true }).at(-1);
    if (!current || GAME_FACTORY_TERMINAL_STATES.includes(current.status)) return;
    appendEvent(runKey, { runId: request.runId, status: current.status === "STEP_STARTED" ? "INTERRUPTED" : "FAILED",
      endedAt: new Date().toISOString(), error: redactWorkerText(error.message || error, 1200),
      checkpoint: current.checkpoint, sandbox: measuredSandbox });
  }
}

async function main() {
  const parentName = readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim();
  if (parentName !== "flock") throw new Error("executor lifetime is not guarded by the required kernel flock owner");
  if (Object.keys(process.env).some((key) => /^(?:HANDS_TOKEN|HANDS_URL|HANDS_CF_CLIENT|DATABASE_URL|.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL).*)$/i.test(key))) {
    throw new Error("executor environment contains a control-plane credential variable");
  }
  for (const path of [commands, replies, workspace, runtime]) if (!statSync(path).isDirectory()) throw new Error("executor mount is missing");
  // Recovery runs only after the lifetime flock is held, so a losing executor can never mutate
  // reply publication markers or hard-link crash remnants.
  recoverDurableTree(replies, { ownerUid: process.getuid?.() ?? 10002, ownerGid: GAME_FACTORY_SPOOL_GID });
  if (!/^[a-f0-9]{64}$/.test(appArmorPolicySha256) || !/^[a-f0-9]{64}$/.test(outerSeccompSha256)) {
    throw new Error("executor policy source and outer seccomp digests are not pinned");
  }
  const payloadRuntime = join(runtime, "payload");
  mkdirSync(payloadRuntime, { recursive: true, mode: 0o700 }); chmodSync(payloadRuntime, 0o700);
  for (const name of ["tmp", "config", "cache", "data"]) {
    const path = join(payloadRuntime, name); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  }
  sandbox = await probeWorkerSandbox({ program: sandboxProgram, sha256: sandboxSha256,
    nodeSeccompPath, nodeSeccompSha256, godotSeccompPath, godotSeccompSha256,
    workspaceRoot: workspace, runtimeHome: payloadRuntime,
    protectedRoots: [commands, replies, workspace, runtime, "/app"] });
  if (!sandbox.ok) throw new Error(sandbox.error || "executor sandbox probe failed");
  executorAttestation = measureExecutorAttestation();
  publishReadiness();
  const heartbeat = setInterval(publishReadiness, 2_000); heartbeat.unref?.();
  while (true) {
    const starts = readdirSync(commands).filter((name) => /^start-[a-f0-9]{32}\.json$/.test(name)).sort();
    for (const name of starts) {
      try { await executeCommand(join(commands, name)); }
      catch (error) {
        if (error?.code === "SPOOL_PUBLICATION_PENDING" && String(error.spoolDirectory || "") === commands) continue;
        if (error?.code === "SPOOL_PUBLICATION_PENDING") throw error;
        const quarantine = join(replies, "quarantine"); mkdirSync(quarantine, { recursive: true, mode: 0o2750 });
        chmodSync(quarantine, 0o2750); if (process.platform !== "win32") chownSync(quarantine, -1, GAME_FACTORY_SPOOL_GID);
        const rejectionKey = sha256(name).slice(0, 32);
        const rejectionPath = join(quarantine, `command-${rejectionKey}.json`);
        const rejection = { protocol: PROTOCOL, sourceName: name, rejectionKey,
          quarantinedAt: new Date().toISOString(), error: redactWorkerText(error.message || error, 1200) };
        try { durableNoReplace(rejectionPath, JSON.stringify(rejection, null, 2) + "\n"); }
        catch (publishError) {
          if (publishError?.code !== "EEXIST") throw publishError;
          const prior = readTrustedJson(rejectionPath, { ownerUid: process.getuid?.() ?? 10002,
            ownerGid: GAME_FACTORY_SPOOL_GID, maxBytes: 64_000 });
          if (prior?.protocol !== PROTOCOL || prior.sourceName !== name || prior.rejectionKey !== rejectionKey) throw publishError;
        }
      }
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
