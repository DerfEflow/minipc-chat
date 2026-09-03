/*
 * hands/hub.mjs liveness self-test - run with: node hands_hub_liveness_test.mjs
 *
 * Covers the streams-lane rewrite of the duplicate-connect decision (deficiency #8/#25): liveness
 * judged by INBOUND evidence (connect / beat / result / chunk), not by whether the hub's own
 * heartbeat write to its local socket succeeded. Drives hub.mjs directly over a bare HTTP server
 * with raw fetch() calls (no real hands.mjs child needed — this test wants precise control over
 * instance tokens and timing that a spawned process would make awkward).
 *
 * Proves:
 *   1. a reconnect presenting the SAME instanceToken preempts the old stream immediately — zero
 *      409s, no lockout window at all (the planned-graceful-re-dial / network-blip-reconnect path)
 *   2. a reconnect with a DIFFERENT token is refused 409 while the current stream has recent
 *      inbound evidence
 *   3. once inbound evidence goes stale, a different-token reconnect IS adopted (no permanent lock)
 *   4. POST /hands/beat advances lastInbound only when its instanceToken matches the registered
 *      stream; a mismatched beat is acknowledged but ignored
 *   5. the stale sweep actively evicts a node whose inbound evidence has gone quiet, even though
 *      its socket never fired "close" — so a subsequent dispatch fails fast (offline:true)
 *   6. GET /hands/nodes reports lastInbound and connected:true, and lastInbound visibly advances
 *      on a beat
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createHandsHub } from "./hands/hub.mjs";

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = "test-hub-liveness-" + Math.random().toString(36).slice(2);

// Fast timings so the suite runs in well under a second instead of real-world minutes.
const hub = createHandsHub({
  token: TOKEN, heartbeatMs: 200,
  recentInboundMs: 300, staleEvictMs: 400, sweepMs: 50,
});
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const body = async () => { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return {}; } };
  if (u.pathname === "/hands/stream") return hub.handleStream(req, res, u);
  if (u.pathname === "/hands/result") return hub.handleResult(req, res, await body());
  if (u.pathname === "/hands/chunk") return hub.handleChunk(req, res, await body());
  if (u.pathname === "/hands/beat") return hub.handleBeat(req, res, await body());
  if (u.pathname === "/hands/nodes") return hub.handleNodes(req, res);
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

// A "connect" that returns the response + an AbortController, without waiting for the stream to
// end (it never does on its own). Mirrors what hands.mjs's openStream() does.
async function connect(node, itok) {
  const ac = new AbortController();
  const r = await fetch(BASE + "/hands/stream?node=" + encodeURIComponent(node) + "&itok=" + encodeURIComponent(itok || ""), {
    headers: { authorization: "Bearer " + TOKEN, accept: "text/event-stream" },
    signal: ac.signal,
  });
  return { r, ac, close: () => { try { ac.abort(); } catch {} } };
}
async function nodesSnapshot() {
  const r = await fetch(BASE + "/hands/nodes", { headers: { authorization: "Bearer " + TOKEN } });
  return r.json();
}
async function beat(node, itok) {
  const r = await fetch(BASE + "/hands/beat", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ node, instanceToken: itok }),
  });
  return r.json();
}
// Reads a connection's raw SSE body until it sees the `job` frame the hub writes on dispatch, and
// returns its parsed { id, tool, args, ... }. Used to simulate a LEGACY node: a real hands.mjs
// would read this same frame and POST the result back; here the test does that POST by hand so it
// controls exactly what the body does and does not contain (e.g. no instanceToken).
async function readJobFrame(bodyStream, timeoutMs = 3000) {
  // Deliberately does NOT cancel the reader on success: cancelling a fetch Response body reader
  // aborts the underlying request, which the hub sees as the node's socket closing — exactly the
  // real disconnect path (req.on("close")). A real hands.mjs keeps its stream open indefinitely
  // after reading one job frame, so this must too, or the test would evict its own "node" by the
  // mere act of reading its stream. Only the give-up (timeout) path releases the reader.
  const reader = bodyStream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const res = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ __timeout: true }), remaining)),
    ]);
    if (res.__timeout || res.done) break;
    buf += dec.decode(res.value, { stream: true });
    const m = buf.match(/data: (\{[^\n]*"id"[^\n]*\})/);
    if (m) return JSON.parse(m[1]);
  }
  try { await reader.cancel(); } catch {}
  return null;
}

// ---- 1. same-token reconnect preempts immediately, zero 409s ----
let firstConn, secondConn;
await t("a reconnect with the SAME instanceToken preempts the old stream with no 409", async () => {
  firstConn = await connect("alpha", "itok-A");
  assert.equal(firstConn.r.status, 200, "first connect must succeed");
  await sleep(20);   // let the entry register
  assert.equal(hub.nodeNames().includes("alpha"), true);

  secondConn = await connect("alpha", "itok-A");   // SAME token — this is "my own process redialing"
  assert.equal(secondConn.r.status, 200, "same-token reconnect must be adopted, never 409");
  await sleep(20);
  assert.equal(hub.nodeNames().length, 1, "still exactly one 'alpha' entry after the handover");

  firstConn.close();
});

// ---- 2. different-token reconnect refused 409 while current stream has recent inbound ----
await t("a reconnect with a DIFFERENT instanceToken is refused 409 while inbound evidence is recent", async () => {
  const rogue = await connect("alpha", "itok-ROGUE");
  assert.equal(rogue.r.status, 409, "a genuinely different process must be refused while the incumbent is provably alive");
  try { await rogue.r.body?.cancel(); } catch {}
  assert.equal(hub.nodeNames().length, 1, "the incumbent (itok-A, second connection) must still be registered");
});

// ---- 3. once inbound evidence goes stale, a different-token reconnect IS adopted ----
await t("a different-token reconnect is adopted once the current stream's inbound evidence is stale", async () => {
  // recentInboundMs=300 and nothing refreshes lastInbound for "alpha" from here (no beats sent) —
  // wait past that window, then the SAME rogue token should be let in as "adopted", not 409.
  await sleep(350);
  const rogue2 = await connect("alpha", "itok-ROGUE");
  assert.equal(rogue2.r.status, 200, "a different token must be adopted once the old stream's evidence is stale, not locked out forever");
  await sleep(20);
  assert.equal(hub.nodeNames().length, 1);
  secondConn.close();
  rogue2.close();
});

// ---- 4. /hands/beat liveness: matched token advances lastInbound, mismatched does not ----
await t("POST /hands/beat advances lastInbound only for a matching instanceToken", async () => {
  const conn = await connect("beta", "itok-B");
  assert.equal(conn.r.status, 200);
  await sleep(20);
  const before = (await nodesSnapshot()).nodes.find((n) => n.name === "beta").lastInbound;
  await sleep(30);

  const wrong = await beat("beta", "itok-WRONG");
  assert.equal(wrong.counted, false, "a beat with the wrong instance token must not count as evidence");
  const afterWrong = (await nodesSnapshot()).nodes.find((n) => n.name === "beta").lastInbound;
  assert.equal(afterWrong, before, "lastInbound must not advance on a mismatched beat");

  const right = await beat("beta", "itok-B");
  assert.equal(right.counted, true, "a beat with the matching instance token must count");
  const afterRight = (await nodesSnapshot()).nodes.find((n) => n.name === "beta").lastInbound;
  assert.ok(afterRight >= before, "lastInbound must advance (or stay, if the clock did not tick) on a matching beat");
  assert.ok(afterRight > before, "lastInbound must genuinely advance on a matching beat: " + before + " -> " + afterRight);

  conn.close();
});

// ---- 5. stale sweep evicts a BEAT-CAPABLE node whose inbound evidence goes quiet, even with no
// "close" (a legacy node with no instanceToken is exempt — see test 5b) ----
await t("the stale sweep evicts a beat-capable node with no recent inbound evidence, socket 'close' or not", async () => {
  const conn = await connect("gamma", "itok-G");
  assert.equal(conn.r.status, 200);
  await sleep(20);
  assert.equal(hub.nodeNames().includes("gamma"), true);

  // Do NOT close the connection and do NOT beat — simulate a tunnel flap where the socket never
  // fires "close" but nothing proves the node is still there. staleEvictMs=400, sweepMs=50.
  await sleep(500);
  assert.equal(hub.nodeNames().includes("gamma"), false, "a node with stale inbound evidence must be actively evicted");

  const dispatched = await hub.dispatch("gamma", "node_info", {}, { timeoutMs: 2000 });
  assert.equal(dispatched.ok, false);
  assert.equal(dispatched.offline, true, "a dispatch to the evicted node must fail FAST as offline, not hang out a timeout");
  conn.close();
});

/*
 * ---- 5b. lead review, 2026-09-03: legacy nodes must be IMMUNE to the stale sweep ----
 * Production still runs hands clients that predate instanceToken/beat entirely: the GX10
 * containers (gx10, gx10-gamefactory), customers' installed nodes (forge-<id>, user:<uid>), and a
 * stale pre-hands/4 laptop copy found running on this machine. None of them will EVER send
 * /hands/beat or connect with an itok — their only inbound evidence is the connect itself plus
 * whatever job traffic happens to flow. If the sweep evicted them on the same clock as a
 * beat-capable node, every legacy node in production would be disconnected once a minute forever.
 */
