/* Spawn-free, length-prefixed token-bearing-controller↔static-broker wire protocol. */
import { createHash } from "node:crypto";
import { GAME_FACTORY_BROKER_PROJECTS, isBrokerProject } from "./gamefactory-broker-projects.mjs";

export const BROKER_REQUEST_MAGIC = Buffer.from("DGFBRQ01", "ascii");
export const BROKER_CANCEL_MAGIC = Buffer.from("DGFBCN01", "ascii");
export const BROKER_RESULT_MAGIC = Buffer.from("DGFRES01", "ascii");
export const BROKER_READY_MAGIC = Buffer.from("DGFRDY01", "ascii");
export const BROKER_ACK_MAGIC = Buffer.from("DGFACK01", "ascii");
export const BROKER_PRUNE_MAGIC = Buffer.from("DGFPRN01", "ascii");
export const BROKER_PROTOCOL = "game-factory-broker/1";
export const BROKER_MAX_PACKET = 1_000_000;
export const BROKER_MAX_TOTAL_LOG_BYTES = 1_048_576;
/* The broker only ferries explicit final build outputs, never an arbitrary workspace tree. */
export const BROKER_MAX_ARTIFACTS = 32;
// A reviewed Godot Web export has one large WASM member.  The per-file and
// aggregate caps remain identical and bounded so one dispatch can never use
// more than 64 MiB of the dedicated 1 GiB result spool.
export const BROKER_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const BROKER_MAX_TOTAL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const PROJECT_LABEL = Object.keys(GAME_FACTORY_BROKER_PROJECTS).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const GUARD_LABEL = new RegExp(`^dominion-gx10-gamefactory-broker//&dominion-gx10-guard-(node|godot)-(${PROJECT_LABEL}) \\(enforce\\)$`);
const PAYLOAD_LABEL = new RegExp(`^dominion-gx10-gamefactory-broker//&dominion-gx10-guard-(node|godot)-(${PROJECT_LABEL})//&dominion-gx10-payload-(node|godot)-(${PROJECT_LABEL}) \\(enforce\\)$`);

