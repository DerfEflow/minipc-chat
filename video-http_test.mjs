import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createVideoHttp, openRouterUsageCost } from "./video-http.mjs";
import { createVideoFeature } from "./video.mjs";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MOBILE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "job_123";
const screenplaySha = (text = "") => createHash("sha256").update(String(text)).digest("hex");
const attemptCommands = (env) => env.calls
  .filter((entry) => entry[0] === "applyCommand" && entry[3]?.type === "screenwriter.attempt")
  .map((entry) => entry[3].attempt);
const canonicalAttempts = (env, generationId) => attemptCommands(env)
  .filter((attempt) => !String(attempt.attemptId || "").startsWith("sw_local_") && (!generationId || attempt.generationId === generationId));

test("OpenRouter usage cost accepts only an authoritative nonnegative report", () => {
  assert.equal(openRouterUsageCost({ cost: 0 }), 0);
  assert.equal(openRouterUsageCost({ cost: "0.00123456789" }), 0.00123457);
  assert.throws(() => openRouterUsageCost({ cost: null, prompt_tokens: 1_000, completion_tokens: 200 }), /usage\.cost/);
  assert.throws(() => openRouterUsageCost({ cost: "invalid", prompt_tokens: 1_000, completion_tokens: 200 }), /usage\.cost/);
});

function request(method, url, body, headers = {}) {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = url;
  req.headers = { ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}), ...headers };
  return req;
}

function response() {
  const events = new EventEmitter();
  let resolveFirstWrite;
  const firstWrite = new Promise((resolve) => { resolveFirstWrite = resolve; });
  return {
    statusCode: 0,
    headers: {},
    raw: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    deferFinish: false,
    firstWrite,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; this.headersSent = true; },
    flushHeaders() { this.flushed = true; },
    once(event, listener) { events.once(event, listener); return this; },
    off(event, listener) { events.off(event, listener); return this; },
    write(value = "") { const chunk = value ? String(value) : ""; this.raw += chunk; resolveFirstWrite?.(chunk); resolveFirstWrite = null; events.emit("write", chunk); return true; },
    end(value = "") { this.raw += value ? String(value) : ""; this.ended = true; this.writableEnded = true; if (!this.deferFinish) events.emit("finish"); },
    releaseFinish() { events.emit("finish"); },
    destroy(error) { this.destroyed = true; this.destroyError = error; this.writableEnded = true; events.emit("close"); },
    get json() { return this.raw && !String(this.headers["content-type"] || "").includes("text/event-stream") ? JSON.parse(this.raw) : null; },
  };
}

const desktopCapabilities = new WeakMap();
function parseEventStream(raw) {
  const events = [];
  for (const block of String(raw || "").replaceAll("\r\n", "\n").split("\n\n")) {
    if (!block.trim() || block.trimStart().startsWith(":")) continue;
    let event = "message"; const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

function completedResponse(req, res, handled) {
  if (!String(res.headers["content-type"] || "").includes("text/event-stream")) return { handled, req, res, body: res.json };
  const events = parseEventStream(res.raw); const terminal = [...events].reverse().find((item) => item.event === "result" || item.event === "error");
  res.events = events;
  if (terminal?.event === "error") res.statusCode = Number(terminal.data?.status) || 500;
  return { handled, req, res, body: terminal?.data || null };
}

async function call(http, method, path, body, headers = {}) {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(String(headers["user-agent"] || ""));
  if (path.startsWith("/api/video") && !["GET", "HEAD", "OPTIONS"].includes(method) && !mobile && !headers["x-dominion-desktop-capability"]) {
    let capability = desktopCapabilities.get(http);
    if (!capability) {
      const configReq = request("GET", "/api/video/config?device=desktop", undefined, { "user-agent": "Mozilla/5.0 Desktop" });
      const configRes = response();
      await http.handle(configReq, configRes, new URL(configReq.url, "http://test.local"));
      capability = configRes.json?.desktopCapability;
      if (capability) desktopCapabilities.set(http, capability);
    }
    if (capability) headers = { ...headers, "x-dominion-desktop-capability": capability };
  }
  if (method === "POST" && path === "/api/video/screenwrite" && !Object.hasOwn(headers, "accept")) headers = { ...headers, accept: "text/event-stream" };
  const req = request(method, path, body, headers);
  const res = response();
  const handled = await http.handle(req, res, new URL(path, "http://test.local"));
  return completedResponse(req, res, handled);
}

async function startCall(http, method, path, body, headers = {}) {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(String(headers["user-agent"] || ""));
  if (path.startsWith("/api/video") && !["GET", "HEAD", "OPTIONS"].includes(method) && !mobile && !headers["x-dominion-desktop-capability"]) {
    let capability = desktopCapabilities.get(http);
    if (!capability) {
      const configReq = request("GET", "/api/video/config?device=desktop", undefined, { "user-agent": "Mozilla/5.0 Desktop" });
      const configRes = response();
      await http.handle(configReq, configRes, new URL(configReq.url, "http://test.local"));
      capability = configRes.json?.desktopCapability;
      if (capability) desktopCapabilities.set(http, capability);
    }
    if (capability) headers = { ...headers, "x-dominion-desktop-capability": capability };
  }
  if (method === "POST" && path === "/api/video/screenwrite" && !Object.hasOwn(headers, "accept")) headers = { ...headers, accept: "text/event-stream" };
  const req = request(method, path, body, headers);
  const res = response();
  const completion = http.handle(req, res, new URL(path, "http://test.local")).then((handled) => completedResponse(req, res, handled));
  return { req, res, completion };
}

function project(id = PROJECT_ID, tenantId = "tenant_a") {
  return {
    id, tenantId, name: "Launch film", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    screenplay: { text: "FADE IN", tokens: 2 }, scenes: [],
    timeline: { videoTracks: [1, 2, 3].map((n) => ({ id: `v${n}`, kind: "video", clips: [] })), audioTracks: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, kind: "audio", clips: [] })) },
    ai: { director: { state: {} }, visualOrchestrator: { state: {} }, liaison: { state: {} } }, conversation: [], jobs: [], providerAttempts: [], history: { head: 1 },
  };
}

function featureMock(overrides = {}) {
  const calls = [];
  const projects = new Map([[PROJECT_ID, project()]]);
  const feature = {
    MAX_SCENES: 100, MAX_SCREENPLAY_TOKENS: 115_000, VIDEO_TRACKS: 3, AUDIO_TRACKS: 4,
    capabilities: { "google:gemini@omni-flash": { modes: ["text"], ratios: ["16:9"], resolutions: ["720p"] } },
    listProjects(tenantId) { calls.push(["listProjects", tenantId]); return [...projects.values()].filter((p) => p.tenantId === tenantId).map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })); },
    createProject(tenantId, input) { calls.push(["createProject", tenantId, input]); const id = projects.has(PROJECT_ID) ? MOBILE_PROJECT_ID : PROJECT_ID; const value = project(id, tenantId); value.name = input.name; projects.set(id, value); return value; },
    getProject(tenantId, id) { calls.push(["getProject", tenantId, id]); const value = projects.get(id); if (!value || value.tenantId !== tenantId) { const error = new Error("Video project not found."); error.status = 404; error.code = "video_project_missing"; throw error; } return structuredClone(value); },
    getClientProject(tenantId, id) { calls.push(["getClientProject", tenantId, id]); const value = feature.getProject(tenantId, id); return { project: { id: value.id, name: value.name, model: "google:gemini@omni-flash", ratio: "16:9", resolution: "720p" }, projectRevision: value.history.head, screenplay: value.screenplay.text, screenplaySha256: screenplaySha(value.screenplay.text), scenes: [], tracks: [], clips: [], ui: {} }; },
    checkpointProject(tenantId, id, input) {
      calls.push(["checkpointProject", tenantId, id, input]); const value = projects.get(id); feature.getProject(tenantId, id);
      if (input.expectedProjectRevision !== value.history.head) { const error = new Error("stale project"); error.status = 409; error.code = "video_project_revision_stale"; throw error; }
      if (input.expectedScreenplaySha256 !== screenplaySha(value.screenplay.text)) { const error = new Error("stale checkpoint"); error.status = 409; error.code = "video_checkpoint_stale"; throw error; }
      if (value.providerAttempts.some((attempt) => !new Set(["applied", "rejected", "provider_http_rejected", "provider_contract_rejected", "provider_correlated", "quarantined_stale_settled", "operator_quarantined"]).has(String(attempt.status || "")))) { const error = new Error("screenwriter busy"); error.status = 409; error.code = "screenwriter_busy"; throw error; }
      if (typeof input.state?.screenplay === "string") value.screenplay.text = input.state.screenplay;
      value.updatedAt = "2026-01-02T00:00:00.000Z"; value.history.head++;
      return { ...structuredClone(value), label: input.label, head: value.history.head, ai: { screenwriter: { state: { reasoningDetails: [{ text: "opaque-checkpoint-secret" }] } } } };
    },
    renameProject(tenantId, id, name) { calls.push(["renameProject", tenantId, id, name]); const value = projects.get(id); value.name = name; return value; },
    deleteProject(tenantId, id, input) { calls.push(["deleteProject", tenantId, id, input]); feature.getProject(tenantId, id); projects.delete(id); return { deleted: true, id }; },
    applyCommand(tenantId, id, command) {
      calls.push(["applyCommand", tenantId, id, command]); const value = projects.get(id); feature.getProject(tenantId, id);
      if (command.type === "screenwriter.attempt") {
        const index = value.providerAttempts.findIndex((item) => item.attemptId === command.attempt.attemptId);
        if (index >= 0) value.providerAttempts[index] = structuredClone(command.attempt); else value.providerAttempts.push(structuredClone(command.attempt));
      } else if (command.type === "screenplay.set") {
        value.screenplay.text = command.text;
        const match = value.providerAttempts.find((item) => item.attemptId === command.attemptId);
        if (match) { match.status = "applied"; match.settlement = { status: "settled", costUsd: Number(command.usage?.cost) || 0 }; }
        value.ai.screenwriter = { state: { generationId: command.generationId, generatedSections: command.generatedSections } };
      }
      value.history.head++;
      return { ok: true };
    },
    updateAiState(tenantId, id, state) {
      calls.push(["updateAiState", tenantId, id, state]); const value = projects.get(id); feature.getProject(tenantId, id);
      const planStale = value.history.head !== state.expectedProjectRevision;
      for (const role of ["director", "visualOrchestrator", "liaison"]) {
        if (state[role]) value.ai[role].state = { ...structuredClone(value.ai[role]?.state || {}), ...structuredClone(state[role]) };
      }
      if (state.visualOrchestrator) value.ai.visualOrchestrator.state.applyStatus = state.visualPlanScenes ? (planStale ? "quarantined_stale" : "applied") : "unavailable";
      if (state.visualPlanScenes && !planStale) value.scenes = structuredClone(state.visualPlanScenes);
      if (state.conversation) {
        value.conversation.push({ role: "user", content: state.conversation.user, at: state.conversation.at });
        value.conversation.push({ role: "assistant", content: state.conversation.reply, at: state.conversation.at });
      }
      value.history.head++;
      return structuredClone(value);
    },
    submitGeneration(tenantId, id, input) { calls.push(["submitGeneration", tenantId, id, input]); const value = projects.get(id); value.jobs.push({ id: JOB_ID, status: "generating", request: input }); return { jobId: JOB_ID, taskUuid: JOB_ID, project: id }; },
    pollJob(tenantId, id, jobId) { calls.push(["pollJob", tenantId, id, jobId]); feature.getProject(tenantId, id); return { id: jobId, status: "generating", request: { duration: 5 } }; },
    downloadJobOutput(tenantId, id, jobId) { calls.push(["downloadJobOutput", tenantId, id, jobId]); return { id: jobId, status: "ready", localOutput: `Z:/data/${jobId}.mp4`, request: { duration: 5 }, cost: 0.12, media: { hasAudio: true, duration: 5 }, clips: [{ id: `clip-${jobId}`, trackId: "v1", type: "video", start: 2, duration: 5, mediaJobId: jobId, mediaFile: `${jobId}.mp4`, linked: `audio-${jobId}` }, { id: `audio-${jobId}`, trackId: "a1", type: "audio", start: 2, duration: 5, mediaJobId: jobId, mediaFile: `${jobId}.mp4`, linked: `clip-${jobId}` }] }; },
    paths() { return { generated: "Z:/data/generated", exports: "Z:/data/exports" }; },
    ...overrides,
  };
  return { feature, calls, projects };
}

