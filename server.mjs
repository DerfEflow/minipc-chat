#!/usr/bin/env node
/*
 * Dominion AI — mini-PC server.
 * Serves the PWA (./public), reverse-proxies /ollama/* to the local Ollama, AND runs a
 * server-side agent loop at /chat that gives the assistant real "hands" (tools.mjs) without ever
 * exposing SYNC_SECRET or the Forge run-password to the browser.
 *
 *   PORT             listen port (default 8088), bound to 127.0.0.1 only
 *   OLLAMA_URL       upstream Ollama (default http://127.0.0.1:11434)
 *   SYNC_SECRET      Command Deck sync passphrase (for deck/forge tools). Read from env, then
 *                    C:\minipc-chat\.env, then the bridge's .env (shared secret).
 *   RUN_PASSWORD     Forge run-password (only needed for forge_send code/file changes).
 *   SANDBOX_DIR      the assistant's private folder (default C:\minipc-chat\sandbox).
 *   COMMAND_DECK_URL the live Command Deck (default the prod alias).
 */
import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TOOL_DEFS, toolDefs, WRITE_TOOLS, runTool, toolMeta, assertNotProtected, effectivePermission, needsConfirm, lifecycle, passConfirmGate } from "./tools.mjs";
import { createMemoryStore } from "./memory.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { createMentor, MENTOR_ROLES } from "./mentor.mjs";
import { createFlywheel } from "./flywheel.mjs";
import { createReviewEngine, computeQuality, extractCitations, wantsReview, detectArtifactTriggers, exportSafetyGate } from "./review.mjs";
import { routeOf, escalateForContext, consumeNeeds, NO_RETRIEVAL_RE } from "./routing.mjs";
import { createChatLog } from "./chatlog.mjs";
import { startWatchdog } from "./watchdog.mjs";
import { createPersonaStore, fetchUrl, htmlToText, renderFacets, KINDS as PERSONA_KINDS } from "./persona.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const ou = new URL(OLLAMA);
const PUBLIC = join(HERE, "public");

// ---- config (env -> local .env -> the bridge's shared .env) ----
function parseEnvFile(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}
const localEnv = parseEnvFile(join(HERE, ".env"));
const bridgeEnv = parseEnvFile("C:\\command-deck\\bridge\\.env");
const cfgGet = (k, d = "") => process.env[k] ?? localEnv[k] ?? bridgeEnv[k] ?? d;
const CTX = {
  baseUrl: String(cfgGet("COMMAND_DECK_URL", "https://command-deck-sigma.vercel.app")).replace(/\/$/, ""),
  syncKey: cfgGet("SYNC_SECRET", ""),
  runPassword: cfgGet("RUN_PASSWORD", ""),
  sandboxDir: cfgGet("SANDBOX_DIR", "C:\\minipc-chat\\sandbox"),
};

// Embeddings for hybrid retrieval (Phase 2 "vector search"). Uses Ollama /api/embed with a small
// dedicated embedding model; if the model isn't pulled or the call fails, retrieval degrades to
// lexical automatically — nothing blocks on this.
const EMBED_MODEL = cfgGet("EMBED_MODEL", "nomic-embed-text");
function embedText(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: String(text || "").slice(0, 2000) });
    const r = http.request(
      { protocol: ou.protocol, hostname: ou.hostname, port: ou.port || 80, path: "/api/embed", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 20000 },
      (resp) => { let buf = ""; resp.on("data", (d) => (buf += d)); resp.on("end", () => { try { const j = JSON.parse(buf); resolve((j.embeddings && j.embeddings[0]) || null); } catch { resolve(null); } }); }
    );
    r.on("error", () => resolve(null));
    r.on("timeout", () => { r.destroy(); resolve(null); });
    r.write(body); r.end();
  });
}

// Phase 2: governed memory store with the three-tier gating matrix (B1). MEMORY_GATING=lax|spec:
// lax (default) auto-approves the approval tier but records gatedAs; spec lands it pending.
// Legacy MEMORY_AUTO_APPROVE=0 still flips to spec mode. The never-save list blocks in BOTH modes.
const MEMORY_DIR = cfgGet("MEMORY_DIR", "C:\\minipc-chat\\memory");
const MEMORY_GATING = String(cfgGet("MEMORY_GATING", String(cfgGet("MEMORY_AUTO_APPROVE", "1")) === "0" ? "spec" : "lax")).toLowerCase() === "spec" ? "spec" : "lax";
const memory = createMemoryStore({ dir: MEMORY_DIR, gating: MEMORY_GATING, embed: embedText });
CTX.memory = memory;

// Server-side rolling chat transcripts (retrieval index for search_chats + episodic summaries).
const chatlog = createChatLog({ dir: cfgGet("CHATLOG_DIR", "C:\\minipc-chat\\chatlog") });
CTX.chatlog = chatlog;

// Phase 4: artifact studio. Generated documents become versioned, editable artifacts.
const ARTIFACT_DIR = cfgGet("ARTIFACT_DIR", "C:\\minipc-chat\\artifacts");
const artifacts = createArtifactStore({ dir: ARTIFACT_DIR });
CTX.artifacts = artifacts;

// Persona Forge: Fred's own corpus (jokes/maxims/essays/stories/poems/thoughts/plans/favorites/chats/
// web) + a distilled Fred Profile, for the "As Fred" mode. Retrieval-conditioned voice, not fine-tuning.
// SQLite-backed for a massive corpus; the E: flash drive is the staging inbox + backup target.
const PERSONA_DIR = cfgGet("PERSONA_DIR", "C:\\minipc-chat\\corpus");
const PERSONA_STAGING = cfgGet("PERSONA_STAGING", "E:\\DominionCorpus");
const persona = createPersonaStore({ dir: PERSONA_DIR, staging: PERSONA_STAGING, embed: embedText });
CTX.persona = persona;

// Continuous background embedder: drains the unembedded-chunk queue at a gentle pace so a bulk dump
// "builds over time" without hogging Ollama. Backs off to 30s when the queue is empty or Ollama is down.
let embedLoopOn = false;
async function embedLoop() {
  if (embedLoopOn) return;
  embedLoopOn = true;
  while (embedLoopOn) {
    // Interactive-priority: never run an embed batch while a chat is streaming (or within the
    // cooldown after one) — the 8B/embedder would evict/contend with the interactive model.
    if (interactiveBusy()) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    let n = 0;
    try { n = await persona.embedPending(8); } catch { n = 0; }
    await new Promise((r) => setTimeout(r, n ? 300 : 30000));
  }
}

// Background inbox scan job (a massive dump = thousands of files; bounded passes keep the server responsive).
let scanState = { running: false, ingested: 0, chunks: 0, skipped: 0, lastFiles: [], startedAt: null, finishedAt: null, error: null };
async function runScan() {
  try {
    for (;;) {
      if (!scanState.running) return;
      const r = persona.scanInbox({ maxFiles: 25 });
      scanState.ingested += r.ingested; scanState.chunks += r.chunks; scanState.skipped += r.skipped.length;
      scanState.lastFiles = r.files.slice(-5);
      if (!r.ingested && !r.skipped.length && !r.remaining) break;
      await new Promise((res) => setTimeout(res, 50));   // yield between passes
    }
    const b = persona.backupTo();   // snapshot after a bulk ingest (no-op if the staging drive is absent)
    scanState = { ...scanState, running: false, finishedAt: new Date().toISOString(), backup: b.ok ? b.path : (b.error || null) };
  } catch (e) { scanState = { ...scanState, running: false, error: String(e.message || e) }; }
}
function startScan() {
  if (scanState.running) return { running: true, ingested: scanState.ingested };
  scanState = { running: true, ingested: 0, chunks: 0, skipped: 0, lastFiles: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
  runScan();
  return { started: true };
}
// NOTE: the Phase 5 mentor/flywheel init lives further down — it needs MAIN_MODEL, which is
// declared in the provider block below (a const referenced before init = TDZ crash).

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

// ---- /ollama/* reverse proxy (streams straight through) ----
function proxy(req, res, upstreamPath) {
  const headers = { ...req.headers, host: ou.host };
  delete headers["accept-encoding"]; // keep SSE/stream un-gzipped so it flows token-by-token
  // Ollama 403s any request carrying a browser Origin/Referer (its cross-origin guard).
  // The phone is a real browser and sends them; strip so Ollama sees a clean local request.
  delete headers.origin;
  delete headers.referer;
  const opts = { protocol: ou.protocol, hostname: ou.hostname, port: ou.port || 80, path: upstreamPath, method: req.method, headers };
  const up = http.request(opts, (ur) => { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res); });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Can't reach Ollama on the mini-PC: " + e.message }));
  });
  req.pipe(up);
}

// ---- the agent loop (server-side tool-calling) + Phase 1 router/modes ----
const MAX_ROUNDS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- interactive-priority lane ----
// A single Ollama on a slow CPU box: background machinery (auto reviews, the persona embed loop,
// periodic mentor passes) must NEVER contend with a live chat. Every streaming /chat request holds
// the lane; background work polls waitInteractiveIdle() and defers (with backoff + a cooldown after
// the last request ends) — deferred, never dropped.
const INTERACTIVE_COOLDOWN_MS = 20000;
const interactiveLane = { active: 0, lastEndAt: 0 };
const interactiveBusy = () => interactiveLane.active > 0 || (Date.now() - interactiveLane.lastEndAt) < INTERACTIVE_COOLDOWN_MS;
function enterInteractive() { interactiveLane.active++; }
function leaveInteractive() { interactiveLane.active = Math.max(0, interactiveLane.active - 1); interactiveLane.lastEndAt = Date.now(); }
async function waitInteractiveIdle({ startMs = 1000, maxMs = 8000 } = {}) {
  let delay = startMs;
  while (interactiveBusy()) { await sleep(delay); delay = Math.min(maxMs, Math.round(delay * 1.5)); }
}
const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();

// Provider abstraction (local) — spec Phase 1 "model provider abstraction". Each tier is a provider
// with the capability fields the router cares about. qwen3:8b = fast light worker; qwen3:30b-a3b = heavy reasoning.
const LIGHT_MODEL = cfgGet("LIGHT_MODEL", "qwen3:8b");
const MAIN_MODEL = cfgGet("MAIN_MODEL", "qwen3:30b-a3b");
// Full spec ModelProvider fields. maxContextTokens is the HONEST Ollama-served window (40960).
//
// D4 — YaRN, the honest closure (spec 19/428/1841, audit item 11): the spec claims "YaRN enabled
// for thinking or long-context jobs" as baseline and says deep-think should "use YaRN when
// required by context size". That is NOT implementable on this stack, and this codebase does not
// pretend otherwise:
//   1. Ollama's /api/chat exposes no rope-scaling parameters (no rope_frequency_scale /
//      yarn_ext_factor equivalents reach the loaded model) — YaRN would require re-serving the
//      model with a modified Modelfile context ceiling, not a per-request option.
//   2. Even if it did, qwen3's YaRN ceiling (~131-262k tokens) needs KV-cache RAM this 32GB box
//      does not have; the machine would swap or OOM long before the window filled.
// So "long context" here = num_ctx escalation up to the provider cap below (40960), which IS what
// the runtime actually serves. The earlier 262144 figure was the family's theoretical YaRN
// ceiling and was removed as dishonest. See docs/RESTORATION-PLAN.md "Spec deviations".
// Displays never leak underlying model names.
const PROVIDERS = {
  light: { id: "local_light", displayName: "Fast", modelName: LIGHT_MODEL, providerType: "local", maxContextTokens: 40960,
           supportsThinking: true, supportsTools: true, supportsStructuredOutput: true, supportsVision: false, supportsAudio: false, supportsVideo: false,
           defaultTemperature: 0.7, recommendedUseCases: ["titles", "classification", "quick chat", "routing", "short summaries"],
           latencyTier: "fast", privacyLevel: "local_private", costTier: "free_local", enabled: true },
  main:  { id: "local_main", displayName: "Deep", modelName: MAIN_MODEL, providerType: "local", maxContextTokens: 40960,
           supportsThinking: true, supportsTools: true, supportsStructuredOutput: true, supportsVision: false, supportsAudio: false, supportsVideo: false,
           defaultTemperature: 0.6, recommendedUseCases: ["reasoning", "documents", "code", "tool planning", "long-form writing", "mentor critique"],
           latencyTier: "medium", privacyLevel: "local_private", costTier: "free_local", enabled: true },
};
const MODEL_FOR = (tier) => (PROVIDERS[tier] || PROVIDERS.light).modelName;
const PROVIDER_FOR_MODEL = (m) => Object.values(PROVIDERS).find((p) => p.modelName === m) || PROVIDERS.main;

// Normalized response shape (spec NormalizedModelResponse, FULL) — one place that translates an
// Ollama reply into the provider-agnostic object. extras carries the spec's quality block
// (confidence/hallucinationRisk/needsReview), citations, warnings, structured, and metadata —
// produced for every completed run and CONSUMED downstream (route/done SSE meta + auto-review).
function normalizeResponse(d, model, mode, extras = {}) {
  const p = PROVIDER_FOR_MODEL(model);
  return {
    providerId: p.id, modelName: model, mode,
    content: (d && d.message && d.message.content) || "",
    structured: extras.structured ?? null,
    toolCalls: (d && d.message && d.message.tool_calls) || [],
    citations: extras.citations || [],
    warnings: extras.warnings || [],
    usage: {
      inputTokens: (d && d.prompt_eval_count) || null,
      outputTokens: (d && d.eval_count) || null,
      totalTokens: ((d && d.prompt_eval_count) || 0) + ((d && d.eval_count) || 0) || null,
      latencyMs: d && d.total_duration ? Math.round(d.total_duration / 1e6) : null,
      costUsd: 0,
    },
    quality: extras.quality || { confidence: 0.5, hallucinationRisk: "low", needsReview: false },
    metadata: extras.metadata || {},
  };
}

