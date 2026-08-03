import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, truncateSync } from "node:fs";
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
  const restarted = createVideoFeature({ dataDir: t.context.dir });
  assert.equal(restarted.undo("a", p.id).screenplay.text, "");
  const restartedAgain = createVideoFeature({ dataDir: t.context.dir });
  assert.equal(restartedAgain.redo("a", p.id).screenplay.text, "one two three");
  assert.throws(() => api.applyCommand("a", p.id, { type: "screenplay.set", text: "x ".repeat(115001) }), /115,000/);
  const paths = api.paths("a", p.id); assert.ok(existsSync(paths.events)); assert.match(readFileSync(paths.events, "utf8"), /command.scene.add/); assert.ok(existsSync(paths.checkpoints));
});

test("history and deletion cannot erase provider work or evade settlement", async (t) => {
  t.context = suite({ mediaProcessor: { download: async () => ({ bytes: 1 }), verify: async () => ({ valid: true, duration: 5, video: [{}], audio: [] }) } }); clean(t); const { api } = t.context; const project = api.createProject("a");
  const firstCheckpoint = api.listCheckpoints("a", project.id).at(-1).seq;
  const submitted = await api.submitGeneration("a", project.id, validRequest({ idempotencyKey: "retained-job" }));
  assert.equal(api.recoverJobs("a", project.id).length, 1);
  api.undo("a", project.id); api.undo("a", project.id);
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  api.redo("a", project.id);
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  api.restoreCheckpoint("a", project.id, firstCheckpoint);
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  assert.throws(() => api.deleteProject("a", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress" && error.status === 409);
  const ready = await api.pollJob("a", project.id, submitted.jobId); assert.equal(ready.status, "ready");
  assert.throws(() => api.deleteProject("a", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress");
  api.markJobSettled("a", project.id, submitted.jobId, { settlementKey: "paid", costUsd: ready.cost });
  assert.equal(api.recoverJobs("a", project.id)[0].id, submitted.jobId);
  assert.throws(() => api.deleteProject("a", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress");
  await api.downloadJobOutput("a", project.id, submitted.jobId);
  assert.deepEqual(api.deleteProject("a", project.id, { confirmDelete: true }), { deleted: true, id: project.id });
});

test("tenant project, temporary-job, aggregate-storage, and disk-reserve limits are enforced", (t) => {
  t.context = suite({ maxProjectsPerTenant: 2, minFreeDiskBytes: 0 }); clean(t); const { api } = t.context;
  api.createProject("a", { name: "One" }); api.createProject("a", { name: "Two" });
  assert.throws(() => api.createProject("a", { name: "Three" }), (error) => error.code === "video_project_limit");
  assert.doesNotThrow(() => api.createProject("b", { name: "Separate tenant" }));

  const tempRoot = join(t.context.dir, "temporary");
  const temporary = createVideoFeature({ dataDir: tempRoot, maxProjectsPerTenant: 5, minFreeDiskBytes: 0 });
  temporary.createProject("mobile", { temporary: true });
  assert.throws(() => temporary.createProject("mobile", { temporary: true }), (error) => error.code === "video_mobile_generation_in_progress");

  const aggregateRoot = join(t.context.dir, "aggregate");
  const aggregate = createVideoFeature({ dataDir: aggregateRoot, storageQuotaBytes: 64 * 1024 * 1024, tenantStorageQuotaBytes: 64 * 1024 * 1024, minFreeDiskBytes: 0 });
  const first = aggregate.createProject("a"); const second = aggregate.createProject("a");
  const large = join(aggregate.paths("a", first.id).generated, "large.mp4"); writeFileSync(large, ""); truncateSync(large, 40 * 1024 * 1024);
  assert.throws(() => aggregate.storageBudget("a", second.id, 30 * 1024 * 1024), (error) => error.code === "video_tenant_storage_quota_exceeded");

  const diskRoot = join(t.context.dir, "disk-reserve");
  const diskLimited = createVideoFeature({ dataDir: diskRoot, minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
  assert.throws(() => diskLimited.createProject("a"), (error) => error.code === "video_disk_space_low" && error.status === 507);
});

test("mobile one-off jobs remain discoverable after a server or browser restart", async (t) => {
  const mediaProcessor = { download: async () => ({ bytes: 1 }), verify: async () => ({ valid: true, duration: 5, video: [{}], audio: [] }) };
  t.context = suite({ mediaProcessor }); clean(t); const project = t.context.api.createProject("mobile", { temporary: true });
  const submitted = await t.context.api.submitGeneration("mobile", project.id, validRequest({ idempotencyKey: "mobile-recovery" }));
  const ready = await t.context.api.pollJob("mobile", project.id, submitted.jobId); t.context.api.markJobSettled("mobile", project.id, submitted.jobId, { settlementKey: "paid", costUsd: ready.cost });
  const restarted = createVideoFeature({ dataDir: t.context.dir, now: () => Date.UTC(2026, 0, 1, 0, 5), runwareApiKey: "test-key", billingGate: async () => ({ allowed: true }), fetch: async () => { throw new Error("poll not requested"); }, mediaProcessor });
  const jobs = restarted.recoverTemporaryJobs("mobile"); assert.equal(jobs.length, 1); assert.equal(jobs[0].id, submitted.jobId); assert.equal(jobs[0].projectId, project.id); assert.equal(jobs[0].singleGeneration, true);
  assert.throws(() => restarted.deleteProject("mobile", project.id, { confirmDelete: true }), (error) => error.code === "video_job_in_progress");
  await restarted.downloadJobOutput("mobile", project.id, submitted.jobId); assert.equal(restarted.recoverTemporaryJobs("mobile").length, 1);
  restarted.markJobDelivered("mobile", project.id, submitted.jobId); assert.equal(restarted.recoverTemporaryJobs("mobile").length, 0);
  assert.deepEqual(restarted.deleteProject("mobile", project.id, { confirmDelete: true }), { deleted: true, id: project.id });
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
  assert.throws(() => validateVideoRequest(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "image", duration: 5, frameImages: ["asset:frame"], referenceImages: ["asset:reference"] })), /cannot be combined/);
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

test("a client idempotency key can create only one paid provider job", async (t) => {
  t.context = suite(); clean(t);
  const { api, calls } = t.context; const p = api.createProject("a");
  const request = validRequest({ idempotencyKey: "generation_click_1" });
  const first = await api.submitGeneration("a", p.id, request);
  const repeated = await api.submitGeneration("a", p.id, request);
  assert.equal(repeated.jobId, first.jobId); assert.equal(repeated.deduplicated, true); assert.equal(calls.length, 1);
  await assert.rejects(api.submitGeneration("a", p.id, { ...request, prompt: "A different scene" }), (error) => error.code === "video_idempotency_conflict" && error.status === 409);
  assert.throws(() => validateVideoRequest(validRequest({ idempotencyKey: "bad key" })), /identity is invalid/);
});

test("billing, provider errors, retry classification, recovery and Palmyra probe are explicit", async (t) => {
  let calls = 0; t.context = suite({ billingGate: async () => ({ allowed: false }), fetch: async () => { calls++; return new Response("down", { status: 503 }); } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); await assert.rejects(api.submitGeneration("a", p.id, validRequest()), /auto top-up/); assert.equal(calls, 0);
  const failing = createVideoFeature({ dataDir: join(t.context.dir, "retry"), runwareApiKey: "test", billingGate: async () => ({ allowed: true }), fetch: async () => new Response(JSON.stringify({ errors: [{ code: "timeoutProvider", message: "try again" }] }), { status: 200 }) });
  const q = failing.createProject("a"); const recoveredSubmit = await failing.submitGeneration("a", q.id, validRequest()); assert.equal(recoveredSubmit.status, "retrying"); assert.equal(recoveredSubmit.recoveredFrom, "timeoutProvider");
  assert.equal(failing.recoverJobs("a", q.id)[0].status, "retrying"); assert.equal((await failing.probePalmyra()).available, false);
  assert.throws(() => parseRunwareEnvelope({ errors: [{ code: "invalidPrompt", message: "bad" }] }, "x"), (error) => error.code === "invalidPrompt");
  assert.throws(() => parseRunwareEnvelope({ data: [{ taskUUID: "another-task", status: "success", videoURL: "https://wrong.invalid" }] }, "expected-task"), (error) => error.code === "runware_task_mismatch");
  assert.equal(classifyVideoRetry({ code: "providerRateLimitExceeded", status: 400 }).retryable, true); assert.equal(classifyVideoRetry({ code: "invalidPrompt", status: 400 }).retryable, false);
  assert.equal(classifyVideoRetry({ cause: { code: "ECONNRESET" } }).retryable, true);
});

test("safe pre-accept failures resubmit the original inference UUID while ambiguous submits only poll", async (t) => {
  const calls = []; let inferenceCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "dominion-video-resubmit-")); t.context = { dir: root }; clean(t);
  const fetch = async (_url, options) => {
    const task = JSON.parse(options.body)[0]; calls.push(structuredClone(task));
    if (task.taskType === "videoInference" && ++inferenceCalls === 1) return new Response(JSON.stringify({ errors: [{ code: "providerUnavailable", message: "not accepted" }] }), { status: 503 });
    return new Response(JSON.stringify({ data: [{ taskType: task.taskType, taskUUID: task.taskUUID, status: "processing", progress: 1 }] }), { status: 200 });
  };
  const api = createVideoFeature({ dataDir: root, runwareApiKey: "test", runwareRetries: 1, billingGate: async () => ({ allowed: true }), fetch });
  const project = api.createProject("a"); const submitted = await api.submitGeneration("a", project.id, validRequest());
  assert.equal(submitted.status, "retrying"); assert.equal(api.getProject("a", project.id).jobs[0].submission.state, "retry_safe");
  const resumed = await api.pollJob("a", project.id, submitted.jobId); assert.equal(resumed.status, "generating"); assert.equal(resumed.submission.state, "accepted");
  assert.deepEqual(calls.map((task) => task.taskType), ["videoInference", "videoInference"]); assert.equal(calls[0].taskUUID, calls[1].taskUUID);

  const ambiguousRoot = join(root, "ambiguous"); const ambiguousCalls = []; let first = true;
  const ambiguous = createVideoFeature({ dataDir: ambiguousRoot, runwareApiKey: "test", runwareRetries: 1, billingGate: async () => ({ allowed: true }), fetch: async (_url, options) => {
    const task = JSON.parse(options.body)[0]; ambiguousCalls.push(task.taskType);
    if (first) { first = false; const error = new Error("response lost"); error.name = "AbortError"; throw error; }
    return new Response(JSON.stringify({ errors: [{ code: "taskNotFound", message: "not visible yet", taskUUID: task.taskUUID }] }), { status: 200 });
  } });
  const p2 = ambiguous.createProject("a"); const uncertain = await ambiguous.submitGeneration("a", p2.id, validRequest());
  assert.equal(ambiguous.getProject("a", p2.id).jobs[0].submission.state, "ack_unknown");
  const stillPolling = await ambiguous.pollJob("a", p2.id, uncertain.jobId); assert.equal(stillPolling.status, "retrying"); assert.deepEqual(ambiguousCalls, ["videoInference", "getResponse"]);
});

test("director context compacts only at the configured 70 percent boundary", () => {
  assert.equal(directorCompactionNeeded({ usedTokens: 700000 }), true); assert.equal(directorCompactionNeeded({ usedTokens: 699999 }), false);
});

test("checkpoints preserve per-scene generation settings, bound the timeline, and restore durable history", (t) => {
  t.context = suite(); clean(t); const { api } = t.context; const p = api.createProject("a"); const state = emptyClientState(p);
  state.scenes = [{ id: "scene_1", title: "Reference cut", prompt: "Camera drifts", model: "bytedance:seedance@2.0", duration: 12, mode: "reference", frameImages: ["frame"], referenceImages: ["image"], referenceVideos: ["video"], referenceAudios: ["audio"], generateAudio: false, shots: [{ duration: 4, prompt: "First move" }] }];
  api.checkpointProject("a", p.id, { label: "scene settings", state });
  const saved = api.getProject("a", p.id).scenes[0]; assert.equal(saved.duration, 12); assert.deepEqual(saved.frameImages, ["frame"]); assert.deepEqual(saved.referenceVideos, ["video"]); assert.equal(saved.generateAudio, false); assert.deepEqual(saved.shots, [{ duration: 4, prompt: "First move" }]);
  state.clips = [{ id: "bad", trackId: "v1", start: 21599, duration: 2 }];
  assert.throws(() => api.checkpointProject("a", p.id, { state }), /invalid timing/);
  const history = api.listCheckpoints("a", p.id); assert.ok(history.length >= 2); api.renameProject("a", p.id, "Changed");
  api.restoreCheckpoint("a", p.id, history.find((item) => item.label === "scene settings").seq); assert.equal(api.getProject("a", p.id).name, p.name);
});

test("verified output creates one durable generated clip with real audio facts", async (t) => {
  t.context = suite({ mediaProcessor: { download: async () => ({ bytes: 42 }), verify: async () => ({ valid: true, duration: 6.5, video: [{}], audio: [{}] }) } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); const first = await api.submitGeneration("a", p.id, validRequest()); await api.pollJob("a", p.id, first.jobId); const job = await api.downloadJobOutput("a", p.id, first.jobId);
  const second = await api.submitGeneration("a", p.id, validRequest()); await api.pollJob("a", p.id, second.jobId); await api.downloadJobOutput("a", p.id, second.jobId);
  assert.equal(job.media.hasVideo, true); assert.equal(job.media.hasAudio, true); const state = api.getProject("a", p.id); const clips = state.timeline.videoTracks[0].clips;
  assert.equal(clips.length, 2); assert.equal(clips[0].mediaFile, `${first.jobId}.mp4`); assert.equal(clips[0].start, 0); assert.equal(clips[1].start, 6.5); assert.equal(clips[0].linked, `audio-${first.jobId}`);
  const audio = state.timeline.audioTracks[0].clips; assert.equal(audio.length, 2); assert.equal(audio[0].linked, `clip-${first.jobId}`); assert.equal(audio[1].start, 6.5);
  await api.downloadJobOutput("a", p.id, first.jobId); const repeat = api.getProject("a", p.id); assert.equal(repeat.timeline.videoTracks[0].clips.length, 2); assert.equal(repeat.timeline.audioTracks[0].clips.length, 2);
});

test("verified silent output remains a durable video clip without a fabricated audio layer", async (t) => {
  t.context = suite({ mediaProcessor: { download: async () => ({ bytes: 42 }), verify: async () => ({ valid: true, duration: 4, video: [{}], audio: [] }) } }); clean(t);
  const { api } = t.context; const p = api.createProject("a"); const submitted = await api.submitGeneration("a", p.id, validRequest()); await api.pollJob("a", p.id, submitted.jobId); const job = await api.downloadJobOutput("a", p.id, submitted.jobId);
  const state = api.getProject("a", p.id); assert.equal(job.media.hasAudio, false); assert.equal(state.timeline.videoTracks[0].clips[0].linked, null); assert.equal(state.timeline.audioTracks[0].clips.length, 0);
});

test("failed generated-media verification removes the final destination", async (t) => {
  let destination;
  t.context = suite({ mediaProcessor: {
    download: async (input) => { destination = input.destination; writeFileSync(destination, "bad-media"); return { bytes: 9 }; },
    verify: async () => { throw new Error("ffprobe rejected output"); },
  } }); clean(t);
  const { api } = t.context; const project = api.createProject("a");
  const submitted = await api.submitGeneration("a", project.id, validRequest()); await api.pollJob("a", project.id, submitted.jobId);
  await assert.rejects(api.downloadJobOutput("a", project.id, submitted.jobId), (error) => error.code === "video_media_download_failed");
  assert.equal(existsSync(destination), false);
});

test("Runware compiler follows each model's distinct dimensions and multi-shot contract", () => {
  const task = compileRunwareTask(validRequest({ model: "bytedance:seedance@2.0", duration: 4, ratio: "21:9", resolution: "4k" }), "33333333-3333-4333-8333-333333333333"); assert.deepEqual([task.width, task.height], [4398, 1886]);
  const kling = compileRunwareTask(validRequest({ model: "klingai:kling-video@3.0-turbo", prompt: "A deliberate city reveal", duration: 3, ratio: "1:1", resolution: "1080p" }), "44444444-4444-4444-8444-444444444444"); assert.deepEqual([kling.width, kling.height], [1440, 1440]);
  const grok = compileRunwareTask(validRequest({ model: "xai:grok-imagine@video-1.5", mode: "image", prompt: "Move", duration: 1, ratio: "3:2", resolution: "720p", frameImages: ["asset:frame"] }), "55555555-5555-4555-8555-555555555555"); assert.equal(grok.resolution, "720p"); assert.equal(Object.hasOwn(grok, "width"), false);
  const geminiImage = compileRunwareTask(validRequest({ mode: "image", frameImages: ["asset:first"] }), "66666666-6666-4666-8666-666666666666"); assert.deepEqual([geminiImage.width, geminiImage.height], [1280, 720]); assert.equal(Object.hasOwn(geminiImage, "resolution"), false);
  const seedanceReference = compileRunwareTask(validRequest({ model: "bytedance:seedance@2.0", mode: "reference", duration: 4, resolution: "720p", referenceVideos: ["asset:video"] }), "77777777-7777-4777-8777-777777777777"); assert.deepEqual([seedanceReference.width, seedanceReference.height], [1280, 720]); assert.equal(Object.hasOwn(seedanceReference, "resolution"), false);
  const klingImage = compileRunwareTask(validRequest({ model: "klingai:kling-video@3.0-turbo", mode: "image", prompt: "Camera moves through rain", duration: 3, resolution: "1080p", frameImages: ["asset:frame"] }), "99999999-9999-4999-8999-999999999999"); assert.equal(klingImage.resolution, "1080p"); assert.equal(Object.hasOwn(klingImage, "width"), false); assert.equal(Object.hasOwn(klingImage, "height"), false);
  const multiShot = compileRunwareTask(validRequest({ model: "klingai:kling-video@3.0-turbo", duration: 6, prompt: "A city sequence", shots: [{ duration: 2, prompt: "Wide skyline" }, { duration: 4, prompt: "Move through rain" }] }), "88888888-8888-4888-8888-888888888888"); assert.equal(multiShot.positivePrompt, "shot 1, 2, Wide skyline; shot 2, 4, Move through rain;"); assert.equal(Object.hasOwn(multiShot, "shots"), false);
  assert.throws(() => validateVideoRequest(validRequest({ mode: "edit", sourceVideo: "asset:source", referenceImages: ["1", "2", "3", "4", "5", "6"] })), /Too many reference images/);
});