function setup({ tenant, feature: customFeature, billing: customBilling, fetch: fetchImpl, openrouter = {}, nvidia = {}, anthropic = {}, privacy = {}, media = {}, desktopPresence, meter: meterImpl, settlementAdmin = null, now } = {}) {
  const mock = customFeature ? { feature: customFeature, calls: customFeature.calls || [] } : featureMock();
  const T = tenant || { tenantId: "tenant_a", email: "a@example.test", role: "credit", status: "active", invited: true, isOwner: false };
  const billing = customBilling || { account: () => ({ autorecharge: true, hasCard: true, balance: 100 }), canChat: () => true };
  const screened = [];
  const metered = [];
  const http = createVideoHttp({
    feature: mock.feature,
    resolveTenant: () => T,
    billing,
    meter: async (...args) => { metered.push(args); return meterImpl ? meterImpl(...args) : undefined; },
    settlementAdmin,
    screenContent: (text) => { screened.push(text); return { blocked: false }; },
    fetch: fetchImpl || (async () => { throw new Error("unexpected network"); }),
    runware: { apiKey: () => "runware-test" },
    openrouter: { apiKey: () => "openrouter-test", url: "https://openrouter.test/api/v1/chat/completions", generationUrl: "https://openrouter.test/api/v1/generation", referer: "https://app.dominion.tools", title: "Dominion AI", costForUsage: (usage) => Number(usage?.cost) || 0, ...openrouter },
    nvidia: { apiKey: () => "nvidia-test", baseUrl: "https://nvidia.test/v1", directorModel: "deepseek-ai/deepseek-v4-pro", ...nvidia },
    anthropic: { apiKey: () => "anthropic-test", baseUrl: "https://anthropic.test", ...anthropic },
    privacy,
    media,
    desktopPresence,
    now,
  });
  return { http, T, billing, screened, metered, ...mock };
}

function setPersistedScreenplay(env, text) {
  env.projects.get(PROJECT_ID).screenplay.text = text;
}

test("config is identity/invite gated and never exposes credentials", async () => {
  const good = setup();
  const result = await call(good.http, "GET", "/api/video/config");
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.body.limits.screenplayTokens, 115_000);
  assert.equal(result.body.agents.screenwriter.model, "arcee-ai/trinity-large-thinking");
  assert.equal(result.body.screenwriter.available, true);
  assert.equal(result.body.screenwriter.provider, "openrouter");
  assert.equal(result.body.screenwriter.reasoning, "mandatory");
  assert.equal(result.body.agents.visualOrchestrator.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.match(result.body.storageKey, /^[a-f0-9]{24}$/);
  assert.equal(typeof result.body.desktopCapability, "string");
  assert.equal(JSON.stringify(result.body).includes("nvidia-test"), false);

  for (const [tenant, code, status] of [
    [{ role: "anon" }, "no_identity", 401],
    [{ tenantId: "tenant_a", email: "a@test", role: "credit", status: "locked", invited: true }, "account_locked", 403],
    [{ tenantId: "tenant_a", email: "a@test", role: "credit", status: "active", invited: false }, "needs_invite", 403],
  ]) {
    const denied = setup({ tenant });
    const out = await call(denied.http, "GET", "/api/video/config");
    assert.equal(out.res.statusCode, status);
    assert.equal(out.body.code, code);
    assert.equal(typeof out.body.requestId, "string");
  }
});

test("settlement administration is owner-only and exposes no records to ordinary tenants", async () => {
  let called = false;
  const settlementAdmin = {
    listHeld() { called = true; return []; },
    inspect() { called = true; return null; },
    repair() { called = true; return null; },
  };
  const env = setup({ settlementAdmin });
  const denied = await call(env.http, "GET", "/api/video/admin/settlements");
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.body.code, "video_settlement_admin_forbidden");
  assert.equal(called, false);
});

test("owner settlement administration lists, inspects, and mutates only with the exact confirmation", async () => {
  const settlementKey = "tenant_a:provider:generation_123";
  const record = { settlementKey, status: "held", costUsd: 0.0042 };
  const repairs = [];
  const settlementAdmin = {
    listHeld() { return record.status === "held" ? [structuredClone(record)] : []; },
    inspect(key) { return key === settlementKey ? structuredClone(record) : null; },
    repair(input) {
      repairs.push(structuredClone(input));
      const confirmation = `MARK_SETTLED ${settlementKey} OPERATOR_VERIFIED_CHARGE_OCCURRED`;
      if (input.settlementKey !== settlementKey || input.action !== "mark_settled" || input.confirmation !== confirmation) {
        const error = new Error("Exact operator confirmation is required."); error.code = "video_meter_repair_confirmation"; throw error;
      }
      record.status = "settled";
      return structuredClone(record);
    },
  };
  const tenant = { tenantId: "owner", email: "owner@example.test", role: "owner", status: "active", invited: true, isOwner: true };
  const env = setup({ tenant, settlementAdmin });

  const listed = await call(env.http, "GET", "/api/video/admin/settlements");
  assert.equal(listed.res.statusCode, 200); assert.equal(listed.body.held[0].settlementKey, settlementKey);
  const inspected = await call(env.http, "GET", `/api/video/admin/settlements?settlementKey=${encodeURIComponent(settlementKey)}`);
  assert.equal(inspected.res.statusCode, 200); assert.equal(inspected.body.settlement.status, "held");

  const rejected = await call(env.http, "POST", "/api/video/admin/settlements", { settlementKey, action: "mark_settled", confirmation: `MARK_SETTLED ${settlementKey}` });
  assert.equal(rejected.res.statusCode, 400); assert.equal(rejected.body.code, "video_meter_repair_confirmation"); assert.equal(record.status, "held");
  const exactConfirmation = `MARK_SETTLED ${settlementKey} OPERATOR_VERIFIED_CHARGE_OCCURRED`;
  const repaired = await call(env.http, "POST", "/api/video/admin/settlements", { settlementKey, action: "mark_settled", confirmation: exactConfirmation });
  assert.equal(repaired.res.statusCode, 200); assert.equal(repaired.body.repair.status, "settled");
  assert.deepEqual(repairs.at(-1), { settlementKey, action: "mark_settled", confirmation: exactConfirmation });
  assert.deepEqual((await call(env.http, "GET", "/api/video/admin/settlements")).body.held, []);
  assert.equal((await call(env.http, "GET", `/api/video/admin/settlements?settlementKey=${encodeURIComponent(settlementKey)}`)).body.settlement.status, "settled");
});

test("persistent desktop mutations require a server-issued capability and mobile cannot mint one", async () => {
  const env = setup();
  const rawReq = request("POST", "/api/video/projects/checkpoint", { projectId: PROJECT_ID, state: {} }, { "user-agent": "Mozilla/5.0 Desktop", "x-dominion-device": "desktop" });
  const rawRes = response(); await env.http.handle(rawReq, rawRes, new URL(rawReq.url, "http://test.local"));
  assert.equal(rawRes.statusCode, 409); assert.equal(rawRes.json.code, "desktop_capability_required");

  const mobile = setup();
  const config = await call(mobile.http, "GET", "/api/video/config?device=mobile", undefined, { "user-agent": "Mozilla/5.0 iPhone Mobile", "x-dominion-device": "desktop" });
  assert.equal(config.body.desktopCapability, undefined); assert.equal(config.body.singleGenerationOnly, true);
  const spoof = await call(mobile.http, "POST", "/api/video/presence", { device: "desktop" }, { "user-agent": "Mozilla/5.0 iPhone Mobile", "x-dominion-device": "desktop" });
  assert.equal(spoof.res.statusCode, 200); assert.equal(spoof.body.desktopSession, false);

  const generationReq = request("POST", "/api/video/jobs", { projectId: PROJECT_ID, model: "google:gemini@omni-flash", prompt: "No capability", duration: 5, ratio: "16:9", resolution: "720p" }, { "user-agent": "Mozilla/5.0 Desktop", "x-dominion-device": "desktop" });
  const generationRes = response(); await env.http.handle(generationReq, generationRes, new URL(generationReq.url, "http://test.local"));
  assert.equal(generationRes.statusCode, 409); assert.equal(generationRes.json.code, "desktop_capability_required");
  assert.equal(env.calls.some((entry) => entry[0] === "submitGeneration"), false);
});

