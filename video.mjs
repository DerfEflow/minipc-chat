/*
 * Dominion AI — durable, tenant-scoped video projects and Runware jobs.
 *
 * This module deliberately has no server dependency: server.mjs supplies identity, billing,
 * media processing, and HTTP response handling.  Keeping that seam narrow prevents a paid
 * generation from being "accepted" before its state has survived a restart.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, statfsSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const MAX_SCENES = 100;
const MAX_SCREENPLAY_TOKENS = 115000;
const SCREENWRITER_MODEL = "arcee-ai/trinity-large-thinking";
const VIDEO_TRACKS = 3;
const AUDIO_TRACKS = 4;
const MAX_PROJECT_DURATION = 21600;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const PROJECT_ID = /^[a-f0-9-]{36}$/i;
const terminal = new Set(["ready", "failed", "cancelled", "paused"]);

// Provider work and unpaid ready outputs are operational records, not creative edit history.
// They must survive restore/undo and must keep the project directory alive until settlement.
function jobRequiresRetention(job = {}, { requireDelivery = false } = {}) {
  const status = String(job.status || "").toLowerCase();
  if (!terminal.has(status)) return true;
  if (status !== "ready") return false;
  if (!job.localOutput) return true;
  if (requireDelivery && job.delivery?.status !== "delivered") return true;
  if (job.settlement?.status === "settled") return false;
  const rawCost = job.cost ?? job.providerResponse?.cost;
  if (rawCost == null) return !!job.output;
  const cost = Number(rawCost);
  return !Number.isFinite(cost) || cost > 0;
}

const TERMINAL_SCREENWRITER_ATTEMPT_STATUSES = new Set([
  "applied",
  "rejected",
  "provider_http_rejected",
  "provider_contract_rejected",
  "provider_correlated",
  "quarantined_stale_settled",
  "operator_quarantined",
]);

export function screenwriterAttemptBlocksMutation(attempt = {}) {
  const status = String(attempt.status || "").toLowerCase();
  if (!TERMINAL_SCREENWRITER_ATTEMPT_STATUSES.has(status)) return true;
  const settlement = String(attempt.settlement?.status || "").toLowerCase();
  const cost = Number(attempt.usage?.costUsd ?? attempt.settlement?.costUsd ?? 0);
  return Number.isFinite(cost) && cost > 0 && !["settled", "skipped", "not_billed"].includes(settlement);
}

function providerAttemptRequiresRetention(attempt = {}) {
  if (screenwriterAttemptBlocksMutation(attempt)) return true;
  const settlement = String(attempt.settlement?.status || "").toLowerCase();
  const cost = Number(attempt.usage?.costUsd ?? attempt.settlement?.costUsd ?? 0);
  return Number.isFinite(cost) && cost > 0 && !["settled", "skipped", "not_billed"].includes(settlement);
}

function restoreProjectSnapshot(current, snapshot) {
  const restored = clone(snapshot);
  for (const field of ["schemaVersion", "id", "tenantId", "createdAt", "temporary", "expiresAt"]) restored[field] = clone(current[field]);
  restored.jobs = clone(current.jobs || []);
  restored.exports = clone(current.exports || []);
  restored.providerAttempts = clone(current.providerAttempts || []);
  return restored;
}

const MODEL_DIMENSIONS = Object.freeze({
  "google:gemini@omni-flash": Object.freeze({ "720p": Object.freeze({ "16:9": [1280, 720], "9:16": [720, 1280] }) }),
  "bytedance:seedance@2.0": Object.freeze({
    "480p": Object.freeze({ "16:9": [864, 496], "4:3": [752, 560], "1:1": [640, 640], "3:4": [560, 752], "9:16": [496, 864], "21:9": [992, 432] }),
    "720p": Object.freeze({ "16:9": [1280, 720], "4:3": [1112, 834], "1:1": [960, 960], "3:4": [834, 1112], "9:16": [720, 1280], "21:9": [1470, 630] }),
    "1080p": Object.freeze({ "16:9": [1920, 1080], "4:3": [1664, 1248], "1:1": [1440, 1440], "3:4": [1248, 1664], "9:16": [1080, 1920], "21:9": [2206, 946] }),
    "4k": Object.freeze({ "16:9": [3840, 2160], "4:3": [3326, 2494], "1:1": [2880, 2880], "3:4": [2496, 3328], "9:16": [2160, 3840], "21:9": [4398, 1886] }),
  }),
  "klingai:kling-video@3.0-turbo": Object.freeze({
    "720p": Object.freeze({ "16:9": [1280, 720], "1:1": [960, 960], "9:16": [720, 1280] }),
    "1080p": Object.freeze({ "16:9": [1920, 1080], "1:1": [1440, 1440], "9:16": [1080, 1920] }),
  }),
  "xai:grok-imagine@video-1.5": Object.freeze({
    "480p": Object.freeze({ "1:1": [480, 480], "16:9": [848, 480], "9:16": [480, 848], "4:3": [640, 480], "3:4": [480, 640], "3:2": [720, 480], "2:3": [480, 720] }),
    "720p": Object.freeze({ "1:1": [720, 720], "16:9": [1280, 720], "9:16": [720, 1280], "4:3": [960, 720], "3:4": [720, 960], "3:2": [1088, 720], "2:3": [720, 1088] }),
    "1080p": Object.freeze({ "1:1": [1424, 1424], "16:9": [1904, 1072], "9:16": [1072, 1904], "4:3": [1648, 1232], "3:4": [1232, 1648], "3:2": [1744, 1152], "2:3": [1152, 1744] }),
  }),
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
// Use the larger of UTF-8 bytes/3 and whitespace terms. This deliberately errs on the safe side
// for non-Latin scripts as well as dense short-token text at the 115k project boundary.
const tokenCount = (text) => {
  const value = String(text || "");
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return Math.max(words, Math.ceil(Buffer.byteLength(value, "utf8") / 3));
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
function atomicBytes(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, value);
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
function createState({ id, name, tenantId, now, temporary = false }) {
  const at = iso(now);
  return { schemaVersion: 1, id, tenantId, name: String(name || "Untitled video").trim().slice(0, 160) || "Untitled video", createdAt: at, updatedAt: at,
    temporary: !!temporary, expiresAt: temporary ? new Date(Number(now()) + 24 * 60 * 60 * 1000).toISOString() : null,
    settings: clone(DEFAULT_SETTINGS), scenes: [], screenplay: { text: "", tokens: 0, limit: MAX_SCREENPLAY_TOKENS, revisions: [] }, timeline: defaultTimeline(), ui: { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 }, conversation: [],
    ai: { screenwriter: { model: SCREENWRITER_MODEL, contextWindow: MAX_SCREENPLAY_TOKENS, reasoning: true, state: { brief: "", generatedSections: 0, lastTurn: null } }, visualOrchestrator: { model: "nvidia/nemotron-3-ultra-550b-a55b", state: {} }, director: { model: "deepseek-ai/deepseek-v4-pro", contextWindow: 1000000, compactAtPercent: 70, compactionRequired: false, state: {} }, liaison: { model: "claude-sonnet-5", promptCaching: true, state: {} } },
    history: { head: 0, undo: [], redo: [] }, jobs: [], exports: [], providerAttempts: [] };
}
function migrateState(state) {
  state.settings ||= clone(DEFAULT_SETTINGS);
  state.ui ||= { panels: { writer: "regular", board: "regular" }, focus: false, zoom: 1 };
  state.exports ||= [];
  state.providerAttempts = (Array.isArray(state.providerAttempts) ? state.providerAttempts : []).slice(-100);
  state.conversation ||= [];
  state.ai ||= {};
  const legacyScreenwriter = state.ai.screenwriter || state.ai.palmyra || {};
  const legacyScreenwriterState = legacyScreenwriter.state && typeof legacyScreenwriter.state === "object" ? legacyScreenwriter.state : {};
  state.ai.screenwriter = { model: SCREENWRITER_MODEL, contextWindow: MAX_SCREENPLAY_TOKENS, reasoning: true, state: { ...legacyScreenwriterState, brief: String(legacyScreenwriterState.brief || "").slice(0, 460_000), generatedSections: Math.max(0, Number(legacyScreenwriterState.generatedSections) || 0), lastTurn: legacyScreenwriterState.lastTurn && typeof legacyScreenwriterState.lastTurn === "object" ? legacyScreenwriterState.lastTurn : null } };
  delete state.ai.palmyra;
  state.ai.visualOrchestrator ||= { model: "nvidia/nemotron-3-ultra-550b-a55b", state: {} };
  state.ai.director ||= { model: "deepseek-ai/deepseek-v4-pro", contextWindow: 1000000, compactAtPercent: 70, compactionRequired: false, state: {} };
  state.ai.liaison ||= { model: "claude-sonnet-5", promptCaching: true, state: {} };
  state.history ||= { head: 0, undo: [], redo: [] };
  state.history.head = Number.isInteger(Number(state.history.head)) ? Number(state.history.head) : 0;
  // Older builds embedded full project snapshots here. Durable checkpoints are authoritative;
  // keep only compact checkpoint sequence references in the live project file.
  state.history.undo = (Array.isArray(state.history.undo) ? state.history.undo : []).map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(-100);
  state.history.redo = (Array.isArray(state.history.redo) ? state.history.redo : []).map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(-100);
  state.screenplay ||= { text: "", tokens: 0, limit: MAX_SCREENPLAY_TOKENS, revisions: [] };
  state.screenplay.revisions = (Array.isArray(state.screenplay.revisions) ? state.screenplay.revisions : []).map((revision) => ({ at: String(revision?.at || state.updatedAt || ""), tokens: Math.max(0, Number(revision?.tokens) || 0), checkpointSeq: Number.isInteger(Number(revision?.checkpointSeq)) ? Number(revision.checkpointSeq) : null, ...(typeof revision?.sha256 === "string" && /^[a-f0-9]{64}$/.test(revision.sha256) ? { sha256: revision.sha256 } : {}) })).slice(-10_000);
  return state;
}
function assertState(state) {
  migrateState(state);
  if (!state || !PROJECT_ID.test(state.id)) fail("video_project_corrupt", "The video project has an invalid identity.", 409);
  if (!Array.isArray(state.scenes) || state.scenes.length > MAX_SCENES) fail("video_scene_limit", "A project can contain at most 100 scenes.", 409);
  if (!Array.isArray(state.providerAttempts) || state.providerAttempts.length > 100) fail("video_provider_attempts_invalid", "The project provider-attempt ledger is invalid.", 409);
  for (const attempt of state.providerAttempts) if (Buffer.byteLength(JSON.stringify(attempt || {}), "utf8") > 8 * 1024 * 1024) fail("video_provider_attempt_invalid", "A provider-attempt record is too large.", 409);
  if (!state.timeline || state.timeline.videoTracks?.length !== VIDEO_TRACKS || state.timeline.audioTracks?.length !== AUDIO_TRACKS) fail("video_timeline_invalid", "Video projects always have three video and four audio tracks.", 409);
  if (!(Number(state.settings?.duration) >= 1) || Number(state.settings.duration) > MAX_PROJECT_DURATION) fail("video_project_duration_invalid", "Project duration is outside the supported range.", 409);
  const tracks = [...state.timeline.videoTracks, ...state.timeline.audioTracks];
  for (const track of tracks) for (const clip of track.clips || []) {
    const start = Number(clip?.start); const duration = Number(clip?.duration); const sourceStart = Number(clip?.sourceStart || 0);
    if (!Number.isFinite(start) || start < 0 || start > MAX_PROJECT_DURATION || !Number.isFinite(duration) || duration <= 0 || duration > MAX_PROJECT_DURATION || start + duration > MAX_PROJECT_DURATION || !Number.isFinite(sourceStart) || sourceStart < 0 || sourceStart > MAX_PROJECT_DURATION) fail("video_clip_invalid", "A timeline clip exceeds the project duration limit.", 409);
  }
  const tokens = tokenCount(state.screenplay?.text);
  if (tokens > MAX_SCREENPLAY_TOKENS || state.screenplay.tokens > MAX_SCREENPLAY_TOKENS) fail("video_screenplay_limit", "The screenplay exceeds the 115,000-token project limit.", 409);
  return state;
}

function clientProject(state) {
  const tracks = [...state.timeline.videoTracks, ...state.timeline.audioTracks].map(({ clips, kind, ...track }) => ({ ...clone(track), type: kind }));
  const jobFiles = new Map((state.jobs || []).filter((job) => job.localOutput).map((job) => [job.id, basename(job.localOutput)]));
  const clips = [...state.timeline.videoTracks, ...state.timeline.audioTracks].flatMap((track) => (track.clips || []).map((clip) => {
    const file = clip.mediaFile || jobFiles.get(clip.mediaJobId); const src = file ? `/api/video/media/${encodeURIComponent(state.id)}/${encodeURIComponent(file)}` : null;
    return { ...clone(clip), trackId: track.id, ...(src ? { src } : {}) };
  }));
  const clientAi = clone(state.ai);
  const writerState = state.ai?.screenwriter?.state || {};
  if (clientAi.screenwriter) clientAi.screenwriter.state = {
    generatedSections: Math.max(0, Number(writerState.generatedSections) || 0),
    lastFinishReason: String(writerState.finishReason || "").slice(0, 80) || null,
    truncated: writerState.truncated === true,
    updatedAt: writerState.updatedAt || null,
  };
  return {
    project: { id: state.id, name: state.name, ...clone(state.settings), createdAt: state.createdAt, updatedAt: state.updatedAt },
    projectRevision: Number(state.history?.head) || 0,
    screenplay: state.screenplay.text, screenplaySha256: createHash("sha256").update(state.screenplay.text || "").digest("hex"), scenes: clone(state.scenes), tracks, clips, ui: clone(state.ui), messages: clone(state.conversation),
    ai: clientAi, jobs: state.jobs.map(({ localOutput, providerResponse, request, ...job }) => ({ ...clone(job), hasLocalOutput: !!localOutput, model: request?.model || null, cost: job.cost ?? providerResponse?.cost ?? null })),
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
    duration: Math.min(MAX_PROJECT_DURATION, Math.max(1, Number(project.duration ?? current.settings.duration) || 30)),
    folder: project.folder == null ? null : String(project.folder).slice(0, 260),
  };
  const screenplayText = String(incoming.screenplay ?? current.screenplay.text);
  const screenplayTokens = tokenCount(screenplayText);
  if (screenplayTokens > MAX_SCREENPLAY_TOKENS) fail("video_screenplay_limit", "The screenplay exceeds the 115,000-token project limit.");
  if (screenplayText !== current.screenplay.text) next.screenplay.revisions.push({ at: current.updatedAt, tokens: current.screenplay.tokens, checkpointSeq: current.history?.head || null, sha256: createHash("sha256").update(current.screenplay.text || "").digest("hex") });
  next.screenplay.text = screenplayText; next.screenplay.tokens = screenplayTokens;
  if (!Array.isArray(incoming.scenes) || incoming.scenes.length > MAX_SCENES) fail("video_scene_limit", "A project can contain at most 100 scenes.");
  next.scenes = incoming.scenes.map((scene, index) => {
    if (!scene || typeof scene !== "object") fail("video_scene_invalid", "Storyboard scenes must be objects.");
    const id = String(scene.id || "scene_" + (index + 1));
    if (!SAFE_ID.test(id.replaceAll("-", "_"))) fail("video_scene_invalid", "Invalid scene id.");
    const list = (value, limit = 9) => (Array.isArray(value) ? value : []).slice(0, limit).map((item) => String(item || "").trim()).filter((item) => item && item.length <= 8 * 1024 * 1024);
    const duration = Number(scene.duration);
    return {
      id, title: String(scene.title || `Scene ${index + 1}`).slice(0, 160), prompt: String(scene.prompt || "").slice(0, 32000),
      model: scene.model && VIDEO_CAPABILITIES[scene.model] ? scene.model : null, status: String(scene.status || "draft").slice(0, 40),
      ...(Number.isInteger(duration) && duration >= 1 && duration <= MAX_PROJECT_DURATION ? { duration } : {}),
      ...(scene.mode ? { mode: String(scene.mode).slice(0, 30) } : {}),
      ...(scene.ratio ? { ratio: String(scene.ratio).slice(0, 20) } : {}),
      ...(scene.resolution ? { resolution: String(scene.resolution).slice(0, 20) } : {}),
      ...(list(scene.frameImages, 2).length ? { frameImages: list(scene.frameImages, 2) } : {}),
      ...(list(scene.referenceImages, 9).length ? { referenceImages: list(scene.referenceImages, 9) } : {}),
      ...(list(scene.referenceVideos, 3).length ? { referenceVideos: list(scene.referenceVideos, 3) } : {}),
      ...(list(scene.referenceAudios, 3).length ? { referenceAudios: list(scene.referenceAudios, 3) } : {}),
      ...(scene.sourceVideo ? { sourceVideo: String(scene.sourceVideo).slice(0, 8 * 1024 * 1024) } : {}),
      ...(scene.videoId ? { videoId: String(scene.videoId).slice(0, 500) } : {}),
      ...(typeof scene.generateAudio === "boolean" ? { generateAudio: scene.generateAudio } : {}),
      ...(Array.isArray(scene.shots) && scene.shots.length ? { shots: scene.shots.slice(0, 6).map((shot) => ({ duration: Math.max(1, Math.min(15, Math.round(Number(shot?.duration) || 1))), prompt: String(shot?.prompt || "").slice(0, 512) })) } : {}),
      ...(scene.mediaJobId ? { mediaJobId: String(scene.mediaJobId) } : {}),
    };
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
    if (!Number.isFinite(start) || start < 0 || start > MAX_PROJECT_DURATION || !Number.isFinite(duration) || duration <= 0 || duration > MAX_PROJECT_DURATION || start + duration > MAX_PROJECT_DURATION) fail("video_clip_invalid", "A timeline clip has invalid timing.");
    const mediaFile = raw.mediaFile ? basename(String(raw.mediaFile)) : null;
    if (mediaFile && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(mediaFile) || mediaFile.includes(".."))) fail("video_clip_invalid", "A timeline clip has an invalid media file.");
    const sourceStart = Number(raw.sourceStart || 0);
    if (!Number.isFinite(sourceStart) || sourceStart < 0 || sourceStart > MAX_PROJECT_DURATION) fail("video_clip_invalid", "A timeline clip has an invalid source offset.");
    const targetTrack = targetTracks.get(String(raw.trackId));
    targetTrack.clips.push({ id, name: String(raw.name || "Clip").slice(0, 160), start, duration, sourceStart, type: targetTrack.kind, linked: raw.linked ? String(raw.linked) : null, mediaJobId: raw.mediaJobId ? String(raw.mediaJobId) : null, sceneId: raw.sceneId && /^[A-Za-z0-9_-]{1,128}$/.test(String(raw.sceneId)) ? String(raw.sceneId) : null, mediaFile, volume: Math.min(8, Math.max(0, Number(raw.volume ?? 1) || 0)), fit: raw.fit === "cover" ? "cover" : "contain" });
  }
  next.timeline = timeline;
  const panels = incoming.ui?.panels || current.ui.panels;
  const panelMode = (value) => ["regular", "expanded", "minimized"].includes(value) ? value : "regular";
  next.ui = { panels: { writer: panelMode(panels?.writer), board: panelMode(panels?.board) }, focus: !!incoming.ui?.focus, zoom: Math.min(3, Math.max(.5, Number(incoming.ui?.zoom) || 1)) };
  if (Array.isArray(incoming.messages)) {
    // "status" survives the round-trip (2026-08-05): terminal failures now land in the chat log
    // persistently, and a whitelist that coerced them to "user" would replay them as things the
    // person said.
    const conversation = incoming.messages.slice(-500).map((message) => ({
      role: message?.role === "assistant" ? "assistant" : message?.role === "status" ? "status" : "user",
      content: String(message?.content || "").slice(0, 32000),
      ...(message?.code ? { code: String(message.code).slice(0, 80) } : {}),
    }));
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
  const pair = MODEL_DIMENSIONS[model]?.[resolution]?.[ratio];
  if (!pair) fail("video_dimensions_invalid", "That ratio and resolution combination is not supported by the selected model.");
  return { width: pair[0], height: pair[1] };
}
function klingShotPrompt(shots = []) {
  return shots.map((shot, index) => `shot ${index + 1}, ${shot.duration}, ${String(shot.prompt || "").replace(/;/g, ",").trim()};`).join(" ");
}

export function validateVideoRequest(input = {}) {
  const model = String(input.model || ""); const cap = VIDEO_CAPABILITIES[model];
  if (!cap) fail("video_model_unsupported", "That video model is not available.");
  const mode = String(input.mode || "text");
  if (!cap.modes.includes(mode)) fail("video_mode_unsupported", "That model does not support the requested generation mode.");
  const frameImages = mediaList(input.frameImages ?? input.images, cap.maxFrameImages || 0, "frame_images");
  const referenceImageLimit = model === "google:gemini@omni-flash" && ["edit", "continue"].includes(mode) ? cap.maxEditReferenceImages : cap.maxReferenceImages;
  const referenceImages = mediaList(input.referenceImages, referenceImageLimit || 0, "reference_images");
  const referenceVideos = mediaList(input.referenceVideos, cap.maxReferenceVideos || 0, "reference_videos");
  const referenceAudios = mediaList(input.referenceAudios, cap.maxReferenceAudio || 0, "reference_audio");
  const prompt = String(input.prompt ?? input.positivePrompt ?? "").trim();
  if (prompt.length < (cap.promptMin || 1) || prompt.length > (cap.promptMax || 32000)) fail("video_prompt_invalid", "The prompt length is not supported by the selected model.");
  if (mode === "image" && !frameImages.length) fail("video_image_required", "This generation mode requires a starting image.");
  if (mode === "image" && model !== "bytedance:seedance@2.0" && frameImages.length !== 1) fail("video_image_required", "This generation mode requires exactly one starting image.");
  if (mode === "reference" && !(referenceImages.length || (model === "bytedance:seedance@2.0" && referenceVideos.length))) fail("video_reference_required", model === "bytedance:seedance@2.0" ? "Seedance reference mode requires at least one reference image or video." : "This generation mode requires at least one reference image.");
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
  if (model === "xai:grok-imagine@video-1.5") {
    if (frameImages.length && (referenceImages.length || referenceAudios.length)) fail("video_media_exclusive", "Grok frame images and reference media cannot be combined.");
    if (referenceAudios.length && !referenceImages.length) fail("video_audio_reference_invalid", "Grok reference audio requires reference images.");
  }
  if (model === "google:gemini@omni-flash" && mode === "edit" && (frameImages.length || input.videoId)) fail("video_media_exclusive", "Gemini source-video editing cannot be combined with frame images or a prior video id.");
  if (model === "google:gemini@omni-flash" && mode === "continue" && (frameImages.length || input.sourceVideo)) fail("video_media_exclusive", "Gemini multi-turn editing cannot be combined with frame images or a source video.");
  const shots = Array.isArray(input.shots) ? input.shots.map((shot) => ({ duration: Number(shot?.duration), prompt: String(shot?.prompt || "").trim().replace(/;/g, ",") })) : [];
  if (shots.length) {
    if (model !== "klingai:kling-video@3.0-turbo" || shots.length > cap.maxShots) fail("video_shots_invalid", "The selected shot plan is not supported.");
    const total = shots.reduce((sum, shot) => sum + Number(shot?.duration || 0), 0);
    if (total !== duration || shots.some((shot) => !Number.isInteger(Number(shot?.duration)) || !shot.prompt || shot.prompt.length > 512) || klingShotPrompt(shots).length > cap.promptMax) fail("video_shots_invalid", "Kling shot durations must be whole seconds that total the requested duration, with complete prompts fitting the model limit.");
  }
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (idempotencyKey && !SAFE_ID.test(idempotencyKey)) fail("video_idempotency_invalid", "The generation request identity is invalid.");
  // The storyboard scene this generation belongs to. Tolerant on purpose: an invalid or absent id
  // degrades to null (an unattached clip) rather than refusing a generation the user already paid
  // attention to. It rides the request so the queued job, the finished clip, and the scene can
  // finally agree (2026-08-05; the client had sent it since the studio shipped).
  const sceneIdRaw = String(input.sceneId || "").trim();
  const sceneId = sceneIdRaw && sceneIdRaw.length <= 128 && /^[A-Za-z0-9_-]+$/.test(sceneIdRaw) ? sceneIdRaw : null;
  return {
    model, mode, prompt, duration, ratio: String(input.ratio), resolution: String(input.resolution),
    frameImages, referenceImages, referenceVideos, referenceAudios,
    sourceVideo: String(input.sourceVideo || "").trim() || null, videoId: String(input.videoId || "").trim() || null,
    generateAudio: input.generateAudio !== false && input.audio !== false, shots, idempotencyKey: idempotencyKey || null,
    sceneId,
  };
}

export function compileRunwareTask(input, taskUUID) {
  const request = validateVideoRequest(input);
  const task = {
    taskType: "videoInference", taskUUID, model: request.model, positivePrompt: request.shots.length ? klingShotPrompt(request.shots) : request.prompt,
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

  if (request.model === "xai:grok-imagine@video-1.5") task.resolution = request.resolution;
  else if (["bytedance:seedance@2.0", "klingai:kling-video@3.0-turbo"].includes(request.model) && request.frameImages.length) task.resolution = request.resolution;
  else if (!request.sourceVideo) Object.assign(task, dimensionsFor(request.model, request.resolution, request.ratio));
  if (request.model === "bytedance:seedance@2.0") task.settings = { audio: request.generateAudio !== false };
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
  const result = taskUUID ? rows.find((item) => item.taskUUID === taskUUID) || null : rows[0] || null;
  if (taskUUID && rows.length && !result) fail("runware_task_mismatch", "The provider response did not match the requested video task.", 502, { provider: "runware", taskUUID });
  if (!result) return { taskUUID, status: "processing", progress: 0 };
  return result;
}
export function directorCompactionNeeded({ usedTokens = 0, contextWindow = 1000000 } = {}) { return Number(usedTokens) >= Number(contextWindow) * .7; }
export function classifyVideoRetry(err, attempt = 0) {
  const status = Number(err?.status || err?.response?.status || err?.cause?.status || 0); const code = String(err?.code || err?.cause?.code || "");
  const notFound = new Set(["taskNotFound", "taskUUIDNotFound"]).has(code);
  const retryableCodes = new Set(["ECONNRESET", "ETIMEDOUT", "fetch_failed", "runware_timeout", "timeoutProvider", "providerRateLimitExceeded", "providerUnavailable", "taskNotFound", "taskUUIDNotFound"]);
  const retryable = attempt < (notFound ? 20 : 3) && (status === 408 || status === 409 || status === 429 || status >= 500 || retryableCodes.has(code));
  return { retryable, delayMs: retryable ? Math.min(30_000, 1000 * (2 ** Math.min(attempt, 5))) : 0, reason: retryable ? "transient_provider_failure" : "non_retryable_provider_failure" };
}

function providerFailure(err, fallback = "provider_request_failed") {
  return {
    code: String(err?.code || err?.cause?.code || fallback).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || fallback,
    message: String(err?.message || err?.cause?.message || "The video provider could not complete this task.").slice(0, 800),
    status: Number(err?.status || err?.response?.status || err?.cause?.status || 0) || null,
  };
}

function submissionRecovery(err) {
  const code = String(err?.code || err?.cause?.code || "");
  const httpStatus = Number(err?.details?.httpStatus || err?.cause?.details?.httpStatus || 0);
  const safeToResubmit = httpStatus === 429 || httpStatus >= 500 || new Set(["providerRateLimitExceeded", "providerUnavailable"]).has(code);
  return { state: safeToResubmit ? "retry_safe" : "ack_unknown", safeToResubmit };
}

export function createVideoFeature({ dataDir, fetch: fetchImpl = globalThis.fetch, now = Date.now, billingGate = null, mediaProcessor = {}, runwareApiKey = process.env.RUNWARE_VIDEO_GEN_DOMINION_API_KEY, runwareBaseUrl = "https://api.runware.ai/v1", runwareTimeoutMs = 45_000, runwareRetries = 2, storageQuotaBytes: configuredStorageQuotaBytes = 2 * 1024 * 1024 * 1024, tenantStorageQuotaBytes: configuredTenantStorageQuotaBytes, maxProjectsPerTenant: configuredMaxProjects = 50, minFreeDiskBytes: configuredMinFreeDiskBytes = 512 * 1024 * 1024 } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const root = resolve(dataDir); mkdirSync(root, { recursive: true });
  const storageQuotaBytes = Math.max(64 * 1024 * 1024, Number(configuredStorageQuotaBytes) || 2 * 1024 * 1024 * 1024);
  const tenantStorageQuotaBytes = Math.max(storageQuotaBytes, Number(configuredTenantStorageQuotaBytes) || storageQuotaBytes * 5);
  const maxProjectsPerTenant = Math.max(1, Math.min(500, Number(configuredMaxProjects) || 50));
  const minFreeDiskBytes = Math.max(0, Number(configuredMinFreeDiskBytes) || 0);
  const tenantRoot = (tenantId) => { const id = validPart(tenantId, "tenant"); const path = join(root, "users", id, "video-projects"); if (!within(root, path)) fail("video_path_invalid", "Invalid project path."); mkdirSync(path, { recursive: true }); return path; };
  const projectDir = (tenantId, id) => { const pid = String(id || ""); if (!PROJECT_ID.test(pid)) fail("video_project_invalid", "Invalid project id."); const path = join(tenantRoot(tenantId), pid); if (!within(tenantRoot(tenantId), path)) fail("video_path_invalid", "Invalid project path."); return path; };
  const stateFile = (tenantId, id) => join(projectDir(tenantId, id), "project.json");
  const keyForRunware = () => typeof runwareApiKey === "function" ? runwareApiKey() : runwareApiKey;
  async function runwareRequest(task) {
    const key = keyForRunware();
    if (!key) fail("video_provider_unavailable", "Video generation is not configured.", 503);
    if (typeof fetchImpl !== "function") fail("video_provider_unavailable", "Video generation is unavailable.", 503);
    const attempts = Math.max(1, Math.min(3, Number(runwareRetries) || 2));
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(5_000, Number(runwareTimeoutMs) || 45_000));
      try {
        const response = await fetchImpl(runwareBaseUrl.replace(/\/$/, ""), { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify([task]), signal: controller.signal });
        return parseRunwareEnvelope(await responseJson(response, "runware"), task.taskUUID);
      } catch (error) {
        if (error?.name === "AbortError") throw new VideoFeatureError("runware_timeout", "Runware did not acknowledge the video task before the request deadline. The saved task will be recovered by polling.", 504, { taskUUID: task.taskUUID });
        lastError = error;
        if (attempt + 1 < attempts && classifyVideoRetry(error, attempt).retryable) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 400 * (2 ** attempt))); continue; }
        throw error;
      } finally { clearTimeout(timer); }
    }
    throw lastError;
  }
  function paths(tenantId, id) { const dir = projectDir(tenantId, id); const media = join(dir, "media"); return { dir, state: join(dir, "project.json"), events: join(dir, "history", "events.jsonl"), checkpoints: join(dir, "history", "checkpoints"), media, generated: join(media, "generated"), uploads: join(media, "uploads"), proxies: join(media, "proxies"), audio: join(media, "audio"), thumbnails: join(media, "thumbnails"), renders: join(media, "renders"), exports: join(media, "exports") }; }
  const walkBytes = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(dir, entry.name);
    try { return total + (entry.isDirectory() ? walkBytes(path) : entry.isFile() ? statSync(path).size : 0); } catch { return total; }
  }, 0);
  function ensureDiskHeadroom(additionalBytes = 0) {
    if (!minFreeDiskBytes) return;
    try {
      const disk = statfsSync(root); const available = Number(disk.bavail) * Number(disk.bsize);
      if (available - Math.max(0, Number(additionalBytes) || 0) < minFreeDiskBytes) fail("video_disk_space_low", "The video worker is preserving its emergency disk reserve. Free storage before adding media or checkpoints.", 507, { availableBytes: available, reserveBytes: minFreeDiskBytes });
    } catch (error) {
      if (error instanceof VideoFeatureError) throw error;
      // Filesystems without statfs support still retain the project and tenant quotas below.
    }
  }
  function storageUsage(tenantId, id) {
    const dir = projectDir(tenantId, id); return existsSync(dir) ? walkBytes(dir) : 0;
  }
  function storageBudget(tenantId, id, additionalBytes = 0) {
    const used = storageUsage(tenantId, id); const requested = Math.max(0, Number(additionalBytes) || 0);
    if (used + requested > storageQuotaBytes) fail("video_storage_quota_exceeded", "This project has reached its 2 GB storage limit. Remove unneeded media before adding more.", 507, { usedBytes: used, quotaBytes: storageQuotaBytes, requestedBytes: requested });
    const tenantDir = tenantRoot(tenantId); const tenantUsed = existsSync(tenantDir) ? walkBytes(tenantDir) : 0;
    if (tenantUsed + requested > tenantStorageQuotaBytes) fail("video_tenant_storage_quota_exceeded", "This account has reached its video storage limit. Remove an unneeded project or media file before adding more.", 507, { usedBytes: tenantUsed, quotaBytes: tenantStorageQuotaBytes, requestedBytes: requested });
    ensureDiskHeadroom(requested);
    return { usedBytes: used, quotaBytes: storageQuotaBytes, tenantUsedBytes: tenantUsed, tenantQuotaBytes: tenantStorageQuotaBytes, remainingBytes: Math.max(0, Math.min(storageQuotaBytes - used, tenantStorageQuotaBytes - tenantUsed)) };
  }
  function load(tenantId, id) {
    const file = stateFile(tenantId, id);
    if (!existsSync(file)) fail("video_project_missing", "Video project not found.", 404);
    let state = assertState(readJson(file));
    const checkpointDir = paths(tenantId, id).checkpoints;
    if (existsSync(checkpointDir)) {
      const latest = readdirSync(checkpointDir).map((name) => Number(name.match(/^(\d{8})\.json(?:\.gz)?$/)?.[1] || 0)).filter(Number.isInteger).sort((a, b) => b - a)[0] || 0;
      if (latest > Number(state.history?.head || 0)) {
        const recovered = assertState(readCheckpoint(paths(tenantId, id), latest));
        if (recovered.id !== state.id || recovered.tenantId !== state.tenantId || Number(recovered.history?.head || 0) !== latest) fail("video_checkpoint_corrupt", "The newest project checkpoint does not match its authoritative project.", 409);
        atomicJson(file, recovered);
        state = recovered;
      }
    }
    return state;
  }
  function save(tenantId, state) { state.updatedAt = iso(now); assertState(state); atomicJson(stateFile(tenantId, state.id), state); return clone(state); }
  const checkpointName = (seq, compressed = true) => join("", String(seq).padStart(8, "0") + (compressed ? ".json.gz" : ".json"));
  function checkpointSnapshot(state, seq) {
    const snapshot = clone(state);
    snapshot.history = { head: seq, undo: clone(state.history?.undo || []), redo: clone(state.history?.redo || []) };
    snapshot.screenplay.revisions = (snapshot.screenplay.revisions || []).map(({ text, ...revision }) => revision);
    return snapshot;
  }
  function readCheckpoint(p, seq) {
    const gz = join(p.checkpoints, checkpointName(seq)); const legacy = join(p.checkpoints, checkpointName(seq, false));
    try {
      if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
      if (existsSync(legacy)) return readJson(legacy);
    } catch { fail("video_checkpoint_corrupt", "That project checkpoint is unreadable.", 409); }
    fail("video_checkpoint_missing", "That project checkpoint is unavailable.", 404);
  }
  function event(tenantId, state, type, payload = {}) {
    const p = paths(tenantId, state.id); mkdirSync(p.checkpoints, { recursive: true });
    const seq = Number(state.history.head || 0) + 1; const record = { seq, at: iso(now), type: String(type), payload: clone(payload) };
    const packed = gzipSync(Buffer.from(JSON.stringify(checkpointSnapshot(state, seq)) + "\n", "utf8"), { level: 9 });
    storageBudget(tenantId, state.id, packed.length);
    atomicBytes(join(p.checkpoints, checkpointName(seq)), packed);
    writeFileSync(p.events, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
    state.history.head = seq;
    return record;
  }
  function mutate(tenantId, id, type, fn, payload = {}) {
    const before = load(tenantId, id); const next = clone(before); const changed = fn(next) || next; assertState(changed);
    changed.history.undo = [...before.history.undo, before.history.head].filter((seq) => Number.isInteger(seq) && seq > 0).slice(-100);
    changed.history.redo = [];
    event(tenantId, changed, type, payload);
    return save(tenantId, changed);
  }
  const projectEntries = (tenantId) => readdirSync(tenantRoot(tenantId), { withFileTypes: true }).filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name));
  function cleanupTenantTemporaryProjects(tenantId) {
    const dir = tenantRoot(tenantId); let removed = 0;
    for (const entry of projectEntries(tenantId)) {
      try {
        const state = load(tenantId, entry.name);
        if (!state.temporary || !state.expiresAt || Date.parse(state.expiresAt) > Number(now()) || state.jobs.some((job) => jobRequiresRetention(job, { requireDelivery: true })) || state.providerAttempts.some(providerAttemptRequiresRetention)) continue;
        const target = projectDir(tenantId, state.id);
        if (!within(dir, target) || basename(target) !== state.id) continue;
        rmSync(target, { recursive: true, force: false }); removed += 1;
      } catch { /* Corrupt projects are retained for explicit recovery or deletion. */ }
    }
    return removed;
  }
  function cleanupExpiredTemporaryProjects(tenantId) {
    if (tenantId) return { removed: cleanupTenantTemporaryProjects(validPart(tenantId, "tenant")) };
    const usersRoot = join(root, "users"); if (!existsSync(usersRoot)) return { removed: 0 };
    let removed = 0;
    for (const entry of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      removed += cleanupTenantTemporaryProjects(entry.name);
    }
    return { removed };
  }
  function createProject(tenantId, { name = "Untitled video", temporary = false } = {}) {
    const tenant = validPart(tenantId, "tenant"); cleanupTenantTemporaryProjects(tenant);
    const entries = projectEntries(tenant);
    if (entries.length >= maxProjectsPerTenant) fail("video_project_limit", `An account can keep at most ${maxProjectsPerTenant} video projects. Delete an unneeded project before creating another.`, 409);
    if (temporary) {
      for (const entry of entries) {
        try {
          const existing = load(tenant, entry.name);
          if (existing.temporary && (!existing.jobs.length || existing.jobs.some((job) => jobRequiresRetention(job, { requireDelivery: true })))) fail("video_mobile_generation_in_progress", "Only one mobile one-off generation can run at a time. Wait for it to finish or continue on desktop.", 409);
        } catch (error) { if (error instanceof VideoFeatureError && error.code === "video_mobile_generation_in_progress") throw error; }
      }
    }
    ensureDiskHeadroom();
    const id = randomUUID(); const p = paths(tenant, id);
    for (const dir of [p.checkpoints, p.generated, p.uploads, p.proxies, p.audio, p.thumbnails, p.renders, p.exports]) mkdirSync(dir, { recursive: true });
    const state = createState({ id, name, tenantId: tenant, now, temporary }); event(tenant, state, "project.created", { name: state.name, temporary: state.temporary }); return save(tenant, state);
  }
  function listProjects(tenantId) {
    const tenant = validPart(tenantId, "tenant"); cleanupTenantTemporaryProjects(tenant);
    return projectEntries(tenant).map((entry) => { try { const s = load(tenant, entry.name); if (s.temporary) return null; return { id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt, scenes: s.scenes.length, jobs: s.jobs.filter((j) => !terminal.has(j.status)).length }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  function recoverTemporaryJobs(tenantId) {
    const tenant = validPart(tenantId, "tenant"); cleanupTenantTemporaryProjects(tenant);
    const recovered = [];
    for (const entry of projectEntries(tenant)) {
      try {
        const state = load(tenant, entry.name); if (!state.temporary) continue;
        for (const job of state.jobs.filter((item) => jobRequiresRetention(item, { requireDelivery: true }))) recovered.push({ id: job.id, projectId: state.id, status: job.status, createdAt: job.createdAt, retryAfterMs: Number(job.retry?.delayMs) || 3_000, singleGeneration: true });
      } catch { /* A corrupt temporary project remains available for explicit operator recovery. */ }
    }
    return recovered.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }
  function renameProject(tenantId, id, name) { const text = String(name || "").trim(); if (!text || text.length > 160) fail("video_name_invalid", "Project names must be between 1 and 160 characters."); return mutate(tenantId, id, "project.renamed", (s) => { s.name = text; }, { name: text }); }
  function deleteProject(tenantId, id, { confirmDelete = false } = {}) { if (confirmDelete !== true) fail("video_delete_confirmation_required", "Explicit project deletion confirmation is required."); const dir = projectDir(tenantId, id); if (!existsSync(dir)) fail("video_project_missing", "Video project not found.", 404); if (!within(tenantRoot(tenantId), dir) || basename(dir) !== id) fail("video_path_invalid", "Invalid project path."); const state = load(tenantId, id); if (state.jobs.some((job) => jobRequiresRetention(job, { requireDelivery: state.temporary }))) fail("video_job_in_progress", "This project still has provider work, an unsettled video, or a verified mobile download awaiting delivery. Let Dominion finish before deleting the project.", 409); if (state.providerAttempts.some(providerAttemptRequiresRetention)) fail("video_provider_attempt_in_progress", "This project has a provider request or charge awaiting settlement or repair. Let Dominion finish before deleting the project.", 409); rmSync(dir, { recursive: true, force: false }); return { deleted: true, id }; }
  function applyVisualPlan(state, rawScenes) {
    const plan = Array.isArray(rawScenes) ? rawScenes : [];
    if (!plan.length || plan.length > MAX_SCENES) fail("video_scene_limit", "A visual plan must contain between 1 and 100 scenes.");
    const previous = new Map(state.scenes.map((scene) => [scene.id, scene]));
    state.scenes = plan.map((scene, index) => {
      const id = String(scene?.sceneId || scene?.id || `scene_${index + 1}`); if (!SAFE_ID.test(id.replaceAll("-", "_"))) fail("video_scene_invalid", "Visual plan contains an invalid scene id.");
      const old = previous.get(id) || {};
      return { ...old, id, title: String(scene?.title || old.title || `Scene ${index + 1}`).slice(0, 160), prompt: String(scene?.videoPrompt || scene?.imagePrompt || old.prompt || "").slice(0, 32000), imagePrompt: String(scene?.imagePrompt || "").slice(0, 32000), continuity: String(scene?.continuity || "").slice(0, 8000), model: VIDEO_CAPABILITIES[scene?.suggestedVideoModel] ? scene.suggestedVideoModel : old.model || null, status: old.status || "planned" };
    });
  }
  function applyCommand(tenantId, id, command = {}) { const type = String(command.type || ""); return mutate(tenantId, id, "command." + type, (s) => {
    if (type === "scene.add") { if (s.scenes.length >= MAX_SCENES) fail("video_scene_limit", "A project can contain at most 100 scenes."); const scene = clone(command.scene || {}); scene.id ||= randomUUID(); if (!SAFE_ID.test(scene.id.replaceAll("-", "_"))) fail("video_scene_invalid", "Invalid scene id."); s.scenes.push(scene); }
    else if (type === "scene.remove") { const index = s.scenes.findIndex((v) => v.id === command.sceneId); if (index < 0) fail("video_scene_missing", "Scene not found.", 404); s.scenes.splice(index, 1); }
    else if (type === "screenwriter.attempt") {
      const incoming = command.attempt && typeof command.attempt === "object" ? clone(command.attempt) : {};
      const attemptId = String(incoming.attemptId || "").slice(0, 128);
      if (!SAFE_ID.test(attemptId)) fail("video_provider_attempt_invalid", "The screenwriter attempt identity is invalid.");
      if (command.begin === true) {
        const expectedHash = String(incoming.sourceScreenplaySha256 || "");
        const currentHash = createHash("sha256").update(s.screenplay?.text || "").digest("hex");
        const expectedGeneration = String(incoming.sourceGenerationId || "").slice(0, 200) || null;
        const currentGeneration = String(s.ai?.screenwriter?.state?.generationId || "").slice(0, 200) || null;
        if (!/^[a-f0-9]{64}$/.test(expectedHash) || currentHash !== expectedHash || currentGeneration !== expectedGeneration) fail("screenwriter_stale_prompt", "The screenplay changed before Trinity provider egress. Refresh the project; no provider request was started.", 409);
        if (s.providerAttempts.some(screenwriterAttemptBlocksMutation)) fail("screenwriter_reconciliation_required", "This project already has Trinity provider work awaiting completion or reconciliation. No second provider request was started.", 409);
      }
      const index = s.providerAttempts.findIndex((attempt) => attempt.attemptId === attemptId);
      const prior = index >= 0 ? s.providerAttempts[index] : {};
      const candidate = incoming.candidate === undefined ? prior.candidate : incoming.candidate === null ? null : clone(incoming.candidate);
      if (candidate && Buffer.byteLength(JSON.stringify(candidate), "utf8") > 8 * 1024 * 1024) fail("video_provider_attempt_invalid", "The recoverable screenwriter candidate is too large to save safely.", 413);
      const rawUsage = incoming.usage && typeof incoming.usage === "object" ? incoming.usage : prior.usage || {};
      const rawSettlement = incoming.settlement && typeof incoming.settlement === "object" ? incoming.settlement : prior.settlement || {};
      const nullableText = (field, limit) => String((Object.hasOwn(incoming, field) ? incoming[field] : prior[field]) ?? "").slice(0, limit) || null;
      const attempt = {
        attemptId,
        generationId: nullableText("generationId", 200),
        provider: "openrouter",
        model: SCREENWRITER_MODEL,
        status: String(incoming.status || prior.status || "recorded").slice(0, 80),
        rejectionCode: nullableText("rejectionCode", 120),
        finishReason: nullableText("finishReason", 80),
        reconciliationFailures: Math.max(0, Math.min(100, Number(incoming.reconciliationFailures ?? prior.reconciliationFailures) || 0)),
        lastReconciliationError: nullableText("lastReconciliationError", 160),
        lastReconciledAt: nullableText("lastReconciledAt", 40),
        sourceScreenplaySha256: /^[a-f0-9]{64}$/.test(String(incoming.sourceScreenplaySha256 || prior.sourceScreenplaySha256 || "")) ? String(incoming.sourceScreenplaySha256 || prior.sourceScreenplaySha256) : null,
        sourceGenerationId: nullableText("sourceGenerationId", 200),
        usage: {
          promptTokens: Math.max(0, Number(rawUsage.promptTokens ?? rawUsage.prompt_tokens) || 0),
          completionTokens: Math.max(0, Number(rawUsage.completionTokens ?? rawUsage.completion_tokens) || 0),
          reasoningTokens: Math.max(0, Number(rawUsage.reasoningTokens ?? rawUsage.completion_tokens_details?.reasoning_tokens) || 0),
          totalTokens: Math.max(0, Number(rawUsage.totalTokens ?? rawUsage.total_tokens) || 0),
          costUsd: Math.max(0, Number(rawUsage.costUsd ?? rawUsage.cost) || 0),
        },
        settlement: {
          status: String(rawSettlement.status || "not_billed").slice(0, 80),
          key: String(rawSettlement.key || rawSettlement.settlementKey || "").slice(0, 300) || null,
          costUsd: Math.max(0, Number(rawSettlement.costUsd ?? rawUsage.costUsd ?? rawUsage.cost) || 0),
          errorCode: String(rawSettlement.errorCode || "").slice(0, 160) || null,
        },
        candidate: candidate || null,
        createdAt: prior.createdAt || iso(now),
        updatedAt: iso(now),
      };
      if (index >= 0) s.providerAttempts[index] = attempt; else s.providerAttempts.push(attempt);
      const supersedeAttemptId = String(command.supersedeAttemptId || "").slice(0, 128);
      if (supersedeAttemptId && supersedeAttemptId !== attemptId && attempt.generationId) {
        const superseded = s.providerAttempts.find((item) => item.attemptId === supersedeAttemptId);
        if (superseded) {
          superseded.generationId = attempt.generationId;
          superseded.status = "provider_correlated";
          superseded.rejectionCode = null;
          superseded.settlement = { status: "not_billed", key: null, costUsd: 0, errorCode: null };
          superseded.updatedAt = iso(now);
        }
      }
      s.providerAttempts = s.providerAttempts.slice(-100);
      const candidates = s.providerAttempts.filter((item) => item.candidate);
      for (const old of candidates.slice(0, -3)) old.candidate = null;
    }
    else if (type === "screenplay.set") {
      const text = String(command.text || ""); const tokens = tokenCount(text);
      if (tokens > MAX_SCREENPLAY_TOKENS) fail("video_screenplay_limit", "The screenplay exceeds the 115,000-token project limit.");
      if (command.expectedScreenplaySha256 !== undefined) {
        const expected = String(command.expectedScreenplaySha256 || "");
        if (!/^[a-f0-9]{64}$/.test(expected)) fail("video_screenplay_precondition_invalid", "The screenplay save precondition is invalid.", 400);
        const current = createHash("sha256").update(s.screenplay.text || "").digest("hex");
        if (current !== expected) fail("screenwriter_stale_write", "The screenplay changed while Trinity was writing. Its result was not allowed to overwrite the newer checkpoint.", 409);
      }
      if (Object.hasOwn(command, "expectedScreenwriterGenerationId")) {
        const expected = String(command.expectedScreenwriterGenerationId || "").slice(0, 200) || null;
        const current = String(s.ai.screenwriter.state?.generationId || "").slice(0, 200) || null;
        if (current !== expected) fail("screenwriter_stale_write", "Another Trinity turn completed while this one was running. Its result was not allowed to overwrite the newer checkpoint.", 409);
      }
      s.screenplay.revisions.push({ at: iso(now), tokens: s.screenplay.tokens, checkpointSeq: s.history?.head || null, sha256: createHash("sha256").update(s.screenplay.text || "").digest("hex") });
      s.screenplay.text = text; s.screenplay.tokens = tokens;
      if (command.model || command.generationId || command.usage || command.finishReason) {
        const usage = command.usage && typeof command.usage === "object" ? command.usage : {};
        const lastTurn = command.lastTurn && typeof command.lastTurn === "object" ? clone(command.lastTurn) : null;
        if (lastTurn && Buffer.byteLength(JSON.stringify(lastTurn), "utf8") > 1_500_000) fail("video_ai_state_large", "The screenwriter continuation state is too large to save safely.", 413);
        s.ai.screenwriter.state = {
          model: SCREENWRITER_MODEL,
          brief: String(command.brief ?? s.ai.screenwriter.state?.brief ?? "").slice(0, 460_000),
          generatedSections: Math.max(0, Number(command.generatedSections) || Number(s.ai.screenwriter.state?.generatedSections) || 0),
          lastTurn,
          sessionId: String(command.sessionId || s.ai.screenwriter.state?.sessionId || "").slice(0, 256) || null,
          generationId: String(command.generationId || "").slice(0, 200) || null,
          finishReason: String(command.finishReason || "unknown").slice(0, 80),
          truncated: command.truncated === true,
          usage: {
            promptTokens: Math.max(0, Number(usage.prompt_tokens) || 0),
            completionTokens: Math.max(0, Number(usage.completion_tokens) || 0),
            reasoningTokens: Math.max(0, Number(usage.completion_tokens_details?.reasoning_tokens) || 0),
            totalTokens: Math.max(0, Number(usage.total_tokens) || 0),
            costUsd: Math.max(0, Number(usage.cost) || 0),
          },
          updatedAt: iso(now),
        };
        const attempt = s.providerAttempts.find((item) => item.attemptId === command.attemptId)
          || (!command.attemptId && command.generationId ? s.providerAttempts.find((item) => item.generationId === command.generationId) : null);
        if (attempt) {
          attempt.status = "applied";
          attempt.settlement = {
            status: String(command.settlement?.status || (Number(usage.cost) > 0 ? "settled" : "skipped")).slice(0, 80),
            key: String(command.settlement?.settlementKey || command.settlement?.key || "").slice(0, 300) || null,
            costUsd: Math.max(0, Number(command.settlement?.costUsd ?? usage.cost) || 0),
            errorCode: null,
          };
          attempt.candidate = null;
          attempt.updatedAt = iso(now);
        }
      }
    }
    else if (type === "visual.plan.apply") {
      applyVisualPlan(s, command.scenes);
    }
    else if (type === "timeline.set") { const timeline = clone(command.timeline); if (!timeline || timeline.videoTracks?.length !== VIDEO_TRACKS || timeline.audioTracks?.length !== AUDIO_TRACKS) fail("video_timeline_invalid", "Exactly three video and four audio tracks are required."); s.timeline = timeline; }
    else if (type === "director.state") { s.ai.director.state = clone(command.state || {}); s.ai.director.compactionRequired = directorCompactionNeeded(command); }
    else if (type === "ai.state") {
      const role = String(command.role || ""); if (!Object.hasOwn(s.ai, role)) fail("video_ai_role_invalid", "Unknown project AI role.");
      const serialized = JSON.stringify(command.state || {}); if (serialized.length > 2 * 1024 * 1024) fail("video_ai_state_large", "The project AI state is too large.", 413);
      s.ai[role].state = clone(command.state || {});
    }
    else fail("video_command_unsupported", "Unsupported video project command.");
  }, { command: type }); }
  function checkpointProject(tenantId, id, { label = "Project checkpoint", state, expectedScreenplaySha256, expectedProjectRevision } = {}) {
    const safeLabel = String(label || "Project checkpoint").trim().slice(0, 160) || "Project checkpoint";
    return mutate(tenantId, id, "project.checkpoint", (current) => {
      assertProjectRevision(current, expectedProjectRevision);
      if (expectedScreenplaySha256 === undefined) fail("video_screenplay_precondition_required", "A screenplay revision precondition is required before saving a project checkpoint.", 428);
      const expected = String(expectedScreenplaySha256 || "");
      if (!/^[a-f0-9]{64}$/.test(expected)) fail("video_screenplay_precondition_invalid", "The screenplay checkpoint precondition is invalid.", 400);
      const currentHash = createHash("sha256").update(current.screenplay?.text || "").digest("hex");
      if (currentHash !== expected) fail("video_checkpoint_stale", "The server screenplay changed before this checkpoint could be saved. Refresh the project; the stale browser copy was not written.", 409);
      if (current.providerAttempts.some(screenwriterAttemptBlocksMutation)) fail("screenwriter_busy", "Trinity provider work is still being completed or reconciled for this project. The checkpoint was not changed.", 409);
      return normalizeClientCheckpoint(current, state);
    }, { label: safeLabel });
  }
  function updateAiState(tenantId, id, turn = {}) {
    return mutate(tenantId, id, "ai.turn", (state) => {
      if (turn.expectedProjectRevision === undefined) fail("video_project_revision_required", "A project revision precondition is required before saving an AI planning turn.", 428);
      const expectedProjectRevision = Number(turn.expectedProjectRevision);
      if (!Number.isInteger(expectedProjectRevision) || expectedProjectRevision < 0) fail("video_project_revision_invalid", "The project revision precondition is invalid.", 400);
      const planStale = Number(state.history?.head || 0) !== expectedProjectRevision;
      for (const role of ["director", "visualOrchestrator", "liaison"]) {
        if (turn[role]) state.ai[role].state = { ...clone(state.ai[role].state || {}), ...clone(turn[role]), updatedAt: iso(now) };
      }
      if (turn.visualOrchestrator) state.ai.visualOrchestrator.state.applyStatus = turn.visualPlanScenes ? (planStale ? "quarantined_stale" : "applied") : "unavailable";
      if (turn.visualPlanScenes && !planStale) applyVisualPlan(state, turn.visualPlanScenes);
      const priorTokens = Number(state.ai.director.state?.usedTokens || 0);
      const turnTokens = Number(turn.director?.usage?.total_tokens || turn.director?.usage?.totalTokens || 0);
      state.ai.director.state.usedTokens = turn.director?.compaction ? turnTokens : priorTokens + turnTokens;
      if (turn.director?.compaction?.summary) state.ai.director.state.compactedSummary = String(turn.director.compaction.summary).slice(0, 100000);
      state.ai.director.compactionRequired = directorCompactionNeeded({ usedTokens: state.ai.director.state.usedTokens, contextWindow: state.ai.director.contextWindow });
      if (turn.conversation) {
        state.conversation.push({ role: "user", content: String(turn.conversation.user || "").slice(0, 100000), at: turn.conversation.at });
        state.conversation.push({ role: "assistant", content: String(turn.conversation.reply || "").slice(0, 100000), at: turn.conversation.at });
        if (state.conversation.length > 500) state.conversation = state.conversation.slice(-500);
      }
    }, { models: { director: turn.director?.model, visualOrchestrator: turn.visualOrchestrator?.model, liaison: turn.liaison?.model }, expectedProjectRevision: turn.expectedProjectRevision });
  }
  function recordExport(tenantId, id, record = {}) {
    return mutate(tenantId, id, "export.completed", (state) => {
      state.exports.push({ id: String(record.id || randomUUID()), filename: basename(String(record.filename || "export.mp4")), format: String(record.format || "mp4"), bytes: Number(record.bytes || 0), duration: Number(record.duration || 0), createdAt: String(record.createdAt || iso(now)), status: String(record.status || "ready") });
    }, { exportId: record.id, filename: basename(String(record.filename || "export.mp4")) });
  }
  function markJobSettled(tenantId, id, jobId, settlement = {}) {
    const saved = mutate(tenantId, id, "job.settled", (state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) fail("video_job_missing", "Video job not found.", 404);
      job.settlement = {
        status: "settled",
        settledAt: iso(now),
        settlementKey: String(settlement.settlementKey || "").slice(0, 300) || null,
        costUsd: Number(settlement.costUsd ?? job.cost ?? 0),
      };
    }, { jobId, settlementKey: String(settlement.settlementKey || "").slice(0, 300) || null });
    return clone(saved.jobs.find((item) => item.id === jobId));
  }
  function markJobDelivered(tenantId, id, jobId) {
    const saved = mutate(tenantId, id, "job.delivered", (state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) fail("video_job_missing", "Video job not found.", 404);
      if (!state.temporary || job.status !== "ready" || !job.localOutput || (Number(job.cost) > 0 && job.settlement?.status !== "settled")) fail("video_delivery_not_ready", "The verified mobile video is not ready to acknowledge for delivery.", 409);
      job.delivery = { status: "delivered", deliveredAt: iso(now) };
    }, { jobId });
    return clone(saved.jobs.find((item) => item.id === jobId));
  }
  function listCheckpoints(tenantId, id) {
    const p = paths(tenantId, id); load(tenantId, id);
    let records = [];
    try { records = readFileSync(p.events, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { fail("video_history_corrupt", "The video project history is unreadable.", 409); }
    return records.filter((record) => Number.isInteger(record.seq) && (existsSync(join(p.checkpoints, checkpointName(record.seq))) || existsSync(join(p.checkpoints, checkpointName(record.seq, false))))).map((record) => ({ seq: record.seq, at: record.at, type: record.type, label: String(record.payload?.label || record.type).slice(0, 160) })).reverse();
  }
  function assertProjectRevision(state, expectedProjectRevision) {
    if (expectedProjectRevision === undefined) fail("video_project_revision_required", "A project revision precondition is required before changing saved project history.", 428);
    const expectedRevision = Number(expectedProjectRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail("video_project_revision_invalid", "The project revision precondition is invalid.", 400);
    if (Number(state.history?.head || 0) !== expectedRevision) fail("video_project_revision_stale", "The server project changed before this action could be saved. Refresh the project; the stale browser action was not applied.", 409);
    return expectedRevision;
  }
  function restoreCheckpoint(tenantId, id, seq, expectedProjectRevision) {
    const number = Number(seq); if (!Number.isInteger(number) || number < 1) fail("video_checkpoint_invalid", "A valid project checkpoint is required.");
    const p = paths(tenantId, id); const snapshot = assertState(readCheckpoint(p, number));
    if (snapshot.id !== id || snapshot.tenantId !== validPart(tenantId, "tenant")) fail("video_checkpoint_invalid", "That checkpoint belongs to another project.", 409);
    return mutate(tenantId, id, "project.restored", (current) => {
      assertProjectRevision(current, expectedProjectRevision);
      if (current.providerAttempts.some(screenwriterAttemptBlocksMutation)) fail("screenwriter_busy", "Trinity provider work is still being completed or reconciled for this project. The saved screenplay was not restored.", 409);
      const restored = restoreProjectSnapshot(current, snapshot); restored.history = current.history; return restored;
    }, { restoredSeq: number });
  }
  function undo(tenantId, id, expectedProjectRevision) {
    const state = load(tenantId, id);
    assertProjectRevision(state, expectedProjectRevision);
    if (state.providerAttempts.some(screenwriterAttemptBlocksMutation)) fail("screenwriter_busy", "Trinity provider work is still being completed or reconciled for this project. The saved screenplay was not changed.", 409);
    const targetSeq = state.history.undo.pop();
    if (!targetSeq) fail("video_undo_empty", "There is no project change to undo.", 409);
    const next = assertState(restoreProjectSnapshot(state, readCheckpoint(paths(tenantId, id), targetSeq)));
    next.history = { head: state.history.head, undo: state.history.undo, redo: [...state.history.redo, state.history.head].slice(-100) };
    event(tenantId, next, "command.undo", { restoredSeq: targetSeq });
    return save(tenantId, next);
  }
  function redo(tenantId, id, expectedProjectRevision) {
    const state = load(tenantId, id);
    assertProjectRevision(state, expectedProjectRevision);
    if (state.providerAttempts.some(screenwriterAttemptBlocksMutation)) fail("screenwriter_busy", "Trinity provider work is still being completed or reconciled for this project. The saved screenplay was not changed.", 409);
    const targetSeq = state.history.redo.pop();
    if (!targetSeq) fail("video_redo_empty", "There is no project change to restore.", 409);
    const next = assertState(restoreProjectSnapshot(state, readCheckpoint(paths(tenantId, id), targetSeq)));
    next.history = { head: state.history.head, undo: [...state.history.undo, state.history.head].slice(-100), redo: state.history.redo };
    event(tenantId, next, "command.redo", { restoredSeq: targetSeq });
    return save(tenantId, next);
  }
  /*
   * Keep the storyboard scene in agreement with the job that renders it (2026-08-05). The client
   * has sent sceneId since the studio shipped and nothing on this side ever read it, so scene
   * cards could never show their own clip. Tolerant on purpose: no sceneId, or a scene deleted
   * mid-flight, is a no-op rather than a failed generation.
   */
  function stampScene(s, job, status) {
    const sceneId = job?.request?.sceneId;
    if (!sceneId) return;
    const scene = (s.scenes || []).find((item) => item.id === sceneId);
    if (!scene) return;
    scene.status = status;
    if (status === "generating" || status === "ready") scene.mediaJobId = job.id;
  }
  function persistProviderResult(tenantId, projectId, jobId, result, eventType, submission = {}) {
    const status = String(result.status || "processing").toLowerCase();
    return mutate(tenantId, projectId, eventType, (s) => {
      const target = s.jobs.find((item) => item.id === jobId);
      target.status = status === "success" && result.videoURL ? "ready" : ["failed", "error"].includes(status) ? "failed" : "generating";
      target.taskUuid = jobId; target.progress = Number(result.progress ?? target.progress ?? 0); target.cost = result.cost ?? target.cost; target.output = result.videoURL || target.output || null; target.videoUUID = result.videoUUID || target.videoUUID || null; target.videoId = result.outputs?.videoId || target.videoId || null; target.lastPolledAt = iso(now);
      target.submission = { ...(target.submission || {}), state: "accepted", acceptedAt: iso(now), ...submission };
      if (status === "success" && !target.output) { target.status = "failed"; target.error = "video_provider_missing_output"; }
      if (["failed", "error"].includes(status)) { target.error = String(result.code || result.error?.code || "video_provider_failed").slice(0, 160); target.providerError = { code: target.error, message: String(result.message || result.error?.message || "Runware reported that this video task failed.").slice(0, 800), status: null }; }
      if (target.status === "failed") stampScene(s, target, "failed");
    }, { jobId, taskUuid: jobId, status }).jobs.find((item) => item.id === jobId);
  }
  async function submitGeneration(tenantId, projectId, request, billingContext = {}) {
    const valid = validateVideoRequest(request);
    const existingResponse = () => {
      if (!valid.idempotencyKey) return null;
      const existing = load(tenantId, projectId).jobs.find((job) => job.request?.idempotencyKey === valid.idempotencyKey);
      if (!existing) return null;
      if (JSON.stringify(existing.request) !== JSON.stringify(valid)) fail("video_idempotency_conflict", "That generation request identity is already attached to different settings.", 409);
      return { jobId: existing.id, taskUuid: existing.taskUuid || existing.id, project: projectId, status: existing.status, deduplicated: true };
    };
    const priorForKey = existingResponse();
    if (priorForKey) return priorForKey;
    if (typeof billingGate !== "function") fail("video_billing_unavailable", "Video billing is not configured.", 503);
    const gate = await billingGate({ tenantId, projectId, request: clone(valid), tenant: billingContext.tenant || null, requireAutoRecharge: true, requireCard: true }); if (!gate || gate.allowed !== true) fail("video_billing_required", gate?.message || "Enable auto top-up and add a payment method before generating video.", 402);
    if (!keyForRunware()) fail("video_provider_unavailable", "Video generation is not configured.", 503); if (typeof fetchImpl !== "function") fail("video_provider_unavailable", "Video generation is unavailable.", 503);
    const existing = existingResponse();
    if (existing) return existing;
    const jobId = randomUUID(); const state = mutate(tenantId, projectId, "job.queued", (s) => { s.jobs.push({ id: jobId, status: "queued", attempt: 0, createdAt: iso(now), request: valid, provider: "runware", taskUuid: jobId, cost: null, submission: { state: "pending", attempts: 1 } }); stampScene(s, s.jobs.at(-1), "generating"); }, { jobId, model: valid.model });
    const task = compileRunwareTask(valid, jobId);
    try {
      const result = await runwareRequest(task); const submitted = persistProviderResult(tenantId, projectId, jobId, result, "job.submitted", { attempts: 1, safeToResubmit: false });
      return { jobId, taskUuid: jobId, project: state.id, status: submitted.status || "generating" };
    }
    catch (err) {
      const retry = classifyVideoRetry(err, 0);
      const failure = providerFailure(err);
      const recovery = submissionRecovery(err);
      mutate(tenantId, projectId, "job.submit_failed", (s) => { const job = s.jobs.find((j) => j.id === jobId); job.status = retry.retryable ? "retrying" : "failed"; job.retry = retry; job.error = failure.code; job.providerError = failure; job.submission = { state: retry.retryable ? recovery.state : "failed", attempts: 1, safeToResubmit: retry.retryable && recovery.safeToResubmit }; if (job.status === "failed") stampScene(s, job, "failed"); }, { jobId, retry, recovery, providerError: failure });
      if (retry.retryable) return { jobId, taskUuid: jobId, project: projectId, status: "retrying", retryAfterMs: retry.delayMs, recoveredFrom: err instanceof VideoFeatureError ? err.code : "provider_request_failed" };
      throw err;
    }
  }
  async function pollJob(tenantId, projectId, jobId) {
    const state = load(tenantId, projectId); const job = state.jobs.find((j) => j.id === jobId); if (!job) fail("video_job_missing", "Video job not found.", 404); if (terminal.has(job.status)) return clone(job); if (!keyForRunware() || typeof fetchImpl !== "function") fail("video_provider_unavailable", "Video generation is unavailable.", 503);
    if (job.submission?.state === "retry_safe") {
      const attempts = Math.max(1, Number(job.submission.attempts) || 1);
      if (attempts >= 3) return mutate(tenantId, projectId, "job.resubmit_exhausted", (s) => { const target = s.jobs.find((item) => item.id === jobId); target.status = "failed"; target.error = "video_provider_submit_exhausted"; target.submission = { ...target.submission, state: "failed", safeToResubmit: false }; stampScene(s, target, "failed"); }, { jobId, attempts }).jobs.find((item) => item.id === jobId);
      try {
        const result = await runwareRequest(compileRunwareTask(job.request, jobId));
        return persistProviderResult(tenantId, projectId, jobId, result, "job.resubmitted", { attempts: attempts + 1, safeToResubmit: false });
      } catch (err) {
        const retry = classifyVideoRetry(err, Number(job.attempt || 0)); const failure = providerFailure(err); const recovery = submissionRecovery(err); const nextAttempts = attempts + 1;
        const retrySafe = retry.retryable && recovery.safeToResubmit && nextAttempts < 3; const acknowledgementUnknown = retry.retryable && !recovery.safeToResubmit;
        return mutate(tenantId, projectId, "job.resubmit_failed", (s) => { const target = s.jobs.find((item) => item.id === jobId); target.attempt = Number(target.attempt || 0) + 1; target.status = retrySafe || acknowledgementUnknown ? "retrying" : "failed"; target.retry = retry; target.error = failure.code; target.providerError = failure; target.submission = { state: retrySafe ? "retry_safe" : acknowledgementUnknown ? "ack_unknown" : "failed", attempts: nextAttempts, safeToResubmit: retrySafe }; if (target.status === "failed") stampScene(s, target, "failed"); }, { jobId, retry, recovery, providerError: failure }).jobs.find((item) => item.id === jobId);
      }
    }
    try {
      const result = await runwareRequest({ taskType: "getResponse", taskUUID: job.taskUuid || job.id });
      return persistProviderResult(tenantId, projectId, jobId, result, "job.polled", { attempts: Math.max(1, Number(job.submission?.attempts) || 1), safeToResubmit: false });
    }
    catch (err) { const retry = classifyVideoRetry(err, Number(job.attempt || 0)); const failure = providerFailure(err, "video_provider_poll_failed"); const unknownTask = job.submission?.state === "ack_unknown" && ["taskNotFound", "taskUUIDNotFound"].includes(failure.code); const keepPolling = retry.retryable || unknownTask; return mutate(tenantId, projectId, "job.poll_failed", (s) => { const target = s.jobs.find((j) => j.id === jobId); target.attempt = Number(target.attempt || 0) + 1; target.status = keepPolling ? "retrying" : "failed"; target.retry = { ...retry, retryable: keepPolling, delayMs: keepPolling ? Math.max(3_000, retry.delayMs || 30_000) : 0 }; target.error = failure.code; target.providerError = failure; if (target.status === "failed") stampScene(s, target, "failed"); }, { jobId, retry, acknowledgementUnknown: unknownTask, providerError: failure }).jobs.find((j) => j.id === jobId); }
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
      const budget = storageBudget(tenantId, projectId);
      const stored = await mediaProcessor.download({ url: job.output, destination, job: clone(job), tenantId, projectId, expiresAt: job.outputExpiresAt || null, maxBytes: budget.remainingBytes });
      const verified = typeof mediaProcessor.verify === "function" ? await mediaProcessor.verify({ path: destination, job: clone(job), result: stored, requireVideo: true }) : null;
      try { storageBudget(tenantId, projectId); } catch (error) { rmSync(destination, { force: true }); throw error; }
      const savedState = mutate(tenantId, projectId, "job.downloaded", (s) => {
        const target = s.jobs.find((j) => j.id === jobId); target.localOutput = destination; target.mediaFile = basename(destination); target.downloadedAt = iso(now);
        target.media = { hasVideo: !!verified?.video?.length, hasAudio: !!verified?.audio?.length, duration: Number(verified?.duration || target.request?.duration || 0) || null };
        const videoTrack = s.timeline.videoTracks[0]; const clipId = `clip-${jobId}`;
        const duration = Number(target.media.duration || target.request?.duration || 5);
        const existingVideo = videoTrack.clips.find((clip) => clip.mediaJobId === jobId || clip.id === clipId);
        const start = existingVideo ? Number(existingVideo.start) : videoTrack.clips.reduce((latest, clip) => Math.max(latest, Number(clip.start || 0) + Number(clip.duration || 0)), 0);
        if (!Number.isFinite(duration) || duration <= 0 || start + duration > MAX_PROJECT_DURATION) fail("video_project_duration_exceeded", "The generated clip cannot fit within the six-hour project limit.", 409);
        // The clip carries its scene home (2026-08-05): the UI attaches previews by clip.sceneId.
        const sceneId = target.request?.sceneId || null;
        if (!existingVideo) videoTrack.clips.push({ id: clipId, name: "Generated scene", start, duration, sourceStart: 0, type: "video", linked: target.media.hasAudio ? `audio-${jobId}` : null, mediaJobId: jobId, sceneId, mediaFile: target.mediaFile, volume: 1, fit: "contain" });
        else if (sceneId && !existingVideo.sceneId) existingVideo.sceneId = sceneId;
        if (target.media.hasAudio) {
          const audioTrack = s.timeline.audioTracks[0]; const audioId = `audio-${jobId}`;
          if (!audioTrack.clips.some((clip) => clip.mediaJobId === jobId || clip.id === audioId)) audioTrack.clips.push({ id: audioId, name: "Generated sound", start, duration, sourceStart: 0, type: "audio", linked: clipId, mediaJobId: jobId, sceneId, mediaFile: target.mediaFile, volume: 1, fit: "contain" });
        }
        stampScene(s, target, "ready");
      }, { jobId });
      const savedJob = savedState.jobs.find((item) => item.id === jobId);
      const clips = [...savedState.timeline.videoTracks, ...savedState.timeline.audioTracks].flatMap((track) => track.clips.filter((clip) => clip.mediaJobId === jobId).map((clip) => ({ ...clone(clip), trackId: track.id })));
      return { ...clone(savedJob), clips };
    } catch (err) {
      rmSync(destination, { force: true });
      mutate(tenantId, projectId, "job.download_failed", (s) => { const target = s.jobs.find((j) => j.id === jobId); target.downloadError = err instanceof VideoFeatureError ? err.code : "media_download_failed"; }, { jobId });
      if (err instanceof VideoFeatureError) throw err;
      fail("video_media_download_failed", "The generated video could not be saved and verified. The provider copy remains available for retry.", 502);
    }
  }
  function recoverJobs(tenantId, projectId) { const state = load(tenantId, projectId); return state.jobs.filter((j) => ["queued", "generating", "retrying"].includes(j.status) || (j.status === "ready" && !j.localOutput)).map((j) => clone(j)); }
  return {
    MAX_SCENES, MAX_SCREENPLAY_TOKENS, VIDEO_TRACKS, AUDIO_TRACKS, capabilities: VIDEO_CAPABILITIES,
    createProject, listProjects, getProject: (tenantId, id) => clone(load(tenantId, id)), getClientProject: (tenantId, id) => clientProject(load(tenantId, id)),
    renameProject, deleteProject, checkpointProject, listCheckpoints, restoreCheckpoint, updateAiState, recordExport, markJobSettled, markJobDelivered, applyCommand, undo, redo, submitGeneration, pollJob, downloadJobOutput, recoverJobs, recoverTemporaryJobs, storageBudget, cleanupExpiredTemporaryProjects,
    validateVideoRequest, safeError: safeVideoError, paths: (tenantId, id) => ({ ...paths(tenantId, id) }),
  };
}
