/*
 * Dominion AI: cloud model catalog (single source of truth).
 *
 * Both sides read THIS file:
 *   - server.cloud.mjs builds the OpenRouter allow-list from MODEL_IDS (an id not here can never
 *     be called), and serves the catalog at GET /api/models.
 *   - public/app.js fetches /api/models and renders the big categorized picker.
 *
 * Fred's rules for the picker: group by SPECIALTY category first, then sort MOST params -> LEAST
 * within each category (undisclosed-parameter models sort to the bottom of their group). Every row
 * shows: name · params · $/M in-out · context · specialty.
 *
 * OpenAI GPT is present as a direct provider; Anthropic Claude was ADDED 2026-07-14 as a direct
 * provider for Trusted mode (strictest retention). Google Gemini stays absent (Fred uses it via its
 * own app). Grok (xAI), Perplexity, and the open Gemma/Llama models are fair game.
 *
 * Prices are USD per 1M tokens (input / output) and DRIFT, so re-pull https://openrouter.ai/api/v1/models
 * to refresh. `params` is a display string; `paramsB` is billions for sorting (null = undisclosed).
 * `ctx` is the context window in tokens. Snapshot date below.
 */

export const CATALOG_UPDATED = "2026-07-27";   // provider-native context/output limits and transports audited

// The owner's default engine (Fred, 2026-07-18): DeepSeek V4 Pro: frontier-class 671B MoE, 1M
// context, tool-capable, served direct to DeepSeek. Picked over the old Qwen 235B all-rounder.
export const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

// The default model for EVERYONE ELSE using the interface (non-owner tenants). They can still
// switch to any model their privacy mode allows; this is just what they land on and fall back to.
// Guest default (Fred, 2026-07-17): DeepSeek V4 Flash: tool-capable, 1M context, cheapest strong
// engine, served direct to DeepSeek. (Replaced Hermes 4 70B, whose OpenRouter hosts could not run
// tools; Hermes itself left the catalog entirely in the 2026-08-03 prune.)
export const TENANT_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
// Which default a caller lands on: the owner keeps the global default, everyone else the tenant one.
export const defaultModelFor = (isOwner) => (isOwner ? DEFAULT_MODEL : TENANT_DEFAULT_MODEL);

// Per-CALL output ceiling when a model doesn't set its own maxOut. 8K is a safe chunk for every
// provider; the server auto-continues past it, so this caps a single round, never the whole answer.
export const DEFAULT_MAX_OUT = 8192;

// Category display order (the picker renders groups in THIS order).
export const CATEGORIES = [
  "Frontier / Flagship",
  "Reasoning & Math",
  "Coding",
  "Science & Technical",
  "Creative & Writing",
  "Free-Thinking",
  "Vision / Multimodal",
  "Web / Research",
  "Open & Trainable",
  "Your GX10 (local)",
];

// Per-model routing fields (optional; normalized by finalizeModels below):
//   provider  : "openrouter" (default) | "openai" | "deepseek". Where the call actually goes.
//   directId  : the model id on that provider's NATIVE API (defaults to `id` for openrouter).
//   toolCapable : true = "doing" bench (gets this box's tools); false = "chatting" bench (chat only).
//                 Defaults from category via TOOL_CAPABLE_CATEGORIES; set explicitly to override.
//   maxOut    : per-CALL output-token ceiling for this model (the chunk size, NOT a hard limit on
//               total answer length; server.mjs auto-continues on finish_reason "length" until the
//               whole response is written). Defaults to DEFAULT_MAX_OUT. Set higher for models with a
//               large native output window so long docs finish in fewer round-trips.
//   reasoning : true for chain-of-thought models whose hidden reasoning is billed against the output
//               budget (gpt-5.x, o-series, R1-style). The server keeps maxOut generous for these so
//               reasoning tokens don't starve the visible answer (the GPT-5.x token-starvation lesson).
//   reasoningEffort : when set, sent as reasoning_effort on every non-OpenAI call. Required by models
//               with mandatory reasoning (Kimi K3 only supports "max"). Omit to use provider default.
//   vision    : true = the model accepts image input (image_url parts with base64 data URLs) on its
//               chat endpoint, so the composer's picture attachments may route to it. NEVER guessed:
//               OpenRouter models were verified against live architecture.input_modalities
//               (2026-07-18 pull); direct OpenAI/Anthropic per their documented multimodal support.
//               DeepSeek is false until a live probe proves otherwise (wrong-true throws a guest-facing
//               error; wrong-false costs only an honest refusal). Audited weekly with the tool flags.
// Direct hookups: OpenAI, DeepSeek, and Anthropic go straight to their native APIs, with no
// OpenRouter middleman. Everything else rides OpenRouter.
export const TOOL_CAPABLE_CATEGORIES = new Set([
  "Frontier / Flagship", "Reasoning & Math", "Coding", "Science & Technical",
  "Web / Research", "Vision / Multimodal", "Open & Trainable",
]);

