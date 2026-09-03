/*
 * Dominion Video Studio HTTP seam.
 *
 * Authentication, account gates, provider calls, and response shaping live here so server.mjs
 * only needs one narrow /api/video dispatch. The durable project/job implementation remains in
 * video.mjs and the FFmpeg implementation remains in video-media.mjs.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { MediaError } from "./video-media.mjs";
import { shapeProviderExecutionRequest, stableProviderSessionId } from "./providerexecution.mjs";
import { screenwriterAttemptBlocksMutation } from "./video.mjs";

const API_ROOT = "/api/video";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const MAX_SCREENPLAY_CHARS = 460_000;
const SCREENWRITER_MODEL = "arcee-ai/trinity-large-thinking";
const SONNET_MODEL = "claude-sonnet-5";
/*
 * MODEL LADDERS (stabilize 2026-09-03, deficiency 20 + LANE-video required behavior #2). NVIDIA
 * retired deepseek-ai/deepseek-v4-pro on 2026-08-07 (every director turn 410'd in production, and
 * the old visual orchestrator alone took 50-57s). Fred's overriding rule is that nothing may end
 * in a silent or announced error while an alternative remains untried, so every agent now has an
 * ordered ladder of provider+model rungs instead of one hardcoded model. runAgentLadder (below)
 * walks the list and returns the first rung that answers with usable content; the served rung is
 * recorded as ordinary metadata (servedBy), never as a degraded/error state. Model ids for NVIDIA
 * and DeepSeek-direct were confirmed live on the rig 2026-09-03 (see specs/LANE-video.md).
 */
const HAIKU_MODEL = "claude-haiku-4-5-20251001"; // Anthropic direct model id (models.catalog.mjs directId); "claude-haiku-4-5" is the display/catalog id only.
const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro"; // DeepSeek direct (api.deepseek.com), not the OpenRouter-style "deepseek/deepseek-v4-pro" id.
const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash"; // DeepSeek direct.
const NVIDIA_DEEPSEEK_MODEL = "deepseek-ai/deepseek-v4-pro-0813"; // NVIDIA's live replacement for the retired deepseek-ai/deepseek-v4-pro.
const NVIDIA_NEMOTRON_SUPER_MODEL = "nvidia/nemotron-3-super-120b-a12b"; // NVIDIA, ~4.4s.
const NVIDIA_NEMOTRON_ULTRA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b"; // NVIDIA, 50-57s for five tokens; last resort only.
const SCREENWRITER_CONTEXT_TOKENS = 115_000;
const SCREENWRITER_MAX_OUTPUT_TOKENS = 16_384;
/*
 * REASONING-MODEL TOKEN FLOOR (stabilize 2026-09-03, follow-up to deficiency 20). Probed live
 * against the real DeepSeek key: deepseek-v4-pro is a reasoning model that writes its scratchpad to
 * message.reasoning_content BEFORE message.content. At max_tokens 1 (the boot probe) or 512 (the
 * director's prior budget) the entire budget is consumed by reasoning_content, finish_reason comes
 * back "length", and content is "" - openAiText() correctly calls that empty_response (it only ever
 * reads .content, which is right: reasoning_content is scratchpad, not the answer), so the rung
 * degrades and the ladder falls through, but rung 1's latency was paid for nothing on every single
 * real turn. Probed at max_tokens 2048 the same prompt finished reasoning at ~1072 tokens and
 * produced real content (finish_reason "stop"). deepseek-v4-flash (visual orchestrator's and
 * liaison's other DeepSeek-direct rungs) is far cheaper on reasoning (475 and 396 reasoning tokens
 * respectively against their real 8192/4096 budgets, both already succeeding) and is NOT the
 * starved rung in production - only deepseek-v4-pro at a sub-4096 budget was ever observed broken.
 * This floor is applied only where a real answer is wanted, not the 1-token boot probe: the probe's
 * job is a liveness/credential check (a 4xx demotes, anything else doesn't), and required behavior
 * #6 specifies a 1-token request - raising it would change the probe's spec-named shape for a signal
 * the real-turn floor below already provides better.
 */
const DEEPSEEK_REASONING_MIN_TOKENS = { [DEEPSEEK_PRO_MODEL]: 4_096 };
function reasoningSafeMaxTokens(model, requested) {
  const floor = DEEPSEEK_REASONING_MIN_TOKENS[model];
  return floor ? Math.max(Number(requested) || 0, floor) : requested;
}
const SCREENWRITER_MIN_OUTPUT_TOKENS = 8_192;
const LONG_CONTEXT_TOKENS = 1_000_000;
const DIRECTOR_COMPACT_AT = 700_000;
const AI_TURN_TIMEOUT_MS = 240_000;
const CONTEXT_SAFETY_TOKENS = 8_192;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_PROJECT_ID = /^[a-f0-9-]{36}$/i;
const SAFE_MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/;
const MEDIA_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".jpg", ".jpeg", ".png", ".webp", ".json"]);

export function openRouterUsageCost(usage = {}) {
  const hasReportedCost = usage.cost !== null && usage.cost !== undefined && String(usage.cost).trim() !== "";
  const reported = hasReportedCost ? Number(usage.cost) : NaN;
  if (!Number.isFinite(reported) || reported < 0) throw new RangeError("OpenRouter usage.cost is required for exact billing.");
  return +reported.toFixed(8);
}

class VideoHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "VideoHttpError";
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new VideoHttpError(status, code, message); };
function definitiveProviderHttpRejection(error) {
  const match = String(error?.code || "").match(/_http_(\d{3})$/);
  const status = Number(error?.upstreamStatus || match?.[1]);
  if (error?.providerGenerationId || Number(error?.providerUsage?.cost) > 0) return false;
  if (Number.isInteger(error?.providerRouterAttempt)) {
    if (error.providerRouterAttempt > 0) return false;
    if (error.providerRouterAttempt === 0) return true;
  }
  return status >= 400 && status < 500 && status !== 408;
}
function failWithScreenwriterAttempt(status, code, message, attempt) {
  const error = new VideoHttpError(status, code, message);
  error.screenwriterAttempt = attempt;
  throw error;
}
const clone = (value) => value == null ? value : structuredClone(value);
/*
 * PLAIN TENANT PROJECTION (stabilize 2026-09-03, deficiency 19). Every POST /api/video/jobs 500'd
 * with a DataCloneError: the signed-in tenant object (OWNER_T / tenants.resolve() in server.mjs)
 * carries live handles - a `memory` object with a `propose()` function, plus chatlog/artifacts/
 * flywheel/etc - and structuredClone refuses to clone a function. billingGate (server.mjs) and
 * everything downstream of submitGeneration's billingContext.tenant only ever reads isOwner, role,
 * and email, so there was never a reason to hand it the whole live tenant. Project onto exactly the
 * fields any video code reads, which are all structured-clone-safe by construction.
 */
const plainTenant = (tenant) => ({
  id: tenant?.id ?? null,
  uid: tenant?.uid ?? null,
  email: tenant?.email ?? null,
  role: tenant?.role ?? null,
  isOwner: !!tenant?.isOwner,
  invited: !!tenant?.invited,
  status: tenant?.status ?? null,
  tenantId: tenant?.tenantId ?? null,
});
const cleanText = (value, max = 20_000) => String(value || "").trim().slice(0, max);
const trimSlash = (value) => String(value || "").replace(/\/+$/, "");
const credential = (value) => cleanText(typeof value === "function" ? value() : value, 20_000);
const tokenEstimate = (value) => {
  const text = String(value || "");
  return Math.max(text.trim() ? text.trim().split(/\s+/).length : 0, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
};

function requestTokenEstimate(value) {
  return tokenEstimate(typeof value === "string" ? value : JSON.stringify(value));
}

function enforceContextWindow(code, label, value, contextTokens, outputTokens) {
  const estimated = requestTokenEstimate(value);
  const inputLimit = Math.max(1, Number(contextTokens) - Number(outputTokens || 0) - CONTEXT_SAFETY_TOKENS);
  if (estimated > inputLimit) {
    fail(413, code, `${label} needs about ${estimated.toLocaleString()} input tokens, above its safe ${inputLimit.toLocaleString()}-token request limit. Shorten the immutable screenplay/storyboard state or restore an earlier checkpoint; no content was silently dropped.`);
  }
  return estimated;
}

function conversationChunks(conversation, budgetTokens = 600_000) {
  const chunks = [];
  let current = [];
  for (const entry of Array.isArray(conversation) ? conversation : []) {
    const next = [...current, entry];
    if (current.length && requestTokenEstimate(next) > budgetTokens) {
      chunks.push(current);
      current = [entry];
    } else current = next;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function endpoint(base, suffix) {
  const root = trimSlash(base);
  if (!root) return "";
  if (suffix === "/v1/messages" && /\/v1$/i.test(root)) return root + "/messages";
  return root + suffix;
}

function requestHeader(req, name) {
  const value = req?.headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function isMobileRequest(req, body = {}) {
  const declared = cleanText(body.device || requestHeader(req, "x-dominion-device"), 30).toLowerCase();
  const agent = requestHeader(req, "user-agent");
  // A mobile user agent always wins over a client-supplied desktop hint. The hint still covers
  // iPadOS desktop-class user agents and test/embedded clients that intentionally identify as mobile.
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(agent)) return true;
  return declared === "mobile" || declared === "phone" || declared === "tablet";
}

function tenantIdFor(tenant) {
  const declared = cleanText(tenant?.tenantId || tenant?.uid || tenant?.id || tenant?.userId, 128);
  if (SAFE_ID.test(declared)) return declared;
  const identity = cleanText(tenant?.email, 512).toLowerCase();
  if (!identity) fail(401, "no_identity", "Sign in to use Dominion Video.");
  return "user_" + createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
  return true;
}

function errorPayload(error, requestId) {
  const media = error instanceof MediaError;
  const known = error instanceof VideoHttpError || (Number.isInteger(error?.status) && error?.code) || media;
  const mediaStatus = media ? (error.code === "STORAGE_QUOTA_EXCEEDED" ? 507 : /UNAVAILABLE/.test(error.code) ? 503 : /DOWNLOAD|EMPTY|INVALID_VIDEO_OUTPUT|INVALID_MEDIA_OUTPUT/.test(error.code) ? 502 : 400) : 500;
  const status = known ? (media ? mediaStatus : Number(error.status)) : 500;
  const code = known ? String(error.code || "video_error") : "video_internal";
  // An unknown fault used to leave no trace anywhere but a requestId in the client's error toast.
  // Log it server-side so the cause is diagnosable (stabilize 2026-09-03).
  if (!known) console.error(`[video] internal fault ${requestId}:`, error && error.stack ? error.stack : error);
  const message = known
    ? cleanText(error.message, 800) || "The video operation could not be completed."
    : "Dominion Video hit an internal fault. Nothing was marked complete or charged by this response.";
  return { status, body: { error: message, code, requestId } };
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(requestHeader(req, "content-length") || 0);
  if (declared > maxBytes) fail(413, "request_too_large", "The video request is too large.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > maxBytes) fail(413, "request_too_large", "The video request is too large.");
    chunks.push(part);
  }
  if (!bytes) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") fail(400, "invalid_json", "The request body must be a JSON object.");
    return parsed;
  } catch (error) {
    if (error instanceof VideoHttpError) throw error;
    fail(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function screenOrFail(screenContent, tenant, text) {
  const result = screenContent(String(text || ""), { isOwner: !!tenant.isOwner });
  if (result?.blocked) fail(403, "video_content_blocked", cleanText(result.reason, 800) || "That request cannot be processed.");
}

function ensureProjectId(value) {
  const id = cleanText(value, 80);
  if (!SAFE_PROJECT_ID.test(id)) fail(400, "video_project_invalid", "A valid video project id is required.");
  return id;
}

function screenplayPrecondition(body = {}) {
  if (!Object.hasOwn(body, "expectedScreenplaySha256")) fail(428, "video_screenplay_precondition_required", "Refresh the project before saving; a screenplay revision precondition is required.");
  const expected = String(body.expectedScreenplaySha256 || "");
  if (!/^[a-f0-9]{64}$/.test(expected)) fail(400, "video_screenplay_precondition_invalid", "The screenplay revision precondition is invalid.");
  return expected;
}

function projectRevisionPrecondition(body = {}) {
  if (!Object.hasOwn(body, "expectedProjectRevision")) fail(428, "video_project_revision_required", "Refresh the project before saving; a project revision precondition is required.");
  const expected = Number(body.expectedProjectRevision);
  if (!Number.isInteger(expected) || expected < 0) fail(400, "video_project_revision_invalid", "The project revision precondition is invalid.");
  return expected;
}

function ensureJobId(value) {
  const id = cleanText(value, 128);
  if (!SAFE_ID.test(id)) fail(400, "video_job_invalid", "A valid video job id is required.");
  return id;
}

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch { fail(400, "video_path_invalid", "The video request path is invalid."); }
}

function clientAi(ai) {
  const safe = clone(ai || {});
  const writerState = ai?.screenwriter?.state || {};
  if (safe.screenwriter) safe.screenwriter.state = {
    generatedSections: Math.max(0, Number(writerState.generatedSections) || 0),
    lastFinishReason: cleanText(writerState.finishReason, 80) || null,
    truncated: writerState.truncated === true,
    updatedAt: writerState.updatedAt || null,
  };
  return safe;
}

function projectForClient(state) {
  if (!state) return state;
  if (state.project && Array.isArray(state.scenes) && Array.isArray(state.tracks)) return clone(state);
  const videoTracks = Array.isArray(state.timeline?.videoTracks) ? state.timeline.videoTracks : [];
  const audioTracks = Array.isArray(state.timeline?.audioTracks) ? state.timeline.audioTracks : [];
  const tracks = [...videoTracks, ...audioTracks].map((track, index) => ({
    id: track.id,
    type: track.kind || (index < videoTracks.length ? "video" : "audio"),
    name: track.name || `${index < videoTracks.length ? "Video" : "Audio"} ${index < videoTracks.length ? index + 1 : index - videoTracks.length + 1}`,
    mute: !!track.mute,
    solo: !!track.solo,
    lock: !!track.lock,
  }));
  const clips = [...videoTracks, ...audioTracks].flatMap((track) => (track.clips || []).map((clip) => ({ ...clone(clip), trackId: track.id })));
  return {
    project: { id: state.id, name: state.name, model: state.settings?.model, purpose: state.settings?.purpose, platform: state.settings?.platform, ratio: state.settings?.ratio, resolution: state.settings?.resolution, format: state.settings?.format },
    projectRevision: Number(state.history?.head) || 0,
    screenplay: state.screenplay?.text || "",
    screenplaySha256: createHash("sha256").update(state.screenplay?.text || "").digest("hex"),
    scenes: clone(state.scenes || []),
    tracks,
    clips,
    ui: clone(state.ui || {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ai: clientAi(state.ai),
  };
}

function providerMessage(body) {
  return cleanText(body?.error?.message || body?.error || body?.detail || body?.message, 800);
}

async function readProviderBody(response, maxBytes = MAX_PROVIDER_BYTES, provider = "provider") {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* The size error is authoritative. */ }
        fail(502, `${provider}_response_too_large`, `${provider} returned an unexpectedly large response.`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) fail(502, `${provider}_response_too_large`, `${provider} returned an unexpectedly large response.`);
  return raw;
}

async function providerPost(fetchImpl, url, { headers, body, timeoutMs = 120_000, provider, retryAmbiguous = true, onHeaders = null }) {
  if (typeof fetchImpl !== "function") fail(503, `${provider}_unavailable`, `${provider} is unavailable on this server.`);
  if (!url) fail(503, `${provider}_not_configured`, `${provider} is not configured.`);
  let lastNetworkError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response; let raw = "";
    try {
      response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
      if (typeof onHeaders === "function") await onHeaders(response);
      raw = await readProviderBody(response, MAX_PROVIDER_BYTES, provider);
    }
    catch (error) {
      if (error instanceof VideoHttpError) throw error;
      lastNetworkError = error;
      if (error?.name === "AbortError") fail(504, `${provider}_timeout`, `${provider} did not respond before the request deadline.`);
      if (retryAmbiguous && attempt < 2) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 400 * (2 ** attempt))); continue; }
      fail(502, `${provider}_network_error`, `${provider} could not be reached${retryAmbiguous ? " after automatic retries" : ""}. No fallback model was used.`);
    } finally { clearTimeout(timer); }
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { fail(502, `${provider}_invalid_response`, `${provider} returned invalid JSON.`); }
    if (response.ok) return data;
    if (retryAmbiguous && (response.status === 429 || response.status === 408 || response.status >= 500) && attempt < 2) {
      const retryAfter = Math.min(5_000, Math.max(0, Number(response.headers?.get?.("retry-after") || 0) * 1000));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryAfter || 400 * (2 ** attempt)));
      continue;
    }
    const error = new VideoHttpError(response.status === 408 ? 504 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, `${provider}_http_${response.status}`, providerMessage(data) || `${provider} rejected the request.`);
    error.upstreamStatus = Number(response.status);
    error.providerErrorCode = cleanText(data?.error?.code, 160) || null;
    error.providerErrorType = cleanText(data?.error?.metadata?.error_type || data?.error?.metadata?.type, 160) || null;
    error.providerBodyGenerationId = cleanText(data?.id || data?.generation_id, 200) || null;
    error.providerHeaderGenerationId = cleanText(response.headers?.get?.("x-generation-id"), 200) || null;
    error.providerGenerationId = error.providerBodyGenerationId || error.providerHeaderGenerationId;
    if (data?.usage && typeof data.usage === "object") error.providerUsage = clone(data.usage);
    const routerAttempt = data?.openrouter_metadata?.attempt;
    if (Number.isInteger(routerAttempt) && routerAttempt >= 0) error.providerRouterAttempt = routerAttempt;
    throw error;
  }
  fail(502, `${provider}_network_error`, `${provider} could not be reached. ${String(lastNetworkError?.message || "")}`.trim());
}

