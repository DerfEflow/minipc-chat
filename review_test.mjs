/*
 * Group-A restoration self-test — run with: node review_test.mjs
 * Proves (with a mocked ollamaChat, no live model needed):
 *   1. the 8 automatic mentor-review triggers fire on synthetic cases
 *   2. all 10 sampling categories are reachable + rates adapt on ledger failures
 *   3. failure classification returns enum values with an INFERRED rootCause + DERIVED actions
 *   4. the Tier-3 council reconciles two mock role critiques into one merged critique
 *   5. the 10-step pipeline generates + queues improvement objects (evals auto-applied, rules
 *      queued as candidates, memory through gating, finetune from mentor rubric) + auto-retire
 *   6. NormalizedModelResponse-style quality block comes out of computeQuality
 *   7. the finetune store rejects non-clean sources and queues clean ones
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlywheel, FAILURE_CATEGORIES, ROOT_CAUSES, IMPROVEMENT_ACTIONS, normalizeCategory } from "./flywheel.mjs";
import { createMentor, MENTOR_ROLES, buildReviewRequest, DOC_REVIEW_SCHEMA } from "./mentor.mjs";
import { createReviewEngine, detectTriggers, categorizeTurn, computeQuality, countClaims, extractCitations, isTier0, wantsReview, MENTOR_SAMPLING } from "./review.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

const dir = mkdtempSync(join(tmpdir(), "dominion-flywheel-test-"));
const fw = createFlywheel({ dir });

// Mock memory store: everything proposed auto-approves (LAX).
const mem = { propose: (o) => ({ item: { id: "mem_" + Math.random().toString(36).slice(2, 8), status: "approved", content: o.content } }) };

// Mock model: routes by prompt content so each engine path gets a sane canned JSON answer.
const mockChat = async (model, messages) => {
  const p = messages[messages.length - 1].content;
  const reply = (o) => ({ message: { content: JSON.stringify(o) } });
  if (/quality screener/i.test(p)) return reply({ ok: false, escalate: true, hallucination_risk: "medium", concerns: ["numbers look invented"] });
  if (/Classify this AI-assistant failure/i.test(p)) return reply({ category: "incorrect_factual_claim" });
  if (/reviewer critiqued your answer/i.test(p)) return reply({ agree: true, response: "Fair points; the population figure was unverified." });
  if (/chair of a review council/i.test(p)) return reply({
    agreements: ["the growth number is unsupported"], conflicts: ["coding mentor found the sample fine; factual mentor disagrees on the source"],
    merged: { overall_score: 5, confidence: 0.8, hallucination_risk: "medium", major_findings: ["unsupported growth figure"], minor_findings: [],
      unsupported_claims: ["40% YoY growth"], reasoning_errors: [], missing_context: [], tool_use_issues: [], safety_or_privacy_issues: [],
      style_or_format_issues: [], recommended_revision: "cite the growth source", revision_priority: "medium",
      memory_candidates: [], eval_case_candidates: ["verify growth stats get a source"], prompt_rule_candidates: [], retrieval_rule_candidates: [] },
  });
  if (/mentor evaluator/i.test(p)) {
    // Role-flavored critiques for the council's independent passes.
    const factual = /Unsupported claims, incorrect claims/i.test(p);
    return reply({ overall_score: factual ? 4 : 7, confidence: 0.7, hallucination_risk: factual ? "high" : "low",
      major_findings: factual ? ["the 40% figure has no source"] : ["loop bound off by one"], minor_findings: [],
      unsupported_claims: factual ? ["40% YoY growth"] : [], reasoning_errors: [], missing_context: [], tool_use_issues: ["export_artifact was called without confirming the format"],
      safety_or_privacy_issues: [], style_or_format_issues: [], recommended_revision: "add sources", revision_priority: "medium",
      memory_candidates: ["Fred wants growth stats sourced"], eval_case_candidates: ["growth stats must cite a source"],
      prompt_rule_candidates: ["When stating statistics, name the source or mark the claim unverified."], retrieval_rule_candidates: ["For statistical claims, retrieve source notes first."] });
  }
  if (/document reviewer/i.test(p)) return reply({ overall_score: 6, ready_for_use: false, major_issues: ["missing executive summary"], minor_issues: [], unsupported_claims: ["market size claim"], clarity_suggestions: ["shorter intro"], formatting_suggestions: [], risk_flags: ["financial language"], recommended_revision_plan: ["add summary", "source the market size"], should_generate_revision: true });
  return reply({});
};

const mentor = createMentor({ localChat: mockChat, mainModel: "mock-main", cfg: {} });
const engine = createReviewEngine({ mentor, flywheel: fw, memory: mem, ollamaChat: mockChat, lightModel: "mock-light", mainModel: "mock-main", autoApply: true, log: () => {} });

await t("A2: all eight triggers fire on synthetic cases", () => {
  assert.ok(detectTriggers({ markedFinal: true }).includes("final_output"), "final_output");
  assert.ok(detectTriggers({ answer: "```python\nprint(1)\n```", lastUserText: "write a script and run it" }).includes("executable_code"), "executable_code");
  assert.ok(detectTriggers({ executedCode: true }).includes("executable_code"), "executable_code via tool");
  assert.ok(detectTriggers({ exported: true }).includes("export"), "export");
  assert.ok(detectTriggers({ quality: { hallucinationRisk: "high" } }).includes("hallucination_risk"), "hallucination_risk via quality");
  assert.ok(detectTriggers({ lastUserText: "what is the right dosage for this medical issue" }).includes("hallucination_risk"), "hallucination_risk via topic");
  const claims = Array.from({ length: 9 }, (_, i) => `The system holds ${i + 2} million records as of 2024.`).join(" ");
  assert.ok(detectTriggers({ answer: claims }).includes("claim_count"), "claim_count");
  assert.ok(detectTriggers({ lastUserText: "please double-check this for me" }).includes("user_ask"), "user_ask");
  assert.ok(detectTriggers({ routeNeedsReview: true }).includes("user_ask"), "user_ask via router signal");
  assert.ok(detectTriggers({ answer: "I'm not sure about this. I may be wrong on the details." }).includes("uncertainty"), "uncertainty via markers");
  assert.ok(detectTriggers({ answer: "ok", quality: { confidence: 0.2 } }).includes("uncertainty"), "uncertainty via confidence");
  assert.ok(detectTriggers({ toolCount: 4 }).includes("complex_tool_chain"), "complex_tool_chain via count");
  assert.ok(detectTriggers({ toolFailed: true }).includes("complex_tool_chain"), "complex_tool_chain via failure");
  assert.equal(detectTriggers({ answer: "Sure, sounds good!", lastUserText: "thanks" }).length, 0, "no false fire on chitchat");
});

await t("A3: all ten sampling categories are reachable", () => {
  const cases = {
    toolChainWithErrors: { toolFailed: true },
    userMarkedImportant: { lastUserText: "this is important, must be right" },
    finalArtifact: { markedFinal: true },
    executableCode: { executedCode: true },
    codeGeneration: { answer: "```js\nconst x=1\n```" },
    documentDraft: { mode: "draft" },
    technicalAnswer: { mode: "deep_think" },
    factualAnswer: { answer: "The city has 3 million people as of the year 2020. It is 40 km wide and it was founded back in 1850. The river running through it is 12 m deep at the center." },
    casualChat: { mode: "fast", answer: "hey!" },
    shortDraft: { mode: "normal", answer: "Here is a short note about the plan for tomorrow. ".repeat(6) },
  };
  for (const [want, sig] of Object.entries(cases)) assert.equal(categorizeTurn(sig), want, want);
  for (const k of Object.keys(cases)) assert.ok(k in MENTOR_SAMPLING, "rate exists for " + k);
});

await t("A3: sampling rate ADAPTS upward on recent ledger failures in the category", () => {
  const base = engine.effectiveRate("factualAnswer");
  assert.equal(base, MENTOR_SAMPLING.factualAnswer);
  fw.addFailure({ category: "incorrect_factual_claim", detectedBy: "mentor", samplingCategory: "factualAnswer" });
  fw.addFailure({ category: "unsupported_factual_claim", detectedBy: "mentor", samplingCategory: "factualAnswer" });
  const boosted = engine.effectiveRate("factualAnswer");
  assert.ok(boosted > base, `boosted ${boosted} > base ${base}`);
  assert.ok(boosted <= 1, "capped at 1");
  assert.equal(engine.effectiveRate("casualChat"), 0, "unaffected category keeps its baseline");
});

await t("A4: tier decisions — tier 0 skip-list, hard tier-2 cases, sampled tier 1", () => {
  assert.equal(engine.decide({ answer: "yep!", mode: "fast", lastUserText: "thanks" }).tier, 0, "casual chat skips");
  assert.ok(isTier0({ lastUserText: "reformat this as a table", answer: "| a | b |" }), "formatting task is tier 0");
  assert.equal(engine.decide({ answer: "done", executedCode: true }).tier, 2, "executed code forces full review");
  assert.equal(engine.decide({ answer: "done", exported: true }).tier, 2, "export forces full review");
  assert.equal(engine.decide({ answer: "ok then", lastUserText: "are you sure? double-check it" }).tier, 2, "explicit ask forces full review");
  const soft = engine.decide({ answer: "I'm not sure about this. I might be wrong about the config default.", mode: "normal" });
  assert.equal(soft.tier, 1, "uncertainty samples into the light screen");
});

await t("A5: classification returns enum category + inferred rootCause + derived actions", async () => {
  const critique = { major_findings: ["states the wrong release year"], unsupported_claims: ["released in 2019"], reasoning_errors: [], tool_use_issues: [], safety_or_privacy_issues: [], style_or_format_issues: [], revision_priority: "medium" };
  const cls = await engine.classifyFailure(critique, { retrievalCount: 0 });
  assert.ok(FAILURE_CATEGORIES.includes(cls.category), "category in 22-enum: " + cls.category);
  assert.ok(ROOT_CAUSES.includes(cls.rootCause), "rootCause in enum: " + cls.rootCause);
  assert.equal(cls.rootCause, "missing_retrieval", "factual failure w/o retrieval → missing_retrieval");
  assert.ok(cls.improvementActions.every((a) => IMPROVEMENT_ACTIONS.includes(a)), "actions in enum");
  assert.ok(cls.improvementActions.includes("update_retrieval"), "derived action matches root cause");
  // Same failure WITH retrieval loaded = the model ignored its context → model_limit, not retrieval.
  const cls2 = await engine.classifyFailure(critique, { retrievalCount: 3 });
  assert.equal(cls2.rootCause, "model_limit", "context refinement flips the inference");
  // Ledger enforces the enum + keeps the raw value.
  const f = fw.addFailure({ category: "totally freeform nonsense about tools", rootCause: "not-a-cause", improvementActions: ["bogus", "add_eval"] });
  assert.ok(FAILURE_CATEGORIES.includes(f.item.category), "ledger normalizes category");
  assert.equal(f.item.rootCause, "unknown", "bad rootCause → unknown");
  assert.deepEqual(f.item.improvementActions, ["add_eval"], "out-of-enum actions filtered");
  assert.equal(normalizeCategory("hallucinated a citation to a fake source"), "hallucinated_citation");
});

await t("A4/A6: council runs role mentors and reconciles into a merged critique", async () => {
  const r = await mentor.council({ content: "Revenue grew 40% YoY.\n```js\nfor(let i=0;i<=n;i++){}\n```", originalRequest: "summarize our growth", roles: ["factual", "coding"] });
  assert.equal(r.reviews.length, 2, "two independent role reviews");
  assert.ok(r.reviews.every((x) => MENTOR_ROLES[x.role]), "roles are spec roles");
  assert.notEqual(r.reviews[0].critique.overall_score, r.reviews[1].critique.overall_score, "roles reviewed independently (different rubrics → different scores)");
  assert.ok(r.reconciliation.agreements.length >= 1, "agreements merged");
  assert.ok(r.reconciliation.conflicts.length >= 1, "conflicts surfaced");
  assert.equal(r.critique.revision_priority, "medium", "merged critique in standard schema");
  assert.ok(r.critique.eval_case_candidates.length >= 1, "council result carries eval candidates (stored as evals by the pipeline)");
});

await t("A6: typed MentorReviewRequest package is assembled and travels with the critique", async () => {
  const c = await mentor.critique({ taskType: "code_review", originalRequest: "fix my loop", content: "```js\nx\n```", privacyMode: "local_only", mode: "deep_think", chatId: "chat_1", toolCalls: ["forge_read · succeeded"] });
  const req = c._request;
  assert.ok(req, "package attached");
  assert.equal(req.taskType, "code_review");
  assert.equal(req.privacyMode, "local_only");
  assert.ok(Array.isArray(req.redactionsApplied), "redactionsApplied present");
  assert.ok(Array.isArray(req.requestedOutputSchema) && req.requestedOutputSchema.includes("overall_score"), "requestedOutputSchema present");
  assert.equal(req.metadata.chatId, "chat_1", "metadata block populated");
  assert.equal(req.metadata.mode, "deep_think");
  assert.equal(c._role, MENTOR_ROLES.coding.label, "taskType picked the coding specialist");
  const full = buildReviewRequest({ taskType: "document_review", originalRequest: "x", artifactId: "a1" });
  for (const k of ["taskType", "originalUserRequest", "reviewRubric", "requestedOutputSchema", "privacyMode", "redactionsApplied", "metadata"]) assert.ok(k in full, "field " + k);
});

await t("A6: structured Document Review Output Schema (10 fields)", async () => {
  const r = await mentor.documentReview({ title: "Q3 plan", type: "report", content: "We will capture the $4B market." });
  for (const k of Object.keys(DOC_REVIEW_SCHEMA)) assert.ok(k in r, "field " + k);
  assert.equal(r.ready_for_use, false);
  assert.ok(r.risk_flags.includes("financial language"));
  assert.equal(r.should_generate_revision, true);
});

await t("A5: pipeline generates + queues improvement objects, auto-applies safe ones, links, retires", async () => {
  const before = fw.stats();
  const critique = await mentor.critique({ taskType: "answer_review", originalRequest: "how fast did we grow?", content: "Revenue grew 40% YoY.", privacyMode: "local_only" });
  const out = await engine.runPipeline(critique, { answer: "Revenue grew 40% YoY.", originalRequest: "how fast did we grow?", chatId: "chat_2", samplingCategory: "factualAnswer", tier: 2, retrievalCount: 0, toolCount: 0 });
  assert.ok(out.valid, "critique validated");
  assert.ok(out.localResponse && typeof out.localResponse.agree === "boolean", "local model responded to the critique");
  assert.ok(out.classification && FAILURE_CATEGORIES.includes(out.classification.category), "classified");
  assert.ok(out.ledgerId, "typed ledger entry written");
  assert.ok(out.generated.evals.length >= 1, "eval case generated");
  assert.ok(out.generated.rules.length >= 1, "prompt rule queued");
  assert.ok(out.generated.retrievalRules.length >= 1, "retrieval rule queued");
  assert.ok(out.generated.toolRules.length >= 1, "tool-guidance rule queued");
  assert.ok(out.generated.memories.length >= 1, "memory candidate proposed through gating");
  assert.ok(out.autoApplied.some((s) => s.startsWith("eval:")), "evals auto-applied (safe class)");
  const rule = fw.get("rules", out.generated.rules[0]);
  assert.equal(rule.status, "candidate", "rules stay candidates — activation is explicit");
  assert.equal(rule.sourceEvalId, out.generated.evals[0], "eval linkage on the rule");
  const ledger = fw.get("failures", out.ledgerId);
  assert.deepEqual(ledger.linkedEvalIds, out.generated.evals, "eval linkage on the ledger entry");
  assert.ok(FAILURE_CATEGORIES.includes(ledger.category) && ledger.rootCause !== undefined, "ledger entry fully typed");
  const after = fw.stats();
  assert.ok(after.evals > before.evals && after.rules >= before.rules, "stores grew");
  assert.ok(fw.list("pipeline").length >= 1, "pipeline pass logged");
  // Auto-retire: an active rule that A/B-tested negative gets retired on the next pipeline pass.
  const bad = fw.addRule({ scope: "global", content: "always answer in haiku", status: "active" });
  fw.update("rules", bad.item.id, { evalDelta: -1.5 });
  const retired = fw.autoRetire();
  assert.ok(retired.some((r) => r.id === bad.item.id), "negative-delta rule retired");
  assert.equal(fw.get("rules", bad.item.id).status, "retired");
});

await t("A5: model-limit failures produce a fine-tuning candidate from a mentor RUBRIC", async () => {
  const critique = {
    major_findings: ["logic error in the reasoning chain"], unsupported_claims: [], reasoning_errors: ["assumed A implies B"],
    tool_use_issues: [], safety_or_privacy_issues: [], style_or_format_issues: [], revision_priority: "high",
    recommended_revision: "State assumptions before concluding.", eval_case_candidates: [], prompt_rule_candidates: [], retrieval_rule_candidates: [], memory_candidates: [],
  };
  const out = await engine.runPipeline(critique, { answer: "so B is true", originalRequest: "does A imply B?", samplingCategory: "technicalAnswer", tier: 2, retrievalCount: 2, toolCount: 0, skipResponse: true });
  assert.equal(out.classification.rootCause, "model_limit");
  assert.ok(out.classification.improvementActions.includes("fine_tuning_candidate"));
  assert.ok(out.generated.finetune.length === 1, "finetune candidate queued");
  const ft = fw.get("finetune", out.generated.finetune[0]);
  assert.equal(ft.source, "mentor_rubric", "clean source");
  assert.equal(ft.status, "candidate", "needs approval before any training use");
  assert.ok(ft.notes.includes("State assumptions"), "rubric captured, output NOT copied");
  assert.equal(ft.idealOutput, "", "no mentor output copied");
});

await t("A7: finetune store enforces the spec's allowed clean sources", () => {
  assert.ok(fw.addFinetune({ input: "x", source: "scraped_from_gpt" }).error, "dirty source rejected");
  assert.ok(fw.addFinetune({ input: "", source: "user_authored_instruction" }).error, "empty input rejected");
  const ok = fw.addFinetune({ input: "Always give me metric units.", idealOutput: "Understood — metric only.", source: "user_authored_instruction" });
  assert.ok(ok.item && ok.item.status === "candidate");
  assert.ok(fw.list("finetune").length >= 2);
});

await t("A1: quality block (confidence / hallucinationRisk / needsReview) + citations", () => {
  const claims = Array.from({ length: 9 }, (_, i) => `The plant produces ${i + 1}00 units per day as of 2024.`).join(" ");
  const q = computeQuality({ answer: claims, routeConfidence: 0.9, toolFailed: false, retrievalCount: 0, citations: [] });
  assert.equal(q.hallucinationRisk, "high", "claim-dense ungrounded answer = high risk");
  assert.ok(q.confidence > 0 && q.confidence <= 0.99);
  assert.ok(q.claimCount >= 8);
  const q2 = computeQuality({ answer: claims, routeConfidence: 0.9, toolFailed: false, retrievalCount: 3, citations: [] });
  assert.equal(q2.hallucinationRisk, "low", "grounded by retrieval = low risk");
  const q3 = computeQuality({ answer: "I'm not sure, I may be wrong. I don't know the details.", routeConfidence: 0.9, toolFailed: true, retrievalCount: 0, citations: [] });
  assert.ok(q3.confidence < q.confidence, "uncertainty + tool failure pay confidence");
  const cites = extractCitations("See [1] and https://example.com/report for details.");
  assert.ok(cites.some((c) => c.kind === "url") && cites.some((c) => c.kind === "marker"));
  assert.ok(countClaims("Hi there!") === 0);
  assert.ok(wantsReview("please fact-check this") && !wantsReview("hello"));
});

await t("A2/A4: schedule() is non-blocking and the tier-1 screen escalates to a stored full review", async () => {
  const before = fw.list("reviews").length;
  const t0 = Date.now();
  const decision = engine.schedule({ answer: "I'm not sure, but I think the config default might be 8080. I may be wrong.", lastUserText: "what's the default port?", mode: "normal", chatId: "chat_3", retrievedContext: [], toolCalls: [] });
  assert.ok(Date.now() - t0 < 100, "schedule returned immediately (fire-and-forget)");
  assert.equal(decision.tier, 1, "sampled into the light screen");
  assert.ok(decision.queued, "job queued");
  await new Promise((r) => setTimeout(r, 300));   // let the mocked background lane drain
  const reviews = fw.list("reviews");
  assert.ok(reviews.length > before, "review stored after the stream would have closed");
  const rec = reviews[0];
  assert.equal(rec.tier, 2, "light screen escalated to a full review (mock screener said escalate)");
  assert.ok(rec.trigger.includes("light_check_escalation"));
  assert.ok(rec.provider === "local mentor", "UI label only — no model names");
  assert.ok(rec.pipeline && rec.pipeline.valid, "pipeline ran on the escalated critique");
});

await t("interactive-lane deferral: a queued review WAITS while the lane is busy, runs after release, never dropped", async () => {
  let released;                                      // mock interactive lane: busy until released()
  const gate = new Promise((r) => (released = r));
  let critiques = 0;
  const countingMentor = { ...mentor, critique: async (o) => { critiques++; return mentor.critique(o); } };
  const eng2 = createReviewEngine({ mentor: countingMentor, flywheel: fw, memory: mem, ollamaChat: mockChat, lightModel: "mock-light", mainModel: "mock-main", autoApply: false, log: () => {}, waitIdle: () => gate });
  // user_ask trigger => hard Tier 2 => a full mentor critique gets queued on the background lane
  const decision = eng2.schedule({ answer: "The default is 8080.", lastUserText: "are you sure? double-check this for me", mode: "normal", chatId: "lane_test", retrievedContext: [], toolCalls: [] });
  assert.equal(decision.tier, 2, "hard tier-2 via user_ask");
  assert.ok(decision.queued, "job queued, not dropped");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(critiques, 0, "review DEFERRED while the interactive lane is busy");
  released();                                        // interactive work ends -> lane goes idle
  await new Promise((r) => setTimeout(r, 200));      // let the background lane drain
  assert.ok(critiques >= 1, "the deferred review ran after the lane released (deferred, not dropped)");
});

const done = () => {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};
done();