// paramsB: total parameters in billions for sorting (MoE = total, not active). null = undisclosed.
export const MODELS = [
  // ---- Frontier / Flagship ------------------------------------------------------------------
  /*
   * OpenAI GPT-5.6 family: DIRECT to OpenAI (provider:"openai"). Sol=agentic flagship, Terra=mid,
   * Luna=lightest/cheapest (~1M context each).
   *
   * PRICES CUT 2026-07-30, the day OpenAI announced it. Luna fell 80% and Terra 20%. Both new
   * numbers reconcile exactly against the rows they replaced (2.50 -> 2.00 and 15 -> 12 is the
   * announced 20%; 1.00 -> 0.20 and 6.00 -> 1.20 is the announced 80%), which is worth writing
   * down because it cross-checks the announcement against what was already here. Every one of
   * these figures is charged to a customer, so models_pricing_test.mjs pins them: a later edit
   * cannot drift a price without a test saying so out loud.
   *
   * `fastTier` marks where OpenAI's Fast mode is offered (service_tier:"fast", which replaces the
   * old "priority"): up to 2.5x the speed for exactly 2x the price, with no change in intelligence.
   * Only Sol is marked, because Sol is the only model the announcement gives that guarantee for.
   * The multiplier lives beside the price it multiplies so the billing path physically cannot
   * charge standard rates for a call that rode the fast lane.
   */
  /*
   * cacheHitCost on the OpenAI-direct lane (2026-08-03). cacheprobe.mjs measured turn-two cache
   * reads of 4,521/4,535 on Luna and 4,352/4,536 on gpt-4o, so these models ARE returning cached
   * tokens on every multi-round turn. Without the field, catalogCallCost falls back to inCost and
   * bills a discounted token at full freight: on gpt-4o that is roughly $20 per thousand turns
   * charged to customers for tokens OpenAI sold at half price.
   * The gpt-5.6 family and gpt-5.5 use the platform's 1/10 cached-input rate; gpt-4o predates that
   * schedule and is billed at half, which is why its ratio differs from its neighbours.
   */
  { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", origin: "OpenAI (direct)", provider: "openai", directId: "gpt-5.6-sol",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 5.00, outCost: 30.00, cacheHitCost: 0.50, ctx: 1050000, maxOut: 128000, reasoning: true,
    fastTier: true, fastMultiplier: 2,
    specialty: "Best pick for complex coding and multi-step agent work" },
  { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", origin: "OpenAI (direct)", provider: "openai", directId: "gpt-5.6-terra",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 2.00, outCost: 12.00, cacheHitCost: 0.20, ctx: 1050000, maxOut: 128000, reasoning: true,
    specialty: "Strong all-round reasoning for everyday work" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", origin: "OpenAI (direct)", provider: "openai", directId: "gpt-5.6-luna",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 0.20, outCost: 1.20, cacheHitCost: 0.02, ctx: 1050000, maxOut: 128000, reasoning: true,
    specialty: "Fast and cheap for high-volume tasks and automation" },
  { id: "openai/gpt-5.5", name: "GPT-5.5", origin: "OpenAI (direct)", provider: "openai", directId: "gpt-5.5",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 5.00, outCost: 30.00, cacheHitCost: 0.50, ctx: 1050000, maxOut: 32768, reasoning: true,
    specialty: "Reliable choice for heavy knowledge work" },
  { id: "openai/gpt-4o", name: "GPT-4o", origin: "OpenAI (direct)", provider: "openai", directId: "gpt-4o",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 2.50, outCost: 10.00, cacheHitCost: 1.25, ctx: 128000, maxOut: 16384,
    specialty: "Dependable all-purpose assistant that can see images" },
  // Kimi K3 (released 2026-07-15): 2.8T open-weight multimodal reasoner, 1M context. Its reasoning is
  // MANDATORY and the ONLY supported effort is "max", and reasoningEffort below is passed on every call
  // (the "new required language"). Draws reasoning tokens from the output budget, so maxOut is large
  // and the server auto-continues past it.
  // Moonshot DIRECT (Fred, 2026-07-28: active prompt caching on every call). Moonshot's caching
  // is automatic (Mooncake): unchanged prefixes over 256 tokens bill at cacheHitCost, one tenth
  // of fresh input, with no cache ids and no write fee. The provider key is OPTIONAL: while
  // MOONSHOT_API_KEY is absent these ride OpenRouter under the catalog id exactly as before
  // (server resolveProviderCfg). K3's direct id is documented; K2.6's directId and its direct
  // pricing are UNVERIFIED until the key lands — first live call confirms or falls back out loud.
  { id: "moonshotai/kimi-k3", name: "Kimi K3", origin: "Moonshot AI (direct)", provider: "moonshot", directId: "kimi-k3",
    category: "Frontier / Flagship", vision: true, params: "2.8T (open-weight MoE)", paramsB: 2800, inCost: 3.00, outCost: 15.00, cacheHitCost: 0.30, ctx: 1048576,
    maxOut: 32768, reasoning: true, reasoningEffort: "max",
    specialty: "Open-weight powerhouse for complex coding and long projects" },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", origin: "Moonshot AI (direct)", provider: "moonshot", directId: "kimi-k2.6",
    category: "Frontier / Flagship", vision: true, params: "1T (MoE·32B active)", paramsB: 1000, inCost: 0.66, outCost: 3.41, cacheHitCost: 0.066, ctx: 262144, maxOut: 16384,
    specialty: "Built for using tools and getting things done" },
  // Anthropic Claude: DIRECT to the native Messages API for full tool-use, thinking,
  // stop-reason, and usage fidelity. directId = the native Anthropic model id.
  /*
   * Anthropic is the ONE provider that charges to WRITE a cache entry, so it needs two numbers.
   * cacheHitCost is the read rate at 1/10 of input; cacheWriteCost is the 5-minute write at
   * 1.25x. Both ratios are confirmed inside this repo rather than taken on faith: videoSonnetCost
   * in server.mjs bills Sonnet 5 at cacheRead 0.3 and cache5m 3.75 against a 3.00 input, which is
   * exactly 0.1x and 1.25x. A 1-hour write is 2x, and Dominion does not request the 1h TTL.
   *
   * These rates only mean anything because chatToAnthropicPayload now sets a cache_control
   * breakpoint. cacheprobe.mjs measured Haiku caching 6,304 of 6,317 tokens WITH a breakpoint and
   * nothing at all without one, so before that change every Anthropic turn paid full freight.
   */
  { id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", origin: "Anthropic (direct)", provider: "anthropic", directId: "claude-opus-4-8",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 5.00, outCost: 25.00, cacheHitCost: 0.50, cacheWriteCost: 6.25, ctx: 1000000, maxOut: 128000, reasoning: true,
    specialty: "Top-tier reasoning with the strictest privacy" },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", origin: "Anthropic (direct)", provider: "anthropic", directId: "claude-sonnet-5",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 3.00, outCost: 15.00, cacheHitCost: 0.30, cacheWriteCost: 3.75, ctx: 1000000, maxOut: 128000, reasoning: true,
    specialty: "Well-rounded assistant at a fair price" },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", origin: "Anthropic (direct)", provider: "anthropic", directId: "claude-haiku-4-5-20251001",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 1.00, outCost: 5.00, cacheHitCost: 0.10, cacheWriteCost: 1.25, ctx: 200000, maxOut: 64000, reasoning: true,
    specialty: "Fast and cheap for quick back-and-forth" },
  // cacheHitCost: DeepSeek's automatic context caching bills repeated prefixes at ~1/120th of
  // fresh input (verified against published pricing 2026-07-28). The server's cost math applies
  // it only to cache tokens the provider actually counts (prompt_cache_hit_tokens).
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", origin: "DeepSeek (direct)", provider: "deepseek", directId: "deepseek-v4-pro",
    category: "Frontier / Flagship", params: "671B (MoE·37B active)", paramsB: 671, inCost: 0.43, outCost: 0.87, cacheHitCost: 0.003625, ctx: 1000000, maxOut: 384000, reasoning: true,
    specialty: "Near-flagship reasoning and code at a fraction of the price" },
  /*
   * PHASE 1 PRUNE, 2026-08-03 (Fred's order 2026-08-02: all free-thinking models out, OpenRouter
   * down to named survivors). 23 rows removed; the approved cut list and the per-model fallback
   * for saved preferences live in REMOVED_MODEL_FALLBACKS below. Survivors on OpenRouter: Trinity
   * (creative), Qwen3 Coder (kept by Fred with its corrected 262k window), DeepSeek R1 (no direct
   * route exists; Fred: "I dont want to lose it"). Grok was cut by name: "I am going to leave out
   * Grok." MiniMax M2.5 fell to M3 on the free lane; Qwen3 235B's daily-driver job belongs to the
   * defaults now.
   */
  /*
   * GOOGLE AI STUDIO, direct (Fred 2026-08-02: "use Google studio for now"; wired 2026-08-03).
   * The OpenAI-compatible lane was LIVE-VERIFIED before these rows existed: gemini-3.5-flash
   * answered and emitted a real write_note tool call on the exact endpoint in PROVIDER_CFG.
   * Prices: ai.google.dev/gemini-api/docs/pricing, read 2026-08-03; pinned by models_pricing_test.
   * ctx/maxOut: the live /v1beta/models list the same day (1048576 in / 65536 out for all three).
   * Ids are OpenRouter's google/ slugs on purpose: no AI Studio key = the call rides OpenRouter
   * unchanged (resolveProviderCfg fallback), same doctrine as the NVIDIA and Moonshot lanes.
   * Seats follow the curation doctrine: 3.6-flash beat 3.5-flash on BOTH age and output price
   * ($7.50 vs $9.00), so 3.5-flash gets no seat; lite is the budget axis; 3.1-pro is the pro axis.
   * cacheHitCost = the published cached-input rate; the cost math bills it only on cache tokens
   * the provider actually counts. vision/reasoning flags: set from the 2026-08-03 live probe.
   */
  { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash", origin: "Google (AI Studio direct)", provider: "google", directId: "gemini-3.6-flash",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 1.50, outCost: 7.50, cacheHitCost: 0.15, ctx: 1048576, maxOut: 65536, reasoning: true,
    specialty: "Fast Google model with a huge 1M-token memory" },
  // 3.1 Pro doubles its price above 200k input tokens ($4/$18); the catalog's flat cost model
  // carries the base tier, so rare >200k turns under-bill. Known, documented, revisit if long-doc
  // pro work becomes common.
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", origin: "Google (AI Studio direct)", provider: "google", directId: "gemini-3.1-pro-preview",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 2.00, outCost: 12.00, cacheHitCost: 0.20, ctx: 1048576, maxOut: 65536, reasoning: true,
    specialty: "Google's deep-reasoning model for images, video, and long documents" },
  { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", origin: "Google (AI Studio direct)", provider: "google", directId: "gemini-3.5-flash-lite",
    category: "Frontier / Flagship", vision: true, params: "undisclosed", paramsB: null, inCost: 0.30, outCost: 2.50, cacheHitCost: 0.03, ctx: 1048576, maxOut: 65536, reasoning: true,
    specialty: "Cheapest Google model for simple, high-volume tasks" },
  /*
   * z-ai/glm-5.2 REMOVED 2026-09-03 (STABILIZE Step 1, deficiency #2 and #4): NVIDIA retired it
   * 2026-08-21, every call now returns HTTP 410 "has reached its end of life". Confirmed dead
   * again against specs/nvidia_models.txt (2026-09-03 live NVIDIA model list): no glm entry at
   * all. It will never come back on this id; a live replacement would be a new seat, not a
   * resurrection. Every internal reference (UTILITY_MODEL, BATTALION_ROSTER, BATTALION_FAILOVER,
   * WILDFIRE_ROSTER, REMOVED_MODEL_FALLBACKS) was repointed in the same pass — grep the ids below
   * if you're looking for where its jobs went.
   */

  // ---- Reasoning & Math ---------------------------------------------------------------------
  /*
   * R1's numbers were wrong in BOTH directions and every call failed (Fred, 2026-08-09: four runs,
   * four failures). Corrected against OpenRouter's own model record and the errors the wire returned:
   *
   *   maxOut was 16384; the endpoint's max_completion_tokens is 16000. Dominion asked for 384 more
   *   output tokens than the model will ever grant, so a request could be rejected on that alone.
   *
   *   ctx was 163000. OpenRouter advertises 163840, but that is the best case ACROSS the providers
   *   it routes to, not a promise about the one that serves any given call. The provider that took
   *   Fred's turns answered "this endpoint's maximum context length is 64000 tokens". Believing the
   *   headline number is what broke him: the router saw a 163k window, escalated to long_context
   *   ("post-retrieval long-context escalation" on all four runs), packed a prompt to match, and the
   *   real endpoint refused it. The wrong number both TRIGGERED the escalation and then failed it.
   *
   * So ctx is the observed floor, not the advertised ceiling. This trades some headroom when routing
   * lands on a larger provider for turns that actually complete on every provider. Same correction
   * Fred accepted for Qwen3 Coder on 2026-08-03 when its live window came back 262,144 against a
   * catalogued 1,000,000 — the catalog is a promise the router relies on, so it has to be the one
   * number we are sure of.
   */
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", origin: "DeepSeek (China)",
    category: "Reasoning & Math", params: "671B (MoE·37B active)", paramsB: 671, inCost: 0.70, outCost: 2.50, ctx: 64000, maxOut: 16000, reasoning: true,
    specialty: "Shows its reasoning step by step as it thinks" },
  // NVIDIA DIRECT (Fred, 2026-07-28): the build.nvidia.com developer endpoint serves these free
  // (63 free endpoints; Fred: "limits are extremely generous"). While NVIDIA_API_KEY is absent
  // they ride OpenRouter at the prices below; with the key, the server routes direct and bills
  // the call at $0 (transport-aware cost math). directId is the NIM catalog id, UNVERIFIED until
  // the key's first live call; a refused id falls back to OpenRouter out loud.
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", origin: "NVIDIA (direct)", provider: "nvidia", directId: "nvidia/nemotron-3-ultra-550b-a55b",
    category: "Reasoning & Math", params: "550B (MoE·55B active)", paramsB: 550, inCost: 0.42, outCost: 2.61, ctx: 1000000, maxOut: 16384, reasoning: true,
    specialty: "Heavyweight for hard math and science problems" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", origin: "DeepSeek (direct)", provider: "deepseek", directId: "deepseek-v4-flash",
    category: "Reasoning & Math", params: "undisclosed (MoE)", paramsB: null, inCost: 0.05, outCost: 0.24, cacheHitCost: 0.0028, ctx: 1000000, maxOut: 384000, reasoning: true,
    specialty: "Cheapest strong option for reasoning, math, and code" },

  // ---- Coding -------------------------------------------------------------------------------
  /*
   * ctx corrected 1000000 -> 262144 on 2026-08-03, measured against OpenRouter's live model list.
   * Not cosmetic. server.mjs derives contextTokens straight from this figure and the compactor
   * then targets roughly half of it, so the old number handed this model about 512k tokens of
   * history against a real 262k ceiling: a provider-side overflow on long repo work rather than a
   * clean compaction. Overclaiming context is the dangerous direction of drift, which is why
   * catalogaudit now raises it as a problem instead of a note.
   */
  { id: "qwen/qwen3-coder", name: "Qwen3 Coder", origin: "Alibaba",
    category: "Coding", params: "480B (MoE·35B active)", paramsB: 480, inCost: 0.22, outCost: 1.80, ctx: 262144, maxOut: 32768,
    specialty: "Built for coding across a large codebase" },

  // ---- Creative & Writing -------------------------------------------------------------------
  { id: "arcee-ai/trinity-large-thinking", name: "Trinity Large Thinking", origin: "Arcee AI",
    category: "Creative & Writing", params: "undisclosed", paramsB: null, inCost: 0.25, outCost: 0.80, ctx: 262144, toolCapable: true,   // audited: tool endpoints live
    specialty: "A creative-writing specialist for stories and prose" },

  // ---- Vision / Multimodal ------------------------------------------------------------------
  // FREE LANE (Wave 2, live-probed 2026-07-29: answers with tools AND vision on NVIDIA's id).
  { id: "minimax/minimax-m3", name: "MiniMax M3", origin: "MiniMax (Shanghai)", provider: "nvidia", directId: "minimaxai/minimax-m3",
    category: "Vision / Multimodal", vision: true, params: "undisclosed (MoE)", paramsB: null, inCost: 0.10, outCost: 1.21, ctx: 1048576,
    specialty: "Best free option for understanding images and video" },
  /*
   * nvidia/nemotron-nano-12b-v2-vl REMOVED 2026-09-03 (STABILIZE Step 1, deficiency #1/#2/#4):
   * NVIDIA retired it 2026-08-26, every call returns HTTP 410 "has reached its end of life" —
   * this was the Simplify "quick" route's model and the reason that route went dark for two
   * weeks. Confirmed absent from specs/nvidia_models.txt's current live list. It held the only
   * small fast free vision seat; REMOVED_MODEL_FALLBACKS below sends saved picks to the next
   * smallest free vision model (nemotron-3-nano-omni-30b-a3b) instead.
   */

  // ---- Open & Trainable ---------------------------------------------------------------------
  // OLMo 3 32B Think REMOVED 2026-07-30 (listed but unserved: every pick was a dead turn).
  // Gemma 4 31B :free REMOVED 2026-08-03 by the same doctrine: "Provider returned error" on both
  // full roster probes and a 75s timeout on the NVIDIA id. Three strikes across two days is a
  // dead seat, not a bad day. Re-add when the weekly audit sees it answer again.
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super", origin: "NVIDIA (direct)", provider: "nvidia", directId: "nvidia/nemotron-3-super-120b-a12b",
    category: "Open & Trainable", params: "120B (MoE·12B active)", paramsB: 120, inCost: 0, outCost: 0, ctx: 1000000,
    specialty: "The biggest free model here, with a 1M-token memory" },
  /*
   * meta/llama-3.1-70b-instruct REMOVED 2026-09-03 (STABILIZE Step 1, deficiency #1/#2/#4): NVIDIA
   * retired it 2026-08-26 (HTTP 410 "end of life"), confirmed absent from the current
   * specs/nvidia_models.txt live list. It held the Simplify "empathetic" route.
   *
   * REPLACEMENT: nvidia/llama-3.1-nemotron-70b-instruct below. This exact id was probed DEAD
   * (HTTP 404 "Not found for account") on 2026-08-03 per docs/SIMPLIFY-ROUTING-TABLE.md section 1
   * — that earlier probe was for the THEOLOGICAL route, a different NVIDIA endpoint slice, over a
   * month before this pass. It IS present in the current specs/nvidia_models.txt live catalog
   * (2026-09-03), and simplify.mjs's empathetic ladder tries it as rung 2 with two more rungs
   * behind it, so a repeat 404 here degrades to the next rung rather than failing the route — see
   * the rig proof in the STABILIZE report for whether it actually answered this time.
   */
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "Nemotron 70B Instruct", origin: "NVIDIA (direct)", provider: "nvidia", directId: "nvidia/llama-3.1-nemotron-70b-instruct",
    category: "Open & Trainable", params: "70B", paramsB: 70, inCost: 0, outCost: 0, ctx: 131072,
    specialty: "Warm, plain-spoken answers when the question is personal" },
  /*
   * nvidia/nemotron-3.5-content-safety KEPT as a catalog row (still listed on NVIDIA, per
   * specs/nvidia_models.txt) but no longer used as an ANSWERING seat anywhere in this app
   * (STABILIZE Step 1, deficiency #2): it is a moderation classifier, not a chat model, and
   * rejects an ordinary chat turn with "Conversation roles must alternate user/assistant/...".
   * simplify.mjs's safety route now answers on claude-haiku-4-5 with a care-first system prompt.
   * toolCapable:false is unchanged; catalogaudit.mjs's new live chat-probe (added this pass) marks
   * this seat "unavailable" on every run so the general picker hides it too, with its `fallback`
   * field (below) pointing at claude-haiku-4-5 for any code that still resolves it by id.
   */
  { id: "nvidia/nemotron-3.5-content-safety", name: "Nemotron Content Safety", origin: "NVIDIA (direct)", provider: "nvidia", directId: "nvidia/nemotron-3.5-content-safety",
    category: "Open & Trainable", params: "undisclosed", paramsB: null, inCost: 0, outCost: 0, ctx: 131072, toolCapable: false,
    specialty: "Handles sensitive and safety questions carefully" },
  /*
   * THE FREE FLEET (ARSENAL Wave 2, docs/ARSENAL-PROGRAM.md). Every row below was LIVE-PROBED on
   * 2026-07-29 against integrate.api.nvidia.com with the production key: it answered, and the
   * tool flag reflects an actual emitted tool call, never a model card. Selection filter: a free
   * seat joins only by beating or matching an existing seat on some axis. (StepFun step-3.7-flash
   * answered with tools but was EXCLUDED: undisclosed size and unclear specialty bring nothing
   * the seats below lack. gpt-oss-120b timed out on the free tier; re-probe at the weekly audit.)
   */
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", origin: "OpenAI (open weights)", provider: "nvidia", directId: "openai/gpt-oss-20b",
    category: "Open & Trainable", params: "21B (MoE·3.6B active)", paramsB: 21, inCost: 0, outCost: 0, ctx: 131072, reasoning: true,
    specialty: "OpenAI's free open-weight reasoning model" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b", name: "Nemotron 3 Nano Omni", origin: "NVIDIA (direct)", provider: "nvidia", directId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    category: "Vision / Multimodal", vision: true, params: "30B (MoE·3B active)", paramsB: 30, inCost: 0, outCost: 0, ctx: 131072, reasoning: true,
    specialty: "Free reasoning model that can also look at images" },

  // ---- Your GX10 (local) --------------------------------------------------------------------
  /*
   * FRED'S OWN HARDWARE (wired 2026-09-01). These run on the GX10 (DGX Spark) in his house, ride
   * the dominion-hands-gx10 relay (or GX10_LLM_URL when the direct gate hostname exists), cost
   * $0 per token, and never send a byte to a third-party provider — the most private lane in the
   * catalog. Every figure below is MEASURED, not copied from a model card:
   *   - ctx values are `ollama show` context length read off the box 2026-09-01 (gpt-oss 131072,
   *     qwen3-coder 262144 native, seated at 131072 so its KV cache leaves room for the 120B
   *     that stays resident — the gx10 lane passes num_ctx so the box allocates exactly this).
   *   - tools: live-probed on Ollama 0.32's OpenAI lane the same day (streamed tool_calls with a
   *     real function call and usage in the final chunk).
   *   - toolCapable is explicit because the category is deliberately not in
   *     TOOL_CAPABLE_CATEGORIES (a future GX10 seat must prove tools before claiming them).
   * MoE only on this box (273GB/s memory bandwidth rule): dense 70B-class models are banned from
   * these seats, they run at 3-6 tok/s and make the hardware look broken.
   */
  { id: "gx10/gpt-oss-120b", name: "GPT-OSS 120B (GX10)", origin: "Your GX10 (local)", provider: "gx10", directId: "gpt-oss:120b",
    category: "Your GX10 (local)", params: "117B (MoE·5B active)", paramsB: 117, inCost: 0, outCost: 0, ctx: 131072, maxOut: 16384, reasoning: true, toolCapable: true,
    specialty: "The house workhorse: strong reasoning on your own hardware, free" },
  { id: "gx10/qwen3-coder-30b", name: "Qwen3 Coder 30B (GX10)", origin: "Your GX10 (local)", provider: "gx10", directId: "qwen3-coder:30b",
    category: "Your GX10 (local)", params: "30B (MoE·3B active)", paramsB: 30, inCost: 0, outCost: 0, ctx: 131072, maxOut: 16384, toolCapable: true,
    specialty: "Fast local coder for builds, free on your own machine" },
  { id: "gx10/gpt-oss-20b", name: "GPT-OSS 20B (GX10)", origin: "Your GX10 (local)", provider: "gx10", directId: "gpt-oss:20b",
    category: "Your GX10 (local)", params: "21B (MoE·3.6B active)", paramsB: 21, inCost: 0, outCost: 0, ctx: 131072, maxOut: 16384, reasoning: true, toolCapable: true,
    specialty: "Quick local reasoner for small asks and utility work" },
];

