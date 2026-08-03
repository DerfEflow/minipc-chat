/* Project-local upload, source resolution, and verified timeline export. */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const INPUT_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".ogg"]);
const OUTPUT_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export class VideoWorkspaceError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "VideoWorkspaceError"; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new VideoWorkspaceError(code, message, status); };
function inside(root, candidate) { const rel = relative(resolve(root), resolve(candidate)); return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../")); }
function safeFilename(value) {
  const raw = basename(String(value || "media")); const ext = extname(raw).toLowerCase();
  if (!INPUT_EXTENSIONS.has(ext)) fail("video_upload_type", "Import an MP4, MOV, M4V, WebM, MP3, WAV, M4A, AAC, or OGG file.");
  const stem = basename(raw, ext).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "media";
  return `${stem}-${randomUUID()}${ext}`;
}

export function createVideoWorkspace({ feature, processor, now = Date.now, maxUploadBytes = MAX_UPLOAD_BYTES, exportTimeoutMs = 15 * 60 * 1000 } = {}) {
  if (!feature || typeof feature.getProject !== "function") throw new TypeError("video feature is required");
  if (!processor || typeof processor.verify !== "function" || typeof processor.exportTimeline !== "function") throw new TypeError("video media processor is required");

  const activeExports = new Map();

  async function importUpload({ req, tenantId, projectId, filename, projectPaths } = {}) {
    await feature.getProject(tenantId, projectId);
    const declared = Number(req?.headers?.["content-length"] || 0);
    if (declared > maxUploadBytes) fail("video_upload_large", "That media file exceeds the 1 GB project import limit.", 413);
    const budget = typeof feature.storageBudget === "function" ? feature.storageBudget(tenantId, projectId, declared) : null;
    const storedName = safeFilename(filename); const root = resolve(projectPaths.uploads); const output = resolve(root, storedName);
    if (!inside(root, output)) fail("video_upload_path", "Invalid project media path.");
    await mkdir(root, { recursive: true });
    const partial = resolve(root, `.${storedName}.${randomUUID()}.partial${extname(storedName)}`);
    let bytes = 0;
    const maximum = Math.min(maxUploadBytes, budget?.remainingBytes ?? maxUploadBytes);
    const limiter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > maximum ? new VideoWorkspaceError("video_storage_quota_exceeded", "This project has reached its storage limit.", 507) : null, chunk); } });
    try {
      await pipeline(req, limiter, createWriteStream(partial, { flags: "wx" }));
      if (!bytes) fail("video_upload_empty", "The imported media file is empty.");
      await rename(partial, output);
      const media = await processor.verify({ path: output, projectRoot: projectPaths.dir, requireVideo: false });
      if (typeof feature.storageBudget === "function") feature.storageBudget(tenantId, projectId);
      return { filename: storedName, bytes, duration: media.duration, hasVideo: media.video.length > 0, hasAudio: media.audio.length > 0, status: "ready" };
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {}); await rm(output, { force: true }).catch(() => {});
      throw error;
    }
  }

  function locateNamedFile(projectPaths, filename) {
    const name = basename(String(filename || ""));
    for (const root of [projectPaths.uploads, projectPaths.generated, projectPaths.exports, projectPaths.renders].filter(Boolean)) {
      const candidate = resolve(root, name); if (inside(root, candidate) && existsSync(candidate)) return candidate;
    }
    return null;
  }

  async function resolveFile({ filename, projectPaths } = {}) {
    const file = locateNamedFile(projectPaths, filename); if (!file) fail("video_media_missing", "Project media not found.", 404); return file;
  }

  async function exportProject({ tenantId, projectId, request = {}, projectPaths } = {}) {
    const runKey = `${tenantId}:${projectId}`;
    const running = activeExports.get(runKey);
    if (running) fail("video_export_in_progress", "An export is already running for this project.", 409);
    const run = { startedAt: new Date(Number(now())).toISOString(), status: "running" }; activeExports.set(runKey, run);
    let finalOutput = null;
    try {
    const state = await feature.getProject(tenantId, projectId);
    const tracks = [...state.timeline.videoTracks, ...state.timeline.audioTracks];
    const solo = { video: state.timeline.videoTracks.some((track) => track.solo), audio: state.timeline.audioTracks.some((track) => track.solo) };
    const jobs = new Map((state.jobs || []).map((job) => [job.id, job]));
    const sources = new Map(); const videoClips = []; const audioClips = [];
    const resolveSource = (clip) => {
      let file = clip.mediaJobId ? jobs.get(clip.mediaJobId)?.localOutput : null;
      if (!file && clip.mediaFile) file = locateNamedFile(projectPaths, clip.mediaFile);
      if (!file || !inside(projectPaths.dir, file)) fail("video_export_source_missing", `Media for clip ${clip.name || clip.id} is unavailable.`, 409);
      file = resolve(file); if (!sources.has(file)) sources.set(file, sources.size); return { file, inputIndex: sources.get(file) };
    };
    for (const track of tracks) {
      const kind = track.kind === "audio" ? "audio" : "video";
      if (track.mute || (solo[kind] && !track.solo)) continue;
      for (const clip of track.clips || []) {
        const source = resolveSource(clip); const mapped = { inputIndex: source.inputIndex, start: Number(clip.start || 0), sourceStart: Number(clip.sourceStart || 0), duration: Number(clip.duration || 0), track: Number(track.id.slice(1)) - 1, volume: Number(clip.volume ?? 1), fit: clip.fit };
        (kind === "audio" ? audioClips : videoClips).push(mapped);
      }
    }
    if (!videoClips.length) fail("video_export_empty", "Add at least one video clip before exporting.", 409);
    const inputs = [...sources.keys()];
    // Inspect every source without assuming it has a picture stream. The subsequent track-specific
    // checks require video only for video layers, allowing a genuine audio-only import on audio layers.
    const probes = await Promise.all(inputs.map((path) => processor.verify({ path, projectRoot: projectPaths.dir, requireVideo: false })));
    for (const clip of videoClips) if (!probes[clip.inputIndex].video.length) fail("video_export_video_stream_missing", "A video-layer clip does not contain video.", 409);
    for (const clip of audioClips) if (!probes[clip.inputIndex].audio.length) fail("video_export_audio_stream_missing", "An audio-layer clip does not contain audio.", 409);
    const duration = Math.max(...[...videoClips, ...audioClips].map((clip) => clip.start + clip.duration));
    const platform = String(request.platform || state.settings?.platform || "").toLowerCase(); const ratio = String(request.ratio || state.settings?.ratio || "16:9");
    const preset = platform.includes("tiktok") ? "tiktok" : platform.includes("instagram") ? (ratio === "1:1" ? "instagram_square" : ratio === "4:5" ? "instagram_portrait" : "instagram_reels") : platform.includes("linkedin") ? "linkedin" : platform.includes("facebook") ? (ratio === "9:16" ? "facebook_reels" : "facebook") : platform.includes("youtube") ? (ratio === "9:16" ? "youtube_shorts" : "youtube") : ({ "16:9": "generic_16_9", "9:16": "generic_9_16", "1:1": "generic_1_1", "4:5": "generic_4_5", "3:4": "generic_3_4", "4:3": "generic_4_3", "21:9": "generic_21_9" }[ratio] || "generic_16_9");
    const format = ["mp4", "mov", "webm"].includes(String(request.format)) ? String(request.format) : "mp4"; const id = randomUUID();
    const filename = `dominion-${new Date(Number(now())).toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.${format}`; const output = resolve(projectPaths.exports, filename); finalOutput = output;
    if (!OUTPUT_EXTENSIONS.has(extname(output).toLowerCase()) || !inside(projectPaths.exports, output)) fail("video_export_path", "Invalid export path.");
    const budget = typeof feature.storageBudget === "function" ? feature.storageBudget(tenantId, projectId) : null;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(30_000, Number(exportTimeoutMs) || 15 * 60 * 1000));
    let rendered;
    try { rendered = await processor.exportTimeline({ inputs, videoClips, audioClips, output, preset, container: format, codec: format === "webm" ? "vp9" : "h264", projectRoot: projectPaths.dir, duration, quality: "maximum", signal: controller.signal, maxOutputBytes: budget?.remainingBytes }); }
    catch (error) { if (controller.signal.aborted) fail("video_export_timeout", "The export exceeded the server time limit and was not marked complete.", 504); throw error; }
    finally { clearTimeout(timer); }
    if (typeof feature.storageBudget === "function") feature.storageBudget(tenantId, projectId);
    if (typeof feature.recordExport === "function") await feature.recordExport(tenantId, projectId, { id, filename, format, bytes: rendered.bytes, duration, createdAt: new Date(Number(now())).toISOString(), status: "ready" });
    run.status = "ready";
    return { id, status: "ready", filename, format, bytes: rendered.bytes, duration, encoder: rendered.encoder, dimensions: rendered.dimensions, url: `/api/video/media/${encodeURIComponent(projectId)}/${encodeURIComponent(filename)}` };
    } catch (error) { run.status = "failed"; if (finalOutput) await rm(finalOutput, { force: true }).catch(() => {}); throw error; }
    finally { activeExports.delete(runKey); }
  }

  function exportStatus({ tenantId, projectId } = {}) { const run = activeExports.get(`${tenantId}:${projectId}`); return run ? { ...run } : { status: "idle" }; }
  return { importUpload, exportProject, exportStatus, resolveFile };
}
