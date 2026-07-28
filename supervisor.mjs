/*
 * Dominion AI completion supervisor.
 *
 * The worker keeps its native reasoning and owns execution. The supervisor manages process:
 * acceptance evidence, the task ledger, recovery, checkpoints, and the narrow distinction between
 * verified completion and an unfinished pause. Cost conservation is not a completion signal.
 *
 * Deterministic evidence produces advisory decisions:
 *   - repeated or ineffective actions -> retry with a different strategy/tool/model;
 *   - context pressure -> durable checkpoint_context and automatic resumability;
 *   - actually exhausted enforced budget -> paused_budget and resumability;
 *   - finite emergency fuse -> checkpoint/retry, never a claim of completion.
 * COMPLETE requires verified acceptance criteria. GENUINELY_BLOCKED requires a specific external
 * dependency after reasonable recoveries are exhausted. Unreadable supervisor output defaults to
 * CONTINUE so the supervisor cannot end useful work on its own parse failure.
 */

import { approxMessageTokens } from "./contextwindow.mjs";

export const SUP_CHECK_EVERY = 8;     // supervisor verdict cadence (rounds)
export const SUP_HARD_CAP = 64;       // runaway insurance, not a work limit
export const SUP_CTX_FRACTION = 0.75; // checkpoint when the prompt passes 75% of the window
const SIG_LIMIT = 3;                  // identical tool call this many times = loop
const NO_PROGRESS_LIMIT = 2;          // two mutation attempts on one target with no byte delta = stall

export const SUPERVISOR_DECISIONS = Object.freeze([
  "complete",
  "continue",
  "checkpoint_context",
  "paused_budget",
  "retry",
  "genuinely_blocked",
]);
export const SUP_DECISIONS = SUPERVISOR_DECISIONS;
export const SUPERVISOR_DECISION = Object.freeze({
  COMPLETE: "complete",
  CONTINUE: "continue",
  CHECKPOINT_CONTEXT: "checkpoint_context",
  PAUSED_BUDGET: "paused_budget",
  RETRY: "retry",
  GENUINELY_BLOCKED: "genuinely_blocked",
});

const shortText = (value, max = 240) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const validDecision = (value) => SUPERVISOR_DECISIONS.includes(String(value || "").toLowerCase());

export function decisionResult(decision = "continue", {
  reason = "",
  nextAction = "",
  unmetCriteria = [],
  checkpoint = false,
  emergency = false,
  ...evidence
} = {}) {
  const normalized = validDecision(decision) ? String(decision).toLowerCase() : "continue";
  const shouldContinue = normalized === "continue" || normalized === "retry";
  const complete = normalized === "complete";
  const genuinelyBlocked = normalized === "genuinely_blocked";
  return {
    ...evidence,
    decision: normalized,
    reason: shortText(reason) || (normalized === "continue" ? "work can continue" : normalized.replace(/_/g, " ")),
    nextAction: shortText(nextAction),
    unmetCriteria: (Array.isArray(unmetCriteria) ? unmetCriteria : [unmetCriteria])
      .map((item) => shortText(item, 180)).filter(Boolean).slice(0, 12),
    // `progressing` remains for older callers. It means "keep the worker running", so a retry is
    // intentionally true; new callers should branch on `decision`.
    progressing: shouldContinue,
    shouldContinue,
    shouldPause: normalized === "checkpoint_context" || normalized === "paused_budget" || genuinelyBlocked,
    complete,
    terminal: complete || genuinelyBlocked,
    checkpoint: checkpoint || normalized === "checkpoint_context" || normalized === "paused_budget",
    emergency: !!emergency,
  };
}