/*
 * SAVED-PREFERENCE FALLBACKS for the 2026-08-03 prune (SOW Phase 1: "every saved preference
 * pointing at a removed model must resolve at read time to a surviving model"). Without this, a
 * user whose saved pick was pruned silently drops to auto-routing, which is a silent swap: the
 * exact thing ORCHESTRATOR_FALLBACKS' own comment calls a lie. The server resolves through
 * resolveModelId and TELLS the user which substitution happened.
 * Mapping logic per row: free-thinking picks land on the biggest FREE seat (Fred: "in those
 * instances fall back to a free model"); everything else lands on the surviving seat closest in
 * job, not in size.
 */
export const REMOVED_MODEL_FALLBACKS = {
  // Free-Thinking (Fred's rule: fall back to a free model)
  "nousresearch/hermes-4-405b": "nvidia/nemotron-3-super-120b-a12b:free",
  "nousresearch/hermes-4-70b": "nvidia/nemotron-3-super-120b-a12b:free",
  "microsoft/wizardlm-2-8x22b": "nvidia/nemotron-3-super-120b-a12b:free",
  "thedrummer/cydonia-24b-v4.1": "nvidia/nemotron-3-super-120b-a12b:free",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition": "nvidia/nemotron-3-super-120b-a12b:free",
  // STABILIZE Step 1, 2026-09-03 prune (three confirmed-410 NVIDIA seats removed for good)
  "z-ai/glm-5.2": "nvidia/nemotron-3-super-120b-a12b:free",           // UTILITY_MODEL's new home
  "nvidia/nemotron-nano-12b-v2-vl": "nvidia/nemotron-3-nano-omni-30b-a3b",  // next smallest free vision seat
  "meta/llama-3.1-70b-instruct": "nvidia/llama-3.1-nemotron-70b-instruct", // same job, live NVIDIA id
  // Creative & Writing -> the surviving creative seat
  "anthracite-org/magnum-v4-72b": "arcee-ai/trinity-large-thinking",
  "sao10k/l3.3-euryale-70b": "arcee-ai/trinity-large-thinking",
  "thedrummer/skyfall-36b-v2": "arcee-ai/trinity-large-thinking",
  "thedrummer/rocinante-12b": "arcee-ai/trinity-large-thinking",
  "thedrummer/unslopnemo-12b": "arcee-ai/trinity-large-thinking",
  "tencent/hy3-preview": "arcee-ai/trinity-large-thinking",
  // Frontier
  "x-ai/grok-4.20": "google/gemini-3.1-pro-preview",       // big-window frontier pick
  "minimax/minimax-m2.5": "minimax/minimax-m3",            // same family, free lane
  "qwen/qwen3-235b-a22b-2507": "deepseek/deepseek-v4-flash", // the daily-driver job
  // Coding / Reasoning / Science / Vision / Web / Open
  "mistralai/codestral-2508": "qwen/qwen3-coder",
  "qwen/qwen3-8b": "deepseek/deepseek-v4-flash",
  "mistralai/mistral-small-24b-instruct-2501": "deepseek/deepseek-v4-flash",
  "mistralai/mistral-small-3.2-24b-instruct": "google/gemini-3.5-flash-lite",  // cheap + vision
  "qwen/qwen3-vl-8b-instruct": "nvidia/nemotron-nano-12b-v2-vl",              // small cheap vision
  "perplexity/sonar-pro": "google/gemini-3.6-flash",       // any model can call web_search
  "meta-llama/llama-4-maverick": "minimax/minimax-m3",     // cheap 1M-ctx vision
  "mistralai/mistral-nemo": "nvidia/nemotron-3-super-120b-a12b:free", // utility work moved with UTILITY_MODEL
  "google/gemma-4-31b-it:free": "nvidia/nemotron-3-super-120b-a12b:free",  // free stays free
};
// Live id -> itself. Removed id -> its mapped survivor. Unknown -> "" (never invent a model).
export const resolveModelId = (id) =>
  BY_ID.has(id) ? id : (REMOVED_MODEL_FALLBACKS[String(id || "")] || "");

