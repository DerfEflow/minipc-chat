/*
 * Dominion AI — running a scheduled work order on a real machine.
 *
 * Kept apart from the store so the thing that TOUCHES SOMEBODY'S FILES can be tested against a fake
 * machine, exhaustively, without a laptop in the loop. The store decides when; this decides what
 * happens, and what happens when the machine is not there.
 *
 * Three rules that are the whole point:
 *
 *   1. A MISSED RUN IS NOT A SKIPPED RUN. A laptop is asleep at 3am. If the machine is not
 *      connected the order is parked as `waiting` and its schedule is NOT advanced, so it fires the
 *      moment that machine reappears. The alternative, quietly rolling to tomorrow, means a job
 *      that never runs while the dashboard shows a healthy next-run time.
 *
 *   2. THE FIRST RUN OF ANYTHING THAT MOVES FILES IS A DRY RUN. It reports every move it would
 *      make and changes nothing. Nobody's documents get rearranged unattended on the strength of a
 *      path typed into a phone at midnight.
 *
 *   3. NO PARTIAL TRUTH. If the machine answers something this cannot parse, that is a FAILURE with
 *      the raw text kept, never a cheerful "0 files sorted". A tidy-up job reporting success while
 *      having done nothing is how you stop checking.
 */
import { sorterCommand, undoCommand, parseSorterResult, summarizeSort } from "./worksorter.mjs";

// A sort of a large Downloads folder is thousands of small moves. Generous, still bounded.
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export function createWorkOrderRunner({ store, dispatch, nodeOnline, log = () => {} } = {}) {
  if (!store) throw new Error("the runner needs the work-order store");

  /*
   * Which machine. An order names one; if it did not, and exactly one machine is connected, that is
   * unambiguous enough to use. More than one and it waits to be told, because guessing which
   * computer to rearrange is not a guess worth making.
   */
  function resolveNode(order, online) {
    if (order.node) return order.node;
    return online.length === 1 ? online[0] : "";
  }

  async function runOne(order, { force = false } = {}) {
    const online = (() => { try { return nodeOnline() || []; } catch { return []; } })();
    const node = resolveNode(order, online);
    if (!node || !online.includes(node)) {
      store.markWaiting(order.id, node || "a machine");
      log(`work-order ${order.id}: waiting for ${node || "a machine to come online"}`);
      return { ok: false, waiting: true, node };
    }

    // Dry run until the order has spent it, unless the caller is deliberately running for real.
    const dryRun = !!order.dryRunFirst && !force;
    let command;
    if (order.task === "sort_by_type") command = sorterCommand({ root: order.folder, dryRun });
    else if (order.task === "folder_report") command = sorterCommand({ root: order.folder, dryRun: true });
    else {
      const summary = `That task is not one this server knows how to run: ${order.task}`;
      store.recordRun(order.id, { ok: false, summary, journal: [] });
      return { ok: false, error: summary };
    }

    let raw;
    try {
      raw = await dispatch(node, "shell_run", { command, timeoutMs: RUN_TIMEOUT_MS }, { timeoutMs: RUN_TIMEOUT_MS + 30000 });
    } catch (e) {
      const summary = "The machine could not be reached: " + String((e && e.message) || e).slice(0, 200);
      store.recordRun(order.id, { ok: false, summary, journal: [] });
      log(`work-order ${order.id}: ${summary}`);
      return { ok: false, error: summary };
    }

    if (!raw || raw.ok === false) {
      const summary = "The machine refused or failed: " + String((raw && (raw.error || raw.reason)) || "no answer").slice(0, 200);
      store.recordRun(order.id, { ok: false, summary, journal: [] });
      return { ok: false, error: summary };
    }

    const parsed = parseSorterResult(raw.stdout || raw.output || "");
    if (parsed.ok === false) {
      // Unparseable is a failure, loudly, with the raw text kept for diagnosis. Never a quiet zero.
      const summary = "The job ran but its result could not be read: " + String(parsed.error || "").slice(0, 160);
      store.recordRun(order.id, { ok: false, summary, journal: [] });
      log(`work-order ${order.id}: ${summary}`);
      return { ok: false, error: summary, raw: parsed.raw };
    }

    const summary = (dryRun ? "Dry run. " : "") + summarizeSort(parsed);
    // Only a REAL run leaves an undoable journal; a dry run moved nothing to undo.
    const journal = dryRun ? [] : (parsed.moved || []).map((m) => ({ from: m.from, to: m.to }));
    const after = store.recordRun(order.id, { ok: true, summary, journal, dryRun });
    log(`work-order ${order.id} on ${node}: ${summary}`);
    return { ok: true, dryRun, summary, moved: (parsed.moved || []).length, order: after };
  }

  return {
    runOne,

    // The ticker. Anything due, in order, one at a time: two jobs rearranging the same folder at
    // once is a race nobody needs, and a handful of file moves is not worth parallelising.
    async tick(nowMs) {
      const due = store.due(nowMs);
      const out = [];
      for (const o of due) { try { out.push(await runOne(o)); } catch (e) { log("work-order tick error: " + e.message); } }
      return out;
    },

    /*
     * A machine just reconnected. Anything parked waiting for it runs now. This is what turns
     * "every morning at 3" into something a laptop can actually honour.
     */
    async onNodeOnline(node) {
      const waiting = store.waitingOn(node);
      if (!waiting.length) return [];
      log(`work-order: ${node} is back, ${waiting.length} order(s) were waiting for it`);
      const out = [];
      for (const o of waiting) { try { out.push(await runOne(o)); } catch (e) { log("work-order catch-up error: " + e.message); } }
      return out;
    },

    // Put a run back the way it was, from the journal that run recorded.
    async undo(order) {
      const moves = order.journal || [];
      if (!moves.length) return { ok: false, error: "That run has nothing to undo." };
      const online = (() => { try { return nodeOnline() || []; } catch { return []; } })();
      const node = resolveNode(order, online);
      if (!node || !online.includes(node)) return { ok: false, error: `${node || "That machine"} is not online, so the files cannot be put back yet.` };
      const raw = await dispatch(node, "shell_run", { command: undoCommand({ moves }), timeoutMs: RUN_TIMEOUT_MS }, { timeoutMs: RUN_TIMEOUT_MS + 30000 });
      const parsed = parseSorterResult((raw && (raw.stdout || raw.output)) || "");
      if (parsed.ok === false) return { ok: false, error: parsed.error || "the undo could not be read" };
      const restored = (parsed.restored || []).length, skipped = (parsed.skipped || []).length;
      return { ok: true, restored, skipped,
        summary: `${restored} file${restored === 1 ? "" : "s"} put back` + (skipped ? `, ${skipped} left alone` : "") + "." };
    },
  };
}
