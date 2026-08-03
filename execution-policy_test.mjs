import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyTaskIntent,
  createTaskContract,
  evaluateCompletionEvidence, forgeFrameworkPrompt,
  executionManagerPrompt,
  mapExecutionPolicy,
  normalizeForgeTier,
  providerRequestOptions,
} from "./execution-policy.mjs";

test("classification follows explicit intent instead of prompt size or model choice", () => {
  assert.equal(classifyTaskIntent("Give me ten names for this section.").kind, "simple");
  assert.equal(classifyTaskIntent("Research the latest options and compare reliable sources.").kind, "research");
  assert.equal(classifyTaskIntent("Review the UI code thoroughly and diagnose why it stops. Do not change it yet.").kind, "audit");
  assert.equal(classifyTaskIntent("Audit the implementation, fix every confirmed issue, and run tests.").kind, "build");
  assert.equal(classifyTaskIntent("Make me a Word document from these notes.").kind, "build");

  const long = classifyTaskIntent("Fix the supervisor and keep working until the entire task is complete.");
  assert.equal(long.kind, "long-run");
  assert.equal(long.baseKind, "build");
  assert.ok(long.signals.includes("explicit-until-complete"));

  const longButUnspecified = classifyTaskIntent("x".repeat(20_000));
  assert.equal(longButUnspecified.kind, "simple", "length alone must not silently promote a request");
  assert.equal(longButUnspecified.explicit, false);
});

test("explicit read-only constraints do not become positive build intent", () => {
  const requests = [
    "Audit this repo and do not make any changes to the code.",
    "Review the UI code, but don't edit or modify any files.",
    "Inspect the implementation without changing the code.",
    "Diagnose the failure and make no changes; report findings only.",
    "Audit the repository before making changes.",
    "Please inspect the repo; never fix, patch, or edit anything.",
    "Review this repository and refrain from modifying its files.",
    "Analyze the code and avoid making any code changes.",
    "Do not create or write any files; audit the project only.",
    "Audit the feature, but do not code the implementation.",
    "Inspect the repository; there is no need to change anything.",
    "Review rather than modify the source.",
    "Under no circumstances edit the files; report findings only.",
    "Audit the feature and make sure not to change any code.",
  ];

  for (const request of requests) {
    const classified = classifyTaskIntent(request);
    assert.equal(classified.kind, "audit", request);
    assert.equal(classified.baseKind, "audit", request);
    assert.ok(classified.signals.includes("explicit-inspection"), request);
    assert.ok(!classified.signals.includes("explicit-change"), request);
  }

  const persistentAudit = classifyTaskIntent(
    "Audit the repository, do not make any code changes, and continue until the audit is complete.",
  );
  assert.equal(persistentAudit.kind, "long-run");
  assert.equal(persistentAudit.baseKind, "audit");
  assert.ok(!persistentAudit.signals.includes("explicit-change"));
});

test("repo scan and find-bugs language is treated as an audit even without the word audit", () => {
  const requests = [
    "Scan this repo for bugs; before changing anything, report what you find.",
    "Find bugs in this codebase without editing files.",
    "Check the project source for errors and report them.",
    "Examine these files for security issues; do not modify them.",
  ];
  for (const request of requests) {
    const classified = classifyTaskIntent(request);
    assert.equal(classified.kind, "audit", request);
    assert.equal(classified.baseKind, "audit", request);
    assert.ok(classified.signals.includes("explicit-inspection"), request);
    assert.ok(!classified.signals.includes("explicit-change"), request);
  }
});

test("a later explicit mutation survives an earlier read-only constraint", () => {
  const requests = [
    "Do not change X yet; inspect it, then fix Y.",
    "Audit without editing the generated file; then patch the parser.",
    "Review the repo first—do not modify vendor code—but fix the application bug.",
    "Before changing the schema, inspect it; afterward implement the migration.",
    "Don't edit the fixture yet. Inspect the failure, then repair the test.",
  ];

  for (const request of requests) {
    const classified = classifyTaskIntent(request);
    assert.equal(classified.kind, "build", request);
    assert.equal(classified.baseKind, "build", request);
    assert.ok(classified.signals.includes("explicit-change"), request);
  }
});

test("compact Forge overlays preserve the framework without crowding out task context", () => {
  const ember = forgeFrameworkPrompt("ember");
  const flame = forgeFrameworkPrompt("flame");
  const furnace = forgeFrameworkPrompt("furnace");
  assert.match(ember, /Seek what is true/i);
  assert.match(flame, /twelve governing checks/i);
  assert.match(furnace, /completion contract/i);
  assert.ok(ember.length < flame.length && flame.length < furnace.length);
  assert.ok(furnace.length < 4_000, "the full task prompt must not include the 48K source treatise");
});

