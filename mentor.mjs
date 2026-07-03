/*
 * Dominion AI — Phase 5 mentor bridge ("the mentor").
 *
 * A mentor is a CRITIC, not an oracle. It reviews a local answer/artifact and returns a STRUCTURED
 * critique that the flywheel turns into evals, prompt rules, memory candidates, or ledger entries.
 *
 * Provider abstraction: default mentor is LOCAL (the 30B) — zero egress, zero privacy concern. An
 * EXTERNAL mentor (OpenAI-compatible, e.g. OpenRouter) is opt-in via MENTOR_API_KEY+MENTOR_MODEL;
 * if unset, everything falls back to local. Even under LAX, external egress stays careful: the
 * redaction layer runs before any external call unless privacy mode is explicitly "approved_external".
 */
import http from "node:http";
import https from "node:https";

// ---- redaction layer (conservative — regex-detectable secrets only; never mangles code wholesale) ----
const REDACTORS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[api-key]"],
  [/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt]"],
  [/\b[0-9a-fA-F]{40,}\b/g, "[hex-secret]"],
  [/(?<=\b(?:password|passwd|pwd|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*)\S+/gi, "[secret]"],
];
export function redact(text) {
  let out = String(text || ""); const applied = [];
  for (const [re, rep] of REDACTORS) { if (re.test(out)) { applied.push(rep); out = out.replace(re, rep); } }
  return { redacted: out, applied: [...new Set(applied)] };
}

function reqJson(method, url, headers, body) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ status: 0, text: "bad url" }); }
    const mod = u.protocol === "https:" ? https : http;
    const data = body == null ? null : JSON.stringify(body);
    const h = { ...headers }; if (data != null) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(data); }
    const r = mod.request({ method, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, headers: h, timeout: 120000 },
      (resp) => { let buf = ""; resp.on("data", (d) => (buf += d)); resp.on("end", () => resolve({ status: resp.statusCode || 0, text: buf })); });
    r.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, text: "timeout" }); });
    if (data != null) r.write(data); r.end();
  });
}

const EMPTY = {
  overall_score: 0, confidence: 0, hallucination_risk: "unknown",
  major_findings: [], minor_findings: [], unsupported_claims: [], reasoning_errors: [],
  missing_context: [], tool_use_issues: [], safety_or_privacy_issues: [], style_or_format_issues: [],
  recommended_revision: "", revision_priority: "none",
  memory_candidates: [], eval_case_candidates: [], prompt_rule_candidates: [], retrieval_rule_candidates: [],
};
const arr = (x) => (Array.isArray(x) ? x.map((v) => (typeof v === "string" ? v : JSON.stringify(v))) : []);
function parseCritique(raw) {
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  let j = null; if (m) { try { j = JSON.parse(m[0]); } catch {} }
  if (!j) return { ...EMPTY, recommended_revision: String(raw || "").slice(0, 1500), _parseError: true };
  return {
    ...EMPTY, ...j,
    major_findings: arr(j.major_findings), minor_findings: arr(j.minor_findings), unsupported_claims: arr(j.unsupported_claims),
    reasoning_errors: arr(j.reasoning_errors), missing_context: arr(j.missing_context), tool_use_issues: arr(j.tool_use_issues),
    safety_or_privacy_issues: arr(j.safety_or_privacy_issues), style_or_format_issues: arr(j.style_or_format_issues),
    memory_candidates: arr(j.memory_candidates), eval_case_candidates: arr(j.eval_case_candidates),
    prompt_rule_candidates: arr(j.prompt_rule_candidates), retrieval_rule_candidates: arr(j.retrieval_rule_candidates),
  };
}

const RUBRIC = "Factual accuracy, completeness, reasoning quality, usefulness, safety, privacy, formatting, tool-use correctness, and whether this should become a durable eval or prompt rule.";

