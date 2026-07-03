/*
 * Dominion AI — Phase 1 routing helpers (Group D restoration).
 *
 * Pure functions extracted from server.mjs so the routing machinery is unit-testable without
 * booting the server:
 *   - routeOf(): maps tier+mode onto the spec's route enum (spec ~352-363)
 *   - escalateForContext(): the POST-RETRIEVAL long-context re-check (audit item 12) — the spec's
 *     first long-context entry condition ("retrieved context exceeds normal limit", spec ~387-391)
 *     is only structurally possible if the check runs AFTER context assembly. server.mjs calls this
 *     once the full message array is built and escalates num_ctx (and the mode label) when the
 *     assembled context would overflow the current window.
 *   - consumeNeeds(): turns the router's needs_retrieval / needs_tools into actual pipeline
 *     behavior (skip retrieval; drop tool defs from the prompt on chat-only turns). Conservative
 *     bias per the spec's spirit: when in doubt, attach tools / retrieve.
 */

// The window Ollama actually serves when we don't ask for more (qwen3 default on this box).
// "Normal limit" for the spec's long-context entry condition.
export const DEFAULT_NUM_CTX = 8192;

// Spec route enum: local_light | local_main | local_main_long_context | external_mentor |
// multi_model_review. The auto-router only ever selects the three local routes (the mentor bridge
// defaults local and review is a POST-answer concern carried by needs_mentor_review, not a routing
// destination); explicit mentor mode = answer + independent critique pass = multi_model_review.
export function routeOf(tier, mode) {
  if (mode === "mentor") return "multi_model_review";
  if (mode === "long_context") return "local_main_long_context";
  return tier === "light" ? "local_light" : "local_main";
}

// Post-retrieval overflow check. contextTokens = estimate of the FULLY ASSEMBLED prompt (system +
// rules + retrieved memory/artifacts/chats + history). reserve = headroom for the model's output.
// Returns the num_ctx to run with; escalate=true means the current budget would overflow and the
// caller should adopt long-context behavior. Rounded up to 4096 steps, capped at the provider's
// HONEST served maximum (no YaRN — see the PROVIDERS note in server.mjs).
export function escalateForContext({ contextTokens = 0, numCtx = 0, cap = 40960, reserve = 1024 } = {}) {
  const budget = numCtx || DEFAULT_NUM_CTX;
  if (contextTokens + reserve <= budget) return { escalate: false, numCtx: budget };
  const want = Math.min(Math.ceil((contextTokens + reserve * 2) / 4096) * 4096, cap);
  return {
    escalate: want > budget,
    numCtx: Math.max(want, budget),
    overflowTokens: Math.max(0, contextTokens + reserve - budget),
    atCap: want >= cap && contextTokens + reserve > cap,   // even the cap can't hold it — flag honestly
  };
}

// Self-contained transform asks: the content to work on is IN the prompt, retrieval adds nothing.
export const NO_RETRIEVAL_RE = /^(format|reformat|convert (this|the following)|rewrite (this|the following)|translate (this|the following)|fix the (grammar|spelling|typos)|proofread (this|the following))/i;

// D3: the needs_* fields become pipeline behavior.
//   skipRetrieval — fast mode, an explicit needs_retrieval=false verdict, or a self-contained
//                   transform ask all skip the retrieval pass (pinned/profile memory still loads).
//   attachTools   — tool defs cost prompt tokens on every call; drop them ONLY on fast-mode turns
//                   with no tool-shaped language (conservative bias: everything else keeps tools).
export function consumeNeeds({ mode, needsTools = true, needsRetrieval = true, lastUserText = "" } = {}) {
  const skipRetrieval = mode === "fast" || needsRetrieval === false || NO_RETRIEVAL_RE.test(String(lastUserText).trim());
  const attachTools = mode === "tool" ? true : mode === "fast" ? needsTools === true : true;
  return { skipRetrieval, attachTools };
}
