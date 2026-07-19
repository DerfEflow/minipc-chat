/*
 * Dominion Works (IDE mode).
 *   SOW:        docs/IDE-MODE-ROADMAP.md
 *   Build pack: docs/IDE-MODE-BUILD.md
 *
 * Phase 0 lands only the exposure gate. The workspace registry, job spine, router, and build
 * engine arrive in Phases 2-5; they get dependency-injected the same way images.mjs is, so this
 * module stays free of node/http/provider imports and testable without a server.
 *
 * The gate exists so every later phase can deploy to the LIVE container while remaining invisible
 * to guests. Fred's ruling 2026-07-19: guests stay dark until Phase 8 (hardening), so the default
 * is owner-only.
 */

export const IDE_MODE_DEFAULT = "owner";

/*
 * Parse an IDE_MODE value into a gate.
 *   "owner" (default): Fred only
 *   "all" | "1":      every signed-in user (anon is never allowed)
 *   "off" | "0":      nobody
 *
 * An unrecognized value falls back to owner-only. A flag we cannot read must never WIDEN
 * exposure: the failure mode of a typo in a Railway env var is "Fred still sees it", never
 * "every guest just got a build surface".
 */
export function createIdeGate(raw) {
  const mode = String(raw ?? IDE_MODE_DEFAULT).trim().toLowerCase();
  const nobody = mode === "off" || mode === "0";
  const everyone = mode === "all" || mode === "1";
  return {
    mode,
    everyone,
    nobody,
    allowed(T) {
      if (nobody) return false;
      if (!T || T.role === "anon") return false;
      if (everyone) return true;
      return T.isOwner === true;
    },
  };
}