async function providerGetJson(fetchImpl, url, { headers, timeoutMs = 30_000, provider }) {
  if (typeof fetchImpl !== "function") fail(503, `${provider}_unavailable`, `${provider} is unavailable on this server.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response; let raw = "";
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal: controller.signal });
    raw = await readProviderBody(response, MAX_PROVIDER_BYTES, provider);
  } catch (error) {
    if (error instanceof VideoHttpError) throw error;
    if (error?.name === "AbortError") fail(504, `${provider}_timeout`, `${provider} did not respond before the reconciliation deadline.`);
    fail(502, `${provider}_network_error`, `${provider} could not be reached for reconciliation.`);
  } finally { clearTimeout(timer); }
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { fail(502, `${provider}_invalid_response`, `${provider} returned invalid reconciliation JSON.`); }
  if (!response.ok) fail(response.status === 404 ? 409 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, `${provider}_http_${response.status}`, providerMessage(data) || `${provider} could not reconcile that generation yet.`);
  return data;
}

function openAiText(data, provider) {
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text || "").join("") : String(content || "");
  if (!text.trim()) {
    // A reasoning model (e.g. deepseek-v4-pro) writes its scratchpad to message.reasoning_content
    // BEFORE message.content; a starved max_tokens can burn the whole budget there and leave
    // .content empty with finish_reason "length". That reasoning text is never the answer and is
    // never substituted here - this is diagnostic only, so the next person to see this in the fault
    // log knows to raise max_tokens rather than suspect the extraction logic (stabilize 2026-09-03).
    const reasoning = String(data?.choices?.[0]?.message?.reasoning_content || "");
    const hint = reasoning.trim() ? ` (the model spent its entire token budget on reasoning_content and never reached content; raise max_tokens)` : "";
    fail(502, `${provider}_empty_response`, `${provider} returned no usable text.${hint}`);
  }
  return text.trim();
}

function anthropicText(data) {
  const text = Array.isArray(data?.content) ? data.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("") : "";
  if (!text.trim()) fail(502, "anthropic_empty_response", "Anthropic returned no usable liaison response.");
  return text.trim();
}

function mimeFor(file) {
  return ({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" })[extname(file).toLowerCase()] || "application/octet-stream";
}

function contained(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return !rel || (rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../"));
}

export function createVideoHttp({
  feature,
  media = {},
  resolveTenant,
  billing = {},
  meter = null,
  settlementAdmin = null,
  screenContent,
  fetch: fetchImpl = globalThis.fetch,
  runware = {},
  openrouter = {},
  nvidia = {},
  anthropic = {},
  deepseek = {},
  privacy = {},
  desktopPresence = null,
  now = Date.now,
  bootProbe = false,
} = {}) {
  if (!feature || typeof feature !== "object") throw new TypeError("feature is required");
  if (typeof resolveTenant !== "function") throw new TypeError("resolveTenant is required");
  if (typeof screenContent !== "function") throw new TypeError("screenContent is required");

  const localPresence = new Map();
  const settledJobs = new Set();
  const rateBuckets = new Map();
  const desktopCapabilities = new Map();
  const activeScreenwriterProjects = new Set();
  const activeScreenwriterTurns = new Set();
  const activeAiProjects = new Set();
  const activeAiTurns = new Set();
  const rungHealth = new Map(); // rungKey -> {healthy, lastError, lastProbedAt}; demotion from the boot probe (required behavior #6).
  let screenwriterActivityVersion = 0;
  let screenwriterDraining = false;
  const presenceTtlMs = Math.max(15_000, Number(desktopPresence?.ttlMs) || 90_000);

  const screenwriterKey = (tenantId, projectId) => `${tenantId}:${projectId}`;
  const pendingScreenwriterAttempt = (project) => [...(project?.providerAttempts || [])].reverse().find(screenwriterAttemptBlocksMutation) || null;
  function requireProjectScreenwriterIdle(tenantId, projectId) {
    if (activeScreenwriterProjects.has(screenwriterKey(tenantId, projectId))) fail(409, "screenwriter_busy", "Trinity is already writing for this project. Wait for that saved turn before changing or starting another screenplay state.");
  }
  function trackScreenwriterTurn(promise) {
    const tracked = Promise.resolve(promise);
    activeScreenwriterTurns.add(tracked);
    tracked.then(() => activeScreenwriterTurns.delete(tracked), () => activeScreenwriterTurns.delete(tracked));
    return tracked;
  }
  function trackAiTurn(promise) {
    const tracked = Promise.resolve(promise);
    activeAiTurns.add(tracked);
    tracked.then(() => activeAiTurns.delete(tracked), () => activeAiTurns.delete(tracked));
    return tracked;
  }
  async function drain({ timeoutMs = 90_000 } = {}) {
    screenwriterDraining = true;
    const pending = [...activeScreenwriterTurns, ...activeAiTurns];
    if (!pending.length) return { pending: 0, completed: 0, timedOut: false };
    let timer = null; let timedOut = false;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolvePromise) => { timer = setTimeout(() => { timedOut = true; resolvePromise(); }, Math.max(1_000, Number(timeoutMs) || 90_000)); }),
    ]);
    if (timer) clearTimeout(timer);
    return { pending: pending.length, completed: pending.length - activeScreenwriterTurns.size - activeAiTurns.size, timedOut };
  }
  /*
   * THE STUDIO RUNS ITS OWN CREW (Fred, 2026-08-05). The studio's four transports are FIXED
   * castings - Runware renders, NVIDIA directs and orchestrates, OpenRouter writes, Anthropic
   * liaises - and none of the first three sit on the global Trusted list, so Trusted mode used to
   * kill the entire studio: every generation AND every producer conversation 403'd, which read as
   * "the API isn't live". Fred's ruling: inside the Video Studio only, the fixed crew is
   * permitted in Trusted mode, and the studio header names the crew so the privacy story is
   * stated on the surface where it applies. The global TRUSTED_PROVIDERS list is deliberately
   * untouched - chat's promise ("Trusted · OpenAI/Anthropic direct") keeps its exact meaning.
   * Private mode still refuses the studio outright: one provider, no exceptions, refuse rather
   * than substitute.
   */
  const STUDIO_CREW_PROVIDERS = new Set(["runware", "nvidia", "openrouter", "anthropic", "deepseek"]);
  function requireProviderPrivacy(body, { provider, model }) {
    const requested = String(body?.privacyMode || "normal").trim().toLowerCase();
    const mode = new Set(["normal", "trusted", "private"]).has(requested) ? requested : "normal";
    if (mode === "trusted" && STUDIO_CREW_PROVIDERS.has(provider)) return mode;
    const providerGate = typeof privacy.providerAllowed === "function"
      ? { allowed: privacy.providerAllowed(mode, provider) }
      : { allowed: mode === "normal" || provider === "anthropic" };
    const modelGate = model && typeof privacy.modeAllows === "function" ? privacy.modeAllows(mode, model) : { allowed: true };
    const gate = providerGate.allowed === true && modelGate?.allowed === true
      ? { allowed: true }
      : { allowed: false, reason: providerGate.allowed !== true ? `${mode[0].toUpperCase() + mode.slice(1)} privacy mode does not allow the ${provider} transport.` : modelGate?.reason };
    if (gate?.allowed !== true) fail(403, "privacy_mode_block", cleanText(gate?.reason, 800) || `${mode[0].toUpperCase() + mode.slice(1)} privacy mode does not allow ${provider}. The provider was refused, not substituted.`);
    return mode;
  }

  function remainingAiTimeout(deadlineAt, configuredTimeout) {
    const remaining = Math.floor(Number(deadlineAt) - Number(now()));
    if (!Number.isFinite(remaining) || remaining <= 0) fail(504, "video_ai_turn_timeout", "The video AI turn reached its aggregate deadline before another provider request could start. Completed provider work was not silently retried.");
    return Math.max(1_000, Math.min(remaining, Math.max(1_000, Number(configuredTimeout) || 180_000)));
  }

  // The four provider configs a ladder rung can settle against, keyed the same way servedBy.provider names them.
  const PROVIDER_CONFIG_BY_NAME = { nvidia, deepseek, anthropic, openrouter };

  /*
   * ONE SMALL LADDER HELPER (LANE-video required behavior #2, deficiency 20). Every studio agent
   * below builds an ordered list of rungs - each a {provider, model, call} thunk - fresh per turn
   * from live config. runAgentLadder tries each rung in order and returns the first one that
   * answers with usable content. A rung's failure only stops the WHOLE ladder if it is not "the
   * provider's fault" (see isLadderSkippable) or if every rung has now failed - Fred's rule that
   * nothing may end in a silent or announced error while an alternative remains untried. The
   * served rung rides back as ordinary metadata (servedBy), never as a degraded/error state.
   */
  function isLadderSkippable(error) {
    if (!(error instanceof VideoHttpError)) return false;
    const status = Number(error.status);
    return Number.isInteger(status) && status >= 400 && status < 600;
  }
  function rungKey(agent, provider, model) { return `${agent}:${provider}:${model}`; }
  function rungDemoted(agent, provider, model) {
    const record = rungHealth.get(rungKey(agent, provider, model));
    return !!record && record.healthy === false;
  }
  function recordRungHealth(agent, provider, model, healthy, error) {
    rungHealth.set(rungKey(agent, provider, model), { healthy, lastError: healthy ? null : cleanText(error?.code || error?.message, 200) || null, lastProbedAt: Number(now()) });
  }
  async function runAgentLadder(agentName, rungs) {
    const usable = rungs.filter((rung) => !rungDemoted(agentName, rung.provider, rung.model));
    // A rung demoted by the hourly boot probe is skipped first, but demotion never fully blocks a
    // turn: if every rung is currently demoted, try them all anyway rather than refuse outright.
    const ordered = usable.length ? usable : rungs;
    let lastError = null;
    for (const rung of ordered) {
      try {
        const outcome = await rung.call();
        recordRungHealth(agentName, rung.provider, rung.model, true);
        return { ...outcome, servedBy: { agent: agentName, model: rung.model, provider: rung.provider } };
      } catch (error) {
        if (!isLadderSkippable(error)) throw error;
        recordRungHealth(agentName, rung.provider, rung.model, false, error);
        lastError = error;
      }
    }
    throw lastError || new VideoHttpError(503, `${agentName}_ladder_exhausted`, `No configured model answered for ${agentName}. Nothing was silently substituted or marked complete.`);
  }
  // Shared OpenAI-chat-completions-shaped transport: NVIDIA and DeepSeek-direct both speak this dialect.
  async function callOpenAiStyleTransport({ provider, apiKey, url, model, messages, maxTokens, temperature, topP, deadlineAt, timeoutMs, extraBody = {} }) {
    if (!apiKey) fail(503, `${provider}_not_configured`, `${provider} is not configured. No substitute model was used for this rung.`);
    const body = await providerPost(fetchImpl, url, {
      provider,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: deadlineAt != null ? remainingAiTimeout(deadlineAt, timeoutMs) : Math.max(1_000, Number(timeoutMs) || 120_000),
      retryAmbiguous: false,
      body: { model, stream: false, messages, temperature, top_p: topP, max_tokens: maxTokens, ...extraBody },
    });
    return { text: openAiText(body, provider), usage: body.usage || null };
  }
  // Shared Anthropic Messages API transport: used for both the liaison and the director's last-resort rung.
  async function callAnthropicTransport({ apiKey, url, model, system, messages, maxTokens, deadlineAt, timeoutMs, version }) {
    if (!apiKey) fail(503, "anthropic_not_configured", "Claude is not configured. No substitute model was used for this rung.");
    const body = await providerPost(fetchImpl, url, {
      provider: "anthropic",
      headers: { "x-api-key": apiKey, "anthropic-version": version || "2023-06-01" },
      timeoutMs: deadlineAt != null ? remainingAiTimeout(deadlineAt, timeoutMs) : Math.max(1_000, Number(timeoutMs) || 120_000),
      retryAmbiguous: false,
      body: { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages },
    });
    return { text: anthropicText(body), usage: body.usage || null };
  }

  function issueDesktopCapability(tenantId) {
    const token = `${randomUUID()}${randomUUID().replaceAll("-", "")}`;
    const expiresAt = Number(now()) + Math.max(10 * 60 * 1000, presenceTtlMs * 4);
    desktopCapabilities.set(token, { tenantId, expiresAt });
    if (desktopCapabilities.size > 2_000) {
      for (const [candidate, record] of desktopCapabilities) if (record.expiresAt <= Number(now())) desktopCapabilities.delete(candidate);
    }
    return token;
  }

  function validDesktopCapability(req, context, body = {}) {
    const token = cleanText(body.desktopCapability || requestHeader(req, "x-dominion-desktop-capability"), 200);
    const record = desktopCapabilities.get(token);
    if (!record || record.tenantId !== context.tenantId || record.expiresAt <= Number(now())) {
      if (record) desktopCapabilities.delete(token);
      return false;
    }
    record.expiresAt = Number(now()) + Math.max(10 * 60 * 1000, presenceTtlMs * 4);
    return true;
  }

  function enforceRateLimit(tenantId, method, pathname) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const path = pathname.slice(API_ROOT.length) || "/";
    let scope = "write", limit = 120, windowMs = 60_000;
    if (path === "/jobs") { scope = "generation"; limit = 30; }
    else if (path === "/projects") { scope = "project_create"; limit = 10; }
    else if (path === "/uploads") { scope = "upload"; limit = 30; windowMs = 60 * 60 * 1000; }
    else if (path === "/chat" || path === "/screenwrite") { scope = "ai"; limit = 20; }
    const key = `${tenantId}:${scope}`; const currentTime = Number(now());
    let bucket = rateBuckets.get(key);
    if (!bucket || currentTime - bucket.startedAt >= windowMs) bucket = { startedAt: currentTime, count: 0 };
    bucket.count += 1; rateBuckets.set(key, bucket);
    if (bucket.count > limit) fail(429, "video_rate_limited", `Too many ${scope.replaceAll("_", " ")} requests. Wait before trying again; the rejected request did not start work.`);
    if (rateBuckets.size > 10_000) {
      for (const [candidate, value] of rateBuckets) if (currentTime - value.startedAt > 60 * 60 * 1000) rateBuckets.delete(candidate);
    }
  }

  async function tenantFor(req) {
    const tenant = await resolveTenant(req);
    if (!tenant || tenant.role === "anon" || (!tenant.email && !tenant.tenantId && !tenant.id)) fail(401, "no_identity", "Sign in to use Dominion Video.");
    if (tenant.status === "paused" || tenant.status === "locked") fail(403, `account_${tenant.status}`, `Account ${tenant.status}.`);
    if (!tenant.isOwner && !tenant.invited) fail(403, "needs_invite", "Redeem an access code before using Dominion Video.");
    return { tenant, tenantId: tenantIdFor(tenant) };
  }

  async function presence(action, context) {
    if (typeof desktopPresence === "function") return desktopPresence({ action, ...context });
    const method = action === "touch" ? desktopPresence?.touch : desktopPresence?.hasDesktop;
    if (typeof method === "function") return method.call(desktopPresence, context);
    const key = context.tenantId;
    if (action === "touch") { localPresence.set(key, Number(now())); return { desktopSession: true }; }
    const seen = localPresence.get(key) || 0;
    return { desktopSession: Number(now()) - seen <= presenceTtlMs };
  }

  async function desktopState(req, context, body = {}) {
    const mobile = isMobileRequest(req, body);
    if (!mobile) {
      const capable = validDesktopCapability(req, context, body);
      if (capable) await presence("touch", { ...context, req, device: "desktop", sessionId: cleanText(body.sessionId, 128) });
      return { mobile: false, desktopSession: capable };
    }
    const result = await presence("hasDesktop", { ...context, req, device: "mobile", sessionId: cleanText(body.sessionId, 128) });
    const desktopSession = typeof result === "boolean" ? result : !!result?.desktopSession;
    return { mobile: true, desktopSession };
  }

  async function requireDesktop(req, context, body = {}) {
    const device = await desktopState(req, context, body);
    if (!device.desktopSession) fail(409, device.mobile ? "desktop_session_required" : "desktop_capability_required", device.mobile ? "Open Dominion on your desktop to create or edit a persistent video project. Mobile-only mode supports one generated video at a time." : "Refresh Dominion Video on this desktop before changing a persistent project.");
    return device;
  }

  async function generationBilling(tenant) {
    if (tenant.isOwner) return { owner: true };
    if (typeof billing.account !== "function" || typeof billing.canChat !== "function") fail(503, "video_billing_unavailable", "Video billing is not configured.");
    const account = await billing.account(tenant.email);
    if (!account?.autorecharge) fail(402, "video_autorecharge_required", "Enable auto top-up before generating video.");
    if (!account?.hasCard) fail(402, "video_payment_method_required", "Add a payment method before generating video.");
    if (!(await billing.canChat(tenant.email)) || !(Number(account.balance) > 0)) fail(402, "needs_credits", "Video generation needs credits. Add credits in Setup first.");
    return account;
  }

  async function modelBilling(tenant) {
    if (tenant.isOwner || tenant.role === "sponsored") return { allowed: true };
    if (typeof billing.canChat !== "function" || !(await billing.canChat(tenant.email))) fail(402, "needs_credits", "The video AI team needs credits. Add credits in Setup first.");
    return { allowed: true };
  }

  async function getProject(tenantId, projectId) {
    const id = ensureProjectId(projectId);
    const state = typeof feature.getClientProject === "function" ? await feature.getClientProject(tenantId, id) : await feature.getProject(tenantId, id);
    return projectForClient(state);
  }

  async function findJob(tenantId, jobId, hintedProjectId) {
    const id = ensureJobId(jobId);
    if (hintedProjectId) {
      const projectId = ensureProjectId(hintedProjectId);
      const project = await feature.getProject(tenantId, projectId);
      if ((project.jobs || []).some((job) => job.id === id)) return { projectId, project };
      fail(404, "video_job_missing", "Video job not found.");
    }
    for (const summary of await feature.listProjects(tenantId)) {
      const project = await feature.getProject(tenantId, summary.id);
      if ((project.jobs || []).some((job) => job.id === id)) return { projectId: summary.id, project };
    }
    fail(404, "video_job_missing", "Video job not found.");
  }

  async function meterUsage(tenant, costUsd, metadata) {
    if (tenant.isOwner || !(Number(costUsd) > 0) || typeof meter !== "function") return { skipped: true };
    return meter(tenant, Number(costUsd), metadata);
  }

  async function maybeMeterProvider(tenant, providerConfig, usage, metadata) {
    if (tenant.isOwner || typeof meter !== "function" || typeof providerConfig?.costForUsage !== "function") return { skipped: true, costUsd: Number(usage?.cost) || 0 };
    const cost = await providerConfig.costForUsage(clone(usage || {}), metadata);
    if (!(Number(cost) > 0)) return { skipped: true, costUsd: Number(cost) || 0 };
    const generationId = cleanText(metadata?.generationId, 200);
    const billingId = generationId
      ? `provider_${createHash("sha256").update(`${metadata?.provider || "provider"}:${metadata?.model || "model"}:${generationId}`).digest("hex")}`
      : randomUUID();
    const settlement = await meterUsage(tenant, Number(cost), { ...metadata, billingId });
    return settlement || { settled: true, costUsd: Number(cost) };
  }

  function attemptSettlement(settlement, usage, fallbackStatus = "settled") {
    const skipped = settlement?.skipped === true;
    return {
      status: skipped ? "skipped" : fallbackStatus,
      key: cleanText(settlement?.settlementKey, 300) || null,
      costUsd: Math.max(0, Number(settlement?.costUsd ?? usage?.cost) || 0),
      errorCode: null,
    };
  }

  function recoverableCandidate(result) {
    return {
      text: result.text,
      section: result.section,
      brief: result.brief,
      generatedSections: result.generatedSections,
      lastTurn: clone(result.lastTurn),
      sessionId: result.sessionId,
      finishReason: result.finishReason,
      truncated: result.truncated === true,
    };
  }

  function storedScreenwriterUsage(attempt) {
    const usage = attempt?.usage && typeof attempt.usage === "object" ? attempt.usage : {};
    const cost = Math.max(0, Number(usage.costUsd ?? usage.cost ?? attempt?.settlement?.costUsd) || 0);
    return {
      prompt_tokens: Math.max(0, Number(usage.promptTokens ?? usage.prompt_tokens) || 0),
      completion_tokens: Math.max(0, Number(usage.completionTokens ?? usage.completion_tokens) || 0),
      total_tokens: Math.max(0, Number(usage.totalTokens ?? usage.total_tokens) || 0),
      cost,
      completion_tokens_details: { reasoning_tokens: Math.max(0, Number(usage.reasoningTokens ?? usage.completion_tokens_details?.reasoning_tokens) || 0) },
    };
  }

  function persistedAttemptSettlement(attempt, usage) {
    const status = cleanText(attempt?.settlement?.status, 80);
    if (!new Set(["settled", "skipped"]).has(status)) return null;
    return {
      status,
      key: cleanText(attempt?.settlement?.key, 300) || null,
      costUsd: Math.max(0, Number(attempt?.settlement?.costUsd ?? usage?.cost) || 0),
      errorCode: null,
    };
  }

  function recoveryActionForAttempt(attempt) {
    if (!attempt) return null;
    if (new Set(["screenwriter_generation_id_mismatch", "screenwriter_generation_conflict"]).has(String(attempt.rejectionCode || ""))) return "quarantine_unrecoverable";
    if (String(attempt.status || "") === "settlement_failed" && String(attempt?.settlement?.errorCode || "").toUpperCase() === "VIDEO_SETTLEMENT_REPAIR_REQUIRED") return "retry_settlement";
    if (attempt.generationId && new Set(["provider_accepted", "provider_rejected", "settlement_failed", "recoverable_stale_unbilled", "recoverable_stale_settled"]).has(String(attempt.status || ""))) return "retry_settlement";
    const firstSeen = Date.parse(String(attempt.createdAt || attempt.updatedAt || ""));
    if (attempt.generationId && Number(attempt.reconciliationFailures || 0) >= 3 && durableGenerationVerificationFailure(attempt.lastReconciliationError) && (!Number.isFinite(firstSeen) || Number(now()) - firstSeen >= 10 * 60 * 1000)) return "quarantine_unrecoverable";
    if (attempt.generationId) return "check_generation";
    return "quarantine_unrecoverable";
  }

  const quarantineConfirmation = (attemptId) => `QUARANTINE ${String(attemptId || "")} WITHOUT_DOMINION_BILLING`;
  const durableGenerationVerificationFailure = (code) => new Set([
    "openrouter_generation_http_404",
    "screenwriter_reconciliation_id_mismatch",
    "screenwriter_reconciliation_model_mismatch",
    "screenwriter_reconciliation_type_mismatch",
  ]).has(String(code || ""));

  async function openRouterGenerationRecord(generationId) {
    const apiKey = credential(openrouter.apiKey);
    if (!apiKey) fail(503, "screenwriter_not_configured", "Trinity Large Thinking is not configured through OpenRouter. No substitute model was used.");
    const generationUrl = cleanText(openrouter.generationUrl, 2_000) || endpoint(openrouter.baseUrl || "https://openrouter.ai/api/v1", "/generation");
    let url;
    try { url = new URL(generationUrl); } catch { fail(503, "openrouter_generation_not_configured", "OpenRouter generation reconciliation is not configured correctly."); }
    url.searchParams.set("id", generationId);
    const body = await providerGetJson(fetchImpl, url.toString(), {
      provider: "openrouter_generation",
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: Number(openrouter.reconciliationTimeoutMs) || 30_000,
    });
    const data = body?.data && typeof body.data === "object" ? body.data : body;
    if (cleanText(data?.id, 200) !== generationId) fail(502, "screenwriter_reconciliation_id_mismatch", "OpenRouter did not confirm the saved Trinity generation identity. The project remains locked for reconciliation.");
    if (cleanText(data?.model, 200) !== SCREENWRITER_MODEL) fail(502, "screenwriter_reconciliation_model_mismatch", "OpenRouter did not confirm the Trinity model for this saved generation. The project remains locked for reconciliation.");
    if (cleanText(data?.api_type, 80) !== "completions") fail(502, "screenwriter_reconciliation_type_mismatch", "OpenRouter did not confirm a chat-completions generation record. The project remains locked for reconciliation.");
    const finishReason = cleanText(data?.finish_reason, 80) || (data?.cancelled === true ? "cancelled" : null);
    if (!finishReason) fail(409, "screenwriter_reconciliation_pending", "OpenRouter has not marked this Trinity generation terminal yet. Retry reconciliation shortly; no second request was started.");
    const hasTotalCost = data?.total_cost !== null && data?.total_cost !== undefined && String(data.total_cost).trim() !== "";
    const totalCost = hasTotalCost ? Number(data.total_cost) : NaN;
    if (!Number.isFinite(totalCost) || totalCost < 0) fail(409, "screenwriter_reconciliation_pending", "OpenRouter has not published authoritative cost metadata for this Trinity generation yet. Retry reconciliation shortly.");
    const promptTokens = Math.max(0, Number(data?.tokens_prompt) || 0);
    const completionTokens = Math.max(0, Number(data?.tokens_completion) || 0);
    return {
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        cost: +totalCost.toFixed(8),
        completion_tokens_details: { reasoning_tokens: Math.max(0, Number(data?.native_tokens_reasoning) || 0) },
      },
      finishReason,
    };
  }

  /*
   * Shared, provider-independent screenplay turn construction (LANE-video required behavior #2:
   * "preserving the 115k-token contract"). Every screenwriter rung - Trinity or a fallback -
   * writes from the exact same messages and is bound by the exact same immutable 115,000-token
   * ceiling regardless of which model ends up serving it; the ceiling is not a per-model context
   * window, it is Dominion's own promise to the project, so it is enforced once here rather than
   * per rung.
   */
  function buildScreenwriterTurn(project, prompt) {
    const writerState = project?.ai?.screenwriter?.state && typeof project.ai.screenwriter.state === "object" ? project.ai.screenwriter.state : {};
    const generatedSections = Math.max(0, Number(writerState.generatedSections) || 0);
    const brief = generatedSections > 0 ? String(writerState.brief || "").slice(0, MAX_SCREENPLAY_CHARS) : prompt;
    const prior = writerState.lastTurn && typeof writerState.lastTurn === "object" ? clone(writerState.lastTurn) : null;
    if (prior && Buffer.byteLength(JSON.stringify(prior), "utf8") > 1_500_000) fail(409, "screenwriter_resume_state_large", "The saved Trinity continuation state is too large to replay safely. Restore an earlier checkpoint; no reasoning or screenplay text was compacted.");
    const userContent = generatedSections > 0
      ? `Project: ${cleanText(project?.project?.name || project?.name, 300)}\n\nOriginal story brief:\n${brief}\n\nCurrent screenplay (authoritative, including any user edits):\n${prompt}\n\nWrite only the next new screenplay section. Continue directly from the current ending, preserve continuity, and do not repeat or rewrite the existing screenplay.`
      : `Project: ${cleanText(project?.project?.name || project?.name, 300)}\n\nStory brief:\n${prompt}\n\nWrite only the opening screenplay section. Do not repeat the brief. Return screenplay text only.`;
    const systemContent = "You are Dominion's principal screenwriter. Think carefully, then write vivid, production-ready screenplay prose with scene headings, action, dialogue, continuity, visual direction, and sound cues. Preserve the user's intent. Each response is one new screenplay section that Dominion saves atomically. Never repeat the existing screenplay, expose private reasoning, or claim a scene was generated or filmed.";
    const messages = [{ role: "system", content: systemContent }];
    if (prior?.userContent && prior?.content) {
      const assistant = { role: "assistant", content: String(prior.content) };
      if (Array.isArray(prior.reasoningDetails)) assistant.reasoning_details = clone(prior.reasoningDetails);
      else if (typeof prior.reasoning === "string" && prior.reasoning) assistant.reasoning = prior.reasoning;
      messages.push({ role: "user", content: String(prior.userContent) }, assistant);
    }
    messages.push({ role: "user", content: userContent });
    const estimatedInput = requestTokenEstimate(messages);
    const remainingOutput = SCREENWRITER_CONTEXT_TOKENS - CONTEXT_SAFETY_TOKENS - estimatedInput;
    if (remainingOutput < SCREENWRITER_MIN_OUTPUT_TOKENS) {
      fail(413, "video_screenplay_context_limit", `The screenwriter request needs about ${estimatedInput.toLocaleString()} input tokens, leaving too little room inside the immutable 115,000-token total limit. Shorten the screenplay or restore an earlier checkpoint; no content was compacted or silently dropped.`);
    }
    const maxTokens = Math.min(SCREENWRITER_MAX_OUTPUT_TOKENS, Math.floor(remainingOutput));
    enforceContextWindow("video_screenplay_context_limit", "The screenwriter request", messages, SCREENWRITER_CONTEXT_TOKENS, maxTokens);
    return { messages, systemContent, userContent, brief, generatedSections, maxTokens };
  }

  // OpenAI-style usage (deepseek) uses prompt_tokens/completion_tokens; Anthropic uses input_tokens/output_tokens.
  // Reshape either into the one ledger shape screenplay.set and the provider attempt record already expect.
  function normalizeScreenwriterUsage(rawUsage, shape, costForUsage) {
    const usage = rawUsage || {};
    const promptTokens = shape === "anthropic" ? Math.max(0, Number(usage.input_tokens) || 0) : Math.max(0, Number(usage.prompt_tokens) || 0);
    const completionTokens = shape === "anthropic" ? Math.max(0, Number(usage.output_tokens) || 0) : Math.max(0, Number(usage.completion_tokens) || 0);
    const reasoningTokens = shape === "anthropic" ? 0 : Math.max(0, Number(usage.completion_tokens_details?.reasoning_tokens) || 0);
    const cost = Math.max(0, Number(typeof costForUsage === "function" ? costForUsage(clone(usage)) : 0) || 0);
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost, completion_tokens_details: { reasoning_tokens: reasoningTokens } };
  }

  // A rung failure with no HTTP status we can read as 4xx is still definitively unbilled when it
  // never left this process (missing credential): no request was ever sent.
  function rungDefinitivelyUnbilled(error) {
    return definitiveProviderHttpRejection(error) || /_not_configured$/.test(String(error?.code || ""));
  }

  /*
   * SCREENWRITER FALLBACK RUNGS (LANE-video required behavior #2, "preserving... the
   * saved-checkpoint semantics"). Trinity (OpenRouter) keeps its full async generation-id
   * reconciliation ledger untouched - that machinery exists because OpenRouter can accept and bill
   * a request before the final response ever arrives, so an ambiguous Trinity failure MUST stay in
   * the existing reconciliation-required path rather than risk a second paid call on top of an
   * unresolved first one. DeepSeek-direct and Claude-direct are ordinary synchronous request/response
   * calls: either the fetch returns a complete, priced result, or nothing was ever billed. Each
   * fallback rung still gets its own durable "provider_submitting" placeholder for crash safety.
   */
  async function screenwriterFallbackRungs(tenant, project, prompt, turn, { tenantId, projectId, expectedScreenplaySha256, expectedScreenwriterGenerationId }) {
    const deepseekUrl = endpoint(deepseek.baseUrl || "https://api.deepseek.com", "/chat/completions");
    const anthropicUrl = endpoint(anthropic.baseUrl || "https://api.anthropic.com", "/v1/messages");
    const anthropicMessages = turn.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: String(m.content || "") }));
    const rungs = [
      { provider: "deepseek", model: DEEPSEEK_PRO_MODEL, shape: "openai", costForUsage: deepseek.costForUsage, call: () => callOpenAiStyleTransport({ provider: "deepseek_screenwriter", apiKey: credential(deepseek.apiKey), url: deepseekUrl, model: DEEPSEEK_PRO_MODEL, messages: turn.messages, maxTokens: reasoningSafeMaxTokens(DEEPSEEK_PRO_MODEL, turn.maxTokens), temperature: 0.3, topP: 0.8, timeoutMs: deepseek.timeoutMs }) },
      { provider: "anthropic", model: SONNET_MODEL, shape: "anthropic", costForUsage: anthropic.costForUsage, call: () => callAnthropicTransport({ apiKey: credential(anthropic.apiKey), url: anthropicUrl, model: SONNET_MODEL, system: turn.systemContent, messages: anthropicMessages, maxTokens: turn.maxTokens, timeoutMs: anthropic.timeoutMs, version: anthropic.version }) },
    ];
    let lastError = null;
    for (const rung of rungs) {
      let submissionAttempt = null;
      try {
        const candidate = { attemptId: `sw_local_${randomUUID().replaceAll("-", "")}`, generationId: null, status: "provider_submitting", rejectionCode: null, finishReason: null, sourceScreenplaySha256: expectedScreenplaySha256, sourceGenerationId: expectedScreenwriterGenerationId, settlement: { status: "awaiting_response", costUsd: 0 } };
        try { await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", begin: true, attempt: candidate }); submissionAttempt = candidate; }
        catch (submitError) {
          const persistenceError = new VideoHttpError(503, "screenwriter_attempt_persist_failed", "Dominion could not durably record the fallback screenplay request before provider egress, so it was not called.");
          persistenceError.cause = submitError; throw persistenceError;
        }
        const { text: rawText, usage: rawUsage } = await rung.call();
        const text = String(rawText || "").trim();
        if (!text) fail(502, `${rung.provider}_screenwriter_empty_response`, `${rung.provider} returned no usable screenplay text.`);
        const usage = normalizeScreenwriterUsage(rawUsage, rung.shape, rung.costForUsage);
        const generationId = `local_${randomUUID().replaceAll("-", "")}`;
        const lastTurn = { userContent: turn.userContent, content: text };
        const updatedText = turn.generatedSections > 0 ? `${prompt}\n\n${text.trimStart()}` : text;
        const attempt = { attemptId: submissionAttempt.attemptId, generationId, status: "provider_accepted", rejectionCode: null, finishReason: "stop", usage, billable: true, settlement: { status: "pending", costUsd: usage.cost } };
        await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...submissionAttempt, generationId, status: "provider_correlated", settlement: { status: "not_billed", costUsd: 0 } } });
        return {
          text: updatedText, section: text, brief: turn.brief, generatedSections: turn.generatedSections + 1, lastTurn,
          usage, model: rung.model, sessionId: null, attempt, generationId, finishReason: "stop", truncated: false,
          servedBy: { agent: "screenwriter", provider: rung.provider, model: rung.model },
        };
      } catch (rungError) {
        if (submissionAttempt) {
          const rejected = rungDefinitivelyUnbilled(rungError);
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...submissionAttempt, status: rejected ? "provider_http_rejected" : "reconciliation_required", rejectionCode: cleanText(rungError?.code || "screenwriter_fallback_rejected", 120), settlement: { status: rejected ? "not_billed" : "awaiting_response", costUsd: 0 } } });
        }
        if (!isLadderSkippable(rungError)) throw rungError;
        lastError = rungError;
      }
    }
    throw lastError || new VideoHttpError(503, "screenwriter_ladder_exhausted", "No configured screenwriter model answered. Nothing was silently substituted or marked complete.");
  }

  async function callScreenwriterTrinity(tenant, project, prompt, turn, { onSubmitting = null, onGeneration = null } = {}) {
    const apiKey = credential(openrouter.apiKey);
    if (!apiKey) fail(503, "screenwriter_not_configured", "Trinity Large Thinking is not configured through OpenRouter. No substitute model was used.");
    const { messages, userContent, brief, generatedSections, maxTokens } = turn;
    const providerUrl = cleanText(openrouter.url, 2_000) || endpoint(openrouter.baseUrl || "https://openrouter.ai/api/v1", "/chat/completions");
    const referer = cleanText(openrouter.referer, 2_000);
    const title = cleanText(openrouter.title || "Dominion AI", 200);
    const sessionId = stableProviderSessionId(`${tenantIdFor(tenant)}:${project?.id || project?.project?.id || "video"}`, { namespace: "dominion-video-writer" });
    const requestBody = shapeProviderExecutionRequest({
      model: SCREENWRITER_MODEL,
      stream: false,
      messages,
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: maxTokens,
    }, {
      provider: "openrouter",
      capabilities: { supported_parameters: ["reasoning"], reasoning: { mandatory: true } },
      policy: { taskKind: "complex", workKind: "complex", effort: { score: 3 } },
      sessionId,
      providerPreferences: { require_parameters: true, allow_fallbacks: true },
    });
    requestBody.reasoning = { ...(requestBody.reasoning || { enabled: true }), exclude: false };
    if (typeof onSubmitting === "function") {
      try { await onSubmitting(); }
      catch (error) {
        if (Number.isInteger(error?.status) && error?.code) throw error;
        const persistenceError = new VideoHttpError(503, "screenwriter_attempt_persist_failed", "Dominion could not durably record the screenplay request before provider egress, so OpenRouter was not called.");
        persistenceError.cause = error;
        throw persistenceError;
      }
    }
    let headerGenerationId = null;
    let body;
    try { body = await providerPost(fetchImpl, providerUrl, {
      provider: "openrouter_trinity",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(referer ? { "HTTP-Referer": referer } : {}),
        ...(title ? { "X-OpenRouter-Title": title } : {}),
        "X-OpenRouter-Metadata": "enabled",
      },
      timeoutMs: Number(openrouter.timeoutMs) || 300_000,
      body: requestBody,
      retryAmbiguous: false,
      onHeaders: async (response) => {
        const candidate = cleanText(response.headers?.get?.("x-generation-id"), 200);
        if (!candidate) return;
        headerGenerationId = candidate;
        if (typeof onGeneration === "function") {
          try { await onGeneration(candidate); }
          catch (error) {
            const persistenceError = new VideoHttpError(503, "screenwriter_attempt_persist_failed", "OpenRouter accepted the screenplay request, but Dominion could not durably record its generation identity. The request was stopped for operator reconciliation.");
            persistenceError.cause = error;
            persistenceError.providerGenerationId = candidate;
            throw persistenceError;
          }
        }
      },
    }); }
    catch (error) {
      const bodyGenerationId = cleanText(error?.providerGenerationId, 200);
      if (bodyGenerationId && headerGenerationId && bodyGenerationId !== headerGenerationId) {
        error.code = "screenwriter_generation_id_mismatch";
        error.screenwriterAttempt = {
          attemptId: `sw_${createHash("sha256").update(bodyGenerationId).digest("hex").slice(0, 48)}`,
          generationId: bodyGenerationId, status: "reconciliation_required", rejectionCode: "screenwriter_generation_id_mismatch",
          finishReason: null, usage: error?.providerUsage && typeof error.providerUsage === "object" ? clone(error.providerUsage) : {},
          billable: false, settlement: { status: "awaiting_response", costUsd: Math.max(0, Number(error?.providerUsage?.cost) || 0) },
        };
      }
      if (bodyGenerationId && !headerGenerationId) {
        headerGenerationId = bodyGenerationId;
        if (typeof onGeneration === "function") await onGeneration(bodyGenerationId);
      }
      throw error;
    }
    const responseModel = cleanText(body?.model, 200);
    const generationId = cleanText(body?.id, 200);
    if (generationId && !headerGenerationId && typeof onGeneration === "function") {
      try { await onGeneration(generationId); headerGenerationId = generationId; }
      catch (error) {
        const persistenceError = new VideoHttpError(503, "screenwriter_attempt_persist_failed", "OpenRouter completed the screenplay request, but Dominion could not durably record its generation identity. The result is held for operator reconciliation.");
        persistenceError.cause = error;
        persistenceError.providerGenerationId = generationId;
        throw persistenceError;
      }
    }
    const durableGenerationId = generationId || headerGenerationId;
    const attemptId = durableGenerationId ? `sw_${createHash("sha256").update(durableGenerationId).digest("hex").slice(0, 48)}` : `sw_${randomUUID().replaceAll("-", "")}`;
    if (!generationId) failWithScreenwriterAttempt(502, "screenwriter_generation_id_missing", "OpenRouter returned no generation identity in its response body. The screenplay was not changed or billed by Dominion; reconcile the provider response before retrying.", { attemptId, generationId: durableGenerationId || null, status: "reconciliation_required", rejectionCode: "screenwriter_generation_id_missing", finishReason: cleanText(body?.choices?.[0]?.finish_reason, 80) || null, billable: false, settlement: { status: "not_billed" } });
    if (headerGenerationId && headerGenerationId !== generationId) failWithScreenwriterAttempt(502, "screenwriter_generation_id_mismatch", "OpenRouter returned conflicting generation identities. The screenplay was not changed or billed by Dominion; reconcile the provider response before retrying.", { attemptId, generationId, status: "reconciliation_required", rejectionCode: "screenwriter_generation_id_mismatch", finishReason: cleanText(body?.choices?.[0]?.finish_reason, 80) || null, billable: false, settlement: { status: "not_billed" } });
    if (!body?.usage || typeof body.usage !== "object") failWithScreenwriterAttempt(502, "screenwriter_usage_missing", "OpenRouter returned no authoritative usage record. The screenplay was not changed or billed by Dominion; reconcile the provider generation before retrying.", { attemptId, generationId, status: "reconciliation_required", rejectionCode: "screenwriter_usage_missing", finishReason: cleanText(body?.choices?.[0]?.finish_reason, 80) || null, billable: false, settlement: { status: "not_billed" } });
    const usage = clone(body.usage);
    try { usage.cost = openRouterUsageCost(usage); }
    catch { failWithScreenwriterAttempt(502, "screenwriter_usage_missing", "OpenRouter returned no authoritative usage cost. The screenplay was not changed or billed by Dominion; reconcile the provider generation before retrying.", { attemptId, generationId, status: "reconciliation_required", rejectionCode: "screenwriter_usage_missing", finishReason: cleanText(body?.choices?.[0]?.finish_reason, 80) || null, billable: false, settlement: { status: "not_billed" } }); }
    if (responseModel !== SCREENWRITER_MODEL) failWithScreenwriterAttempt(502, "screenwriter_model_mismatch", `OpenRouter did not confirm ${SCREENWRITER_MODEL}; the response was rejected and no substitute output was saved.`, { attemptId, generationId, status: "provider_contract_rejected", rejectionCode: "screenwriter_model_mismatch", finishReason: cleanText(body?.choices?.[0]?.finish_reason, 80) || null, usage, billable: false, settlement: { status: "not_billed", costUsd: 0 } });
    const choice = body?.choices?.[0];
    const finishReason = cleanText(choice?.finish_reason, 80);
    const attempt = { attemptId, generationId, status: "provider_accepted", rejectionCode: null, finishReason: finishReason || null, usage, billable: true, settlement: { status: "pending", costUsd: usage.cost } };
    if (!new Set(["stop", "length"]).has(finishReason)) failWithScreenwriterAttempt(502, "screenwriter_incomplete_response", `Trinity ended with ${finishReason || "no finish reason"}. No screenplay text was saved; retry from the existing checkpoint.`, { ...attempt, status: "provider_rejected", rejectionCode: "screenwriter_incomplete_response" });
    let text;
    try { text = openAiText(body, "openrouter_trinity"); }
    catch (error) { error.screenwriterAttempt = { ...attempt, status: "provider_rejected", rejectionCode: error.code || "openrouter_trinity_empty_response" }; throw error; }
    const responseMessage = choice?.message && typeof choice.message === "object" ? choice.message : {};
    const lastTurn = { userContent, content: text };
    if (Array.isArray(responseMessage.reasoning_details)) lastTurn.reasoningDetails = clone(responseMessage.reasoning_details);
    else if (typeof responseMessage.reasoning === "string" && responseMessage.reasoning) lastTurn.reasoning = responseMessage.reasoning;
    if (Buffer.byteLength(JSON.stringify(lastTurn), "utf8") > 1_500_000) failWithScreenwriterAttempt(502, "screenwriter_reasoning_state_large", "Trinity returned continuation state too large to checkpoint safely. The active screenplay was not changed.", { ...attempt, status: "provider_rejected", rejectionCode: "screenwriter_reasoning_state_large" });
    const updatedText = generatedSections > 0 ? `${prompt}\n\n${text.trimStart()}` : text;
    return {
      text: updatedText, section: text, brief, generatedSections: generatedSections + 1, lastTurn,
      usage, model: SCREENWRITER_MODEL, sessionId, attempt,
      generationId, finishReason, truncated: finishReason === "length",
      servedBy: { agent: "screenwriter", provider: "openrouter", model: SCREENWRITER_MODEL },
    };
  }

  async function callDirector(tenant, project, message, context, deadlineAt) {
    let conversation = Array.isArray(project?.messages) ? project.messages : [];
    const directorState = project?.ai?.director?.state || {};
    let compactedSummary = cleanText(directorState.compactedSummary, 100_000);
    let compaction = null;
    /*
     * THE DIRECTOR NOW ROUTES THE JOB (Fred, 2026-08-05). The studio had a screenwriter and a
     * storyboard that nobody could find a path to: "if I didn't know that it did that, I would be
     * completely lost." A quick clip should go straight to render; an ad needs copy and a
     * storyboard so characters hold across scenes. Judging which is which is a reading task, so
     * the DIRECTOR decides (an LLM reading the whole conversation), never a client-side keyword
     * match. The verdict rides back as one fenced JSON block after the directive, and
     * routingFromText below survives any mangling of it.
     */
    const directorSystem = [
      "You are Dominion's creative director. Plan the whole video and coordinate the screenwriter and liaison.",
      "Give a precise change directive based only on the persisted project and the user's request. Consider purpose,",
      "destination, duration, aspect ratio, resolution, scene order, continuity, image needs, sound, and efficient",
      "high-quality model use. Do not say work is complete.",
      "",
      "After the directive, append EXACTLY ONE fenced json block routing this job:",
      '```json',
      '{"routing":{"path":"quick_clip|scripted|storyboarded","needs_screenwriter":false,"needs_storyboard":false,',
      '"ready_to_generate":false,"reason":"one short sentence","suggested_recommendation":"screenwriter|storyboard|generate|none",',
      '"scene_draft":{"title":"","prompt":"","duration":5}}}',
      '```',
      "How to route, by what the person is actually trying to make:",
      "- quick_clip: one shot, one concrete subject, no story. Phrases like 'quick clip', 'just a shot of', or a plain",
      "  visual description. needs_screenwriter false, needs_storyboard false. Set ready_to_generate true as soon as you",
      "  know the subject and what it does, and fill scene_draft with a title and a full render prompt.",
      "- storyboarded: several scenes, recurring characters, an episode, or anything needing visual continuity.",
      "  needs_storyboard true.",
      "- scripted: an ad, commercial, brand or campaign piece, product launch, explainer, anything where the words",
      "  matter. needs_screenwriter true AND needs_storyboard true.",
      "Set suggested_recommendation to the ONE next step you would push for. Use none while you still need an answer",
      "from the person. Never set ready_to_generate true without a usable scene_draft.prompt.",
    ].join("\n");
    const makeProjectContext = () => JSON.stringify({ project: project?.project, screenplay: project?.screenplay, scenes: project?.scenes, timeline: { tracks: project?.tracks, clips: project?.clips }, conversationSummary: compactedSummary || null, recentConversation: conversation, requestContext: context || {} });
    const projected = requestTokenEstimate([{ role: "system", content: directorSystem }, { role: "user", content: `${makeProjectContext()}\n\nUser request:\n${message}` }]);
    if ((project?.ai?.director?.compactionRequired || projected >= DIRECTOR_COMPACT_AT) && conversation.length) {
      let lastUsage = null;
      for (const chunk of conversationChunks(conversation)) {
        const compactionMessages = [
          { role: "system", content: "Compact this video-project conversation into a faithful working brief. Preserve every unresolved decision, character/visual continuity fact, user constraint, scene change, model decision, and failure. Remove repetition only. Return the brief alone." },
          { role: "user", content: JSON.stringify({ priorSummary: compactedSummary, conversation: chunk }) },
        ];
        enforceContextWindow("video_director_context_limit", "The conversation-compaction request", compactionMessages, LONG_CONTEXT_TOKENS, 16_384);
        // Compaction is bookkeeping ahead of the real director turn, not the turn itself: it stays
        // on one reliable, currently-alive, free NVIDIA model rather than carrying its own ladder.
        const compacted = await callOpenAiStyleTransport({
          provider: "nvidia_director_compaction", apiKey: credential(nvidia.apiKey),
          url: endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions"),
          model: NVIDIA_NEMOTRON_SUPER_MODEL, messages: compactionMessages, maxTokens: 16_384, temperature: 0.1, topP: 0.95,
          deadlineAt, timeoutMs: nvidia.timeoutMs, extraBody: { chat_template_kwargs: { thinking: false } },
        });
        compactedSummary = compacted.text;
        lastUsage = compacted.usage;
        await maybeMeterProvider(tenant, nvidia, compacted.usage, { kind: "video_director_compaction", provider: "nvidia", model: NVIDIA_NEMOTRON_SUPER_MODEL });
      }
      compaction = { summary: compactedSummary, usage: lastUsage, atPercent: 70 };
      conversation = [];
    }
    const projectContext = makeProjectContext();
    const maxTokens = Math.min(16_384, Math.max(512, Number(nvidia.directorMaxTokens) || 512));
    const temperature = Number.isFinite(Number(nvidia.directorTemperature)) ? Number(nvidia.directorTemperature) : 1;
    const topP = Number.isFinite(Number(nvidia.directorTopP)) ? Number(nvidia.directorTopP) : 0.95;
    const userContent = `${projectContext}\n\nUser request:\n${message}`;
    const openAiMessages = [{ role: "system", content: directorSystem }, { role: "user", content: userContent }];
    enforceContextWindow("video_director_context_limit", "The video creative-director request", openAiMessages, LONG_CONTEXT_TOKENS, maxTokens);
    const nvidiaUrl = endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions");
    const deepseekUrl = endpoint(deepseek.baseUrl || "https://api.deepseek.com", "/chat/completions");
    const anthropicUrl = endpoint(anthropic.baseUrl || "https://api.anthropic.com", "/v1/messages");
    const ladder = [
      { provider: "deepseek", model: DEEPSEEK_PRO_MODEL, call: () => callOpenAiStyleTransport({ provider: "deepseek_director", apiKey: credential(deepseek.apiKey), url: deepseekUrl, model: DEEPSEEK_PRO_MODEL, messages: openAiMessages, maxTokens: reasoningSafeMaxTokens(DEEPSEEK_PRO_MODEL, maxTokens), temperature, topP, deadlineAt, timeoutMs: deepseek.timeoutMs }) },
      { provider: "nvidia", model: NVIDIA_DEEPSEEK_MODEL, call: () => callOpenAiStyleTransport({ provider: "nvidia_director", apiKey: credential(nvidia.apiKey), url: nvidiaUrl, model: NVIDIA_DEEPSEEK_MODEL, messages: openAiMessages, maxTokens, temperature, topP, deadlineAt, timeoutMs: nvidia.timeoutMs, extraBody: { chat_template_kwargs: { thinking: false } } }) },
      { provider: "nvidia", model: NVIDIA_NEMOTRON_SUPER_MODEL, call: () => callOpenAiStyleTransport({ provider: "nvidia_director", apiKey: credential(nvidia.apiKey), url: nvidiaUrl, model: NVIDIA_NEMOTRON_SUPER_MODEL, messages: openAiMessages, maxTokens, temperature, topP, deadlineAt, timeoutMs: nvidia.timeoutMs, extraBody: { chat_template_kwargs: { thinking: false } } }) },
      { provider: "anthropic", model: SONNET_MODEL, call: () => callAnthropicTransport({ apiKey: credential(anthropic.apiKey), url: anthropicUrl, model: SONNET_MODEL, system: directorSystem, messages: [{ role: "user", content: userContent }], maxTokens, deadlineAt, timeoutMs: anthropic.timeoutMs, version: anthropic.version }) },
    ];
    const served = await runAgentLadder("director", ladder);
    await maybeMeterProvider(tenant, PROVIDER_CONFIG_BY_NAME[served.servedBy.provider], served.usage, { kind: "video_director", provider: served.servedBy.provider, model: served.servedBy.model });
    const routed = routingFromText(served.text);
    return { directive: routed.directive, routing: routed.routing, usage: served.usage, model: served.servedBy.model, servedBy: served.servedBy, compaction };
  }

  /*
   * Read the director's routing block, and NEVER fail the turn over it. A malformed block means we
   * lose a recommendation, which costs one chip; throwing would cost the whole conversation, which
   * is the trade this whole studio has been getting wrong. Everything is whitelisted or coerced:
   * the block is model output and cannot be trusted to be well-formed or well-behaved.
   */
  const ROUTING_PATHS = new Set(["quick_clip", "scripted", "storyboarded"]);
  const ROUTING_RECOMMENDATIONS = new Set(["screenwriter", "storyboard", "generate", "none"]);
  const DEFAULT_ROUTING = Object.freeze({
    path: "unknown", needsScreenwriter: false, needsStoryboard: false, readyToGenerate: false,
    reason: "", recommendation: "none", sceneDraft: null, parseFailed: true,
  });
  function routingFromText(text) {
    const source = String(text || "");
    // Take the LAST fenced block, or failing that the last {...}: the directive itself may
    // legitimately contain braces.
    const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1);
    let candidate = fenced ? fenced[1] : null;
    if (!candidate) {
      const start = source.lastIndexOf("{");
      const end = source.lastIndexOf("}");
      if (start >= 0 && end > start) candidate = source.slice(start, end + 1);
    }
    const directive = cleanText(fenced ? source.slice(0, fenced.index) : (candidate ? source.slice(0, source.lastIndexOf("{")) : source), 100_000) || cleanText(source, 100_000);
    if (!candidate) return { directive, routing: { ...DEFAULT_ROUTING } };
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { return { directive, routing: { ...DEFAULT_ROUTING } }; }
    const r = (parsed && typeof parsed === "object" && parsed.routing && typeof parsed.routing === "object") ? parsed.routing : parsed;
    if (!r || typeof r !== "object") return { directive, routing: { ...DEFAULT_ROUTING } };
    const draftSource = r.scene_draft || r.sceneDraft;
    const draftPrompt = cleanText(draftSource?.prompt, 32_000);
    const duration = Number(draftSource?.duration);
    const sceneDraft = draftPrompt ? {
      title: cleanText(draftSource?.title, 160) || "Scene 1",
      prompt: draftPrompt,
      duration: Number.isInteger(duration) && duration > 0 && duration <= 60 ? duration : null,
    } : null;
    const path = ROUTING_PATHS.has(String(r.path)) ? String(r.path) : "unknown";
    const recommendation = ROUTING_RECOMMENDATIONS.has(String(r.suggested_recommendation || r.recommendation))
      ? String(r.suggested_recommendation || r.recommendation) : "none";
    return {
      directive,
      routing: {
        path,
        needsScreenwriter: (r.needs_screenwriter ?? r.needsScreenwriter) === true,
        needsStoryboard: (r.needs_storyboard ?? r.needsStoryboard) === true,
        // A "ready" verdict with nothing to render is not ready.
        readyToGenerate: (r.ready_to_generate ?? r.readyToGenerate) === true && !!sceneDraft,
        reason: cleanText(r.reason, 500),
        recommendation,
        sceneDraft,
        parseFailed: false,
      },
    };
  }

  /*
   * The chips the person actually taps. Derived on the SERVER from the director's verdict so the
   * client never has to guess intent, and always offering an escape hatch: nothing here is forced,
   * which was Fred's hard requirement.
   */
  function chipsFor(routing) {
    const chips = [];
    if (!routing || routing.path === "unknown") return chips;
    if (routing.needsScreenwriter) chips.push({ id: "screenwriter", label: "Bring in the screenwriter" });
    if (routing.needsStoryboard) chips.push({ id: "storyboard", label: routing.needsScreenwriter ? "Skip to the storyboard" : "Build the storyboard" });
    if (routing.readyToGenerate) chips.push({ id: "generate", label: chips.length ? "Just generate it" : "Generate this clip" });
    return chips;
  }

  function visualPlanFromText(text) {
    let source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const objectStart = source.indexOf("{");
    const objectEnd = source.lastIndexOf("}");
    const arrayStart = source.indexOf("[");
    const arrayEnd = source.lastIndexOf("]");
    if (objectStart >= 0 && objectEnd > objectStart) source = source.slice(objectStart, objectEnd + 1);
    else if (arrayStart >= 0 && arrayEnd > arrayStart) source = source.slice(arrayStart, arrayEnd + 1);
    let parsed;
    try { parsed = JSON.parse(source); }
    catch { fail(502, "visual_orchestrator_invalid_plan", "The visual orchestrator returned an unreadable scene plan. No substitute model was used."); }
    const scenes = Array.isArray(parsed) ? parsed : parsed?.scenes;
    if (!Array.isArray(scenes) || !scenes.length || scenes.length > 100) fail(502, "visual_orchestrator_invalid_plan", "The visual orchestrator must return between 1 and 100 ordered scenes.");
    return {
      scenes: scenes.map((scene, index) => {
        const imagePrompt = cleanText(scene?.imagePrompt || scene?.image_prompt, 32_000);
        if (!imagePrompt) fail(502, "visual_orchestrator_invalid_plan", `Visual scene ${index + 1} has no image prompt.`);
        return {
          order: index + 1,
          sceneId: cleanText(scene?.sceneId || scene?.scene_id, 128) || `scene_${index + 1}`,
          title: cleanText(scene?.title, 200) || `Scene ${index + 1}`,
          imagePrompt,
          videoPrompt: cleanText(scene?.videoPrompt || scene?.video_prompt, 32_000),
          continuity: cleanText(scene?.continuity, 8_000),
          suggestedVideoModel: cleanText(scene?.suggestedVideoModel || scene?.suggested_video_model, 200),
        };
      }),
    };
  }

  async function callVisualOrchestrator(tenant, project, message, director, deadlineAt) {
    const conversation = director.compaction?.summary ? { compactedSummary: director.compaction.summary } : project?.messages || [];
    const source = JSON.stringify({ screenplay: project?.screenplay, conversation, currentScenes: project?.scenes || [], projectSettings: project?.project, userRequest: message, directorPlan: director.directive });
    const maxTokens = Math.min(16_384, Math.max(512, Number(nvidia.visualMaxTokens) || 8_192));
    const temperature = Number.isFinite(Number(nvidia.visualTemperature)) ? Number(nvidia.visualTemperature) : 1;
    const topP = Number.isFinite(Number(nvidia.visualTopP)) ? Number(nvidia.visualTopP) : 0.95;
    const messages = [
      { role: "system", content: "You are Dominion's visual orchestrator. Read the creative director plan, screenplay, and saved conversation, then produce the images needed in exact story order. Return JSON only in this shape: {\"scenes\":[{\"order\":1,\"sceneId\":\"scene_1\",\"title\":\"\",\"imagePrompt\":\"\",\"videoPrompt\":\"\",\"continuity\":\"\",\"suggestedVideoModel\":\"\"}]}. Use no more than 100 scenes. Image prompts must be specific enough to preserve characters, wardrobe, location, lighting, composition, lens, and continuity. Do not claim any image or video was generated." },
      { role: "user", content: source },
    ];
    enforceContextWindow("video_visual_context_limit", "The visual-orchestrator request", messages, LONG_CONTEXT_TOKENS, maxTokens);
    const nvidiaUrl = endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions");
    const deepseekUrl = endpoint(deepseek.baseUrl || "https://api.deepseek.com", "/chat/completions");
    // Parsing/validating the scene plan happens INSIDE each rung: a rung that answers with
    // unusable JSON is exactly as unhelpful as one that answers with an HTTP error, so a malformed
    // plan also falls through to the next rung rather than failing the whole orchestrator outright.
    const nvidiaCall = (model) => async () => {
      const { text, usage } = await callOpenAiStyleTransport({ provider: "nvidia_visual_orchestrator", apiKey: credential(nvidia.apiKey), url: nvidiaUrl, model, messages, maxTokens, temperature, topP, deadlineAt, timeoutMs: nvidia.timeoutMs, extraBody: { chat_template_kwargs: { enable_thinking: false } } });
      return { plan: visualPlanFromText(text), usage };
    };
    const ladder = [
      { provider: "nvidia", model: NVIDIA_NEMOTRON_SUPER_MODEL, call: nvidiaCall(NVIDIA_NEMOTRON_SUPER_MODEL) },
      { provider: "deepseek", model: DEEPSEEK_PRO_MODEL, call: async () => { const { text, usage } = await callOpenAiStyleTransport({ provider: "deepseek_visual_orchestrator", apiKey: credential(deepseek.apiKey), url: deepseekUrl, model: DEEPSEEK_PRO_MODEL, messages, maxTokens: reasoningSafeMaxTokens(DEEPSEEK_PRO_MODEL, maxTokens), temperature, topP, deadlineAt, timeoutMs: deepseek.timeoutMs }); return { plan: visualPlanFromText(text), usage }; } },
      // Last resort: the 550B planner is slow (50-57s measured), but it is never simply left untried.
      { provider: "nvidia", model: NVIDIA_NEMOTRON_ULTRA_MODEL, call: nvidiaCall(NVIDIA_NEMOTRON_ULTRA_MODEL) },
    ];
    const served = await runAgentLadder("visual_orchestrator", ladder);
    await maybeMeterProvider(tenant, PROVIDER_CONFIG_BY_NAME[served.servedBy.provider], served.usage, { kind: "video_visual_orchestration", provider: served.servedBy.provider, model: served.servedBy.model });
    return { available: true, plan: served.plan, usage: served.usage, model: served.servedBy.model, servedBy: served.servedBy };
  }

  async function callLiaison(tenant, project, message, director, visual, deadlineAt) {
    const stableContext = JSON.stringify({ role: "video project state", project: project?.project, screenplay: project?.screenplay, scenes: project?.scenes, tracks: project?.tracks, clips: project?.clips });
    const maxTokens = Math.min(16_384, Math.max(256, Number(anthropic.maxTokens) || 4_096));
    enforceContextWindow("video_liaison_context_limit", "The liaison request", {
      stableContext,
      userRequest: message,
      director: { model: director.model, directive: director.directive },
      visual: visual.available ? visual.plan : visual.error,
    }, LONG_CONTEXT_TOKENS, maxTokens);
    /*
     * SHE SOUNDS LIKE A PERSON WHO MAKES FILMS (Fred, 2026-08-05: "This is a creative director
     * and it should sound like a creative director. give it personality. It's one of the
     * differentiators of this app."). The old prompt produced a competent status clerk. The
     * honesty constraints are untouched and come LAST, because they outrank the voice.
     */
    const systemText = [
      "You are the producer in Dominion's video studio: the person the user talks to about the film they want to make.",
      "You have made a lot of things. You have opinions and you offer them.",
      "",
      "HOW YOU TALK: like a working creative director, not a help system. Warm, direct, a little wry.",
      "Short sentences. Say what you would do and why in one line. Ask ONE sharp question at a time when",
      "something is genuinely missing, rather than interrogating with a list. Never open with 'Certainly' or",
      "'I understand'. Never narrate your own process. No bullet lists unless the user asks for one.",
      "",
      "WHEN THE DIRECTOR RECOMMENDS A STEP: put it in your own words as a suggestion with a reason, the way a",
      "colleague would ('An ad lives or dies on the script, so let me get the writer on this first'). The user",
      "will see buttons for the actual choice, so do not list options or ask them to type a number. Never insist:",
      "if they want to skip straight to a render, that is their call and you make it work.",
      "",
      "HONESTY OUTRANKS EVERYTHING ABOVE. Never claim a generation, save, edit, charge, or export happened",
      "unless the supplied state proves it. Surface every limitation and failure plainly. If something is not",
      "configured or not built, say so instead of implying it will happen.",
    ].join("\n");
    // Three distinct states, and telling them apart matters: a plan, a step we deliberately did
    // not run, and a step that failed. Calling the first two "DEGRADED" made the producer
    // apologise for a storyboard nobody asked for (and threw on a null error).
    const visualLine = `User request:\n${message}\n\nCreative director directive (${director.model}):\n${director.directive}\n\nVisual orchestrator (${visual.model}):\n${
      visual.available ? JSON.stringify(visual.plan)
        : visual.skipped ? "NOT RUN — no storyboard was requested this turn. Do not mention a storyboard unless the user raised it, and never imply one was built."
        : `DEGRADED — ${visual.error?.code || "visual_orchestrator_unavailable"}: ${visual.error?.message || "The visual orchestrator did not answer."}`}`;
    const anthropicSystem = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
    const anthropicMessages = [
      { role: "user", content: [{ type: "text", text: stableContext, cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: "I have the persisted project context." },
      { role: "user", content: visualLine },
    ];
    // DeepSeek-direct is OpenAI-chat-completions-shaped: flatten the structured, cache-tagged
    // Anthropic content blocks into plain strings. Prompt caching is an Anthropic-only mechanic;
    // losing it on the last-resort rung is an acceptable trade for a producer reply that still answers.
    const openAiMessages = [
      { role: "system", content: systemText },
      { role: "user", content: stableContext },
      { role: "assistant", content: "I have the persisted project context." },
      { role: "user", content: visualLine },
    ];
    const anthropicUrl = endpoint(anthropic.baseUrl || "https://api.anthropic.com", "/v1/messages");
    const deepseekUrl = endpoint(deepseek.baseUrl || "https://api.deepseek.com", "/chat/completions");
    const ladder = [
      { provider: "anthropic", model: SONNET_MODEL, call: () => callAnthropicTransport({ apiKey: credential(anthropic.apiKey), url: anthropicUrl, model: SONNET_MODEL, system: anthropicSystem, messages: anthropicMessages, maxTokens, deadlineAt, timeoutMs: anthropic.timeoutMs, version: anthropic.version }) },
      { provider: "anthropic", model: HAIKU_MODEL, call: () => callAnthropicTransport({ apiKey: credential(anthropic.apiKey), url: anthropicUrl, model: HAIKU_MODEL, system: anthropicSystem, messages: anthropicMessages, maxTokens, deadlineAt, timeoutMs: anthropic.timeoutMs, version: anthropic.version }) },
      { provider: "deepseek", model: DEEPSEEK_FLASH_MODEL, call: () => callOpenAiStyleTransport({ provider: "deepseek_liaison", apiKey: credential(deepseek.apiKey), url: deepseekUrl, model: DEEPSEEK_FLASH_MODEL, messages: openAiMessages, maxTokens, temperature: 1, topP: 0.95, deadlineAt, timeoutMs: deepseek.timeoutMs }) },
    ];
    const served = await runAgentLadder("liaison", ladder);
    await maybeMeterProvider(tenant, PROVIDER_CONFIG_BY_NAME[served.servedBy.provider], served.usage, { kind: "video_liaison", provider: served.servedBy.provider, model: served.servedBy.model });
    return { reply: served.text, usage: served.usage, model: served.servedBy.model, servedBy: served.servedBy };
  }

  async function persistAiTurn(tenantId, projectId, expectedProjectRevision, message, director, visual, liaison, { buildStoryboard = true } = {}) {
    const conversation = { at: new Date(Number(now())).toISOString(), user: message, director: director.directive, visualPlan: visual.available ? clone(visual.plan) : null, visualError: visual.available ? null : clone(visual.error), reply: liaison.reply, servedBy: { director: clone(director.servedBy || null), visualOrchestrator: clone(visual.servedBy || null), liaison: clone(liaison.servedBy || null) } };
    if (typeof feature.updateAiState === "function") {
      const saved = await feature.updateAiState(tenantId, projectId, {
        expectedProjectRevision,
        director: { model: director.model, usage: clone(director.usage), directive: director.directive, routing: clone(director.routing || null), compaction: clone(director.compaction), servedBy: clone(director.servedBy || null) },
        // A skipped orchestrator writes NOTHING about itself: passing a record here would stamp an
        // applyStatus and, worse, hand updateAiState a plan-shaped absence to reason about. The
        // last real plan stays exactly as it was.
        visualOrchestrator: buildStoryboard ? { model: visual.model, available: visual.available, usage: clone(visual.usage), plan: clone(visual.plan), error: clone(visual.error), servedBy: clone(visual.servedBy || null) } : null,
        liaison: { model: liaison.model, usage: clone(liaison.usage), reply: liaison.reply, servedBy: clone(liaison.servedBy || null) },
        visualPlanScenes: buildStoryboard && visual.available ? clone(visual.plan.scenes) : null,
        conversation,
      });
      const applyStatus = !buildStoryboard ? "skipped"
        : cleanText(saved?.ai?.visualOrchestrator?.state?.applyStatus, 80) || (visual.available ? "unknown" : "unavailable");
      return { saved, planApplied: applyStatus === "applied", applyStatus };
    }
    fail(501, "video_ai_checkpoint_unavailable", "The AI turn completed but cannot be saved, so it was not accepted as a project change.");
  }

  async function prepareScreenwriterTurn(req, context, body) {
    if (screenwriterDraining) fail(503, "screenwriter_draining", "Dominion is finishing an active screenplay checkpoint for a server restart. Retry after the deployment completes; no provider call was made.");
    await requireDesktop(req, context, body);
    requireProviderPrivacy(body, { provider: "openrouter", model: SCREENWRITER_MODEL });
    await generationBilling(context.tenant);
    const projectId = ensureProjectId(body.projectId);
    const prompt = String(body.prompt || "");
    if (!prompt.trim()) fail(400, "video_screenplay_prompt_required", "Add a story brief before asking the screenwriter.");
    if (prompt.length > MAX_SCREENPLAY_CHARS || tokenEstimate(prompt) > SCREENWRITER_CONTEXT_TOKENS || Number(body.limit || 115_000) > 115_000) fail(413, "video_screenplay_limit", "The screenplay is limited to 115,000 total context tokens and is never compacted.");
    screenOrFail(screenContent, context.tenant, prompt);
    return { ...context, projectId, prompt };
  }

  async function executeScreenwriterTurn({ tenant, tenantId, projectId, prompt }) {
    if (screenwriterDraining) fail(503, "screenwriter_draining", "Dominion is finishing active screenplay work for a server restart. No provider call was made.");
    const activeKey = screenwriterKey(tenantId, projectId);
    if (activeAiProjects.has(activeKey)) fail(409, "video_ai_busy", "The video AI team is already saving a planning turn for this project. Wait for that checkpoint before starting Trinity; no provider request was made.");
    requireProjectScreenwriterIdle(tenantId, projectId);
    activeScreenwriterProjects.add(activeKey);
    screenwriterActivityVersion++;
    try {
      let project = await feature.getProject(tenantId, projectId);
      const unresolved = pendingScreenwriterAttempt(project);
      if (unresolved) fail(409, "screenwriter_reconciliation_required", "This project already has Trinity provider work awaiting completion or reconciliation. Refresh the saved project; no second provider request was made.");
      let persistedText = String(project?.screenplay?.text || "");
      if (prompt !== persistedText) {
        /*
         * AUTO-CHECKPOINT INSTEAD OF STALE REFUSAL (stabilize 2026-09-03, deficiency 21). The
         * client always saves a checkpoint before asking Trinity to write; if that save silently
         * failed, raced, or simply hadn't landed yet, the old behavior refused the entire turn as
         * "stale" even though nothing was actually unresolved (checked above). There is no
         * provider work in flight, so the prompt IS the screenplay the user wants written from:
         * persist it as a real checkpoint (new revision, new sha) and proceed. Only genuinely
         * unresolved provider work still blocks the turn (the check above, unchanged).
         */
        const beforeSha256 = createHash("sha256").update(persistedText).digest("hex");
        try { project = await feature.applyCommand(tenantId, projectId, { type: "screenplay.set", text: prompt, expectedScreenplaySha256: beforeSha256 }); }
        catch (checkpointError) {
          if (String(checkpointError?.code || "") === "screenwriter_stale_write") fail(409, "screenwriter_stale_prompt", "The screenplay changed twice in a race while this request was preparing to auto-checkpoint. Refresh the current project before starting Trinity; no provider call was made.");
          throw checkpointError;
        }
        persistedText = String(project?.screenplay?.text || "");
      }
      const writerState = project?.ai?.screenwriter?.state || {};
      const expectedScreenplaySha256 = createHash("sha256").update(persistedText).digest("hex");
      const expectedScreenwriterGenerationId = cleanText(writerState.generationId, 200) || null;
      const turn = buildScreenwriterTurn(project, prompt);
      let submissionAttempt = null;
      let provisionalAttempt = null;
      let result;
      const completeSubmission = async (generationId = null) => {
        if (!submissionAttempt) return;
        await feature.applyCommand(tenantId, projectId, {
          type: "screenwriter.attempt",
          attempt: { ...submissionAttempt, generationId: cleanText(generationId, 200) || submissionAttempt.generationId || null, status: "provider_correlated", settlement: { status: "not_billed", costUsd: 0 } },
        });
      };
      try {
        result = await callScreenwriterTrinity(tenant, project, prompt, turn, {
          onSubmitting: async () => {
            const candidate = {
              attemptId: `sw_local_${randomUUID().replaceAll("-", "")}`,
              generationId: null, status: "provider_submitting", rejectionCode: null, finishReason: null,
              sourceScreenplaySha256: expectedScreenplaySha256, sourceGenerationId: expectedScreenwriterGenerationId,
              settlement: { status: "awaiting_response", costUsd: 0 },
            };
            await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", begin: true, attempt: candidate });
            submissionAttempt = candidate;
          },
          onGeneration: async (generationId) => {
            const attemptId = `sw_${createHash("sha256").update(generationId).digest("hex").slice(0, 48)}`;
            provisionalAttempt = {
              attemptId, generationId, status: "provider_in_progress", rejectionCode: null, finishReason: null,
              sourceScreenplaySha256: expectedScreenplaySha256, sourceGenerationId: expectedScreenwriterGenerationId,
              settlement: { status: "awaiting_response", costUsd: 0 },
            };
            await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: provisionalAttempt, supersedeAttemptId: submissionAttempt?.attemptId || null });
            await completeSubmission(generationId);
          },
        });
      }
      catch (error) {
        const attempted = error?.screenwriterAttempt;
        let cleanFailure = false;
        if (attempted) {
          const { billable, ...attempt } = attempted;
          const recorded = { ...attempt, sourceScreenplaySha256: expectedScreenplaySha256, sourceGenerationId: expectedScreenwriterGenerationId };
          if (provisionalAttempt && provisionalAttempt.attemptId !== recorded.attemptId) {
            await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...provisionalAttempt, status: "reconciliation_required", rejectionCode: cleanText(error?.code || "screenwriter_generation_conflict", 120) } });
          }
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: recorded });
          await completeSubmission(recorded.generationId);
          if (billable === true) {
            try {
              const settlement = await maybeMeterProvider(tenant, openrouter, attempt.usage, { kind: "video_screenwrite", provider: "openrouter", model: SCREENWRITER_MODEL, generationId: attempt.generationId });
              await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...recorded, status: "rejected", settlement: attemptSettlement(settlement, attempt.usage) } });
            } catch (billingError) {
              await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...recorded, status: "settlement_failed", settlement: { status: "failed", key: cleanText(billingError?.settlementKey, 300) || null, costUsd: Number(attempt.usage?.cost) || 0, errorCode: cleanText(billingError?.code || "video_settlement_failed", 160) } } });
              throw billingError;
            }
          }
          // A response body was parsed (even one that got rejected): ambiguous/billable OpenRouter
          // territory. Preserve the existing reconciliation-required behavior exactly - never risk
          // a second paid call on top of unresolved Trinity work.
        } else if (provisionalAttempt) {
          const providerUsage = error?.providerUsage && typeof error.providerUsage === "object" ? clone(error.providerUsage) : null;
          const providerCost = Math.max(0, Number(providerUsage?.cost) || 0);
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...provisionalAttempt, ...(providerUsage ? { usage: providerUsage } : {}), status: "reconciliation_required", rejectionCode: cleanText(error?.code || "screenwriter_response_interrupted", 120), settlement: { status: "awaiting_response", costUsd: providerCost } } });
          await completeSubmission(provisionalAttempt.generationId);
          // A generation id was already seen for Trinity: real work may be in flight. Same rule.
        } else if (submissionAttempt) {
          const rejected = definitiveProviderHttpRejection(error);
          const generationId = cleanText(error?.providerGenerationId, 200) || null;
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...submissionAttempt, generationId, status: rejected ? "provider_http_rejected" : "reconciliation_required", rejectionCode: cleanText(error?.code || (rejected ? "screenwriter_provider_rejected" : "screenwriter_acknowledgement_unknown"), 120), settlement: { status: rejected ? "not_billed" : "awaiting_response", costUsd: Math.max(0, Number(error?.providerUsage?.cost) || 0) } } });
          // Trinity's own placeholder was just closed out terminal ("provider_http_rejected") only
          // when the rejection was definitive (no generation id or cost ever observed). That
          // makes the attempt ledger correct, but this branch runs only after OpenRouter actually
          // answered the submission POST (an HTTP status came back) - Fred's own reconciliation
          // suite treats a real OpenRouter response, even a clean 401/503, as strictly the
          // OpenRouter-scoped "fix your key / wait and retry" flow, not a cue to silently answer
          // from a different provider. So a definitive rejection here still does NOT fall through
          // to the ladder; cleanFailure stays false and the existing reconciliation-safe behavior
          // (and every test asserting it) is unchanged. Disclosed narrowing of the ladder spec:
          // automatic screenwriter fallthrough is scoped to "Trinity never got a submission off
          // the ground at all" (see the else branch below), not "Trinity answered and refused."
        } else {
          // onSubmitting itself never completed (screenwriter_not_configured, or the durable
          // placeholder write failed before any provider egress): nothing was ever begun, so no
          // OpenRouter response exists to be scoped to OpenRouter - safe to try a direct rung.
          cleanFailure = true;
        }
        if (!cleanFailure) throw error;
        /*
         * TRINITY LADDER FALLTHROUGH (stabilize 2026-09-03, deficiency 20, required behavior #2).
         * OpenRouter/Trinity never got billable or ambiguous work off the ground this specific
         * turn, so fall through to a direct rung instead of ending the turn in an error - Fred's
         * rule that nothing may end in a silent or announced error while an alternative remains
         * untried. Anything even slightly ambiguous stayed on the reconciliation path above.
         */
        result = await screenwriterFallbackRungs(tenant, project, prompt, turn, { tenantId, projectId, expectedScreenplaySha256, expectedScreenwriterGenerationId });
      }
      const latest = await feature.getProject(tenantId, projectId);
      const latestHash = createHash("sha256").update(String(latest?.screenplay?.text || "")).digest("hex");
      const latestGenerationId = cleanText(latest?.ai?.screenwriter?.state?.generationId, 200) || null;
      const baseAttempt = { ...result.attempt, sourceScreenplaySha256: expectedScreenplaySha256, sourceGenerationId: expectedScreenwriterGenerationId };
      delete baseAttempt.billable;
      if (latestHash !== expectedScreenplaySha256 || latestGenerationId !== expectedScreenwriterGenerationId) {
        await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...baseAttempt, status: "recoverable_stale_unbilled", settlement: { status: "not_billed", costUsd: 0 }, candidate: recoverableCandidate(result) } });
        await completeSubmission(result.generationId);
        fail(409, "screenwriter_stale_write", "The screenplay changed while Trinity was writing. Its unbilled result was preserved for recovery and did not overwrite the newer checkpoint.");
      }
      await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...baseAttempt, candidate: recoverableCandidate(result) } });
      await completeSubmission(result.generationId);
      let settlement;
      try {
        const servedByProvider = result.servedBy?.provider || "openrouter";
        settlement = await maybeMeterProvider(tenant, PROVIDER_CONFIG_BY_NAME[servedByProvider] || openrouter, result.usage, { kind: "video_screenwrite", provider: servedByProvider, model: result.servedBy?.model || SCREENWRITER_MODEL, generationId: result.generationId });
        await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...baseAttempt, status: "provider_accepted", settlement: attemptSettlement(settlement, result.usage), candidate: recoverableCandidate(result) } });
      }
      catch (billingError) {
        await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...baseAttempt, status: "settlement_failed", settlement: { status: "failed", key: cleanText(billingError?.settlementKey, 300) || null, costUsd: Number(result.usage?.cost) || 0, errorCode: cleanText(billingError?.code || "video_settlement_failed", 160) }, candidate: recoverableCandidate(result) } });
        throw billingError;
      }
      try {
        await feature.applyCommand(tenantId, projectId, {
          type: "screenplay.set", text: result.text, model: result.model, usage: result.usage,
          generationId: result.generationId, finishReason: result.finishReason, truncated: result.truncated,
          brief: result.brief, generatedSections: result.generatedSections, lastTurn: result.lastTurn, sessionId: result.sessionId,
          expectedScreenplaySha256, expectedScreenwriterGenerationId, attemptId: result.attempt.attemptId, settlement,
        });
      } catch (saveError) {
        await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...baseAttempt, status: "recoverable_stale_settled", settlement: attemptSettlement(settlement, result.usage), candidate: recoverableCandidate(result) } });
        throw saveError;
      }
      return { text: result.text, screenplaySha256: createHash("sha256").update(result.text).digest("hex"), model: result.model, projectId, usage: result.usage, finishReason: result.finishReason, truncated: result.truncated, servedBy: result.servedBy || null };
    } finally { activeScreenwriterProjects.delete(activeKey); screenwriterActivityVersion++; }
  }

  async function reconcileScreenwriterTurn(req, context, body) {
    if (screenwriterDraining) fail(503, "screenwriter_draining", "Dominion is finishing screenplay work for a server restart. Retry reconciliation after deployment completes.");
    await requireDesktop(req, context, body);
    const { tenant, tenantId } = context;
    const projectId = ensureProjectId(body.projectId);
    const activeKey = screenwriterKey(tenantId, projectId);
    requireProjectScreenwriterIdle(tenantId, projectId);
    activeScreenwriterProjects.add(activeKey);
    screenwriterActivityVersion++;
    try {
      const project = await feature.getProject(tenantId, projectId);
      let attempt = pendingScreenwriterAttempt(project);
      if (!attempt) return { ok: true, reconciled: false, status: "idle", project: await getProject(tenantId, projectId), message: "The saved Trinity ledger is already reconciled." };
      if (new Set(["screenwriter_generation_id_mismatch", "screenwriter_generation_conflict"]).has(String(attempt.rejectionCode || ""))) fail(409, "screenwriter_operator_reconciliation_required", "OpenRouter returned conflicting generation identities for one Trinity request. Automatic settlement is disabled to prevent duplicate charging; an operator must reconcile the linked provider records.");
      const usage = storedScreenwriterUsage(attempt);
      const candidate = attempt.candidate && typeof attempt.candidate === "object" ? clone(attempt.candidate) : null;
      const settlementRecovery = new Set(["provider_accepted", "provider_rejected", "settlement_failed", "recoverable_stale_unbilled", "recoverable_stale_settled"]).has(String(attempt.status || ""));

      if (settlementRecovery) {
        if (!attempt.generationId) fail(409, "screenwriter_operator_reconciliation_required", "This saved Trinity result has no stable provider generation identity. It remains preserved for operator reconciliation and was not charged again.");
        let settlement = persistedAttemptSettlement(attempt, usage);
        if (!settlement) {
          try {
            const metered = await maybeMeterProvider(tenant, openrouter, usage, { kind: "video_screenwrite", provider: "openrouter", model: SCREENWRITER_MODEL, generationId: attempt.generationId });
            settlement = attemptSettlement(metered, usage);
            attempt = { ...attempt, status: "provider_accepted", settlement, usage, candidate };
            await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt });
          } catch (billingError) {
            await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, status: "settlement_failed", usage, settlement: { status: "failed", key: cleanText(billingError?.settlementKey, 300) || null, costUsd: usage.cost, errorCode: cleanText(billingError?.code || "video_settlement_failed", 160) }, candidate } });
            throw billingError;
          }
        }
        if (!candidate) {
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, status: "rejected", rejectionCode: "screenwriter_reconciled_without_content", usage, settlement, candidate: null } });
          return { ok: true, reconciled: true, status: "rejected", project: await getProject(tenantId, projectId), message: "The saved Trinity generation was settled without another provider request. It had no recoverable screenplay content, so the active screenplay was left unchanged." };
        }
        if (typeof candidate.text !== "string") {
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, status: "rejected", rejectionCode: "screenwriter_recovery_candidate_invalid", usage, settlement, candidate } });
          return { ok: true, reconciled: true, status: "rejected", project: await getProject(tenantId, projectId), message: "The Trinity charge was reconciled, but its saved output was invalid and was not applied." };
        }
        try {
          await feature.applyCommand(tenantId, projectId, {
            type: "screenplay.set", text: candidate.text, model: SCREENWRITER_MODEL, usage,
            generationId: attempt.generationId, finishReason: candidate.finishReason || attempt.finishReason,
            truncated: candidate.truncated === true, brief: candidate.brief,
            generatedSections: candidate.generatedSections, lastTurn: candidate.lastTurn,
            sessionId: candidate.sessionId, expectedScreenplaySha256: attempt.sourceScreenplaySha256,
            expectedScreenwriterGenerationId: attempt.sourceGenerationId, attemptId: attempt.attemptId,
            settlement,
          });
          return { ok: true, reconciled: true, status: "applied", project: await getProject(tenantId, projectId), message: "The saved Trinity settlement and screenplay checkpoint were repaired without starting another provider request." };
        } catch (saveError) {
          if (!new Set(["screenwriter_stale_write", "video_screenplay_limit", "video_ai_state_large"]).has(String(saveError?.code || ""))) throw saveError;
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, status: "quarantined_stale_settled", rejectionCode: cleanText(saveError?.code || "screenwriter_recovery_stale", 120), usage, settlement, candidate } });
          return { ok: true, reconciled: true, status: "quarantined_stale_settled", project: await getProject(tenantId, projectId), message: "The Trinity charge is settled and its output remains preserved, but a newer screenplay checkpoint won the revision check, so Dominion did not overwrite it." };
        }
      }

      if (!attempt.generationId) fail(409, "screenwriter_operator_reconciliation_required", "This Trinity request has no provider generation identity. It remains on hold because Dominion cannot safely retry or dismiss an ambiguous paid request.");
      requireProviderPrivacy(body, { provider: "openrouter", model: SCREENWRITER_MODEL });
      let record;
      try { record = await openRouterGenerationRecord(attempt.generationId); }
      catch (reconciliationError) {
        try {
          const priorFailures = Number(attempt.reconciliationFailures || 0);
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, reconciliationFailures: durableGenerationVerificationFailure(reconciliationError?.code) ? Math.min(100, priorFailures + 1) : priorFailures, lastReconciliationError: cleanText(reconciliationError?.code || "screenwriter_reconciliation_failed", 160), lastReconciledAt: new Date(Number(now())).toISOString() } });
        } catch { /* The original reconciliation error remains authoritative; the next status rechecks the durable attempt. */ }
        throw reconciliationError;
      }
      let settlement = { status: "not_billed", key: null, costUsd: 0, errorCode: null };
      let status = "provider_http_rejected";
      if (record.usage.cost > 0) {
        attempt = {
          ...attempt,
          status: "provider_accepted",
          usage: record.usage,
          finishReason: record.finishReason,
          settlement: { status: "pending", key: null, costUsd: record.usage.cost, errorCode: null },
          candidate: null,
        };
        await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt });
        try {
          const metered = await maybeMeterProvider(tenant, openrouter, record.usage, { kind: "video_screenwrite", provider: "openrouter", model: SCREENWRITER_MODEL, generationId: attempt.generationId });
          settlement = attemptSettlement(metered, record.usage);
          status = "rejected";
        } catch (billingError) {
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, status: "settlement_failed", usage: record.usage, finishReason: record.finishReason, settlement: { status: "failed", key: cleanText(billingError?.settlementKey, 300) || null, costUsd: record.usage.cost, errorCode: cleanText(billingError?.code || "video_settlement_failed", 160) } } });
          throw billingError;
        }
      }
      await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, status, rejectionCode: "screenwriter_reconciled_without_content", usage: record.usage, finishReason: record.finishReason, settlement, candidate: null } });
      return { ok: true, reconciled: true, status, project: await getProject(tenantId, projectId), message: record.usage.cost > 0 ? "OpenRouter confirmed and Dominion settled the saved Trinity generation. No output content was available to apply, so the screenplay was left unchanged." : "OpenRouter confirmed that the saved Trinity generation had no charge. The screenplay was left unchanged and editing can resume." };
    } finally { activeScreenwriterProjects.delete(activeKey); screenwriterActivityVersion++; }
  }

  async function quarantineScreenwriterTurn(req, context, body) {
    if (screenwriterDraining) fail(503, "screenwriter_draining", "Dominion is finishing screenplay work for a server restart. Retry recovery after deployment completes.");
    await requireDesktop(req, context, body);
    const { tenantId } = context;
    const projectId = ensureProjectId(body.projectId);
    const activeKey = screenwriterKey(tenantId, projectId);
    requireProjectScreenwriterIdle(tenantId, projectId);
    activeScreenwriterProjects.add(activeKey);
    screenwriterActivityVersion++;
    try {
      const project = await feature.getProject(tenantId, projectId);
      let attempt = pendingScreenwriterAttempt(project);
      if (!attempt) return { ok: true, quarantined: false, status: "idle", project: await getProject(tenantId, projectId) };
      if (recoveryActionForAttempt(attempt) !== "quarantine_unrecoverable") fail(409, "screenwriter_quarantine_not_allowed", "This Trinity turn has a safer automatic reconciliation path and cannot be quarantined.");
      const expectedConfirmation = quarantineConfirmation(attempt.attemptId);
      if (String(body.confirmation || "") !== expectedConfirmation) fail(400, "screenwriter_quarantine_confirmation_required", "Confirm the exact saved Trinity attempt before quarantining it without Dominion billing.");
      const expectedAttemptId = attempt.attemptId;
      const expectedGenerationId = cleanText(attempt.generationId, 200) || null;
      const expectedUpdatedAt = cleanText(attempt.updatedAt, 80) || null;
      const reloadAttempt = async () => {
        const latestProject = await feature.getProject(tenantId, projectId);
        const latestAttempt = pendingScreenwriterAttempt(latestProject);
        const changed = !latestAttempt
          || latestAttempt.attemptId !== expectedAttemptId
          || (cleanText(latestAttempt.generationId, 200) || null) !== expectedGenerationId
          || (expectedUpdatedAt && cleanText(latestAttempt.updatedAt, 80) !== expectedUpdatedAt)
          || recoveryActionForAttempt(latestAttempt) !== "quarantine_unrecoverable";
        if (changed) fail(409, "screenwriter_quarantine_state_changed", "The saved Trinity attempt changed during its final safety check. Reload its authoritative recovery status before taking another action.");
        return latestAttempt;
      };
      const identityConflict = new Set(["screenwriter_generation_id_mismatch", "screenwriter_generation_conflict"]).has(String(attempt.rejectionCode || ""));
      if (attempt.generationId && !identityConflict) {
        requireProviderPrivacy(body, { provider: "openrouter", model: SCREENWRITER_MODEL });
        let verificationError = null;
        try { await openRouterGenerationRecord(attempt.generationId); }
        catch (error) { verificationError = error; }
        attempt = await reloadAttempt();
        if (!verificationError) {
          await feature.applyCommand(tenantId, projectId, { type: "screenwriter.attempt", attempt: { ...attempt, reconciliationFailures: 0, lastReconciliationError: null, lastReconciledAt: new Date(Number(now())).toISOString() } });
          fail(409, "screenwriter_generation_now_recoverable", "OpenRouter now confirms this Trinity generation. Use Resolve saved Trinity turn so its authoritative cost can be settled instead of quarantining it.");
        }
        if (!durableGenerationVerificationFailure(verificationError?.code)) throw verificationError;
      } else {
        attempt = await reloadAttempt();
      }
      await feature.applyCommand(tenantId, projectId, {
        type: "screenwriter.attempt",
        attempt: { ...attempt, status: "operator_quarantined", billable: false, settlement: { status: "not_billed", key: null, costUsd: 0, errorCode: null }, candidate: attempt.candidate || null },
      });
      return { ok: true, quarantined: true, status: "operator_quarantined", project: await getProject(tenantId, projectId), message: "The unrecoverable Trinity request remains in project history, was not billed by Dominion, and no longer blocks editing." };
    } finally { activeScreenwriterProjects.delete(activeKey); screenwriterActivityVersion++; }
  }

  function startScreenwriterEvents(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders?.();
  }

  function screenwriterEvent(res, event, payload) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  async function finishScreenwriterEvents(res) {
    if (res.writableEnded || res.destroyed) return;
    if (typeof res.once !== "function") { res.end(); return; }
    await new Promise((resolvePromise) => {
      const done = () => {
        res.off?.("finish", done); res.off?.("close", done); res.off?.("error", done);
        resolvePromise();
      };
      res.once("finish", done); res.once("close", done); res.once("error", done);
      res.end();
    });
  }

  async function serveMedia(req, res, tenantId, projectId, filename) {
    const id = ensureProjectId(projectId);
    const name = cleanText(filename, 200);
    if (!SAFE_MEDIA_NAME.test(name) || basename(name) !== name || name.includes("..") || !MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) fail(400, "video_media_invalid", "Invalid media filename.");
    const project = await feature.getProject(tenantId, id);
    const paidJob = (project.jobs || []).find((job) => basename(String(job.localOutput || "")) === name && Number(job.cost) > 0);
    if (paidJob && paidJob.settlement?.status !== "settled") {
      fail(402, "video_settlement_required", "This generated video is withheld until its provider charge is settled.");
    }
    const projectPaths = feature.paths(tenantId, id);
    let file = typeof media.resolveFile === "function" ? await media.resolveFile({ tenantId, projectId: id, filename: name, projectPaths: clone(projectPaths) }) : resolve(projectPaths.generated, name);
    file = resolve(String(file || ""));
    const allowedRoots = [projectPaths.generated, projectPaths.uploads, projectPaths.exports, projectPaths.renders].filter(Boolean);
    if (!allowedRoots.some((root) => contained(root, file))) fail(403, "video_media_forbidden", "That media file is outside this project.");
    let info;
    try { info = await stat(file); } catch { fail(404, "video_media_missing", "Video media not found."); }
    if (!info.isFile() || !info.size) fail(404, "video_media_missing", "Video media not found.");
    const range = requestHeader(req, "range").match(/^bytes=(\d*)-(\d*)$/);
    let start = 0, end = info.size - 1, status = 200;
    if (range) {
      if (!range[1] && range[2]) {
        const suffix = Number(range[2]);
        start = Number.isInteger(suffix) && suffix > 0 ? Math.max(0, info.size - suffix) : -1;
        end = info.size - 1;
      } else {
        start = range[1] ? Number(range[1]) : 0;
        end = range[2] ? Number(range[2]) : info.size - 1;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= info.size) {
        res.writeHead(416, { "content-range": `bytes */${info.size}`, "cache-control": "private, max-age=0" });
        res.end();
        return true;
      }
      status = 206;
    }
    const headers = { "content-type": mimeFor(file), "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
    if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    res.writeHead(status, headers);
    if (req.method === "HEAD") { res.end(); return true; }
    await pipeline(createReadStream(file, { start, end }), res);
    return true;
  }

  async function dispatch(req, res, parsed, context) {
    const method = String(req.method || "GET").toUpperCase();
    const path = parsed.pathname.slice(API_ROOT.length) || "/";
    const { tenant, tenantId } = context;

    if (method === "OPTIONS") {
      res.writeHead(204, { allow: "GET, HEAD, POST, PATCH, DELETE, OPTIONS", "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (path === "/admin/settlements") {
      if (tenant.isOwner !== true) fail(403, "video_settlement_admin_forbidden", "Video settlement repair is available only to the Dominion owner.");
      if (!settlementAdmin || typeof settlementAdmin.listHeld !== "function" || typeof settlementAdmin.inspect !== "function" || typeof settlementAdmin.repair !== "function") fail(503, "video_settlement_admin_unavailable", "Video settlement repair is not configured.");
      if (method === "GET") {
        const settlementKey = parsed.searchParams.get("settlementKey");
        if (!settlementKey) return json(res, 200, { held: settlementAdmin.listHeld() });
        try {
          const settlement = settlementAdmin.inspect(settlementKey);
          if (!settlement) fail(404, "video_settlement_not_found", "The settlement claim was not found.");
          return json(res, 200, { settlement });
        } catch (error) {
          if (error instanceof VideoHttpError) throw error;
          fail(400, cleanText(error?.code, 120).toLowerCase() || "video_settlement_key_invalid", cleanText(error?.message, 800) || "The settlement key is invalid.");
        }
      }
      if (method === "POST") {
        const body = await readJson(req);
        try {
          return json(res, 200, { ok: true, repair: settlementAdmin.repair({ settlementKey: body.settlementKey, action: body.action, confirmation: body.confirmation }) });
        } catch (error) {
          const code = cleanText(error?.code, 120).toLowerCase() || "video_settlement_repair_failed";
          const status = code.endsWith("not_found") ? 404 : code.includes("confirmation") || code.includes("invalid") ? 400 : 409;
          fail(status, code, cleanText(error?.message, 800) || "The settlement repair could not be applied.");
        }
      }
      fail(405, "method_not_allowed", "Use GET to inspect held settlements or POST to apply an explicit repair.");
    }

    if (method === "GET" && (path === "/" || path === "/config")) {
      const mobile = isMobileRequest(req, { device: parsed.searchParams.get("device") });
      const screenwriterConfigured = !!credential(openrouter.apiKey);
      let desktopCapability = null; let device;
      if (!mobile) {
        desktopCapability = issueDesktopCapability(tenantId);
        await presence("touch", { ...context, req, device: "desktop", sessionId: "" });
        device = { mobile: false, desktopSession: true };
      } else device = await desktopState(req, context, { device: "mobile" });
      return json(res, 200, {
        ok: true,
        models: clone(feature.capabilities || {}), capabilities: clone(feature.capabilities || {}),
        limits: { scenes: Number(feature.MAX_SCENES) || 100, screenplayTokens: Number(feature.MAX_SCREENPLAY_TOKENS) || 115_000, videoTracks: Number(feature.VIDEO_TRACKS) || 3, audioTracks: Number(feature.AUDIO_TRACKS) || 4 },
        // Each agent is a ladder of provider+model rungs, not one fixed model (stabilize
        // 2026-09-03). `model` names the primary (first) rung for backward compatibility;
        // `ladder` lists every rung in try-order. `configured` is true when at least one rung has
        // a credential - a single missing key no longer makes an agent appear entirely dead.
        agents: {
          director: {
            model: DEEPSEEK_PRO_MODEL,
            ladder: [{ provider: "deepseek", model: DEEPSEEK_PRO_MODEL }, { provider: "nvidia", model: NVIDIA_DEEPSEEK_MODEL }, { provider: "nvidia", model: NVIDIA_NEMOTRON_SUPER_MODEL }, { provider: "anthropic", model: SONNET_MODEL }],
            configured: !!credential(deepseek.apiKey) || !!credential(nvidia.apiKey) || !!credential(anthropic.apiKey),
          },
          visualOrchestrator: {
            model: NVIDIA_NEMOTRON_SUPER_MODEL,
            ladder: [{ provider: "nvidia", model: NVIDIA_NEMOTRON_SUPER_MODEL }, { provider: "deepseek", model: DEEPSEEK_PRO_MODEL }, { provider: "nvidia", model: NVIDIA_NEMOTRON_ULTRA_MODEL }],
            configured: !!credential(nvidia.apiKey) || !!credential(deepseek.apiKey),
          },
          screenwriter: {
            model: SCREENWRITER_MODEL,
            ladder: [{ provider: "openrouter", model: SCREENWRITER_MODEL }, { provider: "deepseek", model: DEEPSEEK_PRO_MODEL }, { provider: "anthropic", model: SONNET_MODEL }],
            configured: screenwriterConfigured,
          },
          liaison: {
            model: SONNET_MODEL,
            ladder: [{ provider: "anthropic", model: SONNET_MODEL }, { provider: "anthropic", model: HAIKU_MODEL }, { provider: "deepseek", model: DEEPSEEK_FLASH_MODEL }],
            configured: !!credential(anthropic.apiKey) || !!credential(deepseek.apiKey),
          },
        },
        screenwriter: {
          available: screenwriterConfigured,
          model: SCREENWRITER_MODEL, provider: "openrouter", reasoning: "mandatory", contextTokens: SCREENWRITER_CONTEXT_TOKENS,
          message: screenwriterConfigured ? "Trinity Large Thinking is configured through OpenRouter." : "Add OPENROUTER_API_KEY to enable Trinity Large Thinking; DeepSeek direct and Claude Sonnet 5 serve as automatic fallback rungs when Trinity fails.",
        },
        provider: { runwareConfigured: !!credential(runware.apiKey) },
        storageKey: createHash("sha256").update(`dominion-video:${tenantId}`).digest("hex").slice(0, 24),
        desktopSession: device.desktopSession,
        fullEditor: !device.mobile || device.desktopSession,
        singleGenerationOnly: device.mobile && !device.desktopSession,
        ...(desktopCapability ? { desktopCapability } : {}),
      });
    }

    if (method === "GET" && path === "/projects") return json(res, 200, { projects: await feature.listProjects(tenantId) });

    if (method === "POST" && path === "/projects") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      const project = await feature.createProject(tenantId, { name: cleanText(body.name || body.project?.name, 160) || "Untitled video" });
      if (body.state && typeof feature.checkpointProject === "function") await feature.checkpointProject(tenantId, project.id, { label: "Initial project", state: body.state, expectedScreenplaySha256: createHash("sha256").update("").digest("hex"), expectedProjectRevision: Number(project?.history?.head) || 0 });
      return json(res, 201, await getProject(tenantId, project.id));
    }

    if (method === "POST" && path === "/projects/checkpoint") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      if (typeof feature.checkpointProject !== "function") fail(501, "video_checkpoint_unavailable", "Project checkpoint storage is not available.");
      const projectId = ensureProjectId(body.projectId);
      requireProjectScreenwriterIdle(tenantId, projectId);
      const expectedScreenplaySha256 = screenplayPrecondition(body);
      const expectedProjectRevision = projectRevisionPrecondition(body);
      const label = cleanText(body.label, 200) || "Saved checkpoint";
      const saved = await feature.checkpointProject(tenantId, projectId, { label, state: clone(body.state || {}), expectedScreenplaySha256, expectedProjectRevision });
      const seq = Number(saved?.history?.head ?? saved?.head);
      const savedText = typeof saved?.screenplay?.text === "string" ? saved.screenplay.text : typeof body.state?.screenplay === "string" ? body.state.screenplay : "";
      return json(res, 200, { ok: true, projectId, projectRevision: Number.isInteger(seq) ? seq : null, screenplaySha256: createHash("sha256").update(savedText).digest("hex"), checkpoint: { label, seq: Number.isInteger(seq) ? seq : null, updatedAt: saved?.updatedAt || null } });
    }

    const historyRoute = path.match(/^\/projects\/([^/]+)\/history$/);
    if (method === "GET" && historyRoute) {
      const projectId = ensureProjectId(decodePart(historyRoute[1]));
      if (typeof feature.listCheckpoints !== "function") fail(501, "video_history_unavailable", "Project history is not available.");
      return json(res, 200, { projectId, checkpoints: await feature.listCheckpoints(tenantId, projectId) });
    }
    const restoreRoute = path.match(/^\/projects\/([^/]+)\/restore$/);
    if (method === "POST" && restoreRoute) {
      const body = await readJson(req); await requireDesktop(req, context, body);
      const projectId = ensureProjectId(decodePart(restoreRoute[1]));
      requireProjectScreenwriterIdle(tenantId, projectId);
      if (typeof feature.restoreCheckpoint !== "function") fail(501, "video_history_unavailable", "Project history is not available.");
      await feature.restoreCheckpoint(tenantId, projectId, body.seq, projectRevisionPrecondition(body));
      return json(res, 200, await getProject(tenantId, projectId));
    }
    const commandRoute = path.match(/^\/projects\/([^/]+)\/(undo|redo)$/);
    if (method === "POST" && commandRoute) {
      const body = await readJson(req); await requireDesktop(req, context, body);
      const projectId = ensureProjectId(decodePart(commandRoute[1])); const command = commandRoute[2];
      requireProjectScreenwriterIdle(tenantId, projectId);
      if (typeof feature[command] !== "function") fail(501, "video_history_unavailable", "Project history is not available.");
      await feature[command](tenantId, projectId, projectRevisionPrecondition(body));
      return json(res, 200, await getProject(tenantId, projectId));
    }

    const projectRoute = path.match(/^\/projects\/([^/]+)$/);
    if (projectRoute) {
      const projectId = ensureProjectId(decodePart(projectRoute[1]));
      if (method === "GET") return json(res, 200, await getProject(tenantId, projectId));
      const body = method === "PATCH" || method === "DELETE" ? await readJson(req) : {};
      if (method === "PATCH") {
        await requireDesktop(req, context, body);
        if (body.name != null) await feature.renameProject(tenantId, projectId, body.name);
        if (body.state != null) {
          requireProjectScreenwriterIdle(tenantId, projectId);
          if (typeof feature.checkpointProject !== "function") fail(501, "video_checkpoint_unavailable", "Project checkpoint storage is not available.");
          await feature.checkpointProject(tenantId, projectId, { label: cleanText(body.label, 200) || "Updated project", state: clone(body.state), expectedScreenplaySha256: screenplayPrecondition(body), expectedProjectRevision: projectRevisionPrecondition(body) });
        }
        return json(res, 200, await getProject(tenantId, projectId));
      }
      if (method === "DELETE") {
        await requireDesktop(req, context, body);
        requireProjectScreenwriterIdle(tenantId, projectId);
        if (activeAiProjects.has(screenwriterKey(tenantId, projectId))) fail(409, "video_ai_busy", "The video AI team is still saving a paid planning turn for this project. Wait for its durable checkpoint before deleting the project.");
        if (body.confirmDelete !== true) fail(400, "video_delete_confirmation_required", "Confirm project deletion before removing it.");
        return json(res, 200, await feature.deleteProject(tenantId, projectId, { confirmDelete: true }));
      }
    }

    if (method === "GET" && path === "/jobs/recover-mobile") {
      if (typeof feature.recoverTemporaryJobs !== "function") fail(501, "video_job_recovery_unavailable", "Mobile video job recovery is not available.");
      return json(res, 200, { jobs: await feature.recoverTemporaryJobs(tenantId), status: "resume_by_polling" });
    }

    if (method === "GET" && path === "/jobs/recover") {
      const projectId = ensureProjectId(parsed.searchParams.get("projectId"));
      await feature.getProject(tenantId, projectId);
      if (typeof feature.recoverJobs !== "function") fail(501, "video_job_recovery_unavailable", "Video job recovery is not available.");
      return json(res, 200, { projectId, jobs: await feature.recoverJobs(tenantId, projectId), status: "resume_by_polling" });
    }

    if (method === "POST" && path === "/jobs") {
      const body = await readJson(req);
      requireProviderPrivacy(body, { provider: "runware" });
      const device = await desktopState(req, context, body);
      const requestedProjectId = cleanText(body.projectId, 80);
      const singleGeneration = !requestedProjectId && device.mobile && !device.desktopSession;
      if (!singleGeneration && !device.desktopSession) fail(409, device.mobile ? "desktop_session_required" : "desktop_capability_required", device.mobile ? "A desktop session must be running to change a saved project from mobile. Start a single mobile generation without a project instead." : "Refresh Dominion Video on this desktop before starting persistent generation work.");
      await generationBilling(tenant);
      screenOrFail(screenContent, tenant, body.prompt);
      let projectId = requestedProjectId;
      if (!projectId) {
        const project = await feature.createProject(tenantId, { name: singleGeneration ? "Mobile single video" : cleanText(body.projectName, 160) || "Untitled video", temporary: singleGeneration });
        projectId = project.id;
      } else {
        projectId = ensureProjectId(projectId);
        await feature.getProject(tenantId, projectId);
        if (device.mobile && !device.desktopSession) fail(409, "desktop_session_required", "A desktop session must be running to change a saved project from mobile. Start a single mobile generation without a project instead.");
      }
      const frameImages = Array.isArray(body.frameImages) ? clone(body.frameImages) : Array.isArray(body.images) ? clone(body.images) : [];
      const request = {
        model: cleanText(body.model, 200),
        mode: cleanText(body.mode, 30) || (frameImages.length ? "image" : "text"),
        // The scene this generation belongs to. The client has sent this since the studio
        // shipped and the server never read it, so finished clips could not attach to their
        // storyboard scene - the UI matches clips BY sceneId (2026-08-05).
        sceneId: singleGeneration ? null : cleanText(body.sceneId, 128) || null,
        prompt: cleanText(body.prompt, 100_000),
        frameImages,
        referenceImages: Array.isArray(body.referenceImages) ? clone(body.referenceImages) : [],
        referenceVideos: Array.isArray(body.referenceVideos) ? clone(body.referenceVideos) : [],
        referenceAudios: Array.isArray(body.referenceAudios) ? clone(body.referenceAudios) : [],
        sourceVideo: cleanText(body.sourceVideo, 8 * 1024 * 1024), videoId: cleanText(body.videoId, 500), shots: Array.isArray(body.shots) ? clone(body.shots) : [],
        idempotencyKey: cleanText(body.idempotencyKey, 128),
        duration: Number(body.duration || 5),
        ratio: cleanText(body.ratio, 20) || "16:9",
        resolution: cleanText(body.resolution, 20) || "720p",
        generateAudio: body.generateAudio ?? body.audio ?? true,
      };
      const submitted = await feature.submitGeneration(tenantId, projectId, request, { tenant: plainTenant(tenant) });
      return json(res, 202, { ...clone(submitted), id: submitted.jobId, projectId, status: submitted.status || "queued", singleGeneration, message: submitted.deduplicated ? "That generation request is already saved; Dominion will keep polling the original task." : submitted.status === "retrying" ? "Runware did not confirm the saved task yet; Dominion will recover it by task UUID." : "Video generation was queued and will be verified before it reaches the timeline." });
    }

    const jobRoute = path.match(/^\/jobs\/([^/]+)$/);
    if (method === "GET" && jobRoute) {
      const jobId = ensureJobId(decodePart(jobRoute[1]));
      const located = await findJob(tenantId, jobId, parsed.searchParams.get("projectId"));
      let job = await feature.pollJob(tenantId, located.projectId, jobId);
      const settlementCacheKey = `${tenantId}:${jobId}`;
      if (job.status === "ready" && Number(job.cost) > 0 && job.settlement?.status !== "settled" && !settledJobs.has(settlementCacheKey)) {
        const settlement = await meterUsage(tenant, Number(job.cost), { kind: "video_generation", provider: "runware", jobId, projectId: located.projectId });
        job = typeof feature.markJobSettled === "function"
          ? await feature.markJobSettled(tenantId, located.projectId, jobId, settlement || {})
          : { ...job, settlement: { status: "settled", costUsd: Number(job.cost) } };
        settledJobs.add(settlementCacheKey);
      }
      if (job.status === "ready" && job.output && !job.localOutput) {
        job = await feature.downloadJobOutput(tenantId, located.projectId, jobId);
        if (job.downloadError || !job.localOutput) fail(502, "video_download_failed", "The provider finished the video, but Dominion could not save and verify it. The provider URL remains recorded for recovery.");
      }
      const mediaUrl = job.localOutput ? `${API_ROOT}/media/${encodeURIComponent(located.projectId)}/${encodeURIComponent(basename(job.localOutput))}` : null;
      let clips = Array.isArray(job.clips) ? clone(job.clips) : [];
      if (!clips.length && job.localOutput) {
        try { clips = (await getProject(tenantId, located.projectId)).clips.filter((item) => item.mediaJobId === jobId); } catch { /* The durable job still carries enough data for a recovery response. */ }
      }
      clips = clips.map((item) => ({ ...item, mediaFile: item.mediaFile || basename(job.localOutput || ""), ...(item.src ? {} : mediaUrl ? { src: mediaUrl } : {}) }));
      const clip = clips.find((item) => item.trackId === "v1" || item.type === "video") || null;
      const audioClip = clips.find((item) => item.trackId === "a1" || item.type === "audio") || null;
      const projectRevision = Number((await feature.getProject(tenantId, located.projectId))?.history?.head) || 0;
      return json(res, 200, { ...clone(job), jobId, projectId: located.projectId, projectRevision, mediaUrl, hasAudio: !!job.media?.hasAudio, clips, clip, audioClip, retryAfterMs: Number(job.retry?.delayMs) || 3_000, message: job.status === "ready" ? "Video saved and verified." : job.status === "failed" ? cleanText(job.providerError?.message, 800) || "Video generation failed. No completed clip was added." : "Video generation is still running." });
    }

    const deliveredRoute = path.match(/^\/jobs\/([^/]+)\/delivered$/);
    if (method === "POST" && deliveredRoute) {
      if (typeof feature.markJobDelivered !== "function") fail(501, "video_delivery_unavailable", "Mobile video delivery acknowledgement is unavailable.");
      const body = await readJson(req); const jobId = ensureJobId(decodePart(deliveredRoute[1]));
      const located = await findJob(tenantId, jobId, body.projectId);
      const job = await feature.markJobDelivered(tenantId, located.projectId, jobId);
      return json(res, 200, { ok: true, jobId, projectId: located.projectId, delivery: clone(job.delivery) });
    }

    if (method === "GET" && path === "/screenwriter/status") {
      const projectId = ensureProjectId(parsed.searchParams.get("projectId"));
      const key = screenwriterKey(tenantId, projectId);
      let project, attempt, active, stable = false;
      for (let reads = 0; reads < 4; reads++) {
        const version = screenwriterActivityVersion;
        project = await feature.getProject(tenantId, projectId);
        active = activeScreenwriterProjects.has(key);
        attempt = pendingScreenwriterAttempt(project);
        if (version === screenwriterActivityVersion) { stable = true; break; }
      }
      if (!stable) return json(res, 200, { projectId, active: true, pending: true, status: "active", actionRequired: false, retryAfterMs: 1_000, message: "Trinity state changed while Dominion checked it; the project will be checked again." });
      const status = active ? "active" : cleanText(attempt?.status, 80) || "idle";
      const recoveryAction = active ? null : recoveryActionForAttempt(attempt);
      const operatorReference = !active && attempt ? cleanText(attempt?.settlement?.key, 300) || cleanText(attempt?.attemptId, 128) || null : null;
      return json(res, 200, {
        projectId, active, pending: active || !!attempt,
        status,
        actionRequired: !active && !!attempt,
        recoveryAction,
        operatorReference,
        quarantineConfirmation: recoveryAction === "quarantine_unrecoverable" ? quarantineConfirmation(attempt?.attemptId) : null,
        retryAfterMs: active ? 3_000 : null,
        message: active ? "Trinity is still writing; Dominion will refresh this project when the durable turn finishes." : recoveryAction === "quarantine_unrecoverable" ? "This Trinity response cannot be safely recovered. You can preserve it in history without Dominion billing, then resume editing." : attempt ? `This Trinity request needs reconciliation before another screenplay change can start.${operatorReference ? ` Operator reference: ${operatorReference}.` : ""}` : "The screenwriter is idle.",
      });
    }

    if (method === "POST" && path === "/screenwriter/reconcile") {
      const body = await readJson(req);
      const result = await trackScreenwriterTurn(reconcileScreenwriterTurn(req, context, body));
      return json(res, 200, result);
    }

    if (method === "POST" && path === "/screenwriter/quarantine") {
      const body = await readJson(req);
      const result = await trackScreenwriterTurn(quarantineScreenwriterTurn(req, context, body));
      return json(res, 200, result);
    }

    if (method === "POST" && path === "/screenwrite") {
      const body = await readJson(req);
      const eventStream = requestHeader(req, "accept").toLowerCase().includes("text/event-stream");
      if (!eventStream) fail(406, "screenwriter_stream_required", "Trinity screenwriting requires the event-stream transport so long reasoning turns remain visible and recoverable through the deployment edge. No provider call was made.");
      const prepared = await prepareScreenwriterTurn(req, context, body);
      startScreenwriterEvents(res);
      screenwriterEvent(res, "progress", { stage: "accepted", message: "Trinity Large Thinking is preparing the next durable screenplay section." });
      const heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": dominion-screenwriter\n\n");
      }, 15_000);
      heartbeat.unref?.();
      await trackScreenwriterTurn((async () => {
        try {
          const result = await executeScreenwriterTurn(prepared);
          screenwriterEvent(res, "result", result);
        } catch (error) {
          const failure = errorPayload(error, randomUUID());
          screenwriterEvent(res, "error", { ...failure.body, status: failure.status });
        } finally {
          clearInterval(heartbeat);
          await finishScreenwriterEvents(res);
        }
      })());
      return true;
    }

    if (method === "POST" && path === "/chat") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      if (screenwriterDraining) fail(503, "video_ai_draining", "Dominion is finishing active video AI checkpoints for a server restart. Retry after the deployment completes; no provider call was made.");
      requireProviderPrivacy(body, { provider: "deepseek", model: DEEPSEEK_PRO_MODEL });
      const projectId = ensureProjectId(body.projectId);
      const expectedProjectRevision = projectRevisionPrecondition(body);
      const message = cleanText(body.message, 100_000);
      if (!message) fail(400, "video_chat_message_required", "Enter a message for the video team.");
      screenOrFail(screenContent, tenant, message);
      const activeKey = screenwriterKey(tenantId, projectId);
      if (activeAiProjects.has(activeKey)) fail(409, "video_ai_busy", "The video AI team is already preparing a saved turn for this project. Wait for that checkpoint; no duplicate provider calls were made.");
      if (activeScreenwriterProjects.has(activeKey)) fail(409, "screenwriter_busy", "Trinity is already writing for this project. Wait for that saved turn before starting the video AI team; no provider calls were made.");
      activeAiProjects.add(activeKey);
      return trackAiTurn((async () => {
        try {
          await modelBilling(tenant);
          const internalProject = await feature.getProject(tenantId, projectId);
          if (pendingScreenwriterAttempt(internalProject)) fail(409, "screenwriter_reconciliation_required", "This project has Trinity work awaiting reconciliation. Resolve it before starting the video AI team; no provider calls were made.");
          const project = await getProject(tenantId, projectId);
          if (Number(project?.projectRevision) !== expectedProjectRevision) fail(409, "video_project_revision_stale", "The project changed before the video AI team started. Refresh it and send the request again; no provider calls were made.");
          const deadlineAt = Number(now()) + Math.min(AI_TURN_TIMEOUT_MS, Math.max(30_000, Number(nvidia.aiTurnTimeoutMs) || AI_TURN_TIMEOUT_MS));
          const director = await callDirector(tenant, project, message, body.context, deadlineAt);
          /*
           * THE ORCHESTRATOR RUNS ONLY WHEN A STORYBOARD IS ACTUALLY WANTED (2026-08-05).
           * Every message used to run a 550-billion-parameter planner AND overwrite the whole
           * storyboard from its output - so idle conversation was expensive, and a stray remark
           * could silently rewrite scenes the user had edited. Now plain chat is director plus
           * producer, and the storyboard is only built when the person taps the chip.
           */
          const buildStoryboard = String(body.action || "chat") === "build_storyboard";
          let visual = { available: false, model: NVIDIA_NEMOTRON_SUPER_MODEL, plan: null, usage: null, error: null, skipped: true };
          if (buildStoryboard) {
            try { visual = await callVisualOrchestrator(tenant, project, message, director, deadlineAt); }
            catch (error) {
              if (!(error instanceof VideoHttpError) || !String(error.code || "").includes("visual_orchestrator")) throw error;
              visual = { available: false, model: NVIDIA_NEMOTRON_SUPER_MODEL, plan: null, usage: null, error: { code: error.code, message: error.message } };
            }
          }
          const liaison = await callLiaison(tenant, project, message, director, visual, deadlineAt);
          const persisted = await persistAiTurn(tenantId, projectId, expectedProjectRevision, message, director, visual, liaison, { buildStoryboard });
          const stalePlan = visual.available && persisted.applyStatus === "quarantined_stale";
          const visualError = stalePlan ? { code: "visual_plan_quarantined_stale", message: "The project changed while the AI team was working. Its plan was saved for history but did not overwrite the newer storyboard." } : clone(visual.error);
          const routing = director.routing || { ...DEFAULT_ROUTING };
          return json(res, 200, {
            reply: liaison.reply, projectId,
            director: { directive: director.directive, model: director.model, servedBy: clone(director.servedBy || null) },
            routing: clone(routing),
            chips: chipsFor(routing),
            sceneDraft: routing.readyToGenerate ? clone(routing.sceneDraft) : null,
            visualOrchestrator: { model: visual.model, available: visual.available, skipped: visual.skipped === true, applied: persisted.planApplied, applyStatus: persisted.applyStatus, plan: clone(visual.plan), error: visualError, servedBy: clone(visual.servedBy || null) },
            liaison: { model: liaison.model, servedBy: clone(liaison.servedBy || null) }, saved: true,
            // A skipped orchestrator is not a degraded one: it was never asked to run.
            degraded: visual.skipped || (visual.available && !stalePlan) ? [] : [stalePlan ? "visualPlanStale" : "visualOrchestrator"],
          });
        } finally {
          activeAiProjects.delete(activeKey);
        }
      })());
    }

    if (method === "POST" && path === "/uploads") {
      await requireDesktop(req, context, {});
      if (typeof media.importUpload !== "function") fail(503, "video_import_unavailable", "Video import is not available on this server.");
      const projectId = ensureProjectId(parsed.searchParams.get("projectId")); const filename = cleanText(parsed.searchParams.get("filename") || requestHeader(req, "x-dominion-filename"), 200);
      if (!filename) fail(400, "video_upload_name", "A media filename is required.");
      await feature.getProject(tenantId, projectId);
      const result = await media.importUpload({ req, tenantId, projectId, filename, projectPaths: clone(feature.paths(tenantId, projectId)) });
      const mediaUrl = `${API_ROOT}/media/${encodeURIComponent(projectId)}/${encodeURIComponent(result.filename)}`;
      return json(res, 201, { ...clone(result), projectId, mediaUrl, message: "Media imported and verified." });
    }

    if (method === "POST" && path === "/exports") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      if (typeof media.exportProject !== "function") fail(503, "video_export_unavailable", "The video encoder is not available on this server.");
      const projectId = ensureProjectId(body.projectId);
      const project = await getProject(tenantId, projectId);
      const result = await media.exportProject({ tenantId, projectId, project: clone(project), request: clone(body), projectPaths: clone(feature.paths(tenantId, projectId)) });
      if (!result) fail(502, "video_export_failed", "The encoder returned no export record. Nothing was marked complete.");
      const projectRevision = Number((await feature.getProject(tenantId, projectId))?.history?.head) || 0;
      return json(res, result.status === "ready" ? 200 : 202, { ...clone(result), projectId, projectRevision, message: result.message || (result.status === "ready" ? "Export completed and verified." : "Export queued. It will be verified before download.") });
    }

    if (method === "POST" && path === "/presence") {
      const body = await readJson(req, 64 * 1024);
      const status = await desktopState(req, context, body);
      if (!status.mobile && !status.desktopSession) fail(409, "desktop_capability_required", "Refresh Dominion Video on this desktop to renew its session capability.");
      return json(res, 200, { ok: true, desktopSession: status.desktopSession !== false, expiresInMs: presenceTtlMs });
    }

    const mediaRoute = path.match(/^\/media\/([^/]+)\/([^/]+)$/);
    if ((method === "GET" || method === "HEAD") && mediaRoute) return serveMedia(req, res, tenantId, decodePart(mediaRoute[1]), decodePart(mediaRoute[2]));

    fail(404, "video_route_missing", "Video endpoint not found.");
  }

  async function handle(req, res, u) {
    const parsed = u instanceof URL ? u : new URL(typeof u === "string" ? u : req.url || "/", "http://dominion.local");
    if (parsed.pathname !== API_ROOT && !parsed.pathname.startsWith(API_ROOT + "/")) return false;
    const requestId = randomUUID();
    try {
      const context = await tenantFor(req);
      enforceRateLimit(context.tenantId, String(req.method || "GET").toUpperCase(), parsed.pathname);
      return await dispatch(req, res, parsed, context);
    } catch (error) {
      // A stream can fail after its status and media headers are on the wire. A second JSON response
      // would corrupt the media body; close the response and let the client retry its Range request.
      if (res.headersSent) {
        if (typeof res.destroy === "function") res.destroy(error);
        else if (!res.writableEnded) res.end();
        return true;
      }
      const out = errorPayload(error, requestId);
      return json(res, out.status, out.body);
    }
  }

  /*
   * BOOT-TIME MODEL PROBE (LANE-video required behavior #6). Each agent's first rung gets a
   * 1-token probe request; a rung that 4xx's is demoted (skipped first, not blocked - see
   * runAgentLadder) until the next hourly probe. 5xx/timeout/network errors do NOT demote - those
   * are exactly the transient failures the ladder itself already recovers from, and demoting on a
   * blip would just make the next real turn try a healthy-but-untested rung for no reason. This
   * never runs during tests (bootProbe defaults to false) and never blocks boot: it is scheduled
   * on the next tick and repeats hourly, both un-refed so it cannot keep the process alive.
   */
  function bootProbeCandidates() {
    const deepseekUrl = endpoint(deepseek.baseUrl || "https://api.deepseek.com", "/chat/completions");
    const nvidiaUrl = endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions");
    const anthropicUrl = endpoint(anthropic.baseUrl || "https://api.anthropic.com", "/v1/messages");
    const openrouterUrl = cleanText(openrouter.url, 2_000) || endpoint(openrouter.baseUrl || "https://openrouter.ai/api/v1", "/chat/completions");
    const probeMessages = [{ role: "user", content: "Reply with one word: OK" }];
    return [
      { agent: "director", provider: "deepseek", model: DEEPSEEK_PRO_MODEL, apiKey: credential(deepseek.apiKey), probe: () => callOpenAiStyleTransport({ provider: "deepseek_director", apiKey: credential(deepseek.apiKey), url: deepseekUrl, model: DEEPSEEK_PRO_MODEL, messages: probeMessages, maxTokens: 1, temperature: 0, topP: 1, timeoutMs: 15_000 }) },
      { agent: "visual_orchestrator", provider: "nvidia", model: NVIDIA_NEMOTRON_SUPER_MODEL, apiKey: credential(nvidia.apiKey), probe: () => callOpenAiStyleTransport({ provider: "nvidia_visual_orchestrator", apiKey: credential(nvidia.apiKey), url: nvidiaUrl, model: NVIDIA_NEMOTRON_SUPER_MODEL, messages: probeMessages, maxTokens: 1, temperature: 0, topP: 1, timeoutMs: 15_000, extraBody: { chat_template_kwargs: { enable_thinking: false } } }) },
      // A raw completion, never the reconciliation-aware Trinity path: a boot probe must not create a durable provider attempt on any project.
      { agent: "screenwriter", provider: "openrouter", model: SCREENWRITER_MODEL, apiKey: credential(openrouter.apiKey), probe: () => providerPost(fetchImpl, openrouterUrl, { provider: "openrouter_trinity_probe", headers: { Authorization: `Bearer ${credential(openrouter.apiKey)}` }, timeoutMs: 15_000, retryAmbiguous: false, body: { model: SCREENWRITER_MODEL, stream: false, messages: probeMessages, max_tokens: 1 } }) },
      { agent: "liaison", provider: "anthropic", model: SONNET_MODEL, apiKey: credential(anthropic.apiKey), probe: () => callAnthropicTransport({ apiKey: credential(anthropic.apiKey), url: anthropicUrl, model: SONNET_MODEL, messages: probeMessages, maxTokens: 1, timeoutMs: 15_000, version: anthropic.version }) },
    ];
  }
  async function runBootProbe() {
    for (const candidate of bootProbeCandidates()) {
      if (!candidate.apiKey) continue; // nothing to probe - unconfigured, not demoted (the ladder already skips on missing keys).
      try {
        await candidate.probe();
        recordRungHealth(candidate.agent, candidate.provider, candidate.model, true);
        console.log(`[video] boot probe: ${candidate.agent} rung 1 (${candidate.provider}/${candidate.model}) is live.`);
      } catch (error) {
        const status = Number(error?.status);
        const demote = Number.isInteger(status) && status >= 400 && status < 500;
        if (demote) recordRungHealth(candidate.agent, candidate.provider, candidate.model, false, error);
        console.log(`[video] boot probe: ${candidate.agent} rung 1 (${candidate.provider}/${candidate.model}) ${demote ? "demoted until the next hourly probe" : "did not answer (left active - not a 4xx)"}: ${cleanText(error?.code || error?.message, 200)}`);
      }
    }
  }
  let bootProbeTimer = null;
  if (bootProbe) {
    const kickoff = () => { runBootProbe().catch((error) => console.error("[video] boot probe crashed:", error?.message || error)); };
    setTimeout(kickoff, 0).unref?.();
    bootProbeTimer = setInterval(kickoff, 60 * 60 * 1000);
    bootProbeTimer.unref?.();
  }

  return { handle, drain, activeScreenwriterTurns: () => activeScreenwriterTurns.size, runBootProbe, rungHealth };
}
