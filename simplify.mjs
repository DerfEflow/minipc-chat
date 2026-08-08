/*
 * Dominion AI — "Simplify My Chat" (LANE I, docs/wiring/lane-i-simplify.md).
 *
 * A stripped-down chat for people who use AI as a chatbot and a search engine: one input, the
 * conversation, no model picker, no options. The user never makes a choice they came here to
 * avoid — this module picks the seat for them.
 *
 * SPLIT OF LABOR (both halves are load-bearing, see docs/wiring/lane-e-sequential.md "CONTRACT
 * FOR LANE I"):
 *   - Lane E's classifyComplexity() (sequential.mjs) judges HOW HARD the question is.
 *   - This file judges WHAT the question is ABOUT, and maps that to a model seat. There is
 *     deliberately no second complexity scorer here — two routers that disagree is the exact
 *     failure the contract exists to prevent.
 *
 * ROUTING TABLE: built exactly from docs/SIMPLIFY-ROUTING-TABLE.md (measured live against NVIDIA's
 * endpoint 2026-08-03). Two of Fred's named routes (safety, empathetic) point at model ids that
 * are NOT seats in models.catalog.mjs — the routing doc itself flags this (section 1: "Four of his
 * picks cannot serve"; the specific two below were probed alive on NVIDIA but never added to the
 * catalog as a seat). This file does not invent a substitute model of its own choosing: it falls
 * back to the already-established "chat" seat (Claude Haiku 4.5) and says so loudly, in the
 * `blocked` flag `resolveRouteModel` returns and in simplify_test.mjs. Fred can overrule either
 * fallback with a one-line edit to SIMPLIFY_BLOCKED_FALLBACKS.
 *
 * PROVIDER TRANSPORT — an honest limitation, read before changing this file: server.mjs's
 * PROVIDER_CFG / resolveProviderCfg (the real, already-built provider dispatch) are module-private
 * consts with no export, and this lane is barred from editing server.mjs. `resolveTransport` below
 * MIRRORS that documented behavior (same env var names, same default URLs, same
 * OpenRouter-fallback provider set) rather than importing it, because there is nothing to import.
 * [verified against server.mjs source, lines 612-663, read-only, 2026-08-03]. If server.mjs ever
 * exports resolveProviderCfg, this duplicate block should be deleted in favor of the real one.
 */

import { randomUUID } from "node:crypto";
import { modelById, resolveModelId, isCatalogModel, outLimitFor } from "./models.catalog.mjs";
import { askSliceOf } from "./routing.mjs";
import { runTool } from "./tools.mjs";
import { anthropicMessagesStream } from "./anthropicmessages.mjs";
import { classifyComplexity, SEQUENTIAL_THRESHOLD_DEFAULT } from "./sequential.mjs";

// ---- 1. THE ROUTING TABLE (docs/SIMPLIFY-ROUTING-TABLE.md section 3, verbatim) -----------------

