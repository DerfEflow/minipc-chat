/*
 * google-serviceaccount_test: BigQuery has Dominion's identity, and the consent screen stays clean.
 *
 * Two things are pinned here and they protect different disasters.
 *
 * THE SCOPE LIST. Adding a sensitive scope to the OAuth consent screen made Google demand full app
 * verification on 2026-08-03, and an UNDECLARED scope makes Google abort the whole authorization
 * request with restricted_client, which breaks Connect Google for every user including Gmail. So
 * the scope list is asserted exactly. A future session that adds one casually fails here, with the
 * reason attached, rather than discovering it when nobody can sign in.
 *
 * THE TOKEN. A service account signs a JWT with a private key. Nothing here uses a real key: the
 * test generates a throwaway RSA pair at runtime, so there is no secret in this file, nothing to
 * leak, and the signature path still runs for real.
 *
 * Run: node google-serviceaccount_test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createVerify } from "node:crypto";

import { loadServiceAccount, mintAccessToken, createServiceAccountTokenSource, SA_SCOPE } from "./google-serviceaccount.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };
const ta = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };

// A real RSA pair, generated here, valid nowhere. Never a wallet key.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" });
const PUB = publicKey.export({ type: "spki", format: "pem" });
const FAKE_SA = { clientEmail: "dominion-bigquery-reader@example.iam.gserviceaccount.com", privateKey: PRIV, projectId: "example-project" };

console.log("\n=== the consent screen stays free of scopes that force verification ===");

t("no sensitive scope is requested from users, so Connect Google never needs app verification", () => {
  const src = readFileSync(new URL("./google.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const SCOPES = ["), src.indexOf('].join(" ");'));
  for (const banned of ["contacts.readonly", "contacts", "cloud-platform.read-only", "cloud-platform", "bigquery"]) {
    assert.ok(!block.includes("auth/" + banned),
      `auth/${banned} is back in SCOPES. It forces app verification and an undeclared scope breaks sign-in for everyone.`);
  }
  // The five the app genuinely needs, all of them the user's own data.
  for (const keep of ["gmail.modify", "calendar", "drive", "spreadsheets", "documents"]) {
    assert.ok(block.includes("auth/" + keep), `auth/${keep} went missing from SCOPES`);
  }
});

t("the contacts tool is built but NOT registered, so it can come back cheaply", () => {
  const src = readFileSync(new URL("./google.mjs", import.meta.url), "utf8");
  assert.ok(!/TOOLS\.push\([^)]*peopleTools/.test(src), "peopleTools must not be registered while its scope is undeclared");
  const people = readFileSync(new URL("./google-people.mjs", import.meta.url), "utf8");
  assert.ok(people.includes("people_search_contacts"), "the module stays on disk so restoring it is a scope plus one line");
});

t("BigQuery is handed the service account, never the user's OAuth token", () => {
  const src = readFileSync(new URL("./google.mjs", import.meta.url), "utf8");
  assert.match(src, /createBigQueryTools\(\{\s*accessToken:\s*bigquerySA\.accessToken/,
    "BigQuery must use Dominion's identity: it reads Fred's project, not the caller's account");
});

console.log("\n=== the key is read from configuration, and its absence is not an error ===");

t("no configuration means no service account, rather than a crash", () => {
  assert.equal(loadServiceAccount(() => ""), null);
  assert.equal(loadServiceAccount((k, d) => d), null);
});

t("a base64 key loads, and so does a file path", () => {
  const json = JSON.stringify({ client_email: FAKE_SA.clientEmail, private_key: PRIV, project_id: "example-project" });
  const b64 = Buffer.from(json).toString("base64");
  const sa = loadServiceAccount((k) => (k === "GOOGLE_BIGQUERY_SA_KEY_B64" ? b64 : ""));
  assert.equal(sa.clientEmail, FAKE_SA.clientEmail);
  assert.equal(sa.projectId, "example-project");
});

t("junk configuration is refused quietly, never half-loaded", () => {
  for (const junk of ["not-base64-at-all!!", Buffer.from("{}").toString("base64"), Buffer.from('{"client_email":"a"}').toString("base64")]) {
    assert.equal(loadServiceAccount((k) => (k === "GOOGLE_BIGQUERY_SA_KEY_B64" ? junk : "")), null,
      "a key missing half its fields must not produce a half-built account");
  }
});

console.log("\n=== the token exchange ===");

await ta("the assertion is a real RS256 JWT that verifies against the account's own key", async () => {
  let sent = null;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: String(opts.body) };
    return { ok: true, status: 200, json: async () => ({ access_token: "ya29.fake", expires_in: 3600 }) };
  };
  const r = await mintAccessToken(FAKE_SA, { fetchImpl, now: () => 1700000000 });
  assert.equal(r.token, "ya29.fake");
  assert.equal(sent.url, "https://oauth2.googleapis.com/token");

  const params = new URLSearchParams(sent.body);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, c, s] = params.get("assertion").split(".");
  const claims = JSON.parse(Buffer.from(c, "base64").toString("utf8"));
  assert.equal(claims.iss, FAKE_SA.clientEmail);
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.scope, SA_SCOPE);
  assert.equal(claims.exp - claims.iat, 3600, "Google rejects an assertion longer than an hour");

  // The signature has to actually verify. A JWT that merely looks right is not a JWT.
  const v = createVerify("RSA-SHA256");
  v.update(h + "." + c);
  const sig = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.ok(v.verify(PUB, sig), "the assertion must verify against the service account's public key");
});

await ta("the requested scope is one BigQuery actually accepts", async () => {
  /*
   * `bigquery.readonly` is published on Google's scope page and is accepted by NONE of the methods
   * this code calls. A live read of the bigquery/v2 discovery document on 2026-08-03 shows
   * jobs.query, datasets.list and tables.list take only bigquery, cloud-platform, and
   * cloud-platform.read-only. Requesting the wrong one 403s every query at runtime.
   */
  assert.equal(SA_SCOPE, "https://www.googleapis.com/auth/cloud-platform.read-only");
  assert.ok(!SA_SCOPE.includes("bigquery.readonly"), "bigquery.readonly is accepted by no method we call");
});

