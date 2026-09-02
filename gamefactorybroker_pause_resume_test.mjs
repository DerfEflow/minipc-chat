import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBrokerRequest, encodeBrokerReadiness, encodeBrokerResult } from "./hands/gamefactory-broker-protocol.mjs";
import { createGameFactoryBrokerController } from "./hands/gamefactory-broker-controller.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const empty = sha("");
const uid = process.getuid?.() ?? null;
const gid = process.getgid?.() ?? null;
const hashes = Object.fromEntries(["brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256", "nodeExecutableSha256",
  "godotExecutableSha256", "nodeFilterSha256", "godotFilterSha256", "appArmorPolicySha256", "outerSeccompSha256",
  "deploymentPolicySha256"].map((name) => [name, sha(name)]));
const root = mkdtempSync(join(tmpdir(), "gamefactory-broker-pause-"));

try {
  const commands = join(root, "commands"), results = join(root, "results");
  mkdirSync(commands); mkdirSync(results); chmodSync(commands, 0o2750); chmodSync(results, 0o2750);
  const ready = {
    protocol: "game-factory-broker/1", brokerInstanceId: sha("instance"), containerGenerationId: sha("container"),
    brokerBootIdSha256: sha("boot"), brokerStarttime: "100", brokerPidNamespaceDev: "101", brokerPidNamespaceIno: "102",
    brokerCgroupSha256: sha("different-cgroup"), brokerCgroupInode: "103", leaseDev: "104", leaseIno: "105",
    workspaceDev: "106", workspaceIno: "107", workspaceMountId: "108", workspaceMountIdentitySha256: sha("workspace"),
    runtimeDev: "109", runtimeIno: "110", runtimeMountId: "111", runtimeMountIdentitySha256: sha("runtime"), ...hashes,
    brokerAppArmorLabel: "dominion-gx10-gamefactory-broker (enforce)", noNewPrivs: 1, seccompFilterCount: 1,
    capsZero: 1, landlockAbi: 3, landlockHandledAccessFs: "1", maxConcurrent: 1, programs: "node,godot",
    capabilities: "quality_assurance,godot", readinessSequence: "1", updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(results, "broker-ready.bin"), encodeBrokerReadiness(ready), { mode: 0o640 });
  const controller = createGameFactoryBrokerController({ commandDir: commands, resultDir: results, node: "test-broker",
    brokerOwnerUid: uid, spoolGid: gid, expected: hashes, isolationAttested: true, toolchainAttested: true });
  const recipe = {
    taskId: "task-1", projectId: "project-1", capability: "quality_assurance", workspaceRoot: "/workspace/vector-vault",
    plan: { steps: [
      { program: "node", args: ["--check", "src/one.js"], cwdRelative: ".", timeoutMs: 1_000 },
      { program: "node", args: ["--check", "src/two.js"], cwdRelative: ".", timeoutMs: 1_000 },
    ], collect: [] },
  };
  const started = controller.start({ ...recipe, runId: "pause-source-1" });
  assert.equal(started.ok, true, started.error);
  const first = decodeBrokerRequest(readFileSync(join(commands, `request-${started.payloadGenerationId}.bin`)));
  assert.deepEqual(first.args, ["--check", "src/one.js"]);
  const firstResult = encodeBrokerResult({
    generationId: first.generationId, runId: first.runId, stepIndex: 0, totalSteps: 2, previousGenerationId: null,
    requestId: first.requestId, requestHash: first.requestHash, policyHash: hashes.deploymentPolicySha256,
    brokerInstanceId: ready.brokerInstanceId, brokerBootIdSha256: ready.brokerBootIdSha256,
    deploymentPolicySha256: hashes.deploymentPolicySha256, state: "SUCCEEDED", exitCode: 0, payloadState: "reaped",
    pid: 321, starttime: "654321", observedAt: new Date().toISOString(), decisionId: "",
    brokerBinarySha256: hashes.brokerBinarySha256, nodeGuardSha256: hashes.nodeGuardSha256, godotGuardSha256: hashes.godotGuardSha256,
    nodeExecutableSha256: hashes.nodeExecutableSha256, godotExecutableSha256: hashes.godotExecutableSha256,
    nodeFilterSha256: hashes.nodeFilterSha256, godotFilterSha256: hashes.godotFilterSha256,
    appArmorPolicySha256: hashes.appArmorPolicySha256, outerSeccompSha256: hashes.outerSeccompSha256,
    measuredGuardAppArmorLabel: "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-node-vector-vault (enforce)",
    expectedFinalAppArmorLabel: "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-node-vector-vault//&dominion-gx10-payload-node-vector-vault (enforce)",
    finalTransitionAttested: 1, noNewPrivs: 1, seccompFilterCount: 2, capsZero: 1, waitIdPid: 321, waitIdCode: 1,
    waitIdStatus: 0, cancelEnvelopeSha256: null, terminationReason: "completion", pidfdKillOutcome: "none",
    stdoutLimit: 524_288, stderrLimit: 524_288, totalLogLimit: 1_048_576, stdoutSha256: empty, stdoutBytes: 0,
    stdoutTruncated: 0, stderrSha256: empty, stderrBytes: 0, stderrTruncated: 0,
    artifactManifestSha256: null, artifactCount: 0, artifactTotalBytes: 0, error: "",
  });
  writeFileSync(join(results, `result-${first.generationId}.bin`), firstResult, { mode: 0o640 });
  const paused = controller.cancel("pause-source-1", { mode: "safe", reason: "test safe boundary" });
  assert.equal(paused.ok, true, paused.error); assert.equal(paused.status, "PAUSED");
  assert.equal(paused.checkpoint.completedSteps, 1); assert.equal(paused.checkpoint.safeBoundary, true);
  assert.ok(paused.checkpoint.lineage);
  assert.equal(readdirSync(commands).filter((name) => name.startsWith("request-")).length, 1);
  const refusedPrune = controller.acknowledge("pause-source-1");
  assert.equal(refusedPrune.ok, false);
  assert.match(refusedPrune.error, /paused.*unresolved|current.*paused/i);
  assert.equal(existsSync(join(commands, `request-${first.generationId}.bin`)), true);
  assert.equal(existsSync(join(results, `result-${first.generationId}.bin`)), true);

  const resumed = controller.start({ ...recipe, runId: "pause-resume-1", resumeFrom: paused.checkpoint.lineage });
  assert.equal(resumed.ok, true, resumed.error);
  assert.notEqual(resumed.payloadGenerationId, first.generationId);
  const remaining = decodeBrokerRequest(readFileSync(join(commands, `request-${resumed.payloadGenerationId}.bin`)));
  assert.deepEqual(remaining.args, ["--check", "src/two.js"]);
  assert.equal(remaining.stepIndex, 0); assert.equal(remaining.totalSteps, 1); assert.equal(remaining.previousGenerationId, null);
  assert.equal(existsSync(join(commands, `request-${first.generationId}.bin`)), true);
  const unresolvedResult = encodeBrokerResult({
    generationId: remaining.generationId, runId: remaining.runId, stepIndex: 0, totalSteps: 1,
    previousGenerationId: null, requestId: remaining.requestId, requestHash: remaining.requestHash,
    policyHash: hashes.deploymentPolicySha256, brokerInstanceId: ready.brokerInstanceId,
    brokerBootIdSha256: ready.brokerBootIdSha256, deploymentPolicySha256: hashes.deploymentPolicySha256,
    state: "INTERRUPTED", exitCode: -1, payloadState: "unresolved", pid: 777, starttime: "987654",
    observedAt: new Date().toISOString(), decisionId: "", brokerBinarySha256: hashes.brokerBinarySha256,
    nodeGuardSha256: hashes.nodeGuardSha256, godotGuardSha256: hashes.godotGuardSha256,
    nodeExecutableSha256: hashes.nodeExecutableSha256, godotExecutableSha256: hashes.godotExecutableSha256,
    nodeFilterSha256: hashes.nodeFilterSha256, godotFilterSha256: hashes.godotFilterSha256,
    appArmorPolicySha256: hashes.appArmorPolicySha256, outerSeccompSha256: hashes.outerSeccompSha256,
    measuredGuardAppArmorLabel: "", expectedFinalAppArmorLabel: "", finalTransitionAttested: 0,
    noNewPrivs: 0, seccompFilterCount: 0, capsZero: 0, waitIdPid: 0, waitIdCode: 0, waitIdStatus: 0,
    cancelEnvelopeSha256: null, terminationReason: "broker_restart", pidfdKillOutcome: "none",
    stdoutLimit: 524_288, stderrLimit: 524_288, totalLogLimit: 1_048_576,
    stdoutSha256: empty, stdoutBytes: 0, stdoutTruncated: 0, stderrSha256: empty, stderrBytes: 0,
    stderrTruncated: 0, artifactManifestSha256: null, artifactCount: 0, artifactTotalBytes: 0,
    error: "restart left payload death unresolved",
  });
  writeFileSync(join(results, `result-${remaining.generationId}.bin`), unresolvedResult, { mode: 0o640 });
  const unresolvedPrune = controller.acknowledge("pause-resume-1");
  assert.equal(unresolvedPrune.ok, false);
  assert.match(unresolvedPrune.error, /unresolved|current/);
  assert.equal(existsSync(join(commands, `request-${remaining.generationId}.bin`)), true);
  assert.equal(existsSync(join(results, `result-${remaining.generationId}.bin`)), true);
  console.log("ok - safe pause resumes remaining lineage without replaying completed broker step");
} finally {
  rmSync(root, { recursive: true, force: true });
}