// The spec's 7 specialist mentor roles, each with its own rubric. A single-mentor review picks the
// role matching the taskType; the Tier-3 council runs several roles independently and reconciles.
export const MENTOR_ROLES = {
  coding:       { label: "Coding mentor",       rubric: "Code correctness, bugs, edge cases, architecture soundness, test coverage gaps, error handling, security of the code itself. Flag anything that would fail at runtime." },
  factual:      { label: "Factual mentor",      rubric: "Unsupported claims, incorrect claims, hallucinated citations or sources, missing caveats, statements that need a source. Judge ONLY factual reliability." },
  reasoning:    { label: "Reasoning mentor",    rubric: "Logic errors, missing assumptions, unjustified leaps, decision quality, ignored alternatives, internal contradictions. Audit the argument, not the prose." },
  writing:      { label: "Writing mentor",      rubric: "Clarity, tone, structure, concision, formatting, document quality, whether the output answers what was actually asked." },
  tool_use:     { label: "Tool-use mentor",     rubric: "Tool safety, permission violations, incorrect tool choice, missing confirmations, destructive-action risk, whether tool results were used honestly." },
  long_context: { label: "Long-context mentor", rubric: "Coverage of the large input: missed sections, misattributed content, over-reliance on one part, faithfulness to the source material." },
  agent:        { label: "Agent mentor",        rubric: "Multi-step workflow quality: step ordering, failure prediction, recovery paths, unnecessary steps, whether the plan actually reaches the goal." },
};
const ROLE_FOR_TASK = {
  code_review: "coding", tool_use_audit: "tool_use", hallucination_check: "factual",
  reasoning_review: "reasoning", document_review: "writing", routing_review: "agent",
  memory_review: "agent", eval_generation: "reasoning", answer_review: null,   // null = generic rubric
};

// Spec Document Review Output Schema — 10 machine-readable fields.
export const DOC_REVIEW_SCHEMA = {
  overall_score: 0, ready_for_use: false, major_issues: [], minor_issues: [], unsupported_claims: [],
  clarity_suggestions: [], formatting_suggestions: [], risk_flags: [], recommended_revision_plan: [], should_generate_revision: false,
};

// Spec MentorReviewRequest — the typed review package. Everything a mentor sees is assembled here
// (and stored with the review), so redaction/metadata are auditable instead of vanishing into a string.
export function buildReviewRequest(o = {}) {
  return {
    taskType: o.taskType || "answer_review",
    originalUserRequest: String(o.originalRequest || "").slice(0, 3000),
    localModelAnswer: o.content != null ? String(o.content).slice(0, 12000) : undefined,
    artifactContent: o.artifactContent != null ? String(o.artifactContent).slice(0, 12000) : undefined,
    codeContent: o.codeContent != null ? String(o.codeContent).slice(0, 12000) : undefined,
    toolCalls: Array.isArray(o.toolCalls) ? o.toolCalls.slice(0, 20) : undefined,
    retrievedContext: Array.isArray(o.retrievedContext) ? o.retrievedContext.map((c) => String(c).slice(0, 300)).slice(0, 10) : undefined,
    reviewRubric: o.rubric || RUBRIC,
    requestedOutputSchema: o.requestedOutputSchema || null,
    privacyMode: o.privacyMode || "local_only",
    redactionsApplied: Array.isArray(o.redactionsApplied) ? o.redactionsApplied : [],
    metadata: {
      localModel: o.localModel || "local",
      mode: o.mode || "",
      contextTokenEstimate: o.contextTokenEstimate || undefined,
      artifactId: o.artifactId || undefined,
      chatId: o.chatId || undefined,
    },
  };
}

