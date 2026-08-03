/*
 * Local media primitives for Dominion Video.  This module deliberately has no
 * HTTP or UI knowledge: callers persist jobs/checkpoints and invoke these
 * argv-only plans.  Nothing here invokes a shell or downloads a binary.
 */
import { spawn } from "node:child_process";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { constants as FS, createWriteStream } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const VIDEO_TRACK_LIMIT = 3;
export const AUDIO_TRACK_LIMIT = 4;
export const DEFAULT_CONTAINER = "mp4";
export const DEFAULT_VIDEO_CODEC = "h264";
export const DEFAULT_AUDIO_CODEC = "aac";

export const SOCIAL_PRESETS = Object.freeze({
  youtube: { label: "YouTube", width: 1920, height: 1080, fps: 30, container: "mp4" },
  youtube_shorts: { label: "YouTube Shorts", width: 1080, height: 1920, fps: 30, container: "mp4" },
  tiktok: { label: "TikTok", width: 1080, height: 1920, fps: 30, container: "mp4" },
  instagram_reels: { label: "Instagram Reels", width: 1080, height: 1920, fps: 30, container: "mp4" },
  instagram_stories: { label: "Instagram Stories", width: 1080, height: 1920, fps: 30, container: "mp4" },
  instagram_square: { label: "Instagram Feed 1:1", width: 1080, height: 1080, fps: 30, container: "mp4" },
  instagram_portrait: { label: "Instagram Feed 4:5", width: 1080, height: 1350, fps: 30, container: "mp4" },
  facebook: { label: "Facebook Video", width: 1920, height: 1080, fps: 30, container: "mp4" },
  facebook_reels: { label: "Facebook Reels", width: 1080, height: 1920, fps: 30, container: "mp4" },
  x: { label: "X", width: 1920, height: 1080, fps: 30, container: "mp4" },
  linkedin: { label: "LinkedIn", width: 1920, height: 1080, fps: 30, container: "mp4" },
  pinterest: { label: "Pinterest", width: 1000, height: 1500, fps: 30, container: "mp4" },
  snapchat: { label: "Snapchat", width: 1080, height: 1920, fps: 30, container: "mp4" },
  generic_16_9: { label: "16:9", width: 1920, height: 1080, fps: 30, container: "mp4" },
  generic_9_16: { label: "9:16", width: 1080, height: 1920, fps: 30, container: "mp4" },
  generic_1_1: { label: "1:1", width: 1080, height: 1080, fps: 30, container: "mp4" },
  generic_4_5: { label: "4:5", width: 1080, height: 1350, fps: 30, container: "mp4" },
  generic_3_4: { label: "3:4", width: 1080, height: 1440, fps: 30, container: "mp4" },
  generic_4_3: { label: "4:3", width: 1440, height: 1080, fps: 30, container: "mp4" },
  generic_21_9: { label: "21:9", width: 2560, height: 1080, fps: 30, container: "mp4" },
});

export class MediaError extends Error { constructor(message, code = "MEDIA_ERROR") { super(message); this.name = "MediaError"; this.code = code; } }

/** Returns an immutable preset copy and rejects unknown UI-supplied keys. */
export function socialPreset(name) {
  const preset = SOCIAL_PRESETS[name];
  if (!preset) throw new MediaError(`Unknown social preset: ${name}`, "INVALID_PRESET");
  return { ...preset };
}

function safeInt(value, fallback, min = 1, max = 20000) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new MediaError(`Invalid numeric media value: ${value}`, "INVALID_MEDIA_VALUE");
  return n;
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new MediaError(`Invalid ${label}`, "INVALID_PATH");
  return value;
}

/** True only when candidate is contained by root; handles sibling-prefix attacks. */
export function isPathInside(root, candidate) {
  const base = resolve(assertText(root, "media root"));
  const target = resolve(assertText(candidate, "media path"));
  return target === base || relative(base, target) !== "" && !relative(base, target).startsWith(`..${sep}`) && relative(base, target) !== ".." && !isAbsolute(relative(base, target));
}

export function assertPathInside(root, candidate) {
  if (!isPathInside(root, candidate)) throw new MediaError("Media path is outside the project directory", "PATH_OUTSIDE_PROJECT");
  return resolve(candidate);
}

