import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeBrokerAck, decodeBrokerPruneReceipt, decodeBrokerRequest, decodeBrokerResult,
  encodeBrokerAck, encodeBrokerCancel, encodeBrokerPruneReceipt, encodeBrokerRequest, encodeBrokerResult,
} from "./hands/gamefactory-broker-protocol.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

const request = { requestId: sha("request"), runId: "run-1", requestHash: sha("controller-request"),
  policyHash: sha("policy"), brokerInstanceId: sha("broker-instance"),
  containerGenerationId: sha("container-generation"), program: "node", projectRelative: "vector-vault",
  projectQuotaId: 10_101,
  cwdRelative: "src", timeoutMs: 30_000,
  stdoutLimit: 100_000, stderrLimit: 100_000, totalLogLimit: 150_000, stepIndex: 2,
  totalSteps: 3, previousGenerationId: sha("previous"),
  workspaceDev: "123", workspaceIno: "456", args: ["--test", "a b", "λ"],
  collect: ["dist/index.html", "dist/main.js"] };

test("request encoding is canonical, generation-bound, and round trips Unicode argv", () => {
  const encoded = encodeBrokerRequest(request); const decoded = decodeBrokerRequest(encoded.bytes);
  assert.equal(decoded.generationId, encoded.generationId);
  assert.deepEqual(decoded.args, request.args); assert.equal(decoded.cwdRelative, "src");
  assert.equal(decoded.brokerInstanceId, request.brokerInstanceId);
  assert.equal(decoded.containerGenerationId, request.containerGenerationId);
  assert.deepEqual(decoded.collect, request.collect);
  assert.deepEqual(encodeBrokerRequest(decoded).bytes, encoded.bytes);
});

test("request digest, length, path, enum, argv and trailing-byte changes fail closed", () => {
  const encoded = encodeBrokerRequest(request); const corrupt = Buffer.from(encoded.bytes); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decodeBrokerRequest(corrupt), /generationId/);
  assert.throws(() => decodeBrokerRequest(Buffer.concat([encoded.bytes, Buffer.from([0])])), /trailing|length|canonical/);
  assert.throws(() => encodeBrokerRequest({ ...request, cwdRelative: "../escape" }), /canonical workspace-relative/);
  assert.throws(() => encodeBrokerRequest({ ...request, cwdRelative: "a//b" }), /canonical workspace-relative/);
  assert.throws(() => encodeBrokerRequest({ ...request, cwdRelative: "" }), /cwdRelative/);
  assert.throws(() => encodeBrokerRequest({ ...request, projectRelative: "." }), /dedicated workspace subtree/);
  assert.throws(() => encodeBrokerRequest({ ...request, projectRelative: "projects//game" }), /dedicated workspace subtree/);
  assert.throws(() => encodeBrokerRequest({ ...request, projectQuotaId: 0 }), /projectQuotaId/);
  assert.throws(() => encodeBrokerRequest({ ...request, projectQuotaId: 10_102 }), /reviewed static broker map/);
  assert.throws(() => encodeBrokerRequest({ ...request, projectRelative: "unreviewed", projectQuotaId: 10_123 }), /reviewed static broker map/);
  assert.throws(() => encodeBrokerRequest({ ...request, collect: ["dist/main.js", "dist/index.html"] }), /sort order/);
  assert.throws(() => encodeBrokerRequest({ ...request, collect: ["dist/../secret.txt"] }), /artifact-relative/);
  assert.throws(() => encodeBrokerRequest({ ...request, runId: "../run" }), /runId/);
  assert.throws(() => encodeBrokerRequest({ ...request, program: "sh" }), /not allowed/);
  assert.throws(() => encodeBrokerRequest({ ...request, containerGenerationId: "0" }), /64-hex/);
  assert.throws(() => encodeBrokerRequest({ ...request, stepIndex: 0 }), /previousGenerationId/);
  assert.throws(() => encodeBrokerRequest({ ...request, stepIndex: 3 }), /outside totalSteps/);
  assert.throws(() => encodeBrokerRequest({ ...request, args: Array(161).fill("x") }), /argv/);
});

test("cancellation is exact immediate-mode and generation scoped", () => {
  const generationId = encodeBrokerRequest(request).generationId;
  assert.ok(encodeBrokerCancel({ generationId, mode: "immediate", reason: "stop" }).length > 8);
  assert.throws(() => encodeBrokerCancel({ generationId, mode: "safe" }), /only accepts immediate/);
  assert.throws(() => encodeBrokerCancel({ generationId: "0" }), /64-hex/);
});

test("retention acknowledgement and prune receipt are canonical and hash-bound", () => {
  const generationId = encodeBrokerRequest(request).generationId;
  const acknowledgement = encodeBrokerAck({ generationId, resultSha256: sha("result"),
    artifactManifestSha256: sha("manifest") });
  assert.deepEqual(decodeBrokerAck(acknowledgement), {
    generationId, resultSha256: sha("result"), artifactManifestSha256: sha("manifest"),
  });
  const receipt = encodeBrokerPruneReceipt({ generationId, acknowledgementSha256: sha(acknowledgement),
    resultSha256: sha("result"), artifactManifestSha256: sha("manifest") });
  assert.equal(decodeBrokerPruneReceipt(receipt).acknowledgementSha256, sha(acknowledgement));
  assert.throws(() => decodeBrokerAck(Buffer.concat([acknowledgement, Buffer.from([0])])), /trailing/);
  assert.throws(() => encodeBrokerAck({ generationId, resultSha256: "0" }), /64-hex/);
});