// Mode discipline: each mode picks a model tier, sampling, optional long context, + a prompt fragment.
// normal runs the MAIN model (spec: the main model carries most user-facing answers); the router
// still drops trivial traffic to fast/light. tool + mentor are explicit-selection modes (never auto).
const MODES = {
  fast:         { tier: "light", temp: 0.4, frag: "FAST MODE: minimize reasoning; give a concise, direct answer; use tools only if necessary." },
  normal:       { tier: "main",  temp: 0.7, frag: "" },
  draft:        { tier: "main",  temp: 0.8, frag: "DRAFT MODE: produce a clean, reusable, well-structured document; use headings and lists; keep it editable. Avoid irreversible actions." },
  deep_think:   { tier: "main",  temp: 0.5, frag: "DEEP THINK MODE: reason carefully through the steps and tradeoffs; give a structured, thorough answer; summarize your reasoning rather than dumping raw chain-of-thought." },
  long_context: { tier: "main",  temp: 0.5, num_ctx: 32768, frag: "LONG CONTEXT MODE: the input may be large; be systematic and note which parts you used." },
  tool:         { tier: "main",  temp: 0.5, frag: "TOOL MODE: prefer acting through tools over describing what could be done. Read current state first, then act, then confirm exactly what you did." },
  mentor:       { tier: "main",  temp: 0.5, frag: "MENTOR MODE: give your best answer — it will be independently critiqued afterwards, so be precise and flag any uncertainty honestly." },
  // as_fred runs think:false (CPU latency), so without a private reasoning channel the model will
  // plan OUT LOUD unless ordered to answer directly — the "begin immediately" line is load-bearing.
  as_fred:      { tier: "main",  temp: 0.85, frag: "AS-FRED MODE: write and think AS Frederick Wolfe, in his own voice — using his profile and the real writing examples provided. Two layers, both mandatory: (1) CONTENT — Fred's convictions and stated positions govern what the answer SAYS; when his profile or excerpts state his position on the question, that position is the answer, never a generic or contrary one. (2) STYLE — inhabit his humor, vocabulary, wit, and rhythm. Never announce that you are imitating him and never mention models or being an AI. Begin IMMEDIATELY with Fred's actual answer — the first word of your output is the first word Fred would say. Never narrate the mode, the date, your instructions, your plan, or your process; no preamble of any kind." },
};
// Mode "heaviness" ranking — the router takes the STRONGER of (heuristic, light-model classifier)
// so it can never under-escalate a hard prompt down to the 8B (the old under-escalation bug).
const RANK_MODE = ["fast", "normal", "draft", "deep_think", "long_context"];
const MODE_RANK = { fast: 0, normal: 1, draft: 2, deep_think: 3, long_context: 4 };

// Basic model-usage logging (Phase 1 deliverable) — one JSONL line per run, including interrupted ones.
const LOG_DIR = cfgGet("LOG_DIR", join(HERE, "logs"));
let logDirReady = false;
async function logUsage(entry) {
  try {
    if (!logDirReady) { await mkdir(LOG_DIR, { recursive: true }); logDirReady = true; }
    await appendFile(join(LOG_DIR, "usage.jsonl"), JSON.stringify(entry) + "\n");
  } catch {}
}
const estTokens = (chars) => Math.ceil((chars || 0) / 4);

// Derive an artifact title from a generated document (first heading / first line).
function deriveTitle(text, lastUser) {
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const h = lines.find((l) => /^#{1,6}\s+/.test(l));
  let t = (h ? h.replace(/^#{1,6}\s+/, "") : (lines[0] || "")).replace(/[*_`#>]/g, "").trim();
  if (!t && lastUser) t = String(lastUser.content || "").slice(0, 60);
  return (t || "Draft").slice(0, 80);
}

// Tool-run lifecycle log (Phase 3) -> logs/toolruns.jsonl, plus an in-memory tail for the UI.
// The tail reloads from the JSONL on boot so the Tool-activity panel survives server restarts.
const toolRunTail = [];
try {
  const raw = readFileSync(join(LOG_DIR, "toolruns.jsonl"), "utf8").trim().split("\n").slice(-200);
  for (const line of raw) { try { toolRunTail.push(JSON.parse(line)); } catch {} }
} catch {}
async function logToolRun(entry) {
  try {
    toolRunTail.push(entry); if (toolRunTail.length > 200) toolRunTail.shift();
    if (!logDirReady) { await mkdir(LOG_DIR, { recursive: true }); logDirReady = true; }
    await appendFile(join(LOG_DIR, "toolruns.jsonl"), JSON.stringify(entry) + "\n");
  } catch {}
}
const newRunId = () => "tr_" + randomUUID().slice(0, 8);
// (needsConfirm / lifecycle / passConfirmGate now live in tools.mjs — the C2 lifecycle machinery.)

// Pending tool confirmations (Phase 3 confirmation flow). runId -> resolver. Default OFF under LAX;
// turned on per-request via {confirmTools:true} or server-wide via CONFIRM_TOOLS=1.
const pendingConfirms = new Map();
function awaitConfirm(runId, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingConfirms.delete(runId); resolve("timeout"); }, timeoutMs);
    pendingConfirms.set(runId, (decision) => { clearTimeout(t); pendingConfirms.delete(runId); resolve(decision); });
  });
}
const CONFIRM_TOOLS_ENV = String(cfgGet("CONFIRM_TOOLS", "0")) === "1";

// Phase 5: mentor bridge + improvement flywheel. Mentor defaults LOCAL (no egress); external is
// opt-in via MENTOR_PROVIDER=external + MENTOR_API_KEY + MENTOR_MODEL. Auto-review default OFF (LAX).
// (Placed after MAIN_MODEL so the const is initialized before createMentor reads it.)
const FLYWHEEL_DIR = cfgGet("FLYWHEEL_DIR", "C:\\minipc-chat\\flywheel");
const flywheel = createFlywheel({ dir: FLYWHEEL_DIR });
const mentor = createMentor({
  localChat: (m, msgs, o) => ollamaChat(m, msgs, o),
  mainModel: MAIN_MODEL,
  cfg: { provider: cfgGet("MENTOR_PROVIDER", "local"), apiKey: cfgGet("MENTOR_API_KEY", ""), model: cfgGet("MENTOR_MODEL", ""), endpoint: cfgGet("MENTOR_ENDPOINT", "https://openrouter.ai/api/v1/chat/completions") },
});
CTX.mentor = mentor;
CTX.flywheel = flywheel;
// Auto mentor review — DEFAULT ON per Fred's LAX call (the self-improving loop stays alive):
// tiered + sampled + fire-and-forget, all local (zero egress). AUTO_MENTOR=0 is the cautious flip.
const AUTO_MENTOR = String(cfgGet("AUTO_MENTOR", "1")) !== "0";
// Periodic mentor review (spec): every Nth completed answer gets a lightweight LOCAL critique in the
// background — catches drift without per-response cost. Default ON (local-only = zero egress);
// PERIODIC_MENTOR=0 disables, PERIODIC_MENTOR_EVERY tunes the stride.
const PERIODIC_MENTOR = String(cfgGet("PERIODIC_MENTOR", "1")) !== "0";
const PERIODIC_EVERY = Math.max(5, Number(cfgGet("PERIODIC_MENTOR_EVERY", "25")) || 25);
let completedRuns = 0;
// The review engine (Phase 5, full): 8 auto triggers, 10-category ADAPTIVE sampling, 4 tiers
// (light-model screen before any full 30B review), and the 10-step critique→improvement pipeline.
// REVIEW_AUTO_APPLY=0 stops auto-applying even the safe classes (evals/memory) — cautious flip.
const reviewEngine = createReviewEngine({
  mentor, flywheel, memory,
  ollamaChat: (m, msgs, o) => ollamaChat(m, msgs, o),
  lightModel: LIGHT_MODEL, mainModel: MAIN_MODEL,
  autoApply: String(cfgGet("REVIEW_AUTO_APPLY", "1")) !== "0",
  toolNames: TOOL_DEFS.map((d) => d.function.name),   // C3: mentor tool findings map to real tools -> overlays
  waitIdle: () => waitInteractiveIdle(),               // background reviews defer to live chats
  log: (s) => console.log("[dominion-ai] " + s),
});
// C4: the formatting tools run on the LIGHT model through this hook (fast + cheap by design).
CTX.lightChat = (messages, o = {}) => ollamaChat(LIGHT_MODEL, messages, { noTools: true, ...o });

function systemPrompt(persona, modeFrag) {
  let s = [
    "You are Dominion AI, Frederick (Fred) Wolfe's personal assistant. Today is " + new Date().toISOString().slice(0, 10) + ".",
    "You run on his always-on mini-PC and you have real tools (hands). Use them when they help —",
    "don't just describe what could be done; do it. Prefer reading current state (e.g. deck_list_projects,",
    "forge_read) before acting so you work from facts, not guesses.",
    "Keep replies concise and direct. Don't fabricate file contents, project ids, or results — read them.",
    "Real code/file changes go through forge_send. The sandbox is your private scratch space for drafts/notes.",
    "When you finish a tool action, briefly confirm what you actually did.",
  ].join(" ");
  // Versioned prompt overlays (spec PromptVersion): active global + mode-scope prompts append here.
  for (const p of [...flywheel.activePrompts("global"), ...flywheel.activePrompts("mode")]) s += "\n\n" + p.content;
  if (modeFrag) s += "\n\n" + modeFrag;
  if (persona) s += "\n\nFor this conversation, adopt this style/role: " + persona;
  return s;
}

async function ollamaChat(model, messages, opts = {}) {
  return await new Promise((resolve) => {
    if (opts.signal && opts.signal.aborted) return resolve(null);
    const payload = { model, messages, stream: false };
    // Model residency (RAM pressure fix): the 17.7GB 30B stays hot for an hour; the light model
    // expires after 5m so IT gets evicted first instead of swapping the big one out mid-conversation.
    payload.keep_alive = opts.keep_alive || (model === MAIN_MODEL ? "60m" : "5m");
    // C3: tool defs are assembled LIVE with the flywheel's active description overlays, so mentor
    // tool-guidance actually changes what the model sees about each tool at prompt time.
    if (!opts.noTools) payload.tools = toolDefs(flywheel.activeToolOverlays());
    if (opts.format) payload.format = opts.format;   // e.g. "json" — forces valid JSON, suppresses thinking spill
    if (opts.think === false) payload.think = false;  // disable qwen3 reasoning for structured extraction (thinking-on + json grammar collapses to "{}")
    const options = {};
    if (typeof opts.temperature === "number") options.temperature = opts.temperature;
    if (typeof opts.num_ctx === "number") options.num_ctx = opts.num_ctx;
    if (typeof opts.num_predict === "number") options.num_predict = opts.num_predict;
    if (Object.keys(options).length) payload.options = options;
    const body = JSON.stringify(payload);
    const r = http.request(
      { protocol: ou.protocol, hostname: ou.hostname, port: ou.port || 80, path: "/api/chat", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 180000 },
      (resp) => { let buf = ""; resp.on("data", (d) => (buf += d)); resp.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } }); }
    );
    if (opts.signal) opts.signal.addEventListener("abort", () => { try { r.destroy(); } catch {} resolve(null); }, { once: true });
    r.on("error", () => resolve(null));
    r.on("timeout", () => { r.destroy(); resolve(null); });
    r.write(body); r.end();
  });
}

// Deterministic length/keyword heuristic — the PRIMARY routing signal, immune to the 8B emitting
// bad JSON. Returns a mode "rank" + whether the main (30B) model is warranted.
function heuristicRoute(lastUser, totalInputChars) {
  const t = String(lastUser || "");
  const low = t.toLowerCase();
  const inTok = estTokens(totalInputChars);

  // size gate -> long context, only when the input is genuinely large
  if (inTok > 6000 || t.length > 8000) return { rank: MODE_RANK.long_context, wantMain: true, confident: true, reason: `large input (~${inTok} tok)` };

  if (/^(hi|hey+|hello|yo|sup|thanks|thank you|thx|ok(ay)?|yes|no|cool|nice|got it|good (morning|night|evening)|gm|gn)[!. ]*$/.test(low.trim()))
    return { rank: MODE_RANK.fast, wantMain: false, confident: true, reason: "trivial greeting/ack" };

  const codeRe   = /(\bcode\b|function|refactor|stack ?trace|regex|\bsql\b|typescript|javascript|python|\bnode\b|compile|exception|traceback|algorithm|\bschema\b|migration|debug|\bapi\b|async|class |def |npm |git )/;
  const reasonRe = /(architect|design (a|an|the|my|our)|trade[- ]?off|compare|evaluat|strategy|\bplan\b|root cause|why (does|is|are|do)|step[- ]by[- ]step|pros and cons|optimi|prove|analyz|reason through|figure out|how (should|would|do) (i|we|you))/;
  const docRe    = /(draft|write (a|an|the|me) |compose|proposal|\breport\b|\bessay\b|outline|readme|\bspec\b|\bletter\b|\bblog\b|article|\bmemo\b|\bguide\b|document )/;

  let rank = MODE_RANK.normal, wantMain = false, reason = "general";
  if (docRe.test(low))    { rank = Math.max(rank, MODE_RANK.draft);      wantMain = true; reason = "document drafting"; }
  if (reasonRe.test(low)) { rank = Math.max(rank, MODE_RANK.deep_think); wantMain = true; reason = "reasoning/analysis"; }
  if (codeRe.test(low))   { rank = Math.max(rank, MODE_RANK.deep_think); wantMain = true; reason = "code/technical"; }
  // long, detailed single prompts deserve the main model even below the long-context gate
  if (t.length > 1500 && rank < MODE_RANK.deep_think) { rank = MODE_RANK.deep_think; wantMain = true; reason = "long detailed prompt"; }

  // confident enough to skip the slower 8B classifier when we already see a clear signal
  const confident = wantMain || t.length < 60;
  return { rank, wantMain, confident, reason };
}

// Privacy-risk sniff (spec router field): sensitive content keeps mentor traffic local and is logged.
const PRIVACY_RE = /\b(password|passphrase|passcode|ssn|social security|credit card|card number|routing number|bank account|account number|medical|diagnos\w*|prescription|therapy|salary|tax return|api[ _-]?key|secret key)\b/i;
const privacyRiskOf = (t) => (PRIVACY_RE.test(String(t || "")) ? "high" : "low");