/** FFmpeg filter escaping, not shell escaping.  Paths are deliberately quoted. */
export function escapeFilterValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function runProcess(command, args, { cwd, env, signal, onProgress, timeoutMs = 0, spawnImpl = spawn } = {}) {
  if (!Array.isArray(args) || args.some((x) => typeof x !== "string")) return Promise.reject(new MediaError("Process args must be string argv values", "INVALID_ARGV"));
  return new Promise((resolvePromise, reject) => {
    let child; let timer; let stdout = ""; let stderr = ""; let cancelled = false;
    try { child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    const read = (chunk, isErr) => {
      const text = String(chunk); if (isErr) stderr += text; else stdout += text;
      if (onProgress) for (const progress of parseFfmpegProgress(text)) onProgress(progress);
    };
    child.stdout?.on("data", (c) => read(c, false)); child.stderr?.on("data", (c) => read(c, true));
    const cancel = () => { cancelled = true; child.kill("SIGTERM"); };
    if (signal) { if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true }); }
    if (timeoutMs > 0) timer = setTimeout(() => { cancelled = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.once("close", (code, processSignal) => {
      if (timer) clearTimeout(timer);
      const result = { command, args: [...args], code: code ?? -1, signal: processSignal, stdout, stderr, cancelled };
      if (code === 0 && !cancelled) resolvePromise(result);
      else reject(Object.assign(new MediaError(cancelled ? "Media process cancelled" : `Media process failed (${code})`, cancelled ? "CANCELLED" : "PROCESS_FAILED"), { result }));
    });
  });
}

/** Parses FFmpeg's key=value pipe progress and common frame/fps status lines. */
export function parseFfmpegProgress(text) {
  const progress = [];
  for (const line of String(text).split(/\r?\n|\r/)) {
    const kv = /^([\w_]+)=(.*)$/.exec(line.trim());
    if (kv && ["frame", "fps", "out_time_ms", "speed", "progress"].includes(kv[1])) progress.push({ [kv[1]]: kv[2] });
    else { const m = /frame=\s*(\d+).*?fps=\s*([\d.]+)/.exec(line); if (m) progress.push({ frame: Number(m[1]), fps: Number(m[2]) }); }
  }
  return progress;
}

async function canRun(command, args, runner) { try { const r = await runner(command, args); return { ok: true, ...r }; } catch (error) { return { ok: false, error }; } }

/** Detects configured binaries first then PATH.  Never guesses codec availability. */
export async function detectMediaCapabilities({ env = process.env, runner = runProcess } = {}) {
  // A configured path is preferred, not mandatory: PATH remains a useful
  // recovery route after a stale deployment variable or a moved local binary.
  const firstAvailable = async (configured, fallback, args) => {
    const candidates = [...new Set([configured, fallback].filter(Boolean))];
    let last = { ok: false };
    for (const command of candidates) { last = await canRun(command, args, runner); if (last.ok) return { command, result: last }; }
    return { command: configured || fallback, result: last };
  };
  const probeChoice = await firstAvailable(env.FFPROBE_PATH, "ffprobe", ["-v", "error", "-version"]);
  const encoderChoice = await firstAvailable(env.FFMPEG_PATH, "ffmpeg", ["-hide_banner", "-encoders"]);
  const ffprobe = probeChoice.command;
  const ffmpeg = encoderChoice.command;
  const probe = probeChoice.result;
  const encoders = encoderChoice.result;
  const text = `${encoders.stdout || ""}\n${encoders.stderr || ""}`;
  const has = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`).test(text);
  const available = { h264_nvenc: has("h264_nvenc"), hevc_nvenc: has("hevc_nvenc"), h264_qsv: has("h264_qsv"), hevc_qsv: has("hevc_qsv"), h264_amf: has("h264_amf"), hevc_amf: has("hevc_amf"), libx264: has("libx264"), libx265: has("libx265"), libaom_av1: has("libaom-av1"), libsvtav1: has("libsvtav1"), libvpx_vp9: has("libvpx-vp9"), aac: has("aac"), libopus: has("libopus"), pcm_s16le: has("pcm_s16le") };
  return Object.freeze({ ffmpeg, ffprobe, ffmpegAvailable: encoders.ok, ffprobeAvailable: probe.ok, encoders: Object.freeze(available), rawEncoderText: text });
}

export function chooseVideoEncoder(capabilities, { codec = "h264", preferHardware = true } = {}) {
  const e = capabilities?.encoders || {};
  const order = codec === "hevc" ? ["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"] : codec === "av1" ? ["libsvtav1", "libaom_av1"] : codec === "vp9" ? ["libvpx_vp9"] : ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];
  const candidates = preferHardware ? order : order.filter((name) => !/(nvenc|qsv|amf)$/.test(name)).concat(order.filter((name) => /(nvenc|qsv|amf)$/.test(name)));
  const encoder = candidates.find((name) => e[name]);
  if (!encoder) throw new MediaError(`No supported ${codec} encoder is installed`, "ENCODER_UNAVAILABLE");
  return encoder;
}

export function chooseAudioEncoder(capabilities, container = "mp4") {
  const e = capabilities?.encoders || {};
  if (container === "webm" && e.libopus) return "libopus";
  if (e.aac) return "aac";
  if (e.pcm_s16le && container === "mov") return "pcm_s16le";
  throw new MediaError("No compatible audio encoder is installed", "AUDIO_ENCODER_UNAVAILABLE");
}

/** Invokes ffprobe only with JSON output then validates a minimally useful media shape. */
export async function probeMedia(file, { ffprobe = "ffprobe", projectRoot, runner = runProcess } = {}) {
  if (projectRoot) assertPathInside(projectRoot, file);
  const result = await runner(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
  let parsed; try { parsed = JSON.parse(result.stdout); } catch { throw new MediaError("ffprobe returned invalid JSON", "INVALID_PROBE_JSON"); }
  if (!parsed || !Array.isArray(parsed.streams) || !parsed.format || typeof parsed.format !== "object") throw new MediaError("ffprobe response is missing streams or format", "INVALID_PROBE_RESULT");
  const streams = parsed.streams.map((stream) => ({ ...stream }));
  const video = streams.filter((s) => s.codec_type === "video"); const audio = streams.filter((s) => s.codec_type === "audio");
  const duration = Number(parsed.format.duration);
  return { format: { ...parsed.format }, streams, video, audio, duration: Number.isFinite(duration) && duration >= 0 ? duration : null, valid: streams.length > 0 };
}

function ensureOutput(input, output, projectRoot) { if (projectRoot) { assertPathInside(projectRoot, input); assertPathInside(projectRoot, output); } assertText(input, "input path"); assertText(output, "output path"); }
function scaleFilter(width, height, mode = "contain") {
  if (mode === "cover") return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

export function buildProxyCommand({ input, output, width = 960, height = 540, fps = 30, projectRoot, ffmpeg = "ffmpeg" } = {}) {
  ensureOutput(input, output, projectRoot); width = safeInt(width, 960); height = safeInt(height, 540); fps = safeInt(fps, 30, 1, 120);
  return { command: ffmpeg, args: ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-vf", `${scaleFilter(width, height)},fps=${fps}`, "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-movflags", "+faststart", output], output };
}

export function buildExtractAudioCommand({ input, output, projectRoot, ffmpeg = "ffmpeg" } = {}) {
  ensureOutput(input, output, projectRoot);
  return { command: ffmpeg, args: ["-y", "-i", input, "-map", "0:a:0?", "-vn", "-c:a", "pcm_s16le", output], output };
}

export function buildThumbnailCommand({ input, output, time = 0, width = 640, projectRoot, ffmpeg = "ffmpeg" } = {}) {
  ensureOutput(input, output, projectRoot); if (!Number.isFinite(Number(time)) || Number(time) < 0) throw new MediaError("Invalid thumbnail time", "INVALID_MEDIA_VALUE");
  return { command: ffmpeg, args: ["-y", "-ss", String(time), "-i", input, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${safeInt(width, 640)}:-2`, output], output };
}