test("Forge tier and authorization are durable parts of the task contract", () => {
  const suppliedAuthorization = {
    statement: "The named staging deployment is authorized.",
    grantedActions: ["push the current branch", "deploy to staging"],
    prohibitedActions: ["touch backup stores"],
  };
  const contract = createTaskContract({
    request: "Implement the feature, push it, and deploy it to staging.",
    forgeTier: "Furnace",
    authorization: suppliedAuthorization,
    acceptanceCriteria: ["tests pass", "staging health check passes"],
  });

  assert.equal(contract.forge.tier, "furnace");
  assert.equal(contract.task.kind, "build");
  assert.equal(contract.authorization.requestIsAuthority, true);
  assert.deepEqual(contract.authorization.grantedActions, ["push the current branch", "deploy to staging"]);
  assert.deepEqual(contract.authorization.prohibitedActions, ["touch backup stores"]);
  assert.deepEqual(contract.completion.acceptanceCriteria, ["tests pass", "staging health check passes"]);
  assert.ok(contract.completion.requiredEvidence.includes("criteria"));
  assert.equal(contract.cost.role, "advisory");
  assert.equal(Object.isFrozen(contract), true);

  suppliedAuthorization.grantedActions.push("unrelated production write");
  assert.deepEqual(contract.authorization.grantedActions, ["push the current branch", "deploy to staging"], "caller mutation cannot rewrite a live contract");
  assert.throws(() => normalizeForgeTier("wildfire"), /unknown Forge tier/);
});

test("long-run contracts retain the underlying work evidence bar", () => {
  const contract = createTaskContract({
    request: "Build the app and work on it until the end.",
    forgeTier: "flame",
  });
  assert.equal(contract.task.kind, "long-run");
  assert.equal(contract.task.baseKind, "build");
  for (const field of ["milestones", "changes", "validation", "remaining"]) {
    assert.ok(contract.completion.requiredEvidence.includes(field), field);
  }
});

test("tier plus task maps to neutral effort, verbosity, persistence, and advisory cost", () => {
  const emberBuild = createTaskContract({ request: "Fix the parser and run its tests.", forgeTier: "ember" });
  const emberPolicy = mapExecutionPolicy({
    contract: emberBuild,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    capabilities: { tools: true, reasoning: true, contextWindow: 1_000_000 },
  });
  assert.equal(emberPolicy.effort.level, "deep", "Ember must not make a real build shallow");
  assert.equal(emberPolicy.verbosity, "balanced");
  assert.equal(emberPolicy.persistence.mode, "execute-verify-and-repair");
  assert.equal(emberPolicy.cost.priority, "advisory");
  assert.equal(emberPolicy.cost.mayClaimCompletionBecauseBudgetEnded, false);
  assert.deepEqual(emberPolicy.providerOptions.request, {}, "no DeepSeek fields are guessed");

  const furnaceSimple = createTaskContract({ request: "Explain this function.", forgeTier: "furnace" });
  const furnacePolicy = mapExecutionPolicy({ contract: furnaceSimple });
  assert.equal(furnacePolicy.effort.level, "very-deep");
  assert.equal(furnacePolicy.verbosity, "thorough");
  assert.equal(furnacePolicy.persistence.checkpoint, true);
});

test("capability gaps are visible and prevent false autonomous completion", () => {
  const contract = createTaskContract({ request: "Implement the changes and run tests.", forgeTier: "flame" });
  const policy = mapExecutionPolicy({
    contract,
    provider: "some-provider",
    model: "chat-only-model",
    capabilities: { tools: false, reasoning: false },
  });
  assert.equal(policy.capabilities.canCompleteAutonomously, false);
  assert.ok(policy.limitations.some((item) => item.code === "required-tools-unavailable"));
  assert.ok(policy.limitations.some((item) => item.code === "native-reasoning-control-unavailable"));
  assert.deepEqual(policy.providerOptions.request, {});
});

test("GPT-5.6 adapter uses documented endpoint shapes and exposes tool incompatibility", () => {
  const responses = providerRequestOptions({
    provider: "openai",
    model: "openai/gpt-5.6-sol",
    endpoint: "responses",
    effortScore: 4,
    verbosity: "thorough",
  });
  assert.deepEqual(responses.request, {
    reasoning: { effort: "xhigh" },
    text: { verbosity: "high" },
  });
  assert.equal(responses.compatible, true);

  const chatTools = providerRequestOptions({
    provider: "openai",
    model: "gpt-5.6-sol",
    endpoint: "chat_completions",
    toolsAttached: true,
    effortScore: 5,
  });
  assert.deepEqual(chatTools.request, { reasoning_effort: "none" });
  assert.equal(chatTools.compatible, false);
  assert.equal(chatTools.meetsRequestedEffort, false);
  assert.match(chatTools.notes.join(" "), /use Responses for reasoning plus tools/i);

  const unknownProvider = providerRequestOptions({
    provider: "anthropic",
    model: "claude-opus",
    endpoint: "responses",
    effortScore: 5,
  });
  assert.deepEqual(unknownProvider.request, {});
  assert.match(unknownProvider.notes.join(" "), /no provider-specific request fields/i);
});

