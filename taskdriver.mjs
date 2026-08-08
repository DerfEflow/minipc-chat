/*
 * Dominion AI — taskdriver: the clock that makes provider-backed work finish on its own.
 *
 * The problem it removes: before this loop, the ONLY thing that ever advanced a video job was an
 * open browser tab sending GET /jobs/:id. Runware would finish a clip, the provider URL would age
 * out, and a user who had walked to the Crucible came back to a paid-for generation that no longer
 * existed anywhere. The record was durable the whole time. Nothing was driving it.
 *
 * One timer, not one per task. A per-job setTimeout chain looks simpler and fails badly: timers
 * die with the process, so a restart silently strands every job that had one, and a hundred jobs
 * means a hundred timers competing. This loop wakes on a fixed interval, asks the kernel which
 * tasks are due, and works that list. It is stateless between ticks, so a restart costs at most one
 * interval of delay and nothing else.
 *
 * Three properties worth stating because each one is a bug we would otherwise ship:
 *   - REENTRANCY. A tick that overruns its interval must not overlap itself. A slow provider would
 *     otherwise stack ticks until the process died.
 *   - EXCLUSIVITY. claimDue selects and reschedules in one transaction (see taskkernel), so even
 *     if two ticks did overlap, the same task cannot be polled twice concurrently.
 *   - ISOLATION. One handler throwing must not stop the loop, must not stop the other tasks in
 *     the same tick, and must not fail its own task on the first try, because the overwhelmingly
 *     common cause is a transient provider blip that the next poll will sail through.
 *
 * A task only dies of old age, never of a bad minute. `deadlineAt` from the kernel (set from the
 * handler's maxAgeMs, or the driver default) is the single stop condition, and when it trips the
 * task fails LOUDLY with a notification rather than being quietly dropped. A user whose video
 * never arrives must be told it never arrived.
 */

// Default ceiling for a task whose kind declares no maxAgeMs. Six hours is far past any legitimate
// generation and far short of forever, which is the only number that actually matters here.
const DEFAULT_MAX_AGE_MS = 6 * 3600000;

export function createTaskDriver({
  kernel,
  intervalMs = 2000,
  batch = 25,
  concurrency = 6,
  defaultMaxAgeMs = DEFAULT_MAX_AGE_MS,
  onNotify = null,
  log = () => {},
  now = Date.now,
}) {
  let timer = null, ticking = false, stopped = false;
  const stats = { ticks: 0, polled: 0, settled: 0, failed: 0, expired: 0, errors: 0, notified: 0 };

  /*
   * The api handed to a poll handler. Deliberately narrow: a handler may report progress, record
   * where the artifact landed, and read its own row. It may NOT finish itself, because the driver
   * needs to own the terminal transition to guarantee exactly one notification per task.
   */
  function apiFor(task) {
    let seq = task.eventCount || 0;
    return {
      task,
      emit(ev) {
        if (!ev || typeof ev !== "object") return;
        kernel.appendRows(task.id, [{ seq, span: 1, ev }], seq + 1, task.textChars || 0);
        seq++;
      },
      bind(patch) { kernel.bindMeta(task.id, patch || {}); },
      reload() { return kernel.get(task.id); },
    };
  }

  async function pollOne(task) {
    const handler = kernel.handlerFor(task.kind);
    // An unregistered kind means a half-deployed build, not a broken task. Leave it alone: failing
    // someone's paid video over a deploy ordering accident would be the worse outcome.
    if (!handler || typeof handler.poll !== "function") { kernel.stopPolling(task.id); return; }

    const deadline = task.deadlineAt || (task.startedAt + defaultMaxAgeMs);
    if (now() >= deadline) {
      stats.expired++;
      const api = apiFor(task);
      api.emit({ type: "error", code: "deadline", message: "This ran far longer than it should have and was stopped. Nothing was charged for work that never arrived." });
      kernel.finish(task.id, "failed", { reason: "deadline", ageMs: now() - task.startedAt });
      log(`taskdriver: ${task.kind} ${task.id} expired after ${Math.round((now() - task.startedAt) / 1000)}s`);
      return;
    }

    stats.polled++;
    const api = apiFor(task);
    let out;
    try {
      out = await handler.poll(task, api);
    } catch (e) {
      // Transient by assumption. The deadline above is what eventually ends a genuinely broken
      // task, so a provider having a bad minute costs a retry rather than a user's generation.
      stats.errors++;
      log(`taskdriver: ${task.kind} ${task.id} poll threw: ${(e && e.message) || e}`);
      return;
    }
    if (!out || typeof out !== "object") return;   // still working, keep the scheduled backoff

    if (out.failed) {
      stats.failed++;
      api.emit({ type: "error", code: out.code || "failed", message: String(out.message || "This did not finish.") });
      kernel.finish(task.id, "failed", { reason: out.code || "failed", message: out.message || "" });
      return;
    }
    if (out.needsInput) { kernel.setStatus(task.id, "needs_input"); kernel.stopPolling(task.id); return; }
    if (out.done) {
      stats.settled++;
      if (out.resultRef) kernel.bindMeta(task.id, { resultRef: out.resultRef });
      kernel.finish(task.id, "done", out.meta || null);
      return;
    }
    // An explicit retry hint from the provider (a Retry-After, a queue position) beats our curve.
    if (out.retryInMs > 0) kernel.scheduleNext(task.id, out.retryInMs);
  }

  // A small gate so a backlog of due tasks does not open fifty provider sockets at once.
  async function runGated(items, worker, limit) {
    const queue = items.slice();
    const lanes = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try { await worker(item); } catch (e) { stats.errors++; log(`taskdriver: lane error: ${(e && e.message) || e}`); }
      }
    });
    await Promise.all(lanes);
  }

  /*
   * Notification drain. Terminal tasks that were never announced get handed to onNotify exactly
   * once. markNotified only happens after the sink accepts, so a notifier that throws leaves the
   * task in the queue for the next tick instead of swallowing the only message the user gets.
   */
  async function drainNotifications() {
    if (typeof onNotify !== "function") return;
    for (const row of kernel.pendingNotifications(50)) {
      try {
        await onNotify(kernel.notificationFor(row), row);
        kernel.markNotified(row.id);
        stats.notified++;
      } catch (e) {
        log(`taskdriver: notify failed for ${row.id}, will retry: ${(e && e.message) || e}`);
      }
    }
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      stats.ticks++;
      const due = kernel.claimDue(batch);
      if (due.length) await runGated(due, pollOne, concurrency);
      await drainNotifications();
    } catch (e) {
      stats.errors++;
      log(`taskdriver: tick failed: ${(e && e.message) || e}`);
    } finally { ticking = false; }
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { void tick(); }, intervalMs);
    // Never hold the process open. The driver is a background service, not a reason to stay alive.
    if (typeof timer.unref === "function") timer.unref();
    log(`taskdriver: started, ${intervalMs}ms tick, ${concurrency} lanes`);
  }
  function stop() { stopped = true; if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, tick, stats: () => ({ ...stats }) };
}