// ---- normalization --------------------------------------------------------------------------

/*
 * Human-readable PRICE TIER, bucketed off outCost (the bigger cost driver on almost every call).
 * Fred's complaint was raw six-decimal floats in the picker; a tier a person can compare at a
 * glance replaces that without hiding the real number (fmtPrice/fmtPriceShort still show it).
 * Boundaries are an editorial call, not a measured constant: $3 and $15 per million output tokens
 * split the pruned 25-model roster into four groups of comparable size. Revisit if the roster's
 * price spread shifts enough that a tier stops meaning anything.
 */
function priceTierOf(inCost, outCost) {
  if (!inCost && !outCost) return "Free";
  if (outCost <= 3) return "Budget";
  if (outCost <= 15) return "Standard";
  return "Premium";
}

/*
 * Human-readable SPEED TIER, derived from the `reasoning` flag this file already verifies per
 * model (see the field notes above finalize). A chain-of-thought model spends visible or hidden
 * turns thinking before it answers; a non-reasoning model replies immediately. That is a real
 * behavioral difference a user notices while waiting, not a guessed benchmark number, which is
 * why it is computed from the flag instead of hand-tagged per row.
 */
function speedTierOf(reasoning) {
  return reasoning ? "Reasons first" : "Replies fast";
}

// Fill routing defaults so every consumer can trust these fields exist:
//   provider defaults to "openrouter"; directId defaults to the OpenRouter slug (`id`);
//   toolCapable defaults from the model's category (doing bench vs chatting bench).
function finalize(m) {
  const provider = m.provider || "openrouter";
  const directId = m.directId || m.id;
  const toolCapable = typeof m.toolCapable === "boolean" ? m.toolCapable : TOOL_CAPABLE_CATEGORIES.has(m.category);
  const maxOut = Number(m.maxOut) > 0 ? Number(m.maxOut) : DEFAULT_MAX_OUT;
  const reasoning = m.reasoning === true;
  const reasoningEffort = typeof m.reasoningEffort === "string" ? m.reasoningEffort : "";
  // vision NEVER defaults from category; explicit true only (verified per model; see field notes).
  const vision = m.vision === true;
  const priceTier = priceTierOf(m.inCost, m.outCost);
  const speedTier = speedTierOf(reasoning);
  return { ...m, provider, directId, toolCapable, maxOut, reasoning, reasoningEffort, vision, priceTier, speedTier };
}
// Mutate in place so MODELS (exported) carries the normalized fields everywhere.
for (let i = 0; i < MODELS.length; i++) MODELS[i] = finalize(MODELS[i]);

