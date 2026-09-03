/*
 * Dominion AI — cross-model fallback for the main chat pipeline (lane/chat, deficiency item 6).
 *
 * WHY THIS IS SEPARATE FROM seatfailover.mjs. seatfailover.mjs wraps ONE call and re-posts the
 * SAME work to an alternate WIRE for the SAME model, exactly once — it is BATTALION's fix for "one
 * host, five apparent vendors". This module is the next rung up: when the requested model is
 * unreachable on every wire server.mjs already knows how to try (its own direct key, the
 * OpenRouter fallback, the widen-pool retry, the same-model reroute), the seat itself is declared
 * down and a DIFFERENT model takes over the rest of the turn. That is a bigger decision — the
 * user's answer may now come from a different mind — so it stays out loud (`served` event) and
 * bounded (one hop per call site, so a systemic outage cannot chain through the whole catalog).
 *
 * THE OWNER'S DOCTRINE (AGENT-RULES.md): "nothing may fail to produce a viable result." A model
 * that cannot be reached is not a reason to hand the user a raw provider error; it is a reason to
 * try the next seat that does the same job.
 *
 * SOURCE OF THE MAP. The spec (LANE-chat.md) says a catalog model may later grow its own
 * `m.fallback` field from lane/simplify's work; if present, that wins (it is presumably kept
 * closer to the catalog data and reviewed alongside it). Absent that, CHAT_SEAT_FALLBACKS below is
 * this lane's own map, built from the lane spec's own measured facts: kimi-k3/k2.6 are the same
 * family on the same direct vendor (Moonshot), so a K3 failure that survives the OpenRouter rescue
 * too most likely means the Moonshot ACCOUNT is down, and K2.6 (also Moonshot direct, also
 * OpenRouter-reachable) inherits the same rescue path independently. DeepSeek Pro/Flash are the
 * same vendor's two tiers, each with its OWN OpenRouter-independent direct wire, so a Pro outage
 * that is not a DeepSeek-account problem still has a live neighbor; account-level DeepSeek outages
 * fall through to Moonshot as a second, unrelated vendor. Every entry names a REAL catalog id
 * (never invented) and pickFallbackModel() re-checks that at call time, so a stale or mistyped
 * entry here degrades to "no fallback found" instead of a crash.
 */
import { modelById, isCatalogModel, providerOf } from "./models.catalog.mjs";
import { modeAllows } from "./privacy.mjs";

export const CHAT_SEAT_FALLBACKS = {
  // Moonshot family: K3 (mandatory-reasoning, pricier) <-> K2.6 (no forced reasoning). Both ride
  // Moonshot direct AND OpenRouter independently, so this only fires once BOTH of K3's own wires
  // (direct + the automatic OpenRouter rescue) are already exhausted — a real account-level outage.
  "moonshotai/kimi-k3": "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.6": "deepseek/deepseek-v4-pro",
  // DeepSeek family: Pro <-> Flash, same vendor, same direct wire (deepseek.com) — a DeepSeek
  // account-level outage (insufficient balance, suspended key) takes both down together, so the
  // second hop leaves the vendor entirely rather than trading one DeepSeek seat for another.
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash": "moonshotai/kimi-k2.6",
  // Qwen3 Coder rides OpenRouter (its GX10 twin is a distinct catalog id reached by a different
  // lane's routing, not this fallback ladder) — DeepSeek Pro is the nearest tool-capable coder seat.
  "qwen/qwen3-coder": "deepseek/deepseek-v4-pro",
  // Long-hanging-tail seat named in the deficiency list (minimax-m3 "hangs past 150s with no
  // answer") — its OpenRouter-only wire has no same-model alternate, so the fallback is a
  // different model entirely rather than a dead-end retry on the one wire it has.
  "minimax/minimax-m3": "deepseek/deepseek-v4-flash",
  // Frontier direct seats: OpenAI <-> Anthropic <-> DeepSeek, each a genuinely different vendor so
  // one company's outage (billing hard limit, no credits — both seen in production) cannot strand
  // the turn.
  "openai/gpt-4o": "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-terra": "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5": "openai/gpt-4o",
  "anthropic/claude-opus-4-8": "anthropic/claude-sonnet-5",
  // GX10 relay seats (lane/chat follow-up, 2026-09-03 production evidence: a busy GX10 produced no
  // first token for 150s while the client waited). The relay's own first-token watchdog now hands
  // off here the same way any cloud seat does when it goes quiet -- these targets are cloud models
  // with comparable capability so a queued/unreachable box never strands the turn.
  "gx10/gpt-oss-120b": "deepseek/deepseek-v4-pro",
  "gx10/gpt-oss-20b": "deepseek/deepseek-v4-flash",
  "gx10/qwen3-coder-30b": "deepseek/deepseek-v4-pro",
};

/*
 * One hop, resolved at call time. `tried` is every model already attempted THIS turn (the
 * originally requested one plus any prior fallback), so the ladder can never revisit a seat that
 * already failed or bounce back and forth between two dead models. `privacyMode` is enforced HERE,
 * not left to the caller, because the whole point of Trusted/Private is that nothing routes around
 * it by accident — a fallback that ignored the mode would be exactly the "silent substitution"
 * privacy.mjs's own doctrine forbids.
 */
export function pickFallbackModel(requestedId, { privacyMode = "normal", tried = [] } = {}) {
  const seen = new Set([requestedId, ...tried].filter(Boolean));
  const rec = modelById(requestedId);
  // Prefer a catalog-declared fallback (lane/simplify's future field) over this module's own map,
  // per the spec: "if m.fallback is absent use your own map."
  const candidate = (rec && typeof rec.fallback === "string" && rec.fallback) || CHAT_SEAT_FALLBACKS[requestedId] || "";
  if (!candidate || seen.has(candidate)) return null;
  if (!isCatalogModel(candidate)) return null;   // never invent a model id
  const gate = modeAllows(privacyMode, candidate);
  if (!gate.allowed) return null;                // privacy mode is enforced in the fallback too, never bypassed
  return candidate;
}

// Convenience for callers that want to know the fallback's provider without a second catalog hit.
export const fallbackProviderOf = (id) => providerOf(id);
