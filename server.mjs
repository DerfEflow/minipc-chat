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
import { TOOL_DEFS, WRITE_TOOLS, runTool } from "./tools.mjs";

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

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
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
const PROVIDERS = {
  light: { id: "local_light", modelName: LIGHT_MODEL, providerType: "local", maxContextTokens: 40960,
           supportsThinking: true, supportsTools: true, latencyTier: "fast",   privacyLevel: "local_private", costTier: "free_local" },
  main:  { id: "local_main",  modelName: MAIN_MODEL,  providerType: "local", maxContextTokens: 262144,
           supportsThinking: true, supportsTools: true, latencyTier: "medium", privacyLevel: "local_private", costTier: "free_local" },
};
const MODEL_FOR = (tier) => (PROVIDERS[tier] || PROVIDERS.light).modelName;

// Mode discipline: each mode picks a model tier, sampling, optional long context, + a prompt fragment.
const MODES = {
  fast:         { tier: "light", temp: 0.4, frag: "FAST MODE: minimize reasoning; give a concise, direct answer; use tools only if necessary." },
  normal:       { tier: "light", temp: 0.7, frag: "" },
  draft:        { tier: "main",  temp: 0.8, frag: "DRAFT MODE: produce a clean, reusable, well-structured document; use headings and lists; keep it editable." },
  deep_think:   { tier: "main",  temp: 0.5, frag: "DEEP THINK MODE: reason carefully through the steps and tradeoffs; give a structured, thorough answer; summarize your reasoning rather than dumping raw chain-of-thought." },
  long_context: { tier: "main",  temp: 0.5, num_ctx: 32768, frag: "LONG CONTEXT MODE: the input may be large; be systematic and note which parts you used." },
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

function systemPrompt(persona, modeFrag) {
  let s = [
    "You are Dominion AI, Frederick (Fred) Wolfe's personal assistant. Today is 2026-06-22.",
    "You run on his always-on mini-PC and you have real tools (hands). Use them when they help —",
    "don't just describe what could be done; do it. Prefer reading current state (e.g. deck_list_projects,",
    "forge_read) before acting so you work from facts, not guesses.",
    "Keep replies concise and direct. Don't fabricate file contents, project ids, or results — read them.",
    "Real code/file changes go through forge_send. The sandbox is your private scratch space for drafts/notes.",
    "When you finish a tool action, briefly confirm what you actually did.",
  ].join(" ");
  if (modeFrag) s += "\n\n" + modeFrag;
  if (persona) s += "\n\nFor this conversation, adopt this style/role: " + persona;
  return s;
}

async function ollamaChat(model, messages, opts = {}) {
  return await new Promise((resolve) => {
    const payload = { model, messages, stream: false };
    if (!opts.noTools) payload.tools = TOOL_DEFS;
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

// Combined auto-router: take the STRONGER of heuristic vs classifier -> {mode, tier, reason}.
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
  return { mode, tier, reason: `${src}: ${reason}`.slice(0, 80) };
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
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const totalInputChars = history.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

  // Route: an explicit mode wins; otherwise the combined heuristic+light-model router picks.
  let mode, tier, reason;
  if (reqMode !== "auto" && MODES[reqMode]) { mode = reqMode; tier = MODES[mode].tier; reason = "you chose " + mode.replace("_", " "); }
  else { const c = await routeDecision(lastUser ? lastUser.content : "", totalInputChars); mode = c.mode; tier = c.tier; reason = c.reason; }
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

  const messages = [{ role: "system", content: systemPrompt(persona, md.frag) }, ...history];
  const startedAt = new Date().toISOString();
  let toolCount = 0, roundsUsed = 0;

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
          sse({ type: "tool", name, gated: WRITE_TOOLS.has(name), status: "run" });
          const result = await runTool(name, args, CTX);
          toolCount++;
          sse({ type: "tool", name, status: "done", preview: String(result).replace(/\s+/g, " ").slice(0, 120) });
          messages.push({ role: "tool", tool_name: name, content: String(result).slice(0, 8000) });
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
      console.log(`[dominion-ai] usage ${model}/${mode} prompt=${(last && last.prompt_eval_count) || "?"} out=${(last && last.eval_count) || "?"} tools=${toolCount}`);
      await logUsage({ ts: startedAt, model, mode, reason, status: "completed", rounds: roundsUsed, tools: toolCount, promptTokens: (last && last.prompt_eval_count) || null, outputTokens: (last && last.eval_count) || null });
      sse({ type: "done" });
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
  console.log("[dominion-ai] front this with: tailscale serve --bg " + PORT);
});
