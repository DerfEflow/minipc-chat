/*
 * Dominion AI — taskkernel: ONE durable spine for every long-running task in the app.
 *
 * Why this exists (Fred's concurrent-work spec): a user must be able to start a video, walk to the
 * Crucible and start a build, then open Simplify and brainstorm, and have all three keep working
 * until they finish or hard-fail, with a notification that takes them back to the screen that
 * raised it. Nothing may die because a panel closed, a tab navigated, or a socket dropped.
 *
 * The app had grown FIVE independent job systems, each reinventing durability at a different level
 * of care: chatjobs.mjs (SQLite, resume-on-restart, excellent), idejobs.mjs (JSONL journal, leases,
 * push, also excellent, entirely unrelated), video.mjs (a durable record with nothing driving it),
 * images.mjs (batches only), and simplify.mjs (nothing at all). Five systems means a fix applied to
 * one is absent from four, which is exactly how single-image generation ended up charging for
 * images it then discarded. This module is the shared spine so durability, resume, concurrency,
 * stall detection and notification are written once and inherited.
 *
 * Two halves, deliberately:
 *   - the STORE (this file): rows and events on disk, the source of truth once RAM cannot answer
 *   - the REGISTRY (this file, `register`): per-kind handlers that know how to actually do the work
 * A task record is meaningless without a handler, and a handler without a record cannot survive a
 * restart, so neither half is optional.
 *
 * Driver-managed vs self-driving kinds. Some work runs inside our own process and reports progress
 * as it goes (a chat turn, a build). Some work happens at a provider and only tells us when asked
 * (a Runware video). The second kind needs something to ASK, and before this module the only thing
 * that ever asked was an open browser tab, which is why a finished clip could expire un-downloaded
 * at the provider while the user was on another screen. `nextPollAt` puts those tasks on a single
 * server-side clock that runs whether or not anyone is watching. See driver.mjs for the loop.
 *
 * Event storage borrows chatjobs' proven shape: events buffer in RAM and flush in batches, with
 * contiguous token runs coalesced into one row carrying a `span`. coalesceEvents is imported rather
 * than copied so there is exactly one implementation and one set of tests for it. The import points
 * at chatjobs today because that is where it was born; when chat itself moves onto this kernel the
 * function comes with it and the arrow flips.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { coalesceEvents } from "./chatjobs.mjs";

export { coalesceEvents };

// Terminal states. `needs_input` is deliberately NOT terminal: a build asking a question is still
// alive and still holds its slot, it simply cannot progress until a human answers.
export const TERMINAL = new Set(["done", "failed", "stopped", "orphaned"]);
export const LIVE = new Set(["queued", "running", "needs_input"]);

// How long a collected task's bare row lingers after its events are deleted (inbox/debug trail).
const ROW_LINGER_MS = 7 * 86400000;

/*
 * Poll backoff. A provider that takes 40 seconds should be caught within a couple of seconds of
 * finishing, but a job that has been queued for twenty minutes must not be hammered at that rate.
 * Growth is 1.6x from 2s, capped at 30s, which reaches the cap around attempt 7 and costs roughly
 * 120 provider calls an hour for a genuinely stuck job. The cap matters more than the curve: it is
 * what keeps a forgotten task from becoming a billing surprise at the provider.
 */
export function backoffMs(attempt, { base = 2000, factor = 1.6, cap = 30000 } = {}) {
  const n = Math.max(0, Math.trunc(attempt) || 0);
  return Math.min(cap, Math.round(base * Math.pow(factor, n)));
}

