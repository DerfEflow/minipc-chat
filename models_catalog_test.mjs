/*
 * Catalog self-test — run with: node models_catalog_test.mjs
 *
 * NEW FILE (STABILIZE Step 1, 2026-09-03). No dedicated test file existed for models.catalog.mjs
 * before this pass; the catalog was only ever exercised indirectly through wildfire_test.mjs and
 * battalion_test.mjs. This file covers what THIS pass added:
 *   1. The three confirmed-410 EOL seats are gone for good; the new empathetic-route seat exists.
 *   2. Every catalog model carries a `fallback` to a DIFFERENT, live catalog id — no dangling
 *      reference, no self-reference (deficiency #3-#5: "each seat gains a fallback ... every seat
 *      must have one").
 *   3. resolveServingModel: a live seat serves itself; an unavailable seat is served by its
 *      fallback chain (capped, never a loop); an unknown id resolves to nothing invented.
 *   4. catalogPayload() hides unavailable seats from /api/models and restores them once the audit
 *      state clears (deficiency #4: "the model picker offers seats that cannot answer").
 * setUnavailableSeats is process-wide mutable state; every test that touches it resets to {} in a
 * finally block so it never leaks into a later test in this file or (since run-tests.mjs spawns one
 * process per *_test.mjs) any other suite.
 */
import assert from "node:assert/strict";
import {
  MODELS, MODEL_IDS, isCatalogModel, MODEL_FALLBACKS, fallbackFor,
  setUnavailableSeats, getUnavailableSeats, isSeatUnavailable, unavailableReason, resolveServingModel,
  catalogPayload, modelById,
} from "./models.catalog.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

// ---- 1: the three EOL seats are gone; the replacement seat exists ---------------------------------

await t("the three confirmed-410 EOL seats are removed from the catalog for good", () => {
  for (const dead of ["z-ai/glm-5.2", "nvidia/nemotron-nano-12b-v2-vl", "meta/llama-3.1-70b-instruct"]) {
    assert.ok(!MODEL_IDS.has(dead), `"${dead}" is still in the catalog; it was measured HTTP 410 and will never come back`);
    assert.ok(!modelById(dead), `modelById still resolves "${dead}"`);
  }
});

await t("the empathetic route's replacement seat (nvidia/llama-3.1-nemotron-70b-instruct) exists and is well-formed", () => {
  const m = modelById("nvidia/llama-3.1-nemotron-70b-instruct");
  assert.ok(m, "replacement seat missing from the catalog");
  assert.equal(m.provider, "nvidia");
  assert.equal(m.directId, "nvidia/llama-3.1-nemotron-70b-instruct");
  assert.equal(m.inCost, 0);
  assert.equal(m.outCost, 0);
});

await t("the minimax seat's directId is the live NVIDIA id (minimaxai/minimax-m3), not the catalog id", () => {
  const m = modelById("minimax/minimax-m3");
  assert.ok(m);
  assert.equal(m.directId, "minimaxai/minimax-m3");
});

// ---- 2: every model has a fallback to a DIFFERENT, live catalog id --------------------------------

await t("MODEL_FALLBACKS covers every catalog model exactly once, no self-reference, no dangling target", () => {
  const ids = new Set(MODELS.map((m) => m.id));
  const missing = [...ids].filter((id) => !(id in MODEL_FALLBACKS));
  assert.deepEqual(missing, [], "models with no fallback entry: " + missing.join(", "));
  for (const [key, value] of Object.entries(MODEL_FALLBACKS)) {
    assert.ok(ids.has(key), `MODEL_FALLBACKS key "${key}" is not a live catalog id`);
    assert.ok(ids.has(value), `MODEL_FALLBACKS["${key}"] = "${value}" is not a live catalog id`);
    assert.notEqual(key, value, `"${key}" falls back to itself`);
  }
});

await t("every model record carries its own .fallback field, matching MODEL_FALLBACKS", () => {
  for (const m of MODELS) {
    assert.equal(m.fallback, MODEL_FALLBACKS[m.id] || "", `${m.id}.fallback did not match the map`);
    assert.equal(fallbackFor(m.id), m.fallback);
  }
});

// ---- 3: resolveServingModel -------------------------------------------------------------------------

await t("resolveServingModel: a live seat serves itself, substituted:false", () => {
  const r = resolveServingModel("anthropic/claude-haiku-4-5");
  assert.equal(r.servedId, "anthropic/claude-haiku-4-5");
  assert.equal(r.substituted, false);
  assert.deepEqual(r.chain, []);
});

