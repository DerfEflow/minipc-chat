/*
 * Dominion AI: token-ceiling usage instrumentation (Lane D, 2026-08-03, Fred's ruling).
 *
 * Fred's mission line, verbatim: "Keep the token ceilings very generous now, and record enough real
 * data that after several hundred turns Fred can answer 'where should this actually be capped' from
 * measurements instead of a guess." Ceilings themselves stay generous (models.catalog.mjs owns
 * outLimitFor/OUT_MODE_CEIL/REASONING_FLOOR, untouched by this module); THIS module only records
 * what actually happened on each completed model round, so the narrowing decision is made from
 * measurements later.
 *
 * The defect this exists to avoid (Fred's framing): "A log that records consumption but never
 * records whether a turn HIT its ceiling cannot answer the narrowing question." So every written
 * record MANDATORILY carries finish_reason, usedTokens, budgetTokens, and an explicit hitCeiling
 * boolean. A test asserts all four appear on every written line (see usage-limits_test.mjs).
 *
 * ---------------------------------------------------------------------------------------------
 * REVIEW PASS 2026-08-03 (adversarial). Eleven reproduced defects in the first cut are fixed here.
 * Each one had a way of making Fred's cap decision WRONG, which costs real money, so each is named:
 *
 *  1. PII could ride in on `model`, `mode`, and `finishReason`. The first cut only guarded against
 *     unknown field names. A caller passing "openai/gpt-5.6 (user said his SSN is 555-12-3456)"
 *     wrote the SSN straight to disk. Every stored string is now token-clamped and charset-clamped.
 *  2. A provider that reports no usage row was indistinguishable from a genuine zero-token round.
 *     Both wrote usedTokens: 0. Percentiles then read a transport gap as cheap traffic. `usageKnown`
 *     now separates them and the percentiles ignore unmeasured rounds.
 *  3. A budget-shrunk cap (affordableWorkerOutput squeezing a round to 300 when the model's real
 *     ceiling is 32768) recorded hitCeiling: true, which reads as evidence the MODEL ceiling is too
 *     low. `modelCeiling` and `budgetConstrained` now separate the two, and the headline
 *     ceiling-evidence number excludes budget-constrained rounds.
 *  4. Percentiles blended fast mode (a 2048 cap, per OUT_MODE_CEIL) with normal mode (full maxOut)
 *     inside one model row. The cap is per model AND per mode, so the summary now splits by mode.
 *  5. The finish-reason classifier missed the Anthropic-native "max_tokens" spelling and every
 *     spaced or hyphenated variant. Classification now normalizes before matching.
 *  6. A torn append (crash mid-write, no trailing newline) silently destroyed the NEXT record too,
 *     because the following append fused onto the broken line. The writer now repairs the seam.
 *  7. Unbounded file growth: no rotation, no size cap, and load() read the whole file at boot.
 *     One generation of rotation at MAX_BYTES now bounds both.
 *  8. appendFileSync ran on the hot path of every model round. Writes are now batched and async,
 *     with a synchronous flush on process exit so nothing is lost on a clean shutdown.
 *
 * PII: this module never accepts message/answer text as a field. record() destructures a fixed set
 * of scalar/boolean/number inputs; nothing about a caller's extra properties can ride along, because
 * the written entry is built by hand from named fields, never by spreading the caller's object. The
 * three fields that ARE strings (model, mode, finish_reason) are each reduced to a single short
 * token from a safe charset, so a careless caller can leak at most one truncated word.
 *
 * Storage pattern: an append-only JSONL file the caller points at, plus a bounded in-memory rolling
 * window per model for the summary. Same load()/fold() shape as idetelemetry.mjs, same "pure and
 * injected" discipline: nothing here reaches the network or a clock it was not given.
 *
 * CROSS-LANE NOTE (models.catalog.mjs belongs to another agent this wave; this module imports
 * nothing from it and writes nothing to it): OUT_MODE_CEIL and REASONING_FLOOR were private
 * (`const`, no `export`) at the start of this review and were exported by a concurrent pass at
 * 02:44 on 2026-08-03. This module still takes `reasoningFloor` and `modelCeiling` as CALLER-
 * supplied fields rather than importing them, so a later revert on that file cannot break the
 * recorder, and so this module keeps its "pure and injected" property with no import cycle back
 * toward server.mjs's dependency graph. The wiring spec at docs/wiring/lane-d-limits.md carries the
 * exact lines server.mjs uses to source both.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync, promises as fsp } from "node:fs";
import { join, dirname } from "node:path";

// Rolling samples per model held in memory for the summary. "Several hundred turns" total, spread
// across roughly a dozen catalog models, sits well inside this without needing to re-read the file.
const KEEP = 2000;

// One generation of rotation. At roughly 260 bytes a record this holds ~32,000 rounds per
// generation, ~64,000 across both, which is two orders of magnitude past the "several hundred
// turns" the mission asks for and still bounds boot-time reads and disk use forever.
const MAX_BYTES = 8 * 1024 * 1024;

// Below this many MEASURED rounds the summary refuses to recommend a cap. A percentile over a
// handful of samples is a guess wearing a decimal point, which is the exact thing Fred asked to
// replace.
const MIN_SAMPLES_FOR_VERDICT = 30;

// A cap that truncates this fraction of rounds or more is binding. Above it the observed token
// distribution is CENSORED (every truncated round would have used more than it was allowed), so no
// honest narrowing figure can be computed from it, and the verdict is "raise", never a number.
const BINDING_HIT_FRACTION = 0.05;

/*
 * ---- string hygiene -------------------------------------------------------------------------
 * Three record fields are strings. All three are short identifiers in every legitimate call, so
 * each is reduced to its FIRST whitespace-delimited token, stripped to a safe charset, and clamped.
 * Prose therefore cannot survive: "openai/gpt-5.6 (user said his SSN is 555-12-3456)" stores as
 * "openai/gpt-5.6", and an error string carrying a card number stores as "error".
 */