test("execution-manager prompt is concise, autonomous, evidence-gated, and cost-honest", () => {
  const contract = createTaskContract({
    request: "Fix the TypeScript errors, run all relevant tests, and continue until complete.",
    forgeTier: "furnace",
    authorization: {
      grantedActions: ["edit the scoped repository", "run tests"],
      prohibitedActions: ["touch backup stores"],
    },
    acceptanceCriteria: ["typecheck passes", "tests pass"],
  });
  const policy = mapExecutionPolicy({
    contract,
    provider: "openai",
    model: "gpt-5.6-sol",
    capabilities: { endpoint: "responses", tools: true, toolsAttached: true },
  });
  const prompt = executionManagerPrompt(contract, policy);

  assert.ok(prompt.length < 3_000, "execution manager must remain a compact contract: " + prompt.length);
  assert.match(prompt, /Use native judgment/i);
  assert.match(prompt, /Do not re-ask for already authorized/i);
  assert.match(prompt, /touch backup stores/i);
  assert.match(prompt, /truthful evidence/i);
  assert.match(prompt, /never imply an action or test ran when it did not/i);
  assert.match(prompt, /soft thresholds as advisory/i);
  assert.match(prompt, /paused and not complete/i);
  assert.doesNotMatch(prompt, /propose every modification|await the user's decision/i);
});

test("completion evidence blocks missing work, remaining work, and failed checks", () => {
  const contract = createTaskContract({
    request: "Fix the parser and run tests.",
    forgeTier: "flame",
    acceptanceCriteria: ["regression test passes"],
  });

  const missing = evaluateCompletionEvidence(contract, {
    status: "completed",
    changes: ["parser fixed"],
    remaining: [],
    criteria: [{ name: "regression test passes", status: "passed" }],
  });
  assert.equal(missing.canClaimComplete, false);
  assert.deepEqual(missing.missing, ["validation"]);

  const remaining = evaluateCompletionEvidence(contract, {
    status: "completed",
    changes: ["parser fixed"],
    validation: [{ name: "targeted tests", status: "passed" }],
    remaining: ["run the integration suite"],
    criteria: [{ name: "regression test passes", status: "passed" }],
  });
  assert.equal(remaining.canClaimComplete, false);
  assert.match(remaining.contradictions.join(" "), /remaining work/i);

  const failed = evaluateCompletionEvidence(contract, {
    status: "completed",
    changes: ["parser fixed"],
    validation: [{ name: "targeted tests", status: "failed" }],
    remaining: [],
    criteria: [{ name: "regression test passes", status: "failed" }],
  });
  assert.equal(failed.canClaimComplete, false);
  assert.match(failed.contradictions.join(" "), /validation/i);

  const complete = evaluateCompletionEvidence(contract, {
    status: "completed",
    changes: ["parser fixed", "regression test added"],
    validation: [{ name: "targeted tests", status: "passed" }],
    remaining: [],
    criteria: [{ name: "regression test passes", status: "passed" }],
  });
  assert.equal(complete.canClaimComplete, true);
  assert.equal(complete.status, "completed");

  const commonAlias = evaluateCompletionEvidence(contract, {
    status: "complete",
    changes: ["parser fixed", "regression test added"],
    validation: [{ name: "targeted tests", status: "passed" }],
    remaining: [],
    criteria: [{ name: "regression test passes", status: "passed" }],
  });
  assert.equal(commonAlias.canClaimComplete, true, "provider status alias should normalize to completed");
  assert.equal(commonAlias.status, "completed");

  const partialStatus = evaluateCompletionEvidence(contract, {
    status: "partial",
    changes: ["parser fixed", "regression test added"],
    validation: [{ name: "targeted tests", status: "passed" }],
    remaining: [],
    criteria: [{ name: "regression test passes", status: "passed" }],
  });
  assert.equal(partialStatus.canClaimComplete, false);
  assert.match(partialStatus.contradictions.join(" "), /status is partial/i,
    "a non-completed status must never produce a reasonless rejection");

  const invalidStatus = evaluateCompletionEvidence(contract, {
    status: "almost",
    changes: ["parser fixed"],
    validation: [{ name: "targeted tests", status: "passed" }],
    remaining: [],
    criteria: [{ name: "regression test passes", status: "passed" }],
  });
  assert.equal(invalidStatus.canClaimComplete, false);
  assert.match(invalidStatus.contradictions.join(" "), /status must be completed/i,
    "a status-only rejection must explain the real reason");
});
