import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVideoFeature, VideoFeatureError, validateVideoRequest, compileRunwareTask,
  parseRunwareEnvelope, classifyVideoRetry, directorCompactionNeeded,
} from "./video.mjs";

const validRequest = (overrides = {}) => ({ model: "google:gemini@omni-flash", mode: "text", prompt: "A quiet sunrise over the mountains", duration: 5, ratio: "16:9", resolution: "720p", ...overrides });
function providerResponse(task) {
  return task.taskType === "getResponse"
    ? { data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "success", progress: 100, videoUUID: "video-1", videoURL: "https://provider.invalid/output.mp4", cost: 0.18, outputs: { videoId: "continuation-1" } }] }
    : { data: [{ taskType: "videoInference", taskUUID: task.taskUUID, status: "processing", progress: 2 }] };
}
function suite(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-")); let tick = 0;
  const now = () => Date.UTC(2026, 0, 1, 0, 0, tick++);
  const calls = [];
  const fetch = async (url, options = {}) => {
    const payload = JSON.parse(options.body); calls.push({ url: String(url), options, payload });
    return new Response(JSON.stringify(providerResponse(payload[0])), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { dir, calls, api: createVideoFeature({ dataDir: dir, now, billingGate: async () => ({ allowed: true }), runwareApiKey: "test-key", fetch, ...overrides }) };
}
function clean(t) { t.after(() => rmSync(t.context.dir, { recursive: true, force: true })); }
function emptyClientState(project) {
  return {
    project: { id: project.id, name: project.name, model: "google:gemini@omni-flash", purpose: "Campaign", platform: "YouTube", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30 },
    screenplay: "", scenes: [],
    tracks: [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `v${i + 1}`, type: "video", name: `Video ${i + 1}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i + 1}`, type: "audio", name: `Audio ${i + 1}` })),
    ], clips: [], ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 },
  };
}

test("CRUD and full checkpoints are tenant-safe and deletion is explicit", (t) => {
  t.context = suite(); clean(t); const { api } = t.context;
  const p = api.createProject("alice", { name: "Film" });
  assert.equal(api.listProjects("alice").length, 1); assert.equal(api.listProjects("bob").length, 0);
  const payload = emptyClientState(p); payload.scenes.push({ id: "scene_1", title: "Opening", prompt: "Wind across grass" }); payload.screenplay = "FADE IN. Wind moves through the field.";
  const saved = api.checkpointProject("alice", p.id, { label: "Opening drafted", state: payload });
  assert.equal(saved.scenes.length, 1); assert.equal(api.getClientProject("alice", p.id).project.name, "Film");
  assert.equal(api.renameProject("alice", p.id, "New").name, "New"); assert.throws(() => api.deleteProject("alice", p.id), /confirmation/);
  assert.deepEqual(api.deleteProject("alice", p.id, { confirmDelete: true }), { deleted: true, id: p.id });
  assert.throws(() => api.getProject("bob", p.id), VideoFeatureError); assert.throws(() => api.createProject("../escape"), VideoFeatureError);
});

test("history preserves commands, bounded scenes, screenplay tokens, undo and redo", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const p = api.createProject("a");
  for (let i = 0; i < 100; i++) api.applyCommand("a", p.id, { type: "scene.add", scene: { id: "scene_" + i } });
  assert.throws(() => api.applyCommand("a", p.id, { type: "scene.add", scene: { id: "scene_101" } }), /100 scenes/);
  api.applyCommand("a", p.id, { type: "screenplay.set", text: "one two three" });
  assert.equal(api.undo("a", p.id).screenplay.text, ""); assert.equal(api.redo("a", p.id).screenplay.text, "one two three");
  assert.throws(() => api.applyCommand("a", p.id, { type: "screenplay.set", text: "x ".repeat(115001) }), /115,000/);
  const paths = api.paths("a", p.id); assert.ok(existsSync(paths.events)); assert.match(readFileSync(paths.events, "utf8"), /command.scene.add/); assert.ok(existsSync(paths.checkpoints));
});

