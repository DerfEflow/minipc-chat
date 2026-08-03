import assert from "node:assert/strict";
import { modelById, outLimitFor } from "./models.catalog.mjs";

const deepSeekPro = modelById("deepseek/deepseek-v4-pro");
const deepSeekFlash = modelById("deepseek/deepseek-v4-flash");
const opus = modelById("anthropic/claude-opus-4-8");
const sonnet = modelById("anthropic/claude-sonnet-5");
const haiku = modelById("anthropic/claude-haiku-4-5");

assert.equal(deepSeekPro.ctx, 1_000_000);
assert.equal(deepSeekPro.maxOut, 384_000);
assert.equal(deepSeekFlash.maxOut, 384_000);
assert.equal(deepSeekPro.reasoning, true);

assert.equal(opus.ctx, 1_000_000);
assert.equal(opus.maxOut, 128_000);
assert.equal(sonnet.ctx, 1_000_000);
assert.equal(sonnet.maxOut, 128_000);
assert.equal(haiku.ctx, 200_000);
assert.equal(haiku.maxOut, 64_000);

assert.equal(
  outLimitFor("deepseek/deepseek-v4-pro", "normal"),
  deepSeekPro.maxOut,
  "Normal mode must not impose a hidden Dominion output ceiling",
);
assert.equal(
  outLimitFor("anthropic/claude-opus-4-8", "tool"),
  opus.maxOut,
  "work modes must receive the selected model's native output window",
);
assert.equal(outLimitFor("deepseek/deepseek-v4-pro", "fast"), 2_048);

/*
 * Starvation floors (measured 2026-08-03, twice; docs/MODEL-RECORDS.json). A reasoning model whose
 * hidden thinking bills against the output budget can burn fast mode's whole 2048 and return an
 * EMPTY string. Fred, 2026-08-03: "Ban R1 from fast mode." The floor mechanism implements the ban
 * and extends it to every model measured to starve, with 4x margin because the floors moved
 * between runs.
 */
assert.equal(outLimitFor("deepseek/deepseek-r1", "fast"), 8_192,
  "R1 produced no text at any ceiling up to 2048; fast mode must never hand it the 2048 cap");
assert.equal(outLimitFor("arcee-ai/trinity-large-thinking", "fast"), 8_192,
  "Trinity's worst measured floor equalled the fast cap exactly; no margin is not a setting");
assert.equal(outLimitFor("moonshotai/kimi-k2.6", "fast"), 4_096,
  "Kimi K2.6 needed 1024 once; 4x margin because the floors move");
assert.equal(outLimitFor("openai/gpt-oss-20b", "fast"), 4_096,
  "the Simplify general-chat seat must never be handed a ceiling it starves under");
// The floor only RAISES a mode ceiling; it never widens a model whose floor sits below the cap
// (v4-pro's floor is 1024, under fast's 2048: the 2048 assertion above stays true), and it never
// touches modes without a ceiling:
assert.equal(outLimitFor("deepseek/deepseek-r1", "normal"), modelById("deepseek/deepseek-r1").maxOut,
  "normal mode already gives R1 its full native window; the floor changes nothing there");

console.log("model execution limits: 19 assertions passed, 0 failed");