// Secondary signal: a quick light-model classification. Only consulted for ambiguous middle cases.
async function classifyRoute(lastUser) {
  const prompt =
    "You are a routing classifier for a local AI assistant. Read the request and reply with ONLY compact JSON, no prose:\n" +
    '{"tier":"light|main","mode":"fast|normal|deep_think|long_context|draft","reason":"few words"}\n' +
    "tier light = short/simple/chat/summaries/classification/UI; tier main = real reasoning, coding, document drafting, multi-step analysis. " +
    "mode fast = trivial; deep_think = hard reasoning; long_context = very large input; draft = producing a document; normal = otherwise.\n\nRequest:\n" +
    String(lastUser || "").slice(0, 2000);
  const d = await ollamaChat(LIGHT_MODEL, [{ role: "user", content: prompt }], { temperature: 0, num_predict: 200, noTools: true });
  const txt = stripThink((d && d.message && d.message.content) || "");
  const m = txt.match(/\{[\s\S]*\}/);
  let r = {}; if (m) { try { r = JSON.parse(m[0]); } catch {} }
  const rank = MODE_RANK[r.mode] != null ? MODE_RANK[r.mode] : MODE_RANK.normal;
  return { rank, wantMain: r.tier === "main", reason: String(r.reason || "").slice(0, 60), ok: !!m };
}

// Combined auto-router: take the STRONGER of heuristic vs classifier -> full RouteDecision.
// This is the fix for the under-escalation bug: a hard prompt can never be dragged below 30B.
async function routeDecision(lastUser, totalInputChars) {
  const h = heuristicRoute(lastUser, totalInputChars);
  let rank = h.rank, wantMain = h.wantMain, reason = h.reason, src = "heuristic";
  if (!h.confident) {
    const c = await classifyRoute(lastUser);
    if (c.ok && (c.rank > rank || (c.wantMain && !wantMain))) {
      rank = Math.max(rank, c.rank); wantMain = wantMain || c.wantMain; reason = c.reason || reason; src = "classifier";
    }
  }
  let mode = RANK_MODE[rank] || "normal";
  let tier = MODES[mode].tier;
  if (wantMain && tier !== "main") { mode = "deep_think"; tier = "main"; }   // honor main even on a light-tier mode
  const t = String(lastUser || "").toLowerCase();
  // Routing confidence (spec quality.confidence seed): a confident heuristic beats a classifier
  // verdict beats a shrug. Surfaced in the route/done SSE meta and consumed by computeQuality.
  const confidence = h.confident ? 0.9 : src === "classifier" ? 0.7 : 0.55;
  // D1: the full spec routing decision (spec ~352-363) — route enum + needs_* + confidence +
  // reason, ALL consumed downstream (D3) and logged to usage.jsonl + the route SSE event.
  return {
    route: routeOf(tier, mode),
    mode, tier, reason: `${src}: ${reason}`.slice(0, 80), confidence,
    privacyRisk: privacyRiskOf(lastUser),
    needsTools: /\b(deck|forge|file|sandbox|remember|artifact|project|capture|run|search|export|save|write|python|scrape)\b/.test(t),
    needsMemory: true,                       // approved memory is always considered
    // D3: self-contained transform asks skip retrieval even outside fast mode.
    needsRetrieval: mode !== "fast" && !NO_RETRIEVAL_RE.test(String(lastUser || "").trim()),
    // Real pre-answer signal (spec): explicit critique ask or hallucination-prone/high-stakes topic.
    // Consumed post-answer — it forces the review path instead of leaving it to sampling luck.
    needsMentorReview: wantsReview(lastUser),
  };
}

// Context builder (Phase 2, full): always-on durable memory (pinned + profile) + query-relevant
// approved memory (HYBRID lexical+vector) + relevant saved artifacts + snippets from earlier
// conversations + active retrieval-scope rules. Pending/rejected/archived memory never appears.
// Returns everything injected (for logging + the mentor review package) and a compact block.
async function buildContext(lastUserText, chatId, { skipRetrieval = false, mode = "", model = "" } = {}) {
  // B2: the LIVE scope context — chat-scoped memories only surface in their chat, tool-scoped
  // only in tool contexts, model-scoped only on the matching model. Global always loads.
  const scopeCtx = { chatId, mode, model };
  const pinned = memory.alwaysLoaded({ limit: 6, scopeCtx });
  const retrieved = skipRetrieval ? [] : await memory.retrieveHybrid(lastUserText || "", { limit: 4, scopeCtx });
  const seen = new Set(), used = [];
  for (const c of [...pinned, ...retrieved]) { if (seen.has(c.id)) continue; seen.add(c.id); used.push(c); }
  const parts = [];
  if (used.length) parts.push("Relevant saved memory about Fred (use it when helpful; don't recite it verbatim unless asked):\n" + used.map((c) => `- (${c.title}) ${c.content}`).join("\n"));
  let artifactsUsed = [], chatsUsed = [];
  if (!skipRetrieval && lastUserText) {
    artifactsUsed = artifacts.list({ q: lastUserText }).slice(0, 2);
    if (artifactsUsed.length) parts.push("Possibly relevant saved artifacts (open with read_artifact if needed):\n" + artifactsUsed.map((a) => `- [${a.id.slice(0, 8)}] ${a.title} (${a.type}, v${a.version})`).join("\n"));
    chatsUsed = chatlog.search(lastUserText, { limit: 2, excludeId: chatId });
    if (chatsUsed.length) parts.push("From earlier conversations with Fred:\n" + chatsUsed.map((h) => `- "${h.title}": ${h.snippet.slice(0, 220)}`).join("\n"));
  }
  const retrievalRules = flywheel.activeRules("retrieval").filter((r) => r.scope === "retrieval");
  if (retrievalRules.length) parts.push("Retrieval guidance — follow these when deciding what to look up:\n" + retrievalRules.map((r) => "- " + r.content).join("\n"));
  return { used, artifactsUsed, chatsUsed, block: parts.join("\n\n") };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve(null); } });
  });
}

// Memory API (Phase 2 inbox/approval): GET list, POST create, POST /update, POST /delete.
async function handleMemory(req, res, u) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const path = u.pathname;
  if (req.method === "GET" && path === "/memory") {
    const items = memory.list({ status: u.searchParams.get("status") || "", type: u.searchParams.get("type") || "", q: u.searchParams.get("q") || "" });
    return json(200, { items, stats: memory.stats() });
  }
  if (req.method === "POST" && path === "/memory") {
    const body = await readJsonBody(req); if (!body) return json(400, { error: "bad json" });
    const r = memory.propose({ content: body.content, type: body.type, tags: body.tags, scope: body.scope, scopeRef: body.scopeRef, pinned: body.pinned, source: { kind: body.source || "user_explicit" } });
    return json(r.error ? 400 : 200, r);
  }
  if (req.method === "POST" && path === "/memory/update") {
    const body = await readJsonBody(req); if (!body || !body.id) return json(400, { error: "id required" });
    return json(200, memory.update(body.id, body));
  }
  if (req.method === "POST" && path === "/memory/delete") {
    const body = await readJsonBody(req); if (!body || !body.id) return json(400, { error: "id required" });
    return json(200, memory.remove(body.id));
  }
  // Episodic memory (spec): summarize a finished conversation into one durable dated line.
  // The client fires this when Fred leaves a chat; dedupe + gating in the store keep it clean.
  if (req.method === "POST" && path === "/memory/summarize-session") {
    const body = await readJsonBody(req); if (!body || !body.chatId) return json(400, { error: "chatId required" });
    const c = chatlog.get(body.chatId);
    if (!c || c.turns.length < 4) return json(200, { skipped: "too short to summarize" });
    if (c.summarized && !body.force) return json(200, { skipped: "already summarized" });
    const transcript = c.turns.map((t) => (t.role === "user" ? "Fred: " : "Assistant: ") + t.content).join("\n").slice(0, 6000);
    const prompt = "Summarize this conversation into ONE durable episodic memory line (max 40 words) capturing any decision, preference, or outcome worth remembering later. If nothing durable happened, reply exactly: NONE.\n\n" + transcript;
    const d = await ollamaChat(LIGHT_MODEL, [{ role: "user", content: prompt }], { temperature: 0.2, num_predict: 200, noTools: true });
    const line = stripThink((d && d.message && d.message.content) || "").replace(/^["']|["']$/g, "").trim();
    if (!line || /^NONE\b/i.test(line)) { chatlog.markSummarized(body.chatId); return json(200, { skipped: "nothing durable" }); }
    const r = memory.propose({ content: `On ${new Date().toISOString().slice(0, 10)} ("${c.title}"): ${line}`.slice(0, 400), type: "episodic", source: { kind: "assistant_inferred", referenceId: body.chatId }, tags: ["session-summary"] });
    chatlog.markSummarized(body.chatId);
    return json(200, r);
  }
  return json(404, { error: "not found" });
}

// Tool-run log (Phase 3 tool log UI): GET /toolruns -> recent tool runs (newest first).
function handleToolRuns(req, res) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ runs: [...toolRunTail].reverse().slice(0, 100) }));
}

// Tool confirmation callback (Phase 3): the client POSTs {runId, approved} to approve/deny a gated tool.
async function handleToolConfirm(req, res) {
  const body = await readJsonBody(req);
  const ok = body && pendingConfirms.has(body.runId);
  if (ok) pendingConfirms.get(body.runId)(body.approved ? "approved" : "denied");
  res.writeHead(ok ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok }));
}

