/*
 * Dominion AI — Phase 5 improvement flywheel stores.
 *
 * Zero-dep JSON store for the improvement loop: the failure/hallucination LEDGER (22-category
 * spec enum + typed rootCause/improvementActions), EVAL cases + eval RUNS, prompt RULES, versioned
 * PROMPTS, FINE-TUNING candidates (allowed-source-gated), stored REVIEWS (background critiques the
 * client can fetch after the stream closed), and the PIPELINE log (one line per improvement-pipeline
 * run). Mentor critiques and "save lesson" actions feed these; active prompt rules + prompt versions
 * get injected into prompts; eval runs measure whether changes actually help; autoRetire() prunes
 * rules that A/B-test negative or age out untested. Never touches customer DBs or backups.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const nowIso = () => new Date().toISOString();
const S = (v, n) => String(v == null ? "" : v).slice(0, n);

// ---- spec enums (Failure Categories / FailureLedgerEntry) ----
export const FAILURE_CATEGORIES = [
  "unsupported_factual_claim", "incorrect_factual_claim", "missing_caveat", "bad_reasoning",
  "weak_structure", "poor_writing", "wrong_tone", "tool_misuse", "dangerous_tool_proposal",
  "permission_violation", "bad_routing", "unnecessary_long_context", "missed_retrieval",
  "bad_memory_use", "over_saved_memory", "under_saved_memory", "hallucinated_citation",
  "formatting_error", "code_bug", "security_issue", "test_failure", "user_preference_ignored",
];
export const ROOT_CAUSES = [
  "missing_retrieval", "bad_prompt", "bad_tool_schema", "bad_routing",
  "model_limit", "memory_error", "external_source_error", "unknown",
];
export const IMPROVEMENT_ACTIONS = [
  "add_eval", "update_prompt", "update_tool_schema", "update_router",
  "update_retrieval", "add_memory", "manual_review", "fine_tuning_candidate",
];
// Fine-tuning candidates only from legally clean sources (spec: rare and controlled).
export const FINETUNE_SOURCES = [
  "user_authored_instruction", "user_approved_correction", "synthetic_local",
  "public_domain", "mentor_rubric", "local_ideal_user_approved",
];

// Keyword fallback so out-of-enum categories from old callers / the raw API still land on a real
// spec category instead of a free string (the raw value is preserved in categoryRaw).
const CATEGORY_KEYWORDS = [
  [/unsupported|no (source|citation)|unverif/i, "unsupported_factual_claim"],
  [/incorrect|wrong fact|false|inaccura/i, "incorrect_factual_claim"],
  [/caveat|disclaimer|hedge/i, "missing_caveat"],
  [/(hallucinat|fake|made.?up|invent|fabricat)[\s\S]{0,40}(citation|source|reference|paper|link)|(citation|source|reference)[\s\S]{0,40}(fake|made.?up|invent|fabricat|nonexistent|doesn'?t exist)/i, "hallucinated_citation"],
  [/structure|organi[sz]/i, "weak_structure"],
  [/writing|prose|wordy|verbose/i, "poor_writing"],
  [/tone|voice/i, "wrong_tone"],
  [/dangerous tool|unsafe (tool|action)/i, "dangerous_tool_proposal"],
  [/permission|unauthori[sz]/i, "permission_violation"],
  [/tool/i, "tool_misuse"],
  [/rout/i, "bad_routing"],
  [/long.?context/i, "unnecessary_long_context"],
  [/retriev/i, "missed_retrieval"],
  [/over.?sav/i, "over_saved_memory"],
  [/under.?sav|forgot to (save|remember)/i, "under_saved_memory"],
  [/memory/i, "bad_memory_use"],
  [/format/i, "formatting_error"],
  [/security|inject|secret|credential/i, "security_issue"],
  [/test/i, "test_failure"],
  [/code|bug|crash|exception|syntax/i, "code_bug"],
  [/preference|ignored (fred|the user)|user asked/i, "user_preference_ignored"],
  [/reason|logic|assumption|halluc/i, "bad_reasoning"],
];
export function normalizeCategory(raw) {
  const v = S(raw, 200).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (FAILURE_CATEGORIES.includes(v)) return v;
  for (const [re, cat] of CATEGORY_KEYWORDS) if (re.test(String(raw || ""))) return cat;
  return "bad_reasoning";   // most generic real category — never a free string
}

export function createFlywheel(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\flywheel");
  const file = join(dir, "flywheel.json");
  let db = { failures: [], evals: [], runs: [], rules: [], prompts: [], finetune: [], reviews: [], pipeline: [] };
  const load = () => { try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, "utf8")); if (j && typeof j === "object") db = { failures: j.failures || [], evals: j.evals || [], runs: j.runs || [], rules: j.rules || [], prompts: j.prompts || [], finetune: j.finetune || [], reviews: j.reviews || [], pipeline: j.pipeline || [] }; } } catch {} };
  const persist = () => { try { mkdirSync(dir, { recursive: true }); const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(db, null, 2)); renameSync(tmp, file); } catch {} };
  load();
  const cap = (a, n = 1000) => { if (a.length > n) a.splice(0, a.length - n); };

  // ---- failure / hallucination ledger (spec FailureLedgerEntry: category/rootCause/actions are
  // ENUMS, not free strings; the raw category survives in categoryRaw for honesty) ----
  function addFailure(e = {}) {
    const category = normalizeCategory(e.category || e.categoryHint || S(e.flawedOutput, 200));
    const it = {
      id: randomUUID(), timestamp: nowIso(), category,
      categoryRaw: e.category && normalizeCategory(e.category) !== e.category ? S(e.category, 120) : undefined,
      severity: ["low", "medium", "high", "critical"].includes(e.severity) ? e.severity : "low",
      originalRequest: S(e.originalRequest, 2000), flawedOutput: S(e.flawedOutput, 4000), correctedOutput: e.correctedOutput ? S(e.correctedOutput, 4000) : null,
      detectedBy: ["user", "mentor", "tool", "self_check", "eval"].includes(e.detectedBy) ? e.detectedBy : "user",
      mentorProviderId: e.mentorProviderId ? S(e.mentorProviderId, 60) : undefined,
      rootCause: ROOT_CAUSES.includes(e.rootCause) ? e.rootCause : "unknown",
      improvementActions: (Array.isArray(e.improvementActions) ? e.improvementActions : []).filter((a) => IMPROVEMENT_ACTIONS.includes(a)),
      samplingCategory: e.samplingCategory ? S(e.samplingCategory, 40) : undefined,   // feeds adaptive sampling
      chatId: e.chatId ? S(e.chatId, 80) : undefined,
      linkedEvalIds: Array.isArray(e.linkedEvalIds) ? e.linkedEvalIds.slice(0, 10) : [],
      linkedRuleIds: Array.isArray(e.linkedRuleIds) ? e.linkedRuleIds.slice(0, 10) : [],
      status: "open",
    };
    if (!it.improvementActions.length) it.improvementActions = ["manual_review"];
    db.failures.push(it); cap(db.failures); persist(); return { item: it };
  }
  // Recent failures per sampling category (adaptive sampling reads this to raise rates).
  function failuresSince(ms) {
    const cutoff = Date.now() - ms;
    return db.failures.filter((f) => Date.parse(f.timestamp) >= cutoff);
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

  // ---- fine-tuning candidates (spec improvement object #6) ----
  // Rare and controlled: only the spec's legally-clean sources are storable; everything lands as a
  // candidate and needs explicit approval before any future export/training use.
  function addFinetune(e = {}) {
    if (!S(e.input, 1).trim()) return { error: "input required" };
    if (!FINETUNE_SOURCES.includes(e.source)) return { error: "source must be one of: " + FINETUNE_SOURCES.join(", ") };
    const it = {
      id: randomUUID(), input: S(e.input, 6000), idealOutput: S(e.idealOutput, 8000),
      source: e.source, notes: S(e.notes, 500), tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [],
      linkedFailureId: e.linkedFailureId || null, linkedEvalId: e.linkedEvalId || null,
      status: ["candidate", "approved", "rejected", "exported"].includes(e.status) ? e.status : "candidate",
      createdAt: nowIso(),
    };
    db.finetune.push(it); cap(db.finetune); persist(); return { item: it };
  }

  // ---- stored reviews (background/auto critiques outlive the SSE stream; UI fetches them later) ----
  function addReview(e = {}) {
    const it = {
      id: randomUUID(), createdAt: nowIso(), tier: Number(e.tier) || 0,
      trigger: Array.isArray(e.trigger) ? e.trigger.slice(0, 8) : [], samplingCategory: e.samplingCategory ? S(e.samplingCategory, 40) : undefined,
      taskType: S(e.taskType || "answer_review", 40), chatId: e.chatId ? S(e.chatId, 80) : undefined, artifactId: e.artifactId ? S(e.artifactId, 80) : undefined,
      provider: S(e.provider || "local mentor", 40),   // UI label only — never a model name
      critique: e.critique || null, request: e.request || null, pipeline: e.pipeline || null,
      contentPreview: S(e.contentPreview, 300),
    };
    db.reviews.push(it); cap(db.reviews, 300); persist(); return { item: it };
  }

  // ---- pipeline log (spec flywheel step 9: log whether/what each critique produced) ----
  function addPipelineLog(e = {}) {
    const it = { id: randomUUID(), createdAt: nowIso(), ...e };
    db.pipeline.push(it); cap(db.pipeline, 500); persist(); return { item: it };
  }

  // ---- auto-retire (spec flywheel step 10): rules that A/B-test WORSE get retired; candidates
  // that sat untested/unactivated past the TTL age out. Returns what it retired (for the log). ----
  function autoRetire({ candidateTtlDays = 30 } = {}) {
    const retired = [];
    const cutoff = Date.now() - candidateTtlDays * 864e5;
    for (const r of db.rules) {
      if (r.status === "active" && typeof r.evalDelta === "number" && r.evalDelta < 0) {
        r.status = "retired"; r.retiredAt = nowIso(); r.retiredReason = `A/B delta ${r.evalDelta} — the rule makes evals worse`;
        retired.push({ id: r.id, reason: r.retiredReason });
      } else if (r.status === "candidate" && !r.testedAt && Date.parse(r.createdAt) < cutoff) {
        r.status = "retired"; r.retiredAt = nowIso(); r.retiredReason = `stale candidate — untested for ${candidateTtlDays}+ days`;
        retired.push({ id: r.id, reason: r.retiredReason });
      }
    }
    if (retired.length) persist();
    return retired;
  }

  // ---- generic ops ----
  const COLLS = new Set(["failures", "evals", "runs", "rules", "prompts", "finetune", "reviews", "pipeline"]);
  const update = (coll, id, patch = {}) => { if (!COLLS.has(coll)) return { error: "bad collection" }; const it = db[coll].find((x) => x.id === id); if (!it) return { error: "not found" }; for (const k of Object.keys(patch)) if (k !== "id") it[k] = patch[k]; persist(); return { item: it }; };
  const remove = (coll, id) => { if (!COLLS.has(coll)) return { error: "bad collection" }; const b = db[coll].length; db[coll] = db[coll].filter((x) => x.id !== id); persist(); return { removed: b - db[coll].length }; };
  const list = (coll, filter = {}) => { if (!COLLS.has(coll)) return []; let out = db[coll] || []; if (filter.status) out = out.filter((x) => x.status === filter.status); return [...out].reverse(); };
  const get = (coll, id) => (COLLS.has(coll) ? (db[coll] || []).find((x) => x.id === id) || null : null);
  const runsFor = (evalId) => db.runs.filter((r) => r.evalCaseId === evalId).reverse();
  const stats = () => ({ failures: db.failures.length, evals: db.evals.length, runs: db.runs.length, rules: db.rules.length, prompts: db.prompts.length, finetune: db.finetune.length, reviews: db.reviews.length, openFailures: db.failures.filter((f) => f.status === "open").length, activeRules: db.rules.filter((r) => r.status === "active").length });

  return { addFailure, failuresSince, addEval, addRun, addRule, activeRules, addPrompt, activatePrompt, activePrompts, addFinetune, addReview, addPipelineLog, autoRetire, update, remove, list, get, runsFor, stats };
}
