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

// A single part's size guess in output tokens, from its file count and contract length. Coarse by
// design: ~700 output tokens per file plus the contract's own words, floored so a one-file part is
// never estimated at zero.
export function estimatePartTokens(part) {
  const files = Array.isArray(part && part.files) ? part.files.length : 1;
  const contractWords = String((part && part.contract) || "").split(/\s+/).filter(Boolean).length;
  return Math.max(600, files * 700 + contractWords * 4);
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
    // catalog outCost is dollars per 1e6 output tokens; convert to this part's total across agents.
    const totalTokens = tokens;                       // total work is the same; agents split it
    const usd = measured && m.usdPerKTok.length
      ? (totalTokens / 1000) * usdPerKTok
      : (totalTokens / 1e6) * (rec && rec.outCost || 10);
    return { seconds, tokens: totalTokens, usd: +usd.toFixed(4), basis: measured ? "measured" : "prior", agents: usefulAgents };
  }

  // Whole-plan roll-up: sum the parts under their chosen models and agent counts.
  function estimatePlan(parts, pick) {
    let seconds = 0, tokens = 0, usd = 0, anyPrior = false;
    for (let i = 0; i < parts.length; i++) {
      const p = pick(parts[i], i) || {};
      const e = estimatePart(parts[i], p.rec, p.agents || 1);
      // Parts run sequentially at write time (the pipeline's law), so wall seconds ADD.
      seconds += e.seconds; tokens += e.tokens; usd += e.usd;
      if (e.basis === "prior") anyPrior = true;
    }
    return { seconds, tokens, usd: +usd.toFixed(4), basis: anyPrior ? "prior" : "measured" };
  }

  load();
  return { record, estimatePart, estimatePlan, priorFor: (rec) => priorThroughput(rec), samples: (model) => (mem.get(model) || { n: 0 }).n };
}
