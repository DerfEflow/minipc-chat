/*
 * Supervisor gate tests — run with: node --test supervisor_test.mjs
 * The deterministic gates (loop detection, context headroom, verdict parsing, pause wording) are
 * pure functions; every rule in Fred's design is pinned here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopWatch, contextExceeded, supervisorPrompt, parseVerdict, pauseInstruction,
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

test("supervisor prompt: digest only — bounded goal, capped trail, progress-not-quality framing", () => {
  const p = supervisorPrompt({ goal: "g".repeat(5000), rounds: 16, toolSummaries: Array.from({ length: 100 }, (_, i) => "t" + i + " · succeeded") });
  assert.ok(p.length < 3000, "stays digest-sized: " + p.length);
  assert.match(p, /PROGRESS ONLY/);
  assert.match(p, /not correctness/);
  assert.ok(p.includes("t99"), "most recent activity present");
  assert.ok(!p.includes("t10 "), "old trail truncated");
});

test("constants are Fred's spec: check every 8, hard fuse well above any real job", () => {
  assert.equal(SUP_CHECK_EVERY, 8);
  assert.ok(SUP_HARD_CAP >= 48);
});
