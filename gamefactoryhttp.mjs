/* SD Tech Mobile Game Factory — authenticated HTTP and durable SSE transport. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { TextDecoder } from "node:util";
import { GAME_STATES, REQUIRED_GAME_ARTIFACTS, MANDATORY_ARTIFACT_BACKENDS, DEFERRED_ARTIFACT_BACKENDS, QA_REQUIRED_SUITES, APPROVAL_GATES, HOLD_STATES, allowedTransitions, stateProgress } from "./gamefactory.mjs";
import { startSseHeartbeat } from "./sseheartbeat.mjs";

const MAX_BODY = 1024 * 1024;
const MAX_ARTIFACT_CONTENT_BYTES = 512 * 1024;
const REVIEWABLE_ARTIFACT_MIMES = new Set(["text/markdown", "text/plain"]);
const ARTIFACT_CONTENT_ROUTE = /^\/api\/game-factory\/games\/([^/]+)\/artifacts\/([^/]+)\/content$/;
const SYNTHETIC_CANARY_ROUTE = "/api/game-factory/admin/synthetic-canary";
const SYNTHETIC_CANARY_ACTION = "game-factory-synthetic-canary";
// Native preview (D5): GET .../builds/:buildId/play or .../play/<relPath inside the bundle>.
// The trailing `path.replace(/\/$/, "")` in handle() means a bare "/play/" arrives here as "/play".
const PLAY_ROUTE = /^\/api\/game-factory\/games\/([^/]+)\/builds\/([^/]+)\/play(\/.*)?$/;
const PLAY_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; worker-src 'self'; frame-ancestors 'self'";
const PLAY_MIME_BY_EXT = Object.freeze({
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", webmanifest: "application/manifest+json", css: "text/css; charset=utf-8",
  png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", txt: "text/plain; charset=utf-8",
});
const PREVIEWABLE_BUILD_STATES = Object.freeze(["IMPLEMENTATION", "INTEGRATION", "AUTOMATED_TESTING", "PLAYTEST_READY", "REVISION", "RELEASE_CANDIDATE", "APPROVED", "STORE_PREP", "DEPLOYED"]);

export function verifiedHumanFactoryOwner(req, tenant, mode = "") {
  const identity = req && req.dominionIdentity && typeof req.dominionIdentity === "object" ? req.dominionIdentity : {};
  const identityEmail = String(identity.email || "").trim().toLowerCase();
  const tenantEmail = String(tenant && tenant.email || "").trim().toLowerCase();
  return String(mode || "").trim().toLowerCase() === "owner"
    && tenant?.isOwner === true
    && identity.source === "jwt"
    && identity.verified === true
    && !!identityEmail
    && identityEmail === tenantEmail;
}

async function bodyJson(req, maxBytes = MAX_BODY) {
  let bytes = 0, text = "";
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) return { __bodyError: true, error: "request body too large", code: "body_too_large", status: 413 };
    text += chunk.toString("utf8");
  }
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { __bodyError: true, error: "request body must be a JSON object", code: "bad_json_shape", status: 400 };
    return value;
  }
  catch { return { __bodyError: true, error: "request body must be valid JSON", code: "bad_json", status: 400 }; }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

const one = (value, max = 200) => String(value || "").trim().slice(0, max);

const GATE_LABELS = Object.freeze({
  SPECIFICATION: "the current brief and market case",
  VISUAL_SYSTEM: "the current visual system",
  PLAYTEST: "the current tested build",
  RELEASE_CANDIDATE: "the current release candidate",
  LEGAL_AND_PRIVACY: "the synchronized legal, privacy, monetization and release package",
  STORE_SUBMISSION: "the current iOS and Android store packages",
  PRODUCTION_RELEASE: "the submitted iOS and Android release",
});

function currentRows(rows, buildId, key) {
  const latest = new Map();
  for (const row of rows || []) {
    if (!buildId || row.buildId !== buildId) continue;
    const id = String(row[key] || "");
    if (id && !latest.has(id)) latest.set(id, row);
  }
  return latest;
}

function durableProgress(detail) {
  return HOLD_STATES.has(detail?.state) && detail?.resumeState ? stateProgress(detail.resumeState) : Number(detail?.progress) || 0;
}

function candidateOwnerGate(detail) {
  if (!detail) return "";
  if (detail.state === "SPECIFICATION" && !detail.evidence?.specificationApproved) return "SPECIFICATION";
  if (detail.state === "ARCHITECTURE" && !detail.evidence?.visualSystemApproved) return "VISUAL_SYSTEM";
  if (detail.state === "PLAYTEST_READY" && !detail.evidence?.playtestApproved) return "PLAYTEST";
  if (detail.state === "RELEASE_CANDIDATE" && !detail.evidence?.releaseCandidateApproved) return "RELEASE_CANDIDATE";
  if (detail.state === "APPROVED" && !detail.evidence?.legalAndPrivacyApproved) return "LEGAL_AND_PRIVACY";
  if (detail.state === "STORE_PREP" && !detail.evidence?.storeSubmissionApproved) return "STORE_SUBMISSION";
  if (detail.state === "STORE_PREP" && !detail.evidence?.productionReleaseApproved) return "PRODUCTION_RELEASE";
  return "";
}

function ownerGateBlocker(detail, gate) {
  const subject = detail.approvalSubjects?.[gate];
  if (!subject?.ready) return one(subject?.error, 1000) || `${humanGate(gate)} evidence is not ready for an owner decision.`;
  if (["PLAYTEST", "RELEASE_CANDIDATE"].includes(gate) && !detail.evidence?.qaReady) {
    const count = Array.isArray(detail.evidence?.qaMissing) ? detail.evidence.qaMissing.length : QA_REQUIRED_SUITES.length;
    return `${humanGate(gate)} is unavailable until all required QA suites pass for this build${count ? ` (${count} still missing or failing)` : ""}.`;
  }
  return "";
}

function humanGate(gate) {
  return String(gate || "approval").toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function approvalSubject(detail, gate) {
  const subject = detail?.approvalSubjects?.[gate];
  if (!subject?.ready || !/^[a-f0-9]{64}$/.test(String(subject.hash || ""))) return null;
  return {
    hash: subject.hash,
    label: GATE_LABELS[gate] || `the current ${humanGate(gate).toLowerCase()} evidence`,
    buildId: detail.activeBuild?.id || "",
  };
}

function ownerGateStatus(detail) {
  const gate = candidateOwnerGate(detail);
  if (!gate) return { gate: "", ready: false, blocker: "", subject: null };
  let blocker = ownerGateBlocker(detail, gate);
  const subject = blocker ? null : approvalSubject(detail, gate);
  if (!blocker && !subject) blocker = `${humanGate(gate)} evidence has no valid immutable fingerprint.`;
  return { gate, ready: !blocker, blocker, subject: blocker ? null : subject };
}

function allowedActions(detail, { builds, uid } = {}) {
  if (!detail) return [];
  const out = [{ id: "attach_workspace", label: detail.workspaceId || detail.workspaceRoot ? "Change workspace" : "Attach workspace", kind: "secondary" }];
  const buildId = detail.activeBuild?.id || "";
  const inPreviewState = !!buildId && PREVIEWABLE_BUILD_STATES.includes(detail.state);
  // D5: the server-served bundle build takes priority over the old hands-node tunnel. The tunnel
  // branch is kept only for a build that has no assembled bundle yet (builds.exists false), so
  // existing preview behavior is unchanged wherever no bundle backend is wired in.
  const hasBundle = inPreviewState && !!uid && typeof builds?.exists === "function" && builds.exists({ uid, projectId: detail.id, buildId });
  if (hasBundle) {
    out.unshift({
      id: "preview", label: "Play current build",
      kind: detail.state === "PLAYTEST_READY" ? "primary" : "secondary",
      clientAction: "preview",
      previewUrl: `/api/game-factory/games/${encodeURIComponent(detail.id)}/builds/${encodeURIComponent(buildId)}/play/index.html`,
    });
  } else {
    const previewable = !!detail.workspaceId && inPreviewState && !detail.operation;
    if (previewable) out.unshift({ id: "preview", label: "Try current workspace build", kind: "secondary", clientAction: "preview" });
  }
  if (detail.operation === "PAUSE_REQUESTED" || detail.operation === "STOP_REQUESTED") return out;
  if (detail.state === "PAUSED") return [{ id: "resume", label: "Resume", kind: "primary" }, { id: "stop", label: "Stop", kind: "danger" }, ...out];
  if (detail.state === "BLOCKED" || detail.state === "FAILED") return [{ id: "retry", label: "Retry", kind: "primary" }, ...out];
  if (allowedTransitions(detail.state, { resumeState: detail.resumeState }).includes("REVISION")) {
    out.unshift({ id: "revise", label: detail.state === "DEPLOYED" ? "Create revision" : "Request revision", kind: "secondary", requiresInput: true, inputLabel: "Describe the change you want" });
  }
  if (detail.state === "DEPLOYED") return out;
  const gateStatus = ownerGateStatus(detail);
  if (gateStatus.gate && gateStatus.ready) {
    const commandPayload = { gate: gateStatus.gate, subjectHash: gateStatus.subject.hash };
    out.unshift(
      {
        id: "approve", label: `Approve ${gateStatus.gate.replaceAll("_", " ").toLowerCase()}`,
        kind: "primary", gate: gateStatus.gate, commandPayload, requiresConfirmation: true,
        subjectHash: gateStatus.subject.hash, subjectLabel: gateStatus.subject.label, buildId: gateStatus.subject.buildId,
      },
      {
        id: "reject", label: "Request changes", kind: "danger", gate: gateStatus.gate, commandPayload,
        requiresInput: true, inputLabel: "Explain what must change", subjectHash: gateStatus.subject.hash,
        subjectLabel: gateStatus.subject.label, buildId: gateStatus.subject.buildId,
      },
    );
    out.push({ id: "pause", label: "Pause", kind: "secondary" }, { id: "stop", label: "Stop", kind: "danger" });
    return out;
  }
  if (gateStatus.gate && !gateStatus.ready) {
    out.push({ id: "pause", label: "Pause", kind: "secondary" }, { id: "stop", label: "Stop", kind: "danger" });
    return out;
  }
  // The owner starts the plan and explicitly enters store preparation. Intermediate lifecycle
  // progress belongs to the evidence-validating reconciler, not a browser button.
  if (detail.state === "IDEA") {
    // D6: one tap to a playable build. The manual path (Start game plan, then approve each gate by
    // hand) stays available and unchanged; Run to playtest additionally pre-records the owner's
    // approval of the two planning gates so the supervisor can drive straight to PLAYTEST_READY.
    out.unshift(
      {
        id: "run_to_playtest", label: "Run to playtest", kind: "primary", requiresConfirmation: true,
        confirmNote: "Starts the plan and records your approval of the specification and visual system in advance. You still preview and approve the playtest build yourself.",
      },
      { id: "start", label: "Start game plan", kind: "secondary" },
    );
  }
  else if (detail.state === "APPROVED" && detail.evidence?.artifactsComplete && detail.evidence?.legalAndPrivacyApproved) {
    out.unshift({ id: "advance", label: "Prepare store release", kind: "primary", toState: "STORE_PREP", requiresConfirmation: true });
  } else if (detail.state === "STORE_PREP" && detail.evidence?.storeSubmissionApproved && detail.evidence?.productionReleaseApproved && detail.evidence?.releaseReady) {
    out.unshift({ id: "advance", label: "Record released status", kind: "primary", toState: "DEPLOYED", requiresConfirmation: true });
  }
  out.push({ id: "pause", label: "Pause", kind: "secondary" }, { id: "stop", label: "Stop", kind: "danger" });
  return out;
}

function projectCard(detail, options) {
  const running = (detail.tasks || []).find((task) => task.status === "RUNNING") || null;
  const queued = (detail.tasks || []).find((task) => task.status === "QUEUED") || null;
  const gateStatus = ownerGateStatus(detail);
  const sourceCommit = detail.activeBuild?.sourceCommit || "";
  const tests = currentRows(detail.tests, detail.activeBuild?.id || "", "suite");
  const releases = currentRows(detail.releases, detail.activeBuild?.id || "", "platform");
  return {
    id: detail.id, name: detail.name, slug: detail.slug, order: detail.order,
    state: detail.state, operation: detail.operation, progress: durableProgress(detail),
    version: detail.version, priority: detail.priority, blocker: detail.blocker,
    currentTask: running ? {
      id: running.id, title: running.title, capability: running.capability, status: running.status,
      workerId: running.workerId || "", attempt: running.attempt, maxAttempts: running.maxAttempts,
      startedAt: running.startedAt || 0, heartbeatAt: running.heartbeatAt || 0, leaseUntil: running.leaseUntil || 0,
    } : null,
    nextTask: queued ? {
      id: queued.id, title: queued.title, capability: queued.capability, status: queued.status,
      attempt: queued.attempt, maxAttempts: queued.maxAttempts, createdAt: queued.createdAt || 0,
    } : null,
    approvalNeeded: gateStatus.ready ? gateStatus.gate : "",
    approvalBlocked: gateStatus.blocker,
    approvalSubject: gateStatus.subject,
    artifacts: { complete: detail.complete, missing: (detail.missing || []).length },
    tests: {
      passed: [...tests.values()].filter((test) => test.status === "PASSED" && (!sourceCommit || test.sourceHash === sourceCommit)).length,
      failed: [...tests.values()].filter((test) => ["FAILED", "BLOCKED"].includes(test.status) && (!sourceCommit || test.sourceHash === sourceCommit)).length,
    },
    releases: {
      preflightReady: [...releases.values()].filter((release) => release.status === "READY").length,
      released: [...releases.values()].filter((release) => release.status === "RELEASED").length,
    },
    allowedActions: allowedActions(detail, options), updatedAt: detail.updatedAt,
  };
}

function ownerCommand(detail, body, options) {
  const command = one(body?.command, 80).toLowerCase();
  const supported = new Set(["start", "run_to_playtest", "advance", "pause", "resume", "stop", "retry", "revise", "approve", "reject"]);
  if (!supported.has(command)) {
    return { error: "That command is reserved for the trusted factory control plane.", code: "owner_command_not_allowed", status: 403 };
  }
  const action = allowedActions(detail, options).find((item) => !item.clientAction && (item.command || item.id) === command);
  if (!action) {
    return { error: "That owner action is not available at the current durable checkpoint.", code: "owner_action_not_available", status: 409 };
  }
  const supplied = body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
  let payload = {};
  if (command === "start" || command === "run_to_playtest") payload = {};
  else if (command === "advance") {
    if (one(supplied.toState, 80).toUpperCase() !== action.toState) {
      return { error: "The requested next stage does not match the server-provided owner action.", code: "owner_action_mismatch", status: 409 };
    }
    payload = { toState: action.toState };
  }
  else if (command === "revise") {
    const reason = one(supplied.reason, 2000);
    if (!reason) return { error: "Describe the revision in plain language.", code: "revision_reason_required", status: 400 };
    payload = { reason };
  } else if (command === "approve" || command === "reject") {
    if (one(supplied.gate, 80).toUpperCase() !== action.gate || one(supplied.subjectHash, 128).toLowerCase() !== action.subjectHash) {
      return { error: "The approval evidence changed. Reload the current checkpoint before deciding.", code: "approval_subject_mismatch", status: 409 };
    }
    payload = { ...(action.commandPayload || {}) };
    if (command === "reject") {
      const rationale = one(supplied.rationale, 2000);
      if (!rationale) return { error: "Explain what must change before recording a rejection.", code: "rejection_rationale_required", status: 400 };
      payload.rationale = rationale;
    }
  }
  return { action, command, payload };
}

function normalizedCommandPayload(body) {
  const command = one(body?.command, 80).toLowerCase();
  const supplied = body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
  if (command === "advance") return { toState: one(supplied.toState, 80).toUpperCase() };
  if (command === "revise") return { reason: one(supplied.reason, 2000) };
  if (command === "approve") return { gate: one(supplied.gate, 80).toUpperCase(), subjectHash: one(supplied.subjectHash, 128).toLowerCase() };
  if (command === "reject") return {
    gate: one(supplied.gate, 80).toUpperCase(),
    subjectHash: one(supplied.subjectHash, 128).toLowerCase(),
    rationale: one(supplied.rationale, 2000),
  };
  return {};
}

function artifactViewerStatus(artifact, { configured = false, owner = false } = {}) {
  const artifactKey = String(artifact?.artifactKey || "").trim().toUpperCase();
  const mimeType = String(artifact?.mimeType || "").trim();
  const size = Number(artifact?.size);
  const sha256 = String(artifact?.sha256 || "").trim().toLowerCase();
  if (!owner) return { enabled: false, code: "owner_only", reason: "Only the owner can open artifact contents in Dominion." };
  if (!REQUIRED_GAME_ARTIFACTS.includes(artifactKey)) {
    return { enabled: false, code: "artifact_not_required", reason: "Only required factory artifacts can be opened here." };
  }
  if (!REVIEWABLE_ARTIFACT_MIMES.has(mimeType)) {
    return { enabled: false, code: "artifact_not_text", reason: "This artifact is not plain text or Markdown, so Dominion will not render it here." };
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_CONTENT_BYTES) {
    return { enabled: false, code: "artifact_content_too_large", reason: `Artifact review is limited to ${MAX_ARTIFACT_CONTENT_BYTES.toLocaleString("en-US")} verified bytes.` };
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return { enabled: false, code: "artifact_metadata_invalid", reason: "This artifact has no valid immutable SHA-256 fingerprint." };
  }
  const hasVerifiedPrimary = (artifact?.copies || []).some((copy) => copy?.backend === "primary"
    && copy?.status === "VERIFIED" && copy?.algorithm === "sha256" && copy?.fingerprint === sha256);
  if (!hasVerifiedPrimary) {
    return { enabled: false, code: "artifact_primary_unverified", reason: "A verified local copy is not available for review." };
  }
  if (!configured) {
    return { enabled: false, code: "artifact_reader_unconfigured", reason: "Artifact viewing is not configured on this Dominion runtime." };
  }
  return { enabled: true, maxBytes: MAX_ARTIFACT_CONTENT_BYTES, renderMode: "plain_text", markdownExecution: false };
}

function artifactsForReview(detail, options) {
  return (detail?.artifacts || []).map((artifact) => ({
    id: artifact.id,
    artifactKey: artifact.artifactKey,
    version: artifact.version,
    sha256: artifact.sha256,
    size: artifact.size,
    mimeType: artifact.mimeType,
    createdAt: artifact.createdAt,
    complete: !!artifact.complete,
    copies: (artifact.copies || []).map((copy) => ({
      backend: copy.backend,
      status: copy.status,
      fingerprint: copy.fingerprint,
      algorithm: copy.algorithm,
      attempts: copy.attempts,
      verifiedAt: copy.verifiedAt,
    })),
    viewer: artifactViewerStatus(artifact, options),
  }));
}

export function createGameFactoryHttp({
  store,
  gate,
  resolveTenant,
  workerHealth = () => ({ configured: false }),
  mirrorHealth = () => ({ configured: false }),
  releaseHealth = () => ({ writesEnabled: false }),
  planner = null,
  readArtifactContent = null,
  syntheticCanary = null,
  // D2/D3/D5/D6: the supervisor, forge and served-bundle deps this lane's owner surface reads and
  // drives. All optional and fail-closed: with none injected, Run to playtest 503s, the build card
  // and autopilot badge stay absent, health reads "Not configured", and the play route 404s instead
  // of ever reading a file. Integration (Fable) wires the real adapters in server.mjs.
  supervisor = null,
  forgeHealth = () => ({ enabled: false }),
  supervisorHealth = () => ({ enabled: false }),
  builds = { resolveFile: () => null, summary: () => null, exists: () => false },
  // Builds, worker tasks, artifact attestations, QA evidence and store status are machine facts.
  // A signed-in browser must not be able to manufacture them. Production therefore fails closed;
  // a trusted in-process adapter may opt in with an explicit authorizer.
  authorizeEvidenceWrite = () => false,
  log = () => {},
} = {}) {
  if (!store || !gate || typeof resolveTenant !== "function") throw new Error("createGameFactoryHttp needs store, gate and resolveTenant");

  function wall(req, { ownerOnly = false } = {}) {
    const T = resolveTenant(req);
    if (!T || T.role === "anon") return { T, response: { status: 401, body: { error: "Sign in to use the Game Factory.", code: "no_identity" } } };
    if (T.status === "paused" || T.status === "locked") return { T, response: { status: 403, body: { error: `This account is ${T.status}.`, code: `account_${T.status}` } } };
    if (!gate.allowed(T)) return { T, response: { status: 403, body: { error: "The Mobile Game Factory is not enabled for this account.", code: "factory_disabled" } } };
    if (ownerOnly && !T.isOwner) return { T, response: { status: 403, body: { error: "Only the owner can access this factory operation.", code: "owner_only" } } };
    if (!T.isOwner && !T.invited) return { T, response: { status: 403, body: { error: "An invitation is required.", code: "needs_invite" } } };
    return { T, response: null };
  }

  function seed(T) { return store.seedPortfolio({ uid: T.uid || "owner", email: T.email || "" }); }

  async function handle(req, res, u) {
    const url = u instanceof URL ? u : new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/$/, "");
    const artifactContentMatch = path.match(ARTIFACT_CONTENT_ROUTE);
    const isSyntheticCanary = path === SYNTHETIC_CANARY_ROUTE;
    const isChatgptReconciliation = path === "/api/game-factory/admin/chatgpt-reconciliation";
    const playMatch = path.match(PLAY_ROUTE);
    const check = wall(req, { ownerOnly: path === "/api/game-factory/health" || !!artifactContentMatch || isSyntheticCanary || isChatgptReconciliation || !!playMatch });
    if (check.response) return json(res, check.response.status, check.response.body);
    const T = check.T, uid = T.uid || "owner";
    const expectedAction = isSyntheticCanary ? SYNTHETIC_CANARY_ACTION : "game-factory";
    if (req.method === "POST" && req.headers["x-dominion-action"] !== expectedAction) {
      return json(res, 403, { error: "This factory action did not come through Dominion's protected action channel.", code: "action_header_required" });
    }

    if (isSyntheticCanary) {
      // Unlike authorizeEvidenceWrite, this identity rule is not injectable: even a trusted
      // in-process adapter cannot turn a service principal or forged browser header into a canary.
      if (!verifiedHumanFactoryOwner(req, T, gate.mode)) {
        return json(res, 403, { error: "The synthetic canary requires a verified human owner JWT.", code: "human_owner_required" });
      }
      if (req.method !== "POST") {
        return json(res, 405, { error: "The synthetic canary accepts POST only.", code: "method_not_allowed" });
      }
      if (syntheticCanary?.enabled !== true || typeof syntheticCanary.run !== "function") {
        return json(res, 404, { error: "The synthetic canary is not enabled.", code: "synthetic_canary_disabled" });
      }
      const body = await bodyJson(req, 4096);
      if (body && body.__bodyError) return json(res, body.status || 400, { error: body.error, code: body.code });
      const keys = Object.keys(body || {});
      if (keys.length !== 1 || keys[0] !== "projectId") {
        return json(res, 400, { error: "The synthetic canary accepts only projectId.", code: "bad_canary_schema" });
      }
      const rawProjectId = body.projectId;
      if (typeof rawProjectId !== "string" || rawProjectId !== rawProjectId.trim()
          || !/^gf_[a-z0-9_-]{3,160}$/.test(rawProjectId)) {
        return json(res, 400, { error: "A valid existing factory project is required.", code: "bad_project_id" });
      }
      const headerKey = req.headers["idempotency-key"];
      if (typeof headerKey !== "string" || headerKey !== headerKey.trim()
          || headerKey.length < 16 || headerKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(headerKey)) {
        return json(res, 400, { error: "A 16-128 character Idempotency-Key header is required.", code: "bad_idempotency_key" });
      }
      let result;
      try {
        result = await syntheticCanary.run({
          uid, email: T.email || "", projectId: rawProjectId, key: headerKey,
          actor: T.email || uid, tenant: T,
        });
      } catch {
        log("game factory synthetic canary adapter failed");
        return json(res, 503, { error: "The synthetic canary adapter is unavailable.", code: "synthetic_canary_unavailable" });
      }
      if (!result || !Number.isInteger(result.status) || !result.body || typeof result.body !== "object") {
        return json(res, 503, { error: "The synthetic canary adapter returned an invalid response.", code: "synthetic_canary_unavailable" });
      }
      return json(res, result.status, result.body);
    }

    if (req.method === "GET" && path === "/api/game-factory/config") {
      return json(res, 200, {
        allowed: true, owner: !!T.isOwner, mode: gate.mode,
        states: [...GAME_STATES], requiredArtifacts: [...REQUIRED_GAME_ARTIFACTS], requiredArtifactBackends: [...MANDATORY_ARTIFACT_BACKENDS],
        deferredArtifactBackends: [...DEFERRED_ARTIFACT_BACKENDS],
        qaRequiredSuites: [...QA_REQUIRED_SUITES], approvalGates: [...APPROVAL_GATES],
        // D1: the admitted toolchain is dependency-free HTML5 canvas games, not the Godot candidate
        // the artifact templates describe. A fixed string, not a knob: the client has nothing to pick.
        toolchain: "web-canvas",
        artifactViewer: {
          enabled: !!T.isOwner && typeof readArtifactContent === "function",
          maxBytes: MAX_ARTIFACT_CONTENT_BYTES,
          mimeTypes: [...REVIEWABLE_ARTIFACT_MIMES],
          renderMode: "plain_text",
          markdownExecution: false,
        },
      });
    }

    if (req.method === "GET" && path === "/api/game-factory/bootstrap") {
      seed(T);
      const details = store.listProjects(uid).map((project) => store.getProject(uid, project.id));
      const games = details.map((detail) => projectCard(detail, { builds, uid }));
      return json(res, 200, {
        // The owner surface measures heartbeat and lease ages against THIS clock, never the phone's.
        serverNow: Date.now(),
        games,
        summary: {
          total: games.length,
          active: games.filter((game) => !["IDEA", "PAUSED", "BLOCKED", "FAILED", "DEPLOYED"].includes(game.state)).length,
          approvals: games.filter((game) => game.approvalNeeded).length,
          blocked: games.filter((game) => game.state === "BLOCKED" || game.state === "FAILED").length,
          runningTasks: games.filter((game) => game.currentTask).length,
          mirrored: games.filter((game) => game.artifacts.complete).length,
        },
        health: { worker: workerHealth(T), mirror: mirrorHealth(T), release: releaseHealth(T), supervisor: supervisorHealth(T), forge: forgeHealth(T) },
      });
    }

    if (req.method === "GET" && path === "/api/game-factory/health") {
      return json(res, 200, { store: store.health(), worker: workerHealth(T), mirror: mirrorHealth(T), release: releaseHealth(T) });
    }

    // Deficiency 15's deliverable: the reconciliation queue of what the owner may still sync by hand
    // through the offline attestation command. Purely informational (never a blocker); owner-only
    // because it names artifact identities the same way the artifact/health surfaces already do.
    if (req.method === "GET" && path === "/api/game-factory/admin/chatgpt-reconciliation") {
      if (!T.isOwner) return json(res, 403, { error: "Only the owner can view the reconciliation queue.", code: "owner_only" });
      const queue = typeof store.chatgptProjectReconciliationQueue === "function"
        ? store.chatgptProjectReconciliationQueue({ uid })
        : [];
      return json(res, 200, {
        backend: "chatgpt_project", deferred: true,
        attestationDoc: "docs/NATIVE_CHATGPT_PROJECT_OWNER_ATTESTATION.md",
        offlineOperatorCommand: "node ops/record-native-chatgpt-project-attestation.mjs",
        pending: queue,
      });
    }

    if (req.method === "GET" && path === "/api/game-factory/events") {
      const projectId = one(url.searchParams.get("projectId"), 180);
      if (!store.getProject(uid, projectId, { eventLimit: 1 })) return json(res, 404, { error: "No such game.", code: "not_found" });
      let cursor = Math.max(Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0) || 0, 0);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = () => {
        let rows = [];
        try { rows = store.events(uid, projectId, cursor, 200); } catch (error) { log("game factory SSE: " + String(error && error.message || error)); }
        for (const event of rows) {
          cursor = event.id;
          try { res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch { return false; }
        }
        return true;
      };
      send();
      const poll = setInterval(send, 1000);
      if (typeof poll.unref === "function") poll.unref();
      // Streams lane, deficiency #18: this feed's own 20s keepalive was already inside
      // Cloudflare's ~100s idle-close window and still showed 14 cancels in the production log
      // window — the shared 10s cadence (sseheartbeat.mjs, same helper every other stream in this
      // app uses) narrows that further; the remaining cancels are consistent with ordinary client
      // navigation away from the Game Factory screen (a fresh EventSource per project view), not a
      // transport idle-kill, since a keepalive already well under threshold was already running.
      const stopHeartbeat = startSseHeartbeat(res);
      const close = () => { clearInterval(poll); stopHeartbeat(); };
      req.on("close", close); res.on("close", close);
      return;
    }

    if (artifactContentMatch) {
      if (req.method !== "GET") {
        return json(res, 405, { error: "Artifact contents are read-only.", code: "method_not_allowed" });
      }
      let projectId, artifactKey;
      try {
        projectId = decodeURIComponent(artifactContentMatch[1]);
        artifactKey = decodeURIComponent(artifactContentMatch[2]).trim().toUpperCase();
      } catch {
        return json(res, 400, { error: "The artifact identity is malformed.", code: "bad_artifact_identity" });
      }
      if (!REQUIRED_GAME_ARTIFACTS.includes(artifactKey)) {
        return json(res, 400, { error: "Only required factory artifacts can be opened.", code: "artifact_not_required" });
      }
      const detail = store.getProject(uid, projectId);
      if (!detail) return json(res, 404, { error: "No such game.", code: "not_found" });
      const artifact = (detail.artifacts || []).find((item) => item.artifactKey === artifactKey);
      if (!artifact) return json(res, 404, { error: "That required artifact has not been recorded.", code: "artifact_not_recorded" });
      const viewer = artifactViewerStatus(artifact, { configured: typeof readArtifactContent === "function", owner: !!T.isOwner });
      if (!viewer.enabled) {
        const status = viewer.code === "artifact_not_text" ? 415
          : viewer.code === "artifact_content_too_large" ? 413
            : viewer.code === "artifact_reader_unconfigured" ? 503 : 409;
        return json(res, status, { error: viewer.reason, code: viewer.code });
      }
      let returned;
      try {
        returned = await readArtifactContent({ uid, projectId, artifact, tenant: T, maxBytes: MAX_ARTIFACT_CONTENT_BYTES });
      } catch {
        log("game factory artifact content read failed");
        return json(res, 503, { error: "The verified artifact content is temporarily unavailable.", code: "artifact_content_unavailable" });
      }
      const raw = returned && typeof returned === "object" && !Buffer.isBuffer(returned) && !(returned instanceof Uint8Array)
        && Object.prototype.hasOwnProperty.call(returned, "data") ? returned.data : returned;
      if (typeof raw !== "string" && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
        return json(res, 503, { error: "The artifact reader did not return reviewable bytes.", code: "artifact_content_unavailable" });
      }
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (bytes.length > MAX_ARTIFACT_CONTENT_BYTES) {
        return json(res, 413, { error: "The artifact content exceeds the review limit.", code: "artifact_content_too_large" });
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== Number(artifact.size) || digest !== artifact.sha256) {
        return json(res, 409, { error: "The artifact content no longer matches its immutable metadata.", code: "artifact_content_conflict" });
      }
      let content;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return json(res, 415, { error: "The artifact is not valid UTF-8 text.", code: "artifact_text_invalid" }); }
      return json(res, 200, {
        artifact: {
          id: artifact.id, artifactKey: artifact.artifactKey, version: artifact.version,
          sha256: artifact.sha256, size: artifact.size, mimeType: artifact.mimeType, complete: !!artifact.complete,
        },
        content,
        viewer: { renderMode: "plain_text", markdownExecution: false },
      });
    }

    if (playMatch) {
      // D5: native preview. This is the exact immutable bundle a build produced, served to the
      // sandboxed iframe. It is a build artifact, not a durable project record, so it earns its own
      // human-owner check (mirrors the synthetic canary's verifiedHumanFactoryOwner gate) rather than
      // just riding the ordinary tenant wall: a forged or service-principal session must not be able
      // to load generated game code into the owner's browser.
      if (req.method !== "GET") return json(res, 405, { error: "A build preview can only be read.", code: "method_not_allowed" });
      if (!verifiedHumanFactoryOwner(req, T, gate.mode)) {
        return json(res, 403, { error: "Playing a build requires a verified human owner session.", code: "human_owner_required" });
      }
      let projectId, buildId, relPath;
      try {
        projectId = decodeURIComponent(playMatch[1]);
        buildId = decodeURIComponent(playMatch[2]);
        relPath = playMatch[3] ? decodeURIComponent(playMatch[3].slice(1)) : "index.html";
      } catch {
        return json(res, 400, { error: "The build preview path is malformed.", code: "bad_play_path" });
      }
      if (!relPath) relPath = "index.html";
      // The builds.resolveFile adapter is the actual guarantee against reading outside the bundle
      // (D5, LANE-gfhttp.md #4), but this route never trusts an injected dependency alone for a
      // path-traversal class of bug: any ".." segment, a leading slash (an absolute path once
      // decoded), a backslash, or a Windows drive letter is refused before the resolver is ever
      // called, so a resolver bug elsewhere can only ever narrow what is reachable, never widen it.
      if (relPath.includes("..") || relPath.startsWith("/") || relPath.includes("\\") || /^[a-zA-Z]:/.test(relPath)) {
        return json(res, 400, { error: "That build path is not allowed.", code: "bad_play_path" });
      }
      if (typeof builds?.resolveFile !== "function") {
        return json(res, 503, { error: "Build preview is not configured on this Dominion runtime.", code: "builds_unavailable" });
      }
      let resolved = null;
      try { resolved = builds.resolveFile({ uid, projectId, buildId, relPath }); } catch { resolved = null; }
      if (!resolved || !resolved.absolute) return json(res, 404, { error: "That build file was not found.", code: "not_found" });
      const ext = String(relPath.split(".").pop() || "").toLowerCase();
      const contentType = PLAY_MIME_BY_EXT[ext] || resolved.mime || "application/octet-stream";
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": PLAY_CONTENT_SECURITY_POLICY,
      });
      try {
        // Awaited so the handler's own promise only resolves once the bytes are actually flushed —
        // harmless for a real http.ServerResponse (nothing else is waiting on this handler call) and
        // it makes the route's behavior deterministic for anything that awaits handle() directly.
        await new Promise((resolve) => {
          const stream = createReadStream(resolved.absolute);
          stream.on("error", () => { try { res.end(); } catch {} resolve(); });
          res.once("finish", resolve);
          stream.pipe(res);
        });
      } catch {
        try { res.end(); } catch {}
      }
      return;
    }

    const gameMatch = path.match(/^\/api\/game-factory\/games\/([^/]+)(?:\/(commands|builds|tasks|artifacts|tests|releases))?$/);
    if (gameMatch) {
      const projectId = decodeURIComponent(gameMatch[1]);
      const child = gameMatch[2] || "";
      if (req.method === "GET" && !child) {
        const detail = store.getProject(uid, projectId);
        if (!detail) return json(res, 404, { error: "No such game.", code: "not_found" });
        const gateStatus = ownerGateStatus(detail);
        return json(res, 200, {
          serverNow: Date.now(),
          game: {
            ...detail,
            artifacts: artifactsForReview(detail, { configured: typeof readArtifactContent === "function", owner: !!T.isOwner }),
            progress: durableProgress(detail),
            allowedActions: allowedActions(detail, { builds, uid }),
            build: detail.activeBuild?.id && typeof builds?.summary === "function" ? builds.summary({ uid, projectId, buildId: detail.activeBuild.id }) : null,
            autopilot: typeof supervisor?.getAutopilot === "function" && supervisor.getAutopilot(projectId) === true,
            approvalNeeded: gateStatus.ready ? gateStatus.gate : "",
            approvalBlocked: gateStatus.blocker,
            approvalSubject: gateStatus.subject,
          },
        });
      }
      if (req.method === "POST" && child && child !== "commands" && authorizeEvidenceWrite(req, T, child) !== true) {
        return json(res, 403, { error: "Build and release evidence can only be written by a trusted factory adapter.", code: "trusted_adapter_required" });
      }
      const body = await bodyJson(req);
      if (body && body.__bodyError) return json(res, body.status || 400, { error: body.error, code: body.code });
      if (req.method === "POST" && child === "commands") {
        if (body.expectedVersion == null) return json(res, 428, { error: "expectedVersion is required.", code: "version_required" });
        const key = one(req.headers["idempotency-key"] || body.idempotencyKey, 160);
        const detail = store.getProject(uid, projectId);
        if (!detail) return json(res, 404, { error: "No such game.", code: "not_found" });
        let type = one(body.command, 80).toLowerCase(), payload = normalizedCommandPayload(body);
        // A mismatched version cannot mutate the project; allowing it through preserves the
        // store's durable idempotent replay response for a command that already committed.
        if (Number(body.expectedVersion) === Number(detail.version)) {
          const checked = ownerCommand(detail, body, { builds, uid });
          if (checked.error) return json(res, checked.status, { error: checked.error, code: checked.code });
          type = checked.command;
          payload = checked.payload;
        }
        const result = type === "start"
          ? typeof planner?.startSpecification === "function"
            ? await planner.startSpecification({ uid, email: T.email, projectId, key, expectedVersion: body.expectedVersion, actor: T.email || uid, tenant: T })
            : { status: 503, body: { error: "The trusted game planner is not configured.", code: "planner_unavailable" } }
          : type === "run_to_playtest"
            ? typeof supervisor?.runToPlaytest === "function"
              ? await supervisor.runToPlaytest({ uid, email: T.email, projectId, key, expectedVersion: body.expectedVersion, actor: T.email || uid, tenant: T })
              : { status: 503, body: { error: "The trusted factory supervisor is not configured.", code: "supervisor_unavailable" } }
            : store.executeCommand({ uid, email: T.email, projectId, key, expectedVersion: body.expectedVersion, type, payload, actor: T.email || uid });
        return json(res, result.status, result.body);
      }
      if (req.method === "POST" && child === "builds") {
        const result = store.createBuild({ uid, projectId, sourceCommit: body.sourceCommit, toolchain: body.toolchain || {}, targets: body.targets, versionName: body.versionName, versionCode: body.versionCode });
        return json(res, result.status, result.body);
      }
      if (req.method === "POST" && child === "tasks") {
        const result = store.queueTask({ uid, projectId, buildId: body.buildId, capability: body.capability, title: body.title, payload: body.payload || {}, acceptance: body.acceptance || [], priority: body.priority, safeToRetry: body.safeToRetry, maxAttempts: body.maxAttempts });
        return json(res, result.status, result.body);
      }
      if (req.method === "POST" && child === "artifacts") {
        const result = store.recordArtifact({ uid, projectId, artifactKey: body.artifactKey, sha256: body.sha256, size: body.size, mimeType: body.mimeType, provenance: body.provenance || {} });
        return json(res, result.status, result.body);
      }
      if (req.method === "POST" && child === "tests") {
        const result = store.recordTestRun({ uid, projectId, buildId: body.buildId, suite: body.suite, target: body.target, status: body.status, sourceHash: body.sourceHash, evidence: body.evidence || {}, metrics: body.metrics || {} });
        return json(res, result.status, result.body);
      }
      if (req.method === "POST" && child === "releases") {
        const result = store.recordRelease({ uid, projectId, buildId: body.buildId, platform: body.platform, packageId: body.packageId, versionName: body.versionName, versionCode: body.versionCode, status: body.status, storeLocator: body.storeLocator, evidence: body.evidence || {} });
        return json(res, result.status, result.body);
      }
    }

    const copyMatch = path.match(/^\/api\/game-factory\/artifacts\/([^/]+)\/copies$/);
    if (copyMatch && req.method === "POST") {
      if (authorizeEvidenceWrite(req, T, "copies") !== true) {
        return json(res, 403, { error: "Artifact verification can only be written by a trusted factory adapter.", code: "trusted_adapter_required" });
      }
      const body = await bodyJson(req);
      if (body && body.__bodyError) return json(res, body.status || 400, { error: body.error, code: body.code });
      if (String(body.backend || "").trim().toLowerCase() === "chatgpt_project") {
        // Native Project completion is intentionally not an HTTP capability.  Even a trusted
        // factory adapter cannot turn a browser request, worker result, screenshot, or generic
        // local observation into owner-attested evidence.
        return json(res, 403, { error: "Native ChatGPT Project evidence is recorded only by the offline privileged operator command or a future documented native API adapter.", code: "native_project_evidence_offline_only" });
      }
      const result = store.recordArtifactCopy({ uid, artifactId: decodeURIComponent(copyMatch[1]), backend: body.backend, locator: body.locator, status: body.status, fingerprint: body.fingerprint, algorithm: body.algorithm, error: body.error });
      return json(res, result.status, result.body);
    }

    return json(res, 404, { error: "Unknown Game Factory route.", code: "not_found" });
  }

  return { handle, wall, allowedActions };
}