// Structured document review (spec Document Review Output Schema): the mentor returns the 10
// machine-readable fields; a readable rendering is attached to the artifact, the structured object
// is stored as a review record and returned to the client.
function renderDocReview(r) {
  return [
    `SCORE: ${r.overall_score}/10 · READY FOR USE: ${r.ready_for_use ? "yes" : "no"} · REVISION RECOMMENDED: ${r.should_generate_revision ? "yes" : "no"}`,
    r.major_issues.length ? "MAJOR ISSUES:\n" + r.major_issues.map((x) => "- " + x).join("\n") : "",
    r.minor_issues.length ? "MINOR ISSUES:\n" + r.minor_issues.map((x) => "- " + x).join("\n") : "",
    r.unsupported_claims.length ? "UNSUPPORTED CLAIMS:\n" + r.unsupported_claims.map((x) => "- " + x).join("\n") : "",
    r.risk_flags.length ? "RISK FLAGS:\n" + r.risk_flags.map((x) => "- " + x).join("\n") : "",
    r.clarity_suggestions.length ? "CLARITY:\n" + r.clarity_suggestions.map((x) => "- " + x).join("\n") : "",
    r.formatting_suggestions.length ? "FORMATTING:\n" + r.formatting_suggestions.map((x) => "- " + x).join("\n") : "",
    r.recommended_revision_plan.length ? "REVISION PLAN:\n" + r.recommended_revision_plan.map((x, i) => `${i + 1}. ${x}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
}

// Background artifact review — server-side detection, never a client confirm(). Fire-and-forget;
// results attach to the artifact (structured review stored for the E2 unsupported-claims check)
// and land in the reviews store. One in-flight review per artifact keeps the CPU box sane.
const artifactReviewsInFlight = new Set();
function scheduleArtifactReview(a, triggers) {
  if (!AUTO_MENTOR || !a) return;
  const trig = Array.isArray(triggers) ? triggers : [String(triggers || "manual")];
  if (artifactReviewsInFlight.has(a.id)) return;
  artifactReviewsInFlight.add(a.id);
  setImmediate(async () => {
    try {
      await waitInteractiveIdle();   // never contend with a live chat — defer, don't drop
      const r = await mentor.documentReview({ title: a.title, type: a.type, content: a.content, privacyMode: "local_only" });
      artifacts.attachReview(a.id, `AUTO REVIEW (${trig.join("+")}, local mentor):\n\n` + renderDocReview(r), r);
      flywheel.addReview({ tier: 2, trigger: trig, taskType: "document_review", artifactId: a.id, provider: r._provider, critique: r, contentPreview: String(a.content || "").slice(0, 300) });
      if (!r.ready_for_use && (r.major_issues.length || r.risk_flags.length)) {
        flywheel.addFailure({ category: r.unsupported_claims.length ? "unsupported_factual_claim" : "weak_structure", severity: r.risk_flags.length ? "high" : "medium", originalRequest: "artifact: " + a.title, flawedOutput: String(a.content || "").slice(0, 4000), detectedBy: "mentor", rootCause: r.unsupported_claims.length ? "missing_retrieval" : "bad_prompt", improvementActions: ["add_eval", r.unsupported_claims.length ? "update_retrieval" : "update_prompt"], samplingCategory: "finalArtifact" });
      }
      console.log(`[dominion-ai] auto artifact review (${trig.join("+")}): "${a.title}" score ${r.overall_score}/10 ready=${r.ready_for_use}`);
    } catch {} finally { artifactReviewsInFlight.delete(a.id); }
  });
}

// E1: ONE server-side sweep of the nine artifact mentor-review triggers (spec 1011-1023).
// Runs on create / revise / mark-final / export — REST and tool paths alike. Any firing trigger
// marks the artifact review-recommended (additive field the UI can show) and schedules a
// background documentReview unless the CURRENT version was already reviewed.
function evalArtifactTriggers(id, sig = {}) {
  const a = artifacts.get(id); if (!a) return null;
  let driftRatio = null;
  if (a.reviewedVersion && a.versionCount >= 2 && a.reviewedVersion !== a.version) {
    try { driftRatio = artifacts.changeRatio(id, a.reviewedVersion, a.version); } catch {}
  }
  const triggers = detectArtifactTriggers(a, { ...sig, driftRatio });
  if (!triggers.length) return { triggers };
  artifacts.flagReview(id, triggers);
  const reviewedCurrent = a.mentorReviewed && a.reviewedVersion === a.version;
  if (!reviewedCurrent) scheduleArtifactReview(a, triggers);
  return { triggers, driftRatio };
}

// Artifact studio API (Phase 4): list/get/create/version/update/delete/diff/export/review.
async function handleArtifacts(req, res, u) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  if (req.method === "GET" && p === "/artifacts") return json(200, { items: artifacts.list({ status: u.searchParams.get("status") || "", type: u.searchParams.get("type") || "", q: u.searchParams.get("q") || "" }), stats: artifacts.stats() });
  if (req.method === "GET" && p === "/artifacts/get") { const a = artifacts.get(u.searchParams.get("id")); return json(a ? 200 : 404, a || { error: "not found" }); }
  if (req.method === "GET" && p === "/artifacts/content") { const c = artifacts.getContent(u.searchParams.get("id"), Number(u.searchParams.get("v")) || 0); return json(c == null ? 404 : 200, { content: c || "" }); }
  if (req.method === "GET" && p === "/artifacts/diff") return json(200, artifacts.diff(u.searchParams.get("id"), Number(u.searchParams.get("a")) || 0, Number(u.searchParams.get("b")) || 0));
  if (req.method === "POST") {
    const body = await readJsonBody(req); if (!body) return json(400, { error: "bad json" });
    if (p === "/artifacts") {
      const r = artifacts.create(body);
      if (r.item) evalArtifactTriggers(r.item.id, {});   // E1: trigger sweep on creation
      return json(200, r);
    }
    if (p === "/artifacts/version") {
      const r = artifacts.addVersion(body.id, body);     // E4: body may carry per-version provenance
      if (r.item) evalArtifactTriggers(body.id, {});     // E1: drift & co. re-checked on revision
      return json(200, r);
    }
    if (p === "/artifacts/setversion") return json(200, artifacts.setVersion(body.id, Number(body.version)));
    if (p === "/artifacts/update") {
      const wasFinal = (artifacts.get(body.id) || {}).status === "final";
      const r = artifacts.update(body.id, body);
      // E1: user marks an artifact FINAL → full trigger sweep (final_output + whatever else fires).
      if (!wasFinal && body.status === "final" && r.item) evalArtifactTriggers(body.id, { markedFinal: true });
      return json(200, r);
    }
    if (p === "/artifacts/delete") return json(200, artifacts.remove(body.id));
    if (p === "/artifacts/export") {
      // E2: the single gated export path (safety checks + native generation + Forge fallback).
      const r = await exportGated(body.id, body.format, { destination: body.destination, overrideSensitive: body.override_sensitive === true });
      // E1: artifact exported → trigger sweep (external_send + whatever else fires).
      if (!r.error && !r.blocked) evalArtifactTriggers(body.id, { exported: true });
      return json(200, r);
    }
    if (p === "/artifacts/review") {
      const a = artifacts.get(body.id); if (!a) return json(404, { error: "not found" });
      const review = await mentor.documentReview({ title: a.title, type: a.type, content: a.content, originalRequest: body.originalRequest || "", privacyMode: body.privacyMode || "local_only" });
      const attached = artifacts.attachReview(body.id, `DOCUMENT REVIEW (${review._provider}):\n\n` + renderDocReview(review), review);
      flywheel.addReview({ tier: 2, trigger: ["manual"], taskType: "document_review", artifactId: a.id, provider: review._provider, critique: review, contentPreview: String(a.content || "").slice(0, 300) });
      return json(200, { ...attached, review });   // additive: structured 10-field schema rides along
    }
    if (p === "/artifacts/duplicate") return json(200, artifacts.duplicate(body.id, { asTemplate: !!body.asTemplate }));
    if (p === "/artifacts/transform") return json(200, await transformArtifact(body.id, body.kind));
  }
  return json(404, { error: "not found" });
}

// Artifact transforms (spec actions): checklist / extract tasks / extract memory candidates.
// The main model does the conversion; results land as a new artifact or proposed memories.
async function transformArtifact(id, kind) {
  const a = artifacts.get(id); if (!a) return { error: "not found" };
  const src = String(a.content || "").slice(0, 12000);
  if (kind === "checklist" || kind === "tasks") {
    const prompt = (kind === "checklist"
      ? "Convert this document into a clean, actionable markdown checklist (- [ ] items, grouped under headings where natural). Output ONLY the checklist."
      : "Extract every actionable task from this document as a markdown checklist (- [ ] items), most important first. Output ONLY the checklist.") +
      "\n\nDOCUMENT:\n" + src;
    const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: prompt }], { temperature: 0.3, num_predict: 2000, noTools: true });
    const out = stripThink((d && d.message && d.message.content) || "");
    if (!out) return { error: "the model produced nothing — try again" };
    return artifacts.create({ title: (kind === "checklist" ? "Checklist — " : "Tasks — ") + a.title, type: "checklist", content: out, model: MAIN_MODEL, sourceChatId: a.sourceChatId, promptSummary: kind + " extracted from " + a.id.slice(0, 8) });
  }
  if (kind === "memory") {
    const prompt = 'Extract up to 5 DURABLE facts or preferences from this document that are worth remembering long-term (skip one-off details). Return ONLY a JSON array of short strings.\n\nDOCUMENT:\n' + src;
    const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: prompt }], { temperature: 0.2, num_predict: 800, noTools: true, format: "json" });
    const txt = stripThink((d && d.message && d.message.content) || "");
    let arr = []; try { const j = JSON.parse(txt); arr = Array.isArray(j) ? j : Array.isArray(j.facts) ? j.facts : Object.values(j).find(Array.isArray) || []; } catch {}
    const saved = [];
    for (const f of arr.slice(0, 5)) { const r = memory.propose({ content: String(f), type: "workspace", source: { kind: "assistant_inferred", referenceId: a.id }, tags: ["from-artifact"] }); if (r.item && !r.deduped) saved.push(r.item.content); }
    return { saved, count: saved.length };
  }
  return { error: "unknown transform: " + kind };
}

// E2 + E3: the ONE gated export path. Every export — REST endpoint AND the model-facing
// export_artifact / create_docx / create_pdf / create_spreadsheet tools (via CTX.exportGated) —
// passes the seven-check safety gate, then generates NATIVELY (docwriters.mjs via the artifact
// store). The Forge work-order conversion survives ONLY as the docx/pdf fallback when native
// generation throws. EXPORT_SAFETY=spec makes warning-bearing exports require confirmed:true;
// the default LAX posture returns the warnings and proceeds — EXCEPT sensitive-data, which
// requires an explicit override in both modes.
const EXPORT_SAFETY_LAX = String(cfgGet("EXPORT_SAFETY", "lax")).toLowerCase() !== "spec";
async function exportGated(id, format, { destination = "", overrideSensitive = false, confirmed = false } = {}) {
  const a = artifacts.get(id); if (!a) return { error: "not found" };
  const gate = exportSafetyGate({ artifact: a, format, destination: destination || "local exports folder", overrideSensitive, lax: EXPORT_SAFETY_LAX, confirmed });
  if (!gate.ok) {
    console.log(`[dominion-ai] export BLOCKED (${gate.blocked}): "${a.title}" as ${gate.checks.format}`);
    return { blocked: gate.blocked, detected: gate.detected, error: gate.message, gate: { checks: gate.checks, warnings: gate.warnings } };
  }
  if (gate.warnings.length) console.log(`[dominion-ai] export warnings for "${a.title}": ${gate.warnings.map((w) => w.check).join(", ")} (proceeding — LAX)`);
  let r = artifacts.exportArtifact(id, gate.checks.format);
  if (r && r.nativeFailed && ["docx", "pdf"].includes(gate.checks.format)) {
    console.log(`[dominion-ai] native ${gate.checks.format} failed ("${r.error}") — falling back to the Forge work order`);
    r = await forgeConvertFallback(a, gate.checks.format);
  }
  if (r.error) return { ...r, gate: { checks: gate.checks, warnings: gate.warnings } };
  return { ...r, gate: { checks: gate.checks, warnings: gate.warnings } };
}
CTX.exportGated = exportGated;   // the tool bus goes through the same gate (bypass closed)

// Forge fallback (docx/pdf only, when the native writer throws): export the markdown source, then
// queue a Claude Code work order to convert it. Editable source is always preserved.
async function forgeConvertFallback(a, fmt) {
  const md = artifacts.exportArtifact(a.id, "md");
  if (md.error) return md;
  if (!CTX.runPassword) return { ...md, warning: `Native ${fmt} generation failed and the Forge fallback needs the run-password configured on the server — exported markdown instead.` };
  const instructions = `Convert the exported artifact markdown at ${md.path} into a well-formatted .${fmt} file saved NEXT TO the source (same folder, same base name, .${fmt} extension). Use your document skills; preserve headings, lists, and tables. Do not modify the source .md.`;
  const out = await runTool("forge_send", { repo: "cad-sandbox", title: `Export artifact "${a.title}" to ${fmt}`, instructions }, CTX);
  return { ...md, forge: String(out), queued: /Queued work order/i.test(String(out)) };
}

// Mentor review (Phase 5): critique an answer or artifact -> structured critique -> the FULL
// improvement pipeline (22-category classification, inferred root cause, candidate generation,
// queueing, safe auto-apply, retirement). Attaches review notes to an artifact when given an id.
async function handleMentorReview(req, res) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const b = await readJsonBody(req); if (!b) return json(400, { error: "bad json" });
  let content = String(b.content || "");
  if (b.artifactId) { const a = artifacts.get(b.artifactId); if (a) content = a.content; }
  if (!content.trim()) return json(400, { error: "nothing to review" });
  const c = await mentor.critique({ taskType: b.taskType || "answer_review", originalRequest: b.originalRequest || "", content, privacyMode: b.privacyMode || (mentor.info().externalConfigured ? "redacted_external" : "local_only"), artifactId: b.artifactId, chatId: b.chatId });
  const pipeline = await reviewEngine.runPipeline(c, { answer: content, originalRequest: b.originalRequest || "", chatId: b.chatId, artifactId: b.artifactId, samplingCategory: "userMarkedImportant", tier: 2 });
  const rec = flywheel.addReview({ tier: 2, trigger: ["manual"], taskType: b.taskType || "answer_review", chatId: b.chatId, artifactId: b.artifactId, provider: c._provider, critique: c, request: c._request, pipeline: { valid: pipeline.valid, ledgerId: pipeline.ledgerId, classification: pipeline.classification, generated: pipeline.generated, autoApplied: pipeline.autoApplied }, contentPreview: content.slice(0, 300) });
  if (b.artifactId) artifacts.attachReview(b.artifactId, "MENTOR (" + c._provider + "):\n" + (c.recommended_revision || "") + "\n\nMajor findings: " + (c.major_findings || []).join("; "));
  return json(200, { critique: c, ledgerId: pipeline.ledgerId || null, classification: pipeline.classification, pipeline: { generated: pipeline.generated, autoApplied: pipeline.autoApplied }, reviewId: rec.item.id, mentor: mentor.info() });
}

// Tier-3 Multi-Mentor Council (spec): several role-specialized mentors review independently, then a
// reconciliation pass merges agreements/conflicts. Manual / high-stakes only — N+1 heavy model calls
// on this box. Council results are stored as eval cases (spec: "store results as evals").
async function handleMentorCouncil(req, res) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const b = await readJsonBody(req); if (!b) return json(400, { error: "bad json" });
  let content = String(b.content || "");
  if (b.artifactId) { const a = artifacts.get(b.artifactId); if (a) content = a.content; }
  if (!content.trim()) return json(400, { error: "nothing to review" });
  const roles = Array.isArray(b.roles) ? b.roles.filter((r) => MENTOR_ROLES[r]) : undefined;
  const result = await mentor.council({ content, originalRequest: b.originalRequest || "", roles, taskType: b.taskType || "answer_review", privacyMode: b.privacyMode || "local_only", chatId: b.chatId, artifactId: b.artifactId });
  const pipeline = await reviewEngine.runPipeline(result.critique, { answer: content, originalRequest: b.originalRequest || "", chatId: b.chatId, artifactId: b.artifactId, samplingCategory: "userMarkedImportant", tier: 3 });
  const rec = flywheel.addReview({ tier: 3, trigger: ["council"], taskType: b.taskType || "answer_review", chatId: b.chatId, artifactId: b.artifactId, provider: result.critique._provider, critique: { ...result.critique, _council: { roles: result.roles, agreements: result.reconciliation.agreements, conflicts: result.reconciliation.conflicts, perRole: result.reviews.map((r) => ({ role: r.label, score: r.critique.overall_score, priority: r.critique.revision_priority })) } }, pipeline: { valid: pipeline.valid, ledgerId: pipeline.ledgerId, classification: pipeline.classification, generated: pipeline.generated, autoApplied: pipeline.autoApplied }, contentPreview: content.slice(0, 300) });
  if (b.artifactId) artifacts.attachReview(b.artifactId, "COUNCIL (" + result.roles.length + " mentors):\n" + (result.critique.recommended_revision || "") + "\n\nAgreements: " + result.reconciliation.agreements.join("; "));
  return json(200, { roles: result.roles, reviews: result.reviews.map((r) => ({ role: r.role, label: r.label, score: r.critique.overall_score, priority: r.critique.revision_priority, major_findings: r.critique.major_findings })), agreements: result.reconciliation.agreements, conflicts: result.reconciliation.conflicts, critique: result.critique, pipeline: { generated: pipeline.generated, autoApplied: pipeline.autoApplied }, reviewId: rec.item.id });
}

// Apply a mentor critique (spec "Apply revision"): the local model produces the revised output.
// With an artifactId the revision lands as a NEW version; otherwise the text comes back to the client.
async function handleMentorRevise(req, res) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const b = await readJsonBody(req); if (!b) return json(400, { error: "bad json" });
  let content = String(b.content || "");
  if (b.artifactId) { const a = artifacts.get(b.artifactId); if (a) content = a.content; }
  if (!content.trim()) return json(400, { error: "nothing to revise" });
  const revised = await mentor.revise({ originalRequest: b.originalRequest || "", content, critique: b.critique || {} });
  if (!revised) return json(500, { error: "the mentor produced no revision — try again" });
  // Fine-tuning candidate producer (spec allowed source "user-approved corrections"): Fred clicking
  // Apply revision IS the approval — the corrected pair queues as a candidate (still needs approval
  // in the finetune queue before any training use).
  if (b.originalRequest) flywheel.addFinetune({ input: b.originalRequest, idealOutput: revised, source: "user_approved_correction", notes: "from applied mentor revision", tags: ["revision"] });
  if (b.artifactId) return json(200, { revised, ...artifacts.addVersion(b.artifactId, { content: revised, model: MAIN_MODEL, promptSummary: "mentor revision applied" }) });
  return json(200, { revised });
}

// F2 (audit item 27, spec 1816/1432): Reject critique = a RECORDED rejection that feeds the
// pipeline — never just a DOM removal. Marks the stored review record rejected (or stores a
// standalone rejection record for SSE-only mentor-mode cards that never got a reviewId), REMOVES
// the critique's auto-created ledger entry (a rejected critique must not inflate the adaptive
// sampling failure counts), and logs the rejection to the pipeline log.
async function handleMentorReject(req, res) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const b = await readJsonBody(req); if (!b) return json(400, { error: "bad json" });
  const reason = String(b.reason || "").slice(0, 300);
  let reviewId = b.reviewId && flywheel.get("reviews", b.reviewId) ? b.reviewId : null;
  if (reviewId) {
    flywheel.update("reviews", reviewId, { rejected: true, rejectedAt: new Date().toISOString(), rejectReason: reason });
  } else {
    const rec = flywheel.addReview({ tier: 0, trigger: ["user_rejected"], taskType: String(b.taskType || "answer_review").slice(0, 40), chatId: b.chatId, provider: "user", critique: null, pipeline: { rejected: true }, contentPreview: String(b.contentPreview || "").slice(0, 300) });
    reviewId = rec.item.id;
    flywheel.update("reviews", reviewId, { rejected: true, rejectedAt: new Date().toISOString(), rejectReason: reason });
  }
  const ledgerRemoved = b.ledgerId ? (flywheel.remove("failures", b.ledgerId).removed || 0) : 0;
  flywheel.addPipelineLog({ step: "critique_rejected", reviewId, ledgerId: b.ledgerId || null, ledgerRemoved, reason });
  console.log(`[dominion-ai] critique rejected by Fred (review ${reviewId.slice(0, 8)}, ledger entries removed: ${ledgerRemoved})`);
  return json(200, { ok: true, reviewId, ledgerRemoved });
}

// Eval runner (Phase 5): route the case's input through the REAL router (so routing itself is
// testable), run it, judge it with the main model, store the run. extraRule lets /rules/test
// measure a candidate rule's effect without activating it.
async function runEval(id, { extraRule = null, record = true } = {}) {
  const ev = flywheel.get("evals", id); if (!ev) return { error: "not found" };
  const r = await routeDecision(ev.input, ev.input.length);
  const model = MODEL_FOR(r.tier);
  const msgs = [];
  if (extraRule) msgs.push({ role: "system", content: "Active learned rules — follow these:\n- " + extraRule });
  msgs.push({ role: "user", content: ev.input });
  const out = await ollamaChat(model, msgs, { temperature: 0.3, num_predict: 800, noTools: true });
  const output = stripThink((out && out.message && out.message.content) || "");
  const judgePrompt = 'You are scoring an AI answer. Return ONLY JSON {"score":0-10,"passed":true|false,"notes":"short"}.\nEXPECTED: ' + ev.expectedBehavior + (ev.forbiddenBehavior ? "\nFORBIDDEN: " + ev.forbiddenBehavior : "") + "\nRUBRIC: " + ev.scoringRubric + "\n\nINPUT: " + ev.input + "\n\nOUTPUT TO SCORE:\n" + output.slice(0, 4000);
  const jd = await ollamaChat(MAIN_MODEL, [{ role: "user", content: judgePrompt }], { temperature: 0, num_predict: 500, noTools: true, format: "json" });
  const jt = stripThink((jd && jd.message && jd.message.content) || ""); const m = jt.match(/\{[\s\S]*\}/);
  let parsed = { score: 0, passed: false, notes: jt.slice(0, 200) }; if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  const score = Number(parsed.score) || 0;
  let runItem = null;
  if (record) { const run = flywheel.addRun({ evalCaseId: id, modelProviderId: model, mode: r.mode, input: ev.input, output, score, passed: !!parsed.passed, mentorReviewed: true, notes: `route ${r.mode} (${r.reason}) · ` + (parsed.notes || "") }); runItem = run.item; }
  return { run: runItem, score, passed: !!parsed.passed, route: { mode: r.mode, reason: r.reason }, output: output.slice(0, 2000) };
}

// A/B a candidate rule (spec flywheel steps 8-10): run up to 3 evals baseline vs with-the-rule,
// store the delta on the rule. A negative delta = the rule makes things worse — retire it.
async function testRule(id) {
  const rule = flywheel.get("rules", id); if (!rule) return { error: "not found" };
  const evals = flywheel.list("evals").slice(0, 3);
  if (!evals.length) return { error: "no eval cases exist yet — add evals first, then test rules against them" };
  const results = [];
  for (const ev of evals) {
    const base = await runEval(ev.id, { record: false });
    const withRule = await runEval(ev.id, { extraRule: rule.content, record: false });
    if (base.error || withRule.error) continue;
    results.push({ evalId: ev.id, title: ev.title, before: base.score, after: withRule.score });
  }
  if (!results.length) return { error: "eval runs failed — is the model up?" };
  const avg = (k) => results.reduce((n, x) => n + x[k], 0) / results.length;
  const delta = Number((avg("after") - avg("before")).toFixed(2));
  flywheel.update("rules", id, { evalBefore: Number(avg("before").toFixed(2)), evalAfter: Number(avg("after").toFixed(2)), evalDelta: delta, testedAt: new Date().toISOString() });
  return { results, delta, verdict: delta > 0 ? "rule helps — consider activating" : delta < 0 ? "rule HURTS — retire it" : "no measurable effect" };
}

// Flywheel API (Phase 5): /ledger, /evals (+ /evals/run, /evals/runs), /rules (+ /rules/test),
// /prompts (+ /prompts/activate), /finetune (fine-tuning candidate queue), /reviews (stored
// background/auto critiques), /pipeline (improvement-pipeline log) — list/create/update/delete.
async function handleFlywheel(req, res, u) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  const MAP = { "/ledger": "failures", "/evals": "evals", "/rules": "rules", "/prompts": "prompts", "/finetune": "finetune", "/reviews": "reviews", "/pipeline": "pipeline", "/tool-overlays": "toolOverlays" };
  if (req.method === "GET") {
    if (MAP[p]) return json(200, { items: flywheel.list(MAP[p], { status: u.searchParams.get("status") || "" }), stats: flywheel.stats() });
    if (p === "/evals/runs") return json(200, { runs: flywheel.runsFor(u.searchParams.get("id")) });
    return json(404, { error: "not found" });
  }
  if (req.method === "POST") {
    const b = await readJsonBody(req); if (!b) return json(400, { error: "bad json" });
    if (p === "/ledger") return json(200, flywheel.addFailure(b));
    if (p === "/evals") return json(200, flywheel.addEval(b));
    if (p === "/rules") return json(200, flywheel.addRule(b));
    if (p === "/rules/retire") return json(200, { retired: flywheel.autoRetire() });
    if (p === "/prompts") return json(200, flywheel.addPrompt(b));
    if (p === "/prompts/activate") return json(200, flywheel.activatePrompt(b.id));
    if (p === "/finetune") return json(200, flywheel.addFinetune(b));   // source must be a spec-allowed clean source
    // C3: POST a per-tool description overlay. A manual POST defaults ACTIVE (Fred posting one
    // wants it live); pipeline-generated overlays arrive as candidates needing activation.
    if (p === "/tool-overlays") return json(200, flywheel.addToolOverlay({ ...b, status: b.status || "active", source: b.source || "manual" }));
    if (p === "/evals/run") return json(200, await runEval(b.id));
    if (p === "/rules/test") return json(200, await testRule(b.id));
    for (const [path, coll] of Object.entries(MAP)) {
      if (p === path + "/update") return json(200, flywheel.update(coll, b.id, b));
      if (p === path + "/delete") return json(200, flywheel.remove(coll, b.id));
    }
  }
  return json(404, { error: "not found" });
}

// ---- Persona distillation: MAP-REDUCE over the WHOLE corpus (not a sample) ----
// map: each context-window batch -> partial voice observations; reduce: synthesize all observations
// + whole-corpus statistical vocabulary into the final profile. Runs as a background job with
// progress (distillState), because a large corpus = many 30B calls = minutes. JSON-out + think:false
// (qwen3 + format:json + thinking ON collapses to "{}"; the Phase-5 gotcha).
// "convictions" is load-bearing: v2 of the profile captured Fred's RHYTHM but missed his Reformed
// theology entirely — As-Fred answered "why do humans exist" as an existentialist instead of with
// the Westminster catechism. Beliefs must be a first-class facet, not a style byproduct.
const NOTE_KEYS = ["voice", "humor", "vocabulary", "wit", "specialties", "reasoning", "interests", "convictions"];
let distillState = { running: false, phase: "idle", batchesDone: 0, batchesTotal: 0, startedAt: null, finishedAt: null, error: null, capped: false, digestedChunks: 0, totalChunks: 0 };

function parseJsonLoose(d) {
  const raw = stripThink((d && d.message && d.message.content) || "");
  try { return JSON.parse(raw || "{}"); } catch {}
  const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function runDistill({ batchChars = 90000, maxBatches = 60 } = {}) {
  try {
    const vocab = persona.statVocab();
    const { batches, capped, poolChunks, totalChunks, coveredChars, totalChars } = persona.buildBatches({ batchChars, maxBatches });
    distillState.batchesTotal = batches.length; distillState.capped = capped; distillState.digestedChunks = poolChunks; distillState.totalChunks = totalChunks;
    if (!batches.length) { distillState = { ...distillState, running: false, phase: "error", error: "The corpus is empty — dump some of Fred's writing first." }; return; }

    // MAP: partial observations per batch.
    const notes = Object.fromEntries(NOTE_KEYS.map((k) => [k, []]));
    distillState.phase = "reading";
    const mapPreamble =
      "From this batch of Frederick (Fred) Wolfe's own writing, extract SHORT concrete observations about his enduring style AND his stated beliefs. " +
      "Return ONLY JSON: {\"voice\":[],\"humor\":[],\"vocabulary\":[],\"wit\":[],\"specialties\":[],\"reasoning\":[],\"interests\":[],\"convictions\":[]}. " +
      "convictions = positions Fred actually asserts: faith/theological commitments, creeds or confessions he cites, moral stances, professional principles, things he explicitly rejects. Quote or closely paraphrase HIS assertions. " +
      "Each array = a few terse, specific bullet strings (real words/devices/positions you SEE, no filler). Batch:\n\n";
    for (let i = 0; i < batches.length; i++) {
      if (!distillState.running) return;   // cancelled
      const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: mapPreamble + batches[i] }], { temperature: 0.2, num_predict: 900, noTools: true, format: "json", think: false });
      const o = parseJsonLoose(d);
      if (o) for (const k of NOTE_KEYS) if (Array.isArray(o[k])) notes[k].push(...o[k].map((x) => String(x).slice(0, 300)));
      distillState.batchesDone = i + 1;
    }

    // REDUCE: synthesize the observations + whole-corpus vocabulary into the final profile.
    if (!distillState.running) return;
    distillState.phase = "synthesizing";
    const cap = (arr, n) => [...new Set(arr)].slice(0, n).join("; ");
    const reducePrompt = [
      "You are writing the definitive PERSONA PROFILE of the writer Frederick (Fred) Wolfe, synthesizing observations gathered across his ENTIRE body of writing.",
      "Below are (a) observations pooled from every part of his corpus and (b) his statistically most-distinctive words and phrases (measured across everything he's written). Reconcile them into one sharp, specific profile. Prefer concrete detail over generic praise.",
      "",
      "Return ONLY JSON with these fields:",
      '{ "voice_style":"...", "humor":"...", "vocabulary":"...", "wit":"...", "specialties":"...", "reasoning":"...", "interests":"...", "convictions":"...", "avoid":"...", "summary":"..." }',
      "- convictions: Fred's core beliefs and worldview — the positions that must GOVERN THE CONTENT of anything written as him (his faith tradition, confessions/creeds he holds, moral and professional stances, named rejections). Be specific; use his own formulations where the observations contain them.",
      "- avoid: MUST include never using antithesis constructions ('not X but Y', 'it's not X, it's Y', 'not X, not Y, but Z').",
      "- summary: 3-4 sentences a ghostwriter reads to instantly write as Fred — mention both his voice AND what he believes.",
      "",
      "OBSERVATIONS (pooled from the whole corpus):",
      ...NOTE_KEYS.map((k) => `- ${k}: ${cap(notes[k], 40) || "(none)"}`),
      "",
      "MOST-DISTINCTIVE WORDS: " + (vocab.words.map((x) => x.w).join(", ") || "(none)"),
      "MOST-RECURRING PHRASES: " + (vocab.phrases.map((x) => x.p).join("; ") || "(none)"),
    ].join("\n");
    const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: reducePrompt }], { temperature: 0.3, num_predict: 2600, noTools: true, format: "json", think: false });
    const facets = parseJsonLoose(d);
    if (!facets || typeof facets !== "object" || (!facets.voice_style && !facets.summary)) { distillState = { ...distillState, running: false, phase: "error", error: "The model didn't return a usable profile (is the local model busy or down?) — try again." }; return; }
    // Fold in the measured vocabulary as ground truth (survives even if the model omitted words).
    facets.favored_words = vocab.words.map((x) => x.w);
    facets.favored_phrases = vocab.phrases.map((x) => x.p);
    // Dedicated convictions pass: beliefs from ASSERTION kinds only. Distill v3 proved that
    // majority-voting convictions across the whole voice corpus buries them under poem volume
    // (200 poems outvoted the confessional essays). Voice comes from everything; beliefs don't.
    distillState.phase = "distilling convictions";
    const conv = await distillConvictions();
    if (conv) facets.convictions = conv;
    const systemBlock = renderFacets(facets) + (facets.summary ? "\n- In short: " + facets.summary : "");
    persona.setProfile({ facets, systemBlock, model: "local", method: "map-reduce", batches: batches.length, capped, digestedChunks: poolChunks, totalChunks, coveredChars, totalChars });
    distillState = { ...distillState, running: false, phase: "done", finishedAt: new Date().toISOString(), error: null };
  } catch (e) {
    distillState = { ...distillState, running: false, phase: "error", error: String(e.message || e) };
  }
}

// Convictions-only map-reduce over the assertion kinds (essay/maxim/plan/thought) — small and fast
// (a fraction of the corpus). Returns the synthesized convictions string, or null on failure.
// KEY: format is a STRICT JSON SCHEMA, not the "json" string. Probed live — format:"json" lets the
// 30B smuggle story-narration inside a JSON wrapper (both prior passes returned nothing usable); a
// real schema hard-constrains generation and both a raw batch AND a clean snippet extracted cleanly.
const CONV_MAP_SCHEMA = { type: "object", properties: { convictions: { type: "array", items: { type: "string" } } }, required: ["convictions"] };
const CONV_REDUCE_SCHEMA = { type: "object", properties: { convictions: { type: "string" } }, required: ["convictions"] };
async function distillConvictions() {
  const { batches } = persona.buildBatches({ kinds: ["essay", "maxim", "plan", "thought"], batchChars: 30000, maxBatches: 30 });
  if (!batches.length) return null;
  distillState.batchesTotal += batches.length;
  const notes = [];
  const pre =
    "Extract the writer Frederick (Fred) Wolfe's stated BELIEFS from the text: faith and theological commitments, creeds/confessions/catechisms he cites (quote them), moral stances, professional principles, and explicit rejections. Do NOT narrate, summarize, or continue the text — only extract his assertions.\n\nTEXT:\n";
  for (let i = 0; i < batches.length; i++) {
    if (!distillState.running) return null;
    const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: pre + batches[i] }], { temperature: 0.2, num_predict: 1400, noTools: true, format: CONV_MAP_SCHEMA, think: false });
    const o = parseJsonLoose(d);
    if (o && Array.isArray(o.convictions)) notes.push(...o.convictions.map((x) => String(x).slice(0, 300)).filter((s) => s.length > 8));
    distillState.batchesDone++;
  }
  if (!notes.length) return null;
  const rp =
    "Synthesize Frederick (Fred) Wolfe's CORE CONVICTIONS & WORLDVIEW into one dense paragraph from these observations pooled from his assertion writing. " +
    "Preserve his OWN formulations — the creeds, confessions, and catechisms he cites, the doctrines he affirms, the moral and professional stances he takes, and what he explicitly rejects. Concrete, no softening.\n\nOBSERVATIONS:\n" +
    [...new Set(notes)].slice(0, 90).map((n) => "- " + n).join("\n");
  const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: rp }], { temperature: 0.3, num_predict: 1200, noTools: true, format: CONV_REDUCE_SCHEMA, think: false });
  const o = parseJsonLoose(d);
  return o && o.convictions ? String(o.convictions) : null;
}

// Quick refresh: re-run ONLY the convictions pass over the existing profile (minutes, not an hour).
async function runConvictionsOnly() {
  try {
    const profile = persona.getProfile();
    if (!profile || !profile.facets) { distillState = { ...distillState, running: false, phase: "error", error: "No existing profile — run a full distill first." }; return; }
    distillState.phase = "distilling convictions";
    const conv = await distillConvictions();
    if (!conv) { distillState = { ...distillState, running: false, phase: "error", error: "The convictions pass produced nothing usable — try again." }; return; }
    const facets = { ...profile.facets, convictions: conv };
    const systemBlock = renderFacets(facets) + (facets.summary ? "\n- In short: " + facets.summary : "");
    persona.setProfile({ ...profile, facets, systemBlock, method: (profile.method || "map-reduce") + "+convictions" });
    distillState = { ...distillState, running: false, phase: "done", finishedAt: new Date().toISOString(), error: null };
  } catch (e) {
    distillState = { ...distillState, running: false, phase: "error", error: String(e.message || e) };
  }
}

// Kick a distillation in the background (idempotent while one is running). Returns immediately.
// { convictionsOnly: true } refreshes just the beliefs facet on the existing profile (fast).
function startDistill(opts) {
  if (distillState.running) return { running: true, phase: distillState.phase, batchesDone: distillState.batchesDone, batchesTotal: distillState.batchesTotal };
  const maxBatches = Math.max(1, Math.min(300, Number(opts && opts.maxBatches) || 60));
  const batchChars = Math.max(20000, Math.min(140000, Number(opts && opts.batchChars) || 90000));
  distillState = { running: true, phase: "starting", batchesDone: 0, batchesTotal: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null, capped: false, digestedChunks: 0, totalChunks: 0 };
  if (opts && opts.convictionsOnly) runConvictionsOnly();   // not awaited — background job
  else runDistill({ batchChars, maxBatches });
  return { started: true };
}

// Persona Forge API: dump material, scan the inbox, scrape a page, distill the profile, search exemplars.
async function handlePersona(req, res, u) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  if (req.method === "GET" && p === "/persona") return json(200, { stats: persona.stats(), kinds: PERSONA_KINDS, profile: persona.getProfile() ? { ...persona.getProfile(), facets: undefined } : null });
  if (req.method === "GET" && p === "/persona/profile") return json(200, { profile: persona.getProfile() });
  if (req.method === "GET" && p === "/persona/list") return json(200, { items: persona.list({ kind: u.searchParams.get("kind") || "", q: u.searchParams.get("q") || "" }), stats: persona.stats() });
  if (req.method === "GET" && p === "/persona/search") return json(200, { hits: await persona.retrieve(u.searchParams.get("q") || "", { limit: 8, kind: u.searchParams.get("kind") || "" }) });
  if (req.method === "GET" && p === "/persona/distill/status") return json(200, distillState);
  if (req.method === "GET" && p === "/persona/scan/status") return json(200, scanState);

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json(400, { error: "bad json" });
    if (p === "/persona" || p === "/persona/ingest") {
      const r = persona.ingestText({ text: body.text, kind: body.kind, title: body.title, source: body.source || "pasted", tags: body.tags });
      return json(r.error ? 400 : 200, r.error ? r : { ok: true, docId: r.doc.id, chunks: r.chunks, deduped: !!r.deduped, stats: persona.stats() });
    }
    if (p === "/persona/scan") { return json(200, startScan()); }
    if (p === "/persona/backup") { return json(200, persona.backupTo(body.dir)); }
    if (p === "/persona/scrape") {
      const r = await fetchUrl(String(body.url || ""));
      if (r.error) return json(400, { error: "Couldn't fetch that URL: " + r.error });
      if (r.status >= 400) return json(400, { error: "The site returned HTTP " + r.status });
      const text = /html/i.test(r.contentType || "") || /<html/i.test(r.body || "") ? htmlToText(r.body) : String(r.body || "");
      if (!text || text.length < 40) return json(400, { error: "Nothing readable came back from that page." });
      const ing = persona.ingestText({ text, kind: body.kind || "web", title: body.title || body.url, source: "scrape:" + body.url });
      return json(ing.error ? 400 : 200, ing.error ? ing : { ok: true, docId: ing.doc.id, chunks: ing.chunks, chars: text.length, deduped: !!ing.deduped, stats: persona.stats() });
    }
    if (p === "/persona/distill") { return json(200, startDistill(body)); }
    if (p === "/persona/delete") { return json(200, persona.removeDoc(body.id)); }
  }
  return json(404, { error: "not found" });
}

// ---- durable chat jobs (PWA suspend/resume) ----
// A phone switching apps suspends the PWA and kills the /chat SSE socket mid-answer. The turn must
// survive that: every /chat run is a JOB — all SSE events are buffered in RAM as they're emitted,
// GET /chat/attach?job=<id>&from=<n> replays events[n..] and live-tails until the job ends, and
// POST /chat/stop is now the ONLY thing that aborts generation (a dead socket never does).
// Ring-capped + TTL'd with lazy GC — this is a reconnect window, not persistence.
const CHAT_JOBS = new Map();
const JOB_CAP = 24, JOB_TTL_MS = 45 * 60 * 1000;
function gcChatJobs() {
  const now = Date.now();
  for (const [id, j] of CHAT_JOBS) if (now - (j.endedAt || j.startedAt) > JOB_TTL_MS) CHAT_JOBS.delete(id);
  while (CHAT_JOBS.size > JOB_CAP) {
    let victim = null;
    for (const j of CHAT_JOBS.values()) if (j.done && (!victim || j.startedAt < victim.startedAt)) victim = j;
    if (!victim) for (const j of CHAT_JOBS.values()) { victim = j; break; }   // all still live: drop the oldest
    CHAT_JOBS.delete(victim.id);
  }
}
function createChatJob() {
  gcChatJobs();
  const job = { id: "job_" + randomUUID().slice(0, 12), chatId: "", startedAt: Date.now(), endedAt: 0,
                events: [], listeners: [], done: false, stopped: false, stop: () => {} };
  CHAT_JOBS.set(job.id, job);
  return job;
}
function jobEmit(job, o) {
  if (job.done) return;
  job.events.push(o);
  for (const l of [...job.listeners]) { try { l(o); } catch {} }
}
function finishJob(job) {
  if (job.done) return;
  job.done = true; job.endedAt = Date.now();
  for (const l of [...job.listeners]) { try { l(null); } catch {} }   // null = end-of-stream
  job.listeners.length = 0;
}
// POST /chat/stop {jobId} — the Stop button. Fires the turn's AbortController (in-flight tools +
// model call); the /chat handler then appends its stopped tail to the buffer and seals the job.
async function handleChatStop(req, res) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const b = await readJsonBody(req);
  const job = b && CHAT_JOBS.get(String(b.jobId || ""));
  if (!job) return json(404, { error: "unknown or expired job" });
  if (job.done) return json(200, { ok: true, alreadyDone: true, stopped: job.stopped });
  job.stopped = true;
  try { job.stop(); } catch {}
  console.log(`[dominion-ai] /chat/stop -> ${job.id}`);
  return json(200, { ok: true });
}
// GET /chat/attach?job=<id>&from=<n> — SSE: replay events[n..] immediately, then live-tail new
// events until the job ends. Unknown/expired job -> one {type:"gone"} event, then end.
function handleChatAttach(req, res, u) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  const write = (o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {} };
  const job = CHAT_JOBS.get(String(u.searchParams.get("job") || ""));
  if (!job) { write({ type: "gone" }); return res.end(); }
  const from = Math.max(0, Math.floor(Number(u.searchParams.get("from")) || 0));
  for (const ev of job.events.slice(from)) write(ev);   // catch-up replay (same tick as the subscribe — no gap)
  if (job.done) return res.end();
  const listener = (ev) => { if (ev === null) { try { res.end(); } catch {} } else write(ev); };
  job.listeners.push(listener);
  res.on("close", () => { const i = job.listeners.indexOf(listener); if (i >= 0) job.listeners.splice(i, 1); });
}

async function handleChat(req, res) {
  let body = "";
  req.on("data", (d) => (body += d));
  await new Promise((r) => req.on("end", r));
  let input;
  try { input = JSON.parse(body); } catch { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"bad json"}'); }
  const history = Array.isArray(input.messages) ? input.messages : [];
  if (!history.length) { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":"no messages"}'); }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  // Durable turn: every SSE event is ALSO buffered in the job so a suspended phone can reattach
  // (/chat/attach) and catch up mid-stream or after the fact. Generation runs to completion
  // regardless of the client connection — writes to a dead res are harmless (try/catch below).
  const job = createChatJob();
  const sse = (o) => { jobEmit(job, o); try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {} };
  // `aborted` = EXPLICIT stop only (POST /chat/stop). A client disconnect no longer aborts the turn.
  let aborted = false;
  // Interactive lane: held until the JOB completes (not the socket) — background reviews/embeds
  // keep deferring while a detached turn is still generating. Released exactly once via endStream.
  enterInteractive();
  let laneOpen = true;
  const releaseLane = () => { if (laneOpen) { laneOpen = false; leaveInteractive(); } };
  // C5: one AbortController per request — now fired ONLY by explicit stop. It still reaches
  // in-flight tools (HTTP tools destroy their request, the python sandbox SIGKILLs) + the model call.
  const ac = new AbortController();
  job.stop = () => { if (job.done) return; aborted = true; try { ac.abort(); } catch {} };
  // The single teardown for every exit path: heartbeat off, buffer sealed (drains attach
  // listeners), lane released, socket closed if it's still alive.
  const endStream = () => { workStop(); finishJob(job); releaseLane(); try { res.end(); } catch {} };
  sse({ type: "job", id: job.id });
  // SSE working heartbeat: while a slow model call / tool round is in flight, tell the client every
  // ~8s that we're alive ({type:"working", phase, elapsed seconds}) — cleared before tokens stream.
  const chatT0 = Date.now();
  let workTimer = null;
  const workStop = () => { if (workTimer) { clearInterval(workTimer); workTimer = null; } };
  const working = (phase) => {
    workStop();
    if (aborted) return;
    const emit = () => sse({ type: "working", phase, elapsed: Math.round((Date.now() - chatT0) / 1000) });
    emit();
    workTimer = setInterval(emit, 8000);
  };

  const personaStyle = typeof input.persona === "string" ? input.persona.slice(0, 2000) : "";
  const userTemp = (typeof input.temperature === "number" && input.temperature >= 0 && input.temperature <= 2) ? input.temperature : undefined;
  const reqMode = typeof input.mode === "string" ? input.mode : "auto";
  const forced = (typeof input.model === "string" && input.model && input.model !== "auto") ? input.model : "";
  const confirmTools = CONFIRM_TOOLS_ENV || input.confirmTools === true;   // Phase 3: default OFF (LAX)
  const chatId = typeof input.chatId === "string" ? input.chatId.slice(0, 80) : "";
  job.chatId = chatId;
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const totalInputChars = history.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  // Route: an explicit mode wins; otherwise the combined heuristic+light-model router picks.
  // routeConfidence seeds the response quality block; needs.mentorReview is the spec's pre-answer
  // mentor signal (explicit ask / high-stakes topic) and forces the post-answer review path.
  const lastUserText = lastUser ? String(lastUser.content) : "";
  let mode, tier, reason, privacyRisk = privacyRiskOf(lastUserText);
  let routeConfidence = 0.95;
  // D1/D3: the needs_* block, produced for BOTH the auto route and explicit mode picks.
  let needs = { tools: true, memory: true, retrieval: true, mentorReview: wantsReview(lastUserText) };
  if (reqMode !== "auto" && MODES[reqMode]) {
    mode = reqMode; tier = MODES[mode].tier; reason = "you chose " + mode.replace("_", " ");
    needs.retrieval = mode !== "fast";
    needs.tools = mode !== "fast" || /\b(deck|forge|file|sandbox|remember|artifact|project|capture|run|search|export|save|write|python|scrape)\b/i.test(lastUserText);
  } else {
    working("thinking");   // the ambiguous-case classifier can stall on a cold light model
    const c = await routeDecision(lastUserText, totalInputChars);
    mode = c.mode; tier = c.tier; reason = c.reason; privacyRisk = c.privacyRisk; routeConfidence = c.confidence;
    needs = { tools: c.needsTools, memory: c.needsMemory, retrieval: c.needsRetrieval, mentorReview: c.needsMentorReview };
  }
  const routeNeedsReview = needs.mentorReview;
  if (aborted) { sse({ type: "stopped" }); return endStream(); }
  const md = MODES[mode];
  const model = forced || MODEL_FOR(tier);
  const provCap = PROVIDER_FOR_MODEL(model).maxContextTokens;
  const opts = { temperature: typeof userTemp === "number" ? userTemp : md.temp, signal: ac.signal };   // C5: abort reaches the model call too
  // Long-context gating pass 1 (raw input size): scale num_ctx for long_context mode, capped at the
  // provider limit. Pass 2 (the POST-RETRIEVAL re-check, D2) runs after context assembly below.
  if (mode === "long_context") {
    const want = Math.min(estTokens(totalInputChars) * 2 + 8192, provCap);
    opts.num_ctx = Math.max(md.num_ctx || 32768, Math.ceil(want / 4096) * 4096);
  } else if (md.num_ctx) opts.num_ctx = md.num_ctx;
  // D3: consume needs_retrieval / needs_tools. Chat-only turns drop the tool defs from the prompt
  // (token savings); conservative bias — only fast-mode turns with no tool language skip them.
  let { skipRetrieval, attachTools } = consumeNeeds({ mode, needsTools: needs.tools, needsRetrieval: needs.retrieval, lastUserText });
  // As-Fred latency fix: voice writing needs no deck/forge tools (exemplars are injected) and CoT
  // adds minutes of invisible prefill+thinking for zero voice fidelity — one round, no think,
  // tokens start right after a single prefill.
  // as_fred: no tools (kills the multi-round re-prefill that caused the 4-minute hang) but
  // thinking STAYS ON — think:false makes the 30B narrate its plan as the visible answer, and
  // generation is cheap on this MoE (~80 tok/s); the prefill, not the thinking, is the cost.
  if (mode === "as_fred") { attachTools = false; }
  opts.noTools = !attachTools;
  // D1: the full routing decision surfaces immediately (spec routing JSON shape)...
  sse({ type: "route", model, mode, route: routeOf(tier, mode), reason, confidence: routeConfidence,
        needs: { tools: attachTools, memory: needs.memory, retrieval: !skipRetrieval, mentor_review: needs.mentorReview }, privacyRisk });
  console.log(`[dominion-ai] /chat route -> ${model} · ${mode} (${reason}) · tools=${attachTools ? "on" : "off"} retrieval=${skipRetrieval ? "skip" : "on"}`);

  // Per-request tool context: the base CTX plus the live chat/mode (B2 scope for memory tools).
  const reqCtx = { ...CTX, chatId, mode, model };
  // Context builder (Phase 2, full): system -> learned rules -> memory + artifacts + past chats -> turns.
  working("reading context");   // retrieval (embed call + vec cache) can be slow on a cold box
  // Degrade, don't die: this runs BEFORE the try below, and with disconnect decoupled from abort
  // an uncaught throw here would leak the lane + leave the job unsealed. Empty context is honest.
  let ctxInfo;
  try { ctxInfo = await buildContext(lastUserText, chatId, { skipRetrieval, mode, model }); }
  catch { ctxInfo = { used: [], artifactsUsed: [], chatsUsed: [], block: "" }; }
  const messages = [{ role: "system", content: systemPrompt(personaStyle, md.frag) }];
  const activeRules = flywheel.activeRules(mode).filter((r) => r.scope !== "retrieval");   // Phase 5: learned prompt rules
  if (activeRules.length) messages.push({ role: "system", content: "Active learned rules — follow these:\n" + activeRules.map((r) => "- " + r.content).join("\n") });
  if (ctxInfo.block) messages.push({ role: "system", content: ctxInfo.block });
  // As-Fred mode: inject the distilled Fred Profile + real writing exemplars retrieved for this prompt.
  let personaInfo = null;
  if (mode === "as_fred") {
    try {
      personaInfo = await persona.personaBlock(lastUserText, { exemplars: 6 });
      if (personaInfo.block) messages.push({ role: "system", content: personaInfo.block });
      sse({ type: "persona", hasProfile: personaInfo.hasProfile, exemplars: personaInfo.exemplars.length });
    } catch {}
  }
  // Prefill is the latency bottleneck (~35 tok/s on this CPU): re-reading a whole long conversation
  // every turn costs real minutes. Cap the replayed history — retrieval + episodic memory carry the
  // older context. long_context keeps a much deeper window on purpose (it is the intentional mode).
  const HISTORY_CAP = mode === "long_context" ? 48 : 16;
  messages.push(...history.slice(-HISTORY_CAP));
  // as_fred keeps thinking ON (think:false made the model plan out loud); the answer-directly
  // order is the LAST thing it reads (top-of-prompt placement proved too weak).
  if (mode === "as_fred") messages.push({ role: "system", content: "Reply now with ONLY Fred's actual words. Do not analyze the request, do not restate the question, do not describe Fred's style or your approach — your first word is the first word of Fred's answer." });
  const contextTokens = estTokens(messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0));
  // D2 (audit item 12): the long-context re-check AFTER retrieval. Routing ran before context
  // assembly, so only NOW do we know what retrieval actually loaded — if the assembled prompt
  // would overflow the current window, escalate num_ctx (and the mode label) per the spec's first
  // long-context entry condition ("retrieved context exceeds normal limit").
  let escalated = false;
  const esc = escalateForContext({ contextTokens, numCtx: opts.num_ctx, cap: provCap });
  if (esc.escalate) {
    escalated = true;
    opts.num_ctx = esc.numCtx;
    if (mode !== "long_context") { messages[0].content += "\n\n" + MODES.long_context.frag; mode = "long_context"; }
    reason = (reason + ` · post-retrieval long-context escalation (~${contextTokens} tok > window)`).slice(0, 140);
    sse({ type: "route", model, mode, route: routeOf(tier, mode), reason, confidence: routeConfidence, escalated: true, num_ctx: opts.num_ctx,
          needs: { tools: attachTools, memory: needs.memory, retrieval: !skipRetrieval, mentor_review: needs.mentorReview }, privacyRisk });
    console.log(`[dominion-ai] post-retrieval escalation: ~${contextTokens} tok assembled -> num_ctx ${opts.num_ctx}${esc.atCap ? " (AT PROVIDER CAP — may truncate)" : ""}`);
  }
  // D1: the final decision object — logged with every usage.jsonl entry for this run.
  const routeInfo = { route: routeOf(tier, mode), mode, needs_tools: attachTools, needs_memory: needs.memory, needs_retrieval: !skipRetrieval,
                      needs_mentor_review: needs.mentorReview, privacy_risk: privacyRisk, confidence: routeConfidence, reason,
                      escalated: escalated || undefined, num_ctx: opts.num_ctx || undefined };
  if (ctxInfo.used.length || ctxInfo.artifactsUsed.length || ctxInfo.chatsUsed.length) {
    // F4 (audit "Show context used"): per-item detail — memory items were already sent (and
    // discarded client-side); artifact/chat titles now ride along so the chip can expand honestly.
    sse({ type: "context", memory: ctxInfo.used.length, artifacts: ctxInfo.artifactsUsed.length, chats: ctxInfo.chatsUsed.length,
          items: ctxInfo.used.map((c) => ({ title: c.title, label: c.citationLabel, score: c.score })),
          artifactItems: ctxInfo.artifactsUsed.map((a) => ({ id: a.id, title: a.title })),
          chatItems: ctxInfo.chatsUsed.map((h) => ({ id: h.id, title: h.title })) });
    console.log(`[dominion-ai] context: ${ctxInfo.used.length} mem · ${ctxInfo.artifactsUsed.length} artifact(s) · ${ctxInfo.chatsUsed.length} chat(s) · ~${contextTokens} tok`);
  }
  const startedAt = new Date().toISOString();
  let toolCount = 0, roundsUsed = 0, artifactCreatedThisTurn = false, toolFailedThisTurn = false;
  let executedCodeThisTurn = false, exportedThisTurn = false;   // real trigger signals (spec auto-review)
  const toolRunIds = [], toolSummaries = [];
  // E4: tools that create/revise artifacts stamp THIS turn's provenance on the version they write;
  // E1: and re-sweep the artifact triggers after doing so.
  reqCtx.provenance = () => ({ sourceChatId: chatId, sourceContextRefs: ctxInfo.used.map((c) => c.citationLabel),
                               sourceToolRunIds: [...toolRunIds], promptSummary: lastUserText.slice(0, 200) });
  reqCtx.artifactTriggers = (id, sig) => { try { return evalArtifactTriggers(id, sig || {}); } catch { return null; } };

  try {
    let last = null;
    for (let round = 0; round < MAX_ROUNDS && !aborted; round++) {
      roundsUsed = round + 1;
      // heartbeat phase: think-less runs (and post-tool rounds) go straight to writing
      working(opts.think === false ? "writing" : round === 0 ? "thinking" : "writing");
      let d = await ollamaChat(model, messages, opts);
      // the heavier 30B can return null on a cold load / transient blip — retry once on the first round
      if (!d && round === 0 && !aborted) { await sleep(1500); d = await ollamaChat(model, messages, opts); }
      last = d;
      workStop();   // model call finished (tokens or tool calls next) — heartbeat pauses here
      if (aborted) break;
      const msg = d && d.message;
      if (!msg) { sse({ type: "error", error: "The model didn't respond (it may still be warming up — try again)." }); await logUsage({ ts: startedAt, model, mode, reason, route: routeInfo, status: "no_response", rounds: roundsUsed }); return endStream(); }

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length && round < MAX_ROUNDS - 1) {
        working("running tools");   // round 2+ visibility: tools now, then "writing" on the next model call
        // record the assistant's tool-call turn (thinking stripped — hygiene), then run each tool and feed results back
        messages.push({ role: "assistant", content: stripThink(msg.content), tool_calls: calls });
        for (const c of calls) {
          if (aborted) break;
          const fn = (c.function || {});
          const name = fn.name || "unknown";
          let args = fn.arguments;
          if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
          const meta = toolMeta(name);
          const runId = newRunId();
          // C1: EFFECTIVE class — sandbox overwrite / inferred-memory save escalate to requires_confirmation.
          const cls = effectivePermission(name, args, CTX);
          const startedAt = new Date().toISOString();
          const inPrev = meta.logsInputs ? JSON.stringify(args).slice(0, 200) : undefined;
          // C2: the 9-state lifecycle — every transition timestamped, persisted with the run.
          const life = lifecycle();
          life.push("proposed");
          toolCount++;
          toolRunIds.push(runId);

          // 1) Ironclad carve-out: hard-deny protected resources (customer DBs / backups), even under LAX.
          const guard = assertNotProtected(name, args);
          if (!guard.ok) {
            life.push("blocked", { reason: guard.reason });
            sse({ type: "tool", name, runId, cls, status: "blocked", preview: guard.reason });
            await logToolRun({ ts: startedAt, runId, name, category: meta.category, cls, status: "blocked", reason: guard.reason, states: life.states, input: inPrev, chatId, model });
            messages.push({ role: "tool", tool_name: name, content: `BLOCKED: this ${guard.reason}. I cannot do that.` });
            toolSummaries.push(name + " · blocked");
            continue;
          }

          // 1b) Mode gate (spec allowedModes): e.g. forge_send is barred from Draft mode.
          if (meta.allowedModes && !meta.allowedModes.includes(mode)) {
            life.push("blocked", { reason: "mode " + mode + " not in allowedModes" });
            sse({ type: "tool", name, runId, cls, status: "blocked", preview: "not allowed in " + mode + " mode" });
            await logToolRun({ ts: startedAt, runId, name, category: meta.category, cls, status: "blocked", reason: "mode " + mode + " not in allowedModes", states: life.states, input: inPrev, chatId, model });
            messages.push({ role: "tool", tool_name: name, content: `BLOCKED: ${name} is not allowed in ${mode} mode. Tell Fred to switch modes if this action is really needed.` });
            toolSummaries.push(name + " · blocked (mode)");
            continue;
          }

          // 2) Confirmation gate — the machinery ALWAYS runs for gated classes (dangerous /
          // requires_confirmation). LAX auto-answers "approve" and records the auto_approved
          // transition; CONFIRM_TOOLS=1 (or {confirmTools:true}) makes it truly interactive.
          const gate = await passConfirmGate({
            cls, interactive: confirmTools, life,
            ask: () => { sse({ type: "tool_confirm", name, runId, cls, preview: inPrev || "" }); return awaitConfirm(runId, 120000); },
          });
          if (!gate.proceed) {
            sse({ type: "tool", name, runId, cls, status: "cancelled", preview: gate.decision });
            await logToolRun({ ts: startedAt, runId, name, category: meta.category, cls, status: "cancelled", decision: gate.decision, states: life.states, input: inPrev, chatId, model });
            messages.push({ role: "tool", tool_name: name, content: `The user did not approve this ${cls} action (${gate.decision}); it was not run.` });
            toolSummaries.push(name + " · denied");
            continue;
          }

          // 3) Run + report honestly. The abort signal reaches the tool (C5).
          life.push("executing");
          sse({ type: "tool", name, runId, cls, gated: WRITE_TOOLS.has(name), status: "run" });
          const result = await runTool(name, args, reqCtx, ac.signal);
          if (aborted) {
            // C5: client stopped mid-run. Abortable tools were cancelled; un-abortable ones
            // finished but their answer is DISCARDED (never fed back to the model).
            life.push("cancelled", { discarded: true, reason: String(result).startsWith("CANCELLED") ? "aborted in flight" : "finished but discarded (client stopped)" });
            await logToolRun({ ts: startedAt, endedAt: new Date().toISOString(), runId, name, category: meta.category, cls, status: "cancelled", states: life.states, discarded: true, confirmedByUser: gate.confirmedByUser, input: inPrev, output: String(result).replace(/\s+/g, " ").slice(0, 200), chatId, model });
            toolSummaries.push(name + " · cancelled");
            break;
          }
          const failed = /^(Tool .+ failed|Unknown tool|Couldn't|I can read and plan|Memory isn't available|BLOCKED)/i.test(String(result));
          life.push(failed ? "failed" : "succeeded");
          if (failed) toolFailedThisTurn = true;
          if ((name === "create_artifact" || name === "revise_artifact") && !failed) artifactCreatedThisTurn = true;
          if ((name === "run_python_sandbox" || name === "forge_send") && !failed) executedCodeThisTurn = true;   // code went live → review trigger
          if (name === "export_artifact" && !failed) exportedThisTurn = true;                                     // export happened → review trigger
          sse({ type: "tool", name, runId, cls, status: failed ? "failed" : "done", preview: String(result).replace(/\s+/g, " ").slice(0, 120) });
          await logToolRun({ ts: startedAt, endedAt: new Date().toISOString(), runId, name, category: meta.category, cls, status: failed ? "failed" : "succeeded", states: life.states, confirmedByUser: gate.confirmedByUser, autoApproved: gate.autoApproved || undefined, input: inPrev, output: String(result).replace(/\s+/g, " ").slice(0, 200), chatId, model });
          messages.push({ role: "tool", tool_name: name, content: String(result).slice(0, 8000) });
          toolSummaries.push(name + " · " + (failed ? "failed" : "succeeded"));
        }
        continue;
      }

      // final answer — stream it out in small chunks for a live feel
      const answer = stripThink(msg.content) || "(no response)";
      const size = 28;
      for (let i = 0; i < answer.length && !aborted; i += size) {
        sse({ type: "token", delta: answer.slice(i, i + size) });
        if (i + size < answer.length) await sleep(8);
      }
      if (aborted) break;   // stopped mid-stream -> fall through to the interrupted log, NOT "done"
      // Phase 4: in Draft mode, a generated document is auto-saved as a versioned artifact
      // (unless the model already saved one via a tool this turn). Provenance travels with it.
      if (mode === "draft" && !artifactCreatedThisTurn && answer.trim().length > 400) {
        try {
          const art = artifacts.create({
            title: deriveTitle(answer, lastUser), type: "markdown", content: answer, model, sourceChatId: chatId,
            promptSummary: lastUser ? String(lastUser.content).slice(0, 200) : "",
            sourceToolRunIds: toolRunIds, sourceContextRefs: ctxInfo.used.map((c) => c.citationLabel),
          });
          if (art.item) {
            sse({ type: "artifact", id: art.item.id, title: art.item.title, action: "saved" });
            console.log(`[dominion-ai] artifact auto-saved: ${art.item.title} (${art.item.id.slice(0, 8)})`);
            try { evalArtifactTriggers(art.item.id, {}); } catch {}   // E1: sweep the auto-saved draft too
          }
        } catch {}
      }
      // A1: full NormalizedModelResponse — citations extracted from the answer, quality computed
      // from routing confidence + real content signals, warnings from what actually went wrong.
      const citations = extractCitations(answer);
      const quality = computeQuality({ answer, routeConfidence, toolFailed: toolFailedThisTurn, retrievalCount: ctxInfo.used.length, citations });
      const warnings = [];
      if (toolFailedThisTurn) warnings.push("a tool call failed this turn");
      if (quality.hallucinationRisk !== "low") warnings.push("elevated hallucination risk (" + quality.hallucinationRisk + ")");

      // Mentor mode (spec): the answer is ALWAYS critiqued afterwards — full card goes to the client,
      // then the critique runs the full improvement pipeline (classification, candidates, queueing).
      if (mode === "mentor") {
        try {
          const c = await mentor.critique({ taskType: "answer_review", originalRequest: lastUser ? lastUser.content : "", content: answer, privacyMode: "local_only", retrievedContext: ctxInfo.used.map((x) => x.content), toolCalls: toolSummaries, mode, chatId });
          sse({ type: "mentor_full", critique: c });
          const req0 = lastUser ? String(lastUser.content) : "";
          setImmediate(() => waitInteractiveIdle().then(() => reviewEngine.runPipeline(c, { answer, originalRequest: req0, chatId, samplingCategory: "userMarkedImportant", tier: 2, retrievalCount: ctxInfo.used.length, toolCount })).catch(() => {}));
        } catch {}
      }
      // Phase 5 (full): tiered adaptive auto-review — fire-and-forget, never delays this stream.
      // Tier decision + trigger detection are synchronous (breadcrumb SSE below); the actual light
      // screen / full critique / pipeline run on the single-lane background queue.
      else if (AUTO_MENTOR) {
        try {
          const decision = reviewEngine.schedule({
            answer, lastUserText: lastUser ? String(lastUser.content) : "", mode, chatId,
            toolCount, toolFailed: toolFailedThisTurn, executedCode: executedCodeThisTurn, exported: exportedThisTurn,
            artifactCreated: artifactCreatedThisTurn, routeNeedsReview, quality, claimCount: quality.claimCount,
            retrievedContext: ctxInfo.used.map((x) => x.content), toolCalls: toolSummaries,
          });
          quality.needsReview = decision.tier > 0;
          if (decision.tier > 0) sse({ type: "mentor_queued", tier: decision.tier, triggers: decision.triggers, category: decision.category });
        } catch {}
      }
      // Periodic mentor review (spec): every Nth completed answer gets a background full review
      // through the SAME pipeline (classified ledger entries, not hardcoded stubs).
      completedRuns++;
      if (PERIODIC_MENTOR && mode !== "mentor" && completedRuns % PERIODIC_EVERY === 0) {
        const req0 = lastUser ? String(lastUser.content) : "";
        const n = completedRuns;
        setImmediate(async () => {
          try {
            await waitInteractiveIdle();   // periodic reviews also yield to live chats
            const r = await reviewEngine.reviewNow({ tier: 2, answer, originalRequest: req0, chatId, samplingCategory: "factualAnswer", triggers: ["periodic"], mode });
            console.log(`[dominion-ai] periodic mentor review #${n}: score ${r.critique.overall_score}/10, priority ${r.critique.revision_priority}`);
          } catch {}
        });
      }
      const norm = normalizeResponse(last, model, mode, { quality, citations, warnings, metadata: { chatId, reason, rounds: roundsUsed, tools: toolCount, privacyRisk } });
      console.log(`[dominion-ai] usage ${model}/${mode} prompt=${norm.usage.inputTokens || "?"} out=${norm.usage.outputTokens || "?"} tools=${toolCount} conf=${quality.confidence} risk=${quality.hallucinationRisk}`);
      await logUsage({ ts: startedAt, model, mode, reason, route: routeInfo, privacyRisk, status: "completed", rounds: roundsUsed, tools: toolCount, memoryUsed: ctxInfo.used.length, artifactsUsed: ctxInfo.artifactsUsed.length, chatsUsed: ctxInfo.chatsUsed.length, contextTokens, promptTokens: norm.usage.inputTokens, outputTokens: norm.usage.outputTokens, latencyMs: norm.usage.latencyMs, confidence: quality.confidence, hallucinationRisk: quality.hallucinationRisk, needsReview: quality.needsReview });
      try { chatlog.record(chatId, history, answer); } catch {}
      // F1 (audit item 26): runIds travel with the message meta so "show tool log" can filter the
      // tool panel to exactly this answer's runs (older messages fall back to chatId).
      sse({ type: "done", meta: { mode, memory: ctxInfo.used.length, artifacts: ctxInfo.artifactsUsed.length, chats: ctxInfo.chatsUsed.length, tools: toolCount, runIds: toolRunIds, outputTokens: norm.usage.outputTokens, quality: { confidence: quality.confidence, hallucinationRisk: quality.hallucinationRisk, needsReview: quality.needsReview }, warnings: norm.warnings } });
      return endStream();
    }
    workStop();   // stopped mid-tool-round / max_rounds — never leave the heartbeat ticking
    if (aborted) { sse({ type: "stopped" }); await logUsage({ ts: startedAt, model, mode, reason, route: routeInfo, status: "interrupted", rounds: roundsUsed, tools: toolCount }); }
    else { sse({ type: "error", error: "I used too many tool steps without finishing — try rephrasing." }); await logUsage({ ts: startedAt, model, mode, reason, route: routeInfo, status: "max_rounds", rounds: roundsUsed, tools: toolCount }); }
  } catch (e) {
    workStop();
    sse({ type: "error", error: "Server error: " + e.message });
    await logUsage({ ts: startedAt, model, mode, reason, route: routeInfo, status: "error", error: String(e.message).slice(0, 200) });
  }
  endStream();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(u.pathname);

    if (path === "/chat" && req.method === "POST") return handleChat(req, res);
    if (path === "/chat/stop" && req.method === "POST") return handleChatStop(req, res);
    if (path === "/chat/attach" && req.method === "GET") return handleChatAttach(req, res, u);
    if (path === "/memory" || path.startsWith("/memory/")) return handleMemory(req, res, u);
    if (path === "/toolruns" && req.method === "GET") return handleToolRuns(req, res);
    if (path === "/tool-confirm" && req.method === "POST") return handleToolConfirm(req, res);
    if (path === "/artifacts" || path.startsWith("/artifacts/")) return handleArtifacts(req, res, u);
    if (path === "/mentor/review" && req.method === "POST") return handleMentorReview(req, res);
    if (path === "/mentor/council" && req.method === "POST") return handleMentorCouncil(req, res);
    if (path === "/mentor/revise" && req.method === "POST") return handleMentorRevise(req, res);
    if (path === "/mentor/reject" && req.method === "POST") return handleMentorReject(req, res);
    if (["/ledger", "/evals", "/rules", "/prompts", "/finetune", "/reviews", "/pipeline", "/tool-overlays"].some((b) => path === b || path.startsWith(b + "/"))) return handleFlywheel(req, res, u);
    if (path === "/persona" || path.startsWith("/persona/")) return handlePersona(req, res, u);

    if (path === "/ollama" || path.startsWith("/ollama/")) {
      const rest = path.slice("/ollama".length) || "/";
      return proxy(req, res, rest + (u.search || ""));
    }

    let rel = path === "/" ? "/index.html" : path;
    const safe = normalize(rel).replace(/\\/g, "/");
    const file = join(PUBLIC, safe);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
    let data;
    try { data = await readFile(file); }
    catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dominion-ai] http://127.0.0.1:${PORT}  ->  Ollama ${OLLAMA}`);
  console.log(`[dominion-ai] tools: deck/forge/sandbox  ·  sync=${CTX.syncKey ? "set" : "MISSING"}  ·  run-password=${CTX.runPassword ? "set" : "unset"}  ·  sandbox=${CTX.sandboxDir}`);
  console.log(`[dominion-ai] router: heuristic+classifier  ·  light=${LIGHT_MODEL}  ·  main=${MAIN_MODEL}  ·  modes: auto/fast/normal/draft/deep_think/long_context  ·  needs_* consumed (retrieval skip + tool-def gating)  ·  post-retrieval long-context re-check  ·  usage log=${LOG_DIR}`);
  const ms = memory.stats();
  console.log(`[dominion-ai] memory: ${ms.total} item(s) (${JSON.stringify(ms.byStatus)})  ·  gating=${ms.gating}${ms.gatedLax ? " (" + ms.gatedLax + " lax-auto-approved)" : ""}${ms.unverified ? " · " + ms.unverified + " unverified mentor claim(s) pending" : ""}  ·  scope-filtered retrieval  ·  vectors=${EMBED_MODEL} (${ms.embedded} embedded)  ·  dir=${MEMORY_DIR}`);
  console.log(`[dominion-ai] chatlog: ${chatlog.stats().chats} conversation(s) indexed  ·  episodic summaries via /memory/summarize-session`);
  console.log(`[dominion-ai] tools: ${TOOL_DEFS.length} typed (incl. 6 formatting on the light model)  ·  confirm-risky=${CONFIRM_TOOLS_ENV ? "ON (interactive)" : "auto-approve (LAX, recorded)"}  ·  9-state lifecycle persisted  ·  ${flywheel.stats().activeToolOverlays} active description overlay(s)  ·  carve-outs: customer-DBs+backups hard-denied  ·  run log=toolruns.jsonl (${toolRunTail.length} reloaded)`);
  const as = artifacts.stats();
  console.log(`[dominion-ai] artifacts: ${as.total} (${JSON.stringify(as.byStatus)})  ·  dir=${ARTIFACT_DIR}  ·  native exports: docx/pdf/xlsx/csv (Forge = docx/pdf fallback only)  ·  export gate: ${EXPORT_SAFETY_LAX ? "LAX (warn+proceed, sensitive blocks)" : "SPEC (confirm on warnings)"}  ·  9 review triggers server-side  ·  endpoints: /artifacts[/get|content|diff|version|update|delete|export|review|duplicate|transform]`);
  console.log(`[dominion-ai] mentor: ${mentor.info().provider}  ·  auto-review=${AUTO_MENTOR ? "ON (tiered+adaptive)" : "OFF"}  ·  periodic=${PERIODIC_MENTOR ? "every " + PERIODIC_EVERY : "off"}  ·  council roles: ${Object.keys(MENTOR_ROLES).length}  ·  flywheel ${JSON.stringify(flywheel.stats())}`);
  const ps = persona.stats();
  console.log(`[dominion-ai] persona: ${ps.docs} doc(s) / ${ps.chunks} chunk(s) (${JSON.stringify(ps.byKind)})  ·  ${ps.pendingEmbeds} pending embed(s)  ·  fts=${ps.fts ? "on" : "OFF"}  ·  profile=${ps.profile ? "distilled " + String(ps.profile.updatedAt).slice(0, 10) : "none yet"}  ·  db=${Math.round(ps.dbBytes / 1024)}KB  ·  inboxes: ${persona.inbox} + ${persona.stagingInbox}  ·  mode: as_fred`);
  if (persona.migrated) console.log(`[dominion-ai] persona: migrated ${persona.migrated} doc(s) from the legacy JSON store into SQLite`);
  // Backfill embeddings for pre-vector memories in the background (no-op if the embed model is absent).
  memory.backfillEmbeddings(100).then((n) => { if (n) console.log(`[dominion-ai] memory: backfilled ${n} embedding(s)`); }).catch(() => {});
  embedLoop();   // continuous persona embedder: drains new chunks at a gentle pace, forever
  // Warm the persona vector cache in the background so the FIRST As-Fred query doesn't pay the
  // full 14k-vector SQLite load inside an interactive request.
  setTimeout(() => { try { const n = persona.warmCache(); console.log(`[dominion-ai] persona: vec cache warmed (${n} vector(s) in RAM)`); } catch (e) { console.log("[dominion-ai] persona: vec cache warm failed: " + (e && e.message)); } }, 1500);
  console.log("[dominion-ai] front this with: tailscale serve --bg " + PORT);
  if (String(cfgGet("WATCHDOG_ENABLED", "1")) !== "0") {
    const wms = Number(cfgGet("WATCHDOG_INTERVAL_MS", "180000")) || 180000;
    startWatchdog({ logDir: LOG_DIR, ollamaUrl: OLLAMA, intervalMs: wms });
    console.log(`[dominion-ai] watchdog: ON  ·  heartbeat + poller self-heal every ${Math.round(wms / 1000)}s  ·  log=logs/watchdog.jsonl`);
  }
});
