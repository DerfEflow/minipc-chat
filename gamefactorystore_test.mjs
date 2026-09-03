import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { REQUIRED_GAME_ARTIFACTS, QA_REQUIRED_SUITES } from "./gamefactory.mjs";
import {
  LOCKED_NATIVE_CHATGPT_PROJECT_ID, NATIVE_PROJECT_OWNER_ATTESTED_STATUS, OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  OWNER_ATTESTATION_OPERATOR, expectedNativeProjectFilename,
} from "./gamefactorynativeevidence.mjs";

const dir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-"));
let clock = 1_800_000_000_000;
const store = createGameFactoryStore({
  dir, now: () => clock,
  verifyReleaseEvidence: ({ status, evidence }) => ({
    ok: evidence?.provider === "verified-test-store"
      && /^[a-f0-9]{64}$/.test(String(evidence.submissionReceiptHash || ""))
      && (status !== "RELEASED" || /^[a-f0-9]{64}$/.test(String(evidence.releaseReceiptHash || ""))),
    verifier: "test-store-adapter",
  }),
});
let n = 0;
const test = (name, fn) => { const out = fn(); n++; console.log("ok", n, "-", name); return out; };
const owner = "owner-uid";
const other = "other-uid";

function ownerAttestationManifest(artifact, suffix = "visible-source") {
  return {
    formatVersion: 1,
    kind: NATIVE_PROJECT_OWNER_ATTESTED_STATUS,
    nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
    artifactId: artifact.id,
    artifactKey: artifact.artifactKey,
    artifactVersion: artifact.version,
    sha256: artifact.sha256,
    size: artifact.size,
    filename: expectedNativeProjectFilename(artifact),
    sourceCount: 1,
    operator: OWNER_ATTESTATION_OPERATOR,
    observedAt: new Date(clock).toISOString(),
    browserEvidenceRef: `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/visible/${artifact.id}-${suffix}`,
    uploadMethod: "BROWSER_FILE_UPLOAD",
    evidenceOrigin: "OWNER_CONTROLLED_CHATGPT_PROJECT_BROWSER",
    sourceListVisible: true,
    screenshotOnly: false,
    ownerAttestation: OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  };
}

function recordOwnerAttestedNative(uid, gameId, artifactId, suffix = "visible-source") {
  const artifact = store.getProject(uid, gameId)?.artifacts?.find((item) => item.id === artifactId);
  assert.ok(artifact, "test fixture needs the current artifact");
  return store.recordOwnerAttestedNativeProjectEvidence({ uid, artifactId, manifest: ownerAttestationManifest(artifact, suffix) });
}