// ---- helpers --------------------------------------------------------------------------------

// The security allow-list: exactly the ids above. An id not in here can never be sent to a provider.
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
export const isCatalogModel = (id) => typeof id === "string" && MODEL_IDS.has(id);

// Look up the full normalized model record by its UI-facing id (or null).
const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
export const modelById = (id) => BY_ID.get(id) || null;
// The provider a model routes to ("openrouter" | "openai" | "deepseek"), or "" if unknown.
export const providerOf = (id) => { const m = BY_ID.get(id); return m ? m.provider : ""; };
// Whether a model is allowed to use this box's tools (doing bench).
export const isToolCapable = (id) => { const m = BY_ID.get(id); return !!(m && m.toolCapable); };

/*
 * WILDFIRE ROSTER — the models Fred trusts with broad, multi-step authority over his machines.
 *
 * This is a DIFFERENT question from toolCapable. 31 models in this catalog accept tool calls; only
 * these can be relied on to plan and execute a real piece of work across an infrastructure without
 * losing the thread. Starring all 31 would be worse than starring none: Fred would pick a small
 * free model for a big job, watch it flounder, and reasonably conclude the wiring is broken again.
 *
 * Curated with Fred on 2026-07-19 and revised when OpenAI moved to the Responses API. GPT-5.6 is
 * now included because tools no longer force reasoning off; that former transport limitation was
 * a Dominion defect, not a model limitation.
 * Two of his original calls, recorded so nobody quietly "corrects" them:
 *   - DeepSeek R1 and Nemotron 3 Ultra were ADDED at his direction over my hesitation. R1 in
 *     particular sometimes emits reasoning where a clean tool call belongs. Logged as accepted risk.
 *
 * GPT-4o stays because the reasoning-off rule only matches ^gpt-5 and ^o\d, so it is unaffected.
 */
