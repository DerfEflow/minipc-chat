/*
 * Dominion AI — durable, tenant-scoped video projects and Runware jobs.
 *
 * This module deliberately has no server dependency: server.mjs supplies identity, billing,
 * media processing, and HTTP response handling.  Keeping that seam narrow prevents a paid
 * generation from being "accepted" before its state has survived a restart.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_SCENES = 100;
const MAX_SCREENPLAY_TOKENS = 115000;
const VIDEO_TRACKS = 3;
const AUDIO_TRACKS = 4;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const PROJECT_ID = /^[a-f0-9-]{36}$/i;
const terminal = new Set(["ready", "failed", "cancelled", "paused"]);

const DIMENSIONS = Object.freeze({
  "480p": Object.freeze({ "16:9": [854, 480], "9:16": [480, 854], "1:1": [480, 480], "4:3": [640, 480], "3:4": [480, 640], "21:9": [1024, 432] }),
  "720p": Object.freeze({ "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [720, 720], "4:3": [960, 720], "3:4": [720, 960], "21:9": [1680, 720], "3:2": [1080, 720], "2:3": [720, 1080] }),
  "1080p": Object.freeze({ "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:3": [1440, 1080], "3:4": [1080, 1440], "21:9": [2560, 1080], "3:2": [1620, 1080], "2:3": [1080, 1620] }),
  "4k": Object.freeze({ "16:9": [3840, 2160], "9:16": [2160, 3840], "1:1": [2160, 2160], "4:3": [2880, 2160], "3:4": [2160, 2880], "21:9": [5120, 2160] }),
});

const GROK_1080_DIMENSIONS = Object.freeze({
  "16:9": [1904, 1072], "9:16": [1072, 1904], "1:1": [1424, 1424],
  "4:3": [1648, 1232], "3:4": [1232, 1648], "3:2": [1744, 1152], "2:3": [1152, 1744],
});

export const VIDEO_CAPABILITIES = Object.freeze({
  "google:gemini@omni-flash": Object.freeze({ modes: ["text", "image", "reference", "edit", "continue"], ratios: ["16:9", "9:16"], resolutions: ["720p"], minDuration: 3, maxDuration: 10, nativeAudio: true, maxFrameImages: 1, maxReferenceImages: 7, maxEditReferenceImages: 5, promptMin: 2 }),
  "bytedance:seedance@2.0": Object.freeze({ modes: ["text", "image", "reference"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p", "4k"], minDuration: 4, maxDuration: 15, nativeAudio: true, configurableAudio: true, maxFrameImages: 2, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudio: 3, promptMin: 2, promptMax: 10000 }),
  "klingai:kling-video@3.0-turbo": Object.freeze({ modes: ["text", "image"], ratios: ["16:9", "9:16", "1:1"], resolutions: ["720p", "1080p"], minDuration: 3, maxDuration: 15, nativeAudio: true, maxFrameImages: 1, promptMin: 3, promptMax: 3072, maxShots: 6 }),
  "xai:grok-imagine@video-1.5": Object.freeze({ modes: ["image", "reference"], ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], resolutions: ["480p", "720p", "1080p"], minDuration: 1, maxDuration: 15, nativeAudio: true, maxFrameImages: 1, maxReferenceImages: 7, maxReferenceAudio: 1, promptMin: 1 }),
});

export class VideoFeatureError extends Error {
  constructor(code, message, status = 400, details = null) { super(message); this.name = "VideoFeatureError"; this.code = code; this.status = status; this.details = details; }
  toJSON() { return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } }; }
}
export function safeVideoError(err) {
  return err instanceof VideoFeatureError ? err.toJSON() : { error: { code: "video_internal", message: "Video operation could not be completed." } };
}
const fail = (code, message, status, details) => { throw new VideoFeatureError(code, message, status, details); };
const clone = (v) => structuredClone(v);
const iso = (now) => new Date(now()).toISOString();
// A tokenizer package would couple durable project reads to a provider-specific vocabulary.
// Use the larger of the familiar chars/4 estimate and whitespace terms so short-token text
// cannot slip through the 115k project boundary.
const tokenCount = (text) => {
  const value = String(text || "");
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return Math.max(words, Math.ceil(value.length / 4));
};

function validPart(value, label) {
  const s = String(value || "").trim();
  if (!SAFE_ID.test(s) || s === "." || s === "..") fail("video_invalid_" + label, "Invalid " + label + ".");
  return s;
}
function within(root, target) {
  const r = resolve(root), t = resolve(target), rel = relative(r, t);
  return !rel || (!rel.startsWith(".." + "\\") && rel !== ".." && !rel.startsWith("../"));
}
function atomicJson(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { fail("video_project_corrupt", "The video project file is unreadable.", 409); }
}
function defaultTimeline() {
  return {
    videoTracks: Array.from({ length: VIDEO_TRACKS }, (_, index) => ({ id: "v" + (index + 1), kind: "video", name: "Video " + (index + 1), mute: false, solo: false, lock: false, clips: [] })),
    audioTracks: Array.from({ length: AUDIO_TRACKS }, (_, index) => ({ id: "a" + (index + 1), kind: "audio", name: "Audio " + (index + 1), mute: false, solo: false, lock: false, clips: [] })),
  };
}
const DEFAULT_SETTINGS = Object.freeze({ model: "google:gemini@omni-flash", purpose: "Social campaign", platform: "YouTube", ratio: "16:9", resolution: "720p", format: "mp4", duration: 30, folder: null });
function createState({ id, name, tenantId, now }) {
  const at = iso(now);
  return { schemaVersion: 1, id, tenantId, name: String(name || "Untitled video").trim().slice(0, 160) || "Untitled video", createdAt: at, updatedAt: at,
    settings: clone(DEFAULT_SETTINGS), scenes: [], screenplay: { text: "", tokens: 0, limit: MAX_SCREENPLAY_TOKENS, revisions: [] }, timeline: defaultTimeline(), ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 }, conversation: [],
    ai: { palmyra: { model: "writer/palmyra-creative-122b", available: null, state: {} }, visualOrchestrator: { model: "nvidia/nemotron-3-ultra-550b-a55b", state: {} }, director: { model: "deepseek-ai/deepseek-v4-pro", contextWindow: 1000000, compactAtPercent: 70, compactionRequired: false, state: {} }, liaison: { model: "claude-sonnet-5", promptCaching: true, state: {} } },
    history: { head: 0, undo: [], redo: [] }, jobs: [], exports: [] };
}
function migrateState(state) {
  state.settings ||= clone(DEFAULT_SETTINGS);
  state.ui ||= { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 };
  state.exports ||= [];
  state.conversation ||= [];
  state.ai ||= {};
  state.ai.palmyra ||= { model: "writer/palmyra-creative-122b", available: null, state: {} };
  state.ai.visualOrchestrator ||= { model: "nvidia/nemotron-3-ultra-550b-a55b", state: {} };
  state.ai.director ||= { model: "deepseek-ai/deepseek-v4-pro", contextWindow: 1000000, compactAtPercent: 70, compactionRequired: false, state: {} };
  state.ai.liaison ||= { model: "claude-sonnet-5", promptCaching: true, state: {} };
  return state;
}
function assertState(state) {
  migrateState(state);
  if (!state || !PROJECT_ID.test(state.id)) fail("video_project_corrupt", "The video project has an invalid identity.", 409);
  if (!Array.isArray(state.scenes) || state.scenes.length > MAX_SCENES) fail("video_scene_limit", "A project can contain at most 100 scenes.", 409);
  if (!state.timeline || state.timeline.videoTracks?.length !== VIDEO_TRACKS || state.timeline.audioTracks?.length !== AUDIO_TRACKS) fail("video_timeline_invalid", "Video projects always have three video and four audio tracks.", 409);
  const tokens = tokenCount(state.screenplay?.text);
  if (tokens > MAX_SCREENPLAY_TOKENS || state.screenplay.tokens > MAX_SCREENPLAY_TOKENS) fail("video_screenplay_limit", "The screenplay exceeds the 115,000-token project limit.", 409);
  return state;
}

function clientProject(state) {
  const tracks = [...state.timeline.videoTracks, ...state.timeline.audioTracks].map(({ clips, kind, ...track }) => ({ ...clone(track), type: kind }));
  const clips = [...state.timeline.videoTracks, ...state.timeline.audioTracks].flatMap((track) => (track.clips || []).map((clip) => ({ ...clone(clip), trackId: track.id })));
  return {
    project: { id: state.id, name: state.name, ...clone(state.settings), createdAt: state.createdAt, updatedAt: state.updatedAt },
    screenplay: state.screenplay.text, scenes: clone(state.scenes), tracks, clips, ui: clone(state.ui), messages: clone(state.conversation),
    jobs: state.jobs.map(({ localOutput, providerResponse, request, ...job }) => ({ ...clone(job), hasLocalOutput: !!localOutput, model: request?.model || null, cost: job.cost ?? providerResponse?.cost ?? null })),
    exports: clone(state.exports || []),
  };
}

function normalizeClientCheckpoint(current, incoming = {}) {
  if (!incoming || typeof incoming !== "object") fail("video_checkpoint_invalid", "A project checkpoint is required.");
  const next = clone(current);
  const project = incoming.project && typeof incoming.project === "object" ? incoming.project : {};
  if (project.id && project.id !== current.id) fail("video_project_mismatch", "The checkpoint belongs to another project.");
  const name = String(project.name ?? current.name).trim();
  if (!name || name.length > 160) fail("video_name_invalid", "Project names must be between 1 and 160 characters.");
  next.name = name;
  next.settings = {
    model: VIDEO_CAPABILITIES[project.model] ? project.model : current.settings.model,
    purpose: String(project.purpose ?? current.settings.purpose).slice(0, 300), platform: String(project.platform ?? current.settings.platform).slice(0, 80),
    ratio: String(project.ratio ?? current.settings.ratio).slice(0, 12), resolution: String(project.resolution ?? current.settings.resolution).slice(0, 12),
    format: ["mp4", "mov", "webm"].includes(project.format) ? project.format : current.settings.format,
    duration: Math.min(21600, Math.max(1, Number(project.duration ?? current.settings.duration) || 30)),
    folder: project.folder == null ? null : String(project.folder).slice(0, 260),
  };
  const screenplayText = String(incoming.screenplay ?? current.screenplay.text);
  const screenplayTokens = tokenCount(screenplayText);
  if (screenplayTokens > MAX_SCREENPLAY_TOKENS) fail("video_screenplay_limit", "The screenplay exceeds the 115,000-token project limit.");
  if (screenplayText !== current.screenplay.text) next.screenplay.revisions.push({ at: current.updatedAt, text: current.screenplay.text, tokens: current.screenplay.tokens });
  next.screenplay.text = screenplayText; next.screenplay.tokens = screenplayTokens;
  if (!Array.isArray(incoming.scenes) || incoming.scenes.length > MAX_SCENES) fail("video_scene_limit", "A project can contain at most 100 scenes.");
  next.scenes = incoming.scenes.map((scene, index) => {
    if (!scene || typeof scene !== "object") fail("video_scene_invalid", "Storyboard scenes must be objects.");
    const id = String(scene.id || "scene_" + (index + 1));
    if (!SAFE_ID.test(id.replaceAll("-", "_"))) fail("video_scene_invalid", "Invalid scene id.");
    return { id, title: String(scene.title || `Scene ${index + 1}`).slice(0, 160), prompt: String(scene.prompt || "").slice(0, 32000), model: scene.model && VIDEO_CAPABILITIES[scene.model] ? scene.model : null, status: String(scene.status || "draft").slice(0, 40), ...(scene.mediaJobId ? { mediaJobId: String(scene.mediaJobId) } : {}) };
  });
  if (!Array.isArray(incoming.tracks) || !Array.isArray(incoming.clips)) fail("video_timeline_invalid", "A checkpoint must contain its timeline tracks and clips.");
  const expectedTracks = [...Array.from({ length: VIDEO_TRACKS }, (_, i) => ["v" + (i + 1), "video"]), ...Array.from({ length: AUDIO_TRACKS }, (_, i) => ["a" + (i + 1), "audio"])];
  const byId = new Map(incoming.tracks.map((track) => [String(track?.id || ""), track]));
  const timeline = { videoTracks: [], audioTracks: [] };
  for (const [id, kind] of expectedTracks) {
    const raw = byId.get(id); if (!raw || String(raw.type || raw.kind) !== kind) fail("video_timeline_invalid", "Exactly three video and four audio tracks are required.");
    const track = { id, kind, name: String(raw.name || (kind === "video" ? "Video " : "Audio ") + id.slice(1)).slice(0, 80), mute: !!raw.mute, solo: !!raw.solo, lock: !!raw.lock, clips: [] };
    (kind === "video" ? timeline.videoTracks : timeline.audioTracks).push(track);
  }
  const targetTracks = new Map([...timeline.videoTracks, ...timeline.audioTracks].map((track) => [track.id, track]));
  for (const raw of incoming.clips) {
    if (!raw || typeof raw !== "object" || !targetTracks.has(String(raw.trackId))) fail("video_clip_invalid", "A timeline clip targets an invalid track.");
    const id = String(raw.id || ""); if (!SAFE_ID.test(id.replaceAll("-", "_"))) fail("video_clip_invalid", "A timeline clip has an invalid id.");
    const start = Number(raw.start), duration = Number(raw.duration);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 21600) fail("video_clip_invalid", "A timeline clip has invalid timing.");
    targetTracks.get(String(raw.trackId)).clips.push({ id, name: String(raw.name || "Clip").slice(0, 160), start, duration, type: String(raw.type || targetTracks.get(String(raw.trackId)).kind), linked: raw.linked ? String(raw.linked) : null, mediaJobId: raw.mediaJobId ? String(raw.mediaJobId) : null, volume: Math.min(8, Math.max(0, Number(raw.volume ?? 1) || 0)), fit: raw.fit === "cover" ? "cover" : "contain" });
  }
  next.timeline = timeline;
  const panels = incoming.ui?.panels || current.ui.panels;
  const panelMode = (value) => ["regular", "expanded", "minimized"].includes(value) ? value : "regular";
  next.ui = { panels: { writer: panelMode(panels?.writer), board: panelMode(panels?.board) }, focus: !!incoming.ui?.focus, zoom: Math.min(3, Math.max(.5, Number(incoming.ui?.zoom) || 1)) };
  if (Array.isArray(incoming.messages)) {
    const conversation = incoming.messages.slice(-500).map((message) => ({ role: message?.role === "assistant" ? "assistant" : "user", content: String(message?.content || "").slice(0, 32000) }));
    if (JSON.stringify(conversation).length > 2 * 1024 * 1024) fail("video_conversation_large", "The saved video conversation is too large.", 413);
    next.conversation = conversation;
  }
  return next;
}
async function responseJson(res, provider = "runware") {
  const body = await res.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; }
  catch { fail(provider + "_invalid_json", "The provider returned an unreadable response.", 502); }
  if (!res.ok) {
    const item = data?.errors?.[0] || data?.error || {};
    const code = String(item.code || provider + "_http_" + res.status).replace(/[^a-zA-Z0-9_-]/g, "_");
    fail(code, item.message || "The provider rejected the request.", res.status === 429 ? 429 : res.status >= 500 ? 502 : 400, { provider, httpStatus: res.status });
  }
  return data;
}

function mediaList(value, limit, label) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > limit) fail("video_too_many_" + label, "Too many " + label.replaceAll("_", " ") + " for the selected model.");
  for (const item of list) if (typeof item !== "string" || !item.trim() || item.length > 8 * 1024 * 1024) fail("video_invalid_" + label, "A " + label.replaceAll("_", " ") + " value is invalid.");
  return [...list];
}

function dimensionsFor(model, resolution, ratio) {
  const pair = model === "xai:grok-imagine@video-1.5" && resolution === "1080p" ? GROK_1080_DIMENSIONS[ratio] : DIMENSIONS[resolution]?.[ratio];
  if (!pair) fail("video_dimensions_invalid", "That ratio and resolution combination is not supported by the selected model.");
  return { width: pair[0], height: pair[1] };
}

export function validateVideoRequest(input = {}) {
  const model = String(input.model || ""); const cap = VIDEO_CAPABILITIES[model];
  if (!cap) fail("video_model_unsupported", "That video model is not available.");
  const mode = String(input.mode || "text");
  if (!cap.modes.includes(mode)) fail("video_mode_unsupported", "That model does not support the requested generation mode.");
  const frameImages = mediaList(input.frameImages ?? input.images, cap.maxFrameImages || 0, "frame_images");
  const referenceImages = mediaList(input.referenceImages, cap.maxReferenceImages || 0, "reference_images");
  const referenceVideos = mediaList(input.referenceVideos, cap.maxReferenceVideos || 0, "reference_videos");
  const referenceAudios = mediaList(input.referenceAudios, cap.maxReferenceAudio || 0, "reference_audio");
  const prompt = String(input.prompt ?? input.positivePrompt ?? "").trim();
  if (prompt.length < (cap.promptMin || 1) || prompt.length > (cap.promptMax || 32000)) fail("video_prompt_invalid", "The prompt length is not supported by the selected model.");
  if (mode === "image" && !frameImages.length) fail("video_image_required", "This generation mode requires a starting image.");
  if (mode === "image" && model !== "bytedance:seedance@2.0" && frameImages.length !== 1) fail("video_image_required", "This generation mode requires exactly one starting image.");
  if (mode === "reference" && !referenceImages.length) fail("video_reference_required", "This generation mode requires at least one reference image.");
  if (mode === "edit" && !String(input.sourceVideo || "").trim()) fail("video_source_required", "Video editing requires a source video.");
  if (mode === "continue" && !String(input.videoId || "").trim()) fail("video_id_required", "A prior Gemini video id is required to continue an edit.");
  const duration = Number(input.duration || 0);
  if (!Number.isInteger(duration) || duration < cap.minDuration || duration > cap.maxDuration) fail("video_duration_invalid", `Duration must be a whole number from ${cap.minDuration} to ${cap.maxDuration} seconds for this model.`);
  if (!cap.ratios.includes(String(input.ratio || ""))) fail("video_ratio_invalid", "The selected aspect ratio is not supported by this model.");
  if (!cap.resolutions.includes(String(input.resolution || ""))) fail("video_resolution_invalid", "The selected resolution is not supported by this model.");
  if (model === "bytedance:seedance@2.0") {
    if (frameImages.length && (referenceImages.length || referenceVideos.length || referenceAudios.length)) fail("video_media_exclusive", "Seedance frame images cannot be combined with reference media.");
    if (referenceAudios.length && !referenceImages.length && !referenceVideos.length) fail("video_audio_reference_invalid", "Seedance reference audio requires a reference image or video.");
  }
  if (model === "xai:grok-imagine@video-1.5" && referenceAudios.length && !referenceImages.length) fail("video_audio_reference_invalid", "Grok reference audio requires reference images.");
  if (model === "google:gemini@omni-flash" && mode === "edit" && (frameImages.length || input.videoId)) fail("video_media_exclusive", "Gemini source-video editing cannot be combined with frame images or a prior video id.");
  if (model === "google:gemini@omni-flash" && mode === "continue" && (frameImages.length || input.sourceVideo)) fail("video_media_exclusive", "Gemini multi-turn editing cannot be combined with frame images or a source video.");
  const shots = Array.isArray(input.shots) ? clone(input.shots) : [];
  if (shots.length) {
    if (model !== "klingai:kling-video@3.0-turbo" || shots.length > cap.maxShots) fail("video_shots_invalid", "The selected shot plan is not supported.");
    const total = shots.reduce((sum, shot) => sum + Number(shot?.duration || 0), 0);
    if (total !== duration || shots.some((shot) => !Number.isInteger(Number(shot?.duration)) || String(shot?.prompt || "").length > 512)) fail("video_shots_invalid", "Kling shot durations must be whole seconds that total the requested duration, with prompts no longer than 512 characters.");
  }
  return {
    model, mode, prompt, duration, ratio: String(input.ratio), resolution: String(input.resolution),
    frameImages, referenceImages, referenceVideos, referenceAudios,
    sourceVideo: String(input.sourceVideo || "").trim() || null, videoId: String(input.videoId || "").trim() || null,
    generateAudio: input.generateAudio ?? input.audio ?? true, shots,
  };
}

export function compileRunwareTask(input, taskUUID) {
  const request = validateVideoRequest(input);
  const task = {
    taskType: "videoInference", taskUUID, model: request.model, positivePrompt: request.prompt,
    deliveryMethod: "async", includeCost: true, numberResults: 1, outputType: "URL", outputFormat: "MP4",
  };
  if (!request.sourceVideo && !request.videoId) task.duration = request.duration;
  const inputs = {};
  if (request.frameImages.length) inputs.frameImages = request.frameImages;
  if (request.referenceImages.length) inputs.referenceImages = request.referenceImages;
  if (request.referenceVideos.length) inputs.referenceVideos = request.referenceVideos;
  if (request.referenceAudios.length) inputs.referenceAudios = request.referenceAudios;
  if (request.sourceVideo) inputs.video = request.sourceVideo;
  if (request.videoId) inputs.videoId = request.videoId;
  if (Object.keys(inputs).length) task.inputs = inputs;

  const imageLed = request.frameImages.length > 0;
  const usesResolution = imageLed && request.model !== "google:gemini@omni-flash";
  if (usesResolution) task.resolution = request.resolution;
  else if (!request.sourceVideo && !request.videoId) Object.assign(task, dimensionsFor(request.model, request.resolution, request.ratio));
  if (request.model === "bytedance:seedance@2.0") task.settings = { audio: request.generateAudio !== false };
  if (request.shots.length) task.shots = request.shots;
  return task;
}

export function parseRunwareEnvelope(payload, taskUUID) {
  const providerError = (Array.isArray(payload?.errors) ? payload.errors : []).find((item) => !taskUUID || !item.taskUUID || item.taskUUID === taskUUID);
  if (providerError) {
    const providerCode = String(providerError.code || "runware_task_error").replace(/[^a-zA-Z0-9_-]/g, "_");
    const transient = ["timeoutProvider", "providerRateLimitExceeded", "providerUnavailable"].includes(providerCode);
    fail(providerCode, providerError.message || "The video provider could not complete the task.", transient ? 503 : 400, { provider: "runware", taskUUID });
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const result = rows.find((item) => !taskUUID || item.taskUUID === taskUUID) || rows[0] || null;
  if (!result) return { taskUUID, status: "processing", progress: 0 };
  return result;
}
export function directorCompactionNeeded({ usedTokens = 0, contextWindow = 1000000 } = {}) { return Number(usedTokens) >= Number(contextWindow) * .7; }
export function classifyVideoRetry(err, attempt = 0) {
  const status = Number(err?.status || err?.response?.status || 0); const code = String(err?.code || "");
  const retryableCodes = new Set(["ECONNRESET", "ETIMEDOUT", "fetch_failed", "timeoutProvider", "providerRateLimitExceeded", "providerUnavailable"]);
  const retryable = attempt < 3 && (status === 408 || status === 409 || status === 429 || status >= 500 || retryableCodes.has(code));
  return { retryable, delayMs: retryable ? 1000 * (2 ** attempt) : 0, reason: retryable ? "transient_provider_failure" : "non_retryable_provider_failure" };
}

export function createVideoFeature({ dataDir, fetch: fetchImpl = globalThis.fetch, now = Date.now, billingGate = null, mediaProcessor = {}, runwareApiKey = process.env.RUNWARE_VIDEO_GEN_DOMINION_API_KEY, runwareBaseUrl = "https://api.runware.ai/v1", nvidiaApiKey = process.env.NVIDIA_API_KEY, nvidiaBaseUrl = "https://integrate.api.nvidia.com/v1" } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const root = resolve(dataDir); mkdirSync(root, { recursive: true });
  const tenantRoot = (tenantId) => { const id = validPart(tenantId, "tenant"); const path = join(root, "users", id, "video-projects"); if (!within(root, path)) fail("video_path_invalid", "Invalid project path."); mkdirSync(path, { recursive: true }); return path; };
  const projectDir = (tenantId, id) => { const pid = String(id || ""); if (!PROJECT_ID.test(pid)) fail("video_project_invalid", "Invalid project id."); const path = join(tenantRoot(tenantId), pid); if (!within(tenantRoot(tenantId), path)) fail("video_path_invalid", "Invalid project path."); return path; };
  const stateFile = (tenantId, id) => join(projectDir(tenantId, id), "project.json");
  const keyForRunware = () => typeof runwareApiKey === "function" ? runwareApiKey() : runwareApiKey;
  async function runwareRequest(task) {
    const key = keyForRunware();
    if (!key) fail("video_provider_unavailable", "Video generation is not configured.", 503);
    if (typeof fetchImpl !== "function") fail("video_provider_unavailable", "Video generation is unavailable.", 503);
    const response = await fetchImpl(runwareBaseUrl.replace(/\/$/, ""), { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify([task]) });
    return parseRunwareEnvelope(await responseJson(response, "runware"), task.taskUUID);
  }
  function paths(tenantId, id) { const dir = projectDir(tenantId, id); return { dir, state: join(dir, "project.json"), events: join(dir, "history", "events.jsonl"), checkpoints: join(dir, "history", "checkpoints"), generated: join(dir, "media", "generated") }; }
  function load(tenantId, id) { const file = stateFile(tenantId, id); if (!existsSync(file)) fail("video_project_missing", "Video project not found.", 404); return assertState(readJson(file)); }
  function save(tenantId, state) { state.updatedAt = iso(now); assertState(state); atomicJson(stateFile(tenantId, state.id), state); return clone(state); }
  function event(tenantId, state, type, payload = {}) { const p = paths(tenantId, state.id); mkdirSync(p.checkpoints, { recursive: true }); const seq = Number(state.history.head || 0) + 1; const record = { seq, at: iso(now), type: String(type), payload: clone(payload) }; writeFileSync(p.events, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" }); atomicJson(join(p.checkpoints, String(seq).padStart(8, "0") + ".json"), state); state.history.head = seq; return record; }
  // Undo entries are deliberately history-free snapshots.  Storing a state whose undo array stores
  // earlier complete states creates exponential JSON growth (and eventually an invalid string size).
  const undoSnapshot = (state) => { const snap = clone(state); snap.history = { head: state.history.head, undo: [], redo: [] }; return snap; };
  function mutate(tenantId, id, type, fn, payload = {}) { const before = load(tenantId, id); const next = clone(before); const changed = fn(next) || next; assertState(changed); changed.history.undo.push(undoSnapshot(before)); if (changed.history.undo.length > 100) changed.history.undo.shift(); changed.history.redo = []; event(tenantId, changed, type, payload); return save(tenantId, changed); }
  function createProject(tenantId, { name = "Untitled video" } = {}) { const id = randomUUID(); const p = paths(tenantId, id); mkdirSync(p.checkpoints, { recursive: true }); mkdirSync(p.generated, { recursive: true }); const state = createState({ id, name, tenantId: validPart(tenantId, "tenant"), now }); event(tenantId, state, "project.created", { name: state.name }); return save(tenantId, state); }
  function listProjects(tenantId) { const dir = tenantRoot(tenantId); return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name)).map((entry) => { try { const s = load(tenantId, entry.name); return { id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt, scenes: s.scenes.length, jobs: s.jobs.filter((j) => !terminal.has(j.status)).length }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  function renameProject(tenantId, id, name) { const text = String(name || "").trim(); if (!text || text.length > 160) fail("video_name_invalid", "Project names must be between 1 and 160 characters."); return mutate(tenantId, id, "project.renamed", (s) => { s.name = text; }, { name: text }); }
  function deleteProject(tenantId, id, { confirmDelete = false } = {}) { if (confirmDelete !== true) fail("video_delete_confirmation_required", "Explicit project deletion confirmation is required."); const dir = projectDir(tenantId, id); if (!existsSync(dir)) fail("video_project_missing", "Video project not found.", 404); if (!within(tenantRoot(tenantId), dir) || basename(dir) !== id) fail("video_path_invalid", "Invalid project path."); rmSync(dir, { recursive: true, force: false }); return { deleted: true, id }; }
  function applyCommand(tenantId, id, command = {}) { const type = String(command.type || ""); return mutate(tenantId, id, "command." + type, (s) => {
    if (type === "scene.add") { if (s.scenes.length >= MAX_SCENES) fail("video_scene_limit", "A project can contain at most 100 scenes."); const scene = clone(command.scene || {}); scene.id ||= randomUUID(); if (!SAFE_ID.test(scene.id.replaceAll("-", "_"))) fail("video_scene_invalid", "Invalid scene id."); s.scenes.push(scene); }
    else if (type === "scene.remove") { const index = s.scenes.findIndex((v) => v.id === command.sceneId); if (index < 0) fail("video_scene_missing", "Scene not found.", 404); s.scenes.splice(index, 1); }
    else if (type === "screenplay.set") { const text = String(command.text || ""); const tokens = tokenCount(text); if (tokens > MAX_SCREENPLAY_TOKENS) fail("video_screenplay_limit", "The screenplay exceeds the 115,000-token project limit."); s.screenplay.revisions.push({ at: iso(now), text: s.screenplay.text, tokens: s.screenplay.tokens }); s.screenplay.text = text; s.screenplay.tokens = tokens; }
    else if (type === "timeline.set") { const timeline = clone(command.timeline); if (!timeline || timeline.videoTracks?.length !== VIDEO_TRACKS || timeline.audioTracks?.length !== AUDIO_TRACKS) fail("video_timeline_invalid", "Exactly three video and four audio tracks are required."); s.timeline = timeline; }
    else if (type === "director.state") { s.ai.director.state = clone(command.state || {}); s.ai.director.compactionRequired = directorCompactionNeeded(command); }
    else if (type === "ai.state") {
      const role = String(command.role || ""); if (!Object.hasOwn(s.ai, role)) fail("video_ai_role_invalid", "Unknown project AI role.");
      const serialized = JSON.stringify(command.state || {}); if (serialized.length > 2 * 1024 * 1024) fail("video_ai_state_large", "The project AI state is too large.", 413);
      s.ai[role].state = clone(command.state || {});
    }
    else fail("video_command_unsupported", "Unsupported video project command.");
  }, { command: type }); }
  function checkpointProject(tenantId, id, { label = "Project checkpoint", state } = {}) {
    const safeLabel = String(label || "Project checkpoint").trim().slice(0, 160) || "Project checkpoint";
    return mutate(tenantId, id, "project.checkpoint", (current) => normalizeClientCheckpoint(current, state), { label: safeLabel });
  }
  function undo(tenantId, id) { const state = load(tenantId, id); const old = state.history.undo.pop(); if (!old) fail("video_undo_empty", "There is no project change to undo.", 409); const next = clone(old); next.history.undo = state.history.undo; next.history.redo = [...state.history.redo, undoSnapshot(state)]; event(tenantId, next, "command.undo", {}); return save(tenantId, next); }
  function redo(tenantId, id) { const state = load(tenantId, id); const restored = state.history.redo.pop(); if (!restored) fail("video_redo_empty", "There is no project change to restore.", 409); const next = clone(restored); next.history.undo = [...state.history.undo, undoSnapshot(state)]; next.history.redo = state.history.redo; event(tenantId, next, "command.redo", {}); return save(tenantId, next); }
  function probePalmyra() { if (!nvidiaApiKey) return Promise.resolve({ available: false, model: "writer/palmyra-creative-122b", reason: "missing_nvidia_api_key" }); if (typeof fetchImpl !== "function") return Promise.resolve({ available: false, model: "writer/palmyra-creative-122b", reason: "fetch_unavailable" }); return fetchImpl(nvidiaBaseUrl.replace(/\/$/, "") + "/models", { headers: { Authorization: "Bearer " + nvidiaApiKey } }).then(responseJson).then((body) => ({ available: !!(body.data || body.models || []).find((m) => (m.id || m.name) === "writer/palmyra-creative-122b"), model: "writer/palmyra-creative-122b" })).catch(() => ({ available: false, model: "writer/palmyra-creative-122b", reason: "probe_failed" })); }
  async function submitGeneration(tenantId, projectId, request) {
    const valid = validateVideoRequest(request); if (typeof billingGate !== "function") fail("video_billing_unavailable", "Video billing is not configured.", 503);
    const gate = await billingGate({ tenantId, projectId, request: clone(valid), requireAutoRecharge: true, requireCard: true }); if (!gate || gate.allowed !== true) fail("video_billing_required", gate?.message || "Enable auto top-up and add a payment method before generating video.", 402);
    if (!keyForRunware()) fail("video_provider_unavailable", "Video generation is not configured.", 503); if (typeof fetchImpl !== "function") fail("video_provider_unavailable", "Video generation is unavailable.", 503);
    const jobId = randomUUID(); const state = mutate(tenantId, projectId, "job.queued", (s) => { s.jobs.push({ id: jobId, status: "queued", attempt: 0, createdAt: iso(now), request: valid, provider: "runware", taskUuid: null, cost: null }); }, { jobId, model: valid.model });
    const task = compileRunwareTask(valid, jobId);
    try {
      const result = await runwareRequest(task); const status = String(result.status || "processing").toLowerCase();
      const submitted = mutate(tenantId, projectId, "job.submitted", (s) => {
        const job = s.jobs.find((j) => j.id === jobId); job.status = status === "success" && result.videoURL ? "ready" : "generating"; job.taskUuid = jobId;
        job.progress = Number(result.progress || 0); job.cost = result.cost ?? null; job.output = result.videoURL || null; job.videoUUID = result.videoUUID || null; job.videoId = result.outputs?.videoId || null;
      }, { jobId, taskUuid: jobId });
      return { jobId, taskUuid: jobId, project: state.id, status: submitted.jobs.find((job) => job.id === jobId)?.status || "generating" };
    }
    catch (err) { const retry = classifyVideoRetry(err, 0); mutate(tenantId, projectId, "job.submit_failed", (s) => { const job = s.jobs.find((j) => j.id === jobId); job.status = retry.retryable ? "retrying" : "failed"; job.retry = retry; job.error = err instanceof VideoFeatureError ? err.code : "provider_request_failed"; }, { jobId, retry }); throw err; }
  }
  async function pollJob(tenantId, projectId, jobId) {
    const state = load(tenantId, projectId); const job = state.jobs.find((j) => j.id === jobId); if (!job) fail("video_job_missing", "Video job not found.", 404); if (terminal.has(job.status)) return clone(job); if (!keyForRunware() || typeof fetchImpl !== "function") fail("video_provider_unavailable", "Video generation is unavailable.", 503);
    try {
      const result = await runwareRequest({ taskType: "getResponse", taskUUID: job.taskUuid || job.id }); const status = String(result.status || "processing").toLowerCase();
      return mutate(tenantId, projectId, "job.polled", (s) => {
        const target = s.jobs.find((j) => j.id === jobId); target.status = status === "success" && result.videoURL ? "ready" : ["failed", "error"].includes(status) ? "failed" : "generating";
        target.progress = Number(result.progress ?? target.progress ?? 0); target.cost = result.cost ?? target.cost; target.output = result.videoURL || target.output || null; target.videoUUID = result.videoUUID || target.videoUUID || null; target.videoId = result.outputs?.videoId || target.videoId || null; target.lastPolledAt = iso(now);
        if (status === "success" && !target.output) { target.status = "failed"; target.error = "video_provider_missing_output"; }
      }, { jobId, status }).jobs.find((j) => j.id === jobId);
    }
    catch (err) { const retry = classifyVideoRetry(err, Number(job.attempt || 0)); return mutate(tenantId, projectId, "job.poll_failed", (s) => { const target = s.jobs.find((j) => j.id === jobId); target.attempt = Number(target.attempt || 0) + 1; target.status = retry.retryable ? "retrying" : "failed"; target.retry = retry; }, { jobId, retry }).jobs.find((j) => j.id === jobId); }
  }
  // Provider URLs are often short-lived.  The media layer owns bytes/FFmpeg verification, while
  // this store owns the durable record and makes the only allowed destination project-local.
  async function downloadJobOutput(tenantId, projectId, jobId) {
    const state = load(tenantId, projectId); const job = state.jobs.find((j) => j.id === jobId);
    if (!job) fail("video_job_missing", "Video job not found.", 404);
    if (job.status !== "ready" || !job.output) fail("video_output_not_ready", "The generated video is not ready to download.", 409);
    if (typeof mediaProcessor.download !== "function") fail("video_media_unavailable", "Video media processing is not configured.", 503);
    const p = paths(tenantId, projectId); mkdirSync(p.generated, { recursive: true });
    const destination = join(p.generated, jobId + ".mp4");
    if (!within(p.generated, destination)) fail("video_path_invalid", "Invalid media destination.");
    try {
      const stored = await mediaProcessor.download({ url: job.output, destination, job: clone(job), tenantId, projectId, expiresAt: job.outputExpiresAt || null });
      if (typeof mediaProcessor.verify === "function") await mediaProcessor.verify({ path: destination, job: clone(job), result: stored });
      return mutate(tenantId, projectId, "job.downloaded", (s) => { const target = s.jobs.find((j) => j.id === jobId); target.localOutput = destination; target.downloadedAt = iso(now); }, { jobId }).jobs.find((j) => j.id === jobId);
    } catch (err) {
      mutate(tenantId, projectId, "job.download_failed", (s) => { const target = s.jobs.find((j) => j.id === jobId); target.downloadError = err instanceof VideoFeatureError ? err.code : "media_download_failed"; }, { jobId });
      if (err instanceof VideoFeatureError) throw err;
      fail("video_media_download_failed", "The generated video could not be saved and verified. The provider copy remains available for retry.", 502);
    }
  }
  function recoverJobs(tenantId, projectId) { const state = load(tenantId, projectId); return state.jobs.filter((j) => ["queued", "generating", "retrying"].includes(j.status)).map((j) => clone(j)); }
  return {
    MAX_SCENES, MAX_SCREENPLAY_TOKENS, VIDEO_TRACKS, AUDIO_TRACKS, capabilities: VIDEO_CAPABILITIES,
    createProject, listProjects, getProject: (tenantId, id) => clone(load(tenantId, id)), getClientProject: (tenantId, id) => clientProject(load(tenantId, id)),
    renameProject, deleteProject, checkpointProject, applyCommand, undo, redo, submitGeneration, pollJob, downloadJobOutput, recoverJobs, probePalmyra,
    validateVideoRequest, safeError: safeVideoError, paths: (tenantId, id) => ({ ...paths(tenantId, id) }),
  };
}
