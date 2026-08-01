/*
 * The chat -> Crucible handoff must carry the CORPUS, never a light summary.
 *
 * Fred, 2026-07-31: "it is not a light summary, but the entire corpus of pertinent decisions and
 * details, otherwise a completely different app might be built, which is what would have happened
 * on this test." The old path squeezed a conversation through 24,000 chars into an 8,000-char
 * brief while the build door accepts 3,000,000. These checks pin the limits and the contract so a
 * future edit cannot quietly reintroduce the squeeze.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const handler = server.slice(server.indexOf('path === "/ide/from-chat"'), server.indexOf('path === "/ide/intake"'));
assert.ok(handler.length > 500, "found the from-chat handler");

t("the extractor is fed the conversation, not a keyhole view of it", () => {
  assert.match(handler, /slice\(-400\)/, "carries 400 turns, not 40");
  assert.match(handler, /slice\(0,\s*40000\)/, "40,000 chars per turn, not 4,000");
  assert.match(handler, /slice\(-400000\)/, "400,000 chars of conversation, not 24,000");
});

t("the decision record is not capped at summary length", () => {
  assert.match(handler, /slice\(0,\s*200000\)/, "the record may be as long as the decisions are");
  assert.ok(!/slice\(0,\s*8000\)/.test(handler), "the old 8,000-char squeeze is gone");
});

t("the prompt demands completeness and forbids summarising", () => {
  assert.match(handler, /NOT A SUMMARY/, "it must say so in capitals; this is the whole bug");
  assert.match(handler, /Completeness outranks brevity/);
  assert.match(handler, /EVERY settled decision/);
  assert.match(handler, /REJECTED or ruled out/, "ruled-out things must not be helpfully reintroduced");
  assert.match(handler, /OPEN:/, "unsettled questions are named rather than guessed");
});

t("the verbatim source rides along beside the record", () => {
  assert.match(handler, /transcript:\s*said/, "the ground truth is returned, not discarded");
});

/* ---- the client chain: three places used to re-cut what the server sent ---- */
const ide  = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");
const app  = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const vibe = readFileSync(new URL("./public/dominion-vibe.js", import.meta.url), "utf8");

t("nothing re-cuts the corpus on the way through the client", () => {
  assert.match(app, /transcript: j\.transcript/, "the chat forwards the source");
  assert.match(ide, /brief: String\(d\.brief \|\| ""\)\.slice\(0, 200000\)/, "the bridge stopped cutting to 8,000");
  assert.match(ide, /transcript: String\(d\.transcript/, "the bridge carries the source");
  assert.match(vibe, /transcript: ph\.transcript/, "the Vibe surface stores the source");
});

t("the BUILD prompt receives the record and the source, decisions first", () => {
  const build = vibe.slice(vibe.indexOf("async function beginBuilding"), vibe.indexOf("function budgetIsCredits"));
  assert.match(build, /DECISION RECORD FROM THE PLANNING CONVERSATION/);
  assert.match(build, /SOURCE CONVERSATION \(verbatim/);
  assert.ok(build.indexOf("DECISION RECORD") < build.indexOf("SOURCE CONVERSATION"),
    "decisions must precede the appendix so a truncation loses the appendix first");
});

t("a reload keeps the decisions even though it drops the bulky appendix", () => {
  assert.match(vibe, /plan: state\.plan \? \{ name: state\.plan\.name, brief: state\.plan\.brief \}/,
    "the draft persists the record; localStorage cannot hold 400KB of transcript");
});

console.log(`\ncorpus_handoff: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
