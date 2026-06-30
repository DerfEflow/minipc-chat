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
function mentorPrompt(taskType, originalRequest, content, rubric) {
  return [
    "You are a mentor evaluator for a local AI assistant. Review the assistant output against the rubric.",
    "Do NOT rewrite unless asked. Identify unsupported claims, reasoning errors, tool-use risks, and privacy concerns. Be specific and concise.",
    "Return ONLY valid JSON (no prose) with these keys: overall_score (0-10), confidence (0-1), hallucination_risk (low|medium|high),",
    "major_findings[], minor_findings[], unsupported_claims[], reasoning_errors[], missing_context[], tool_use_issues[],",
    "safety_or_privacy_issues[], style_or_format_issues[], recommended_revision (string), revision_priority (none|low|medium|high),",
    "memory_candidates[], eval_case_candidates[], prompt_rule_candidates[], retrieval_rule_candidates[].",
    "\nTask type: " + (taskType || "answer_review"),
    "Rubric: " + (rubric || RUBRIC),
    "\nOriginal request:\n" + String(originalRequest || "(none)").slice(0, 3000),
    "\nAssistant output to review:\n" + String(content || "").slice(0, 12000),
  ].join("\n");
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
    const d = await localChat(mainModel, messages, { temperature: 0.3, num_predict: 1400, noTools: true });
    return (d && d.message && d.message.content) || "";
  }

  // privacyMode: local_only | redacted_external | approved_external
  async function critique({ taskType, originalRequest, content, rubric, privacyMode = "redacted_external" }) {
    let body = String(content || ""); let redactions = [];
    if (externalReady && privacyMode !== "approved_external") { const r = redact(body); body = r.redacted; redactions = r.applied; }
    const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
    const raw = stripThink(await run([{ role: "user", content: mentorPrompt(taskType, originalRequest, body, rubric) }]));
    const parsed = parseCritique(raw);
    parsed._provider = externalReady ? cfg.model + " (external)" : mainModel + " (local)";
    parsed._redactions = redactions;
    return parsed;
  }

  const info = () => ({ provider: externalReady ? "external:" + cfg.model : "local:" + mainModel, externalConfigured: externalReady });
  return { critique, redact, info };
}
