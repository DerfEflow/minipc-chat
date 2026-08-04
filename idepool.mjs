/*
 * Dominion Works - the rolling task pool (Fred, 2026-08-03).
 *
 * The old runner executed discrete waves with a full barrier: one slow task held every
 * satisfied, file-disjoint task out of the next wave, and a failure slid silently into the
 * end-of-build audit. This pool is the scheduling truth, extracted PURE so the riskiest
 * orchestration in the build engine is exercised by tests instead of mirrored by them:
 *
 *   - a task starts the moment its dependencies are done and its files collide with nothing
 *     currently running (readyTasks has enforced both rules since the redesign; the wave
 *     runner just never passed it the running set);
 *   - failure is a fork, not a slide: when the pool drains with failed tasks, askRetry decides
 *     retry / skip / stop, with two-strike caps per task and a bounded number of fork rounds;
 *   - abort and carve-out are fatal: nothing new starts, in-flight work drains, the caller
 *     acts once.
 *
 * The pool knows NOTHING about models, files on disk, events, or money. The caller supplies
 * runTask (model calls + serialized writes) and the notification hooks; this module owns who
 * runs when, and what failure does next. server.mjs is the only production caller.
 */
import { readyTasks } from "./idetasks.mjs";

/*
 * A concurrency gate for model calls. A 12-task roadmap with divided tasks could otherwise
 * fire 30 simultaneous calls at providers that are already wobbling - the thundering herd is
 * what turned one flaky endpoint into nine failed tasks on 2026-08-03. Callers queue in
 * arrival order.
 */
export function createGate(limit) {
  const max = Math.max(1, Math.trunc(Number(limit) || 1));
  let inFlight = 0;
  const waiters = [];
  return {
    async enter() {
      if (inFlight >= max) await new Promise((wake) => waiters.push(wake));
      inFlight++;
    },
    leave() {
      inFlight = Math.max(0, inFlight - 1);
      const wake = waiters.shift();
      if (wake) wake();
    },
    get inFlight() { return inFlight; },
  };
}

/*
 * Run the whole roadmap. runTask(t) resolves to a verdict:
 *   { ok, aborted?, carve?, reason?, error?, ...anything the hooks need }
 * Outcomes: "drained" (all work either done or honestly abandoned), "aborted" (user/system
 * abort), "carve" (a safety wall went up), "stopped" (the user chose stop at the fork),
 * "sealed" (the job died while a question waited - askRetry returned null).
 */
export async function runTaskPool({
  tasks,
  runTask,
  isAborted = () => false,
  maxRetryRounds = 2,
  maxAttemptsPerTask = 3,
  onTaskStart = () => {},
  onTaskDone = () => {},
  onTaskFailed = () => {},
  askRetry = null,
  onRetry = () => {},
} = {}) {
  const done = new Set(), hardFailed = new Set(), runningN = new Set();
  const failReason = new Map(), attemptsByTask = new Map();
  const active = new Map();
  let fatal = null;
  let retryRounds = 0;

  const result = (outcome) => ({
    outcome, done, hardFailed, failReason,
    skipped: tasks.filter((t) => !done.has(t.n) && !hardFailed.has(t.n))
      .map((t) => ({ t, missing: t.needs.filter((n) => !done.has(n)).sort((a, b) => a - b) })),
  });

  const start = (t) => {
    runningN.add(t.n);
    try { onTaskStart(t); } catch {}
    active.set(t.n, Promise.resolve()
      .then(() => runTask(t))
      .then((verdict) => ({ t, verdict: verdict || { ok: false, error: "the task returned no verdict" } }))
      .catch((e) => ({ t, verdict: { ok: false, error: String((e && e.message) || e) } })));
  };

  while (true) {
    if (!fatal && !isAborted()) {
      // Start ONE task, then recompute: starting a task can create a file collision the last
      // readyTasks call could not see, and starting a batch on a stale snapshot is exactly how
      // two owners of the same file end up running together (a real bug this suite caught).
      for (;;) {
        const startable = readyTasks(tasks, { done, running: [...runningN] })
          .filter((t) => !active.has(t.n) && !hardFailed.has(t.n) && !t.needs.some((n) => hardFailed.has(n)));
        if (!startable.length) break;
        start(startable[0]);
      }
    }
    if (!active.size) {
      if (isAborted() || (fatal && fatal.kind === "abort")) return result("aborted");
      if (fatal && fatal.kind === "carve") return result("carve");
      if (hardFailed.size && retryRounds < maxRetryRounds && askRetry) {
        const retryable = [...hardFailed]
          .filter((n) => (attemptsByTask.get(n) || 0) < maxAttemptsPerTask)
          .sort((a, b) => a - b);
        if (retryable.length) {
          const answer = await askRetry(retryable.map((n) => ({ n, reason: failReason.get(n) || "" })));
          if (answer === null) return result("sealed");
          if (answer === "stop") return result("stopped");
          if (answer === "retry") {
            retryRounds++;
            for (const n of retryable) hardFailed.delete(n);
            try { onRetry(retryable); } catch {}
            continue;
          }
          // "skip": fall through and abandon honestly.
        }
      }
      return result("drained");
    }
    const finished = await Promise.race([...active.values()]);
    active.delete(finished.t.n);
    runningN.delete(finished.t.n);
    const verdict = finished.verdict;
    if (verdict.aborted) fatal = fatal || { kind: "abort" };
    else if (verdict.carve) fatal = fatal || { kind: "carve" };
    if (verdict.ok) {
      done.add(finished.t.n);
      try { onTaskDone(finished.t, verdict); } catch {}
    } else if (!fatal) {
      hardFailed.add(finished.t.n);
      attemptsByTask.set(finished.t.n, (attemptsByTask.get(finished.t.n) || 0) + 1);
      const reason = String(verdict.reason || verdict.error || "").slice(0, 160);
      if (reason) failReason.set(finished.t.n, reason);
      try { onTaskFailed(finished.t, failReason.get(finished.t.n) || "", verdict); } catch {}
    }
  }
}
