/*
 * Wildfire roster self-test - run with: node wildfire_test.mjs
 *
 * The roster is a list of string ids, which is exactly the kind of thing that rots silently: a
 * catalog rename unstars a model and nobody notices until Fred picks it for a big job and watches
 * it sit on its hands. This asserts the roster against the live catalog every run.
 */
import assert from "node:assert/strict";
import { MODELS, isBroadCapable, broadCapableIds, broadCapableNames, isToolCapable, modelById } from "./models.catalog.mjs";

let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };

const EXPECTED = [
  "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5",
  "moonshotai/kimi-k3", "moonshotai/kimi-k2.6",
  "deepseek/deepseek-v4-pro", "deepseek/deepseek-r1",
  "qwen/qwen3-235b-a22b-2507", "qwen/qwen3-coder",
  "x-ai/grok-4.20", "z-ai/glm-5.2", "openai/gpt-4o",
  "nvidia/nemotron-3-ultra-550b-a55b",
];

// 1. every rostered id still exists in the catalog
{
  const all = new Set(MODELS.map((m) => m.id));
  const missing = EXPECTED.filter((id) => !all.has(id));
  assert.deepEqual(missing, [], "rostered ids missing from the catalog: " + missing.join(", "));
  ok("all 13 rostered ids exist in the catalog");
}

// 2. all 13 actually arm
{
  const armed = broadCapableIds();
  assert.equal(armed.length, 13, "expected 13 armed, got " + armed.length + ": " + armed.join(", "));
  for (const id of EXPECTED) assert.equal(isBroadCapable(id), true, id + " should be broad-capable");
  ok("all 13 resolve as broad-capable");
}

// 3. tool capability is a hard prerequisite
{
  for (const id of EXPECTED) assert.equal(isToolCapable(id), true, id + " is rostered but not tool-capable");
  ok("every rostered model is tool-capable (prerequisite holds)");
}

// 4. Fred's explicit exclusions stay excluded
{
  // GPT-5.6 Sol: dropped at his direction because tools force reasoning off on that path.
  assert.equal(isBroadCapable("openai/gpt-5.6-sol"), false, "GPT-5.6 Sol must NOT be starred (Fred's call)");
  assert.equal(isBroadCapable("openai/gpt-5.6-terra"), false);
  assert.equal(isBroadCapable("openai/gpt-5.5"), false);
  ok("the GPT-5 family stays off the roster, per Fred's ruling");
}

// 5. small and chat-only models never arm, even the tool-capable ones
{
  for (const id of ["mistralai/mistral-nemo", "qwen/qwen3-8b", "google/gemma-4-31b-it:free",
                    "perplexity/sonar-pro", "allenai/olmo-3-32b-think"]) {
    if (!modelById(id)) continue;   // catalog drift on a non-rostered id is not this test's business
    assert.equal(isBroadCapable(id), false, id + " must not be broad-capable");
  }
  ok("small, free and chat-only models never arm");
}

// 6. a model that is not in the catalog at all cannot arm
{
  assert.equal(isBroadCapable("totally/made-up-model"), false);
  assert.equal(isBroadCapable(""), false);
  assert.equal(isBroadCapable(null), false);
  ok("unknown or empty model ids never arm");
}

// 7. the names list is usable in the refusal message
{
  const names = broadCapableNames();
  assert.equal(names.length, 13);
  assert.ok(names.every((n) => typeof n === "string" && n.length), "names must be human-facing");
  ok("broadCapableNames returns 13 usable display names");
}

console.log(`\n${passed}/7 checks passed - Wildfire roster verified against the live catalog`);
