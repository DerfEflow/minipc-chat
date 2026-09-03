import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_REQUIRED_SUITES } from "./gamefactory.mjs";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { createGameFactoryPlanner } from "./gamefactoryplanner.mjs";
import { createGameFactorySupervisor, RUN_TO_PLAYTEST_RATIONALE } from "./gamefactorysupervisor.mjs";

const dir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-supervisor-"));
let clock = 1_800_000_000_000;
const store = createGameFactoryStore({ dir, now: () => clock });
let n = 0;
async function test(name, fn) { await fn(); n++; console.log("ok", n, "-", name); }
const owner = "owner";

// ---- fake artifact mirror (real store + real planner behind it): records copies through
// store.recordArtifact + store.recordArtifactCopy for the "primary" and "google_drive" backends so
// every rendered specification artifact becomes complete, exactly as LANE-gfsupervisor.md asks. ----
function fakeArtifactMirror() {
  const shaByArtifact = new Map();
  return {
    async health() { return { localWritesEnabled: true, driveWritesEnabled: true, nativeProjectConfigured: false }; },
    async ingestBuffer({ uid, projectId, artifactKey, data, mimeType, provenance }) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const recorded = store.recordArtifact({ uid, projectId, artifactKey, sha256, size: buf.length, mimeType, provenance });
      if (recorded.status >= 300) return recorded;
      shaByArtifact.set(recorded.body.artifactId, sha256);
      store.recordArtifactCopy({ uid, artifactId: recorded.body.artifactId, backend: "primary", status: "VERIFIED", fingerprint: sha256 });
      return { status: 201, body: { ok: true, artifactId: recorded.body.artifactId, version: recorded.body.version, sha256, size: buf.length, reused: false } };
    },
    async mirrorArtifact({ uid, artifactId }) {
      const sha256 = shaByArtifact.get(artifactId);
      const response = store.recordArtifactCopy({ uid, artifactId, backend: "google_drive", status: "VERIFIED", fingerprint: sha256 });
      return { status: response.status < 300 ? 200 : response.status, body: response.body };
    },
  };
}
const planner = createGameFactoryPlanner({ store, artifactMirror: fakeArtifactMirror() });

// ---- fake server QA runner: injectable pass/fail mode, never touches the real filesystem. --------
function fakeQaRunner() {
  const calls = [];
  let mode = "pass";
  return {
    calls,
    setMode(next) { mode = next; },
    async run({ bundleDir, resultsDir }) {
      calls.push({ bundleDir, resultsDir, mode });
      const suites = {};
      for (const suite of QA_REQUIRED_SUITES) {
        suites[suite] = mode === "pass" || suite !== "core-loop"
          ? { status: "PASSED", summary: `${suite} passed on the fixtures.`, metrics: {} }
          : { status: "FAILED", summary: "The level-1 win fixture ended lost, not won.", failures: ["level-1 win fixture ended lost"] };
      }
      return {
        ok: mode === "pass", runner: "server-qa", timedOut: false, exitCode: 0, durationMs: 12,
        results: { schema: "gf-qa/1", bundleSha256: "q".repeat(64), startedAt: new Date(clock).toISOString(), endedAt: new Date(clock).toISOString(), runner: "server-qa", suites },
      };
    },
  };
}

// ---- fake kit: verifyBundle keyed by the buildId segment of the bundle directory it is given. -----
function fakeKit() {
  const failures = new Map();
  return {
    QA_SUITES: QA_REQUIRED_SUITES,
    verifyBundle(bundleDir) {
      const parts = String(bundleDir).split(/[\\/]+/);
      const buildId = parts[parts.length - 2];
      if (failures.has(buildId)) return { ok: false, bundleSha256: "", problems: failures.get(buildId) };
      return { ok: true, bundleSha256: "b".repeat(64), problems: [] };
    },
    forceFailure(buildId, problems) { failures.set(buildId, problems); },
  };
}

const qa = fakeQaRunner();
const kit = fakeKit();
const supervisor = createGameFactorySupervisor({ store, planner, qaRunner: qa, kit, dataDir: dir, ownerUid: owner, ownerEmail: "owner@example.com", pollMs: 60_000, maxRepairs: 3 });

let keyCounter = 0;
const nextKey = (label) => `test-${label}-${++keyCounter}-${"k".repeat(4)}`;
const bundleSha = (tag) => createHash("sha256").update(String(tag)).digest("hex");