// NOTE: these are catalog ids, NOT provider ids. Direct-provider models carry a "<provider>/" prefix
// here and a bare directId on the wire (anthropic/claude-opus-4-8 vs claude-opus-4-8). Mixing the
// two silently unstars a model, so isBroadCapable is covered by a test that asserts all 16 resolve.
const WILDFIRE_ROSTER = new Set([
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.6",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-r1",
  "qwen/qwen3-coder",
  "openai/gpt-4o",
  "nvidia/nemotron-3-ultra-550b-a55b",
  // Gemini seats joined 2026-08-03 with the lane: tools live-probed on the wire Dominion uses.
  "google/gemini-3.6-flash",
  "google/gemini-3.1-pro-preview",
]);   // qwen3-235b and grok-4.20 left with the 2026-08-03 prune; z-ai/glm-5.2 left 2026-09-03 (410, EOL)

// Stamp it onto every model record so it rides the /api/models payload to the picker without a
// second lookup. Runs AFTER finalize(), so toolCapable is already resolved.
for (const m of MODELS) m.broadCapable = WILDFIRE_ROSTER.has(m.id) && m.toolCapable === true;

// Can this model be trusted with Wildfire's broad authority? Tool capability is a prerequisite:
// a model that cannot call tools can never be armed, whatever the roster says.
export const isBroadCapable = (id) => WILDFIRE_ROSTER.has(id) && isToolCapable(id);
// The roster as names, for the block message that tells Fred what he COULD have picked.
export const broadCapableNames = () => MODELS.filter((m) => isBroadCapable(m.id)).map((m) => m.name);
export const broadCapableIds = () => MODELS.filter((m) => isBroadCapable(m.id)).map((m) => m.id);
// Whether a model is a chain-of-thought reasoner whose hidden thinking is billed against output.
export const isReasoning = (id) => { const m = BY_ID.get(id); return !!(m && m.reasoning); };
// Whether a model accepts image input (picture attachments may route to it). Explicit flag only.
export const isVisionCapable = (id) => { const m = BY_ID.get(id); return !!(m && m.vision); };
// Short honest list for refusal messages: "which models CAN see this image".
export const visionModelNames = (limit = 6) => MODELS.filter((m) => m.vision).slice(0, limit).map((m) => m.name);

// Per-CALL output ceiling for a model in a given mode. This is the CHUNK a single round may emit;
// the server auto-continues past it (finish_reason "length") until the full answer is written, so a
// smaller number here never truncates the final result; it only changes how many round-trips it takes.
// Fast is the only explicit brevity mode. Normal and all work modes receive the
// selected model's native output window; Dominion must not quietly starve a
// frontier model and then mistake the resulting boundary for task completion.
export const OUT_MODE_CEIL = { fast: 2048 };   // any mode not listed -> the model's full maxOut

/*
 * MEASURED STARVATION FLOORS (probed live 2026-08-03, twice, against the pre-prune 44-model
 * roster; see docs/MODEL-RECORDS.json). These numbers are measured rather than estimated, and
 * that provenance is the reason to trust them.
 * A reasoning model bills its hidden thinking against the output budget. Under a tight ceiling it
 * spends the whole allowance thinking and returns an EMPTY string, not a short answer. Ten of those
 * models did exactly that at a 64-token ceiling, and the ceiling each one needs to recover MOVED
 * between runs (gpt-oss-20b: 1024 then 512; trinity: 512 then 2048), so these floors are 4x the
 * worst observed, not the observed value. Fred's decision 2026-08-03: R1 is banned from fast mode's
 * 2048 cap; the same measured evidence protects the rest of the list. A mode ceiling may CHUNK a
 * reply (the server auto-continues), but a chunk smaller than the floor can be 100% reasoning, and
 * a turn that burns 2048 tokens to emit nothing is the failure Fred named: "we can avoid a bunch of
 * disappointed people right off the bat".
 */
export const REASONING_FLOOR = {
  "deepseek/deepseek-r1": 8192,             // no text at ANY ceiling <= 2048 in one run
  "arcee-ai/trinity-large-thinking": 8192,  // worst observed floor 2048 = the fast cap exactly
  "moonshotai/kimi-k2.6": 4096,             // worst 1024
  "openai/gpt-oss-20b": 4096,               // worst 1024
  "gx10/gpt-oss-20b": 4096,                 // same weights as the NVIDIA seat above
  "gx10/gpt-oss-120b": 4096,                // same family; reasoning billed against output
  "minimax/minimax-m2.5": 4096,             // worst 1024
  "tencent/hy3-preview": 4096,              // worst 1024
  "moonshotai/kimi-k3": 2048,               // worst 512
  "openai/gpt-5.6-luna": 1024,              // worst 256
  "google/gemini-3.1-pro-preview": 1024,    // silent at 64, recovered by 256 (probed 2026-08-03)
  "openai/gpt-5.5": 1024,                   // worst 256
  "anthropic/claude-sonnet-5": 1024,        // worst 256
  "deepseek/deepseek-v4-pro": 1024,         // worst 256 (owner default)
  "deepseek/deepseek-v4-flash": 1024,       // worst 256 (tenant default)
};

export function outLimitFor(id, mode) {
  const m = BY_ID.get(id);
  const cap = (m && m.maxOut) || DEFAULT_MAX_OUT;
  const ceil = OUT_MODE_CEIL[mode];
  if (!ceil) return cap;
  // A mode ceiling never dips below a measured starvation floor: brevity is a request for a short
  // ANSWER, and an empty reply is not a short answer.
  return Math.min(cap, Math.max(ceil, REASONING_FLOOR[id] || 0));
}

