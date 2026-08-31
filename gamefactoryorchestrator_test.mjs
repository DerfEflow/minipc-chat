import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { createGameFactoryDispatchJournal, createGameFactoryOrchestrator } from "./gamefactoryorchestrator.mjs";

const roots = [];
const cleanups = [];
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
  }
  async probe() { return { ok: true, node: this.node, configured: true }; }
  async start(request) {
    if (!this.runs.has(request.runId)) this.runs.set(request.runId, { request, status: "RUNNING", checkpoint: { completedSteps: 0 } });
    return { ok: true, node: this.node, runId: request.runId, status: this.runs.get(request.runId).status };
  }
  async status(runId) {
    const run = this.runs.get(runId);
    return run ? { ok: true, node: this.node, runId, status: run.status, checkpoint: run.checkpoint } : { ok: false, node: this.node, notFound: true };
  }
  async cancel(runId, { mode }) {
    const run = this.runs.get(runId);
    this.cancelCalls.push({ runId, mode });
    if (run) {
      run.status = mode === "immediate" ? "CANCELLED" : "PAUSED";
      run.checkpoint = { completedSteps: 1, safeBoundary: true };
    }
    return { ok: true, node: this.node, runId, status: run?.status || "CANCELLED", checkpoint: run?.checkpoint };
  }
  async collect(runId) {
    const run = this.runs.get(runId);
    return run ? {
      ok: true, node: this.node, runId, status: run.status, checkpoint: run.checkpoint,
      result: { done: true }, artifacts: [{ path: "build.apk", sha256: "a".repeat(64), size: 10 }],
      stdout: "worker output", stderr: "",
    } : { ok: false, notFound: true };
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
  const result = store.queueTask({
    uid, projectId, capability: "quality_assurance", title: "Run QA", safeToRetry: true,
    payload: {
      workspaceRoot: "F:\\Games\\VectorVault",
      workerPlan: { steps: [{ program: "godot", args: ["--headless", "--quit"], cwd: "." }] },
    },
    ...extra,
  });
  assert.equal(result.status, 201);
  return result.body.taskId;
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
    await orchestrator.close();
    store.close();
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

  console.log(`\n${passed} game factory orchestrator tests passed`);
} finally {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
}
