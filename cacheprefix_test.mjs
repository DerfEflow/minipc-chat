/*
 * Pins the prompt-cache prefix invariant (SOW Phase 0, fix 2026-08-03) so it cannot silently
 * regress: turn N+1's request must be a byte-stable extension of turn N's, with the volatile
 * EXECUTION MANAGER directive riding only as the tail behind history.
 *
 * The defect this guards against sat in production from at least 07-19 to 08-03: the directive
 * (carrying the turn's goal) was concatenated into the SYSTEM message, so message zero changed on
 * every request and no provider ever cached a byte. Zero hits, app-wide, at DeepSeek's ~1/120th
 * cached-input price. One innocent `s += goal` anywhere ahead of history brings it back, which is
 * exactly the kind of edit that reads harmless in review.
 *
 * Delegates to cacheprefix_probe.mjs, which boots the REAL server against a local capture
 * endpoint and diffs the actual request bodies. Nothing reaches a provider; nothing is billed.
 * Heavier than a unit test, same weight as the other boot-the-server suites here, and the only
 * honest way to test bytes-on-the-wire: a unit test of a prompt HELPER cannot see an assembly-site
 * mistake, and the assembly site is where this bug lived.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODELS } from "./models.catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(HERE, "cacheprefix_probe.mjs")], { encoding: "utf8", timeout: 150000 });
const out = String((r.stdout || "") + (r.stderr || ""));

if (r.status !== 0) {
  console.error(out.trim().split("\n").slice(-25).join("\n"));
  console.error("\ncacheprefix_test: FAILED — the prompt prefix churned (or the directive vanished); see above.");
  process.exit(1);
}
if (!/PREFIX STABLE/.test(out)) {
  console.error(out.trim().split("\n").slice(-25).join("\n"));
  console.error("\ncacheprefix_test: FAILED — probe exited 0 without declaring the prefix stable.");
  process.exit(1);
}
console.log("cacheprefix_test: turn 2 extends turn 1 byte-for-byte; the volatile directive rides only behind history");

/*
 * ==== CACHE COST MATH (wargame C3: the discount gets double-counted) ====
 *
 * The failure this pins is quiet and expensive in either direction. Bill the cached tokens at the
 * hit rate AND leave them in the fresh-input total and every cached turn overcharges. Subtract them
 * twice and Dominion eats the difference. Neither shows up anywhere except a bill.
 *
 * catalogCallCost is a module-private function in server.mjs, and importing server.mjs starts a
 * listening server plus its timers, which is why nothing here does that (it has burned a past
 * session in this repo). The function is lifted out of the source text by brace matching and
 * evaluated on its own, so this exercises the REAL production arithmetic rather than a copy of it
 * that could drift silently. Rates come from the catalog, which models_pricing_test.mjs pins;
 * they are read here and never written.
 */
function lift(name, src) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "server.mjs no longer defines " + name + "; the cost-math test needs rewiring");
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) { end = k + 1; break; }
  }
  assert.ok(end > 0, "could not brace-match " + name);
  return src.slice(start, end);
}
const serverSrc = readFileSync(join(HERE, "server.mjs"), "utf8");
const catalogCallCost = new Function(
  lift("fastMultiplierFor", serverSrc) + "\n" + lift("catalogCallCost", serverSrc) + "\nreturn catalogCallCost;",
)();

const rec = MODELS.find((m) => m.id === "deepseek/deepseek-v4-pro");
assert.ok(rec && typeof rec.cacheHitCost === "number", "V4 Pro must carry a cacheHitCost for this test to mean anything");

let costPassed = 0;
const c = (name, fn) => { fn(); console.log("  PASS  " + name); costPassed++; };

c("cached tokens bill at the read rate and are NOT also billed as fresh input", () => {
  const inTok = 10_000, cached = 8_000, outTok = 100;
  const got = catalogCallCost(rec, { prompt_tokens: inTok, completion_tokens: outTok, prompt_cache_hit_tokens: cached });
  const want = ((inTok - cached) * rec.inCost + cached * rec.cacheHitCost + outTok * rec.outCost) / 1e6;
  assert.equal(got, want);
  // The double-count this guards: the same 8,000 tokens charged at BOTH rates.
  const doubleCounted = (inTok * rec.inCost + cached * rec.cacheHitCost + outTok * rec.outCost) / 1e6;
  assert.notEqual(got, doubleCounted, "cached tokens are being billed as fresh input as well as at the hit rate");
  assert.ok(got < doubleCounted);
});

c("input tokens billed sum to exactly prompt_tokens, never more and never less", () => {
  for (const cached of [0, 1, 2_500, 9_999, 10_000]) {
    const inTok = 10_000;
    const cost = catalogCallCost(rec, { prompt_tokens: inTok, completion_tokens: 0, prompt_cache_hit_tokens: cached });
    // Solve back out how many tokens were charged at each rate; they must partition the prompt.
    const fresh = (cost * 1e6 - cached * rec.cacheHitCost) / rec.inCost;
    assert.ok(Math.abs(fresh + cached - inTok) < 1e-6, `cached=${cached}: billed ${fresh + cached} input tokens for a ${inTok}-token prompt`);
  }
});