// Deterministic evidence has priority over a fuzzy model verdict. A repeated action, transient
// provider/tool failure, or emergency fuse is recoverable and therefore RETRY, never "complete" or
// "blocked". Only explicit, verified acceptance evidence may produce COMPLETE.
export function supervisorDecision(evidence = {}) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const unmetCriteria = (Array.isArray(e.unmetCriteria) ? e.unmetCriteria : [e.unmetCriteria])
    .map((item) => shortText(item, 180)).filter(Boolean);
  const ledger = Array.isArray(e.taskLedger) ? e.taskLedger : (Array.isArray(e.ledger) ? e.ledger : []);
  const pendingLedger = ledger.some((item) => {
    if (!item || typeof item !== "object") return false;
    return /^(?:pending|remaining|in[_ -]?progress|blocked|todo|open|failed)$/i.test(String(item.status || ""));
  });
  const completionClaimed = e.verifiedComplete === true || e.acceptanceComplete === true ||
    e.criteriaSatisfied === true;
  const verifiedComplete = completionClaimed && unmetCriteria.length === 0 && !pendingLedger;
  const contextThresholdReached = e.contextThresholdReached === true || e.contextExceeded === true;
  const budgetExhausted = e.budgetExhausted === true || e.budgetRemaining === 0 ||
    (typeof e.budgetRemaining === "number" && e.budgetRemaining < 0);
  const repeated = e.repeatedToolCall === true || e.repeatedAction === true || e.looping === true;
  const recoverable = repeated || e.transientFailure === true || e.recoveryAvailable === true;
  const emergency = e.emergencyProtectionReached === true || e.hardFuseReached === true;
  const blocked = e.genuinelyBlocked === true || e.externalBlocker === true;

  if (verifiedComplete) {
    return decisionResult("complete", {
      reason: e.reason || "all acceptance criteria are verified",
      nextAction: e.nextAction || "deliver the verified final result",
      unmetCriteria: [],
    });
  }
  if (contextThresholdReached) {
    return decisionResult("checkpoint_context", {
      reason: e.reason || "context headroom reached the checkpoint threshold",
      nextAction: e.nextAction || "save a durable task ledger and resume in a fresh context",
      unmetCriteria,
    });
  }
  if (budgetExhausted) {
    return decisionResult("paused_budget", {
      reason: e.reason || "the enforced session budget is exhausted",
      nextAction: e.nextAction || "preserve the checkpoint and resume when budget is available",
      unmetCriteria,
    });
  }
  if (recoverable || emergency) {
    return decisionResult("retry", {
      reason: e.reason || (emergency
        ? "finite emergency protection fired before completion"
        : "the current approach stalled but a recovery path remains"),
      nextAction: e.nextAction || (emergency
        ? "checkpoint the exact state and resume with a fresh supervised attempt"
        : "inspect the failure, change strategy or tool, and retry"),
      unmetCriteria,
      checkpoint: emergency,
      emergency,
      recoveryRecommended: true,
    });
  }
  if (blocked) {
    return decisionResult("genuinely_blocked", {
      reason: e.reason || "a specific external dependency prevents further safe progress",
      nextAction: e.nextAction || "state the missing input, authority, or external change required",
      unmetCriteria,
    });
  }
  return decisionResult("continue", {
    reason: e.reason || (completionClaimed
      ? "completion was claimed but supplied evidence still shows unfinished work"
      : "acceptance criteria remain and a concrete next action is available"),
    nextAction: e.nextAction || "perform the next ledger item and verify its result",
    unmetCriteria,
  });
}

export const evaluateSupervisorEvidence = supervisorDecision;

// The cap is finite emergency insurance. Reaching it requests a recoverable checkpoint/retry and
// explicitly does not certify completion.
export function emergencyDecision({ rounds = 0, hardCap = SUP_HARD_CAP } = {}) {
  const cap = Math.max(1, Number(hardCap) || SUP_HARD_CAP);
  const reached = Number(rounds) >= cap;
  return supervisorDecision({
    emergencyProtectionReached: reached,
    reason: reached ? `finite emergency protection reached at ${cap} rounds` : "",
    nextAction: reached ? "checkpoint unfinished work and resume with a fresh supervised attempt" : "",
  });
}

