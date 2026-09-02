/* Workspace-blind token-bearing controller for the static binary broker. No spawn/toolchain code. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, posix, resolve } from "node:path";
import {
  BROKER_MAX_ARTIFACT_BYTES, BROKER_MAX_ARTIFACTS, BROKER_MAX_TOTAL_ARTIFACT_BYTES,
  decodeBrokerPruneReceipt, decodeBrokerReadiness, decodeBrokerResult, encodeBrokerAck,
  encodeBrokerCancel, encodeBrokerRequest,
} from "./gamefactory-broker-protocol.mjs";
import { brokerProject } from "./gamefactory-broker-projects.mjs";
import {
  durableNoReplace, durableRemoveTrusted, readTrustedBytes, readTrustedJson, redactWorkerText,
  sanitizeWorkerValue,
} from "./gamefactory-ipc.mjs";

const PROTOCOL = "game-factory-worker/1";
const HEX64 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const TERMINAL = new Set(["SUCCEEDED", "PAUSED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const RETENTION_TOMBSTONE_LIMIT = 256;
const RETENTION_RUN_LIMIT = 32;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ARTIFACT_MIME = Object.freeze({
  html: "text/html", js: "text/javascript", css: "text/css", json: "application/json",
  wasm: "application/wasm", pck: "application/octet-stream", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", txt: "text/plain", map: "application/json",
});
function fail(message) { throw new Error(message); }
function exact(value, name, max = 240) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > max
      || /[\u0000-\u001f\u007f]/.test(value) || redactWorkerText(value, max) !== value) fail(`${name} is invalid`);
  return value;
}
function relative(value, name, { root = false } = {}) {
  const path = exact(value, name, 2_000);
  if (path === ".") { if (root) return path; fail(`${name} must name a dedicated subtree`); }
  if (path.startsWith("/") || path.includes("\\")
      || path.split("/").some((part) => !part || part === "." || part === "..")) fail(`${name} is not canonical relative`);
  return path;
}
function artifactRelative(value, name) {
  const path = exact(value, name, 2_000);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) || path.endsWith("/")
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${name} is not a canonical artifact-relative file path`);
  }
  return path;
}
function mimeForArtifact(path) {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const mimeType = ARTIFACT_MIME[extension];
  if (!mimeType) fail("artifact path has no reviewed MIME type");
  return mimeType;
}
function normalizeNode(args) {
  let script = false, test = false, testIsolationNone = false;
  for (const arg of args) {
    if (arg.startsWith("@")) fail("Node response-file arguments are forbidden");
    if (script) continue;
    if (!arg.startsWith("-")) { relative(arg, "Node script"); script = true; continue; }
    if (arg === "--test") test = true;
    if (arg === "--test-isolation=none") testIsolationNone = true;
    const safe = /^(?:--|-c|--check|--test|--test-only|--test-isolation=none|--no-warnings|--trace-warnings|--enable-source-maps|--version|--test-concurrency=[1-9][0-9]*|--test-name-pattern=.{1,500}|--test-shard=[1-9][0-9]*\/[1-9][0-9]*|--unhandled-rejections=(?:strict|throw|warn|none)|--stack-trace-limit=[1-9][0-9]*)$/;
    if (!safe.test(arg)) fail("Node execution flag is outside the reviewed semantic policy");
  }
  if (test !== testIsolationNone) fail("Node test execution requires exact --test-isolation=none");
}
function normalizeGodot(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--headless", "--editor", "--quit", "--verbose", "--import"].includes(arg)) continue;
    if (arg === "--path") { relative(args[++index], "Godot project path", { root: true }); continue; }
    if (["--export-release", "--export-debug"].includes(arg)) {
      if (args[++index] !== "Web") fail("the static broker permits only the exact Web export preset");
      relative(args[++index], "Godot Web export output"); continue;
    }
    if (arg === "--rendering-method" && args[++index] === "gl_compatibility") continue;
    if (arg === "--audio-driver" && args[++index] === "Dummy") continue;
    if (arg === "--display-driver" && args[++index] === "headless") continue;
    fail("Godot argument is outside the reviewed Web-only semantic policy");
  }
}
function normalize(input) {
  const runId = exact(input?.runId, "runId"); if (!RUN_ID.test(runId)) fail("runId is not canonical");
  const taskId = exact(input?.taskId, "taskId"); const projectId = exact(input?.projectId, "projectId");
  const capability = exact(input?.capability, "capability", 100);
  if (!new Set(["quality_assurance", "godot"]).has(capability)) fail("capability is not enabled");
  let projectRelative = input?.projectRelative;
  if (!projectRelative && typeof input?.workspaceRoot === "string" && input.workspaceRoot.startsWith("/workspace/")) {
    projectRelative = input.workspaceRoot.slice("/workspace/".length);
  }
  projectRelative = relative(projectRelative, "projectRelative");
  const project = brokerProject(projectRelative);
  if (!project || (input?.workspaceRoot != null && input.workspaceRoot !== project.workspaceRoot)
      || (input?.projectQuotaId != null && Number(input.projectQuotaId) !== project.quotaId)) {
    fail("project workspace identity is not one of the reviewed fixed broker subtrees");
  }
  const projectQuotaId = project.quotaId;
  const rawSteps = input?.plan?.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length || rawSteps.length > 24) fail("plan.steps must contain 1-24 steps");
  const steps = rawSteps.map((step, index) => {
    const program = basename(String(step?.program || "")).toLowerCase();
    if (!new Set(["node", "godot"]).has(program)) fail(`step ${index + 1} program is not enabled`);
    if (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string"
        || Buffer.byteLength(arg) > 16_000 || /[\u0000-\u001f\u007f]/.test(arg)
        || redactWorkerText(arg, 16_000) !== arg)) fail(`step ${index + 1} argv is invalid`);
    if (step.args.length > 160) fail(`step ${index + 1} argv exceeds its bound`);
    if (program === "node") normalizeNode(step.args); else normalizeGodot(step.args);
    const cwdRelative = relative(step.cwdRelative || step.cwd || ".", `step ${index + 1} cwd`, { root: true });
    const timeoutMs = Math.min(Math.max(Number(step.timeoutMs) || 600_000, 1_000), 1_800_000);
    return { program, args: step.args.slice(), cwdRelative, timeoutMs,
      stdoutLimit: 524_288, stderrLimit: 524_288, totalLogLimit: 1_048_576 };
  });
  const rawCollect = input?.plan?.collect == null ? [] : input.plan.collect;
  if (!Array.isArray(rawCollect) || rawCollect.length > BROKER_MAX_ARTIFACTS) {
    fail(`plan.collect exceeds the ${BROKER_MAX_ARTIFACTS}-artifact bound`);
  }
  const collect = rawCollect.map((item, index) => {
    const path = artifactRelative(item, `plan.collect[${index}]`);
    mimeForArtifact(path);
    return path;
  }).sort();
  if (new Set(collect).size !== collect.length) fail("plan.collect contains duplicate artifact paths");
  const rawResume = input?.resumeFrom == null ? null : input.resumeFrom;
  let resumeFrom = null;
  let completedSteps = 0;
  if (rawResume != null) {
    if (!rawResume || typeof rawResume !== "object"
        || rawResume.protocol !== "game-factory-broker-resume/1") fail("resume lineage is not a broker checkpoint");
    completedSteps = Number(rawResume.completedSteps);
    if (!Number.isSafeInteger(completedSteps) || completedSteps < 1 || completedSteps >= steps.length
        || rawResume.safeBoundary !== true || rawResume.complete === true) {
      fail("resume lineage is not a non-final safe boundary");
    }
    resumeFrom = {
      protocol: rawResume.protocol,
      sourceRunId: exact(rawResume.sourceRunId, "resume sourceRunId"),
      sourceRequestHash: String(rawResume.sourceRequestHash || "").toLowerCase(),
      sourceResultSha256: String(rawResume.sourceResultSha256 || "").toLowerCase(),
      sourceGenerationId: String(rawResume.sourceGenerationId || "").toLowerCase(),
      sourceBrokerInstanceId: String(rawResume.sourceBrokerInstanceId || "").toLowerCase(),
      sourceBrokerBootIdSha256: String(rawResume.sourceBrokerBootIdSha256 || "").toLowerCase(),
      completedSteps, totalSteps: Number(rawResume.totalSteps), safeBoundary: true, complete: false,
    };
    for (const field of ["sourceRequestHash", "sourceResultSha256", "sourceGenerationId",
      "sourceBrokerInstanceId", "sourceBrokerBootIdSha256"]) {
      if (!HEX64.test(resumeFrom[field])) fail(`resume ${field} is invalid`);
    }
    if (!Number.isSafeInteger(resumeFrom.totalSteps) || resumeFrom.totalSteps !== steps.length) {
      fail("resume lineage total step count is invalid");
    }
  }
  return { runId, taskId, projectId, capability, projectRelative, projectQuotaId,
    steps, collect, completedSteps, resumeFrom };
}

export function createGameFactoryBrokerController({ commandDir = "", resultDir = "", replyDir = "",
  node = "gx10-gamefactory", brokerOwnerUid = 10003, spoolGid = 11000, expected = {},
  isolationAttested = false, toolchainAttested = false } = {}) {
  const commands = resolve(commandDir); const results = resolve(resultDir || replyDir);
  const controllerUid = process.getuid?.(); const brokerUid = Number(brokerOwnerUid);
  function requireSpoolDirectories() {
    if (process.platform !== "linux") return;
    const commandMetadata = lstatSync(commands); const resultMetadata = lstatSync(results);
    if (!commandMetadata.isDirectory() || commandMetadata.isSymbolicLink()
        || commandMetadata.uid !== controllerUid || commandMetadata.gid !== spoolGid
        || (commandMetadata.mode & 0o7777) !== 0o2750
        || !resultMetadata.isDirectory() || resultMetadata.isSymbolicLink()
        || resultMetadata.uid !== brokerUid || resultMetadata.gid !== spoolGid
        || (resultMetadata.mode & 0o7777) !== 0o2750) fail("broker spool ownership/mode contract is invalid");
  }
  function trusted(path, ownerUid = brokerUid, maxBytes = 1_000_000, allowEmpty = false) {
    return readTrustedBytes(path, { ownerUid, ownerGid: spoolGid, maxBytes, allowEmpty });
  }
  function readiness() {
    requireSpoolDirectories();
    const ready = decodeBrokerReadiness(trusted(posix.join(results, "broker-ready.bin"), brokerUid, 64_000));
    const age = Date.now() - Date.parse(ready.updatedAt);
    if (age < -5_000 || age > 30_000) fail("static broker readiness heartbeat is stale");
    const map = { brokerBinarySha256: "brokerBinarySha256", nodeGuardSha256: "nodeGuardSha256",
      godotGuardSha256: "godotGuardSha256", nodeExecutableSha256: "nodeExecutableSha256",
      godotExecutableSha256: "godotExecutableSha256", nodeFilterSha256: "nodeFilterSha256",
      godotFilterSha256: "godotFilterSha256", appArmorPolicySha256: "appArmorPolicySha256",
      outerSeccompSha256: "outerSeccompSha256", deploymentPolicySha256: "deploymentPolicySha256" };
    for (const [field, option] of Object.entries(map)) if (!HEX64.test(expected[option] || "")
        || ready[field] !== expected[option]) fail(`static broker ${field} differs from reviewed configuration`);
    if (process.platform === "linux") {
      const controllerCgroup = readFileSync("/proc/self/cgroup", "utf8");
      if (sha(controllerCgroup) === ready.brokerCgroupSha256) {
        fail("controller and static broker share a cgroup; separation proof is invalid");
      }
    }
    return ready;
  }
  function requireReady() {
    // These booleans are controller-side attestations from the hardened entrypoint. A valid
    // broker heartbeat alone is not authority to send untrusted work when either mount/toolchain
    // proof has been withheld or lost.
    if (isolationAttested !== true || toolchainAttested !== true) {
      fail("controller isolation/toolchain attestation is not present");
    }
    return readiness();
  }
  const runKey = (runId) => sha(exact(runId, "runId")).slice(0, 32);
  const journalPath = (runId) => posix.join(commands, `run-${runKey(runId)}.json`);
  const pausePath = (runId) => posix.join(commands, `pause-${runKey(runId)}.json`);
  const retentionPath = (runId) => posix.join(commands, `retention-${runKey(runId)}.json`);
  const tombstonePath = (runId) => posix.join(commands, `retained-${runKey(runId)}.json`);
  const expectedLabels = (projectRelative, program) => {
    const component = program === "node" ? "node" : "godot";
    const guard = `dominion-gx10-gamefactory-broker//&dominion-gx10-guard-${component}-${projectRelative} (enforce)`;
    return { guard, payload: `${guard.slice(0, -" (enforce)".length)}//&dominion-gx10-payload-${component}-${projectRelative} (enforce)` };
  };
  function buildJournal(request, ready) {
    const requestHash = sha(JSON.stringify(request)); let previousGenerationId = null;
    const remaining = request.steps.slice(request.completedSteps);
    if (!remaining.length) fail("broker request has no uncompleted steps to dispatch");
    const packets = remaining.map((step, stepIndex) => {
      const encoded = encodeBrokerRequest({ requestId: sha(`${request.runId}\n${requestHash}\n${stepIndex}`),
        runId: request.runId, requestHash, policyHash: ready.deploymentPolicySha256,
        brokerInstanceId: ready.brokerInstanceId, containerGenerationId: ready.containerGenerationId,
        program: step.program, projectRelative: request.projectRelative, projectQuotaId: request.projectQuotaId,
        cwdRelative: step.cwdRelative,
        timeoutMs: step.timeoutMs, stdoutLimit: step.stdoutLimit, stderrLimit: step.stderrLimit,
        totalLogLimit: step.totalLogLimit, stepIndex, totalSteps: remaining.length,
        previousGenerationId, workspaceDev: ready.workspaceDev, workspaceIno: ready.workspaceIno,
        args: step.args, collect: request.collect });
      previousGenerationId = encoded.generationId;
      return { generationId: encoded.generationId, packetSha256: sha(encoded.bytes), bytes: encoded.bytes.toString("base64") };
    });
    const journal = { protocol: "game-factory-controller-broker/1", request, requestHash,
      ready: {
        brokerInstanceId: ready.brokerInstanceId, containerGenerationId: ready.containerGenerationId,
        brokerBootIdSha256: ready.brokerBootIdSha256, brokerStarttime: ready.brokerStarttime,
        brokerPidNamespaceDev: ready.brokerPidNamespaceDev, brokerPidNamespaceIno: ready.brokerPidNamespaceIno,
        brokerCgroupSha256: ready.brokerCgroupSha256, brokerCgroupInode: ready.brokerCgroupInode,
        leaseDev: ready.leaseDev, leaseIno: ready.leaseIno, workspaceDev: ready.workspaceDev,
        workspaceIno: ready.workspaceIno, workspaceMountId: ready.workspaceMountId,
        workspaceMountIdentitySha256: ready.workspaceMountIdentitySha256, runtimeDev: ready.runtimeDev,
        runtimeIno: ready.runtimeIno, runtimeMountId: ready.runtimeMountId,
        runtimeMountIdentitySha256: ready.runtimeMountIdentitySha256,
        brokerBinarySha256: ready.brokerBinarySha256, nodeGuardSha256: ready.nodeGuardSha256,
        godotGuardSha256: ready.godotGuardSha256, nodeExecutableSha256: ready.nodeExecutableSha256,
        godotExecutableSha256: ready.godotExecutableSha256, nodeFilterSha256: ready.nodeFilterSha256,
        godotFilterSha256: ready.godotFilterSha256, appArmorPolicySha256: ready.appArmorPolicySha256,
        outerSeccompSha256: ready.outerSeccompSha256, deploymentPolicySha256: ready.deploymentPolicySha256,
        landlockAbi: ready.landlockAbi, landlockHandledAccessFs: ready.landlockHandledAccessFs,
        noNewPrivs: ready.noNewPrivs, seccompFilterCount: ready.seccompFilterCount,
        capsZero: ready.capsZero, maxConcurrent: ready.maxConcurrent,
      }, packets };
    if (Buffer.byteLength(JSON.stringify(journal), "utf8") > 900_000) {
      fail("controller run journal exceeds its bounded durable spool budget");
    }
    return journal;
  }
  function readJournal(runId) {
    const value = readTrustedJson(journalPath(runId), { ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 1_000_000 });
    if (value?.protocol !== "game-factory-controller-broker/1" || value.request?.runId !== runId
        || !Array.isArray(value.packets) || !value.packets.length) fail("controller run journal is invalid");
    for (const packet of value.packets) if (!HEX64.test(packet.generationId || "")
        || sha(Buffer.from(packet.bytes || "", "base64")) !== packet.packetSha256) fail("controller packet journal is invalid");
    return value;
  }
  function pauseEnvelope(journal, reason = "") {
    const commandId = sha(`${journal.request.runId}\n${journal.requestHash}\nPAUSE`);
    const body = {
      protocol: "game-factory-controller-broker/1", command: "PAUSE", commandId,
      runId: journal.request.runId, requestHash: journal.requestHash,
      reason: redactWorkerText(String(reason || ""), 1_000), requestedAt: new Date().toISOString(),
    };
    return { ...body, pauseHash: sha(JSON.stringify(body)) };
  }
  function readPause(journal) {
    try {
      const value = readTrustedJson(pausePath(journal.request.runId), {
        ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 16_000,
      });
      const expectedCommandId = sha(`${journal.request.runId}\n${journal.requestHash}\nPAUSE`);
      const body = {
        protocol: value?.protocol, command: value?.command, commandId: value?.commandId,
        runId: value?.runId, requestHash: value?.requestHash, reason: value?.reason,
        requestedAt: value?.requestedAt,
      };
      if (body.protocol !== "game-factory-controller-broker/1" || body.command !== "PAUSE"
          || body.commandId !== expectedCommandId || body.runId !== journal.request.runId
          || body.requestHash !== journal.requestHash || typeof body.reason !== "string"
          || typeof body.requestedAt !== "string" || !Number.isFinite(Date.parse(body.requestedAt))
          || value.pauseHash !== sha(JSON.stringify(body))) fail("safe-pause envelope is invalid");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  function readArtifactManifest(journal, packet, index, result) {
    if (result.artifactManifestSha256 == null) return [];
    if (result.state !== "SUCCEEDED" || index !== journal.packets.length - 1) {
      fail("artifact manifest is attached to a non-final or unsuccessful generation");
    }
    const manifestName = `artifacts-${packet.generationId}.json`;
    const manifestBytes = trusted(posix.join(results, manifestName), brokerUid, 128_000);
    if (sha(manifestBytes) !== result.artifactManifestSha256) {
      fail("broker artifact manifest does not bind to result evidence");
    }
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch { fail("broker artifact manifest is not JSON"); }
    // The static broker emits a no-whitespace canonical JSON form. Reject alternate encodings so a
    // second parser cannot silently reinterpret path, MIME, or byte binding fields.
    if (!Buffer.from(JSON.stringify(manifest), "utf8").equals(manifestBytes)) {
      fail("broker artifact manifest is not canonical");
    }
    const expectedKeys = ["protocol", "generationId", "runId", "requestHash", "stepIndex", "totalSteps",
      "projectRelative", "artifacts", "totalBytes"];
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || JSON.stringify(Object.keys(manifest)) !== JSON.stringify(expectedKeys)
        || manifest.protocol !== "game-factory-broker-artifacts/1"
        || manifest.generationId !== packet.generationId || manifest.runId !== journal.request.runId
        || manifest.requestHash !== journal.requestHash || manifest.stepIndex !== index
        || manifest.totalSteps !== journal.packets.length || manifest.projectRelative !== journal.request.projectRelative
        || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== result.artifactCount
        || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== result.artifactTotalBytes
        || manifest.totalBytes < 0 || manifest.totalBytes > BROKER_MAX_TOTAL_ARTIFACT_BYTES) {
      fail("broker artifact manifest does not match the immutable dispatch");
    }
    const expectedPaths = journal.request.collect || [];
    if (manifest.artifacts.length !== expectedPaths.length) fail("broker artifact manifest omits or adds requested paths");
    let totalBytes = 0;
    const artifacts = manifest.artifacts.map((artifact, artifactIndex) => {
      const expectedArtifactKeys = ["path", "mimeType", "bytes", "sha256", "spoolName"];
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
          || JSON.stringify(Object.keys(artifact)) !== JSON.stringify(expectedArtifactKeys)
          || artifact.path !== expectedPaths[artifactIndex] || artifactRelative(artifact.path, "artifact path") !== artifact.path
          || artifact.mimeType !== mimeForArtifact(artifact.path) || !Number.isSafeInteger(artifact.bytes)
          || artifact.bytes < 0 || artifact.bytes > BROKER_MAX_ARTIFACT_BYTES
          || !HEX64.test(artifact.sha256 || "")
          || artifact.spoolName !== `artifact-${packet.generationId}-${artifactIndex}.bin`) {
        fail("broker artifact entry is invalid or does not bind to the requested path");
      }
      const bytes = trusted(posix.join(results, artifact.spoolName), brokerUid, BROKER_MAX_ARTIFACT_BYTES, true);
      if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256) {
        fail("broker artifact bytes do not bind to their manifest entry");
      }
      totalBytes += bytes.length;
      if (totalBytes > BROKER_MAX_TOTAL_ARTIFACT_BYTES) fail("broker artifact total exceeds its bound");
      return { path: artifact.path, mimeType: artifact.mimeType, size: artifact.bytes, sha256: artifact.sha256,
        spoolName: artifact.spoolName, ferry: "broker-result-spool" };
    });
    if (totalBytes !== manifest.totalBytes) fail("broker artifact total bytes do not bind to its manifest");
    return artifacts;
  }
  function verifyResultBinding(journal, packet, index, result) {
    const ready = journal.ready || {};
    const generationRejected = result.state === "INTERRUPTED" && result.exitCode === -1
      && result.payloadState === "never_started" && result.pid === 0 && result.starttime === ""
      && result.finalTransitionAttested === 0 && result.waitIdPid === 0
      && result.terminationReason === "broker_generation_mismatch"
      && result.pidfdKillOutcome === "none" && result.brokerInstanceId !== ready.brokerInstanceId;
    const restartUnresolved = result.state === "INTERRUPTED" && result.exitCode === -1
      && result.payloadState === "unresolved" && result.pid > 0 && !!result.starttime
      && result.finalTransitionAttested === 0 && result.waitIdPid === 0
      && result.terminationReason === "broker_restart"
      && result.pidfdKillOutcome === "none" && result.brokerInstanceId !== ready.brokerInstanceId;
    const replacementProof = generationRejected || restartUnresolved;
    let current = null;
    if (replacementProof) {
      // A broker can die after readiness was validated but before the immutable request appears.
      // Only the currently live, fully attested replacement broker may certify that the old target
      // generation never started. This narrow exception makes the race terminal without allowing a
      // replacement generation to execute stale controller bytes.
      current = readiness();
    }
    if (result.generationId !== packet.generationId || result.runId !== journal.request.runId
        || result.requestHash !== journal.requestHash || result.stepIndex !== index
        || result.totalSteps !== journal.packets.length || result.policyHash !== ready.deploymentPolicySha256
        || result.deploymentPolicySha256 !== ready.deploymentPolicySha256
        || (replacementProof
          ? result.brokerInstanceId !== current.brokerInstanceId
            || result.brokerBootIdSha256 !== current.brokerBootIdSha256
          : result.brokerInstanceId !== ready.brokerInstanceId
            || result.brokerBootIdSha256 !== ready.brokerBootIdSha256)) {
      fail("broker result does not match the immutable controller journal");
    }
    for (const field of ["brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256",
      "nodeExecutableSha256", "godotExecutableSha256", "nodeFilterSha256", "godotFilterSha256",
      "appArmorPolicySha256", "outerSeccompSha256"]) {
      if (result[field] !== (replacementProof ? current[field] : ready[field])) {
        fail(`broker result ${field} differs from its dispatch attestation`);
      }
    }
    if (result.payloadState === "reaped") {
      const labels = expectedLabels(journal.request.projectRelative, journal.request.steps[journal.request.completedSteps + index]?.program);
      if (result.measuredGuardAppArmorLabel !== labels.guard || result.expectedFinalAppArmorLabel !== labels.payload) {
        fail("broker result AppArmor labels do not bind to the selected project subtree");
      }
    }
  }
  function lineageFor(journal, index, result, resultBytes) {
    return {
      protocol: "game-factory-broker-resume/1", sourceRunId: journal.request.runId,
      sourceRequestHash: journal.requestHash, sourceResultSha256: sha(resultBytes),
      sourceGenerationId: result.generationId, sourceBrokerInstanceId: result.brokerInstanceId,
      sourceBrokerBootIdSha256: result.brokerBootIdSha256,
      completedSteps: journal.request.completedSteps + index + 1,
      totalSteps: journal.request.steps.length, safeBoundary: true, complete: false,
    };
  }
  function validateResumeLineage(request) {
    const lineage = request.resumeFrom;
    if (!lineage) return;
    if (!RUN_ID.test(lineage.sourceRunId)) fail("resume source run ID is invalid");
    const source = readJournal(lineage.sourceRunId);
    if (source.request.taskId !== request.taskId || source.request.projectId !== request.projectId
        || source.request.capability !== request.capability || source.request.projectRelative !== request.projectRelative
        || source.request.projectQuotaId !== request.projectQuotaId
        || JSON.stringify(source.request.steps) !== JSON.stringify(request.steps)
        || JSON.stringify(source.request.collect || []) !== JSON.stringify(request.collect)
        || source.requestHash !== lineage.sourceRequestHash) {
      fail("resume lineage does not bind to the same immutable task recipe");
    }
    const sourceIndex = lineage.completedSteps - Number(source.request.completedSteps || 0) - 1;
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= source.packets.length) {
      fail("resume lineage does not name a completed source generation");
    }
    const packet = source.packets[sourceIndex];
    const path = posix.join(results, `result-${packet.generationId}.bin`);
    const bytes = trusted(path);
    const result = decodeBrokerResult(bytes);
    verifyResultBinding(source, packet, sourceIndex, result);
    const sourcePause = readPause(source);
    if (!sourcePause || result.state !== "SUCCEEDED" || result.generationId !== lineage.sourceGenerationId
        || result.brokerInstanceId !== lineage.sourceBrokerInstanceId
        || result.brokerBootIdSha256 !== lineage.sourceBrokerBootIdSha256
        || sha(bytes) !== lineage.sourceResultSha256) {
      fail("resume lineage has no verified safe paused source boundary");
    }
  }
  function retentionBody(value) {
    return {
      protocol: value?.protocol, runId: value?.runId, requestHash: value?.requestHash,
      terminalStatus: value?.terminalStatus, runs: value?.runs, generations: value?.generations,
      acknowledgedAt: value?.acknowledgedAt,
    };
  }
  function validateRetention(value, expectedRunId = "") {
    const body = retentionBody(value);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value)) !== JSON.stringify([...Object.keys(body), "retentionSha256"])
        || body.protocol !== "game-factory-controller-retention/1"
        || body.runId !== expectedRunId || !RUN_ID.test(body.runId || "")
        || !HEX64.test(body.requestHash || "")
        || !new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]).has(body.terminalStatus)
        || !Array.isArray(body.runs) || !body.runs.length || body.runs.length > RETENTION_RUN_LIMIT
        || new Set(body.runs).size !== body.runs.length || body.runs.some((runId) => !RUN_ID.test(runId || ""))
        || !Array.isArray(body.generations) || !body.generations.length || body.generations.length > RETENTION_RUN_LIMIT * 24
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.acknowledgedAt || "")
        || !Number.isFinite(Date.parse(body.acknowledgedAt))
        || value.retentionSha256 !== sha(JSON.stringify(body))) fail("controller retention acknowledgement is invalid");
    const ids = new Set();
    for (const item of body.generations) {
      const keys = ["generationId", "resultSha256", "artifactManifestSha256"];
      if (!item || typeof item !== "object" || Array.isArray(item)
          || JSON.stringify(Object.keys(item)) !== JSON.stringify(keys)
          || !HEX64.test(item.generationId || "") || !HEX64.test(item.resultSha256 || "")
          || (item.artifactManifestSha256 != null && !HEX64.test(item.artifactManifestSha256 || ""))
          || ids.has(item.generationId)) fail("controller retention generation is invalid");
      ids.add(item.generationId);
    }
    return { ...body, retentionSha256: value.retentionSha256 };
  }
  function readRetention(runId) {
    return validateRetention(readTrustedJson(retentionPath(runId), {
      ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 1_000_000,
    }), runId);
  }
  function tombstoneBody(value) {
    return { protocol: value?.protocol, runId: value?.runId, prunedAt: value?.prunedAt, retention: value?.retention };
  }
  function validateTombstone(value, expectedRunId = "") {
    const body = tombstoneBody(value);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value)) !== JSON.stringify([...Object.keys(body), "tombstoneSha256"])
        || body.protocol !== "game-factory-controller-retained/1" || body.runId !== expectedRunId
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.prunedAt || "")
        || !Number.isFinite(Date.parse(body.prunedAt))
        || value.tombstoneSha256 !== sha(JSON.stringify(body))) fail("controller retention tombstone is invalid");
    return { ...body, retention: validateRetention(body.retention, expectedRunId), tombstoneSha256: value.tombstoneSha256 };
  }
  function readTombstone(runId) {
    return validateTombstone(readTrustedJson(tombstonePath(runId), {
      ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 1_000_000,
    }), runId);
  }
  function removeCommand(path) {
    return durableRemoveTrusted(path, { ownerUid: controllerUid, ownerGid: spoolGid, mode: 0o640 });
  }
  function cleanupControllerRetention(retention) {
    for (const item of retention.generations) {
      for (const prefix of ["request", "cancel", "ack"]) {
        removeCommand(posix.join(commands, `${prefix}-${item.generationId}.bin`));
      }
    }
    for (const sourceRunId of retention.runs) {
      removeCommand(pausePath(sourceRunId));
      removeCommand(journalPath(sourceRunId));
      if (sourceRunId !== retention.runId) removeCommand(retentionPath(sourceRunId));
    }
    removeCommand(retentionPath(retention.runId));
  }
  function pruneTombstones() {
    const entries = [];
    for (const name of readdirSync(commands)) {
      if (!/^retained-[a-f0-9]{32}\.json$/.test(name)) continue;
      const value = readTrustedJson(posix.join(commands, name), {
        ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 1_000_000,
      });
      const tombstone = validateTombstone(value, value?.runId);
      if (name !== `retained-${runKey(tombstone.runId)}.json`) fail("retention tombstone filename is not bound to its run");
      entries.push({ name, at: Date.parse(tombstone.prunedAt) });
    }
    entries.sort((left, right) => right.at - left.at || right.name.localeCompare(left.name));
    for (const entry of entries.slice(RETENTION_TOMBSTONE_LIMIT)) {
      removeCommand(posix.join(commands, entry.name));
    }
  }
  function buildRetention(journal, current, terminalResult, terminalBytes) {
    const runs = []; const generations = []; const seenRuns = new Set(); const seenGenerations = new Set();
    function appendRun(source, lastIndex) {
      if (seenRuns.has(source.request.runId)) fail("retention resume ancestry contains a cycle");
      if (seenRuns.size >= RETENTION_RUN_LIMIT) fail("retention resume ancestry exceeds its run bound");
      seenRuns.add(source.request.runId);
      if (source.request.resumeFrom) {
        const lineage = source.request.resumeFrom;
        const parent = readJournal(lineage.sourceRunId);
        const parentIndex = lineage.completedSteps - Number(parent.request.completedSteps || 0) - 1;
        if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= parent.packets.length) {
          fail("retention resume ancestry is invalid");
        }
        const parentPacket = parent.packets[parentIndex];
        const parentBytes = trusted(posix.join(results, `result-${parentPacket.generationId}.bin`));
        const parentResult = decodeBrokerResult(parentBytes);
        verifyResultBinding(parent, parentPacket, parentIndex, parentResult);
        if (sha(parentBytes) !== lineage.sourceResultSha256 || parentResult.generationId !== lineage.sourceGenerationId
            || parentResult.state !== "SUCCEEDED" || parentResult.payloadState === "unresolved") {
          fail("retention cannot prune an unverified resume ancestor");
        }
        appendRun(parent, parentIndex);
      }
      runs.push(source.request.runId);
      for (let index = 0; index <= lastIndex; index++) {
        const packet = source.packets[index];
        const resultBytes = source === journal && index === lastIndex
          ? terminalBytes : trusted(posix.join(results, `result-${packet.generationId}.bin`));
        const result = source === journal && index === lastIndex
          ? terminalResult : decodeBrokerResult(resultBytes);
        verifyResultBinding(source, packet, index, result);
        if (result.payloadState === "unresolved" || seenGenerations.has(packet.generationId)) {
          fail("retention cannot prune an unresolved or repeated generation");
        }
        if (result.artifactManifestSha256 != null) readArtifactManifest(source, packet, index, result);
        seenGenerations.add(packet.generationId);
        generations.push({ generationId: packet.generationId, resultSha256: sha(resultBytes),
          artifactManifestSha256: result.artifactManifestSha256 || null });
      }
    }
    appendRun(journal, Number(current.payloadStepIndex));
    const body = { protocol: "game-factory-controller-retention/1", runId: journal.request.runId,
      requestHash: journal.requestHash, terminalStatus: current.status, runs, generations,
      acknowledgedAt: new Date().toISOString() };
    return { ...body, retentionSha256: sha(JSON.stringify(body)) };
  }
  function publishPacket(journal, index) {
    const packet = journal.packets[index]; const target = posix.join(commands, `request-${packet.generationId}.bin`);
    const bytes = Buffer.from(packet.bytes, "base64");
    try { durableNoReplace(target, bytes, 0o640, { gid: null }); }
    catch (error) { if (error?.code !== "EEXIST" || !trusted(target, controllerUid).equals(bytes)) throw error; }
  }
  function prefix(journal, last) { return journal.packets.slice(0, last + 1).map((packet, stepIndex) => ({
    stepIndex, totalSteps: journal.packets.length, generationId: packet.generationId,
    previousGenerationId: stepIndex ? journal.packets[stepIndex - 1].generationId : null,
  })); }
  function checkpointFor(journal, index, result, resultBytes, { paused = false } = {}) {
    const completedSteps = journal.request.completedSteps + (result.state === "SUCCEEDED" ? index + 1 : index);
    const complete = result.state === "SUCCEEDED" && completedSteps === journal.request.steps.length;
    const checkpoint = { completedSteps, totalSteps: journal.request.steps.length, safeBoundary: true, complete };
    if (paused) checkpoint.lineage = lineageFor(journal, index, result, resultBytes);
    return checkpoint;
  }
  function publicResult(journal, index, result, resultBytes, { paused = false } = {}) {
    const generations = prefix(journal, index); const latest = generations.at(-1);
    const death = ["reaped", "child_reaped_unmeasured", "never_started"].includes(result.payloadState) ? {
      protocol: "game-factory-payload-death/1",
      state: result.payloadState === "child_reaped_unmeasured" ? "reaped" : result.payloadState,
      stepIndex: result.stepIndex, totalSteps: result.totalSteps,
      generationId: result.generationId, previousGenerationId: result.previousGenerationId,
      pid: result.payloadState === "never_started" ? null : result.pid,
      starttime: result.payloadState === "never_started" ? null : result.starttime,
      decisionId: result.payloadState === "never_started" ? result.decisionId : null,
      observedAt: result.observedAt,
    } : null;
    return sanitizeWorkerValue({ ok: true, node, runId: journal.request.runId, status: paused ? "PAUSED" : result.state,
      payloadStepIndex: latest.stepIndex, payloadTotalSteps: latest.totalSteps,
      payloadGenerationId: latest.generationId, payloadPreviousGenerationId: latest.previousGenerationId,
      payloadGenerations: generations, payloadDeathProof: death,
      cancellationResolved: !!death && TERMINAL.has(paused ? "PAUSED" : result.state), retryable: result.state === "INTERRUPTED",
      result: { exitCode: result.exitCode, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
        stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
        terminationReason: result.terminationReason, artifactManifestSha256: result.artifactManifestSha256,
        artifactCount: result.artifactCount, artifactTotalBytes: result.artifactTotalBytes },
      checkpoint: checkpointFor(journal, index, result, resultBytes, { paused }),
      ...(paused ? { pauseAtSafeBoundary: true } : {}), error: result.error || undefined });
  }
  function runningResult(journal, index, status = "RUNNING") {
    const packet = journal.packets[index];
    return { ok: true, node, runId: journal.request.runId, status,
      payloadStepIndex: index, payloadTotalSteps: journal.packets.length,
      payloadGenerationId: packet.generationId,
      payloadPreviousGenerationId: index ? journal.packets[index - 1].generationId : null,
      payloadGenerations: prefix(journal, index), cancellationResolved: false,
      checkpoint: { completedSteps: journal.request.completedSteps + index,
        totalSteps: journal.request.steps.length, safeBoundary: false, complete: false } };
  }
  function status(runId, { advance = true } = {}) {
    try {
      const journal = readJournal(exact(runId, "runId"));
      for (let index = 0; index < journal.packets.length; index++) {
        const packet = journal.packets[index]; const path = posix.join(results, `result-${packet.generationId}.bin`);
        if (!existsSync(path)) return runningResult(journal, index);
        const bytes = trusted(path); const result = decodeBrokerResult(bytes);
        verifyResultBinding(journal, packet, index, result);
        if (result.state !== "SUCCEEDED" || index === journal.packets.length - 1) return publicResult(journal, index, result, bytes);
        if (readPause(journal)) return publicResult(journal, index, result, bytes, { paused: true });
        if (!advance) return runningResult(journal, index + 1, "SAFE_BOUNDARY");
        publishPacket(journal, index + 1);
      }
      fail("controller state traversal failed");
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, commandAbsent: true, cancellationResolved: false,
        node, runId: String(runId || ""), error: "no controller authorization exists for this run" };
      return { ok: false, node, runId: String(runId || ""), error: redactWorkerText(error.message || error, 1200) };
    }
  }
  function start(input) {
    try {
      const ready = requireReady(); const request = normalize(input); validateResumeLineage(request);
      const journal = buildJournal(request, ready);
      const path = journalPath(request.runId);
      try { durableNoReplace(path, JSON.stringify(journal) + "\n", 0o640, { gid: null }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const prior = readJournal(request.runId);
        if (prior.requestHash !== journal.requestHash) return { ok: false, conflict: true, retryable: false,
          node, runId: request.runId, error: "runId already belongs to different immutable work" };
        return { ...status(request.runId), replayed: true };
      }
      publishPacket(journal, 0); const first = journal.packets[0];
      return { ok: true, node, runId: request.runId, status: "STARTING", payloadStepIndex: 0,
        payloadTotalSteps: journal.packets.length, payloadGenerationId: first.generationId,
        payloadPreviousGenerationId: null, payloadGenerations: prefix(journal, 0), cancellationResolved: false };
    } catch (error) { return { ok: false, node, runId: input?.runId, error: redactWorkerText(error.message || error, 1200) }; }
  }
  function cancel(runId, { mode = "immediate", reason = "" } = {}) {
    try {
      if (!new Set(["immediate", "safe"]).has(mode)) fail("cancellation mode is invalid");
      const current = status(runId, { advance: false }); if (!current.ok || TERMINAL.has(current.status)) return current;
      const journal = readJournal(exact(runId, "runId"));
      if (mode === "safe") {
        const envelope = pauseEnvelope(journal, reason); const path = pausePath(runId);
        try { durableNoReplace(path, JSON.stringify(envelope) + "\n", 0o640, { gid: null }); }
        catch (error) {
          if (error?.code !== "EEXIST") throw error;
          readPause(journal);
        }
        // The marker is consulted before the controller authorizes the next packet. If a packet
        // was already running, it is allowed to finish and the following status read becomes the
        // durable pause boundary; no completed packet is replayed on resume.
        return { ...status(runId, { advance: false }), pauseRequested: true, cancellationResolved: false };
      }
      if (current.status === "SAFE_BOUNDARY") publishPacket(journal, current.payloadStepIndex);
      const bytes = encodeBrokerCancel({ generationId: current.payloadGenerationId, mode, reason });
      const path = posix.join(commands, `cancel-${current.payloadGenerationId}.bin`);
      try { durableNoReplace(path, bytes, 0o640, { gid: null }); }
      catch (error) { if (error?.code !== "EEXIST" || !trusted(path, controllerUid, 65_536).equals(bytes)) throw error; }
      return { ...current, cancelRequested: true, cancellationResolved: false };
    } catch (error) { return { ok: false, node, runId, cancellationResolved: false,
      error: redactWorkerText(error.message || error, 1200) }; }
  }
  function collect(runId) {
    const current = status(runId); if (!current.ok || !TERMINAL.has(current.status)) return current;
    try {
      const journal = readJournal(exact(runId, "runId"));
      const index = Number(current.payloadStepIndex);
      const packet = journal.packets[index];
      const resultBytes = trusted(posix.join(results, `result-${packet.generationId}.bin`));
      const result = decodeBrokerResult(resultBytes); verifyResultBinding(journal, packet, index, result);
      let stdout = "", stderr = "";
      if (["reaped", "child_reaped_unmeasured"].includes(result.payloadState)) {
        const out = trusted(posix.join(results, `stdout-${packet.generationId}.log`), brokerUid, result.stdoutLimit, true);
        const err = trusted(posix.join(results, `stderr-${packet.generationId}.log`), brokerUid, result.stderrLimit, true);
        if (out.length !== result.stdoutBytes || err.length !== result.stderrBytes
            || sha(out) !== result.stdoutSha256 || sha(err) !== result.stderrSha256) {
          fail("broker output bytes do not bind to the signed result evidence");
        }
        stdout = redactWorkerText(out.toString("utf8"), 64_000);
        stderr = redactWorkerText(err.toString("utf8"), 16_000);
      }
      const artifacts = readArtifactManifest(journal, packet, index, result);
      return { ...current, stdout, stderr, artifacts, outputBound: true, artifactFerryBound: true,
        artifactManifestSha256: result.artifactManifestSha256 || null };
    } catch (error) {
      return { ok: false, node, runId: String(runId || ""),
        error: redactWorkerText(error.message || error, 1200) };
    }
  }
  function acknowledge(runId) {
    const id = String(runId || "");
    try {
      exact(id, "runId");
      pruneTombstones();
      try {
        const tombstone = readTombstone(id);
        cleanupControllerRetention(tombstone.retention);
        return { ok: true, node, runId: id, retentionAcknowledged: true, retentionPruned: true,
          generationsPruned: tombstone.retention.generations.length, replayed: true };
      } catch (error) { if (error?.code !== "ENOENT") throw error; }

      let retention;
      try { retention = readRetention(id); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const observed = status(id, { advance: false });
        if (!observed.ok || !TERMINAL.has(observed.status)) return observed;
        if (observed.status === "PAUSED" || observed.cancellationResolved !== true) {
          fail("current, paused, or unresolved payload lineage cannot be retention-acknowledged");
        }
        const current = collect(id);
        if (!current.ok || current.status !== observed.status || current.cancellationResolved !== true) {
          fail("terminal collection changed before retention acknowledgement");
        }
        const journal = readJournal(id); const index = Number(current.payloadStepIndex);
        const packet = journal.packets[index];
        const resultBytes = trusted(posix.join(results, `result-${packet.generationId}.bin`));
        const result = decodeBrokerResult(resultBytes); verifyResultBinding(journal, packet, index, result);
        retention = buildRetention(journal, current, result, resultBytes);
        durableNoReplace(retentionPath(id), JSON.stringify(retention) + "\n", 0o640, { gid: null });
      }

      let pending = 0;
      for (const item of retention.generations) {
        const acknowledgement = encodeBrokerAck(item);
        const ackPath = posix.join(commands, `ack-${item.generationId}.bin`);
        const receiptPath = posix.join(results, `pruned-${item.generationId}.bin`);
        if (existsSync(receiptPath)) {
          const receipt = decodeBrokerPruneReceipt(trusted(receiptPath, brokerUid, 16_000));
          if (receipt.generationId !== item.generationId
              || receipt.acknowledgementSha256 !== sha(acknowledgement)
              || receipt.resultSha256 !== item.resultSha256
              || receipt.artifactManifestSha256 !== item.artifactManifestSha256) {
            fail("broker prune receipt does not bind to the durable retention acknowledgement");
          }
          continue;
        }
        try { durableNoReplace(ackPath, acknowledgement, 0o640, { gid: null }); }
        catch (error) {
          if (error?.code !== "EEXIST" || !trusted(ackPath, controllerUid, 16_000).equals(acknowledgement)) throw error;
        }
        pending++;
      }
      if (pending) return { ok: true, node, runId: id, retentionAcknowledged: true,
        retentionPruned: false, generationsPending: pending };

      const body = { protocol: "game-factory-controller-retained/1", runId: id,
        prunedAt: new Date().toISOString(), retention };
      const tombstone = { ...body, tombstoneSha256: sha(JSON.stringify(body)) };
      try { durableNoReplace(tombstonePath(id), JSON.stringify(tombstone) + "\n", 0o640, { gid: null }); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        validateTombstone(readTrustedJson(tombstonePath(id), {
          ownerUid: controllerUid, ownerGid: spoolGid, maxBytes: 1_000_000,
        }), id);
      }
      cleanupControllerRetention(retention);
      pruneTombstones();
      return { ok: true, node, runId: id, retentionAcknowledged: true, retentionPruned: true,
        generationsPruned: retention.generations.length };
    } catch (error) {
      return { ok: false, node, runId: id, retentionAcknowledged: false, retentionPruned: false,
        error: redactWorkerText(error.message || error, 1200) };
    }
  }
  function describe() {
    try { const ready = requireReady(); return { protocol: PROTOCOL, configured: true, state: "ready", node,
      programs: ["node", "godot"], capabilities: ["quality_assurance", "godot"], maxConcurrent: 1,
      externalBroker: true, separateBrokerCgroup: true,
      secureForUntrustedCode: isolationAttested === true && toolchainAttested === true,
      brokerInstanceId: ready.brokerInstanceId, landlockAbi: ready.landlockAbi }; }
    catch (error) { return { protocol: PROTOCOL, configured: !!commandDir && !!results, state: "blocked", node,
      programs: ["node", "godot"], capabilities: ["quality_assurance", "godot"], maxConcurrent: 1,
      externalBroker: true, separateBrokerCgroup: true, secureForUntrustedCode: false,
      error: redactWorkerText(error.message || error, 1200) }; }
  }
  return { describe, probe: () => { const value = describe(); return { ...value, ok: value.state === "ready" && value.secureForUntrustedCode === true }; },
    start, status, cancel, collect, acknowledge };
}