test("model validation and Runware compilation honor documented constraints", () => {
  const omni = compileRunwareTask(validRequest(), "11111111-1111-4111-8111-111111111111");
  assert.equal(omni.width, 1280); assert.equal(omni.height, 720); assert.equal(omni.positivePrompt, "A quiet sunrise over the mountains");
  for (const appField of ["mode", "ratio", "images", "audio", "generateAudio"]) assert.ok(!Object.hasOwn(omni, appField));
  assert.equal(omni.deliveryMethod, "async"); assert.equal(omni.includeCost, true); assert.equal(omni.outputFormat, "MP4");

  const seedance = compileRunwareTask(validRequest({ model: "bytedance:seedance@2.0", mode: "image", duration: 15, resolution: "4k", ratio: "21:9", frameImages: ["asset:first", "asset:last"], generateAudio: false }), "22222222-2222-4222-8222-222222222222");
  assert.equal(seedance.resolution, "4k"); assert.deepEqual(seedance.inputs.frameImages, ["asset:first", "asset:last"]); assert.deepEqual(seedance.settings, { audio: false }); assert.ok(!Object.hasOwn(seedance, "width"));
  const kling = validateVideoRequest(validRequest({ model: "klingai:kling-video@3.0-turbo", prompt: "Six-shot city reveal", duration: 15, resolution: "1080p" })); assert.equal(kling.duration, 15);
  const grok = validateVideoRequest(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "image", prompt: "Move", duration: 1, ratio: "3:2", resolution: "1080p", frameImages: ["asset:frame"] })); assert.equal(grok.ratio, "3:2");

  assert.throws(() => validateVideoRequest(validRequest({ duration: 2 })), /3 to 10/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "bytedance:seedance@2.0", duration: 4, frameImages: ["a"], referenceImages: ["b"] })), /cannot be combined/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "text", duration: 5 })), /does not support/);
  assert.throws(() => validateVideoRequest(validRequest({ model: "klingai:kling-video@3.0-turbo", prompt: "ok", duration: 4 })), /prompt length/);
});

test("Runware submission and polling use one array-based async endpoint and persist final facts", async (t) => {
  const downloads = [];
  t.context = suite({ mediaProcessor: { download: async (args) => { downloads.push(args); return { bytes: 42 }; }, verify: async () => ({ valid: true }) } }); clean(t);
  const { api, calls } = t.context; const p = api.createProject("a"); const submitted = await api.submitGeneration("a", p.id, validRequest());
  assert.equal(calls[0].url, "https://api.runware.ai/v1"); assert.equal(calls[0].options.method, "POST"); assert.ok(Array.isArray(calls[0].payload)); assert.equal(calls[0].payload[0].taskType, "videoInference");
  const job = await api.pollJob("a", p.id, submitted.jobId); assert.equal(calls[1].payload[0].taskType, "getResponse"); assert.equal(calls[1].payload[0].taskUUID, submitted.jobId);
  assert.equal(job.status, "ready"); assert.equal(job.output, "https://provider.invalid/output.mp4"); assert.equal(job.videoUUID, "video-1"); assert.equal(job.videoId, "continuation-1"); assert.equal(job.cost, 0.18);
  const saved = await api.downloadJobOutput("a", p.id, submitted.jobId); assert.match(saved.localOutput, /media[\\/]generated/); assert.equal(downloads.length, 1);
});

test("billing, provider errors, retry classification, recovery and Palmyra probe are explicit", async (t) => {
  let calls = 0; t.context = suite({ billingGate: async () => ({ allowed: false }), fetch: async () => { calls++; return new Response("down", { status: 503 }); } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); await assert.rejects(api.submitGeneration("a", p.id, validRequest()), /auto top-up/); assert.equal(calls, 0);
  const failing = createVideoFeature({ dataDir: join(t.context.dir, "retry"), runwareApiKey: "test", billingGate: async () => ({ allowed: true }), fetch: async () => new Response(JSON.stringify({ errors: [{ code: "timeoutProvider", message: "try again" }] }), { status: 200 }) });
  const q = failing.createProject("a"); await assert.rejects(failing.submitGeneration("a", q.id, validRequest()), (error) => error.code === "timeoutProvider");
  assert.equal(failing.recoverJobs("a", q.id)[0].status, "retrying"); assert.equal((await failing.probePalmyra()).available, false);
  assert.throws(() => parseRunwareEnvelope({ errors: [{ code: "invalidPrompt", message: "bad" }] }, "x"), (error) => error.code === "invalidPrompt");
  assert.equal(classifyVideoRetry({ code: "providerRateLimitExceeded", status: 400 }).retryable, true); assert.equal(classifyVideoRetry({ code: "invalidPrompt", status: 400 }).retryable, false);
});

test("director context compacts only at the configured 70 percent boundary", () => {
  assert.equal(directorCompactionNeeded({ usedTokens: 700000 }), true); assert.equal(directorCompactionNeeded({ usedTokens: 699999 }), false);
});