test("result proof is state-dependent and never fabricates a PID", () => {
  const generationId = encodeBrokerRequest(request).generationId;
  const empty = sha("");
  const base = { generationId, runId: request.runId, stepIndex: request.stepIndex,
    totalSteps: request.totalSteps, previousGenerationId: request.previousGenerationId,
    requestId: request.requestId, requestHash: request.requestHash, policyHash: request.policyHash,
    brokerInstanceId: sha("instance"), brokerBootIdSha256: sha("boot"),
    deploymentPolicySha256: request.policyHash, brokerBinarySha256: sha("broker"),
    nodeGuardSha256: sha("node-guard"), godotGuardSha256: sha("godot-guard"),
    nodeExecutableSha256: sha("node"), godotExecutableSha256: sha("godot"),
    nodeFilterSha256: sha("node-filter"), godotFilterSha256: sha("godot-filter"),
    appArmorPolicySha256: sha("apparmor"), outerSeccompSha256: sha("outer-seccomp"),
    observedAt: "2026-09-01T00:00:00.000Z", stdoutLimit: request.stdoutLimit,
    stderrLimit: request.stderrLimit, totalLogLimit: request.totalLogLimit,
    stdoutSha256: empty, stdoutBytes: 0, stdoutTruncated: 0,
    stderrSha256: empty, stderrBytes: 0, stderrTruncated: 0, capsZero: 0, error: "" };
  const reaped = { ...base, state: "CANCELLED", exitCode: -1, payloadState: "reaped", pid: 321,
    starttime: "987654", decisionId: "",
    measuredGuardAppArmorLabel: "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-node-vector-vault (enforce)",
    expectedFinalAppArmorLabel: "dominion-gx10-gamefactory-broker//&dominion-gx10-guard-node-vector-vault//&dominion-gx10-payload-node-vector-vault (enforce)",
    finalTransitionAttested: 1, noNewPrivs: 1, seccompFilterCount: 2, capsZero: 1,
    waitIdPid: 321, waitIdCode: 2, waitIdStatus: 9,
    cancelEnvelopeSha256: sha("cancel"), terminationReason: "cancel", pidfdKillOutcome: "signalled" };
  assert.equal(decodeBrokerResult(encodeBrokerResult(reaped)).payloadState, "reaped");
  const never = { ...base, state: "CANCELLED", exitCode: -1, payloadState: "never_started", pid: 0,
    starttime: "", decisionId: sha("decision"), measuredGuardAppArmorLabel: "",
    expectedFinalAppArmorLabel: "", finalTransitionAttested: 0, noNewPrivs: 0,
    seccompFilterCount: 0, waitIdPid: 0, waitIdCode: 0, waitIdStatus: 0,
    cancelEnvelopeSha256: sha("cancel"), terminationReason: "cancel", pidfdKillOutcome: "none" };
  assert.equal(decodeBrokerResult(encodeBrokerResult(never)).payloadState, "never_started");
  const unmeasured = { ...base, state: "FAILED", exitCode: 78,
    payloadState: "child_reaped_unmeasured", pid: 322, starttime: "987655", decisionId: "",
    measuredGuardAppArmorLabel: "", expectedFinalAppArmorLabel: "", finalTransitionAttested: 0,
    noNewPrivs: 0, seccompFilterCount: 0, capsZero: 0,
    waitIdPid: 322, waitIdCode: 1, waitIdStatus: 78,
    cancelEnvelopeSha256: null, terminationReason: "guard_failed", pidfdKillOutcome: "already_dead" };
  assert.equal(decodeBrokerResult(encodeBrokerResult(unmeasured)).payloadState, "child_reaped_unmeasured");
  assert.throws(() => decodeBrokerResult(encodeBrokerResult({ ...never, pid: 22 })), /never-started proof/);
  assert.throws(() => decodeBrokerResult(encodeBrokerResult({ ...reaped, starttime: "" })), /reaped proof/);
  assert.throws(() => decodeBrokerResult(encodeBrokerResult({ ...reaped, waitIdPid: 999 })), /reaped proof/);
  assert.throws(() => decodeBrokerResult(encodeBrokerResult({ ...reaped,
    deploymentPolicySha256: sha("other-policy") })), /policy binding/);
  const successful = { ...reaped, state: "SUCCEEDED", exitCode: 0, waitIdCode: 1, waitIdStatus: 0,
    cancelEnvelopeSha256: null, terminationReason: "completion", pidfdKillOutcome: "none",
    artifactManifestSha256: sha("manifest"), artifactCount: 1, artifactTotalBytes: 5 };
  assert.equal(decodeBrokerResult(encodeBrokerResult(successful)).artifactManifestSha256, sha("manifest"));
  assert.throws(() => decodeBrokerResult(encodeBrokerResult({ ...successful, artifactManifestSha256: null })), /artifact manifest/);
  assert.throws(() => decodeBrokerResult(encodeBrokerResult({ ...reaped, artifactManifestSha256: sha("forbidden") })), /artifact publication/);
});

console.log(`\n${passed} game-factory broker protocol tests passed`);
