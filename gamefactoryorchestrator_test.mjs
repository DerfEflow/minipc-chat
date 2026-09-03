import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { createGameFactoryDispatchJournal, createGameFactoryOrchestrator } from "./gamefactoryorchestrator.mjs";

const roots = [];
const cleanups = [];
const sha = (value) => createHash("sha256").update(value).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
const stableHash = (value) => sha(JSON.stringify(stable(value)));
function temp(name) {
  const dir = mkdtempSync(join(tmpdir(), `dominion-${name}-`));
  cleanups.push(dir);
  return dir;
}

class FakeWorker {
  constructor() {
    this.enabled = true;
    this.node = "gx10";
    this.runs = new Map();
    this.cancelCalls = [];
    this.acknowledgeCalls = [];
  }
  async probe() {
    return {
      ok: true, node: this.node, configured: true, secureForUntrustedCode: true,
      externalBroker: true, separateBrokerCgroup: true, maxConcurrent: 1,
      controllerRecoveryEpoch: sha("fake-controller-recovery"),
      brokerInstanceId: sha("fake-broker-instance"),
      containerGenerationId: sha("fake-container-generation"),
      brokerBootIdSha256: sha("fake-broker-boot"),
      programs: ["node", "godot"], capabilities: ["quality_assurance", "godot"],
    };
  }
  async start(request) {
    if (!this.runs.has(request.runId)) this.runs.set(request.runId, {
      request, status: "RUNNING", checkpoint: { completedSteps: 0 }, generationId: "a".repeat(64),
    });
    const run = this.runs.get(request.runId);
    return {
      ok: true, node: this.node, runId: request.runId, status: run.status,
      payloadStepIndex: 0, payloadTotalSteps: request.plan.steps.length,
      payloadGenerationId: run.generationId, payloadPreviousGenerationId: null,
    };
  }
  terminalEvidence(run, tuple) {
    if (!new Set(["SUCCEEDED", "PAUSED", "FAILED", "CANCELLED", "INTERRUPTED"]).has(run.status)) {
      return { cancellationResolved: false };
    }
    return {
      cancellationResolved: true,
      payloadDeathProof: {
        protocol: "game-factory-payload-death/1", state: "reaped",
        stepIndex: tuple.stepIndex, totalSteps: tuple.totalSteps,
        generationId: tuple.generationId, previousGenerationId: tuple.previousGenerationId,
        observedAt: "2026-09-01T00:00:00.000Z", pid: 4242, starttime: "123456", decisionId: null,
      },
    };
  }
  async status(runId) {
    const run = this.runs.get(runId);
    const tuple = run ? {
      stepIndex: 0, totalSteps: run.request.plan.steps.length,
      generationId: run.generationId, previousGenerationId: null,
    } : null;
    return run ? {
      ok: true, node: this.node, runId, status: run.status, checkpoint: run.checkpoint,
      payloadStepIndex: tuple.stepIndex, payloadTotalSteps: tuple.totalSteps,
      payloadGenerationId: tuple.generationId, payloadPreviousGenerationId: tuple.previousGenerationId,
      payloadGenerations: [tuple],
      ...this.terminalEvidence(run, tuple),
    } : { ok: false, node: this.node, runId, notFound: true };
  }
  async cancel(runId, { mode }) {
    const run = this.runs.get(runId);
    this.cancelCalls.push({ runId, mode });
    if (run) {
      run.status = mode === "immediate" ? "CANCELLED" : "PAUSED";
      run.checkpoint = { completedSteps: 1, safeBoundary: true };
      const generationId = run.generationId;
      return {
        ok: true, node: this.node, runId, status: run.status, checkpoint: run.checkpoint,
        cancellationResolved: true,
        payloadStepIndex: 0, payloadTotalSteps: run.request.plan.steps.length,
        payloadGenerationId: generationId, payloadPreviousGenerationId: null,
        payloadDeathProof: {
          protocol: "game-factory-payload-death/1", stepIndex: 0,
          totalSteps: run.request.plan.steps.length, generationId, previousGenerationId: null, state: "reaped",
          observedAt: "2026-09-01T00:00:00.000Z", pid: 4242, starttime: "123456", decisionId: null,
        },
      };
    }
    return {
      ok: false, node: this.node, runId, commandAbsent: true, cancellationResolved: false,
      error: "no durable start command exists for this run",
    };
  }
  async collect(runId) {
    const run = this.runs.get(runId);
    const tuple = run ? {
      stepIndex: 0, totalSteps: run.request.plan.steps.length,
      generationId: run.generationId, previousGenerationId: null,
    } : null;
    return run ? {
      ok: true, node: this.node, runId, status: run.status, checkpoint: run.checkpoint,
      payloadStepIndex: tuple.stepIndex, payloadTotalSteps: tuple.totalSteps,
      payloadGenerationId: tuple.generationId, payloadPreviousGenerationId: tuple.previousGenerationId,
      payloadGenerations: [tuple], ...this.terminalEvidence(run, tuple),
      result: { done: true }, artifacts: [{ path: "build.apk", sha256: "a".repeat(64), size: 10 }],
      stdout: "worker output", stderr: "",
    } : { ok: false, notFound: true };
  }
  async acknowledge(runId) {
    this.acknowledgeCalls.push(runId);
    return { ok: true, node: this.node, runId, retentionAcknowledged: true, retentionPruned: true,
      generationsPruned: 1 };
  }
  health() { return { enabled: true, node: this.node }; }
  setAll(status, checkpoint = { completedSteps: 1, complete: true }) {
    for (const run of this.runs.values()) { run.status = status; run.checkpoint = checkpoint; }
  }
}

function setup(name) {
  const storeDir = temp(name + "-store");
  const journalDir = temp(name + "-journal");
  const store = createGameFactoryStore({ dir: storeDir });
  const uid = "owner@example.com";
  const [project] = store.seedPortfolio({ uid, email: uid });
  return { store, journalDir, uid, project };
}

