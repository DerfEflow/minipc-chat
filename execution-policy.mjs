/*
 * Shared execution policy for Dominion chat and Crucible.
 *
 * This module is intentionally pure and integration-neutral. It turns the user's
 * explicit intent into a durable task contract, selects provider-neutral working
 * settings, produces a short execution-manager prompt, and gates completion on
 * evidence. Provider request fields live behind a narrow, documented adapter so
 * neutral policy never leaks guessed parameters into third-party APIs.
 */

export const TASK_CLASSES = Object.freeze(["simple", "research", "build", "audit", "long-run"]);
export const FORGE_TIERS = Object.freeze(["ember", "flame", "furnace"]);
export const DEFAULT_FORGE_TIER = "ember";
export const EXECUTION_CONTRACT_VERSION = 1;

const TASK_SET = new Set(TASK_CLASSES);
const FORGE_SET = new Set(FORGE_TIERS);

const INTENT_PATTERNS = Object.freeze({
  longRun: [
    /\b(?:work|keep working|continue|carry on|stay on (?:it|this)|do not stop|don't stop)\b[\s\S]{0,90}\b(?:until|through|to)\b[\s\S]{0,45}\b(?:done|complete|completed|completion|the end|finished)\b/i,
    /\b(?:finish|complete)\b[\s\S]{0,55}\b(?:end[- ]to[- ]end|all the way|entire task|everything|fully)\b/i,
    /\b(?:long[- ]running|long horizon|multi[- ]session|resume until complete|checkpoint and resume)\b/i,
  ],
  build: [
    /\b(?:build|implement|fix|patch|refactor|edit|modify|change|add|remove|rename|repair|commit|push|deploy|install|configure|migrate|upgrade)\b/i,
    /\b(?:code|code up)\b[\s\S]{0,35}\b(?:feature|app|site|module|component|project|implementation)\b/i,
    /\b(?:create|make|write|generate)\b[\s\S]{0,55}\b(?:app|site|file|code|module|feature|test|document|script|project|implementation|artifact)\b/i,
  ],
  audit: [
    /\b(?:audit|review|inspect|assess|evaluate|diagnose|debug|root[- ]cause|find(?:ing)?s)\b/i,
    /\b(?:what(?:'s| is) (?:wrong|broken)|why (?:does|is|did)|analy[sz]e)\b/i,
    /\b(?:scan|check|examine)\b[\s\S]{0,60}\b(?:repo(?:sitory)?|codebase|project|files?|source|code|bugs?|issues?|errors?|problems?)\b/i,
    /\bfind\b[\s\S]{0,45}\b(?:bugs?|issues?|errors?|problems?|vulnerabilit(?:y|ies))\b[\s\S]{0,45}\b(?:repo(?:sitory)?|codebase|project|files?|source|code)?/i,
  ],
  research: [
    /\b(?:research|browse|look up|search (?:the )?(?:web|internet)|investigate|gather sources|source[- ]check|fact[- ]check)\b/i,
    /\b(?:find|compare|verify)\b[\s\S]{0,45}\b(?:current|latest|recent|sources?|evidence|options?|products?|prices?|law|rules?)\b/i,
  ],
  simple: [
    /\b(?:answer|explain|define|summari[sz]e|translate|brainstorm|list|name|rewrite|format)\b/i,
    /\b(?:quick|brief|short|simple)\b[\s\S]{0,35}\b(?:answer|question|summary|explanation|list)\b/i,
  ],
});

const TIER_PROFILE = Object.freeze({
  ember: Object.freeze({
    minimumEffort: 0,
    minimumVerbosity: 0,
    direction: "Work directly and efficiently; completeness and evidence still apply.",
  }),
  flame: Object.freeze({
    minimumEffort: 2,
    minimumVerbosity: 1,
    direction: "Reason deliberately, check dependencies, and validate the result.",
  }),
  furnace: Object.freeze({
    minimumEffort: 4,
    minimumVerbosity: 2,
    direction: "Use maximum appropriate rigor, inspect the relevant scope, and repair failures before finishing.",
  }),
});

const TASK_PROFILE = Object.freeze({
  simple: Object.freeze({ effort: 0, verbosity: 0, persistence: "finish-current-result" }),
  research: Object.freeze({ effort: 2, verbosity: 1, persistence: "gather-verify-and-finish" }),
  build: Object.freeze({ effort: 3, verbosity: 1, persistence: "execute-verify-and-repair" }),
  audit: Object.freeze({ effort: 3, verbosity: 2, persistence: "inspect-evidence-and-report" }),
  "long-run": Object.freeze({ effort: 5, verbosity: 2, persistence: "checkpoint-resume-until-complete" }),
});

const EFFORT_LEVELS = Object.freeze(["light", "standard", "balanced", "deep", "very-deep", "maximum"]);
const VERBOSITY_LEVELS = Object.freeze(["concise", "balanced", "thorough"]);

const EVIDENCE_BY_TASK = Object.freeze({
  simple: Object.freeze(["status", "result", "remaining"]),
  research: Object.freeze(["status", "result", "sources", "remaining"]),
  build: Object.freeze(["status", "changes", "validation", "remaining"]),
  audit: Object.freeze(["status", "inspected", "findings", "remaining"]),
  "long-run": Object.freeze(["status", "milestones", "remaining"]),
});

function compactText(value, limit = Infinity) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}

function asStringList(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => compactText(item)).filter(Boolean);
}

function clonePlain(value, depth = 0) {
  if (value == null || typeof value !== "object") return value;
  if (depth > 12) throw new TypeError("task-contract values may not be nested more than 12 levels");
  if (Array.isArray(value)) return value.map((item) => clonePlain(item, depth + 1));
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = clonePlain(item, depth + 1);
  return copy;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function firstSignal(text, patterns, label) {
  for (const pattern of patterns) if (pattern.test(text)) return label;
  return "";
}

const MUTATION_ACTION = String.raw`(?:build(?:ing)?|implement(?:ing)?|fix(?:ing)?|patch(?:ing)?|refactor(?:ing)?|cod(?:e|ing)|edit(?:ing)?|modif(?:y|ying)|chang(?:e|ing)|add(?:ing)?|remov(?:e|ing)|renam(?:e|ing)|repair(?:ing)?|commit(?:ting)?|push(?:ing)?|deploy(?:ing)?|install(?:ing)?|configur(?:e|ing)|migrat(?:e|ing)|upgrad(?:e|ing)|creat(?:e|ing)|mak(?:e|ing)|writ(?:e|ing)|generat(?:e|ing)|alter(?:ing)?|delet(?:e|ing)|touch(?:ing)?)`;
const NEGATED_MUTATION_START = String.raw`(?:\b(?:(?:do|does|did|must|should|shall|will|would|can|could|may)\s+not|don['’]t|doesn['’]t|didn['’]t|mustn['’]t|shouldn['’]t|shan['’]t|won['’]t|wouldn['’]t|can['’]t|couldn['’]t|never)(?:\s+(?!(?:but|however|then|afterwards?|instead|except)\b)[\w'-]+){0,5}\s+${MUTATION_ACTION}\b|\bnot\s+(?:(?:allowed|authori[sz]ed|permitted|necessary|required)\s+to\s+|to\s+)?${MUTATION_ACTION}\b|\bno\s+need\s+to\s+${MUTATION_ACTION}\b|\b(?:under\s+no\s+circumstances|in\s+no\s+event)\s+${MUTATION_ACTION}\b|\b(?:without|before|rather\s+than|instead\s+of)\s+(?:\w+\s+){0,3}${MUTATION_ACTION}\b|\b(?:avoid(?:ing)?|refrain(?:ing)?\s+from)\s+(?:\w+\s+){0,3}${MUTATION_ACTION}\b|\b(?:make|apply|perform)\s+no\s+(?:\w+\s+){0,3}(?:changes?|edits?|modifications?|writes?)\b|\bno\s+(?:(?:code|source|file|repo(?:sitory)?|project)\s+)?(?:changes?|edits?|modifications?|writes?)\b)`;
const NEGATED_MUTATION_CLAUSE = new RegExp(
  String.raw`${NEGATED_MUTATION_START}[\s\S]*?(?=(?:[;!?](?=\s|$)|\.(?=\s|$)|[—–]|\b(?:but|however|then|afterwards?|instead|except)\b|$))`,
  "gi",
);

/*
 * Keep negative constraints from becoming positive build signals. Removing the
 * whole constrained clause matters for phrases such as "do not make any changes
 * to the code", where deleting only "do not make" would leave "change" behind.
 * Sequence/contrast pivots end the negative scope so "don't change X yet; inspect,
 * then fix Y" still exposes the genuinely requested fix.
 */
function mutationIntentText(text) {
  return text.replace(NEGATED_MUTATION_CLAUSE, " ");
}

export function normalizeForgeTier(value, fallback = DEFAULT_FORGE_TIER) {
  if (value == null || String(value).trim() === "") return fallback;
  const tier = String(value).trim().toLowerCase();
  if (!FORGE_SET.has(tier)) throw new RangeError(`unknown Forge tier: ${value}`);
  return tier;
}

/*
 * Classification is deliberately based on explicit verbs and persistence
 * language, not prompt length, model choice, price, or a hidden complexity score.
 * A long-run request also retains its underlying work kind for evidence rules.
 */
export function classifyTaskIntent(request) {
  const text = compactText(request);
  const actionText = mutationIntentText(text);
  const signals = [];
  const longSignal = firstSignal(text, INTENT_PATTERNS.longRun, "explicit-until-complete");
  const buildSignal = firstSignal(actionText, INTENT_PATTERNS.build, "explicit-change");
  const auditSignal = firstSignal(text, INTENT_PATTERNS.audit, "explicit-inspection");
  const researchSignal = firstSignal(text, INTENT_PATTERNS.research, "explicit-research");
  const simpleSignal = firstSignal(text, INTENT_PATTERNS.simple, "explicit-answer");

  for (const signal of [longSignal, buildSignal, auditSignal, researchSignal, simpleSignal]) {
    if (signal) signals.push(signal);
  }

  // Mutation wins over inspection when the user explicitly asks for both.
  const baseKind = buildSignal ? "build"
    : auditSignal ? "audit"
      : researchSignal ? "research"
        : "simple";
  const kind = longSignal ? "long-run" : baseKind;

  return deepFreeze({
    kind,
    baseKind,
    explicit: signals.length > 0,
    signals,
    rationale: longSignal
      ? `The user explicitly requested persistence; the underlying work is ${baseKind}.`
      : signals.length
        ? `The request explicitly indicates ${baseKind} work.`
        : "No explicit research, mutation, audit, or long-run intent was found; defaulted to a simple response.",
  });
}

export const classifyRequest = classifyTaskIntent;

function normalizeClassification(request, taskType) {
  const inferred = classifyTaskIntent(request);
  if (taskType == null || String(taskType).trim() === "") return inferred;
  const kind = String(taskType).trim().toLowerCase();
  if (!TASK_SET.has(kind)) throw new RangeError(`unknown task class: ${taskType}`);
  return deepFreeze({
    kind,
    baseKind: kind === "long-run" ? inferred.baseKind : kind,
    explicit: true,
    signals: ["caller-declared-task-class"],
    rationale: "The caller supplied the task class explicitly.",
  });
}

function requiredEvidenceFor(classification, acceptanceCriteria) {
  const fields = new Set(EVIDENCE_BY_TASK[classification.kind]);
  if (classification.kind === "long-run") {
    for (const field of EVIDENCE_BY_TASK[classification.baseKind]) fields.add(field);
  }
  if (acceptanceCriteria.length) fields.add("criteria");
  return [...fields];
}

function normalizeAuthorization(request, classification, authorization) {
  const supplied = typeof authorization === "string"
    ? { statement: compactText(authorization) }
    : clonePlain(authorization || {});

  const defaultActions = classification.baseKind === "build"
    ? ["inspect in-scope materials", "make explicitly requested in-scope changes", "run relevant non-destructive validation"]
    : classification.baseKind === "simple"
      ? ["produce the requested response"]
      : ["inspect the materials needed to answer the request"];

  return {
    source: "user",
    requestIsAuthority: true,
    rule: "The explicit request authorizes the actions it asks for within its stated scope; do not ask again for those actions.",
    defaultInScopeActions: defaultActions,
    grantedActions: asStringList(supplied.grantedActions || supplied.allowedActions),
    prohibitedActions: asStringList(supplied.prohibitedActions || supplied.deniedActions),
    confirmBefore: asStringList(supplied.confirmBefore || supplied.requiresConfirmation),
    userProvided: supplied,
    requestSnapshot: request,
  };
}

export function createTaskContract({
  request,
  taskType,
  forgeTier = DEFAULT_FORGE_TIER,
  authorization,
  acceptanceCriteria = [],
  constraints = [],
  requiredCapabilities,
  budget,
  taskId = null,
} = {}) {
  const requestText = String(request ?? "").trim();
  if (!requestText) throw new TypeError("a non-empty request is required");

  const classification = normalizeClassification(requestText, taskType);
  const tier = normalizeForgeTier(forgeTier);
  const criteria = asStringList(acceptanceCriteria);
  const needsTools = requiredCapabilities && Object.hasOwn(requiredCapabilities, "tools")
    ? requiredCapabilities.tools === true
    : classification.baseKind === "build";

  const contract = {
    version: EXECUTION_CONTRACT_VERSION,
    taskId: taskId == null ? null : String(taskId),
    request: requestText,
    objective: compactText(requestText, 1600),
    task: classification,
    forge: {
      tier,
      direction: TIER_PROFILE[tier].direction,
      invariant: "Forge raises process rigor; it never replaces native model judgment or lowers the completion bar.",
    },
    authorization: normalizeAuthorization(requestText, classification, authorization),
    constraints: asStringList(constraints),
    requirements: {
      tools: needsTools,
      ...clonePlain(requiredCapabilities || {}),
    },
    completion: {
      acceptanceCriteria: criteria,
      requiredEvidence: requiredEvidenceFor(classification, criteria),
      allowSilentPartial: false,
      rule: "Completion may be claimed only when the requested scope is done and the required evidence is present.",
    },
    cost: {
      role: "advisory",
      mayReduceScopeSilently: false,
      mayMarkIncompleteWorkComplete: false,
      softLimit: budget && budget.softLimit != null ? budget.softLimit : null,
      hardLimit: budget && budget.hardLimit != null ? budget.hardLimit : null,
      hardLimitBehavior: "checkpoint-and-report-paused-not-complete",
    },
  };
  return deepFreeze(contract);
}

function capabilityBoolean(capabilities, ...names) {
  for (const name of names) if (typeof capabilities[name] === "boolean") return capabilities[name];
  return null;
}

function openAIEffortFor(score) {
  // GPT-5.6's native default is medium. Ember/simple work preserves that baseline instead of
  // Dominion quietly downgrading the selected model to low effort.
  if (score <= 2) return "medium";
  if (score === 3) return "high";
  if (score === 4) return "xhigh";
  return "max";
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "responses" || value === "responses_api") return "responses";
  if (value === "chat" || value === "chat_completions" || value === "chatcompletions") return "chat_completions";
  return "";
}

/*
 * Documented provider adapter.
 *
 * GPT-5.6 supports none/low/medium/high/xhigh/max and defaults to medium.
 * Responses expresses effort as reasoning.effort and verbosity as
 * text.verbosity. Chat Completions expresses effort as reasoning_effort, and
 * function tools there require effective effort "none". No fields are emitted
 * for any other provider/model: those adapters must declare their own support.
 */
export function providerRequestOptions({
  provider,
  model,
  endpoint,
  toolsAttached = false,
  effortScore = 0,
  verbosity = "balanced",
} = {}) {
  const providerName = String(provider || "").toLowerCase();
  const modelName = String(model || "").toLowerCase().replace(/^openai\//, "");
  const api = normalizeEndpoint(endpoint);
  const desiredEffort = openAIEffortFor(effortScore);
  const result = {
    provider: providerName,
    model: String(model || ""),
    endpoint: api,
    request: {},
    desiredEffort,
    compatible: true,
    meetsRequestedEffort: true,
    notes: [],
  };

  if (providerName !== "openai" || !/^gpt-5\.6(?:-|$)/.test(modelName)) {
    result.notes.push("No provider-specific request fields emitted; apply the neutral policy through the execution prompt.");
    return deepFreeze(result);
  }

  if (api === "responses") {
    result.request = {
      reasoning: { effort: desiredEffort },
      text: { verbosity: verbosity === "concise" ? "low" : verbosity === "thorough" ? "high" : "medium" },
    };
    return deepFreeze(result);
  }

  if (api === "chat_completions") {
    if (toolsAttached) {
      result.request = { reasoning_effort: "none" };
      result.compatible = desiredEffort === "none";
      result.meetsRequestedEffort = false;
      result.notes.push("GPT-5.6 Chat Completions function tools require reasoning_effort none; use Responses for reasoning plus tools.");
    } else {
      result.request = { reasoning_effort: desiredEffort };
    }
    return deepFreeze(result);
  }

  result.compatible = false;
  result.meetsRequestedEffort = false;
  result.notes.push("An OpenAI endpoint must be declared before request fields can be selected safely.");
  return deepFreeze(result);
}

export function mapExecutionPolicy({
  contract,
  provider = "",
  model = "",
  capabilities = {},
} = {}) {
  if (!contract || contract.version !== EXECUTION_CONTRACT_VERSION) {
    throw new TypeError("a current execution task contract is required");
  }

  const taskProfile = TASK_PROFILE[contract.task.kind];
  const tierProfile = TIER_PROFILE[contract.forge.tier];
  const effortScore = Math.max(taskProfile.effort, tierProfile.minimumEffort);
  const verbosityScore = Math.max(taskProfile.verbosity, tierProfile.minimumVerbosity);
  const tools = capabilityBoolean(capabilities, "tools", "toolCapable", "supportsTools", "supportsToolCalls");
  const limitations = [];

  if (contract.requirements.tools && tools === false) {
    limitations.push({
      code: "required-tools-unavailable",
      message: "This task requires tools, but the selected model cannot call them. Handoff or enable tools; do not claim completion.",
    });
  }
  if (capabilityBoolean(capabilities, "reasoning", "supportsReasoning") === false && effortScore >= 3) {
    limitations.push({
      code: "native-reasoning-control-unavailable",
      message: "The requested rigor must be expressed through the prompt because the model exposes no native reasoning control.",
    });
  }

  const contextWindow = Number(capabilities.contextWindow || capabilities.contextTokens || 0);
  const checkpoint = contract.task.kind === "long-run"
    || contract.forge.tier === "furnace"
    || (Number.isFinite(contextWindow) && contextWindow > 0 && contextWindow < 64_000);
  const verbosity = VERBOSITY_LEVELS[verbosityScore];
  const toolsAttached = capabilities.toolsAttached === true;
  const endpoint = capabilities.endpoint || "";
  const providerOptions = providerRequestOptions({
    provider,
    model,
    endpoint,
    toolsAttached,
    effortScore,
    verbosity,
  });
  if (!providerOptions.compatible) {
    limitations.push({
      code: "provider-route-cannot-meet-effort",
      message: providerOptions.notes.join(" "),
    });
  }

  const policy = {
    contractVersion: contract.version,
    taskKind: contract.task.kind,
    workKind: contract.task.baseKind,
    forgeTier: contract.forge.tier,
    effort: {
      score: effortScore,
      level: EFFORT_LEVELS[effortScore],
      providerNeutral: true,
    },
    verbosity,
    persistence: {
      mode: taskProfile.persistence,
      continueThroughRecoverableFailures: contract.task.kind !== "simple" || contract.forge.tier !== "ember",
      changeApproachAfterRepeatedFailure: true,
      checkpoint,
      stopOnlyFor: ["verified completion", "actual unrecoverable blocker", "user cancellation", "hard platform or user limit"],
    },
    completion: {
      evidenceRequired: true,
      requiredEvidence: [...contract.completion.requiredEvidence],
      partialMustBeReported: true,
    },
    cost: {
      priority: "advisory",
      actionAtSoftLimit: "warn-and-continue-within-user-authorized-scope",
      actionAtHardLimit: contract.cost.hardLimitBehavior,
      mayClaimCompletionBecauseBudgetEnded: false,
    },
    capabilities: {
      tools,
      contextWindow: contextWindow || null,
      canCompleteAutonomously: limitations.every((item) => item.code !== "required-tools-unavailable"),
    },
    providerOptions,
    limitations,
  };
  return deepFreeze(policy);
}

function promptList(items, emptyText, limit = 5) {
  if (!items || !items.length) return emptyText;
  return items.slice(0, limit).map((item) => compactText(item, 180)).join("; ");
}

export function executionManagerPrompt(contract, policy = mapExecutionPolicy({ contract })) {
  if (!contract || !policy) throw new TypeError("contract and policy are required");
  const auth = contract.authorization;
  const criteria = promptList(contract.completion.acceptanceCriteria, "the requested outcome plus the evidence gate");
  const prohibited = promptList(auth.prohibitedActions, "the user's stated constraints and higher-level platform limits");
  const confirmations = promptList(auth.confirmBefore, "only actions outside or materially expanding the authorized scope");

  return [
    "EXECUTION MANAGER",
    `Task: ${contract.task.kind}${contract.task.kind === "long-run" ? ` (${contract.task.baseKind})` : ""}. Forge: ${contract.forge.tier}.`,
    `Goal: ${compactText(contract.objective, 900)}`,
    `Method: Use native judgment at ${policy.effort.level} effort. ${contract.forge.direction}`,
    `Authorization: The user's explicit request authorizes the in-scope actions it names. Do not re-ask for already authorized reads, edits, tests, or named actions. Preserve prohibitions: ${prohibited}. Ask only before: ${confirmations}. Never widen scope silently.`,
    `Persistence: ${policy.persistence.mode}. After a recoverable failure, diagnose it, change approach when useful, and continue. Checkpoint before context or hard limits. Never silently omit requested work.`,
    `Success: ${criteria}. Before claiming completion, provide truthful evidence for: ${contract.completion.requiredEvidence.join(", ")}. Report exact checks and outcomes; never imply an action or test ran when it did not. If anything remains, label the task partial or blocked and state the next resumable action.`,
    "Cost: Treat estimates and soft thresholds as advisory. Warn clearly, but do not reduce scope, lower correctness, or declare completion to save money. At an actual hard limit, checkpoint and report paused—not complete.",
  ].join("\n");
}

/*
 * Compact Wolfe Logic overlay. The former Furnace prompt repeated the full source framework on
 * every model round (roughly 48K characters), crowding out the user's files and native reasoning.
 * This preserves the governing process as a manager's specification, while leaving the selected
 * model room to use its own intelligence.
 */
export function forgeFrameworkPrompt(value = DEFAULT_FORGE_TIER) {
  const tier = normalizeForgeTier(value);
  const core = [
    "FORGE PROCESS (Wolfe Logic, compact):",
    "Seek what is true before what is agreeable. Separate observed fact, report, inference, assumption, preference, prediction, and unknown.",
    "Define controlling terms, identify the mechanism beneath symptoms, inspect dependencies and incentives, and test important claims where they can fail.",
    "Turn understanding into concrete action and verification. Record what changed or was learned. Do not let analysis replace execution.",
  ];
  if (tier === "ember") return core.join("\n");

  core.push(
    "FLAME PASS: Apply the twelve governing checks: truth over consensus; ordered authority; definitions control conclusions; contradictions expose mechanisms; dwell past the obvious reading; experience is evidence, not a throne; theory must meet reality; seek the person's genuine good; confess and correct errors specifically; make value visible; treat cost as a constraint rather than the purpose; transfer durable structure.",
    "Use the relevant engines: truth/evidence, logic, qualification, forensics, systems, pattern, builder, practical engineering, economics, communication, and forward action. Check scale, abuse, ordinary-user behavior, failure modes, and downstream effects.",
  );
  if (tier === "flame") return core.join("\n");

  core.push(
    "FURNACE PASS: State the actual object, desired end, hard constraints, facts and unknowns. Decompose the system. Generate competing explanations. Stress-test the preferred one. Inspect the full authorized scope, run the smallest meaningful proof, repair failed checks, and repeat until the completion contract is satisfied or a real blocker is evidenced.",
    "Guard against breadth without sequence, elegant plans without implementation, premature certainty, repeated methods after no progress, and calling a checkpoint completion. Preserve the whole vision while executing in dependency order.",
  );
  return core.join("\n");
}

function hasEvidenceValue(field, value) {
  if (field === "remaining" || field === "blockers") return Array.isArray(value);
  if (field === "status") return ["completed", "partial", "blocked", "paused"].includes(String(value || "").toLowerCase());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return compactText(value).length > 0;
}

function listHasItems(value) {
  if (Array.isArray(value)) return value.length > 0;
  return compactText(value).length > 0;
}

function validationFailures(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const status = String(entry.status || entry.outcome || "").toLowerCase().replace(/[\s-]+/g, "_");
    return ["failed", "failure", "error", "not_run", "unknown", "timed_out"].includes(status);
  });
}

