import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createVideoHttp } from "./video-http.mjs";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MOBILE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "job_123";

function request(method, url, body, headers = {}) {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = url;
  req.headers = { ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}), ...headers };
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    raw: "",
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; },
    end(value = "") { this.raw += value ? String(value) : ""; this.ended = true; },
    get json() { return this.raw ? JSON.parse(this.raw) : null; },
  };
}

const desktopCapabilities = new WeakMap();
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
  const req = request(method, path, body, headers);
  const res = response();
  const handled = await http.handle(req, res, new URL(path, "http://test.local"));
  return { handled, req, res, body: res.json };
}

function project(id = PROJECT_ID, tenantId = "tenant_a") {
  return {
    id, tenantId, name: "Launch film", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    screenplay: { text: "FADE IN", tokens: 2 }, scenes: [],
    timeline: { videoTracks: [1, 2, 3].map((n) => ({ id: `v${n}`, kind: "video", clips: [] })), audioTracks: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, kind: "audio", clips: [] })) },
    ai: { director: { state: {} } }, jobs: [],
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
    getClientProject(tenantId, id) { calls.push(["getClientProject", tenantId, id]); const value = feature.getProject(tenantId, id); return { project: { id: value.id, name: value.name, model: "google:gemini@omni-flash", ratio: "16:9", resolution: "720p" }, screenplay: value.screenplay.text, scenes: [], tracks: [], clips: [], ui: {} }; },
    checkpointProject(tenantId, id, input) { calls.push(["checkpointProject", tenantId, id, input]); feature.getProject(tenantId, id); return { label: input.label, head: 2 }; },
    renameProject(tenantId, id, name) { calls.push(["renameProject", tenantId, id, name]); const value = projects.get(id); value.name = name; return value; },
    deleteProject(tenantId, id, input) { calls.push(["deleteProject", tenantId, id, input]); feature.getProject(tenantId, id); projects.delete(id); return { deleted: true, id }; },
    applyCommand(tenantId, id, command) { calls.push(["applyCommand", tenantId, id, command]); feature.getProject(tenantId, id); return { ok: true }; },
    updateAiState(tenantId, id, state) { calls.push(["updateAiState", tenantId, id, state]); feature.getProject(tenantId, id); return { ok: true }; },
    submitGeneration(tenantId, id, input) { calls.push(["submitGeneration", tenantId, id, input]); const value = projects.get(id); value.jobs.push({ id: JOB_ID, status: "generating", request: input }); return { jobId: JOB_ID, taskUuid: JOB_ID, project: id }; },
    pollJob(tenantId, id, jobId) { calls.push(["pollJob", tenantId, id, jobId]); feature.getProject(tenantId, id); return { id: jobId, status: "generating", request: { duration: 5 } }; },
    downloadJobOutput(tenantId, id, jobId) { calls.push(["downloadJobOutput", tenantId, id, jobId]); return { id: jobId, status: "ready", localOutput: `Z:/data/${jobId}.mp4`, request: { duration: 5 }, cost: 0.12, media: { hasAudio: true, duration: 5 }, clips: [{ id: `clip-${jobId}`, trackId: "v1", type: "video", start: 2, duration: 5, mediaJobId: jobId, mediaFile: `${jobId}.mp4`, linked: `audio-${jobId}` }, { id: `audio-${jobId}`, trackId: "a1", type: "audio", start: 2, duration: 5, mediaJobId: jobId, mediaFile: `${jobId}.mp4`, linked: `clip-${jobId}` }] }; },
    paths() { return { generated: "Z:/data/generated", exports: "Z:/data/exports" }; },
    ...overrides,
  };
  return { feature, calls, projects };
}

function setup({ tenant, feature: customFeature, billing: customBilling, fetch: fetchImpl, nvidia = {}, anthropic = {}, media = {}, desktopPresence, meter: meterImpl } = {}) {
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
    screenContent: (text) => { screened.push(text); return { blocked: false }; },
    fetch: fetchImpl || (async () => { throw new Error("unexpected network"); }),
    runware: { apiKey: () => "runware-test" },
    nvidia: { apiKey: () => "nvidia-test", baseUrl: "https://nvidia.test/v1", directorModel: "deepseek-ai/deepseek-v4-pro", palmyraEnabled: true, ...nvidia },
    anthropic: { apiKey: () => "anthropic-test", baseUrl: "https://anthropic.test", ...anthropic },
    media,
    desktopPresence,
  });
  return { http, T, billing, screened, metered, ...mock };
}

test("config is identity/invite gated and never exposes credentials", async () => {
  const good = setup();
  const result = await call(good.http, "GET", "/api/video/config");
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.body.limits.screenplayTokens, 115_000);
  assert.equal(result.body.agents.screenwriter.model, "writer/palmyra-creative-122b");
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

  const payload = { projectId: PROJECT_ID, label: "Moved scene", state: { project: { id: PROJECT_ID }, scenes: [{ id: "s1" }] } };
  const saved = await call(env.http, "POST", "/api/video/projects/checkpoint", payload);
  assert.equal(saved.res.statusCode, 200);
  const checkpoint = env.calls.find((entry) => entry[0] === "checkpointProject");
  assert.equal(checkpoint[1], "tenant_a");
  assert.equal(checkpoint[2], PROJECT_ID);
  assert.equal(checkpoint[3].label, "Moved scene");

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
    restoreCheckpoint(tenantId, id, seq) { this.getProject(tenantId, id); assert.equal(seq, 3); return {}; },
    undo(tenantId, id) { this.getProject(tenantId, id); return {}; }, redo(tenantId, id) { this.getProject(tenantId, id); return {}; },
    recoverJobs(tenantId, id) { this.getProject(tenantId, id); return [{ id: JOB_ID, status: "generating" }]; },
  });
  const env = setup({ feature: mock.feature });
  const history = await call(env.http, "GET", `/api/video/projects/${PROJECT_ID}/history`);
  assert.equal(history.res.statusCode, 200); assert.equal(history.body.checkpoints[0].seq, 3);
  assert.equal((await call(env.http, "POST", `/api/video/projects/${PROJECT_ID}/restore`, { seq: 3 })).res.statusCode, 200);
  assert.equal((await call(env.http, "POST", `/api/video/projects/${PROJECT_ID}/undo`, {})).res.statusCode, 200);
  assert.equal((await call(env.http, "POST", `/api/video/projects/${PROJECT_ID}/redo`, {})).res.statusCode, 200);
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