test("project CRUD and checkpoints use the durable feature contracts with tenant isolation", async () => {
  const env = setup();
  const listed = await call(env.http, "GET", "/api/video/projects");
  assert.equal(listed.res.statusCode, 200);
  assert.equal(listed.body.projects.length, 1);
  assert.deepEqual(env.calls.find((entry) => entry[0] === "listProjects").slice(0, 2), ["listProjects", "tenant_a"]);

  const payload = { projectId: PROJECT_ID, label: "Moved scene", expectedProjectRevision: 1, expectedScreenplaySha256: screenplaySha("FADE IN"), state: { project: { id: PROJECT_ID }, scenes: [{ id: "s1" }] } };
  const saved = await call(env.http, "POST", "/api/video/projects/checkpoint", payload);
  assert.equal(saved.res.statusCode, 200);
  const checkpoint = env.calls.find((entry) => entry[0] === "checkpointProject");
  assert.equal(checkpoint[1], "tenant_a");
  assert.equal(checkpoint[2], PROJECT_ID);
  assert.equal(checkpoint[3].label, "Moved scene");
  assert.equal(checkpoint[3].expectedScreenplaySha256, screenplaySha("FADE IN"));
  assert.equal(checkpoint[3].expectedProjectRevision, 1);
  assert.equal(saved.body.screenplaySha256, screenplaySha("FADE IN"));
  assert.deepEqual(saved.body.checkpoint, { label: "Moved scene", seq: 2, updatedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(JSON.stringify(saved.body).includes("opaque-checkpoint-secret"), false);

  const missingRevision = await call(env.http, "POST", "/api/video/projects/checkpoint", { ...payload, expectedScreenplaySha256: undefined });
  assert.equal(missingRevision.res.statusCode, 428); assert.equal(missingRevision.body.code, "video_screenplay_precondition_required");
  const missingProjectRevision = await call(env.http, "POST", "/api/video/projects/checkpoint", { ...payload, expectedProjectRevision: undefined });
  assert.equal(missingProjectRevision.res.statusCode, 428); assert.equal(missingProjectRevision.body.code, "video_project_revision_required");
  const staleRevision = await call(env.http, "POST", "/api/video/projects/checkpoint", { ...payload, expectedProjectRevision: 2, expectedScreenplaySha256: screenplaySha("STALE") });
  assert.equal(staleRevision.res.statusCode, 409); assert.equal(staleRevision.body.code, "video_checkpoint_stale");

  const renamed = await call(env.http, "PATCH", `/api/video/projects/${PROJECT_ID}`, { name: "New title" });
  assert.equal(renamed.res.statusCode, 200);
  assert.equal(renamed.body.project.name, "New title");
  const rejectedDelete = await call(env.http, "DELETE", `/api/video/projects/${PROJECT_ID}`, {});
  assert.equal(rejectedDelete.res.statusCode, 400);
  assert.equal(rejectedDelete.body.code, "video_delete_confirmation_required");
  const deleted = await call(env.http, "DELETE", `/api/video/projects/${PROJECT_ID}`, { confirmDelete: true });
  assert.equal(deleted.res.statusCode, 200);
  assert.equal(env.calls.find((entry) => entry[0] === "deleteProject")[3].confirmDelete, true);
});

test("history, restore, undo/redo, and exact-project job recovery are exposed without cross-project scans", async () => {
  const mock = featureMock({
    listCheckpoints(tenantId, id) { this.getProject(tenantId, id); return [{ seq: 3, label: "Saved cut" }]; },
    restoreCheckpoint(tenantId, id, seq, expectedProjectRevision) { this.getProject(tenantId, id); assert.equal(seq, 3); assert.equal(expectedProjectRevision, 1); return {}; },
    undo(tenantId, id, expectedProjectRevision) { this.getProject(tenantId, id); assert.equal(expectedProjectRevision, 1); return {}; },
    redo(tenantId, id, expectedProjectRevision) { this.getProject(tenantId, id); assert.equal(expectedProjectRevision, 1); return {}; },
    recoverJobs(tenantId, id) { this.getProject(tenantId, id); return [{ id: JOB_ID, status: "generating" }]; },
  });
  const env = setup({ feature: mock.feature });
  const history = await call(env.http, "GET", `/api/video/projects/${PROJECT_ID}/history`);
  assert.equal(history.res.statusCode, 200); assert.equal(history.body.checkpoints[0].seq, 3);
  assert.equal((await call(env.http, "POST", `/api/video/projects/${PROJECT_ID}/restore`, { seq: 3, expectedProjectRevision: 1 })).res.statusCode, 200);
  assert.equal((await call(env.http, "POST", `/api/video/projects/${PROJECT_ID}/undo`, { expectedProjectRevision: 1 })).res.statusCode, 200);
  assert.equal((await call(env.http, "POST", `/api/video/projects/${PROJECT_ID}/redo`, { expectedProjectRevision: 1 })).res.statusCode, 200);
  const recovered = await call(env.http, "GET", `/api/video/jobs/recover?projectId=${PROJECT_ID}`);
  assert.equal(recovered.res.statusCode, 200); assert.equal(recovered.body.jobs[0].id, JOB_ID);
});

test("generation refuses each missing billing prerequisite before creating or submitting work", async () => {
  const cases = [
    [{ autorecharge: false, hasCard: true, balance: 10 }, true, "video_autorecharge_required"],
    [{ autorecharge: true, hasCard: false, balance: 10 }, true, "video_payment_method_required"],
    [{ autorecharge: true, hasCard: true, balance: 0 }, false, "needs_credits"],
  ];
  for (const [account, canChat, code] of cases) {
    const env = setup({ billing: { account: () => account, canChat: () => canChat } });
    const result = await call(env.http, "POST", "/api/video/jobs", { projectId: PROJECT_ID, model: "google:gemini@omni-flash", prompt: "Sunrise", duration: 5, ratio: "16:9", resolution: "720p" });
    assert.equal(result.res.statusCode, 402);
    assert.equal(result.body.code, code);
    assert.equal(env.calls.some((entry) => entry[0] === "submitGeneration"), false);
  }
});

test("generation validates safety and submits the exact model/settings without substitution", async () => {
  const env = setup();
  const result = await call(env.http, "POST", "/api/video/jobs", { projectId: PROJECT_ID, model: "google:gemini@omni-flash", prompt: "Sunrise over water", duration: 5, ratio: "16:9", resolution: "720p", audio: true, idempotencyKey: "ui_generation_1" });
  assert.equal(result.res.statusCode, 202);
  assert.equal(result.body.jobId, JOB_ID);
  const submitted = env.calls.find((entry) => entry[0] === "submitGeneration");
  assert.equal(submitted[3].model, "google:gemini@omni-flash");
  assert.equal(submitted[3].resolution, "720p");
  assert.equal(submitted[3].generateAudio, true);
  assert.equal(submitted[3].idempotencyKey, "ui_generation_1");
  assert.deepEqual(env.screened, ["Sunrise over water"]);
});

test("project media uploads stream through the injected verifier contract", async () => {
  const imports = [];
  const env = setup({ media: { importUpload: async (input) => { imports.push(input); return { filename: "source-1.mp4", bytes: 4, duration: 2, hasVideo: true, hasAudio: true, status: "ready" }; } } });
  const out = await call(env.http, "POST", `/api/video/uploads?projectId=${PROJECT_ID}&filename=source.mp4`, "data", { "content-type": "video/mp4", "content-length": "4" });
  assert.equal(out.res.statusCode, 201); assert.equal(out.body.filename, "source-1.mp4"); assert.match(out.body.mediaUrl, /source-1\.mp4$/); assert.equal(imports[0].tenantId, "tenant_a");
});

test("mobile without a desktop session gets one-off generation but cannot mutate a saved project", async () => {
  const env = setup({ desktopPresence: async ({ action }) => action === "hasDesktop" ? { desktopSession: false } : { desktopSession: true } });
  const headers = { "user-agent": "Mozilla/5.0 iPhone Mobile", "x-dominion-device": "desktop" };
  const denied = await call(env.http, "POST", "/api/video/projects/checkpoint", { projectId: PROJECT_ID, label: "x", state: {} }, headers);
  assert.equal(denied.res.statusCode, 409);
  assert.equal(denied.body.code, "desktop_session_required");

  const generated = await call(env.http, "POST", "/api/video/jobs", { model: "google:gemini@omni-flash", prompt: "One phone clip", duration: 5, ratio: "16:9", resolution: "720p" }, headers);
  assert.equal(generated.res.statusCode, 202);
  assert.equal(generated.body.singleGeneration, true);
  assert.ok(env.calls.some((entry) => entry[0] === "createProject"));
  env.feature.recoverTemporaryJobs = (tenantId) => [{ id: JOB_ID, projectId: generated.body.projectId, status: "generating", singleGeneration: true }];
  const recovered = await call(env.http, "GET", "/api/video/jobs/recover-mobile", undefined, headers);
  assert.equal(recovered.res.statusCode, 200); assert.equal(recovered.body.jobs[0].id, JOB_ID); assert.equal(recovered.body.jobs[0].projectId, generated.body.projectId);
  env.feature.markJobDelivered = (_tenantId, projectId, jobId) => ({ id: jobId, projectId, delivery: { status: "delivered" } });
  const delivered = await call(env.http, "POST", `/api/video/jobs/${JOB_ID}/delivered`, { projectId: generated.body.projectId }, headers);
  assert.equal(delivered.res.statusCode, 200); assert.equal(delivered.body.delivery.status, "delivered");
});

test("job polling settles before downloading, exposes only verified clips, and meters once", async () => {
  let pollCount = 0; const order = [];
  const mock = featureMock({
    pollJob(tenantId, id, jobId) { pollCount++; return { id: jobId, status: "ready", output: "https://provider.test/video", request: { duration: 7 }, cost: 0.12 }; },
    downloadJobOutput(tenantId, id, jobId) { order.push("download"); return featureMock().feature.downloadJobOutput(tenantId, id, jobId); },
  });
  mock.projects.get(PROJECT_ID).jobs.push({ id: JOB_ID, status: "generating" });
  const env = setup({ feature: mock.feature, meter: async () => { order.push("settle"); return { settlementKey: "tenant:job:job_123", costUsd: 0.12 }; } });
  env.feature.calls = mock.calls;
  const first = await call(env.http, "GET", `/api/video/jobs/${JOB_ID}`);
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.body.status, "ready");
  assert.match(first.body.mediaUrl, /job_123\.mp4$/);
  assert.equal(first.body.clip.duration, 5);
  assert.equal(first.body.clip.start, 2); assert.equal(first.body.audioClip.trackId, "a1"); assert.equal(first.body.hasAudio, true);
  assert.equal(env.metered.length, 1);
  assert.deepEqual(order.slice(0, 2), ["settle", "download"]);
  await call(env.http, "GET", `/api/video/jobs/${JOB_ID}`);
  assert.equal(pollCount, 2);
  assert.equal(env.metered.length, 1);
});

test("screenwriter refuses a non-event-stream request before calling OpenRouter", async () => {
  let providerCalls = 0;
  const env = setup({ fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  setPersistedScreenplay(env, "Write an opening");
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 }, { accept: "application/json" });
  assert.equal(out.res.statusCode, 406);
  assert.equal(out.body.code, "screenwriter_stream_required");
  assert.equal(providerCalls, 0);
  assert.equal(env.calls.some((entry) => entry[0] === "applyCommand"), false);
});

test("screenwriter calls only Trinity Large Thinking through OpenRouter and saves exact usage", async () => {
  const providerCalls = [];
  const fetch = async (url, options) => {
    providerCalls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: "gen-trinity-1", model: "arcee-ai/trinity-large-thinking", choices: [{ finish_reason: "stop", message: { content: "EXT. OCEAN - DAWN\nWaves catch fire.", reasoning_details: [{ type: "reasoning.text", text: "opaque-provider-state" }] } }], usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120, cost: 0.0000512, completion_tokens_details: { reasoning_tokens: 12 } } }), { status: 200 });
  };
  const env = setup({ fetch });
  setPersistedScreenplay(env, "Write a dawn opening");
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a dawn opening", limit: 115_000 });
  assert.equal(out.res.statusCode, 200);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, "https://openrouter.test/api/v1/chat/completions");
  assert.equal(providerCalls[0].body.model, "arcee-ai/trinity-large-thinking");
  assert.equal(providerCalls[0].body.stream, false);
  assert.equal(providerCalls[0].body.max_tokens, 16_384);
  assert.equal(providerCalls[0].body.temperature, 0.3);
  assert.equal(providerCalls[0].body.top_p, 0.8);
  assert.deepEqual(providerCalls[0].body.reasoning, { enabled: true, exclude: false });
  assert.deepEqual(providerCalls[0].body.provider, { require_parameters: true, allow_fallbacks: true });
  assert.match(providerCalls[0].body.session_id, /^dominion-video-writer-[a-f0-9]{32}$/);
  assert.match(providerCalls[0].options.headers.Authorization, /^Bearer /);
  assert.equal(providerCalls[0].options.headers["HTTP-Referer"], "https://app.dominion.tools");
  assert.equal(providerCalls[0].options.headers["X-OpenRouter-Title"], "Dominion AI");
  assert.equal(env.metered[0][1], 0.0000512);
  assert.equal(env.metered[0][2].provider, "openrouter");
  const commands = env.calls.filter((entry) => entry[0] === "applyCommand").map((entry) => entry[3]);
  const canonical = canonicalAttempts(env, "gen-trinity-1");
  assert.ok(canonical.some((attempt) => attempt.status === "provider_accepted"));
  assert.equal(attemptCommands(env).some((attempt) => String(attempt.attemptId).startsWith("sw_local_") && attempt.status === "provider_correlated"), true);
  const command = commands.find((candidate) => candidate.type === "screenplay.set");
  assert.equal(command.type, "screenplay.set");
  assert.match(command.text, /OCEAN/);
  assert.equal(command.model, "arcee-ai/trinity-large-thinking");
  assert.equal(command.generationId, "gen-trinity-1");
  assert.equal(command.finishReason, "stop");
  assert.equal(command.generatedSections, 1);
  assert.equal(command.brief, "Write a dawn opening");
  assert.equal(command.lastTurn.reasoningDetails[0].text, "opaque-provider-state");
  assert.equal(out.body.truncated, false);
});

