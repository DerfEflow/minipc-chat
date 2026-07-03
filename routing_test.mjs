/*
 * Group-D restoration self-test — run with: node routing_test.mjs
 * Proves (pure functions, no live model / server needed):
 *   1. the POST-RETRIEVAL long-context re-check escalates on synthetic overflow (audit item 12)
 *      — under budget stays put, overflow escalates to a 4096-aligned window, the provider cap
 *      clamps honestly (atCap flagged, never a pretend-YaRN window)
 *   2. routeOf maps tier+mode onto the spec route enum (spec ~352-363)
 *   3. consumeNeeds turns needs_retrieval / needs_tools into pipeline behavior with the
 *      conservative bias (when in doubt: attach tools, retrieve)
 */
import assert from "node:assert/strict";
import { DEFAULT_NUM_CTX, routeOf, escalateForContext, consumeNeeds, NO_RETRIEVAL_RE } from "./routing.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

await t("escalateForContext: small context stays inside the default window", () => {
  const r = escalateForContext({ contextTokens: 3000 });
  assert.equal(r.escalate, false);
  assert.equal(r.numCtx, DEFAULT_NUM_CTX);
});

await t("escalateForContext: synthetic post-retrieval overflow FIRES the escalation", () => {
  // routing said "normal" (default 8192 window) but retrieval assembled ~20k tokens of context
  const r = escalateForContext({ contextTokens: 20000, numCtx: 0, cap: 40960 });
  assert.equal(r.escalate, true, "overflow must escalate");
  assert.ok(r.numCtx >= 20000 + 1024, "escalated window holds the assembled context + reserve");
  assert.equal(r.numCtx % 4096, 0, "4096-aligned");
  assert.ok(r.overflowTokens > 0);
  assert.ok(!r.atCap);
});

await t("escalateForContext: respects an already-raised long_context window", () => {
  const r = escalateForContext({ contextTokens: 20000, numCtx: 32768, cap: 40960 });
  assert.equal(r.escalate, false, "32768 already holds 20k + reserve");
  assert.equal(r.numCtx, 32768);
});

await t("escalateForContext: clamps at the provider cap and says so (no pretend-YaRN)", () => {
  const r = escalateForContext({ contextTokens: 90000, numCtx: 8192, cap: 40960 });
  assert.equal(r.escalate, true);
  assert.equal(r.numCtx, 40960, "never exceeds the HONEST served maximum");
  assert.equal(r.atCap, true, "flags that even the cap can't hold it");
});

await t("routeOf: spec route enum mapping", () => {
  assert.equal(routeOf("light", "fast"), "local_light");
  assert.equal(routeOf("main", "normal"), "local_main");
  assert.equal(routeOf("main", "deep_think"), "local_main");
  assert.equal(routeOf("main", "long_context"), "local_main_long_context");
  assert.equal(routeOf("light", "long_context"), "local_main_long_context", "post-retrieval escalation keeps the long-context route");
  assert.equal(routeOf("main", "mentor"), "multi_model_review");
});

await t("consumeNeeds: fast-mode chat-only turn drops tool defs AND retrieval", () => {
  const r = consumeNeeds({ mode: "fast", needsTools: false, needsRetrieval: false, lastUserText: "thanks!" });
  assert.equal(r.skipRetrieval, true);
  assert.equal(r.attachTools, false, "chat-only fast turn saves the tool-def prompt tokens");
});

await t("consumeNeeds: fast mode with tool-shaped language keeps tools (conservative bias)", () => {
  const r = consumeNeeds({ mode: "fast", needsTools: true, needsRetrieval: false, lastUserText: "list my deck projects" });
  assert.equal(r.attachTools, true);
});

await t("consumeNeeds: normal mode always attaches tools, even when the sniff was negative", () => {
  const r = consumeNeeds({ mode: "normal", needsTools: false, needsRetrieval: true, lastUserText: "explain something" });
  assert.equal(r.attachTools, true, "when in doubt, attach");
  assert.equal(r.skipRetrieval, false);
});

await t("consumeNeeds: needs_retrieval=false is honored outside fast mode", () => {
  const r = consumeNeeds({ mode: "deep_think", needsTools: true, needsRetrieval: false, lastUserText: "long reasoning task" });
  assert.equal(r.skipRetrieval, true, "the router's needs_retrieval verdict is consumed");
  assert.equal(r.attachTools, true);
});

await t("consumeNeeds: self-contained transform asks skip retrieval", () => {
  assert.ok(NO_RETRIEVAL_RE.test("Format this list as a table"));
  const r = consumeNeeds({ mode: "normal", needsTools: true, needsRetrieval: true, lastUserText: "Reformat the following notes into bullets: a b c" });
  assert.equal(r.skipRetrieval, true);
});

await t("consumeNeeds: tool mode always attaches tools", () => {
  const r = consumeNeeds({ mode: "tool", needsTools: false, needsRetrieval: true, lastUserText: "hi" });
  assert.equal(r.attachTools, true);
});

console.log(`\nrouting_test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
