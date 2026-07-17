/*
 * Dominion AI — hands hub (orchestrator side of the Phase-1 MCP hands).
 *
 * Lives inside server.mjs. Hands nodes on Fred's machines dial OUT and hold one SSE stream open
 * per node; the hub pushes jobs down the stream and collects results on POST /hands/result.
 * The orchestrator never reaches into Fred's network — the network path is always node -> hub.
 *
 * Contract:
 *   GET  /hands/stream?node=<name>   (bearer)  long-lived SSE: `job` events + `hb` every 20s
 *   POST /hands/result               (bearer)  { node, jobId, result }
 *   POST /hands/run                  (bearer)  { node, tool, args, timeoutMs } -> the result
 *   GET  /hands/nodes                (bearer)  registry snapshot (no secrets)
 *
 * Guarantees:
 *   - No HANDS_TOKEN configured -> the whole surface answers 503 disabled. Auth exists before the
 *     surface does (L-017's lesson, paid for with Fred's private poem).
 *   - Bearer check is constant-time (timingSafeEqual over a digest — length never leaks).
 *   - The ironclad carve-outs are checked HERE before dispatch as well as on the node. Defense in
 *     depth in both directions.
 *   - A dispatch to a node that is absent, or that misses its deadline, resolves to an honest
 *     { ok:false, offline:true } — never a hang, never a throw (machines.mjs's contract).
 */
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";

// Carve-outs — same list the node enforces (ported verbatim from tools.mjs).
const PROTECTED_RE = [
  /(^|[^a-z0-9])d:[\\/]/i,        // mini-PC D: = the backup SSD
  /app[-_ ]?backups?/i,          // the app-backup system
  /\bdb[-_ ]?backups?\b/i,
  /pg_dump|pg_restore/i,         // dumping/restoring a (prod) DB
];

const sha = (s) => createHash("sha256").update(String(s)).digest();

export function createHandsHub({ token, heartbeatMs = 20000, log = () => {} } = {}) {
  const enabled = !!token;
  const tokenDigest = enabled ? sha(token) : null;
  const nodes = new Map();   // name -> { res, connectedAt, lastSeen, jobsSent, jobsDone }
  const jobs = new Map();    // jobId -> { node, resolve, timer, sentAt }

  function authed(req) {
    if (!enabled) return false;
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) return false;
    return timingSafeEqual(sha(h.slice(7)), tokenDigest);   // digest compare: constant-time, length-safe
  }
  function deny(res) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); }
  function disabled(res) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "hands disabled: no HANDS_TOKEN configured" })); }
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

  function handleStream(req, res, u) {
    if (!enabled) return disabled(res);
    if (!authed(req)) return deny(res);
    const name = String(u.searchParams.get("node") || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
    if (!name) return json(res, 400, { error: "node name required" });
    // One live stream per node: a reconnect replaces the old socket (the old one is dead or dying).
    const prev = nodes.get(name);
    if (prev) { try { prev.res.end(); } catch {} clearInterval(prev.beat); }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("event: hb\ndata: {}\n\n");
    const entry = { res, connectedAt: Date.now(), lastSeen: Date.now(), jobsSent: 0, jobsDone: 0 };
    entry.beat = setInterval(() => { try { res.write("event: hb\ndata: {}\n\n"); } catch {} }, heartbeatMs);
    nodes.set(name, entry);
    log(`hands: node "${name}" connected`);
    req.on("close", () => {
      clearInterval(entry.beat);
      if (nodes.get(name) === entry) nodes.delete(name);
      log(`hands: node "${name}" disconnected`);
    });
  }

  async function handleResult(req, res, body) {
    if (!enabled) return disabled(res);
    if (!authed(req)) return deny(res);
    const { jobId, result, node } = body || {};
    const j = jobs.get(jobId);
    if (!j) return json(res, 200, { ok: false, stale: true });   // deadline already fired — result discarded
    jobs.delete(jobId);
    clearTimeout(j.timer);
    const entry = nodes.get(j.node);
    if (entry) { entry.jobsDone++; entry.lastSeen = Date.now(); }
    j.resolve({ node: node || j.node, ms: Date.now() - j.sentAt, ...((result && typeof result === "object") ? result : { ok: false, error: "malformed result" }) });
    return json(res, 200, { ok: true });
  }

  function dispatch(node, tool, args = {}, { timeoutMs = 60000 } = {}) {
    if (!enabled) return Promise.resolve({ ok: false, error: "hands disabled: no HANDS_TOKEN configured" });
    // Hub-side carve-out check (the node re-checks — defense in depth, both directions).
    const blob = JSON.stringify(args || {});
    for (const re of PROTECTED_RE) {
      if (re.test(blob)) return Promise.resolve({ ok: false, refused: true, reason: "references a protected resource (app backups / customer DB) — hard carve-out, never touched" });
    }
    const entry = nodes.get(String(node || "").toLowerCase());
    if (!entry) return Promise.resolve({ ok: false, offline: true, node, error: `hands node "${node}" is not connected (machine asleep, off, or the node service is down)` });
    const id = "hj_" + randomUUID().slice(0, 12);
    const cap = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 600000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        jobs.delete(id);
        resolve({ ok: false, offline: true, node, timedOut: true, error: `hands node "${node}" did not answer within ${Math.round(cap / 1000)}s` });
      }, cap);
      jobs.set(id, { node: String(node).toLowerCase(), resolve, timer, sentAt: Date.now() });
      entry.jobsSent++;
      try { entry.res.write(`event: job\ndata: ${JSON.stringify({ id, tool, args, deadlineMs: cap })}\n\n`); }
      catch (e) {
        clearTimeout(timer); jobs.delete(id);
        resolve({ ok: false, offline: true, node, error: "the node's stream died mid-dispatch: " + (e && e.message) });
      }
    });
  }

  async function handleRun(req, res, body) {
    if (!enabled) return disabled(res);
    if (!authed(req)) return deny(res);
    const { node, tool, args, timeoutMs } = body || {};
    if (!node || !tool) return json(res, 400, { error: "node and tool required" });
    const r = await dispatch(node, tool, args || {}, { timeoutMs });
    return json(res, 200, r);
  }

  function handleNodes(req, res) {
    if (!enabled) return disabled(res);
    if (!authed(req)) return deny(res);
    return json(res, 200, {
      nodes: [...nodes.entries()].map(([name, n]) => ({ name, connectedAt: n.connectedAt, lastSeen: n.lastSeen, jobsSent: n.jobsSent, jobsDone: n.jobsDone })),
      pendingJobs: jobs.size,
    });
  }

  // Pick a connected node to act on: an explicit preference wins; otherwise prefer an always-on
  // mini-PC name, else the first connected node, else null (no machine available).
  function pick(preferred) {
    const p = String(preferred || "").toLowerCase();
    if (p && nodes.has(p)) return p;
    for (const n of ["mini-pc", "minipc", "mini_pc"]) if (nodes.has(n)) return n;
    const first = nodes.keys().next();
    return first.done ? null : first.value;
  }
  const nodeNames = () => [...nodes.keys()];
  const stats = () => ({ enabled, nodes: nodes.size, pendingJobs: jobs.size });
  return { enabled, handleStream, handleResult, handleRun, handleNodes, dispatch, pick, nodeNames, stats };
}