test("screenwriter event stream starts immediately, records the header identity, drains safely, and hides reasoning", async () => {
  let releaseBody; let bodyReleased = false; let providerCalls = 0; let resolveProvisional;
  const provisionalSaved = new Promise((resolve) => { resolveProvisional = resolve; });
  const providerPayload = {
    id: "gen-trinity-sse", model: "arcee-ai/trinity-large-thinking",
    choices: [{ finish_reason: "stop", message: { content: "EXT. OBSERVATORY - NIGHT", reasoning_details: [{ type: "reasoning.text", text: "opaque-sse-reasoning" }] } }],
    usage: { prompt_tokens: 24, completion_tokens: 10, total_tokens: 34, cost: 0.00001478 },
  };
  const env = setup({ fetch: async () => {
    providerCalls++;
    const body = new ReadableStream({ start(controller) {
      releaseBody = () => {
        bodyReleased = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(providerPayload)));
        controller.close();
      };
    } });
    return new Response(body, { status: 200, headers: { "X-Generation-Id": "gen-trinity-sse" } });
  } });
  const apply = env.feature.applyCommand.bind(env.feature);
  env.feature.applyCommand = (...args) => {
    const value = apply(...args); const command = args[2];
    if (command?.type === "screenwriter.attempt" && command.attempt?.status === "provider_in_progress") resolveProvisional(command.attempt);
    return value;
  };
  setPersistedScreenplay(env, "Write an observatory opening");

  const started = await startCall(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an observatory opening", limit: 115_000 });
  started.res.deferFinish = true;
  const firstChunk = await started.res.firstWrite;
  assert.match(firstChunk, /^event: progress\n/);
  assert.equal(bodyReleased, false);
  assert.equal(started.res.statusCode, 200);
  assert.match(started.res.headers["content-type"], /^text\/event-stream/);
  const provisional = await provisionalSaved;
  assert.equal(provisional.generationId, "gen-trinity-sse");
  assert.equal(provisional.status, "provider_in_progress");
  assert.equal(env.http.activeScreenwriterTurns(), 1);

  let drainFinished = false;
  const draining = env.http.drain({ timeoutMs: 5_000 }).then((result) => { drainFinished = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainFinished, false);
  const refused = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an observatory opening", limit: 115_000 });
  assert.equal(refused.res.statusCode, 503);
  assert.equal(refused.body.code, "screenwriter_draining");
  assert.equal(providerCalls, 1);

  const resultWritten = new Promise((resolve) => started.res.once("write", resolve));
  releaseBody();
  const finalChunk = await resultWritten;
  assert.match(finalChunk, /^event: result\n/);
  assert.equal(started.res.ended, true);
  assert.equal(started.res.writableEnded, true);
  assert.equal(drainFinished, false);
  assert.equal(env.http.activeScreenwriterTurns(), 1);
  started.res.releaseFinish();
  const completed = await started.completion;
  const drained = await draining;
  assert.equal(completed.res.statusCode, 200);
  assert.deepEqual(completed.res.events.map((item) => item.event), ["progress", "result"]);
  assert.equal(completed.body.text, "EXT. OBSERVATORY - NIGHT");
  assert.equal(completed.body.model, "arcee-ai/trinity-large-thinking");
  assert.equal(completed.res.raw.includes("opaque-sse-reasoning"), false);
  assert.equal(drained.pending, 1);
  assert.equal(drained.completed, 1);
  assert.equal(drained.timedOut, false);
  assert.equal(env.http.activeScreenwriterTurns(), 0);
});

test("screenwriter rejects conflicting OpenRouter header and body generation identities", async () => {
  const env = setup({ fetch: async () => new Response(JSON.stringify({
    id: "gen-body-id", model: "arcee-ai/trinity-large-thinking",
    choices: [{ finish_reason: "stop", message: { content: "This conflicting response must not be saved." } }],
    usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27, cost: 0.00001161 },
  }), { status: 200, headers: { "X-Generation-Id": "gen-header-id" } }) });
  setPersistedScreenplay(env, "Write a generation identity test");
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a generation identity test", limit: 115_000 });
  assert.equal(out.res.statusCode, 502);
  assert.equal(out.body.code, "screenwriter_generation_id_mismatch");
  const commands = env.calls.filter((entry) => entry[0] === "applyCommand").map((entry) => entry[3]);
  assert.ok(commands.some((command) => command.type === "screenwriter.attempt" && command.attempt.generationId === "gen-header-id" && command.attempt.status === "provider_in_progress"));
  assert.ok(commands.some((command) => command.type === "screenwriter.attempt" && command.attempt.generationId === "gen-header-id" && command.attempt.status === "reconciliation_required"));
  assert.ok(commands.some((command) => command.type === "screenwriter.attempt" && command.attempt.generationId === "gen-body-id" && command.attempt.rejectionCode === "screenwriter_generation_id_mismatch"));
  assert.equal(commands.some((command) => command.type === "screenplay.set"), false);
  assert.equal(env.metered.length, 0);
});

test("screenwriter bounds a stalled provider body timeout without retrying the paid POST", async () => {
  let providerCalls = 0;
  const env = setup({
    openrouter: { timeoutMs: 25 },
    fetch: async (_url, options) => {
      providerCalls++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "X-Generation-Id": "gen-stalled-body" }),
        body: { getReader() { return {
          read() {
            return new Promise((_resolve, reject) => {
              const abort = () => { const error = new Error("provider body deadline"); error.name = "AbortError"; reject(error); };
              if (options.signal.aborted) abort(); else options.signal.addEventListener("abort", abort, { once: true });
            });
          },
          async cancel() {},
        }; } },
      };
    },
  });
  setPersistedScreenplay(env, "Write a timeout test");
  const before = Date.now();
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a timeout test", limit: 115_000 });
  const elapsed = Date.now() - before;
  assert.equal(out.res.statusCode, 504);
  assert.equal(out.body.code, "openrouter_trinity_timeout");
  assert.equal(providerCalls, 1);
  assert.ok(elapsed < 2_000, `provider body timeout took ${elapsed}ms`);
  const attempts = env.calls.filter((entry) => entry[0] === "applyCommand" && entry[3].type === "screenwriter.attempt").map((entry) => entry[3].attempt);
  assert.ok(attempts.some((attempt) => attempt.generationId === "gen-stalled-body" && attempt.status === "provider_in_progress"));
  assert.ok(attempts.some((attempt) => attempt.generationId === "gen-stalled-body" && attempt.status === "reconciliation_required"));
  assert.equal(env.http.activeScreenwriterTurns(), 0);
});

