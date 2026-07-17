/*
 * per-user Forge self-test — run: node forge_test.mjs
 * Covers the Forge store (token mint/verify, roots cap, enable) AND the hub's cross-user isolation:
 * a node authenticates under its OWN uid, dispatch reaches only that node, and one user's token can
 * never complete another user's job.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createForgeStore, MAX_ROOTS } from "./forge.mjs";
import { createHandsHub } from "./hands/hub.mjs";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// ---- forge store ----
const dir = mkdtempSync(join(tmpdir(), "forge-"));
const store = createForgeStore({ dir });

await t("token mint + verify round-trips; wrong token is null", () => {
  const tok = store.generateToken("uidA");
  assert.match(tok, /^dfk_[a-f0-9]{48}$/);
  assert.equal(store.verifyToken(tok), "uidA");
  assert.equal(store.verifyToken("dfk_bogus"), null);
  assert.equal(store.verifyToken(""), null);
});
await t("regenerating a token invalidates the old one", () => {
  const t1 = store.generateToken("uidR");
  const t2 = store.generateToken("uidR");
  assert.equal(store.verifyToken(t1), null);
  assert.equal(store.verifyToken(t2), "uidR");
});
await t("roots are capped at MAX_ROOTS and deduped", () => {
  const many = Array.from({ length: 30 }, (_, i) => `C:/folder${i}`);
  const r = store.setRoots("uidA", [...many, "C:/folder0"]);
  assert.equal(r.roots.length, MAX_ROOTS);
  assert.equal(r.capped, true);
  assert.equal(store.getRoots("uidA").length, MAX_ROOTS);
});
await t("enable toggles and status reflects it", () => {
  store.setEnabled("uidA", true);
  assert.equal(store.status("uidA").enabled, true);
  store.setEnabled("uidA", false);
  assert.equal(store.status("uidA").enabled, false);
});

// ---- hub cross-user isolation ----
const authNode = (tok) => (tok === "tokA" ? "uidA" : tok === "tokB" ? "uidB" : null);
const hub = createHandsHub({ token: "SHARED_OWNER", authNode });
const mkStream = (bearer) => {
  const res = { buf: "", writeHead() {}, write(s) { this.buf += s; }, end() {} };
  const req = { headers: { authorization: "Bearer " + bearer }, on() {} };
  return { req, res };
};
const url = new URL("http://x/hands/stream?node=whatever");

await t("each per-user node registers under its OWN uid namespace", () => {
  const a = mkStream("tokA"), b = mkStream("tokB");
  hub.handleStream(a.req, a.res, url);
  hub.handleStream(b.req, b.res, url);
  const names = hub.nodeNames();
  assert.ok(names.includes("user:uida"), "A registered (lowercased namespace)");
  assert.ok(names.includes("user:uidb"), "B registered (lowercased namespace)");
  a._buf = () => a.res.buf; b._buf = () => b.res.buf;
  globalThis.__A = a; globalThis.__B = b;
});
await t("an unauthorized token cannot open a stream", () => {
  const x = mkStream("nope");
  hub.handleStream(x.req, x.res, url);
  assert.ok(!hub.nodeNames().includes("user:undefined"));
});
await t("dispatch to user:uidA reaches A's node only, not B's", async () => {
  const a = globalThis.__A, b = globalThis.__B;
  const beforeB = b.res.buf.length;
  const pending = hub.dispatch("user:uidA", "node_info", {}, { timeoutMs: 3000 });
  const m = a.res.buf.match(/data: (\{[^\n]*"id"[^\n]*\})/);  // the JOB frame (skip the {} heartbeat)
  assert.ok(m, "A received the job frame");
  assert.equal(b.res.buf.length, beforeB, "B received nothing");
  const jobId = JSON.parse(m[1]).id;
  // A completes its own job (its per-user token) -> the dispatch resolves.
  const rres = { code: 0, body: "", writeHead(c) { this.code = c; }, end(s) { this.body = s; } };
  await hub.handleResult({ headers: { authorization: "Bearer tokA" }, on() {} }, rres, { jobId, result: { ok: true, host: "A" } });
  const out = await pending;
  assert.equal(out.ok, true); assert.equal(out.host, "A");
});
await t("user B's token CANNOT complete user A's job (isolation)", async () => {
  const a = globalThis.__A;
  const pending = hub.dispatch("user:uidA", "node_info", {}, { timeoutMs: 1500 });
  const m = [...a.res.buf.matchAll(/data: (\{[^\n]*"id"[^\n]*\})/g)].pop();
  const jobId = JSON.parse(m[1]).id;
  const rres = { code: 0, body: "", writeHead(c) { this.code = c; }, end(s) { this.body = s; } };
  await hub.handleResult({ headers: { authorization: "Bearer tokB" }, on() {} }, rres, { jobId, result: { ok: true, host: "B-attacker" } });
  assert.equal(rres.code, 401, "B's completion is denied");
  const out = await pending;   // A's job still times out honestly (never got B's forged result)
  assert.equal(out.ok, false); assert.equal(out.offline, true);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nforge_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
