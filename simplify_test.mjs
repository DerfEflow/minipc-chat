/*
 * Lane I self-test — run with: node simplify_test.mjs
 * Pure-function tests only (no server boot, no live model/network calls):
 *   1. Every route in SIMPLIFY_ROUTES resolves (after fallback) to a model id that EXISTS in
 *      models.catalog.mjs — the check that catches a dead route before a user finds it.
 *   2. Exactly the two routes the routing doc flags as unseated (safety, empathetic) come back
 *      `blocked: true`; every other route is a live, direct catalog hit with no fallback.
 *   3. Sample questions land on the expected route (subject-matter classification).
 *   4. pickRoute/classifyTopic never throw on hostile input (null, undefined, numbers, emoji, deep
 *      junk) — the classifier-fuzzing concern raised for Lane E's export applies to this file's own
 *      wrapper too.
 *   5. The websearch route really points at the app's existing web_search tool (tools.mjs), not an
 *      invented one.
 *   6. dominion-simplify.js exposes no model picker to the user.
 *   7. dominion-simplify.css is structurally well-formed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODEL_IDS, isCatalogModel } from "./models.catalog.mjs";
import { toolDefs } from "./tools.mjs";
import { SIMPLIFY_ROUTES, resolveRouteModel, classifyTopic, pickRoute } from "./simplify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

// ---- 1 & 2: every route resolves to a real catalog id; blocked set matches the routing doc ------

/*
 * EMPTY ON PURPOSE, and it is the stronger assertion.
 *
 * This lane built against a routing table where `safety` and `empathetic` named models that were
 * measured alive on NVIDIA and had never been seated in models.catalog.mjs, so both fell back to
 * the chat seat. The integrator seated them on 2026-08-03 with their probed first-token latencies
 * recorded beside each row, so every route in the table is now a direct hit.
 *
 * Keep this set empty. A route reappearing here means somebody added a route naming a model the
 * catalog does not carry, and the whole point of this check is that such a route fails HERE rather
 * than in front of a user who asked a sensitive question and quietly got the general chat model.
 */
const EXPECTED_BLOCKED = new Set();

for (const routeKey of Object.keys(SIMPLIFY_ROUTES)) {
  await t(`resolveRouteModel("${routeKey}") resolves to a catalog model`, () => {
    const r = resolveRouteModel(routeKey);
    assert.ok(r.ok, `route "${routeKey}" did not resolve at all: ${r.error || ""}`);
    assert.ok(isCatalogModel(r.modelId), `route "${routeKey}" resolved to "${r.modelId}", which is NOT in models.catalog.mjs`);
    assert.ok(MODEL_IDS.has(r.modelId));
  });
}

await t("every route is a direct catalog hit; nothing falls back to a substitute seat", () => {
  for (const routeKey of Object.keys(SIMPLIFY_ROUTES)) {
    const r = resolveRouteModel(routeKey);
    if (EXPECTED_BLOCKED.has(routeKey)) {
      assert.equal(r.blocked, true, `"${routeKey}" was expected blocked (dead model id) but resolved live`);
      assert.ok(r.blockReason && r.blockReason.length > 0, `"${routeKey}" must explain why it fell back`);
    } else {
      assert.equal(r.blocked, false, `"${routeKey}" was expected a live catalog hit but came back blocked: ${r.blockReason || ""}`);
      assert.equal(r.modelId, r.requestedModel, `"${routeKey}" should need no substitution`);
    }
  }
});

await t("unknown route key is reported, never silently invented", () => {
  const r = resolveRouteModel("not-a-real-route");
  assert.equal(r.ok, false);
  assert.equal(r.modelId, "");
});

// ---- 3: sample questions land on the expected route ---------------------------------------------

const SAMPLES = [
  ["hi", "quick"],
  ["what's 2+2", "quick"],
  ["solve for x: 2x + 3 = 7", "science"],
  ["can you help me find the derivative of x^2 + 3x", "science"],
  ["should I raise my prices this quarter, my revenue has been flat", "business"],
  ["I want to kill myself", "safety"],
  ["I've been feeling really anxious and overwhelmed about my job lately", "empathetic"],
  ["write me a short story about a lighthouse keeper", "literary"],
  ["help me brainstorm a creative idea for a birthday party", "creative"],
  ["is there a god, and what is the meaning of life", "theological"],
  ["what's the weather in Denver right now", "websearch"],
  ["what's today's stock price for a company I follow", "websearch"],
];

