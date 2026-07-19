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
 * Structural events only: plan, move, file, diff, run, cost, need_input, snapshot, done, error.
 * Never per-token streaming. A build emits tens of events, not thousands, so append-per-event is
 * cheap and the journal stays replayable and readable by a human.
 *
 * Zero dependencies, sync fs, one file per job. Same discipline as artifacts.mjs and forge.mjs.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Terminal states. A job whose journal ends without one of these was interrupted by a restart.
export const TERMINAL = new Set(["done", "error", "stopped"]);

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
  "done",       // terminal: finished
  "error",      // terminal: failed
  "stopped",    // terminal: explicitly stopped
]);

const isTerminal = (t) => TERMINAL.has(t);

export function createIdeJobs({ dir, cap = 200, now = () => Date.now(), log = () => {} } = {}) {
  if (!dir) throw new Error("createIdeJobs needs a dir");
  const jobsDir = join(dir, "jobs");
  mkdirSync(jobsDir, { recursive: true });

  // id -> { id, uid, workspaceId, kind, startedAt, endedAt, outcome, events[], listeners[],
  //         done, stopped, interrupted, stop() }
  const INDEX = new Map();

  const fileFor = (id) => join(jobsDir, id + ".jsonl");

  function append(id, ev) {
    try { appendFileSync(fileFor(id), JSON.stringify(ev) + "\n", "utf8"); }
    catch (e) { log("[ide] journal write failed for " + id + ": " + (e && e.message)); }
  }

  // ---- restart recovery ---------------------------------------------------------------------
  // Rebuild the index from journals. A job with no terminal event did not finish: the process that
  // was driving it is gone, so it is marked interrupted rather than left looking alive. Phase 4
  // offers resume; the honest state in the meantime is "interrupted", never "running".
  function loadFromDisk() {
    let recovered = 0, interrupted = 0;
    let names = [];
    try { names = readdirSync(jobsDir).filter((n) => n.endsWith(".jsonl")); } catch { return { recovered, interrupted }; }
    for (const name of names) {
      const id = name.slice(0, -6);
      let lines = [];
      try { lines = readFileSync(join(jobsDir, name), "utf8").split("\n").filter(Boolean); } catch { continue; }
      const events = [];
      for (const line of lines) { try { events.push(JSON.parse(line)); } catch {} }
      if (!events.length) continue;
      const head = events[0] || {};
      const last = events[events.length - 1] || {};
      const job = {
        id,
        uid: head.uid || "",
        workspaceId: head.workspaceId || "",
        kind: head.kind || "build",
        startedAt: head.at || 0,
        endedAt: isTerminal(last.type) ? (last.at || 0) : 0,
        outcome: isTerminal(last.type) ? last.type : "",
        events,
        listeners: [],
        done: isTerminal(last.type),
        stopped: last.type === "stopped",
        interrupted: false,
        stop: () => {},
      };
      if (!job.done) {
        // Seal it honestly: nothing is driving this job any more.
        job.interrupted = true;
        job.done = true;
        job.outcome = "error";
        job.endedAt = now();
        const ev = { type: "error", at: job.endedAt, code: "interrupted",
          message: "This build was interrupted when the server restarted. Its work up to here is on disk." };
        job.events.push(ev);
        append(id, ev);
        interrupted++;
      }
      INDEX.set(id, job);
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
      INDEX.delete(victim.id);
      try { unlinkSync(fileFor(victim.id)); } catch {}
    }
  }

  function create({ uid, workspaceId = "", kind = "build" } = {}) {
    if (!uid) throw new Error("a job needs a uid");
    const id = "ide_" + randomUUID().slice(0, 12);
    const at = now();
    const head = { type: "job", at, id, uid, workspaceId, kind };
    const job = { id, uid, workspaceId, kind, startedAt: at, endedAt: 0, outcome: "",
                  events: [head], listeners: [], done: false, stopped: false, interrupted: false, stop: () => {} };
    INDEX.set(id, job);
    append(id, head);
    gc();
    return job;
  }

  // Append an event: memory, disk, then live listeners. Terminal events seal the job so nothing
  // can be appended afterward (a late tool callback cannot resurrect a finished build).
  function emit(id, ev) {
    const job = INDEX.get(id);
    if (!job || job.done) return null;
    const type = String(ev && ev.type || "");
    if (!EVENT_TYPES.has(type)) throw new Error("unknown ide job event type: " + type);
    const out = { ...ev, type, at: now() };
    job.events.push(out);
    append(id, out);
    if (isTerminal(type)) {
      job.done = true;
      job.endedAt = out.at;
      job.outcome = type;
      if (type === "stopped") job.stopped = true;
    }
    for (const l of [...job.listeners]) { try { l(out); } catch {} }
    if (job.done) {
      for (const l of [...job.listeners]) { try { l(null); } catch {} }   // null = end of stream
      job.listeners.length = 0;
    }
    return out;
  }

  function finish(id, { type = "done", ...rest } = {}) {
    if (!isTerminal(type)) throw new Error("finish needs a terminal type");
    return emit(id, { type, ...rest });
  }

  function stop(id, reason = "stopped by the user") {
    const job = INDEX.get(id);
    if (!job) return { ok: false, error: "unknown or expired job" };
    if (job.done) return { ok: true, alreadyDone: true, outcome: job.outcome };
    job.stopped = true;
    try { job.stop(); } catch {}
    emit(id, { type: "stopped", message: reason });
    return { ok: true };
  }

  // ---- reads --------------------------------------------------------------------------------
  const get = (id) => INDEX.get(id) || null;

  // The multi-job registry. Chat tracks exactly ONE live job and hides it the moment the user
  // switches chats (app.js liveJob.chatId !== curId); that limitation is the thing Phase 4 exists
  // to remove, so this is per-user and view-independent from the start.
  function listFor(uid, { limit = 50 } = {}) {
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
      else if (isTerminal(ev.type)) pending = null;
    }
    return {
      id: j.id, uid: j.uid, workspaceId: j.workspaceId, kind: j.kind,
      startedAt: j.startedAt, endedAt: j.endedAt,
      done: j.done, stopped: j.stopped, interrupted: j.interrupted, outcome: j.outcome,
      events: j.events.length,
      move: lastMove ? { id: lastMove.id || "", title: lastMove.title || "", state: lastMove.state || "" } : null,
      cost: lastCost ? { usd: lastCost.usd || 0, credits: lastCost.credits || 0 } : null,
      needsInput: j.done ? null : (pending ? { id: pending.id || "", question: pending.question || "" } : null),
    };
  }

  // Replay from `from`, then live-tail. Returns an unsubscribe fn. The replay happens in the same
  // tick as the subscribe so no event can slip through the gap between the two.
  function attach(id, from, onEvent) {
    const job = INDEX.get(id);
    if (!job) { onEvent({ type: "gone" }); onEvent(null); return () => {}; }
    const start = Math.max(0, Math.floor(Number(from) || 0));
    for (const ev of job.events.slice(start)) onEvent(ev);
    if (job.done) { onEvent(null); return () => {}; }
    job.listeners.push(onEvent);
    return () => { const i = job.listeners.indexOf(onEvent); if (i >= 0) job.listeners.splice(i, 1); };
  }

  return { create, emit, finish, stop, get, listFor, activeFor, attach, loadFromDisk, summarize,
           get size() { return INDEX.size; } };
}
