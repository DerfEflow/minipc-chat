/*
 * Dominion AI — OpenRouter model capability cache (lane/chat, required behavior #2).
 *
 * THE LIVE FAILURE this closes (production usage log): "OpenRouter: No endpoints found that
 * support tool use. Try disabling 'deck_list_projects'..." on nousresearch/hermes-4-70b. Confirmed
 * live 2026-09-03 against https://openrouter.ai/api/v1/models: hermes-4-70b's own
 * `supported_parameters` genuinely omits "tools" — this is not a transient host hiccup, it is a
 * model that cannot take tools on OpenRouter AT ALL, so retrying (on the same wire, a widened pool,
 * or any of it) never helps. server.mjs already carries a REACTIVE recovery for exactly this error
 * string ("Safety net for catalog drift": try once, catch the refusal, resend without tools) — this
 * module makes the common case PROACTIVE instead, so that recovery stays the rare backstop it was
 * meant to be rather than firing on every single hermes turn.
 *
 * Cached for one hour (the spec's own number): OpenRouter's roster changes slowly, a fetch failure
 * degrades to "unknown -> assume tools work" (refusing tools on a model that actually has them is a
 * worse failure than an occasional avoidable round-trip), and the cache warms itself in the
 * background rather than ever blocking a turn on a cold-cache network round-trip.
 */
import https from "node:https";

const CACHE_MS = 60 * 60 * 1000;
let cache = null;         // Map<slug, Set<supported_parameter>>
let cacheAt = 0;
let inFlight = null;

function fetchModelsRaw(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };
    try {
      const req = https.get("https://openrouter.ai/api/v1/models", { timeout: timeoutMs }, (resp) => {
        if (resp.statusCode && resp.statusCode >= 400) { resp.resume(); return done(null); }
        let buf = ""; resp.on("data", (d) => (buf += d));
        resp.on("end", () => { try { done(JSON.parse(buf)); } catch { done(null); } });
        resp.on("error", () => done(null));
      });
      req.on("error", () => done(null));
      req.on("timeout", () => { try { req.destroy(); } catch {} done(null); });
    } catch { done(null); }
  });
}

function ensureCache() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const d = await fetchModelsRaw();
    if (d && Array.isArray(d.data)) {
      const next = new Map();
      for (const m of d.data) {
        if (m && typeof m.id === "string") next.set(m.id, new Set(Array.isArray(m.supported_parameters) ? m.supported_parameters : []));
      }
      cache = next; cacheAt = Date.now();
    } else if (!cache) {
      cache = new Map();   // fetch failed and nothing has ever succeeded — empty cache reads as "unknown" for every slug
    }
    inFlight = null;
    return cache;
  })();
  return inFlight;
}

// Kick the cache off in the background. Fire-and-forget by design: a caller in the middle of a chat
// turn must never wait on this — it warms the cache for the NEXT lookup, never the current one.
export function warmOpenRouterCapabilities() { ensureCache().catch(() => {}); }

// Awaited form, for a caller that genuinely has nothing better to do while it settles (tests, an
// offline audit). Same null-means-unknown contract as the sync form below.
export async function openRouterSupportsTools(slug) {
  const c = await ensureCache();
  if (!c.has(slug)) return null;
  return c.get(slug).has("tools");
}

// Synchronous, no network wait — the hot-path read for the chat pipeline. Returns true (confirmed
// tools support), false (confirmed no tools support), or null (never fetched successfully yet, or
// this slug is not in OpenRouter's own catalog listing). null MUST be treated as "assume yes": this
// cache existing at all is a latency optimization, never a new way to refuse a working model.
export function openRouterSupportsToolsCached(slug) {
  if (!cache || !cache.has(slug)) return null;
  return cache.get(slug).has("tools");
}

// Test-only: force a cold, empty state between test files that each want their own fetch mock.
export function __resetOpenRouterCapabilityCache() { cache = null; cacheAt = 0; inFlight = null; }
// Test-only: seed the cache directly, skipping the network entirely.
export function __seedOpenRouterCapabilityCache(entries) {
  cache = new Map(Object.entries(entries || {}).map(([id, params]) => [id, new Set(params)]));
  cacheAt = Date.now();
}
