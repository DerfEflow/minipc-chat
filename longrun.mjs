/*
 * Dominion AI - Long-Run Harness, the spine (SOW docs/LONG-RUN-HARNESS-SOW.md rev B, items 1-3
 * plus the resume half of item 6 and the prose screens of item 4).
 *
 * Why this exists (Fred's 36-hour spec): long work fails as gibberish (context rot), endless
 * loops (nobody watching), or fragility (crash at hour 20 loses everything). The cure is never
 * a time limit or a size cap; it is progress measured by CODE, state on DISK, and bounded
 * verified steps. This module is that code. It never calls a model itself: the segment runner
 * takes callUnit as a dependency, so the whole spine tests with plain data and the model
 * plumbing plugs in at the server (items 5/7 wiring).
 *
 * The ledger IS the job's memory. One JSON line per completed work unit, append-only. Segments
 * read the tail to know where they are; resume after a crash rebuilds purely from it. Nothing
 * trusts the model's self-report: a unit exists when its validated line is on disk.
 *
 * Design laws carried from the SOW:
 *   - Bounded step, unbounded total.
 *   - Every guard fails loud and honest. No silent anything.
 *   - Watchdog verdicts are deterministic: fingerprint loops, the 20-minute stall clock
 *     (Fred's number, D1), and his two-strike rule, all enforced in code.
 */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const STALL_MINUTES_DEFAULT = 20;   // D1: Fred's number. Configurable per job, floor 1.
const LEDGER_TAIL_DEFAULT = 30;            // how many trailing lines a fresh segment context gets
const LOOP_RUN = 3;                        // identical fingerprints in a row = loop

// ---- fingerprints: "same step, same way, same outcome" detectable by code ----
export function fingerprint(action, args, result) {
  const head = String(result ?? "").slice(0, 500);
  return createHash("sha256").update(JSON.stringify([action, args ?? null, head])).digest("hex").slice(0, 24);
}

// ---- item 4 (prose half): degeneration screens, pure and free ----
// Looping models repeat word n-grams at rates real prose never hits. ratio = repeated 5-gram
// occurrences over total 5-grams; healthy text sits well under 0.2 even with refrains.
export function repetitionRatio(text, n = 5) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < n * 2) return 0;
  const seen = new Map();
  let total = 0, repeated = 0;
  for (let i = 0; i + n <= words.length; i++) {
    const gram = words.slice(i, i + n).join(" ");
    total++;
    const c = (seen.get(gram) || 0) + 1;
    seen.set(gram, c);
    if (c > 1) repeated++;
  }
  return total ? repeated / total : 0;
}
export function degenerationScreen(text, { maxRepeatRatio = 0.35, minChars = 1 } = {}) {
  const s = String(text ?? "");
  if (s.length < minChars) return { ok: false, reason: "empty output where content was promised" };
  const junk = (s.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g) || []).length;
  if (junk > 0 && junk / s.length > 0.01) return { ok: false, reason: "output is " + Math.round((junk / s.length) * 100) + "% unreadable bytes (encoding failure)" };
  const ratio = repetitionRatio(s);
  if (ratio > maxRepeatRatio) return { ok: false, reason: "output repeats itself (" + Math.round(ratio * 100) + "% repeated phrases); this is the gibberish signature, so the unit does not count" };
  return { ok: true };
}

// ---- item 3: the watchdog. Deterministic verdicts over the ledger + clock, nothing else. ----
export function watchdogVerdict({ entries = [], nowMs, lastActivityMs, stallMs }) {
  const tail = entries.slice(-LOOP_RUN);
  if (tail.length === LOOP_RUN && tail.every((e) => e.fp && e.fp === tail[0].fp)) {
    return { verdict: "loop", detail: "the last " + LOOP_RUN + " steps were identical (same action, same result). Step: " + (tail[0].action || "unknown") + " on unit " + (tail[0].unit ?? "?") };
  }
  const last2 = entries.slice(-2);
  if (last2.length === 2 && last2.every((e) => e.outcome === "failed" && e.unit === last2[0].unit)) {
    return { verdict: "two-strike", detail: "unit " + last2[0].unit + " failed twice (" + (last2[1].note || "no detail") + "). Stopping to classify instead of thrashing" };
  }
  // A resumed job's old ledger timestamps must never read as a stall: activity is whichever is
  // newer, the last ledger line or the moment THIS run started.
  const lastAt = Math.max(entries.length ? entries[entries.length - 1].at : 0, lastActivityMs || 0);
  if (nowMs - lastAt > stallMs) {
    return { verdict: "stalled", detail: "no progress in " + Math.round((nowMs - lastAt) / 60000) + " minutes (stall clock is " + Math.round(stallMs / 60000) + ")" };
  }
  return { verdict: "ok" };
}