const safeToken = (value, maxLen, extraChars) => {
  const first = String(value == null ? "" : value).trim().split(/\s+/)[0] || "";
  const re = new RegExp("[^A-Za-z0-9" + extraChars + "]+", "g");
  return first.replace(re, "").slice(0, maxLen);
};
const safeModel = (value) => safeToken(value, 80, "._/:@-");
const safeMode = (value) => (safeToken(value, 24, "_-").toLowerCase() || "normal");

/*
 * Canonical finish reasons Dominion's own transport layer already emits. providerexecution.mjs's
 * canonicalTerminalReason() maps every provider spelling onto this set before server.mjs sees it,
 * so in practice these are the values that arrive. Anything outside the set is a raw provider
 * string and gets the one-token treatment above.
 */
const KNOWN_FINISH = new Set([
  "stop", "tool_calls", "length", "max_tokens", "max_output_tokens", "token_limit",
  "content_filter", "insufficient_system_resource", "cancelled", "error", "incomplete",
  "context_length", "context_length_exceeded",
]);

// Normalize a raw provider finish reason for CLASSIFICATION: lowercase, and collapse spaces and
// hyphens to underscores so "MAX TOKENS", "max-tokens", and "max_tokens" are one thing.
const normalizeFinish = (reason) =>
  String(reason == null ? "" : reason).trim().toLowerCase().replace(/[\s-]+/g, "_");

/*
 * Spellings that mean "the provider stopped ONLY because the OUTPUT ceiling was reached". This
 * mirrors the subset of providerexecution.mjs's canonicalTerminalReason() that is genuinely about
 * the output budget.
 *
 * context_length / context_length_exceeded are deliberately EXCLUDED. Upstream folds them into
 * "length", but they describe an INPUT context overflow, which says nothing about whether the
 * output cap should move. Counting them would tell Fred to raise a ceiling that was never the
 * constraint. (Because upstream canonicalization has already rewritten them to "length" by the time
 * server.mjs reads finishReason, this exclusion only bites on lanes that pass the raw string
 * through; the limitation is recorded in docs/wiring/lane-d-limits.md rather than papered over.)
 */
