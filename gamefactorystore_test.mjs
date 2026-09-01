import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { REQUIRED_GAME_ARTIFACTS, QA_REQUIRED_SUITES } from "./gamefactory.mjs";

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

  test("artifact copies conflict on a wrong sha256 and complete only with two backends", () => {
    const hash = "a".repeat(64);
    const made = store.recordArtifact({ uid: owner, projectId, artifactKey: REQUIRED_GAME_ARTIFACTS[0], sha256: hash, size: 12, mimeType: "text/markdown" });
    assert.equal(made.status, 201);
    const wrong = store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: "b".repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.status, "CONFLICT");
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: hash }).status, 200);
    assert.equal(store.getProject(owner, projectId).artifacts[0].complete, false);
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
    assert.equal(store.getProject(owner, projectId).artifacts[0].complete, false);
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "chatgpt_project", status: "VERIFIED", fingerprint: hash }).status, 200);
    assert.equal(store.getProject(owner, projectId).artifacts[0].complete, true);
    assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: made.body.artifactId, backend: "invented", status: "VERIFIED", fingerprint: hash }).status, 400);
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
      assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: created.body.artifactId, backend: "chatgpt_project", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(store.recordArtifactCopy({ uid: owner, artifactId: created.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
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
      assert.equal(store.recordArtifactCopy({ uid: other, artifactId: created.body.artifactId, backend: "chatgpt_project", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(store.recordArtifactCopy({ uid: other, artifactId: created.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
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
      assert.equal(store.recordArtifactCopy({ uid: releaseUid, artifactId: artifact.body.artifactId, backend: "chatgpt_project", status: "VERIFIED", fingerprint: hash }).status, 200);
      assert.equal(store.recordArtifactCopy({ uid: releaseUid, artifactId: artifact.body.artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: hash }).status, 200);
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
    assert.equal(store.health().schema.version, 1);
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