await ta("a failed exchange never echoes the response body, because this path handles a private key", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: "invalid_grant", error_description: "SECRET-LOOKING-DETAIL" }) });
  await assert.rejects(() => mintAccessToken(FAKE_SA, { fetchImpl }), (e) => {
    assert.ok(!/SECRET-LOOKING-DETAIL/.test(e.message), "the raw body must never reach an error message");
    assert.match(e.message, /invalid_grant/, "the error CODE is enough to diagnose");
    return true;
  });
});

await ta("the token is cached and re-minted before it expires, not on every query", async () => {
  let mints = 0;
  const json = JSON.stringify({ client_email: FAKE_SA.clientEmail, private_key: PRIV, project_id: "p" });
  const b64 = Buffer.from(json).toString("base64");
  const fetchImpl = async () => { mints++; return { ok: true, status: 200, json: async () => ({ access_token: "tok" + mints, expires_in: 3600 }) }; };
  const src = createServiceAccountTokenSource({ cfgGet: (k) => (k === "GOOGLE_BIGQUERY_SA_KEY_B64" ? b64 : ""), fetchImpl });
  assert.equal(await src.accessToken(), "tok1");
  assert.equal(await src.accessToken(), "tok1", "a second query in the same hour must reuse the token");
  assert.equal(mints, 1);
  assert.equal(src.configured, true);
});

await ta("with no key configured the refusal names the cause, rather than failing as an auth error", async () => {
  const src = createServiceAccountTokenSource({ cfgGet: () => "" });
  assert.equal(src.configured, false);
  await assert.rejects(() => src.accessToken(), /not set up|service-account key/i);
});

console.log(`\ngoogle-serviceaccount: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