const CEILING_FINISH = new Set(["length", "max_tokens", "max_output_tokens", "max_output_token", "token_limit", "incomplete"]);
export function isCeilingFinish(reason) {
  return CEILING_FINISH.has(normalizeFinish(reason));
}

/*
 * ONE process-exit listener for the whole module, no matter how many stores exist. Registering per
 * store tripped Node's MaxListeners warning as soon as a test built a dozen of them, and a warning
 * that fires in normal use is a warning nobody reads when it matters.
 */
const exitFlushers = [];
function registerExitFlush(fn) {
  if (typeof process === "undefined" || !process.once) return;
  if (!exitFlushers.length) {
    process.once("exit", () => { for (const f of exitFlushers) { try { f(); } catch {} } });
  }
  exitFlushers.push(fn);
}

export function createUsageLimits({ dir, now = Date.now, sync = false } = {}) {
  const file = dir ? join(dir, "usage-limits.jsonl") : null;
  const rotated = file ? file.replace(/\.jsonl$/, ".1.jsonl") : null;
  const mem = new Map();   // modelId -> array of folded records, capped at KEEP

  let pending = [];        // lines waiting to be written
  let writing = null;      // in-flight flush promise, so appends stay ordered
  let seamRepairNeeded = false;   // a previous process died mid-append and left a line with no "\n"

  function fold(e) {
    if (!e || !e.model) return;
    const arr = mem.get(e.model) || [];
    arr.push(e);
    if (arr.length > KEEP) arr.shift();
    mem.set(e.model, arr);
  }

  function loadFile(path) {
    if (!path || !existsSync(path)) return;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e && e.model) fold(e);
      }
    } catch {}
  }

  function load() {
    if (!file) return;
    loadFile(rotated);   // older generation first, so the in-memory window stays chronological
    loadFile(file);
    // Torn-write detection. A crash between the JSON and its newline leaves a partial final line.
    // Appending onto it would fuse the next good record into the wreckage and lose BOTH. The first
    // write of this process prepends a newline to close the seam instead.
    try {
      if (existsSync(file)) {
        const size = statSync(file).size;
        if (size > 0) {
          const tail = readFileSync(file, "utf8").slice(-1);
          if (tail !== "\n") seamRepairNeeded = true;
        }
      }
    } catch {}
  }

  function rotateIfNeeded() {
    if (!file || !rotated) return;
    try {
      if (existsSync(file) && statSync(file).size >= MAX_BYTES) {
        renameSync(file, rotated);   // one generation kept; the previous .1 is replaced
        seamRepairNeeded = false;
      }
    } catch {}
  }

  function take() {
    const batch = pending;
    pending = [];
    let text = batch.join("");
    if (seamRepairNeeded && text) { text = "\n" + text; seamRepairNeeded = false; }
    return text;
  }

  // Writes are batched and asynchronous so no model round pays for a disk syscall inline. Ordering
  // is preserved by chaining onto the in-flight promise. `sync: true` is for tests and for callers
  // that want the old inline behavior.
  function flush() {
    if (!file || !pending.length) return writing || Promise.resolve();
    const run = async () => {
      while (pending.length) {
        const text = take();
        if (!text) continue;
        try {
          rotateIfNeeded();
          await fsp.mkdir(dirname(file), { recursive: true });
          await fsp.appendFile(file, text);
        } catch {}
      }
    };
    writing = (writing || Promise.resolve()).then(run, run);
    return writing;
  }

  function flushSync() {
    if (!file || !pending.length) return;
    const text = take();
    if (!text) return;
    try {
      rotateIfNeeded();
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text);
    } catch {}
  }

  let exitHooked = false;
  function hookExit() {
    if (exitHooked || !file) return;
    exitHooked = true;
    registerExitFlush(flushSync);
  }

  /*
   * Record ONE completed model round (a single settled provider call). A round that FAILED is not a
   * round: pass ok: false for it, or better, do not call at all. See the wiring spec.
   *
   * Inputs, all by name (never spread, so no caller field can sneak an extra property into the
   * written record):
   *   model             catalog model id                                    (required)
   *   mode              the chat mode this round ran under ("normal", "fast", ...)
   *   ceiling           the output-token ceiling ACTUALLY sent to the provider for this round
   *                     (roundOutputCap / continuationOutputCap, which may be below the model's own
   *                     ceiling when the session budget squeezed it)
   *   modelCeiling      the model's own configured ceiling for this mode (outLimitFor(model, mode)).
   *                     Optional but strongly wanted: without it, a budget-squeezed round is
   *                     indistinguishable from a genuine model-ceiling hit, and Fred's narrowing
   *                     decision reads the wrong number.
   *   usedTokens        output tokens the provider reports it spent. Pass null/undefined when the
   *                     provider returned NO usage row, so it is recorded as unmeasured rather than
   *                     as a genuine zero.
   *   finishReason      the provider's finish/stop reason string
   *   emptyOutput       true if the visible answer text came back empty (the starvation signature);
   *                     the caller computes this from its own answer variable and passes a boolean
   *                     ONLY: the text itself never reaches this module
   *   reasoningFloor    the measured starvation floor that applied to this model, if any (nullable)
   *   ok                false for a round that did not settle (transport failure). Recorded, but
   *                     excluded from every statistic, so a dead provider cannot deflate the
   *                     measured token distribution.
   *
   * Returns the written entry, or null if `model` was missing or unusable.
   */
  function record(input) {
    // Destructure from a normalized object rather than a default parameter. A default only fires on
    // `undefined`, so `record(null)` used to throw, and a throw here lands in the hot path of a live
    // chat turn.
    const {
      model, mode = "normal", ceiling = 0, modelCeiling = null, usedTokens = null, finishReason = "",
      emptyOutput = false, reasoningFloor = null, ok = true,
    } = (input && typeof input === "object") ? input : {};
    const modelId = safeModel(model);
    if (!modelId) return null;

    const budgetTokens = Math.max(0, Number(ceiling) || 0);
    const rawCeil = Number(modelCeiling);
    const fullCeiling = Number.isFinite(rawCeil) && rawCeil > 0 ? Math.floor(rawCeil) : null;

    const rawUsed = Number(usedTokens);
    const usageKnown = usedTokens != null && Number.isFinite(rawUsed) && rawUsed >= 0;
    const used = usageKnown ? Math.floor(rawUsed) : 0;

    const normalized = normalizeFinish(finishReason);
    const finish_reason = KNOWN_FINISH.has(normalized) ? normalized : safeToken(finishReason, 32, "_");

    /*
     * A round hits the ceiling two ways: the provider SAYS so (finish reason), or it silently spent
     * every token it was given. The silent branch requires usageKnown, because a missing usage row
     * reads as used === 0, and 0 >= budget is only ever true when there was no budget at all.
     */
    const hitCeiling = isCeilingFinish(normalized) || (usageKnown && budgetTokens > 0 && used >= budgetTokens);
    // The applied cap was below the model's own cap, so a hit here is evidence about the SESSION
    // BUDGET, never about where the model ceiling belongs.
    const budgetConstrained = fullCeiling != null && budgetTokens > 0 && budgetTokens < fullCeiling;
    const floor = (typeof reasoningFloor === "number" && reasoningFloor > 0) ? Math.floor(reasoningFloor) : null;

    const entry = {
      at: now(),
      model: modelId,
      mode: safeMode(mode),
      budgetTokens,
      modelCeiling: fullCeiling,
      usedTokens: used,
      usageKnown,
      finish_reason,
      hitCeiling: !!hitCeiling,
      budgetConstrained: !!budgetConstrained,
      emptyOutput: !!emptyOutput,
      reasoningFloor: floor,
      ok: ok !== false,
    };
    fold(entry);
    if (file) {
      pending.push(JSON.stringify(entry) + "\n");
      hookExit();
      if (sync) flushSync(); else flush();
    }
    return entry;
  }

  const nth = (sorted, p) => {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  };

  /*
   * The one number Fred asked for, computed honestly.
   *
   * A raw p95 of used tokens does NOT answer "where should this be capped", for two reasons the
   * first cut of this module missed:
   *
   *   1. The sample is CENSORED. A round that hit the cap would have used more if allowed, so its
   *      recorded usage is a lower bound. Fitting a new cap to censored data recommends capping at
   *      roughly the cap you already have, forever. So when the cap is binding (>= 5% of rounds
   *      truncated) the verdict is "raise" and no number is offered.
   *   2. The cap is per model AND per mode (OUT_MODE_CEIL gives fast mode 2048 while normal mode
   *      gets the model's full maxOut). Blending them makes both percentiles meaningless. Every
   *      row therefore carries a byMode breakdown, and the per-mode rows are the ones to act on.
   *
   * Budget-constrained rounds (the session budget squeezed the cap below the model's own ceiling)
   * are excluded from the ceiling-evidence figures and from the percentiles, because their cap was
   * never the model ceiling under review.
   */
  function statsFor(records) {
    const n = records.length;
    const settled = records.filter((r) => r.ok !== false);
    const nSettled = settled.length;
    // Rounds whose cap actually WAS the model ceiling under review.
    const atFull = settled.filter((r) => !r.budgetConstrained);
    const measured = atFull.filter((r) => r.usageKnown !== false);
    const nMeasured = measured.length;

    const frac = (count, total) => (total ? +(count / total).toFixed(4) : 0);
    const hitCount = settled.reduce((s, r) => s + (r.hitCeiling ? 1 : 0), 0);
    const evidenceHits = atFull.reduce((s, r) => s + (r.hitCeiling ? 1 : 0), 0);
    const emptyCount = settled.reduce((s, r) => s + (r.emptyOutput ? 1 : 0), 0);
    const starvedCount = settled.reduce((s, r) => s + ((r.emptyOutput && r.hitCeiling) ? 1 : 0), 0);
    const constrainedCount = settled.reduce((s, r) => s + (r.budgetConstrained ? 1 : 0), 0);

    const used = measured.map((r) => r.usedTokens).sort((a, b) => a - b);
    const ceilingEvidenceFraction = frac(evidenceHits, atFull.length);
    const censored = atFull.length > 0 && ceilingEvidenceFraction >= BINDING_HIT_FRACTION;

    let verdict = "insufficient_data";
    let suggestedCeiling = null;
    if (nMeasured >= MIN_SAMPLES_FOR_VERDICT) {
      if (censored) {
        verdict = "raise";   // the cap is binding often enough that the true usage is unknown
      } else {
        verdict = "narrow";
        // p95 plus 25% headroom, rounded up to a 256-token step, never below 512.
        const target = Math.ceil((nth(used, 0.95) * 1.25) / 256) * 256;
        suggestedCeiling = Math.max(512, target);
      }
    }

    return {
      n,
      nSettled,
      nMeasured,
      hitCeilingFraction: frac(hitCount, nSettled),
      ceilingEvidenceFraction,
      budgetConstrainedFraction: frac(constrainedCount, nSettled),
      emptyOutputFraction: frac(emptyCount, nSettled),
      starvedFraction: frac(starvedCount, nSettled),
      p50UsedTokens: nth(used, 0.50),
      p95UsedTokens: nth(used, 0.95),
      maxUsedTokens: used.length ? used[used.length - 1] : 0,
      censored,
      verdict,
      suggestedCeiling,
    };
  }

  function summary() {
    const out = {};
    for (const [model, records] of mem) {
      if (!records.length) continue;
      const row = statsFor(records);
      const byMode = {};
      const modes = new Set(records.map((r) => r.mode || "normal"));
      for (const m of modes) byMode[m] = statsFor(records.filter((r) => (r.mode || "normal") === m));
      row.byMode = byMode;
      out[model] = row;
    }
    return out;
  }

  load();
  return {
    record,
    summary,
    flush,
    flushSync,
    samples: (model) => (mem.get(safeModel(model)) || []).length,
  };
}
