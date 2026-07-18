/*
 * Dominion AI - Cloudflare Access JWT verification.
 *
 * WHY THIS EXISTS (2026-07-18). Until now the app took a caller's identity from the raw
 * `cf-access-authenticated-user-email` header with no verification at all. That made network
 * topology the ONLY thing standing between the internet and owner privileges: anything reaching the
 * container outside the Cloudflare tunnel could set one header and become Fred. That is exactly what
 * happened when a stray Railway service domain was generated - a forged header returned
 * `isOwner: true` from the public internet.
 *
 * Cloudflare Access also sends `Cf-Access-Jwt-Assertion`, an RS256 JWT signed by the team's keys.
 * This module verifies that signature, the audience tag, and expiry, and hands back the email from
 * the VERIFIED claims. Identity now rests on a signature instead of on a hostname.
 *
 * Zero npm dependencies: Node's built-in crypto verifies RS256 against the JWKS.
 *
 * Modes (ACCESS_JWT):
 *   "enforce" - a valid JWT is REQUIRED for identity. Header-only callers are anonymous. (production)
 *   "prefer"  - verify when a JWT is present, fall back to the header when absent. (migration/default)
 *   "off"     - header only. The local devboot rig and tests use this.
 */
import { createPublicKey, createVerify } from "node:crypto";

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const decodeJson = (seg) => { try { return JSON.parse(b64urlToBuf(seg).toString("utf8")); } catch { return null; } };

export function createAccessVerifier({ teamDomain, aud, mode = "prefer", fetchImpl = fetch, now = () => Date.now() }) {
  const TEAM = String(teamDomain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const AUDS = (Array.isArray(aud) ? aud : String(aud || "").split(",")).map((a) => a.trim()).filter(Boolean);
  const MODE = ["enforce", "prefer", "off"].includes(mode) ? mode : "prefer";
  const certsUrl = () => `https://${TEAM}/cdn-cgi/access/certs`;

  let keys = new Map();          // kid -> KeyObject
  let fetchedAt = 0, inflight = null;
  // Observed identity sources. This is the evidence for flipping mode to "enforce": if real traffic
  // shows jwt>0 and header==0 for human requests, enforcing costs nobody their access.
  const stats = { jwt: 0, header: 0, rejected: 0, service: 0, none: 0, lastReject: "", lastJwtAt: 0, jwksErrors: 0 };
  const TTL_MS = 60 * 60 * 1000;   // refresh the JWKS hourly
  const MIN_REFETCH_MS = 60 * 1000; // floor on unknown-kid refetches, so a bad token can't hammer CF

  async function loadKeys(force = false) {
    if (!TEAM) return keys;
    const age = now() - fetchedAt;
    if (!force && keys.size && age < TTL_MS) return keys;
    if (force && age < MIN_REFETCH_MS) return keys;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await fetchImpl(certsUrl(), { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const next = new Map();
        for (const k of (j.keys || [])) {
          if (!k.kid || k.kty !== "RSA" || !k.n || !k.e) continue;
          try { next.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" })); } catch {}
        }
        if (next.size) { keys = next; fetchedAt = now(); }
      } catch (e) {
        stats.jwksErrors++;
        console.log("[access] JWKS fetch failed:", String(e && e.message || e).slice(0, 120));
      } finally { inflight = null; }
      return keys;
    })();
    return inflight;
  }

  // Verify a raw JWT string. Returns { ok, email, reason }.
  async function verify(token) {
    if (!token || typeof token !== "string") return { ok: false, reason: "no token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed token" };
    const header = decodeJson(parts[0]), payload = decodeJson(parts[1]);
    if (!header || !payload) return { ok: false, reason: "unparseable token" };
    if (header.alg !== "RS256") return { ok: false, reason: "unexpected alg " + header.alg };

    let ks = await loadKeys();
    let key = ks.get(header.kid);
    if (!key) { ks = await loadKeys(true); key = ks.get(header.kid); }   // key rotation: one forced refetch
    if (!key) return { ok: false, reason: "unknown signing key" };

    const v = createVerify("RSA-SHA256");
    v.update(parts[0] + "." + parts[1]);
    v.end();
    if (!v.verify(key, b64urlToBuf(parts[2]))) return { ok: false, reason: "bad signature" };

    const t = Math.floor(now() / 1000);
    if (typeof payload.exp === "number" && t >= payload.exp) return { ok: false, reason: "expired" };
    if (typeof payload.nbf === "number" && t < payload.nbf - 60) return { ok: false, reason: "not yet valid" };
    if (typeof payload.iat === "number" && t < payload.iat - 300) return { ok: false, reason: "issued in the future" };

    if (AUDS.length) {
      const claimed = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!claimed.some((a) => AUDS.includes(a))) return { ok: false, reason: "audience mismatch" };
    }
    if (TEAM && payload.iss && payload.iss.replace(/^https?:\/\//, "").replace(/\/+$/, "") !== TEAM) {
      return { ok: false, reason: "issuer mismatch" };
    }

    // Service tokens carry `common_name` and no email. They are a legitimate Access identity, and
    // they are NOT a user: never let one resolve to a human account (that is how a node token would
    // become the owner). Callers get identity:"service" and must handle it explicitly.
    const email = String(payload.email || "").trim().toLowerCase();
    if (!email) {
      return payload.common_name
        ? { ok: true, identity: "service", commonName: String(payload.common_name), email: "" }
        : { ok: false, reason: "no email claim" };
    }
    return { ok: true, identity: "user", email, sub: payload.sub || "" };
  }

  // The request-level decision. Returns the email the app should treat as the caller, or "".
  //   enforce: only a verified JWT yields an email.
  //   prefer : verified JWT wins; a REJECTED jwt yields nothing (never silently downgrade to the
  //            header, or forging becomes trivial again by sending garbage); absent jwt falls back.
  //   off    : header only.
  async function identify(req) {
    const hdrEmail = String((req.headers && req.headers["cf-access-authenticated-user-email"]) || "").trim().toLowerCase();
    if (MODE === "off") return { email: hdrEmail, source: "header", verified: false };
    const token = (req.headers && (req.headers["cf-access-jwt-assertion"] || req.headers["Cf-Access-Jwt-Assertion"])) || "";
    if (!token) {
      if (MODE === "enforce") { stats.none++; return { email: "", source: "none", verified: false, reason: "no Access JWT" }; }
      if (hdrEmail) stats.header++;
      return { email: hdrEmail, source: "header", verified: false };
    }
    const r = await verify(token);
    if (!r.ok) { stats.rejected++; stats.lastReject = r.reason; return { email: "", source: "rejected", verified: false, reason: r.reason }; }
    if (r.identity === "service") { stats.service++; return { email: "", source: "service", verified: true, commonName: r.commonName }; }
    stats.jwt++; stats.lastJwtAt = now();
    // A verified JWT whose email disagrees with the header means something is rewriting headers.
    if (hdrEmail && hdrEmail !== r.email) console.log(`[access] header/JWT email mismatch (${hdrEmail} vs verified) - trusting the JWT`);
    return { email: r.email, source: "jwt", verified: true };
  }

  return {
    verify, identify, mode: MODE, ready: () => !!TEAM,
    // Health + evidence for the enforce decision. keys>0 means the JWKS actually loaded, which is
    // the check that would have caught the wrong team domain before it shipped.
    health: () => ({ mode: MODE, teamDomain: TEAM, audCount: AUDS.length, keys: keys.size,
                     keysFetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null, stats: { ...stats } }),
    _loadKeys: loadKeys, _keyCount: () => keys.size,
  };
}
