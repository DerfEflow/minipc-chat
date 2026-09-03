/*
 * SD Tech Mobile Game Factory — stage supervisor.
 *
 * Approvals become work, and durable evidence becomes progress. This module implements the rules
 * table in specs/GAME-FACTORY-BUILD.md section 3, literally and idempotently: it queues the one task
 * a game's current stage needs, creates builds, records QA results, and drives every lifecycle
 * transition through the store's own `transition`/`approve`/`block` commands so every gate in
 * `transitionDecision` (gamefactory.mjs) still applies. It never bypasses a gate and never fabricates
 * evidence — QA results come only from the injected `qaRunner`, approvals only from an owner decision
 * (`runToPlaytest`'s advance approvals or a human's own approve/reject) or the autopilot VISUAL_SYSTEM
 * rule below, and blocks always carry the exact failing sentence.
 *
 * Durable per-project state that does not belong in the SQLite store (autopilot on/off, a pending
 * revision reason, the repair budget) lives in a small JSON sidecar file, written atomically so a
 * crash mid-write cannot corrupt it. Every lifecycle mutation goes through `store.executeCommand`
 * with a deterministic idempotency key `sv:<projectId>:<version>:<intent>`, so a crash between
 * deciding an action and committing it replays the same command instead of double-applying it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOLD_STATES } from "./gamefactory.mjs";

const clean = (value, max = 1000) => String(value == null ? "" : value).trim().slice(0, max);
// Redaction mirrors gamefactorystore.mjs / gamefactoryworker.mjs: task results and store errors are
// our own data, not raw provider output, but AGENT-RULES forbids ever printing a secret-shaped value,
// so every logged string still goes through this filter.
const SECRET_NAME = /(authorization|cookie|credential|password|passwd|private.?key|recovery.?code|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret|(^|[_-])pat($|[_-]))/i;
function redact(value, max = 4000) {
  return String(value == null ? "" : value).slice(0, max)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, "[redacted-private-key]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, "[redacted-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(access_?token|api_?key|password|passwd|private_?key|secret|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
function safeText(value, max = 1000) {
  if (SECRET_NAME.test(String(value || "").slice(0, 40))) return "[redacted]";
  return redact(value, max).trim();
}

export const RUN_TO_PLAYTEST_RATIONALE = "Owner chose Run to playtest: planning gates are approved by the owner in advance.";

// ---- durable per-project sidecar ---------------------------------------------------------------

function sidecarPath(dataDir, projectId) {
  return join(dataDir, "game-factory", "supervisor", `${clean(projectId, 180)}.json`);
}
function defaultSidecar() {
  return { autopilot: false, pendingRevision: null, repairs: {}, lineageId: "", lastTickAt: 0, notes: [] };
}
function loadSidecar(dataDir, projectId) {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(dataDir, projectId), "utf8"));
    return { ...defaultSidecar(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch { return defaultSidecar(); }
}
function saveSidecar(dataDir, projectId, sidecar) {
  const file = sidecarPath(dataDir, projectId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(sidecar), "utf8");
  renameSync(tmp, file);
}

// ---- small pure helpers over a getProject() detail object --------------------------------------

function specDesignVersion(detail) {
  const subject = detail.approvalSubjects?.SPECIFICATION;
  return subject?.ready ? subject.hash : "";
}
// detail.tasks is already ordered newest-first (gamefactorystore.mjs q.tasks: "ORDER BY createdAt DESC"),
// so the first match is the latest task for that capability/predicate.
function latestTask(detail, capability, predicate) {
  return (detail.tasks || []).find((task) => task.capability === capability && predicate(task)) || null;
}
function latestTestBySuite(detail, buildId) {
  const byBuild = (detail.tests || []).filter((row) => row.buildId === buildId);
  const latest = new Map();
  for (const row of byBuild) if (!latest.has(row.suite)) latest.set(row.suite, row); // detail.tests is DESC by createdAt
  return latest;
}

export function createGameFactorySupervisor({
  store, planner, qaRunner, kit, dataDir,
  ownerUid = "owner", ownerEmail = "", maxRepairs = 3, pollMs = 10_000,
  log = () => {}, now = () => Date.now(),
} = {}) {
  if (!store || typeof store.getProject !== "function" || typeof store.executeCommand !== "function"
      || typeof store.listBuilds !== "function" || typeof store.updateBuildStatus !== "function") {
    throw new Error("createGameFactorySupervisor needs a game factory store (with the additive updateBuildStatus/listBuilds exports)");
  }
  if (!planner || typeof planner.startSpecification !== "function") throw new Error("createGameFactorySupervisor needs the game factory planner");
  if (!qaRunner || typeof qaRunner.run !== "function") throw new Error("createGameFactorySupervisor needs the server QA runner");
  if (!kit || typeof kit.verifyBundle !== "function" || !Array.isArray(kit.QA_SUITES) || kit.QA_SUITES.length !== 12) {
    throw new Error("createGameFactorySupervisor needs the game kit (verifyBundle, QA_SUITES)");
  }
  if (!dataDir) throw new Error("createGameFactorySupervisor needs a dataDir");
  const uid = clean(ownerUid, 80).toLowerCase() || "owner";
  const budget = Math.min(Math.max(Number(maxRepairs) || 3, 1), 20);

  let timer = null, ticking = null, closed = false;
  let lastTickAt = 0, lastError = "", actionCount = 0, lastProjects = [];
  const lastActionByProject = new Map();

  function recordAction(detail, action, why) {
    lastActionByProject.set(detail.id, action);
    log(`[game-factory] supervisor ${detail.slug}: ${detail.state} -> ${action} (${why})`);
  }

  // Every lifecycle-gated mutation shares this key scheme so a retry after a crash between "decide"
  // and "commit" replays the exact same store command instead of re-deciding and double-applying.
  const intentKey = (detail, intent) => `sv:${detail.id}:${detail.version}:${clean(intent, 120)}`;

  function doTransition(detail, toState, intent, why) {
    const response = store.executeCommand({
      uid, projectId: detail.id, key: intentKey(detail, intent), expectedVersion: detail.version,
      type: "transition", payload: { toState }, actor: "supervisor",
    });
    const ok = response.status < 300;
    recordAction(detail, ok ? toState : `${toState} FAILED (${safeText(response.body?.error, 200)})`, why);
    return { acted: ok, response };
  }

  function doApprove(detail, gate, subjectHash, rationale, intent, why) {
    const response = store.executeCommand({
      uid, projectId: detail.id, key: intentKey(detail, intent), expectedVersion: detail.version,
      type: "approve", payload: { gate, subjectHash, rationale }, actor: "supervisor",
    });
    const ok = response.status < 300;
    recordAction(detail, ok ? `approve ${gate}` : `approve ${gate} FAILED (${safeText(response.body?.error, 200)})`, why);
    return { acted: ok, response };
  }

  function doBlock(detail, reason) {
    const response = store.executeCommand({
      uid, projectId: detail.id, key: intentKey(detail, "block"), expectedVersion: detail.version,
      type: "block", payload: { reason }, actor: "supervisor",
    });
    recordAction(detail, "BLOCKED", reason);
    return { acted: response.status < 300, response };
  }

  function doQueueTask(detail, { capability, kind, designVersion }, why) {
    const response = store.queueTask({
      uid, projectId: detail.id, buildId: "", capability, title: kind,
      payload: { kind, designVersion },
      acceptance: [`Produce durable ${kind} evidence for design version ${designVersion}.`],
      priority: 0, safeToRetry: false, maxAttempts: 3,
    });
    const ok = response.status < 300;
    recordAction(detail, ok ? `queue ${capability}:${kind}` : `queue ${capability}:${kind} FAILED (${safeText(response.body?.error, 200)})`, why);
    return { acted: ok, response };
  }

  function doCreateBuildAndQueue(detail, sidecar, kind) {
    const versionCount = store.listBuilds(uid, detail.id).length + 1;
    const buildResponse = store.createBuild({
      uid, projectId: detail.id, sourceCommit: "", toolchain: { lane: "web-canvas" }, targets: ["web"],
      versionName: `0.1.${versionCount}`, versionCode: versionCount,
    });
    if (buildResponse.status >= 300) {
      recordAction(detail, `build FAILED (${safeText(buildResponse.body?.error, 200)})`, kind);
      return { acted: false, response: buildResponse };
    }
    const buildId = buildResponse.body.buildId;
    // "revise" always starts a fresh lineage (the repair budget resets); "repair" stays in the
    // lineage it belongs to so its count keeps incrementing; "implement" starts the very first one.
    if (kind !== "repair" || !sidecar.lineageId) sidecar.lineageId = buildId;
    const designVersion = specDesignVersion(detail);
    const pending = sidecar.pendingRevision || {};
    const queueResponse = store.queueTask({
      uid, projectId: detail.id, buildId, capability: "gameplay_engineering", title: kind,
      payload: { kind, buildId, reason: pending.reason || "", failures: pending.failures || [], designVersion },
      acceptance: ["Bundle assembles completely and passes local validation (syntax, imports, fixtures) before completion."],
      maxAttempts: 1, safeToRetry: false,
    });
    sidecar.pendingRevision = null;
    saveSidecar(dataDir, detail.id, sidecar);
    const ok = queueResponse.status < 300;
    recordAction(detail, ok ? `build ${buildId} created, queue gameplay_engineering:${kind}` : `queue gameplay_engineering:${kind} FAILED (${safeText(queueResponse.body?.error, 200)})`, kind);
    return { acted: ok, response: queueResponse };
  }

  // ---- per-state rules (specs/GAME-FACTORY-BUILD.md section 3, top to bottom) -------------------

  function handleSpecification(detail, sidecar) {
    // Not a literal row in the master table (which only lists the transition), but required by this
    // lane's runToPlaytest contract: when the owner ran "Run to playtest" before the specification's
    // mirror finished, the inline approval attempt is deferred here so autopilot can record it once
    // the subject becomes ready, mirroring the ARCHITECTURE/VISUAL_SYSTEM autopilot rule below.
    if (detail.evidence?.specificationApproved) return doTransition(detail, "ARCHITECTURE", "to-architecture", "specification approved");
    const subject = detail.approvalSubjects?.SPECIFICATION;
    if (sidecar.autopilot && subject?.ready) {
      return doApprove(detail, "SPECIFICATION", subject.hash, RUN_TO_PLAYTEST_RATIONALE, "approve-specification", "autopilot: run to playtest pre-approves planning gates");
    }
    return { acted: false };
  }

  function handleArchitecture(detail, sidecar) {
    const visualSubject = detail.approvalSubjects?.VISUAL_SYSTEM;
    if (sidecar.autopilot && visualSubject?.ready && !detail.evidence?.visualSystemApproved) {
      return doApprove(detail, "VISUAL_SYSTEM", visualSubject.hash, RUN_TO_PLAYTEST_RATIONALE, "approve-visual-system", "autopilot: run to playtest pre-approves planning gates");
    }
    const designVersion = specDesignVersion(detail);
    if (!designVersion) return { acted: false };
    const completedDesign = latestTask(detail, "product_planning", (task) => task.payload?.kind === "design" && task.payload?.designVersion === designVersion && task.status === "COMPLETED");
    if (!completedDesign) return doQueueTask(detail, { capability: "product_planning", kind: "design", designVersion }, "no completed product_planning task for this design version");
    if (detail.evidence?.visualSystemApproved) return doTransition(detail, "ASSET_GENERATION", "to-asset-generation", "design complete and visual system approved");
    return { acted: false };
  }

  function handleAssetGeneration(detail) {
    const designVersion = specDesignVersion(detail);
    if (!designVersion) return { acted: false };
    const completedAssets = latestTask(detail, "visual_design", (task) => task.payload?.kind === "assets" && task.payload?.designVersion === designVersion && task.status === "COMPLETED");
    if (!completedAssets) return doQueueTask(detail, { capability: "visual_design", kind: "assets", designVersion }, "no completed visual_design task for this design version");
    return doTransition(detail, "IMPLEMENTATION", "to-implementation", "assets complete");
  }

  function handleImplementation(detail, sidecar) {
    const activeBuildId = detail.activeBuild?.id || "";
    const gameplayTask = activeBuildId ? latestTask(detail, "gameplay_engineering", (task) => task.buildId === activeBuildId) : null;
    const completedGameplay = gameplayTask && gameplayTask.status === "COMPLETED" ? gameplayTask : null;
    const needsNewBuild = !activeBuildId || (completedGameplay && sidecar.pendingRevision);
    if (needsNewBuild) {
      const kind = sidecar.pendingRevision?.kind === "revise" ? "revise" : sidecar.pendingRevision?.kind === "repair" ? "repair" : "implement";
      return doCreateBuildAndQueue(detail, sidecar, kind);
    }
    if (completedGameplay && clean(completedGameplay.result?.bundleSha256, 128)) {
      return doTransition(detail, "INTEGRATION", "to-integration", "build task completed with a bundle fingerprint");
    }
    return { acted: false };
  }

  function handleIntegration(detail, sidecar) {
    const activeBuildId = detail.activeBuild?.id || "";
    if (!activeBuildId) return { acted: false };
    const bundleDir = join(dataDir, "game-factory", "builds", activeBuildId, "bundle");
    let verification;
    try { verification = kit.verifyBundle(bundleDir); }
    catch (error) { verification = { ok: false, problems: [safeText(error?.message || error, 500) || "bundle verification threw"] }; }
    if (verification.ok) {
      store.updateBuildStatus({ uid, projectId: detail.id, buildId: activeBuildId, status: "BUILT" });
      return doTransition(detail, "AUTOMATED_TESTING", "to-automated-testing", "bundle verified against build.json");
    }
    sidecar.pendingRevision = { kind: "repair", reason: "Bundle verification failed.", failures: verification.problems || [], buildId: activeBuildId, at: Number(now()) || Date.now() };
    saveSidecar(dataDir, detail.id, sidecar);
    return doTransition(detail, "REVISION", "to-revision-bundle-failed", `bundle verification failed: ${(verification.problems || []).slice(0, 3).join("; ")}`);
  }

  async function handleAutomatedTesting(detail, sidecar) {
    const activeBuildId = detail.activeBuild?.id || "";
    if (!activeBuildId) return { acted: false };
    const testsForBuild = (detail.tests || []).filter((row) => row.buildId === activeBuildId);
    if (testsForBuild.length === 0) {
      const gameplayTask = latestTask(detail, "gameplay_engineering", (task) => task.buildId === activeBuildId && task.status === "COMPLETED");
      const sourceHash = clean(gameplayTask?.result?.bundleSha256, 128);
      const bundleDir = join(dataDir, "game-factory", "builds", activeBuildId, "bundle");
      const resultsDir = join(dataDir, "game-factory", "builds", activeBuildId, "qa");
      let outcome;
      try { outcome = await qaRunner.run({ bundleDir, resultsDir }); }
      catch (error) { outcome = { ok: false, results: { suites: {} }, error: safeText(error?.message || error, 500) }; }
      const suites = outcome?.results?.suites || {};
      let passed = 0;
      for (const suite of kit.QA_SUITES) {
        const entry = suites[suite] || { status: "FAILED", summary: "the harness did not report this suite (runner produced no result)" };
        const status = entry.status === "PASSED" ? "PASSED" : "FAILED";
        if (status === "PASSED") passed++;
        store.recordTestRun({
          uid, projectId: detail.id, buildId: activeBuildId, suite, target: "server-qa", status, sourceHash,
          evidence: { summary: clean(entry.summary, 2000) || "no summary reported", failures: (entry.failures || []).slice(0, 20) },
          metrics: entry.metrics && typeof entry.metrics === "object" ? entry.metrics : {},
        });
      }
      recordAction(detail, "record QA results", `${passed}/${kit.QA_SUITES.length} suites passed for build ${activeBuildId}`);
      return { acted: true };
    }
    const latestBySuite = latestTestBySuite(detail, activeBuildId);
    const failingSuites = kit.QA_SUITES.filter((suite) => latestBySuite.get(suite)?.status !== "PASSED");
    if (failingSuites.length === 0) return doTransition(detail, "PLAYTEST_READY", "to-playtest-ready", "all 12 required QA suites passed");
    const lineageId = sidecar.lineageId || activeBuildId;
    const repairsUsed = Number(sidecar.repairs?.[lineageId]) || 0;
    if (repairsUsed < budget) {
      sidecar.pendingRevision = { kind: "repair", reason: `QA failed: ${failingSuites.join(", ")}`, failures: failingSuites, buildId: activeBuildId, at: Number(now()) || Date.now() };
      sidecar.repairs = { ...(sidecar.repairs || {}), [lineageId]: repairsUsed + 1 };
      saveSidecar(dataDir, detail.id, sidecar);
      return doTransition(detail, "REVISION", "to-revision-qa-repair", `QA failing (${failingSuites.join(", ")}), repair ${repairsUsed + 1}/${budget}`);
    }
    const summary = failingSuites.map((suite) => `${suite}: ${clean(latestBySuite.get(suite)?.evidence?.summary, 200) || latestBySuite.get(suite)?.status || "missing"}`).join("; ");
    return doBlock(detail, `QA failed after ${repairsUsed} repair builds: ${summary}`);
  }

  function deriveRevision(detail) {
    const rejected = (detail.approvals || [])
      .filter((approval) => approval.decision === "REJECTED" && approval.invalidatedAt === 0)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (rejected) {
      return { kind: "revise", reason: clean(rejected.rationale, 2000) || `${rejected.gate} was rejected.`, failures: [], buildId: detail.activeBuild?.id || "", at: Number(now()) || Date.now() };
    }
    // detail.events (getProject's own event window) is oldest-first and capped; we page the store's
    // own event log directly here (also oldest-first) so a long-lived project's most recent
    // revision_requested event is still found. TODO(fable): a project with more than 500 durable
    // events since its last owner-initiated revision would need a "most recent event" store query
    // this lane is not authorized to add (LANE-gfsupervisor.md permits only updateBuildStatus/listBuilds).
    const events = typeof store.events === "function" ? store.events(uid, detail.id, 0, 500) : [];
    const revisionEvents = events.filter((event) => event.type === "project.revision_requested");
    const latestRevisionEvent = revisionEvents[revisionEvents.length - 1];
    if (latestRevisionEvent) {
      return { kind: "revise", reason: clean(latestRevisionEvent.payload?.reason, 2000) || "Revision requested.", failures: [], buildId: detail.activeBuild?.id || "", at: Number(now()) || Date.now() };
    }
    const activeBuildId = detail.activeBuild?.id || "";
    const latestBySuite = latestTestBySuite(detail, activeBuildId);
    const failing = kit.QA_SUITES.filter((suite) => latestBySuite.get(suite)?.status !== "PASSED");
    return { kind: "repair", reason: failing.length ? `QA failing: ${failing.join(", ")}` : "Prior evidence was invalidated.", failures: failing, buildId: activeBuildId, at: Number(now()) || Date.now() };
  }

  function handleRevision(detail, sidecar) {
    if (!sidecar.pendingRevision) {
      sidecar.pendingRevision = deriveRevision(detail);
      saveSidecar(dataDir, detail.id, sidecar);
    }
    return doTransition(detail, "IMPLEMENTATION", "to-implementation-revision", `revision: ${sidecar.pendingRevision.kind} (${clean(sidecar.pendingRevision.reason, 200)})`);
  }

  function handlePlaytestReady(detail) {
    if (detail.evidence?.playtestApproved) return doTransition(detail, "RELEASE_CANDIDATE", "to-release-candidate", "owner playtest approval recorded for this build");
    return { acted: false };
  }
  function handleReleaseCandidate(detail) {
    if (detail.evidence?.releaseCandidateApproved && detail.evidence?.qaReady) return doTransition(detail, "APPROVED", "to-approved", "release-candidate approval recorded and QA ready");
    return { acted: false };
  }

  async function handleProject(detail, sidecar) {
    switch (detail.state) {
      case "IDEA": return { acted: false }; // Run to playtest already started the plan; nothing to do here.
      case "SPECIFICATION": return handleSpecification(detail, sidecar);
      case "ARCHITECTURE": return handleArchitecture(detail, sidecar);
      case "ASSET_GENERATION": return handleAssetGeneration(detail);
      case "IMPLEMENTATION": return handleImplementation(detail, sidecar);
      case "INTEGRATION": return handleIntegration(detail, sidecar);
      case "AUTOMATED_TESTING": return handleAutomatedTesting(detail, sidecar);
      case "REVISION": return handleRevision(detail, sidecar);
      case "PLAYTEST_READY": return handlePlaytestReady(detail);
      case "RELEASE_CANDIDATE": return handleReleaseCandidate(detail);
      default: return { acted: false }; // APPROVED, STORE_PREP: human-gated by design; store release writes are off.
    }
  }

  // Skip a game entirely when it is on hold/deployed, mid owner-operation, or already has a task
  // in flight; the rules above are consulted fresh (never a second time) once one of those clears.
  function blockedByGuard(detail) {
    if (HOLD_STATES.has(detail.state) || detail.state === "DEPLOYED") return true;
    if (detail.operation) return true;
    return (detail.tasks || []).some((task) => task.status === "QUEUED" || task.status === "RUNNING");
  }

  async function runTick() {
    lastTickAt = Number(now()) || Date.now();
    const summary = [];
    let projects;
    try { projects = store.listProjects(uid); }
    catch (error) { lastError = safeText(error?.message || error, 1000) || "listProjects failed"; return summary; }
    for (const row of projects) {
      let detail;
      try { detail = store.getProject(uid, row.id, { eventLimit: 500 }); }
      catch (error) { lastError = safeText(error?.message || error, 1000) || "getProject failed"; continue; }
      if (!detail) continue;
      if (!blockedByGuard(detail)) {
        const sidecar = loadSidecar(dataDir, detail.id);
        try {
          const outcome = await handleProject(detail, sidecar);
          if (outcome?.acted) actionCount++;
        } catch (error) {
          lastError = safeText(error?.message || error, 2000) || "supervisor tick failed for a project";
          log(`[game-factory] supervisor ${detail.slug}: tick error (${lastError})`);
        }
      }
      const after = store.getProject(uid, row.id) || detail;
      summary.push({ id: detail.id, slug: detail.slug, state: after.state, lastAction: lastActionByProject.get(detail.id) || null });
    }
    lastProjects = summary;
    return summary;
  }

  function tick() {
    if (ticking) return ticking;
    ticking = runTick().finally(() => { ticking = null; });
    return ticking;
  }

  async function start() {
    if (closed) throw new Error("supervisor is closed");
    const first = await tick();
    if (!timer) {
      timer = setInterval(() => { tick().catch((error) => { lastError = safeText(error?.message || error, 1000); }); }, Math.max(Number(pollMs) || 10_000, 1_000));
      if (typeof timer.unref === "function") timer.unref();
    }
    return first;
  }
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (ticking) await ticking.catch(() => {});
  }
  async function close() {
    await stop();
    closed = true;
  }

  function health() {
    return { enabled: true, lastTickAt, lastError, actions: actionCount, projects: lastProjects };
  }

  function setAutopilot(projectId, on) {
    const sidecar = loadSidecar(dataDir, projectId);
    sidecar.autopilot = !!on;
    saveSidecar(dataDir, projectId, sidecar);
    return sidecar.autopilot;
  }
  function getAutopilot(projectId) {
    return loadSidecar(dataDir, projectId).autopilot;
  }

  // D6: one tap to a playable build. Starts the plan and records the owner's advance approval of the
  // SPECIFICATION gate (the VISUAL_SYSTEM gate follows the same rationale once ARCHITECTURE begins,
  // via the autopilot rule in handleArchitecture/handleSpecification above). Playtest approval is
  // never automatic — the owner still previews the exact build and approves it or requests changes.
  async function runToPlaytest({ uid: callerUid = uid, projectId, key, expectedVersion, actor = "owner", tenant = null } = {}) {
    const started = await planner.startSpecification({ uid: callerUid, email: ownerEmail, projectId, key, expectedVersion, actor, tenant });
    if (!started || started.status >= 300) return started || { status: 500, body: { error: "The specification start produced no response.", code: "specification_start_failed" } };
    let detail = store.getProject(callerUid, projectId, { eventLimit: 500 });
    if (!detail) return { status: 500, body: { error: "The game disappeared while its specification was starting.", code: "project_lost" } };
    const subject = detail.approvalSubjects?.SPECIFICATION;
    if (subject?.ready) {
      const approveResponse = store.executeCommand({
        uid: callerUid, projectId, key: `${clean(key, 140)}:approve-spec`, expectedVersion: detail.version,
        type: "approve", payload: { gate: "SPECIFICATION", subjectHash: subject.hash, rationale: RUN_TO_PLAYTEST_RATIONALE }, actor,
      });
      if (approveResponse.status >= 300) {
        // Non-fatal: a version race or a not-yet-ready subject just means the tick loop (with
        // autopilot now on) records this approval on its next pass instead of inline here.
        log(`[game-factory] supervisor ${projectId}: run-to-playtest inline SPECIFICATION approval deferred to tick (${safeText(approveResponse.body?.error, 300)})`);
      } else {
        detail = store.getProject(callerUid, projectId, { eventLimit: 500 }) || detail;
      }
    }
    setAutopilot(projectId, true);
    return { status: 200, body: { ok: true, autopilot: true, project: detail } };
  }

  return { start, stop, close, tick, health, setAutopilot, getAutopilot, runToPlaytest };
}
