/*
 * Completion supervisor tests — run with: node --test supervisor_test.mjs
 * Deterministic recovery/checkpoint evidence and the model-verdict contract are pure functions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  continuationContext, contextDecision, contextExceeded, createLoopWatch, emergencyDecision,
  emptyResponseInstruction, parseVerdict, pauseInstruction, reasoningOnlyPause,
  summarizeToolOutcome, supervisorDecision, supervisorPrompt, textLoopEvidence,
  SUP_CHECK_EVERY, SUP_CTX_FRACTION, SUP_HARD_CAP, SUPERVISOR_DECISIONS,
} from "./supervisor.mjs";

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test("loop watch: identical call 3x trips; varied calls never do", () => {
  const w = createLoopWatch();
  assert.equal(w.note([call("forge_read", { path: "a.txt" })]).looping, false);
  assert.equal(w.note([call("forge_read", { path: "a.txt" })]).looping, false);
  const third = w.note([call("forge_read", { path: "a.txt" })]);
  assert.equal(third.looping, true);
  assert.equal(third.decision, "retry", "repetition recommends recovery, not conclusion");
  assert.equal(third.shouldContinue, true);
  assert.equal(third.complete, false);
  assert.match(third.sig, /forge_read/);
  assert.match(third.recovery, /change arguments or tools/i);
  const v = createLoopWatch();
  for (let i = 0; i < 10; i++) assert.equal(v.note([call("forge_read", { path: "file" + i + ".txt" })]).looping, false, "paging through files is progress, not a loop");
});

test("loop watch: different edit commands that change no bytes on the same file trip", () => {
  const w = createLoopWatch();
  const first = w.outcome({
    name: "forge_run",
    args: { command: "Set-Content 'C:\\work\\IMPLEMENTATION_STATUS.md' -Value $x" },
    result: "exit 0\nNO TRACKED CHANGE: the command ran but changed nothing",
  });
  assert.equal(first.looping, false);
  const second = w.outcome({
    name: "forge_run",
    args: { command: "$x -replace 'old','new' | Out-File 'C:\\work\\IMPLEMENTATION_STATUS.md'" },
    result: "exit 0\nNO TRACKED CHANGE: the command ran but changed nothing",
  });
  assert.equal(second.looping, true);
  assert.equal(second.decision, "retry");
  assert.match(second.nextAction, /different edit method or tool/i);
  assert.match(second.sig, /changed no bytes/i);
});

test("loop watch: a real byte change resets the no-progress count", () => {
  const w = createLoopWatch();
  const edit = (result) => w.outcome({ name: "forge_edit", args: { path: "C:\\work\\a.md" }, result });
  assert.equal(edit("NO CHANGE: identical").looping, false);
  assert.equal(edit("CHANGED: replaced one match").looping, false);
  assert.equal(edit("NO CHANGE: identical").looping, false, "one miss after progress is not a loop");
  assert.equal(edit("NO CHANGE: identical").looping, true);
});

test("tool outcome summaries distinguish command success from file progress", () => {
  const noDelta = summarizeToolOutcome({
    name: "forge_run", args: { command: "Set-Content 'C:\\work\\a.md' -Value x" },
    result: "exit 0\nNO TRACKED CHANGE: unchanged",
  });
  assert.equal(noDelta.changed, false);
  assert.match(noDelta.summary, /no byte change/);
  const testRun = summarizeToolOutcome({ name: "forge_run", args: { command: "npm test" }, result: "exit 0" });
  assert.equal(testRun.mutation, false, "a read-only check is not counted as a failed edit");
});

test("text loop fuse catches repetition inside one answer and leaves ordinary prose alone", () => {
  const phrase = "Let me try to see the git status with a different approach:";
  const loop = textLoopEvidence(Array(20).fill(phrase).join("\n\n"));
  assert.equal(loop.looping, true);
  assert.equal(loop.decision, "retry");
  assert.equal(loop.complete, false);
  assert.ok(loop.cutAt > 0);
  assert.match(loop.phrase, /git status/);
  assert.equal(textLoopEvidence("One line of analysis.\nA second distinct line.\nA final result.").looping, false);
  assert.equal(textLoopEvidence("yes\nyes\nyes\nyes\nyes\nyes").looping, false, "short intentional refrains are ignored");
});

test("context headroom: checkpoints past 75% and preserves the legacy boolean", () => {
  const msg = (chars) => [{ role: "user", content: "x".repeat(chars) }];
  const under = contextDecision({ messages: msg(100000), ctx: 100000 });
  assert.equal(under.exceeded, false, "25k tok of 100k window: fine");
  assert.equal(under.decision, "continue");
  const over = contextDecision({ messages: msg(330000), ctx: 100000 });
  assert.equal(over.exceeded, true, "82.5k tok of 100k window: checkpoint");
  assert.equal(over.decision, "checkpoint_context");
  assert.equal(over.checkpoint, true);
  assert.equal(over.complete, false);
  assert.equal(contextExceeded({ messages: msg(330000), ctx: 100000 }), true, "old callers still receive a boolean");
  assert.equal(SUP_CTX_FRACTION, 0.75);
});

test("context headroom counts provider-native replay state and structured payloads", () => {
  const cases = [
    ["OpenAI encrypted Responses output", {
      role: "assistant",
      content: "",
      responsesOutput: [{
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "o".repeat(10_000),
        summary: [],
      }],
    }],
    ["Anthropic signed thinking in array content", {
      role: "assistant",
      content: [{ type: "thinking", thinking: "brief", signature: "s".repeat(4_000) }],
    }],
    ["DeepSeek reasoning replay", {
      role: "assistant",
      content: "",
      reasoning_content: "d".repeat(4_000),
    }],
    ["OpenRouter reasoning-detail replay", {
      role: "assistant",
      content: "",
      reasoning_details: [{ type: "reasoning.encrypted", data: "r".repeat(4_000) }],
    }],
    ["text attachment payload", {
      role: "user",
      content: "inspect",
      attachments: [{ kind: "text", name: "large.txt", text: "a".repeat(4_000) }],
    }],
    ["tool-call payload", {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "forge_write", arguments: "t".repeat(4_000) },
      }],
    }],
  ];

  for (const [label, message] of cases) {
    const decision = contextDecision({ messages: [message], ctx: 1_000 });
    assert.equal(decision.exceeded, true, `${label} was omitted from context accounting`);
    assert.equal(decision.decision, "checkpoint_context", `${label} did not request a checkpoint`);
    assert.ok(decision.estimatedTokens > decision.thresholdTokens, `${label} estimate did not cross the threshold`);
  }

  assert.equal(contextExceeded({ messages: [cases[0][1]], ctx: 1_000 }), true,
    "legacy contextExceeded omitted a 10k OpenAI responsesOutput payload");
});

test("decision engine distinguishes completion, checkpoints, recovery, and a genuine block", () => {
  assert.equal(supervisorDecision({ verifiedComplete: true }).decision, "complete");
  assert.equal(supervisorDecision().decision, "continue");
  assert.equal(supervisorDecision({ contextThresholdReached: true }).decision, "checkpoint_context");
  assert.equal(supervisorDecision({ budgetExhausted: true }).decision, "paused_budget");
  assert.equal(supervisorDecision({ transientFailure: true }).decision, "retry");
  assert.equal(supervisorDecision({ genuinelyBlocked: true }).decision, "genuinely_blocked");

  const recoverBeforeBlock = supervisorDecision({ repeatedToolCall: true, genuinelyBlocked: true });
  assert.equal(recoverBeforeBlock.decision, "retry", "repetition alone must trigger recovery before blocking");
  assert.equal(recoverBeforeBlock.terminal, false);
  const contradictedCompletion = supervisorDecision({
    verifiedComplete: true,
    unmetCriteria: ["tests pass"],
    taskLedger: [{ id: "tests", status: "remaining" }],
  });
  assert.equal(contradictedCompletion.decision, "continue",
    "a completion flag cannot override supplied unfinished evidence");
  assert.equal(supervisorDecision({ verifiedComplete: true, budgetExhausted: true }).decision, "complete",
    "verified acceptance evidence may finalize even if the budget reaches zero");
});

test("finite emergency protection checkpoints for retry and never certifies completion", () => {
  assert.equal(emergencyDecision({ rounds: SUP_HARD_CAP - 1 }).decision, "continue");
  const fused = emergencyDecision({ rounds: SUP_HARD_CAP });
  assert.equal(fused.decision, "retry");
  assert.equal(fused.emergency, true);
  assert.equal(fused.checkpoint, true);
  assert.equal(fused.complete, false);
  assert.equal(fused.terminal, false);
  assert.match(fused.nextAction, /checkpoint.*resume/i);
});

test("verdict parse: six decisions supported; legacy stalls recover; glitches continue", () => {
  for (const decision of SUPERVISOR_DECISIONS) {
    const verdict = parseVerdict(JSON.stringify({
      decision,
      reason: "evidence checked",
      next_action: "take the next concrete action",
      unmet_criteria: ["tests pass"],
    }));
    assert.equal(verdict.decision, decision);
    assert.equal(verdict.reason, "evidence checked");
    assert.equal(verdict.nextAction, "take the next concrete action");
    assert.deepEqual(verdict.unmetCriteria, ["tests pass"]);
  }
  const legacyStall = parseVerdict('{"progressing": false, "reason": "same failure 6x"}');
  assert.equal(legacyStall.decision, "retry");
  assert.equal(legacyStall.progressing, true, "old stall verdict must not kill recoverable work");
  assert.equal(legacyStall.reportedProgressing, false);
  assert.equal(parseVerdict('Sure! {"progressing": true, "reason": "reading new files"}').decision, "continue");
  for (const junk of ["", null, "no json here", '{"weird": 1}', '{broken']) {
    const v = parseVerdict(junk);
    assert.equal(v.decision, "continue", "glitch must never kill good work: " + JSON.stringify(junk));
    assert.equal(v.progressing, true);
  }
});

test("decision instructions keep budget/context/retry states resumable and name the model", () => {
  const p = pauseInstruction({ reason: "the session budget is spent", model: "deepseek/deepseek-v4-pro" });
  assert.match(p, /accomplished so far/);
  assert.match(p, /what remains/);
  assert.match(p, /why work paused/);
  assert.match(p, /deepseek\/deepseek-v4-pro/);
  assert.match(p, /budget is spent/);
  assert.match(p, /paused_budget/);
  assert.match(p, /NOT.*complete/i);

  const context = pauseInstruction({
    decision: "checkpoint_context",
    reason: "context threshold reached",
    model: "openai/gpt-5.6-sol",
    acceptanceCriteria: ["tests pass", "changes committed"],
    taskLedger: [{ id: "AUTH-003", status: "remaining" }],
  });
  assert.match(context, /durable checkpoint/i);
  assert.match(context, /NOT task completion/);
  assert.match(context, /tests pass/);
  assert.match(context, /AUTH-003/);

  const retry = pauseInstruction({ decision: "retry", reason: "same edit repeated" });
  assert.match(retry, /recovery decision, not a conclusion/i);
  assert.match(retry, /change strategy or tool/i);
  assert.match(retry, /Escalate to a more capable tool or model/i);
});

test("continuation recovers the prior substantive goal for routing and supervision", () => {
  const messages = [
    { role: "user", content: "Fix the TypeScript errors, run tests, and commit the changes." },
    { role: "assistant", content: "Paused because the session budget is spent." },
  ];
  for (const command of [
    "continue",
    "Resume.",
    "Keep going",
    "Finish the task",
    "work until the end",
    "Keep working until done.",
    "Do not stop until complete!",
    "Don't pause working until it's finished, please.",
    "Work on this to completion.",
    "Continue the unfinished work from the prior run now. Resume with the next concrete tool action.",
  ]) {
    const c = continuationContext(messages, command);
    assert.equal(c.requested, true);
    assert.match(c.goal, /TypeScript errors/);
    assert.match(c.intentText, /commit the changes/);
    assert.match(c.intentText, /Continuation instruction/);
  }
  const fresh = continuationContext(messages, "Explain what TypeScript is.");
  assert.equal(fresh.requested, false);
  assert.equal(fresh.goal, "Explain what TypeScript is.");
  for (const substantive of [
    "Keep working until done, then deploy the app to production.",
    "Do not stop until complete: fix the authentication bug.",
    "Work until the end of the file and summarize each section.",
  ]) {
    const c = continuationContext(messages, substantive);
    assert.equal(c.requested, false, "a directive with a new substantive objective is not continuation-only");
    assert.equal(c.goal, substantive);
  }
});

test("empty response recovery resumes tool work and never exposes reasoning", () => {
  const active = emptyResponseInstruction({ toolsAvailable: true, concludePhase: false, attempt: 1 });
  assert.match(active, /call the appropriate tool immediately/i);
  assert.match(active, /do not describe your plan/i);
  const concluding = emptyResponseInstruction({ toolsAvailable: true, concludePhase: true, attempt: 2 });
  assert.match(concluding, /what was accomplished/i);
  const pause = reasoningOnlyPause({ model: "deepseek/deepseek-v4-pro", attempts: 2, hadReasoning: true });
  assert.match(pause, /deepseek\/deepseek-v4-pro/);
  assert.match(pause, /No additional work was verified/);
  assert.doesNotMatch(pause, /Let me analyze|tail of its reasoning/i);
});

test("supervisor prompt: bounded completion evidence with legacy goal/tool callers supported", () => {
  const p = supervisorPrompt({
    goal: "g".repeat(5000),
    rounds: 16,
    toolSummaries: Array.from({ length: 100 }, (_, i) => "t" + i + " · succeeded"),
  });
  assert.ok(p.length < 12000, "legacy digest stays bounded: " + p.length);
  assert.match(p, /completion supervisor/i);
  assert.match(p, /Do not optimize for cheapness/);
  assert.match(p, /successful command with no required state change is not progress/i);
  for (const decision of SUPERVISOR_DECISIONS) assert.match(p, new RegExp("\\b" + decision + "\\b"));
  assert.ok(p.includes("t99"), "most recent activity present");
  assert.ok(!p.includes("t10 "), "old trail truncated");

  const evidencePrompt = supervisorPrompt({
    goal: "Finish the AUTH packet.",
    acceptanceCriteria: ["IMPLEMENTATION_STATUS.md corrected", "tests pass", "clean commit exists"],
    taskLedger: [
      { id: "AUTH-003", status: "remaining", next: "create vocabulary" },
      { id: "AUTH-005", status: "remaining", next: "define handoff" },
    ],
    evidence: { lastTest: "not run", budgetExhausted: false },
  });
  assert.match(evidencePrompt, /IMPLEMENTATION_STATUS\.md corrected/);
  assert.match(evidencePrompt, /AUTH-003/);
  assert.match(evidencePrompt, /lastTest/);
  assert.match(evidencePrompt, /Repetition alone is not a genuine block/);
});

test("supervisor prompt accepts early ledger/criteria aliases", () => {
  const p = supervisorPrompt({
    goal: "ship",
    ledger: ["build done", "tests remaining"],
    criteria: ["tests green"],
  });
  assert.match(p, /build done/);
  assert.match(p, /tests green/);
});

test("constants retain cadence and finite emergency protection", () => {
  assert.equal(SUP_CHECK_EVERY, 8);
  assert.ok(SUP_HARD_CAP >= 48);
  assert.deepEqual(SUPERVISOR_DECISIONS, [
    "complete", "continue", "checkpoint_context", "paused_budget", "retry", "genuinely_blocked",
  ]);
});