// ---- items 1 + 2 + 6-resume: the store and the segment runner ----
export function createLongRun({ dir, now = Date.now }) {
  mkdirSync(dir, { recursive: true });
  const jobDir = (id) => join(dir, id);
  const metaPath = (id) => join(jobDir(id), "meta.json");
  const ledgerPath = (id) => join(jobDir(id), "ledger.jsonl");

  function writeMeta(meta) {
    const p = metaPath(meta.id), tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, p);   // atomic on the same volume; a crash never leaves half a meta
    return meta;
  }
  function readMeta(id) {
    if (!existsSync(metaPath(id))) return null;
    try { return JSON.parse(readFileSync(metaPath(id), "utf8")); } catch { return null; }
  }
  function readLedger(id) {
    if (!existsSync(ledgerPath(id))) return [];
    return readFileSync(ledgerPath(id), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  function appendLedger(id, entry) {
    const line = { at: now(), ...entry };
    appendFileSync(ledgerPath(id), JSON.stringify(line) + "\n");
    return line;
  }

  function createJob({ mission, model = "", plan = [], stallMinutes = STALL_MINUTES_DEFAULT, meta = {} }) {
    if (!mission || !String(mission).trim()) throw new Error("a job needs a mission line");
    const id = "job-" + randomUUID().slice(0, 13);
    mkdirSync(jobDir(id), { recursive: true });
    return writeMeta({
      id, mission: String(mission).trim(), model, plan,
      // Floor 0.01 min (600ms) exists for tests with injected clocks; real jobs use whole minutes.
      stallMinutes: Math.max(0.01, Number(stallMinutes) || STALL_MINUTES_DEFAULT),
      state: "ready", reason: "", createdAt: now(), updatedAt: now(), ...meta,
    });
  }
  function setState(id, state, reason = "") {
    const m = readMeta(id);
    if (!m) return null;
    return writeMeta({ ...m, state, reason, updatedAt: now() });
  }
  function listJobs() {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.startsWith("job-")).map(readMeta).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  // Resume truth: a unit is DONE when its validated ledger line says so. Nothing else counts.
  function progress(id) {
    const m = readMeta(id);
    if (!m) return null;
    const entries = readLedger(id);
    const done = new Set(entries.filter((e) => e.outcome === "done").map((e) => e.unit));
    const remaining = (m.plan || []).map((u, i) => ({ unit: i, ...u })).filter((u) => !done.has(u.unit));
    return { meta: m, entries, done, remaining };
  }

  /*
   * The segment runner (item 2). Code owns the loop; the model only ever sees one unit at a
   * time with a fresh context pack: the mission line, the ledger tail, and its unit. deps:
   *   callUnit(unit, pack) -> { text, produced?, tokens?, costUsd?, action?, args?, error? }
   *   validate(result, unit) -> { ok, reason }   (defaults to the degeneration screen)
   *   budget: { remaining() -> number|Infinity }  (item 5 wires real billing later; the fuse
   *            interface is honest today: remaining <= 0 pauses the job, never kills it)
   *   onEvent(type, detail)  progress beats for the surface (item 7 wires the chat later)
   */
  async function runJob(id, deps = {}) {
    const callUnit = deps.callUnit;
    if (typeof callUnit !== "function") throw new Error("runJob needs deps.callUnit");
    const validate = deps.validate || ((r) => degenerationScreen(r && r.text));
    const budget = deps.budget || { remaining: () => Infinity };
    const emit = deps.onEvent || (() => {});
    let m = readMeta(id);
    if (!m) return { state: "missing", reason: "no such job " + id };
    if (m.state === "done") return { state: "done", reason: "already complete" };
    if (m.state !== "ready" && m.state !== "running") return { state: m.state, reason: "job is " + m.state + " (" + (m.reason || "no reason recorded") + "); resume it first" };
    m = setState(id, "running");
    const startedAt = now();

    while (true) {
      const p = progress(id);
      // Cooperative pause (item 7 wiring): /jobs pause flips the meta; the driver honors it at
      // the next unit boundary instead of finishing the job and overwriting the state. The
      // in-flight unit completes (bounded step law), so pausing never tears a unit.
      if (p.meta.state === "paused") {
        emit("paused", { why: "request" });
        return { state: "paused", reason: p.meta.reason || "paused by request" };
      }
      if (!p.remaining.length) {
        setState(id, "done");
        emit("done", { units: p.done.size });
        return { state: "done", units: p.done.size };
      }
      // Watchdog BEFORE spending anything on the next step.
      const wd = watchdogVerdict({ entries: p.entries, nowMs: now(), lastActivityMs: startedAt, stallMs: p.meta.stallMinutes * 60000 });
      if (wd.verdict !== "ok") {
        setState(id, "halted", wd.verdict + ": " + wd.detail);
        emit("halted", wd);
        return { state: "halted", ...wd };
      }
      if (budget.remaining() <= 0) {
        setState(id, "paused", "budget tranche exhausted; approve the next tranche to continue (D2: the fuse pauses, it never kills)");
        emit("paused", { why: "budget" });
        return { state: "paused", reason: "budget tranche exhausted" };
      }
      const unit = p.remaining[0];
      const pack = { mission: p.meta.mission, ledgerTail: p.entries.slice(-LEDGER_TAIL_DEFAULT), unit };
      emit("unit-start", { unit: unit.unit, title: unit.title });

      // The stall clock races every unit call directly. The between-steps watchdog can never
      // catch a HANGING unit (the runner is awaiting it), so the same 20-minute rule bounds one
      // unit's wall time here. The losing promise cannot be cancelled; it is abandoned, and the
      // job halts honestly (a cooperative abort signal is item 7 wiring).
      const stallMs = p.meta.stallMinutes * 60000;
      const raceUnit = (args) => new Promise((resolve) => {
        // Deliberately NOT unref'd: this timer is the watchdog, and it must keep the process
        // alive to fire. It is always cleared on a settled unit, so it never delays shutdown.
        const timer = setTimeout(() => resolve({ __stalled: true }), stallMs);
        Promise.resolve().then(() => callUnit(unit, args))
          .then((r) => { clearTimeout(timer); resolve({ r }); })
          .catch((e) => { clearTimeout(timer); resolve({ err: String((e && e.message) || e) }); });
      });

      let result, verdictNote = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const raced = await raceUnit({ ...pack, retryReason: verdictNote || undefined });
        if (raced.__stalled) {
          const detail = "unit " + unit.unit + " produced nothing for " + p.meta.stallMinutes + " minutes (the stall clock). The step was abandoned, nothing was recorded for it";
          setState(id, "halted", "stalled: " + detail);
          emit("halted", { verdict: "stalled", detail });
          return { state: "halted", verdict: "stalled", detail };
        }
        result = raced.err ? { error: raced.err } : raced.r;
        if (result && result.error) { verdictNote = result.error; result = null; }
        else {
          const v = validate(result, unit);
          if (v.ok) break;
          verdictNote = v.reason;   // retry once WITH the failure shown, per SOW item 4
          result = null;
        }
        if (attempt === 2) {
          appendLedger(id, { unit: unit.unit, action: unit.title || "unit", outcome: "failed", note: verdictNote, fp: fingerprint(unit.title, unit, verdictNote) });
          const p2 = progress(id);
          const wd2 = watchdogVerdict({ entries: p2.entries, nowMs: now(), lastActivityMs: startedAt, stallMs: p2.meta.stallMinutes * 60000 });
          if (wd2.verdict !== "ok") {
            setState(id, "halted", wd2.verdict + ": " + wd2.detail);
            emit("halted", wd2);
            return { state: "halted", ...wd2 };
          }
          setState(id, "paused", "unit " + unit.unit + " failed validation twice: " + verdictNote);
          emit("paused", { why: "validation", unit: unit.unit, reason: verdictNote });
          return { state: "paused", reason: verdictNote, unit: unit.unit };
        }
      }
      appendLedger(id, {
        unit: unit.unit, action: unit.title || "unit", outcome: "done",
        produced: result.produced || [], tokens: result.tokens || 0, costUsd: result.costUsd || 0,
        note: result.note || "", fp: fingerprint(unit.title, unit, result.text),
      });
      emit("unit-done", { unit: unit.unit });
    }
  }

  function resumeJob(id) {
    const m = readMeta(id);
    if (!m) return null;
    if (m.state === "done") return m;
    return setState(id, "ready", "resumed; ledger is the memory, nothing was lost");
  }

  return { createJob, readMeta, readLedger, appendLedger, listJobs, progress, runJob, resumeJob, pauseJob: (id, why) => setState(id, "paused", why || "paused by request"), dir };
}