test("screenwriter exposes output truncation and rejects an unconfirmed model identity", async () => {
  const continuationCalls = [];
  const truncated = setup({ fetch: async (_url, options) => { continuationCalls.push(JSON.parse(options.body)); return new Response(JSON.stringify({
    id: "gen-trinity-length", model: "arcee-ai/trinity-large-thinking",
    choices: [{ finish_reason: "length", message: { content: "INT. ARCHIVE - NIGHT\nThe next sequence begins.", reasoning_details: [{ type: "reasoning.text", text: "new-opaque-state" }] } }],
    usage: { prompt_tokens: 20, completion_tokens: 16_384, total_tokens: 16_404, cost: 0.0139264 },
  }), { status: 200 }); } });
  const current = "FADE IN.\n\nEXT. HARBOR - DAWN\nThe city wakes.";
  const state = truncated.projects.get(PROJECT_ID); state.screenplay.text = current; state.ai.screenwriter = { state: { brief: "A city mystery", generatedSections: 1, lastTurn: { userContent: "Earlier request", content: "EXT. HARBOR - DAWN", reasoningDetails: [{ type: "reasoning.text", text: "prior-opaque-state" }] } } };
  const partial = await call(truncated.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: current, limit: 115_000 });
  assert.equal(partial.res.statusCode, 200);
  assert.equal(partial.body.truncated, true);
  assert.equal(partial.body.finishReason, "length");
  const partialCommand = truncated.calls.find((entry) => entry[0] === "applyCommand" && entry[3].type === "screenplay.set")[3];
  assert.equal(partialCommand.truncated, true);
  assert.equal(partialCommand.text.startsWith(current), true);
  assert.match(partialCommand.text, /ARCHIVE/);
  assert.equal(partialCommand.generatedSections, 2);
  assert.equal(continuationCalls[0].messages[1].content, "Earlier request");
  assert.equal(continuationCalls[0].messages[2].reasoning_details[0].text, "prior-opaque-state");
  assert.match(continuationCalls[0].session_id, /^dominion-video-writer-[a-f0-9]{32}$/);

  const substituted = setup({ fetch: async () => new Response(JSON.stringify({
    id: "gen-wrong-model", model: "another/model",
    choices: [{ finish_reason: "stop", message: { content: "This must not be saved." } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 },
  }), { status: 200 }) });
  setPersistedScreenplay(substituted, "Write an opening");
  const rejected = await call(substituted.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(rejected.res.statusCode, 502);
  assert.equal(rejected.body.code, "screenwriter_model_mismatch");
  const substitutedCommands = substituted.calls.filter((entry) => entry[0] === "applyCommand").map((entry) => entry[3]);
  const rejectedAttempt = canonicalAttempts(substituted, "gen-wrong-model").at(-1);
  assert.equal(rejectedAttempt.status, "provider_contract_rejected");
  assert.equal(substitutedCommands.some((command) => command.type === "screenplay.set"), false);
  assert.equal(substituted.metered.length, 0);
});

test("screenwriter rejects an incomplete finish without changing the screenplay", async () => {
  const env = setup({ fetch: async () => new Response(JSON.stringify({
    id: "gen-trinity-filtered", model: "arcee-ai/trinity-large-thinking",
    choices: [{ finish_reason: "content_filter", message: { content: "This incomplete text must not be saved." } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.00000604 },
  }), { status: 200 }) });
  setPersistedScreenplay(env, "Write an opening");
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(out.res.statusCode, 502);
  assert.equal(out.body.code, "screenwriter_incomplete_response");
  const commands = env.calls.filter((entry) => entry[0] === "applyCommand").map((entry) => entry[3]);
  const canonical = canonicalAttempts(env, "gen-trinity-filtered");
  assert.ok(canonical.some((attempt) => attempt.status === "provider_rejected"));
  assert.equal(canonical.at(-1).status, "rejected");
  assert.equal(commands.some((command) => command.type === "screenplay.set"), false);
  assert.equal(canonical.at(-1).settlement.status, "settled");
  assert.equal(env.metered.length, 1);
});

test("screenwriter rejects missing authoritative usage and never retries an ambiguous POST", async () => {
  const missingUsage = setup({ fetch: async () => new Response(JSON.stringify({
    id: "gen-trinity-no-usage", model: "arcee-ai/trinity-large-thinking",
    choices: [{ finish_reason: "stop", message: { content: "This must not be saved." } }],
  }), { status: 200 }) });
  setPersistedScreenplay(missingUsage, "Write an opening");
  const malformed = await call(missingUsage.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(malformed.res.statusCode, 502);
  assert.equal(malformed.body.code, "screenwriter_usage_missing");
  const missingUsageCommands = missingUsage.calls.filter((entry) => entry[0] === "applyCommand").map((entry) => entry[3]);
  assert.equal(canonicalAttempts(missingUsage, "gen-trinity-no-usage").at(-1).status, "reconciliation_required");
  assert.equal(missingUsageCommands.some((command) => command.type === "screenplay.set"), false);
  assert.equal(missingUsage.metered.length, 0);

  let attempts = 0;
  const ambiguous = setup({ fetch: async () => { attempts++; throw new Error("connection reset after request write"); } });
  setPersistedScreenplay(ambiguous, "Write an opening");
  const failed = await call(ambiguous.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(failed.res.statusCode, 502);
  assert.equal(failed.body.code, "openrouter_trinity_network_error");
  assert.equal(attempts, 1);
  const pending = attemptCommands(ambiguous).filter((attempt) => String(attempt.attemptId).startsWith("sw_local_")).at(-1);
  assert.equal(pending.status, "reconciliation_required");
  assert.equal(pending.settlement.status, "awaiting_response");
  const retry = await call(ambiguous.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(retry.res.statusCode, 409); assert.equal(retry.body.code, "screenwriter_reconciliation_required");
  assert.equal(attempts, 1);
  const status = await call(ambiguous.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(status.body.active, false); assert.equal(status.body.pending, true); assert.equal(status.body.actionRequired, true);
  assert.equal(status.body.status, "reconciliation_required");
});

test("screenwriter quarantine requires the exact attempt confirmation, preserves linked attempts, and unlocks checkpoints", async () => {
  let providerCalls = 0;
  const env = setup({ fetch: async () => { providerCalls++; throw new Error("quarantine must not call a provider"); } });
  const sourceHash = screenplaySha("FADE IN");
  const firstAttempt = { attemptId: "sw_unrecoverable_first", generationId: null, status: "reconciliation_required", rejectionCode: "screenwriter_acknowledgement_unknown", sourceScreenplaySha256: sourceHash, settlement: { status: "awaiting_response", costUsd: 0 } };
  const secondAttempt = { attemptId: "sw_unrecoverable_second", generationId: "gen-conflicting", status: "reconciliation_required", rejectionCode: "screenwriter_generation_id_mismatch", sourceScreenplaySha256: sourceHash, settlement: { status: "awaiting_response", costUsd: 0 } };
  env.projects.get(PROJECT_ID).providerAttempts.push(structuredClone(firstAttempt), structuredClone(secondAttempt));

  const blockedCheckpoint = await call(env.http, "POST", "/api/video/projects/checkpoint", {
    projectId: PROJECT_ID, label: "Must remain blocked", state: { screenplay: "FADE IN" },
    expectedScreenplaySha256: sourceHash, expectedProjectRevision: 1,
  });
  assert.equal(blockedCheckpoint.res.statusCode, 409); assert.equal(blockedCheckpoint.body.code, "screenwriter_busy");

  const firstStatus = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(firstStatus.body.pending, true); assert.equal(firstStatus.body.recoveryAction, "quarantine_unrecoverable");
  assert.equal(firstStatus.body.operatorReference, secondAttempt.attemptId);
  const secondConfirmation = `QUARANTINE ${secondAttempt.attemptId} WITHOUT_DOMINION_BILLING`;
  assert.equal(firstStatus.body.quarantineConfirmation, secondConfirmation);

  const wrong = await call(env.http, "POST", "/api/video/screenwriter/quarantine", { projectId: PROJECT_ID, confirmation: `QUARANTINE ${secondAttempt.attemptId}` });
  assert.equal(wrong.res.statusCode, 400); assert.equal(wrong.body.code, "screenwriter_quarantine_confirmation_required");
  assert.deepEqual(env.projects.get(PROJECT_ID).providerAttempts.at(-1), secondAttempt);

  const secondQuarantine = await call(env.http, "POST", "/api/video/screenwriter/quarantine", { projectId: PROJECT_ID, confirmation: secondConfirmation });
  assert.equal(secondQuarantine.res.statusCode, 200); assert.equal(secondQuarantine.body.status, "operator_quarantined");
  let stored = env.projects.get(PROJECT_ID).providerAttempts;
  assert.equal(stored[1].status, "operator_quarantined"); assert.equal(stored[1].settlement.status, "not_billed");
  assert.equal(stored[0].status, "reconciliation_required");

  const linkedStatus = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  const firstConfirmation = `QUARANTINE ${firstAttempt.attemptId} WITHOUT_DOMINION_BILLING`;
  assert.equal(linkedStatus.body.pending, true); assert.equal(linkedStatus.body.operatorReference, firstAttempt.attemptId);
  assert.equal(linkedStatus.body.quarantineConfirmation, firstConfirmation);
  const firstQuarantine = await call(env.http, "POST", "/api/video/screenwriter/quarantine", { projectId: PROJECT_ID, confirmation: firstConfirmation });
  assert.equal(firstQuarantine.res.statusCode, 200); assert.equal(firstQuarantine.body.status, "operator_quarantined");

  stored = env.projects.get(PROJECT_ID).providerAttempts;
  assert.equal(stored.length, 2);
  for (const attempt of stored) { assert.equal(attempt.status, "operator_quarantined"); assert.equal(attempt.settlement.status, "not_billed"); assert.equal(attempt.settlement.costUsd, 0); }
  const idle = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(idle.body.pending, false); assert.equal(idle.body.status, "idle");

  const checkpoint = await call(env.http, "POST", "/api/video/projects/checkpoint", {
    projectId: PROJECT_ID, label: "Editing unlocked", state: { screenplay: "FADE IN" },
    expectedScreenplaySha256: sourceHash, expectedProjectRevision: env.projects.get(PROJECT_ID).history.head,
  });
  assert.equal(checkpoint.res.statusCode, 200);
  assert.equal(providerCalls, 0); assert.equal(env.metered.length, 0);
});

test("an explicit OpenRouter 401 is terminal, unbilled, and permits a corrected retry and checkpoint", async () => {
  let providerCalls = 0;
  const env = setup({ fetch: async () => {
    providerCalls++;
    if (providerCalls === 1) return new Response(JSON.stringify({ error: { message: "invalid API key" } }), { status: 401 });
    return new Response(JSON.stringify({
      id: "gen-after-auth-fix", model: "arcee-ai/trinity-large-thinking",
      choices: [{ finish_reason: "stop", message: { content: "EXT. RIDGE - SUNRISE" } }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, cost: 0.00001204 },
    }), { status: 200 });
  } });
  setPersistedScreenplay(env, "Write a sunrise opening");

  const rejected = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a sunrise opening", limit: 115_000 });
  assert.equal(rejected.res.statusCode, 400); assert.equal(rejected.body.code, "openrouter_trinity_http_401");
  const terminal = attemptCommands(env).find((attempt) => String(attempt.attemptId).startsWith("sw_local_") && attempt.status === "provider_http_rejected");
  assert.ok(terminal); assert.equal(terminal.settlement.status, "not_billed");
  assert.equal(env.metered.length, 0);
  const idle = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(idle.body.pending, false); assert.equal(idle.body.actionRequired, false); assert.equal(idle.body.status, "idle");

  const corrected = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a sunrise opening", limit: 115_000 });
  assert.equal(corrected.res.statusCode, 200); assert.equal(providerCalls, 2); assert.equal(env.metered.length, 1);
  const checkpoint = await call(env.http, "POST", "/api/video/projects/checkpoint", {
    projectId: PROJECT_ID, label: "Corrected Trinity turn", expectedProjectRevision: env.projects.get(PROJECT_ID).history.head, expectedScreenplaySha256: corrected.body.screenplaySha256,
    state: { project: { id: PROJECT_ID }, screenplay: corrected.body.text, scenes: [] },
  });
  assert.equal(checkpoint.res.statusCode, 200); assert.equal(checkpoint.body.screenplaySha256, corrected.body.screenplaySha256);
});

test("router metadata attempt zero makes a clean 503 terminal without retrying Trinity", async () => {
  let providerCalls = 0;
  const env = setup({ fetch: async (_url, options) => {
    providerCalls++;
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.model, "arcee-ai/trinity-large-thinking");
    assert.equal(options.headers["X-OpenRouter-Metadata"], "enabled");
    if (providerCalls === 1) return new Response(JSON.stringify({ error: { code: 503, message: "No provider available" }, openrouter_metadata: { attempt: 0 } }), { status: 503 });
    return new Response(JSON.stringify({
      id: "gen-after-provider-recovery", model: "arcee-ai/trinity-large-thinking",
      choices: [{ finish_reason: "stop", message: { content: "EXT. PLATFORM - DAWN" } }],
      usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22, cost: 0.00000946 },
    }), { status: 200 });
  } });
  setPersistedScreenplay(env, "Write a platform opening");
  const unavailable = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a platform opening", limit: 115_000 });
  assert.equal(unavailable.res.statusCode, 502); assert.equal(providerCalls, 1);
  assert.equal(attemptCommands(env).at(-1).status, "provider_http_rejected");
  const retry = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a platform opening", limit: 115_000 });
  assert.equal(retry.res.statusCode, 200); assert.equal(providerCalls, 2);
});

test("a routed error generation identity is persisted and the paid POST is never retried", async () => {
  let providerCalls = 0;
  const env = setup({ fetch: async (_url, options) => {
    providerCalls++;
    if (providerCalls > 1) return new Response(JSON.stringify({ id: "must-not-run", model: "arcee-ai/trinity-large-thinking" }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 429, message: "Provider rate limited" }, openrouter_metadata: { attempt: 1 } }), { status: 429, headers: { "X-Generation-Id": "gen-rate-limited" } });
  } });
  setPersistedScreenplay(env, "Write a rate-limit test");
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a rate-limit test", limit: 115_000 });
  assert.equal(out.res.statusCode, 429); assert.equal(providerCalls, 1);
  const canonical = canonicalAttempts(env, "gen-rate-limited").at(-1);
  assert.equal(canonical.status, "reconciliation_required");
  const status = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(status.body.pending, true); assert.equal(status.body.recoveryAction, "check_generation");
});

test("settlement recovery applies a durable candidate once without another Trinity request", async () => {
  let providerCalls = 0; let meterCalls = 0;
  const env = setup({
    fetch: async () => { providerCalls++; throw new Error("Trinity must not be called during candidate recovery"); },
    meter: async () => { meterCalls++; return { settlementKey: "settled-once", costUsd: 0.0025 }; },
  });
  const source = "FADE IN"; setPersistedScreenplay(env, source);
  env.projects.get(PROJECT_ID).providerAttempts.push({
    attemptId: "sw_recover_candidate", generationId: "gen-recover-candidate", provider: "openrouter", model: "arcee-ai/trinity-large-thinking",
    status: "settlement_failed", sourceScreenplaySha256: screenplaySha(source), sourceGenerationId: null,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.0025 },
    settlement: { status: "failed", costUsd: 0.0025, errorCode: "temporary_charge_failure" },
    candidate: { text: "EXT. STATION - DAWN", brief: source, generatedSections: 1, lastTurn: { userContent: source, content: "EXT. STATION - DAWN" }, sessionId: "writer-session", finishReason: "stop", truncated: false },
  });
  const repaired = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: PROJECT_ID, privacyMode: "private" });
  assert.equal(repaired.res.statusCode, 200); assert.equal(repaired.body.status, "applied");
  assert.equal(env.projects.get(PROJECT_ID).screenplay.text, "EXT. STATION - DAWN");
  assert.equal(meterCalls, 1); assert.equal(providerCalls, 0);
  const repeat = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: PROJECT_ID, privacyMode: "private" });
  assert.equal(repeat.body.reconciled, false); assert.equal(repeat.body.status, "idle");
  assert.equal(meterCalls, 1); assert.equal(providerCalls, 0);
});

test("known-generation reconciliation uses exact OpenRouter metadata and never provider content", async () => {
  let gets = 0; let posts = 0; let meterCalls = 0;
  const env = setup({
    fetch: async (url, options) => {
      if (options.method === "POST") { posts++; throw new Error("paid POST must not run"); }
      gets++; assert.equal(String(url), "https://openrouter.test/api/v1/generation?id=gen-metadata-only");
      return new Response(JSON.stringify({ data: { id: "gen-metadata-only", model: "arcee-ai/trinity-large-thinking", api_type: "completions", total_cost: 0.0012, tokens_prompt: 80, tokens_completion: 12, native_tokens_reasoning: 5, finish_reason: "error" } }), { status: 200 });
    },
    meter: async (_tenant, cost) => { meterCalls++; assert.equal(cost, 0.0012); return { settlementKey: "metadata-settled", costUsd: cost }; },
  });
  env.projects.get(PROJECT_ID).providerAttempts.push({ attemptId: "sw_metadata_only", generationId: "gen-metadata-only", status: "reconciliation_required", settlement: { status: "awaiting_response", costUsd: 0 } });
  const repaired = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: PROJECT_ID, privacyMode: "normal" });
  assert.equal(repaired.res.statusCode, 200); assert.equal(repaired.body.status, "rejected");
  assert.equal(gets, 1); assert.equal(posts, 0); assert.equal(meterCalls, 1);
  assert.equal(env.projects.get(PROJECT_ID).providerAttempts[0].settlement.status, "settled");
});