for (const [text, expected] of SAMPLES) {
  await t(`pickRoute(${JSON.stringify(text)}) -> "${expected}"`, () => {
    const picked = pickRoute(text);
    assert.equal(picked.route, expected, `got "${picked.route}" (topic="${picked.topic}", band="${picked.complexity && picked.complexity.band}")`);
  });
}

await t("a long, general question with no specialist topic lands on chat", () => {
  const picked = pickRoute("Could you walk me through the tradeoffs between renting and buying a home over the next ten years, considering interest rates and my own situation in detail");
  assert.equal(picked.route, "chat");
});

// ---- 4: never throws on hostile input -------------------------------------------------------------

const HOSTILE_INPUTS = [null, undefined, 0, 42, NaN, "", "🔥🔥🔥 emoji only 🔥🔥🔥", { nested: { junk: [1, 2, { a: "b" }] } }, ["array", "not", "string"], true, false];

for (const bad of HOSTILE_INPUTS) {
  await t(`classifyTopic(${JSON.stringify(bad)}) never throws`, () => {
    assert.doesNotThrow(() => classifyTopic(bad));
  });
  await t(`pickRoute(${JSON.stringify(bad)}) never throws and returns a route`, () => {
    let picked;
    assert.doesNotThrow(() => { picked = pickRoute(bad); });
    assert.ok(typeof picked.route === "string" && SIMPLIFY_ROUTES[picked.route], "must resolve to a real route key");
  });
}

// ---- 5: websearch really uses the app's existing tool, not an invented one -----------------------

await t("the websearch route names a tool that actually exists in tools.mjs", () => {
  const route = SIMPLIFY_ROUTES.websearch;
  assert.equal(route.tool, "web_search");
  const defs = toolDefs();
  const names = defs.map((d) => d.function && d.function.name);
  assert.ok(names.includes("web_search"), "tools.mjs no longer defines web_search — the websearch route would be faking it");
});

// ---- 6: the surface exposes no model picker --------------------------------------------------------

await t("dominion-simplify.js renders no model picker and no model name to the user", () => {
  const src = readFileSync(join(__dirname, "public", "dominion-simplify.js"), "utf8");
  // Strip comments first: this file's own header PROSE explains, in English, that it has no model
  // picker — that sentence must not trip a check meant to catch an actual picker being built.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/<select[^>]*model/i.test(code), "found a <select> that looks like a model picker");
  assert.ok(!/createElement\(\s*["']select["']\s*\)/i.test(code), "found code building a <select> element");
  assert.ok(!/optgroup/i.test(code), "found optgroup markup (the main app's model picker uses this) — Simplify must not build one");
  assert.ok(!/\bmodelSel\b|\bmodel[-_]?id\b\s*[:=]/i.test(code), "found a model-selection variable — this surface must never expose one");
});

// ---- 7: the CSS is structurally well-formed ---------------------------------------------------------

await t("dominion-simplify.css has balanced braces and no dangling rule", () => {
  const src = readFileSync(join(__dirname, "public", "dominion-simplify.css"), "utf8");
  // A lightweight structural check, not a full CSS parser: this repo carries no CSS-parsing
  // dependency and package.json is out of this lane's ownership, so this proves the file is not
  // truncated / mismatched rather than fully validating CSS grammar.
  const opens = (src.match(/\{/g) || []).length;
  const closes = (src.match(/\}/g) || []).length;
  assert.equal(opens, closes, `unbalanced braces: ${opens} "{" vs ${closes} "}"`);
  assert.ok(opens > 0, "file has no rules at all");
  assert.ok(!/\/\*(?:(?!\*\/)[\s\S])*$/.test(src), "unterminated /* comment at end of file");
});

// ---- summary ---------------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