function queue(store, uid, projectId, extra = {}) {
  const project = store.getProject(uid, projectId, { eventLimit: 1 });
  assert.ok(project?.slug);
  const normalizedPayload = extra.payload && typeof extra.payload === "object"
    ? { ...extra.payload } : {
      workerPlan: { steps: [{ program: "godot", args: ["--headless", "--quit"], cwd: "." }] },
    };
  if (normalizedPayload.workerPlan) normalizedPayload.workspaceRoot = `/workspace/${project.slug}`;
  const result = store.queueTask({
    uid, projectId, capability: "quality_assurance", title: "Run QA", safeToRetry: true,
    payload: {
      workspaceRoot: "F:\\Games\\VectorVault",
      workerPlan: { steps: [{ program: "godot", args: ["--headless", "--quit"], cwd: "." }] },
    },
    ...extra,
    payload: normalizedPayload,
  });
  assert.equal(result.status, 201);
  return result.body.taskId;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function authorityAbsenceResponse(request, probe, overrides = {}) {
  const completed = Number(request?.resumeFrom?.completedSteps) || 0;
  const total = request.plan.steps.length - completed;
  const generations = Array.from({ length: total }, (_, stepIndex) => ({
    stepIndex, totalSteps: total, generationId: sha(`${request.runId}:generation:${stepIndex}`),
    previousGenerationId: stepIndex ? sha(`${request.runId}:generation:${stepIndex - 1}`) : null,
    packetSha256: sha(`${request.runId}:packet:${stepIndex}`),
  }));
  const body = {
    protocol: "game-factory-controller-authorization-absence-proof/1", runId: request.runId,
    orchestratorRequestHash: stableHash(request), controllerRequestHash: sha(`${request.runId}:controller-request`),
    absenceReceiptSha256: sha(`${request.runId}:absence-receipt`),
    controllerRecoveryEpoch: probe.controllerRecoveryEpoch,
    brokerInstanceId: probe.brokerInstanceId, containerGenerationId: probe.containerGenerationId,
    brokerBootIdSha256: probe.brokerBootIdSha256,
    recordedControllerRecoveryEpoch: probe.controllerRecoveryEpoch,
    recordedBrokerInstanceId: probe.brokerInstanceId,
    recordedContainerGenerationId: probe.containerGenerationId,
    recordedBrokerBootIdSha256: probe.brokerBootIdSha256,
    generations,
    ...overrides,
  };
  return {
    ok: true, node: probe.node, runId: request.runId, status: "INTERRUPTED",
    cancellationResolved: true, dispatchAuthorityAbsent: true,
    dispatchAuthorityAbsenceProof: { ...body, proofSha256: sha(JSON.stringify(body)) },
  };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok - " + name); }
  catch (error) { console.error("not ok - " + name); throw error; }
}

try {
  await test("dispatch journal rejects an unknown future schema", async () => {
    const dir = temp("gfo-future");
    const db = new DatabaseSync(join(dir, "gamefactory-dispatch.db"));
    db.exec("PRAGMA user_version=99");
    db.close();
    assert.throws(() => createGameFactoryDispatchJournal({ dir }), /newer than supported/);
  });

  await test("dispatch journal rejects mismatched metadata and redacts every persisted response", async () => {
    const dir = temp("gfo-redaction");
    const journal = createGameFactoryDispatchJournal({ dir });
    const task = { id: "task-redact", uid: "owner", projectId: "project-redact", buildId: "", attempt: 1, capability: "quality_assurance", safeToRetry: true };
    const request = { runId: "task-redact:attempt:1", taskId: task.id, projectId: task.projectId, capability: task.capability, attempt: 1, workspaceRoot: "F:\\Games\\Safe", plan: { steps: [{ program: "node", args: ["test.mjs"], cwd: "." }] } };
    journal.recordIntent({ task, request, workerId: "gx10" });
    assert.throws(() => journal.recordIntent({ task, request: { ...request, runId: "wrong-project:attempt:1", projectId: "another-project" }, workerId: "gx10" }), /identity does not match/);
    const marker = "orchestrator-secret-marker-2281";
    journal.update(request.runId, { lastResponse: {
      authorization: marker, databaseUrl: `postgres://owner:${marker}@db.example/game`, error: `Bearer ${marker}`,
      stdout: `api_key=${marker}\n{"password":"${marker}"}\nAuthorization: Basic ${marker}\nCookie: sid=${marker}\n-----BEGIN PRIVATE KEY-----\n${marker}`,
    }, error: `password=${marker}` });
    assert.equal(JSON.stringify(journal.latestForTask(task.id)).includes(marker), false);
    assert.throws(() => journal.recordIntent({ task: { ...task, id: "task-secret" }, request: { ...request, runId: "task-secret:attempt:1", taskId: "task-secret", plan: { steps: [{ program: "node", args: [`api_key=${marker}`], cwd: "." }] } }, workerId: "gx10" }), /credential material/);
    journal.finish(request.runId, "SUCCEEDED", { ok: true, status: "SUCCEEDED" });
    journal.update(request.runId, { status: "REMOTE_PROTOCOL_ERROR", error: "late observer" }, "dispatch.late_observer");
    assert.equal(journal.latestForTask(task.id).status, "SUCCEEDED");
    journal.close();
    const db = new DatabaseSync(join(dir, "gamefactory-dispatch.db"));
    db.exec("PRAGMA user_version=0");
    db.prepare("UPDATE dispatch_schema SET checksum='wrong'").run();
    db.close();
    assert.throws(() => createGameFactoryDispatchJournal({ dir }), /metadata does not match/);
  });

  await test("the journal security latch overrides stale terminal truth and is absorbing", async () => {
    const dir = temp("gfo-security-latch");
    const journal = createGameFactoryDispatchJournal({ dir });
    const task = {
      id: "task-security-latch", uid: "owner", projectId: "project-security-latch", buildId: "",
      attempt: 1, capability: "quality_assurance", safeToRetry: true,
    };
    const request = {
      runId: "task-security-latch:attempt:1", taskId: task.id, projectId: task.projectId,
      capability: task.capability, attempt: 1, workspaceRoot: "F:\\Games\\Safe",
      plan: { steps: [{ program: "node", args: ["--version"], cwd: "." }] },
    };
    journal.recordIntent({ task, request, workerId: "gx10-gamefactory" });
    journal.finish(request.runId, "SUCCEEDED", { ok: true, runId: request.runId, status: "SUCCEEDED" });
    assert.ok(journal.get(request.runId).endedAt > 0);

    const latched = journal.securityLatch(request.runId, { probe: { secureForUntrustedCode: false } }, "proof lost");
    assert.equal(latched.status, "SECURITY_CANCEL_REQUESTED");
    assert.equal(latched.endedAt, 0);
    assert.equal(journal.hasPendingSecurity(), true);
    const latchedEpoch = journal.securityEpoch();
    assert.ok(latchedEpoch > 0);
    for (let retry = 0; retry < 100; retry++) {
      const replay = journal.securityLatch(request.runId,
        { probe: { secureForUntrustedCode: false, retry } }, `proof still lost ${retry}`);
      assert.equal(replay.status, "SECURITY_CANCEL_REQUESTED");
      assert.equal(replay.endedAt, 0);
      assert.equal(journal.securityEpoch(), latchedEpoch);
    }
    const inspection = new DatabaseSync(join(dir, "gamefactory-dispatch.db"), { readOnly: true });
    try {
      assert.equal(Number(inspection.prepare(
        "SELECT COUNT(*) AS count FROM dispatch_events WHERE runId=? AND type='dispatch.security_latched'",
      ).get(request.runId).count), 1);
    } finally {
      inspection.close();
    }
    assert.equal(journal.update(request.runId, { status: "RUNNING" }).status, "SECURITY_CANCEL_REQUESTED");
    assert.equal(journal.finish(request.runId, "SUCCEEDED", { ok: true, status: "SUCCEEDED" }).status, "SECURITY_CANCEL_REQUESTED");

    const finished = journal.securityFinish(request.runId, {
      ok: true, runId: request.runId, status: "CANCELLED", cancellationResolved: true,
    }, "proof loss resolved");
    assert.equal(finished.status, "SECURITY_INTERRUPTED");
    assert.ok(finished.endedAt > 0);
    assert.equal(journal.hasPendingSecurity(), false);
    assert.equal(journal.securityLatch(request.runId, null, "late duplicate").status, "SECURITY_INTERRUPTED");
    assert.equal(journal.finish(request.runId, "SUCCEEDED", { ok: true, status: "SUCCEEDED" }).status, "SECURITY_INTERRUPTED");
    journal.close();
  });

  await test("a global proof-loss observation atomically latches active dispatches before restart", async () => {
    const dir = temp("gfo-security-observation-crash-gap");
    const task = {
      id: "task-security-observation", uid: "owner", projectId: "project-security-observation",
      buildId: "", attempt: 1, capability: "quality_assurance", safeToRetry: true,
    };
    const request = {
      runId: "task-security-observation:attempt:1", taskId: task.id, projectId: task.projectId,
      capability: task.capability, attempt: 1, workspaceRoot: "F:\\Games\\Safe",
      plan: { steps: [{ program: "node", args: ["--version"], cwd: "." }] },
    };
    let journal = createGameFactoryDispatchJournal({ dir });
    try {
      journal.recordIntent({ task, request, workerId: "gx10-gamefactory" });
      const epoch = journal.observeProofLoss({
        ok: false, node: "gx10-gamefactory", secureForUntrustedCode: false,
      }, "force probe failed");
      assert.ok(epoch > 0);
      assert.equal(journal.get(request.runId).status, "SECURITY_CANCEL_REQUESTED");
      assert.equal(journal.hasPendingSecurity(), true);

      // Simulate the observer dying before runTick can execute listActive() or cancellation. The
      // successor must recover the persisted latch; a later secure probe cannot erase the incident.
      journal.close();
      journal = createGameFactoryDispatchJournal({ dir });
      assert.equal(journal.get(request.runId).status, "SECURITY_CANCEL_REQUESTED");
      assert.equal(journal.hasPendingSecurity(), true);
      assert.equal(journal.securityEpoch(), epoch);
    } finally {
      journal.close();
    }
  });

  await test("the journal binds a contiguous controller generation prefix and rejects regression or replacement", async () => {
    const dir = temp("gfo-generation-chain");
    const journal = createGameFactoryDispatchJournal({ dir });
    const task = {
      id: "task-generation-chain", uid: "owner", projectId: "project-generation-chain", buildId: "",
      attempt: 1, capability: "quality_assurance", safeToRetry: true,
    };
    const request = {
      runId: "task-generation-chain:attempt:1", taskId: task.id, projectId: task.projectId,
      capability: task.capability, attempt: 1, workspaceRoot: "F:\\Games\\Safe",
      plan: { steps: [
        { program: "node", args: ["first.mjs"], cwd: "." },
        { program: "node", args: ["second.mjs"], cwd: "." },
        { program: "node", args: ["third.mjs"], cwd: "." },
      ] },
    };
    const first = { stepIndex: 0, totalSteps: 3, generationId: "a".repeat(64), previousGenerationId: null };
    const second = { stepIndex: 1, totalSteps: 3, generationId: "b".repeat(64), previousGenerationId: first.generationId };
    const third = { stepIndex: 2, totalSteps: 3, generationId: "c".repeat(64), previousGenerationId: second.generationId };
    journal.recordIntent({ task, request, workerId: "gx10-gamefactory" });
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 0, payloadTotalSteps: 3,
      payloadGenerationId: first.generationId, payloadPreviousGenerationId: null,
    }, "start").ok, true);
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 2, payloadTotalSteps: 3,
      payloadGenerationId: third.generationId, payloadPreviousGenerationId: second.generationId,
      payloadGenerations: [first, second, third],
    }, "status").ok, false);
    assert.deepEqual(journal.payloadGeneration(request.runId), first);
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 1, payloadTotalSteps: 3,
      payloadGenerationId: second.generationId, payloadPreviousGenerationId: first.generationId,
      payloadGenerations: [first, second],
    }, "status").ok, true);
    assert.deepEqual(journal.payloadGeneration(request.runId), second);
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 0, payloadTotalSteps: 3,
      payloadGenerationId: first.generationId, payloadPreviousGenerationId: null,
      payloadGenerations: [first],
    }, "status").ok, false);
    const replacement = { ...second, generationId: "d".repeat(64) };
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 1, payloadTotalSteps: 3,
      payloadGenerationId: replacement.generationId, payloadPreviousGenerationId: first.generationId,
      payloadGenerations: [first, replacement],
    }, "status").ok, false);
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 1, payloadTotalSteps: 3,
      payloadGenerationId: second.generationId, payloadPreviousGenerationId: first.generationId,
    }, "cancel").ok, false);
    assert.deepEqual(journal.payloadGeneration(request.runId), second);
    journal.close();
  });

  await test("the journal binds current controller no-authorization proof only before any payload generation", async () => {
    const dir = temp("gfo-authorization-absence");
    const journal = createGameFactoryDispatchJournal({ dir });
    const worker = new FakeWorker(); const probe = await worker.probe();
    const make = (suffix) => {
      const task = { id: `task-absence-${suffix}`, uid: "owner", projectId: `project-absence-${suffix}`,
        buildId: "", attempt: 1, capability: "quality_assurance", safeToRetry: true };
      const request = { runId: `${task.id}:attempt:1`, taskId: task.id, projectId: task.projectId,
        capability: task.capability, attempt: 1, workspaceRoot: "F:\\Games\\Safe",
        plan: { steps: [{ program: "node", args: ["--version"], cwd: "." }] } };
      journal.recordIntent({ task, request, workerId: worker.node });
      return { task, request };
    };

    const valid = make("valid"); const response = authorityAbsenceResponse(valid.request, probe);
    const bound = journal.bindAuthorizationAbsence(valid.request.runId, response, probe);
    assert.equal(bound.ok, true, bound.error);
    assert.equal(journal.bindAuthorizationAbsence(valid.request.runId, response, probe).replayed, true);
    assert.equal(journal.payloadGeneration(valid.request.runId), null);
    assert.equal(journal.bindPayloadGeneration(valid.request.runId, {
      ok: true, runId: valid.request.runId, payloadStepIndex: 0, payloadTotalSteps: 1,
      payloadGenerationId: "a".repeat(64), payloadPreviousGenerationId: null,
    }, "start").ok, false);
    journal.securityLatch(valid.request.runId, response, "failed dispatch");
    journal.securityFinish(valid.request.runId, response, "absence proved");
    assert.equal(journal.listRetentionPending().length, 1);
    assert.equal(journal.recordRetentionAck(valid.request.runId, {
      ok: true, runId: valid.request.runId, retentionAcknowledged: true, retentionPruned: true,
      generationsPruned: 0, dispatchAuthorityAbsent: true,
    }), true);
    assert.equal(journal.listRetentionPending().length, 0);

    const forgedEpoch = make("forged-epoch");
    const forgedEpochResponse = authorityAbsenceResponse(forgedEpoch.request, probe, {
      controllerRecoveryEpoch: sha("previous-controller-recovery"),
    });
    assert.equal(journal.bindAuthorizationAbsence(forgedEpoch.request.runId, forgedEpochResponse, probe).ok, false);

    const forgedChain = make("forged-chain");
    const badGeneration = [{ stepIndex: 0, totalSteps: 1,
      generationId: sha("forged-generation"), previousGenerationId: sha("forged-previous"),
      packetSha256: sha("forged-packet") }];
    const forgedChainResponse = authorityAbsenceResponse(forgedChain.request, probe, { generations: badGeneration });
    assert.equal(journal.bindAuthorizationAbsence(forgedChain.request.runId, forgedChainResponse, probe).ok, false);

    const previouslyBound = make("previous-generation");
    const generationId = "b".repeat(64);
    assert.equal(journal.bindPayloadGeneration(previouslyBound.request.runId, {
      ok: true, runId: previouslyBound.request.runId, payloadStepIndex: 0, payloadTotalSteps: 1,
      payloadGenerationId: generationId, payloadPreviousGenerationId: null,
    }, "start").ok, true);
    assert.equal(journal.bindAuthorizationAbsence(previouslyBound.request.runId,
      authorityAbsenceResponse(previouslyBound.request, probe), probe).ok, false);
    journal.close();
  });

  await test("the journal binds resume generations to only the immutable remaining plan", async () => {
    const dir = temp("gfo-resume-generation-chain");
    const journal = createGameFactoryDispatchJournal({ dir });
    const task = {
      id: "task-resume-generation-chain", uid: "owner", projectId: "project-resume-generation-chain",
      buildId: "", attempt: 2, capability: "quality_assurance", safeToRetry: true,
    };
    const request = {
      runId: "task-resume-generation-chain:attempt:2", taskId: task.id, projectId: task.projectId,
      capability: task.capability, attempt: 2, workspaceRoot: "F:\\Games\\Safe",
      plan: { steps: [
        { program: "node", args: ["first.mjs"], cwd: "." },
        { program: "node", args: ["second.mjs"], cwd: "." },
        { program: "node", args: ["third.mjs"], cwd: "." },
      ] },
      resumeFrom: {
        protocol: "game-factory-broker-resume/1", completedSteps: 1, totalSteps: 3,
        safeBoundary: true, complete: false,
      },
    };
    const firstRemaining = {
      stepIndex: 0, totalSteps: 2, generationId: "d".repeat(64), previousGenerationId: null,
    };
    journal.recordIntent({ task, request, workerId: "gx10-gamefactory" });
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 0, payloadTotalSteps: 2,
      payloadGenerationId: firstRemaining.generationId, payloadPreviousGenerationId: null,
    }, "start").ok, true);
    assert.deepEqual(journal.payloadGeneration(request.runId), firstRemaining);
    assert.equal(journal.bindPayloadGeneration(request.runId, {
      ok: true, runId: request.runId,
      payloadStepIndex: 0, payloadTotalSteps: 3,
      payloadGenerationId: "e".repeat(64), payloadPreviousGenerationId: null,
      payloadGenerations: [{ ...firstRemaining, totalSteps: 3, generationId: "e".repeat(64) }],
    }, "status").ok, false);
    journal.close();
  });

  await test("does not claim when probe is ok without secure untrusted-code attestation", async () => {
    const { store, journalDir, uid, project } = setup("gfo-insecure-probe");
    const worker = new FakeWorker();
    worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    const tick = await orchestrator.tick();
    assert.equal(tick.claimed, 0);
    assert.equal(worker.runs.size, 0);
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "QUEUED");
    await orchestrator.close();
    store.close();
  });

  await test("claims only when secure probe provenance exactly matches the configured node", async () => {
    const { store, journalDir, uid, project } = setup("gfo-secure-probe");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await orchestrator.tick()).claimed, 1);
    assert.equal(worker.runs.size, 1);
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "RUNNING");
    await orchestrator.close();
    store.close();

    const mismatch = setup("gfo-secure-wrong-node");
    const wrongNodeWorker = new FakeWorker();
    wrongNodeWorker.probe = async () => ({
      ok: true, node: "not-gx10", configured: true, secureForUntrustedCode: true,
    });
    const mismatchTaskId = queue(mismatch.store, mismatch.uid, mismatch.project.id);
    const mismatchedOrchestrator = createGameFactoryOrchestrator({
      store: mismatch.store, worker: wrongNodeWorker, journalDir: mismatch.journalDir,
    });
    assert.equal((await mismatchedOrchestrator.tick()).claimed, 0);
    assert.equal(wrongNodeWorker.runs.size, 0);
    assert.equal(mismatch.store.getProject(mismatch.uid, mismatch.project.id).tasks
      .find((task) => task.id === mismatchTaskId).status, "QUEUED");
    await mismatchedOrchestrator.close();
    mismatch.store.close();
  });

  await test("rejects any non-singleton orchestrator concurrency for the static broker", async () => {
    const { store, journalDir } = setup("gfo-exact-singleton");
    try {
      assert.throws(() => createGameFactoryOrchestrator({
        store, worker: new FakeWorker(), journalDir, maxConcurrent: 2,
      }), /exact maxConcurrent=1/);
    } finally { store.close(); }
  });

  await test("does not redispatch and keeps cancellation unresolved when an insecure worker only reports absence", async () => {
    const { store, journalDir, uid, project } = setup("gfo-insecure-redispatch");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const first = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await first.tick()).claimed, 1);
    await first.close();

    worker.runs.clear();
    worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
    const restarted = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await restarted.tick()).reconciled, 1);
    assert.equal(worker.runs.size, 0);
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.equal(detail.state, "FAILED");
    assert.equal(restarted.health().journal.active, 1);
    assert.equal(worker.cancelCalls.length, 1);
    await restarted.close();
    store.close();
  });

  await test("closes a failed pre-journal dispatch only with current typed no-authorization proof", async () => {
    const { store, journalDir, uid, project } = setup("gfo-pre-journal-absence");
    const worker = new FakeWorker(); let failedRequest = null; let absenceCalls = 0;
    worker.start = async (request) => {
      failedRequest = request;
      return { ok: false, node: worker.node, runId: request.runId, retryable: false,
        error: "journal publication failed before final link" };
    };
    worker.status = async (runId) => ({ ok: false, node: worker.node, runId,
      commandAbsent: true, cancellationResolved: false,
      error: "no controller authorization exists for this run" });
    worker.authorizationAbsent = async (request) => {
      absenceCalls++;
      return authorityAbsenceResponse(request, await FakeWorker.prototype.probe.call(worker));
    };
    worker.acknowledge = async (runId) => {
      worker.acknowledgeCalls.push(runId);
      return { ok: true, node: worker.node, runId, retentionAcknowledged: true,
        retentionPruned: true, generationsPruned: 0, dispatchAuthorityAbsent: true };
    };
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    const tick = await orchestrator.tick();
    assert.equal(tick.claimed, 1);
    assert.ok(failedRequest);
    assert.equal(worker.runs.size, 0);
    assert.equal(absenceCalls, 1);
    const dispatch = orchestrator.journal.latestForTask(taskId);
    assert.equal(dispatch.status, "SECURITY_INTERRUPTED");
    assert.ok(dispatch.endedAt > 0);
    assert.equal(orchestrator.journal.payloadGeneration(dispatch.runId), null);
    assert.equal(orchestrator.journal.hasPendingSecurity(), false);
    assert.equal(orchestrator.journal.listRetentionPending().length, 0);
    assert.deepEqual(worker.acknowledgeCalls, [dispatch.runId]);
    const task = store.getProject(uid, project.id).tasks.find((item) => item.id === taskId);
    assert.equal(task.status, "FAILED");
    assert.equal(task.result.securityStopped, true);
    await orchestrator.close();
    store.close();
  });

  await test("a cached secure probe cannot admit a later claim after the same worker turns insecure", async () => {
    const { store, journalDir, uid, project } = setup("gfo-stale-secure-claim");
    const worker = new FakeWorker();
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await orchestrator.tick()).claimed, 0);
    worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
    const taskId = queue(store, uid, project.id);
    assert.equal((await orchestrator.tick()).claimed, 0);
    assert.equal(worker.runs.size, 0);
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "QUEUED");
    await orchestrator.close();
    store.close();
  });

  await test("a cached secure probe cannot redispatch a missing run after the same worker turns insecure", async () => {
    const { store, journalDir, uid, project } = setup("gfo-stale-secure-redispatch");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await orchestrator.tick()).claimed, 1);
    worker.runs.clear();
    worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
    assert.equal((await orchestrator.tick()).reconciled, 1);
    assert.equal(worker.runs.size, 0);
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.equal(orchestrator.health().journal.active, 1);
    await orchestrator.close();
    store.close();
  });

  await test("loss of isolation proof immediately interrupts active work without extending its lease", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-active");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir, leaseMs: 120_000 });
    assert.equal((await orchestrator.tick()).claimed, 1);
    const running = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
    assert.equal(running.status, "RUNNING");
    assert.ok(running.leaseUntil > 0);
    worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
    const tick = await orchestrator.tick();
    assert.equal(tick.reconciled, 1);
    assert.equal(worker.cancelCalls.length, 1);
    assert.equal(worker.cancelCalls[0].mode, "immediate");
    const detail = store.getProject(uid, project.id);
    const failed = detail.tasks.find((task) => task.id === taskId);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.leaseUntil, 0);
    assert.equal(detail.state, "FAILED");
    assert.match(detail.blocker, /lost its current isolation proof/i);
    assert.equal(orchestrator.health().journal.active, 0);
    const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
    assert.equal(journal.prepare("SELECT status FROM dispatches WHERE taskId=?").get(taskId).status, "SECURITY_INTERRUPTED");
    journal.close();
    await orchestrator.close();
    store.close();
  });

  await test("a rejected isolation probe is treated as proof loss for active work", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-probe-rejected");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.probe = async () => { throw new Error("attestation transport unavailable"); };
      const stopped = await orchestrator.tick();
      assert.equal(stopped.ok, true);
      assert.equal(stopped.reconciled, 1);
      assert.equal(worker.cancelCalls.length, 1);
      const failed = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.result.securityStopped, true);
      assert.equal(orchestrator.health().probe.secureForUntrustedCode, false);
      assert.equal(orchestrator.journal.get(`${taskId}:attempt:1`).status, "SECURITY_INTERRUPTED");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("an unconfirmed security cancellation stays journaled and cannot resume after proof recovery", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-uncertain");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await orchestrator.tick()).claimed, 1);
    worker.cancel = async (runId, { mode }) => {
      worker.cancelCalls.push({ runId, mode });
      return { ok: false, node: worker.node, runId, status: "RUNNING", error: "cancel acknowledgement unavailable" };
    };
    worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
    assert.equal((await orchestrator.tick()).reconciled, 1);
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.equal(orchestrator.health().journal.active, 1);
    const secondProject = store.listProjects(uid).find((candidate) => candidate.id !== project.id);
    const secondTaskId = queue(store, uid, secondProject.id);
    worker.probe = FakeWorker.prototype.probe.bind(worker);
    const recovered = await orchestrator.tick();
    assert.equal(recovered.reconciled, 1);
    assert.equal(recovered.claimed, 0);
    assert.equal(worker.cancelCalls.length, 2);
    assert.equal(worker.runs.get(`${taskId}:attempt:1`).status, "RUNNING");
    assert.equal(store.getProject(uid, project.id).state, "FAILED");
    assert.equal(store.getProject(uid, secondProject.id).tasks.find((task) => task.id === secondTaskId).status, "QUEUED");
    const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
    assert.equal(journal.prepare("SELECT status FROM dispatches WHERE taskId=?").get(taskId).status, "SECURITY_CANCEL_REQUESTED");
    journal.close();
    await orchestrator.close();
    store.close();
  });

  // Required behavior 2 (deficiency 16): the gx10-gamefactory hands node disconnects/reconnects
  // every ~15 minutes and gets caught in hub 409 lockouts. That is not proof isolation was lost.
  await test("a retryable not-connected probe suspends dispatching without latching the active task", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-suspend-basic");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir, leaseMs: 120_000 });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "RUNNING");
      worker.probe = async () => ({
        ok: false, node: worker.node, offline: true, retryable: true,
        error: `hands node "${worker.node}" is not connected (machine asleep, off, or the node service is down)`,
      });
      const suspendedTick = await orchestrator.tick();
      assert.equal(suspendedTick.ok, true);
      assert.equal(suspendedTick.suspended, true);
      assert.equal(suspendedTick.reconciled, 0);
      assert.equal(worker.cancelCalls.length, 0);
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "RUNNING");
      assert.equal(orchestrator.health().suspended, true);
      assert.equal(orchestrator.health().suspension.node, worker.node);
      const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
      assert.equal(journal.prepare("SELECT status FROM dispatches WHERE taskId=?").get(taskId).status, "RUNNING");
      journal.close();
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("resumes normally when the same broker identity reconnects within the grace window", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-suspend-resume");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir, leaseMs: 120_000 });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.probe = async () => ({ ok: false, node: worker.node, offline: true, retryable: true, error: "not connected" });
      assert.equal((await orchestrator.tick()).suspended, true);
      worker.probe = FakeWorker.prototype.probe.bind(worker); // exact same identity reconnects
      const resumedTick = await orchestrator.tick();
      assert.equal(resumedTick.suspended, false);
      assert.equal(resumedTick.reconciled, 1);
      assert.equal(worker.cancelCalls.length, 0);
      assert.equal(orchestrator.health().suspended, false);
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "RUNNING");
      const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
      assert.equal(journal.prepare("SELECT status FROM dispatches WHERE taskId=?").get(taskId).status, "RUNNING");
      journal.close();
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("latches when the grace window expires while the node is still disconnected", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-suspend-expire");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    let clock = 1_800_000_000_000;
    const orchestrator = createGameFactoryOrchestrator({
      store, worker, journalDir, leaseMs: 120_000, proofGraceMs: 60_000, now: () => clock,
    });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.probe = async () => ({ ok: false, node: worker.node, offline: true, retryable: true, error: "not connected" });
      assert.equal((await orchestrator.tick()).suspended, true);
      clock += 61_000; // past the 60s grace window; the node is still disconnected
      const expired = await orchestrator.tick();
      assert.equal(expired.suspended, false);
      assert.equal(worker.cancelCalls.length, 1);
      assert.equal(worker.cancelCalls[0].mode, "immediate");
      const failed = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(failed.status, "FAILED");
      assert.equal(orchestrator.health().suspended, false);
      const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
      assert.equal(journal.prepare("SELECT status FROM dispatches WHERE taskId=?").get(taskId).status, "SECURITY_INTERRUPTED");
      journal.close();
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("latches when a different broker identity answers after a suspension", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-suspend-identity-change");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir, leaseMs: 120_000 });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.probe = async () => ({ ok: false, node: worker.node, offline: true, retryable: true, error: "not connected" });
      assert.equal((await orchestrator.tick()).suspended, true);
      // A different broker container answers: same node name, different isolation identity.
      worker.probe = async () => ({
        ok: true, node: worker.node, configured: true, secureForUntrustedCode: true,
        externalBroker: true, separateBrokerCgroup: true, maxConcurrent: 1,
        controllerRecoveryEpoch: sha("new-controller-recovery"), brokerInstanceId: sha("new-broker-instance"),
        containerGenerationId: sha("new-container-generation"), brokerBootIdSha256: sha("new-broker-boot"),
        programs: ["node", "godot"], capabilities: ["quality_assurance", "godot"],
      });
      const changedTick = await orchestrator.tick();
      assert.equal(changedTick.suspended, false);
      assert.equal(worker.cancelCalls.length, 1);
      const failed = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(failed.status, "FAILED");
      assert.equal(orchestrator.health().suspended, false);
      const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
      assert.equal(journal.prepare("SELECT status FROM dispatches WHERE taskId=?").get(taskId).status, "SECURITY_INTERRUPTED");
      journal.close();
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("repairs a crash after the journal latch and security-stops the complete active snapshot", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-restart-repair");
    const worker = new FakeWorker();
    const secondProject = store.listProjects(uid).find((candidate) => candidate.id !== project.id);
    const qaTaskId = queue(store, uid, project.id);
    const gameplayTaskId = queue(store, uid, secondProject.id, { capability: "godot" });
    let first;
    let restarted;
    try {
      first = createGameFactoryOrchestrator({ store, worker, journalDir });
      assert.equal((await first.tick()).claimed, 1);
      const secondAttempt = store.claimNextTask({
        workerId: "game-factory:gx10", capability: "godot", leaseMs: 120_000,
      });
      assert.equal(secondAttempt.id, gameplayTaskId);
      const secondRequest = {
        runId: `${gameplayTaskId}:attempt:1`, taskId: gameplayTaskId, projectId: secondProject.id,
        buildId: "", capability: secondAttempt.capability, attempt: 1,
        workspaceRoot: `/workspace/${secondProject.slug}`, projectRelative: secondProject.slug,
        plan: secondAttempt.payload.workerPlan, resumeFrom: null,
      };
      first.journal.recordIntent({ task: secondAttempt, request: secondRequest, workerId: "game-factory:gx10" });
      assert.equal((await worker.start(secondRequest)).ok, true);
      assert.equal(worker.runs.size, 2);
      const qaRunId = `${qaTaskId}:attempt:1`;
      first.journal.securityLatch(qaRunId, { probe: { secureForUntrustedCode: false } }, "proof lost before store repair");
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === qaTaskId).status, "RUNNING");
      assert.equal(store.getProject(uid, secondProject.id).tasks.find((task) => task.id === gameplayTaskId).status, "RUNNING");
      await first.close();
      first = null;

      // The probe recovered, but the persisted lane incident remains absorbing. The restart must
      // latch both tasks before resolving either cancellation, then repair both store rows.
      restarted = createGameFactoryOrchestrator({ store, worker, journalDir });
      const repaired = await restarted.tick();
      assert.equal(repaired.reconciled, 2);
      assert.equal(repaired.claimed, 0);
      assert.equal(worker.cancelCalls.length, 2);
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === qaTaskId).status, "FAILED");
      assert.equal(store.getProject(uid, secondProject.id).tasks.find((task) => task.id === gameplayTaskId).status, "FAILED");
      assert.equal(restarted.health().journal.active, 0);
      const journal = new DatabaseSync(join(journalDir, "gamefactory-dispatch.db"));
      try {
        assert.deepEqual(journal.prepare("SELECT status FROM dispatches ORDER BY taskId").all().map((row) => row.status),
          ["SECURITY_INTERRUPTED", "SECURITY_INTERRUPTED"]);
      } finally { journal.close(); }
    } finally {
      if (first) await first.close();
      if (restarted) await restarted.close();
      store.close();
    }
  });

  await test("repairs overlapping attempts without weakening exact-attempt security stops", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-overlapping-attempts");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    let first;
    let restarted;
    try {
      first = createGameFactoryOrchestrator({ store, worker, journalDir });
      assert.equal((await first.tick()).claimed, 1);
      const firstRunId = `${taskId}:attempt:1`;

      // Simulate a lease expiring while attempt 1's external payload and journal entry still exist,
      // followed by another scheduler claiming the same retry-safe task as attempt 2.
      const inspection = new DatabaseSync(store.file);
      try { inspection.prepare("UPDATE game_tasks SET leaseUntil=1 WHERE id=?").run(taskId); }
      finally { inspection.close(); }
      assert.equal(store.reconcile().requeued, 1);
      const secondAttempt = store.claimNextTask({
        workerId: "game-factory:gx10", capability: "quality_assurance", leaseMs: 120_000,
      });
      assert.equal(secondAttempt.id, taskId);
      assert.equal(secondAttempt.attempt, 2);
      const secondRunId = `${taskId}:attempt:2`;
      const secondRequest = {
        runId: secondRunId, taskId, projectId: project.id, buildId: "",
        capability: secondAttempt.capability, attempt: 2,
        workspaceRoot: secondAttempt.payload.workspaceRoot,
        plan: secondAttempt.payload.workerPlan,
        resumeFrom: null,
      };
      first.journal.recordIntent({ task: secondAttempt, request: secondRequest, workerId: "game-factory:gx10" });
      assert.equal((await worker.start(secondRequest)).ok, true);

      let secondCancellationUnresolved = true;
      const baseCancel = worker.cancel.bind(worker);
      worker.cancel = async (runId, options) => {
        if (runId === secondRunId && secondCancellationUnresolved) {
          worker.cancelCalls.push({ runId, mode: options.mode });
          return {
            ok: false, node: worker.node, runId, status: "RUNNING",
            cancellationResolved: false, error: "second-attempt cancellation acknowledgement unavailable",
          };
        }
        return baseCancel(runId, options);
      };
      worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
      const stopped = await first.tick();
      assert.equal(stopped.reconciled, 2);
      assert.equal(first.journal.get(firstRunId).status, "SECURITY_INTERRUPTED");
      assert.equal(first.journal.get(secondRunId).status, "SECURITY_CANCEL_REQUESTED");
      const durableTask = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(durableTask.attempt, 2);
      assert.equal(durableTask.status, "FAILED");
      assert.equal(durableTask.result.securityStopped, true);
      await first.close();
      first = null;

      secondCancellationUnresolved = false;
      worker.probe = FakeWorker.prototype.probe.bind(worker);
      restarted = createGameFactoryOrchestrator({ store, worker, journalDir });
      const repaired = await restarted.tick();
      assert.equal(repaired.reconciled, 1);
      assert.equal(repaired.claimed, 0);
      assert.equal(restarted.journal.get(secondRunId).status, "SECURITY_INTERRUPTED");
      assert.equal(restarted.health().journal.active, 0);
    } finally {
      if (first) await first.close();
      if (restarted) await restarted.close();
      store.close();
    }
  });

  await test("keeps cancellation unresolved when a claimed death proof is malformed", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-malformed-proof");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.cancel = async (runId, { mode }) => {
        worker.cancelCalls.push({ runId, mode });
        return {
          ok: true, node: worker.node, runId, status: "CANCELLED", cancellationResolved: true,
          payloadStepIndex: 0, payloadTotalSteps: 1,
          payloadGenerationId: "b".repeat(64), payloadPreviousGenerationId: null,
          payloadDeathProof: {
            protocol: "game-factory-payload-death/1", stepIndex: 0, totalSteps: 1,
            generationId: "b".repeat(64), previousGenerationId: null, state: "reaped",
            observedAt: "2026-09-01T00:00:00.000Z", pid: 4242, starttime: "123456", decisionId: null,
          },
        };
      };
      worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "FAILED");
      assert.equal(orchestrator.health().journal.active, 1);
      assert.equal(orchestrator.journal.get(`${taskId}:attempt:1`).status, "SECURITY_CANCEL_REQUESTED");
      assert.equal(worker.cancelCalls.length, 1);
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("never completes or re-admits a terminal generation without death proof", async () => {
    const { store, journalDir, uid, project } = setup("gfo-terminal-without-death-proof");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      const runId = `${taskId}:attempt:1`;
      worker.setAll("SUCCEEDED");
      const baseStatus = worker.status.bind(worker);
      worker.status = async (requestedRunId) => {
        const response = await baseStatus(requestedRunId);
        delete response.payloadDeathProof;
        response.cancellationResolved = false;
        return response;
      };
      worker.cancel = async (requestedRunId, { mode }) => {
        worker.cancelCalls.push({ runId: requestedRunId, mode });
        const response = await baseStatus(requestedRunId);
        delete response.payloadDeathProof;
        response.status = "INTERRUPTED";
        response.cancellationResolved = false;
        return response;
      };
      const terminal = await orchestrator.tick();
      assert.equal(terminal.reconciled, 1);
      assert.equal(terminal.claimed, 0);
      const task = store.getProject(uid, project.id).tasks.find((candidate) => candidate.id === taskId);
      assert.equal(task.status, "FAILED");
      assert.equal(task.attempt, 1);
      assert.equal(task.result.securityStopped, true);
      assert.equal(orchestrator.journal.get(runId).status, "SECURITY_CANCEL_REQUESTED");
      assert.equal(orchestrator.health().journal.active, 1);
      const retried = await orchestrator.tick();
      assert.equal(retried.claimed, 0);
      assert.equal(store.getProject(uid, project.id).tasks.find((candidate) => candidate.id === taskId).attempt, 1);
      assert.equal(orchestrator.journal.get(runId).status, "SECURITY_CANCEL_REQUESTED");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("lease loss security-stops and reaps before closing the dispatch", async () => {
    const { store, journalDir, uid, project } = setup("gfo-lease-loss-death-proof");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    const baseHeartbeat = store.heartbeatTask.bind(store);
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      store.heartbeatTask = () => ({ status: 409, body: { error: "lease owner changed" } });
      const lost = await orchestrator.tick();
      assert.equal(lost.reconciled, 1);
      assert.equal(lost.claimed, 0);
      assert.equal(worker.cancelCalls.some((call) => call.mode === "immediate"), true);
      const task = store.getProject(uid, project.id).tasks.find((candidate) => candidate.id === taskId);
      assert.equal(task.status, "FAILED");
      assert.equal(task.result.securityStopped, true);
      assert.equal(orchestrator.journal.get(`${taskId}:attempt:1`).status, "SECURITY_INTERRUPTED");
    } finally {
      store.heartbeatTask = baseHeartbeat;
      await orchestrator.close();
      store.close();
    }
  });

  await test("remote loss security-stops instead of requeueing an unproved payload", async () => {
    const { store, journalDir, uid, project } = setup("gfo-remote-loss-death-proof");
    let clock = 1_000;
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({
      store, worker, journalDir, now: () => clock, remoteGraceMs: 1,
    });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.status = async (runId) => ({
        ok: false, node: worker.node, runId, error: "worker transport unavailable",
      });
      clock = 2_000;
      const lost = await orchestrator.tick();
      assert.equal(lost.reconciled, 1);
      assert.equal(lost.claimed, 0);
      assert.equal(worker.cancelCalls.some((call) => call.mode === "immediate"), true);
      const task = store.getProject(uid, project.id).tasks.find((candidate) => candidate.id === taskId);
      assert.equal(task.status, "FAILED");
      assert.equal(task.attempt, 1);
      assert.equal(task.result.securityStopped, true);
      assert.equal(orchestrator.journal.get(`${taskId}:attempt:1`).status, "SECURITY_INTERRUPTED");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("accepts a death proof only for the latest controller-bound step generation", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-latest-generation");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id, { payload: {
      workspaceRoot: "F:\\Games\\VectorVault",
      workerPlan: { steps: [
        { program: "node", args: ["first.mjs"], cwd: "." },
        { program: "node", args: ["second.mjs"], cwd: "." },
      ] },
    } });
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    const firstGeneration = "a".repeat(64), secondGeneration = "b".repeat(64);
    const first = { stepIndex: 0, totalSteps: 2, generationId: firstGeneration, previousGenerationId: null };
    const second = { stepIndex: 1, totalSteps: 2, generationId: secondGeneration, previousGenerationId: firstGeneration };
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      const runId = `${taskId}:attempt:1`;
      worker.status = async () => ({
        ok: true, node: worker.node, runId, status: "RUNNING", checkpoint: { completedSteps: 1 },
        payloadStepIndex: 1, payloadTotalSteps: 2,
        payloadGenerationId: secondGeneration, payloadPreviousGenerationId: firstGeneration,
        payloadGenerations: [first, second],
      });
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.deepEqual(orchestrator.journal.payloadGeneration(runId), second);
      worker.cancel = async (requestedRunId, { mode }) => {
        worker.cancelCalls.push({ runId: requestedRunId, mode });
        return {
          ok: true, node: worker.node, runId: requestedRunId, status: "CANCELLED", cancellationResolved: true,
          payloadStepIndex: 0, payloadTotalSteps: 2,
          payloadGenerationId: firstGeneration, payloadPreviousGenerationId: null,
          payloadDeathProof: {
            protocol: "game-factory-payload-death/1", stepIndex: 0, totalSteps: 2,
            generationId: firstGeneration, previousGenerationId: null, state: "reaped",
            observedAt: "2026-09-01T00:00:00.000Z", pid: 4242, starttime: "123456", decisionId: null,
          },
        };
      };
      worker.probe = async () => ({ ok: true, node: worker.node, configured: true });
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.equal(orchestrator.journal.get(runId).status, "SECURITY_CANCEL_REQUESTED");
      worker.cancel = async (requestedRunId, { mode }) => {
        worker.cancelCalls.push({ runId: requestedRunId, mode });
        return {
          ok: true, node: worker.node, runId: requestedRunId, status: "CANCELLED", cancellationResolved: true,
          payloadStepIndex: 1, payloadTotalSteps: 2,
          payloadGenerationId: secondGeneration, payloadPreviousGenerationId: firstGeneration,
          payloadDeathProof: {
            protocol: "game-factory-payload-death/1", stepIndex: 1, totalSteps: 2,
            generationId: secondGeneration, previousGenerationId: firstGeneration, state: "reaped",
            observedAt: "2026-09-01T00:00:01.000Z", pid: 4243, starttime: "123457", decisionId: null,
          },
        };
      };
      worker.probe = FakeWorker.prototype.probe.bind(worker);
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.equal(orchestrator.journal.get(runId).status, "SECURITY_INTERRUPTED");
      assert.equal(orchestrator.health().journal.active, 0);
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("fences a stale terminal observer before collecting output", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-before-collect");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    let collectCalls = 0;
    const baseStatus = worker.status.bind(worker);
    const baseCollect = worker.collect.bind(worker);
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      const runId = `${taskId}:attempt:1`;
      worker.setAll("SUCCEEDED");
      worker.status = async (requestedRunId) => {
        const status = await baseStatus(requestedRunId);
        orchestrator.journal.securityLatch(runId, { probe: { secureForUntrustedCode: false } }, "concurrent observer lost proof");
        return status;
      };
      worker.collect = async (requestedRunId) => { collectCalls++; return baseCollect(requestedRunId); };
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.equal(collectCalls, 0);
      const failed = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.result.securityStopped, true);
      assert.equal(orchestrator.journal.get(runId).status, "SECURITY_INTERRUPTED");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("discards collected output when proof loss latches during collection", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-after-collect");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    let collectCalls = 0;
    const baseCollect = worker.collect.bind(worker);
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      const runId = `${taskId}:attempt:1`;
      worker.setAll("SUCCEEDED");
      worker.collect = async (requestedRunId) => {
        collectCalls++;
        const collected = await baseCollect(requestedRunId);
        orchestrator.journal.securityLatch(runId, { probe: { secureForUntrustedCode: false } }, "proof lost while collection was in flight");
        return collected;
      };
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.equal(collectCalls, 1);
      const detail = store.getProject(uid, project.id);
      const failed = detail.tasks.find((task) => task.id === taskId);
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.result.securityStopped, true);
      assert.equal(failed.result.runId, undefined);
      const inspection = new DatabaseSync(store.file);
      try {
        assert.equal(Number(inspection.prepare(
          "SELECT COUNT(*) AS n FROM game_checkpoints WHERE projectId=? AND compatible=1",
        ).get(project.id).n), 0);
      } finally { inspection.close(); }
      assert.equal(orchestrator.journal.get(runId).status, "SECURITY_INTERRUPTED");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("rechecks the absorbing latch after worker start returns", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-start-race");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    const baseStart = worker.start.bind(worker);
    worker.start = async (request) => {
      const started = await baseStart(request);
      orchestrator.journal.securityLatch(request.runId, { probe: { secureForUntrustedCode: false } }, "proof lost while start was in flight");
      return started;
    };
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      assert.equal(worker.cancelCalls.length, 1);
      const failed = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.result.securityStopped, true);
      assert.equal(orchestrator.journal.get(`${taskId}:attempt:1`).status, "SECURITY_INTERRUPTED");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("does not admit work with a probe concurrent with a resolved security incident", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-probe-epoch");
    const worker = new FakeWorker();
    const completedTaskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.setAll("SUCCEEDED");
      assert.equal((await orchestrator.tick()).reconciled, 1);
      const completedRunId = `${completedTaskId}:attempt:1`;
      const secondProject = store.listProjects(uid).find((candidate) => candidate.id !== project.id);
      const queuedTaskId = queue(store, uid, secondProject.id);
      const baseProbe = worker.probe.bind(worker);
      worker.probe = async () => {
        orchestrator.journal.securityLatch(completedRunId, null, "concurrent proof-loss incident");
        store.securityStopTask({ uid, taskId: completedTaskId, attempt: 1, error: "concurrent proof-loss incident" });
        orchestrator.journal.securityFinish(completedRunId, {
          ok: true, runId: completedRunId, status: "INTERRUPTED", cancellationResolved: true,
        }, "concurrent proof-loss incident resolved");
        return baseProbe();
      };
      const raced = await orchestrator.tick();
      assert.equal(raced.claimed, 0);
      assert.equal(store.getProject(uid, secondProject.id).tasks.find((task) => task.id === queuedTaskId).status, "QUEUED");
      assert.equal(worker.runs.has(`${queuedTaskId}:attempt:1`), false);
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("security-stops a task when the durable incident epoch changes during its claim", async () => {
    const { store, journalDir, uid, project } = setup("gfo-proof-loss-claim-epoch");
    const worker = new FakeWorker();
    const completedTaskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      worker.setAll("SUCCEEDED");
      assert.equal((await orchestrator.tick()).reconciled, 1);
      const completedRunId = `${completedTaskId}:attempt:1`;
      const secondProject = store.listProjects(uid).find((candidate) => candidate.id !== project.id);
      const racedTaskId = queue(store, uid, secondProject.id);
      const baseClaim = store.claimNextTask.bind(store);
      let injected = false;
      store.claimNextTask = (args) => {
        const task = baseClaim(args);
        if (task && !injected) {
          injected = true;
          orchestrator.journal.securityLatch(completedRunId, null, "incident raced task claim");
          store.securityStopTask({ uid, taskId: completedTaskId, attempt: 1, error: "incident raced task claim" });
          orchestrator.journal.securityFinish(completedRunId, {
            ok: true, runId: completedRunId, status: "INTERRUPTED", cancellationResolved: true,
          }, "incident raced task claim resolved");
        }
        return task;
      };
      const raced = await orchestrator.tick();
      assert.equal(raced.claimed, 1);
      const stopped = store.getProject(uid, secondProject.id).tasks.find((task) => task.id === racedTaskId);
      assert.equal(stopped.status, "FAILED");
      assert.equal(stopped.result.securityStopped, true);
      assert.equal(worker.runs.has(`${racedTaskId}:attempt:1`), false);
      assert.equal(orchestrator.journal.latestForTask(racedTaskId), null);
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("dispatches the immutable synthetic canary only into its dedicated workspace subtree", async () => {
    const { store, journalDir, uid, project } = setup("gfo-synthetic-canary-subtree");
    const worker = new FakeWorker();
    const queued = store.queueSyntheticCanary({
      uid, projectId: project.id, key: "orchestrator-canary-subtree-0001", actor: uid,
      workspaceRoot: "/workspace", projectRelative: ".",
    });
    assert.equal(queued.status, 201);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      const runId = `${queued.body.taskId}:attempt:1`;
      const request = worker.runs.get(runId)?.request;
      assert.ok(request);
      assert.match(request.taskId, /^gft_canary_[a-f0-9]{32}$/);
      assert.equal(request.workspaceRoot, "/workspace/system-canary");
      assert.deepEqual(request.plan, {
        workspaceRoot: "/workspace/system-canary",
        steps: [{
          label: "Report the Node.js runtime version", program: "node", args: ["--version"],
          cwd: ".", timeoutMs: 30_000,
        }],
        collect: [],
      });
      assert.equal(store.getProject(uid, project.id).workspaceRoot, "");
    } finally {
      await orchestrator.close();
      store.close();
    }
  });

  await test("a second leader's failed probe fences a start before its active-dispatch snapshot", async () => {
    const { store, journalDir, uid, project } = setup("gfo-two-leader-start-proof-epoch");
    let clock = 1_000;
    const now = () => clock;
    const workerA = new FakeWorker();
    const workerB = new FakeWorker();
    workerB.probe = async () => ({
      ok: false, node: workerB.node, configured: true, secureForUntrustedCode: false,
      error: "executor attestation disappeared",
    });
    const startEntered = deferred(), allowStartReturn = deferred();
    const incidentObserved = deferred(), allowSecondSnapshot = deferred();
    const baseStart = workerA.start.bind(workerA);
    workerA.start = async (request) => {
      startEntered.resolve(request.runId);
      await allowStartReturn.promise;
      return baseStart(request);
    };
    const leaderA = createGameFactoryOrchestrator({
      store, worker: workerA, journalDir, now, leaderLeaseMs: 5_000,
    });
    const leaderB = createGameFactoryOrchestrator({
      store, worker: workerB, journalDir, now, leaderLeaseMs: 5_000,
    });
    const realObserve = leaderB.journal.observeProofLoss.bind(leaderB.journal);
    leaderB.journal.observeProofLoss = async (...args) => {
      const epoch = realObserve(...args);
      incidentObserved.resolve(epoch);
      await allowSecondSnapshot.promise;
      return epoch;
    };
    let secondTick = null;
    try {
      const taskId = queue(store, uid, project.id);
      const firstTick = leaderA.tick();
      const runId = await startEntered.promise;
      assert.equal(runId, `${taskId}:attempt:1`);

      clock = 7_000;
      secondTick = leaderB.tick();
      const observedEpoch = await incidentObserved.promise;
      assert.ok(observedEpoch > 0);
      // B has durably recorded proof loss but has not listed active dispatches. Let A's already
      // issued start return in that exact gap; only the global epoch can fence it.
      allowStartReturn.resolve();
      const report = await firstTick;
      assert.equal(report.claimed, 1);
      const stopped = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(stopped.status, "FAILED");
      assert.equal(stopped.result.securityStopped, true);
      assert.equal(workerA.cancelCalls.some((call) => call.runId === runId && call.mode === "immediate"), true);
      assert.equal(leaderA.journal.get(runId).status, "SECURITY_INTERRUPTED");

      allowSecondSnapshot.resolve();
      await secondTick;
    } finally {
      allowStartReturn.resolve();
      allowSecondSnapshot.resolve();
      if (secondTick) await secondTick.catch(() => {});
      await leaderA.close();
      await leaderB.close();
      store.close();
    }
  });

  await test("a second leader's failed probe overrides completion before normal journal finish", async () => {
    const { store, journalDir, uid, project } = setup("gfo-two-leader-complete-proof-epoch");
    let clock = 1_000;
    const now = () => clock;
    const workerA = new FakeWorker();
    const workerB = new FakeWorker();
    workerB.probe = async () => ({
      ok: false, node: workerB.node, configured: true, secureForUntrustedCode: false,
      error: "executor attestation disappeared",
    });
    const leaderA = createGameFactoryOrchestrator({
      store, worker: workerA, journalDir, now, leaderLeaseMs: 5_000,
    });
    const leaderB = createGameFactoryOrchestrator({
      store, worker: workerB, journalDir, now, leaderLeaseMs: 5_000,
    });
    let secondObservedEpoch = 0;
    let taskStoreCompleted = false;
    const baseComplete = store.completeTask.bind(store);
    const baseFinish = leaderA.journal.finishIfSecurityEpoch.bind(leaderA.journal);
    try {
      const taskId = queue(store, uid, project.id);
      assert.equal((await leaderA.tick()).claimed, 1);
      const runId = `${taskId}:attempt:1`;
      workerA.setAll("SUCCEEDED", { completedSteps: 1, complete: true });
      clock = 7_000;
      store.completeTask = (args) => {
        const committed = baseComplete(args);
        taskStoreCompleted = committed?.status === 200;
        return committed;
      };
      leaderA.journal.finishIfSecurityEpoch = (...args) => {
        assert.equal(taskStoreCompleted, true);
        // A has passed its post-store asynchronous fence and is entering the atomic normal journal
        // finish. Expire its lease and persist B's failed-probe epoch immediately before that write.
        clock = 13_000;
        assert.equal(leaderB.journal.acquireLeadership("test-proof-loss-leader", 5_000), true);
        secondObservedEpoch = leaderB.journal.observeProofLoss({
          ok: false, node: workerB.node, configured: true, secureForUntrustedCode: false,
          error: "executor attestation disappeared",
        }, "second leader force probe failed");
        return baseFinish(...args);
      };

      const completionTick = leaderA.tick();
      const report = await completionTick;
      assert.ok(secondObservedEpoch > 0);
      assert.equal(report.reconciled, 1);
      const stopped = store.getProject(uid, project.id).tasks.find((task) => task.id === taskId);
      assert.equal(stopped.status, "FAILED");
      assert.equal(stopped.result.securityStopped, true);
      assert.equal(stopped.result.runId, undefined);
      // The terminal status already carried a valid latest-generation reaping proof, so the
      // security stop must not issue a redundant cancellation merely to manufacture another proof.
      assert.equal(workerA.cancelCalls.some((call) => call.runId === runId && call.mode === "immediate"), false);
      assert.equal(leaderA.journal.get(runId).status, "SECURITY_INTERRUPTED");
      const inspection = new DatabaseSync(store.file);
      try {
        assert.equal(Number(inspection.prepare(
          "SELECT COUNT(*) AS n FROM game_checkpoints WHERE projectId=? AND compatible=1",
        ).get(project.id).n), 0);
      } finally { inspection.close(); }

    } finally {
      store.completeTask = baseComplete;
      leaderA.journal.finishIfSecurityEpoch = baseFinish;
      await leaderA.close();
      await leaderB.close();
      store.close();
    }
  });

  await test("claims, journals, heartbeats, collects, and commits a successful run", async () => {
    const { store, journalDir, uid, project } = setup("gfo-success");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir, pollMs: 60_000 });
    const first = await orchestrator.tick();
    assert.equal(first.claimed, 1);
    assert.equal(orchestrator.health().journal.active, 1);
    const runId = [...worker.runs.keys()][0];
    assert.equal(runId, `${taskId}:attempt:1`);
    worker.setAll("SUCCEEDED");
    const second = await orchestrator.tick();
    assert.equal(second.reconciled, 1);
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "COMPLETED");
    assert.equal(detail.tasks.find((task) => task.id === taskId).result.runId, runId);
    assert.equal(orchestrator.health().journal.active, 0);
    assert.deepEqual(worker.acknowledgeCalls, [runId]);
    assert.equal(orchestrator.journal.listRetentionPending().length, 0);
    await orchestrator.close();
    store.close();
  });

  await test("retries two-phase retention pruning after terminal truth is durable", async () => {
    const { store, journalDir, uid, project } = setup("gfo-retention-retry");
    const worker = new FakeWorker(); let acknowledgements = 0;
    worker.acknowledge = async (runId) => {
      worker.acknowledgeCalls.push(runId); acknowledgements++;
      return { ok: true, node: worker.node, runId, retentionAcknowledged: true,
        retentionPruned: acknowledgements > 1, ...(acknowledgements > 1 ? { generationsPruned: 1 } : { generationsPending: 1 }) };
    };
    const taskId = queue(store, uid, project.id);
    const secondProject = store.listProjects(uid).find((candidate) => candidate.id !== project.id);
    const secondTaskId = queue(store, uid, secondProject.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    try {
      assert.equal((await orchestrator.tick()).claimed, 1);
      const runId = `${taskId}:attempt:1`; worker.setAll("SUCCEEDED");
      assert.equal((await orchestrator.tick()).reconciled, 1);
      assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "COMPLETED");
      assert.equal(store.getProject(uid, secondProject.id).tasks.find((task) => task.id === secondTaskId).status, "QUEUED");
      assert.equal(orchestrator.journal.listRetentionPending().length, 1);
      const retried = await orchestrator.tick();
      assert.equal(retried.retentionPruned, 1);
      assert.equal(retried.claimed, 1);
      assert.equal(orchestrator.journal.listRetentionPending().length, 0);
      assert.deepEqual(worker.acknowledgeCalls, [runId, runId]);
    } finally {
      await orchestrator.close(); store.close();
    }
  });

  await test("recovers an in-flight dispatch from the journal after orchestrator restart", async () => {
    const { store, journalDir, uid, project } = setup("gfo-restart");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const first = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await first.tick()).claimed, 1);
    await first.close();

    worker.setAll("SUCCEEDED");
    const restarted = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await restarted.tick()).reconciled, 1);
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "COMPLETED");
    assert.equal(restarted.health().journal.total, 1);
    await restarted.close();
    store.close();
  });

  await test("does not duplicate or fail work when the start acknowledgement is ambiguous", async () => {
    const { store, journalDir, uid, project } = setup("gfo-uncertain");
    const worker = new FakeWorker();
    let firstStart = true;
    const baseStart = worker.start.bind(worker);
    worker.start = async (request) => {
      const accepted = await baseStart(request);
      if (firstStart) {
        firstStart = false;
        return { ok: false, node: worker.node, timedOut: true, retryable: true, error: "acknowledgement timed out" };
      }
      return accepted;
    };
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    await orchestrator.tick();
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "RUNNING");
    assert.equal(orchestrator.health().journal.active, 1);
    worker.setAll("SUCCEEDED");
    await orchestrator.tick();
    assert.equal(store.getProject(uid, project.id).tasks.find((task) => task.id === taskId).status, "COMPLETED");
    assert.equal(worker.runs.size, 1);
    await orchestrator.close();
    store.close();
  });

  await test("turns owner pause into safe-boundary cancellation and durable PAUSED state", async () => {
    const { store, journalDir, uid, project } = setup("gfo-pause");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    await orchestrator.tick();
    const current = store.getProject(uid, project.id);
    const paused = store.executeCommand({
      uid, projectId: project.id, key: "pause-for-test", expectedVersion: current.version,
      type: "pause", actor: "owner",
    });
    assert.equal(paused.status, 202);
    await orchestrator.tick();
    assert.equal(worker.cancelCalls.length, 1);
    assert.equal(worker.cancelCalls[0].mode, "safe");
    await orchestrator.tick();
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.state, "PAUSED");
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "PAUSED");
    assert.equal(detail.tasks.find((task) => task.id === taskId).result.status, "PAUSED");
    await orchestrator.close();
    store.close();
  });

  await test("blocks instead of inventing a safe boundary when a worker fails during pause", async () => {
    const { store, journalDir, uid, project } = setup("gfo-pause-failure");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id);
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    await orchestrator.tick();
    const current = store.getProject(uid, project.id);
    assert.equal(store.executeCommand({ uid, projectId: project.id, key: "pause-before-failure", expectedVersion: current.version, type: "pause" }).status, 202);
    worker.setAll("FAILED", { completedSteps: 0, safeBoundary: true });
    await orchestrator.tick();
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.equal(detail.state, "BLOCKED");
    assert.match(detail.blocker, /before the requested pause.*confirmed safe boundary/i);
    await orchestrator.close();
    store.close();
  });

  await test("fails closed when a worker invents a pause without an owner request", async () => {
    const { store, journalDir, uid, project } = setup("gfo-unexpected-pause");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id, { safeToRetry: false });
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    await orchestrator.tick();
    worker.setAll("PAUSED", { completedSteps: 1, safeBoundary: true });
    await orchestrator.tick();
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.equal(detail.state, "FAILED");
    assert.match(detail.blocker, /unexpected paused state/i);
    assert.equal(orchestrator.health().journal.active, 0);
    await orchestrator.close();
    store.close();
  });

  await test("fails closed on an unknown remote protocol state", async () => {
    const { store, journalDir, uid, project } = setup("gfo-unknown-state");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id, { safeToRetry: false });
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    await orchestrator.tick();
    worker.setAll("INVENTED_REMOTE_STATE");
    await orchestrator.tick();
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.match(detail.blocker, /unknown protocol state/i);
    assert.equal(orchestrator.health().journal.active, 0);
    await orchestrator.close();
    store.close();
  });

  await test("fails closed when collection contradicts the observed terminal status", async () => {
    const { store, journalDir, uid, project } = setup("gfo-contradictory-collection");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id, { safeToRetry: false });
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    await orchestrator.tick();
    worker.setAll("SUCCEEDED");
    const originalCollect = worker.collect.bind(worker);
    worker.collect = async (runId) => ({ ...(await originalCollect(runId)), status: "PAUSED" });
    await orchestrator.tick();
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.match(detail.blocker, /contradicted terminal status/i);
    assert.equal(orchestrator.health().journal.active, 0);
    await orchestrator.close();
    store.close();
  });

  await test("refuses malformed recipes before any remote side effect", async () => {
    const { store, journalDir, uid, project } = setup("gfo-refuse");
    const worker = new FakeWorker();
    const taskId = queue(store, uid, project.id, { payload: { workspaceRoot: "F:\\Games\\VectorVault" }, safeToRetry: false });
    const orchestrator = createGameFactoryOrchestrator({ store, worker, journalDir });
    assert.equal((await orchestrator.tick()).claimed, 1);
    assert.equal(worker.runs.size, 0);
    const detail = store.getProject(uid, project.id);
    assert.equal(detail.tasks.find((task) => task.id === taskId).status, "FAILED");
    assert.equal(detail.state, "FAILED");
    await orchestrator.close();
    store.close();
  });

  await test("a schema-1 dispatch journal fixture upgrades to schema 2 in place, losing no dispatch or event rows", async () => {
    // Lead note 2026-09-03: the production journal (/data/game-factory/gamefactory-dispatch.db) is
    // schema 1 with real dispatches and hundreds of events. This proves the automatic 1->2 migration
    // (worker_suspension/worker_identity, both purely additive CREATE TABLE IF NOT EXISTS) opens a
    // genuine v1 file, advances it, and returns every existing row unmodified rather than trusting
    // that "additive" reasoning by inspection alone.
    const dir = temp("gfo-journal-v1-migration");
    const file = join(dir, "gamefactory-dispatch.db");
    const v1Checksum = createHash("sha256").update("dispatches:v1|dispatch_events:v1|orchestrator_leader:v1").digest("hex");
    const fixture = new DatabaseSync(file);
    fixture.exec(`
      CREATE TABLE dispatch_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
        checksum TEXT NOT NULL, appliedAt INTEGER NOT NULL
      );
      CREATE TABLE dispatches (
        runId TEXT PRIMARY KEY, taskId TEXT NOT NULL, attempt INTEGER NOT NULL, uid TEXT NOT NULL,
        projectId TEXT NOT NULL, buildId TEXT NOT NULL DEFAULT '', workerId TEXT NOT NULL,
        capability TEXT NOT NULL, requestHash TEXT NOT NULL, taskJson TEXT NOT NULL,
        requestJson TEXT NOT NULL, status TEXT NOT NULL, remoteStatus TEXT NOT NULL DEFAULT '',
        lastResponse TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL DEFAULT 0, endedAt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE dispatch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL
      );
      CREATE TABLE orchestrator_leader (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), instanceId TEXT NOT NULL,
        leaseUntil INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
    `);
    const runIds = ["gfo-v1-fixture-run-1", "gfo-v1-fixture-run-2"];
    for (const runId of runIds) {
      fixture.prepare(`INSERT INTO dispatches (runId,taskId,attempt,uid,projectId,buildId,workerId,capability,requestHash,taskJson,requestJson,status,remoteStatus,lastResponse,error,createdAt,updatedAt,lastSeenAt,endedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, runId + "-task", 1, "gfo-v1-fixture-uid", "gfo-v1-fixture-project", "", "gx10",
          "quality_assurance", "a".repeat(64), "{}", "{}", "SUCCEEDED", "", "", "",
          1_000, 1_000, 1_000, 1_000);
    }
    let expectedEvents = 0;
    for (const runId of runIds) {
      for (let i = 0; i < 6; i++) {
        fixture.prepare("INSERT INTO dispatch_events (runId,type,payload,createdAt) VALUES (?,?,?,?)")
          .run(runId, "dispatch.status", JSON.stringify({ i }), 1_000 + i);
        expectedEvents++;
      }
    }
    fixture.prepare("INSERT INTO dispatch_schema (singleton,version,checksum,appliedAt) VALUES (1,1,?,?)").run(v1Checksum, 1_000);
    fixture.exec("PRAGMA user_version=1");
    fixture.close();

    const journal = createGameFactoryDispatchJournal({ dir });
    try {
      const health = journal.health();
      assert.equal(health.schema.version, 2, "the journal must report the upgraded schema version");
      assert.equal(health.total, runIds.length, "no dispatch row can be lost by the migration");
      for (const runId of runIds) {
        const dispatch = journal.get(runId);
        assert.ok(dispatch, `dispatch ${runId} must survive the migration`);
        assert.equal(dispatch.status, "SUCCEEDED");
        assert.equal(dispatch.uid, "gfo-v1-fixture-uid");
      }
      // A freshly migrated file has no suspension recorded yet; the new capability must work
      // immediately without a separate backfill step.
      assert.deepEqual(journal.getSuspension(), { active: false, since: 0, node: "", reason: "", identity: null });
    } finally {
      await journal.close();
    }

    // Verify the event rows physically survived migration through a fresh, independent connection
    // (not the journal's own reader), so this cannot pass merely because the journal cached a count.
    const verify = new DatabaseSync(file);
    try {
      const total = Number(verify.prepare("SELECT COUNT(*) AS n FROM dispatch_events").get().n) || 0;
      assert.equal(total, expectedEvents, "no event row can be lost by the migration");
      const schemaRow = verify.prepare("SELECT version,checksum FROM dispatch_schema WHERE singleton=1").get();
      assert.equal(schemaRow.version, 2);
      const userVersion = Number(verify.prepare("PRAGMA user_version").get().user_version) || 0;
      assert.equal(userVersion, 2, "PRAGMA user_version must also advance so a later open does not re-run migration logic");
    } finally {
      verify.close();
    }
  });

  console.log(`\n${passed} game factory orchestrator tests passed`);
} finally {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
}
