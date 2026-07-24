/*
 * Dominion Works durable job spine self-test. Run with: node idejobs_test.mjs
 * Proves the properties Phase 4 will depend on, using a throwaway temp dir:
 *   1. events are journalled to DISK, not just memory
 *   2. a fresh spine rebuilds the index from those journals (container restart)
 *   3. a job with no terminal event is sealed as INTERRUPTED, never left looking alive
 *   4. replay-from-N then live-tail, with no gap between the two
 *   5. terminal events seal a job so a late callback cannot resurrect it
 *   6. the registry is per-user and view-independent (the thing chat's single job is not)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdeJobs, TERMINAL, EVENT_TYPES } from "./idejobs.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const dirs = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "ide-jobs-")); dirs.push(d); return d; };

await t("a created job writes a header line to its own journal file on disk", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1", workspaceId: "ws_a", kind: "probe" });
  const file = join(dir, "jobs", job.id + ".jsonl");
  assert.ok(existsSync(file), "journal file should exist immediately");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const head = JSON.parse(lines[0]);
  assert.equal(head.type, "job");
  assert.equal(head.uid, "u1");
  assert.equal(head.workspaceId, "ws_a");
});

await t("every emitted event is appended to disk in order", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  jobs.emit(job.id, { type: "plan", title: "P" });
  jobs.emit(job.id, { type: "move", id: "m1", state: "running" });
  jobs.emit(job.id, { type: "move", id: "m1", state: "done" });
  const lines = readFileSync(join(dir, "jobs", job.id + ".jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["job", "plan", "move", "move"]);
  assert.equal(lines[3].state, "done");
});

await t("an unknown event type is refused rather than silently dropped", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  assert.throws(() => jobs.emit(job.id, { type: "sneaky" }), /unknown ide job event type/);
  assert.ok(EVENT_TYPES.has("need_input"));
  assert.ok(TERMINAL.has("done") && TERMINAL.has("error") && TERMINAL.has("stopped"));
});

await t("a terminal event SEALS the job: later emits are refused", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  jobs.finish(job.id, { type: "done", message: "finished" });
  assert.equal(jobs.get(job.id).done, true);
  assert.equal(jobs.emit(job.id, { type: "move", id: "late" }), null, "a late callback must not resurrect a finished build");
  const lines = readFileSync(join(dir, "jobs", job.id + ".jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "the refused event must not reach disk either");
});

await t("RESTART: a new spine over the same dir rebuilds finished jobs from their journals", () => {
  const dir = freshDir();
  const first = createIdeJobs({ dir });
  const job = first.create({ uid: "u1", workspaceId: "ws_a" });
  first.emit(job.id, { type: "move", id: "m1", title: "One", state: "done" });
  first.finish(job.id, { type: "done" });

  const second = createIdeJobs({ dir });              // pretend the container restarted
  const rec = second.loadFromDisk();
  assert.equal(rec.recovered, 1);
  assert.equal(rec.interrupted, 0);
  const back = second.get(job.id);
  assert.ok(back, "the job should be back in the index");
  assert.equal(back.done, true);
  assert.equal(back.outcome, "done");
  assert.equal(back.events.length, 3);
});

await t("RESTART: an unfinished OLD job is sealed as INTERRUPTED and says so honestly", () => {
  const dir = freshDir();
  // The event is stamped far in the past, so the rolling-deploy grace window has long passed.
  const first = createIdeJobs({ dir, now: () => 1000 });
  const job = first.create({ uid: "u1" });
  first.emit(job.id, { type: "move", id: "m1", state: "running" });   // then the container dies

  const second = createIdeJobs({ dir, now: () => 1000 + 5 * 60000 });   // 5 min later
  const rec = second.loadFromDisk();
  assert.equal(rec.interrupted, 1);
  const back = second.get(job.id);
  assert.equal(back.done, true, "never left looking alive");
  assert.equal(back.interrupted, true);
  assert.equal(back.outcome, "error");
  const last = back.events[back.events.length - 1];
  assert.equal(last.code, "interrupted");
  assert.match(last.message, /restarted/i);
  // and the seal is durable: a third boot must not re-seal or duplicate it
  const third = createIdeJobs({ dir });
  const rec3 = third.loadFromDisk();
  assert.equal(rec3.interrupted, 0, "already-sealed jobs must not be sealed twice");
});

await t("ROLLING DEPLOY: a job with a RECENT last event is NOT sealed (Kimi #2 phantom kill)", () => {
  const dir = freshDir();
  const clock = { t: 1000000 };
  const first = createIdeJobs({ dir, now: () => clock.t });
  const job = first.create({ uid: "u1" });
  first.emit(job.id, { type: "move", id: "m1", state: "running" });   // old container still driving

  // The new container boots moments later (within the grace window).
  clock.t += 30000;   // 30s
  const second = createIdeJobs({ dir, now: () => clock.t });
  const rec = second.loadFromDisk();
  assert.equal(rec.interrupted, 0, "a live-driven job must not be sealed as a phantom failure");
  const back = second.get(job.id);
  assert.equal(back.done, false, "left running, because the outgoing instance may still finish it");

  // Much later, with no further activity, it IS genuinely dead and gets sealed.
  clock.t += 5 * 60000;
  const third = createIdeJobs({ dir, now: () => clock.t });
  assert.equal(third.loadFromDisk().interrupted, 1, "a truly stale job is sealed on a later boot");
});

await t("attach replays from N and then live-tails, with no gap", async () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  jobs.emit(job.id, { type: "plan", title: "P" });
  jobs.emit(job.id, { type: "move", id: "m1", state: "running" });

  const seen = [];
  let ended = false;
  jobs.attach(job.id, 1, (ev) => { if (ev === null) ended = true; else seen.push(ev.type); });
  assert.deepEqual(seen, ["plan", "move"], "replay should start at index 1, skipping the header");

  jobs.emit(job.id, { type: "move", id: "m1", state: "done" });
  jobs.finish(job.id, { type: "done" });
  assert.deepEqual(seen, ["plan", "move", "move", "done"], "live tail should continue the same stream");
  assert.equal(ended, true, "the stream must be closed when the job seals");
});

await t("attach to an unknown job yields one 'gone' then closes", () => {
  const jobs = createIdeJobs({ dir: freshDir() });
  const seen = [];
  jobs.attach("ide_nope", 0, (ev) => seen.push(ev === null ? "END" : ev.type));
  assert.deepEqual(seen, ["gone", "END"]);
});

await t("the registry is PER USER and independent of any view", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const a1 = jobs.create({ uid: "alice", workspaceId: "ws_1" });
  const a2 = jobs.create({ uid: "alice", workspaceId: "ws_2" });
  jobs.create({ uid: "bob", workspaceId: "ws_3" });
  jobs.finish(a1.id, { type: "done" });

  const alice = jobs.listFor("alice");
  assert.equal(alice.length, 2, "both of alice's jobs, across two different workspaces");
  assert.equal(jobs.listFor("bob").length, 1);
  assert.equal(jobs.activeFor("alice").length, 1, "one still running");
  assert.equal(jobs.activeFor("alice")[0].id, a2.id);
  assert.ok(!alice.some((j) => j.uid === "bob"), "never another user's job");
});

await t("a summary carries the last move, cost, and any pending question", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  jobs.emit(job.id, { type: "move", id: "m1", title: "First", state: "done" });
  jobs.emit(job.id, { type: "cost", usd: 0.42, credits: 42 });
  jobs.emit(job.id, { type: "need_input", id: "q1", question: "Which database?",
    options: ["Postgres", "SQLite"], default: "Postgres" });
  let s = jobs.listFor("u1")[0];
  assert.equal(s.move.title, "First");
  assert.equal(s.cost.credits, 42);
  assert.equal(s.needsInput.question, "Which database?");
  // the OPTIONS have to survive too, or "answer in one tap" quietly becomes "type it yourself"
  assert.deepEqual(s.needsInput.options, ["Postgres", "SQLite"]);
  assert.equal(s.needsInput.default, "Postgres");

  // answering (work resumes) clears the pending question
  jobs.emit(job.id, { type: "move", id: "m2", title: "Second", state: "running" });
  s = jobs.listFor("u1")[0];
  assert.equal(s.needsInput, null, "a resumed build is no longer asking");
  assert.equal(s.move.title, "Second");

  // and a finished job is never still asking
  jobs.emit(job.id, { type: "need_input", id: "q2", question: "Again?" });
  jobs.finish(job.id, { type: "done" });
  s = jobs.listFor("u1")[0];
  assert.equal(s.needsInput, null);
});

await t("stop() seals a running job and is idempotent", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  let aborted = false;
  job.stop = () => { aborted = true; };
  const r = jobs.stop(job.id, "stopped by the user");
  assert.equal(r.ok, true);
  assert.equal(aborted, true, "the job's own abort hook must fire");
  assert.equal(jobs.get(job.id).outcome, "stopped");
  const again = jobs.stop(job.id);
  assert.equal(again.alreadyDone, true);
  assert.equal(jobs.stop("ide_nope").ok, false);
});

await t("gc keeps live jobs, evicts finished ones, and ARCHIVES their journals (Kimi)", () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir, cap: 3 });
  const live = jobs.create({ uid: "u1" });
  const finished = [];
  for (let i = 0; i < 5; i++) { const j = jobs.create({ uid: "u1" }); jobs.finish(j.id, { type: "done" }); finished.push(j); }
  assert.ok(jobs.size <= 3, "index should be capped, got " + jobs.size);
  assert.ok(jobs.get(live.id), "a LIVE job must never be evicted, however old");
  const topLevel = readdirSync(join(dir, "jobs")).filter((n) => n.endsWith(".jsonl")).length;
  assert.ok(topLevel <= 3, "active journals capped at the index size, found " + topLevel);
  // Evicted journals are archived, not destroyed: the postmortem survives.
  const archived = existsSync(join(dir, "jobs", "archive")) ? readdirSync(join(dir, "jobs", "archive")).length : 0;
  assert.ok(archived >= 1, "at least one evicted journal was archived, found " + archived);
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
await t("waitForAnswer releases a frozen build, and survives the ask/listen race", async () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });

  // the runner's exact sequence: capture from, emit the question, then wait
  const from = jobs.get(job.id).events.length;
  jobs.emit(job.id, { type: "need_input", id: "q1", question: "Continue?", options: ["Yes", "No"] });
  const waiting = jobs.waitForAnswer(job.id, from);
  jobs.emit(job.id, { type: "answer", id: "q1", answer: "Yes" });
  const got = await waiting;
  assert.equal(got.answer, "Yes");

  // THE RACE: the answer lands BEFORE the waiter attaches. Replay-from-`from` must find it, or a
  // paused build would freeze forever on a fast answer.
  const from2 = jobs.get(job.id).events.length;
  jobs.emit(job.id, { type: "need_input", id: "q2", question: "Again?" });
  jobs.emit(job.id, { type: "answer", id: "q2", answer: "raced" });
  const late = await jobs.waitForAnswer(job.id, from2);
  assert.equal(late.answer, "raced", "an answer that beat the waiter must still be found");
});

await t("waitForAnswer resolves null when the job seals instead of hanging forever", async () => {
  const dir = freshDir();
  const jobs = createIdeJobs({ dir });
  const job = jobs.create({ uid: "u1" });
  const from = jobs.get(job.id).events.length;
  jobs.emit(job.id, { type: "need_input", id: "q1", question: "Continue?" });
  const waiting = jobs.waitForAnswer(job.id, from);
  jobs.stop(job.id, "user gave up");
  assert.equal(await waiting, null, "a sealed job must release its waiter with null");
  assert.equal(await jobs.waitForAnswer("ide_nope", 0), null, "an unknown job resolves null immediately");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