// Cheap fast model for internal utility calls (chat titles, short summaries) so they never block.
// Was mistral-nemo until the 2026-08-03 prune, then GLM 5.2 (free on the NVIDIA lane, no
// reasoning headroom) until NVIDIA retired it 2026-08-21 (STABILIZE Step 1, 2026-09-03): every
// call 410'd, so utility calls were silently failing. Nemotron 3 Super takes the job: same $0
// NVIDIA lane, not flagged `reasoning` (no starvation risk), already the most heavily used free
// seat in this catalog (Simplify's business/theological rungs, BATTALION's single seat).
export const UTILITY_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

/* BATTALION (ARSENAL Wave 6, docs/BATTALION-SOW.md). Fred's copy, verbatim, no quality
 * qualifier. The roster is the "handpicked" in his sentence: free-lane seats ONLY, each admitted
 * by the Wave 2 live probe (answers + tools verified on the NVIDIA free endpoint), reviewed at
 * the weekly audit like the Wildfire roster above. No model rides in because it is merely free. */
export const BATTALION_COPY = "a handpicked swarm of AI models to do more work in less time- for free";
export const BATTALION_ROSTER = {
  assess: "openai/gpt-oss-20b",                          // fast free reasoner: the war-council gate
  orchestrator: "nvidia/nemotron-3-ultra-550b-a55b",     // 550B free flagship: plans the split
  synthesizer: "nvidia/nemotron-3-ultra-550b-a55b",      // and merges the parts into one voice
  single: "nvidia/nemotron-3-super-120b-a12b:free",      // simple turns: one strong fast seat
  workers: [                                             // the parallel bench, round-robin
    "nvidia/nemotron-3-super-120b-a12b:free",            //   reasoning
    "nvidia/llama-3.1-nemotron-70b-instruct",            //   warm, plain-spoken (replaced glm-5.2, EOL 08-21)
    "openai/gpt-oss-20b",                                //   fast general
    "minimax/minimax-m3",                                //   long-context + vision seat
  ],
};
// Every roster seat must exist in the catalog — a rename in MODELS must break loudly, not
// silently bench a specialist. Covered by battalion_test.mjs.
export const battalionRosterIds = () => [BATTALION_ROSTER.assess, BATTALION_ROSTER.orchestrator,
  BATTALION_ROSTER.synthesizer, BATTALION_ROSTER.single, ...BATTALION_ROSTER.workers];

/*
 * A SECOND WIRE FOR EVERY SEAT (Fred, 2026-08-09, ready to give up on BATTALION after a turn died
 * with "Couldn't reach NVIDIA (direct): read ETIMEDOUT").
 *
 * The roster reads like five vendors and is ONE HOST. Every id above resolves to provider "nvidia",
 * so integrate.api.nvidia.com carries the assess seat, the orchestrator, the synthesizer, the single
 * seat and all four workers. battalion.mjs does replace a dead seat with another seat, but that
 * changes the model name in the request body and posts it to the host that just timed out; against a
 * transport failure it buys nothing. One bad minute on one host therefore reaches the user as "the
 * free lane is down", which is what it reached Fred as.
 *
 * The endpoint was NOT the problem. Probed from the production container the same evening: GET
 * /v1/models 200 in 109ms, ultra-550b 200 in 482ms, super-120b 200 in 430ms.
 *
 * This maps each seat to a route on a DIFFERENT host, and every value is MEASURED rather than
 * assumed, because the obvious version of this fix quietly starts billing. Probed against OpenRouter
 * 2026-08-09 from the same container:
 *
 *   openai/gpt-oss-20b                        PAID bare ($0.03/$0.13), :free exists  -> :free
 *   nvidia/nemotron-3-ultra-550b-a55b         PAID bare ($0.60/$3.60), :free exists  -> :free
 *   nvidia/nemotron-3-super-120b-a12b:free    already a $0 route                     -> itself
 *   nvidia/llama-3.1-nemotron-70b-instruct    NO $0 route on OpenRouter at all       -> the free 120B
 *   minimax/minimax-m3                        NO $0 route on OpenRouter at all       -> the free 120B
 *
 * (z-ai/glm-5.2's row here was removed with it from MODELS 2026-09-03, STABILIZE Step 1 — NVIDIA
 * retired the seat 2026-08-21 and it took its BATTALION worker slot with it; see the roster above.)
 *
 * FOUR OF THE FIVE ARE PAID under their bare ids, so a plain __forceProvider reroute would have
 * charged Fred on a lane whose own failure message says "Nothing was billed". Every value below is a
 * $0 route, each live-probed HTTP 200 (nemotron-70b-instruct is UNVERIFIED on this specific point —
 * it has no OpenRouter-native row in this catalog to probe a :free twin against, so it takes the
 * same no-free-twin fallback as minimax-m3 on the same reasoning, not a fresh probe). The two seats
 * with no free twin fall to the free 120B: that loses the coder and the long-context specialist,
 * which is a real downgrade and is announced in the manifest rather than swallowed. Vision is not
 * among the losses — the swarm refuses picture turns outright, so the minimax seat's vision never
 * runs here.
 *
 * The $0 invariant is enforced by battalion_failover_test, not by this comment.
 */
export const BATTALION_FAILOVER = {
  "openai/gpt-oss-20b": "openai/gpt-oss-20b:free",
  "nvidia/nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free": "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/llama-3.1-nemotron-70b-instruct": "nvidia/nemotron-3-super-120b-a12b:free",
  "minimax/minimax-m3": "nvidia/nemotron-3-super-120b-a12b:free",
};

// Pretty context window: 262144 -> "256K", 1000000 -> "1M", 2000000 -> "2M".
export function fmtCtx(n) {
  if (!n) return "?";
  if (n >= 1000000) return (n % 1000000 === 0 ? n / 1000000 : (n / 1000000).toFixed(1)) + "M";
  return Math.round(n / 1000) + "K";
}

// Pretty price: 0 -> "Free", else "$in/$out".
export function fmtPrice(m) {
  if (!m.inCost && !m.outCost) return "Free";
  return "$" + m.inCost + " / $" + m.outCost;
}

// Group by category (in CATEGORIES order), sorted most params -> least within each (nulls last).
/*
 * The orchestrator slot (Fred's Vibe Coder ruling 2026-07-25, extending the Feedback Wave SOW 2.2).
 * The ONE place in the whole app where a model pick may be refused: the orchestrator/divider writes
 * the task roadmap every agent then follows, so a tiny model garbling it poisons the entire build,
 * not one part of it. Everywhere else stays warn-never-block by design.
 *
 * "Above the tiny tier" means: 200B+ total parameters, or undisclosed (the undisclosed models in
 * this catalog are the frontier-lab lines: GPT, Claude, Grok — none of them small). The threshold
 * is deliberately a number in one place so raising it is a one-line change.
 */
const ORCH_MIN_PARAMS_B = 200;
export const isOrchestratorApproved = (id) => {
  const m = modelById(id);
  if (!m) return false;
  return m.paramsB === null || m.paramsB >= ORCH_MIN_PARAMS_B;
};

