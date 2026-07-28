/*
 * Supervisor gate tests — run with: node --test supervisor_test.mjs
 * The deterministic gates (loop detection, context headroom, verdict parsing, pause wording) are
 * pure functions; every rule in Fred's design is pinned here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { continuationContext, createLoopWatch, contextExceeded, emptyResponseInstruction, reasoningOnlyPause, supervisorPrompt, parseVerdict, pauseInstruction, summarizeToolOutcome, textLoopEvidence,
         SUP_CHECK_EVERY, SUP_HARD_CAP, SUP_CTX_FRACTION } from "./supervisor.mjs";

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test("loop watch: identical call 3x trips; varied calls never do", () => {
  const w = createLoopWatch();
  assert.equal(w.note([call("forge_read", { path: "a.txt" })]).looping, false);
  assert.equal(w.note([call("forge_read", { path: "a.txt" })]).looping, false);
  const third = w.note([call("forge_read", { path: "a.txt" })]);
  assert.equal(third.looping, true);
  assert.match(third.sig, /forge_read/);
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
  assert.ok(loop.cutAt > 0);
  assert.match(loop.phrase, /git status/);
  assert.equal(textLoopEvidence("One line of analysis.\nA second distinct line.\nA final result.").looping, false);
  assert.equal(textLoopEvidence("yes\nyes\nyes\nyes\nyes\nyes").looping, false, "short intentional refrains are ignored");
});

test("context headroom: trips past 75% of the window, not before", () => {
  const msg = (chars) => [{ role: "user", content: "x".repeat(chars) }];
  assert.equal(contextExceeded({ messages: msg(100000), ctx: 100000 }), false, "25k tok of 100k window: fine");
  assert.equal(contextExceeded({ messages: msg(330000), ctx: 100000 }), true, "82.5k tok of 100k window: pause");
  assert.equal(SUP_CTX_FRACTION, 0.75);
});

test("verdict parse: honest JSON respected; any glitch defaults to CONTINUE", () => {
  assert.equal(parseVerdict('{"progressing": false, "reason": "same failure 6x"}').progressing, false);
  assert.equal(parseVerdict('Sure! {"progressing": true, "reason": "reading new files"}').progressing, true);
  for (const junk of ["", null, "no json here", '{"weird": 1}', '{broken']) {
    const v = parseVerdict(junk);
    assert.equal(v.progressing, true, "glitch must never kill good work: " + JSON.stringify(junk));
  }
});

test("pause instruction: demands the summary, the why, and names the monitored model", () => {
  const p = pauseInstruction({ reason: "the session budget is spent", model: "deepseek/deepseek-v4-pro" });
  assert.match(p, /accomplished so far/);
  assert.match(p, /what remains/);
  assert.match(p, /why work paused/);
  assert.match(p, /deepseek\/deepseek-v4-pro/);
  assert.match(p, /budget is spent/);
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

test("supervisor prompt: digest only — bounded goal, capped trail, progress-not-quality framing", () => {
  const p = supervisorPrompt({ goal: "g".repeat(5000), rounds: 16, toolSummaries: Array.from({ length: 100 }, (_, i) => "t" + i + " · succeeded") });
  assert.ok(p.length < 3000, "stays digest-sized: " + p.length);
  assert.match(p, /PROGRESS ONLY/);
  assert.match(p, /not correctness/);
  assert.match(p, /without a file delta is NOT progress/);
  assert.ok(p.includes("t99"), "most recent activity present");
  assert.ok(!p.includes("t10 "), "old trail truncated");
});

test("constants are Fred's spec: check every 8, hard fuse well above any real job", () => {
  assert.equal(SUP_CHECK_EVERY, 8);
  assert.ok(SUP_HARD_CAP >= 48);
});
