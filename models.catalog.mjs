/*
 * Dominion AI — cloud model catalog (single source of truth).
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
 * The big three Fred already pays for directly (Anthropic Claude, Google Gemini, OpenAI GPT) are
 * deliberately ABSENT — he uses those through their own apps. Grok (xAI), Perplexity, and the open
 * Gemma/Llama models are fair game.
 *
 * Prices are USD per 1M tokens (input / output) and DRIFT — re-pull https://openrouter.ai/api/v1/models
 * to refresh. `params` is a display string; `paramsB` is billions for sorting (null = undisclosed).
 * `ctx` is the context window in tokens. Snapshot date below.
 */

export const CATALOG_UPDATED = "2026-07-08";

// The out-of-the-box default: fast, dirt-cheap, strong all-rounder. Change via env DEFAULT_CLOUD_MODEL.
export const DEFAULT_MODEL = "qwen/qwen3-235b-a22b-2507";

// Category display order (the picker renders groups in THIS order).
export const CATEGORIES = [
  "Frontier / Flagship",
  "Reasoning & Math",
  "Coding",
  "Science & Technical",
  "Creative & Writing",
  "Uncensored / Blunt",
  "Vision / Multimodal",
  "Web / Research",
  "Open & Trainable",
];

// paramsB: total parameters in billions for sorting (MoE = total, not active). null = undisclosed.
export const MODELS = [
  // ---- Frontier / Flagship ------------------------------------------------------------------
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", origin: "Moonshot AI (Beijing)",
    category: "Frontier / Flagship", params: "1T (MoE·32B active)", paramsB: 1000, inCost: 0.66, outCost: 3.41, ctx: 262144,
    specialty: "Agentic tool-use heavyweight; cult favorite for doing things" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", origin: "DeepSeek (China)",
    category: "Frontier / Flagship", params: "671B (MoE·37B active)", paramsB: 671, inCost: 0.43, outCost: 0.87, ctx: 1000000,
    specialty: "Near-frontier reasoning + code at ~1/30th flagship price" },
  { id: "minimax/minimax-m2.5", name: "MiniMax M2.5", origin: "MiniMax (Shanghai)",
    category: "Frontier / Flagship", params: "456B (MoE)", paramsB: 456, inCost: 0.12, outCost: 0.48, ctx: 204000,
    specialty: "Cheap capable all-rounder for high-volume work" },
  { id: "z-ai/glm-5.2", name: "GLM 5.2", origin: "Zhipu AI (Tsinghua spinout)",
    category: "Frontier / Flagship", params: "355B (MoE)", paramsB: 355, inCost: 0.45, outCost: 3.31, ctx: 202000,
    specialty: "Strong coder + long-horizon planning" },
  { id: "qwen/qwen3-235b-a22b-2507", name: "Qwen3 235B", origin: "Alibaba",
    category: "Frontier / Flagship", params: "235B (MoE·22B active)", paramsB: 235, inCost: 0.09, outCost: 0.10, ctx: 262144,
    specialty: "Fast, dirt-cheap, strong — the default daily driver" },
  { id: "x-ai/grok-4.20", name: "Grok 4.20", origin: "xAI (Musk)",
    category: "Frontier / Flagship", params: "undisclosed", paramsB: null, inCost: 1.25, outCost: 2.50, ctx: 2000000,
    specialty: "Frontier quality, 2M context, least hedgy of the majors" },

  // ---- Reasoning & Math ---------------------------------------------------------------------
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", origin: "DeepSeek (China)",
    category: "Reasoning & Math", params: "671B (MoE·37B active)", paramsB: 671, inCost: 0.70, outCost: 2.50, ctx: 163000,
    specialty: "Visible chain-of-thought; watch it reason step by step" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", origin: "NVIDIA",
    category: "Reasoning & Math", params: "550B (MoE·55B active)", paramsB: 550, inCost: 0.42, outCost: 2.61, ctx: 131072,
    specialty: "Deep STEM reasoning when you need the big gun" },
  { id: "qwen/qwen3-8b", name: "Qwen3 8B", origin: "Alibaba",
    category: "Reasoning & Math", params: "8B", paramsB: 8, inCost: 0.05, outCost: 0.40, ctx: 128000,
    specialty: "Tiny thinking-mode model; cheap step-by-step math (Apache 2.0)" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", origin: "DeepSeek (China)",
    category: "Reasoning & Math", params: "undisclosed (MoE)", paramsB: null, inCost: 0.05, outCost: 0.24, ctx: 1000000,
    specialty: "Cheapest strong reasoning/math+code engine (MIT)" },

  // ---- Coding -------------------------------------------------------------------------------
  { id: "qwen/qwen3-coder", name: "Qwen3 Coder", origin: "Alibaba",
    category: "Coding", params: "480B (MoE·35B active)", paramsB: 480, inCost: 0.22, outCost: 1.80, ctx: 1000000,
    specialty: "Agentic coding with a 1M window — whole-repo work (Apache 2.0)" },
  { id: "mistralai/codestral-2508", name: "Codestral 25.08", origin: "Mistral AI (France)",
    category: "Coding", params: "~22B", paramsB: 22, inCost: 0.30, outCost: 0.90, ctx: 256000,
    specialty: "Fast code-completion specialist" },

  // ---- Science & Technical ------------------------------------------------------------------
  { id: "mistralai/mistral-small-24b-instruct-2501", name: "Mistral Small 3", origin: "Mistral AI (France)",
    category: "Science & Technical", params: "24B", paramsB: 24, inCost: 0.05, outCost: 0.08, ctx: 32000,
    specialty: "Excellent cheap technical/science Q&A; fully fine-tunable (Apache 2.0)" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2", origin: "Mistral AI (France)",
    category: "Science & Technical", params: "24B", paramsB: 24, inCost: 0.08, outCost: 0.20, ctx: 128000,
    specialty: "Fast cheap scripting/technical helper (OpenSCAD, three.js)" },

  // ---- Creative & Writing -------------------------------------------------------------------
  { id: "anthracite-org/magnum-v4-72b", name: "Magnum v4 72B", origin: "Anthracite (open collective)",
    category: "Creative & Writing", params: "72B", paramsB: 72, inCost: 3.00, outCost: 5.00, ctx: 32000,
    specialty: "Literary prose — a collective reproducing Claude's writing feel" },
  { id: "sao10k/l3.3-euryale-70b", name: "Euryale 70B (L3.3)", origin: "Sao10k (community)",
    category: "Creative & Writing", params: "70B", paramsB: 70, inCost: 0.65, outCost: 0.75, ctx: 131072,
    specialty: "Vivid, uninhibited fiction; distinct character voices" },
  { id: "thedrummer/skyfall-36b-v2", name: "Skyfall 36B v2", origin: "TheDrummer (community)",
    category: "Creative & Writing", params: "36B", paramsB: 36, inCost: 0.55, outCost: 0.80, ctx: 32000,
    specialty: "Longer-form scripts with narrative stamina" },
  { id: "arcee-ai/trinity-large-thinking", name: "Trinity Large Thinking", origin: "Arcee AI",
    category: "Creative & Writing", params: "undisclosed", paramsB: null, inCost: 0.25, outCost: 0.80, ctx: 262144,
    specialty: "Expressive creative writing (already in Command Deck notes)" },
  { id: "thedrummer/rocinante-12b", name: "Rocinante 12B", origin: "TheDrummer (community)",
    category: "Creative & Writing", params: "12B", paramsB: 12, inCost: 0.17, outCost: 0.43, ctx: 32000,
    specialty: "Cheapest uncensored storyteller — punches above 12B" },
  { id: "thedrummer/unslopnemo-12b", name: "UnslopNemo 12B", origin: "TheDrummer (community)",
    category: "Creative & Writing", params: "12B", paramsB: 12, inCost: 0.40, outCost: 0.40, ctx: 32000,
    specialty: "'De-slopped' — kills purple-prose GPT-isms" },
  { id: "tencent/hy3-preview", name: "Tencent Hy3", origin: "Tencent",
    category: "Creative & Writing", params: "undisclosed", paramsB: null, inCost: 0.06, outCost: 0.21, ctx: 32000,
    specialty: "Ultra-cheap, surprisingly vivid creative chat for volume" },

  // ---- Uncensored / Blunt -------------------------------------------------------------------
  { id: "nousresearch/hermes-4-405b", name: "Hermes 4 405B", origin: "Nous Research (open collective)",
    category: "Uncensored / Blunt", params: "405B", paramsB: 405, inCost: 1.00, outCost: 3.00, ctx: 131072,
    specialty: "Neutral, steerable, minimal moralizing — obeys your system prompt" },
  { id: "microsoft/wizardlm-2-8x22b", name: "WizardLM-2 8x22B", origin: "Microsoft",
    category: "Uncensored / Blunt", params: "141B (MoE·8x22B)", paramsB: 141, inCost: 0.62, outCost: 0.62, ctx: 65536,
    specialty: "Relatively unfiltered MoE; a piece of open-model history" },
  { id: "nousresearch/hermes-4-70b", name: "Hermes 4 70B", origin: "Nous Research (open collective)",
    category: "Uncensored / Blunt", params: "70B", paramsB: 70, inCost: 0.13, outCost: 0.40, ctx: 131072,
    specialty: "Reflective, non-preachy dialogue; toggleable reasoning" },
  { id: "thedrummer/cydonia-24b-v4.1", name: "Cydonia 24B v4.1", origin: "TheDrummer (community)",
    category: "Uncensored / Blunt", params: "24B", paramsB: 24, inCost: 0.30, outCost: 0.50, ctx: 131072,
    specialty: "Characterful, unfiltered; sharp dialogue with no hand-wringing" },
  { id: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", name: "Dolphin Venice 24B", origin: "Cognitive Computations (Eric Hartford)",
    category: "Uncensored / Blunt", params: "24B", paramsB: 24, inCost: 0, outCost: 0, ctx: 32768,
    specialty: "The classic de-censored finetune — FREE to experiment" },
  { id: "venice/uncensored", name: "Venice Uncensored 24B", origin: "Venice / Dolphin",
    category: "Uncensored / Blunt", params: "24B", paramsB: 24, inCost: 0, outCost: 0, ctx: 32768,
    specialty: "Near-zero refusals — FREE best no-cost pick" },

  // ---- Vision / Multimodal ------------------------------------------------------------------
  { id: "minimax/minimax-m3", name: "MiniMax M3", origin: "MiniMax (Shanghai)",
    category: "Vision / Multimodal", params: "undisclosed (MoE)", paramsB: null, inCost: 0.10, outCost: 1.21, ctx: 200000,
    specialty: "Strongest visual understanding here (image/video reasoning)" },
  { id: "qwen/qwen3-vl-8b-instruct", name: "Qwen3-VL 8B", origin: "Alibaba",
    category: "Vision / Multimodal", params: "8B", paramsB: 8, inCost: 0.08, outCost: 0.50, ctx: 128000,
    specialty: "Image/style critique, art analysis, prompt-writing (text+vision)" },

  // ---- Web / Research -----------------------------------------------------------------------
  { id: "perplexity/sonar-pro", name: "Perplexity Sonar Pro", origin: "Perplexity",
    category: "Web / Research", params: "undisclosed (Llama-based)", paramsB: null, inCost: 3.00, outCost: 15.00, ctx: 200000,
    specialty: "Live web search with citations baked in — 'what's true right now'" },

  // ---- Open & Trainable ---------------------------------------------------------------------
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", origin: "Meta",
    category: "Open & Trainable", params: "400B (MoE·17B active)", paramsB: 400, inCost: 0.15, outCost: 0.60, ctx: 1000000,
    specialty: "The trunk of the whole open-source tree; 1M context" },
  { id: "allenai/olmo-3-32b-think", name: "OLMo 3 32B Think", origin: "Allen Institute (nonprofit)",
    category: "Open & Trainable", params: "32B", paramsB: 32, inCost: 0.15, outCost: 0.50, ctx: 65536,
    specialty: "Fully open — weights, DATA, and training code. Study how models are built" },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", origin: "Google (open weights)",
    category: "Open & Trainable", params: "31B", paramsB: 31, inCost: 0, outCost: 0, ctx: 262144,
    specialty: "Capable FREE baseline to sanity-check everything against" },
  { id: "mistralai/mistral-nemo", name: "Mistral Nemo", origin: "Mistral AI (France)",
    category: "Open & Trainable", params: "12B", paramsB: 12, inCost: 0.02, outCost: 0.04, ctx: 128000,
    specialty: "Cheapest warm conversational base — ideal to fine-tune your own (Apache 2.0)" },
];

// ---- helpers --------------------------------------------------------------------------------

// The security allow-list: exactly the ids above. An id not in here can never be sent to OpenRouter.
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
export const isCatalogModel = (id) => typeof id === "string" && MODEL_IDS.has(id);

// Cheap fast model for internal utility calls (chat titles, short summaries) so they never block.
export const UTILITY_MODEL = "mistralai/mistral-nemo";

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
export function catalogByCategory() {
  return CATEGORIES.map((cat) => ({
    category: cat,
    models: MODELS.filter((m) => m.category === cat)
      .sort((a, b) => (b.paramsB ?? -1) - (a.paramsB ?? -1)),
  })).filter((g) => g.models.length);
}

// The full payload served at /api/models.
export function catalogPayload() {
  return { updated: CATALOG_UPDATED, default: DEFAULT_MODEL, categories: CATEGORIES, groups: catalogByCategory(), count: MODELS.length };
}