c("only PROVIDER-COUNTED cache tokens get the discount; an uncounted turn is full freight", () => {
  const silent = catalogCallCost(rec, { prompt_tokens: 10_000, completion_tokens: 0 });
  const full = (10_000 * rec.inCost) / 1e6;
  assert.equal(silent, full, "a provider that reports no cache counters must be billed at fresh input");
});

c("a cache count larger than the prompt cannot manufacture a discount", () => {
  const absurd = catalogCallCost(rec, { prompt_tokens: 1_000, completion_tokens: 0, prompt_cache_hit_tokens: 999_999 });
  const clamped = (1_000 * rec.cacheHitCost) / 1e6;
  assert.equal(absurd, clamped, "cached tokens must clamp to the prompt size");
  assert.ok(absurd > 0);
});

c("every cache-counter shape the providers actually return is honoured", () => {
  const want = catalogCallCost(rec, { prompt_tokens: 10_000, completion_tokens: 0, prompt_cache_hit_tokens: 8_000 });
  // OpenAI + Google nest it; DeepSeek uses prompt_cache_hit_tokens; Moonshot returns cached_tokens.
  assert.equal(catalogCallCost(rec, { prompt_tokens: 10_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 8_000 } }), want);
  assert.equal(catalogCallCost(rec, { prompt_tokens: 10_000, completion_tokens: 0, cached_tokens: 8_000 }), want);
});

c("the free NVIDIA transport bills zero no matter what the catalog row says", () => {
  const paid = MODELS.find((m) => m.id === "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(catalogCallCost(paid, { prompt_tokens: 500_000, completion_tokens: 50_000, __transport: "nvidia" }), 0);
});

/*
 * ==== TWO HOLES A MUTATION TEST FOUND IN THE SIX ABOVE (review, 2026-08-03) ====
 *
 * The six assertions were run against ten hand-built mutants of catalogCallCost. Eight died. Two
 * walked out alive, and both of them move real money:
 *
 *   1. `rec.cacheHitCost ?? rec.inCost` changed to `rec.cacheHitCost || 0`. Every model WITHOUT a
 *      cacheHitCost then bills its cached tokens at nothing. That is not hypothetical: no OpenAI or
 *      Anthropic row carries the field today, and OpenAI caches automatically. Measured live on
 *      2026-08-03, gpt-4o read 9,088 of 9,364 prompt tokens from cache on turn two of a
 *      Dominion-shaped conversation. Under that mutation Dominion would eat the whole input line on
 *      every OpenAI turn. Every one of the six assertions used deepseek-v4-pro, which HAS the field,
 *      so none of them could see it.
 *   2. The fast multiplier applied unconditionally instead of only when `u.__fast` is set. That
 *      doubles the bill on every OpenAI call. None of the six passes a fast-lane usage row at all.
 *
 * These two pin the behaviour that is live TODAY. Neither asserts a rate, so neither has to change
 * when Fred approves adding cacheHitCost to the OpenAI and Anthropic rows; the first one only says
 * that an absent field means full freight rather than free, which stays true either way.
 */
/*
 * 2026-08-03: gpt-4o was the fixture here and now carries a cacheHitCost, exactly as the note
 * above anticipated. The fixture moves to an OpenRouter row, which lacks a rate for a real reason
 * rather than an oversight: cacheprobe measured OpenRouter returning cached_tokens as a field
 * shape and zero in fact, so there is no discount to name. That makes it a permanent example of
 * the case this assertion exists for, instead of one that was only waiting to be filled in.
 */
const noHitRate = MODELS.find((m) => m.provider === "openrouter" && typeof m.cacheHitCost !== "number" && m.inCost > 0);
assert.ok(noHitRate, "no rate-less priced model left in the catalog; this assertion needs a different fixture");

c("a model with NO cacheHitCost bills cached tokens at full freight, never at zero", () => {
  const inTok = 9_364, cached = 9_088;
  const got = catalogCallCost(noHitRate, { prompt_tokens: inTok, completion_tokens: 0, prompt_tokens_details: { cached_tokens: cached } });
  assert.equal(got, (inTok * noHitRate.inCost) / 1e6, "an absent cacheHitCost must fall back to inCost, not to 0");
  assert.ok(got > 0, "cached tokens on a model with no hit rate must still cost something");
  // The failure this guards: the fallback becoming `|| 0`, which hands the whole input line away.
  assert.notEqual(got, ((inTok - cached) * noHitRate.inCost) / 1e6);
});

c("the fast multiplier applies only to a call that ACTUALLY rode the fast lane", () => {
  const fastRec = MODELS.find((m) => m.fastTier && typeof m.inCost === "number");
  assert.ok(fastRec, "no fast-tier model in the catalog; this assertion needs rewiring");
  const u = { prompt_tokens: 10_000, completion_tokens: 1_000 };
  const standard = catalogCallCost(fastRec, u);
  const fast = catalogCallCost(fastRec, { ...u, __fast: true });
  const mult = Number.isFinite(Number(fastRec.fastMultiplier)) && Number(fastRec.fastMultiplier) >= 1 ? Number(fastRec.fastMultiplier) : 2;
  assert.ok(standard > 0);
  assert.equal(fast, standard * mult, "a fast-lane call must bill at the multiplier");
  assert.notEqual(standard, fast, "a standard call is being billed at fast-lane rates");
});

console.log(`cacheprefix_test: cache cost math, ${costPassed} assertions passed, 0 failed`);