await t("resolveServingModel: an unavailable seat is served by its fallback, substituted:true, chain explains why", () => {
  try {
    setUnavailableSeats({ "deepseek/deepseek-v4-pro": "live probe: HTTP 410 (test)" });
    const r = resolveServingModel("deepseek/deepseek-v4-pro");
    assert.equal(r.servedId, fallbackFor("deepseek/deepseek-v4-pro"));
    assert.equal(r.substituted, true);
    assert.equal(r.chain.length, 1);
    assert.equal(r.chain[0].id, "deepseek/deepseek-v4-pro");
    assert.match(r.chain[0].reason, /HTTP 410/);
  } finally { setUnavailableSeats({}); }
});

await t("resolveServingModel: chases a fallback CHAIN when the first fallback is ALSO unavailable", () => {
  try {
    const first = "openai/gpt-5.6-sol", second = fallbackFor(first);   // -> gpt-5.6-terra
    setUnavailableSeats({ [first]: "reason A", [second]: "reason B" });
    const r = resolveServingModel(first);
    assert.equal(r.servedId, fallbackFor(second), "should have chased past the also-dead first fallback");
    assert.equal(r.substituted, true);
    assert.equal(r.chain.length, 2);
  } finally { setUnavailableSeats({}); }
});

await t("resolveServingModel: an unknown id resolves to nothing invented", () => {
  const r = resolveServingModel("totally/made-up-model");
  assert.equal(r.servedId, "");
  assert.equal(r.substituted, false);
});

await t("isSeatUnavailable / unavailableReason / getUnavailableSeats round-trip cleanly", () => {
  try {
    assert.equal(isSeatUnavailable("anthropic/claude-haiku-4-5"), false);
    setUnavailableSeats({ "anthropic/claude-haiku-4-5": "test reason" });
    assert.equal(isSeatUnavailable("anthropic/claude-haiku-4-5"), true);
    assert.equal(unavailableReason("anthropic/claude-haiku-4-5"), "test reason");
    assert.deepEqual(getUnavailableSeats(), { "anthropic/claude-haiku-4-5": "test reason" });
  } finally { setUnavailableSeats({}); }
  assert.equal(isSeatUnavailable("anthropic/claude-haiku-4-5"), false, "state must not leak after reset");
});

// ---- 4: catalogPayload() hides unavailable seats and restores them -------------------------------

await t("catalogPayload() hides a seat the audit marked unavailable, and restores it when cleared", () => {
  const before = catalogPayload();
  const beforeCount = before.count;
  const findRow = (payload, id) => payload.groups.flatMap((g) => g.models).find((m) => m.id === id);
  assert.ok(findRow(before, "minimax/minimax-m3"), "minimax should be visible before any audit runs");
  try {
    setUnavailableSeats({ "minimax/minimax-m3": "live probe timed out (test)" });
    const during = catalogPayload();
    assert.ok(!findRow(during, "minimax/minimax-m3"), "an unavailable seat must not appear in /api/models");
    assert.equal(during.count, beforeCount - 1);
    assert.equal(during.hiddenCount, 1);
    // MODEL_IDS (the security allow-list) is untouched — hiding is a picker concern, not a ban.
    assert.ok(isCatalogModel("minimax/minimax-m3"), "a hidden seat must still be callable if a request already knows the id");
  } finally { setUnavailableSeats({}); }
  const after = catalogPayload();
  assert.ok(findRow(after, "minimax/minimax-m3"), "the seat must come back once the audit state clears");
  assert.equal(after.count, beforeCount);
  assert.equal(after.hiddenCount, 0);
});

await t("catalogPayload() hiding a whole category leaves no empty group", () => {
  // Vision / Multimodal currently holds 2 seats: minimax-m3 and nemotron-3-nano-omni. Hide both and
  // the category itself must vanish from `groups`, not linger as an empty shell.
  try {
    setUnavailableSeats({ "minimax/minimax-m3": "test", "nvidia/nemotron-3-nano-omni-30b-a3b": "test" });
    const payload = catalogPayload();
    assert.ok(!payload.groups.some((g) => g.category === "Vision / Multimodal"), "an all-hidden category must be dropped, not left empty");
  } finally { setUnavailableSeats({}); }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