export const SIMPLIFY_ROUTES = Object.freeze({
  chat: Object.freeze({
    label: "Chat", requestedModel: "anthropic/claude-haiku-4-5",
    note: "Fred's pick, stands — fast, cheap, kept off training data.",
  }),
  science: Object.freeze({
    label: "Science and math", requestedModel: "deepseek/deepseek-r1",
    note: "Fred's pick, stands — shows its reasoning step by step; Fred values how it reasons and wants it kept.",
  }),
  quick: Object.freeze({
    label: "Quick and dirty", requestedModel: "nvidia/nemotron-nano-12b-v2-vl",
    note: "Fred's pick, stands — small, fast, free.",
  }),
  business: Object.freeze({
    label: "Business", requestedModel: "z-ai/glm-5.2",
    note: "Fred's pick, stands — long-horizon planning, free via NVIDIA.",
  }),
  safety: Object.freeze({
    label: "Safety", requestedModel: "nvidia/nemotron-3.5-content-safety",
    note: "Fred's pick — measured ALIVE at 167ms on NVIDIA's endpoint 2026-08-03, but this id is not "
      + "a seat in models.catalog.mjs. BLOCKED until Fred adds it or approves the fallback.",
  }),
  empathetic: Object.freeze({
    label: "Empathetic", requestedModel: "meta/llama-3.1-70b-instruct",
    note: "SUBSTITUTED for the 3.3 generation (45,581ms to first token, unusable on a chat surface); "
      + "the 3.1 id measured 238ms but is ALSO not a seat in models.catalog.mjs. BLOCKED until Fred "
      + "adds it or approves the fallback.",
  }),
  literary: Object.freeze({
    label: "Literary", requestedModel: "arcee-ai/trinity-large-thinking",
    note: "SUBSTITUTED — Palmyra (Fred's pick) is not invokable on this account (HTTP 404).",
  }),
  creative: Object.freeze({
    label: "Creative", requestedModel: "arcee-ai/trinity-large-thinking",
    note: "SUBSTITUTED — Llama 3.1 405B (Fred's pick) does not exist on NVIDIA at all. Creative and "
      + "literary collapse into one seat rather than inventing a distinction the roster cannot serve.",
  }),
  theological: Object.freeze({
    label: "Theological and philosophical", requestedModel: "nvidia/nemotron-3-super-120b-a12b:free",
    note: "SUBSTITUTED — Fred's Nemotron 70B pick is not invokable (HTTP 404). This is the largest "
      + "FREE seat in the roster, 1M context, measured alive at 365ms.",
  }),
  websearch: Object.freeze({
    label: "Web search", requestedModel: "anthropic/claude-haiku-4-5",
    note: "REDESIGNED — Perplexity is not a seat in this roster and adding one is out of this wave's "
      + "scope. Search is a TOOL, not a model: this route reuses the chat seat and turns on the app's "
      + "existing web_search tool (tools.mjs, SerpApi-backed).",
    tool: "web_search",
  }),
});

// The seat every blocked route falls back to, and why. Both point at the "chat" route's own
// requested model — already verified a catalog member below — so a blocked route degrades to the
// app's ordinary fast chat model rather than a novel pick. This is Fred's own suggested alternative
// for "empathetic" (routing doc §4.2: "The alternative is a Claude seat, which is better at
// emotional register"); for "safety" it is the same seat used honestly until a real moderation
// model earns a catalog row (this app already screens content elsewhere via safety.mjs; this route
// is about a user's SUBJECT MATTER, not a moderation gate).
const SIMPLIFY_BLOCKED_FALLBACKS = Object.freeze({
  safety: "anthropic/claude-haiku-4-5",
  empathetic: "anthropic/claude-haiku-4-5",
});

/**
 * Resolve one named route to a model id that is guaranteed to exist in models.catalog.mjs, or
 * report exactly why it does not and what it fell back to. This is the function
 * simplify_test.mjs calls to catch a dead route before a user finds it.
 */
export function resolveRouteModel(routeKey) {
  const route = SIMPLIFY_ROUTES[routeKey];
  if (!route) return { routeKey, ok: false, blocked: true, modelId: "", error: `Unknown route "${routeKey}".` };
  const requested = route.requestedModel;
  // resolveModelId: live catalog id -> itself; a REMOVED_MODEL_FALLBACKS id -> its survivor;
  // anything else (never on the catalog, never pruned from it) -> "" (models.catalog.mjs's own
  // rule: "never invent a model").
  const resolved = resolveModelId(requested);
  if (resolved && isCatalogModel(resolved)) {
    return { routeKey, ok: true, blocked: false, modelId: resolved, requestedModel: requested };
  }
  const fallback = SIMPLIFY_BLOCKED_FALLBACKS[routeKey] || SIMPLIFY_ROUTES.chat.requestedModel;
  return {
    routeKey, ok: true, blocked: true, modelId: fallback, requestedModel: requested,
    blockReason: `${requested} is not a seat in models.catalog.mjs (docs/SIMPLIFY-ROUTING-TABLE.md `
      + `section 1). Falling back to ${fallback}.`,
  };
}