test("OpenRouter metadata with zero cost but no finish reason remains pending and is not metered", async () => {
  let gets = 0; let posts = 0; let meterCalls = 0;
  const env = setup({
    fetch: async (url, options) => {
      if (options.method === "POST") { posts++; throw new Error("paid POST must not run"); }
      gets++; assert.equal(String(url), "https://openrouter.test/api/v1/generation?id=gen-still-running");
      return new Response(JSON.stringify({ data: { id: "gen-still-running", model: "arcee-ai/trinity-large-thinking", api_type: "completions", total_cost: 0, finish_reason: null } }), { status: 200 });
    },
    meter: async () => { meterCalls++; throw new Error("pending metadata must not be metered"); },
  });
  const pendingAttempt = { attemptId: "sw_still_running", generationId: "gen-still-running", status: "reconciliation_required", settlement: { status: "awaiting_response", costUsd: 0 } };
  env.projects.get(PROJECT_ID).providerAttempts.push(structuredClone(pendingAttempt));
  const pending = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: PROJECT_ID, privacyMode: "normal" });
  assert.equal(pending.res.statusCode, 409); assert.equal(pending.body.code, "screenwriter_reconciliation_pending");
  assert.equal(gets, 1); assert.equal(posts, 0); assert.equal(meterCalls, 0);
  const durablePending = env.projects.get(PROJECT_ID).providerAttempts[0];
  assert.equal(durablePending.attemptId, pendingAttempt.attemptId); assert.equal(durablePending.status, "reconciliation_required");
  assert.deepEqual(durablePending.settlement, pendingAttempt.settlement);
  assert.equal(durablePending.reconciliationFailures, 0); assert.equal(durablePending.lastReconciliationError, "screenwriter_reconciliation_pending");
  assert.equal(typeof durablePending.lastReconciledAt, "string");
  const durableWrites = env.calls.filter((entry) => entry[0] === "applyCommand");
  assert.equal(durableWrites.length, 1); assert.equal(durableWrites[0][3].type, "screenwriter.attempt");
});

test("three durable known-generation reconciliation failures unlock typed quarantine only after ten minutes", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dominion-video-reconcile-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const startedAt = Date.UTC(2026, 0, 2, 12, 0, 0); let clock = startedAt;
  const feature = createVideoFeature({ dataDir, now: () => clock, minFreeDiskBytes: 0 });
  const created = feature.createProject("tenant_a", { name: "Known generation recovery" });
  const attemptId = "sw_known_generation_escape"; const generationId = "gen-known-generation-escape";
  feature.applyCommand("tenant_a", created.id, {
    type: "screenwriter.attempt", begin: true,
    attempt: { attemptId, generationId, status: "reconciliation_required", sourceScreenplaySha256: screenplaySha(""), sourceGenerationId: null, settlement: { status: "awaiting_response", costUsd: 0 } },
  });
  const recoveredProject = feature.createProject("tenant_a", { name: "Generation recovered on final check" });
  const recoveredAttemptId = "sw_generation_recovers_at_quarantine"; const recoveredGenerationId = "gen-recovers-at-quarantine";
  feature.applyCommand("tenant_a", recoveredProject.id, {
    type: "screenwriter.attempt", begin: true,
    attempt: { attemptId: recoveredAttemptId, generationId: recoveredGenerationId, status: "reconciliation_required", reconciliationFailures: 3, lastReconciliationError: "openrouter_generation_http_404", sourceScreenplaySha256: screenplaySha(""), sourceGenerationId: null, settlement: { status: "awaiting_response", costUsd: 0 } },
  });

  let metadataGets = 0; let recoveredMetadataGets = 0; let providerPosts = 0; let meterCalls = 0;
  const env = setup({
    feature,
    now: () => clock,
    fetch: async (url, options) => {
      if (options.method === "POST") { providerPosts++; throw new Error("known-generation recovery must not retry Trinity"); }
      const requestedId = new URL(String(url)).searchParams.get("id");
      if (requestedId === recoveredGenerationId) {
        recoveredMetadataGets++;
        return new Response(JSON.stringify({ data: { id: recoveredGenerationId, model: "arcee-ai/trinity-large-thinking", api_type: "completions", total_cost: 0, finish_reason: "error" } }), { status: 200 });
      }
      metadataGets++; assert.equal(requestedId, generationId);
      if (metadataGets === 2) return new Response(JSON.stringify({ data: { id: generationId, model: "not-trinity", api_type: "completions", total_cost: 0, finish_reason: "error" } }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "generation metadata is not available" } }), { status: 404 });
    },
    meter: async () => { meterCalls++; throw new Error("failed metadata must not be metered"); },
  });

  const expectedCodes = ["openrouter_generation_http_404", "screenwriter_reconciliation_model_mismatch", "openrouter_generation_http_404"];
  for (let index = 0; index < expectedCodes.length; index++) {
    const failed = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: created.id, privacyMode: "normal" });
    assert.equal(failed.body.code, expectedCodes[index]);
    const diskState = createVideoFeature({ dataDir, minFreeDiskBytes: 0 }).getProject("tenant_a", created.id);
    const durableAttempt = diskState.providerAttempts.find((attempt) => attempt.attemptId === attemptId);
    assert.equal(durableAttempt.reconciliationFailures, index + 1);
    assert.equal(durableAttempt.lastReconciliationError, expectedCodes[index]);
    assert.equal(durableAttempt.lastReconciledAt, new Date(clock).toISOString());
  }
  assert.equal(metadataGets, 3); assert.equal(providerPosts, 0); assert.equal(meterCalls, 0);

  clock = startedAt + 9 * 60 * 1000 + 59_999;
  const beforeTenMinutes = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${created.id}`);
  assert.equal(beforeTenMinutes.body.recoveryAction, "check_generation");
  assert.equal(beforeTenMinutes.body.quarantineConfirmation, null);

  clock = startedAt + 10 * 60 * 1000;
  const eligible = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${created.id}`);
  const confirmation = `QUARANTINE ${attemptId} WITHOUT_DOMINION_BILLING`;
  assert.equal(eligible.body.recoveryAction, "quarantine_unrecoverable");
  assert.equal(eligible.body.quarantineConfirmation, confirmation);
  desktopCapabilities.delete(env.http);
  const quarantined = await call(env.http, "POST", "/api/video/screenwriter/quarantine", { projectId: created.id, confirmation });
  assert.equal(quarantined.res.statusCode, 200); assert.equal(quarantined.body.status, "operator_quarantined");
  assert.equal(metadataGets, 4);

  const afterQuarantine = createVideoFeature({ dataDir, minFreeDiskBytes: 0 }).getProject("tenant_a", created.id);
  const terminalAttempt = afterQuarantine.providerAttempts.find((attempt) => attempt.attemptId === attemptId);
  assert.equal(terminalAttempt.status, "operator_quarantined"); assert.equal(terminalAttempt.settlement.status, "not_billed");
  assert.equal(terminalAttempt.reconciliationFailures, 3);
  const idle = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${created.id}`);
  assert.equal(idle.body.pending, false); assert.equal(idle.body.status, "idle");

  const client = feature.getClientProject("tenant_a", created.id);
  const unlocked = await call(env.http, "POST", "/api/video/projects/checkpoint", {
    projectId: created.id, label: "Editing unlocked after known-generation quarantine", state: client,
    expectedScreenplaySha256: client.screenplaySha256, expectedProjectRevision: client.projectRevision,
  });
  assert.equal(unlocked.res.statusCode, 200);

  const recoveredEligible = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${recoveredProject.id}`);
  const recoveredConfirmation = `QUARANTINE ${recoveredAttemptId} WITHOUT_DOMINION_BILLING`;
  assert.equal(recoveredEligible.body.recoveryAction, "quarantine_unrecoverable");
  assert.equal(recoveredEligible.body.quarantineConfirmation, recoveredConfirmation);
  const recoveredRefusal = await call(env.http, "POST", "/api/video/screenwriter/quarantine", { projectId: recoveredProject.id, confirmation: recoveredConfirmation });
  assert.equal(recoveredRefusal.res.statusCode, 409); assert.equal(recoveredRefusal.body.code, "screenwriter_generation_now_recoverable");
  const recoveredState = createVideoFeature({ dataDir, minFreeDiskBytes: 0 }).getProject("tenant_a", recoveredProject.id);
  const resetAttempt = recoveredState.providerAttempts.find((attempt) => attempt.attemptId === recoveredAttemptId);
  assert.equal(resetAttempt.status, "reconciliation_required"); assert.equal(resetAttempt.reconciliationFailures, 0);
  assert.equal(resetAttempt.lastReconciliationError, null);
  assert.equal(resetAttempt.lastReconciledAt, new Date(clock).toISOString()); assert.equal(resetAttempt.settlement.status, "awaiting_response");
  const recoveredStatus = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${recoveredProject.id}`);
  assert.equal(recoveredStatus.body.recoveryAction, "check_generation"); assert.equal(recoveredStatus.body.quarantineConfirmation, null);
  assert.equal(metadataGets, 4); assert.equal(recoveredMetadataGets, 1); assert.equal(providerPosts, 0); assert.equal(meterCalls, 0);
});

test("a deferred quarantine verification locks out concurrent reconciliation and preserves the terminal attempt", async () => {
  const clock = Date.UTC(2026, 0, 3, 12, 0, 0); const mock = featureMock();
  const attemptId = "sw_quarantine_reconcile_race"; const generationId = "gen-quarantine-reconcile-race";
  mock.projects.get(PROJECT_ID).providerAttempts.push({
    attemptId, generationId, status: "reconciliation_required", reconciliationFailures: 3,
    lastReconciliationError: "openrouter_generation_http_404", createdAt: new Date(clock - 11 * 60 * 1000).toISOString(),
    sourceScreenplaySha256: screenplaySha("FADE IN"), sourceGenerationId: null,
    settlement: { status: "awaiting_response", costUsd: 0 },
  });
  let announceMetadata; let resolveMetadata; let metadataGets = 0; let providerPosts = 0;
  const metadataStarted = new Promise((resolve) => { announceMetadata = resolve; });
  const metadataResponse = new Promise((resolve) => { resolveMetadata = resolve; });
  const env = setup({
    feature: mock.feature, now: () => clock,
    fetch: async (url, options) => {
      if (options.method === "POST") { providerPosts++; throw new Error("race recovery must never POST to Trinity"); }
      metadataGets++; assert.equal(String(url), `https://openrouter.test/api/v1/generation?id=${generationId}`);
      announceMetadata(); return metadataResponse;
    },
  });
  const confirmation = `QUARANTINE ${attemptId} WITHOUT_DOMINION_BILLING`;
  const quarantine = call(env.http, "POST", "/api/video/screenwriter/quarantine", { projectId: PROJECT_ID, confirmation, privacyMode: "normal" });
  await metadataStarted;

  const reconcile = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: PROJECT_ID, privacyMode: "normal" });
  assert.equal(reconcile.res.statusCode, 409); assert.equal(reconcile.body.code, "screenwriter_busy");
  assert.equal(metadataGets, 1); assert.equal(providerPosts, 0);

  resolveMetadata(new Response(JSON.stringify({ error: { message: "generation still not found" } }), { status: 404 }));
  const quarantined = await quarantine;
  assert.equal(quarantined.res.statusCode, 200); assert.equal(quarantined.body.status, "operator_quarantined");
  const terminal = structuredClone(mock.projects.get(PROJECT_ID).providerAttempts.find((attempt) => attempt.attemptId === attemptId));
  assert.equal(terminal.status, "operator_quarantined"); assert.equal(terminal.settlement.status, "not_billed");
  assert.equal(terminal.reconciliationFailures, 3); assert.equal(env.metered.length, 0);

  const afterTerminal = await call(env.http, "POST", "/api/video/screenwriter/reconcile", { projectId: PROJECT_ID, privacyMode: "normal" });
  assert.equal(afterTerminal.res.statusCode, 200); assert.equal(afterTerminal.body.status, "idle");
  assert.deepEqual(mock.projects.get(PROJECT_ID).providerAttempts.find((attempt) => attempt.attemptId === attemptId), terminal);
  assert.equal(metadataGets, 1); assert.equal(providerPosts, 0);
});

test("screenwriter status distinguishes an active turn from durable action required", async () => {
  let releaseProvider; let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const env = setup({ fetch: async () => {
    providerStarted(); await new Promise((resolve) => { releaseProvider = resolve; });
    return new Response(JSON.stringify({
      id: "gen-status-active", model: "arcee-ai/trinity-large-thinking",
      choices: [{ finish_reason: "stop", message: { content: "INT. EDIT SUITE - NIGHT" } }],
      usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24, cost: 0.00001032 },
    }), { status: 200 });
  } });
  setPersistedScreenplay(env, "Write an editor scene");
  const turn = call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an editor scene", limit: 115_000 });
  await started;
  const active = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(active.body.active, true); assert.equal(active.body.pending, true); assert.equal(active.body.actionRequired, false); assert.equal(active.body.status, "active");
  releaseProvider(); assert.equal((await turn).res.statusCode, 200);
  const idle = await call(env.http, "GET", `/api/video/screenwriter/status?projectId=${PROJECT_ID}`);
  assert.equal(idle.body.active, false); assert.equal(idle.body.pending, false); assert.equal(idle.body.status, "idle");
});