// The fallback chain when an orchestrator call fails: strongest first, all approved by
// construction. handleIdeTasks walks it, skipping the model that just failed and any provider
// without a key, and TELLS THE USER which substitution happened (a silent swap is a lie).
export const ORCHESTRATOR_FALLBACKS = [
  "deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-5", "openai/gpt-5.6-terra",
  "moonshotai/kimi-k2.6", "google/gemini-3.6-flash",   // gemini took qwen3-235b's slot in the prune
];

/*
 * PER-SEAT FALLBACK (STABILIZE Step 1, 2026-09-03, deficiency #3-#5). "Model picker offers seats
 * that cannot answer" and "boot-time audit reports CLEAN while seats are dead" are two faces of
 * one gap: nothing ever recorded WHAT a hidden or dead seat should serve instead. Every current
 * catalog id gets exactly one, chosen for a similar job at the next price/latency step down (a
 * paid flagship falls to a cheaper sibling in the same family before it falls to a free seat; a
 * free NVIDIA seat falls to another free NVIDIA seat or the cheapest DeepSeek lane). Verified by
 * models_catalog_test.mjs: every key is a live id, every value is a live id, no id maps to itself.
 */
export const MODEL_FALLBACKS = Object.freeze({
  "openai/gpt-5.6-sol": "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra": "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna": "deepseek/deepseek-v4-flash",
  "openai/gpt-5.5": "openai/gpt-5.6-terra",
  "openai/gpt-4o": "openai/gpt-5.6-luna",
  "moonshotai/kimi-k3": "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.6": "deepseek/deepseek-v4-pro",
  "anthropic/claude-opus-4-8": "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5": "anthropic/claude-haiku-4-5",
  "anthropic/claude-haiku-4-5": "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-flash",
  "google/gemini-3.6-flash": "deepseek/deepseek-v4-flash",
  "google/gemini-3.1-pro-preview": "google/gemini-3.6-flash",
  "google/gemini-3.5-flash-lite": "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-r1": "deepseek/deepseek-v4-pro",
  "nvidia/nemotron-3-ultra-550b-a55b": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "anthropic/claude-haiku-4-5",
  "qwen/qwen3-coder": "deepseek/deepseek-v4-pro",
  "arcee-ai/trinity-large-thinking": "anthropic/claude-sonnet-5",
  "minimax/minimax-m3": "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b": "minimax/minimax-m3",
  "nvidia/nemotron-3-super-120b-a12b:free": "deepseek/deepseek-v4-flash",
  "nvidia/llama-3.1-nemotron-70b-instruct": "anthropic/claude-haiku-4-5",
  "nvidia/nemotron-3.5-content-safety": "anthropic/claude-haiku-4-5",
  "openai/gpt-oss-20b": "deepseek/deepseek-v4-flash",
  "gx10/gpt-oss-120b": "deepseek/deepseek-v4-flash",
  "gx10/qwen3-coder-30b": "qwen/qwen3-coder",
  "gx10/gpt-oss-20b": "deepseek/deepseek-v4-flash",
});
// Stamp it onto every model record (same pattern as broadCapable above) so it rides /api/models
// without a second lookup, and so a caller who already has the record in hand needs no import.
for (const m of MODELS) m.fallback = MODEL_FALLBACKS[m.id] || "";
export const fallbackFor = (id) => MODEL_FALLBACKS[id] || "";

/*
 * LIVE-AUDIT UNAVAILABLE STATE (STABILIZE Step 1, deficiency #3-#5). catalogaudit.mjs's boot/hourly
 * run (server.mjs) calls setUnavailableSeats() with what it could not verify live; this module
 * holds that as the single place both /api/models (catalogPayload, below) and any request-time
 * caller (resolveServingModel, below) read it from. Module-scope mutable state, on purpose: the
 * audit result is process-wide truth about what NVIDIA will currently answer, not a per-request
 * value, and every consumer needs the SAME snapshot without threading it through every call site.
 * Empty object at boot (nothing known-dead yet) is the safe default: nothing is hidden until the
 * first audit actually proves it should be.
 */
let unavailableSeats = {};   // { [modelId]: reason }
export function setUnavailableSeats(map) { unavailableSeats = (map && typeof map === "object") ? { ...map } : {}; }
export function getUnavailableSeats() { return { ...unavailableSeats }; }
export const isSeatUnavailable = (id) => Object.prototype.hasOwnProperty.call(unavailableSeats, id);
export const unavailableReason = (id) => unavailableSeats[id] || "";

/*
 * Resolve what a chat request for `id` should actually be served by: itself if it is live, its
 * `fallback` (recursing once more if THAT is also unavailable, capped so a fallback cycle can
 * never spin) otherwise. Every consumer that substitutes a seat gets the same answer from the same
 * place, and the `substituted`/`reason` fields are exactly what a `served` metadata event needs —
 * this is the data half of "a chat request for a hidden or unavailable seat is served by its
 * fallback and the response carries served metadata"; simplify.mjs's ladder implements the request
 * half for Simplify's own routes, and the main /chat picker (lane/chat) is the other caller this
 * was built for.
 */
export function resolveServingModel(id) {
  let cur = id, hops = 0;
  const chain = [];
  while (cur && isSeatUnavailable(cur) && hops < 4) {
    chain.push({ id: cur, reason: unavailableReason(cur) });
    const next = fallbackFor(cur);
    if (!next || next === cur || chain.some((c) => c.id === next)) break;   // no route, self-loop, or a cycle
    cur = next; hops++;
  }
  const servedId = cur && isCatalogModel(cur) ? cur : (isCatalogModel(id) ? id : "");
  // "substituted" means a DIFFERENT live seat is serving this request, not "we found nothing at
  // all" (an id that was never a catalog member in the first place is not a substitution — there
  // was nothing to substitute FROM).
  return { requestedId: id, servedId, substituted: !!servedId && servedId !== id, chain };
}

export function catalogByCategory() {
  return CATEGORIES.map((cat) => ({
    category: cat,
    models: MODELS.filter((m) => m.category === cat)
      .sort((a, b) => (b.paramsB ?? -1) - (a.paramsB ?? -1)),
  })).filter((g) => g.models.length);
}

/*
 * The full payload served at /api/models. Hides any seat the live audit could not verify
 * (deficiency #4/#5: "the model picker offers seats that cannot answer") rather than greying it
 * out client-side — a hidden dead seat cannot be picked at all, which is the actual requirement
 * ("nothing may fail to produce a viable result" reads, for a picker, as "never offer a choice
 * that fails"). `count` and each group's models reflect the filtered set; nothing downstream needs
 * to know a seat was ever hidden. MODEL_IDS (the security allow-list) is untouched: a seat that
 * comes back alive on the next hourly audit is immediately pickable again with no redeploy.
 */
export function catalogPayload() {
  const hiddenCount = Object.keys(unavailableSeats).length;
  const groups = catalogByCategory()
    .map((g) => ({ ...g, models: g.models.filter((m) => !isSeatUnavailable(m.id)) }))
    .filter((g) => g.models.length);
  const count = groups.reduce((n, g) => n + g.models.length, 0);
  return { updated: CATALOG_UPDATED, default: DEFAULT_MODEL, categories: CATEGORIES, groups, count, hiddenCount };
}
