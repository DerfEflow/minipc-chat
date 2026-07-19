// Dominion Forge Images — OpenAI image generation for the Dominion AI interface.
// Zero-dep, mirrors the /api/ocr wall exactly (identity, account state, invite, credits),
// screens every prompt through the content wall, meters non-owners like a chat turn, and
// never stores pixels server-side: sync results stream back as base64 and live only in the
// device gallery (IndexedDB). Batch results are spooled to a temp JSONL under DATA_DIR only
// long enough to page them down to the device, then cleaned up.
//
// Pricing facts [verified 2026-07-18 against developers.openai.com]:
//   gpt-image-2 (released 2026-04, the current flagship) — text input $5/1M, image input
//   $8/1M, image output tokens $30/1M; Batch rates are exactly half ($2.50/$4/$15).
//   Published per-image prices (portrait/landscape run CHEAPER than square on this model):
//     low    $0.006 (1024x1024) / $0.005 (1024x1536) / $0.005 (1536x1024)
//     medium $0.053 / $0.041 / $0.041
//     high   $0.211 / $0.165 / $0.165
//   Token estimates below are derived from those prices at $30/1M output; metering always
//   prefers the real usage object. Batch API: 50% off, 24h window, up to 50k requests/job.

import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const IMAGE_SIZES = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};
export const IMAGE_QUALITIES = ["low", "medium", "high"];

// Output-token estimates per generated image (published price / $30 per 1M), quality then aspect.
export const IMAGE_TOKENS = {
  low: { square: 200, portrait: 167, landscape: 167 },
  medium: { square: 1767, portrait: 1367, landscape: 1367 },
  high: { square: 7033, portrait: 5500, landscape: 5500 },
};
// Published per-image USD (sync). Batch = 50% of these.
export const IMAGE_PRICES = {
  low: { square: 0.006, portrait: 0.005, landscape: 0.005 },
  medium: { square: 0.053, portrait: 0.041, landscape: 0.041 },
  high: { square: 0.211, portrait: 0.165, landscape: 0.165 },
};
const TEXT_IN_PER_M = 5;      // $/1M text input tokens
const IMG_OUT_PER_M = 30;     // $/1M image output tokens
const BATCH_DISCOUNT = 0.5;
const REFINE_IN_PER_M = 1;    // $/1M — gpt-5.6-luna published rates
const REFINE_OUT_PER_M = 6;

const SYNC_MAX_N = 4;
const PROMPT_MAX = 32000;
const BATCH_MAX_GUEST = 50;
const BATCH_MAX_OWNER = 200;
const COLLECT_PAGE_MAX = 8;
const SPOOL_TTL_MS = 48 * 3600 * 1000;
const REF_MAX = 10;                       // reference plates per immediate forge
const REF_MAX_BYTES = 6 * 1024 * 1024;    // per decoded reference image
const REF_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function priceFor(quality, aspect, { batch = false } = {}) {
  const p = (IMAGE_PRICES[quality] || {})[aspect];
  if (typeof p !== "number") return null;
  return batch ? +(p * BATCH_DISCOUNT).toFixed(6) : p;
}

const IMG_IN_PER_M = 8;       // $/1M image input tokens (reference plates)

function usageCostUsd(usage, { batch = false } = {}) {
  if (!usage) return null;
  const inTok = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (!inTok && !outTok) return null;
  const k = batch ? BATCH_DISCOUNT : 1;
  const det = usage.input_tokens_details;
  const inUsd = det && typeof det.image_tokens === "number"
    ? (det.text_tokens || 0) * TEXT_IN_PER_M + det.image_tokens * IMG_IN_PER_M
    : inTok * TEXT_IN_PER_M;
  return +(((inUsd + outTok * IMG_OUT_PER_M) / 1e6) * k).toFixed(6);
}

function readRawBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (d) => {
      total += d.length;
      if (total > maxBytes) { req.destroy(); resolve(null); return; }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

// One request helper for every OpenAI call this module makes. `apiBase` is injectable so
// the e2e suite can point it at a local mock (http) while production stays on api.openai.com.
function apiRequest(base, key, { method, path, headers = {}, body = null, timeout = 300000 }) {
  const u = new URL(path, base);
  const mod = u.protocol === "http:" ? http : https;
  return new Promise((resolve) => {
    const rq = mod.request(
      { method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        headers: { authorization: "Bearer " + key, ...headers }, timeout },
      (resp) => {
        const chunks = [];
        resp.on("data", (d) => chunks.push(d));
        resp.on("end", () => resolve({ status: resp.statusCode || 0, buf: Buffer.concat(chunks) }));
      }
    );
    rq.on("error", (e) => resolve({ status: 0, buf: Buffer.from(String(e.message || "request error")) }));
    rq.on("timeout", () => { rq.destroy(); resolve({ status: 0, buf: Buffer.from("timeout") }); });
    if (body) rq.write(body);
    rq.end();
  });
}

function apiErrorMessage(r, fallback) {
  let msg = fallback + " (HTTP " + r.status + ").";
  try { const j = JSON.parse(r.buf.toString("utf8")); if (j.error && j.error.message) msg = "OpenAI: " + j.error.message; } catch {}
  return msg;
}

// Validate one generation request. Returns { error } or normalized { prompt, quality, aspect, size, n }.
function normalizeItem(raw, { maxN = 1 } = {}) {
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { error: "prompt required" };
  if (prompt.length > PROMPT_MAX) return { error: "prompt too long (max " + PROMPT_MAX + " chars)" };
  const quality = String(raw.quality || "medium").toLowerCase();
  if (!IMAGE_QUALITIES.includes(quality)) return { error: "quality must be low, medium, or high" };
  const aspect = String(raw.aspect || raw.size || "square").toLowerCase();
  if (!IMAGE_SIZES[aspect]) return { error: "aspect must be square, portrait, or landscape" };
  let n = Math.trunc(Number(raw.n) || 1);
  if (n < 1) n = 1;
  if (n > maxN) n = maxN;
  return { prompt, quality, aspect, size: IMAGE_SIZES[aspect], n };
}

export function createImagesFeature(deps) {
  const {
    key,                    // () => OpenAI API key string ("" = feature unavailable)
    apiBase = "https://api.openai.com",
    model = "gpt-image-2",
    refineModel = "gpt-5.6-luna",
    dataDir,                // spool + batch-job records live here
    resolveTenant,          // (req) => T   — the tenancy resolver from server.mjs
    screenContent,          // (text, {isOwner}) => { blocked, reason } — the content wall
    meter,                  // (T, costUsd) — charges non-owners exactly like OCR/chat turns
    creditBack = () => {},  // (T, credits, reason) — returns credits to a non-owner (batch settle)
    isMetered = () => false,// (T) => does meter() actually charge this tenant?
    billingAccount = null,  // (email) => { balance } | null — for batch affordability checks
    logUsage = async () => {},
    log = () => {},
  } = deps;

  mkdirSync(dataDir, { recursive: true });
  const jobsFile = join(dataDir, "batches.json");

  function loadJobs() {
    try { return JSON.parse(readFileSync(jobsFile, "utf8")).jobs || []; } catch { return []; }
  }
  function saveJobs(jobs) {
    try { writeFileSync(jobsFile, JSON.stringify({ jobs }, null, 2)); } catch (e) { log("images: job store write failed: " + e.message); }
  }
  function persistJob(job) {
    const jobs = loadJobs();
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) { jobs[i] = job; saveJobs(jobs); }
  }
  function cleanSpool() {
    try {
      for (const f of readdirSync(dataDir)) {
        if (!f.startsWith("spool-") || !f.endsWith(".jsonl")) continue;
        const p = join(dataDir, f);
        try { if (Date.now() - statSync(p).mtimeMs > SPOOL_TTL_MS) unlinkSync(p); } catch {}
      }
    } catch {}
  }
  cleanSpool();

  const json = (res, code, o) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(o));
  };

  // The same four-gate wall as /api/ocr. Returns T on pass, or null after refusing.
  function gate(req, res, what) {
    const T = resolveTenant(req);
    if (T.role === "anon") { json(res, 401, { error: "Sign in to use Dominion.", code: "no_identity" }); return null; }
    if (T.status === "paused" || T.status === "locked") { json(res, 403, { error: "Account " + T.status + ".", code: "account_" + T.status }); return null; }
    if (!T.isOwner && !T.invited) { json(res, 403, { error: "You need an access code before " + what + " can run.", code: "needs_invite" }); return null; }
    if (!T.isOwner && T.role === "credit" && deps.canChat && !deps.canChat(T.email)) {
      json(res, 402, { error: what + " needs credits. Add credits in Setup first.", code: "needs_credits" }); return null;
    }
    return T;
  }

  // ---- GET /api/images/config — the one source of truth the panel builds its estimates from.
  function handleConfig(req, res) {
    json(res, 200, {
      available: !!key(),
      brand: "Dominion Forge Images",
      model,
      sizes: IMAGE_SIZES,
      qualities: IMAGE_QUALITIES,
      tokens: IMAGE_TOKENS,
      prices: IMAGE_PRICES,
      textInPerM: TEXT_IN_PER_M,
      imgOutPerM: IMG_OUT_PER_M,
      syncMaxN: SYNC_MAX_N,
      refCap: REF_MAX,
      refine: true,
      batch: { discount: BATCH_DISCOUNT, window: "24h", maxItemsGuest: BATCH_MAX_GUEST, maxItemsOwner: BATCH_MAX_OWNER },
    });
  }

  // Validate the staged reference plates (dataURLs). Returns { error } or { refs: [{mime, buf}] }.
  function parseRefs(raw) {
    if (!Array.isArray(raw) || !raw.length) return { refs: [] };
    if (raw.length > REF_MAX) return { error: "too many reference images (max " + REF_MAX + ")" };
    const refs = [];
    for (let i = 0; i < raw.length; i++) {
      const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(String(raw[i] || ""));
      if (!m || !REF_MIMES.has(m[1].toLowerCase())) return { error: "reference " + (i + 1) + ": unsupported image type" };
      let buf; try { buf = Buffer.from(m[2], "base64"); } catch { return { error: "reference " + (i + 1) + ": unreadable" }; }
      if (!buf.length || buf.length > REF_MAX_BYTES) return { error: "reference " + (i + 1) + ": too large" };
      refs.push({ mime: m[1].toLowerCase(), buf });
    }
    return { refs };
  }

  // ---- POST /api/images/generate — synchronous generation, 1-4 images. With reference
  // plates the call rides /v1/images/edits (multipart, image[] entries); without, the plain
  // JSON /v1/images/generations. Same response shape either way.
  async function handleGenerate(req, res) {
    if (!key()) return json(res, 503, { error: "Image generation needs the OpenAI key (OPEN_AI_DOMINION_UI_APIKEY)." });
    const raw = await readRawBody(req, 96 * 1024 * 1024);
    if (raw === null) return json(res, 413, { error: "request too large" });
    let body; try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad json" }); }

    const T = gate(req, res, "image generation");
    if (!T) return;
    const item = normalizeItem(body, { maxN: SYNC_MAX_N });
    if (item.error) return json(res, 400, { error: item.error });
    const parsedRefs = parseRefs(body.refs);
    if (parsedRefs.error) return json(res, 400, { error: parsedRefs.error });

    const screen = screenContent(item.prompt, { isOwner: T.isOwner });
    if (screen.blocked) {
      await logUsage({ ts: new Date().toISOString(), model, mode: "image", status: "blocked", reason: screen.category, uid: T.uid });
      return json(res, 403, { error: screen.reason, code: "content_blocked" });
    }

    const startedAt = new Date().toISOString();
    let r;
    if (parsedRefs.refs.length) {
      const boundary = "----dominionimages" + randomUUID().replace(/-/g, "");
      const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      const parts = [
        field("model", model), field("prompt", item.prompt), field("size", item.size),
        field("quality", item.quality), field("n", String(item.n)),
      ];
      parsedRefs.refs.forEach((ref, i) => {
        const ext = ref.mime === "image/png" ? "png" : ref.mime === "image/webp" ? "webp" : "jpg";
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="ref-${i + 1}.${ext}"\r\nContent-Type: ${ref.mime}\r\n\r\n`));
        parts.push(ref.buf, Buffer.from("\r\n"));
      });
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const upBody = Buffer.concat(parts);
      r = await apiRequest(apiBase, key(), {
        method: "POST", path: "/v1/images/edits",
        headers: { "content-type": "multipart/form-data; boundary=" + boundary, "content-length": upBody.length },
        body: upBody,
      });
    } else {
      const payload = JSON.stringify({
        model, prompt: item.prompt, size: item.size, quality: item.quality, n: item.n,
        output_format: "png", moderation: "auto",
      });
      r = await apiRequest(apiBase, key(), {
        method: "POST", path: "/v1/images/generations",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        body: payload,
      });
    }
    if (r.status !== 200) {
      const msg = apiErrorMessage(r, "Image generation failed");
      await logUsage({ ts: startedAt, model, mode: "image", status: "error", error: msg.slice(0, 200), uid: T.uid });
      return json(res, 502, { error: msg });
    }
    let out; try { out = JSON.parse(r.buf.toString("utf8")); } catch { return json(res, 502, { error: "Unreadable response from OpenAI." }); }
    const images = (out.data || []).map((d) => d.b64_json).filter(Boolean);
    if (!images.length) return json(res, 502, { error: "OpenAI returned no images." });

    const costUsd = usageCostUsd(out.usage) ?? +(priceFor(item.quality, item.aspect) * images.length).toFixed(6);
    meter(T, costUsd);
    await logUsage({
      ts: startedAt, model, mode: "image", status: "completed", images: images.length,
      quality: item.quality, aspect: item.aspect, refs: parsedRefs.refs.length || null,
      promptTokens: out.usage?.input_tokens ?? null, outputTokens: out.usage?.output_tokens ?? null,
      costUsd, uid: T.uid,
    });
    log(`image gen: ${images.length} ${item.quality}/${item.aspect}${parsedRefs.refs.length ? " +" + parsedRefs.refs.length + " refs" : ""} · $${costUsd} · ${T.isOwner ? "owner" : T.email || T.uid}`);
    return json(res, 200, {
      images: images.map((b64) => ({ b64, format: "png" })),
      model, quality: item.quality, aspect: item.aspect, size: item.size,
      usage: { inputTokens: out.usage?.input_tokens ?? null, outputTokens: out.usage?.output_tokens ?? null },
      costUsd,
    });
  }

  // ---- POST /api/images/refine — sharpen a creative directive with a cheap text model.
  // Same wall as generation; metered from real usage at the refine model's published rates.
  async function handleRefine(req, res) {
    if (!key()) return json(res, 503, { error: "Prompt refinement needs the OpenAI key (OPEN_AI_DOMINION_UI_APIKEY)." });
    const raw = await readRawBody(req);
    if (raw === null) return json(res, 413, { error: "request too large" });
    let body; try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
    const T = gate(req, res, "prompt refinement");
    if (!T) return;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
    if (!prompt) return json(res, 400, { error: "prompt required" });
    const screen = screenContent(prompt, { isOwner: T.isOwner });
    if (screen.blocked) return json(res, 403, { error: screen.reason, code: "content_blocked" });

    const sys = "You refine prompts for an image generation engine. Rewrite the user's directive into one vivid, concrete image prompt: subject, composition, lighting, materials, atmosphere, style. Keep the user's intent and subject exactly; add craft, never commentary. Output ONLY the refined prompt text.";
    const payload = JSON.stringify({
      model: refineModel,
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      max_completion_tokens: 2500,
    });
    // Two attempts: gpt-5.x models occasionally return an empty message on small completions.
    let text = "", usage = null, lastErr = "";
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      const r = await apiRequest(apiBase, key(), {
        method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        body: payload, timeout: 60000,
      });
      if (r.status !== 200) { lastErr = apiErrorMessage(r, "Refinement failed"); continue; }
      try {
        const j = JSON.parse(r.buf.toString("utf8"));
        text = String(j.choices?.[0]?.message?.content || "").trim();
        usage = j.usage || usage;
      } catch { lastErr = "Unreadable response from OpenAI."; }
    }
    if (!text) return json(res, 502, { error: lastErr || "Refinement returned nothing." });
    const costUsd = usage
      ? +((((usage.prompt_tokens || 0) * REFINE_IN_PER_M + (usage.completion_tokens || 0) * REFINE_OUT_PER_M) / 1e6)).toFixed(6)
      : 0.001;
    meter(T, costUsd);
    await logUsage({ ts: new Date().toISOString(), model: refineModel, mode: "image_refine", status: "completed", promptTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, costUsd, uid: T.uid });
    return json(res, 200, { prompt: text.slice(0, 4000), costUsd });
  }

  // ---- POST /api/images/batch — submit up to 50/200 generations at 50% token rates.
  async function handleBatchCreate(req, res) {
    if (!key()) return json(res, 503, { error: "Image generation needs the OpenAI key (OPEN_AI_DOMINION_UI_APIKEY)." });
    const raw = await readRawBody(req);
    if (raw === null) return json(res, 413, { error: "request too large" });
    let body; try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad json" }); }

    const T = gate(req, res, "batch image generation");
    if (!T) return;
    const maxItems = T.isOwner ? BATCH_MAX_OWNER : BATCH_MAX_GUEST;
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, maxItems + 1) : [];
    if (!rawItems.length) return json(res, 400, { error: "items required" });
    if (rawItems.length > maxItems) return json(res, 400, { error: "too many items (max " + maxItems + ")" });

    const items = [];
    let estUsd = 0;
    for (let i = 0; i < rawItems.length; i++) {
      const item = normalizeItem(rawItems[i], { maxN: 1 });
      if (item.error) return json(res, 400, { error: "item " + (i + 1) + ": " + item.error });
      const screen = screenContent(item.prompt, { isOwner: T.isOwner });
      if (screen.blocked) return json(res, 403, { error: "item " + (i + 1) + ": " + screen.reason, code: "content_blocked" });
      estUsd += priceFor(item.quality, item.aspect, { batch: true });
      items.push(item);
    }
    estUsd = +estUsd.toFixed(6);

    // Affordability wall for credit users: the whole batch must fit their balance up front,
    // even though the charge lands at collection (when real per-line usage is known).
    if (!T.isOwner && T.role === "credit" && billingAccount) {
      const acct = billingAccount(T.email) || {};
      const needCredits = Math.max(1, Math.ceil(estUsd * 100));
      if ((acct.balance || 0) < needCredits) {
        return json(res, 402, { error: `This batch estimates ${needCredits} credits; you have ${acct.balance || 0}. Add credits in Setup first.`, code: "needs_credits" });
      }
    }

    // Build the JSONL and upload it (purpose=batch), then create the batch job.
    const lines = items.map((it, i) => JSON.stringify({
      custom_id: "dfi-" + i,
      method: "POST",
      url: "/v1/images/generations",
      body: { model, prompt: it.prompt, size: it.size, quality: it.quality, n: 1, output_format: "png", moderation: "auto" },
    })).join("\n");
    const boundary = "----dominionimages" + randomUUID().replace(/-/g, "");
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="forge-images.jsonl"\r\nContent-Type: application/jsonl\r\n\r\n`
    );
    const upBody = Buffer.concat([head, Buffer.from(lines, "utf8"), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await apiRequest(apiBase, key(), {
      method: "POST", path: "/v1/files",
      headers: { "content-type": "multipart/form-data; boundary=" + boundary, "content-length": upBody.length },
      body: upBody,
    });
    if (up.status !== 200) return json(res, 502, { error: apiErrorMessage(up, "Batch file upload failed") });
    let fileId; try { fileId = JSON.parse(up.buf.toString("utf8")).id; } catch {}
    if (!fileId) return json(res, 502, { error: "Batch file upload returned no file id." });

    const createPayload = JSON.stringify({ input_file_id: fileId, endpoint: "/v1/images/generations", completion_window: "24h" });
    const cr = await apiRequest(apiBase, key(), {
      method: "POST", path: "/v1/batches",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(createPayload) },
      body: createPayload,
    });
    if (cr.status !== 200) return json(res, 502, { error: apiErrorMessage(cr, "Batch creation failed") });
    let batch; try { batch = JSON.parse(cr.buf.toString("utf8")); } catch {}
    if (!batch || !batch.id) return json(res, 502, { error: "Batch creation returned no id." });

    // Fred's rule (2026-07-18): the batch is CHARGED AT SUBMIT at the published 50% rates.
    // Collection settles against real usage — overcharges come back as credits, and the rare
    // actual-above-published overrun is charged as the difference. Terminal failures refund fully.
    const metered = isMetered(T);
    const chargedCredits = metered ? Math.max(1, Math.ceil(estUsd * 100)) : 0;
    if (metered) meter(T, estUsd);

    const jobs = loadJobs();
    const job = {
      id: batch.id, uid: T.uid, email: T.email || "", ts: new Date().toISOString(), model,
      count: items.length, estUsd, status: batch.status || "validating",
      chargedCredits, settled: !metered, costUsd: null, outputFileId: null,
      items: items.map((it) => ({ prompt: it.prompt.slice(0, 200), quality: it.quality, aspect: it.aspect })),
    };
    jobs.unshift(job);
    saveJobs(jobs.slice(0, 200));
    await logUsage({ ts: job.ts, model, mode: "image_batch", status: "submitted", images: items.length, estUsd, chargedCredits, batchId: batch.id, uid: T.uid });
    log(`image batch submitted: ${items.length} item(s) · est $${estUsd} charged at submit (${chargedCredits} credits) · ${T.isOwner ? "owner" : T.email || T.uid}`);
    return json(res, 200, { id: batch.id, status: job.status, count: items.length, estUsd, chargedCredits });
  }

  // ---- GET /api/images/batches — this user's jobs, newest first.
  function handleBatchList(req, res) {
    const T = gate(req, res, "batch image generation");
    if (!T) return;
    const jobs = loadJobs().filter((j) => j.uid === T.uid).map((j) => ({
      id: j.id, ts: j.ts, count: j.count, estUsd: j.estUsd, status: j.status,
      chargedCredits: j.chargedCredits, settled: j.settled, costUsd: j.costUsd, items: j.items,
    }));
    return json(res, 200, { jobs });
  }

  // Refresh one job's status from OpenAI and persist it. Returns the updated job record.
  async function refreshJob(job) {
    const r = await apiRequest(apiBase, key(), { method: "GET", path: "/v1/batches/" + encodeURIComponent(job.id) });
    if (r.status !== 200) return job;
    let b; try { b = JSON.parse(r.buf.toString("utf8")); } catch { return job; }
    job.status = b.status || job.status;
    job.outputFileId = b.output_file_id || job.outputFileId;
    job.errorFileId = b.error_file_id || job.errorFileId || null;
    job.requestCounts = b.request_counts || job.requestCounts || null;
    const jobs = loadJobs();
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) { jobs[i] = job; saveJobs(jobs); }
    return job;
  }

  function spoolPath(id) { return join(dataDir, "spool-" + id.replace(/[^a-zA-Z0-9_-]/g, "") + ".jsonl"); }

  // Download the batch output once, spool it, and parse. Returns { lines } or { error }.
  async function ensureSpool(job) {
    const p = spoolPath(job.id);
    if (!existsSync(p)) {
      const r = await apiRequest(apiBase, key(), { method: "GET", path: "/v1/files/" + encodeURIComponent(job.outputFileId) + "/content" });
      if (r.status !== 200) return { error: apiErrorMessage(r, "Batch result download failed") };
      writeFileSync(p, r.buf);
    }
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
    return { lines };
  }

  // ---- GET /api/images/batch/<id>?offset=0&limit=4 — poll status; page results when done.
  // The first successful collection charges the user ONCE from real usage at batch rates.
  async function handleBatchGet(req, res, u) {
    const T = gate(req, res, "batch image generation");
    if (!T) return;
    const id = decodeURIComponent(u.pathname.split("/").pop() || "");
    let job = loadJobs().find((j) => j.id === id && j.uid === T.uid);
    if (!job) return json(res, 404, { error: "batch not found" });

    if (!["completed", "failed", "expired", "cancelled"].includes(job.status) || (job.status === "completed" && !job.outputFileId)) {
      job = await refreshJob(job);
    }

    // Terminal failure before any results: the submit charge comes back in full, once.
    if (["failed", "expired", "cancelled"].includes(job.status) && !job.settled) {
      creditBack(T, job.chargedCredits, "batch " + job.status + " refund " + job.id);
      job.settled = true;
      job.costUsd = 0;
      job.refundedCredits = job.chargedCredits;
      persistJob(job);
      await logUsage({ ts: new Date().toISOString(), model, mode: "image_batch", status: job.status, refundedCredits: job.chargedCredits, batchId: job.id, uid: T.uid });
      log(`image batch ${job.status}: refunded ${job.chargedCredits} credit(s) · ${T.isOwner ? "owner" : T.email || T.uid}`);
    }

    const base = { id: job.id, status: job.status, count: job.count, estUsd: job.estUsd, chargedCredits: job.chargedCredits, settled: job.settled, costUsd: job.costUsd, refundedCredits: job.refundedCredits || 0, requestCounts: job.requestCounts || null };
    if (job.status !== "completed" || !job.outputFileId) return json(res, 200, base);

    const sp = await ensureSpool(job);
    if (sp.error) return json(res, 502, { error: sp.error });

    const parsed = sp.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const ok = parsed.filter((l) => l.response && l.response.status_code === 200 && l.response.body);

    // First collection settles submit-charge vs real usage: refund the overage as credits,
    // charge the (rare) shortfall when actual tokens run above the published table.
    if (!job.settled) {
      let cost = 0, sawUsage = false;
      for (const l of ok) {
        const c = usageCostUsd(l.response.body.usage, { batch: true });
        if (c !== null) { cost += c; sawUsage = true; }
        else {
          const idx = Number((l.custom_id || "").replace("dfi-", ""));
          const it = job.items[idx];
          if (it) cost += priceFor(it.quality, it.aspect, { batch: true });
        }
      }
      job.costUsd = +cost.toFixed(6);
      const actualCredits = ok.length ? Math.max(1, Math.ceil(job.costUsd * 100)) : 0;
      const delta = actualCredits - job.chargedCredits;
      if (delta > 0) meter(T, delta / 100);
      else if (delta < 0) creditBack(T, -delta, "batch settle refund " + job.id);
      job.refundedCredits = delta < 0 ? -delta : 0;
      job.extraCredits = delta > 0 ? delta : 0;
      job.settled = true;
      persistJob(job);
      await logUsage({ ts: new Date().toISOString(), model, mode: "image_batch", status: "completed", images: ok.length, failed: parsed.length - ok.length, costUsd: job.costUsd, chargedCredits: job.chargedCredits, refundedCredits: job.refundedCredits, extraCredits: job.extraCredits, usageBased: sawUsage, batchId: job.id, uid: T.uid });
      log(`image batch collected: ${ok.length}/${job.count} ok · $${job.costUsd} actual vs ${job.chargedCredits} credit(s) charged at submit · settle ${job.refundedCredits ? "+" + job.refundedCredits + " back" : job.extraCredits ? "-" + job.extraCredits + " extra" : "even"} · ${T.isOwner ? "owner" : T.email || T.uid}`);
    }

    const offset = Math.max(0, Math.trunc(Number(u.searchParams.get("offset")) || 0));
    const limit = Math.min(COLLECT_PAGE_MAX, Math.max(1, Math.trunc(Number(u.searchParams.get("limit")) || 4)));
    const page = ok.slice(offset, offset + limit).map((l) => {
      const idx = Number((l.custom_id || "").replace("dfi-", ""));
      const it = job.items[idx] || {};
      const d = (l.response.body.data || [])[0] || {};
      return { b64: d.b64_json || "", format: "png", prompt: it.prompt || "", quality: it.quality || "", aspect: it.aspect || "" };
    }).filter((x) => x.b64);
    const done = offset + limit >= ok.length;
    if (done) { try { unlinkSync(spoolPath(job.id)); } catch {} }
    return json(res, 200, {
      ...base, settled: job.settled, costUsd: job.costUsd,
      refundedCredits: job.refundedCredits || 0, extraCredits: job.extraCredits || 0,
      total: ok.length, failed: parsed.length - ok.length, offset, images: page, done,
    });
  }

  // ---- POST /api/images/batch/<id>/cancel
  async function handleBatchCancel(req, res, u) {
    const T = gate(req, res, "batch image generation");
    if (!T) return;
    const id = decodeURIComponent(u.pathname.split("/").slice(-2, -1)[0] || "");
    const job = loadJobs().find((j) => j.id === id && j.uid === T.uid);
    if (!job) return json(res, 404, { error: "batch not found" });
    const r = await apiRequest(apiBase, key(), { method: "POST", path: "/v1/batches/" + encodeURIComponent(id) + "/cancel", headers: { "content-length": 0 } });
    if (r.status !== 200) return json(res, 502, { error: apiErrorMessage(r, "Batch cancel failed") });
    let b; try { b = JSON.parse(r.buf.toString("utf8")); } catch {}
    job.status = (b && b.status) || "cancelling";
    const jobs = loadJobs();
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) { jobs[i] = job; saveJobs(jobs); }
    return json(res, 200, { id: job.id, status: job.status });
  }

  return { handleConfig, handleGenerate, handleRefine, handleBatchCreate, handleBatchList, handleBatchGet, handleBatchCancel };
}
