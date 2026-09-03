/*
 * Dominion AI — hands hub (orchestrator side of the Phase-1 MCP hands).
 *
 * Lives inside server.mjs. Hands nodes on Fred's machines dial OUT and hold one SSE stream open
 * per node; the hub pushes jobs down the stream and collects results on POST /hands/result.
 * The orchestrator never reaches into Fred's network — the network path is always node -> hub.
 *
 * Contract:
 *   GET  /hands/stream?node=<name>&itok=<instance>   (bearer)  long-lived SSE: `job` events +
 *                                                     `hb` every 10s. `itok` is an opaque token the
 *                                                     node generates once at process start and
 *                                                     resends on every (re)connect — see below.
 *   POST /hands/result               (bearer)  { node, jobId, result, instanceToken? }
 *   POST /hands/chunk                (bearer)  { node, jobId, seq, delta, instanceToken? }
 *   POST /hands/beat                 (bearer)  { node, instanceToken }  liveness ping, no job
 *                                     required — the only inbound evidence during an idle stretch
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
 *
 * LIVENESS IS JUDGED BY INBOUND EVIDENCE (streams lane, stabilization 2026-09-03, deficiency
 * #8/#25). Before this pass, "is this node's stream healthy" was decided by whether the HUB's own
 * write of its heartbeat frame to the LOCAL socket succeeded — which only proves the socket
 * between this process and cloudflared is writable, never that the node on the other end of a
 * tunnel is actually receiving anything. Measured in production: 17-18 minute lockouts on the
 * GX10 node, 36-38 refusals per episode, because a tunnel flap left a "healthy"-looking dead
 * stream occupying the node's name. Every node-name entry now tracks `lastInbound`, advanced only
 * by evidence that actually came FROM the node: the connect itself, a /hands/beat ping, or a
 * result/chunk POST bearing the SAME instanceToken as the currently registered stream. A stale
 * sweep actively evicts an entry whose inbound evidence has gone quiet for STALE_EVICT_MS even if
 * the socket itself never fires "close" (the exact "healthy-looking dead stream" failure mode) —
 * so a dispatch to that node name goes back to `offline:true` FAST instead of waiting out a job
 * timeout against a connection nothing is listening on.
 *
 * THE SWEEP IS BEAT-CAPABLE-ONLY (lead review, 2026-09-03). It never touches an entry that
 * connected with no instanceToken at all. Production still runs hands clients that predate `itok`
 * and /hands/beat entirely — the GX10 containers, customers' installed per-user nodes, and a stale
 * pre-hands/4 laptop copy — and for those the connect itself plus incidental job traffic is the
 * ONLY inbound evidence there will ever be. Sweeping a legacy node on the same clock as a
 * beat-capable one would evict every legacy node once a minute, forever; see sweepStale() below.
 */
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { startSseHeartbeat } from "../sseheartbeat.mjs";

// Carve-outs — same list the node enforces (ported verbatim from tools.mjs).
const PROTECTED_RE = [
  /(^|[^a-z0-9])d:[\\/]/i,        // mini-PC D: = the backup SSD
  /app[-_ ]?backups?/i,          // the app-backup system
  /\bdb[-_ ]?backups?\b/i,
  /pg_dump|pg_restore/i,         // dumping/restoring a (prod) DB
];

const sha = (s) => createHash("sha256").update(String(s)).digest();

// A reconnect presenting the SAME instanceToken as the currently registered stream is, by
// construction, the same physical node process redialing (a network blip, or its own planned
// graceful re-dial ahead of the ~15-minute tunnel churn) — it preempts the old stream immediately,
// no matter how "healthy" that old stream looks. A DIFFERENT token is refused with 409 only while
// the current stream has proven itself alive within this window; once inbound evidence goes
// stale, a differently-tokened reconnect is adopted too (better than a permanent lockout).
const RECENT_INBOUND_MS = 10000;
// A registered node whose inbound evidence (connect / beat / result / chunk, all instanceToken-
// matched) goes quiet for this long is actively evicted, even if its socket never fires "close" —
// the fix for a tunnel flap leaving a dead stream registered as the node's name forever. Sized as
// 3x the node's own /hands/beat cadence (20s) plus margin for one dropped beat.
const STALE_EVICT_MS = 60000;
// How often the stale sweep runs. Independent of heartbeatMs — this is a safety net, not the
// primary keepalive.
const SWEEP_MS = 5000;

