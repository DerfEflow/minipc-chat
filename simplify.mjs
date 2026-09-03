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
 * LADDER REWRITE (STABILIZE Step 1, 2026-09-03, docs/STABILIZE-2026-09-03-DEFICIENCIES.md #1-#3).
 * Every route used to name exactly ONE model. NVIDIA quietly retired three of those models between
 * 2026-08-21 and 2026-08-26 (HTTP 410 "end of life"), and this surface had no way to notice: four
 * probe prompts on the rig all returned `{"type":"error","message":"Provider returned HTTP 410..."}`
 * with the raw provider string shown to the user — a dead surface for two weeks running. The owner's
 * standing order ("nothing may fail to produce a viable result") means a single named model is never
 * again the whole plan. Every route below is now a LADDER of at least three model ids
 * (SIMPLIFY_ROUTES[route].ladder); resolveLadder() drops any rung that is not a live catalog id or
 * that the hourly catalog audit (catalogaudit.mjs, via models.catalog.mjs's isSeatUnavailable) has
 * already proven dead, and runLadder() tries what is left in order, moving to the next rung on ANY
 * provider failure (4xx/5xx/network/timeout/empty), with a first-token timeout per rung (20s; 12s for
 * a gx10 rung, since server.mjs's own gx10 doctrine treats it as the fast/local case) and a 120s
 * total wall-clock budget for the whole ladder. A `served` event names which rung actually answered
 * — provenance as ordinary metadata, never as an error, per the owner's directive — and the `error`
 * event fires only once EVERY rung of TWO full ladder passes (a 3s pause, then one retry of the
 * whole ladder) has failed.
 *
 * PROVIDER TRANSPORT — an honest limitation, read before changing this file: server.mjs's
 * PROVIDER_CFG / resolveProviderCfg (the real, already-built provider dispatch) are module-private
 * consts with no export, and this lane is barred from editing server.mjs's main chat pipeline.
 * `resolveTransport` below MIRRORS that documented behavior (same env var names, same default URLs,
 * same OpenRouter-fallback provider set) rather than importing it, because there is nothing to
 * import. [verified against server.mjs source, PROVIDER_CFG region, read-only, 2026-09-03]. The one
 * provider this duplicate cannot fully reach is gx10's HANDS-RELAY wire (server.mjs's
 * gx10HandsChatStream, which lives deep in the hands-hub machinery this lane does not own): a gx10
 * rung answers when GX10_LLM_URL (the direct wire) is configured, and is skipped — correctly, as any
 * unreachable rung is — when it is not. If server.mjs ever exports resolveProviderCfg or a gx10
 * relay helper, the duplicated pieces below should be deleted in favor of the real ones.
 */

import { modelById, resolveModelId, isCatalogModel, outLimitFor, isSeatUnavailable } from "./models.catalog.mjs";
import { askSliceOf } from "./routing.mjs";
import { runTool } from "./tools.mjs";
import { anthropicMessagesStream } from "./anthropicmessages.mjs";
import { classifyComplexity, SEQUENTIAL_THRESHOLD_DEFAULT } from "./sequential.mjs";

// ---- 1. THE ROUTING TABLE (docs/SIMPLIFY-ROUTING-TABLE.md section 3, ladder rewrite) -----------

/*
 * Every ladder is Fred's named pick for the route first, then two measured, live-verified
 * alternates in priority order (see docs/SIMPLIFY-ROUTING-TABLE.md and this STABILIZE pass's rig
 * proof for what was actually probed). `careFirst: true` on safety swaps the system prompt for
 * every rung of that route (see CARE_FIRST_SYSTEM_PROMPT below) — a crisis message deserves the
 * same careful framing regardless of which rung in the ladder ends up answering it, not just the
 * first one. `tool: "web_search"` on websearch is unchanged from before the rewrite: search is a
 * TOOL this route turns on, not a model choice, and it is fetched once per turn (see
 * buildRungSpecs below for exactly how a failed or unconfigured search degrades honestly).
 */
export const SIMPLIFY_ROUTES = Object.freeze({
  chat: Object.freeze({
    label: "Chat",
    ladder: Object.freeze(["anthropic/claude-haiku-4-5", "deepseek/deepseek-v4-flash", "gx10/gpt-oss-120b"]),
  }),
  science: Object.freeze({
    label: "Science and math",
    ladder: Object.freeze(["deepseek/deepseek-r1", "deepseek/deepseek-v4-pro", "nvidia/nemotron-3-super-120b-a12b:free"]),
  }),
  quick: Object.freeze({
    label: "Quick and dirty",
    ladder: Object.freeze(["gx10/gpt-oss-120b", "deepseek/deepseek-v4-flash", "anthropic/claude-haiku-4-5"]),
  }),
  business: Object.freeze({
    label: "Business",
    ladder: Object.freeze(["deepseek/deepseek-v4-pro", "nvidia/nemotron-3-super-120b-a12b:free", "anthropic/claude-haiku-4-5"]),
  }),
  safety: Object.freeze({
    label: "Safety",
    ladder: Object.freeze(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-flash"]),
    careFirst: true,
    note: "The content-safety classifier (nvidia/nemotron-3.5-content-safety) is a moderation model, "
      + "not an answerer — measured 2026-09-03: it replies to an ordinary chat turn with 'Conversation "
      + "roles must alternate user/assistant/...'. This route never calls it; it answers on the same "
      + "seats every other route trusts, with a system prompt that asks for care rather than a clinical "
      + "tone.",
  }),
  empathetic: Object.freeze({
    label: "Empathetic",
    ladder: Object.freeze(["anthropic/claude-haiku-4-5", "nvidia/llama-3.1-nemotron-70b-instruct", "deepseek/deepseek-v4-flash"]),
  }),
  literary: Object.freeze({
    label: "Literary",
    ladder: Object.freeze(["arcee-ai/trinity-large-thinking", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-pro"]),
  }),
  creative: Object.freeze({
    label: "Creative",
    // Shares literary's ladder (routing doc ledger item S1, still open, needs Fred): Palmyra and
    // Llama 3.1 405B (Fred's original picks for these two routes) are both unreachable on this
    // account, and inventing a distinction the roster cannot serve was rejected in the original
    // build. Unchanged by this rewrite; revisit together if Fred ever wants them split.
    ladder: Object.freeze(["arcee-ai/trinity-large-thinking", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-pro"]),
  }),
  theological: Object.freeze({
    label: "Theological and philosophical",
    ladder: Object.freeze(["nvidia/nemotron-3-super-120b-a12b:free", "deepseek/deepseek-v4-pro", "anthropic/claude-haiku-4-5"]),
  }),
  websearch: Object.freeze({
    label: "Web search",
    ladder: Object.freeze(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5"]),
    tool: "web_search",
  }),
});

/*
 * Resolve one route's ladder to the model ids actually worth trying right now: a live catalog hit
 * (via resolveModelId, same "removed id -> its survivor, unknown -> drop" rule the rest of this app
 * uses) that the live catalog audit has not already proven dead (isSeatUnavailable, fed by
 * catalogaudit.mjs's hourly run). Dropping a known-dead rung here means the ladder never spends a
 * live attempt finding out something the audit already knows — the request-time skip in runLadder
 * below is for failures the audit HASN'T seen yet (a brand-new 410, a timeout), not a second chance
 * for one it has.
 */
export function resolveLadder(routeKey) {
  const route = SIMPLIFY_ROUTES[routeKey];
  if (!route) return { routeKey, ok: false, rungs: [], dropped: [], error: `Unknown route "${routeKey}".` };
  const rungs = [];
  const dropped = [];
  for (const requested of route.ladder) {
    const resolved = resolveModelId(requested);
    if (resolved && isCatalogModel(resolved) && !isSeatUnavailable(resolved)) {
      rungs.push(resolved);
    } else {
      dropped.push({
        requested, resolved: resolved || "",
        reason: !resolved || !isCatalogModel(resolved) ? "not a live catalog id" : "marked unavailable by the live catalog audit",
      });
    }
  }
  return { routeKey, ok: true, rungs, dropped };
}

// ---- 2. SUBJECT-MATTER CLASSIFICATION (Lane I's own job) ----------------------------------------
// Keyword heuristics, deliberately shallow and readable: this app has already paid once for a
// keyword classifier promoted past what it can carry (routing.mjs's own NO_RETRIEVAL_RE comment).
// This never gates a refusal or a pause — worst case it picks the general "chat" seat, which is
// itself a competent generalist.
//
// WIDENED 2026-09-03 (STABILIZE Step 1, deficiency #3): "three unrelated question types were all
// classified quick" because these patterns only caught NARROW phrasing ("biology problem", not
// "photosynthesis"; nothing at all for "LLC" or "S-corp"). A short factual question with no topic
// match still correctly lands on "quick" (see pickRoute's priority order below) — that path is
// working as designed. The bug was specialist SUBJECT MATTER falling through to it for lack of a
// keyword, which is what the additions below close: every addition is a plain subject-matter noun
// or phrase, not a complexity signal (complexity stays Lane E's job, never duplicated here).

const TOPIC_PATTERNS = Object.freeze([
  // Safety checked FIRST and unconditionally: a crisis message must never be filed under "quick"
  // just because it is short.
  ["safety", /\b(kill myself|suicid\w*|self[- ]?harm|hurt(ing)? myself|want(ed)? to die|end(ing)? my life|cutting myself|overdose|no reason to live)\b/i],
  ["websearch", /\b(latest|breaking news|right now|as of today|current price|stock price|today'?s (date|news|weather)|this week'?s|who won|score of the|weather (in|today|tomorrow|this week)|search for|look up)\b/i],
  ["science", /\b(equation|derivative|integral|theorem|hypothesis|algorithm complexity|physics|chemistry|biology|photosynthes\w*|molecul\w*|velocity|acceleration|standard deviation|calculat\w*|solve for [a-z]|prove that|medicine|medical (basics|condition|diagnos\w*)|anatomy|genetics?|dna\b|ecosystem|organism|periodic table|newton'?s (law|laws)|gravity|thermodynamics|atom(ic)?|cell (division|biology)|evolution\w*)\b/i],
  ["business", /\b(business plan|marketing plan|revenue|pricing strategy|startup idea|invoice|negotiat\w*|market analysis|budget forecast|sales pitch|swot analysis|profit margin|cash flow|business proposal|\bllc\b|s[- ]?corp(oration)?|c[- ]?corp\b|sole proprietor\w*|business entity|incorporat\w*|payroll|hir(e|ing) (an? )?(employee|staff|contractor)|marketing (idea|strategy|campaign)|small business)\b/i],
  ["empathetic", /\b(i feel|i'?m feeling|i'?ve been feeling|feeling (?:so |really |quite )?(?:sad|stressed|anxious|overwhelmed|lonely|hurt|struggling|depressed)|i'?m (so |really |quite )?(sad|stressed|anxious|lonely|overwhelmed|struggling|hurting|depressed)|breakup|broke up with|relationship advice|grief|grieving|i don'?t know what to do about my|giving up on|ready to give up|thinking about giving up)\b/i],
  // TODO(fred): "write me a poem" matches; "write me a SHORT poem" or "write me a TWO LINE poem"
  // does not (the adjective sits between "a" and the noun) and falls through to quick instead —
  // measured live 2026-09-03 via rig probe, not fixed this pass since widening this without a wider
  // prompt sample risks new false positives more than the undershoot is worth guessing at.
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
 *      goes to "quick" — the small, fast, free seat "quick and dirty" was built for. A short
 *      DEFINITIONAL question with no specialist subject (e.g. "what is a roofing contractor")
 *      belongs here too, by design (spec: "quick = short factual or definitional questions only").
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
    anthropicUrl: env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages",
    openrouter: env.OPENROUTER_API_KEY || "",
    openrouterUrl: env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions",
    openrouterReferer: env.OPENROUTER_REFERER || env.PUBLIC_URL || "https://dominion.ai",
    nvidia: env.NVIDIA_API_KEY || env.NVIDIA_KEY || "",
    nvidiaUrl: env.NVIDIA_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
    deepseek: env.DEEPSEEK_AI_DOMINION_UI_APIKEY || env.DEEPSEEK_API_KEY || "",
    deepseekUrl: env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions",
    serp: env.SERP_API_KEY || "",
    // GX10 direct wire only (see file header): the relay-only path needs the hands hub this lane
    // does not own, so a rung with no direct URL is left to fail fast and get skipped.
    gx10Url: env.GX10_LLM_URL || "",
    gx10Key: env.GX10_LLM_KEY || "",
  };
}

function resolveTransport(modelId, keys) {
  const rec = modelById(modelId);
  const provider = (rec && rec.provider) || "openrouter";
  const directId = (rec && rec.directId) || modelId;
  if (provider === "anthropic") return { transport: "anthropic", apiKey: keys.anthropic, baseUrl: keys.anthropicUrl, directId, provider };
  if (provider === "gx10") {
    if (!keys.gx10Url) {
      return {
        transport: "openai", apiKey: "", baseUrl: "", directId, provider, extraHeaders: {},
        unavailable: true,
        unavailableReason: "GX10_LLM_URL is not configured on this server (Simplify's isolated transport only reaches the direct wire, not the hands relay)",
      };
    }
    // Ollama's OpenAI-compatible lane does not check the bearer; a placeholder keeps the shared
    // "no key configured" gate below from refusing a call that genuinely needs no secret.
    return { transport: "openai", apiKey: keys.gx10Key || "gx10-local", baseUrl: keys.gx10Url, directId, provider, extraHeaders: {} };
  }
  // Same key-absent-falls-back-to-OpenRouter rule as server.mjs's resolveProviderCfg: a model may
  // prefer a direct provider, but an unkeyed box still answers via OpenRouter under the catalog id.
  if (provider !== "openrouter" && OPENROUTER_FALLBACK_PROVIDERS.has(provider) && !keys[provider]) {
    return {
      transport: "openai", apiKey: keys.openrouter, baseUrl: keys.openrouterUrl, directId: (rec && rec.id) || modelId, provider: "openrouter",
      extraHeaders: { "http-referer": keys.openrouterReferer, "x-title": "Dominion AI Simplify" }, fellBackToOpenRouter: true,
    };
  }
  if (provider === "nvidia") return { transport: "openai", apiKey: keys.nvidia, baseUrl: keys.nvidiaUrl, directId, provider, extraHeaders: {} };
  if (provider === "deepseek") return { transport: "openai", apiKey: keys.deepseek, baseUrl: keys.deepseekUrl, directId, provider, extraHeaders: {} };
  return {
    transport: "openai", apiKey: keys.openrouter, baseUrl: keys.openrouterUrl, directId, provider: "openrouter",
    extraHeaders: { "http-referer": keys.openrouterReferer, "x-title": "Dominion AI Simplify" },
  };
}

/** Minimal OpenAI-compatible streaming chat completion (OpenRouter, NVIDIA, DeepSeek, GX10 direct). */
async function openAiCompatStream({ baseUrl, apiKey, directId, messages, maxOut, extraHeaders, signal, onDelta }) {
  if (!apiKey) return { ok: false, content: "", error: "No API key configured for this model's provider." };
  if (!baseUrl) return { ok: false, content: "", error: "No endpoint configured for this model's provider." };
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

// ---- 5. THE LADDER RUNNER ------------------------------------------------------------------------

// First-token timeout: how long a rung gets to produce its FIRST piece of content before it is
// abandoned for the next rung. gx10 gets a shorter budget because server.mjs's own gx10 doctrine
// (gx10.mjs, PROVIDER_CFG) treats it as the fast local case — a cold-load stall there is a signal
// to move on quickly, not wait as long as a paid cloud round-trip deserves.
const FIRST_TOKEN_TIMEOUT_MS = 20000;
const GX10_FIRST_TOKEN_TIMEOUT_MS = 12000;
// Whole-ladder wall-clock budget for ONE pass (required behavior #1). Once a rung streams its
// first token it is allowed to keep going past its own first-token timeout, but never past this
// shared deadline — one slow rung cannot eat every other rung's share of the turn.
const LADDER_TOTAL_BUDGET_MS = 120000;
// After a full ladder pass fails end to end, wait this long and try the WHOLE ladder once more
// before finally telling the user nothing came back (required behavior #1: "even then wait 3s and
// retry the ladder once before giving up").
const LADDER_RETRY_DELAY_MS = 3000;

/**
 * Run one rung: a model call with a first-token abort timer and a hard stop at the ladder's shared
 * deadline. Returns the same {ok, content, error, usage?} shape callSeat-style transports use.
 * Partial content already streamed to the user on a mid-stream failure is treated as a completed
 * answer, not a failure to retry — openAiCompatStream's own read-loop already does this
 * (`ok: content.length > 0` on a read error), which is exactly the discipline this app's BATTALION
 * failover tests pin elsewhere: a partially streamed answer is never re-posted from another seat,
 * or the user reads two answers stacked on top of each other.
 */
async function attemptRung({ transport, messages, maxOut, parentSignal, firstTokenTimeoutMs, deadlineAt, onDelta }) {
  if (transport.unavailable) return { ok: false, content: "", error: transport.unavailableReason || "this rung is not configured on this server" };
  const remainingBudget = deadlineAt - Date.now();
  if (remainingBudget <= 0) return { ok: false, content: "", error: "ladder time budget exhausted" };

  const rungAc = new AbortController();
  const onParentAbort = () => { try { rungAc.abort(); } catch {} };
  if (parentSignal) {
    if (parentSignal.aborted) rungAc.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let gotFirstToken = false;
  const effectiveFirstTokenMs = Math.max(0, Math.min(firstTokenTimeoutMs, remainingBudget));
  const firstTokenTimer = setTimeout(() => { if (!gotFirstToken) { try { rungAc.abort(); } catch {} } }, effectiveFirstTokenMs);
  // The hard ladder-deadline stop. Cleared alongside firstTokenTimer; harmless to fire after the
  // rung already finished (abort on a settled controller is a no-op).
  const deadlineTimer = setTimeout(() => { try { rungAc.abort(); } catch {} }, remainingBudget);
  const wrappedOnDelta = (text) => {
    if (!gotFirstToken) gotFirstToken = true;
    if (onDelta) onDelta(text);
  };

  let result;
  try {
    if (transport.transport === "anthropic") {
      if (!transport.apiKey) {
        result = { ok: false, content: "", error: "No API key configured for this model's provider." };
      } else {
        result = await anthropicMessagesStream(transport.directId, messages, {
          apiKey: transport.apiKey, endpoint: transport.baseUrl, maxTokens: maxOut, signal: rungAc.signal,
        }, wrappedOnDelta);
      }
    } else {
      result = await openAiCompatStream({
        baseUrl: transport.baseUrl, apiKey: transport.apiKey, directId: transport.directId,
        messages, maxOut, extraHeaders: transport.extraHeaders, signal: rungAc.signal, onDelta: wrappedOnDelta,
      });
    }
  } catch (e) {
    result = { ok: false, content: "", error: String((e && e.message) || e) };
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(deadlineTimer);
    if (parentSignal) { try { parentSignal.removeEventListener("abort", onParentAbort); } catch {} }
  }

  if (!result) return { ok: false, content: "", error: "no response" };
  if (!result.ok || !String(result.content || "").trim()) {
    const reason = (result.error && String(result.error).trim())
      || (!gotFirstToken ? `no response within ${effectiveFirstTokenMs}ms` : "empty response");
    return { ok: false, content: result.content || "", error: reason };
  }
  return result;
}

/**
 * Try each rung spec in order over the SAME base messages, stopping at the first one that produces
 * real content. `systemPromptFor(spec)` lets the caller vary the system prompt per rung (safety's
 * care-first prompt; websearch's per-rung search context or honest no-search disclosure) without
 * this function knowing anything about routes. Returns the winning rung's id/provider/usage/content
 * on success, or the list of every rung's failure reason on total failure.
 */
async function runLadder({ rungSpecs, baseMessages, systemPromptFor, keys, parentSignal, onDelta }) {
  const deadlineAt = Date.now() + LADDER_TOTAL_BUDGET_MS;
  const failures = [];
  for (const spec of rungSpecs) {
    if (parentSignal && parentSignal.aborted) return { ok: false, error: "stopped", failures };
    if (Date.now() >= deadlineAt) { failures.push({ model: spec.modelId, error: "ladder time budget exhausted" }); break; }
    const rec = modelById(spec.modelId);
    if (!rec) { failures.push({ model: spec.modelId, error: "not a catalog model" }); continue; }
    const firstTokenTimeoutMs = rec.provider === "gx10" ? GX10_FIRST_TOKEN_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
    const transport = resolveTransport(spec.modelId, keys);
    const messages = [{ role: "system", content: systemPromptFor(spec) }, ...baseMessages];
    const maxOut = outLimitFor(spec.modelId, "normal");
    const result = await attemptRung({ transport, messages, maxOut, parentSignal, firstTokenTimeoutMs, deadlineAt, onDelta });
    if (result.ok && String(result.content || "").trim()) {
      return { ok: true, modelId: spec.modelId, provider: transport.provider, usage: result.usage || null, content: result.content, failures };
    }
    failures.push({ model: spec.modelId, error: result.error || "no answer" });
  }
  return { ok: false, error: failures.length ? failures[failures.length - 1].error : "no live rungs available", failures };
}

// ---- 6. THE CHAT HANDLER ------------------------------------------------------------------------

const SYSTEM_PROMPT = "You are Dominion, answering in Simplify mode: a plain chat and search surface "
  + "for someone who wants a straight answer, not a tool. Keep replies direct and easy to read. Never "
  + "mention which model is answering, and never offer settings, modes, or model choices; this surface "
  + "has none.";

// Used for every rung of the "safety" route (SIMPLIFY_ROUTES.safety.careFirst). A crisis message is
// defined by the fact that it needs care, not by which model in the ladder happens to answer it.
const CARE_FIRST_SYSTEM_PROMPT = "You are Dominion, answering in Simplify mode. This message may come "
  + "from someone in distress or crisis. Take it seriously, respond with warmth, and do not minimize "
  + "what they said. If there is any sign of risk of self-harm or suicide, gently encourage reaching "
  + "out to a crisis line (in the US: call or text 988) or a trusted person, while staying supportive "
  + "rather than clinical. Keep replies direct and easy to read. Never mention which model is "
  + "answering, and never offer settings, modes, or model choices; this surface has none.";

const WEBSEARCH_CONTEXT_HEADER = "\n\nLive web search results for the user's question:\n\n";
const WEBSEARCH_CONTEXT_FOOTER = "\n\nUse these if they are relevant. Name the source when you rely on "
  + "one. If they are not relevant, answer from what you already know.";
const WEBSEARCH_UNAVAILABLE_NOTE = "\n\nLive web search was not available for this reply. If the "
  + "question depends on current events, prices, or anything that changes over time, say so plainly "
  + "and briefly before answering, then answer as well as you can from what you already know.";

/**
 * Build one rung's system prompt: the route's base prompt (care-first for safety), plus the
 * websearch route's per-rung search behavior. Every other route ignores spec.useSearch/disclose —
 * they are only ever set by buildRungSpecs for the websearch route.
 */
function systemPromptFor(route, spec, searchContext) {
  let prompt = SIMPLIFY_ROUTES[route] && SIMPLIFY_ROUTES[route].careFirst ? CARE_FIRST_SYSTEM_PROMPT : SYSTEM_PROMPT;
  if (spec.useSearch && searchContext) prompt += WEBSEARCH_CONTEXT_HEADER + searchContext + WEBSEARCH_CONTEXT_FOOTER;
  if (spec.disclose) prompt += WEBSEARCH_UNAVAILABLE_NOTE;
  return prompt;
}

/*
 * Turn a resolved rung list into per-rung specs. For every route except websearch this is a
 * pass-through (each rung just names a model). Websearch is the one route whose BEHAVIOR, not just
 * its model, changes per rung (required behavior: "keep haiku + web_search; fallback ... + "
 * "web_search; then answer without search on haiku and say plainly ... that live search was "
 * "unavailable"):
 *   - `searchOk` true (the tool answered something usable): every rung but the LAST carries the
 *     search context; the last rung is the explicit no-search-and-say-so fallback.
 *   - `searchOk` false (no SERP key, or the tool call failed/came back empty): EVERY rung skips
 *     search and discloses it, because we already know before trying a single model that no rung
 *     is going to have live results — no point pretending otherwise on rung 1.
 * Either way the ladder still tries every live model in order; only the search behavior changes.
 */
function buildRungSpecs(route, liveRungs, searchOk) {
  if (route !== "websearch") return liveRungs.map((modelId) => ({ modelId }));
  return liveRungs.map((modelId, i) => {
    const isLast = i === liveRungs.length - 1;
    const useSearch = searchOk && !isLast;
    return { modelId, useSearch, disclose: !useSearch };
  });
}

async function buildBaseMessages({ history, userMessage }) {
  const messages = [];
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

const CALM_FAILURE_MESSAGE = "I couldn't get an answer just now. Please try again in a moment.";

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
  return async function handleSimplifyChat(req, res, { onTurnBilled = null } = {}) {
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
    const sse = (o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {} };
    const ac = new AbortController();
    req.on("close", () => { try { ac.abort(); } catch {} });

    let picked;
    try { picked = pickRoute(userMessage, { env }); } catch { picked = { route: "chat", topic: "", complexity: DEGRADED_COMPLEXITY }; }
    const route = picked.route;
    // Diagnostic frame only — dominion-simplify.js never renders a route or model name to the user.
    sse({ type: "route", route });

    let searchOk = false, searchContext = "";
    if (route === "websearch") {
      if (!keys.serp) {
        sse({ type: "notice", text: "Web search isn't configured on this server right now. Answering from what the model already knows." });
      } else {
        try {
          const r = await runTool("web_search", { query: userMessage, num: 6 }, { serpKey: keys.serp }, ac.signal);
          searchContext = String(r || "").slice(0, 6000);
          searchOk = !!searchContext.trim();
          if (!searchOk) sse({ type: "notice", text: "Web search returned nothing useful just now. Answering from what the model already knows." });
        } catch {
          sse({ type: "notice", text: "Web search failed just now. Answering from what the model already knows." });
        }
      }
    }

    const { rungs: liveRungs } = resolveLadder(route);
    const rungSpecs = buildRungSpecs(route, liveRungs, searchOk);
    const baseMessages = await buildBaseMessages({ history, userMessage });

    const attemptFullLadder = () => runLadder({
      rungSpecs, baseMessages,
      systemPromptFor: (spec) => systemPromptFor(route, spec, searchContext),
      keys, parentSignal: ac.signal,
      onDelta: (text) => sse({ type: "delta", text }),
    });

    let outcome = await attemptFullLadder();
    if (!outcome.ok && !ac.signal.aborted) {
      await new Promise((r) => setTimeout(r, LADDER_RETRY_DELAY_MS));
      if (!ac.signal.aborted) outcome = await attemptFullLadder();
    }

    if (outcome.ok) {
      sse({ type: "served", model: outcome.modelId, provider: outcome.provider, route });
    } else if (!ac.signal.aborted) {
      sse({ type: "error", message: CALM_FAILURE_MESSAGE });
    }

    /*
     * PAY FOR WHAT YOU USE, WITH NO CAP (Fred, 2026-08-03).
     *
     * Metering happens through a callback the server supplies rather than here, because billing
     * belongs in server.mjs next to meterTurn and the ledger. A second copy of the cost math living
     * in this file is a copy that drifts.
     *
     * A FAILED TURN IS NOT CHARGED — unchanged by the ladder rewrite. `outcome.ok` false means
     * every rung in both ladder passes failed to produce content, and charging for silence is the
     * surprise this app refuses. Usage is passed through exactly as the WINNING rung's provider
     * reported it; any rung that failed before the winner never appears in the bill, the same
     * honesty the single-model version had.
     */
    if (outcome.ok && typeof onTurnBilled === "function") {
      try {
        await onTurnBilled({
          modelId: outcome.modelId,
          usage: outcome.usage || null,
          question: userMessage,
          answer: outcome.content || "",
        });
      } catch (e) {
        // Metering must never take the user's answer down with it. They already have their reply.
        console.warn("[simplify] metering failed: " + ((e && e.message) || e));
      }
    }

    sse({ type: "done" });
    try { res.end(); } catch {}
  };
}
