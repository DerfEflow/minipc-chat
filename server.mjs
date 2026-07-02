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
import { TOOL_DEFS, WRITE_TOOLS, runTool, toolMeta, assertNotProtected } from "./tools.mjs";
import { createMemoryStore } from "./memory.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { createMentor } from "./mentor.mjs";
import { createFlywheel } from "./flywheel.mjs";
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

// Phase 2: governed memory store. LAX -> candidates auto-approve unless MEMORY_AUTO_APPROVE=0.
const MEMORY_DIR = cfgGet("MEMORY_DIR", "C:\\minipc-chat\\memory");
const memory = createMemoryStore({ dir: MEMORY_DIR, autoApprove: String(cfgGet("MEMORY_AUTO_APPROVE", "1")) !== "0", embed: embedText });
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
const PERSONA_DIR = cfgGet("PERSONA_DIR", "C:\\minipc-chat\\corpus");
const persona = createPersonaStore({ dir: PERSONA_DIR, embed: embedText });
CTX.persona = persona;
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
const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();

// Provider abstraction (local) — spec Phase 1 "model provider abstraction". Each tier is a provider
// with the capability fields the router cares about. qwen3:8b = fast light worker; qwen3:30b-a3b = heavy reasoning.
const LIGHT_MODEL = cfgGet("LIGHT_MODEL", "qwen3:8b");
const MAIN_MODEL = cfgGet("MAIN_MODEL", "qwen3:30b-a3b");
// Full spec ModelProvider fields. maxContextTokens is the HONEST Ollama-served window (40960);
// the earlier 262144 was the family's theoretical YaRN ceiling, which this box neither serves
// (Ollama doesn't expose YaRN rope-scaling params) nor has the RAM to hold — long-context gating
// caps at what the runtime actually delivers. Displays never leak underlying model names.
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