try {
  test("portfolio seeding is complete and repeatable", () => {
    assert.equal(store.seedPortfolio({ uid: owner, email: "owner@example.com" }).length, 10);
    assert.equal(store.seedPortfolio({ uid: owner, email: "owner@example.com" }).length, 10);
    assert.equal(store.seedPortfolio({ uid: other, email: "other@example.com" }).length, 10);
  });

  const projectId = store.listProjects(owner)[0].id;

  test("tenant-scoped lookup hides another tenant's identifier", () => {
    assert.ok(store.getProject(owner, projectId));
    assert.equal(store.getProject(other, projectId), null);
  });

  test("trusted synthetic canaries are fixed, evidence-free, tenant-scoped and replay-safe", () => {
    const canaryProjectId = store.listProjects(owner)[9].id;
    const secondCanaryProjectId = store.listProjects(owner)[8].id;
    const before = store.getProject(owner, canaryProjectId);
    assert.equal(before.workspaceRoot, "");
    assert.equal(store.getProject(owner, secondCanaryProjectId).workspaceRoot, "");
    assert.equal(before.tasks.length, 0);
    assert.equal(before.tests.length, 0);
    assert.equal(before.artifacts.length, 0);
    assert.equal(before.releases.length, 0);

    const key = "synthetic-canary-replay-0001";
    const first = store.queueSyntheticCanary({
      uid: owner, projectId: canaryProjectId, key, actor: "owner@example.com",
      workspaceRoot: "/caller/cannot/override", payload: { workspaceRoot: "/caller/cannot/override" },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.capability, "quality_assurance");
    assert.equal(first.body.effects.qaEvidence, false);
    assert.match(first.body.audit.idempotencyFingerprint, /^[a-f0-9]{64}$/);
    const detail = store.getProject(owner, canaryProjectId);
    const task = detail.tasks.find((item) => item.id === first.body.taskId);
    assert.ok(task);
    assert.equal(task.buildId, "");
    assert.equal(task.capability, "quality_assurance");
    assert.equal(task.safeToRetry, true);
    assert.equal(task.maxAttempts, 2);
    assert.deepEqual(task.payload.workerPlan, {
      workspaceRoot: "/workspace/system-canary",
      steps: [{ label: "Report the Node.js runtime version", program: "node", args: ["--version"], cwd: ".", timeoutMs: 30_000 }],
      collect: [],
    });
    assert.deepEqual(Object.keys(task.payload).sort(), ["syntheticCanary", "workerPlan"]);
    assert.equal("workspaceRoot" in task.payload, false);
    assert.equal(JSON.stringify(task.payload).includes("gx10"), false);
    assert.equal(detail.tests.length, 0);
    assert.equal(detail.artifacts.length, 0);
    assert.equal(detail.releases.length, 0);
    assert.equal(detail.activeBuild, null);

    const replay = store.queueSyntheticCanary({ uid: owner, projectId: canaryProjectId, key, actor: "owner@example.com" });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.taskId, first.body.taskId);
    assert.equal(store.getProject(owner, canaryProjectId).tasks.length, 1);
    const concurrent = store.queueSyntheticCanary({ uid: owner, projectId: canaryProjectId, key: "synthetic-canary-concurrent-01" });
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.code, "synthetic_canary_in_progress");
    const crossProjectConcurrent = store.queueSyntheticCanary({
      uid: owner, projectId: secondCanaryProjectId, key: "synthetic-canary-cross-project-01",
    });
    assert.equal(crossProjectConcurrent.status, 409);
    assert.equal(crossProjectConcurrent.body.code, "synthetic_canary_in_progress");
    assert.equal(crossProjectConcurrent.body.taskId, first.body.taskId);
    const conflict = store.queueSyntheticCanary({ uid: owner, projectId: secondCanaryProjectId, key });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "idempotency_conflict");
    assert.equal(store.queueSyntheticCanary({ uid: other, projectId: canaryProjectId, key: "synthetic-other-tenant-01" }).status, 404);
    assert.equal(store.queueSyntheticCanary({ uid: owner, projectId: ` ${canaryProjectId}`, key: "synthetic-bad-project-01" }).body.code, "bad_project_id");
    assert.equal(store.queueSyntheticCanary({ uid: owner, projectId: canaryProjectId, key: "bad;canary-key-0001" }).body.code, "bad_idempotency_key");

    const claimed = store.claimNextTask({ workerId: "gx10-gamefactory", capability: "quality_assurance", leaseMs: 15_000 });
    assert.equal(claimed.id, first.body.taskId);
    const failed = store.failTask({
      uid: owner, taskId: claimed.id, workerId: "gx10-gamefactory", attempt: claimed.attempt,
      error: "synthetic probe failed", retryable: false,
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.syntheticCanary, true);
    assert.equal(failed.body.projectLifecycleUnaffected, true);
    const afterFailure = store.getProject(owner, canaryProjectId);
    assert.equal(afterFailure.state, before.state);
    assert.equal(afterFailure.version, before.version);
    assert.equal(afterFailure.tests.length, 0);
    assert.equal(afterFailure.artifacts.length, 0);
    assert.equal(afterFailure.releases.length, 0);
    assert.ok(afterFailure.events.some((event) => event.type === "synthetic_canary.queued"));
    assert.ok(afterFailure.events.some((event) => event.type === "synthetic_canary.failed"));

    const inspection = new DatabaseSync(store.file);
    const checkpointsBefore = Number(inspection.prepare("SELECT COUNT(*) AS n FROM game_checkpoints WHERE projectId=?").get(canaryProjectId).n);
    const success = store.queueSyntheticCanary({ uid: owner, projectId: canaryProjectId, key: "synthetic-canary-success-0001" });
    assert.equal(success.status, 201);
    const successClaim = store.claimNextTask({ workerId: "gx10-gamefactory", capability: "quality_assurance", leaseMs: 15_000 });
    assert.equal(successClaim.id, success.body.taskId);
    const completed = store.completeTask({
      uid: owner, taskId: successClaim.id, workerId: "gx10-gamefactory", attempt: successClaim.attempt,
      result: { status: "SUCCEEDED", artifacts: [{ path: "forged.apk" }] },
      checkpoint: { completedSteps: 1, complete: true, safeBoundary: true },
    });
    assert.equal(completed.status, 200);
    assert.equal(Number(inspection.prepare("SELECT COUNT(*) AS n FROM game_checkpoints WHERE projectId=?").get(canaryProjectId).n), checkpointsBefore);
    inspection.close();
    const afterSuccess = store.getProject(owner, canaryProjectId);
    assert.equal(afterSuccess.artifacts.length, 0);
    assert.equal(afterSuccess.tests.length, 0);
    assert.equal(afterSuccess.releases.length, 0);
    assert.ok(afterSuccess.events.some((event) => event.type === "synthetic_canary.completed"));
  });

  test("an expired synthetic canary never poisons the game lifecycle", () => {
    const canaryProjectId = store.listProjects(owner)[9].id;
    const queued = store.queueSyntheticCanary({
      uid: owner, projectId: canaryProjectId, key: "synthetic-canary-expiry-0001", actor: "owner@example.com",
    });
    assert.equal(queued.status, 201);
    let claimed = store.claimNextTask({ workerId: "gx10-gamefactory", capability: "quality_assurance", leaseMs: 15_000 });
    assert.equal(claimed.id, queued.body.taskId);
    clock += 20_000;
    const firstExpiry = store.reconcile();
    assert.equal(firstExpiry.requeued, 1);
    claimed = store.claimNextTask({ workerId: "gx10-gamefactory", capability: "quality_assurance", leaseMs: 15_000 });
    assert.equal(claimed.id, queued.body.taskId);
    clock += 20_000;
    const finalExpiry = store.reconcile();
    assert.equal(finalExpiry.failed, 0);
    const detail = store.getProject(owner, canaryProjectId);
    assert.equal(detail.state, "IDEA");
    assert.equal(detail.tasks.find((task) => task.id === queued.body.taskId).status, "FAILED");
  });

  test("an ordinary task cannot forge the synthetic canary lifecycle exemption", () => {
    const ordinaryProjectId = store.listProjects(owner)[7].id;
    const payload = {
      syntheticCanary: { schema: "game-factory.synthetic-worker-canary.v1", evidenceEffects: "none" },
      workerPlan: {
        workspaceRoot: "/workspace/system-canary",
        steps: [{
          label: "Report the Node.js runtime version", program: "node", args: ["--version"], cwd: ".", timeoutMs: 30_000,
        }],
        collect: [],
      },
    };
    const queued = store.queueTask({
      uid: owner, projectId: ordinaryProjectId, buildId: "", capability: "quality_assurance",
      title: "Trusted synthetic worker canary", payload,
      acceptance: ["The fixed Node.js version probe exits successfully without collecting artifacts."],
      priority: 1000, safeToRetry: true, maxAttempts: 2,
    });
    assert.equal(queued.status, 201);
    assert.match(queued.body.taskId, /^gft_[0-9a-f-]{36}$/);
    assert.doesNotMatch(queued.body.taskId, /^gft_canary_/);
    const claimed = store.claimNextTask({ workerId: "gx10-gamefactory", capability: "quality_assurance", leaseMs: 15_000 });
    assert.equal(claimed.id, queued.body.taskId);
    const failed = store.failTask({
      uid: owner, taskId: claimed.id, workerId: "gx10-gamefactory", attempt: claimed.attempt,
      error: "ordinary lookalike failed", retryable: false,
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.syntheticCanary, undefined);
    const detail = store.getProject(owner, ordinaryProjectId);
    assert.equal(detail.state, "FAILED");
    assert.ok(detail.events.some((event) => event.type === "task.failed" && event.payload.taskId === claimed.id));
    assert.equal(detail.events.some((event) => event.type.startsWith("synthetic_canary.") && event.payload.taskId === claimed.id), false);
  });

  test("a real synthetic canary keeps its lifecycle exemption after store restart", () => {
    const restartDir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-canary-restart-"));
    const restartUid = "restart-owner";
    let first;
    try {
      first = createGameFactoryStore({ dir: restartDir, now: () => clock });
      const project = first.seedPortfolio({ uid: restartUid, email: "restart@example.com" })[0];
      assert.equal(first.getProject(restartUid, project.id).workspaceRoot, "");
      const queued = first.queueSyntheticCanary({
        uid: restartUid, projectId: project.id, key: "restart-canary-idempotency-01", actor: restartUid,
      });
      assert.equal(queued.status, 201);
      assert.match(queued.body.taskId, /^gft_canary_[a-f0-9]{32}$/);
      first.close(); first = null;
      const reopened = createGameFactoryStore({ dir: restartDir, now: () => clock });
      try {
        const claimed = reopened.claimNextTask({ workerId: "gx10-gamefactory", capability: "quality_assurance", leaseMs: 15_000 });
        assert.equal(claimed.id, queued.body.taskId);
        const failed = reopened.failTask({
          uid: restartUid, taskId: claimed.id, workerId: "gx10-gamefactory", attempt: claimed.attempt,
          error: "restart canary failed", retryable: false,
        });
        assert.equal(failed.body.syntheticCanary, true);
        assert.equal(reopened.getProject(restartUid, project.id).state, "IDEA");
      } finally { reopened.close(); }
    } finally {
      try { first?.close(); } catch {}
      rmSync(restartDir, { recursive: true, force: true });
    }
  });

  test("a security stop overrides stale completion and invalidates every unsafe pause checkpoint", () => {
    const securityUid = "security-stop-owner";
    const [securityProject] = store.seedPortfolio({ uid: securityUid, email: "security-stop@example.com" });
    const queued = store.queueTask({
      uid: securityUid, projectId: securityProject.id, capability: "gameplay_engineering",
      title: "Race a completion against proof loss", safeToRetry: true,
    });
    assert.equal(queued.status, 201);
    const claimed = store.claimNextTask({
      workerId: "gx10-gamefactory", capability: "gameplay_engineering", leaseMs: 30_000,
    });
    assert.equal(claimed.id, queued.body.taskId);
    const beforePause = store.getProject(securityUid, securityProject.id);
    assert.equal(store.executeCommand({
      uid: securityUid, projectId: securityProject.id, key: "security-stop-pause-race",
      expectedVersion: beforePause.version, type: "pause",
    }).status, 202);
    // Simulate the stale leader winning first: it commits success and both a task checkpoint and
    // finalizePause's generic owner-operation checkpoint.
    assert.equal(store.completeTask({
      uid: securityUid, taskId: claimed.id, workerId: "gx10-gamefactory", attempt: claimed.attempt,
      result: { status: "SUCCEEDED", staleObserver: true }, checkpoint: { complete: true, unsafeAfterProofLoss: true },
    }).status, 200);
    assert.equal(store.getProject(securityUid, securityProject.id).state, "PAUSED");
    const inspection = new DatabaseSync(store.file);
    const compatibleBefore = Number(inspection.prepare(
      "SELECT COUNT(*) AS n FROM game_checkpoints WHERE projectId=? AND compatible=1",
    ).get(securityProject.id).n);
    assert.ok(compatibleBefore >= 2);

    const stopped = store.securityStopTask({
      uid: securityUid, taskId: claimed.id, attempt: claimed.attempt,
      error: "The worker lost its current isolation proof while this task was active.",
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.securityStopped, true);
    assert.ok(stopped.body.invalidatedCheckpoints >= 2);
    const corrected = store.getProject(securityUid, securityProject.id);
    assert.equal(corrected.tasks.find((task) => task.id === claimed.id).status, "FAILED");
    assert.equal(corrected.tasks.find((task) => task.id === claimed.id).result.securityStopped, true);
    assert.equal(corrected.state, "BLOCKED");
    assert.match(corrected.blocker, /lost its isolation proof/i);
    assert.equal(Number(inspection.prepare(
      "SELECT COUNT(*) AS n FROM game_checkpoints WHERE projectId=? AND compatible=1",
    ).get(securityProject.id).n), 0);
    assert.equal(store.completeTask({
      uid: securityUid, taskId: claimed.id, workerId: "gx10-gamefactory", attempt: claimed.attempt,
      result: { status: "SUCCEEDED", tooLate: true }, checkpoint: { forged: true },
    }).body.code, "lease_lost");
    const replay = store.securityStopTask({
      uid: securityUid, taskId: claimed.id, attempt: claimed.attempt, error: "same security stop",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    inspection.close();

    const secondProject = store.seedPortfolio({ uid: securityUid, email: "security-stop@example.com" })[1];
    const secondQueued = store.queueTask({
      uid: securityUid, projectId: secondProject.id, capability: "gameplay_engineering",
      title: "Security stop wins first", safeToRetry: true,
    });
    const secondClaim = store.claimNextTask({
      workerId: "gx10-gamefactory", capability: "gameplay_engineering", leaseMs: 30_000,
    });
    assert.equal(secondClaim.id, secondQueued.body.taskId);
    assert.equal(store.securityStopTask({
      uid: securityUid, taskId: secondClaim.id, attempt: secondClaim.attempt,
    }).status, 200);
    assert.equal(store.completeTask({
      uid: securityUid, taskId: secondClaim.id, workerId: "gx10-gamefactory", attempt: secondClaim.attempt,
      result: { status: "SUCCEEDED" }, checkpoint: { shouldNotExist: true },
    }).body.code, "lease_lost");
  });

  test("commands require optimistic version and replay by idempotency key", () => {
    const before = store.getProject(owner, projectId);
    const args = { uid: owner, projectId, key: "advance-1", expectedVersion: before.version, type: "advance", actor: "owner@example.com" };
    const first = store.executeCommand(args);
    assert.equal(first.status, 200);
    assert.equal(first.body.project.state, "SPECIFICATION");
    const replay = store.executeCommand(args);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const conflict = store.executeCommand({ ...args, type: "pause" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "idempotency_conflict");
    const stale = store.executeCommand({ uid: owner, projectId, key: "stale", expectedVersion: before.version, type: "advance" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "version_conflict");
    const current = store.getProject(owner, projectId);
    for (const hold of ["PAUSED", "BLOCKED", "FAILED"]) {
      const refused = store.executeCommand({ uid: owner, projectId, key: `hold-bypass-${hold}`, expectedVersion: current.version, type: "transition", payload: { toState: hold } });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "hold_transition_requires_command");
    }
    assert.equal(store.getProject(owner, projectId).state, "SPECIFICATION");
  });

  test("pause without an active worker is immediately durable and resumable", () => {
    const before = store.getProject(owner, projectId);
    const paused = store.executeCommand({ uid: owner, projectId, key: "pause-1", expectedVersion: before.version, type: "pause" });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.project.state, "PAUSED");
    assert.equal(paused.body.project.resumeState, "SPECIFICATION");
    const resumed = store.executeCommand({ uid: owner, projectId, key: "resume-1", expectedVersion: paused.body.project.version, type: "resume" });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.project.state, "SPECIFICATION");
  });

  let taskId;
  test("one writer lease per project and truthful safe-boundary pause", () => {
    const queued = store.queueTask({ uid: owner, projectId, capability: "product_planning", title: "Draft the market case", safeToRetry: true });
    assert.equal(queued.status, 201);
    taskId = queued.body.taskId;
    const task = store.claimNextTask({ workerId: "gx10", capability: "product_planning", leaseMs: 30_000 });
    assert.equal(task.id, taskId);
    assert.equal(store.claimNextTask({ workerId: "gx10-b", capability: "product_planning" }), null);

    const before = store.getProject(owner, projectId);
    const requested = store.executeCommand({ uid: owner, projectId, key: "pause-active", expectedVersion: before.version, type: "pause" });
    assert.equal(requested.status, 202);
    assert.equal(requested.body.project.state, "SPECIFICATION");
    assert.equal(requested.body.project.operation, "PAUSE_REQUESTED");
    assert.equal(store.heartbeatTask({ uid: owner, taskId, workerId: "gx10", attempt: task.attempt }).body.stopRequested, true);

    const stopped = store.completeTask({ uid: owner, taskId, workerId: "gx10", attempt: task.attempt, result: { draft: "preserved" }, checkpoint: { next: "review" } });
    assert.equal(stopped.status, 200);
    assert.equal(store.getProject(owner, projectId).state, "PAUSED");
    const resume = store.executeCommand({ uid: owner, projectId, key: "resume-active", expectedVersion: store.getProject(owner, projectId).version, type: "resume" });
    assert.equal(resume.status, 200);
    assert.equal(resume.body.project.tasks, undefined);
    assert.equal(store.getProject(owner, projectId).tasks.find((task) => task.id === taskId).status, "QUEUED");
  });

  test("a completion racing with pause is never re-executed after resume", () => {
    const queued = store.queueTask({ uid: owner, projectId, capability: "quality_assurance", title: "Finish at the boundary", safeToRetry: true });
    const claimed = store.claimNextTask({ workerId: "gx10-race", capability: "quality_assurance", leaseMs: 30_000 });
    assert.equal(claimed.id, queued.body.taskId);
    const before = store.getProject(owner, projectId);
    assert.equal(store.executeCommand({ uid: owner, projectId, key: "pause-completion-race", expectedVersion: before.version, type: "pause" }).status, 202);
    const finished = store.completeTask({ uid: owner, taskId: claimed.id, workerId: "gx10-race", attempt: claimed.attempt, result: { status: "SUCCEEDED", output: "done" }, checkpoint: { completedSteps: 1, complete: true } });
    assert.equal(finished.status, 200);
    assert.equal(finished.body.paused, false);
    const staleFailure = store.failTask({ uid: owner, taskId: claimed.id, workerId: "gx10-race", attempt: claimed.attempt, error: "late contradictory failure" });
    assert.equal(staleFailure.status, 409);
    assert.equal(staleFailure.body.code, "lease_lost");
    const paused = store.getProject(owner, projectId);
    assert.equal(paused.state, "PAUSED");
    assert.equal(paused.tasks.find((task) => task.id === claimed.id).status, "COMPLETED");
    assert.equal(store.executeCommand({ uid: owner, projectId, key: "resume-completion-race", expectedVersion: paused.version, type: "resume" }).status, 200);
    assert.equal(store.getProject(owner, projectId).tasks.find((task) => task.id === claimed.id).status, "COMPLETED");
  });

  test("expired replay-safe work requeues while non-retryable work fails closed", () => {
    const claimed = store.claimNextTask({ workerId: "gx10", capability: "product_planning", leaseMs: 15_000 });
    assert.equal(claimed.id, taskId);
    clock += 20_000;
    const recoveredLease = store.heartbeatTask({ uid: owner, taskId, workerId: "gx10", attempt: claimed.attempt, leaseMs: 15_000 });
    assert.equal(recoveredLease.status, 200);
    clock += 20_000;
    const recovered = store.reconcile();
    assert.equal(recovered.expired, 1);
    assert.equal(recovered.requeued, 1);
    assert.equal(store.heartbeatTask({ uid: owner, taskId, workerId: "gx10", attempt: claimed.attempt }).body.code, "lease_lost");
    assert.equal(store.completeTask({ uid: owner, taskId, workerId: "gx10", attempt: claimed.attempt, result: { stale: true } }).body.code, "lease_lost");

    const risky = store.queueTask({ uid: owner, projectId, capability: "release_coordination", title: "Upload a release", safeToRetry: false });
    assert.equal(risky.status, 201);
    // The requeued planning task still owns queue priority. Finish it, then claim the risky task.
    const planning = store.claimNextTask({ workerId: "gx10", capability: "product_planning", leaseMs: 15_000 });
    store.completeTask({ uid: owner, taskId: planning.id, workerId: "gx10", attempt: planning.attempt, result: { ok: true } });
    const release = store.claimNextTask({ workerId: "gx10", capability: "release_coordination", leaseMs: 15_000 });
    assert.equal(release.id, risky.body.taskId);
    clock += 20_000;
    const failed = store.reconcile();
    assert.equal(failed.failed, 1);
    assert.equal(store.getProject(owner, projectId).state, "FAILED");
  });

  test("retry returns to the saved lifecycle state", () => {
    const before = store.getProject(owner, projectId);
    const retried = store.executeCommand({ uid: owner, projectId, key: "retry-failed", expectedVersion: before.version, type: "retry" });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.project.state, "SPECIFICATION");
  });

  let buildId;
  test("build creation invalidates prior approvals and binds later evidence", () => {
    const built = store.createBuild({ uid: owner, projectId, sourceCommit: "abc123", toolchain: { godot: "4.7" }, targets: ["android", "ios"], versionName: "0.1.0", versionCode: 1 });
    assert.equal(built.status, 201);
    buildId = built.body.buildId;
    assert.equal(store.getProject(owner, projectId).activeBuild.id, buildId);
  });

  test("native Project completion requires append-only owner evidence after primary and Drive verification", () => {
    const hash = "a".repeat(64);
    const made = store.recordArtifact({ uid: owner, projectId, artifactKey: REQUIRED_GAME_ARTIFACTS[0], sha256: hash, size: 12, mimeType: "text/markdown" });
    assert.equal(made.status, 201);
    const wrong = store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: "b".repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.status, "CONFLICT");
    const missingPrimary = recordOwnerAttestedNative(owner, projectId, made.body.artifactId);
    assert.equal(missingPrimary.status, 409);
    assert.equal(missingPrimary.body.code, "native_project_primary_unverified");
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: hash }).status, 200);
    assert.equal(store.getProject(owner, projectId).artifacts[0].complete, false);
    const missingDrive = recordOwnerAttestedNative(owner, projectId, made.body.artifactId);
    assert.equal(missingDrive.status, 409);
    assert.equal(missingDrive.body.code, "native_project_drive_unverified");
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
    // Required behavior 1 (deficiency 15, 2026-09-03): chatgpt_project is a DEFERRED backend, not
    // mandatory. With this default store config, primary+google_drive verified is already complete;
    // native Project evidence remains a genuine, still-tested append-only mechanism below, it just
    // no longer gates completeness for the default MANDATORY_ARTIFACT_BACKENDS.
    assert.equal(store.getProject(owner, projectId).artifacts[0].complete, true);
    assert.equal(store.getProject(owner, projectId).artifacts[0].copies.find((copy) => copy.backend === "chatgpt_project").status, "DEFERRED");
    const rejected = store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "chatgpt_project", status: "VERIFIED", fingerprint: hash });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, "native_project_evidence_offline_only");
    const evidence = recordOwnerAttestedNative(owner, projectId, made.body.artifactId);
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
    const replay = recordOwnerAttestedNative(owner, projectId, made.body.artifactId);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const current = store.getProject(owner, projectId).artifacts.find((artifact) => artifact.id === made.body.artifactId);
    assert.equal(current.complete, true);
    assert.equal(current.copies.find((copy) => copy.backend === "chatgpt_project").status, "OWNER_ATTESTED");
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "invented", status: "VERIFIED", fingerprint: hash }).status, 400);
    const replacement = recordOwnerAttestedNative(owner, projectId, made.body.artifactId, "second-visible-source");
    assert.equal(replacement.status, 409);
    assert.equal(replacement.body.code, "native_project_evidence_already_active");
    assert.equal(store.getProject(owner, projectId).complete, false);
  });

  test("test evidence binds to the active build and release truth cannot skip approval", () => {
    const beforeUnknown = store.getProject(owner, projectId).tests.length;
    const unknown = store.recordTestRun({ uid: owner, projectId, buildId, suite: "informational-benchmark", target: "portfolio", status: "PASSED", sourceHash: "abc123" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "bad_suite");
    assert.equal(store.getProject(owner, projectId).tests.length, beforeUnknown);
    for (const suite of QA_REQUIRED_SUITES) {
      assert.equal(store.recordTestRun({ uid: owner, projectId, buildId, suite, target: "portfolio", status: "PASSED", sourceHash: "abc123", evidence: { log: "ok" } }).status, 201);
    }
    assert.equal(store.recordRelease({ uid: owner, projectId, buildId, platform: "android", packageId: "tools.dominion.vectorvault", versionName: "0.1.0", versionCode: 1, status: "READY" }).status, 201);
    assert.equal(store.recordRelease({ uid: owner, projectId, buildId, platform: "ios", packageId: "tools.dominion.vectorvault", versionName: "0.1.0", versionCode: 1, status: "READY" }).status, 201);
    const forged = store.recordRelease({ uid: owner, projectId, buildId, platform: "android", packageId: "tools.dominion.vectorvault", versionName: "0.1.0", versionCode: 1, status: "RELEASED", evidence: { submissionReceiptHash: "a".repeat(64), releaseReceiptHash: "b".repeat(64), provider: "verified-test-store" } });
    assert.equal(forged.status, 409);
    assert.equal(forged.body.code, "release_status_regression");
    const detail = store.getProject(owner, projectId);
    assert.equal(detail.evidence.automatedTestsPassed, true);
    assert.equal(detail.evidence.qaReady, true);
    assert.equal(detail.evidence.releaseReady, false);
  });

  test("approval decisions are durable and rejection routes to revision", () => {
    let before = store.getProject(owner, projectId);
    const wrongGate = store.executeCommand({ uid: owner, projectId, key: "approve-too-early", expectedVersion: before.version, type: "approve", payload: { gate: "PLAYTEST" }, actor: "owner@example.com" });
    assert.equal(wrongGate.status, 409);
    assert.equal(wrongGate.body.code, "gate_not_available");
    const missing = store.executeCommand({ uid: owner, projectId, key: "approve-missing-specification", expectedVersion: before.version, type: "approve", payload: { gate: "SPECIFICATION" }, actor: "owner@example.com" });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, "approval_subject_missing");
    for (const key of ["01_MARKET_CASE", "02_RELEASE_ROADMAP", "03_BUILD_WORKFLOW", "04_GAME_ARCHITECTURE", "05_VISUAL_SYSTEM"]) {
      const hash = String(key.charCodeAt(0) % 10).repeat(64);
      const created = store.recordArtifact({ uid: owner, projectId, artifactKey: key, sha256: hash });
      assert.equal(created.status, 201);
      assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: created.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: created.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(recordOwnerAttestedNative(owner, projectId, created.body.artifactId).status, 201);
    }
    before = store.getProject(owner, projectId);
    const staleSubject = store.executeCommand({ uid: owner, projectId, key: "approve-stale-specification", expectedVersion: before.version, type: "approve", payload: { gate: "SPECIFICATION", subjectHash: "f".repeat(64) }, actor: "owner@example.com" });
    assert.equal(staleSubject.status, 409);
    assert.equal(staleSubject.body.code, "approval_subject_changed");
    const approved = store.executeCommand({ uid: owner, projectId, key: "approve-specification", expectedVersion: before.version, type: "approve", payload: { gate: "SPECIFICATION", rationale: "Pilot accepted" }, actor: "owner@example.com" });
    assert.equal(approved.status, 200);
    assert.match(approved.body.subjectHash, /^[a-f0-9]{64}$/);
    assert.equal(store.getProject(owner, projectId).approvals[0].gate, "SPECIFICATION");
    const current = store.getProject(owner, projectId);
    const rejected = store.executeCommand({ uid: owner, projectId, key: "reject-specification", expectedVersion: current.version, type: "reject", payload: { gate: "SPECIFICATION", rationale: "Revise scope" }, actor: "owner@example.com" });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.project.state, "REVISION");
  });

  test("admission gates, latest QA truth and late material changes fail closed", () => {
    const pilotId = store.listProjects(other)[0].id;
    let seq = 0;
    const command = (type, payload = {}) => {
      const current = store.getProject(other, pilotId);
      return store.executeCommand({ uid: other, projectId: pilotId, key: `pilot-${++seq}-${type}`, expectedVersion: current.version, type, payload, actor: "owner@example.com" });
    };
    assert.equal(command("advance").body.project.state, "SPECIFICATION");
    assert.equal(command("advance").body.code, "specification_approval_required");
    for (const [index, key] of REQUIRED_GAME_ARTIFACTS.entries()) {
      const hash = ((index % 6) + 10).toString(16).repeat(64);
      const created = store.recordArtifact({ uid: other, projectId: pilotId, artifactKey: key, sha256: hash });
      assert.equal(created.status, 201);
      assert.equal(store.recordArtifactCopy({ uid: other, artifactId: created.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(store.recordArtifactCopy({ uid: other, artifactId: created.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(recordOwnerAttestedNative(other, pilotId, created.body.artifactId).status, 201);
    }
    assert.equal(command("approve", { gate: "SPECIFICATION" }).status, 200);
    assert.equal(command("advance").body.project.state, "ARCHITECTURE");
    assert.equal(command("advance").body.code, "visual_approval_required");
    assert.equal(command("approve", { gate: "VISUAL_SYSTEM" }).status, 200);
    for (const state of ["ASSET_GENERATION", "IMPLEMENTATION", "INTEGRATION", "AUTOMATED_TESTING"]) {
      assert.equal(command("advance").body.project.state, state);
    }
    const created = store.createBuild({ uid: other, projectId: pilotId, sourceCommit: "pilot-source", targets: ["android", "ios"] });
    const pilotBuildId = created.body.buildId;
    store.recordTestRun({ uid: other, projectId: pilotId, buildId: pilotBuildId, suite: "core-loop", status: "PASSED", sourceHash: "pilot-source" });
    assert.equal(store.getProject(other, pilotId).evidence.automatedTestsPassed, true);
    store.recordTestRun({ uid: other, projectId: pilotId, buildId: pilotBuildId, suite: "core-loop", status: "FAILED", sourceHash: "pilot-source" });
    assert.equal(store.getProject(other, pilotId).evidence.automatedTestsPassed, false);
    store.recordTestRun({ uid: other, projectId: pilotId, buildId: pilotBuildId, suite: "core-loop", status: "PASSED", sourceHash: "pilot-source" });
    for (const suite of QA_REQUIRED_SUITES.filter((item) => item !== "core-loop")) {
      store.recordTestRun({ uid: other, projectId: pilotId, buildId: pilotBuildId, suite, status: "PASSED", sourceHash: "pilot-source" });
    }
    const playtestTransition = command("advance");
    assert.equal(playtestTransition.status, 200, JSON.stringify(playtestTransition.body));
    assert.equal(playtestTransition.body.project.state, "PLAYTEST_READY");
    assert.equal(command("approve", { gate: "PLAYTEST" }).status, 200);
    assert.equal(command("advance").body.project.state, "RELEASE_CANDIDATE");
    assert.equal(store.recordArtifact({ uid: other, projectId: pilotId, artifactKey: "00_GAME_BRIEF", sha256: "c".repeat(64) }).status, 201);
    const revised = store.getProject(other, pilotId);
    assert.equal(revised.state, "REVISION");
    assert.equal(revised.evidence.playtestApproved, false);
    assert.match(revised.blocker, /invalidated/i);
  });

  test("an expired worker lease never masquerades as a confirmed owner pause or stop", () => {
    const leaseUid = "lease-owner";
    const projects = store.seedPortfolio({ uid: leaseUid });
    for (const [index, requested] of ["pause", "stop"].entries()) {
      const id = projects[index].id;
      const queued = store.queueTask({ uid: leaseUid, projectId: id, capability: "product_planning", title: "Lease-bound work", safeToRetry: true });
      const task = store.claimNextTask({ workerId: `lease-worker-${index}`, capability: "product_planning", leaseMs: 15_000 });
      assert.equal(task.id, queued.body.taskId);
      const current = store.getProject(leaseUid, id);
      assert.equal(store.executeCommand({ uid: leaseUid, projectId: id, key: `lease-${requested}`, expectedVersion: current.version, type: requested }).status, 202);
      clock += 20_000;
      const report = store.reconcile();
      assert.equal(report.blocked, 1);
      const blocked = store.getProject(leaseUid, id);
      assert.equal(blocked.state, "BLOCKED");
      assert.equal(blocked.operation, "");
      assert.match(blocked.blocker, /before the requested (pause|stop).*confirmed safe boundary/i);
      assert.equal(blocked.tasks.find((item) => item.id === task.id).status, "FAILED");
    }
  });

  test("release approvals bind immutable subjects and authorize only verified forward transitions", () => {
    const releaseUid = "release-owner";
    const releaseProject = store.seedPortfolio({ uid: releaseUid })[0];
    let sequence = 0;
    const command = (type, payload = {}) => {
      const current = store.getProject(releaseUid, releaseProject.id);
      return store.executeCommand({ uid: releaseUid, projectId: releaseProject.id, key: `release-${++sequence}-${type}`, expectedVersion: current.version, type, payload, actor: "publisher@example.com" });
    };
    assert.equal(command("advance").body.project.state, "SPECIFICATION");
    for (const [index, key] of REQUIRED_GAME_ARTIFACTS.entries()) {
      const hash = ((index % 6) + 10).toString(16).repeat(64);
      const artifact = store.recordArtifact({ uid: releaseUid, projectId: releaseProject.id, artifactKey: key, sha256: hash, size: 100 + index });
      assert.equal(artifact.status, 201);
      assert.equal(store.recordArtifactCopy({ uid: releaseUid, artifactId: artifact.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(store.recordArtifactCopy({ uid: releaseUid, artifactId: artifact.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(recordOwnerAttestedNative(releaseUid, releaseProject.id, artifact.body.artifactId).status, 201);
    }
    assert.equal(command("approve", { gate: "SPECIFICATION" }).status, 200);
    assert.equal(command("advance").body.project.state, "ARCHITECTURE");
    assert.equal(command("approve", { gate: "VISUAL_SYSTEM" }).status, 200);
    for (const state of ["ASSET_GENERATION", "IMPLEMENTATION", "INTEGRATION", "AUTOMATED_TESTING"]) {
      assert.equal(command("advance").body.project.state, state);
    }
    const built = store.createBuild({ uid: releaseUid, projectId: releaseProject.id, sourceCommit: "release-source", targets: ["android", "ios"], versionName: "1.0.0", versionCode: 1 });
    assert.equal(built.status, 201);
    for (const suite of QA_REQUIRED_SUITES) {
      assert.equal(store.recordTestRun({ uid: releaseUid, projectId: releaseProject.id, buildId: built.body.buildId, suite, status: "PASSED", sourceHash: "release-source" }).status, 201);
    }
    assert.equal(command("advance").body.project.state, "PLAYTEST_READY");
    assert.equal(command("approve", { gate: "PLAYTEST" }).status, 200);
    assert.equal(command("advance").body.project.state, "RELEASE_CANDIDATE");
    assert.equal(command("approve", { gate: "RELEASE_CANDIDATE" }).status, 200);
    assert.equal(command("approve", { gate: "LEGAL_AND_PRIVACY" }).status, 200);
    assert.equal(command("advance").body.project.state, "APPROVED");
    assert.equal(command("advance").body.project.state, "STORE_PREP");

    const releaseInput = (platform, status, evidence = {}) => ({
      uid: releaseUid, projectId: releaseProject.id, buildId: built.body.buildId, platform,
      packageId: `tools.dominion.${platform}`, versionName: "1.0.0", versionCode: 1,
      status, storeLocator: `store://${platform}/tools.dominion.${platform}`, evidence,
    });
    assert.equal(store.recordRelease(releaseInput("android", "READY")).status, 201);
    assert.equal(store.recordRelease(releaseInput("ios", "READY")).status, 201);
    const androidSubmission = "a".repeat(64), iosSubmission = "b".repeat(64);
    const beforeApproval = store.recordRelease(releaseInput("android", "SUBMITTED", { provider: "verified-test-store", submissionReceiptHash: androidSubmission }));
    assert.equal(beforeApproval.status, 409);
    assert.equal(beforeApproval.body.code, "store_submission_approval_required");
    const storeApproval = command("approve", { gate: "STORE_SUBMISSION" });
    assert.equal(storeApproval.status, 200);
    assert.match(storeApproval.body.subjectHash, /^[a-f0-9]{64}$/);
    const unverified = store.recordRelease(releaseInput("android", "SUBMITTED", { provider: "forged", submissionReceiptHash: androidSubmission }));
    assert.equal(unverified.status, 409);
    assert.equal(unverified.body.code, "release_evidence_unverified");
    assert.equal(store.recordRelease(releaseInput("android", "SUBMITTED", { provider: "verified-test-store", submissionReceiptHash: androidSubmission })).status, 201);
    assert.equal(store.recordRelease(releaseInput("ios", "SUBMITTED", { provider: "verified-test-store", submissionReceiptHash: iosSubmission })).status, 201);
    assert.equal(store.getProject(releaseUid, releaseProject.id).evidence.storeSubmissionApproved, true);

    const productionApproval = command("approve", { gate: "PRODUCTION_RELEASE" });
    assert.equal(productionApproval.status, 200);
    const changedSubject = store.recordRelease(releaseInput("android", "RELEASED", {
      provider: "verified-test-store", submissionReceiptHash: "c".repeat(64), releaseReceiptHash: "d".repeat(64),
    }));
    assert.equal(changedSubject.status, 409);
    assert.equal(changedSubject.body.code, "release_subject_changed");
    assert.equal(store.recordRelease(releaseInput("android", "RELEASED", { provider: "verified-test-store", submissionReceiptHash: androidSubmission, releaseReceiptHash: "d".repeat(64) })).status, 201);
    assert.equal(store.recordRelease(releaseInput("ios", "RELEASED", { provider: "verified-test-store", submissionReceiptHash: iosSubmission, releaseReceiptHash: "e".repeat(64) })).status, 201);
    const ready = store.getProject(releaseUid, releaseProject.id);
    assert.equal(ready.evidence.productionReleaseApproved, true);
    assert.equal(ready.evidence.releaseReady, true);
    assert.equal(command("advance").body.project.state, "DEPLOYED");
  });

  test("secret-shaped task and event data is redacted before persistence", () => {
    const marker = "super-sensitive-marker-9347";
    const queued = store.queueTask({
      uid: owner, projectId, capability: "product_planning", title: `Review api_key=${marker}`,
      payload: {
        accessToken: marker, DATABASE_URL: `postgres://owner:${marker}@db.example/game`, note: `Bearer ${marker}`,
        quoted: `{"password":"${marker}"}`, basic: `Authorization: Basic ${marker}`,
        cookieHeader: `Cookie: sid=${marker}`, partialPem: `-----BEGIN PRIVATE KEY-----\n${marker}`,
      },
      acceptance: [`password=${marker}`], safeToRetry: true,
    });
    assert.equal(queued.status, 201);
    const serialized = JSON.stringify(store.getProject(owner, projectId));
    assert.equal(serialized.includes(marker), false);
    assert.match(serialized, /redacted/);
  });

  test("events and database health are durable", () => {
    const events = store.events(owner, projectId, 0, 1000);
    assert.ok(events.length >= 15);
    assert.equal(events[0].type, "project.created");
    assert.equal(store.health().ok, true);
    assert.equal(store.health().schema.version, 2);
    assert.equal(store.stats().runningTasks, 0);
    assert.ok(store.stats().taskStatus.COMPLETED >= 1);
  });

  store.close();
  const reopened = createGameFactoryStore({ dir, now: () => clock });
  test("state survives a fresh process", () => {
    assert.equal(reopened.getProject(owner, projectId).state, "REVISION");
    assert.ok(reopened.events(owner, projectId, 0, 1000).length >= 15);
  });
  reopened.close();

  test("schema metadata mismatches are rejected even after an interrupted version write", () => {
    const metadataDir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-metadata-"));
    try {
      createGameFactoryStore({ dir: metadataDir }).close();
      const metadata = new DatabaseSync(join(metadataDir, "gamefactory.db"));
      metadata.exec("PRAGMA user_version=0");
      metadata.prepare("UPDATE game_factory_schema SET checksum='wrong'").run();
      metadata.close();
      assert.throws(() => createGameFactoryStore({ dir: metadataDir }), /metadata does not match/);
    } finally { rmSync(metadataDir, { recursive: true, force: true }); }
  });

  test("a future schema is rejected instead of being guessed at", () => {
    const future = new DatabaseSync(join(dir, "gamefactory.db"));
    future.exec("PRAGMA user_version=99");
    future.close();
    assert.throws(() => createGameFactoryStore({ dir }), /newer than supported/);
  });
  console.log(`\n${n} game factory store tests passed`);
} finally {
  try { store.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
