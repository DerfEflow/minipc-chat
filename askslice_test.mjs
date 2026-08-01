/*
 * The ask, separated from the paste. Run: node askslice_test.mjs
 *
 * Fred, 2026-08-01: he pasted an article his son is writing and asked for a review in Fred's
 * voice. The reply opened with "Heads up: that asks for real work on a machine, but the Operating
 * mode is set to As Fred", and then the turn failed to finish.
 *
 * The warning was a false positive with an obvious cause once seen: MACHINE_INTENT_RE was tested
 * against the WHOLE user message, article included, and any few thousand words of English contain
 * "run" or "file" or "fix" or "server" somewhere. The guard was reading a teenager's essay looking
 * for build instructions.
 *
 * These pin the separation, and pin that a genuine machine ask is still caught, because a guard
 * that stops crying wolf by going deaf is not an improvement.
 *
 * server.mjs is read as TEXT here, never imported: importing it boots a whole server against the
 * real data directories, which a unit test must never do.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { askSliceOf } from "./routing.mjs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
};

// The same pattern the router and the disarm guard use.
const MACHINE_INTENT_RE = /\b(build|deploy|install|refactor|migrate|fix|debug|run|execute|script|commit|push|repo|repository|codebase|server|database|file|folder|directory|terminal|shell|command|laptop|mini-?pc|machine|my computer)\b/i;

// An article that mentions ordinary things in ordinary English. Nothing here asks for any work.
const ARTICLE = [
  "The old mill had not run in forty years, and the river ran past it without comment.",
  "My grandfather kept a file of every repair he ever made to the place, in a folder tied with string.",
  "He used to say a man should fix what he owns before he buys another one.",
  "The building itself was a machine of a kind: gears, belts, a command over water that nobody",
  "living now could reproduce. In the archive there is a photograph of the whole crew on the steps.",
].join(" ").repeat(12);

t("a pasted article is not mistaken for machine work", () => {
  const msg = "Review this as me, in my voice. Be honest about whether it holds up.\n\n" + ARTICLE;
  assert.ok(msg.length > 3000, "the fixture must be long enough to have a payload");
  assert.ok(MACHINE_INTENT_RE.test(msg), "the WHOLE message does trip the pattern, which was the bug");
  const slice = askSliceOf(msg);
  assert.ok(slice.startsWith("Review this as me"), "the ask survives at the front");
  assert.ok(slice.length < msg.length / 3, "and the bulk of the article is gone");
});

t("an article pasted ABOVE the ask keeps the ask, because people paste both ways", () => {
  const msg = ARTICLE + "\n\nWhat do you think of this? Review it as me.";
  assert.ok(askSliceOf(msg).includes("Review it as me"), "the trailing ask must survive the slice");
});

/*
 * The slice narrows what is read; it cannot promise that no sentence of prose ever contains the
 * word "run". The SECOND gate is what makes the guarantee: a warning, and a required-tools pause,
 * both need the turn to classify as build or audit as well. Fred's Auto attempt with a chat-only
 * model is the case that proves why: a false "build" reading did not merely add a notice, it
 * replaced his answer with "Work paused. This task is not complete."
 */
t("keyword alone is never enough: the task class has to agree", () => {
  const disarm = server.slice(server.indexOf("if (!attachTools && MACHINE_INTENT_RE"), server.indexOf("if (!attachTools && MACHINE_INTENT_RE") + 200);
  assert.match(disarm, /\["build", "audit", "research"\]\.includes\(taskIntent\.baseKind\)/,
    "the disarm warning needs the class to agree, not just a word");
  assert.match(server, /tools: \["build", "audit"\]\.includes\(taskIntent\.baseKind\) && MACHINE_INTENT_RE\.test\(askText\)/,
    "and REQUIRING tools needs both, so a prose turn can never be paused for lack of hands");
});

t("wanting a web search is no longer a reason to refuse to answer", () => {
  const block = server.slice(server.indexOf("requiredCapabilities: {"), server.indexOf("requiredCapabilities: {") + 300);
  assert.ok(!/"research"/.test(block), "research must not sit in the REQUIRED-tools set");
  assert.match(server, /never a reason to refuse to answer/, "and the reasoning is written down");
});

t("a real machine ask is STILL caught, wherever it sits", () => {
  const before = "Fix the build on my laptop, it fails on the test step.\n\n" + ARTICLE;
  assert.ok(MACHINE_INTENT_RE.test(askSliceOf(before)), "an ask above the paste is caught");
  const after = ARTICLE + "\n\nNow deploy this to the server for me.";
  assert.ok(MACHINE_INTENT_RE.test(askSliceOf(after)), "an ask below the paste is caught");
});

t("a short message is returned untouched: it is all ask and no payload", () => {
  for (const m of ["", "hi", "fix the build", "review this paragraph for me please"]) {
    assert.equal(askSliceOf(m), m);
  }
  const justUnder = "x".repeat(1200);
  assert.equal(askSliceOf(justUnder), justUnder, "the threshold itself is not sliced");
});

t("the slice keeps both ends and drops only the middle", () => {
  const msg = "START-MARKER " + "m".repeat(5000) + " END-MARKER";
  const slice = askSliceOf(msg);
  assert.ok(slice.includes("START-MARKER"), "the opening survives");
  assert.ok(slice.includes("END-MARKER"), "the closing survives");
  assert.ok(slice.length < msg.length / 4, "the middle is dropped");
  assert.ok(slice.includes("…"), "and the cut is marked rather than silently joined");
});

t("no input shape throws, because this runs before anything else on every turn", () => {
  for (const v of [undefined, null, 0, false, {}, []]) assert.equal(typeof askSliceOf(v), "string");
});

/* ---- the second half of the report: the turn that stopped without saying why ---------------- */

t("an over-capacity prompt is announced to the PERSON, not just the server log", () => {
  assert.match(server, /sse\(\{ type: "context_overflow"/,
    "atCap was computed and written only to console.log, where no user has ever looked");
  const block = server.slice(server.indexOf('if (esc.atCap) {'), server.indexOf('if (esc.atCap) {') + 1200);
  assert.match(block, /more than/, "it must say what was too big");
  assert.match(block, /oldest part of the prompt gets dropped/, "and what that costs the answer");
  assert.match(block, /in pieces, or pick a model with a bigger window/, "and what to do about it");
});

t("every intent decision reads the ask, never the pasted payload", () => {
  for (const call of ["privacyRiskOf(askText)", "wantsReview(askText)", "classifyTaskIntent(askText)",
                      "MACHINE_INTENT_RE.test(askText)", "routeDecision(askText"]) {
    assert.ok(server.includes(call), "must route through the ask slice: " + call);
  }
  const guard = server.slice(server.indexOf("if (!attachTools && MACHINE_INTENT_RE"), server.indexOf("if (!attachTools && MACHINE_INTENT_RE") + 120);
  assert.ok(!/workIntentText/.test(guard), "the disarm guard must not read the whole message again");
});

t("the content wall still reads the WHOLE message, which is the point of a wall", () => {
  assert.match(server, /screenContent\(lastUserText, \{ isOwner: T\.isOwner \}\)/,
    "safety screening must never be narrowed to the ask slice");
});

console.log("\naskslice: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