export function buildContactSheetCommand({ input, output, duration, columns = 4, rows = 3, width = 1280, projectRoot, ffmpeg = "ffmpeg" } = {}) {
  ensureOutput(input, output, projectRoot); columns = safeInt(columns, 4, 1, 12); rows = safeInt(rows, 3, 1, 12); width = safeInt(width, 1280); const frames = columns * rows;
  const interval = duration && Number(duration) > 0 ? Math.max(Number(duration) / frames, 0.1) : 1;
  return { command: ffmpeg, args: ["-y", "-i", input, "-vf", `fps=1/${interval},scale=${Math.floor(width / columns)}:-2,tile=${columns}x${rows}:padding=4:margin=4`, "-frames:v", "1", output], output };
}

export function buildAudioPeakCommand({ input, projectRoot, ffmpeg = "ffmpeg" } = {}) {
  if (projectRoot) assertPathInside(projectRoot, input); assertText(input, "input path");
  return { command: ffmpeg, args: ["-v", "info", "-i", input, "-map", "0:a:0?", "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-", "-f", "null", "-" ] };
}

export function parseAudioPeakData(text) {
  const values = [...String(text).matchAll(/(?:Peak_level|peak_level)[^=]*=\s*(-?[\d.]+|-inf)/gi)].map((m) => m[1] === "-inf" ? -Infinity : Number(m[1])).filter((n) => Number.isFinite(n) || n === -Infinity);
  return { peaksDb: values, maxDb: values.length ? Math.max(...values) : null, silent: !values.length || values.every((n) => n === -Infinity) };
}

