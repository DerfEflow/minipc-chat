/*
 * Dominion AI — privacy modes (Phase 2 of the cloud migration).
 *
 * Fred sets the mode. There is NO auto-detection of sensitivity and NO ability for the system to
 * re-route or override his choice. The mode is a hard ALLOW-LIST of which brains may be called;
 * within that allow-list, whatever model Fred picks is used exactly, never substituted. A picked
 * model that the mode disallows is REFUSED with a clear message, never silently swapped.
 *
 *   Normal  (default) : all providers (OpenRouter, DeepSeek, OpenAI direct, Anthropic direct)
 *   Trusted           : direct no-train providers (OpenAI direct, Anthropic direct) ONLY.
 *                       No OpenRouter, no DeepSeek.
 *   Private           : the single-provider lane — Anthropic direct ONLY. One contract, one
 *                       endpoint, the smallest possible set of parties that ever sees a message.
 *                       (Repurposed 2026-07-30 when Local Qwen left the app's picker; it used to
 *                       mean "local only". The local class is still permitted server-side in every
 *                       mode because a non-catalog id never egresses at all.)
 *
 * This module is pure and dependency-light on purpose: the whole privacy guarantee is one small,
 * auditable, unit-tested function. server.mjs enforces it before any egress; the UI mirrors it.
 */
import { isCatalogModel, providerOf } from "./models.catalog.mjs";

export const PRIVACY_MODES = ["normal", "trusted", "private"];
export const DEFAULT_PRIVACY_MODE = "normal";

// The providers that do NOT train on API data and retain briefly / offer ZDR (see
// docs/ACCESS-AND-PRIVACY-DESIGN.md §4). These are the only cloud providers Trusted mode permits.
// "gx10" is Fred's own machine (2026-09-01): tokens never leave hardware he owns, so it belongs
// in every mode by the same logic that admits the local class everywhere.
export const TRUSTED_PROVIDERS = new Set(["openai", "anthropic", "gx10"]);

// Private mode's whole allow-list: one direct no-train provider, so the exposure surface cannot
// get smaller without going to zero. Anthropic because it is the house's deepest-integrated direct
// lane; swapping the single provider is a one-word change here and nowhere else. The GX10 seats
// join because their exposure surface is ZERO third parties, strictly smaller than the lane rule.
export const PRIVATE_PROVIDERS = new Set(["anthropic", "gx10"]);

// Normalize a client-supplied mode to one of the three; anything unrecognized falls back to the
// documented default (Normal). The server is the enforcement point regardless of what the UI sends.
export function normalizeMode(mode) {
  const m = String(mode || "").toLowerCase().trim();
  return PRIVACY_MODES.includes(m) ? m : DEFAULT_PRIVACY_MODE;
}

// Classify a model pick into its egress class:
//   "local"  -> the on-box Qwen path (or any non-catalog id, which server.mjs also runs locally)
//   provider -> a cloud provider string ("openrouter" | "deepseek" | "openai" | "anthropic")
// Mirrors handleChat's own gate: only a catalog model egresses; everything else is local.
export function classifyModel(model) {
  const m = String(model || "").trim();
  if (!m || m === "auto" || m === "local") return "local";
  if (isCatalogModel(m)) return providerOf(m) || "local";
  return "local";   // unknown id -> the local path (an id not in the catalog can never egress)
}

// The one decision. Returns { allowed, modelClass, reason }.
//   - local is allowed in every mode (all three permit the local brain).
//   - a cloud provider is allowed in Normal always; in Trusted only if it is a TRUSTED_PROVIDER;
//     in Private never.
// REFUSE-NOT-SUBSTITUTE: a false result means the server stops and tells Fred, it does NOT swap in
// a different (e.g. local) model behind his back.
export function modeAllows(mode, model) {
  const m = normalizeMode(mode);
  const cls = classifyModel(model);
  if (cls === "local") return { allowed: true, modelClass: "local", reason: "" };
  if (m === "normal") return { allowed: true, modelClass: cls, reason: "" };
  if (m === "private") {
    if (PRIVATE_PROVIDERS.has(cls)) return { allowed: true, modelClass: cls, reason: "" };
    const who = cls === "openrouter" ? "OpenRouter" : cls === "deepseek" ? "DeepSeek" : cls === "openai" ? "OpenAI" : cls;
    return { allowed: false, modelClass: cls, reason: `Private mode is the single-provider lane: Anthropic direct only, one contract and one endpoint. ${who} was refused, not substituted; pick an Anthropic model or switch modes.` };
  }
  // trusted
  if (TRUSTED_PROVIDERS.has(cls)) return { allowed: true, modelClass: cls, reason: "" };
  const nice = cls === "openrouter" ? "OpenRouter" : cls === "deepseek" ? "DeepSeek" : cls;
  return { allowed: false, modelClass: cls, reason: `Trusted mode allows only direct no-train providers (OpenAI, Anthropic) and local models. ${nice} was refused, not substituted; pick an allowed model or switch modes.` };
}

// Convenience for callers that just want to know if a provider (not a specific model) is selectable
// in a mode — used by the UI's picker filter and by /estimate.
export function providerAllowed(mode, provider) {
  const m = normalizeMode(mode);
  if (provider === "local") return true;
  if (m === "normal") return true;
  if (m === "private") return PRIVATE_PROVIDERS.has(provider);
  return TRUSTED_PROVIDERS.has(provider);
}