function mentorPrompt(taskType, originalRequest, content, rubric, extras = {}) {
  const parts = [
    "You are a mentor evaluator for a local AI assistant. Review the assistant output against the rubric.",
    "Do NOT rewrite unless asked. Identify unsupported claims, reasoning errors, tool-use risks, and privacy concerns. Be specific and concise.",
    "Return ONLY valid JSON (no prose) with these keys: overall_score (0-10), confidence (0-1), hallucination_risk (low|medium|high),",
    "major_findings[], minor_findings[], unsupported_claims[], reasoning_errors[], missing_context[], tool_use_issues[],",
    "safety_or_privacy_issues[], style_or_format_issues[], recommended_revision (string), revision_priority (none|low|medium|high),",
    "memory_candidates[], eval_case_candidates[], prompt_rule_candidates[], retrieval_rule_candidates[].",
    "\nTask type: " + (taskType || "answer_review"),
    "Rubric: " + (rubric || RUBRIC),
    "\nOriginal request:\n" + String(originalRequest || "(none)").slice(0, 3000),
  ];
  // Full review package (spec): what context the assistant actually saw + what tools it ran.
  if (Array.isArray(extras.retrievedContext) && extras.retrievedContext.length)
    parts.push("\nContext the assistant had loaded:\n" + extras.retrievedContext.map((c) => "- " + String(c).slice(0, 300)).join("\n").slice(0, 3000));
  if (Array.isArray(extras.toolCalls) && extras.toolCalls.length)
    parts.push("\nTool calls the assistant made (name · status):\n" + extras.toolCalls.map((t) => "- " + String(t).slice(0, 120)).join("\n").slice(0, 1500));
  parts.push("\nAssistant output to review:\n" + String(content || "").slice(0, 12000));
  return parts.join("\n");
}

