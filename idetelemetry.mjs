/*
 * Dominion Works - build telemetry + estimates (Phase 2, Fred's "telemetry first" ruling).
 *
 * The AF window shows a live time/token estimate beside each section as the user picks a model and
 * an agent count. Fred chose real measured throughput over a guessed table, so this module RECORDS
 * what real moves actually cost (tokens in/out, wall-clock) per model, and ESTIMATES from that
 * record. Until a model has history, a cold-start prior derived from the catalog's own price/tier
 * fields fills in, always LABELLED as a prior so the number never pretends to be measured.
 *
 * Pure and injected: the store is an append-only JSONL the server points at; nothing here reaches
 * the network or a clock it did not receive. Estimates are honest approximation, never a promise.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const KEEP = 200;   // rolling samples per model held in memory for the running average

// Cold-start prior: tokens/sec by rough tier, keyed off the catalog record's output price as a
// stand-in for size/speed (cheaper models run faster). Deliberately coarse; it only holds until
// three real samples exist for a model, after which measured data wins entirely.
export function priorThroughput(rec) {
  const outCost = rec && typeof rec.outCost === "number" ? rec.outCost : 10;
  if (outCost >= 25) return 22;   // frontier, slow and dear
  if (outCost >= 8) return 40;    // mid
  if (outCost >= 2) return 70;    // light
  return 110;                     // tiny/local
}

/*
 * A single part's size in OUTPUT tokens.
 *
 * This said 700 tokens per file, which is about twenty lines. A move writes whole files, and a real
 * source file lands nearer 2,500 tokens. That single number is most of why a twelve-step plan was
 * quoted at "~22k tokens · ~$0.30" and then cost $9.07 (Fred, 2026-07-31): twelve parts of roughly
 * two files each multiply out to exactly the 22k he was shown.
 */
export const OUT_TOKENS_PER_FILE = 2500;
/*
 * What the quote never counted at all.
 *
 * INPUT: every attempt re-sends the manifest of the files it may touch, so a move pays for reading
 * about as much as it writes, and the catalog charges for input separately.
 *
 * RETRIES AND REVIEW: the engine is not a single call per part. A move gets up to three attempts,
 * each with up to three inspection windows, and a failed check earns repair rounds on top, with
 * reviewer and QC stages after that. An estimate that models one clean call per part is quoting the
 * luckiest possible build, which is not the number anyone needs before pressing the button.
 *
 * So the estimate carries a range: `usd` is a realistic pass, `usdHigh` is the same plan when it
 * argues with itself. The high number is the one worth reading, and it is what the spend limit
 * should be set against.
 */
export const INPUT_TO_OUTPUT_RATIO = 1.0;
export const RETRY_OVERHEAD = 2.2;

export function estimatePartTokens(part) {
  const files = Array.isArray(part && part.files) ? part.files.length : 1;
  const contractWords = String((part && part.contract) || "").split(/\s+/).filter(Boolean).length;
  return Math.max(900, files * OUT_TOKENS_PER_FILE + contractWords * 4);
}

