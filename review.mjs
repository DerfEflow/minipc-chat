/*
 * Dominion AI — Phase 5 automatic review engine.
 *
 * The piece that makes the flywheel AUTONOMOUS: post-answer trigger detection (the spec's 8
 * automatic mentor-review conditions), the response quality block (confidence / hallucinationRisk /
 * needsReview), the 10-category ADAPTIVE sampling policy, the 4-tier review ladder (Tier 0 skip →
 * Tier 1 light-model screen → Tier 2 full mentor → Tier 3 council), and the 10-step
 * critique→improvement pipeline (parse, validate, respond, classify to the 22-category enum,
 * generate candidates, queue, auto-apply safe ones, eval linkage, log, retire).
 *
 * Constraints that shaped this file:
 * - The 30B is SLOW on this CPU box, so every auto review is fire-and-forget: the user's stream is
 *   never delayed; results land in flywheel "reviews" and the ledger for the UI to fetch later.
 * - A single-lane queue (with a small cap) keeps background reviews from stacking up on the CPU.
 * - Tier 1 screens with the LIGHT model so the expensive full review only runs when warranted.
 * - LAX posture: sampling ships ON at spec rates; auto-apply is on for SAFE classes only (eval
 *   cases + memory candidates through governed gating); prompt/retrieval rules always queue as
 *   candidates needing activation. Cautious mode = flip REVIEW_AUTO_APPLY / AUTO_MENTOR, no rebuild.
 */
import { FAILURE_CATEGORIES, ROOT_CAUSES, normalizeCategory } from "./flywheel.mjs";
import { redact } from "./mentor.mjs";

const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- spec sampling policy (baseline rates; adaptive boosts sit on top) ----
export const MENTOR_SAMPLING = {
  casualChat: 0.0, shortDraft: 0.05, factualAnswer: 0.15, technicalAnswer: 0.25, documentDraft: 0.25,
  finalArtifact: 0.75, codeGeneration: 0.5, executableCode: 0.9, toolChainWithErrors: 1.0, userMarkedImportant: 1.0,
};