// Normalized response shape (spec NormalizedModelResponse) — one place that translates an Ollama
// reply into provider-agnostic usage/quality fields for logging and the done event.
function normalizeResponse(d, model, mode) {
  const p = PROVIDER_FOR_MODEL(model);
  return {
    providerId: p.id, modelName: model, mode,
    content: (d && d.message && d.message.content) || "",
    toolCalls: (d && d.message && d.message.tool_calls) || [],
    usage: {
      inputTokens: (d && d.prompt_eval_count) || null,
      outputTokens: (d && d.eval_count) || null,
      totalTokens: ((d && d.prompt_eval_count) || 0) + ((d && d.eval_count) || 0) || null,
      latencyMs: d && d.total_duration ? Math.round(d.total_duration / 1e6) : null,
      costUsd: 0,
    },
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
  as_fred:      { tier: "main",  temp: 0.85, frag: "AS-FRED MODE: write and think AS Frederick Wolfe, in his own voice — using his profile and the real writing examples provided. Inhabit his humor, vocabulary, wit, and rhythm; hold his opinions and interests. Never announce that you are imitating him and never mention models or being an AI." },
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
const needsConfirm = (cls) => cls === "dangerous" || cls === "requires_confirmation";

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
const AUTO_MENTOR = String(cfgGet("AUTO_MENTOR", "0")) === "1";
// Periodic mentor review (spec): every Nth completed answer gets a lightweight LOCAL critique in the
// background — catches drift without per-response cost. Default ON (local-only = zero egress);
// PERIODIC_MENTOR=0 disables, PERIODIC_MENTOR_EVERY tunes the stride.
const PERIODIC_MENTOR = String(cfgGet("PERIODIC_MENTOR", "1")) !== "0";
const PERIODIC_EVERY = Math.max(5, Number(cfgGet("PERIODIC_MENTOR_EVERY", "25")) || 25);
let completedRuns = 0;
// Adaptive mentor sampling policy (spec) — used only when AUTO_MENTOR is on.
const MENTOR_SAMPLING = { casualChat: 0, shortDraft: 0.05, factualAnswer: 0.15, technicalAnswer: 0.25, documentDraft: 0.25, finalArtifact: 0.75, codeGeneration: 0.5, executableCode: 0.9, toolChainWithErrors: 1, userMarkedImportant: 1 };
function sampleCategory(mode, toolFailed) {
  if (toolFailed) return "toolChainWithErrors";
  if (mode === "draft") return "documentDraft";
  if (mode === "deep_think") return "technicalAnswer";
  if (mode === "fast") return "casualChat";
  return "factualAnswer";
}

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
    const payload = { model, messages, stream: false };
    if (!opts.noTools) payload.tools = TOOL_DEFS;
    if (opts.format) payload.format = opts.format;   // e.g. "json" — forces valid JSON, suppresses thinking spill
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
  return {
    mode, tier, reason: `${src}: ${reason}`.slice(0, 80),
    privacyRisk: privacyRiskOf(lastUser),
    needsTools: /\b(deck|forge|file|sandbox|remember|artifact|project|capture|run|search)\b/.test(t),
    needsMemory: true,                       // approved memory is always considered
    needsRetrieval: mode !== "fast",
    needsMentorReview: false,                // manual / sampled / periodic paths decide this
  };
}

// Context builder (Phase 2, full): always-on durable memory (pinned + profile) + query-relevant
// approved memory (HYBRID lexical+vector) + relevant saved artifacts + snippets from earlier
// conversations + active retrieval-scope rules. Pending/rejected/archived memory never appears.
// Returns everything injected (for logging + the mentor review package) and a compact block.
async function buildContext(lastUserText, chatId, { skipRetrieval = false } = {}) {
  const pinned = memory.alwaysLoaded({ limit: 6 });
  const retrieved = skipRetrieval ? [] : await memory.retrieveHybrid(lastUserText || "", { limit: 4 });
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
    const r = memory.propose({ content: body.content, type: body.type, tags: body.tags, scope: body.scope, pinned: body.pinned, source: { kind: body.source || "user_explicit" } });
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

// Local document review (Phase 4 mentor-hook stand-in) — the main model critiques an artifact.
// Phase 5 swaps in external mentors + the full structured critique/ledger.
async function localReview(a) {
  const prompt =
    "You are a careful reviewer of a document. Review it and return a SHORT plain-text critique with these labeled sections:\n" +
    "SCORE (0-10):\nREADY FOR USE (yes/no):\nMAJOR ISSUES:\nMINOR ISSUES:\nUNSUPPORTED CLAIMS:\nSUGGESTIONS:\n" +
    "Do not rewrite the document. Be concise and specific.\n\nTITLE: " + a.title + "\nTYPE: " + a.type + "\n\nDOCUMENT:\n" + String(a.content || "").slice(0, 12000);
  const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: prompt }], { temperature: 0.3, num_predict: 700, noTools: true });
  return stripThink((d && d.message && d.message.content) || "") || "(no review produced)";
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
    if (p === "/artifacts") return json(200, artifacts.create(body));
    if (p === "/artifacts/version") return json(200, artifacts.addVersion(body.id, body));
    if (p === "/artifacts/setversion") return json(200, artifacts.setVersion(body.id, Number(body.version)));
    if (p === "/artifacts/update") return json(200, artifacts.update(body.id, body));
    if (p === "/artifacts/delete") return json(200, artifacts.remove(body.id));
    if (p === "/artifacts/export") return json(200, await exportWithForge(body.id, body.format));
    if (p === "/artifacts/review") {
      const a = artifacts.get(body.id); if (!a) return json(404, { error: "not found" });
      const notes = "LOCAL REVIEW (local mentor):\n\n" + await localReview(a);
      return json(200, artifacts.attachReview(body.id, notes));
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

// Export with the Forge chained in: text formats export locally as before; docx/pdf exports the
// markdown source, then AUTOMATICALLY queues a Forge work order to convert it (Claude Code holds
// the docx/pdf skills). Editable source is always preserved (spec export safety).
async function exportWithForge(id, format) {
  const fmt = String(format || "").toLowerCase();
  if (!["docx", "pdf"].includes(fmt)) return artifacts.exportArtifact(id, format);
  const a = artifacts.get(id); if (!a) return { error: "not found" };
  const md = artifacts.exportArtifact(id, "md");
  if (md.error) return md;
  if (!CTX.runPassword) return { ...md, warning: `Exported markdown. ${fmt} conversion needs the Forge run-password configured on the server.` };
  const instructions = `Convert the exported artifact markdown at ${md.path} into a well-formatted .${fmt} file saved NEXT TO the source (same folder, same base name, .${fmt} extension). Use your document skills; preserve headings, lists, and tables. Do not modify the source .md.`;
  const out = await runTool("forge_send", { repo: "cad-sandbox", title: `Export artifact "${a.title}" to ${fmt}`, instructions }, CTX);
  return { ...md, forge: String(out), queued: /Queued work order/i.test(String(out)) };
}

// Mentor review (Phase 5): critique an answer or artifact -> structured critique; auto-log a ledger
// entry when the mentor flags real issues; attach review notes to an artifact when given an id.
async function handleMentorReview(req, res) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const b = await readJsonBody(req); if (!b) return json(400, { error: "bad json" });
  let content = String(b.content || "");
  if (b.artifactId) { const a = artifacts.get(b.artifactId); if (a) content = a.content; }
  if (!content.trim()) return json(400, { error: "nothing to review" });
  const c = await mentor.critique({ taskType: b.taskType || "answer_review", originalRequest: b.originalRequest || "", content, privacyMode: b.privacyMode || (mentor.info().externalConfigured ? "redacted_external" : "local_only") });
  let ledgerId = null;
  if (["medium", "high"].includes(c.revision_priority)) { const f = flywheel.addFailure({ category: "mentor_flag", severity: c.revision_priority === "high" ? "high" : "medium", originalRequest: b.originalRequest || "", flawedOutput: content, detectedBy: "mentor", rootCause: "unknown", improvementActions: ["manual_review"] }); ledgerId = f.item.id; }
  if (b.artifactId) artifacts.attachReview(b.artifactId, "MENTOR (" + c._provider + "):\n" + (c.recommended_revision || "") + "\n\nMajor findings: " + (c.major_findings || []).join("; "));
  return json(200, { critique: c, ledgerId, mentor: mentor.info() });
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
  if (b.artifactId) return json(200, { revised, ...artifacts.addVersion(b.artifactId, { content: revised, model: MAIN_MODEL, promptSummary: "mentor revision applied" }) });
  return json(200, { revised });
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
// /prompts (+ /prompts/activate) — list/create/update/delete.
async function handleFlywheel(req, res, u) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  const MAP = { "/ledger": "failures", "/evals": "evals", "/rules": "rules", "/prompts": "prompts" };
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
    if (p === "/prompts") return json(200, flywheel.addPrompt(b));
    if (p === "/prompts/activate") return json(200, flywheel.activatePrompt(b.id));
    if (p === "/evals/run") return json(200, await runEval(b.id));
    if (p === "/rules/test") return json(200, await testRule(b.id));
    for (const [path, coll] of Object.entries(MAP)) {
      if (p === path + "/update") return json(200, flywheel.update(coll, b.id, b));
      if (p === path + "/delete") return json(200, flywheel.remove(coll, b.id));
    }
  }
  return json(404, { error: "not found" });
}