// ---- 2. SUBJECT-MATTER CLASSIFICATION (Lane I's own job) ----------------------------------------
// Keyword heuristics, deliberately shallow and readable: this app has already paid once for a
// keyword classifier promoted past what it can carry (routing.mjs's own NO_RETRIEVAL_RE comment).
// This never gates a refusal or a pause — worst case it picks the general "chat" seat, which is
// itself a competent generalist.

const TOPIC_PATTERNS = Object.freeze([
  // Safety checked FIRST and unconditionally: a crisis message must never be filed under "quick"
  // just because it is short.
  ["safety", /\b(kill myself|suicid\w*|self[- ]?harm|hurt(ing)? myself|want(ed)? to die|end(ing)? my life|cutting myself|overdose|no reason to live)\b/i],
  ["websearch", /\b(latest|breaking news|right now|as of today|current price|stock price|today'?s (date|news|weather)|this week'?s|who won|score of the|weather (in|today|tomorrow|this week)|search for|look up)\b/i],
  ["science", /\b(equation|derivative|integral|theorem|hypothesis|algorithm complexity|physics|chemistry|biology problem|calculat\w*|solve for [a-z]|prove that|molecul\w*|velocity|acceleration|standard deviation)\b/i],
  ["business", /\b(business plan|marketing plan|revenue|pricing strategy|startup idea|invoice|negotiat\w*|market analysis|budget forecast|sales pitch|swot analysis|profit margin|cash flow|business proposal)\b/i],
  ["empathetic", /\b(i feel|i'?m feeling|i'?ve been feeling|feeling (?:so |really |quite )?(?:sad|stressed|anxious|overwhelmed|lonely|hurt|struggling|depressed)|i'?m (so |really |quite )?(sad|stressed|anxious|lonely|overwhelmed|struggling|hurting|depressed)|breakup|broke up with|relationship advice|grief|grieving|i don'?t know what to do about my)\b/i],
  ["literary", /\b(write (me |us )?a (poem|short story|screenplay|novel chapter|sonnet)|literary style|prose style|metaphor for|poetry about)\b/i],
  ["creative", /\b(brainstorm|creative idea|invent a|creative concept|design a character|worldbuild\w*|plot twist|story idea)\b/i],
  ["theological", /\b(does god|is there a god|meaning of life|afterlife|my faith|the bible says|religion\w*|theolog\w*|philosoph\w*|existentialis\w*|morality of|the soul)\b/i],
]);

/** Subject-matter route key for a message, or "" when nothing matches (falls through to "chat"). */
export function classifyTopic(text) {
  const s = String(text == null ? "" : text);
  for (const [route, re] of TOPIC_PATTERNS) if (re.test(s)) return route;
  return "";
}

// ---- 3. COMPLEXITY, VIA LANE E — NEVER A SECOND CLASSIFIER --------------------------------------

const DEGRADED_COMPLEXITY = Object.freeze({
  score: 0, band: "simple", threshold: SEQUENTIAL_THRESHOLD_DEFAULT, needsSequential: false,
  suggestedTier: "ember", reasoning: false, minContextTokens: 0, taskKind: "simple", workKind: "",
  signals: Object.freeze([]), rationale: "The complexity classifier was unavailable for this turn; defaulted to a simple route.",
  degraded: true,
});

/*
 * sequential.mjs's own contract calls classifyComplexity() "total" and "never throws", and its
 * own author is fuzzing it against null/undefined/numbers/emoji/deep junk as this file is written.
 * A claim under active fuzzing is not yet a proof. This wrapper does not trust the guarantee: any
 * throw, or any return shape missing a usable `band`, degrades to a fixed, safe default rather than
 * failing the user's turn.
 */