await t("a legacy node (no instanceToken) is NEVER evicted by the stale sweep, while a beat-capable twin with no beats IS", async () => {
  const legacy = await connect("zeta-legacy", "");             // no itok at all -> legacy contract
  const beatCapable = await connect("zeta-modern", "itok-Z");  // has itok, but never beats after connect
  await sleep(20);
  assert.equal(hub.nodeNames().includes("zeta-legacy"), true);
  assert.equal(hub.nodeNames().includes("zeta-modern"), true);

  // Neither sends a beat and neither closes its socket. staleEvictMs=400, sweepMs=50 — wait well
  // past several sweep cycles.
  await sleep(500);

  assert.equal(hub.nodeNames().includes("zeta-legacy"), true,
    "a legacy (no-instanceToken) node must NEVER be actively evicted by the stale sweep — its only evidence is the connect itself, by design");
  assert.equal(hub.nodeNames().includes("zeta-modern"), false,
    "a beat-capable node that stopped proving liveness must still be evicted");

  legacy.close();
  beatCapable.close();
});

// ---- 5c. lead review: a legacy node's own /hands/result (no instanceToken in the body at all)
// must still advance lastInbound — the job/result channel is inbound evidence in its own right,
// independent of the instanceToken mechanism entirely (see handleResult in hub.mjs). ----
await t("a legacy node's /hands/result, with no instanceToken in the body, still advances lastInbound", async () => {
  const conn = await connect("epsilon", "");   // legacy: connects with no itok
  await sleep(20);
  const before = (await nodesSnapshot()).nodes.find((n) => n.name === "epsilon").lastInbound;
  await sleep(30);

  const dispatchPromise = hub.dispatch("epsilon", "node_info", {}, { timeoutMs: 5000 });
  const job = await readJobFrame(conn.r.body);
  assert.ok(job && job.id, "expected a job frame on the legacy node's stream");

  // A real legacy hands.mjs POSTs exactly this shape: no instanceToken field anywhere.
  const rres = await fetch(BASE + "/hands/result", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ node: "epsilon", jobId: job.id, result: { ok: true, host: "epsilon" } }),
  });
  assert.equal(rres.status, 200);
  const dispatched = await dispatchPromise;
  assert.equal(dispatched.ok, true, "the dispatch must resolve normally from the legacy node's result");

  const after = (await nodesSnapshot()).nodes.find((n) => n.name === "epsilon").lastInbound;
  assert.ok(after > before, "a legacy node's /hands/result must still advance lastInbound: " + before + " -> " + after);
  conn.close();
});

// ---- 6. GET /hands/nodes reports connected + lastInbound ----
await t("GET /hands/nodes reports connected:true and a lastInbound that advances on a beat", async () => {
  const conn = await connect("delta", "itok-D");
  await sleep(20);
  const snap1 = await nodesSnapshot();
  const entry1 = snap1.nodes.find((n) => n.name === "delta");
  assert.ok(entry1, "delta must appear in the registry");
  assert.equal(entry1.connected, true);
  assert.ok(typeof entry1.lastInbound === "number" && entry1.lastInbound > 0);

  await sleep(30);
  await beat("delta", "itok-D");
  const snap2 = await nodesSnapshot();
  const entry2 = snap2.nodes.find((n) => n.name === "delta");
  assert.ok(entry2.lastInbound > entry1.lastInbound, "lastInbound must visibly advance: " + entry1.lastInbound + " -> " + entry2.lastInbound);
  conn.close();
});

server.close();
console.log(`\nhands_hub_liveness_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