// Distill a structured "Fred Profile" from the corpus by having the 30B analyze a diverse sample.
// JSON-out (format:"json") to dodge qwen's thinking-spill breaking the parse (the Phase-5 gotcha).
async function distillPersona() {
  const sample = persona.sampleForProfile({ perKind: 6, maxChars: 14000 });
  if (!sample.length) return { error: "The corpus is empty — dump some of Fred's writing first (paste, scan the inbox, or scrape a page)." };
  const corpus = sample.map((s, i) => `#${i + 1} [${s.kind}] ${s.title}\n${s.text}`).join("\n\n---\n\n");
  const prompt = [
    "You are building a PERSONA PROFILE of the writer Frederick (Fred) Wolfe from real samples of his own writing.",
    "Study the samples and infer his enduring style — not the topic of any one piece. Be specific and concrete: name actual words he favors, the shape of his sentences, the mechanics of his humor. Avoid generic flattery.",
    "",
    "Return ONLY JSON with these string (or string-array) fields:",
    '{ "voice_style": "...", "humor": "...", "vocabulary": "...", "wit": "...", "specialties": "...", "reasoning": "...", "interests": "...", "avoid": "...", "summary": "..." }',
    "- voice_style: tone, sentence rhythm, formality, punctuation habits, POV.",
    "- humor: what makes him funny — timing, irony, absurdity, wordplay, targets he mocks.",
    "- vocabulary: his nuanced/favored words and phrases (list real ones seen in the samples).",
    "- wit: rhetorical moves, turns of phrase, how he lands a point.",
    "- specialties: subjects he clearly knows deeply.",
    "- reasoning: how he thinks/argues/structures ideas.",
    "- interests: recurring interests, habits, hobbies, life work.",
    "- avoid: anti-patterns that would break his voice. ALWAYS include: never use antithesis constructions ('not X but Y', 'it's not X, it's Y', 'not X, not Y, but Z').",
    "- summary: 2-3 sentences a ghostwriter could read to instantly write as Fred.",
    "",
    "SAMPLES:",
    corpus,
  ].join("\n");
  const d = await ollamaChat(MAIN_MODEL, [{ role: "user", content: prompt }], { temperature: 0.3, num_predict: 2600, noTools: true, format: "json" });
  let facets = null;
  try { facets = JSON.parse(d && d.content ? d.content : "{}"); } catch { return { error: "The model didn't return valid JSON — try again." }; }
  if (!facets || typeof facets !== "object") return { error: "Empty profile came back — try again." };
  const systemBlock = renderFacets(facets) + (facets.summary ? "\n- In short: " + facets.summary : "");
  const p = persona.setProfile({ facets, systemBlock, model: "local" });
  return { profile: p, sampled: sample.length };
}