export function createTelemetry({ dir, now = Date.now } = {}) {
  const file = dir ? join(dir, "build-telemetry.jsonl") : null;
  const mem = new Map();   // modelId -> { n, tokPerSec: [..], usdPerKTok: [..] }

  function load() {
    if (!file || !existsSync(file)) return;
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e && e.model) fold(e);
      }
    } catch {}
  }
  function fold(e) {
    if (!e.model || !(e.tokPerSec > 0)) return;
    const m = mem.get(e.model) || { n: 0, tokPerSec: [], usdPerKTok: [] };
    m.n++;
    m.tokPerSec.push(e.tokPerSec);
    if (e.usdPerKTok >= 0) m.usdPerKTok.push(e.usdPerKTok);
    if (m.tokPerSec.length > KEEP) m.tokPerSec.shift();
    if (m.usdPerKTok.length > KEEP) m.usdPerKTok.shift();
    mem.set(e.model, m);
  }
  const avg = (a) => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

  /*
   * Record one completed move/unit. outTokens + ms give throughput; costUsd + outTokens give the
   * $/1k-token rate we bill at. A move that produced nothing measurable is skipped, not logged as
   * zero (a zero would poison the average).
   */
  function record({ model, outTokens = 0, ms = 0, costUsd = 0 }) {
    if (!model || !(outTokens > 0) || !(ms > 0)) return;
    const tokPerSec = outTokens / (ms / 1000);
    const usdPerKTok = outTokens > 0 ? (costUsd / outTokens) * 1000 : -1;
    const e = { at: now(), model, tokPerSec: +tokPerSec.toFixed(2), usdPerKTok: +usdPerKTok.toFixed(6) };
    fold(e);
    if (file) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(e) + "\n"); } catch {} }
  }

  /*
   * Estimate one part on one model with N agents. Returns { seconds, tokens, usd, basis }.
   * basis is "measured" once >=3 real samples exist for the model, else "prior". Agents run in
   * PARALLEL, so wall-time divides by agent count (capped: past the point where each agent has
   * less than a whole file, more agents stop helping); tokens and cost are the SUM across agents
   * plus the divider/referee overhead the pipeline always pays, so more agents cost more money for
   * less wall-time, which is exactly the trade the counter should show a tinkerer.
   */
  function estimatePart(part, rec, agents = 1) {
    const tokens = estimatePartTokens(part);
    const m = rec ? mem.get(rec.id) : null;
    const measured = m && m.n >= 3;
    const tokPerSec = measured ? avg(m.tokPerSec) : priorThroughput(rec);
    const usdPerKTok = measured && m.usdPerKTok.length
      ? avg(m.usdPerKTok)
      : (rec && typeof rec.outCost === "number" ? rec.outCost : 10);   // catalog outCost is $/1M ~ /1k*1000; see below
    const files = Array.isArray(part && part.files) ? part.files.length : 1;
    const usefulAgents = Math.max(1, Math.min(Number(agents) || 1, files));
    const wallTokens = tokens / usefulAgents;         // each agent handles a share, in parallel
    const seconds = Math.ceil(wallTokens / Math.max(1, tokPerSec)) + 6 * usefulAgents;   // +ramp per agent
    /*
     * Cost counts BOTH sides. The old line multiplied total tokens by outCost alone, so a move's
     * reading was free and its writing was under-counted, on top of the per-file figure being a
     * quarter of reality. Measured throughput (usdPerKTok, folded from real settled calls) already
     * reflects whatever a turn truly costs, so it is used as-is and only the retry allowance is
     * applied on top of it.
     */
    const inTokens = Math.round(tokens * INPUT_TO_OUTPUT_RATIO);
    const totalTokens = tokens + inTokens;
    const onePass = measured && m.usdPerKTok.length
      ? (tokens / 1000) * usdPerKTok
      : (tokens / 1e6) * (rec && typeof rec.outCost === "number" ? rec.outCost : 10)
        + (inTokens / 1e6) * (rec && typeof rec.inCost === "number" ? rec.inCost : 1);
    const usdHigh = onePass * RETRY_OVERHEAD;
    return {
      seconds, tokens: totalTokens, outTokens: tokens, inTokens,
      usd: +onePass.toFixed(4),
      usdHigh: +usdHigh.toFixed(4),
      secondsHigh: Math.ceil(seconds * RETRY_OVERHEAD),
      basis: measured ? "measured" : "prior", agents: usefulAgents,
    };
  }

  // Whole-plan roll-up: sum the parts under their chosen models and agent counts.
  /*
   * Wall time the way the scheduler actually runs (Fred, 2026-08-03: "Whole plan: 18 min to
   * 40 min" was a sequential sum shown over a parallel build). Model calls run CONCURRENTLY for
   * every task whose dependencies are met and whose files are disjoint; only the file writes
   * serialize, and writes are seconds against a model call's minutes. So the honest wall figure
   * simulates the dependency waves: each wave costs as long as its slowest member, and the plan
   * costs the sum of its waves. Money still ADDS across every part - parallelism buys time, not
   * dollars. Parts with no dependency info (older clients) fall back to the sequential sum, which
   * is then labelled for what it is.
   */
  function planWallSeconds(parts, secondsOf) {
    const nodes = (parts || []).map((p, i) => ({
      i,
      n: Number.isFinite(Number(p && p.n)) ? Number(p.n) : i + 1,
      needs: Array.isArray(p && p.needs) ? p.needs.map(Number).filter(Number.isFinite) : [],
      files: new Set((Array.isArray(p && p.files) ? p.files : []).map((f) => String(f).trim().replace(/\\/g, "/").toLowerCase())),
    }));
    if (!nodes.length) return 0;
    const present = new Set(nodes.map((x) => x.n));
    for (const x of nodes) x.needs = x.needs.filter((n) => present.has(n) && n !== x.n);
    const doneN = new Set();
    const left = new Set(nodes.map((x) => x.i));
    let wall = 0, guard = 0;
    while (left.size && guard++ <= nodes.length + 1) {
      const ready = [...left].map((i) => nodes[i]).filter((x) => x.needs.every((n) => doneN.has(n)));
      if (!ready.length) return null;   // a dependency loop; the caller falls back to the sum
      const wave = [];
      for (const x of ready) {
        if (!wave.some((w) => [...w.files].some((f) => x.files.has(f)))) wave.push(x);
      }
      wall += Math.max(...wave.map((x) => secondsOf(x.i)));
      for (const x of wave) { left.delete(x.i); doneN.add(x.n); }
    }
    return left.size ? null : wall;
  }

  function estimatePlan(parts, pick) {
    let seconds = 0, secondsHigh = 0, tokens = 0, usd = 0, usdHigh = 0, anyPrior = false;
    const perSeconds = [], perSecondsHigh = [];
    for (let i = 0; i < parts.length; i++) {
      const p = pick(parts[i], i) || {};
      const e = estimatePart(parts[i], p.rec, p.agents || 1);
      perSeconds.push(e.seconds); perSecondsHigh.push(e.secondsHigh || e.seconds);
      seconds += e.seconds; secondsHigh += e.secondsHigh || e.seconds;
      tokens += e.tokens; usd += e.usd; usdHigh += e.usdHigh || e.usd;
      if (e.basis === "prior") anyPrior = true;
    }
    const wall = planWallSeconds(parts, (i) => perSeconds[i]);
    const wallHigh = wall == null ? null : planWallSeconds(parts, (i) => perSecondsHigh[i]);
    return {
      seconds, secondsHigh, tokens,
      // The parallel-aware figures. Null dependency info degrades to the sequential sum so the
      // range can never claim a speedup nobody scheduled.
      secondsParallel: wall == null ? seconds : wall,
      secondsParallelHigh: wallHigh == null ? secondsHigh : wallHigh,
      parallelBasis: wall == null ? "sequential" : "waves",
      usd: +usd.toFixed(4), usdHigh: +usdHigh.toFixed(4),
      basis: anyPrior ? "prior" : "measured",
    };
  }

  load();
  return { record, estimatePart, estimatePlan, priorFor: (rec) => priorThroughput(rec), samples: (model) => (mem.get(model) || { n: 0 }).n };
}