test("screenwriter rejects a stale first turn before calling OpenRouter", async () => {
  let providerCalls = 0;
  const env = setup({ fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  assert.equal(env.projects.get(PROJECT_ID).ai.screenwriter, undefined);
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "A newly typed first-turn brief", limit: 115_000 });
  assert.equal(out.res.statusCode, 409);
  assert.equal(out.body.code, "screenwriter_stale_prompt");
  assert.equal(providerCalls, 0);
  assert.equal(env.calls.some((entry) => entry[0] === "applyCommand"), false);
  assert.equal(env.metered.length, 0);
});

test("screenwriter preserves leading and trailing screenplay whitespace for the exact stale guard", async () => {
  const providerCalls = [];
  const env = setup({ fetch: async (_url, options) => {
    providerCalls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      id: "gen-trinity-whitespace", model: "arcee-ai/trinity-large-thinking",
      choices: [{ finish_reason: "stop", message: { content: "INT. STUDIO - DAY" } }],
      usage: { prompt_tokens: 22, completion_tokens: 8, total_tokens: 30, cost: 0.0000129 },
    }), { status: 200 });
  } });
  const exact = "  FADE IN.\n\nEXT. HARBOR - DAWN\nA bell rings.  \n";
  setPersistedScreenplay(env, exact);
  env.projects.get(PROJECT_ID).ai.screenwriter = { state: { brief: "Harbor mystery", generatedSections: 1, generationId: "gen-prior-whitespace" } };
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: exact, limit: 115_000 });
  assert.equal(out.res.statusCode, 200);
  assert.equal(providerCalls.length, 1);
  assert.ok(providerCalls[0].messages.at(-1).content.includes(exact));
  assert.equal(env.screened.at(-1), exact);
  const screenplaySet = env.calls.find((entry) => entry[0] === "applyCommand" && entry[3].type === "screenplay.set")[3];
  assert.equal(screenplaySet.text.slice(0, exact.length), exact);
});

test("screenwriter privacy modes refuse OpenRouter unless normal mode explicitly allows exact Trinity", async () => {
  const privacyChecks = [];
  const providerCalls = [];
  const env = setup({
    privacy: {
      modeAllows(mode, model) {
        privacyChecks.push({ mode, model });
        return { allowed: mode === "normal", reason: `${mode} blocks this provider` };
      },
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      providerCalls.push(body);
      return new Response(JSON.stringify({
        id: "gen-trinity-privacy",
        model: "arcee-ai/trinity-large-thinking",
        choices: [{ finish_reason: "stop", message: { content: "EXT. GARDEN - MORNING" } }],
        usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24, cost: 0.00001032 },
      }), { status: 200 });
    },
  });
  setPersistedScreenplay(env, "Write a private garden opening");

  const trusted = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a private garden opening", limit: 115_000, privacyMode: "trusted" });
  assert.equal(trusted.res.statusCode, 403);
  assert.equal(trusted.body.code, "privacy_mode_block");
  assert.equal(providerCalls.length, 0);

  const privateMode = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a private garden opening", limit: 115_000, privacyMode: "private" });
  assert.equal(privateMode.res.statusCode, 403);
  assert.equal(privateMode.body.code, "privacy_mode_block");
  assert.equal(providerCalls.length, 0);

  const normal = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a private garden opening", limit: 115_000, privacyMode: "normal" });
  assert.equal(normal.res.statusCode, 200);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].model, "arcee-ai/trinity-large-thinking");
  assert.deepEqual(privacyChecks, [
    { mode: "trusted", model: "arcee-ai/trinity-large-thinking" },
    { mode: "private", model: "arcee-ai/trinity-large-thinking" },
    { mode: "normal", model: "arcee-ai/trinity-large-thinking" },
  ]);
});

test("screenwriter rejects stale and concurrent turns before a second paid request", async () => {
  let staleCalls = 0;
  const stale = setup({ fetch: async () => { staleCalls++; throw new Error("must not call"); } });
  const staleProject = stale.projects.get(PROJECT_ID);
  staleProject.screenplay.text = "CURRENT SAVED SCREENPLAY";
  staleProject.ai.screenwriter = { state: { brief: "Mystery", generatedSections: 1, generationId: "gen-current", lastTurn: null } };
  const rejected = await call(stale.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "OLDER SCREENPLAY", limit: 115_000 });
  assert.equal(rejected.res.statusCode, 409);
  assert.equal(rejected.body.code, "screenwriter_stale_prompt");
  assert.equal(staleCalls, 0);

  let releaseProvider; let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const concurrent = setup({ fetch: async () => {
    announceStarted();
    await new Promise((resolve) => { releaseProvider = resolve; });
    return new Response(JSON.stringify({
      id: "gen-trinity-locked", model: "arcee-ai/trinity-large-thinking",
      choices: [{ finish_reason: "stop", message: { content: "EXT. LIGHTHOUSE - NIGHT" } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.0000129 },
    }), { status: 200 });
  } });
  const first = call(concurrent.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "FADE IN", limit: 115_000 });
  await started;
  const duplicate = await call(concurrent.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "FADE IN", limit: 115_000 });
  assert.equal(duplicate.res.statusCode, 409);
  assert.equal(duplicate.body.code, "screenwriter_busy");
  releaseProvider();
  assert.equal((await first).res.statusCode, 200);
});

test("chat runs DeepSeek director then cached Sonnet liaison and persists both outputs", async () => {
  const providerCalls = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); providerCalls.push({ url: String(url), body, options });
    if (body.model === "deepseek-ai/deepseek-v4-pro") return new Response(JSON.stringify({ choices: [{ message: { content: "Move the reveal to scene three." } }], usage: { total_tokens: 88 } }), { status: 200 });
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ order: 1, sceneId: "s1", title: "Reveal", imagePrompt: "A rain-lit close-up of the heroine", videoPrompt: "Slow push in", continuity: "Red coat", suggestedVideoModel: "google:gemini@omni-flash" }] }) } }], usage: { total_tokens: 44 } }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "I will move the reveal and preserve continuity." }], usage: { input_tokens: 99, output_tokens: 14 } }), { status: 200 });
  };
  const env = setup({ fetch });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "The reveal happens too early", context: { selected: "s2" } });
  assert.equal(out.res.statusCode, 200);
  assert.match(out.body.reply, /preserve continuity/);
  assert.equal(providerCalls.length, 3);
  assert.equal(providerCalls[0].body.model, "deepseek-ai/deepseek-v4-pro");
  assert.equal(providerCalls[0].body.stream, false);
  assert.deepEqual(providerCalls[0].body.chat_template_kwargs, { thinking: false });
  assert.equal(Object.hasOwn(providerCalls[0].body, "extra_body"), false);
  assert.equal(providerCalls[0].body.top_p, .95);
  assert.equal(providerCalls[0].body.max_tokens, 512);
  assert.equal(providerCalls[1].body.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(providerCalls[1].body.stream, false);
  assert.deepEqual(providerCalls[1].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(Object.hasOwn(providerCalls[1].body, "extra_body"), false);
  assert.equal(providerCalls[1].body.temperature, 1); assert.equal(providerCalls[1].body.top_p, .95);
  assert.equal(providerCalls[2].body.model, "claude-sonnet-5");
  assert.equal(providerCalls[2].body.system[0].cache_control.type, "ephemeral");
  assert.equal(providerCalls[2].body.messages[0].content[0].cache_control.type, "ephemeral");
  assert.equal(out.body.visualOrchestrator.plan.scenes[0].imagePrompt, "A rain-lit close-up of the heroine");
  assert.equal(out.body.visualOrchestrator.applied, true); assert.equal(out.body.visualOrchestrator.applyStatus, "applied");
  const saved = env.calls.find((entry) => entry[0] === "updateAiState")[3];
  assert.equal(saved.expectedProjectRevision, 1);
  assert.equal(saved.director.directive, "Move the reveal to scene three.");
  assert.equal(saved.visualOrchestrator.plan.scenes[0].sceneId, "s1");
  assert.match(saved.liaison.reply, /preserve continuity/);
  assert.equal(env.calls.filter((entry) => entry[0] === "updateAiState").length, 1);
  assert.equal(env.calls.some((entry) => entry[0] === "applyCommand"), false);
  assert.equal(env.projects.get(PROJECT_ID).history.head, 2);
  assert.equal(env.projects.get(PROJECT_ID).scenes[0].sceneId, "s1");
  assert.equal(env.projects.get(PROJECT_ID).conversation.length, 2);
});

test("chat atomically saves all AI roles but quarantines a visual plan after a concurrent project change", async () => {
  const mock = featureMock();
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.model === "deepseek-ai/deepseek-v4-pro") return new Response(JSON.stringify({ choices: [{ message: { content: "Hold on the final frame." } }], usage: { total_tokens: 41 } }), { status: 200 });
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ sceneId: "ai_scene", imagePrompt: "A still silhouette against dawn" }] }) } }] }), { status: 200 });
    mock.projects.get(PROJECT_ID).scenes = [{ id: "newer_user_scene", title: "Newer user edit" }];
    mock.projects.get(PROJECT_ID).history.head++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "I will hold the final frame." }] }), { status: 200 });
  };
  const env = setup({ feature: mock.feature, fetch });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Give the ending room" });
  assert.equal(out.res.statusCode, 200);
  assert.equal(out.body.visualOrchestrator.applied, false); assert.equal(out.body.visualOrchestrator.applyStatus, "quarantined_stale");
  assert.deepEqual(out.body.degraded, ["visualPlanStale"]); assert.equal(out.body.visualOrchestrator.error.code, "visual_plan_quarantined_stale");
  const stored = mock.projects.get(PROJECT_ID);
  assert.equal(stored.history.head, 3); assert.equal(stored.scenes[0].id, "newer_user_scene");
  assert.equal(stored.ai.director.state.directive, "Hold on the final frame.");
  assert.equal(stored.ai.visualOrchestrator.state.plan.scenes[0].sceneId, "ai_scene");
  assert.match(stored.ai.liaison.state.reply, /final frame/); assert.equal(stored.conversation.length, 2);
  assert.equal(mock.calls.filter((entry) => entry[0] === "updateAiState").length, 1);
  assert.equal(mock.calls.some((entry) => entry[0] === "applyCommand"), false);
});

test("a concurrent same-project chat is refused before provider egress while the first turn truthfully quarantines after mutation", async () => {
  const mock = featureMock(); const providerCalls = [];
  let announceDirector; let releaseDirector;
  const directorStarted = new Promise((resolve) => { announceDirector = resolve; });
  const directorGate = new Promise((resolve) => { releaseDirector = resolve; });
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body); providerCalls.push(body.model);
    if (body.model === "deepseek-ai/deepseek-v4-pro") {
      announceDirector(); await directorGate;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Keep the newer edit and preserve this proposal." } }], usage: { total_tokens: 20 } }), { status: 200 });
    }
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ sceneId: "deferred_plan", imagePrompt: "A deferred visual plan" }] }) } }] }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "I preserved the proposal without replacing newer work." }] }), { status: 200 });
  };
  const env = setup({ feature: mock.feature, fetch });
  const first = call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Plan the reveal" });
  await directorStarted;

  const duplicate = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Run a second plan" });
  assert.equal(duplicate.res.statusCode, 409); assert.equal(duplicate.body.code, "video_ai_busy");
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro"]);

  mock.feature.checkpointProject("tenant_a", PROJECT_ID, {
    label: "Intervening user checkpoint", state: { screenplay: "FADE IN" },
    expectedScreenplaySha256: screenplaySha("FADE IN"), expectedProjectRevision: 1,
  });
  releaseDirector();
  const completed = await first;
  assert.equal(completed.res.statusCode, 200);
  assert.equal(completed.body.visualOrchestrator.applied, false);
  assert.equal(completed.body.visualOrchestrator.applyStatus, "quarantined_stale");
  assert.deepEqual(completed.body.degraded, ["visualPlanStale"]);
  assert.equal(completed.body.visualOrchestrator.error.code, "visual_plan_quarantined_stale");
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro", "nvidia/nemotron-3-ultra-550b-a55b", "claude-sonnet-5"]);
  assert.equal(mock.calls.filter((entry) => entry[0] === "updateAiState").length, 1);
  assert.equal(mock.projects.get(PROJECT_ID).history.head, 3);
});

