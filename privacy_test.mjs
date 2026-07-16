/*
 * Phase-2 privacy-mode self-test — run with: node privacy_test.mjs
 * Proves the allow-list guarantee (pure logic, no server needed): every cell of the
 * mode x model-class matrix, refuse-not-substitute wording, mode normalization, and that
 * unknown/local ids are always local (never a silent egress).
 */
import assert from "node:assert/strict";
import { modeAllows, normalizeMode, classifyModel, providerAllowed, PRIVACY_MODES } from "./privacy.mjs";
import { MODELS } from "./models.catalog.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); }
}

// Pick a real catalog id per provider so the test tracks the actual catalog, not hardcoded ids.
const idFor = (prov) => (MODELS.find((m) => m.provider === prov) || {}).id;
const OR = idFor("openrouter"), DS = idFor("deepseek"), OAI = idFor("openai"), ANT = idFor("anthropic");

t("catalog has at least openrouter + openai models to test against", () => {
  assert.ok(OR, "no openrouter model in catalog");
  assert.ok(OAI, "no openai model in catalog");
});

// ---- classification ----
t("classifyModel: blank/auto/local -> local", () => {
  for (const v of ["", null, undefined, "auto", "local"]) assert.equal(classifyModel(v), "local");
});
t("classifyModel: unknown id -> local (never egresses)", () => {
  assert.equal(classifyModel("some/model-not-in-catalog"), "local");
});
t("classifyModel: a raw local qwen name -> local", () => {
  assert.equal(classifyModel("qwen3:8b"), "local");
});
t("classifyModel: catalog ids map to their provider", () => {
  assert.equal(classifyModel(OR), "openrouter");
  if (OAI) assert.equal(classifyModel(OAI), "openai");
});

// ---- mode normalization ----
t("normalizeMode: junk -> normal (documented default)", () => {
  for (const v of ["", "NORMAL", "Trusted", "PRIVATE", "bogus", null]) {
    assert.ok(PRIVACY_MODES.includes(normalizeMode(v)));
  }
  assert.equal(normalizeMode("bogus"), "normal");
  assert.equal(normalizeMode("PRIVATE"), "private");
});

// ---- the matrix ----
t("Normal: everything allowed (all providers + local)", () => {
  assert.equal(modeAllows("normal", "local").allowed, true);
  assert.equal(modeAllows("normal", OR).allowed, true);
  if (DS) assert.equal(modeAllows("normal", DS).allowed, true);
  if (OAI) assert.equal(modeAllows("normal", OAI).allowed, true);
});
t("Private: local allowed, EVERY cloud provider refused", () => {
  assert.equal(modeAllows("private", "local").allowed, true);
  assert.equal(modeAllows("private", OR).allowed, false);
  if (DS) assert.equal(modeAllows("private", DS).allowed, false);
  if (OAI) assert.equal(modeAllows("private", OAI).allowed, false);
  if (ANT) assert.equal(modeAllows("private", ANT).allowed, false);
});
t("Trusted: local + OpenAI + Anthropic allowed; OpenRouter + DeepSeek refused", () => {
  assert.equal(modeAllows("trusted", "local").allowed, true);
  if (OAI) assert.equal(modeAllows("trusted", OAI).allowed, true, "OpenAI must be allowed in Trusted");
  if (ANT) assert.equal(modeAllows("trusted", ANT).allowed, true, "Anthropic must be allowed in Trusted");
  assert.equal(modeAllows("trusted", OR).allowed, false, "OpenRouter must be refused in Trusted");
  if (DS) assert.equal(modeAllows("trusted", DS).allowed, false, "DeepSeek must be refused in Trusted");
});

// ---- refuse-not-substitute wording ----
t("a refusal carries a clear reason and never a substitute model", () => {
  const r = modeAllows("private", OR);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /refused, not substituted/i);
  assert.equal(r.modelClass, "openrouter");   // reports what was picked, does not hand back another
});
t("Trusted refusal names the blocked provider", () => {
  const r = modeAllows("trusted", OR);
  assert.match(r.reason, /OpenRouter/);
});

// ---- providerAllowed (UI filter) agrees with modeAllows ----
t("providerAllowed mirrors modeAllows across the matrix", () => {
  for (const mode of PRIVACY_MODES) {
    for (const prov of ["local", "openrouter", "deepseek", "openai", "anthropic"]) {
      const viaProvider = providerAllowed(mode, prov);
      // build a synthetic check via a real id of that provider when one exists
      const id = prov === "local" ? "local" : idFor(prov);
      if (!id) continue;
      assert.equal(viaProvider, modeAllows(mode, id).allowed, `${mode}/${prov} mismatch`);
    }
  }
});

console.log(`\nprivacy_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