export function evaluateCompletionEvidence(contract, evidence = {}) {
  if (!contract || contract.version !== EXECUTION_CONTRACT_VERSION) {
    throw new TypeError("a current execution task contract is required");
  }
  const required = contract.completion.requiredEvidence;
  const missing = required.filter((field) => !Object.hasOwn(evidence, field) || !hasEvidenceValue(field, evidence[field]));
  const contradictions = [];
  const status = String(evidence.status || "").toLowerCase();

  if (status === "completed" && listHasItems(evidence.remaining)) {
    contradictions.push("status is completed but remaining work is listed");
  }
  if (status === "completed" && listHasItems(evidence.blockers)) {
    contradictions.push("status is completed but blockers are listed");
  }
  const failedChecks = validationFailures(evidence.validation);
  if (status === "completed" && failedChecks.length) {
    contradictions.push("status is completed but validation contains failed, missing, or unknown checks");
  }

  const canClaimComplete = status === "completed" && missing.length === 0 && contradictions.length === 0;
  return deepFreeze({
    canClaimComplete,
    status: canClaimComplete ? "completed" : status || "unverified",
    missing,
    contradictions,
    required: [...required],
    instruction: canClaimComplete
      ? "Completion evidence satisfies the contract."
      : "Do not claim completion; continue, or report a truthful partial/blocked state with a resumable next action.",
  });
}
