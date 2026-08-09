/*
 * Every exit from a cloud chat turn has to settle what the turn spent.
 *
 * THE BUG THIS GUARDS (Fred, 2026-08-09: "the usage calculator stayed the same after the switch").
 * Only the completed path metered. A turn that ran eight tool rounds and then died on a provider
 * error logged costUsd undefined, charged nobody, and skipped the budget event — so the budget
 * window in the UI kept displaying the last good number. Fred switched to DeepSeek R1, all four of
 * his R1 turns failed, and the frozen window read as "the calculator stopped counting when I changed
 * models". The calculator was correct; the failed turns were simply worth nothing to it, while
 * OpenRouter billed the tokens they had already burned.
 *
 * The settlement closure lives inside the streaming handler and cannot be imported, so this asserts
 * against the source the way buildfreeze_test and cachebilling_test do. Source assertions are crude,
 * but the regression here is structural — someone adds a fifth exit and forgets to settle — and that
 * is exactly what a structural check catches and a behavioural one would not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
let passed = 0;
const t = (name, fn) => { fn(); console.log("  ok  " + name); passed++; };

t("settlement is defined exactly once", () => {
  const defs = server.match(/async function settleTurnSpend\s*\(/g) || [];
  assert.equal(defs.length, 1, "expected one settleTurnSpend definition, found " + defs.length);
});

t("all three turn exits settle: completed, provider error, interrupted", () => {
  const calls = server.match(/settleTurnSpend\(\)/g) || [];
  // 3 call sites + 0 in the definition line (which is `async function settleTurnSpend(`).
  assert.ok(calls.length >= 3, "expected at least 3 settlement call sites, found " + calls.length);
});

t("recordSpend has exactly one call site, so no exit can bill by a second route", () => {
  const hits = server.match(/sessionBudgets\.recordSpend\(/g) || [];
  assert.equal(hits.length, 1,
    "session spend must flow through settleTurnSpend alone; found " + hits.length + " call sites");
});

t("settlement is idempotent — the abort path can be reached twice", () => {
  assert.match(server, /let spendSettled = false/, "missing the idempotence flag");
  assert.match(server, /if \(spendSettled\) return/, "missing the idempotence guard");
});

t("the cost expression has one home per purpose, so the exits cannot disagree on the number", () => {
  const defs = server.match(/const turnCostUsd = \(\)/g) || [];
  assert.equal(defs.length, 1, "turnCostUsd must be defined once");
  /*
   * Two named helpers are allowed to add the running totals and nothing else may:
   *   turnCostUsd() - the SETTLED figure (rounded, gated on sawCost/sawTok) that bills and logs;
   *   liveCostUsd() - the in-flight running total the mid-turn affordability guard subtracts from
   *                   remaining budget before sizing the next worker call. Deliberately unrounded
   *                   and ungated, because it is a guard rail rather than an invoice.
   * Any THIRD site is an exit recomputing the sum by hand, which is how the completed and failed
   * paths drifted apart in the first place.
   */
  const lines = server.split("\n").filter((l) => l.includes("costTotal + catalogCostTotal"));
  assert.equal(lines.length, 2, "the cost sum appears on " + lines.length + " lines, expected 2");
  assert.ok(lines.every((l) => /const (turnCostUsd|liveCostUsd) = \(\)/.test(l)),
    "the cost sum may only appear inside turnCostUsd or liveCostUsd, not inline at an exit");
});

t("the failure paths log what the turn cost instead of leaving it undefined", () => {
  // Both non-completed exits now carry costUsd into usage.jsonl. This is the field that read
  // "cost=undefined" on all four failed R1 runs while OpenRouter billed them for real.
  const errorLog = /status: "error", error: String\(or\.error \|\| ""\)\.slice\(0, 200\), rounds: roundsUsed, tools: toolCount, promptTokens: [^,]+, outputTokens: [^,]+, costUsd: s\.costUsd/;
  assert.match(server, errorLog, "the provider-error exit must log costUsd");
  const interruptedLog = /status: "interrupted", rounds: roundsUsed, tools: toolCount, promptTokens: [^,]+, outputTokens: [^,]+, costUsd: s\.costUsd/;
  assert.match(server, interruptedLog, "the interrupted exit must log costUsd");
});

t("both tenancies settle: owner in USD, guest in credits through meterTurn", () => {
  // One line decides which unit the session is charged in; if it ever loses a branch, one of the two
  // populations silently stops accumulating. Fred asked for the fix on "mine and guest versions".
  assert.match(server, /const spendAmt = T\.isOwner \? \(cost \|\| 0\) : \(\(metered && metered\.credits\) \|\| 0\)/,
    "settlement must charge the owner in USD and a guest in the credits meterTurn actually deducted");
});

console.log(`\nbudgetsettle: ${passed} passed, 0 failed`);
