/*
 * Dominion AI — chatjobs: the DURABLE half of the chat-job system (server.mjs holds the live half).
 *
 * Why this exists (Fred's 18-hour-run spec): a /chat turn must survive a client that disappears for
 * hours, a chat switch, an app reload, AND a server restart/redeploy. The in-RAM CHAT_JOBS map can
 * only ever be a reconnect window — this store is the source of truth once RAM can't answer:
 *   - every job gets a row at birth (identity-scoped: one user can never attach to another's job)
 *   - every SSE event lands here in BATCHES (coalesce-at-flush, below), so an in-flight run's
 *     partial output survives a hard crash minus at most the last flush window (~2s of tokens)
 *   - finished-but-uncollected answers persist for weeks, not the 45-minute RAM window; the client
 *     acknowledges delivery via collect(), which starts the (much shorter) retention clock
 *   - at boot, sweepOrphans() turns rows a dead process left 'running' into honest 'orphaned'
 *     results: partial text + a server_restart error + stopped, never a silent disappearance
 *
 * Token batching: an 18h cloud run can emit hundreds of thousands of token deltas; a row per delta
 * is absurd write amplification, and rewriting one growing blob is O(n^2). Middle path: events
 * buffer in RAM and flush as ONE transaction (2s timer / 64 pending / any structural event / job
 * end), with each contiguous run of token deltas collapsed into a single row whose `span` records
 * how many live events it covers. The client's parser concatenates deltas, so a replayed "fat"
 * delta reconstitutes the text exactly. `working` heartbeats are NOT persisted (pure liveness
 * noise; seq numbering keeps counting them, so gaps in stored seqs are normal and harmless).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// How long a collected job's bare row lingers after its events are deleted (debug/inbox history).
const ROW_LINGER_MS = 7 * 86400000;

// Collapse a flush batch into storable rows: token runs merge into one row (span = run length),
// structural events store as-is, `working` heartbeats drop (seq still advances past them).
export function coalesceEvents(events, startSeq) {
  const rows = [];
  let seq = startSeq, run = null;   // run = { seq, span, delta } for the open token run
  const closeRun = () => { if (run) { rows.push({ seq: run.seq, span: run.span, ev: { type: "token", delta: run.delta } }); run = null; } };
  for (const ev of events) {
    if (ev && ev.type === "token") {
      if (run) { run.span++; run.delta += ev.delta || ""; }
      else run = { seq, span: 1, delta: ev.delta || "" };
    } else {
      closeRun();
      if (ev && ev.type !== "working") rows.push({ seq, span: 1, ev });
    }
    seq++;
  }
  closeRun();
  return rows;
}

export function createChatJobs({ dir, now = Date.now }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "chatjobs.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    chatId      TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    uid         TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'running',
    startedAt   INTEGER NOT NULL,
    endedAt     INTEGER NOT NULL DEFAULT 0,
    collectedAt INTEGER NOT NULL DEFAULT 0,
    model       TEXT NOT NULL DEFAULT '',
    mode        TEXT NOT NULL DEFAULT '',
    eventCount  INTEGER NOT NULL DEFAULT 0,
    textChars   INTEGER NOT NULL DEFAULT 0,
    meta        TEXT NOT NULL DEFAULT '' )`);
  db.exec("CREATE INDEX IF NOT EXISTS jobs_by_email ON jobs(email, status)");
  db.exec("CREATE INDEX IF NOT EXISTS jobs_by_chat ON jobs(chatId)");
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    jobId TEXT NOT NULL,
    seq   INTEGER NOT NULL,
    span  INTEGER NOT NULL DEFAULT 1,
    ev    TEXT NOT NULL,
    PRIMARY KEY (jobId, seq) ) WITHOUT ROWID`);

  const q = {
    ins: db.prepare("INSERT OR REPLACE INTO jobs (id,chatId,email,uid,status,startedAt) VALUES (?,?,?,?,'running',?)"),
    get: db.prepare("SELECT * FROM jobs WHERE id=?"),
    bind: db.prepare("UPDATE jobs SET chatId=CASE WHEN ?<>'' THEN ? ELSE chatId END, model=CASE WHEN ?<>'' THEN ? ELSE model END, mode=CASE WHEN ?<>'' THEN ? ELSE mode END WHERE id=?"),
    prog: db.prepare("UPDATE jobs SET eventCount=?, textChars=? WHERE id=?"),
    fin: db.prepare("UPDATE jobs SET status=?, endedAt=?, meta=? WHERE id=?"),
    coll: db.prepare("UPDATE jobs SET collectedAt=? WHERE id=? AND collectedAt=0"),
    evIns: db.prepare("INSERT OR REPLACE INTO events (jobId,seq,span,ev) VALUES (?,?,?,?)"),
    evAll: db.prepare("SELECT seq,span,ev FROM events WHERE jobId=? ORDER BY seq"),
    evFrom: db.prepare("SELECT seq,span,ev FROM events WHERE jobId=? AND seq+span>? ORDER BY seq"),
    evDel: db.prepare("DELETE FROM events WHERE jobId=?"),
    listAll: db.prepare("SELECT id,chatId,status,startedAt,endedAt,collectedAt,model,mode,eventCount,textChars FROM jobs WHERE email=? ORDER BY startedAt DESC LIMIT ?"),
    listChat: db.prepare("SELECT id,chatId,status,startedAt,endedAt,collectedAt,model,mode,eventCount,textChars FROM jobs WHERE email=? AND chatId=? ORDER BY startedAt DESC LIMIT ?"),
    running: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE email=? AND status='running'"),
    runningAll: db.prepare("SELECT * FROM jobs WHERE status='running'"),
    del: db.prepare("DELETE FROM jobs WHERE id=?"),
    collectedOld: db.prepare("SELECT id, collectedAt FROM jobs WHERE collectedAt>0 AND collectedAt<?"),
    uncollectedOld: db.prepare("SELECT id FROM jobs WHERE collectedAt=0 AND status<>'running' AND endedAt>0 AND endedAt<?"),
    counts: db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"),
    uncollectedDone: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE collectedAt=0 AND status<>'running'"),
  };
  const lc = (e) => String(e || "").trim().toLowerCase();

  function createJob({ id, chatId = "", email = "", uid = "", startedAt }) {
    q.ins.run(String(id), String(chatId), lc(email), String(uid || ""), Math.trunc(startedAt) || now());
  }
  function bindMeta(id, { chatId = "", model = "", mode = "" } = {}) {
    q.bind.run(String(chatId), String(chatId), String(model), String(model), String(mode), String(mode), String(id));
  }
  // The batched flush: rows from coalesceEvents(), plus the authoritative progress counters.
  function appendRows(id, rows, eventCount, textChars) {
    if (!rows.length) { q.prog.run(Math.trunc(eventCount) || 0, Math.trunc(textChars) || 0, String(id)); return; }
    db.exec("BEGIN");
    try {
      for (const r of rows) q.evIns.run(String(id), r.seq, r.span, JSON.stringify(r.ev));
      q.prog.run(Math.trunc(eventCount) || 0, Math.trunc(textChars) || 0, String(id));
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  }
  function finish(id, status, meta) {
    const s = ["done", "stopped", "error", "orphaned"].includes(status) ? status : "error";
    q.fin.run(s, now(), meta ? JSON.stringify(meta).slice(0, 4000) : "", String(id));
  }
  const get = (id) => q.get.get(String(id || "")) || null;
  const listFor = (email, { chatId = "", limit = 100 } = {}) =>
    chatId ? q.listChat.all(lc(email), String(chatId), limit) : q.listAll.all(lc(email), limit);
  const runningCountFor = (email) => (q.running.get(lc(email)) || {}).n || 0;
  // Stored rows covering seq >= fromSeq (a row whose span straddles the cursor is included whole —
  // the caller decides whether that boundary mismatch forces a reset+full replay).
  const replayRows = (id, fromSeq) => (fromSeq > 0 ? q.evFrom.all(String(id), Math.trunc(fromSeq)) : q.evAll.all(String(id)))
    .map((r) => ({ seq: r.seq, span: r.span, ev: JSON.parse(r.ev) }));
  // Assemble a finished (or in-progress-on-disk) job into a deliverable result.
  function resultFor(id) {
    const row = get(id);
    if (!row) return null;
    let text = ""; const tools = [], errors = [];
    for (const { ev } of replayRows(id, 0)) {
      if (ev.type === "token") text += ev.delta || "";
      else if (ev.type === "tool" && ev.status && ev.status !== "run") tools.push(ev.name + ":" + ev.status);
      else if (ev.type === "error") errors.push(String(ev.message || ev.code || "error"));
    }
    let meta = null; try { meta = row.meta ? JSON.parse(row.meta) : null; } catch {}
    return { id: row.id, chatId: row.chatId, status: row.status, model: row.model, mode: row.mode,
             startedAt: row.startedAt, endedAt: row.endedAt, collected: !!row.collectedAt,
             eventCount: row.eventCount, text, meta, tools, errors };
  }
  const collect = (id) => { q.coll.run(now(), String(id || "")); return true; };
  // Boot sweep: rows a dead process left 'running' become honest orphans. The synthetic tail means
  // a later /chat/attach replays partial text + a clear explanation + stopped — the client already
  // renders that combination (partial kept, marked interrupted) with zero new event types.
  function sweepOrphans() {
    const dead = q.runningAll.all();
    if (!dead.length) return 0;
    db.exec("BEGIN");
    try {
      for (const j of dead) {
        const tail = [
          { type: "error", code: "server_restart", message: "The server restarted mid-run — everything generated before the restart is preserved below. Tap Continue to pick up where it left off." },
          { type: "stopped", reason: "server_restart" },
        ];
        tail.forEach((ev, i) => q.evIns.run(j.id, j.eventCount + i, 1, JSON.stringify(ev)));
        q.prog.run(j.eventCount + tail.length, j.textChars, j.id);
        q.fin.run("orphaned", now(), JSON.stringify({ note: "server restarted mid-run", chatId: j.chatId, model: j.model, mode: j.mode }), j.id);
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    return dead.length;
  }
  // Retention: running rows are untouchable; collected jobs lose their events after collectedTtlMs
  // (bare row lingers ROW_LINGER_MS more for the inbox/debug trail); uncollected terminal jobs wait
  // uncollectedTtlMs (0 = keep forever) — the whole point is an answer nobody has seen yet.
  function gcRetention({ collectedTtlMs = 86400000, uncollectedTtlMs = 30 * 86400000 } = {}) {
    const t = now(); let events = 0, rowsGone = 0;
    for (const j of q.collectedOld.all(t - collectedTtlMs)) {
      q.evDel.run(j.id); events++;
      if (j.collectedAt < t - collectedTtlMs - ROW_LINGER_MS) { q.del.run(j.id); rowsGone++; }
    }
    if (uncollectedTtlMs > 0) {
      for (const j of q.uncollectedOld.all(t - uncollectedTtlMs)) { q.evDel.run(j.id); q.del.run(j.id); rowsGone++; }
    }
    return { events, rowsGone };
  }
  function stats() {
    const by = {}; for (const r of q.counts.all()) by[r.status] = r.n;
    return { byStatus: by, uncollected: (q.uncollectedDone.get() || {}).n || 0 };
  }

  const orphanedAtBoot = sweepOrphans();

  return { createJob, bindMeta, appendRows, finish, get, listFor, replayRows, resultFor, collect,
           runningCountFor, sweepOrphans, gcRetention, stats, orphanedAtBoot };
}
