import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGameFactoryGate } from "./gamefactory.mjs";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { createGameFactoryHttp } from "./gamefactoryhttp.mjs";
import {
  LOCKED_NATIVE_CHATGPT_PROJECT_ID, NATIVE_PROJECT_OWNER_ATTESTED_STATUS, OWNER_ATTESTATION_ACKNOWLEDGEMENT,
  OWNER_ATTESTATION_OPERATOR, expectedNativeProjectFilename,
} from "./gamefactorynativeevidence.mjs";

class Response extends EventEmitter {
  constructor() { super(); this.statusCode = 0; this.headers = {}; this.body = ""; this.ended = false; }
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; return this; }
  write(chunk = "") { this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); return true; }
  end(chunk = "") { if (chunk) this.write(chunk); this.ended = true; this.emit("finish"); }
  json() { return JSON.parse(this.body || "null"); }
}

function makeRequest({ method = "GET", path, body, rawBody, headers = {}, tenant, identity, actionHeader = true }) {
  const payload = rawBody == null ? (body == null ? [] : [Buffer.from(JSON.stringify(body))]) : [Buffer.from(rawBody)];
  const req = Readable.from(payload);
  req.method = method;
  req.url = path;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (method === "POST" && actionHeader) req.headers["x-dominion-action"] = typeof actionHeader === "string" ? actionHeader : "game-factory";
  req.tenant = tenant;
  if (identity) req.dominionIdentity = identity;
  return req;
}

const owner = { uid: "owner-uid", email: "owner@example.com", role: "owner", isOwner: true, invited: true, status: "active" };
const member = { uid: "member-uid", email: "member@example.com", role: "credit", isOwner: false, invited: true, status: "active" };
const dir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-http-"));
const store = createGameFactoryStore({ dir });
const health = { worker: { configured: true, node: "gx10" }, mirror: { configured: false }, release: { writesEnabled: false } };
const plannerCalls = [];
const planner = {
  async startSpecification(input) {
    plannerCalls.push(input);
    return store.executeCommand({
      uid: input.uid, email: input.email, projectId: input.projectId, key: input.key,
      expectedVersion: input.expectedVersion, type: "advance", payload: { toState: "SPECIFICATION" }, actor: input.actor,
    });
  },
};
const api = createGameFactoryHttp({
  store,
  gate: createGameFactoryGate("owner"),
  resolveTenant: (req) => req.tenant,
  workerHealth: () => health.worker,
  mirrorHealth: () => health.mirror,
  releaseHealth: () => health.release,
  planner,
  authorizeEvidenceWrite: (_req, T) => T?.isOwner === true,
});

async function call(target = api, options) {
  const req = makeRequest(options);
  const res = new Response();
  await target.handle(req, res);
  return { req, res };
}

function recordVerifiedArtifact(projectId, artifactKey, fill) {
  const sha256 = String(fill).repeat(64).slice(0, 64);
  const artifact = store.recordArtifact({ uid: owner.uid, projectId, artifactKey, sha256, size: 10, mimeType: "text/markdown" });
  assert.equal(artifact.status, 201);
  for (const backend of ["primary", "google_drive"]) {
    const copy = store.recordArtifactCopy({ uid: owner.uid, artifactId: artifact.body.artifactId, backend, locator: `${backend}://${artifactKey}`, status: "VERIFIED", fingerprint: sha256 });
    assert.equal(copy.status, 200);
  }
  const current = store.getProject(owner.uid, projectId).artifacts.find((item) => item.id === artifact.body.artifactId);
  const native = store.recordOwnerAttestedNativeProjectEvidence({
    uid: owner.uid, artifactId: artifact.body.artifactId,
    manifest: {
      formatVersion: 1, kind: NATIVE_PROJECT_OWNER_ATTESTED_STATUS, nativeProjectId: LOCKED_NATIVE_CHATGPT_PROJECT_ID,
      artifactId: current.id, artifactKey: current.artifactKey, artifactVersion: current.version,
      sha256: current.sha256, size: current.size, filename: expectedNativeProjectFilename(current), sourceCount: 1,
      operator: OWNER_ATTESTATION_OPERATOR, observedAt: new Date(current.createdAt).toISOString(),
      browserEvidenceRef: `chatgpt-project-browser://${LOCKED_NATIVE_CHATGPT_PROJECT_ID}/visible/${current.id}`,
      uploadMethod: "BROWSER_FILE_UPLOAD", evidenceOrigin: "OWNER_CONTROLLED_CHATGPT_PROJECT_BROWSER",
      sourceListVisible: true, screenshotOnly: false, ownerAttestation: OWNER_ATTESTATION_ACKNOWLEDGEMENT,
    },
  });
  assert.equal(native.status, 201, JSON.stringify(native.body));
  return artifact.body.artifactId;
}

function recordLocalArtifact(projectId, artifactKey, data, mimeType = "text/markdown", declaredSize = null) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = store.recordArtifact({
    uid: owner.uid, projectId, artifactKey, sha256,
    size: declaredSize == null ? bytes.length : declaredSize, mimeType,
  });
  assert.equal(artifact.status, 201, JSON.stringify(artifact.body));
  const copy = store.recordArtifactCopy({
    uid: owner.uid, artifactId: artifact.body.artifactId, backend: "primary",
    locator: `factory-local://${artifact.body.artifactId}`, status: "VERIFIED", fingerprint: sha256, algorithm: "sha256",
  });
  assert.equal(copy.status, 200, JSON.stringify(copy.body));
  return { bytes, sha256, artifactId: artifact.body.artifactId };
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log("ok", n, "-", name); }

