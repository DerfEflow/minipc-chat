/*
 * The Google connect/disconnect round trip, kept honest (Fred, live, 2026-07-30).
 *
 * The live failure: Disconnect wrote an EMPTY OBJECT over the token file, and `connected()` was
 * `!!loadTok(T)`. In JavaScript `!!{}` is true, so a disconnected account still reported itself
 * connected. The Setup card kept offering Test and Disconnect and NEVER offered Connect again, so
 * the OAuth reconnect path was unreachable from the interface: Fred clicked Disconnect, the tool
 * switched off, he switched it back on, and the card still said Disconnect. A Google account he
 * believed he had reconnected had in fact been impossible to reconnect.
 *
 * Everything below drives the REAL public surface (authUrl -> handleCallback -> connected ->
 * disconnect) with only globalThis.fetch stubbed, so no test-only hook exists in the product.
 *
 * Run: node google_connect_test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleProvider } from "./google.mjs";

let passed = 0, failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); } };

const dir = mkdtempSync(join(tmpdir(), "google-connect-"));
const T = { isOwner: true, uid: "owner" };
// Plain-text enc/dec keeps these tests about the connection lifecycle rather than the cipher.
const provider = () => createGoogleProvider({
  dir,
  cfgGet: (k, d) => ({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret" }[k] ?? d),
  baseUrl: () => "https://app.example", enc: (s) => s, dec: (s) => s,
});

const realFetch = globalThis.fetch;
const stub = (handler) => { globalThis.fetch = handler; };
const restore = () => { globalThis.fetch = realFetch; };
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

// Complete a real OAuth grant: the state comes from authUrl, the exchange from the stub.
async function grant(g, { expiresIn = 3600 } = {}) {
  const state = new URL(g.authUrl(T)).searchParams.get("state");
  stub(async () => jsonRes({ access_token: "a1", refresh_token: "r1", expires_in: expiresIn }));
  const r = await g.handleCallback(new URLSearchParams({ state, code: "authcode" }));
  restore();
  assert.equal(r.ok, true, "the OAuth callback should have stored a token: " + JSON.stringify(r));
}

await t("a fresh install reports NOT connected", () => {
  assert.equal(provider().connected(T), false);
});

await t("a completed grant reads as connected", async () => {
  const g = provider();
  await grant(g);
  assert.equal(g.connected(T), true);
  g.disconnect(T);
});

await t("THE BUG: disconnect must let Connect be offered again", async () => {
  const g = provider();
  await grant(g);
  assert.equal(g.connected(T), true);
  g.disconnect(T);
  assert.equal(g.connected(T), false,
    "after Disconnect the Setup card must offer Connect, never Test/Disconnect forever");
});

await t("disconnect leaves no stale token file behind", async () => {
  const g = provider();
  await grant(g);
  g.disconnect(T);
  const cxDir = join(dir, "connectors");
  const left = existsSync(cxDir) ? readdirSync(cxDir).filter((f) => f.includes("google")) : [];
  assert.deepEqual(left, [], "the file must be gone, not blanked: " + JSON.stringify(left));
});

await t("a permanently revoked refresh clears the credential and says so", async () => {
  const g = provider();
  await grant(g, { expiresIn: -10 });            // already expired, so the next call must refresh
  assert.equal(g.connected(T), true);
  stub(async () => jsonRes({ error: "invalid_grant", error_description: "Token has been expired or revoked." }));
  const out = await g.call(T, "drive_search", { query: "anything" });
  restore();
  assert.match(String(out), /revoked or expired/i, "the user must be told what actually happened");
  assert.match(String(out), /Reconnect Google in Setup/i, "and what to do about it");
  assert.equal(g.connected(T), false, "a dead credential must stop claiming a connection");
});

await t("a TRANSIENT refresh failure keeps the credential", async () => {
  const g = provider();
  await grant(g, { expiresIn: -10 });
  stub(async () => jsonRes({ error: "backendError", error_description: "try again later" }));
  const out = await g.call(T, "drive_search", { query: "anything" });
  restore();
  assert.match(String(out), /token refresh failed/i);
  assert.equal(g.connected(T), true, "a passing blip must never log the user out");
  g.disconnect(T);
});

await t("an empty token object is not a connection", async () => {
  const g = provider();
  // Reproduce the old disconnect exactly: a grant, then a blanked token written the old way.
  await grant(g);
  const state = new URL(g.authUrl(T)).searchParams.get("state");
  stub(async () => jsonRes({ access_token: "", refresh_token: "", expires_in: 0 }));
  await g.handleCallback(new URLSearchParams({ state, code: "x" }));   // refused, token untouched
  restore();
  g.disconnect(T);
  assert.equal(g.connected(T), false);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log("\ngoogle connect: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
