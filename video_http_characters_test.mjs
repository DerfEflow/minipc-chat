/*
 * HTTP-layer tests for the video-characters lane: character routes, cast hydration, CAST-aware
 * screenwriter/visual-orchestrator prompts and name-to-id mapping, chat-triggered scriptwriting,
 * and /produce (dryRun composition, reference-cap/text-fallback, credit-exhaustion pause).
 *
 * Deliberately backed by the REAL video.mjs and videocharacters.mjs stores (temp dataDir) rather
 * than a hand-rolled feature mock, the same way video_test.mjs itself works: this exercises the
 * actual wiring end to end instead of a second implementation of it that could drift. Only the
 * provider transports (openrouter/nvidia/anthropic/deepseek/runware) are mocked, per AGENT-RULES.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createVideoHttp } from "./video-http.mjs";
import { createVideoFeature } from "./video.mjs";
import { createCharactersFeature } from "./videocharacters.mjs";

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function request(method, url, body, headers = {}) {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method; req.url = url;
  req.headers = { ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}), ...headers };
  return req;
}
function response() {
  const events = new EventEmitter();
  return {
    statusCode: 0, headers: {}, raw: "", headersSent: false, writableEnded: false, destroyed: false,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; this.headersSent = true; },
    once(event, listener) { events.once(event, listener); return this; },
    off(event, listener) { events.off(event, listener); return this; },
    write(value = "") { this.raw += value ? String(value) : ""; events.emit("write"); return true; },
    end(value = "") { this.raw += value ? String(value) : ""; this.ended = true; this.writableEnded = true; events.emit("finish"); },
    destroy(error) { this.destroyed = true; this.destroyError = error; this.writableEnded = true; events.emit("close"); },
    get json() { return this.raw ? JSON.parse(this.raw) : null; },
  };
}
const desktopCapabilities = new WeakMap();
async function call(http, method, path, body, headers = {}) {
  if (path.startsWith("/api/video") && !["GET", "HEAD", "OPTIONS"].includes(method) && !headers["x-dominion-desktop-capability"]) {
    let capability = desktopCapabilities.get(http);
    if (!capability) {
      const configRes = response();
      await http.handle(request("GET", "/api/video/config?device=desktop", undefined, { "user-agent": "Mozilla/5.0 Desktop" }), configRes, new URL("/api/video/config?device=desktop", "http://test.local"));
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

function suite({ tenant, billing, fetch: aiFetch, runwareFetch, generateImages } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-http-characters-"));
  const T = tenant || { tenantId: "tenant_a", email: "a@example.test", role: "credit", status: "active", invited: true, isOwner: true };
  const videoFeature = createVideoFeature({
    dataDir: dir, runwareApiKey: "runware-test",
    fetch: runwareFetch || (async () => { throw new Error("unexpected runware call"); }),
    billingGate: async () => ({ allowed: true }),
    mediaProcessor: { download: async () => ({ bytes: 42 }), verify: async () => ({ valid: true, duration: 3, video: [{}], audio: [] }) },
  });
  const characters = createCharactersFeature({
    dataDir: dir,
    generateImages: generateImages || (async (args) => ({ images: Array.from({ length: args.n || 1 }, () => ({ b64: TINY_PNG_B64, format: "png" })), model: "gpt-image-2", quality: args.quality, aspect: args.aspect, costUsd: 0.006, servedBy: { engine: "paid", model: "gpt-image-2", quality: args.quality } })),
  });
  const http = createVideoHttp({
    feature: videoFeature, characters, resolveTenant: () => T,
    billing: billing || { account: () => ({ autorecharge: true, hasCard: true, balance: 100 }), canChat: () => true },
    meter: async () => undefined,
    screenContent: () => ({ blocked: false }),
    fetch: aiFetch || (async () => { throw new Error("unexpected AI provider call"); }),
    runware: { apiKey: () => "runware-test" },
    openrouter: { apiKey: () => "openrouter-test", url: "https://openrouter.test/api/v1/chat/completions", costForUsage: (usage) => Number(usage?.cost) || 0 },
    nvidia: { apiKey: () => "nvidia-test", baseUrl: "https://nvidia.test/v1" },
    anthropic: { apiKey: () => "anthropic-test", baseUrl: "https://anthropic.test" },
    deepseek: { apiKey: () => "deepseek-test", baseUrl: "https://deepseek.test" },
  });
  return { dir, http, T, videoFeature, characters };
}
function clean(t) { t.after(() => rmSync(t.context.dir, { recursive: true, force: true })); }

async function createProject(env, name = "Ad") {
  const out = await call(env.http, "POST", "/api/video/projects", { name });
  return out.body;
}
async function createCharacter(env, name, description = `${name} description`) {
  const out = await call(env.http, "POST", "/api/video/characters", { name, description });
  assert.equal(out.res.statusCode, 201, JSON.stringify(out.body));
  return out.body.character;
}
async function attach(env, projectId, characterIds, expectedProjectRevision) {
  const out = await call(env.http, "POST", `/api/video/projects/${projectId}/characters`, { characterIds, expectedProjectRevision });
  assert.equal(out.res.statusCode, 200, JSON.stringify(out.body));
  return out.body;
}
const liaisonOk = () => new Response(JSON.stringify({ content: [{ type: "text", text: "Got it." }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200 });

test("character CRUD: create generates images, list/get/patch work, delete refuses while attached then force detaches", async (t) => {
  t.context = suite(); clean(t); const env = t.context;
  const jake = await createCharacter(env, "Jake");
  assert.equal(jake.images.length, 1);
  assert.match(jake.images[0].url, /\/api\/video\/characters\/.+\/images\/1$/);
  const list = await call(env.http, "GET", "/api/video/characters");
  assert.equal(list.body.characters.length, 1);
  const patched = await call(env.http, "PATCH", `/api/video/characters/${jake.id}`, { voiceNotes: "gravelly" });
  assert.equal(patched.body.character.voiceNotes, "gravelly");
  const img = await call(env.http, "GET", jake.images[0].url);
  assert.equal(img.res.statusCode, 200); assert.equal(img.res.headers["content-type"], "image/png");

  const project = await createProject(env);
  await attach(env, project.project.id, [jake.id], project.projectRevision);
  const refused = await call(env.http, "DELETE", `/api/video/characters/${jake.id}`, { force: false });
  assert.equal(refused.res.statusCode, 409); assert.equal(refused.body.code, "character_attached");
  const forced = await call(env.http, "DELETE", `/api/video/characters/${jake.id}`, { force: true });
  assert.equal(forced.res.statusCode, 200); assert.equal(forced.body.deleted, true);
  const reloaded = await call(env.http, "GET", `/api/video/projects/${project.project.id}`);
  assert.deepEqual(reloaded.body.cast, [], "a force-deleted character is gone from the project's hydrated cast too");
});

test("GET /projects/:id returns a hydrated cast with name, description, voiceNotes, and a primary image URL", async (t) => {
  t.context = suite(); clean(t); const env = t.context;
  const jake = await createCharacter(env, "Jake", "A roofing foreman");
  await call(env.http, "PATCH", `/api/video/characters/${jake.id}`, { voiceNotes: "gravelly" });
  const project = await createProject(env);
  await attach(env, project.project.id, [jake.id], project.projectRevision);
  const loaded = await call(env.http, "GET", `/api/video/projects/${project.project.id}`);
  assert.equal(loaded.body.cast.length, 1);
  assert.equal(loaded.body.cast[0].name, "Jake");
  assert.equal(loaded.body.cast[0].description, "A roofing foreman");
  assert.equal(loaded.body.cast[0].voiceNotes, "gravelly");
  assert.match(loaded.body.cast[0].image, /\/api\/video\/characters\/.+\/images\/1$/);
});

test("screenwriter and visual-orchestrator prompts carry a CAST block, and characterNames resolve to characterIds on saved scenes", async (t) => {
  const providerCalls = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); providerCalls.push({ url: String(url), body });
    if (String(url).includes("openrouter.test")) {
      assert.match(body.messages.find((m) => m.role === "user").content, /^CAST:\n- Jake: A roofing foreman \(voice: gravelly\)/, "the screenwriter's user content must open with the CAST block");
      return new Response(JSON.stringify({ id: "gen-1", model: "arcee-ai/trinity-large-thinking", choices: [{ finish_reason: "stop", message: { content: "EXT. ROOF - DAY\nJake surveys the shingles." } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, cost: 0.00003 } }), { status: 200 });
    }
    if (body.model === "nvidia/nemotron-3-super-120b-a12b") {
      assert.ok(JSON.parse(body.messages[1].content).cast.some((c) => c.name === "Jake"), "the visual orchestrator's source JSON must carry the cast");
      assert.match(body.messages[0].content, /characterNames/, "the visual orchestrator must be told to return characterNames");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ order: 1, sceneId: "scene_1", title: "Roof survey", imagePrompt: "Jake on a roof", characterNames: ["Jake"] }] }) } }], usage: { total_tokens: 40 } }), { status: 200 });
    }
    return liaisonOk();
  };
  t.context = suite({ fetch }); clean(t); const env = t.context;
  const jake = await createCharacter(env, "Jake", "A roofing foreman");
  await call(env.http, "PATCH", `/api/video/characters/${jake.id}`, { voiceNotes: "gravelly" });
  const project = await createProject(env);
  const attached = await attach(env, project.project.id, [jake.id], project.projectRevision);
  const out = await call(env.http, "POST", "/api/video/chat", { projectId: project.project.id, expectedProjectRevision: attached.projectRevision, action: "screenwrite", message: "write the two-shot roof scene" });
  assert.equal(out.res.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.action, "screenwrite");
  assert.ok(providerCalls.some((c) => c.url.includes("openrouter.test")), "Trinity must have been called");
  assert.ok(providerCalls.some((c) => c.body.model === "nvidia/nemotron-3-super-120b-a12b"), "the visual orchestrator must have been called");
  const reloaded = await call(env.http, "GET", `/api/video/projects/${project.project.id}`);
  assert.match(reloaded.body.screenplay, /Jake surveys the shingles/);
  assert.deepEqual(reloaded.body.scenes[0].characterIds, [jake.id]);
});

test("chat action:screenwrite and the deterministic phrase matcher both skip the director entirely", async (t) => {
  for (const trigger of [{ action: "screenwrite", message: "anything" }, { action: "chat", message: "please write the script for this ad" }]) {
    const fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).includes("openrouter.test")) return new Response(JSON.stringify({ id: "gen-x", model: "arcee-ai/trinity-large-thinking", choices: [{ finish_reason: "stop", message: { content: "FADE IN." } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.000001 } }), { status: 200 });
      if (body.model === "deepseek-v4-pro") throw new Error("the director must not run when scriptwriting intent is already unambiguous");
      if (body.model === "nvidia/nemotron-3-super-120b-a12b") return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ order: 1, sceneId: "scene_1", title: "Open", imagePrompt: "x" }] }) } }], usage: { total_tokens: 10 } }), { status: 200 });
      return liaisonOk();
    };
    const env = suite({ fetch });
    try {
      const project = await createProject(env);
      const out = await call(env.http, "POST", "/api/video/chat", { projectId: project.project.id, expectedProjectRevision: project.projectRevision, ...trigger });
      assert.equal(out.res.statusCode, 200, JSON.stringify(out.body));
      assert.equal(out.body.action, "screenwrite");
      assert.match(out.body.reply, /Wrote it/);
      const reloaded = await call(env.http, "GET", `/api/video/projects/${project.project.id}`);
      assert.match(reloaded.body.screenplay, /FADE IN/);
      assert.equal(reloaded.body.scenes.length, 1);
    } finally { rmSync(env.dir, { recursive: true, force: true }); }
  }
});

test("/produce dryRun composes CHARACTERS/style prompts and caps reference images at the model limit, most-used characters first", async (t) => {
  t.context = suite(); clean(t); const env = t.context;
  const chars = [];
  for (let i = 1; i <= 9; i++) chars.push(await createCharacter(env, `Char${i}`, `Description ${i}`));
  const project = await createProject(env);
  let attached = await attach(env, project.project.id, chars.map((c) => c.id), project.projectRevision);
  const state = {
    project: { id: project.project.id, name: "Ad", model: "google:gemini@omni-flash", purpose: "Roofing promo", platform: "YouTube", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30, style: "moody, backlit" },
    screenplay: "", scenes: [
      { id: "scene_a", title: "Scene A", prompt: "The whole crew on site", characterIds: chars.map((c) => c.id) },
      { id: "scene_b", title: "Scene B", prompt: "Three of them close up", characterIds: [chars[0].id, chars[1].id, chars[2].id] },
    ],
    tracks: [...Array.from({ length: 3 }, (_, i) => ({ id: `v${i + 1}`, type: "video", name: `Video ${i + 1}` })), ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, type: "audio", name: `Audio ${i + 1}` }))],
    clips: [], ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 },
  };
  const checkpointed = await call(env.http, "POST", "/api/video/projects/checkpoint", { projectId: project.project.id, label: "Storyboard", state, expectedScreenplaySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", expectedProjectRevision: attached.projectRevision });
  const out = await call(env.http, "POST", "/api/video/produce", { projectId: project.project.id, expectedProjectRevision: checkpointed.body.projectRevision, model: "google:gemini@omni-flash", dryRun: true });
  assert.equal(out.res.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.dryRun, true);
  assert.equal(out.body.productionId, null, "a dryRun never creates a durable production or spends anything");
  const sceneA = out.body.scenes.find((s) => s.sceneId === "scene_a");
  assert.match(sceneA.prompt, /^Purpose: Roofing promo for YouTube\./);
  assert.match(sceneA.prompt, /The whole crew on site/);
  assert.match(sceneA.prompt, /CHARACTERS: Char1: Description 1; keep face, hair, wardrobe and proportions identical to the reference images\./);
  assert.match(sceneA.prompt, /Style: moody, backlit$/);
  assert.equal(sceneA.mode, "reference");
  assert.equal(sceneA.referencePlan.length, 7, "capped at google:gemini@omni-flash's maxReferenceImages");
  assert.deepEqual(sceneA.referencePlan.map((r) => r.name), ["Char1", "Char2", "Char3", "Char4", "Char5", "Char6", "Char7"], "most-used-across-the-production characters (also in scene B) come first, ties keep storyboard order");
});

test("/produce falls back to text mode (still with a CHARACTERS block) when the model has no reference mode", async (t) => {
  t.context = suite(); clean(t); const env = t.context;
  const jake = await createCharacter(env, "Jake", "A foreman");
  const mia = await createCharacter(env, "Mia", "An estimator");
  const project = await createProject(env);
  let attached = await attach(env, project.project.id, [jake.id, mia.id], project.projectRevision);
  const state = {
    project: { id: project.project.id, name: "Ad", model: "klingai:kling-video@3.0-turbo", purpose: "Promo", platform: "TikTok", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30 },
    screenplay: "", scenes: [{ id: "scene_a", title: "Scene A", prompt: "Jake and Mia talk shop", characterIds: [jake.id, mia.id] }],
    tracks: [...Array.from({ length: 3 }, (_, i) => ({ id: `v${i + 1}`, type: "video", name: `Video ${i + 1}` })), ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, type: "audio", name: `Audio ${i + 1}` }))],
    clips: [], ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 },
  };
  const checkpointed = await call(env.http, "POST", "/api/video/projects/checkpoint", { projectId: project.project.id, label: "Storyboard", state, expectedScreenplaySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", expectedProjectRevision: attached.projectRevision });
  const out = await call(env.http, "POST", "/api/video/produce", { projectId: project.project.id, expectedProjectRevision: checkpointed.body.projectRevision, model: "klingai:kling-video@3.0-turbo", dryRun: true });
  assert.equal(out.res.statusCode, 200, JSON.stringify(out.body));
  const scene = out.body.scenes[0];
  assert.equal(scene.mode, "text");
  assert.equal(scene.referencePlan.length, 0);
  assert.match(scene.prompt, /CHARACTERS: Jake: A foreman.*Mia: An estimator/s);
});

test("a real production pauses the remaining scenes when credit runs out mid-production, never a failure", async (t) => {
  // NOTE on concurrency: /produce submits up to 2 scenes in flight, so scene_1 and scene_2's
  // async handlers both call generationBilling() before either one's promise chain resumes (both
  // dispatch synchronously, then interleave on microtasks). `canChat` is therefore held constant
  // and every pass/fail decision lives in the SNAPSHOT `account()` returns for that one call —
  // immune to which scene's `await` happens to resume first — rather than in a live shared
  // counter a later `canChat()` call could read after a DIFFERENT scene has already advanced it.
  let accountCall = 0;
  const billing = {
    account: () => { accountCall++; return accountCall <= 2 ? { autorecharge: true, hasCard: true, balance: 100 } : { autorecharge: true, hasCard: true, balance: 0 }; },
    canChat: () => true,
  };
  const runwareFetch = async (_url, options) => {
    const [task] = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ taskType: task.taskType, taskUUID: task.taskUUID, status: "success", progress: 100, videoURL: "https://provider.invalid/output.mp4", cost: 0.05 }] }), { status: 200 });
  };
  const tenant = { tenantId: "tenant_credit", email: "credit@example.test", role: "credit", status: "active", invited: true, isOwner: false };
  t.context = suite({ tenant, billing, runwareFetch }); clean(t); const env = t.context;
  const project = await createProject(env);
  const state = {
    project: { id: project.project.id, name: "Ad", model: "google:gemini@omni-flash", purpose: "Promo", platform: "YouTube", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30 },
    screenplay: "", scenes: [
      { id: "scene_1", title: "One", prompt: "Shot one", duration: 3 },
      { id: "scene_2", title: "Two", prompt: "Shot two", duration: 3 },
      { id: "scene_3", title: "Three", prompt: "Shot three", duration: 3 },
    ],
    tracks: [...Array.from({ length: 3 }, (_, i) => ({ id: `v${i + 1}`, type: "video", name: `Video ${i + 1}` })), ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, type: "audio", name: `Audio ${i + 1}` }))],
    clips: [], ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 },
  };
  const checkpointed = await call(env.http, "POST", "/api/video/projects/checkpoint", { projectId: project.project.id, label: "Storyboard", state, expectedScreenplaySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", expectedProjectRevision: project.projectRevision });
  const out = await call(env.http, "POST", "/api/video/produce", { projectId: project.project.id, expectedProjectRevision: checkpointed.body.projectRevision, model: "google:gemini@omni-flash" });
  assert.equal(out.res.statusCode, 202, JSON.stringify(out.body));
  const byId = Object.fromEntries(out.body.scenes.map((s) => [s.sceneId, s]));
  // The mocked Runware task resolves synchronously to "success" (real submissions are usually
  // async and reach "ready" only after polling; this mock just proves scene_1 actually submitted).
  assert.notEqual(byId.scene_1.status, "paused: add credits");
  assert.ok(byId.scene_1.jobId, "the first scene, submitted before credit ran out, must have a real job");
  assert.equal(byId.scene_2.status, "paused: add credits");
  assert.equal(byId.scene_2.jobId, null);
  assert.equal(byId.scene_3.status, "paused: add credits");
  assert.equal(byId.scene_3.jobId, null);

  const status = await call(env.http, "GET", `/api/video/produce/${out.body.productionId}?projectId=${project.project.id}`);
  assert.equal(status.res.statusCode, 200);
  const statusById = Object.fromEntries(status.body.scenes.map((s) => [s.sceneId, s]));
  assert.equal(statusById.scene_1.status, "ready");
  assert.equal(statusById.scene_2.status, "paused: add credits");
});
