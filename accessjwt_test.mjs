/*
 * Cloudflare Access JWT verification - including the exact attack that got through today.
 * Run: node accessjwt_test.mjs
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createPublicKey } from "node:crypto";
import { createAccessVerifier } from "./accessjwt.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok - " + name); }
  catch (e) { fail++; console.log("  FAIL - " + name + "\n        " + (e.message || e)); }
}

const TEAM = "test-team.cloudflareaccess.com";
const AUD = "aud-main-app";
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Two key pairs: the "real" team key and an attacker's key.
const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const evil = generateKeyPairSync("rsa", { modulusLength: 2048 });
// generateKeyPairSync returns KeyObjects; a public KeyObject exports to JWK directly
// (passing it back through createPublicKey throws "expected private").
const jwkOf = (pub, kid) => ({ ...pub.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });

let jwksHits = 0;
const fakeFetch = async () => { jwksHits++; return { json: async () => ({ keys: [jwkOf(good.publicKey, "kid-1")] }) }; };

function mint({ key = good.privateKey, kid = "kid-1", alg = "RS256", claims = {}, sig = null }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ aud: AUD, iss: "https://" + TEAM, iat: now - 10, exp: now + 3600, email: "guest@example.com", sub: "u1", ...claims }));
  if (sig) return `${header}.${payload}.${sig}`;
  const s = createSign("RSA-SHA256"); s.update(`${header}.${payload}`); s.end();
  return `${header}.${payload}.${b64url(s.sign(key))}`;
}
const V = (mode = "prefer") => createAccessVerifier({ teamDomain: TEAM, aud: AUD, mode, fetchImpl: fakeFetch });
const reqOf = (headers) => ({ headers });

console.log("accessjwt_test:");

await t("valid token verifies and yields the email from signed claims", async () => {
  const r = await V().verify(mint({}));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.email, "guest@example.com");
  assert.equal(r.identity, "user");
});

await t("THE ATTACK: forged header with NO jwt is refused in enforce mode", async () => {
  const id = await V("enforce").identify(reqOf({ "cf-access-authenticated-user-email": "fredwolfe@gmail.com" }));
  assert.equal(id.email, "", "forged header must not yield an identity");
  assert.equal(id.verified, false);
  assert.match(id.reason, /no Access JWT/);
});

await t("attacker-signed token is rejected (signature checked against the team JWKS)", async () => {
  const r = await V().verify(mint({ key: evil.privateKey, claims: { email: "fredwolfe@gmail.com" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad signature");
});

await t("alg:none / unsigned token rejected", async () => {
  const r = await V().verify(mint({ alg: "none", sig: "" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /alg|malformed/);
});

await t("tampered payload rejected (claims swapped after signing)", async () => {
  const tok = mint({});
  const [h, , s] = tok.split(".");
  const evilPayload = b64url(JSON.stringify({ aud: AUD, iss: "https://" + TEAM, exp: Math.floor(Date.now() / 1000) + 3600, email: "fredwolfe@gmail.com" }));
  const r = await V().verify(`${h}.${evilPayload}.${s}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad signature");
});

await t("expired token rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await V().verify(mint({ claims: { iat: now - 7200, exp: now - 60 } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

await t("audience mismatch rejected (a token for another Access app)", async () => {
  const r = await V().verify(mint({ claims: { aud: "aud-some-other-app" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "audience mismatch");
});

await t("issuer mismatch rejected", async () => {
  const r = await V().verify(mint({ claims: { iss: "https://evil.cloudflareaccess.com" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "issuer mismatch");
});

await t("unknown signing key rejected", async () => {
  const r = await V().verify(mint({ kid: "kid-unknown" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown signing key");
});

await t("SERVICE TOKEN never resolves to a human account", async () => {
  const r = await V().verify(mint({ claims: { email: undefined, common_name: "dominion-minipc-node" } }));
  assert.equal(r.ok, true);
  assert.equal(r.identity, "service");
  assert.equal(r.email, "", "a service token must never carry a user email");
  const id = await V("enforce").identify(reqOf({ "cf-access-jwt-assertion": mint({ claims: { email: undefined, common_name: "dominion-minipc-node" } }) }));
  assert.equal(id.email, "", "service identity must not become a user");
  assert.equal(id.source, "service");
});

await t("REJECTED jwt never silently downgrades to the header", async () => {
  // Sending garbage alongside a forged header must NOT fall back to header trust.
  const id = await V("prefer").identify(reqOf({
    "cf-access-jwt-assertion": mint({ key: evil.privateKey }),
    "cf-access-authenticated-user-email": "fredwolfe@gmail.com",
  }));
  assert.equal(id.email, "", "a bad token must not fall back to the header");
  assert.equal(id.source, "rejected");
});

await t("prefer mode: verified JWT wins over a conflicting header", async () => {
  const id = await V("prefer").identify(reqOf({
    "cf-access-jwt-assertion": mint({ claims: { email: "real@example.com" } }),
    "cf-access-authenticated-user-email": "fredwolfe@gmail.com",
  }));
  assert.equal(id.email, "real@example.com");
  assert.equal(id.verified, true);
  assert.equal(id.source, "jwt");
});

await t("prefer mode: no JWT falls back to the header (migration path)", async () => {
  const id = await V("prefer").identify(reqOf({ "cf-access-authenticated-user-email": "fred@example.com" }));
  assert.equal(id.email, "fred@example.com");
  assert.equal(id.verified, false);
  assert.equal(id.source, "header");
});

await t("off mode: header only (devboot rig + tests keep working)", async () => {
  const id = await V("off").identify(reqOf({ "cf-access-authenticated-user-email": "owner@dev.local" }));
  assert.equal(id.email, "owner@dev.local");
  assert.equal(id.source, "header");
});

await t("JWKS is cached, and an unknown kid does not let a bad token hammer Cloudflare", async () => {
  jwksHits = 0;
  const v = V();
  await v.verify(mint({}));
  await v.verify(mint({}));
  await v.verify(mint({}));
  assert.equal(jwksHits, 1, "expected a single JWKS fetch across valid verifications");
  await v.verify(mint({ kid: "nope-1" }));
  await v.verify(mint({ kid: "nope-2" }));
  assert.ok(jwksHits <= 2, "unknown kids must be rate-limited to one forced refetch, saw " + jwksHits);
});

await t("health() reports JWKS load + identity-source counts (the enforce-flip evidence)", async () => {
  const v = V("prefer");
  await v.identify(reqOf({ "cf-access-jwt-assertion": mint({}) }));                          // jwt
  await v.identify(reqOf({ "cf-access-authenticated-user-email": "fred@example.com" }));      // header
  await v.identify(reqOf({ "cf-access-jwt-assertion": mint({ key: evil.privateKey }) }));     // rejected
  const h = v.health();
  assert.equal(h.mode, "prefer");
  assert.equal(h.teamDomain, TEAM);
  assert.ok(h.keys > 0, "keys must be loaded; 0 means the team domain is wrong");
  assert.equal(h.stats.jwt, 1);
  assert.equal(h.stats.header, 1);
  assert.equal(h.stats.rejected, 1);
  assert.equal(h.stats.lastReject, "bad signature");
});

await t("a wrong team domain surfaces as keys:0 rather than silent failure", async () => {
  const bad = createAccessVerifier({ teamDomain: "wrong-name.cloudflareaccess.com", aud: AUD, mode: "prefer",
    fetchImpl: async () => ({ json: async () => { throw new Error("Unexpected token '<'"); } }) });
  const r = await bad.verify(mint({}));
  assert.equal(r.ok, false);
  const h = bad.health();
  assert.equal(h.keys, 0, "keys:0 is the signal that the JWKS never loaded");
  assert.ok(h.stats.jwksErrors > 0);
});

await t("malformed inputs rejected without throwing", async () => {
  const v = V();
  for (const bad of ["", "a", "a.b", "a.b.c.d", "...", null, undefined, 42, "not.a.jwt"]) {
    const r = await v.verify(bad);
    assert.equal(r.ok, false);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