function safeClassifyComplexity(text, env) {
  try {
    const result = env ? classifyComplexity(text, { env }) : classifyComplexity(text);
    if (result && typeof result === "object" && typeof result.band === "string" && result.band) return result;
    return DEGRADED_COMPLEXITY;
  } catch {
    return DEGRADED_COMPLEXITY;
  }
}

const SPECIALIST_TOPICS = new Set(["science", "business", "empathetic", "literary", "creative", "theological"]);

/**
 * Pick a route for one user message. Lane E's complexity band and this lane's subject-matter read
 * combine in a fixed priority order, cheapest-signal-wins-only-when-nothing-else-fires:
 *   1. Safety and websearch are content-triggered overrides — they fire on ANY match, regardless
 *      of complexity, because a crisis message or a live-data question is defined by its content,
 *      not by how many words it took to ask.
 *   2. A specialist topic (business/science/empathetic/literary/creative/theological) wins next,
 *      at ANY complexity band. "I'm feeling overwhelmed about my job" scores as low-complexity
 *      text (short, no multi-step ask) but is exactly the message the empathetic seat exists for;
 *      subject matter, not word count, decides it. This is Lane I's whole job per the contract:
 *      "E judges complexity. You judge subject matter and pick the seat."
 *   3. With no topic match, `band === "trivial"` (measured against sequential.mjs's own scoring:
 *      a short greeting or an arithmetic one-liner scores under 15 with no raiser rules firing)
 *      goes to "quick" — the small, fast, free seat "quick and dirty" was built for.
 *   4. Everything else (simple/moderate/complex/deep, no specialist topic) lands on "chat", the
 *      general seat. A "simple"-banded but genuinely open-ended question (e.g. "walk me through
 *      the tradeoffs of X in detail") is still a real conversation, not a quick lookup.
 */
export function pickRoute(rawText, opts = {}) {
  const text = String(rawText == null ? "" : rawText);
  const ask = askSliceOf(text);   // NEVER the raw message into the classifier (lane-e-sequential.md).
  const complexity = safeClassifyComplexity(ask, opts.env);
  const topic = classifyTopic(text) || classifyTopic(ask);

  if (topic === "safety") return { route: "safety", topic, complexity };
  if (topic === "websearch") return { route: "websearch", topic, complexity };
  if (SPECIALIST_TOPICS.has(topic)) return { route: topic, topic, complexity };
  if (complexity.band === "trivial") return { route: "quick", topic: topic || "", complexity };
  return { route: "chat", topic: topic || "", complexity };
}

// ---- 4. PROVIDER TRANSPORT (see the file-header note: a documented, necessary duplication) ------

const OPENROUTER_FALLBACK_PROVIDERS = new Set(["moonshot", "nvidia", "google"]);

export function keysFromEnv(env = process.env) {
  return {
    anthropic: env.ANTHROPIC_API_KEY || env.CLAUDE_ANTHROPIC_KEY || "",
    openrouter: env.OPENROUTER_API_KEY || "",
    openrouterUrl: env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions",
    openrouterReferer: env.OPENROUTER_REFERER || env.PUBLIC_URL || "https://dominion.ai",
    nvidia: env.NVIDIA_API_KEY || env.NVIDIA_KEY || "",
    nvidiaUrl: env.NVIDIA_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
    deepseek: env.DEEPSEEK_AI_DOMINION_UI_APIKEY || env.DEEPSEEK_API_KEY || "",
    deepseekUrl: env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions",
    serp: env.SERP_API_KEY || "",
  };
}