test("screenwriter calls only exact Palmyra and saves the screenplay revision", async () => {
  const providerCalls = [];
  const fetch = async (url, options) => {
    providerCalls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "EXT. OCEAN - DAWN\nWaves catch fire." } }], usage: { total_tokens: 120 } }), { status: 200 });
  };
  const env = setup({ fetch });
  const out = await call(env.http, "POST", "/api/video/screenwrite", { projectId: PROJECT_ID, prompt: "Write a dawn opening", limit: 115_000 });
  assert.equal(out.res.statusCode, 200);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, "https://nvidia.test/v1/chat/completions");
  assert.equal(providerCalls[0].body.model, "writer/palmyra-creative-122b");
  assert.equal(providerCalls[0].body.stream, false);
  assert.match(providerCalls[0].options.headers.Authorization, /^Bearer /);
  const command = env.calls.find((entry) => entry[0] === "applyCommand")[3];
  assert.equal(command.type, "screenplay.set");
  assert.match(command.text, /OCEAN/);
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
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "The reveal happens too early", context: { selected: "s2" } });
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
  const saved = env.calls.find((entry) => entry[0] === "updateAiState")[3];
  assert.equal(saved.director.directive, "Move the reveal to scene three.");
  assert.equal(saved.visualOrchestrator.plan.scenes[0].sceneId, "s1");
  assert.match(saved.liaison.reply, /preserve continuity/);
});

test("chat persists through the feature's director checkpoint when updateAiState is absent", async () => {
  const mock = featureMock();
  delete mock.feature.updateAiState;
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.model === "deepseek-ai/deepseek-v4-pro") return new Response(JSON.stringify({ choices: [{ message: { content: "Hold on the final frame." } }], usage: { total_tokens: 41 } }), { status: 200 });
    if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ imagePrompt: "A still silhouette against dawn" }] }) } }] }), { status: 200 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "I will hold the final frame." }] }), { status: 200 });
  };
  const env = setup({ feature: mock.feature, fetch });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Give the ending room" });
  assert.equal(out.res.statusCode, 200);
  const saved = mock.calls.find((entry) => entry[0] === "applyCommand")[3];
  assert.equal(saved.type, "director.state");
  assert.equal(saved.usedTokens, 41);
  assert.match(saved.state.lastTurn.reply, /final frame/);
  const visualSaved = mock.calls.find((entry) => entry[0] === "applyCommand" && entry[3].role === "visualOrchestrator")[3];
  assert.equal(visualSaved.type, "ai.state");
  assert.equal(visualSaved.state.plan.scenes[0].order, 1);
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
  const env = setup({ feature: mock.feature, fetch }); const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Keep the essential context" });
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
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Plan the images" });
  assert.equal(out.res.statusCode, 200);
  assert.deepEqual(out.body.degraded, ["visualOrchestrator"]);
  assert.equal(out.body.visualOrchestrator.available, false);
  assert.equal(out.body.visualOrchestrator.error.code, "nvidia_visual_orchestrator_http_503");
  assert.deepEqual(providerCalls, ["deepseek-ai/deepseek-v4-pro", "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-ultra-550b-a55b", "claude-sonnet-5"]);
});

test("a director failure is explicit and never falls through to Sonnet", async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ error: { message: "model is unavailable" } }), { status: 404 }); };
  const env = setup({ fetch });
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Change the ending" });
  assert.equal(out.res.statusCode, 400);
  assert.equal(out.body.code, "nvidia_director_http_404");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("nvidia"), true);
});

test("a provider deadline abort is returned once as a timeout instead of being retried", async () => {
  let calls = 0; const fetch = async () => { calls++; const error = new Error("deadline"); error.name = "AbortError"; throw error; };
  const env = setup({ fetch }); const out = await call(env.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Change the ending" });
  assert.equal(out.res.statusCode, 504); assert.equal(out.body.code, "nvidia_director_timeout"); assert.equal(calls, 1);
});

test("AI requests enforce exact role models and final serialized context windows", async () => {
  let providerCalls = 0;
  const wrongDirector = setup({ nvidia: { directorModel: "another/model" }, fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  const mismatch = await call(wrongDirector.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Plan this" });
  assert.equal(mismatch.res.statusCode, 503); assert.equal(mismatch.body.code, "director_model_mismatch"); assert.equal(providerCalls, 0);

  const wrongVisual = setup({ nvidia: { visualModel: "another/model" } });
  const config = await call(wrongVisual.http, "GET", "/api/video/config");
  assert.equal(config.body.agents.visualOrchestrator.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(config.body.agents.visualOrchestrator.configured, false);

  const oversized = setup({ fetch: async () => { providerCalls++; throw new Error("must not call"); } });
  const tooLarge = await call(oversized.http, "POST", "/api/video/chat", { projectId: PROJECT_ID, message: "Plan this", context: { immutableNotes: "x".repeat(3_100_000) } });
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
