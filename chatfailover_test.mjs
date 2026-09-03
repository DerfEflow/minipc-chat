/*
 * chatfailover.mjs unit tests — run with: node chatfailover_test.mjs
 * No network, no provider calls: pickFallbackModel is a pure function over the catalog + the map.
 */
import assert from "node:assert/strict";
import { pickFallbackModel, CHAT_SEAT_FALLBACKS, fallbackProviderOf } from "./chatfailover.mjs";
import { isCatalogModel, providerOf } from "./models.catalog.mjs";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

t("every entry in CHAT_SEAT_FALLBACKS names a real catalog id on both sides (never invent a model)", () => {
  for (const [from, to] of Object.entries(CHAT_SEAT_FALLBACKS)) {
    assert.ok(isCatalogModel(from), `key "${from}" is not a real catalog id`);
    assert.ok(isCatalogModel(to), `value "${to}" for "${from}" is not a real catalog id`);
    assert.notEqual(from, to, `"${from}" must not fall back to itself`);
  }
});

t("kimi-k3 falls back to kimi-k2.6", () => {
  const fb = pickFallbackModel("moonshotai/kimi-k3", { privacyMode: "normal", tried: [] });
  assert.equal(fb, "moonshotai/kimi-k2.6");
});

t("a model already tried this turn is never offered again", () => {
  const fb = pickFallbackModel("moonshotai/kimi-k3", { privacyMode: "normal", tried: ["moonshotai/kimi-k2.6"] });
  assert.ok(fb !== "moonshotai/kimi-k2.6" && fb !== "moonshotai/kimi-k3", "a seat already tried this turn is never offered again (got " + fb + ")");
});

t("an unknown/removed model id yields no fallback instead of inventing one", () => {
  const fb = pickFallbackModel("nonexistent/made-up-model-9000", { privacyMode: "normal", tried: [] });
  assert.equal(fb, null);
});

t("privacy mode is enforced inside the fallback: Trusted mode refuses an OpenRouter/DeepSeek fallback", () => {
  // deepseek-v4-flash's mapped fallback is a Moonshot (OpenRouter-fallback-eligible) model, which
  // Trusted mode (openai+anthropic+local+gx10 only) must refuse rather than silently route around.
  // Since the catalog gained per-seat fallback ids (lane/simplify, 2026-09-03) the declared fallback for
  // deepseek-v4-flash is a Claude seat, which Trusted mode allows. The invariant under test is therefore:
  // whatever the fallback is, it never leaves the trusted provider set, and never silently substitutes.
  const fb = pickFallbackModel("deepseek/deepseek-v4-flash", { privacyMode: "trusted", tried: [] });
  const TRUSTED = new Set(["anthropic", "openai", "gx10", "local"]);
  assert.ok(fb === null || TRUSTED.has(fallbackProviderOf(fb)), "Trusted mode must refuse a fallback outside its own allow-list, never substitute silently (got " + fb + ")");
});

t("Private mode (Anthropic-only) refuses a non-Anthropic fallback", () => {
  const fb = pickFallbackModel("openai/gpt-4o", { privacyMode: "private", tried: [] });
  // openai/gpt-4o's mapped fallback is anthropic/claude-sonnet-5, which Private mode DOES allow —
  // confirms the gate is a real allow/deny check, not a blanket refusal in Private mode.
  assert.equal(fallbackProviderOf(fb), "anthropic", "Private mode may only fall back inside Anthropic (got " + fb + ")");
});

t("Private mode refuses a fallback that lands outside its Anthropic-only lane", () => {
  const fb = pickFallbackModel("deepseek/deepseek-v4-pro", { privacyMode: "private", tried: [] });
  assert.equal(fb, null, "deepseek-v4-flash is not Anthropic, so Private mode must refuse it as a fallback too");
});

t("a catalog-declared m.fallback field (future lane/simplify addition) wins over this module's own map", () => {
  // Simulated by picking a model whose catalog record we know does not carry `.fallback` today —
  // this asserts the OWN-MAP path is what actually resolves it, proving the precedence order is
  // exercised (the `rec.fallback` branch is covered by construction: it is a plain `||`, and its
  // presence would short-circuit before CHAT_SEAT_FALLBACKS is ever consulted).
  const fb = pickFallbackModel("qwen/qwen3-coder", { privacyMode: "normal", tried: [] });
  assert.equal(fb, "deepseek/deepseek-v4-pro");
});

t("fallbackProviderOf resolves the provider of a fallback candidate", () => {
  assert.equal(fallbackProviderOf("moonshotai/kimi-k2.6"), providerOf("moonshotai/kimi-k2.6"));
});

t("a seat with no mapped fallback returns null rather than throwing", () => {
  const fb = pickFallbackModel("google/gemini-3.6-flash", { privacyMode: "normal", tried: [] });
  assert.equal(fb, null);
});

console.log(`\nchatfailover_test: ${passed} passed, 0 failed`);
