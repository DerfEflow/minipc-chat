/*
 * Dominion Works push self-test. Run with: node idepush_test.mjs
 * Proves:
 *   1. VAPID keys generate and the JWT VERIFIES against the public key (a signature nobody
 *      checked is not a signature)
 *   2. the JWT is scoped to one push service's origin and expires
 *   3. Fred's escalation ruling holds: questions/completion/failure notify, progress never does
 *   4. wake-ups carry NO body, and dead endpoints (404/410) are reported for pruning
 *   5. subscriptions are per device, capped, and https-only
 */
import assert from "node:assert/strict";
import { createVerify, createPublicKey } from "node:crypto";
import { generateVapidKeys, vapidAuth, escalationFor, createPushStore, sendWakeups } from "./idepush.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const KEYS = generateVapidKeys();

await t("generated keys have the shape the push protocol requires", () => {
  const raw = unb64url(KEYS.publicKey);
  assert.equal(raw.length, 65, "public key must be a 65-byte uncompressed point");
  assert.equal(raw[0], 4, "and start with the 0x04 uncompressed marker");
  assert.equal(unb64url(KEYS.privateKey).length, 32);
});

await t("the VAPID JWT actually VERIFIES against the public key", () => {
  const { Authorization } = vapidAuth({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", ...KEYS, subject: "mailto:f@x.com" });
  const jwt = Authorization.match(/vapid t=([^,]+), k=(.+)$/);
  assert.ok(jwt, "header must be 'vapid t=<jwt>, k=<key>'");
  assert.equal(jwt[2], KEYS.publicKey, "the advertised key must be the one that signed");

  const [h, p, s] = jwt[1].split(".");
  const raw = unb64url(KEYS.publicKey);
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256",
    x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") }, format: "jwk" });
  const v = createVerify("SHA256");
  v.update(h + "." + p);
  v.end();
  assert.equal(v.verify({ key: pub, dsaEncoding: "ieee-p1363" }, unb64url(s)), true, "signature must verify");

  const claims = JSON.parse(unb64url(p).toString("utf8"));
  assert.equal(claims.aud, "https://fcm.googleapis.com", "audience is the push service ORIGIN only");
  assert.equal(claims.sub, "mailto:f@x.com");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), "must not be born expired");
});

await t("a token for one push service is not valid for another", () => {
  const a = vapidAuth({ endpoint: "https://fcm.googleapis.com/fcm/send/x", ...KEYS });
  const b = vapidAuth({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/y", ...KEYS });
  const audOf = (h) => JSON.parse(unb64url(h.Authorization.match(/t=([^,]+)/)[1].split(".")[1]).toString("utf8")).aud;
  assert.notEqual(audOf(a), audOf(b));
  assert.equal(audOf(b), "https://updates.push.services.mozilla.com");
});

await t("ESCALATION (Fred's ruling): questions, completion and failure notify", () => {
  const q = escalationFor({ type: "need_input", question: "Which database should this use?" }, { workspaceName: "Demo" });
  assert.ok(q);
  assert.equal(q.urgency, "high");
  assert.match(q.title, /question/i);
  assert.match(q.body, /Which database/);

  assert.match(escalationFor({ type: "done" }).title, /finished/i);
  assert.equal(escalationFor({ type: "done" }).urgency, "normal", "a finished build is not urgent");
  assert.match(escalationFor({ type: "error", message: "typecheck failed" }).body, /typecheck failed/);
  assert.equal(escalationFor({ type: "error" }).urgency, "high");
});

await t("ESCALATION: routine progress is SILENT, which is the whole point", () => {
  for (const type of ["plan", "move", "file", "diff", "run", "cost", "snapshot", "stopped", "job"]) {
    assert.equal(escalationFor({ type }), null, type + " must never buzz the user's phone");
  }
  assert.equal(escalationFor(null), null);
  assert.equal(escalationFor({}), null);
});

await t("a wake-up carries NO body: the worker fetches live state instead", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { status: 201 }; };
  const r = await sendWakeups({
    subs: [{ endpoint: "https://fcm.googleapis.com/fcm/send/a" }], ...KEYS, fetchImpl, urgency: "high", ttl: 600,
  });
  assert.equal(r.sent, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.body, undefined, "there must be no payload at all");
  assert.equal(seen[0].opts.headers.TTL, "600");
  assert.equal(seen[0].opts.headers.Urgency, "high");
  assert.match(seen[0].opts.headers.Authorization, /^vapid t=/);
});

await t("dead endpoints (404/410) are reported for pruning, not retried forever", async () => {
  const fetchImpl = async (url) => ({ status: url.endsWith("dead") ? 410 : url.endsWith("missing") ? 404 : 201 });
  const r = await sendWakeups({
    subs: [{ endpoint: "https://p.example.com/live" }, { endpoint: "https://p.example.com/dead" }, { endpoint: "https://p.example.com/missing" }],
    ...KEYS, fetchImpl,
  });
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 2);
  assert.deepEqual(r.gone.sort(), ["https://p.example.com/dead", "https://p.example.com/missing"]);
});

await t("one failing device never stops the others from being told", async () => {
  const fetchImpl = async (url) => { if (url.includes("boom")) throw new Error("network down"); return { status: 201 }; };
  const r = await sendWakeups({
    subs: [{ endpoint: "https://p.example.com/boom" }, { endpoint: "https://p.example.com/ok" }], ...KEYS, fetchImpl,
  });
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
});

await t("with no VAPID keys configured it declines honestly instead of pretending", async () => {
  const r = await sendWakeups({ subs: [{ endpoint: "https://p.example.com/x" }], fetchImpl: async () => ({ status: 201 }) });
  assert.equal(r.sent, 0);
  assert.match(r.skipped, /no VAPID keys/);
});

await t("subscriptions are https-only, per device, deduped and capped", () => {
  let disk = { subs: [] };
  const store = createPushStore({ read: () => JSON.parse(JSON.stringify(disk)), write: (s) => { disk = s; }, max: 3 });
  assert.equal(store.add({ endpoint: "http://insecure.example/x" }).code, "bad_subscription");
  assert.equal(store.add({}).code, "bad_subscription");

  store.add({ endpoint: "https://p/1", keys: { p256dh: "a", auth: "b" } }, { label: "laptop" });
  store.add({ endpoint: "https://p/2" }, { label: "phone" });
  assert.equal(store.list().length, 2, "two devices, both kept");
  store.add({ endpoint: "https://p/1" }, { label: "laptop again" });
  assert.equal(store.list().length, 2, "re-subscribing the same device replaces it");
  assert.equal(store.list().find((s) => s.endpoint === "https://p/1").label, "laptop again");

  store.add({ endpoint: "https://p/3" });
  store.add({ endpoint: "https://p/4" });
  assert.equal(store.list().length, 3, "capped");
  assert.ok(!store.list().some((s) => s.endpoint === "https://p/2"), "the oldest device drops off");

  assert.equal(store.prune(["https://p/3"]).removed, 1);
  assert.equal(store.remove("https://p/4").removed, 1);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
