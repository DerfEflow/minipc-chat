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

console.log("model execution limits: 13 assertions passed, 0 failed");
