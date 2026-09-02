import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBrokerAck, decodeBrokerRequest, decodeBrokerResult, encodeBrokerPruneReceipt,
  encodeBrokerReadiness, encodeBrokerResult,
} from "./hands/gamefactory-broker-protocol.mjs";
import { createGameFactoryBrokerController } from "./hands/gamefactory-broker-controller.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const empty = sha("");
const uid = process.getuid();
const gid = process.getgid();
const hashes = Object.fromEntries([
  "brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256", "nodeExecutableSha256",
  "godotExecutableSha256", "nodeFilterSha256", "godotFilterSha256", "appArmorPolicySha256",
  "outerSeccompSha256", "deploymentPolicySha256",
].map((name) => [name, sha(name)]));

const root = mkdtempSync(join(tmpdir(), "gamefactory-broker-ferry-"));
try {
  const commands = join(root, "commands"); const results = join(root, "results");
  mkdirSync(commands); mkdirSync(results); chmodSync(commands, 0o2750); chmodSync(results, 0o2750);
  const ready = {
    protocol: "game-factory-broker/1", brokerInstanceId: sha("instance"), containerGenerationId: sha("container"),
    brokerBootIdSha256: sha("boot"), brokerStarttime: "100", brokerPidNamespaceDev: "101",
    brokerPidNamespaceIno: "102", brokerCgroupSha256: sha("a-different-controller-cgroup"), brokerCgroupInode: "103",
    leaseDev: "104", leaseIno: "105", workspaceDev: "106", workspaceIno: "107", workspaceMountId: "108",
    workspaceMountIdentitySha256: sha("workspace-mount"), runtimeDev: "109", runtimeIno: "110",
    runtimeMountId: "111", runtimeMountIdentitySha256: sha("runtime-mount"), ...hashes,
    brokerAppArmorLabel: "dominion-gx10-gamefactory-broker (enforce)", noNewPrivs: 1,
    seccompFilterCount: 1, capsZero: 1, landlockAbi: 3, landlockHandledAccessFs: "1",
    maxConcurrent: 1, programs: "node,godot", capabilities: "quality_assurance,godot",
    readinessSequence: "1", updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(results, "broker-ready.bin"), encodeBrokerReadiness(ready), { mode: 0o640 });
  const controller = createGameFactoryBrokerController({
    commandDir: commands, resultDir: results, node: "test-broker", brokerOwnerUid: uid, spoolGid: gid,
    expected: hashes, isolationAttested: true, toolchainAttested: true,
  });
  const started = controller.start({
    runId: "artifact-ferry-1", taskId: "task-1", projectId: "project-1", capability: "quality_assurance",
    workspaceRoot: "/workspace/vector-vault", plan: {
      steps: [{ program: "node", args: ["--check", "src/check.js"], cwdRelative: ".", timeoutMs: 1_000 }],
      collect: ["dist/index.html"],
    },
  });
  assert.equal(started.ok, true, started.error);
  const generationId = started.payloadGenerationId;
  const request = decodeBrokerRequest(readFileSync(join(commands, `request-${generationId}.bin`)));
  assert.equal(request.brokerInstanceId, ready.brokerInstanceId);
  assert.equal(request.containerGenerationId, ready.containerGenerationId);
  assert.deepEqual(request.collect, ["dist/index.html"]);
  const artifact = Buffer.from("<!doctype html><title>bounded ferry</title>", "utf8");
  const spoolName = `artifact-${generationId}-0.bin`;
  const manifest = {
    protocol: "game-factory-broker-artifacts/1", generationId, runId: request.runId, requestHash: request.requestHash,
    stepIndex: 0, totalSteps: 1, projectRelative: "vector-vault",
    artifacts: [{ path: "dist/index.html", mimeType: "text/html", bytes: artifact.length, sha256: sha(artifact), spoolName }],
    totalBytes: artifact.length,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  writeFileSync(join(results, spoolName), artifact, { mode: 0o640 });
  writeFileSync(join(results, `artifacts-${generationId}.json`), manifestBytes, { mode: 0o640 });
  const result = encodeBrokerResult({
    generationId, runId: request.runId, stepIndex: 0, totalSteps: 1, previousGenerationId: null,
    requestId: request.requestId, requestHash: request.requestHash, policyHash: hashes.deploymentPolicySha256,
    brokerInstanceId: ready.brokerInstanceId, brokerBootIdSha256: ready.brokerBootIdSha256,
    deploymentPolicySha256: hashes.deploymentPolicySha256, state: "SUCCEEDED", exitCode: 0,
    payloadState: "reaped", pid: 321, starttime: "654321", observedAt: new Date().toISOString(), decisionId: "",
    brokerBinarySha256: hashes.brokerBinarySha256, nodeGuardSha256: hashes.nodeGuardSha256,
    godotGuardSha256: hashes.godotGuardSha256, nodeExecutableSha256: hashes.nodeExecutableSha256,
    godotExecutableSha256: hashes.godotExecutableSha256, nodeFilterSha256: hashes.nodeFilterSha256,
    godotFilterSha256: hashes.godotFilterSha256, appArmorPolicySha256: hashes.appArmorPolicySha256,
    outerSeccompSha256: hashes.outerSeccompSha256,
    measuredGuardAppArmorLabel: "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-node-vector-vault (enforce)",
    expectedFinalAppArmorLabel: "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-node-vector-vault//&dominion-gx10-payload-node-vector-vault (enforce)",
    finalTransitionAttested: 1, noNewPrivs: 1, seccompFilterCount: 2, capsZero: 1,
    waitIdPid: 321, waitIdCode: 1, waitIdStatus: 0, cancelEnvelopeSha256: null,
    terminationReason: "completion", pidfdKillOutcome: "none", stdoutLimit: 524_288, stderrLimit: 524_288,
    totalLogLimit: 1_048_576, stdoutSha256: empty, stdoutBytes: 0, stdoutTruncated: 0,
    stderrSha256: empty, stderrBytes: 0, stderrTruncated: 0,
    artifactManifestSha256: sha(manifestBytes), artifactCount: 1, artifactTotalBytes: artifact.length, error: "",
  });
  writeFileSync(join(results, `stdout-${generationId}.log`), Buffer.alloc(0), { mode: 0o640 });
  writeFileSync(join(results, `stderr-${generationId}.log`), Buffer.alloc(0), { mode: 0o640 });
  writeFileSync(join(results, `result-${generationId}.bin`), result, { mode: 0o640 });
  const collected = controller.collect("artifact-ferry-1");
  assert.equal(collected.ok, true, collected.error);
  assert.equal(collected.artifactFerryBound, true);
  assert.deepEqual(collected.artifacts, [{ path: "dist/index.html", mimeType: "text/html", size: artifact.length,
    sha256: sha(artifact), spoolName, ferry: "broker-result-spool" }]);
  const firstAck = controller.acknowledge("artifact-ferry-1");
  assert.equal(firstAck.ok, true, firstAck.error);
  assert.equal(firstAck.retentionAcknowledged, true);
  assert.equal(firstAck.retentionPruned, false);
  const acknowledgementBytes = readFileSync(join(commands, `ack-${generationId}.bin`));
  const acknowledgement = decodeBrokerAck(acknowledgementBytes);
  assert.equal(acknowledgement.resultSha256, sha(result));
  assert.equal(acknowledgement.artifactManifestSha256, sha(manifestBytes));
  // No controller acknowledgement may erase the artifact ferry. The broker must first publish its
  // own hash-bound receipt, after independently validating the terminal result and manifest.
  assert.equal(existsSync(join(results, spoolName)), true);
  assert.equal(existsSync(join(results, `artifacts-${generationId}.json`)), true);
  const receipt = encodeBrokerPruneReceipt({ generationId, acknowledgementSha256: sha(acknowledgementBytes),
    resultSha256: sha(result), artifactManifestSha256: sha(manifestBytes) });
  writeFileSync(join(results, `pruned-${generationId}.bin`), receipt, { mode: 0o640 });
  const pruned = controller.acknowledge("artifact-ferry-1");
  assert.equal(pruned.ok, true, pruned.error);
  assert.equal(pruned.retentionPruned, true);
  assert.equal(existsSync(join(commands, `request-${generationId}.bin`)), false);
  assert.equal(existsSync(join(commands, `ack-${generationId}.bin`)), false);
  assert.equal(existsSync(join(commands, `retained-${sha("artifact-ferry-1").slice(0, 32)}.json`)), true);
  const replay = controller.acknowledge("artifact-ferry-1");
  assert.equal(replay.retentionPruned, true);
  assert.equal(replay.replayed, true);

  // Reproduce the exact death-between-readiness-and-dispatch race. The immutable packet targets
  // the old instance+container generation; only the newly ready broker may certify never-started.
  writeFileSync(join(results, "broker-ready.bin"), encodeBrokerReadiness({
    ...ready, updatedAt: new Date().toISOString(), readinessSequence: "2",
  }), { mode: 0o640 });
  const raceStarted = controller.start({
    runId: "generation-race-1", taskId: "task-race", projectId: "project-race",
    capability: "quality_assurance", workspaceRoot: "/workspace/vector-vault",
    plan: { steps: [{ program: "node", args: ["--version"], cwdRelative: ".", timeoutMs: 1_000 }], collect: [] },
  });
  assert.equal(raceStarted.ok, true, raceStarted.error);
  const raceRequest = decodeBrokerRequest(readFileSync(join(commands,
    `request-${raceStarted.payloadGenerationId}.bin`)));
  assert.equal(raceRequest.brokerInstanceId, ready.brokerInstanceId);
  assert.equal(raceRequest.containerGenerationId, ready.containerGenerationId);
  const replacement = { ...ready, brokerInstanceId: sha("replacement-instance"),
    containerGenerationId: sha("replacement-container"), brokerStarttime: "200",
    readinessSequence: "1", updatedAt: new Date().toISOString() };
  writeFileSync(join(results, "broker-ready.bin"), encodeBrokerReadiness(replacement), { mode: 0o640 });
  const priorResult = decodeBrokerResult(result);
  const raceResult = encodeBrokerResult({
    ...priorResult, generationId: raceRequest.generationId, runId: raceRequest.runId,
    stepIndex: 0, totalSteps: 1, previousGenerationId: null, requestId: raceRequest.requestId,
    requestHash: raceRequest.requestHash, brokerInstanceId: replacement.brokerInstanceId,
    brokerBootIdSha256: replacement.brokerBootIdSha256, state: "INTERRUPTED", exitCode: -1,
    payloadState: "never_started", pid: 0, starttime: "", decisionId: sha("generation-rejection"),
    measuredGuardAppArmorLabel: "", expectedFinalAppArmorLabel: "", finalTransitionAttested: 0,
    noNewPrivs: 0, seccompFilterCount: 0, capsZero: 0, waitIdPid: 0, waitIdCode: 0,
    waitIdStatus: 0, cancelEnvelopeSha256: null, terminationReason: "broker_generation_mismatch",
    pidfdKillOutcome: "none", stdoutSha256: empty, stdoutBytes: 0, stdoutTruncated: 0,
    stderrSha256: empty, stderrBytes: 0, stderrTruncated: 0, artifactManifestSha256: null,
    artifactCount: 0, artifactTotalBytes: 0,
    error: "request targeted a broker generation that is no longer active",
  });
  writeFileSync(join(results, `result-${raceRequest.generationId}.bin`), raceResult, { mode: 0o640 });
  const rejected = controller.collect("generation-race-1");
  assert.equal(rejected.ok, true, rejected.error);
  assert.equal(rejected.status, "INTERRUPTED");
  assert.equal(rejected.cancellationResolved, true);
  assert.equal(rejected.payloadDeathProof.state, "never_started");
  assert.equal(rejected.result.terminationReason, "broker_generation_mismatch");
  console.log("ok - controller verifies artifact ferry and two-phase terminal retention pruning");
} finally {
  // This test runs under WSL and only removes its own /tmp directory; it never creates Windows C: temp paths.
  rmSync(root, { recursive: true, force: true });
}