export function createTaskKernel({ dir, now = Date.now, log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "tasks.db"));
  db.exec("PRAGMA journal_mode=WAL");

  /*
   * `surface` + `anchor` are the deep link, stored at birth rather than derived at notification
   * time. A notification fires long after the originating request is gone, often from a service
   * worker with no session, so the record has to already know where "take me back" points.
   */
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT '',
    surface     TEXT NOT NULL DEFAULT '',
    anchor      TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    uid         TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'queued',
    startedAt   INTEGER NOT NULL,
    endedAt     INTEGER NOT NULL DEFAULT 0,
    collectedAt INTEGER NOT NULL DEFAULT 0,
    notifiedAt  INTEGER NOT NULL DEFAULT 0,
    seenAt      INTEGER NOT NULL DEFAULT 0,
    nextPollAt  INTEGER NOT NULL DEFAULT 0,
    lastPollAt  INTEGER NOT NULL DEFAULT 0,
    attempt     INTEGER NOT NULL DEFAULT 0,
    deadlineAt  INTEGER NOT NULL DEFAULT 0,
    externalId  TEXT NOT NULL DEFAULT '',
    resultRef   TEXT NOT NULL DEFAULT '',
    eventCount  INTEGER NOT NULL DEFAULT 0,
    textChars   INTEGER NOT NULL DEFAULT 0,
    meta        TEXT NOT NULL DEFAULT '' )`);
  db.exec("CREATE INDEX IF NOT EXISTS tasks_by_uid ON tasks(uid, status)");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_by_anchor ON tasks(surface, anchor)");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_by_poll ON tasks(nextPollAt) WHERE nextPollAt > 0");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_by_notify ON tasks(notifiedAt, endedAt)");
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    taskId TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    span   INTEGER NOT NULL DEFAULT 1,
    ev     TEXT NOT NULL,
    PRIMARY KEY (taskId, seq) ) WITHOUT ROWID`);

  const q = {
    ins: db.prepare(`INSERT OR REPLACE INTO tasks
      (id,kind,surface,anchor,title,email,uid,status,startedAt,nextPollAt,deadlineAt,externalId)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    get: db.prepare("SELECT * FROM tasks WHERE id=?"),
    prog: db.prepare("UPDATE tasks SET eventCount=?, textChars=? WHERE id=?"),
    fin: db.prepare("UPDATE tasks SET status=?, endedAt=?, meta=?, nextPollAt=0 WHERE id=?"),
    setStatus: db.prepare("UPDATE tasks SET status=? WHERE id=?"),
    coll: db.prepare("UPDATE tasks SET collectedAt=? WHERE id=? AND collectedAt=0"),
    bind: db.prepare(`UPDATE tasks SET
      title=CASE WHEN ?<>'' THEN ? ELSE title END,
      anchor=CASE WHEN ?<>'' THEN ? ELSE anchor END,
      externalId=CASE WHEN ?<>'' THEN ? ELSE externalId END,
      resultRef=CASE WHEN ?<>'' THEN ? ELSE resultRef END WHERE id=?`),
    evIns: db.prepare("INSERT OR REPLACE INTO events (taskId,seq,span,ev) VALUES (?,?,?,?)"),
    evAll: db.prepare("SELECT seq,span,ev FROM events WHERE taskId=? ORDER BY seq"),
    evFrom: db.prepare("SELECT seq,span,ev FROM events WHERE taskId=? AND seq+span>? ORDER BY seq"),
    evDel: db.prepare("DELETE FROM events WHERE taskId=?"),
    // Driver loop: due, oldest-scheduled first, so a backlog drains in fairness order.
    due: db.prepare("SELECT * FROM tasks WHERE nextPollAt>0 AND nextPollAt<=? AND status IN ('queued','running') ORDER BY nextPollAt LIMIT ?"),
    sched: db.prepare("UPDATE tasks SET nextPollAt=?, lastPollAt=?, attempt=? WHERE id=?"),
    listUid: db.prepare("SELECT * FROM tasks WHERE uid=? ORDER BY startedAt DESC LIMIT ?"),
    liveUid: db.prepare("SELECT * FROM tasks WHERE uid=? AND status IN ('queued','running','needs_input') ORDER BY startedAt"),
    liveKind: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE uid=? AND kind=? AND status IN ('queued','running','needs_input')"),
    liveAnchor: db.prepare("SELECT * FROM tasks WHERE surface=? AND anchor=? AND status IN ('queued','running','needs_input') LIMIT 1"),
    runningAll: db.prepare("SELECT * FROM tasks WHERE status IN ('queued','running')"),
    // Terminal, never announced, still unseen: exactly the set the notifier owes the user.
    unnotified: db.prepare("SELECT * FROM tasks WHERE notifiedAt=0 AND endedAt>0 AND status IN ('done','failed','stopped','orphaned') ORDER BY endedAt LIMIT ?"),
    markNotified: db.prepare("UPDATE tasks SET notifiedAt=? WHERE id=?"),
    markSeen: db.prepare("UPDATE tasks SET seenAt=? WHERE id=? AND seenAt=0"),
    unseen: db.prepare("SELECT * FROM tasks WHERE uid=? AND seenAt=0 AND endedAt>0 AND status IN ('done','failed','stopped','orphaned') ORDER BY endedAt DESC LIMIT ?"),
    del: db.prepare("DELETE FROM tasks WHERE id=?"),
    collectedOld: db.prepare("SELECT id, collectedAt FROM tasks WHERE collectedAt>0 AND collectedAt<?"),
    uncollectedOld: db.prepare("SELECT id FROM tasks WHERE collectedAt=0 AND endedAt>0 AND endedAt<? AND status<>'running'"),
    counts: db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"),
    byKind: db.prepare("SELECT kind, COUNT(*) AS n FROM tasks WHERE status IN ('queued','running','needs_input') GROUP BY kind"),
  };
  const lc = (e) => String(e || "").trim().toLowerCase();
  const s = (v) => String(v == null ? "" : v);

  /*
   * The kind registry. A handler declares how its work runs and, for provider-backed work, how to
   * ask whether it is finished. Kinds register at boot; an unregistered kind found on disk at boot
   * is left alone rather than failed, because the usual cause is a half-deployed build and failing
   * someone's paid video over a deploy ordering accident would be worse than waiting.
   */
  const kinds = new Map();
  function register(kind, handler = {}) {
    const k = s(kind);
    if (!k) throw new Error("task kind required");
    kinds.set(k, {
      run: handler.run || null,       // (task, api) => Promise<void>, detached, for in-process work
      poll: handler.poll || null,     // (task, api) => Promise<{done?, failed?, retryInMs?}>
      describe: handler.describe || ((t) => t.title || k),  // notification text
      href: handler.href || ((t) => "/"),                   // deep link back to the originating screen
      maxAgeMs: handler.maxAgeMs || 0, // 0 = no deadline
    });
    return kinds.get(k);
  }
  const handlerFor = (kind) => kinds.get(s(kind)) || null;

  function createTask({ id, kind, surface = "", anchor = "", title = "", email = "", uid = "",
                        status = "queued", startedAt, pollAt = 0, externalId = "" }) {
    const t0 = Math.trunc(startedAt) || now();
    const h = handlerFor(kind);
    const deadline = h && h.maxAgeMs ? t0 + h.maxAgeMs : 0;
    q.ins.run(s(id), s(kind), s(surface), s(anchor), s(title).slice(0, 200), lc(email), s(uid),
              s(status), t0, Math.trunc(pollAt) || 0, deadline, s(externalId));
    return get(id);
  }
  function bindMeta(id, { title = "", anchor = "", externalId = "", resultRef = "" } = {}) {
    q.bind.run(s(title).slice(0, 200), s(title).slice(0, 200), s(anchor), s(anchor),
               s(externalId), s(externalId), s(resultRef), s(resultRef), s(id));
  }
  // The batched flush, identical in shape to chatjobs: rows from coalesceEvents plus counters.
  function appendRows(id, rows, eventCount, textChars) {
    if (!rows.length) { q.prog.run(Math.trunc(eventCount) || 0, Math.trunc(textChars) || 0, s(id)); return; }
    db.exec("BEGIN");
    try {
      for (const r of rows) q.evIns.run(s(id), r.seq, r.span, JSON.stringify(r.ev));
      q.prog.run(Math.trunc(eventCount) || 0, Math.trunc(textChars) || 0, s(id));
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  }
  function finish(id, status, meta) {
    const st = TERMINAL.has(status) ? status : "failed";
    q.fin.run(st, now(), meta ? JSON.stringify(meta).slice(0, 4000) : "", s(id));
    return st;
  }
  const setStatus = (id, status) => { q.setStatus.run(s(status), s(id)); };
  const get = (id) => q.get.get(s(id)) || null;
  const listFor = (uid, { limit = 100 } = {}) => q.listUid.all(s(uid), limit);
  const liveFor = (uid) => q.liveUid.all(s(uid));
  const liveCountFor = (uid, kind) => (q.liveKind.get(s(uid), s(kind)) || {}).n || 0;
  const liveAtAnchor = (surface, anchor) => q.liveAnchor.get(s(surface), s(anchor)) || null;
  const replayRows = (id, fromSeq) =>
    (fromSeq > 0 ? q.evFrom.all(s(id), Math.trunc(fromSeq)) : q.evAll.all(s(id)))
      .map((r) => ({ seq: r.seq, span: r.span, ev: JSON.parse(r.ev) }));
  const collect = (id) => { q.coll.run(now(), s(id)); return true; };

  function resultFor(id) {
    const row = get(id);
    if (!row) return null;
    let text = ""; const errors = [];
    for (const { ev } of replayRows(id, 0)) {
      if (ev.type === "token") text += ev.delta || "";
      else if (ev.type === "error") errors.push(s(ev.message || ev.code || "error"));
    }
    let meta = null; try { meta = row.meta ? JSON.parse(row.meta) : null; } catch {}
    return { id: row.id, kind: row.kind, surface: row.surface, anchor: row.anchor, title: row.title,
             status: row.status, startedAt: row.startedAt, endedAt: row.endedAt,
             collected: !!row.collectedAt, seen: !!row.seenAt, resultRef: row.resultRef,
             eventCount: row.eventCount, text, meta, errors };
  }

  /*
   * Driver support. `claimDue` both selects and reschedules in one pass, so two driver ticks that
   * overlap (a slow provider call straddling the next tick) cannot hand the same task out twice.
   * The reschedule is optimistic: it assumes the poll will need another round, and a poll that
   * settles the task clears nextPollAt via finish() anyway.
   */
  function claimDue(limit = 25, t = now()) {
    const rows = q.due.all(t, Math.max(1, limit));
    if (!rows.length) return [];
    db.exec("BEGIN");
    try {
      for (const r of rows) q.sched.run(t + backoffMs(r.attempt + 1), t, r.attempt + 1, r.id);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    return rows;
  }
  const scheduleNext = (id, delayMs, t = now()) => {
    const row = get(id);
    if (!row) return;
    q.sched.run(t + Math.max(250, Math.trunc(delayMs) || 0), t, row.attempt, s(id));
  };
  const stopPolling = (id) => { const r = get(id); if (r) q.sched.run(0, r.lastPollAt, r.attempt, s(id)); };

  /*
   * Notification queue. Terminal and never announced. markNotified is a separate write from
   * markSeen on purpose: "we told them" and "they looked" answer different questions, and the
   * service worker needs the first to avoid re-buzzing while the popup needs the second to know
   * whether it still owes the user a card.
   */
  const pendingNotifications = (limit = 50) => q.unnotified.all(Math.max(1, limit));
  const markNotified = (id) => { q.markNotified.run(now(), s(id)); };
  const markSeen = (id) => { q.markSeen.run(now(), s(id)); };
  const unseenFor = (uid, limit = 20) => q.unseen.all(s(uid), Math.max(1, limit));

  function notificationFor(task) {
    const h = handlerFor(task.kind);
    return {
      id: task.id, kind: task.kind, status: task.status, surface: task.surface, anchor: task.anchor,
      title: h ? safe(() => h.describe(task), task.title || task.kind) : (task.title || task.kind),
      href: h ? safe(() => h.href(task), "/") : "/",
      endedAt: task.endedAt,
    };
  }
  const safe = (fn, fallback) => { try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; } };

  /*
   * Boot sweep. Anything a dead process left live becomes an honest orphan with a synthetic tail,
   * matching chatjobs' proven approach: partial output preserved, a clear explanation appended, and
   * a terminal marker, so a client attaching later renders "interrupted, here is what we had" with
   * no new event types. Tasks whose handler declares a resume path are marked `orphaned` rather
   * than `failed` precisely so the resume logic can tell "died mid-flight" from "genuinely broke".
   */
  function sweepOrphans() {
    const dead = q.runningAll.all();
    if (!dead.length) return 0;
    db.exec("BEGIN");
    try {
      for (const j of dead) {
        const tail = [
          { type: "error", code: "server_restart", message: "The server restarted while this was running. Everything finished before the restart is kept below." },
          { type: "stopped", reason: "server_restart" },
        ];
        tail.forEach((ev, i) => q.evIns.run(j.id, j.eventCount + i, 1, JSON.stringify(ev)));
        q.prog.run(j.eventCount + tail.length, j.textChars, j.id);
        q.fin.run("orphaned", now(), JSON.stringify({ note: "server restarted mid-run", kind: j.kind, surface: j.surface, anchor: j.anchor }), j.id);
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    log(`taskkernel: sealed ${dead.length} task(s) orphaned at boot`);
    return dead.length;
  }

  /*
   * Retention. Live rows are untouchable. Collected tasks lose events after collectedTtlMs, the
   * bare row lingering ROW_LINGER_MS more. Uncollected terminal tasks wait far longer because an
   * uncollected result is by definition one nobody has seen. resultRef is returned so the caller
   * can delete the artifact it points at: the kernel deliberately does not touch the filesystem,
   * since the thing at the other end of a resultRef might be an R2 key or a provider URL.
   */
  function gcRetention({ collectedTtlMs = 86400000, uncollectedTtlMs = 30 * 86400000 } = {}) {
    const t = now(); let events = 0, rowsGone = 0; const orphanedRefs = [];
    for (const j of q.collectedOld.all(t - collectedTtlMs)) {
      q.evDel.run(j.id); events++;
      if (j.collectedAt < t - collectedTtlMs - ROW_LINGER_MS) {
        const row = get(j.id); if (row && row.resultRef) orphanedRefs.push(row.resultRef);
        q.del.run(j.id); rowsGone++;
      }
    }
    if (uncollectedTtlMs > 0) {
      for (const j of q.uncollectedOld.all(t - uncollectedTtlMs)) {
        const row = get(j.id); if (row && row.resultRef) orphanedRefs.push(row.resultRef);
        q.evDel.run(j.id); q.del.run(j.id); rowsGone++;
      }
    }
    return { events, rowsGone, orphanedRefs };
  }

  function stats() {
    const byStatus = {}; for (const r of q.counts.all()) byStatus[r.status] = r.n;
    const liveByKind = {}; for (const r of q.byKind.all()) liveByKind[r.kind] = r.n;
    return { byStatus, liveByKind, kinds: [...kinds.keys()] };
  }

  const orphanedAtBoot = sweepOrphans();

  return { register, handlerFor, createTask, bindMeta, appendRows, finish, setStatus, get, listFor,
           liveFor, liveCountFor, liveAtAnchor, replayRows, resultFor, collect,
           claimDue, scheduleNext, stopPolling,
           pendingNotifications, markNotified, markSeen, unseenFor, notificationFor,
           sweepOrphans, gcRetention, stats, orphanedAtBoot, TERMINAL, LIVE, backoffMs };
}
