/*
 * Dominion AI — Phase 5 improvement flywheel stores.
 *
 * Five collections in one zero-dep JSON store: the failure/hallucination LEDGER, EVAL cases +
 * eval RUNS, prompt RULES, and versioned PROMPTS. Mentor critiques and "save lesson" actions feed
 * these; active prompt rules + prompt versions get injected into prompts; eval runs measure whether
 * changes actually help. Never touches customer DBs or backups.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const nowIso = () => new Date().toISOString();
const S = (v, n) => String(v == null ? "" : v).slice(0, n);

export function createFlywheel(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\flywheel");
  const file = join(dir, "flywheel.json");
  let db = { failures: [], evals: [], runs: [], rules: [], prompts: [] };
  const load = () => { try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, "utf8")); if (j && typeof j === "object") db = { failures: j.failures || [], evals: j.evals || [], runs: j.runs || [], rules: j.rules || [], prompts: j.prompts || [] }; } } catch {} };
  const persist = () => { try { mkdirSync(dir, { recursive: true }); const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(db, null, 2)); renameSync(tmp, file); } catch {} };
  load();
  const cap = (a, n = 1000) => { if (a.length > n) a.splice(0, a.length - n); };

  // ---- failure / hallucination ledger ----
  function addFailure(e = {}) {
    const it = {
      id: randomUUID(), timestamp: nowIso(), category: e.category || "unknown",
      severity: ["low", "medium", "high", "critical"].includes(e.severity) ? e.severity : "low",
      originalRequest: S(e.originalRequest, 2000), flawedOutput: S(e.flawedOutput, 4000), correctedOutput: e.correctedOutput ? S(e.correctedOutput, 4000) : null,
      detectedBy: e.detectedBy || "user", rootCause: e.rootCause || "unknown",
      improvementActions: Array.isArray(e.improvementActions) ? e.improvementActions : [], status: "open",
    };
    db.failures.push(it); cap(db.failures); persist(); return { item: it };
  }

  // ---- eval cases + runs ----
  function addEval(e = {}) {
    if (!S(e.input, 1).trim()) return { error: "input required" };
    const it = {
      id: randomUUID(), title: S(e.title || "Eval", 160), category: e.category || "reasoning", input: S(e.input, 4000),
      expectedBehavior: S(e.expectedBehavior, 2000), forbiddenBehavior: e.forbiddenBehavior ? S(e.forbiddenBehavior, 1000) : null,
      scoringRubric: S(e.scoringRubric || "Score 0-10 on whether the output meets the expected behavior.", 1000),
      source: e.source || "manual", createdAt: nowIso(), lastRunAt: null, latestScore: null,
    };
    db.evals.push(it); cap(db.evals); persist(); return { item: it };
  }
  function addRun(r = {}) {
    const it = { id: randomUUID(), evalCaseId: r.evalCaseId, modelProviderId: r.modelProviderId || "", mode: r.mode || "", input: S(r.input, 2000), output: S(r.output, 4000), score: Number(r.score) || 0, passed: !!r.passed, mentorReviewed: !!r.mentorReviewed, notes: S(r.notes, 2000), createdAt: nowIso() };
    db.runs.push(it); cap(db.runs, 2000);
    const ev = db.evals.find((x) => x.id === r.evalCaseId); if (ev) { ev.lastRunAt = it.createdAt; ev.latestScore = it.score; }
    persist(); return { item: it };
  }

  // ---- prompt rules ----
  function addRule(e = {}) {
    if (!S(e.content, 1).trim()) return { error: "content required" };
    const it = { id: randomUUID(), scope: ["global", "mode", "tool", "mentor", "router", "workspace", "retrieval"].includes(e.scope) ? e.scope : "global", content: S(e.content, 1000), sourceEvalId: e.sourceEvalId || null, status: ["candidate", "active", "retired"].includes(e.status) ? e.status : "candidate", createdAt: nowIso() };
    db.rules.push(it); cap(db.rules); persist(); return { item: it };
  }
  const activeRules = (scope) => db.rules.filter((r) => r.status === "active" && (r.scope === "global" || r.scope === scope));

  // ---- versioned prompts (spec: PromptVersion — no unversioned junk drawer) ----
  // Same name = one prompt lineage; each save is a NEW version; at most one version of a lineage is
  // active. Active global/mode prompts are appended to the system prompt by the server.
  function addPrompt(e = {}) {
    if (!S(e.content, 1).trim()) return { error: "content required" };
    const name = S(e.name || "unnamed", 80);
    const version = db.prompts.filter((p) => p.name === name).reduce((m, p) => Math.max(m, p.version), 0) + 1;
    const it = {
      id: randomUUID(), name, scope: ["global", "mode", "tool", "mentor", "router"].includes(e.scope) ? e.scope : "global",
      content: S(e.content, 4000), version, createdAt: nowIso(),
      changeReason: S(e.changeReason, 300), sourceEvalIds: Array.isArray(e.sourceEvalIds) ? e.sourceEvalIds.slice(0, 10) : [],
      active: false,
    };
    db.prompts.push(it); cap(db.prompts, 500); persist(); return { item: it };
  }
  function activatePrompt(id) {
    const it = db.prompts.find((p) => p.id === id); if (!it) return { error: "not found" };
    for (const p of db.prompts) if (p.name === it.name) p.active = false;   // one active version per lineage
    it.active = true; persist(); return { item: it };
  }
  const activePrompts = (scope) => db.prompts.filter((p) => p.active && p.scope === scope);

  // ---- generic ops ----
  const COLLS = new Set(["failures", "evals", "runs", "rules", "prompts"]);
  const update = (coll, id, patch = {}) => { if (!COLLS.has(coll)) return { error: "bad collection" }; const it = db[coll].find((x) => x.id === id); if (!it) return { error: "not found" }; for (const k of Object.keys(patch)) if (k !== "id") it[k] = patch[k]; persist(); return { item: it }; };
  const remove = (coll, id) => { if (!COLLS.has(coll)) return { error: "bad collection" }; const b = db[coll].length; db[coll] = db[coll].filter((x) => x.id !== id); persist(); return { removed: b - db[coll].length }; };
  const list = (coll, filter = {}) => { if (!COLLS.has(coll)) return []; let out = db[coll] || []; if (filter.status) out = out.filter((x) => x.status === filter.status); return [...out].reverse(); };
  const get = (coll, id) => (COLLS.has(coll) ? (db[coll] || []).find((x) => x.id === id) || null : null);
  const runsFor = (evalId) => db.runs.filter((r) => r.evalCaseId === evalId).reverse();
  const stats = () => ({ failures: db.failures.length, evals: db.evals.length, runs: db.runs.length, rules: db.rules.length, prompts: db.prompts.length, openFailures: db.failures.filter((f) => f.status === "open").length, activeRules: db.rules.filter((r) => r.status === "active").length });

  return { addFailure, addEval, addRun, addRule, activeRules, addPrompt, activatePrompt, activePrompts, update, remove, list, get, runsFor, stats };
}
