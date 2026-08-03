/*
 * A Google access token that belongs to DOMINION rather than to a user.
 *
 * WHY THIS EXISTS. BigQuery reads Fred's own cloud data. It is not the user's information, so
 * asking every user to consent to it was the wrong model from the start, and it had a real cost:
 * adding `cloud-platform.read-only` to the OAuth consent screen made Google demand app
 * verification, which means a privacy policy, a demo video, domain verification and weeks of
 * review, for a feature that never touches a user's account. A service account is its own identity.
 * No consent screen, no verification, no user interaction, and it works the moment it is created.
 *
 * WHAT LIMITS IT IS IAM, NOT THE SCOPE. The token requests `cloud-platform.read-only` because a
 * live read of the bigquery/v2 discovery document on 2026-08-03 shows `jobs.query`,
 * `datasets.list` and `tables.list` accept only `bigquery`, `cloud-platform` and
 * `cloud-platform.read-only`. The published-looking `bigquery.readonly` is accepted by none of
 * them. That scope is broad by name, so the actual boundary is the two roles the account is
 * granted: BigQuery Data Viewer and BigQuery Job User. Both are read-only. Granting this account
 * anything beyond those two roles widens what a model can reach, so do not.
 *
 * WHERE THE KEY LIVES. Never in the repo, never in a chat, never in a log. Either:
 *   GOOGLE_BIGQUERY_SA_KEY_FILE  an absolute path to the downloaded JSON key
 *   GOOGLE_BIGQUERY_SA_KEY_B64   the same JSON, base64 encoded, for hosts with no writable disk
 * Railway takes the base64 form. A local box is easier with the file.
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Broad by name, narrowed by the IAM roles on the account. See the header.
export const SA_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Read the service-account JSON from wherever it is configured.
 * Returns null when nothing is configured, which is the normal state on a box that never uses
 * BigQuery. A missing key is not an error, it just means the tools stay unavailable.
 */
export function loadServiceAccount(cfgGet = (k, d) => process.env[k] ?? d) {
  const b64 = String(cfgGet("GOOGLE_BIGQUERY_SA_KEY_B64", "") || "").trim();
  const path = String(cfgGet("GOOGLE_BIGQUERY_SA_KEY_FILE", "") || "").trim();
  let raw = "";
  try {
    if (b64) raw = Buffer.from(b64, "base64").toString("utf8");
    else if (path) raw = readFileSync(path, "utf8");
    else return null;
  } catch { return null; }

  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || !j.client_email || !j.private_key) return null;
  // project_id is optional here: a caller may name a different project explicitly per query.
  return { clientEmail: j.client_email, privateKey: j.private_key, projectId: j.project_id || "" };
}

/**
 * Mint an access token by signing a JWT and exchanging it. Google's documented
 * jwt-bearer flow: sign {iss, scope, aud, exp, iat} with the account's private key.
 */
export async function mintAccessToken(sa, { fetchImpl = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const iat = now();
  const exp = iat + 3600;   // Google rejects an assertion longer than one hour.
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.clientEmail, scope: SA_SCOPE, aud: TOKEN_URL, exp, iat,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(header + "." + claims);
  const sig = b64url(signer.sign(sa.privateKey));
  const assertion = header + "." + claims + "." + sig;

  const r = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  /*
   * Report the failure WITHOUT the body. Google's token errors are terse and safe, but this path
   * handles a private key, and a habit of echoing a response that touched one is how a key reaches
   * a log. The status and the error code are enough to diagnose.
   */
  if (!r.ok || !j.access_token) {
    const code = (j && j.error) ? String(j.error).slice(0, 60) : "no access_token";
    throw new Error(`service account token exchange failed (HTTP ${r.status}, ${code})`);
  }
  return { token: j.access_token, expiresAt: (now() + Number(j.expires_in || 3600)) * 1000 };
}

/**
 * A cached token source shaped like the per-user `accessToken(T)` the Google tools already take,
 * so the BigQuery tools need no change to accept it. The tenant argument is ignored on purpose:
 * this identity is Dominion's, and it is the same one whoever is asking.
 *
 * Re-minted a minute before expiry, so a token never goes stale mid-query.
 */
export function createServiceAccountTokenSource({ cfgGet, fetchImpl, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const sa = loadServiceAccount(cfgGet);
  let cached = null;
  const configured = !!sa;

  const accessToken = async () => {
    if (!sa) throw new Error("BigQuery is not set up on this server: no service-account key is configured.");
    if (cached && cached.expiresAt - 60000 > Date.now()) return cached.token;
    cached = await mintAccessToken(sa, { fetchImpl, now });
    return cached.token;
  };

  return { accessToken, configured, projectId: sa ? sa.projectId : "", clientEmail: sa ? sa.clientEmail : "" };
}