try {
  await test("identity, account status and feature mode fail closed", async () => {
    assert.equal((await call(api, { path: "/api/game-factory/config" })).res.statusCode, 401);
    assert.equal((await call(api, { path: "/api/game-factory/config", tenant: { ...owner, status: "locked" } })).res.statusCode, 403);
    const off = createGameFactoryHttp({ store, gate: createGameFactoryGate(), resolveTenant: (req) => req.tenant });
    const denied = await call(off, { path: "/api/game-factory/config", tenant: owner });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.res.json().code, "factory_disabled");
  });

  await test("bootstrap seeds the fixed portfolio and publishes server-derived actions", async () => {
    const { res } = await call(api, { path: "/api/game-factory/bootstrap", tenant: owner });
    assert.equal(res.statusCode, 200);
    const payload = res.json();
    assert.equal(payload.games.length, 10);
    assert.equal(payload.summary.total, 10);
    assert.equal(payload.games[0].name, "Vector Vault");
    assert.equal(payload.games[0].allowedActions.find((action) => action.id === "start")?.label, "Start game plan");
    assert.equal(payload.games[0].allowedActions.some((action) => action.id === "advance"), false);
    assert.deepEqual(payload.health.worker, health.worker);
  });

  const projectId = store.listProjects(owner.uid)[0].id;

  await test("configuration, detail and owner-only operations health are scoped", async () => {
    const config = (await call(api, { path: "/api/game-factory/config", tenant: owner })).res.json();
    assert.equal(config.owner, true);
    assert.equal(config.states.length, 16);
    assert.equal(config.requiredArtifacts.length, 11);
    const detail = await call(api, { path: `/api/game-factory/games/${encodeURIComponent(projectId)}`, tenant: owner });
    assert.equal(detail.res.statusCode, 200);
    assert.equal(detail.res.json().game.id, projectId);
    const all = createGameFactoryHttp({ store, gate: createGameFactoryGate("all"), resolveTenant: (req) => req.tenant });
    assert.equal((await call(all, { path: "/api/game-factory/health", tenant: member })).res.statusCode, 403);
    const ownHealth = await call(api, { path: "/api/game-factory/health", tenant: owner });
    assert.equal(ownHealth.res.statusCode, 200);
    assert.equal(ownHealth.res.json().store.ok, true);
  });

  await test("machine evidence endpoints fail closed without a trusted adapter", async () => {
    const browserOnly = createGameFactoryHttp({ store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant });
    const denied = await call(browserOnly, {
      method: "POST", path: `/api/game-factory/games/${projectId}/tests`, tenant: owner,
      body: { suite: "core-loop", status: "PASSED" },
    });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.res.json().code, "trusted_adapter_required");
  });

  await test("synthetic canary is exact-flag, verified-human-owner only and has a fixed input schema", async () => {
    const canaryPath = "/api/game-factory/admin/synthetic-canary";
    const canaryProjectId = store.listProjects(owner.uid)[9].id;
    assert.equal(store.getProject(owner.uid, canaryProjectId).workspaceRoot, "");
    const calls = [];
    const canaryApi = createGameFactoryHttp({
      store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant,
      syntheticCanary: {
        enabled: true,
        run: async (input) => {
          calls.push(input);
          return store.queueSyntheticCanary(input);
        },
      },
    });
    const validIdentity = { source: "jwt", verified: true, email: owner.email };
    const request = {
      method: "POST", path: canaryPath, tenant: owner, identity: validIdentity,
      actionHeader: "game-factory-synthetic-canary",
      headers: { "Idempotency-Key": "http-synthetic-canary-0001" }, body: { projectId: canaryProjectId },
    };

    assert.equal((await call(canaryApi, { ...request, tenant: undefined, identity: undefined })).res.statusCode, 401);
    assert.equal((await call(canaryApi, { ...request, tenant: member, identity: { ...validIdentity, email: member.email } })).res.statusCode, 403);
    for (const identity of [
      { source: "service-owner", verified: true, email: owner.email },
      { source: "jwt", verified: false, email: owner.email },
      { source: "header", verified: true, email: owner.email },
      { source: "jwt", verified: true, email: "different@example.com" },
    ]) {
      const denied = await call(canaryApi, { ...request, identity });
      assert.equal(denied.res.statusCode, 403);
      assert.equal(denied.res.json().code, "human_owner_required");
    }
    assert.equal(calls.length, 0);

    const wrongAction = await call(canaryApi, { ...request, actionHeader: true });
    assert.equal(wrongAction.res.statusCode, 403);
    assert.equal(wrongAction.res.json().code, "action_header_required");
    const get = await call(canaryApi, { path: canaryPath, tenant: owner, identity: validIdentity });
    assert.equal(get.res.statusCode, 405);
    const disabled = await call(api, request);
    assert.equal(disabled.res.statusCode, 404);
    assert.equal(disabled.res.json().code, "synthetic_canary_disabled");
    const missingKey = await call(canaryApi, { ...request, headers: {} });
    assert.equal(missingKey.res.statusCode, 400);
    assert.equal(missingKey.res.json().code, "bad_idempotency_key");
    const badKey = await call(canaryApi, { ...request, headers: { "Idempotency-Key": "http-canary;node=-e" } });
    assert.equal(badKey.res.statusCode, 400);
    assert.equal(badKey.res.json().code, "bad_idempotency_key");

    for (const body of [
      {},
      { projectId: canaryProjectId, capability: "release_coordination" },
      { projectId: canaryProjectId, executable: "powershell" },
      { projectId: canaryProjectId, argv: ["-Command", "whoami"] },
      { projectId: canaryProjectId, workspaceRoot: "C:\\" },
      { projectId: canaryProjectId, buildId: "forged" },
      { projectId: canaryProjectId, artifact: { key: "00_GAME_BRIEF" } },
      { projectId: canaryProjectId, release: { status: "RELEASED" } },
    ]) {
      const denied = await call(canaryApi, { ...request, body });
      assert.equal(denied.res.statusCode, 400, JSON.stringify(body));
      assert.equal(denied.res.json().code, "bad_canary_schema");
    }
    assert.equal(calls.length, 0);

    const first = await call(canaryApi, request);
    assert.equal(first.res.statusCode, 201, first.res.body);
    assert.equal(first.res.json().capability, "quality_assurance");
    assert.equal(first.res.json().effects.artifacts, false);
    assert.equal(calls.length, 1);
    const canaryTask = store.getProject(owner.uid, canaryProjectId).tasks
      .find((task) => task.id === first.res.json().taskId);
    assert.equal(canaryTask.payload.workerPlan.workspaceRoot, "/workspace/system-canary");
    assert.deepEqual(Object.keys(calls[0]).sort(), ["actor", "email", "key", "projectId", "tenant", "uid"]);
    assert.equal("node" in calls[0], false);
    assert.equal("workspaceRoot" in calls[0], false);
    assert.equal("argv" in calls[0], false);
    const replay = await call(canaryApi, request);
    assert.equal(replay.res.statusCode, 201);
    assert.equal(replay.res.json().replayed, true);
    assert.equal(replay.res.json().taskId, first.res.json().taskId);

    const genericTask = await call(canaryApi, {
      method: "POST", path: `/api/game-factory/games/${canaryProjectId}/tasks`, tenant: owner,
      body: { capability: "quality_assurance", payload: { workerPlan: { steps: [{ program: "node", args: ["--version"] }] } } },
    });
    assert.equal(genericTask.res.statusCode, 403);
    assert.equal(genericTask.res.json().code, "trusted_adapter_required");
  });

  await test("commands require concurrency and idempotency evidence", async () => {
    const unprotected = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner, actionHeader: false, body: { command: "start", expectedVersion: 1 } });
    assert.equal(unprotected.res.statusCode, 403);
    assert.equal(unprotected.res.json().code, "action_header_required");
    const missingVersion = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner, body: { command: "start" } });
    assert.equal(missingVersion.res.statusCode, 428);
    const version = store.getProject(owner.uid, projectId).version;
    const options = {
      method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "http-start-1" }, body: { command: "start", expectedVersion: version, payload: {} },
    };
    const first = await call(api, options);
    assert.equal(first.res.statusCode, 200);
    assert.equal(first.res.json().project.state, "SPECIFICATION");
    const replay = await call(api, options);
    assert.equal(replay.res.statusCode, 200);
    assert.equal(replay.res.json().replayed, true);
    assert.equal(plannerCalls.length, 2);
    assert.equal(plannerCalls[0].tenant, owner);
  });

  await test("starting fails closed when the trusted planner is unavailable", async () => {
    const unstartedId = store.listProjects(owner.uid).find((project) => project.state === "IDEA").id;
    const noPlanner = createGameFactoryHttp({
      store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant,
      authorizeEvidenceWrite: (_req, T) => T?.isOwner === true,
    });
    const version = store.getProject(owner.uid, unstartedId).version;
    const response = await call(noPlanner, {
      method: "POST", path: `/api/game-factory/games/${unstartedId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "no-planner-start" }, body: { command: "start", expectedVersion: version },
    });
    assert.equal(response.res.statusCode, 503);
    assert.equal(response.res.json().code, "planner_unavailable");
    assert.equal(store.getProject(owner.uid, unstartedId).state, "IDEA");
  });

  await test("the browser cannot issue machine-only transitions or approve missing evidence", async () => {
    for (const command of ["transition", "block", "attach_workspace"]) {
      const version = store.getProject(owner.uid, projectId).version;
      const denied = await call(api, {
        method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
        headers: { "Idempotency-Key": `reserved-${command}` },
        body: { command, expectedVersion: version, payload: command === "transition" ? { toState: "ARCHITECTURE" } : { reason: "skip" } },
      });
      assert.equal(denied.res.statusCode, 403, command);
      assert.equal(denied.res.json().code, "owner_command_not_allowed");
    }
    const version = store.getProject(owner.uid, projectId).version;
    const prematureAdvance = await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "premature-browser-advance" },
      body: { command: "advance", expectedVersion: version, payload: { toState: "ARCHITECTURE" } },
    });
    assert.equal(prematureAdvance.res.statusCode, 409);
    assert.equal(prematureAdvance.res.json().code, "owner_action_not_available");
    const detail = (await call(api, { path: `/api/game-factory/games/${projectId}`, tenant: owner })).res.json().game;
    assert.equal(detail.approvalNeeded, "");
    assert.match(detail.approvalBlocked, /subject does not exist yet|not durably mirrored/i);
  });

  await test("approval decisions are available only for the exact verified subject", async () => {
    recordVerifiedArtifact(projectId, "00_GAME_BRIEF", "a");
    recordVerifiedArtifact(projectId, "01_MARKET_CASE", "b");
    recordVerifiedArtifact(projectId, "02_RELEASE_ROADMAP", "c");
    recordVerifiedArtifact(projectId, "03_BUILD_WORKFLOW", "d");
    const detail = (await call(api, { path: `/api/game-factory/games/${projectId}`, tenant: owner })).res.json().game;
    const approve = detail.allowedActions.find((action) => action.id === "approve");
    assert.equal(detail.approvalNeeded, "SPECIFICATION");
    assert.match(approve.subjectHash, /^[a-f0-9]{64}$/);
    assert.equal(approve.requiresConfirmation, true);

    const noRationale = await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "reject-no-rationale" },
      body: { command: "reject", expectedVersion: detail.version, payload: approve.commandPayload },
    });
    assert.equal(noRationale.res.statusCode, 400);
    assert.equal(noRationale.res.json().code, "rejection_rationale_required");

    const wrongSubject = await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "approve-wrong-subject" },
      body: { command: "approve", expectedVersion: detail.version, payload: { ...approve.commandPayload, subjectHash: "0".repeat(64) } },
    });
    assert.equal(wrongSubject.res.statusCode, 409);
    assert.equal(wrongSubject.res.json().code, "approval_subject_mismatch");

    const exact = await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "approve-exact-subject" },
      body: { command: "approve", expectedVersion: detail.version, payload: approve.commandPayload },
    });
    assert.equal(exact.res.statusCode, 200, JSON.stringify(exact.res.json()));
    assert.equal(exact.res.json().project.state, "SPECIFICATION");
    const replay = await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "approve-exact-subject" },
      body: { command: "approve", expectedVersion: detail.version, payload: approve.commandPayload },
    });
    assert.equal(replay.res.statusCode, 200);
    assert.equal(replay.res.json().replayed, true);
  });

  await test("body parsing is bounded and does not confuse ordinary error fields", async () => {
    const bad = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/tasks`, tenant: owner, rawBody: "{" });
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.res.json().code, "bad_json");
    const badShape = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/tasks`, tenant: owner, rawBody: "null" });
    assert.equal(badShape.res.statusCode, 400);
    assert.equal(badShape.res.json().code, "bad_json_shape");
    const tooLarge = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/tasks`, tenant: owner, rawBody: "x".repeat(1024 * 1024 + 1) });
    assert.equal(tooLarge.res.statusCode, 413);
    const ordinary = await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/tasks`, tenant: owner,
      body: { capability: "product_planning", title: "Plan", payload: { error: "a domain value, not a parser error" } },
    });
    assert.equal(ordinary.res.statusCode, 201);
  });

  await test("build, artifact, copy, test and release evidence use tenant-scoped endpoints", async () => {
    const build = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/builds`, tenant: owner, body: { sourceCommit: "abc123", targets: ["android"] } });
    assert.equal(build.res.statusCode, 201);
    const buildId = build.res.json().buildId;
    const artifact = await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/artifacts`, tenant: owner, body: { artifactKey: "00_GAME_BRIEF", sha256: "a".repeat(64), size: 5, mimeType: "text/markdown" } });
    assert.equal(artifact.res.statusCode, 201);
    const copy = await call(api, { method: "POST", path: `/api/game-factory/artifacts/${artifact.res.json().artifactId}/copies`, tenant: owner, body: { backend: "primary", status: "VERIFIED", fingerprint: "a".repeat(64), locator: "local://brief" } });
    assert.equal(copy.res.statusCode, 200);
    const nativeDenied = await call(api, { method: "POST", path: `/api/game-factory/artifacts/${artifact.res.json().artifactId}/copies`, tenant: owner, body: { backend: "chatgpt_project", status: "VERIFIED", fingerprint: "a".repeat(64), locator: "browser://forged" } });
    assert.equal(nativeDenied.res.statusCode, 403);
    assert.equal(nativeDenied.res.json().code, "native_project_evidence_offline_only");
    assert.equal((await call(api, { method: "POST", path: `/api/game-factory/games/${projectId}/tests`, tenant: owner, body: { buildId, suite: "core-loop", status: "PASSED", sourceHash: "abc123" } })).res.statusCode, 201);
    assert.equal((await call(api, {
      method: "POST", path: `/api/game-factory/games/${projectId}/releases`, tenant: owner,
      body: { buildId, platform: "android", packageId: "tools.dominion.test", versionName: "0.1.0", versionCode: 1, status: "READY" },
    })).res.statusCode, 201);
  });

  await test("artifact content review is owner-only, allowlisted, bounded, integrity-checked and inert", async () => {
    const viewerProjectId = store.listProjects(owner.uid)[2].id;
    const safe = recordLocalArtifact(viewerProjectId, "00_GAME_BRIEF", "# Review\n<script>alert('still text')</script>\n");
    const invalidUtf8 = recordLocalArtifact(viewerProjectId, "01_MARKET_CASE", Buffer.from([0xc3, 0x28]), "text/plain");
    recordLocalArtifact(viewerProjectId, "02_RELEASE_ROADMAP", "{}", "application/json");
    recordLocalArtifact(viewerProjectId, "03_BUILD_WORKFLOW", "small", "text/plain", 512 * 1024 + 1);
    const bytesByArtifact = new Map([[safe.artifactId, safe.bytes], [invalidUtf8.artifactId, invalidUtf8.bytes]]);
    const reads = [];
    const viewerApi = createGameFactoryHttp({
      store, gate: createGameFactoryGate("all"), resolveTenant: (req) => req.tenant,
      readArtifactContent: async (request) => { reads.push(request); return { data: bytesByArtifact.get(request.artifact.id) }; },
    });

    const config = (await call(viewerApi, { path: "/api/game-factory/config", tenant: owner })).res.json();
    assert.deepEqual(config.artifactViewer, {
      enabled: true, maxBytes: 512 * 1024, mimeTypes: ["text/markdown", "text/plain"],
      renderMode: "plain_text", markdownExecution: false,
    });
    const detail = (await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}`, tenant: owner })).res.json().game;
    const safeMetadata = detail.artifacts.find((artifact) => artifact.artifactKey === "00_GAME_BRIEF");
    assert.deepEqual(safeMetadata.viewer, { enabled: true, maxBytes: 512 * 1024, renderMode: "plain_text", markdownExecution: false });
    assert.equal("provenance" in safeMetadata, false, "storage provenance is not browser review data");
    assert.equal("locator" in safeMetadata.copies[0], false, "copy locators stay inside the trusted mirror boundary");
    assert.equal(detail.artifacts.find((artifact) => artifact.artifactKey === "02_RELEASE_ROADMAP").viewer.code, "artifact_not_text");
    assert.equal(detail.artifacts.find((artifact) => artifact.artifactKey === "03_BUILD_WORKFLOW").viewer.code, "artifact_content_too_large");

    const contentPath = `/api/game-factory/games/${viewerProjectId}/artifacts/00_GAME_BRIEF/content`;
    const opened = await call(viewerApi, { path: contentPath, tenant: owner });
    assert.equal(opened.res.statusCode, 200);
    assert.equal(opened.res.headers["x-content-type-options"], "nosniff");
    assert.equal(opened.res.json().content, safe.bytes.toString("utf8"));
    assert.deepEqual(opened.res.json().viewer, { renderMode: "plain_text", markdownExecution: false });
    assert.equal(opened.res.json().artifact.id, safe.artifactId);
    assert.equal(opened.res.json().artifact.complete, false, "a verified local view must not imply every required mirror is complete");
    assert.equal(reads[0].uid, owner.uid);
    assert.equal(reads[0].projectId, viewerProjectId);
    assert.equal(reads[0].artifact.id, safe.artifactId, "the callback receives only the server-selected current artifact");
    assert.equal(reads[0].maxBytes, 512 * 1024);

    const memberDenied = await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/%ZZ/content`, tenant: member });
    assert.equal(memberDenied.res.statusCode, 403, "owner wall runs before parsing or looking up an artifact");
    assert.equal(memberDenied.res.json().code, "owner_only");
    const otherOwner = { ...owner, uid: "other-owner-uid", email: "other@example.com" };
    assert.equal((await call(viewerApi, { path: contentPath, tenant: otherOwner })).res.statusCode, 404);
    assert.equal((await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/%ZZ/content`, tenant: owner })).res.json().code, "bad_artifact_identity");
    assert.equal((await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/NOT_REQUIRED/content`, tenant: owner })).res.json().code, "artifact_not_required");
    assert.equal((await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/05_VISUAL_SYSTEM/content`, tenant: owner })).res.json().code, "artifact_not_recorded");
    assert.equal((await call(viewerApi, { method: "POST", path: contentPath, tenant: owner, body: {} })).res.statusCode, 405);

    const notConfigured = await call(api, { path: contentPath, tenant: owner });
    assert.equal(notConfigured.res.statusCode, 503);
    assert.equal(notConfigured.res.json().code, "artifact_reader_unconfigured");
    assert.match(notConfigured.res.json().error, /not configured/i);

    const wrongBytesApi = createGameFactoryHttp({
      store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant,
      readArtifactContent: async () => Buffer.alloc(safe.bytes.length, 0x78),
    });
    const conflict = await call(wrongBytesApi, { path: contentPath, tenant: owner });
    assert.equal(conflict.res.statusCode, 409);
    assert.equal(conflict.res.json().code, "artifact_content_conflict");

    const invalid = await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/01_MARKET_CASE/content`, tenant: owner });
    assert.equal(invalid.res.statusCode, 415);
    assert.equal(invalid.res.json().code, "artifact_text_invalid");
    assert.equal((await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/02_RELEASE_ROADMAP/content`, tenant: owner })).res.statusCode, 415);
    assert.equal((await call(viewerApi, { path: `/api/game-factory/games/${viewerProjectId}/artifacts/03_BUILD_WORKFLOW/content`, tenant: owner })).res.statusCode, 413);
  });

  await test("preview is a server-derived client action only for a durable workspace build", async () => {
    const previewProjectId = store.listProjects(owner.uid)[1].id;
    let commandIndex = 0;
    const command = (type, payload = {}) => {
      const current = store.getProject(owner.uid, previewProjectId);
      const result = store.executeCommand({
        uid: owner.uid, projectId: previewProjectId, key: `preview-setup-${++commandIndex}`,
        expectedVersion: current.version, type, payload, actor: owner.email,
      });
      assert.ok([200, 202].includes(result.status), `${type}: ${JSON.stringify(result.body)}`);
      return result;
    };
    command("advance");
    recordVerifiedArtifact(previewProjectId, "00_GAME_BRIEF", "5");
    recordVerifiedArtifact(previewProjectId, "01_MARKET_CASE", "6");
    recordVerifiedArtifact(previewProjectId, "02_RELEASE_ROADMAP", "7");
    recordVerifiedArtifact(previewProjectId, "03_BUILD_WORKFLOW", "8");
    command("approve", { gate: "SPECIFICATION", subjectHash: store.getApprovalSubject(owner.uid, previewProjectId, "SPECIFICATION").hash });
    command("advance");
    recordVerifiedArtifact(previewProjectId, "04_GAME_ARCHITECTURE", "9");
    recordVerifiedArtifact(previewProjectId, "05_VISUAL_SYSTEM", "e");
    command("approve", { gate: "VISUAL_SYSTEM", subjectHash: store.getApprovalSubject(owner.uid, previewProjectId, "VISUAL_SYSTEM").hash });
    command("advance");
    command("advance");
    command("attach_workspace", { workspaceId: "ws-preview-verified" });
    const build = store.createBuild({ uid: owner.uid, projectId: previewProjectId, sourceCommit: "preview-commit", targets: ["android", "ios"] });
    assert.equal(build.status, 201);

    const detail = (await call(api, { path: `/api/game-factory/games/${previewProjectId}`, tenant: owner })).res.json().game;
    const preview = detail.allowedActions.find((action) => action.id === "preview");
    assert.deepEqual(preview, { id: "preview", label: "Try current workspace build", kind: "secondary", clientAction: "preview" });
    assert.ok(!detail.allowedActions.some((action) => action.id === "advance"), "implementation progress must remain machine-controlled");

    const denied = await call(api, {
      method: "POST", path: `/api/game-factory/games/${previewProjectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "preview-is-not-command" },
      body: { command: "preview", expectedVersion: detail.version, payload: {} },
    });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.res.json().code, "owner_command_not_allowed");

    const paused = await call(api, {
      method: "POST", path: `/api/game-factory/games/${previewProjectId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "preview-project-pause" },
      body: { command: "pause", expectedVersion: detail.version, payload: {} },
    });
    assert.equal(paused.res.statusCode, 200);
    const pausedDetail = (await call(api, { path: `/api/game-factory/games/${previewProjectId}`, tenant: owner })).res.json().game;
    assert.equal(pausedDetail.state, "PAUSED");
    assert.equal(pausedDetail.resumeState, "IMPLEMENTATION");
    assert.ok(pausedDetail.progress > 0, "a truthful pause keeps progress at its durable resume stage");
  });

  await test("durable SSE replays ordered project events and accepts Last-Event-ID", async () => {
    const req = makeRequest({ path: `/api/game-factory/events?projectId=${encodeURIComponent(projectId)}`, tenant: owner, headers: { "Last-Event-ID": "0" } });
    const res = new Response();
    await api.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.match(res.body, /event: project\.created/);
    assert.match(res.body, /event: project\.transitioned/);
    const ids = [...res.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.ok(ids.length >= 2);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    req.emit("close");
    res.emit("close");
  });

  await test("unknown routes and cross-tenant project identifiers do not disclose data", async () => {
    assert.equal((await call(api, { path: "/api/game-factory/nope", tenant: owner })).res.statusCode, 404);
    const all = createGameFactoryHttp({ store, gate: createGameFactoryGate("all"), resolveTenant: (req) => req.tenant });
    assert.equal((await call(all, { path: `/api/game-factory/games/${projectId}`, tenant: member })).res.statusCode, 404);
  });

  await test("Run to playtest sits beside Start game plan at IDEA, routes to the injected supervisor, and 503s fail-closed without one", async () => {
    const config = (await call(api, { path: "/api/game-factory/config", tenant: owner })).res.json();
    assert.equal(config.toolchain, "web-canvas");

    const ideaId = store.listProjects(owner.uid)[3].id;
    const supervisorCalls = [];
    const withSupervisor = createGameFactoryHttp({
      store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant,
      supervisor: {
        runToPlaytest: async (input) => { supervisorCalls.push(input); return { status: 200, body: { project: { id: input.projectId } } }; },
        getAutopilot: (id) => id === ideaId,
      },
      builds: { exists: () => false, resolveFile: () => null, summary: () => ({ status: "BUILT", versionName: "0.1.1", bundleSha256: "e".repeat(64), fileCount: 12, qa: { passed: 12, failed: 0, suites: {} } }) },
    });

    const detail = (await call(withSupervisor, { path: `/api/game-factory/games/${ideaId}`, tenant: owner })).res.json().game;
    const runAction = detail.allowedActions.find((action) => action.id === "run_to_playtest");
    const startAction = detail.allowedActions.find((action) => action.id === "start");
    assert.ok(runAction, "run_to_playtest must be offered at IDEA");
    assert.equal(runAction.label, "Run to playtest");
    assert.equal(runAction.kind, "primary");
    assert.equal(runAction.requiresConfirmation, true);
    assert.match(runAction.confirmNote, /records your approval of the specification and visual system in advance/);
    assert.ok(startAction, "the manual Start game plan path must remain available");
    assert.equal(startAction.label, "Start game plan");
    assert.equal(detail.autopilot, true, "autopilot reads from the injected supervisor.getAutopilot");
    assert.equal(detail.build, null, "IDEA has no activeBuild yet, so build stays null even with a summary adapter injected");

    const version = store.getProject(owner.uid, ideaId).version;
    const routed = await call(withSupervisor, {
      method: "POST", path: `/api/game-factory/games/${ideaId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "run-to-playtest-1" },
      body: { command: "run_to_playtest", expectedVersion: version, payload: {} },
    });
    assert.equal(routed.res.statusCode, 200, JSON.stringify(routed.res.json()));
    assert.equal(supervisorCalls.length, 1);
    assert.equal(supervisorCalls[0].projectId, ideaId);
    assert.equal(supervisorCalls[0].uid, owner.uid);
    assert.equal(supervisorCalls[0].actor, owner.email);

    // The default api instance in this file has no supervisor injected: fail closed, not a crash.
    const noSupervisor = await call(api, {
      method: "POST", path: `/api/game-factory/games/${ideaId}/commands`, tenant: owner,
      headers: { "Idempotency-Key": "run-to-playtest-no-supervisor" },
      body: { command: "run_to_playtest", expectedVersion: version, payload: {} },
    });
    assert.equal(noSupervisor.res.statusCode, 503);
    assert.equal(noSupervisor.res.json().code, "supervisor_unavailable");
    assert.equal(store.getProject(owner.uid, ideaId).state, "IDEA", "a 503 must not mutate the durable record");
  });

  await test("preview carries a server-served bundle previewUrl once builds.exists is true, defaults to secondary until PLAYTEST_READY, and the fail-closed default builds adapter keeps the old behavior", async () => {
    const bundleProjectId = store.listProjects(owner.uid)[4].id;
    let commandIndex = 0;
    const command = (type, payload = {}) => {
      const current = store.getProject(owner.uid, bundleProjectId);
      const result = store.executeCommand({
        uid: owner.uid, projectId: bundleProjectId, key: `bundle-preview-setup-${++commandIndex}`,
        expectedVersion: current.version, type, payload, actor: owner.email,
      });
      assert.ok([200, 202].includes(result.status), `${type}: ${JSON.stringify(result.body)}`);
      return result;
    };
    command("advance");
    recordVerifiedArtifact(bundleProjectId, "00_GAME_BRIEF", "1");
    recordVerifiedArtifact(bundleProjectId, "01_MARKET_CASE", "2");
    recordVerifiedArtifact(bundleProjectId, "02_RELEASE_ROADMAP", "3");
    recordVerifiedArtifact(bundleProjectId, "03_BUILD_WORKFLOW", "4");
    command("approve", { gate: "SPECIFICATION", subjectHash: store.getApprovalSubject(owner.uid, bundleProjectId, "SPECIFICATION").hash });
    command("advance");
    recordVerifiedArtifact(bundleProjectId, "04_GAME_ARCHITECTURE", "5");
    recordVerifiedArtifact(bundleProjectId, "05_VISUAL_SYSTEM", "6");
    command("approve", { gate: "VISUAL_SYSTEM", subjectHash: store.getApprovalSubject(owner.uid, bundleProjectId, "VISUAL_SYSTEM").hash });
    command("advance");
    command("advance");
    const build = store.createBuild({ uid: owner.uid, projectId: bundleProjectId, sourceCommit: "bundle-commit", targets: ["android", "ios"] });
    assert.equal(build.status, 201, JSON.stringify(build.body));
    const buildId = build.body.buildId;
    assert.equal(store.getProject(owner.uid, bundleProjectId).state, "IMPLEMENTATION");

    const existsCalls = [];
    const bundleApi = createGameFactoryHttp({
      store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant,
      builds: {
        exists: (args) => { existsCalls.push(args); return args.buildId === buildId; },
        resolveFile: () => null, summary: () => null,
      },
    });
    const detail = (await call(bundleApi, { path: `/api/game-factory/games/${bundleProjectId}`, tenant: owner })).res.json().game;
    const preview = detail.allowedActions.find((action) => action.id === "preview");
    assert.deepEqual(preview, {
      id: "preview", label: "Play current build", kind: "secondary", clientAction: "preview",
      previewUrl: `/api/game-factory/games/${bundleProjectId}/builds/${buildId}/play/index.html`,
    });
    assert.equal(existsCalls[0].uid, owner.uid);
    assert.equal(existsCalls[0].projectId, bundleProjectId);
    assert.equal(existsCalls[0].buildId, buildId);

    // No builds adapter injected: the fail-closed default (exists always false) must fall back to
    // the pre-existing tunnel-only behavior, i.e. no preview action at all without a workspaceId.
    const noBundleDetail = (await call(api, { path: `/api/game-factory/games/${bundleProjectId}`, tenant: owner })).res.json().game;
    assert.equal(noBundleDetail.allowedActions.some((action) => action.id === "preview"), false);
  });

  await test("the play route serves the resolved bundle file with a locked-down CSP, 404s a missing file, and refuses a decoded traversal or absolute path before calling the resolver", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "dominion-gamefactory-bundle-"));
    writeFileSync(join(bundleDir, "index.html"), "<!doctype html><title>t</title>");
    const resolveCalls = [];
    const buildsMock = {
      exists: () => true, summary: () => null,
      resolveFile: ({ uid: u, projectId: p, buildId: b, relPath }) => {
        resolveCalls.push({ uid: u, projectId: p, buildId: b, relPath });
        return relPath === "index.html" ? { absolute: join(bundleDir, "index.html"), mime: "text/html; charset=utf-8", size: 10 } : null;
      },
    };
    // verifiedHumanFactoryOwner only ever returns true under gate mode "owner" (it checks the mode
    // itself, not just tenant.isOwner), so the owner-path assertions below need gate "owner". Testing
    // that a non-owner is refused specifically by the route's ownerOnly wall flag (not merely by the
    // gate) needs gate "all", the same pattern the artifact-content-review test above uses.
    const playApi = createGameFactoryHttp({ store, gate: createGameFactoryGate("owner"), resolveTenant: (req) => req.tenant, builds: buildsMock });
    const playApiAll = createGameFactoryHttp({ store, gate: createGameFactoryGate("all"), resolveTenant: (req) => req.tenant, builds: buildsMock });
    const validIdentity = { source: "jwt", verified: true, email: owner.email };
    const playPath = `/api/game-factory/games/${projectId}/builds/build-xyz/play/index.html`;

    assert.equal((await call(playApi, { path: playPath })).res.statusCode, 401, "sign-in is required first, like every other route");

    const notHuman = await call(playApi, { path: playPath, tenant: owner });
    assert.equal(notHuman.res.statusCode, 403);
    assert.equal(notHuman.res.json().code, "human_owner_required", "an owner tenant without a verified human JWT still cannot play a build");

    const memberDenied = await call(playApiAll, { path: playPath, tenant: member, identity: { source: "jwt", verified: true, email: member.email } });
    assert.equal(memberDenied.res.statusCode, 403);
    assert.equal(memberDenied.res.json().code, "owner_only");

    const served = await call(playApi, { path: playPath, tenant: owner, identity: validIdentity });
    assert.equal(served.res.statusCode, 200, JSON.stringify(served.res.body));
    assert.equal(served.res.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(served.res.headers["cache-control"], "no-store");
    assert.equal(served.res.headers["x-content-type-options"], "nosniff");
    assert.match(served.res.headers["content-security-policy"], /default-src 'self'/);
    assert.match(served.res.headers["content-security-policy"], /script-src 'self'/);
    assert.match(served.res.headers["content-security-policy"], /connect-src 'none'/);
    assert.match(served.res.headers["content-security-policy"], /frame-ancestors 'self'/);
    assert.equal(served.res.body, "<!doctype html><title>t</title>");
    assert.equal(resolveCalls[0].relPath, "index.html");
    assert.equal(resolveCalls[0].buildId, "build-xyz");
    assert.equal(resolveCalls[0].uid, owner.uid);

    const bare = await call(playApi, { path: `/api/game-factory/games/${projectId}/builds/build-xyz/play`, tenant: owner, identity: validIdentity });
    assert.equal(bare.res.statusCode, 200, "a bare /play defaults to index.html");

    const missing = await call(playApi, { path: `/api/game-factory/games/${projectId}/builds/build-xyz/play/missing.js`, tenant: owner, identity: validIdentity });
    assert.equal(missing.res.statusCode, 404);
    assert.equal(missing.res.json().code, "not_found");

    // A literal ".." or single-percent-encoded "%2e%2e" is already collapsed by the WHATWG URL
    // parser before this handler ever sees it (verified: both routes end up 404 "unknown route"
    // because the parser consumes the "play" segment along with the dot-segment). The route's own
    // ".." rejection is defense in depth for a caller that hands in an unnormalized URL, and it is
    // exercised here through an encoding the URL parser does NOT collapse: a backslash next to an
    // encoded ".." decodes, after this route's own decodeURIComponent, to a real ".." string.
    const beforeTraversal = resolveCalls.length;
    const traversal = await call(playApi, { path: `/api/game-factory/games/${projectId}/builds/build-xyz/play/%5c%2e%2e%5csecrets.env`, tenant: owner, identity: validIdentity });
    assert.equal(traversal.res.statusCode, 400);
    assert.equal(traversal.res.json().code, "bad_play_path");
    assert.equal(resolveCalls.length, beforeTraversal, "a decoded traversal must never reach the resolver");

    const absolute = await call(playApi, { path: `/api/game-factory/games/${projectId}/builds/build-xyz/play/%2fetc/passwd`, tenant: owner, identity: validIdentity });
    assert.equal(absolute.res.statusCode, 400);
    assert.equal(absolute.res.json().code, "bad_play_path");
    assert.equal(resolveCalls.length, beforeTraversal, "a decoded absolute path must never reach the resolver either");

    const noBuildsAdapter = await call(api, { path: playPath, tenant: owner, identity: validIdentity });
    assert.equal(noBuildsAdapter.res.statusCode, 404, "the fail-closed default builds adapter 404s rather than ever reading a file");

    rmSync(bundleDir, { recursive: true, force: true });
  });

  console.log(`\n${n} game factory HTTP tests passed`);
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