test("project deletion is refused while chat is active and the released AI turn saves atomically", async () => {
  const mock = featureMock(); const providerCalls = [];
  let announceDirector; let releaseDirector;
  const directorStarted = new Promise((resolve) => { announceDirector = resolve; });
  const directorGate = new Promise((resolve) => { releaseDirector = resolve; });
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body); providerCalls.push(body.model);
    if (body.model === "deepseek-ai/deepseek-v4-pro") {
      announceDirector(); await directorGate;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Keep this project alive through the save." } }], usage: { total_tokens: 18 } }), { status: 200 });
    }
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ sceneId: "saved_after_delete_race", imagePrompt: "A project safely preserved" }] }) } }] }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "The project and its new plan are saved." }] }), { status: 200 });
  };
  const env = setup({ feature: mock.feature, fetch });
  const chat = call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Save this plan" });
  await directorStarted;

  const deletion = await call(env.http, "DELETE", `/api/video/projects/${PROJECT_ID}`, { confirmDelete: true });
  assert.equal(deletion.res.statusCode, 409); assert.equal(deletion.body.code, "video_ai_busy");
  assert.equal(mock.projects.has(PROJECT_ID), true);
  assert.equal(mock.calls.some((entry) => entry[0] === "deleteProject"), false);
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro"]);

  releaseDirector();
  const completed = await chat;
  assert.equal(completed.res.statusCode, 200); assert.equal(completed.body.saved, true);
  assert.equal(completed.body.visualOrchestrator.applyStatus, "applied");
  assert.equal(mock.projects.has(PROJECT_ID), true);
  assert.equal(mock.projects.get(PROJECT_ID).history.head, 2);
  assert.equal(mock.projects.get(PROJECT_ID).scenes[0].sceneId, "saved_after_delete_race");
  assert.equal(mock.calls.filter((entry) => entry[0] === "updateAiState").length, 1);
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro", "nvidia/nemotron-3-ultra-550b-a55b", "claude-sonnet-5"]);
});

test("NVIDIA compaction uses the same explicit non-streaming DeepSeek request shape", async () => {
  const mock = featureMock(); delete mock.feature.getClientProject; mock.projects.get(PROJECT_ID).ai.director.compactionRequired = true;
  const providerCalls = []; const fetch = async (url, options) => {
    const body = JSON.parse(options.body); providerCalls.push(body);
    if (body.model === "deepseek-ai/deepseek-v4-pro" && providerCalls.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: "Faithful summary" } }] }), { status: 200 });
    if (body.model === "deepseek-ai/deepseek-v4-pro") return new Response(JSON.stringify({ choices: [{ message: { content: "Use the summary." } }] }), { status: 200 });
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ imagePrompt: "A locked frame" }] }) } }] }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "I saved the plan." }] }), { status: 200 });
  };
  const env = setup({ feature: mock.feature, fetch }); const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Keep the essential context" });
  assert.equal(out.res.statusCode, 200); assert.equal(providerCalls[0].stream, false); assert.equal(providerCalls[0].top_p, .95); assert.deepEqual(providerCalls[0].chat_template_kwargs, { thinking: false });
});

test("visual orchestrator failure is surfaced as structured degradation without model substitution", async () => {
  const providerCalls = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); providerCalls.push(body.model);
    if (body.model === "deepseek-ai/deepseek-v4-pro") return new Response(JSON.stringify({ choices: [{ message: { content: "Build three ordered images." } }] }), { status: 200 });
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ error: { message: "visual endpoint unavailable" } }), { status: 503 });
    assert.equal(body.model, "claude-sonnet-5");
    assert.match(body.messages.at(-1).content, /DEGRADED/);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "The visual planner is unavailable; the director plan is saved." }] }), { status: 200 });
  };
  const env = setup({ fetch });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Plan the images" });
  assert.equal(out.res.statusCode, 200);
  assert.deepEqual(out.body.degraded, ["visualOrchestrator"]);
  assert.equal(out.body.visualOrchestrator.available, false);
  assert.equal(out.body.visualOrchestrator.error.code, "nvidia_visual_orchestrator_http_503");
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro", "nvidia/nemotron-3-ultra-550b-a55b", "claude-sonnet-5"]);
});

test("a director failure is explicit and never falls through to Sonnet", async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ error: { message: "model is unavailable" } }), { status: 404 }); };
  const env = setup({ fetch });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Change the ending" });
  assert.equal(out.res.statusCode, 400);
  assert.equal(out.body.code, "nvidia_director_http_404");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("nvidia"), true);
});

test("a provider deadline abort is returned once as a timeout instead of being retried", async () => {
  let calls = 0; const fetch = async () => { calls++; const error = new Error("deadline"); error.name = "AbortError"; throw error; };
  const env = setup({ fetch }); const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Change the ending" });
  assert.equal(out.res.statusCode, 504); assert.equal(out.body.code, "nvidia_director_timeout"); assert.equal(calls, 1);
});

test("the aggregate AI-turn deadline stops before another provider request and never retries completed work", async () => {
  let clock = 0; const providerCalls = [];
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body); providerCalls.push(body.model);
    clock = 31_000;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Use one deliberate reveal." } }], usage: { total_tokens: 12 } }), { status: 200 });
  };
  const env = setup({ fetch, now: () => clock, nvidia: { aiTurnTimeoutMs: 30_000 } });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Tighten the reveal" });
  assert.equal(out.res.statusCode, 504); assert.equal(out.body.code, "video_ai_turn_timeout");
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro"]);
  assert.equal(env.calls.some((entry) => entry[0] === "updateAiState"), false);
});

test("deployment drain tracks an active AI turn and refuses new AI work until its atomic save completes", async () => {
  let releaseDirector; let announceDirector;
  const directorStarted = new Promise((resolve) => { announceDirector = resolve; });
  const providerCalls = [];
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body); providerCalls.push(body.model);
    if (body.model === "deepseek-ai/deepseek-v4-pro") {
      announceDirector(); await new Promise((resolve) => { releaseDirector = resolve; });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Preserve the final beat." } }], usage: { total_tokens: 10 } }), { status: 200 });
    }
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ imagePrompt: "A quiet final frame" }] }) } }] }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "The final beat is preserved." }] }), { status: 200 });
  };
  const env = setup({ fetch });
  const turn = call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Preserve the ending" });
  await directorStarted;
  let drainFinished = false;
  const draining = env.http.drain({ timeoutMs: 5_000 }).then((result) => { drainFinished = true; return result; });
  await Promise.resolve(); assert.equal(drainFinished, false);
  const refused = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Start another turn" });
  assert.equal(refused.res.statusCode, 503); assert.equal(refused.body.code, "video_ai_draining");
  releaseDirector(); assert.equal((await turn).res.statusCode, 200);
  const drained = await draining;
  assert.deepEqual(drained, { pending: 1, completed: 1, timedOut: false });
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro", "nvidia/nemotron-3-ultra-550b-a55b", "claude-sonnet-5"]);
  assert.equal(env.calls.filter((entry) => entry[0] === "updateAiState").length, 1);
});

test("AI requests enforce exact role models and final serialized context windows", async () => {
  let providerCalls = 0;
  const wrongDirector = setup({ nvidia: { directorModel: "another/model" }, fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  const mismatch = await call(wrongDirector.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Plan this" });
  assert.equal(mismatch.res.statusCode, 503); assert.equal(mismatch.body.code, "director_model_mismatch"); assert.equal(providerCalls, 0);

  const wrongVisual = setup({ nvidia: { visualModel: "another/model" } });
  const config = await call(wrongVisual.http, "GET", "/api/video/config");
  assert.equal(config.body.agents.visualOrchestrator.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(config.body.agents.visualOrchestrator.configured, false);

  const wrongWriter = setup({ openrouter: { screenwriterModel: "another/model" }, fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  const writerConfig = await call(wrongWriter.http, "GET", "/api/video/config");
  assert.equal(writerConfig.body.agents.screenwriter.model, "arcee-ai/trinity-large-thinking");
  assert.equal(writerConfig.body.agents.screenwriter.configured, false);
  setPersistedScreenplay(wrongWriter, "Write an opening");
  const writerMismatch = await call(wrongWriter.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(writerMismatch.res.statusCode, 503); assert.equal(writerMismatch.body.code, "screenwriter_model_mismatch"); assert.equal(providerCalls, 0);

  const missingWriter = setup({ openrouter: { apiKey: () => "" }, fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  setPersistedScreenplay(missingWriter, "Write an opening");
  const unavailable = await call(missingWriter.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write an opening", limit: 115_000 });
  assert.equal(unavailable.res.statusCode, 503); assert.equal(unavailable.body.code, "screenwriter_not_configured"); assert.equal(providerCalls, 0);

  const oversized = setup({ fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  const tooLarge = await call(oversized.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, expectedProjectRevision: 1, message: "Plan this", context: { immutableNotes: "x".repeat(3_100_000) } });
  assert.equal(tooLarge.res.statusCode, 413); assert.equal(tooLarge.body.code, "video_director_context_limit"); assert.equal(providerCalls, 0);

  const screenplay = await call(oversized.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "é".repeat(180_000) });
  assert.equal(screenplay.res.statusCode, 413); assert.equal(screenplay.body.code, "video_screenplay_limit"); assert.equal(providerCalls, 0);
});

test("tenant-scoped write rate limits reject excess project creation before work starts", async () => {
  const env = setup();
  for (let index = 0; index < 10; index++) {
    const made = await call(env.http, "POST", "/api/video/projects", { name: `Project ${index}` });
    assert.equal(made.res.statusCode, 201);
  }
  const denied = await call(env.http, "POST", "/api/video/projects", { name: "Excess" });
  assert.equal(denied.res.statusCode, 429); assert.equal(denied.body.code, "video_rate_limited");
  assert.equal(env.calls.filter((entry) => entry[0] === "createProject").length, 10);
});

test("exports use the injected media contract and reject a missing encoder", async () => {
  const exportCalls = [];
  const env = setup({ media: { exportProject: async (input) => { exportCalls.push(input); return { id: "export_1", status: "queued" }; } } });
  const out = await call(env.http, "POST", "/api/video/exports", { projectId: PROJECT_ID, format: "mp4", clips: [] });
  assert.equal(out.res.statusCode, 202);
  assert.equal(exportCalls[0].tenantId, "tenant_a");
  assert.equal(exportCalls[0].projectId, PROJECT_ID);
  assert.equal(exportCalls[0].request.format, "mp4");

  const missing = setup();
  const rejected = await call(missing.http, "POST", "/api/video/exports", { projectId: PROJECT_ID });
  assert.equal(rejected.res.statusCode, 503);
  assert.equal(rejected.body.code, "video_export_unavailable");
});

test("invalid JSON and oversized declared bodies return structured errors", async () => {
  const env = setup();
  const invalid = await call(env.http, "POST", "/api/video/projects", "{");
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(invalid.body.code, "invalid_json");
  const tooLarge = await call(env.http, "POST", "/api/video/projects", {}, { "content-length": String(5 * 1024 * 1024) });
  assert.equal(tooLarge.res.statusCode, 413);
  assert.equal(tooLarge.body.code, "request_too_large");
});

test("non-video paths are not consumed by the adapter", async () => {
  const env = setup();
  for (const path of ["/api/images", "/api/video-malicious-prefix"]) {
    const req = request("GET", path, undefined);
    const res = response();
    assert.equal(await env.http.handle(req, res, new URL(path, "http://test.local")), false);
    assert.equal(res.statusCode, 0);
  }
});