export function buildDiagnosticsCommands({ input, projectRoot, ffmpeg = "ffmpeg", noise = -50, freezeDuration = 2, blackDuration = 0.5 } = {}) {
  if (projectRoot) assertPathInside(projectRoot, input); assertText(input, "input path");
  return [
    { kind: "black", command: ffmpeg, args: ["-v", "info", "-i", input, "-vf", `blackdetect=d=${Number(blackDuration)}:pic_th=0.98`, "-an", "-f", "null", "-"] },
    { kind: "freeze", command: ffmpeg, args: ["-v", "info", "-i", input, "-vf", `freezedetect=n=-60dB:d=${Number(freezeDuration)}`, "-an", "-f", "null", "-"] },
    { kind: "silence", command: ffmpeg, args: ["-v", "info", "-i", input, "-af", `silencedetect=n=${Number(noise)}dB:d=0.5`, "-vn", "-f", "null", "-"] },
  ];
}

export function parseDiagnostics(text) {
  const out = { black: [], freeze: [], silence: [] }; const source = String(text);
  for (const m of source.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) out.black.push({ start: +m[1], end: +m[2], duration: +m[3] });
  for (const m of source.matchAll(/freeze_(?:start|end):\s*([\d.]+)/g)) out.freeze.push(+m[1]);
  for (const m of source.matchAll(/silence_(?:start|end):\s*([\d.]+)/g)) out.silence.push(+m[1]);
  return out;
}

function clipNumber(value, fallback = 0) { const n = Number(value ?? fallback); if (!Number.isFinite(n) || n < 0) throw new MediaError("Invalid clip timing", "INVALID_CLIP"); return n; }
function trackLimit(clips, max, label) { if (!Array.isArray(clips)) throw new MediaError(`${label} clips must be an array`, "INVALID_TRACKS"); const tracks = new Set(clips.map((c) => Number(c.track ?? 0))); if ([...tracks].some((n) => !Number.isInteger(n) || n < 0 || n >= max)) throw new MediaError(`${label} track limit is ${max}`, "TRACK_LIMIT"); }

/**
 * Deterministic filtergraph for up to three visual layers and four audio layers.
 * Clip ordering is by start then original index, which makes saved projects render
 * identically across restarts.  Video uses black background and overlays layers;
 * audio is delayed/mixed and intentionally has no hidden normalization.
 */
export function buildTimelineFiltergraph({ videoClips = [], audioClips = [], width, height, fps = 30, duration } = {}) {
  trackLimit(videoClips, VIDEO_TRACK_LIMIT, "Video"); trackLimit(audioClips, AUDIO_TRACK_LIMIT, "Audio");
  width = safeInt(width, 1920); height = safeInt(height, 1080); fps = safeInt(fps, 30, 1, 120); duration = clipNumber(duration, 0);
  const sort = (clips) => clips.map((c, index) => ({ ...c, _index: index, start: clipNumber(c.start, 0), duration: clipNumber(c.duration, 0), track: Number(c.track ?? 0) })).sort((a, b) => a.track - b.track || a.start - b.start || a._index - b._index);
  const videos = sort(videoClips); const audios = sort(audioClips); const filters = [`color=c=black:s=${width}x${height}:r=${fps}:d=${duration || 1}[base]`];
  let v = "base";
  for (const clip of videos) {
    const i = clip.inputIndex; if (!Number.isInteger(i) || i < 0) throw new MediaError("Video clip inputIndex is required", "INVALID_CLIP");
    const sourceStart = clipNumber(clip.sourceStart, 0); const trim = `trim=start=${sourceStart}${clip.duration ? `:duration=${clip.duration}` : ""},`; const cropMode = clip.fit === "cover" ? "cover" : "contain";
    filters.push(`[${i}:v]${trim}setpts=PTS-STARTPTS+${clip.start}/TB,${scaleFilter(width, height, cropMode)}[v${clip._index}]`);
    filters.push(`[${v}][v${clip._index}]overlay=0:0:enable='between(t,${clip.start},${clip.start + (clip.duration || duration || 1)})'[ov${clip._index}]`); v = `ov${clip._index}`;
  }
  const aLabels = [];
  for (const clip of audios) {
    const i = clip.inputIndex; if (!Number.isInteger(i) || i < 0) throw new MediaError("Audio clip inputIndex is required", "INVALID_CLIP");
    const delay = Math.round(clip.start * 1000); const sourceStart = clipNumber(clip.sourceStart, 0); const trim = `atrim=start=${sourceStart}${clip.duration ? `:duration=${clip.duration}` : ""},`; const volume = Number(clip.volume ?? 1); if (!Number.isFinite(volume) || volume < 0 || volume > 8) throw new MediaError("Invalid audio volume", "INVALID_CLIP");
    filters.push(`[${i}:a]${trim}asetpts=PTS-STARTPTS,adelay=${delay}|${delay},volume=${volume}[a${clip._index}]`); aLabels.push(`[a${clip._index}]`);
  }
  if (aLabels.length) filters.push(`${aLabels.join("")}amix=inputs=${aLabels.length}:duration=longest:dropout_transition=0[aout]`);
  return { filterComplex: filters.join(";"), videoLabel: `[${v}]`, audioLabel: aLabels.length ? "[aout]" : null, orderedVideo: videos, orderedAudio: audios };
}

