/*
 * The budget freeze that referred to a variable that was not there. Run: node buildfreeze_test.mjs
 *
 * Fred and a guest, both testing in the same room on 2026-08-01, each planned a project, split it
 * into tasks, assigned models per task, pressed BEGIN BUILDING, and watched it fail. The tasks
 * appeared first, which is the tell: the build got as far as drawing the Blueprint and died on the
 * next statement.
 *
 * That statement was the budget freeze. A `files:` argument had been added to it as
 * `(mv && mv.files && mv.files.length) || 1`, copied from the single-move path where `mv` is the
 * move being estimated. Neither batch scope has an `mv`, and a free identifier in a module is a
 * ReferenceError rather than undefined, so EVERY build that split into tasks threw — for a day and
 * a half, for everyone, on both the roadmap path and the Army path.
 *
 * A source-shape assertion would not have caught this, because the token `mv` does appear in the
 * file: it is declared thirty lines later, inside a callback, in a scope that cannot reach back.
 * So these tests EXECUTE each estimate expression, lifted verbatim out of server.mjs, in a strict
 * scope holding exactly the names its real enclosing function holds. Anything else it reaches for
 * throws, here, instead of in front of somebody who is paying for the build.
 *
 * server.mjs is read as TEXT, never imported: importing it boots a whole server against the real
 * data directories.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateMove } from "./ideengine.mjs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
};

// ---- lift every estimateMove(...) call out of server.mjs, with its balanced parens -------------
function callsTo(fnName, src) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(fnName + "(", from);
    if (at < 0) return out;
    let i = at + fnName.length, depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") { depth--; if (!depth) { i++; break; } }
    }
    out.push({ at, text: src.slice(at, i), after: src.slice(i, i + 240) });
    from = i;
  }
}

const calls = callsTo("estimateMove", server).filter((c) => !/^estimateMove\(\{ manifestBytes = /.test(c.text));

/*
 * Which scope each call actually stands in, named by the line right after it. The roadmap freeze
 * multiplies by tasks.length and the Army freeze by parts.length, so the estimate is PER UNIT and
 * the per-unit file count has to come from the units themselves.
 */
const SCOPES = {
  tasks: { wmRec: { inCost: 1, outCost: 2 }, tasks: [{ files: ["a.js", "b.js"] }, { files: ["c.js"] }] },
  parts: { wmRec: { inCost: 1, outCost: 2 }, parts: [{ files: ["a.js", "b.js"] }, { files: ["c.js"] }] },
  move:  { move: { files: ["a.js"] }, resolved: { build_code: "x" }, modelById: () => ({ inCost: 1, outCost: 2 }) },
};
const scopeOf = (c) => (/est\.usd \* tasks\.length/.test(c.after) ? "tasks"
  : /est\.usd \* parts\.length/.test(c.after) ? "parts" : "move");

// The declarations that sit between the call and its scope's collection, so the lifted expression
// can be evaluated exactly as written.
const PRELUDE = {
  tasks: "const filesPerTask = Math.max(1, ...tasks.map((t) => (t.files || []).length));",
  parts: "const filesPerPart = Math.max(1, ...parts.map((p) => (p.files || []).length));",
  move: "",
};

function evaluate(call) {
  const kind = scopeOf(call);
  const scope = SCOPES[kind];
  const names = Object.keys(scope);
  const body = "'use strict';\n" + PRELUDE[kind] + "\nreturn " + call.text + ";";
  const fn = new Function("estimateMove", ...names, body);
  return fn(estimateMove, ...names.map((n) => scope[n]));
}

t("server.mjs still has the three freezes this test is about", () => {
  assert.equal(calls.length, 3, "found " + calls.length + " estimateMove call sites, expected 3");
  const kinds = calls.map(scopeOf).sort();
  assert.deepEqual(kinds, ["move", "parts", "tasks"], "one per-move estimate, one per-task, one per-part");
});