export function createMentor({ localChat, mainModel, cfg = {} }) {
  const provider = cfg.provider || "local";
  const endpoint = cfg.endpoint || "https://openrouter.ai/api/v1/chat/completions";
  const externalReady = provider === "external" && !!cfg.apiKey && !!cfg.model;

  async function run(messages) {
    if (externalReady) {
      const r = await reqJson("POST", endpoint, { authorization: "Bearer " + cfg.apiKey }, { model: cfg.model, messages, temperature: 0.3 });
      const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
      const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (txt) return txt;
      return JSON.stringify({ recommended_revision: "External mentor error (HTTP " + r.status + "): " + String(r.text).slice(0, 200), revision_priority: "none" });
    }
    // qwen3 gotcha: format:"json" without think:false collapses to "{}" — always pair them locally.
    const d = await localChat(mainModel, messages, { temperature: 0.3, num_predict: 2000, noTools: true, format: "json", think: false });
    return (d && d.message && d.message.content) || "";
  }

  const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();

  // privacyMode: local_only | redacted_external | approved_external.
  // local_only FORCES the local mentor even when an external one is configured (privacy override).
  // Accepts the full spec MentorReviewRequest field set; the assembled package rides back on the
  // critique as _request so callers can store/audit exactly what the mentor was sent.
  async function critique({ taskType, originalRequest, content, rubric, privacyMode = "redacted_external", retrievedContext, toolCalls, role, mode, chatId, artifactId, contextTokenEstimate, requestedOutputSchema }) {
    const external = externalReady && privacyMode !== "local_only";
    let body = String(content || ""); let redactions = [];
    if (external && privacyMode !== "approved_external") { const r = redact(body); body = r.redacted; redactions = r.applied; }
    // Role-specialized rubric: explicit role wins, else the taskType's natural specialist, else generic.
    const roleKey = role && MENTOR_ROLES[role] ? role : ROLE_FOR_TASK[taskType] || null;
    const effRubric = rubric || (roleKey ? MENTOR_ROLES[roleKey].rubric : RUBRIC);
    const request = buildReviewRequest({
      taskType, originalRequest, content: body, toolCalls, retrievedContext, rubric: effRubric,
      requestedOutputSchema: requestedOutputSchema || Object.keys(EMPTY),
      privacyMode: external ? privacyMode : "local_only", redactionsApplied: redactions,
      localModel: external ? "external" : "local", mode, chatId, artifactId, contextTokenEstimate,
    });
    const prompt = mentorPrompt(taskType, request.originalUserRequest, body, effRubric, { retrievedContext, toolCalls });
    const raw = stripThink(await run([{ role: "user", content: prompt }]));
    const parsed = parseCritique(raw);
    // UI-facing label — never surfaces underlying model names (house rule).
    parsed._provider = external ? "external mentor" : "local mentor";
    parsed._role = roleKey ? MENTOR_ROLES[roleKey].label : null;
    parsed._redactions = redactions;
    parsed._request = { ...request, localModelAnswer: undefined, artifactContent: undefined, codeContent: undefined };   // package minus bulky bodies
    return parsed;
  }

  // Structured document review (spec Document Review Output Schema, 10 fields). format:"json" +
  // think:false makes the local model reliable at this.
  async function documentReview({ title, type, content, originalRequest, privacyMode = "local_only" }) {
    const external = externalReady && privacyMode !== "local_only";
    let body = String(content || "").slice(0, 12000); let redactions = [];
    if (external && privacyMode !== "approved_external") { const r = redact(body); body = r.redacted; redactions = r.applied; }
    const prompt = [
      "You are a document reviewer. Review the document and return ONLY valid JSON exactly matching this schema (no prose):",
      JSON.stringify(DOC_REVIEW_SCHEMA),
      "overall_score is 0-10. ready_for_use is your verdict as-is. risk_flags = legal/financial/medical/operational/security risks.",
      "recommended_revision_plan = ordered short steps. should_generate_revision = whether an automatic revision pass is worth running.",
      originalRequest ? "\nThe document was requested as:\n" + String(originalRequest).slice(0, 1500) : "",
      "\nTITLE: " + String(title || "").slice(0, 200) + "\nTYPE: " + String(type || "document"),
      "\nDOCUMENT:\n" + body,
    ].join("\n");
    const raw = stripThink(await run([{ role: "user", content: prompt }]));
    const m = raw.match(/\{[\s\S]*\}/);
    let j = null; if (m) { try { j = JSON.parse(m[0]); } catch {} }
    if (!j) return { ...DOC_REVIEW_SCHEMA, major_issues: ["review parse failed"], _parseError: true, _provider: external ? "external mentor" : "local mentor" };
    const out = {
      overall_score: Number(j.overall_score) || 0, ready_for_use: !!j.ready_for_use,
      major_issues: arr(j.major_issues), minor_issues: arr(j.minor_issues), unsupported_claims: arr(j.unsupported_claims),
      clarity_suggestions: arr(j.clarity_suggestions), formatting_suggestions: arr(j.formatting_suggestions),
      risk_flags: arr(j.risk_flags), recommended_revision_plan: arr(j.recommended_revision_plan),
      should_generate_revision: !!j.should_generate_revision,
    };
    out._provider = external ? "external mentor" : "local mentor";
    out._redactions = redactions;
    return out;
  }

  // Tier-3 Multi-Mentor Council (spec): several role-specialized mentors review INDEPENDENTLY,
  // then a reconciliation pass merges agreements/conflicts into one council critique. Expensive on
  // this CPU box (N+1 heavy calls) — manual / high-stakes only; callers store the result as evals.
  async function council({ content, originalRequest, roles, taskType = "answer_review", privacyMode = "local_only", mode, chatId, artifactId }) {
    const picked = (Array.isArray(roles) && roles.length ? roles : autoRoles(content)).filter((r) => MENTOR_ROLES[r]).slice(0, 7);
    const reviews = [];
    for (const r of picked) {   // sequential on purpose — parallel 30B calls would thrash the CPU box
      const c = await critique({ taskType, originalRequest, content, role: r, privacyMode, mode, chatId, artifactId });
      reviews.push({ role: r, label: MENTOR_ROLES[r].label, critique: c });
    }
    const reconciliation = await reconcile(reviews, originalRequest);
    return { roles: picked, reviews, reconciliation, critique: reconciliation.merged };
  }
  // Content-driven default council: always factual+reasoning, plus the obvious specialists.
  function autoRoles(content) {
    const t = String(content || "");
    const roles = ["factual", "reasoning"];
    if (/```|\bfunction\b|\bdef |\bclass |\bimport /.test(t)) roles.push("coding");
    if (t.length > 6000) roles.push("long_context");
    if (roles.length < 3) roles.push("writing");
    return roles;
  }
  // Reconciliation: merge N independent critiques — agreements (flagged by 2+), conflicts, and a
  // single merged critique in the standard 16-key schema (so downstream pipeline code just works).
  async function reconcile(reviews, originalRequest) {
    const summaries = reviews.map((r) => ({
      role: r.label, score: r.critique.overall_score, hallucination_risk: r.critique.hallucination_risk,
      major_findings: r.critique.major_findings.slice(0, 8), unsupported_claims: r.critique.unsupported_claims.slice(0, 5),
      revision_priority: r.critique.revision_priority, recommended_revision: String(r.critique.recommended_revision || "").slice(0, 500),
      eval_case_candidates: r.critique.eval_case_candidates.slice(0, 4), prompt_rule_candidates: r.critique.prompt_rule_candidates.slice(0, 4),
    }));
    const prompt = [
      "You are the chair of a review council. Several specialist reviewers independently critiqued the same assistant output.",
      "Reconcile them. Return ONLY valid JSON: {\"agreements\":[], \"conflicts\":[], \"merged\":{...}} where",
      "agreements[] = findings raised by 2+ reviewers (short strings), conflicts[] = points where reviewers disagree (short strings, name the roles),",
      "and merged = ONE combined critique with keys: overall_score (0-10), confidence (0-1), hallucination_risk (low|medium|high),",
      "major_findings[], minor_findings[], unsupported_claims[], reasoning_errors[], missing_context[], tool_use_issues[],",
      "safety_or_privacy_issues[], style_or_format_issues[], recommended_revision (string), revision_priority (none|low|medium|high),",
      "memory_candidates[], eval_case_candidates[], prompt_rule_candidates[], retrieval_rule_candidates[].",
      "Weight consensus over outliers; keep every agreement in the merged findings.",
      originalRequest ? "\nOriginal request:\n" + String(originalRequest).slice(0, 1500) : "",
      "\nReviewer critiques:\n" + JSON.stringify(summaries).slice(0, 9000),
    ].join("\n");
    const raw = stripThink(await run([{ role: "user", content: prompt }]));
    const m = raw.match(/\{[\s\S]*\}/);
    let j = null; if (m) { try { j = JSON.parse(m[0]); } catch {} }
    if (!j || !j.merged) {
      // Deterministic fallback: majority-merge without a model (keeps the council usable if the chair call flops).
      const all = (k) => [...new Set(reviews.flatMap((r) => r.critique[k] || []))];
      const avg = reviews.reduce((n, r) => n + (Number(r.critique.overall_score) || 0), 0) / (reviews.length || 1);
      const pr = ["high", "medium", "low", "none"].find((p) => reviews.some((r) => r.critique.revision_priority === p)) || "none";
      return {
        agreements: [], conflicts: [], _parseError: !!raw,
        merged: { ...parseCritique("{}"), overall_score: Math.round(avg * 10) / 10, revision_priority: pr,
          major_findings: all("major_findings"), unsupported_claims: all("unsupported_claims"),
          eval_case_candidates: all("eval_case_candidates"), prompt_rule_candidates: all("prompt_rule_candidates"),
          memory_candidates: all("memory_candidates"), retrieval_rule_candidates: all("retrieval_rule_candidates"),
          recommended_revision: reviews.map((r) => r.label + ": " + String(r.critique.recommended_revision || "").slice(0, 200)).join("\n"),
          _provider: reviews[0] ? reviews[0].critique._provider : "local mentor" },
      };
    }
    const merged = parseCritique(JSON.stringify(j.merged));
    merged._provider = reviews[0] ? reviews[0].critique._provider : "local mentor";
    merged._council = true;
    return { agreements: arr(j.agreements), conflicts: arr(j.conflicts), merged };
  }

  // Apply a critique: the local main model produces a revised version of the content.
  async function revise({ originalRequest, content, critique: crit }) {
    const prompt = [
      "You are revising an assistant's output using a mentor's critique. Produce ONLY the fully revised output — no preamble, no meta-commentary, keep the original format.",
      "\nOriginal request:\n" + String(originalRequest || "(none)").slice(0, 3000),
      "\nCurrent output:\n" + String(content || "").slice(0, 12000),
      "\nMentor critique to apply:\n" + JSON.stringify(crit || {}).slice(0, 4000),
    ].join("\n");
    const d = await localChat(mainModel, [{ role: "user", content: prompt }], { temperature: 0.4, num_predict: 4000, noTools: true });
    return stripThink((d && d.message && d.message.content) || "");
  }

  const info = () => ({ provider: externalReady ? "external mentor" : "local mentor", externalConfigured: externalReady });
  return { critique, documentReview, council, revise, redact, info };
}
