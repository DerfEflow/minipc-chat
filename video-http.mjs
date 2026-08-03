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

const API_ROOT = "/api/video";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const MAX_SCREENPLAY_CHARS = 460_000;
const PALMYRA_MODEL = "writer/palmyra-creative-122b";
const DIRECTOR_MODEL = "deepseek-ai/deepseek-v4-pro";
const VISUAL_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const SONNET_MODEL = "claude-sonnet-5";
const PALMYRA_CONTEXT_TOKENS = 115_000;
const LONG_CONTEXT_TOKENS = 1_000_000;
const DIRECTOR_COMPACT_AT = 700_000;
const CONTEXT_SAFETY_TOKENS = 8_192;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_PROJECT_ID = /^[a-f0-9-]{36}$/i;
const SAFE_MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/;
const MEDIA_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".jpg", ".jpeg", ".png", ".webp", ".json"]);

class VideoHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "VideoHttpError";
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new VideoHttpError(status, code, message); };
const clone = (value) => value == null ? value : structuredClone(value);
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

function ensureJobId(value) {
  const id = cleanText(value, 128);
  if (!SAFE_ID.test(id)) fail(400, "video_job_invalid", "A valid video job id is required.");
  return id;
}

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch { fail(400, "video_path_invalid", "The video request path is invalid."); }
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
    screenplay: state.screenplay?.text || "",
    scenes: clone(state.scenes || []),
    tracks,
    clips,
    ui: clone(state.ui || {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ai: clone(state.ai),
  };
}

function providerMessage(body) {
  return cleanText(body?.error?.message || body?.error || body?.detail || body?.message, 800);
}

async function providerPost(fetchImpl, url, { headers, body, timeoutMs = 120_000, provider }) {
  if (typeof fetchImpl !== "function") fail(503, `${provider}_unavailable`, `${provider} is unavailable on this server.`);
  if (!url) fail(503, `${provider}_not_configured`, `${provider} is not configured.`);
  let lastNetworkError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try { response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal }); }
    catch (error) {
      lastNetworkError = error;
      if (error?.name === "AbortError") fail(504, `${provider}_timeout`, `${provider} did not respond before the request deadline.`);
      if (attempt < 2) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 400 * (2 ** attempt))); continue; }
      fail(502, `${provider}_network_error`, `${provider} could not be reached after automatic retries. No fallback model was used.`);
    } finally { clearTimeout(timer); }
    let raw = "";
    try { raw = await response.text(); } catch { fail(502, `${provider}_invalid_response`, `${provider} returned an unreadable response.`); }
    if (Buffer.byteLength(raw) > MAX_PROVIDER_BYTES) fail(502, `${provider}_response_too_large`, `${provider} returned an unexpectedly large response.`);
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { fail(502, `${provider}_invalid_response`, `${provider} returned invalid JSON.`); }
    if (response.ok) return data;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retryAfter = Math.min(5_000, Math.max(0, Number(response.headers.get("retry-after") || 0) * 1000));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryAfter || 400 * (2 ** attempt)));
      continue;
    }
    fail(response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, `${provider}_http_${response.status}`, providerMessage(data) || `${provider} rejected the request.`);
  }
  fail(502, `${provider}_network_error`, `${provider} could not be reached. ${String(lastNetworkError?.message || "")}`.trim());
}