t("every budget freeze evaluates in its OWN scope and reaches for nothing else", () => {
  for (const call of calls) {
    let est;
    try { est = evaluate(call); }
    catch (e) {
      throw new Error("the " + scopeOf(call) + " freeze cannot run in its own scope — " +
        (e && e.name) + ": " + (e && e.message) + "\n      " + call.text.replace(/\s+/g, " ").slice(0, 200));
    }
    assert.ok(est && Number.isFinite(Number(est.usd)), "an estimate must be a number, got " + JSON.stringify(est));
    assert.ok(Number(est.usd) >= 0, "and never negative");
  }
});

/*
 * The freeze is a seatbelt, so its per-unit figure must not be the NARROWEST unit. A roadmap
 * whose widest task owns eight files is not priced as though every task owned one.
 */
t("the per-unit file count follows the widest unit, not the first one", () => {
  const wide = Math.max(1, ...[{ files: ["a"] }, { files: ["a", "b", "c", "d", "e", "f", "g", "h"] }].map((t2) => (t2.files || []).length));
  assert.equal(wide, 8);
  const narrow = estimateMove({ manifestBytes: 8000, files: 1, inCost: 1, outCost: 2 });
  const widest = estimateMove({ manifestBytes: 8000, files: 8, inCost: 1, outCost: 2 });
  assert.ok(widest.usd >= narrow.usd, "more owned files can never estimate cheaper");
});

t("an empty roadmap still yields a usable count rather than -Infinity", () => {
  assert.equal(Math.max(1, ...[].map((x) => x)), 1, "Math.max of nothing is -Infinity without the 1");
});

/*
 * The harness has to have teeth. If lifting an expression into a scope that lacks its identifiers
 * did NOT throw, every assertion above would pass on the broken code it was written to catch.
 */
t("the harness itself refuses the expression that caused this", () => {
  assert.throws(
    () => evaluate({ text: "estimateMove({ manifestBytes: 8000, files: (mv && mv.files && mv.files.length) || 1, inCost: wmRec.inCost || 0, outCost: wmRec.outCost || 0 })",
                     after: "nextEstUsd: est.usd * tasks.length" }),
    /ReferenceError|mv is not defined/,
    "the original line must still fail this test, or the test proves nothing");
});

/* ---- why the failure took a person in the room to discover -------------------------------- */

// runIdeBuild's last-resort catch, which is where a fault in this file lands.
const catchAll = () => server.slice(server.lastIndexOf("if (ac.signal.aborted) return;"),
  server.lastIndexOf("if (ac.signal.aborted) return;") + 1800);

t("a terminal failure is written to the SERVER log, above every early return", () => {
  const fn = server.slice(server.indexOf("function ideEscalate("), server.indexOf("const ideJobs = createIdeJobs("));
  assert.ok(fn.includes('event.type === "error"'), "the hook must notice a terminal error");
  const logAt = fn.indexOf("console.log(\"[ide] job \"");
  const bail = fn.indexOf("if (!note) return;");
  assert.ok(logAt > 0, "the failure must reach console.log");
  assert.ok(logAt < bail, "and must be logged BEFORE the push path can decline or bail");
  assert.ok(fn.indexOf("if (!subs.length) return;") > logAt,
    "an account with no phone subscribed must still get its failure logged");
});

t("a fault in our own code is not reported as a fault in the user's project", () => {
  const block = catchAll();
  assert.match(block, /e instanceof ReferenceError/, "a ReferenceError is ours, never theirs");
  assert.match(block, /e instanceof TypeError/);
  assert.match(block, /not your project/, "and the message has to say so plainly");
  assert.match(block, /console\.log\(/, "with the stack going to the log");
  const message = block.slice(block.indexOf("message: internal"), block.indexOf("message: internal") + 500);
  assert.ok(!/e\.stack/.test(message), "a stack trace is never the user's error message");
});

t("a provider or carve-out failure keeps its own words", () => {
  const block = catchAll();
  assert.match(block, /: String\(\(e && e\.message\) \|\| e\),/,
    "only the three internal error classes are reworded; everything else still speaks for itself");
});

console.log("\nbuildfreeze: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
