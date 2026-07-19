/*
 * Dominion Works: reaching the user when a build needs them.
 *   SOW docs/IDE-MODE-ROADMAP.md (Phase 4.5-4.8) - build pack docs/IDE-MODE-BUILD.md
 *
 * WHY PAYLOAD-FREE PUSH.
 * The Web Push spec lets you encrypt a payload into the notification (RFC 8291: ECDH, HKDF,
 * AES-128-GCM). We deliberately do not. A push here is a WAKE-UP with no content; the service
 * worker then fetches the live job state and writes the notification from that. Three reasons,
 * in order of how much they matter:
 *   1. Honesty. A payload composed 40 seconds ago can arrive after the question was already
 *      answered on another device. Fetching at display time cannot show a stale question.
 *   2. Privacy. Nothing about Fred's builds sits in Google's push queue, encrypted or not.
 *   3. Less crypto to get wrong. VAPID auth alone is a small, well-understood signature.
 *
 * VAPID is still required (push services reject unsigned requests), so this signs an ES256 JWT
 * with node:crypto. No dependencies, matching the rest of the repo.
 *
 * WHAT THIS MODULE WILL NOT DO: it never decides to notify. escalationFor() below encodes Fred's
 * ruling (questions, completion, failure; never routine progress) and the caller obeys it.
 */
import { createSign, createPrivateKey, generateKeyPairSync, createPublicKey } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/*
 * Generate a VAPID key pair. Run once, keep the private key in the wallet and on Railway.
 * Returns raw base64url values, which is the shape the browser's applicationServerKey and the
 * push protocol both expect.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  // Uncompressed point: 0x04 || X || Y
  const raw = Buffer.concat([Buffer.from([4]), unb64url(pubJwk.x), unb64url(pubJwk.y)]);
  return { publicKey: b64url(raw), privateKey: privJwk.d, jwk: { x: pubJwk.x, y: pubJwk.y, d: privJwk.d } };
}

// Rebuild a signing key from the stored raw private scalar plus the public point.
function keyFrom(publicKeyB64, privateKeyB64) {
  const raw = unb64url(publicKeyB64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("VAPID public key must be a 65-byte uncompressed point");
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)), d: privateKeyB64 },
    format: "jwk",
  });
}

/*
 * Build the Authorization header for one push endpoint. The JWT is audience-scoped to the push
 * service's origin and short-lived, so a captured header cannot be replayed at another service or
 * next week.
 */
export function vapidAuth({ endpoint, publicKey, privateKey, subject, now = () => Date.now(), ttlSec = 12 * 3600 }) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64url(JSON.stringify({
    aud,
    exp: Math.floor(now() / 1000) + ttlSec,
    sub: subject || "mailto:fredwolfe@gmail.com",
  }));
  const signer = createSign("SHA256");
  signer.update(header + "." + body);
  signer.end();
  // ieee-p1363 gives the raw r||s the JWS spec wants; the DER default would be rejected.
  const sig = signer.sign({ key: keyFrom(publicKey, privateKey), dsaEncoding: "ieee-p1363" });
  return { Authorization: "vapid t=" + header + "." + body + "." + b64url(sig) + ", k=" + publicKey };
}

/*
 * Fred's escalation ruling, in one place so no caller can quietly invent its own policy:
 * questions, completion, and failure reach the user. Routine per-move progress never does.
 * Returns null when an event must stay silent.
 */
export function escalationFor(event, { workspaceName = "" } = {}) {
  const type = String(event && event.type || "");
  const where = workspaceName ? " in " + workspaceName : "";
  if (type === "need_input") {
    return { urgency: "high", tag: "ide-question",
      title: "Your build has a question",
      body: (event.question ? String(event.question).slice(0, 140) : "It needs an answer to continue") + where };
  }
  if (type === "done") {
    return { urgency: "normal", tag: "ide-done", title: "Build finished", body: "The work is done" + where + "." };
  }
  if (type === "error") {
    return { urgency: "high", tag: "ide-error", title: "Build stopped",
      body: (event.message ? String(event.message).slice(0, 140) : "Something went wrong") + where };
  }
  return null;   // move, plan, file, diff, run, cost, snapshot, stopped: silent by design
}

/*
 * Per-account push subscription store. A subscription is per DEVICE, so the same person can hold
 * one for the laptop and one for the phone and a question reaches both.
 */
export function createPushStore({ read, write, now = () => Date.now(), max = 12 } = {}) {
  if (typeof read !== "function" || typeof write !== "function") throw new Error("createPushStore needs read/write");
  const keyOf = (sub) => String(sub && sub.endpoint || "");
  return {
    list: () => read().subs || [],
    add(sub, { label = "" } = {}) {
      const endpoint = keyOf(sub);
      if (!endpoint || !/^https:\/\//i.test(endpoint)) return { error: "A push subscription needs an https endpoint.", code: "bad_subscription" };
      const s = read();
      s.subs = (s.subs || []).filter((x) => x.endpoint !== endpoint);
      s.subs.push({ endpoint, keys: (sub && sub.keys) || {}, label: String(label).slice(0, 60), addedAt: now() });
      // Oldest device drops off rather than growing without bound.
      if (s.subs.length > max) s.subs = s.subs.slice(-max);
      write(s);
      return { ok: true, count: s.subs.length };
    },
    remove(endpoint) {
      const s = read();
      const before = (s.subs || []).length;
      s.subs = (s.subs || []).filter((x) => x.endpoint !== String(endpoint || ""));
      write(s);
      return { ok: true, removed: before - s.subs.length };
    },
    // A push service answering 404/410 means that device unsubscribed. Prune it rather than
    // retrying forever against an endpoint that is gone for good.
    prune(endpoints) {
      const dead = new Set((endpoints || []).map(String));
      if (!dead.size) return { removed: 0 };
      const s = read();
      const before = (s.subs || []).length;
      s.subs = (s.subs || []).filter((x) => !dead.has(x.endpoint));
      write(s);
      return { removed: before - s.subs.length };
    },
  };
}

/*
 * Send one payload-free wake-up to every device on the account. TTL is short for questions: a
 * question that surfaces two hours late is worse than one that never arrives, because the user
 * acts on it believing the build is still waiting.
 *
 * `fetchImpl` is injected so this is testable without touching the network.
 */
export async function sendWakeups({ subs, publicKey, privateKey, subject, urgency = "normal", ttl = 900,
                                    fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
  const results = { sent: 0, failed: 0, gone: [] };
  if (!publicKey || !privateKey) { results.skipped = "no VAPID keys configured"; return results; }
  for (const sub of subs || []) {
    try {
      const auth = vapidAuth({ endpoint: sub.endpoint, publicKey, privateKey, subject, now });
      const res = await fetchImpl(sub.endpoint, {
        method: "POST",
        headers: {
          ...auth,
          TTL: String(ttl),
          Urgency: urgency,
          // No body at all: the service worker fetches the live state when it wakes.
          "Content-Length": "0",
        },
      });
      if (res.status === 404 || res.status === 410) { results.gone.push(sub.endpoint); results.failed++; continue; }
      if (res.status >= 200 && res.status < 300) { results.sent++; continue; }
      results.failed++;
      log("[ide] push rejected " + res.status + " for " + sub.endpoint.slice(0, 48));
    } catch (e) {
      results.failed++;
      log("[ide] push threw: " + (e && e.message));
    }
  }
  return results;
}