function resolveTransport(modelId, keys) {
  const rec = modelById(modelId);
  const provider = (rec && rec.provider) || "openrouter";
  const directId = (rec && rec.directId) || modelId;
  if (provider === "anthropic") return { transport: "anthropic", apiKey: keys.anthropic, directId };
  // Same key-absent-falls-back-to-OpenRouter rule as server.mjs's resolveProviderCfg: a model may
  // prefer a direct provider, but an unkeyed box still answers via OpenRouter under the catalog id.
  if (provider !== "openrouter" && OPENROUTER_FALLBACK_PROVIDERS.has(provider) && !keys[provider]) {
    return {
      transport: "openai", apiKey: keys.openrouter, baseUrl: keys.openrouterUrl, directId: (rec && rec.id) || modelId,
      extraHeaders: { "http-referer": keys.openrouterReferer, "x-title": "Dominion AI Simplify" }, fellBackToOpenRouter: true,
    };
  }
  if (provider === "nvidia") return { transport: "openai", apiKey: keys.nvidia, baseUrl: keys.nvidiaUrl, directId, extraHeaders: {} };
  if (provider === "deepseek") return { transport: "openai", apiKey: keys.deepseek, baseUrl: keys.deepseekUrl, directId, extraHeaders: {} };
  return {
    transport: "openai", apiKey: keys.openrouter, baseUrl: keys.openrouterUrl, directId,
    extraHeaders: { "http-referer": keys.openrouterReferer, "x-title": "Dominion AI Simplify" },
  };
}