// The store's own getProject() picks a project's "active build" as the most recently created build
// row (ORDER BY createdAt DESC LIMIT 1) — a fine assumption under a real, always-advancing wall
// clock, but this suite pins `clock` for determinism. Every mutation therefore ticks the fake clock
// forward first so two builds (or two anything) never tie on createdAt and make that ORDER BY
// ambiguous. Real usage never hits this: wall-clock time always moves between two store writes.
function advanceClock(ms = 5) { clock += ms; }
async function tick() { advanceClock(); return supervisor.tick(); }

function claimAndComplete(capability, resultFor) {
  advanceClock();
  const claimed = store.claimNextTask({ workerId: "test-forge", capability, leaseMs: 60_000 });
  assert.ok(claimed, `expected a queued ${capability} task to claim`);
  advanceClock();
  const outcome = store.completeTask({ uid: owner, taskId: claimed.id, workerId: "test-forge", attempt: claimed.attempt, result: resultFor(claimed) });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return claimed;
}

const AUTO_FORGE = {
  product_planning: () => ({ status: "SUCCEEDED", ok: true }),
  visual_design: () => ({ status: "SUCCEEDED", ok: true }),
  gameplay_engineering: (claimed) => ({ status: "SUCCEEDED", ok: true, bundleSha256: bundleSha(claimed.id) }),
};

// Ticks until predicate(detail) is true, auto-completing any queued task whose capability is in
// autoComplete along the way (simulating the forge lane). Bounded so a stuck state fails loudly.
async function tickUntil(projectId, predicate, { maxTicks = 60, autoComplete = AUTO_FORGE } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    const detail = store.getProject(owner, projectId);
    if (predicate(detail)) return detail;
    await tick();
    const after = store.getProject(owner, projectId);
    const queued = (after.tasks || []).find((task) => task.status === "QUEUED" && autoComplete[task.capability]);
    if (queued) claimAndComplete(queued.capability, autoComplete[queued.capability]);
  }
  const final = store.getProject(owner, projectId);
  assert.ok(predicate(final), `tickUntil exhausted ${maxTicks} ticks without reaching the target state (still ${final.state})`);
  return final;
}