function openAiText(data, provider) {
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text || "").join("") : String(content || "");
  if (!text.trim()) fail(502, `${provider}_empty_response`, `${provider} returned no usable text.`);
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
  screenContent,
  fetch: fetchImpl = globalThis.fetch,
  runware = {},
  nvidia = {},
  anthropic = {},
  desktopPresence = null,
  now = Date.now,
} = {}) {
  if (!feature || typeof feature !== "object") throw new TypeError("feature is required");
  if (typeof resolveTenant !== "function") throw new TypeError("resolveTenant is required");
  if (typeof screenContent !== "function") throw new TypeError("screenContent is required");

  const localPresence = new Map();
  const settledJobs = new Set();
  const rateBuckets = new Map();
  const desktopCapabilities = new Map();
  const presenceTtlMs = Math.max(15_000, Number(desktopPresence?.ttlMs) || 90_000);

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
    if (tenant.isOwner || typeof meter !== "function" || typeof providerConfig?.costForUsage !== "function") return;
    const cost = await providerConfig.costForUsage(clone(usage || {}), metadata);
    if (Number(cost) > 0) await meterUsage(tenant, Number(cost), { ...metadata, billingId: randomUUID() });
  }

  async function callPalmyra(tenant, project, prompt) {
    const apiKey = credential(nvidia.apiKey);
    if (!apiKey || nvidia.palmyraEnabled !== true) fail(503, "palmyra_not_configured", "Palmyra Creative is not enabled for this NVIDIA account. Configure a production endpoint entitlement before screenwriting; no substitute model was used.");
    const maxTokens = Math.min(16_384, Math.max(512, Number(nvidia.palmyraMaxTokens) || 8_192));
    const messages = [
      { role: "system", content: "You are Dominion's screenwriter. Write vivid, production-ready screenplay prose with scene headings, action, dialogue, continuity, visual direction, and sound cues. Preserve the user's intent. Return only the screenplay text. Never claim a scene was generated or filmed." },
      { role: "user", content: `Project: ${cleanText(project?.project?.name || project?.name, 300)}\n\nStory brief or existing screenplay:\n${prompt}` },
    ];
    enforceContextWindow("video_screenplay_context_limit", "The Palmyra screenwriter request", messages, PALMYRA_CONTEXT_TOKENS, maxTokens);
    const body = await providerPost(fetchImpl, endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions"), {
      provider: "nvidia_palmyra",
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: Number(nvidia.timeoutMs) || 180_000,
      body: {
        model: PALMYRA_MODEL,
        stream: false,
        messages,
        temperature: Number.isFinite(Number(nvidia.palmyraTemperature)) ? Number(nvidia.palmyraTemperature) : 0.8,
        max_tokens: maxTokens,
      },
    });
    await maybeMeterProvider(tenant, nvidia, body.usage, { kind: "video_screenwrite", provider: "nvidia", model: PALMYRA_MODEL });
    return { text: openAiText(body, "nvidia_palmyra"), usage: body.usage || null, model: PALMYRA_MODEL };
  }

  async function callDirector(tenant, project, message, context) {
    const apiKey = credential(nvidia.apiKey);
    const configuredModel = cleanText(nvidia.directorModel || DIRECTOR_MODEL, 200);
    if (configuredModel !== DIRECTOR_MODEL) fail(503, "director_model_mismatch", `Video creative direction requires ${DIRECTOR_MODEL}; no substitute model was used.`);
    const model = DIRECTOR_MODEL;
    if (!apiKey) fail(503, "director_not_configured", "DeepSeek V4 Pro is not configured on the NVIDIA endpoint. No substitute model was used.");
    let conversation = Array.isArray(project?.messages) ? project.messages : [];
    const directorState = project?.ai?.director?.state || {};
    let compactedSummary = cleanText(directorState.compactedSummary, 100_000);
    let compaction = null;
    const directorSystem = "You are Dominion's creative director. Plan the whole video and coordinate the screenwriter and liaison. Give a precise change directive based only on the persisted project and the user's request. Consider purpose, destination, duration, aspect ratio, resolution, scene order, continuity, image needs, sound, and efficient high-quality model use. Do not say work is complete. Return only the directive for the liaison.";
    const makeProjectContext = () => JSON.stringify({ project: project?.project, screenplay: project?.screenplay, scenes: project?.scenes, timeline: { tracks: project?.tracks, clips: project?.clips }, conversationSummary: compactedSummary || null, recentConversation: conversation, requestContext: context || {} });
    const projected = requestTokenEstimate([{ role: "system", content: directorSystem }, { role: "user", content: `${makeProjectContext()}\n\nUser request:\n${message}` }]);
    if ((project?.ai?.director?.compactionRequired || projected >= DIRECTOR_COMPACT_AT) && conversation.length) {
      let lastUsage = null;
      for (const chunk of conversationChunks(conversation)) {
        const compactionMessages = [
          { role: "system", content: "Compact this video-project conversation into a faithful working brief. Preserve every unresolved decision, character/visual continuity fact, user constraint, scene change, model decision, and failure. Remove repetition only. Return the brief alone." },
          { role: "user", content: JSON.stringify({ priorSummary: compactedSummary, conversation: chunk }) },
        ];
        enforceContextWindow("video_director_context_limit", "The DeepSeek conversation-compaction request", compactionMessages, LONG_CONTEXT_TOKENS, 16_384);
        const compacted = await providerPost(fetchImpl, endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions"), {
          provider: "nvidia_director_compaction", headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: Number(nvidia.timeoutMs) || 180_000,
          body: { model, stream: false, messages: compactionMessages, temperature: 0.1, top_p: 0.95, max_tokens: 16_384, chat_template_kwargs: { thinking: false } },
        });
        compactedSummary = openAiText(compacted, "nvidia_director_compaction");
        lastUsage = compacted.usage || null;
        await maybeMeterProvider(tenant, nvidia, compacted.usage, { kind: "video_director_compaction", provider: "nvidia", model });
      }
      compaction = { summary: compactedSummary, usage: lastUsage, atPercent: 70 };
      conversation = [];
    }
    const projectContext = makeProjectContext();
    const maxTokens = Math.min(16_384, Math.max(512, Number(nvidia.directorMaxTokens) || 512));
    const messages = [
      { role: "system", content: directorSystem },
      { role: "user", content: `${projectContext}\n\nUser request:\n${message}` },
    ];
    enforceContextWindow("video_director_context_limit", "The DeepSeek creative-director request", messages, LONG_CONTEXT_TOKENS, maxTokens);
    const body = await providerPost(fetchImpl, endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions"), {
      provider: "nvidia_director",
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: Number(nvidia.timeoutMs) || 180_000,
      body: {
        model,
        stream: false,
        messages,
        temperature: Number.isFinite(Number(nvidia.directorTemperature)) ? Number(nvidia.directorTemperature) : 1,
        top_p: Number.isFinite(Number(nvidia.directorTopP)) ? Number(nvidia.directorTopP) : 0.95,
        max_tokens: maxTokens,
        chat_template_kwargs: { thinking: false },
      },
    });
    await maybeMeterProvider(tenant, nvidia, body.usage, { kind: "video_director", provider: "nvidia", model });
    return { directive: openAiText(body, "nvidia_director"), usage: body.usage || null, model, compaction };
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

  async function callVisualOrchestrator(tenant, project, message, director) {
    const apiKey = credential(nvidia.apiKey);
    const configuredModel = cleanText(nvidia.visualModel || VISUAL_MODEL, 200);
    if (configuredModel !== VISUAL_MODEL) fail(503, "visual_orchestrator_model_mismatch", `The visual orchestrator requires ${VISUAL_MODEL}; no substitute model was used.`);
    const model = VISUAL_MODEL;
    if (!apiKey) fail(503, "visual_orchestrator_not_configured", `The visual orchestrator ${VISUAL_MODEL} is not configured. No substitute model was used.`);
    const conversation = director.compaction?.summary ? { compactedSummary: director.compaction.summary } : project?.messages || [];
    const source = JSON.stringify({ screenplay: project?.screenplay, conversation, currentScenes: project?.scenes || [], projectSettings: project?.project, userRequest: message, directorPlan: director.directive });
    const maxTokens = Math.min(16_384, Math.max(512, Number(nvidia.visualMaxTokens) || 8_192));
    const messages = [
      { role: "system", content: "You are Dominion's visual orchestrator. Read the creative director plan, screenplay, and saved conversation, then produce the images needed in exact story order. Return JSON only in this shape: {\"scenes\":[{\"order\":1,\"sceneId\":\"scene_1\",\"title\":\"\",\"imagePrompt\":\"\",\"videoPrompt\":\"\",\"continuity\":\"\",\"suggestedVideoModel\":\"\"}]}. Use no more than 100 scenes. Image prompts must be specific enough to preserve characters, wardrobe, location, lighting, composition, lens, and continuity. Do not claim any image or video was generated." },
      { role: "user", content: source },
    ];
    enforceContextWindow("video_visual_context_limit", "The Nemotron visual-orchestrator request", messages, LONG_CONTEXT_TOKENS, maxTokens);
    const body = await providerPost(fetchImpl, endpoint(nvidia.baseUrl || "https://integrate.api.nvidia.com/v1", "/chat/completions"), {
      provider: "nvidia_visual_orchestrator",
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: Number(nvidia.timeoutMs) || 180_000,
      body: {
        model,
        messages,
        stream: false,
        temperature: Number.isFinite(Number(nvidia.visualTemperature)) ? Number(nvidia.visualTemperature) : 1,
        top_p: Number.isFinite(Number(nvidia.visualTopP)) ? Number(nvidia.visualTopP) : 0.95,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: false },
      },
    });
    await maybeMeterProvider(tenant, nvidia, body.usage, { kind: "video_visual_orchestration", provider: "nvidia", model });
    return { available: true, plan: visualPlanFromText(openAiText(body, "nvidia_visual_orchestrator")), usage: body.usage || null, model };
  }

  async function callLiaison(tenant, project, message, director, visual) {
    const apiKey = credential(anthropic.apiKey);
    if (anthropic.model && anthropic.model !== SONNET_MODEL) fail(503, "liaison_model_mismatch", `Video liaison requires ${SONNET_MODEL}; no substitute model was used.`);
    if (!apiKey) fail(503, "liaison_not_configured", "Claude Sonnet 5 is not configured. No substitute model was used.");
    const stableContext = JSON.stringify({ role: "video project state", project: project?.project, screenplay: project?.screenplay, scenes: project?.scenes, tracks: project?.tracks, clips: project?.clips });
    const maxTokens = Math.min(16_384, Math.max(256, Number(anthropic.maxTokens) || 4_096));
    enforceContextWindow("video_liaison_context_limit", "The Claude liaison request", {
      stableContext,
      userRequest: message,
      director: { model: director.model, directive: director.directive },
      visual: visual.available ? visual.plan : visual.error,
    }, LONG_CONTEXT_TOKENS, maxTokens);
    const body = await providerPost(fetchImpl, endpoint(anthropic.baseUrl || "https://api.anthropic.com", "/v1/messages"), {
      provider: "anthropic",
      headers: { "x-api-key": apiKey, "anthropic-version": anthropic.version || "2023-06-01" },
      timeoutMs: Number(anthropic.timeoutMs) || 180_000,
      body: {
        model: SONNET_MODEL,
        max_tokens: maxTokens,
        system: [{ type: "text", text: "You are Dominion Video's user-facing liaison. Keep the creative director and screenwriter context aligned, explain the exact next change in plain language, and surface every limitation or failure honestly. Never claim a generation, save, edit, charge, or export happened unless the supplied state proves it. Keep the reply useful and concise.", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: stableContext, cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: "I have the persisted project context." },
          { role: "user", content: `User request:\n${message}\n\nCreative director directive (${director.model}):\n${director.directive}\n\nVisual orchestrator (${visual.model}):\n${visual.available ? JSON.stringify(visual.plan) : `DEGRADED — ${visual.error.code}: ${visual.error.message}`}` },
        ],
      },
    });
    await maybeMeterProvider(tenant, anthropic, body.usage, { kind: "video_liaison", provider: "anthropic", model: SONNET_MODEL });
    return { reply: anthropicText(body), usage: body.usage || null, model: SONNET_MODEL };
  }

  async function persistAiTurn(tenantId, projectId, message, director, visual, liaison) {
    const conversation = { at: new Date(Number(now())).toISOString(), user: message, director: director.directive, visualPlan: visual.available ? clone(visual.plan) : null, visualError: visual.available ? null : clone(visual.error), reply: liaison.reply };
    if (typeof feature.updateAiState === "function") {
      const saved = await feature.updateAiState(tenantId, projectId, {
        director: { model: director.model, usage: clone(director.usage), directive: director.directive, compaction: clone(director.compaction) },
        visualOrchestrator: { model: visual.model, available: visual.available, usage: clone(visual.usage), plan: clone(visual.plan), error: clone(visual.error) },
        liaison: { model: liaison.model, usage: clone(liaison.usage), reply: liaison.reply },
        conversation,
      });
      if (visual.available && typeof feature.applyCommand === "function") await feature.applyCommand(tenantId, projectId, { type: "visual.plan.apply", scenes: visual.plan.scenes });
      return saved;
    }
    if (typeof feature.applyCommand === "function") {
      const project = await feature.getProject(tenantId, projectId);
      const prior = project?.ai?.director?.state || {};
      const usedTokens = Number(prior.usedTokens || 0) + Number(director.usage?.total_tokens || 0);
      await feature.applyCommand(tenantId, projectId, { type: "director.state", state: { ...clone(prior), usedTokens, lastTurn: conversation, liaison: { model: liaison.model, usage: clone(liaison.usage) } }, usedTokens, contextWindow: 1_000_000 });
      const saved = await feature.applyCommand(tenantId, projectId, { type: "ai.state", role: "visualOrchestrator", state: { model: visual.model, available: visual.available, usage: clone(visual.usage), plan: clone(visual.plan), error: clone(visual.error), updatedAt: conversation.at } });
      if (visual.available) await feature.applyCommand(tenantId, projectId, { type: "visual.plan.apply", scenes: visual.plan.scenes });
      return saved;
    }
    fail(501, "video_ai_checkpoint_unavailable", "The AI turn completed but cannot be saved, so it was not accepted as a project change.");
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

    if (method === "GET" && (path === "/" || path === "/config")) {
      const mobile = isMobileRequest(req, { device: parsed.searchParams.get("device") });
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
        agents: {
          director: { model: DIRECTOR_MODEL, configured: !!credential(nvidia.apiKey) && cleanText(nvidia.directorModel || DIRECTOR_MODEL, 200) === DIRECTOR_MODEL },
          visualOrchestrator: { model: VISUAL_MODEL, configured: !!credential(nvidia.apiKey) && cleanText(nvidia.visualModel || VISUAL_MODEL, 200) === VISUAL_MODEL },
          screenwriter: { model: PALMYRA_MODEL, configured: !!credential(nvidia.apiKey) && nvidia.palmyraEnabled === true },
          liaison: { model: SONNET_MODEL, configured: !!credential(anthropic.apiKey) && (!anthropic.model || anthropic.model === SONNET_MODEL) },
        },
        palmyra: { available: !!credential(nvidia.apiKey) && nvidia.palmyraEnabled === true, model: PALMYRA_MODEL, message: nvidia.palmyraEnabled === true ? "Palmyra Creative is configured." : "Palmyra is listed in the NVIDIA catalog but is not enabled for completion on this account." },
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
      if (body.state && typeof feature.checkpointProject === "function") await feature.checkpointProject(tenantId, project.id, { label: "Initial project", state: body.state });
      return json(res, 201, await getProject(tenantId, project.id));
    }

    if (method === "POST" && path === "/projects/checkpoint") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      if (typeof feature.checkpointProject !== "function") fail(501, "video_checkpoint_unavailable", "Project checkpoint storage is not available.");
      const projectId = ensureProjectId(body.projectId);
      const saved = await feature.checkpointProject(tenantId, projectId, { label: cleanText(body.label, 200) || "Saved checkpoint", state: clone(body.state || {}) });
      return json(res, 200, { ok: true, projectId, checkpoint: saved });
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
      if (typeof feature.restoreCheckpoint !== "function") fail(501, "video_history_unavailable", "Project history is not available.");
      await feature.restoreCheckpoint(tenantId, projectId, body.seq);
      return json(res, 200, await getProject(tenantId, projectId));
    }
    const commandRoute = path.match(/^\/projects\/([^/]+)\/(undo|redo)$/);
    if (method === "POST" && commandRoute) {
      const body = await readJson(req); await requireDesktop(req, context, body);
      const projectId = ensureProjectId(decodePart(commandRoute[1])); const command = commandRoute[2];
      if (typeof feature[command] !== "function") fail(501, "video_history_unavailable", "Project history is not available.");
      await feature[command](tenantId, projectId);
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
          if (typeof feature.checkpointProject !== "function") fail(501, "video_checkpoint_unavailable", "Project checkpoint storage is not available.");
          await feature.checkpointProject(tenantId, projectId, { label: cleanText(body.label, 200) || "Updated project", state: clone(body.state) });
        }
        return json(res, 200, await getProject(tenantId, projectId));
      }
      if (method === "DELETE") {
        await requireDesktop(req, context, body);
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
      const submitted = await feature.submitGeneration(tenantId, projectId, request, { tenant: clone(tenant) });
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
      return json(res, 200, { ...clone(job), jobId, projectId: located.projectId, mediaUrl, hasAudio: !!job.media?.hasAudio, clips, clip, audioClip, retryAfterMs: Number(job.retry?.delayMs) || 3_000, message: job.status === "ready" ? "Video saved and verified." : job.status === "failed" ? cleanText(job.providerError?.message, 800) || "Video generation failed. No completed clip was added." : "Video generation is still running." });
    }

    const deliveredRoute = path.match(/^\/jobs\/([^/]+)\/delivered$/);
    if (method === "POST" && deliveredRoute) {
      if (typeof feature.markJobDelivered !== "function") fail(501, "video_delivery_unavailable", "Mobile video delivery acknowledgement is unavailable.");
      const body = await readJson(req); const jobId = ensureJobId(decodePart(deliveredRoute[1]));
      const located = await findJob(tenantId, jobId, body.projectId);
      const job = await feature.markJobDelivered(tenantId, located.projectId, jobId);
      return json(res, 200, { ok: true, jobId, projectId: located.projectId, delivery: clone(job.delivery) });
    }

    if (method === "POST" && path === "/screenwrite") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      await modelBilling(tenant);
      const projectId = ensureProjectId(body.projectId);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) fail(400, "video_screenplay_prompt_required", "Add a story brief before asking the screenwriter.");
      if (prompt.length > MAX_SCREENPLAY_CHARS || tokenEstimate(prompt) > PALMYRA_CONTEXT_TOKENS || Number(body.limit || 115_000) > 115_000) fail(413, "video_screenplay_limit", "The screenplay is limited to 115,000 tokens and is never compacted.");
      screenOrFail(screenContent, tenant, prompt);
      const project = await getProject(tenantId, projectId);
      const result = await callPalmyra(tenant, project, prompt);
      await feature.applyCommand(tenantId, projectId, { type: "screenplay.set", text: result.text });
      return json(res, 200, { text: result.text, model: result.model, projectId, usage: result.usage });
    }

    if (method === "POST" && path === "/chat") {
      const body = await readJson(req);
      await requireDesktop(req, context, body);
      await modelBilling(tenant);
      const projectId = ensureProjectId(body.projectId);
      const message = cleanText(body.message, 100_000);
      if (!message) fail(400, "video_chat_message_required", "Enter a message for the video team.");
      screenOrFail(screenContent, tenant, message);
      const project = await getProject(tenantId, projectId);
      const director = await callDirector(tenant, project, message, body.context);
      let visual;
      try { visual = await callVisualOrchestrator(tenant, project, message, director); }
      catch (error) {
        if (!(error instanceof VideoHttpError) || !String(error.code || "").includes("visual_orchestrator")) throw error;
        visual = { available: false, model: cleanText(nvidia.visualModel || VISUAL_MODEL, 200), plan: null, usage: null, error: { code: error.code, message: error.message } };
      }
      const liaison = await callLiaison(tenant, project, message, director, visual);
      await persistAiTurn(tenantId, projectId, message, director, visual, liaison);
      return json(res, 200, { reply: liaison.reply, projectId, director: { directive: director.directive, model: director.model }, visualOrchestrator: { model: visual.model, available: visual.available, plan: clone(visual.plan), error: clone(visual.error) }, liaison: { model: liaison.model }, saved: true, degraded: visual.available ? [] : ["visualOrchestrator"] });
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
      return json(res, result.status === "ready" ? 200 : 202, { ...clone(result), projectId, message: result.message || (result.status === "ready" ? "Export completed and verified." : "Export queued. It will be verified before download.") });
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

  return { handle };
}