function validateContainer(container) { if (!["mp4", "webm", "mov"].includes(container)) throw new MediaError(`Unsupported output container: ${container}`, "INVALID_CONTAINER"); return container; }
function tempPath(output) { const ext = extname(output); return resolve(dirname(output), `.${basename(output, ext)}.${process.pid}.${Date.now()}.partial${ext || ".mp4"}`); }

export function buildExportPlan({ inputs = [], videoClips = [], audioClips = [], output, preset = "youtube", container, codec = "h264", capabilities, projectRoot, ffmpeg = "ffmpeg", duration, quality = "balanced", preferHardware = false } = {}) {
  if (!Array.isArray(inputs) || !inputs.length) throw new MediaError("Export requires at least one input", "NO_INPUTS"); if (!output) throw new MediaError("Export output is required", "INVALID_PATH");
  if (projectRoot) { for (const input of inputs) assertPathInside(projectRoot, input); assertPathInside(projectRoot, output); }
  const dimensions = socialPreset(preset); container = validateContainer(container || dimensions.container);
  if (container === "webm" && !["vp9", "av1"].includes(codec)) codec = "vp9"; if (container === "mov" && codec === "vp9") throw new MediaError("VP9 cannot be exported to MOV", "INVALID_CONTAINER_CODEC");
  const encoder = chooseVideoEncoder(capabilities, { codec, preferHardware }); const audioEncoder = chooseAudioEncoder(capabilities, container);
  const timeline = buildTimelineFiltergraph({ videoClips, audioClips, width: dimensions.width, height: dimensions.height, fps: dimensions.fps, duration });
  const partialOutput = tempPath(output); const args = ["-y", "-progress", "pipe:2"];
  for (const input of inputs) args.push("-i", input);
  args.push("-filter_complex", timeline.filterComplex, "-map", timeline.videoLabel);
  if (timeline.audioLabel) args.push("-map", timeline.audioLabel); else args.push("-an");
  args.push("-r", String(dimensions.fps), "-c:v", encoder);
  if (/^(h264|hevc)_(nvenc|qsv|amf)$/.test(encoder)) args.push("-b:v", quality === "maximum" ? "20M" : quality === "small" ? "5M" : "10M");
  else if (encoder === "libx264" || encoder === "libx265") args.push("-crf", quality === "maximum" ? "17" : quality === "small" ? "27" : "21", "-preset", quality === "maximum" ? "slow" : "medium");
  else if (encoder.includes("vp9") || encoder.includes("av1")) args.push("-crf", quality === "maximum" ? "22" : quality === "small" ? "38" : "30", "-b:v", "0");
  if (timeline.audioLabel) args.push("-c:a", audioEncoder, "-b:a", audioEncoder === "pcm_s16le" ? "1411k" : "192k");
  if (container === "mp4") args.push("-movflags", "+faststart", "-pix_fmt", "yuv420p");
  if (Number(duration) > 0) args.push("-t", String(Number(duration)));
  args.push(partialOutput);
  return { command: ffmpeg, args, output: resolve(output), partialOutput, dimensions, encoder, audioEncoder, timeline };
}