/** Minimal OpenAI-compatible streaming chat completion (OpenRouter, NVIDIA, DeepSeek). */
async function openAiCompatStream({ baseUrl, apiKey, directId, messages, maxOut, extraHeaders, signal, onDelta }) {
  if (!apiKey) return { ok: false, content: "", error: "No API key configured for this model's provider." };
  let res;
  try {
    res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(extraHeaders || {}) },
      body: JSON.stringify({ model: directId, messages, max_tokens: maxOut, stream: true }),
      signal,
    });
  } catch (e) {
    return { ok: false, content: "", error: `Couldn't reach the model provider: ${(e && e.message) || e}` };
  }
  if (!res.ok || !res.body) {
    let text = "";
    try { text = await res.text(); } catch {}
    return { ok: false, content: "", error: `Provider returned HTTP ${res.status}: ${String(text).slice(0, 200)}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "";
  for (;;) {
    let step;
    try { step = await reader.read(); } catch (e) { return { ok: content.length > 0, content, error: content ? "" : String((e && e.message) || e) }; }
    if (step.done) break;
    buf += decoder.decode(step.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const m = /^data:\s?(.*)$/.exec(line.trim());
        if (!m) continue;
        const data = m[1];
        if (!data || data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        const delta = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (typeof delta === "string" && delta) { content += delta; if (onDelta) onDelta(delta); }
      }
    }
  }
  return { ok: true, content };
}

// ---- 5. THE CHAT HANDLER ------------------------------------------------------------------------

const SYSTEM_PROMPT = "You are Dominion, answering in Simplify mode: a plain chat and search surface "
  + "for someone who wants a straight answer, not a tool. Keep replies direct and easy to read. Never "
  + "mention which model is answering, and never offer settings, modes, or model choices; this surface "
  + "has none.";

async function buildMessages({ history, userMessage, searchContext }) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (searchContext) {
    messages.push({
      role: "system",
      content: "Live web search results for the user's question:\n\n" + searchContext
        + "\n\nUse these if they are relevant. Name the source when you rely on one. If they are not "
        + "relevant, answer from what you already know.",
    });
  }
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || typeof h.content !== "string") continue;
    if (h.role !== "user" && h.role !== "assistant") continue;
    messages.push({ role: h.role, content: h.content.slice(0, 8000) });
  }
  messages.push({ role: "user", content: userMessage });
  return messages;
}

/**
 * Read a request body, capped so a hostile client cannot stream unbounded data at this route
 * (same discipline as server.mjs's readRawBody for /chat, reimplemented here for the same reason
 * transport is: nothing to import).
 */
function readCappedBody(req, capBytes) {
  return new Promise((resolve, reject) => {
    let buf = "", total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > capBytes) { reject(new Error("request too large")); try { req.destroy(); } catch {} return; }
      buf += chunk;
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

/**
 * Build the Simplify chat route handler. `env` defaults to process.env; pass an explicit one in
 * tests. Returns `async (req, res) => void`, meant to be mounted by server.mjs's route table per
 * docs/wiring/lane-i-simplify.md — including THAT file's identity/billing gate, which this handler
 * does not repeat (it assumes the caller already decided this request is allowed to chat).
 */
export function createSimplifyChatHandler({ env = process.env } = {}) {
  const keys = keysFromEnv(env);
  /*
   * onTurnBilled is passed PER REQUEST, never at construction. The caller closes over the tenant
   * for this one request, so two people using Simplify at once can never bill each other. See the
   * simplifyBilling note in server.mjs for the race this shape exists to prevent.
   */
  /*
   * `tasks` (the task kernel) and `tenant` arrive per request for the same reason onTurnBilled
   * does: they describe THIS caller. Both are optional, and with them absent the handler behaves
   * exactly as it did before the kernel existed, which is what keeps the older unit tests honest.
   */
  return async function handleSimplifyChat(req, res, { onTurnBilled = null, tasks = null, tenant = null } = {}) {
    let raw;
    try {
      raw = await readCappedBody(req, 262144);
    } catch {
      try { res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"request too large"}'); } catch {}
      return;
    }
    let input;
    try { input = JSON.parse(raw || "{}"); } catch {
      try { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad json"}'); } catch {}
      return;
    }
    const userMessage = String(input.message || "").trim();
    if (!userMessage) {
      try { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"empty message"}'); } catch {}
      return;
    }
    const history = Array.isArray(input.history) ? input.history.slice(-20) : [];

    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no",
    });

    /*
     * DURABILITY (Fred's concurrent-work spec, 2026-08-08).
     *
     * This handler used to wire req.on("close") straight into ac.abort(). That single line meant
     * closing the Simplify panel, switching to the Crucible, or simply reloading killed the model
     * call and threw away the partial answer, which existed nowhere but the browser's DOM. It also
     * quietly made those turns free: an aborted call lands in the catch below with ok:false, and
     * the billing block at the end only fires on ok, so a user who closed the panel mid-answer
     * burned provider tokens at no charge.
     *
     * A disconnect now means nothing at all. The turn runs to completion, every frame is recorded
     * to the task kernel as it streams, and the client reattaches by task id to collect whatever it
     * missed. Only an explicit stop aborts, exactly as /chat has worked since the 18-hour-run work.
     *
     * Wire shape stays {type:"delta", text}. The kernel stores {type:"token", delta} so its
     * coalescing collapses token runs into single rows, and the attach route translates back on
     * replay, so the client only ever sees one vocabulary.
     */
    const task = tasks && tenant
      ? tasks.createTask({
          id: "sx-" + randomUUID(), kind: "simplify", surface: "simplify",
          anchor: String(input.sessionId || "").slice(0, 120),
          title: userMessage.slice(0, 80), email: tenant.email || "", uid: tenant.uid || "",
          status: "running",
        })
      : null;
    let seq = 0, chars = 0;
    const record = (ev) => {
      if (!task) return;
      try { tasks.appendRows(task.id, [{ seq, span: 1, ev }], seq + 1, chars); seq++; } catch {}
    };
    const sse = (o) => {
      if (task) {
        if (o && o.type === "delta") { chars += String(o.text || "").length; record({ type: "token", delta: o.text || "" }); }
        else if (o && o.type !== "working") record(o);
      }
      try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {}
    };
    const ac = new AbortController();
    if (task) {
      // The one thing that DOES abort: a deliberate stop, reached through the kernel by task id.
      tasks.bindMeta(task.id, { title: userMessage.slice(0, 80) });
      sse({ type: "task", id: task.id, surface: "simplify" });
    }

    let picked;
    try { picked = pickRoute(userMessage, { env }); } catch { picked = { route: "chat", topic: "", complexity: DEGRADED_COMPLEXITY }; }
    const resolved = resolveRouteModel(picked.route);
    // Diagnostic frame only — dominion-simplify.js never renders a model name or route to the user.
    sse({ type: "route", route: picked.route, blocked: resolved.blocked || false });

    let searchContext = "";
    if (picked.route === "websearch") {
      if (!keys.serp) {
        sse({ type: "notice", text: "Web search isn't configured on this server right now. Answering from what the model already knows." });
      } else {
        try {
          const r = await runTool("web_search", { query: userMessage, num: 6 }, { serpKey: keys.serp }, ac.signal);
          searchContext = String(r || "").slice(0, 6000);
        } catch {
          sse({ type: "notice", text: "Web search failed just now. Answering from what the model already knows." });
        }
      }
    }

    const messages = await buildMessages({ history, userMessage, searchContext });
    const maxOut = outLimitFor(resolved.modelId, "normal");
    const transport = resolveTransport(resolved.modelId, keys);

    let result;
    try {
      if (transport.transport === "anthropic") {
        result = await anthropicMessagesStream(transport.directId, messages, {
          apiKey: transport.apiKey, maxTokens: maxOut, signal: ac.signal,
        }, (delta) => sse({ type: "delta", text: delta }));
      } else {
        result = await openAiCompatStream({
          baseUrl: transport.baseUrl, apiKey: transport.apiKey, directId: transport.directId,
          messages, maxOut, extraHeaders: transport.extraHeaders, signal: ac.signal,
          onDelta: (delta) => sse({ type: "delta", text: delta }),
        });
      }
    } catch (e) {
      result = { ok: false, content: "", error: String((e && e.message) || e) };
    }

    if (!result || !result.ok) {
      sse({ type: "error", message: (result && result.error) || "The model didn't answer that time. Try again." });
    }

    /*
     * PAY FOR WHAT YOU USE, WITH NO CAP (Fred, 2026-08-03).
     *
     * This surface shipped UNMETERED. It had no meterTurn, no cost calculation and no credit
     * deduction anywhere, while the route gate checked that a guest HAS credits and then never
     * spent any. Several Simplify routes are free provider lanes, but chat and websearch both land
     * on Claude Haiku, which Dominion pays for on every turn. So every one of those turns was
     * served free, and the leak was invisible because the gate LOOKED like billing.
     *
     * Metering happens through a callback the server supplies rather than here, because billing
     * belongs in server.mjs next to meterTurn and the ledger. A second copy of the cost math living
     * in this file is a copy that drifts.
     *
     * A FAILED TURN IS NOT CHARGED. `result.ok` false means the provider never answered, and
     * charging for silence is the surprise this app refuses. Usage is passed through exactly as the
     * provider reported it, so a turn with no usage row bills nothing rather than bills a guess.
     */
    if (result && result.ok && typeof onTurnBilled === "function") {
      try {
        await onTurnBilled({
          modelId: resolved.modelId,
          usage: result.usage || null,
          question: userMessage,
          answer: result.content || "",
        });
      } catch (e) {
        // Metering must never take the user's answer down with it. They already have their reply.
        console.warn("[simplify] metering failed: " + ((e && e.message) || e));
      }
    }

    sse({ type: "done" });
    /*
     * The task closes AFTER billing, so a crash between the two leaves the row `running` and the
     * boot sweep seals it orphaned rather than reporting a clean finish for a turn nobody charged.
     * An honest orphan is recoverable. A false `done` is not.
     */
    if (task) {
      try {
        tasks.finish(task.id, result && result.ok ? "done" : "failed",
                     result && result.ok ? null : { error: (result && result.error) || "no answer" });
      } catch {}
    }
    try { res.end(); } catch {}
  };
}
