/*
 * Dominion Works: the durable job spine.
 *   SOW docs/IDE-MODE-ROADMAP.md (Phase 2.3, Phase 4) - build pack docs/IDE-MODE-BUILD.md
 *
 * WHY THIS IS NOT THE CHAT JOB SPINE.
 * Chat jobs (server.mjs CHAT_JOBS) hold their events in a Map in memory with a 45 minute TTL.
 * That is right for a turn that lasts seconds: if the container restarts mid-answer the user asks
 * again. A build is different. It can run for many minutes, it writes real files on the user's
 * machine, and Fred's ruling is that it must survive the user closing the app AND the container
 * restarting under it. So every structural event is appended to a per-job JSONL journal on disk,
 * and the in-memory index is a cache rebuilt from those journals at boot.
 *
 * WHAT IS AND IS NOT JOURNALLED.
 * Public records are structural events only: plan, move, file, diff, run, cost, need_input,
 * snapshot, done, error. The private `_lease` heartbeat is filtered from replay/event indexes.
 * Never per-token streaming. A build emits tens of public events, so the journal stays replayable
 * and readable by a human.
 *
 * Zero dependencies, sync fs, one file per job. Same discipline as artifacts.mjs and forge.mjs.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

// Terminal states. `checkpoint` is explicitly unfinished but safely sealed: it exists so a runner
// can preserve partial work without lying that it completed or collapsing every recoverable limit
// into an error. A journal ending without any terminal was interrupted by a restart.
export const TERMINAL = new Set(["done", "checkpoint", "error", "stopped"]);

// Event types the spine understands. Anything else is refused so a typo cannot become a silent
// no-op that the client waits on forever.
export const EVENT_TYPES = new Set([
  "job",        // header, written once at create
  "plan",       // the blueprint for this job
  "move",       // a move started / changed state
  "file",       // a file was written or changed
  "diff",       // a diff for a move
  "run",        // shell/verify output
  "cost",       // running cost for the job
  "snapshot",   // a snapshot was taken before a write batch
  "need_input", // frozen, waiting on a human (zero spend from here)
  "answer",     // a human answered; the freeze lifts
  "done",       // terminal: finished
  "checkpoint", // terminal: unfinished, work/evidence preserved for a resumable follow-up
  "error",      // terminal: failed
  "stopped",    // terminal: explicitly stopped
]);

const isTerminal = (t) => TERMINAL.has(t);

// Rolling-deploy grace (Kimi #2). Railway boots the NEW container while the OLD one is briefly
// still driving a build. The old instance writes an internal lease heartbeat to the same append-
// only journal; a new instance tails it until it sees a terminal event or one full grace window
// passes without foreign activity. Lease records never enter the public event stream or its
// replay indexes.
const DEPLOY_GRACE_MS = 120000;
const RECONCILE_INTERVAL_MS = 1000;
const LEASE_EVENT = "_lease";
const MAX_READ_FAILURES = 3;

export function createIdeJobs({
  dir,
  cap = 200,
  now = () => Date.now(),
  log = () => {},
  onEvent = null,
  deployGraceMs = DEPLOY_GRACE_MS,
  reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  heartbeatIntervalMs = null,
} = {}) {
  if (!dir) throw new Error("createIdeJobs needs a dir");
  const jobsDir = join(dir, "jobs");
  mkdirSync(jobsDir, { recursive: true });

  // id -> { id, uid, workspaceId, kind, startedAt, endedAt, outcome, events[], listeners[],
  //         done, stopped, interrupted, stop() }
  const INDEX = new Map();
  // Only jobs recovered from another process are followed. Each lease deadline is bounded from
  // this process's observation time, so a bad/future timestamp cannot create a permanent zombie.
  const FOLLOWERS = new Map();
  const HEARTBEATS = new Map();
  const instanceId = randomUUID();
  let recordSeq = 0;
  let disposed = false;

  const asMs = (value, fallback, minimum = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(minimum, n) : fallback;
  };
  const graceMs = asMs(deployGraceMs, DEPLOY_GRACE_MS);
  const tailMs = asMs(reconcileIntervalMs, RECONCILE_INTERVAL_MS, 1);
  const defaultHeartbeatMs = Math.max(1, Math.floor(graceMs / 3));
  const heartbeatMs = heartbeatIntervalMs == null
    ? defaultHeartbeatMs
    : asMs(heartbeatIntervalMs, defaultHeartbeatMs, 1);
  const clockNow = () => {
    const n = Number(now());
    return Number.isFinite(n) ? n : Date.now();
  };

  const fileFor = (id) => join(jobsDir, id + ".jsonl");

  function append(id, ev) {
    try {
      appendFileSync(fileFor(id), JSON.stringify(ev) + "\n", "utf8");
      return true;
    } catch (e) {
      log("[ide] journal write failed for " + id + ": " + (e && e.message));
      return false;
    }
  }

  function ownedRecord(ev) {
    return { ...ev, _writer: instanceId, _record: instanceId + ":" + (++recordSeq) };
  }

  function readJournal(id) {
    try {
      const raw = readFileSync(fileFor(id), "utf8");
      const records = [];
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev === "object") records.push(ev);
        } catch {}
      }
      return { records, bytes: Buffer.byteLength(raw, "utf8") };
    } catch {
      return null;
    }
  }

  function publicEvents(records) {
    const events = [];
    for (const ev of records) {
      if (ev.type === LEASE_EVENT) continue;
      // A terminal event seals the stream even if a stale writer managed to append afterward.
      // That keeps every process on the same durable outcome.
      if (events.length && isTerminal(events[events.length - 1].type)) continue;
      events.push(ev);
    }
    return events;
  }

  function stopHeartbeat(id) {
    const timer = HEARTBEATS.get(id);
    if (timer) clearTimeout(timer);
    HEARTBEATS.delete(id);
  }

  function stopFollowing(id) {
    const follower = FOLLOWERS.get(id);
    if (follower && follower.timer) clearTimeout(follower.timer);
    FOLLOWERS.delete(id);
  }

  function publish(job, ev, fireHook = false) {
    if (isTerminal(ev.type)) {
      job.done = true;
      job.endedAt = ev.at || clockNow();
      job.outcome = ev.type;
      job.stopped = ev.type === "stopped";
      job.interrupted = ev.type === "error" && ev.code === "interrupted";
      stopHeartbeat(job.id);
      stopFollowing(job.id);
    }
    for (const listener of [...job.listeners]) {
      try { listener(ev); } catch {}
    }
    if (fireHook && typeof onEvent === "function") {
      try { onEvent(job, ev); } catch (e) { log("[ide] onEvent threw: " + (e && e.message)); }
    }
    if (job.done) {
      for (const listener of [...job.listeners]) {
        try { listener(null); } catch {}
      }
      job.listeners.length = 0;
    }
  }

  function sealInterrupted(job) {
    if (!job || job.done) return false;
    const ev = ownedRecord({
      type: "error",
      at: clockNow(),
      code: "interrupted",
      message: "This build was interrupted when the server restarted. Its work up to here is on disk.",
    });
    job.events.push(ev);
    append(job.id, ev);
    publish(job, ev);
    return true;
  }

  function scheduleHeartbeat(job) {
    if (disposed || !job || job.done || HEARTBEATS.has(job.id)) return;
    const timer = setTimeout(() => {
      HEARTBEATS.delete(job.id);
      if (disposed || job.done || INDEX.get(job.id) !== job) return;
      append(job.id, {
        type: LEASE_EVENT,
        at: clockNow(),
        instanceId,
        _writer: instanceId,
      });
      scheduleHeartbeat(job);
    }, heartbeatMs);
    if (typeof timer.unref === "function") timer.unref();
    HEARTBEATS.set(job.id, timer);
  }

  function scheduleFollower(id) {
    const follower = FOLLOWERS.get(id);
    if (disposed || !follower || follower.timer) return;
    const remaining = Math.max(0, follower.leaseUntil - clockNow());
    const delay = Math.max(1, Math.min(tailMs, remaining));
    follower.timer = setTimeout(() => {
      follower.timer = null;
      reconcileOne(id);
    }, delay);
    if (typeof follower.timer.unref === "function") follower.timer.unref();
  }

  function startFollowing(job, snapshot, remainingGrace) {
    stopFollowing(job.id);
    FOLLOWERS.set(job.id, {
      rawCursor: snapshot.records.length,
      bytes: snapshot.bytes,
      seen: new Set(snapshot.records.map((ev) => ev._record).filter(Boolean)),
      leaseUntil: clockNow() + Math.max(0, remainingGrace),
      readFailures: 0,
      timer: null,
    });
    scheduleFollower(job.id);
  }

  function reconcileOne(id, allowInterrupt = true) {
    const follower = FOLLOWERS.get(id);
    const job = INDEX.get(id);
    if (!follower || !job || job.done) {
      if (follower) stopFollowing(id);
      return false;
    }

    const snapshot = readJournal(id);
    if (!snapshot) {
      follower.readFailures++;
      if (allowInterrupt && clockNow() >= follower.leaseUntil &&
          follower.readFailures >= MAX_READ_FAILURES) {
        return sealInterrupted(job);
      }
      scheduleFollower(id);
      return false;
    }

    follower.readFailures = 0;
    let foreignActivity = snapshot.bytes > follower.bytes &&
      snapshot.records.length === follower.rawCursor;
    if (snapshot.records.length < follower.rawCursor) {
      // Journals are append-only. If one was unexpectedly replaced, trust the durable terminal
      // state already in memory and rebase without replaying an ambiguous prefix twice.
      follower.rawCursor = snapshot.records.length;
    } else {
      for (const ev of snapshot.records.slice(follower.rawCursor)) {
        const foreign = !ev._writer || ev._writer !== instanceId;
        if (foreign) foreignActivity = true;
        if (ev.type === LEASE_EVENT) continue;
        if (ev._record && follower.seen.has(ev._record)) continue;
        if (ev._record) follower.seen.add(ev._record);
        if (job.done) continue;
        job.events.push(ev);
        publish(job, ev);
      }
      follower.rawCursor = snapshot.records.length;
    }
    follower.bytes = snapshot.bytes;

    if (foreignActivity && !job.done) follower.leaseUntil = clockNow() + graceMs;
    if (job.done) {
      stopFollowing(id);
      return true;
    }
    if (allowInterrupt && clockNow() >= follower.leaseUntil) return sealInterrupted(job);
    scheduleFollower(id);
    return foreignActivity;
  }

  function reconcileAll() {
    for (const id of [...FOLLOWERS.keys()]) reconcileOne(id);
  }

  // ---- restart recovery ---------------------------------------------------------------------
  // Rebuild the index from journals. A recent unfinished job gets a bounded lease while this
  // process tails the outgoing instance's journal. If that instance finishes, its terminal event
  // is adopted here; if its heartbeats disappear, this process seals the job after the grace.
  function loadFromDisk() {
    let recovered = 0, interrupted = 0;
    let names = [];
    try { names = readdirSync(jobsDir).filter((n) => n.endsWith(".jsonl")); } catch { return { recovered, interrupted }; }
    for (const name of names) {
      const id = name.slice(0, -6);
      const snapshot = readJournal(id);
      if (!snapshot) continue;
      const events = publicEvents(snapshot.records);
      if (!events.length) continue;
      const head = events[0] || {};
      const last = events[events.length - 1] || {};
      const job = {
        id,
        uid: head.uid || "",
        workspaceId: head.workspaceId || "",
        kind: head.kind || "build",
        isOwner: !!head.isOwner,
        startedAt: head.at || 0,
        endedAt: isTerminal(last.type) ? (last.at || 0) : 0,
        outcome: isTerminal(last.type) ? last.type : "",
        events,
        listeners: [],
        done: isTerminal(last.type),
        stopped: last.type === "stopped",
        interrupted: last.type === "error" && last.code === "interrupted",
        stop: () => {},
      };
      stopFollowing(id);
      INDEX.set(id, job);
      if (!job.done) {
        const activity = snapshot.records[snapshot.records.length - 1] || last;
        const stamp = Number(activity.at);
        const age = Number.isFinite(stamp) && stamp > 0
          ? Math.max(0, clockNow() - stamp)
          : graceMs;
        const remainingGrace = Math.max(0, graceMs - Math.min(graceMs, age));
        if (remainingGrace > 0) {
          startFollowing(job, snapshot, remainingGrace);
        } else if (sealInterrupted(job)) {
          interrupted++;
        }
      }
      recovered++;
    }
    gc();
    return { recovered, interrupted };
  }

  // ---- lifecycle ----------------------------------------------------------------------------
  function gc() {
    if (INDEX.size <= cap) return;
    // Drop finished jobs oldest-first. A live job is never evicted, however old.
    const finished = [...INDEX.values()].filter((j) => j.done).sort((a, b) => (a.endedAt || a.startedAt) - (b.endedAt || b.startedAt));
    while (INDEX.size > cap && finished.length) {
      const victim = finished.shift();
      stopHeartbeat(victim.id);
      stopFollowing(victim.id);
      INDEX.delete(victim.id);
      // ARCHIVE, do not delete (Kimi): a build journal is the postmortem when something went
      // wrong. Move it under jobs/archive/ instead of unlinking; the index drops it either way.
      try {
        const arch = join(jobsDir, "archive");
        mkdirSync(arch, { recursive: true });
        renameSync(fileFor(victim.id), join(arch, victim.id + ".jsonl"));
      } catch { try { unlinkSync(fileFor(victim.id)); } catch {} }
    }
  }

  function create({ uid, workspaceId = "", kind = "build", isOwner = false } = {}) {
    if (disposed) throw new Error("ide jobs spine is disposed");
    if (!uid) throw new Error("a job needs a uid");
    const id = "ide_" + randomUUID().slice(0, 12);
    const at = clockNow();
    // isOwner is recorded on the header deliberately: the escalation hook fires long after the
    // request that started the job is gone, and after a restart there is nothing else left to
    // tell it which account's devices to notify.
    const head = ownedRecord({ type: "job", at, id, uid, workspaceId, kind, isOwner: !!isOwner });
    const job = { id, uid, workspaceId, kind, isOwner: !!isOwner, startedAt: at, endedAt: 0, outcome: "",
                  events: [head], listeners: [], done: false, stopped: false, interrupted: false, stop: () => {} };
    INDEX.set(id, job);
    append(id, head);
    scheduleHeartbeat(job);
    gc();
    return job;
  }

  // Append an event: memory, disk, then live listeners. Terminal events seal the job so nothing
  // can be appended afterward (a late tool callback cannot resurrect a finished build).
  function emit(id, ev) {
    reconcileOne(id, false);
    const job = INDEX.get(id);
    if (!job || job.done) return null;
    const type = String(ev && ev.type || "");
    if (!EVENT_TYPES.has(type)) throw new Error("unknown ide job event type: " + type);
    const out = ownedRecord({ ...ev, type, at: clockNow() });
    job.events.push(out);
    append(id, out);
    const follower = FOLLOWERS.get(id);
    if (follower && out._record) follower.seen.add(out._record);
    // Escalation hook fires after the event is on disk and delivered, and is wrapped so a failing
    // notifier can never corrupt or stall the build it was only meant to announce.
    publish(job, out, true);
    return out;
  }

  function finish(id, { type = "done", ...rest } = {}) {
    if (!isTerminal(type)) throw new Error("finish needs a terminal type");
    return emit(id, { type, ...rest });
  }

  function stop(id, reason = "stopped by the user") {
    const job = get(id);
    if (!job) return { ok: false, error: "unknown or expired job" };
    if (job.done) return { ok: true, alreadyDone: true, outcome: job.outcome };
    job.stopped = true;
    try { job.stop(); } catch {}
    emit(id, { type: "stopped", message: reason });
    return { ok: true };
  }

  // ---- reads --------------------------------------------------------------------------------
  function get(id) {
    reconcileOne(id);
    return INDEX.get(id) || null;
  }

  // The multi-job registry. Chat tracks exactly ONE live job and hides it the moment the user
  // switches chats (app.js liveJob.chatId !== curId); that limitation is the thing Phase 4 exists
  // to remove, so this is per-user and view-independent from the start.
  function listFor(uid, { limit = 50 } = {}) {
    reconcileAll();
    return [...INDEX.values()]
      .filter((j) => j.uid === uid)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, limit)
      .map(summarize);
  }

  const activeFor = (uid) => listFor(uid).filter((j) => !j.done);

  function summarize(j) {
    // The last event that carries user-facing progress, so a status rail can render without
    // replaying the whole journal.
    let lastMove = null, lastCost = null, pending = null;
    for (const ev of j.events) {
      // A move after a question means the question was answered and work resumed, so the pending
      // prompt clears. Terminal events clear it too: a finished job is never still asking.
      if (ev.type === "move") { lastMove = ev; pending = null; }
      else if (ev.type === "cost") lastCost = ev;
      else if (ev.type === "need_input") pending = ev;
      else if (ev.type === "answer" || isTerminal(ev.type)) pending = null;
    }
    return {
      id: j.id, uid: j.uid, workspaceId: j.workspaceId, kind: j.kind,
      startedAt: j.startedAt, endedAt: j.endedAt,
      done: j.done, stopped: j.stopped, interrupted: j.interrupted, outcome: j.outcome,
      // "waiting" is deliberately distinct from "running": a frozen job is spending nothing, and
      // a status rail that shows a spinner for it would be lying about both.
      waiting: !j.done && !!pending,
      events: j.events.length,
      move: lastMove ? { id: lastMove.id || "", title: lastMove.title || "", state: lastMove.state || "" } : null,
      cost: lastCost ? { usd: lastCost.usd || 0, credits: lastCost.credits || 0 } : null,
      // The whole structured question travels, not just its text. Dropping `options` here is what
      // turns "answer in one tap" into "type it out yourself", which is the difference between
      // answering from a phone on the move and putting it off until you are back at a desk.
      needsInput: j.done ? null : (pending ? {
        id: pending.id || "",
        question: pending.question || "",
        options: Array.isArray(pending.options) ? pending.options.slice(0, 6) : [],
        default: pending.default || "",
      } : null),
    };
  }

  // Replay from `from`, then live-tail. Returns an unsubscribe fn. The replay happens in the same
  // tick as the subscribe so no event can slip through the gap between the two. Recovered jobs
  // continue tailing their journal afterward, not merely this process's in-memory emits.
  function attach(id, from, onEvent) {
    reconcileOne(id);
    const job = INDEX.get(id);
    if (!job) { onEvent({ type: "gone" }); onEvent(null); return () => {}; }
    const start = Math.max(0, Math.floor(Number(from) || 0));
    for (const ev of job.events.slice(start)) onEvent(ev);
    if (job.done) { onEvent(null); return () => {}; }
    job.listeners.push(onEvent);
    return () => { const i = job.listeners.indexOf(onEvent); if (i >= 0) job.listeners.splice(i, 1); };
  }

  /*
   * Wait for a human's answer to a pending question. The runner calls this right after emitting
   * need_input and simply awaits: the build function stays alive in-process, frozen at zero
   * spend, until any device on the account answers.
   *
   * `from` must be captured BEFORE the need_input is emitted. The answer can land in the gap
   * between emitting the question and attaching the waiter, and a waiter that only listens for
   * future events would miss it and freeze the build forever. Replaying from `from` closes that
   * race: the answer is found in the replay instead.
   *
   * Resolves the answer event, or null when the job seals first (stopped, errored, restarted).
   */
  function waitForAnswer(id, from) {
    const job = get(id);
    if (!job || job.done) return Promise.resolve(null);
    const start = Math.max(0, Math.floor(Number(from) || 0));
    return new Promise((resolve) => {
      let off = () => {};
      const onEv = (ev) => {
        if (ev === null) { off(); resolve(null); }
        else if (ev.type === "answer") { off(); resolve(ev); }
      };
      off = attach(id, start, onEv);
    });
  }

  function dispose() {
    disposed = true;
    for (const id of [...HEARTBEATS.keys()]) stopHeartbeat(id);
    for (const id of [...FOLLOWERS.keys()]) stopFollowing(id);
  }

  return { create, emit, finish, stop, get, listFor, activeFor, attach, loadFromDisk, summarize, waitForAnswer, dispose,
           get size() { return INDEX.size; } };
}