/** Executes a plan safely; only a fully written partial file is atomically renamed. */
export async function executeExportPlan(plan, { runner = runProcess, signal, onProgress, cleanupPartial = true } = {}) {
  const cleanup = async () => { if (cleanupPartial) await rm(plan.partialOutput, { force: true }).catch(() => {}); };
  try { await mkdir(dirname(plan.output), { recursive: true }); await runner(plan.command, plan.args, { signal, onProgress }); await access(plan.partialOutput, FS.R_OK); const info = await stat(plan.partialOutput); if (!info.size) throw new MediaError("Encoder produced an empty output", "EMPTY_OUTPUT"); await rename(plan.partialOutput, plan.output); return { output: plan.output, bytes: info.size }; }
  catch (error) { await cleanup(); throw error; }
}

/**
 * Production media adapter used by the HTTP layer. Provider bytes are streamed to a unique
 * project-local partial file, size-limited during transfer, atomically renamed, then ffprobed.
 */
export function createVideoMediaProcessor({ fetchImpl = globalThis.fetch, env = process.env, runner = runProcess, maxDownloadBytes = 1024 * 1024 * 1024, allowHttp = false } = {}) {
  let capabilityPromise = null;
  const capabilities = () => capabilityPromise ||= detectMediaCapabilities({ env, runner });

  async function download({ url, destination, signal } = {}) {
    if (typeof fetchImpl !== "function") throw new MediaError("Media download is unavailable", "DOWNLOAD_UNAVAILABLE");
    let parsed; try { parsed = new URL(String(url || "")); } catch { throw new MediaError("Provider media URL is invalid", "INVALID_DOWNLOAD_URL"); }
    if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) throw new MediaError("Provider media URL must use HTTPS", "INVALID_DOWNLOAD_URL");
    destination = resolve(assertText(destination, "download destination"));
    await mkdir(dirname(destination), { recursive: true });
    const partial = resolve(dirname(destination), `.${basename(destination, extname(destination))}.${randomUUID()}.partial${extname(destination) || ".mp4"}`);
    let bytes = 0;
    try {
      const response = await fetchImpl(parsed, { method: "GET", redirect: "follow", signal, headers: { accept: "video/*,application/octet-stream;q=0.8" } });
      if (!response.ok || !response.body) throw new MediaError(`Provider media download failed (${response.status})`, "DOWNLOAD_FAILED");
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > maxDownloadBytes) throw new MediaError("Provider media exceeds the project download limit", "DOWNLOAD_TOO_LARGE");
      const limiter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > maxDownloadBytes ? new MediaError("Provider media exceeds the project download limit", "DOWNLOAD_TOO_LARGE") : null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partial, { flags: "wx" }));
      if (!bytes) throw new MediaError("Provider returned an empty media file", "EMPTY_DOWNLOAD");
      await rename(partial, destination);
      return { path: destination, bytes, contentType: response.headers.get("content-type") || "" };
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function verify({ path, projectRoot } = {}) {
    const caps = await capabilities();
    if (!caps.ffprobeAvailable) throw new MediaError("ffprobe is not installed on this video worker", "FFPROBE_UNAVAILABLE");
    const result = await probeMedia(path, { ffprobe: caps.ffprobe, projectRoot, runner });
    if (!result.valid || !result.video.length || !(result.duration > 0)) throw new MediaError("The generated file is not a playable video", "INVALID_VIDEO_OUTPUT");
    return result;
  }

  async function exportTimeline({ inputs, videoClips, audioClips, output, preset, container, codec, projectRoot, duration, quality, signal, onProgress } = {}) {
    const caps = await capabilities();
    if (!caps.ffmpegAvailable || !caps.ffprobeAvailable) throw new MediaError("FFmpeg and ffprobe are required for export", "FFMPEG_UNAVAILABLE");
    const plan = buildExportPlan({ inputs, videoClips, audioClips, output, preset, container, codec, capabilities: caps, projectRoot, ffmpeg: caps.ffmpeg, duration, quality });
    const rendered = await executeExportPlan(plan, { runner, signal, onProgress });
    const media = await verify({ path: rendered.output, projectRoot });
    return { ...rendered, media, encoder: plan.encoder, audioEncoder: plan.audioEncoder, dimensions: plan.dimensions };
  }

  return { capabilities, download, verify, exportTimeline };
}