// Persona Forge API: dump material, scan the inbox, scrape a page, distill the profile, search exemplars.
async function handlePersona(req, res, u) {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const p = u.pathname;
  if (req.method === "GET" && p === "/persona") return json(200, { stats: persona.stats(), kinds: PERSONA_KINDS, profile: persona.getProfile() ? { ...persona.getProfile(), facets: undefined } : null });
  if (req.method === "GET" && p === "/persona/profile") return json(200, { profile: persona.getProfile() });
  if (req.method === "GET" && p === "/persona/list") return json(200, { items: persona.list({ kind: u.searchParams.get("kind") || "", q: u.searchParams.get("q") || "" }), stats: persona.stats() });
  if (req.method === "GET" && p === "/persona/search") return json(200, { hits: await persona.retrieve(u.searchParams.get("q") || "", { limit: 8, kind: u.searchParams.get("kind") || "" }) });

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body) return json(400, { error: "bad json" });
    if (p === "/persona" || p === "/persona/ingest") {
      const r = persona.ingestText({ text: body.text, kind: body.kind, title: body.title, source: body.source || "pasted", tags: body.tags });
      return json(r.error ? 400 : 200, r.error ? r : { ok: true, docId: r.doc.id, chunks: r.chunks, deduped: !!r.deduped, stats: persona.stats() });
    }
    if (p === "/persona/scan") { const r = persona.scanInbox(); return json(200, { ...r, stats: persona.stats() }); }
    if (p === "/persona/scrape") {
      const r = await fetchUrl(String(body.url || ""));
      if (r.error) return json(400, { error: "Couldn't fetch that URL: " + r.error });
      if (r.status >= 400) return json(400, { error: "The site returned HTTP " + r.status });
      const text = /html/i.test(r.contentType || "") || /<html/i.test(r.body || "") ? htmlToText(r.body) : String(r.body || "");
      if (!text || text.length < 40) return json(400, { error: "Nothing readable came back from that page." });
      const ing = persona.ingestText({ text, kind: body.kind || "web", title: body.title || body.url, source: "scrape:" + body.url });
      return json(ing.error ? 400 : 200, ing.error ? ing : { ok: true, docId: ing.doc.id, chunks: ing.chunks, chars: text.length, deduped: !!ing.deduped, stats: persona.stats() });
    }
    if (p === "/persona/distill") { const r = await distillPersona(); return json(r.error ? 400 : 200, r); }
    if (p === "/persona/delete") { return json(200, persona.removeDoc(body.id)); }
  }
  return json(404, { error: "not found" });
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
  const sse = (o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {} };
  let aborted = false;
  res.on("close", () => (aborted = true));

  const persona = typeof input.persona === "string" ? input.persona.slice(0, 2000) : "";
  const userTemp = (typeof input.temperature === "number" && input.temperature >= 0 && input.temperature <= 2) ? input.temperature : undefined;
  const reqMode = typeof input.mode === "string" ? input.mode : "auto";
  const forced = (typeof input.model === "string" && input.model && input.model !== "auto") ? input.model : "";
  const confirmTools = CONFIRM_TOOLS_ENV || input.confirmTools === true;   // Phase 3: default OFF (LAX)
  const chatId = typeof input.chatId === "string" ? input.chatId.slice(0, 80) : "";
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const totalInputChars = history.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  // Route: an explicit mode wins; otherwise the combined heuristic+light-model router picks.
  let mode, tier, reason, privacyRisk = privacyRiskOf(lastUser ? lastUser.content : "");
  if (reqMode !== "auto" && MODES[reqMode]) { mode = reqMode; tier = MODES[mode].tier; reason = "you chose " + mode.replace("_", " "); }
  else { const c = await routeDecision(lastUser ? lastUser.content : "", totalInputChars); mode = c.mode; tier = c.tier; reason = c.reason; privacyRisk = c.privacyRisk; }
  if (aborted) return res.end();
  const md = MODES[mode];
  const model = forced || MODEL_FOR(tier);
  const opts = { temperature: typeof userTemp === "number" ? userTemp : md.temp };
  // Long-context gating: only scale num_ctx up for long_context mode, sized to the input, capped at the provider limit.
  if (mode === "long_context") {
    const cap = (PROVIDERS[tier] || PROVIDERS.main).maxContextTokens;
    const want = Math.min(estTokens(totalInputChars) * 2 + 8192, cap);
    opts.num_ctx = Math.max(md.num_ctx || 32768, Math.ceil(want / 4096) * 4096);
  } else if (md.num_ctx) opts.num_ctx = md.num_ctx;
  sse({ type: "route", model, mode, reason });
  console.log(`[dominion-ai] /chat route -> ${model} · ${mode} (${reason})`);

  // Context builder (Phase 2, full): system -> learned rules -> memory + artifacts + past chats -> turns.
  // Fast mode skips retrieval (spec: fast = no retrieval overhead); durable pinned/profile still loads.
  const ctxInfo = await buildContext(lastUser ? lastUser.content : "", chatId, { skipRetrieval: mode === "fast" });
  const messages = [{ role: "system", content: systemPrompt(persona, md.frag) }];
  const activeRules = flywheel.activeRules(mode).filter((r) => r.scope !== "retrieval");   // Phase 5: learned prompt rules
  if (activeRules.length) messages.push({ role: "system", content: "Active learned rules — follow these:\n" + activeRules.map((r) => "- " + r.content).join("\n") });
  if (ctxInfo.block) messages.push({ role: "system", content: ctxInfo.block });
  // As-Fred mode: inject the distilled Fred Profile + real writing exemplars retrieved for this prompt.
  let personaInfo = null;
  if (mode === "as_fred") {
    try {
      personaInfo = await persona.personaBlock(lastUser ? lastUser.content : "", { exemplars: 6 });
      if (personaInfo.block) messages.push({ role: "system", content: personaInfo.block });
      sse({ type: "persona", hasProfile: personaInfo.hasProfile, exemplars: personaInfo.exemplars.length });
    } catch {}
  }
  messages.push(...history);
  const contextTokens = estTokens(messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0));
  if (ctxInfo.used.length || ctxInfo.artifactsUsed.length || ctxInfo.chatsUsed.length) {
    sse({ type: "context", memory: ctxInfo.used.length, artifacts: ctxInfo.artifactsUsed.length, chats: ctxInfo.chatsUsed.length, items: ctxInfo.used.map((c) => ({ title: c.title, label: c.citationLabel, score: c.score })) });
    console.log(`[dominion-ai] context: ${ctxInfo.used.length} mem · ${ctxInfo.artifactsUsed.length} artifact(s) · ${ctxInfo.chatsUsed.length} chat(s) · ~${contextTokens} tok`);
  }
  const startedAt = new Date().toISOString();
  let toolCount = 0, roundsUsed = 0, artifactCreatedThisTurn = false, toolFailedThisTurn = false;
  const toolRunIds = [], toolSummaries = [];

  try {
    let last = null;
    for (let round = 0; round < MAX_ROUNDS && !aborted; round++) {
      roundsUsed = round + 1;
      let d = await ollamaChat(model, messages, opts);
      // the heavier 30B can return null on a cold load / transient blip — retry once on the first round
      if (!d && round === 0 && !aborted) { await sleep(1500); d = await ollamaChat(model, messages, opts); }
      last = d;
      if (aborted) break;
      const msg = d && d.message;
      if (!msg) { sse({ type: "error", error: "The model didn't respond (it may still be warming up — try again)." }); await logUsage({ ts: startedAt, model, mode, reason, status: "no_response", rounds: roundsUsed }); return res.end(); }

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length && round < MAX_ROUNDS - 1) {
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
          const cls = meta.permissionClass;
          const startedAt = new Date().toISOString();
          const inPrev = meta.logsInputs ? JSON.stringify(args).slice(0, 200) : undefined;
          toolCount++;
          toolRunIds.push(runId);

          // 1) Ironclad carve-out: hard-deny protected resources (customer DBs / backups), even under LAX.
          const guard = assertNotProtected(name, args);
          if (!guard.ok) {
            sse({ type: "tool", name, runId, cls, status: "blocked", preview: guard.reason });
            await logToolRun({ ts: startedAt, runId, name, category: meta.category, cls, status: "blocked", reason: guard.reason, input: inPrev, chatId, model });
            messages.push({ role: "tool", tool_name: name, content: `BLOCKED: this ${guard.reason}. I cannot do that.` });
            toolSummaries.push(name + " · blocked");
            continue;
          }

          // 1b) Mode gate (spec allowedModes): e.g. forge_send is barred from Draft mode.
          if (meta.allowedModes && !meta.allowedModes.includes(mode)) {
            sse({ type: "tool", name, runId, cls, status: "blocked", preview: "not allowed in " + mode + " mode" });
            await logToolRun({ ts: startedAt, runId, name, category: meta.category, cls, status: "blocked", reason: "mode " + mode + " not in allowedModes", input: inPrev, chatId, model });
            messages.push({ role: "tool", tool_name: name, content: `BLOCKED: ${name} is not allowed in ${mode} mode. Tell Fred to switch modes if this action is really needed.` });
            toolSummaries.push(name + " · blocked (mode)");
            continue;
          }

          // 2) Confirmation gate (Phase 3) — default OFF (LAX). When on, risky tools need user approval.
          if (confirmTools && needsConfirm(cls)) {
            sse({ type: "tool_confirm", name, runId, cls, preview: inPrev || "" });
            const decision = await awaitConfirm(runId, 120000);
            if (decision !== "approved") {
              sse({ type: "tool", name, runId, cls, status: "cancelled", preview: decision });
              await logToolRun({ ts: startedAt, runId, name, category: meta.category, cls, status: "cancelled", decision, input: inPrev, chatId, model });
              messages.push({ role: "tool", tool_name: name, content: `The user did not approve this ${cls} action (${decision}); it was not run.` });
              toolSummaries.push(name + " · cancelled");
              continue;
            }
          }

          // 3) Run + report honestly.
          sse({ type: "tool", name, runId, cls, gated: WRITE_TOOLS.has(name), status: "run" });
          const result = await runTool(name, args, CTX);
          const failed = /^(Tool .+ failed|Unknown tool|Couldn't|I can read and plan|Memory isn't available|BLOCKED)/i.test(String(result));
          if (failed) toolFailedThisTurn = true;
          if ((name === "create_artifact" || name === "revise_artifact") && !failed) artifactCreatedThisTurn = true;
          sse({ type: "tool", name, runId, cls, status: failed ? "failed" : "done", preview: String(result).replace(/\s+/g, " ").slice(0, 120) });
          await logToolRun({ ts: startedAt, endedAt: new Date().toISOString(), runId, name, category: meta.category, cls, status: failed ? "failed" : "succeeded", input: inPrev, output: String(result).replace(/\s+/g, " ").slice(0, 200), chatId, model });
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
          if (art.item) { sse({ type: "artifact", id: art.item.id, title: art.item.title, action: "saved" }); console.log(`[dominion-ai] artifact auto-saved: ${art.item.title} (${art.item.id.slice(0, 8)})`); }
        } catch {}
      }
      // Mentor mode (spec): the answer is ALWAYS critiqued afterwards — full card goes to the client.
      if (mode === "mentor") {
        try {
          const c = await mentor.critique({ taskType: "answer_review", originalRequest: lastUser ? lastUser.content : "", content: answer, privacyMode: "local_only", retrievedContext: ctxInfo.used.map((x) => x.content), toolCalls: toolSummaries });
          sse({ type: "mentor_full", critique: c });
          if (["medium", "high"].includes(c.revision_priority)) flywheel.addFailure({ category: "mentor_flag", severity: c.revision_priority === "high" ? "high" : "medium", originalRequest: lastUser ? lastUser.content : "", flawedOutput: answer, detectedBy: "mentor", rootCause: "unknown", improvementActions: ["manual_review"] });
        } catch {}
      }
      // Phase 5: adaptive auto mentor-review (default OFF / LAX). Local-only on the auto path (no egress).
      else if (AUTO_MENTOR && Math.random() < (MENTOR_SAMPLING[sampleCategory(mode, toolFailedThisTurn)] || 0)) {
        try {
          const c = await mentor.critique({ taskType: "answer_review", originalRequest: lastUser ? lastUser.content : "", content: answer, privacyMode: "local_only", retrievedContext: ctxInfo.used.map((x) => x.content), toolCalls: toolSummaries });
          sse({ type: "mentor", score: c.overall_score, priority: c.revision_priority, findings: (c.major_findings || []).length });
          if (["medium", "high"].includes(c.revision_priority)) flywheel.addFailure({ category: "mentor_flag", severity: c.revision_priority === "high" ? "high" : "medium", originalRequest: lastUser ? lastUser.content : "", flawedOutput: answer, detectedBy: "mentor", rootCause: "unknown", improvementActions: ["manual_review"] });
        } catch {}
      }
      // Periodic mentor review (spec): every Nth completed answer gets a background local critique —
      // findings land in the ledger, nothing blocks the reply.
      completedRuns++;
      if (PERIODIC_MENTOR && mode !== "mentor" && completedRuns % PERIODIC_EVERY === 0) {
        const req0 = lastUser ? String(lastUser.content) : "";
        setImmediate(async () => {
          try {
            const c = await mentor.critique({ taskType: "answer_review", originalRequest: req0, content: answer, privacyMode: "local_only" });
            if (["medium", "high"].includes(c.revision_priority)) flywheel.addFailure({ category: "periodic_review", severity: c.revision_priority === "high" ? "high" : "medium", originalRequest: req0, flawedOutput: answer.slice(0, 4000), detectedBy: "mentor", rootCause: "unknown", improvementActions: ["manual_review"] });
            console.log(`[dominion-ai] periodic mentor review #${completedRuns}: score ${c.overall_score}/10, priority ${c.revision_priority}`);
          } catch {}
        });
      }
      const norm = normalizeResponse(last, model, mode);
      console.log(`[dominion-ai] usage ${model}/${mode} prompt=${norm.usage.inputTokens || "?"} out=${norm.usage.outputTokens || "?"} tools=${toolCount}`);
      await logUsage({ ts: startedAt, model, mode, reason, privacyRisk, status: "completed", rounds: roundsUsed, tools: toolCount, memoryUsed: ctxInfo.used.length, artifactsUsed: ctxInfo.artifactsUsed.length, chatsUsed: ctxInfo.chatsUsed.length, contextTokens, promptTokens: norm.usage.inputTokens, outputTokens: norm.usage.outputTokens, latencyMs: norm.usage.latencyMs });
      try { chatlog.record(chatId, history, answer); } catch {}
      sse({ type: "done", meta: { mode, memory: ctxInfo.used.length, artifacts: ctxInfo.artifactsUsed.length, chats: ctxInfo.chatsUsed.length, tools: toolCount, outputTokens: norm.usage.outputTokens } });
      return res.end();
    }
    if (aborted) { await logUsage({ ts: startedAt, model, mode, reason, status: "interrupted", rounds: roundsUsed, tools: toolCount }); }
    else { sse({ type: "error", error: "I used too many tool steps without finishing — try rephrasing." }); await logUsage({ ts: startedAt, model, mode, reason, status: "max_rounds", rounds: roundsUsed, tools: toolCount }); }
  } catch (e) {
    sse({ type: "error", error: "Server error: " + e.message });
    await logUsage({ ts: startedAt, model, mode, reason, status: "error", error: String(e.message).slice(0, 200) });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(u.pathname);

    if (path === "/chat" && req.method === "POST") return handleChat(req, res);
    if (path === "/memory" || path.startsWith("/memory/")) return handleMemory(req, res, u);
    if (path === "/toolruns" && req.method === "GET") return handleToolRuns(req, res);
    if (path === "/tool-confirm" && req.method === "POST") return handleToolConfirm(req, res);
    if (path === "/artifacts" || path.startsWith("/artifacts/")) return handleArtifacts(req, res, u);
    if (path === "/mentor/review" && req.method === "POST") return handleMentorReview(req, res);
    if (path === "/mentor/revise" && req.method === "POST") return handleMentorRevise(req, res);
    if (["/ledger", "/evals", "/rules", "/prompts"].some((b) => path === b || path.startsWith(b + "/"))) return handleFlywheel(req, res, u);
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
  console.log(`[dominion-ai] router: heuristic+classifier  ·  light=${LIGHT_MODEL}  ·  main=${MAIN_MODEL}  ·  modes: auto/fast/normal/draft/deep_think/long_context  ·  usage log=${LOG_DIR}`);
  const ms = memory.stats();
  console.log(`[dominion-ai] memory: ${ms.total} item(s) (${JSON.stringify(ms.byStatus)})  ·  auto-approve=${ms.autoApprove}  ·  vectors=${EMBED_MODEL} (${ms.embedded} embedded)  ·  dir=${MEMORY_DIR}`);
  console.log(`[dominion-ai] chatlog: ${chatlog.stats().chats} conversation(s) indexed  ·  episodic summaries via /memory/summarize-session`);
  console.log(`[dominion-ai] tools: ${TOOL_DEFS.length} typed  ·  confirm-risky=${CONFIRM_TOOLS_ENV ? "ON" : "off (LAX)"}  ·  carve-outs: customer-DBs+backups hard-denied  ·  run log=toolruns.jsonl (${toolRunTail.length} reloaded)`);
  const as = artifacts.stats();
  console.log(`[dominion-ai] artifacts: ${as.total} (${JSON.stringify(as.byStatus)})  ·  dir=${ARTIFACT_DIR}  ·  endpoints: /artifacts[/get|content|diff|version|update|delete|export|review|duplicate|transform]`);
  console.log(`[dominion-ai] mentor: ${mentor.info().provider}  ·  auto-review=${AUTO_MENTOR ? "ON" : "off (LAX)"}  ·  periodic=${PERIODIC_MENTOR ? "every " + PERIODIC_EVERY : "off"}  ·  flywheel ${JSON.stringify(flywheel.stats())}`);
  const ps = persona.stats();
  console.log(`[dominion-ai] persona: ${ps.docs} doc(s) / ${ps.chunks} chunk(s) (${JSON.stringify(ps.byKind)})  ·  profile=${ps.profile ? "distilled " + String(ps.profile.updatedAt).slice(0, 10) : "none yet"}  ·  inbox=${persona.inbox}  ·  mode: as_fred`);
  // Backfill embeddings for pre-vector memories in the background (no-op if the embed model is absent).
  memory.backfillEmbeddings(100).then((n) => { if (n) console.log(`[dominion-ai] memory: backfilled ${n} embedding(s)`); }).catch(() => {});
  persona.backfillEmbeddings(200).then((n) => { if (n) console.log(`[dominion-ai] persona: backfilled ${n} embedding(s)`); }).catch(() => {});
  console.log("[dominion-ai] front this with: tailscale serve --bg " + PORT);
  if (String(cfgGet("WATCHDOG_ENABLED", "1")) !== "0") {
    const wms = Number(cfgGet("WATCHDOG_INTERVAL_MS", "180000")) || 180000;
    startWatchdog({ logDir: LOG_DIR, ollamaUrl: OLLAMA, intervalMs: wms });
    console.log(`[dominion-ai] watchdog: ON  ·  heartbeat + poller self-heal every ${Math.round(wms / 1000)}s  ·  log=logs/watchdog.jsonl`);
  }
});