// A short continuation message is control input, not a new goal. Recover the most recent
// substantive user instruction so routing, tool selection, retrieval, and the supervisor all keep
// seeing the unfinished job after a budget top-up or manual pause.
const CONTINUATION_ONLY_RE = /^\s*(?:(?:please\s+)?(?:continue|resume|proceed|keep\s+going|carry\s+on)|(?:continue|resume)\s+(?:the|this|that|from\s+where\s+you\s+left\s+off|exactly\s+where\s+you\s+left\s+off)|continue\s+the\s+unfinished\s+work\s+from\s+the\s+prior\s+run\s+now\..*|finish(?:\s+(?:it|this|that|the\s+(?:task|job|work)))?|(?:please\s+)?(?:work|keep\s+working)(?:\s+on\s+(?:it|this|that))?\s+(?:until|to)\s+(?:(?:it\s+is|it['’]s)\s+)?(?:the\s+)?(?:end|done|complete|completed|completion|finished)|(?:please\s+)?(?:(?:do\s+not|don['’]?t|never)\s+)(?:stop|pause|quit)(?:\s+working)?\s+until\s+(?:(?:it\s+is|it['’]s)\s+)?(?:the\s+)?(?:end|done|complete|completed|completion|finished))(?:\s*,?\s*please)?\s*[.!]*\s*$/i;
export function continuationContext(messages = [], lastUserText = "") {
  const current = String(lastUserText || "").trim();
  if (!CONTINUATION_ONLY_RE.test(current)) {
    return { requested: false, goal: current, intentText: current };
  }
  const prior = [...messages].reverse().find((m) =>
    m && m.role === "user" &&
    String(m.content || "").trim() &&
    String(m.content || "").trim() !== current &&
    !CONTINUATION_ONLY_RE.test(String(m.content || "").trim()));
  const goal = prior ? String(prior.content || "").trim() : current;
  return {
    requested: true,
    goal,
    intentText: goal === current ? current : `${goal}\n\nContinuation instruction: ${current}`,
  };
}

export function emptyResponseInstruction({ toolsAvailable = false, concludePhase = false, attempt = 1 } = {}) {
  if (toolsAvailable && !concludePhase) {
    return "[Dominion supervisor notice — not Fred] Your last response contained internal reasoning " +
      "but no visible answer and no tool call. Resume the unfinished work NOW. If work remains, call " +
      "the appropriate tool immediately; do not describe your plan or repeat what remains. If the " +
      "task is complete, provide the final answer with verified results. Recovery attempt " + attempt + ".";
  }
  return "[Dominion supervisor notice — not Fred] Your last response contained no visible answer. " +
    "Tool work is paused. Write the required visible user report now as plain text: what was " +
    "accomplished, what remains, and why the run paused. Do not output internal reasoning. " +
    "Recovery attempt " + attempt + ".";
}

export function reasoningOnlyPause({ model = "", attempts = 0, hadReasoning = false } = {}) {
  return "[Dominion supervisor] Paused because " + (model || "the selected model") +
    (hadReasoning ? " returned internal reasoning" : " returned no visible response") +
    " without a visible answer or tool action after " + attempts + " recovery attempts. " +
    "No additional work was verified in this continuation. Earlier progress is saved; continue " +
    "again or choose another coding model.";
}

// Detect a model looping inside ONE answer. Tool/round supervision cannot see this shape because
// the provider is still producing a single completion. Six consecutive copies is far beyond
// legitimate rhetorical repetition; cut at the third copy so the user gets enough context to
// recognize what happened without receiving pages of it.
export function textLoopEvidence(text, minRepeats = 6) {
  const rows = [];
  const re = /[^\r\n]+/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const normalized = m[0].trim().replace(/\s+/g, " ").toLowerCase();
    if (normalized.length >= 16) rows.push({ normalized, at: m.index, raw: m[0].trim() });
  }
  let prior = "", run = 0, thirdAt = 0;
  for (const row of rows) {
    if (row.normalized === prior) run++;
    else { prior = row.normalized; run = 1; thirdAt = 0; }
    if (run === 3) thirdAt = row.at;
    if (run >= minRepeats) return {
      looping: true,
      phrase: row.raw.slice(0, 160),
      repeats: run,
      cutAt: thirdAt || row.at,
      ...supervisorDecision({
        repeatedAction: true,
        reason: "the current answer is repeating text instead of advancing",
        nextAction: "stop this completion, preserve prior progress, and retry with a different strategy",
      }),
    };
  }
  return { looping: false, ...supervisorDecision() };
}

const normalizedTarget = (name, args = {}) => {
  if (args.path) return String(args.path).replace(/\\/g, "/").toLowerCase();
  if (name !== "forge_run") return "";
  const command = String(args.command || "");
  const quoted = [...command.matchAll(/["']([^"']+\.[a-z0-9_-]{1,12})["']/ig)].map((m) => m[1]);
  const bare = command.match(/(?:[a-z]:[\\/]|\.{0,2}[\\/])[^;\r\n|]+?\.[a-z0-9_-]{1,12}\b/i);
  return String(quoted[0] || (bare && bare[0]) || "").trim().replace(/\\/g, "/").toLowerCase();
};
const isMutationAttempt = (name, args = {}) => {
  if (name === "forge_write" || name === "forge_edit") return true;
  if (name !== "forge_run") return false;
  return /\b(set-content|out-file|add-content|copy-item|move-item|rename-item|remove-item|new-item|sed\s+-i|perl\s+-pi|python(?:3)?\s+-c)\b|(?:^|\s)(?:>>?|2>)\s*\S/i.test(String(args.command || ""));
};

// Exit zero is execution success, not mutation success: only the explicit change marker proves
// that bytes moved.
export function summarizeToolOutcome({ name = "?", args = {}, result = "", failed = false } = {}) {
  const text = String(result || "");
  const target = normalizedTarget(name, args);
  const mutation = isMutationAttempt(name, args);
  const changed = mutation
    ? (/^(?:CHANGED:)|\nCHANGE:/m.test(text) ? true
      : /^(?:NO CHANGE:|EDIT REFUSED)|\nNO TRACKED CHANGE:/m.test(text) || failed ? false : null)
    : null;
  const outcome = failed ? "failed"
    : changed === true ? "changed bytes"
    : changed === false ? "no byte change"
    : "completed";
  return {
    summary: `${name} · ${outcome}${target ? ` · ${target}` : ""}`,
    mutation, changed, target,
  };
}

// Deterministic loop detector: catches both identical calls and semantically equivalent mutation
// attempts whose arguments vary but whose target never changes.
export function createLoopWatch() {
  const counts = new Map();
  const stalledTargets = new Map();
  return {
    note(calls) {
      for (const c of Array.isArray(calls) ? calls : []) {
        const fn = c && c.function || {};
        const sig = (fn.name || "?") + "|" + (typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}));
        const n = (counts.get(sig) || 0) + 1;
        counts.set(sig, n);
        if (n >= SIG_LIMIT) {
          const label = (fn.name || "?") + " with identical arguments";
          return {
            looping: true,
            repeated: true,
            sig: label,
            count: n,
            recovery: "Inspect the actual result, change arguments or tools, and escalate the approach if needed.",
            ...supervisorDecision({
              repeatedToolCall: true,
              reason: `repeated ${label}`,
              nextAction: "inspect the result, choose a materially different recovery, and retry",
            }),
          };
        }
      }
      return { looping: false, repeated: false, ...supervisorDecision() };
    },
    outcome(event) {
      const evidence = summarizeToolOutcome(event);
      if (!evidence.mutation || !evidence.target) {
        return { looping: false, ...evidence, ...supervisorDecision() };
      }
      if (evidence.changed === true) {
        stalledTargets.delete(evidence.target);
        return { looping: false, ...evidence, ...supervisorDecision() };
      }
      if (evidence.changed !== false) {
        return { looping: false, ...evidence, ...supervisorDecision() };
      }
      const n = (stalledTargets.get(evidence.target) || 0) + 1;
      stalledTargets.set(evidence.target, n);
      const looping = n >= NO_PROGRESS_LIMIT;
      const advice = looping
        ? supervisorDecision({
          repeatedToolCall: true,
          reason: `${n} mutation attempts changed no bytes in ${evidence.target}`,
          nextAction: "read the exact file state and error, then use a different edit method or tool",
        })
        : supervisorDecision();
      return {
        looping,
        repeated: looping,
        sig: `${n} mutation attempts changed no bytes in ${evidence.target}`,
        ...evidence,
        ...advice,
      };
    },
  };
}

// Context pressure is a checkpoint boundary, never evidence that the task is complete.
export function contextDecision({ messages = [], ctx = 128000, fraction = SUP_CTX_FRACTION } = {}) {
  const estimatedTokens = messages.reduce((total, message) => total + approxMessageTokens(message), 0);
  const thresholdTokens = Math.floor(ctx * fraction);
  const exceeded = estimatedTokens > thresholdTokens;
  return {
    exceeded,
    estimatedTokens,
    thresholdTokens,
    contextWindow: ctx,
    fraction,
    ...supervisorDecision({
      contextThresholdReached: exceeded,
      reason: exceeded
        ? `estimated context use ${estimatedTokens} exceeded checkpoint threshold ${thresholdTokens}`
        : "",
    }),
  };
}

// Legacy boolean retained for existing callers; new callers should use contextDecision().
export function contextExceeded(options = {}) {
  return contextDecision(options).exceeded;
}

const evidencePresent = (value) => {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};
const safeEvidenceText = (value, { maxItems = 32, maxChars = 3200 } = {}) => {
  if (!evidencePresent(value)) return "(not supplied)";
  const values = Array.isArray(value) ? value.slice(0, maxItems) : [value];
  const rows = values.map((item) => {
    if (typeof item === "string") return item;
    try { return JSON.stringify(item); } catch { return String(item); }
  }).map((item) => shortText(item, 500)).filter(Boolean);
  return rows.map((item) => "- " + item).join("\n").slice(0, maxChars) || "(not supplied)";
};

// The supervisor sees a bounded evidence digest, not the transcript. Existing goal/round/tool-only
// callers keep working, while newer callers can provide acceptance criteria, a durable task ledger,
// and structured evidence. Generic `ledger`/`criteria` aliases are accepted for compatibility with
// callers that adopted those names before the formal shape was added.
export function supervisorPrompt(options = {}) {
  const input = options && typeof options === "object" ? options : {};
  const goal = input.goal || "";
  const rounds = Number(input.rounds) || 0;
  const toolSummaries = Array.isArray(input.toolSummaries) ? input.toolSummaries : [];
  const suppliedEvidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  const taskLedger = input.taskLedger ?? input.ledger ?? suppliedEvidence.taskLedger ?? suppliedEvidence.ledger;
  const acceptanceCriteria = input.acceptanceCriteria ?? input.criteria ??
    suppliedEvidence.acceptanceCriteria ?? suppliedEvidence.criteria;
  const extraEvidence = { ...suppliedEvidence };
  delete extraEvidence.taskLedger;
  delete extraEvidence.ledger;
  delete extraEvidence.acceptanceCriteria;
  delete extraEvidence.criteria;
  const trail = toolSummaries.slice(-24)
    .map((item) => shortText(item, 320)).filter(Boolean).join("\n").slice(0, 6000) ||
    "(no tool activity)";

  return [
    "You are Dominion's completion supervisor for an AI worker.",
    "Decide whether the user's requested outcome is verified and what must happen next. Preserve the worker's native reasoning; manage process, evidence, recovery, and resumability.",
    "",
    "Do not optimize for cheapness, shortness, or fewer tool calls. Cost estimates and round count alone never justify stopping. Only an explicitly exhausted enforced budget may produce paused_budget.",
    "Only observable evidence counts: changed bytes, fully read relevant inputs, passing checks, completed deliverables, and explicit acceptance-criterion evidence. A successful command with no required state change is not progress. Activity volume is not completion.",
    "",
    "Goal:",
    shortText(goal, 2000) || "(not supplied)",
    "",
    "Acceptance criteria:",
    safeEvidenceText(acceptanceCriteria, { maxItems: 40, maxChars: 4000 }),
    "",
    "Task ledger (done/in progress/remaining, with evidence when known):",
    safeEvidenceText(taskLedger, { maxItems: 48, maxChars: 5000 }),
    "",
    "Additional supplied evidence:",
    safeEvidenceText(extraEvidence, { maxItems: 24, maxChars: 3200 }),
    "",
    `Worker rounds so far: ${rounds}`,
    "Recent tool activity (most recent last):",
    trail,
    "",
    "Choose exactly one decision:",
    "- complete: every supplied acceptance criterion is satisfied and verified. Never infer this from effort, cost, round count, a fuse, or a plausible-looking answer.",
    "- continue: work remains and a concrete safe next action is available.",
    "- checkpoint_context: context headroom is low; save the exact ledger and resume in a fresh context. This is not completion.",
    "- paused_budget: the enforced available budget is actually exhausted. Preserve resumable state. This is not completion.",
    "- retry: a tool call repeated, an approach stalled, or a transient/provider/tool failure has a recovery path. Recommend a different strategy, tool, or model escalation; do not conclude.",
    "- genuinely_blocked: all reasonable recoveries are exhausted and a specific external input, authority, dependency, or state change is required. Repetition alone is not a genuine block.",
    "",
    'Reply with ONLY JSON: {"decision":"complete|continue|checkpoint_context|paused_budget|retry|genuinely_blocked","reason":"<one evidence-based sentence>","next_action":"<one concrete action>","unmet_criteria":["<criterion still open>"]}',
  ].join("\n");
}

const unreadableVerdict = () => decisionResult("continue", {
  reason: "supervisor unreadable - defaulting to continue",
  nextAction: "continue from the current task ledger",
  parseFallback: true,
});

// Forgiving verdict parse: invalid output continues. Legacy `progressing` JSON is accepted; a
// legacy false becomes RETRY because "not currently progressing" is not proof of a genuine block.
export function parseVerdict(text) {
  try {
    const m = /\{[\s\S]*\}/.exec(String(text || ""));
    if (!m) return unreadableVerdict();
    const j = JSON.parse(m[0]);
    const reason = shortText(j.reason);
    const nextAction = shortText(j.next_action ?? j.nextAction);
    const unmetCriteria = j.unmet_criteria ?? j.unmetCriteria ?? [];
    if (validDecision(j.decision)) {
      return decisionResult(String(j.decision).toLowerCase(), { reason, nextAction, unmetCriteria });
    }
    if (typeof j.progressing === "boolean") {
      return decisionResult(j.progressing ? "continue" : "retry", {
        reason: reason || (j.progressing ? "legacy supervisor reported progress" : "legacy supervisor reported a recoverable stall"),
        nextAction: nextAction || (j.progressing
          ? "continue the next task-ledger item"
          : "inspect the stall, change strategy, and retry"),
        unmetCriteria,
        legacyVerdict: true,
        reportedProgressing: j.progressing,
      });
    }
    return unreadableVerdict();
  } catch {
    return unreadableVerdict();
  }
}

const inferredDecision = (reason) => {
  const text = String(reason || "");
  if (/budget/i.test(text)) return "paused_budget";
  if (/context|headroom/i.test(text)) return "checkpoint_context";
  if (/repeat|loop|stall|fuse|runaway|round/i.test(text)) return "retry";
  return "retry";
};

// Backward-compatible name retained for the existing caller. The instruction is now explicitly a
// checkpoint/recovery/finalization instruction based on decision; a pause never silently becomes a
// claim of completion.
export function pauseInstruction(options = {}) {
  const input = options && typeof options === "object" ? options : {};
  const reason = shortText(input.reason) || "the supervisor requested a recoverable checkpoint";
  const model = shortText(input.model, 180) || "the selected model";
  const decision = validDecision(input.decision) ? String(input.decision).toLowerCase() :
    inferredDecision(reason);
  const ledger = safeEvidenceText(input.taskLedger ?? input.ledger, { maxItems: 24, maxChars: 2400 });
  const criteria = safeEvidenceText(input.acceptanceCriteria ?? input.criteria, { maxItems: 24, maxChars: 2400 });
  const prefix = `[Dominion supervisor notice - not Fred] Decision: ${decision}. Reason: ${reason}. ` +
    `The model doing this work was ${model}. `;

  if (decision === "complete") {
    return prefix + "Write the final answer now. State what was accomplished and cite the verification " +
      "for every acceptance criterion. Do not claim anything that was not observed.";
  }
  if (decision === "checkpoint_context") {
    return prefix + "Context headroom requires a durable checkpoint; this is NOT task completion. " +
      "Write a clear report now containing: (1) everything accomplished so far with evidence, " +
      "(2) exactly what remains and the unmet acceptance criteria, (3) the exact next tool action, " +
      "and (4) why work checkpointed. A continuation must resume from that action without repeating " +
      `finished work. Current acceptance criteria:\n${criteria}\nCurrent task ledger:\n${ledger}`;
  }
  if (decision === "paused_budget") {
    return prefix + "The enforced budget is the only reason work paused; unfinished work is NOT " +
      "complete. Write a clear report now containing: (1) everything accomplished so far, " +
      "(2) exactly what remains, (3) the exact next action, and (4) why work paused. Preserve a " +
      "resumable checkpoint so added budget can continue automatically. " +
      `Current acceptance criteria:\n${criteria}\nCurrent task ledger:\n${ledger}`;
  }
  if (decision === "genuinely_blocked") {
    return prefix + "Do not call the task complete. Report everything accomplished so far, exactly " +
      "what remains, the recovery paths already attempted, and the specific external input, authority, " +
      "dependency, or state change required to continue.";
  }
  return prefix + "This is a recovery decision, not a conclusion and not task completion. If tools " +
    "remain enabled, inspect the actual failure, change strategy or tool, and retry now. If emergency " +
    "protection disabled tools, write a durable checkpoint with everything accomplished so far, " +
    "exactly what remains, why work paused, and the first different action the next attempt must take. " +
    "Escalate to a more capable tool or model when the current method cannot recover.";
}