export function createHandsHub({
  token, heartbeatMs = 10000, log = () => {}, authNode = null, onConnect = null,
  recentInboundMs = RECENT_INBOUND_MS, staleEvictMs = STALE_EVICT_MS, sweepMs = SWEEP_MS,
} = {}) {
  const enabled = !!token;
  const tokenDigest = enabled ? sha(token) : null;
  // nodeKey -> { res, info, connectedAt, lastSeen, lastInbound, instanceToken, jobsSent, jobsDone,
  //              stopBeat }  (owner: name; user: "user:<uid>")
  const nodes = new Map();
  const dupLogAt = new Map(); // nodeKey -> last time the duplicate-connect refusal was narrated
  const jobs = new Map();    // jobId -> { node, resolve, timer, sentAt }

  const bearer = (req) => { const h = String(req.headers.authorization || ""); return h.startsWith("Bearer ") ? h.slice(7) : ""; };
  function authed(req) {   // the SHARED owner token (constant-time)
    if (!enabled) return false;
    const t = bearer(req); if (!t) return false;
    return timingSafeEqual(sha(t), tokenDigest);
  }
  // Resolve the caller to a node namespace: "owner" for the shared token, "user:<uid>" for a valid
  // per-user Forge token, or null. This is what binds each node connection to exactly one identity, so
  // one user's chat can never reach another user's machine.
  function nodeAuthKey(req) {
    if (authed(req)) return "owner";
    const t = bearer(req);
    const uid = t && authNode ? authNode(t) : null;
    // Lowercase to match dispatch()'s node-key normalization exactly (in prod uid is lowercase hex).
    return uid ? "user:" + String(uid).toLowerCase() : null;
  }
  function deny(res) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); }
  function disabled(res) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "hands disabled: no HANDS_TOKEN configured" })); }
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

  function handleStream(req, res, u) {
    if (!enabled) return disabled(res);
    const authKey = nodeAuthKey(req);
    if (!authKey) return deny(res);
    // Owner token: the node names itself via ?node=. Per-user token: the namespace is forced to the
    // user's uid (they cannot register under an arbitrary name or another user's node).
    let name;
    if (authKey === "owner") {
      name = String(u.searchParams.get("node") || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
      if (!name) return json(res, 400, { error: "node name required" });
    } else {
      name = authKey;   // "user:<uid>"
    }
    // The node generates this ONCE per process lifetime and resends it on every (re)connect — see
    // hands.mjs INSTANCE_TOKEN. It is how the hub tells "my own process, redialing" apart from "a
    // different process that happens to want the same name", which a shared bearer token alone
    // cannot do (every owner-scope node presents the identical HANDS_TOKEN).
    const itok = String(u.searchParams.get("itok") || "").slice(0, 128);
    /*
     * One live stream per node — but WHO wins matters. This used to kick the old socket
     * unconditionally, on the theory that a reconnect means the old one is dead or dying. On
     * 2026-07-30 two laptop clients (a scheduled-task node plus an orphan from an earlier manual
     * start) turned that theory into an eviction war: each connect kicked the other, the kicked one
     * reconnected on its 1s post-success backoff, and the hub logged connect/disconnect every ~1.3s
     * for days. Any job dispatched down the stream died with it — Fred saw "workshop cannot be
     * reached" on adopt.
     *
     * So now (streams lane, 2026-09-03): a reconnect presenting the SAME instanceToken as the
     * currently registered stream is provably the same physical node — it PREEMPTS the old stream
     * immediately, closing it and adopting the new one, with no lockout window at all (this is what
     * makes a planned graceful re-dial gap-free, and what stops a genuine network-blip reconnect
     * from ever hitting 409). A DIFFERENT token (a genuinely separate process — including a stale
     * pre-singleton-lock installer copy that does not know to avoid this) is refused with 409 ONLY
     * while the current stream has inbound evidence from within the last RECENT_INBOUND_MS; once
     * that goes stale the newcomer is adopted too, because a "healthy-looking" write to the hub's
     * own local socket is not evidence the node itself is still there (see file header).
     */
    const prev = nodes.get(name);
    if (prev) {
      const sameProcess = !!(itok && prev.instanceToken && itok === prev.instanceToken);
      const recentInbound = (Date.now() - (prev.lastInbound || prev.connectedAt)) < recentInboundMs;
      if (!sameProcess && recentInbound) {
        /*
         * Log ONCE PER HOUR per node, not once per knock. A stuck twin retries every 30s forever
         * (observed live 2026-09-01: the laptop's orphan filled the entire production log window
         * with this one line), and a log that is 95% one message hides every real failure. The
         * refusal itself still happens on every knock; only the narration is throttled.
         */
        const now = Date.now();
        if (!dupLogAt.has(name) || now - dupLogAt.get(name) > 3600_000) {
          dupLogAt.set(name, now);
          log(`hands: node "${name}" duplicate connect REFUSED (a DIFFERENT process — instance token mismatch — and the live stream has inbound evidence within the last ${Math.round(recentInboundMs / 1000)}s); repeats suppressed for 1h`);
        }
        return json(res, 409, { error: "a live stream for this node already exists; refusing the duplicate" });
      }
      log(`hands: node "${name}" ${sameProcess ? "reconnecting (same instance token — preempting the old stream, no gap)" : "adopted (previous stream's inbound evidence was stale)"}`);
      try { prev.res.end(); } catch {}
      try { prev.stopBeat(); } catch {}
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("event: hb\ndata: {}\n\n");
    // The node's self-description (drives, platform, elevation) rides the connect URL as base64url
    // JSON. It is what the system prompt renders so models know which machine holds which drive —
    // see the ENVIRONMENT block in server.mjs. Untrusted input, so it is parsed defensively and
    // clamped; a malformed blob costs the node its profile, never the connection.
    let info = null;
    try {
      const raw = u.searchParams.get("info");
      if (raw) {
        const o = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
        if (o && typeof o === "object") info = {
          host: String(o.host || "").slice(0, 64),
          platform: String(o.platform || "").slice(0, 16),
          roots: Array.isArray(o.roots) ? o.roots.slice(0, 32).map((s) => String(s).slice(0, 260)) : [],
          elevated: o.elevated === true,
          desktop: o.desktop === true,
          maxAccess: o.maxAccess === true,
        };
      }
    } catch { info = null; }
    const now = Date.now();
    // lastInbound is the CANONICAL liveness signal (see file header): the connect itself counts as
    // inbound evidence, and it advances again only on a matching /hands/beat, /hands/result, or
    // /hands/chunk — never on the hub's own outbound heartbeat write succeeding.
    const entry = { res, info, instanceToken: itok, connectedAt: now, lastSeen: now, lastInbound: now, jobsSent: 0, jobsDone: 0, stopBeat: () => {} };
    entry.stopBeat = startSseHeartbeat(res, { intervalMs: heartbeatMs, frame: "event: hb\ndata: {}\n\n" });
    nodes.set(name, entry);
    log(`hands: node "${name}" connected`);
    try { if (typeof onConnect === "function") onConnect(name); } catch {}
    req.on("close", () => {
      entry.stopBeat();
      if (nodes.get(name) === entry) nodes.delete(name);
      log(`hands: node "${name}" disconnected`);
    });
  }

  // Genuine inbound evidence: only a beat whose instanceToken matches the CURRENTLY registered
  // stream for this name advances lastInbound. A beat from a different (e.g. stale/zombie) process
  // is acknowledged but ignored for liveness — it must not keep a phantom entry looking alive.
  async function handleBeat(req, res, body) {
    if (!enabled) return disabled(res);
    const authKey = nodeAuthKey(req);
    if (!authKey) return deny(res);
    const { node, instanceToken } = body || {};
    const name = authKey === "owner" ? String(node || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64) : authKey;
    const entry = nodes.get(name);
    const matched = !!(entry && instanceToken && entry.instanceToken === String(instanceToken));
    if (matched) { entry.lastInbound = Date.now(); entry.lastSeen = Date.now(); }
    return json(res, 200, { ok: true, counted: matched });
  }

  // A registered node's inbound evidence going stale for staleEvictMs means the stream is exactly
  // the failure mode this file exists to close: it still LOOKS connected (no "close" event has
  // fired — a tunnel flap can leave a socket half-open for a long time) but nothing is actually
  // proving the node on the other end is still there. Evict it so the next dispatch fails fast
  // (offline:true) instead of waiting out a job timeout against a dead stream.
  //
  // BEAT-CAPABLE ONLY (lead review, 2026-09-03). This sweep must NEVER touch a legacy entry that
  // registered with no instanceToken at all: production still runs old hands clients that never
  // send /hands/beat and never mint a token — the GX10 containers (gx10, gx10-gamefactory),
  // customers' installed nodes (forge-<id>, user:<uid>), and the stale Downloads laptop copy
  // (hands/3, see hands.mjs's header note). A legacy node's ONLY inbound evidence is the connect
  // itself plus whatever job result/chunk traffic happens to flow, so it goes quiet for long
  // stretches by design, not because anything is wrong — sweeping it on the same clock as a
  // beat-capable node would evict every legacy node once a minute, forever. A legacy entry keeps
  // the pre-existing contract instead: it lives until its socket fires "close", and the
  // duplicate-connect rule above already adopts a reconnect for it once ITS OWN inbound evidence
  // goes stale (recentInboundMs), so there is no lockout either way.
  function sweepStale() {
    const now = Date.now();
    for (const [name, entry] of [...nodes.entries()]) {
      if (!entry.instanceToken) continue;   // legacy, no beat contract — never actively evicted
      const age = now - (entry.lastInbound || entry.connectedAt);
      if (age <= staleEvictMs) continue;
      try { entry.res.end(); } catch {}
      try { entry.stopBeat(); } catch {}
      nodes.delete(name);
      log(`hands: node "${name}" evicted — no inbound evidence for ${Math.round(age / 1000)}s (the stream looked open but the node stopped proving it is alive)`);
    }
  }
  const staleSweepTimer = setInterval(sweepStale, sweepMs);
  if (typeof staleSweepTimer.unref === "function") staleSweepTimer.unref();

  async function handleResult(req, res, body) {
    if (!enabled) return disabled(res);
    const authKey = nodeAuthKey(req);
    if (!authKey) return deny(res);
    const { jobId, result, node } = body || {};
    const j = jobs.get(jobId);
    if (!j) return json(res, 200, { ok: false, stale: true });   // deadline already fired — result discarded
    // Isolation: a per-user token may only complete jobs dispatched to ITS OWN node.
    if (authKey !== "owner" && j.node !== authKey) return deny(res);
    jobs.delete(jobId);
    clearTimeout(j.timer);
    // A settled result for THIS jobId is inbound evidence in its own right (the id is unguessable
    // and was only ever handed to the one node it was dispatched to) — reuses the existing
    // job/result channel as liveness proof, no separate instanceToken check needed here.
    const entry = nodes.get(j.node);
    if (entry) { entry.jobsDone++; entry.lastSeen = Date.now(); entry.lastInbound = Date.now(); }
    j.resolve({ node: node || j.node, ms: Date.now() - j.sentAt, ...((result && typeof result === "object") ? result : { ok: false, error: "malformed result" }) });
    return json(res, 200, { ok: true });
  }

  /*
   * Streaming, added 2026-07-20. A node emits ordered chunks for a long-running or token-producing
   * tool (Qwen generation, long build output) via POST /hands/chunk, then finishes with the normal
   * /hands/result. Strictly ADDITIVE: a tool that never chunks behaves byte-identically to before,
   * because dispatch() (no onChunk) simply has no chunk sink registered and any stray chunk is
   * dropped harmlessly. seq lets the sink detect a gap; delivery order is the node's contract.
   */
  async function handleChunk(req, res, body) {
    if (!enabled) return disabled(res);
    const authKey = nodeAuthKey(req);
    if (!authKey) return deny(res);
    const { jobId, seq, delta, node } = body || {};
    const j = jobs.get(jobId);
    if (!j) return json(res, 200, { ok: false, stale: true });   // job already settled — chunk ignored
    if (authKey !== "owner" && j.node !== authKey) return deny(res);
    if (j.onChunk) { try { j.onChunk({ seq: Number(seq) || 0, delta: String(delta || "") }); } catch { /* a sink throw must never break the node */ } }
    // A chunk is liveness: push the deadline out so a long stream is not killed mid-flight.
    if (j.timer && j.capMs) { clearTimeout(j.timer); j.timer = setTimeout(() => j.resolve({ ok: false, offline: true, node: j.node, timedOut: true, error: "node went quiet mid-stream" }), j.capMs); }
    if (entryFor(j)) { const e = entryFor(j); e.lastSeen = Date.now(); e.lastInbound = Date.now(); }
    return json(res, 200, { ok: true });
  }
  const entryFor = (j) => nodes.get(j.node);

  /*
   * dispatch now takes an AbortSignal. Before 2026-07-19 it did not, which is precisely why Fred's
   * Stop button "sometimes worked": aborting killed the model stream and the round loop, but a job
   * already handed to a node ran to completion on his machine, up to the 600s ceiling, while the UI
   * had moved on. Stop must reach the machine, not just the conversation.
   */
  /*
   * dispatchStream is the general form. dispatch() below is exactly this with no onChunk sink, so
   * the non-streaming path is byte-for-byte what it was: same carve-out check, same abort wiring,
   * same job/result contract. onChunk (when given) receives {seq, delta} as the node streams, and
   * the final result still arrives via /hands/result to resolve the promise.
   */
  function dispatchStream(node, tool, args = {}, { timeoutMs = 60000, signal = null, onChunk = null } = {}) {
    if (!enabled) return Promise.resolve({ ok: false, error: "hands disabled: no HANDS_TOKEN configured" });
    // Hub-side carve-out check (the node re-checks — defense in depth, both directions).
    const blob = JSON.stringify(args || {});
    for (const re of PROTECTED_RE) {
      if (re.test(blob)) return Promise.resolve({ ok: false, refused: true, reason: "references a protected resource (app backups / customer DB) — hard carve-out, never touched" });
    }
    if (signal && signal.aborted) return Promise.resolve({ ok: false, aborted: true, error: "stopped before dispatch" });
    const entry = nodes.get(String(node || "").toLowerCase());
    if (!entry) return Promise.resolve({ ok: false, offline: true, node, error: `hands node "${node}" is not connected (machine asleep, off, or the node service is down)` });
    const id = "hj_" + randomUUID().slice(0, 12);
    const cap = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 600000);
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (settled) return; settled = true; jobs.delete(id); clearTimeout(job.timer); if (onAbort && signal) { try { signal.removeEventListener("abort", onAbort); } catch {} } resolve(r); };
      const timer = setTimeout(() => done({ ok: false, offline: true, node, timedOut: true, error: `hands node "${node}" did not answer within ${Math.round(cap / 1000)}s` }), cap);

      // Tell the node to kill the work, then stop waiting. We do not wait for the node to confirm:
      // Stop must feel instant, and the node kills its process tree on receipt.
      const onAbort = () => { cancelJob(id, "stopped by the user"); done({ ok: false, aborted: true, node, error: "stopped" }); };
      if (signal) { try { signal.addEventListener("abort", onAbort, { once: true }); } catch {} }

      // capMs is stored so handleChunk can rearm the deadline on each chunk (a long stream is alive).
      const job = { node: String(node).toLowerCase(), resolve: done, timer, capMs: cap, sentAt: Date.now(), tool, onChunk: typeof onChunk === "function" ? onChunk : null };
      jobs.set(id, job);
      entry.jobsSent++;
      try { entry.res.write(`event: job\ndata: ${JSON.stringify({ id, tool, args, deadlineMs: cap, stream: !!onChunk })}\n\n`); }
      catch (e) { done({ ok: false, offline: true, node, error: "the node's stream died mid-dispatch: " + (e && e.message) }); }
    });
  }
  // The original signature, unchanged for every existing caller: no streaming sink.
  function dispatch(node, tool, args = {}, opts = {}) {
    return dispatchStream(node, tool, args, { ...opts, onChunk: null });
  }

  // Push a cancel down the node's stream. The node kills the matching child process tree.
  function cancelJob(id, reason = "cancelled") {
    const j = jobs.get(id);
    if (!j) return false;
    const entry = nodes.get(j.node);
    if (entry) { try { entry.res.write(`event: cancel\ndata: ${JSON.stringify({ id, reason })}\n\n`); } catch { /* stream already gone */ } }
    return true;
  }

  /*
   * FIRE ALARM. Kill everything in flight, across every node at once. Owner scope pulls the whole
   * board; a per-user scope pulls only that user's own node, so a guest hitting their alarm can
   * never stop Fred's work or another guest's.
   */
  function cancelAll({ scope = "owner", reason = "fire alarm" } = {}) {
    let killed = 0;
    for (const [id, j] of [...jobs.entries()]) {
      if (scope !== "owner" && j.node !== String(scope).toLowerCase()) continue;
      cancelJob(id, reason);
      j.resolve({ ok: false, aborted: true, node: j.node, error: reason });
      killed++;
    }
    // Belt and braces: tell every node in scope to kill anything it is still running, even jobs the
    // hub has already given up on (a timed-out dispatch leaves the node's child very much alive).
    for (const [name, entry] of nodes.entries()) {
      if (scope !== "owner" && name !== String(scope).toLowerCase()) continue;
      try { entry.res.write(`event: cancel\ndata: ${JSON.stringify({ id: "*", reason })}\n\n`); } catch {}
    }
    return { killed, nodes: [...nodes.keys()].filter((n) => scope === "owner" || n === String(scope).toLowerCase()) };
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
      // connected is always true for an entry in this map (a stale one is actively evicted by the
      // sweep, not merely marked) — included explicitly so a caller never has to infer it from
      // array membership. lastInbound is the genuine liveness clock (see file header).
      nodes: [...nodes.entries()].map(([name, n]) => ({ name, connected: true, connectedAt: n.connectedAt, lastSeen: n.lastSeen, lastInbound: n.lastInbound || n.connectedAt, jobsSent: n.jobsSent, jobsDone: n.jobsDone, info: n.info || null })),
      pendingJobs: jobs.size,
    });
  }

  // Pick a connected node to act on. An explicit preference wins when it is connected. Otherwise
  // return the node whose stream last did something (heartbeat, job result, or chunk) — this is
  // the "currently active" machine when the owner has more than one hands node live. The old bias
  // toward a "mini-pc" name meant every chat routed to the mini-PC whenever it was up, so a
  // co-registered laptop was never reachable through the chat path — that hardcode is gone.
  function pick(preferred) {
    const p = String(preferred || "").toLowerCase();
    if (p && nodes.has(p)) return p;
    let best = null, bestSeen = -1;
    for (const [name, n] of nodes) {
      const seen = n.lastSeen || 0;
      if (seen > bestSeen) { best = name; bestSeen = seen; }
    }
    return best;
  }
  const nodeNames = () => [...nodes.keys()];
  // name -> self-description, for the ENVIRONMENT block in the system prompt and for path-based
  // routing (which machine actually holds F:\ ?). Only nodes that reported a profile appear.
  const nodeInfo = () => {
    const out = {};
    for (const [name, n] of nodes) if (n.info) out[name] = n.info;
    return out;
  };
  // Which connected node owns this absolute path? Returns "" when no node claims it, or when more
  // than one does (C:\ exists on both machines, so it can never pin a target on its own).
  function nodeForPath(p) {
    const t = String(p || "").trim().toLowerCase();
    if (!t) return "";
    const hits = [];
    for (const [name, n] of nodes) {
      const roots = (n.info && Array.isArray(n.info.roots)) ? n.info.roots : [];
      for (const r of roots) {
        const root = String(r || "").trim().toLowerCase();
        if (root && t.startsWith(root.length > 3 ? root : root.slice(0, 3))) { hits.push(name); break; }
      }
    }
    return hits.length === 1 ? hits[0] : "";
  }
  const stats = () => ({ enabled, nodes: nodes.size, pendingJobs: jobs.size });
  return { enabled, handleStream, handleResult, handleChunk, handleBeat, handleRun, handleNodes, dispatch, dispatchStream, cancelJob, cancelAll, pick, nodeNames, nodeInfo, nodeForPath, stats };
}