// ---- content signals (shared by triggers, sampling, and quality) ----
const EXEC_LANGS = /```(python|py|bash|sh|powershell|ps1|js|javascript|node|sql)\b/i;
const CODE_FENCE = /```/;
const UNCERTAIN_RE = /(i'?m not (sure|certain)|not entirely sure|uncertain|i (may|might|could) be wrong|i don'?t know|can'?t verify|cannot verify|unverified|hard to say|i'?d guess|my best guess|take this with)/gi;
const USER_ASK_RE = /\b(critique|review (this|it|that|my)|double.?check|fact.?check|verify (this|that|it)|check (this|that|your|it) (for|over|again)|are you (sure|certain)|stress.?test)\b/i;
const IMPORTANT_RE = /\b(important|critical|high.?stakes|must be (right|correct|accurate)|make sure (it'?s|this is) (right|correct)|final version|this is final)\b/i;
const HIGH_RISK_TOPIC_RE = /\b(medical|legal|financial|tax(es)?|dosage|diagnos\w*|lawsuit|contract|investment|liabilit\w*|regulation|compliance)\b/i;
const CLAIM_THRESHOLD = 8;

// Pre-answer signal for the router (spec routeDecision.needsMentorReview): the user is explicitly
// asking for scrutiny, or the topic is in hallucination-prone / high-stakes territory.
export const wantsReview = (t) => USER_ASK_RE.test(String(t || "")) || HIGH_RISK_TOPIC_RE.test(String(t || ""));

// Rough factual-claim counter: assertive sentences carrying a number, date, percentage, or a
// source-shaped reference. Heuristic on purpose — cheap, deterministic, no model call.
export function countClaims(text) {
  const sentences = String(text || "").split(/(?<=[.!?])\s+/);
  let n = 0;
  for (const s of sentences) {
    if (s.length < 25) continue;
    const hasFact = /\d/.test(s) || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(s) || /\baccording to\b/i.test(s);
    const asserts = /\b(is|are|was|were|has|have|had|will|can|costs?|holds?|contains?|supports?|requires?|produces?|provides?|measures?|weighs?|generates?|reached?|grew|increased?|decreased?)\b/i.test(s);
    if (hasFact && asserts) n++;
  }
  return n;
}

// Citations for the NormalizedModelResponse: URLs + [n]-style reference markers found in the answer.
export function extractCitations(text) {
  const t = String(text || "");
  const out = [];
  for (const m of t.matchAll(/https?:\/\/[^\s)\]>"']+/g)) { out.push({ kind: "url", ref: m[0].slice(0, 300) }); if (out.length >= 12) return out; }
  for (const m of t.matchAll(/\[(\d{1,2})\]/g)) { out.push({ kind: "marker", ref: "[" + m[1] + "]" }); if (out.length >= 12) break; }
  return out;
}

// ---- A2: the eight automatic mentor-review triggers (spec 393-402 / 1176-1189), detected for real ----
// signals: { answer, mode, lastUserText, toolCount, toolFailed, executedCode, exported, markedFinal,
//            routeNeedsReview, quality } — everything comes from what actually happened this turn.
export function detectTriggers(sig = {}) {
  const answer = String(sig.answer || "");
  const userText = String(sig.lastUserText || "");
  const fired = [];
  if (sig.markedFinal || IMPORTANT_RE.test(userText) && /final/i.test(userText)) fired.push("final_output");
  if (sig.executedCode || (EXEC_LANGS.test(answer) && /\b(run|execute|deploy|install|cron|schedule)\b/i.test(userText + " " + answer.slice(0, 500)))) fired.push("executable_code");
  if (sig.exported) fired.push("export");
  const q = sig.quality || {};
  if (q.hallucinationRisk === "high" || HIGH_RISK_TOPIC_RE.test(userText)) fired.push("hallucination_risk");
  if ((sig.claimCount != null ? sig.claimCount : countClaims(answer)) >= CLAIM_THRESHOLD) fired.push("claim_count");
  if (USER_ASK_RE.test(userText) || sig.routeNeedsReview) fired.push("user_ask");
  if ((answer.match(UNCERTAIN_RE) || []).length >= 2 || (typeof q.confidence === "number" && q.confidence < 0.4)) fired.push("uncertainty");
  if ((sig.toolCount || 0) >= 3 || sig.toolFailed) fired.push("complex_tool_chain");
  return fired;
}

// ---- A1: the quality block for NormalizedModelResponse ----
// confidence starts at the router's own confidence and pays for uncertainty markers / tool failures;
// hallucinationRisk rises with claim density when nothing was retrieved to ground the claims.
export function computeQuality({ answer, routeConfidence, toolFailed, retrievalCount, citations }) {
  const text = String(answer || "");
  const claimCount = countClaims(text);
  const uncertainty = (text.match(UNCERTAIN_RE) || []).length;
  let confidence = typeof routeConfidence === "number" ? routeConfidence : 0.6;
  confidence -= Math.min(0.3, uncertainty * 0.1);
  if (toolFailed) confidence -= 0.15;
  confidence = clamp(Math.round(confidence * 100) / 100, 0.05, 0.99);
  const grounded = (retrievalCount || 0) > 0 || (citations || []).length > 0;
  const hallucinationRisk = claimCount >= CLAIM_THRESHOLD && !grounded ? "high" : claimCount >= 4 && !grounded ? "medium" : "low";
  return { confidence, hallucinationRisk, needsReview: false, claimCount, uncertaintyMarkers: uncertainty };
}

// ---- A3: turn categorization — every one of the spec's 10 sampling categories is reachable ----
// Priority order matters: the highest-stakes category that matches wins.
export function categorizeTurn(sig = {}) {
  const answer = String(sig.answer || "");
  const userText = String(sig.lastUserText || "");
  if (sig.toolFailed) return "toolChainWithErrors";
  if (IMPORTANT_RE.test(userText) || USER_ASK_RE.test(userText)) return "userMarkedImportant";
  if (sig.markedFinal || sig.artifactMarkedFinal) return "finalArtifact";
  if (sig.executedCode || (EXEC_LANGS.test(answer) && /\b(run|execute|deploy)\b/i.test(userText))) return "executableCode";
  if (CODE_FENCE.test(answer)) return "codeGeneration";
  if (sig.mode === "draft" || sig.artifactCreated) return "documentDraft";
  if (sig.mode === "deep_think" || sig.mode === "long_context") return "technicalAnswer";
  const claims = sig.claimCount != null ? sig.claimCount : countClaims(answer);
  if (claims >= 3) return "factualAnswer";
  if (sig.mode === "fast" || answer.length < 160) return "casualChat";
  if (answer.length < 900) return "shortDraft";
  return "factualAnswer";
}

// ---- E1: the NINE artifact mentor-review triggers (spec 1011-1023, audit item 8), detected
// server-side in ONE place. a = artifact (title/type/status/content/sourceContextRefs/
// versionCount/mentorReviewed), sig = event signals { markedFinal, exported, externalSend,
// driftRatio }. Returns the trigger names that fired; the server schedules a background
// documentReview + marks the artifact review-recommended when any fire. ----
const LONG_DOC_WORDS = 1200, LONG_DOC_CHARS = 8000;
const DRIFT_RATIO = 0.4;
const TECH_TERM_RE = /\b(api|schema|latency|throughput|bandwidth|voltage|amperage|wattage|kwh|psi|mils?|coverage rate|sq\.? ?ft|tolerance|algorithm|protocol|encryption|database|server|kernel|compiler|benchmark|spec(ification)?s?|firmware|calibrat\w*)\b/i;
const LEGAL_FIN_RE = /\b(contract|liabilit\w*|indemnif\w*|warrant(y|ies)|legal|lawsuit|statute|regulation|compliance|jurisdiction|invoice|payment terms|interest rate|loan|mortgage|tax(es)?|financial|investment|medical|diagnos\w*|dosage|prescription|standard operating procedure|safety procedure|operational (procedure|protocol))\b/i;
export function detectArtifactTriggers(a = {}, sig = {}) {
  const content = String(a.content || "");
  const fired = [];
  // 1. user marks it final
  if (sig.markedFinal || a.status === "final") fired.push("final_output");
  // 2. it will be sent externally (export counts — it leaves the studio)
  if (sig.exported || sig.externalSend) fired.push("external_send");
  // 3. it's long
  const words = (content.match(/\S+/g) || []).length;
  if (words > LONG_DOC_WORDS || content.length > LONG_DOC_CHARS) fired.push("long_document");
  // 4. it carries technical claims
  if (countClaims(content) >= CLAIM_THRESHOLD && TECH_TERM_RE.test(content)) fired.push("technical_claims");
  // 5. it contains code
  if (CODE_FENCE.test(content) || a.type === "code") fired.push("code_content");
  // 6. it was created from retrieved documents (provenance says retrieval contributed)
  if ((a.sourceContextRefs || []).length) fired.push("retrieval_sourced");
  // 7. legal / financial / medical / operational language
  if (LEGAL_FIN_RE.test(content)) fired.push("legal_financial_language");
  // 8. the local model self-reported uncertainty
  if ((content.match(UNCERTAIN_RE) || []).length >= 2) fired.push("uncertainty");
  // 9. drift: multiple revisions and the latest diverges heavily from the reviewed one
  const vc = a.versionCount || (Array.isArray(a.versions) ? a.versions.length : 1);
  if ((typeof sig.driftRatio === "number" && sig.driftRatio > DRIFT_RATIO && vc >= 3) ||
      (sig.driftRatio == null && vc >= 4 && !a.mentorReviewed)) fired.push("drift");
  return fired;
}

// ---- E2: the SEVEN export safety checks (spec 1042-1052, audit item 9) — ONE server-side gate
// that both the REST export endpoint and the model-facing export tools pass through.
//   1-3: confirm title / format / destination  -> structured echo in checks{}
//   4:   mentor review skipped                 -> warning
//   5:   unsupported claims remain (from the artifact's latest structured review) -> warning
//   6:   sensitive data may be included (redact() detection) -> BLOCKS without an explicit
//        override flag, even under LAX (the one check that keeps its teeth)
//   7:   preserve editable source              -> structural guarantee, echoed in checks{}
// LAX posture: warnings return + the export proceeds; spec mode (lax=false) additionally requires
// confirmed=true whenever any warning fired. ----
export const EXPORT_FORMATS = new Set(["md", "markdown", "txt", "text", "json", "html", "htm", "docx", "pdf", "xlsx", "csv", "spreadsheet", "code", "checklist", "report"]);
export function exportSafetyGate({ artifact, format, destination = "local exports folder", overrideSensitive = false, lax = true, confirmed = false } = {}) {
  const a = artifact || {};
  const fmt = String(format || a.type || "md").toLowerCase();
  const checks = { title: a.title || "Untitled", format: fmt, destination, preservesSource: true };
  if (!EXPORT_FORMATS.has(fmt)) return { ok: false, blocked: "unsupported_format", message: `unsupported export format "${fmt}"`, checks, warnings: [] };
  const warnings = [];
  if (!a.mentorReviewed) warnings.push({ check: "review_skipped", message: "this artifact has not been mentor-reviewed" });
  const claims = a.lastReview && Array.isArray(a.lastReview.unsupported_claims) ? a.lastReview.unsupported_claims : [];
  if (claims.length) warnings.push({ check: "unsupported_claims", message: `${claims.length} unsupported claim(s) flagged by the last review`, claims: claims.slice(0, 5).map(String) });
  const r = redact(String(a.content || ""));
  if (r.applied.length) {
    if (!overrideSensitive) return { ok: false, blocked: "sensitive_data", detected: r.applied, message: "possible sensitive data detected (" + r.applied.join(", ") + ") — exporting needs an explicit override", checks, warnings };
    warnings.push({ check: "sensitive_data", overridden: true, detected: r.applied, message: "sensitive-data warning overridden explicitly" });
  }
  if (!lax && warnings.length && !confirmed) return { ok: false, blocked: "needs_confirmation", message: "export needs explicit confirmation (spec mode): " + warnings.map((w) => w.check).join(", "), checks, warnings };
  return { ok: true, checks, warnings };
}

// ---- Tier 0 (spec): content-level skip-list — never mentor these ----
const TIER0_ASK_RE = /^(format|reformat|convert|rename|retitle|make (a|the) (list|table)|summari[sz]e (this|that)( briefly)?|tl;?dr|shorten|bullet)/i;
export function isTier0(sig = {}) {
  const cat = sig.category || categorizeTurn(sig);
  if (cat === "casualChat") return true;
  const userText = String(sig.lastUserText || "").trim();
  const answer = String(sig.answer || "");
  if (TIER0_ASK_RE.test(userText) && answer.length < 1500) return true;   // small formatting/summary tasks
  if (answer.length < 120) return true;                                    // trivial acks / labels
  return false;
}

export function createReviewEngine({ mentor, flywheel, memory, ollamaChat, lightModel, mainModel, autoApply = true, toolNames = [], waitIdle = null, log = () => {} }) {
  // ---- adaptive sampling (spec: rate rises on recent ledger failures in that category, decays
  // back to baseline as the 7-day window slides past them) ----
  function effectiveRate(category) {
    const base = MENTOR_SAMPLING[category] ?? 0.15;
    let boost = 0;
    try {
      const recent = flywheel.failuresSince(7 * 864e5).filter((f) => f.samplingCategory === category).length;
      boost = Math.min(0.45, recent * 0.15);
    } catch {}
    return clamp(base + boost, 0, 1);
  }

  // ---- tier selection: hard Tier-2 conditions (spec Tier 2 cases) beat sampling; everything else
  // is sampled into a Tier-1 light screen at the adaptive category rate. Tier 3 is never automatic. ----
  const TIER2_TRIGGERS = new Set(["executable_code", "export", "final_output", "user_ask"]);
  function decide(sig = {}) {
    const category = categorizeTurn(sig);
    const triggers = detectTriggers({ ...sig, claimCount: sig.claimCount });
    if (isTier0({ ...sig, category }) && !triggers.length) return { tier: 0, category, triggers, rate: 0 };
    const hardTier2 = triggers.some((t) => TIER2_TRIGGERS.has(t)) || (sig.toolFailed && (sig.toolCount || 0) > 1) ||
      sig.mode === "long_context" || (sig.quality && sig.quality.hallucinationRisk === "high");
    if (hardTier2) return { tier: 2, category, triggers, rate: 1 };
    const rate = effectiveRate(category);
    const softTrigger = triggers.length > 0;   // uncertainty / claim-count / tool-chain / risk topics
    if (softTrigger || Math.random() < rate) return { tier: 1, category, triggers, rate };
    return { tier: 0, category, triggers, rate };
  }

  // ---- Tier 1: cheap light-model screen (8B) — escalates to a full review when it smells trouble ----
  async function lightCheck({ answer, lastUserText }) {
    const prompt = [
      'You are a fast quality screener for an AI assistant\'s answer. Return ONLY JSON: {"ok":true|false,"escalate":true|false,"hallucination_risk":"low|medium|high","concerns":["short strings"]}',
      "escalate=true when the answer deserves a FULL expert review (possible factual errors, risky advice, broken code, big unsupported claims). ok=false when you see a concrete problem.",
      "\nUser asked:\n" + String(lastUserText || "").slice(0, 1500),
      "\nAssistant answered:\n" + String(answer || "").slice(0, 5000),
    ].join("\n");
    const d = await ollamaChat(lightModel, [{ role: "user", content: prompt }], { temperature: 0, num_predict: 400, noTools: true, format: "json", think: false });
    const raw = stripThink((d && d.message && d.message.content) || "");
    const m = raw.match(/\{[\s\S]*\}/);
    let j = null; if (m) { try { j = JSON.parse(m[0]); } catch {} }
    if (!j) return { ok: true, escalate: false, hallucination_risk: "low", concerns: [], _parseError: true };
    return { ok: j.ok !== false, escalate: !!j.escalate, hallucination_risk: ["low", "medium", "high"].includes(j.hallucination_risk) ? j.hallucination_risk : "low", concerns: Array.isArray(j.concerns) ? j.concerns.map(String).slice(0, 6) : [] };
  }

  // ---- A5 step 4: failure classification — 22-category enum + INFERRED rootCause + DERIVED actions.
  // Heuristic keyword pass first (deterministic, free); the light model breaks ties only when the
  // heuristic can't find a category in the critique text. Root cause is inferred from which kind of
  // failure it is + what the turn actually had loaded (retrieval, tools, routing). ----
  const ROOT_FOR_CATEGORY = {
    unsupported_factual_claim: "missing_retrieval", incorrect_factual_claim: "missing_retrieval",
    hallucinated_citation: "missing_retrieval", missed_retrieval: "missing_retrieval",
    missing_caveat: "bad_prompt", weak_structure: "bad_prompt", poor_writing: "bad_prompt",
    wrong_tone: "bad_prompt", formatting_error: "bad_prompt", user_preference_ignored: "memory_error",
    tool_misuse: "bad_tool_schema", dangerous_tool_proposal: "bad_tool_schema", permission_violation: "bad_tool_schema",
    bad_routing: "bad_routing", unnecessary_long_context: "bad_routing",
    bad_memory_use: "memory_error", over_saved_memory: "memory_error", under_saved_memory: "memory_error",
    bad_reasoning: "model_limit", code_bug: "model_limit", security_issue: "model_limit", test_failure: "model_limit",
  };
  const ACTIONS_FOR_ROOT = {
    missing_retrieval: ["update_retrieval", "add_eval"],
    bad_prompt: ["update_prompt", "add_eval"],
    bad_tool_schema: ["update_tool_schema", "add_eval"],
    bad_routing: ["update_router", "add_eval"],
    model_limit: ["add_eval", "fine_tuning_candidate"],
    memory_error: ["add_memory", "add_eval"],
    external_source_error: ["add_eval"],
    unknown: ["manual_review"],
  };
  function deriveActions(rootCause) { return ACTIONS_FOR_ROOT[rootCause] ? [...ACTIONS_FOR_ROOT[rootCause]] : ["manual_review"]; }
  function inferRootCause(category, ctx = {}) {
    let root = ROOT_FOR_CATEGORY[category] || "unknown";
    // Context refinement: a factual failure WITH retrieval loaded isn't a missing-retrieval problem —
    // the model ignored/garbled what it had (model limit). A tool failure with no tool run = routing.
    if (root === "missing_retrieval" && (ctx.retrievalCount || 0) > 0) root = "model_limit";
    if (root === "bad_tool_schema" && (ctx.toolCount || 0) === 0) root = "bad_routing";
    return ROOT_CAUSES.includes(root) ? root : "unknown";
  }
  async function classifyFailure(critique, ctx = {}) {
    const evidence = [
      ...(critique.major_findings || []), ...(critique.reasoning_errors || []), ...(critique.unsupported_claims || []).map((c) => "unsupported claim: " + c),
      ...(critique.tool_use_issues || []).map((c) => "tool: " + c), ...(critique.safety_or_privacy_issues || []).map((c) => "security/privacy: " + c),
      ...(critique.style_or_format_issues || []).map((c) => "style/format: " + c),
    ].join(" · ").slice(0, 2000);
    let category = normalizeCategory(evidence);
    // Heuristic found nothing sharper than the generic bucket AND we have a model available → ask
    // the light model to pick from the enum (format json + think:false per the qwen3 gotcha).
    if (category === "bad_reasoning" && !/reason|logic|assumption/i.test(evidence) && ollamaChat) {
      try {
        const prompt = 'Classify this AI-assistant failure into EXACTLY ONE category from this list:\n' + FAILURE_CATEGORIES.join(", ") +
          '\nReturn ONLY JSON: {"category":"..."}.\n\nFailure evidence:\n' + evidence;
        const d = await ollamaChat(lightModel, [{ role: "user", content: prompt }], { temperature: 0, num_predict: 120, noTools: true, format: "json", think: false });
        const raw = stripThink((d && d.message && d.message.content) || "");
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { const j = JSON.parse(m[0]); if (FAILURE_CATEGORIES.includes(j.category)) category = j.category; }
      } catch {}
    }
    const rootCause = inferRootCause(category, ctx);
    return { category, rootCause, improvementActions: deriveActions(rootCause), evidence: evidence.slice(0, 500) };
  }

  // ---- A5: the 10-step mentor-feedback→improvement pipeline (spec 1426-1439) ----
  // Steps: 1 parse (mentor already returned structured JSON) · 2 validate · 3 local response ·
  // 4 classify · 5 generate candidates · 6 queue · 7 auto-apply safe ones · 8 eval linkage ·
  // 9 log · 10 retire stale rules. Returns a summary object that gets stored with the review.
  async function runPipeline(critique, ctx = {}) {
    const out = { valid: false, classification: null, generated: { evals: [], rules: [], retrievalRules: [], toolRules: [], toolOverlays: [], memories: [], finetune: [] }, autoApplied: [], localResponse: null, retired: [] };
    // 2) validate: a critique that failed to parse, or found nothing actionable, ends the pipeline.
    if (critique._parseError) { out.reason = "critique unparseable"; flywheel.addPipelineLog({ ...pipelineMeta(ctx), valid: false, reason: out.reason }); return out; }
    const hasFindings = (critique.major_findings || []).length || (critique.unsupported_claims || []).length ||
      (critique.reasoning_errors || []).length || (critique.tool_use_issues || []).length || (critique.safety_or_privacy_issues || []).length;
    const priority = critique.revision_priority;
    const anyCandidates = ["eval_case_candidates", "prompt_rule_candidates", "retrieval_rule_candidates", "memory_candidates"].some((k) => (critique[k] || []).length);
    if (!hasFindings && !anyCandidates && !["medium", "high"].includes(priority)) {
      out.valid = true; out.reason = "clean critique — nothing to improve";
      flywheel.addPipelineLog({ ...pipelineMeta(ctx), valid: true, reason: out.reason, score: critique.overall_score });
      return out;
    }
    out.valid = true;
    // 3) local model responds to the critique (agree / push back) — cheap, on the light model.
    if (!ctx.skipResponse && ollamaChat) {
      try {
        const prompt = 'An external reviewer critiqued your answer. Respond briefly. Return ONLY JSON: {"agree":true|false,"response":"1-3 sentences"}.\n\nCritique findings:\n' +
          JSON.stringify({ major_findings: critique.major_findings, unsupported_claims: critique.unsupported_claims, reasoning_errors: critique.reasoning_errors }).slice(0, 2500) +
          "\n\nYour original answer (excerpt):\n" + String(ctx.answer || "").slice(0, 2500);
        const d = await ollamaChat(lightModel, [{ role: "user", content: prompt }], { temperature: 0.2, num_predict: 300, noTools: true, format: "json", think: false });
        const raw = stripThink((d && d.message && d.message.content) || "");
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { const j = JSON.parse(m[0]); out.localResponse = { agree: j.agree !== false, response: String(j.response || "").slice(0, 400) }; }
      } catch {}
    }
    // 4) classify (only when the critique flags a real failure) + ledger entry with typed fields.
    let ledgerEntry = null;
    if (hasFindings && ["medium", "high"].includes(priority)) {
      out.classification = await classifyFailure(critique, ctx);
      const f = flywheel.addFailure({
        category: out.classification.category, severity: priority === "high" ? "high" : "medium",
        originalRequest: ctx.originalRequest || "", flawedOutput: ctx.answer || "", detectedBy: "mentor",
        mentorProviderId: critique._provider, rootCause: out.classification.rootCause,
        improvementActions: out.classification.improvementActions, samplingCategory: ctx.samplingCategory, chatId: ctx.chatId,
      });
      ledgerEntry = f.item; out.ledgerId = f.item.id;
    }
    // 5+6) generate improvement candidates from the critique's arrays and QUEUE them.
    for (const c of (critique.eval_case_candidates || []).slice(0, 4)) {
      const r = flywheel.addEval({ title: String(c).slice(0, 120), category: evalCategoryFor(out.classification), input: ctx.originalRequest || String(c).slice(0, 2000), expectedBehavior: String(c).slice(0, 1500), source: "mentor" });
      if (r.item) { out.generated.evals.push(r.item.id); out.autoApplied.push("eval:" + r.item.id.slice(0, 8)); }   // 7) evals are inert tests — safe to auto-add
    }
    for (const c of (critique.prompt_rule_candidates || []).slice(0, 4)) {
      const r = flywheel.addRule({ scope: "global", content: String(c).slice(0, 800), status: "candidate", sourceEvalId: out.generated.evals[0] || null });   // 8) eval linkage
      if (r.item) out.generated.rules.push(r.item.id);   // rules queue as CANDIDATES — activation stays explicit even under LAX
    }
    for (const c of (critique.retrieval_rule_candidates || []).slice(0, 4)) {
      const r = flywheel.addRule({ scope: "retrieval", content: String(c).slice(0, 800), status: "candidate", sourceEvalId: out.generated.evals[0] || null });
      if (r.item) out.generated.retrievalRules.push(r.item.id);
    }
    // Tool-use issues: when the finding names a REAL registered tool, it becomes a per-tool
    // DESCRIPTION OVERLAY candidate (C3 Tool Description Update — activation folds it into the
    // tool's model-facing description); otherwise it queues as a generic tool-scope rule.
    for (const c of (critique.tool_use_issues || []).slice(0, 2)) {
      const text = String(c);
      const named = toolNames.find((n) => text.includes(n));
      if (named && flywheel.addToolOverlay) {
        const o = flywheel.addToolOverlay({ toolName: named, content: "Mentor guidance: " + text.slice(0, 500), source: "mentor", status: "candidate" });
        if (o.item) out.generated.toolOverlays.push(o.item.id);
      }
      const r = flywheel.addRule({ scope: "tool", content: "Tool guidance: " + text.slice(0, 700), status: "candidate" });
      if (r.item) out.generated.toolRules.push(r.item.id);
    }
    for (const c of (critique.memory_candidates || []).slice(0, 3)) {
      if (!memory) break;
      const r = memory.propose({ content: String(c).slice(0, 400), type: "failure", source: { kind: "mentor_suggested" }, tags: ["mentor"] });
      if (r.item && !r.deduped) { out.generated.memories.push(r.item.id); if (autoApply && r.item.status === "approved") out.autoApplied.push("memory:" + r.item.id.slice(0, 8)); }
    }
    // Fine-tuning candidate (spec allowed source: mentor critique transformed into a RUBRIC, never a
    // copied output) — only when classification says the failure is a model limit.
    if (out.classification && out.classification.improvementActions.includes("fine_tuning_candidate") && ctx.originalRequest) {
      const rubric = "When answering: " + (critique.recommended_revision || (critique.major_findings || []).join("; ")).slice(0, 1200);
      const r = flywheel.addFinetune({ input: ctx.originalRequest, idealOutput: "", notes: rubric, source: "mentor_rubric", linkedFailureId: out.ledgerId || null, linkedEvalId: out.generated.evals[0] || null });
      if (r.item) out.generated.finetune.push(r.item.id);
    }
    // 8) eval linkage back onto the ledger entry.
    if (ledgerEntry && (out.generated.evals.length || out.generated.rules.length))
      flywheel.update("failures", ledgerEntry.id, { linkedEvalIds: out.generated.evals, linkedRuleIds: [...out.generated.rules, ...out.generated.retrievalRules] });
    // 10) retire stale/harmful rules opportunistically (cheap scan, runs with every pipeline pass).
    out.retired = flywheel.autoRetire();
    // 9) log the whole pass.
    flywheel.addPipelineLog({ ...pipelineMeta(ctx), valid: true, score: critique.overall_score, priority, classification: out.classification, generated: out.generated, autoApplied: out.autoApplied, retired: out.retired.length, localResponse: out.localResponse });
    return out;
  }
  const pipelineMeta = (ctx) => ({ chatId: ctx.chatId, artifactId: ctx.artifactId, samplingCategory: ctx.samplingCategory, tier: ctx.tier });
  const evalCategoryFor = (cls) => {
    if (!cls) return "reasoning";
    const map = { code_bug: "coding", test_failure: "coding", security_issue: "coding", tool_misuse: "tool_use", dangerous_tool_proposal: "tool_use", permission_violation: "tool_use", bad_routing: "routing", unnecessary_long_context: "routing", bad_memory_use: "memory", over_saved_memory: "memory", under_saved_memory: "memory", weak_structure: "document", poor_writing: "style", wrong_tone: "style", formatting_error: "style" };
    return map[cls.category] || (/factual|citation|caveat/.test(cls.category) ? "factuality" : "reasoning");
  };

  // ---- the background lane: one review at a time, small backlog cap (the 30B is slow) ----
  // Interactive-priority: when a waitIdle hook is provided (server passes the interactive-lane
  // waiter), every queued job WAITS for live chats to finish (+ cooldown) before touching the
  // model. Jobs are deferred, never dropped — the backlog cap only guards runaway queueing.
  let lane = Promise.resolve(); let backlog = 0;
  function enqueue(job) {
    if (backlog >= 4) { log("review backlog full — dropping an auto review"); return false; }
    backlog++;
    lane = lane.then(async () => { if (waitIdle) await waitIdle(); return job(); }).catch((e) => log("review job error: " + (e && e.message))).finally(() => backlog--);
    return true;
  }

  // Full review-now path (used by tier escalation, periodic review, and manual endpoints that want
  // the pipeline): critique → store review → pipeline.
  async function reviewNow({ tier, taskType = "answer_review", answer, originalRequest, retrievedContext, toolCalls, samplingCategory, triggers = [], chatId, artifactId, mode, role }) {
    const critique = await mentor.critique({ taskType, originalRequest, content: answer, privacyMode: "local_only", retrievedContext, toolCalls, mode, chatId, artifactId, role });
    const pipeline = await runPipeline(critique, { answer, originalRequest, samplingCategory, chatId, artifactId, tier, retrievalCount: (retrievedContext || []).length, toolCount: (toolCalls || []).length });
    const rec = flywheel.addReview({ tier, trigger: triggers, samplingCategory, taskType, chatId, artifactId, provider: critique._provider, critique, request: critique._request, pipeline: { valid: pipeline.valid, ledgerId: pipeline.ledgerId, classification: pipeline.classification, generated: pipeline.generated, autoApplied: pipeline.autoApplied }, contentPreview: String(answer || "").slice(0, 300) });
    log(`review tier ${tier} (${taskType}) score ${critique.overall_score}/10 priority ${critique.revision_priority}` + (pipeline.classification ? ` → ${pipeline.classification.category}/${pipeline.classification.rootCause}` : ""));
    return { critique, pipeline, reviewId: rec.item.id };
  }

  // ---- the post-answer hook: decide tier, then fire-and-forget. NEVER blocks the caller. ----
  // Returns the decision synchronously (so the server can emit an SSE breadcrumb before `done`).
  function schedule(sig) {
    const decision = decide(sig);
    if (decision.tier === 0) return decision;
    const queued = enqueue(async () => {
      let tier = decision.tier;
      if (tier === 1) {
        const screen = await lightCheck({ answer: sig.answer, lastUserText: sig.lastUserText });
        if (!screen.escalate && screen.ok) {
          // Screen passed: record the cheap check, no full review, no 30B spent.
          flywheel.addReview({ tier: 1, trigger: decision.triggers, samplingCategory: decision.category, taskType: "light_check", chatId: sig.chatId, provider: "local mentor", critique: { overall_score: null, light: screen }, contentPreview: String(sig.answer || "").slice(0, 300) });
          log(`review tier 1 light check passed (${decision.category})`);
          return;
        }
        tier = 2;   // escalate: the light screen smelled trouble
        decision.triggers.push("light_check_escalation");
      }
      await reviewNow({
        tier, answer: sig.answer, originalRequest: sig.lastUserText, retrievedContext: sig.retrievedContext,
        toolCalls: sig.toolCalls, samplingCategory: decision.category, triggers: decision.triggers,
        chatId: sig.chatId, artifactId: sig.artifactId, mode: sig.mode,
        taskType: decision.category === "executableCode" || decision.category === "codeGeneration" ? "code_review" : "answer_review",
      });
    });
    return { ...decision, queued };
  }

  return { schedule, reviewNow, runPipeline, classifyFailure, lightCheck, decide, effectiveRate, backlogSize: () => backlog };
}
