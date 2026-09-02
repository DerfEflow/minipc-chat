/* Token-bearing game-factory controller. It only publishes immutable commands and reads replies. */
import {
  existsSync, statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, posix, resolve } from "node:path";
import {
  GAME_FACTORY_EXECUTOR_PROTOCOL, GAME_FACTORY_SPOOL_GID, GAME_FACTORY_WORKER_PROTOCOL, durableNoReplace, readSpoolEvents,
  readTrustedJson, readTrustedText, redactWorkerText, sanitizeWorkerValue, sha256Text,
  spoolCommandHash, workerRequestHash,
} from "./gamefactory-ipc.mjs";

const TERMINAL = new Set(["SUCCEEDED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"]);
const clean = (value, max = 500) => String(value == null ? "" : value).trim().slice(0, max);
const hash = sha256Text;
function exact(value, name, max = 240) {
  const raw = String(value == null ? "" : value).trim();
  const result = clean(raw, max);
  if (!result || result !== raw || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${name} is invalid`);
  if (redactWorkerText(result, result.length) !== result) throw new Error(`${name} contains credential material`);
  return result;
}
function underPosix(path, root) {
  const rel = posix.relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
}
function publicEvent(event, fallback = {}) {
  return sanitizeWorkerValue({
    runId: event?.runId || fallback.runId, taskId: event?.taskId || fallback.taskId,
    projectId: event?.projectId || fallback.projectId, capability: event?.capability || fallback.capability,
    status: event?.status || "QUEUED", revision: event?.sequence || 0,
    createdAt: fallback.createdAt, startedAt: event?.startedAt, endedAt: event?.endedAt,
    updatedAt: event?.at || fallback.createdAt, runnerPid: 0, childPid: 0,
    currentStep: event?.currentStep, checkpoint: event?.checkpoint, result: event?.result,
    error: event?.error, exitCode: event?.exitCode, cancelMode: event?.cancelMode,
    artifacts: event?.artifacts, sandbox: event?.sandbox,
  });
}

export function normalizeSpoolRequest(input, {
  workspaceRoot = "/workspace", allowedPrograms = ["node", "godot"], allowedCapabilities = ["quality_assurance", "godot"],
} = {}) {
  const runId = exact(input?.runId, "runId");
  const taskId = exact(input?.taskId, "taskId");
  const projectId = exact(input?.projectId, "projectId");
  const buildId = input?.buildId ? exact(input.buildId, "buildId") : "";
  const capability = exact(input?.capability, "capability", 100).toLowerCase();
  if (!allowedCapabilities.includes(capability)) throw new Error("capability is not enabled on this Web/QA worker");
  const attempt = input?.attempt == null ? 1 : Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  const configuredWorkspace = posix.normalize(workspaceRoot);
  const workspace = posix.normalize(String(input?.workspaceRoot || ""));
  if (!posix.isAbsolute(workspace) || workspace !== String(input?.workspaceRoot || "") || workspace !== configuredWorkspace) {
    throw new Error("workspaceRoot must be the executor's one exact project workspace mount");
  }
  const programs = [...new Set(allowedPrograms.map((item) => clean(item, 100).toLowerCase()).filter(Boolean))];
  const rawSteps = input?.plan?.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length || rawSteps.length > 24) throw new Error("plan.steps must contain 1-24 steps");
  const steps = rawSteps.map((step, index) => {
    const program = basename(String(step?.program || "")).replace(/\.(?:exe|com)$/i, "").toLowerCase();
    if (!programs.includes(program)) throw new Error(`step ${index + 1} program is not allowed`);
    const args = Array.isArray(step.args) ? step.args.map(String) : [];
    if (args.length > 160 || args.some((arg) => arg.length > 16_000 || arg.includes("\0") || redactWorkerText(arg, arg.length) !== arg)) {
      throw new Error(`step ${index + 1} arguments are invalid or contain credential material`);
    }
    const cwd = posix.normalize(isAbsolute(String(step.cwd || "")) ? String(step.cwd) : posix.join(workspace, String(step.cwd || ".")));
    if (!underPosix(cwd, workspace)) throw new Error(`step ${index + 1} cwd escapes the workspace`);
    for (const arg of args) {
      if (posix.isAbsolute(arg) && !underPosix(posix.normalize(arg), workspace)) throw new Error(`step ${index + 1} argument escapes the workspace`);
    }
    return { label: clean(step.label, 160) || `step ${index + 1}`, program, args, cwd,
      timeoutMs: Math.min(Math.max(Number(step.timeoutMs) || 600_000, 1_000), 1_800_000) };
  });
  const collect = (Array.isArray(input?.plan?.collect) ? input.plan.collect : []).map((item) => {
    const value = String(item || "");
    if (!value || posix.isAbsolute(value) || !underPosix(posix.normalize(posix.join(workspace, value)), workspace)) {
      throw new Error("artifact paths must be relative to the workspace");
    }
    return value;
  });
  return { protocol: GAME_FACTORY_WORKER_PROTOCOL, runId, taskId, projectId, buildId, capability, attempt,
    workspaceRoot: workspace, plan: { steps, collect }, resumeFrom: input?.resumeFrom || null,
    policy: { allowedPrograms: programs, allowedCapabilities: allowedCapabilities.slice(), maxLogBytes: 5_000_000 },
    createdAt: new Date().toISOString() };
}

export function createGameFactorySpoolController({
  commandDir = "", replyDir = "", node = "", workspaceRoot = "/workspace",
  allowedPrograms = ["node", "godot"], allowedCapabilities = ["quality_assurance", "godot"],
  isolationAttested = false, toolchainAttested = false, sandboxSha256 = "",
  nodeSeccompSha256 = "", godotSeccompSha256 = "", appArmorPolicySha256 = "", outerSeccompSha256 = "",
  spoolGid = GAME_FACTORY_SPOOL_GID, executorOwnerUid = 10002,
} = {}) {
  const commands = resolve(commandDir); const replies = resolve(replyDir); const nodeName = clean(node, 160).toLowerCase();
  const controllerUid = process.getuid?.() ?? null; const executorUid = Number(executorOwnerUid);
  const expectedSandbox = { kind: "fd-launcher", version: "dominion-fd-launcher/1",
    sha256: clean(sandboxSha256, 64).toLowerCase(),
    appArmorComponents: {
      launcher: ["dominion-gx10-fd-launcher", "dominion-gx10-gamefactory-executor"],
      node: ["dominion-gx10-fd-launcher", "dominion-gx10-gamefactory-executor", "dominion-gx10-payload-node"],
      godot: ["dominion-gx10-fd-launcher", "dominion-gx10-gamefactory-executor", "dominion-gx10-payload-godot"],
    },
    seccomp: { node: { sha256: clean(nodeSeccompSha256, 64).toLowerCase() },
      godot: { sha256: clean(godotSeccompSha256, 64).toLowerCase() } },
    appArmorPolicySha256: clean(appArmorPolicySha256, 64).toLowerCase(),
    outerSeccompSha256: clean(outerSeccompSha256, 64).toLowerCase(),
  };
  const configured = !!commandDir && !!replyDir;
  function readiness() {
    let ready = null;
    try { ready = readTrustedJson(posix.join(replies, "executor-ready.json"), { ownerUid: executorUid, ownerGid: spoolGid, maxBytes: 64_000 }); } catch {}
    const readyAt = Date.parse(ready?.updatedAt || ""); const skew = Date.now() - readyAt;
    if (!ready || ready.protocol !== "game-factory-executor/1" || !Number.isFinite(readyAt) || skew < -5_000 || skew > 10_000) return null;
    if (hash(JSON.stringify(ready.sandbox)) !== hash(JSON.stringify(expectedSandbox))) return null;
    if (JSON.stringify(ready.programs) !== JSON.stringify(allowedPrograms)) return null;
    if (ready.workspace?.path !== workspaceRoot || !/^\d+$/.test(String(ready.workspace?.dev || ""))
        || !/^\d+$/.test(String(ready.workspace?.ino || ""))) return null;
    if (!ready.toolchain || JSON.stringify(Object.keys(ready.toolchain).sort()) !== JSON.stringify(["godot", "node"])
        || Object.values(ready.toolchain).some((item) => !item?.path || !/^[a-f0-9]{64}$/.test(item.sha256 || "")
          || !/^\d+$/.test(String(item.dev || "")) || !/^\d+$/.test(String(item.ino || "")))) return null;
    return ready;
  }
  function ensureReady() {
    if (!configured) throw new Error("external game-factory spool directories are not configured");
    if (!isolationAttested) throw new Error("game factory execution requires an explicit external isolation attestation");
    if (!toolchainAttested) throw new Error("game factory execution requires an explicit toolchain attestation");
    if (!statSync(commands).isDirectory()) throw new Error("controller command mount is unavailable");
    if (!existsSync(replies)) throw new Error("executor reply mount is unavailable");
    const ready = readiness();
    if (!ready) throw new Error("the tokenless external executor is unavailable or its measured policy differs");
    return ready;
  }
  function readStart(path, runKey) {
    const value = readTrustedJson(path, { ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 1_000_000 });
    if (!value || value.protocol !== GAME_FACTORY_EXECUTOR_PROTOCOL || value.command !== "START"
        || value.commandHash !== spoolCommandHash(value) || value.requestHash !== workerRequestHash(value.request)
        || hash(exact(value.request?.runId, "runId")).slice(0, 32) !== runKey) {
      throw new Error("existing START command is not a valid immutable envelope");
    }
    return value;
  }
  function readAttempt(path, attemptKey) {
    const value = readTrustedJson(path, { ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 64_000 });
    if (!value || value.protocol !== GAME_FACTORY_EXECUTOR_PROTOCOL || value.command !== "ATTEMPT"
        || value.attemptKey !== attemptKey || value.commandHash !== spoolCommandHash(value)) {
      throw new Error("existing attempt claim is not a valid immutable envelope");
    }
    return value;
  }
  function describe() {
    const ready = readiness();
    const secure = isolationAttested === true && toolchainAttested === true && !!ready;
    return { protocol: GAME_FACTORY_WORKER_PROTOCOL, configured, node: nodeName, programs: allowedPrograms.slice(),
      capabilities: allowedCapabilities.slice(), maxConcurrent: 1, state: secure ? "ready" : configured ? "blocked" : "disabled",
      isolationAttested: isolationAttested === true, toolchainAttested: toolchainAttested === true,
      externalExecutor: true, separateExecutorCgroup: true, sandboxRequired: true, sandboxReady: !!ready,
      sandbox: ready?.sandbox || null, secureForUntrustedCode: secure };
  }
  function probe() {
    try { const ready = ensureReady(); return { ok: true, node: nodeName, ...describe(), executorId: ready.executorId, detected: ready.detected }; }
    catch (error) { return { ok: false, node: nodeName, ...describe(), error: redactWorkerText(error.message || error, 1200) }; }
  }
  function findCommand(runId) { const runKey = hash(exact(runId, "runId")).slice(0, 32); return { runKey, path: posix.join(commands, `start-${runKey}.json`) }; }
  function start(input) {
    try {
      const ready = ensureReady();
      const request = normalizeSpoolRequest(input, { workspaceRoot, allowedPrograms, allowedCapabilities });
      request.policy.sandbox = expectedSandbox;
      request.policy.executor = "external-static";
      request.policy.executorWorkspace = ready.workspace;
      request.policy.toolchain = ready.toolchain;
      const requestHash = workerRequestHash(request);
      const envelope = { protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, command: "START", commandId: randomUUID(), requestHash, request };
      envelope.commandHash = spoolCommandHash(envelope);
      const target = findCommand(request.runId);
      const attemptKey = hash(`${request.projectId}\0${request.taskId}\0${request.attempt}`).slice(0, 32);
      const attemptIndex = { protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, command: "ATTEMPT", commandId: randomUUID(),
        attemptKey, runId: request.runId, requestHash };
      attemptIndex.commandHash = spoolCommandHash(attemptIndex);
      const attemptPath = posix.join(commands, `attempt-${attemptKey}.json`);
      // A pre-existing run conflict must not poison a previously-unused attempt key. With one
      // fixed controller writer this preflight also makes the two immutable claims recoverable.
      let priorRun = null;
      try { priorRun = readStart(target.path, target.runKey); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (priorRun && priorRun.requestHash !== requestHash) {
        return { ok: false, conflict: true, retryable: false, node: nodeName, runId: request.runId, error: "runId already belongs to a different immutable command" };
      }
      try { durableNoReplace(attemptPath, JSON.stringify(attemptIndex, null, 2) + "\n", 0o640, { gid: spoolGid }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const priorAttempt = readAttempt(attemptPath, attemptKey);
        if (priorAttempt.runId !== request.runId || priorAttempt.requestHash !== requestHash) {
          return { ok: false, conflict: true, retryable: false, node: nodeName, runId: request.runId, error: "this task attempt belongs to another immutable run" };
        }
      }
      if (priorRun) {
        const event = readSpoolEvents(replies, target.runKey, { ownerUid: executorUid, ownerGid: spoolGid }).at(-1);
        return { ok: true, replayed: true, node: nodeName, ...publicEvent(event, priorRun.request) };
      }
      try { durableNoReplace(target.path, JSON.stringify(envelope, null, 2) + "\n", 0o640, { gid: spoolGid }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const prior = readStart(target.path, target.runKey);
        if (prior.requestHash !== requestHash) return { ok: false, conflict: true, retryable: false, node: nodeName, runId: request.runId, error: "runId already belongs to a different immutable command" };
        const event = readSpoolEvents(replies, target.runKey, { ownerUid: executorUid, ownerGid: spoolGid }).at(-1);
        return { ok: true, replayed: true, node: nodeName, ...publicEvent(event, prior.request) };
      }
      return { ok: true, node: nodeName, ...publicEvent(null, request) };
    } catch (error) { return { ok: false, node: nodeName, error: redactWorkerText(error.message || error, 1200) }; }
  }
  function status(runId) {
    try {
      const target = findCommand(runId); let command = null;
      try { command = readStart(target.path, target.runKey); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (!command) return { ok: false, notFound: true, node: nodeName, runId: clean(runId, 240), error: "unknown game factory run" };
      const event = readSpoolEvents(replies, target.runKey, { ownerUid: executorUid, ownerGid: spoolGid }).at(-1);
      return { ok: event?.status !== "INTERRUPTED", retryable: event?.status === "INTERRUPTED", node: nodeName, ...publicEvent(event, command.request) };
    } catch (error) { return { ok: false, node: nodeName, runId: clean(runId, 240), error: redactWorkerText(error.message || error, 1200) }; }
  }
  function cancel(runId, { mode = "safe", reason = "" } = {}) {
    try {
      const target = findCommand(runId); let command = null;
      try { command = readStart(target.path, target.runKey); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (!command) return { ok: false, commandAbsent: true, cancellationResolved: false,
        node: nodeName, runId: clean(runId, 240), error: "no immutable command exists for this game factory run; payload absence is not proven" };
      const current = readSpoolEvents(replies, target.runKey, { ownerUid: executorUid, ownerGid: spoolGid }).at(-1);
      if (TERMINAL.has(current?.status)) return { ok: true, replayed: true,
        cancellationResolved: current?.payloadDeathProof?.generationId === current?.payloadGenerationId,
        node: nodeName, ...publicEvent(current, command.request) };
      const cancelMode = String(mode).toLowerCase() === "immediate" ? "immediate" : "safe";
      const commandId = sha256Text(`${command.request.runId}\n${command.requestHash}\n${cancelMode}`);
      const item = { protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, command: "CANCEL", commandId, runId: command.request.runId,
        requestHash: command.requestHash, mode: cancelMode, reason: redactWorkerText(reason, 1000), requestedAt: new Date().toISOString() };
      item.commandHash = spoolCommandHash(item);
      const cancelPath = posix.join(commands, `cancel-${target.runKey}-${cancelMode}.json`);
      let replayed = false;
      try { durableNoReplace(cancelPath, JSON.stringify(item, null, 2) + "\n", 0o640, { gid: spoolGid }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const prior = readTrustedJson(cancelPath, { ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 64_000 });
        if (!prior || prior.protocol !== GAME_FACTORY_EXECUTOR_PROTOCOL || prior.command !== "CANCEL"
            || prior.commandId !== commandId || prior.runId !== command.request.runId
            || prior.requestHash !== command.requestHash || prior.mode !== cancelMode
            || prior.commandHash !== spoolCommandHash(prior)) {
          throw new Error("existing deterministic cancellation envelope is invalid or conflicts");
        }
        replayed = true;
      }
      return { ok: true, replayed, cancellationResolved: false, node: nodeName,
        ...publicEvent({ ...current, status: "CANCEL_REQUESTED", cancelMode }, command.request) };
    } catch (error) { return { ok: false, node: nodeName, runId: clean(runId, 240), error: redactWorkerText(error.message || error, 1200) }; }
  }
  function collect(runId) {
    const result = status(runId);
    if (result.notFound) return result;
    try {
      const { runKey } = findCommand(runId); const dir = posix.join(replies, `run-${runKey}`);
      const trustedLog = (name) => {
        try { return redactWorkerText(readTrustedText(posix.join(dir, name), { ownerUid: executorUid, ownerGid: spoolGid }), 64_000); }
        catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
      };
      return { ...result, stdout: trustedLog("stdout.log"), stderr: trustedLog("stderr.log") };
    } catch (error) {
      return { ...result, ok: false, stdout: "", stderr: "",
        error: `executor log verification failed: ${redactWorkerText(error.message || error, 1000)}` };
    }
  }
  return { describe, probe, start, status, cancel, collect };
}
