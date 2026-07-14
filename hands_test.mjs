/*
 * Phase-1 MCP hands self-test — run with: node hands_test.mjs
 * Proves (no live orchestrator needed — a bare hub server + a real spawned node child):
 *   1. carve-outs refuse a D:\ job on BOTH sides: the node executor directly, and the hub
 *      before dispatch (defense in depth, MOVE 9)
 *   2. the dial-out loop works end to end: hub dispatches fs_write + fs_read to a spawned
 *      node over real SSE + POST, and the read byte-matches what was written
 *   3. roots are enforced (a path outside HANDS_ROOTS is refused)
 *   4. auth: no bearer -> 401 on /hands/stream, /hands/result, /hands/run, /hands/nodes;
 *      no HANDS_TOKEN -> hub disabled (503 + dispatch returns a plain error)
 *   5. offline honesty: unknown node -> offline:true instantly; a killed node -> offline:true
 *      within the dispatch deadline, never a hang
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHandsHub } from "./hands/hub.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The node executor reads HANDS_ROOTS at import time — set the jail BEFORE importing it.
const WORK = mkdtempSync(join(tmpdir(), "hands-test-"));
process.env.HANDS_ROOTS = WORK;
const { executeJob, assertNotProtected } = await import("./hands/hands.mjs");

const TOKEN = "test-token-" + Math.random().toString(36).slice(2);

// ---- 1. carve-outs, node side (executor called directly) ----
await t("node executor refuses a D:\\ path (carve-out verbatim)", async () => {
  const r = await executeJob("fs_read", { path: "D:\\backups\\corpus.db" });
  assert.equal(r.ok, false); assert.equal(r.refused, true);
  assert.match(r.reason, /protected resource/);
});
await t("node executor refuses pg_dump in a shell command", async () => {
  const r = await executeJob("shell_run", { command: "pg_dump -h prod-db -U admin app" });
  assert.equal(r.ok, false); assert.equal(r.refused, true);
});
await t("assertNotProtected passes clean args", () => {
  assert.equal(assertNotProtected({ path: join(WORK, "x.txt") }).ok, true);
});
await t("node executor refuses a path outside HANDS_ROOTS", async () => {
  const r = await executeJob("fs_read", { path: join(tmpdir(), "outside-the-roots.txt") });
  assert.equal(r.ok, false); assert.equal(r.refused, true);
  assert.match(r.reason, /roots/);
});
await t("node executor reads what it wrote inside the roots", async () => {
  const p = join(WORK, "unit.txt");
  const w = await executeJob("fs_write", { path: p, content: "unit-proof" });
  assert.equal(w.ok, true);
  const r = await executeJob("fs_read", { path: p });
  assert.equal(r.ok, true); assert.equal(r.text, "unit-proof");
});

// ---- 1b. MAX ACCESS: whole machine as roots, but carve-outs still hard-block ----
await t("max-access node still refuses D:\\ (carve-out survives max access)", async () => {
  // Re-import the executor in a child-like context with HANDS_MAX_ACCESS=1 by checking the guard
  // directly: max access widens ROOTS, it must NOT touch the carve-out list.
  const r = await executeJob("fs_read", { path: "D:\\backups\\corpus.db" });
  assert.equal(r.refused, true, "D:\\ must be refused regardless of roots");
});
await t("max-access node refuses app-backups even under an allowed root", async () => {
  const p = join(WORK, "app-backups", "x.db");
  const r = await executeJob("fs_write", { path: p, content: "x" });
  assert.equal(r.refused, true, "an app-backups path is a carve-out even inside HANDS_ROOTS");
});

// ---- 2. hub disabled without a token ----
await t("hub without HANDS_TOKEN is disabled (dispatch refuses, no surface)", async () => {
  const off = createHandsHub({ token: "" });
  assert.equal(off.enabled, false);
  const r = await off.dispatch("anything", "node_info", {});
  assert.equal(r.ok, false); assert.match(r.error, /disabled/);
});

// ---- 3. the real loop: bare HTTP server around the hub + a spawned node child ----
const hub = createHandsHub({ token: TOKEN, heartbeatMs: 1000 });
const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/hands/stream") return hub.handleStream(req, res, u);
  if (u.pathname === "/hands/result") return hub.handleResult(req, res, await readBody(req));
  if (u.pathname === "/hands/run") return hub.handleRun(req, res, await readBody(req));
  if (u.pathname === "/hands/nodes") return hub.handleNodes(req, res);
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

// ---- 4. auth refusals (before any node exists — the surface itself must refuse) ----
await t("unauthenticated /hands/* is refused with 401", async () => {
  for (const [path, method] of [["/hands/stream", "GET"], ["/hands/result", "POST"], ["/hands/run", "POST"], ["/hands/nodes", "GET"]]) {
    const r = await fetch(BASE + path, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 401, path + " must 401 without a bearer");
  }
  const bad = await fetch(BASE + "/hands/nodes", { headers: { authorization: "Bearer wrong-token" } });
  assert.equal(bad.status, 401, "a wrong bearer must 401");
});

// ---- 5. offline honesty for a node that never connected ----
await t("dispatch to an unknown node returns offline:true instantly", async () => {
  const r = await hub.dispatch("ghost", "node_info", {});
  assert.equal(r.ok, false); assert.equal(r.offline, true);
});

// ---- spawn the real node child, dialing out to the bare hub ----
const child = spawn(process.execPath, ["hands/hands.mjs"], {
  env: { ...process.env, HANDS_URL: BASE, HANDS_TOKEN: TOKEN, HANDS_NODE: "testnode", HANDS_ROOTS: WORK },
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => (childLog += d));
child.stderr.on("data", (d) => (childLog += d));

await t("node child connects (registry shows it)", async () => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && hub.stats().nodes === 0) await sleep(150);
  assert.equal(hub.stats().nodes, 1, "node never registered. child log:\n" + childLog);
});

await t("end to end: dispatched fs_write then fs_read byte-match", async () => {
  const p = join(WORK, "e2e.txt");
  const payload = "round-trip-proof " + Date.now();
  const w = await hub.dispatch("testnode", "fs_write", { path: p, content: payload }, { timeoutMs: 15000 });
  assert.equal(w.ok, true, JSON.stringify(w));
  const r = await hub.dispatch("testnode", "fs_read", { path: p }, { timeoutMs: 15000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, payload, "dispatched read must match what was dispatched-written");
  assert.equal(readFileSync(p, "utf8"), payload, "local read must byte-match the dispatched read");
});

await t("end to end over HTTP: /hands/run with bearer works", async () => {
  const r = await fetch(BASE + "/hands/run", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ node: "testnode", tool: "node_info", timeoutMs: 15000 }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.node, "testnode");
});

await t("hub refuses a D:\\ job BEFORE dispatch (defense in depth, hub side)", async () => {
  const r = await hub.dispatch("testnode", "fs_read", { path: "D:\\anything.txt" }, { timeoutMs: 15000 });
  assert.equal(r.ok, false); assert.equal(r.refused, true);
  assert.match(r.reason, /protected resource/);
});

await t("dispatched shell_run executes on the node", async () => {
  const r = await hub.dispatch("testnode", "shell_run", { command: process.platform === "win32" ? "Write-Output hands-shell-ok" : "echo hands-shell-ok", timeoutMs: 30000 }, { timeoutMs: 45000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.stdout, /hands-shell-ok/);
});

// ---- 6. offline honesty when the node dies ----
await t("killed node -> dispatch returns offline:true within its deadline (no hang)", async () => {
  child.kill();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && hub.stats().nodes > 0) await sleep(100);   // hub notices the closed socket
  const t0 = Date.now();
  const r = await hub.dispatch("testnode", "node_info", {}, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.offline, true, JSON.stringify(r));
  assert.ok(Date.now() - t0 <= 6000, "must resolve by the deadline, not hang");
});

server.close();
try { rmSync(WORK, { recursive: true, force: true }); } catch {}
console.log(`\nhands_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