function fail(message) { throw new Error(`broker protocol: ${message}`); }
function text(value, label, max, { empty = false } = {}) {
  const result = String(value == null ? "" : value);
  if ((!empty && !result) || Buffer.byteLength(result, "utf8") > max
      || /[\u0000-\u001f\u007f]/.test(result)) fail(`${label} is invalid`);
  return result;
}
function hex64(value, label) { const result = String(value || "").toLowerCase(); if (!HEX64.test(result)) fail(`${label} is not 64-hex`); return result; }
function u32(value, label, minimum, maximum) {
  const result = Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum) fail(`${label} is out of range`); return result;
}
function decimalBytes(bytes, label, minimum, maximum) {
  const value = bytes.toString("ascii");
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail(`${label} is not canonical decimal`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(`${label} is out of range`);
  return result;
}
function canonicalUint64(value, label) {
  const result = text(value, label, 20);
  if (!/^[1-9][0-9]*$/.test(result) || BigInt(result) > 0xffffffffffffffffn) fail(`${label} is invalid`);
  return result;
}
function artifactPath(value, label) {
  const path = text(value, label, 2_000);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) || path.endsWith("/")
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${label} is not a canonical artifact-relative file path`);
  }
  return path;
}
function collectPaths(input) {
  const values = input == null ? [] : input;
  if (!Array.isArray(values) || values.length > BROKER_MAX_ARTIFACTS) fail("collect exceeds its artifact bound");
  const paths = values.map((value, index) => artifactPath(value, `collect[${index}]`));
  for (let index = 1; index < paths.length; index++) {
    if (paths[index - 1] >= paths[index]) fail("collect paths must be unique canonical sort order");
  }
  return paths;
}
function field(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const header = Buffer.allocUnsafe(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
}
function packet(magic, fields) {
  const result = Buffer.concat([magic, ...fields.map(field)]);
  if (result.length > BROKER_MAX_PACKET) fail("packet exceeds its byte bound");
  return result;
}
function reader(bytes, magic) {
  if (!Buffer.isBuffer(bytes) || bytes.length > BROKER_MAX_PACKET || bytes.length < magic.length
      || !bytes.subarray(0, magic.length).equals(magic)) fail("magic or packet size is invalid");
  let offset = magic.length;
  return {
    next(max, label) {
      if (offset + 4 > bytes.length) fail(`${label} length is truncated`);
      const size = bytes.readUInt32BE(offset); offset += 4;
      if (size > max || offset + size > bytes.length) fail(`${label} exceeds its bound or is truncated`);
      const value = bytes.subarray(offset, offset + size); offset += size; return value;
    },
    done() { if (offset !== bytes.length) fail("packet has trailing bytes"); },
  };
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function unsignedRequest(input) {
  const requestId = hex64(input.requestId, "requestId");
  const runId = text(input.runId, "runId", 240);
  if (!RUN_ID.test(runId)) fail("runId is not canonical");
  const requestHash = hex64(input.requestHash, "requestHash");
  const policyHash = hex64(input.policyHash, "policyHash");
  const brokerInstanceId = hex64(input.brokerInstanceId, "brokerInstanceId");
  const containerGenerationId = hex64(input.containerGenerationId, "containerGenerationId");
  const program = text(input.program, "program", 8);
  if (!["node", "godot"].includes(program)) fail("program is not allowed");
  const projectRelative = text(input.projectRelative, "projectRelative", 2_000);
  if (projectRelative === "." || projectRelative.startsWith("/") || projectRelative.includes("\\")
      || projectRelative.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("projectRelative is not a canonical dedicated workspace subtree");
  }
  const projectQuotaId = u32(input.projectQuotaId, "projectQuotaId", 10_000, 2_147_483_647);
  if (!isBrokerProject(projectRelative, projectQuotaId)) {
    fail("project identity is not in the reviewed static broker map");
  }
  const cwdRelative = text(input.cwdRelative, "cwdRelative", 2_000);
  if (cwdRelative !== "." && (cwdRelative.startsWith("/") || cwdRelative.includes("\\")
      || cwdRelative.split("/").some((part) => !part || part === "." || part === ".."))) {
    fail("cwdRelative is not a canonical workspace-relative path");
  }
  const timeoutMs = u32(input.timeoutMs, "timeoutMs", 1_000, 1_800_000);
  const stdoutLimit = u32(input.stdoutLimit, "stdoutLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES);
  const stderrLimit = u32(input.stderrLimit, "stderrLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES);
  const totalLogLimit = u32(input.totalLogLimit, "totalLogLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES);
  if (stdoutLimit > totalLogLimit || stderrLimit > totalLogLimit) fail("per-stream log limit exceeds totalLogLimit");
  const stepIndex = u32(input.stepIndex, "stepIndex", 0, 23);
  const totalSteps = u32(input.totalSteps, "totalSteps", 1, 24);
  if (stepIndex >= totalSteps) fail("stepIndex is outside totalSteps");
  const previousGenerationId = input.previousGenerationId == null ? "" : hex64(input.previousGenerationId, "previousGenerationId");
  if ((stepIndex === 0) !== (previousGenerationId === "")) fail("previousGenerationId does not match the step ordinal");
  const workspaceDev = canonicalUint64(input.workspaceDev, "workspaceDev");
  const workspaceIno = canonicalUint64(input.workspaceIno, "workspaceIno");
  const args = Array.isArray(input.args) ? input.args : fail("args is not an array");
  if (args.length > 160 || args.some((arg) => typeof arg !== "string"
      || Buffer.byteLength(arg) > 16_000 || /[\u0000-\u001f\u007f]/.test(arg))) fail("argv exceeds its canonical bound");
  const collect = collectPaths(input.collect);
  return packet(BROKER_REQUEST_MAGIC, [requestId, runId, requestHash, policyHash,
    brokerInstanceId, containerGenerationId, program, projectRelative,
    String(projectQuotaId), cwdRelative,
    String(timeoutMs), String(stdoutLimit), String(stderrLimit), String(totalLogLimit),
    String(stepIndex), String(totalSteps), previousGenerationId,
    workspaceDev, workspaceIno, String(args.length), ...args, String(collect.length), ...collect]);
}

export function encodeBrokerRequest(input) {
  const unsigned = unsignedRequest(input); const generationId = digest(unsigned);
  return { generationId, bytes: packet(BROKER_REQUEST_MAGIC, [generationId, unsigned]) };
}

export function decodeBrokerRequest(bytes) {
  const read = reader(bytes, BROKER_REQUEST_MAGIC);
  const generationId = read.next(64, "generationId").toString("ascii");
  const unsigned = read.next(BROKER_MAX_PACKET, "unsignedRequest"); read.done();
  hex64(generationId, "generationId");
  if (digest(unsigned) !== generationId) fail("generationId does not match the unsigned request bytes");
  const body = reader(unsigned, BROKER_REQUEST_MAGIC);
  const values = {
    requestId: body.next(64, "requestId").toString("utf8"), runId: body.next(960, "runId").toString("utf8"),
    requestHash: body.next(64, "requestHash").toString("utf8"), policyHash: body.next(64, "policyHash").toString("utf8"),
    brokerInstanceId: body.next(64, "brokerInstanceId").toString("ascii"),
    containerGenerationId: body.next(64, "containerGenerationId").toString("ascii"),
    program: body.next(8, "program").toString("utf8"),
    projectRelative: body.next(8_000, "projectRelative").toString("utf8"),
    projectQuotaId: decimalBytes(body.next(16, "projectQuotaId"), "projectQuotaId", 10_000, 2_147_483_647),
    cwdRelative: body.next(8_000, "cwdRelative").toString("utf8"),
    timeoutMs: decimalBytes(body.next(16, "timeoutMs"), "timeoutMs", 1_000, 1_800_000),
    stdoutLimit: decimalBytes(body.next(16, "stdoutLimit"), "stdoutLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    stderrLimit: decimalBytes(body.next(16, "stderrLimit"), "stderrLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    totalLogLimit: decimalBytes(body.next(16, "totalLogLimit"), "totalLogLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    stepIndex: decimalBytes(body.next(4, "stepIndex"), "stepIndex", 0, 23),
    totalSteps: decimalBytes(body.next(4, "totalSteps"), "totalSteps", 1, 24),
    previousGenerationId: body.next(64, "previousGenerationId").toString("ascii") || null,
    workspaceDev: body.next(32, "workspaceDev").toString("ascii"), workspaceIno: body.next(32, "workspaceIno").toString("ascii"),
  };
  const argc = decimalBytes(body.next(4, "argc"), "argc", 0, 160);
  if (!Number.isInteger(argc) || argc < 0 || argc > 160) fail("argc is invalid");
  values.args = Array.from({ length: argc }, (_, index) => body.next(16_000, `argv[${index}]`).toString("utf8"));
  const collectCount = decimalBytes(body.next(4, "collectCount"), "collectCount", 0, BROKER_MAX_ARTIFACTS);
  values.collect = Array.from({ length: collectCount }, (_, index) => body.next(2_000, `collect[${index}]`).toString("utf8"));
  body.done();
  const canonical = encodeBrokerRequest(values);
  if (!canonical.bytes.equals(bytes)) fail("request encoding is not canonical");
  return { ...values, generationId };
}

export function encodeBrokerCancel({ generationId, mode = "immediate", reason = "" }) {
  if (mode !== "immediate") fail("broker only accepts immediate per-generation cancellation");
  return packet(BROKER_CANCEL_MAGIC, [hex64(generationId, "generationId"), mode, text(reason, "reason", 1_000, { empty: true })]);
}

/*
 * Retention is a two-party commit. The controller may acknowledge a generation only after it has
 * verified the complete terminal result (including any artifact manifest and artifact bytes) and
 * the cloud orchestrator has durably committed that result. The broker publishes a prune receipt
 * before removing any broker-owned evidence; the controller removes its request only after it has
 * verified that receipt. Empty artifactManifestSha256 is canonical for generations without one.
 */
export function encodeBrokerAck({ generationId, resultSha256, artifactManifestSha256 = null }) {
  return packet(BROKER_ACK_MAGIC, [hex64(generationId, "generationId"),
    hex64(resultSha256, "resultSha256"),
    artifactManifestSha256 == null ? "" : hex64(artifactManifestSha256, "artifactManifestSha256")]);
}

export function decodeBrokerAck(bytes) {
  const read = reader(bytes, BROKER_ACK_MAGIC);
  const value = {
    generationId: read.next(64, "generationId").toString("ascii"),
    resultSha256: read.next(64, "resultSha256").toString("ascii"),
    artifactManifestSha256: read.next(64, "artifactManifestSha256").toString("ascii") || null,
  };
  read.done();
  const canonical = encodeBrokerAck(value);
  if (!canonical.equals(bytes)) fail("acknowledgement encoding is not canonical");
  return value;
}

export function encodeBrokerPruneReceipt({ generationId, acknowledgementSha256, resultSha256,
  artifactManifestSha256 = null }) {
  return packet(BROKER_PRUNE_MAGIC, [hex64(generationId, "generationId"),
    hex64(acknowledgementSha256, "acknowledgementSha256"), hex64(resultSha256, "resultSha256"),
    artifactManifestSha256 == null ? "" : hex64(artifactManifestSha256, "artifactManifestSha256")]);
}

export function decodeBrokerPruneReceipt(bytes) {
  const read = reader(bytes, BROKER_PRUNE_MAGIC);
  const value = {
    generationId: read.next(64, "generationId").toString("ascii"),
    acknowledgementSha256: read.next(64, "acknowledgementSha256").toString("ascii"),
    resultSha256: read.next(64, "resultSha256").toString("ascii"),
    artifactManifestSha256: read.next(64, "artifactManifestSha256").toString("ascii") || null,
  };
  read.done();
  const canonical = encodeBrokerPruneReceipt(value);
  if (!canonical.equals(bytes)) fail("prune-receipt encoding is not canonical");
  return value;
}

export function encodeBrokerReadiness(input) {
  const hashes = ["brokerInstanceId", "containerGenerationId", "brokerBootIdSha256",
    "brokerCgroupSha256", "workspaceMountIdentitySha256", "runtimeMountIdentitySha256",
    "brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256", "nodeExecutableSha256",
    "godotExecutableSha256", "nodeFilterSha256", "godotFilterSha256", "appArmorPolicySha256",
    "outerSeccompSha256", "deploymentPolicySha256"];
  for (const name of hashes) hex64(input[name], name);
  const identities = ["brokerStarttime", "brokerPidNamespaceDev", "brokerPidNamespaceIno",
    "brokerCgroupInode", "leaseDev", "leaseIno", "workspaceDev", "workspaceIno",
    "workspaceMountId", "runtimeDev", "runtimeIno", "runtimeMountId", "landlockHandledAccessFs",
    "readinessSequence"];
  for (const name of identities) canonicalUint64(input[name], name);
  if (input.protocol !== BROKER_PROTOCOL
      || input.brokerAppArmorLabel !== "dominion-gx10-gamefactory-broker (enforce)"
      || u32(input.noNewPrivs, "noNewPrivs", 1, 1) !== 1
      || u32(input.seccompFilterCount, "seccompFilterCount", 1, 64) < 1
      || u32(input.capsZero, "capsZero", 1, 1) !== 1
      || u32(input.landlockAbi, "landlockAbi", 3, 64) < 3
      || u32(input.maxConcurrent, "maxConcurrent", 1, 1) !== 1
      || input.programs !== "node,godot" || input.capabilities !== "quality_assurance,godot"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.updatedAt)
      || !Number.isFinite(Date.parse(input.updatedAt))) fail("broker readiness contract is invalid");
  return packet(BROKER_READY_MAGIC, [input.protocol, ...hashes.slice(0, 3).map((name) => input[name]),
    input.brokerStarttime, input.brokerPidNamespaceDev, input.brokerPidNamespaceIno,
    input.brokerCgroupSha256, input.brokerCgroupInode, input.leaseDev, input.leaseIno,
    input.workspaceDev, input.workspaceIno, input.workspaceMountId, input.workspaceMountIdentitySha256,
    input.runtimeDev, input.runtimeIno, input.runtimeMountId, input.runtimeMountIdentitySha256,
    input.brokerBinarySha256, input.nodeGuardSha256, input.godotGuardSha256,
    input.nodeExecutableSha256, input.godotExecutableSha256, input.nodeFilterSha256,
    input.godotFilterSha256, input.appArmorPolicySha256, input.outerSeccompSha256,
    input.deploymentPolicySha256, input.brokerAppArmorLabel, String(input.noNewPrivs),
    String(input.seccompFilterCount), String(input.capsZero), String(input.landlockAbi),
    input.landlockHandledAccessFs, String(input.maxConcurrent), input.programs, input.capabilities,
    input.readinessSequence, input.updatedAt]);
}

export function decodeBrokerReadiness(bytes) {
  const read = reader(bytes, BROKER_READY_MAGIC);
  const ascii = (max, label) => read.next(max, label).toString("ascii");
  const value = {
    protocol: ascii(32, "protocol"), brokerInstanceId: ascii(64, "brokerInstanceId"),
    containerGenerationId: ascii(64, "containerGenerationId"),
    brokerBootIdSha256: ascii(64, "brokerBootIdSha256"), brokerStarttime: ascii(32, "brokerStarttime"),
    brokerPidNamespaceDev: ascii(32, "brokerPidNamespaceDev"),
    brokerPidNamespaceIno: ascii(32, "brokerPidNamespaceIno"),
    brokerCgroupSha256: ascii(64, "brokerCgroupSha256"), brokerCgroupInode: ascii(32, "brokerCgroupInode"),
    leaseDev: ascii(32, "leaseDev"), leaseIno: ascii(32, "leaseIno"),
    workspaceDev: ascii(32, "workspaceDev"), workspaceIno: ascii(32, "workspaceIno"),
    workspaceMountId: ascii(32, "workspaceMountId"),
    workspaceMountIdentitySha256: ascii(64, "workspaceMountIdentitySha256"),
    runtimeDev: ascii(32, "runtimeDev"), runtimeIno: ascii(32, "runtimeIno"),
    runtimeMountId: ascii(32, "runtimeMountId"), runtimeMountIdentitySha256: ascii(64, "runtimeMountIdentitySha256"),
    brokerBinarySha256: ascii(64, "brokerBinarySha256"), nodeGuardSha256: ascii(64, "nodeGuardSha256"),
    godotGuardSha256: ascii(64, "godotGuardSha256"), nodeExecutableSha256: ascii(64, "nodeExecutableSha256"),
    godotExecutableSha256: ascii(64, "godotExecutableSha256"), nodeFilterSha256: ascii(64, "nodeFilterSha256"),
    godotFilterSha256: ascii(64, "godotFilterSha256"), appArmorPolicySha256: ascii(64, "appArmorPolicySha256"),
    outerSeccompSha256: ascii(64, "outerSeccompSha256"), deploymentPolicySha256: ascii(64, "deploymentPolicySha256"),
    brokerAppArmorLabel: read.next(256, "brokerAppArmorLabel").toString("utf8"),
    noNewPrivs: decimalBytes(read.next(2, "noNewPrivs"), "noNewPrivs", 1, 1),
    seccompFilterCount: decimalBytes(read.next(8, "seccompFilterCount"), "seccompFilterCount", 1, 64),
    capsZero: decimalBytes(read.next(2, "capsZero"), "capsZero", 1, 1),
    landlockAbi: decimalBytes(read.next(8, "landlockAbi"), "landlockAbi", 3, 64),
    landlockHandledAccessFs: ascii(32, "landlockHandledAccessFs"),
    maxConcurrent: decimalBytes(read.next(4, "maxConcurrent"), "maxConcurrent", 1, 1),
    programs: ascii(32, "programs"), capabilities: ascii(64, "capabilities"),
    readinessSequence: ascii(32, "readinessSequence"), updatedAt: ascii(64, "updatedAt"),
  }; read.done();
  if (value.protocol !== "game-factory-broker/1" || value.programs !== "node,godot"
      || value.capabilities !== "quality_assurance,godot") fail("broker readiness contract is invalid");
  for (const field of ["brokerInstanceId", "containerGenerationId", "brokerBootIdSha256", "brokerCgroupSha256",
    "workspaceMountIdentitySha256", "runtimeMountIdentitySha256",
    "brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256", "nodeExecutableSha256",
    "godotExecutableSha256", "nodeFilterSha256", "godotFilterSha256", "appArmorPolicySha256",
    "outerSeccompSha256", "deploymentPolicySha256"]) hex64(value[field], field);
  for (const field of ["brokerStarttime", "brokerPidNamespaceDev", "brokerPidNamespaceIno", "brokerCgroupInode",
    "leaseDev", "leaseIno", "workspaceDev", "workspaceIno", "workspaceMountId",
    "runtimeDev", "runtimeIno", "runtimeMountId", "landlockHandledAccessFs", "readinessSequence"]) {
    if (!/^[1-9][0-9]*$/.test(value[field]) || BigInt(value[field]) > 0xffffffffffffffffn) {
      fail(`${field} is not canonical uint64`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
      || !Number.isFinite(Date.parse(value.updatedAt))) fail("broker readiness timestamp is invalid");
  if (value.brokerAppArmorLabel !== "dominion-gx10-gamefactory-broker (enforce)"
      || value.noNewPrivs !== 1 || value.seccompFilterCount < 1 || value.capsZero !== 1
      || !encodeBrokerReadiness(value).equals(bytes)) fail("broker readiness evidence is not canonical");
  return value;
}

export function decodeBrokerResult(bytes) {
  const read = reader(bytes, BROKER_RESULT_MAGIC);
  const ascii = (max, label) => read.next(max, label).toString("ascii");
  const number = (max, label, minimum, maximum) => decimalBytes(read.next(max, label), label, minimum, maximum);
  const value = {
    generationId: ascii(64, "generationId"), runId: read.next(960, "runId").toString("utf8"),
    stepIndex: number(4, "stepIndex", 0, 23), totalSteps: number(4, "totalSteps", 1, 24),
    previousGenerationId: ascii(64, "previousGenerationId") || null,
    requestId: ascii(64, "requestId"), requestHash: ascii(64, "requestHash"), policyHash: ascii(64, "policyHash"),
    brokerInstanceId: ascii(64, "brokerInstanceId"), brokerBootIdSha256: ascii(64, "brokerBootIdSha256"),
    deploymentPolicySha256: ascii(64, "deploymentPolicySha256"), state: ascii(24, "state"),
    exitCode: (() => { const raw = ascii(16, "exitCode"); if (!/^(?:-1|0|[1-9][0-9]{0,2})$/.test(raw)) fail("exitCode is not canonical"); return Number(raw); })(),
    payloadState: ascii(32, "payloadState"),
    pid: number(16, "pid", 0, 2_147_483_647), starttime: ascii(32, "starttime"), observedAt: ascii(64, "observedAt"),
    decisionId: ascii(64, "decisionId"),
    brokerBinarySha256: ascii(64, "brokerBinarySha256"),
    nodeGuardSha256: ascii(64, "nodeGuardSha256"), godotGuardSha256: ascii(64, "godotGuardSha256"),
    nodeExecutableSha256: ascii(64, "nodeExecutableSha256"),
    godotExecutableSha256: ascii(64, "godotExecutableSha256"),
    nodeFilterSha256: ascii(64, "nodeFilterSha256"), godotFilterSha256: ascii(64, "godotFilterSha256"),
    appArmorPolicySha256: ascii(64, "appArmorPolicySha256"), outerSeccompSha256: ascii(64, "outerSeccompSha256"),
    measuredGuardAppArmorLabel: read.next(256, "measuredGuardAppArmorLabel").toString("utf8"),
    expectedFinalAppArmorLabel: read.next(256, "expectedFinalAppArmorLabel").toString("utf8"),
    finalTransitionAttested: number(2, "finalTransitionAttested", 0, 1),
    noNewPrivs: number(2, "noNewPrivs", 0, 1), seccompFilterCount: number(8, "seccompFilterCount", 0, 64),
    capsZero: number(2, "capsZero", 0, 1), waitIdPid: number(16, "waitIdPid", 0, 2_147_483_647),
    waitIdCode: number(16, "waitIdCode", 0, 6),
    waitIdStatus: number(16, "waitIdStatus", 0, 255),
    cancelEnvelopeSha256: ascii(64, "cancelEnvelopeSha256") || null,
    terminationReason: ascii(32, "terminationReason"), pidfdKillOutcome: ascii(16, "pidfdKillOutcome"),
    stdoutLimit: number(16, "stdoutLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    stderrLimit: number(16, "stderrLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    totalLogLimit: number(16, "totalLogLimit", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    stdoutSha256: ascii(64, "stdoutSha256"), stdoutBytes: number(16, "stdoutBytes", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    stdoutTruncated: number(2, "stdoutTruncated", 0, 1),
    stderrSha256: ascii(64, "stderrSha256"), stderrBytes: number(16, "stderrBytes", 0, BROKER_MAX_TOTAL_LOG_BYTES),
    stderrTruncated: number(2, "stderrTruncated", 0, 1),
    artifactManifestSha256: ascii(64, "artifactManifestSha256") || null,
    artifactCount: number(4, "artifactCount", 0, BROKER_MAX_ARTIFACTS),
    artifactTotalBytes: number(16, "artifactTotalBytes", 0, BROKER_MAX_TOTAL_ARTIFACT_BYTES),
    error: read.next(4_000, "error").toString("utf8"),
  }; read.done();
  for (const field of ["generationId", "requestId", "requestHash", "policyHash", "brokerInstanceId",
    "brokerBootIdSha256", "deploymentPolicySha256",
    "brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256",
    "nodeExecutableSha256", "godotExecutableSha256", "nodeFilterSha256",
    "godotFilterSha256", "appArmorPolicySha256", "outerSeccompSha256", "stdoutSha256", "stderrSha256"]) {
    hex64(value[field], field);
  }
  text(value.runId, "runId", 240);
  if (!RUN_ID.test(value.runId) || value.deploymentPolicySha256 !== value.policyHash) {
    fail("result run/policy binding is invalid");
  }
  if (!Number.isInteger(value.stepIndex) || !Number.isInteger(value.totalSteps) || value.totalSteps < 1
      || value.totalSteps > 24 || value.stepIndex < 0 || value.stepIndex >= value.totalSteps
      || ((value.stepIndex === 0) !== (value.previousGenerationId == null))
      || (value.previousGenerationId != null && !HEX64.test(value.previousGenerationId))) fail("result step chain is invalid");
  if (!["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(value.state)) fail("result state is invalid");
  if (!Number.isInteger(value.exitCode) || value.exitCode < -1 || value.exitCode > 255) fail("exitCode is invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)
      || !Number.isFinite(Date.parse(value.observedAt))) fail("observedAt is invalid");
  if (![0, 1].includes(value.noNewPrivs) || ![0, 1].includes(value.capsZero)
      || !Number.isInteger(value.seccompFilterCount) || value.seccompFilterCount < 0
      || value.seccompFilterCount > 64 || !Number.isInteger(value.waitIdPid) || value.waitIdPid < 0
      || !Number.isInteger(value.waitIdCode) || value.waitIdCode < 0
      || !Number.isInteger(value.waitIdStatus) || value.waitIdStatus < 0 || value.waitIdStatus > 255
      || !Number.isInteger(value.stdoutBytes) || value.stdoutBytes < 0 || value.stdoutBytes > BROKER_MAX_TOTAL_LOG_BYTES
      || !Number.isInteger(value.stderrBytes) || value.stderrBytes < 0 || value.stderrBytes > BROKER_MAX_TOTAL_LOG_BYTES
      || !Number.isInteger(value.stdoutLimit) || value.stdoutLimit < 0 || value.stdoutLimit > BROKER_MAX_TOTAL_LOG_BYTES
      || !Number.isInteger(value.stderrLimit) || value.stderrLimit < 0 || value.stderrLimit > BROKER_MAX_TOTAL_LOG_BYTES
      || !Number.isInteger(value.totalLogLimit) || value.totalLogLimit < 0 || value.totalLogLimit > BROKER_MAX_TOTAL_LOG_BYTES
      || value.stdoutBytes > value.stdoutLimit || value.stderrBytes > value.stderrLimit
      || value.stdoutBytes + value.stderrBytes > value.totalLogLimit
      || ![0, 1].includes(value.stdoutTruncated) || ![0, 1].includes(value.stderrTruncated)) {
    fail("result security/wait/log evidence is invalid");
  }
  if (value.cancelEnvelopeSha256 != null && !HEX64.test(value.cancelEnvelopeSha256)) {
    fail("cancel envelope digest is invalid");
  }
  if (!new Set(["completion", "cancel", "cancel_invalid", "timeout", "output_limit", "poll_fault",
    "guard_failed", "kill_failed", "broker_shutdown", "never_started", "broker_restart",
    "broker_generation_mismatch"]).has(value.terminationReason)
      || !new Set(["none", "signalled", "already_dead", "failed"]).has(value.pidfdKillOutcome)
      || (value.terminationReason === "cancel") !== (value.cancelEnvelopeSha256 != null)
      || (value.state === "CANCELLED" && value.terminationReason !== "cancel")
      || (value.state === "SUCCEEDED" && (value.terminationReason !== "completion"
        || value.pidfdKillOutcome !== "none"))) fail("result termination evidence is invalid");
  if (value.payloadState === "reaped") {
    const guard = GUARD_LABEL.exec(value.measuredGuardAppArmorLabel);
    const payload = PAYLOAD_LABEL.exec(value.expectedFinalAppArmorLabel);
    const expectedLabel = !!guard && !!payload && guard[1] === payload[1] && guard[2] === payload[2]
      && payload[1] === payload[3] && payload[2] === payload[4];
    if (!Number.isInteger(value.pid) || value.pid <= 0 || !/^\d+$/.test(value.starttime) || value.decisionId
        || value.waitIdPid !== value.pid || value.waitIdCode === 0 || !expectedLabel
        || value.finalTransitionAttested !== 1
        || value.noNewPrivs !== 1 || value.seccompFilterCount < 2 || value.capsZero !== 1) {
      fail("reaped proof is invalid");
    }
  } else if (value.payloadState === "child_reaped_unmeasured") {
    if (!Number.isInteger(value.pid) || value.pid <= 0 || !/^\d+$/.test(value.starttime)
        || value.decisionId || value.waitIdPid !== value.pid || ![1, 2, 3].includes(value.waitIdCode)
        || value.measuredGuardAppArmorLabel || value.expectedFinalAppArmorLabel
        || value.finalTransitionAttested !== 0 || value.noNewPrivs !== 0 || value.seccompFilterCount !== 0
        || value.capsZero !== 0 || value.state !== "FAILED"
        || !["guard_failed", "kill_failed"].includes(value.terminationReason)) {
      fail("unmeasured reaped-child proof is invalid");
    }
  } else if (value.payloadState === "never_started") {
    if (value.pid !== 0 || value.starttime || !HEX64.test(value.decisionId)
        || value.waitIdPid !== 0 || value.waitIdCode !== 0 || value.waitIdStatus !== 0
        || value.measuredGuardAppArmorLabel || value.expectedFinalAppArmorLabel
        || value.finalTransitionAttested !== 0
        || value.noNewPrivs !== 0 || value.seccompFilterCount !== 0 || value.capsZero !== 0
        || value.exitCode !== -1) fail("never-started proof is invalid");
  } else if (value.payloadState === "unresolved") {
    if (!Number.isInteger(value.pid) || value.pid <= 0 || !/^\d+$/.test(value.starttime)
        || value.decisionId || value.waitIdPid !== 0 || value.waitIdCode !== 0
        || value.state !== "INTERRUPTED" || value.exitCode !== -1) fail("unresolved generation identity is invalid");
  } else fail("payloadState is invalid");
  if (value.payloadState === "reaped" || value.payloadState === "child_reaped_unmeasured") {
    if ((value.waitIdCode === 1 && value.exitCode !== value.waitIdStatus)
        || ([2, 3].includes(value.waitIdCode) && value.exitCode !== -1)
        || ![1, 2, 3].includes(value.waitIdCode)
        || (value.state === "SUCCEEDED" && !(value.waitIdCode === 1
          && value.waitIdStatus === 0 && value.exitCode === 0))) fail("result state conflicts with waitid evidence");
  }
  if (!["reaped", "child_reaped_unmeasured"].includes(value.payloadState) && (value.stdoutBytes !== 0 || value.stderrBytes !== 0
      || value.stdoutTruncated !== 0 || value.stderrTruncated !== 0
      || value.stdoutSha256 !== digest(Buffer.alloc(0)) || value.stderrSha256 !== digest(Buffer.alloc(0)))) {
    fail("non-launched/restart result contains fabricated payload output");
  }
  const finalSuccessfulGeneration = value.state === "SUCCEEDED" && value.stepIndex === value.totalSteps - 1;
  if (finalSuccessfulGeneration) {
    if (!HEX64.test(value.artifactManifestSha256 || "")) fail("successful final result lacks its artifact manifest binding");
  } else if (value.artifactManifestSha256 != null || value.artifactCount !== 0 || value.artifactTotalBytes !== 0) {
    fail("non-final or unsuccessful result contains artifact publication evidence");
  }
  if (!encodeBrokerResult(value).equals(bytes)) fail("result encoding is not canonical");
  return value;
}

export function encodeBrokerResult(input) {
  const requiredHashes = ["generationId", "requestId", "requestHash", "policyHash", "brokerInstanceId",
    "brokerBootIdSha256", "deploymentPolicySha256",
    "brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256",
    "nodeExecutableSha256", "godotExecutableSha256", "nodeFilterSha256",
    "godotFilterSha256", "appArmorPolicySha256", "outerSeccompSha256", "stdoutSha256", "stderrSha256"];
  for (const field of requiredHashes) hex64(input[field], field);
  return packet(BROKER_RESULT_MAGIC, [input.generationId, input.runId, String(input.stepIndex), String(input.totalSteps),
    input.previousGenerationId || "", input.requestId, input.requestHash,
    input.policyHash, input.brokerInstanceId, input.brokerBootIdSha256, input.deploymentPolicySha256,
    input.state, String(input.exitCode), input.payloadState,
    String(input.pid || 0), input.starttime || "", input.observedAt, input.decisionId || "",
    input.brokerBinarySha256, input.nodeGuardSha256, input.godotGuardSha256,
    input.nodeExecutableSha256, input.godotExecutableSha256,
    input.nodeFilterSha256, input.godotFilterSha256, input.appArmorPolicySha256, input.outerSeccompSha256,
    input.measuredGuardAppArmorLabel || "", input.expectedFinalAppArmorLabel || "",
    String(input.finalTransitionAttested || 0), String(input.noNewPrivs || 0), String(input.seccompFilterCount || 0),
    String(input.capsZero || 0), String(input.waitIdPid || 0), String(input.waitIdCode || 0),
    String(input.waitIdStatus || 0),
    input.cancelEnvelopeSha256 || "", input.terminationReason, input.pidfdKillOutcome,
    String(input.stdoutLimit || 0), String(input.stderrLimit || 0), String(input.totalLogLimit || 0),
    input.stdoutSha256, String(input.stdoutBytes || 0), String(input.stdoutTruncated || 0),
    input.stderrSha256, String(input.stderrBytes || 0), String(input.stderrTruncated || 0),
    input.artifactManifestSha256 || "", String(input.artifactCount || 0), String(input.artifactTotalBytes || 0),
    text(input.error, "error", 4_000, { empty: true })]);
}