function ownerDecision(projectId, gate, decision, rationale) {
  advanceClock();
  const detail = store.getProject(owner, projectId);
  const subject = detail.approvalSubjects[gate];
  assert.ok(subject?.ready, `${gate} subject not ready: ${JSON.stringify(subject)}`);
  const response = store.executeCommand({
    uid: owner, projectId, key: nextKey(`${decision}-${gate}`), expectedVersion: detail.version,
    type: decision, payload: { gate, subjectHash: subject.hash, rationale }, actor: "owner-test",
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response;
}

try {
  const seeded = store.seedPortfolio({ uid: owner, email: "owner@example.com" });
  assert.equal(seeded.length, 10);
  const bySlug = (slug) => store.listProjects(owner).find((p) => p.slug === slug);

  // ---- 1 & 2: IDEA -> PLAYTEST_READY via runToPlaytest, one action per tick, 12 PASSED ----------
  {
    const project = bySlug("vector-vault");

    await test("runToPlaytest starts the specification (11 artifacts), approves it, and turns autopilot on", async () => {
      const response = await supervisor.runToPlaytest({ projectId: project.id, key: nextKey("run"), expectedVersion: project.version });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.autopilot, true);
      const detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "SPECIFICATION");
      assert.equal(detail.artifacts.length, 11);
      assert.equal(detail.artifacts.every((a) => a.complete), true);
      assert.equal(detail.evidence.specificationApproved, true);
      const approval = detail.approvals.find((a) => a.gate === "SPECIFICATION" && a.decision === "APPROVED");
      assert.ok(approval);
      assert.equal(approval.rationale, RUN_TO_PLAYTEST_RATIONALE);
      assert.equal(supervisor.getAutopilot(project.id), true);
    });

    await test("tick 1: SPECIFICATION -> ARCHITECTURE", async () => {
      await tick();
      assert.equal(store.getProject(owner, project.id).state, "ARCHITECTURE");
    });

    await test("tick 2: autopilot approves VISUAL_SYSTEM (no transition yet)", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "ARCHITECTURE");
      assert.equal(detail.evidence.visualSystemApproved, true);
      const approval = detail.approvals.find((a) => a.gate === "VISUAL_SYSTEM" && a.decision === "APPROVED");
      assert.equal(approval.rationale, RUN_TO_PLAYTEST_RATIONALE);
    });

    await test("tick 3: no completed product_planning task yet -> queue the design task", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      const designTask = detail.tasks.find((task) => task.capability === "product_planning" && task.status === "QUEUED");
      assert.ok(designTask);
      assert.equal(designTask.payload.kind, "design");
      assert.equal(designTask.payload.designVersion, detail.approvalSubjects.SPECIFICATION.hash);
    });

    await test("completing the design task, tick 4: ARCHITECTURE -> ASSET_GENERATION", async () => {
      claimAndComplete("product_planning", AUTO_FORGE.product_planning);
      await tick();
      assert.equal(store.getProject(owner, project.id).state, "ASSET_GENERATION");
    });

    await test("tick 5: no completed visual_design task yet -> queue the assets task", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      const assetsTask = detail.tasks.find((task) => task.capability === "visual_design" && task.status === "QUEUED");
      assert.ok(assetsTask);
      assert.equal(assetsTask.payload.kind, "assets");
    });

    await test("completing the assets task, tick 6: ASSET_GENERATION -> IMPLEMENTATION", async () => {
      claimAndComplete("visual_design", AUTO_FORGE.visual_design);
      await tick();
      assert.equal(store.getProject(owner, project.id).state, "IMPLEMENTATION");
    });

    let firstBuildId = "";
    await test("tick 7: no active build -> create build 0.1.1 and queue the implement task", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      assert.ok(detail.activeBuild);
      assert.equal(detail.activeBuild.versionName, "0.1.1");
      assert.equal(detail.activeBuild.status, "PLANNED");
      firstBuildId = detail.activeBuild.id;
      const gameplayTask = detail.tasks.find((task) => task.capability === "gameplay_engineering" && task.status === "QUEUED");
      assert.ok(gameplayTask);
      assert.equal(gameplayTask.payload.kind, "implement");
      assert.equal(gameplayTask.buildId, firstBuildId);
    });

    await test("completing the build task, tick 8: IMPLEMENTATION -> INTEGRATION", async () => {
      claimAndComplete("gameplay_engineering", (claimed) => ({ status: "SUCCEEDED", ok: true, bundleSha256: bundleSha("build-1") }));
      await tick();
      assert.equal(store.getProject(owner, project.id).state, "INTEGRATION");
    });

    await test("tick 9: bundle verifies -> build BUILT, INTEGRATION -> AUTOMATED_TESTING", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "AUTOMATED_TESTING");
      assert.equal(detail.activeBuild.status, "BUILT");
    });

    await test("tick 10: no QA run recorded yet -> run the server QA suite and record all 12", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "AUTOMATED_TESTING", "recording evidence is its own tick; the transition follows on the next one");
      const forThisBuild = detail.tests.filter((t) => t.buildId === firstBuildId);
      assert.equal(forThisBuild.length, 12);
      assert.equal(forThisBuild.filter((t) => t.status === "PASSED").length, 12);
      assert.equal(qa.calls.length, 1);
    });

    await test("tick 11: all 12 PASSED -> AUTOMATED_TESTING -> PLAYTEST_READY", async () => {
      await tick();
      const detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "PLAYTEST_READY");
      assert.equal(detail.evidence.qaReady, true);
      assert.equal(detail.approvalSubjects.PLAYTEST.ready, true);
    });

    await test("further ticks are a no-op at PLAYTEST_READY without an owner decision", async () => {
      const before = store.getProject(owner, project.id).version;
      await tick();
      await tick();
      assert.equal(store.getProject(owner, project.id).version, before);
    });
  }

  // ---- 3: manual path (no autopilot) waits at ARCHITECTURE until VISUAL_SYSTEM is approved -------
  {
    const project = bySlug("bolt-bloom");
    await test("manual path: without autopilot, ARCHITECTURE waits for the owner's own VISUAL_SYSTEM approval", async () => {
      const started = await planner.startSpecification({ uid: owner, email: "owner@example.com", projectId: project.id, key: nextKey("manual-start"), expectedVersion: project.version, actor: "owner-test" });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(supervisor.getAutopilot(project.id), false, "autopilot must stay off on the manual path");

      ownerDecision(project.id, "SPECIFICATION", "approve", "owner approved the brief by hand");
      await tick(); // SPECIFICATION -> ARCHITECTURE (this row does not require autopilot)
      assert.equal(store.getProject(owner, project.id).state, "ARCHITECTURE");

      await tick(); // no autopilot: no auto-approve; queues the design task instead
      let detail = store.getProject(owner, project.id);
      assert.equal(detail.evidence.visualSystemApproved, false);
      claimAndComplete("product_planning", AUTO_FORGE.product_planning);

      // design is complete but nobody approved VISUAL_SYSTEM: repeated ticks must not transition.
      for (let i = 0; i < 3; i++) await tick();
      detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "ARCHITECTURE", "the game must wait at ARCHITECTURE without a human VISUAL_SYSTEM approval");

      ownerDecision(project.id, "VISUAL_SYSTEM", "approve", "owner approved the visual system by hand");
      await tick(); // now it can move on
      assert.equal(store.getProject(owner, project.id).state, "ASSET_GENERATION");
    });
  }

  // ---- 4: reject at PLAYTEST -> REVISION -> IMPLEMENTATION (revise) -> new build -> PLAYTEST_READY,
  //         approvals bound to the old build are invalidated by the new build. ---------------------
  {
    const project = bySlug("pocket-gravity");
    qa.setMode("pass");
    await test("reject at PLAYTEST drives a revise build back to PLAYTEST_READY and invalidates the old approvals", async () => {
      await supervisor.runToPlaytest({ projectId: project.id, key: nextKey("run"), expectedVersion: project.version });
      const ready = await tickUntil(project.id, (d) => d.state === "PLAYTEST_READY");
      const firstBuildId = ready.activeBuild.id;

      ownerDecision(project.id, "PLAYTEST", "reject", "Make the vault glow brighter.");
      assert.equal(store.getProject(owner, project.id).state, "REVISION");

      const revised = await tickUntil(project.id, (d) => d.state === "PLAYTEST_READY" && d.activeBuild?.id !== firstBuildId);
      assert.notEqual(revised.activeBuild.id, firstBuildId);
      assert.equal(revised.evidence.qaReady, true);

      const reviseTask = revised.tasks.find((task) => task.capability === "gameplay_engineering" && task.buildId === revised.activeBuild.id);
      assert.ok(reviseTask);
      assert.equal(reviseTask.payload.kind, "revise");
      assert.equal(reviseTask.payload.reason, "Make the vault glow brighter.");

      const oldRejection = revised.approvals.find((a) => a.buildId === firstBuildId && a.gate === "PLAYTEST" && a.decision === "REJECTED");
      assert.ok(oldRejection);
      assert.ok(oldRejection.invalidatedAt > 0, "the old build's PLAYTEST rejection must be invalidated once a new build exists");
    });
  }

  // ---- 5: QA failure -> repair task with failures -> after maxRepairs -> BLOCKED; Retry re-enters -
  {
    const project = bySlug("chromalock");
    await test("repeated QA failure queues repair builds up to the budget, then blocks with the failing sentence; Retry re-enters", async () => {
      qa.setMode("fail");
      await supervisor.runToPlaytest({ projectId: project.id, key: nextKey("run"), expectedVersion: project.version });
      const blocked = await tickUntil(project.id, (d) => d.state === "BLOCKED", { maxTicks: 120 });

      assert.match(blocked.blocker, /QA failed after 3 repair builds/);
      assert.match(blocked.blocker, /core-loop/);
      assert.equal(store.listBuilds(owner, project.id).length, 4, "one implement build plus three repair builds");

      const repairTasks = blocked.tasks.filter((task) => task.capability === "gameplay_engineering" && task.payload?.kind === "repair");
      assert.equal(repairTasks.length, 3);
      for (const task of repairTasks) assert.ok(Array.isArray(task.payload.failures) && task.payload.failures.includes("core-loop"));

      advanceClock();
      const retryResponse = store.executeCommand({ uid: owner, projectId: project.id, key: nextKey("retry"), expectedVersion: blocked.version, type: "retry", payload: {}, actor: "owner-test" });
      assert.equal(retryResponse.status, 200, JSON.stringify(retryResponse.body));
      assert.equal(retryResponse.body.project.state, "AUTOMATED_TESTING", "retry returns to the state the game was in when it was blocked");
      qa.setMode("pass");
    });
  }

  // ---- 6: idempotency -------------------------------------------------------------------------
  {
    const project = bySlug("pulse-path");
    qa.setMode("pass");
    await test("the sv:<projectId>:<version>:<intent> key collapses a replayed commit into one transition", async () => {
      await supervisor.runToPlaytest({ projectId: project.id, key: nextKey("run"), expectedVersion: project.version });
      const detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "SPECIFICATION");
      const key = `sv:${project.id}:${detail.version}:to-architecture`;
      advanceClock();
      const first = store.executeCommand({ uid: owner, projectId: project.id, key, expectedVersion: detail.version, type: "transition", payload: { toState: "ARCHITECTURE" }, actor: "supervisor" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.project.state, "ARCHITECTURE");
      const versionAfterFirst = first.body.project.version;

      // Simulate a crash after the store committed but before the supervisor recorded success: the
      // exact same deterministic key, replayed with the exact same payload and expectedVersion.
      advanceClock();
      const second = store.executeCommand({ uid: owner, projectId: project.id, key, expectedVersion: detail.version, type: "transition", payload: { toState: "ARCHITECTURE" }, actor: "supervisor" });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.replayed, true);
      assert.equal(store.getProject(owner, project.id).version, versionAfterFirst, "a replayed command must not mutate the project a second time");
    });

    await test("two ticks issued back to back share one in-flight pass instead of racing", async () => {
      advanceClock();
      const [a, b] = await Promise.all([supervisor.tick(), supervisor.tick()]);
      assert.equal(a, b, "a second tick() call issued before the first resolves must return the very same in-flight result");
    });
  }

  // ---- 7: pause/resume -------------------------------------------------------------------------
  {
    const project = bySlug("shelf-shift");
    qa.setMode("pass");
    await test("a RUNNING task holds the supervisor back; a paused game is never acted on; resume continues", async () => {
      await supervisor.runToPlaytest({ projectId: project.id, key: nextKey("run"), expectedVersion: project.version });
      await tickUntil(project.id, (d) => d.state === "ARCHITECTURE");
      await tickUntil(project.id, (d) => d.evidence.visualSystemApproved === true);
      await tickUntil(project.id, (d) => (d.tasks || []).some((t) => t.capability === "product_planning" && t.status === "QUEUED"));

      advanceClock();
      const claimed = store.claimNextTask({ workerId: "test-forge", capability: "product_planning", leaseMs: 60_000 });
      assert.ok(claimed);
      const beforePause = store.getProject(owner, project.id);
      await tick();
      assert.equal(store.getProject(owner, project.id).version, beforePause.version, "a RUNNING task must hold the supervisor back entirely");

      advanceClock();
      const pauseResponse = store.executeCommand({ uid: owner, projectId: project.id, key: nextKey("pause"), expectedVersion: beforePause.version, type: "pause", payload: {}, actor: "owner-test" });
      assert.equal(pauseResponse.status, 202, "waiting for the safe boundary: the task is still RUNNING");
      await tick();
      assert.equal(store.getProject(owner, project.id).state, "ARCHITECTURE", "not paused yet: the task has not reached its safe boundary");

      advanceClock();
      const completeResponse = store.completeTask({ uid: owner, taskId: claimed.id, workerId: "test-forge", attempt: claimed.attempt, result: AUTO_FORGE.product_planning() });
      assert.equal(completeResponse.status, 200);
      assert.equal(store.getProject(owner, project.id).state, "PAUSED");
      await tick();
      assert.equal(store.getProject(owner, project.id).state, "PAUSED", "a held game is never acted on");

      advanceClock();
      const resumeDetail = store.getProject(owner, project.id);
      const resumeResponse = store.executeCommand({ uid: owner, projectId: project.id, key: nextKey("resume"), expectedVersion: resumeDetail.version, type: "resume", payload: {}, actor: "owner-test" });
      assert.equal(resumeResponse.status, 200, JSON.stringify(resumeResponse.body));
      assert.equal(resumeResponse.body.project.state, "ARCHITECTURE");

      const final = await tickUntil(project.id, (d) => d.state === "ASSET_GENERATION");
      assert.equal(final.state, "ASSET_GENERATION");
    });
  }

  // ---- integration review (Fable, 2026-09-03): the forge exhausted every model, the store marked the
  // game FAILED, the owner pressed Retry. The build exists, its only gameplay task is FAILED, and
  // nothing else is queued. The supervisor must put work back on that build, not sit there. ----------
  {
    const project = store.listProjects(owner).find((p) => p.state === "IDEA");
    assert.ok(project, "a game still at IDEA is needed for the retry scenario");

    await test("after a non-retryable forge failure and an owner Retry, the supervisor re-queues gameplay work on the same build", async () => {
      const started = await supervisor.runToPlaytest({ projectId: project.id, key: nextKey("run-retry"), expectedVersion: project.version });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const planningOnly = { product_planning: AUTO_FORGE.product_planning, visual_design: AUTO_FORGE.visual_design };
      const atBuild = await tickUntil(project.id, (d) => d.state === "IMPLEMENTATION" && !!d.activeBuild && (d.tasks || []).some((t) => t.capability === "gameplay_engineering" && t.status === "QUEUED"), { autoComplete: planningOnly });
      const buildId = atBuild.activeBuild.id;
      assert.equal(store.listBuilds(owner, project.id).length, 1);

      // The forge claims the implement task and gives up honestly (every model rung failed). The queue
      // is tenant-wide, so a stale QUEUED gameplay task left behind by an earlier scenario on another
      // game may come first; park those as FAILED (a held game the supervisor never touches) until
      // this game's own task is claimed.
      let claimed = null;
      for (let i = 0; i < 10 && !claimed; i++) {
        advanceClock();
        const next = store.claimNextTask({ workerId: "test-forge", capability: "gameplay_engineering", leaseMs: 60_000 });
        assert.ok(next, "expected a queued gameplay task to claim");
        if (next.projectId === project.id) claimed = next;
        else store.failTask({ uid: owner, taskId: next.id, workerId: "test-forge", attempt: next.attempt, error: "parked by the retry scenario", retryable: false });
      }
      assert.ok(claimed && claimed.buildId === buildId, "claimed this game's task on its active build");
      advanceClock();
      const failed = store.failTask({ uid: owner, taskId: claimed.id, workerId: "test-forge", attempt: claimed.attempt, error: "No model produced a game that passes the local checks after 4 rounds on 3 models; last failures: core-loop", retryable: false });
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      let detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "FAILED");
      assert.match(detail.blocker, /No model produced a game/);

      // A held game is never acted on.
      await tick();
      detail = store.getProject(owner, project.id);
      assert.equal(detail.state, "FAILED");
      assert.equal((detail.tasks || []).filter((t) => t.status === "QUEUED").length, 0);

      // Owner: Retry.
      advanceClock();
      const retried = store.executeCommand({ uid: owner, projectId: project.id, key: nextKey("retry-forge"), expectedVersion: detail.version, type: "retry", payload: {}, actor: "owner-test" });
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(retried.body.project.state, "IMPLEMENTATION");

      await tick();
      detail = store.getProject(owner, project.id);
      const requeued = (detail.tasks || []).find((t) => t.capability === "gameplay_engineering" && t.status === "QUEUED");
      assert.ok(requeued, "a fresh gameplay task must be queued after Retry; tasks: " + JSON.stringify((detail.tasks || []).map((t) => t.capability + ":" + t.status)));
      assert.equal(requeued.buildId, buildId, "the work goes back onto the SAME build");
      assert.equal(requeued.payload.kind, "repair");
      assert.match(String(requeued.payload.reason || ""), /previous build attempt failed/i);
      assert.equal(store.listBuilds(owner, project.id).length, 1, "no second build for the same lineage");

      // With the forge succeeding this time, the game reaches PLAYTEST_READY.
      const done = await tickUntil(project.id, (d) => d.state === "PLAYTEST_READY");
      assert.equal(done.activeBuild.id, buildId);
    });
  }

  await test("health reports enabled, an action count, and per-project state", async () => {
    const h = supervisor.health();
    assert.equal(h.enabled, true);
    assert.ok(h.actions > 0);
    assert.ok(Array.isArray(h.projects) && h.projects.length >= 6);
    assert.ok(h.lastTickAt > 0);
  });

  console.log(`\n${n} game factory supervisor tests passed`);
} finally {
  await supervisor.close();
  try { store.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
