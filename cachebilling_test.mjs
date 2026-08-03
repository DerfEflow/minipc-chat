/*
 * Prompt-cache billing, both directions. Run: node cachebilling_test.mjs
 *
 * cacheprobe.mjs measured, on 2026-08-03, that the catalog splits three ways:
 *   automatic and working   deepseek, moonshot, openai-direct
 *   only on request         anthropic, which caches ONLY behind a cache_control breakpoint
 *   nothing at all          google, nvidia, openrouter (counters absent or reported as zero)
 *
 * Two faults came out of that, one in each direction, and this suite pins both.
 *
 * OVERCHARGE. Every OpenAI-direct row was missing cacheHitCost, so catalogCallCost fell back to
 * inCost and billed a half-price token at full freight. gpt-4o returns ~4,350 cached tokens a
 * turn, which is roughly $20 per thousand turns taken from customers for a discount OpenAI had
 * already given.
 *
 * UNDERCHARGE. Anthropic reports input_tokens EXCLUDING cache reads and writes, and every cost
 * path here is written against the OpenAI shape. Untranslated, a cached Anthropic turn bills its
 * cache reads at nothing. That fault could not fire while Anthropic caching was broken; the
 * breakpoint that fixes the first fault is what arms the second, so they belong in one suite.
 *
 * catalogCallCost is module-private in server.mjs and importing server.mjs starts a listening
 * server (that has burned a session in this repo), so it is lifted out by brace matching and run
 * on its own. Same technique as cacheprefix_test.mjs, and it exercises the real arithmetic rather
 * than a copy that could drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODELS } from "./models.catalog.mjs";
import { buildAnthropicMessagesPayload } from "./anthropicmessages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function lift(name, src) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "server.mjs no longer defines " + name + "; this test needs rewiring");
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (!depth) { end = k + 1; break; } }
  }
  assert.ok(end > 0, "could not find the end of " + name);
  return src.slice(start, end);
}
const serverSrc = readFileSync(join(HERE, "server.mjs"), "utf8");
const catalogCallCost = new Function(
  lift("fastMultiplierFor", serverSrc) + "\n" + lift("catalogCallCost", serverSrc) + "\nreturn catalogCallCost;",
)();

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
};
const row = (id) => {
  const r = MODELS.find((m) => m.id === id);
  assert.ok(r, "catalog row missing: " + id);
  return r;
};

/* ---- the overcharge --------------------------------------------------------------------- */

t("every provider that actually caches carries a read rate", () => {
  // Deliberately NOT every row. nvidia bills zero by transport and returns no counters at all;
  // openrouter reports cached_tokens as a shape and zero in fact. A rate there would be fiction.
  const caching = MODELS.filter((m) => ["openai", "anthropic", "deepseek", "moonshot", "google"].includes(m.provider));
  const bare = caching.filter((m) => typeof m.cacheHitCost !== "number").map((m) => m.id);
  assert.deepEqual(bare, [],
    "these bill discounted tokens at full input price, which is money taken from customers: " + bare.join(", "));
});

t("a read rate is a DISCOUNT, never above fresh input", () => {
  for (const m of MODELS) {
    if (typeof m.cacheHitCost !== "number") continue;
    assert.ok(m.cacheHitCost >= 0, m.id + " has a negative cache rate");
    assert.ok(m.cacheHitCost <= (m.inCost || 0), m.id + " charges MORE for a cached token than a fresh one");
  }
});

t("gpt-4o's cached tokens stop being billed as fresh input", () => {
  const rec = row("openai/gpt-4o");
  const inTok = 10_000, cached = 4_350, outTok = 500;
  const u = { prompt_tokens: inTok, completion_tokens: outTok, prompt_tokens_details: { cached_tokens: cached } };
  const got = catalogCallCost(rec, u);
  const want = ((inTok - cached) * rec.inCost + cached * rec.cacheHitCost + outTok * rec.outCost) / 1e6;
  assert.equal(got, want);
  const oldBehaviour = (inTok * rec.inCost + outTok * rec.outCost) / 1e6;
  assert.ok(got < oldBehaviour, "the fix must actually reduce the charge");
  // The measured shape of the overcharge: ~4,350 cached tokens a turn, 1,000 turns.
  const perThousandTurns = (oldBehaviour - got) * 1000;
  assert.ok(perThousandTurns > 4, "expected a material refund per thousand turns, got $" + perThousandTurns.toFixed(2));
});

/* ---- the undercharge ------------------------------------------------------------------- */

t("Anthropic rows carry a WRITE rate too, because Anthropic is the only one that charges for it", () => {
  for (const m of MODELS.filter((x) => x.provider === "anthropic")) {
    assert.equal(typeof m.cacheWriteCost, "number", m.id + " has no cacheWriteCost, so a cache write bills as plain input");
    assert.ok(m.cacheWriteCost > m.inCost, m.id + " must charge MORE to write a cache entry than to send fresh input");
  }
});

t("the Anthropic ratios match the rates already proven in videoSonnetCost", () => {
  // videoSonnetCost bills Sonnet 5 at cacheRead 0.3 and cache5m 3.75 against a 3.00 input, which
  // is 0.1x and 1.25x. Those are the only Anthropic cache rates independently verified in this
  // repo, so the catalog is held to them rather than to anything I could have mistyped.
  assert.match(serverSrc, /cacheRead:\s*0\.3\b/, "videoSonnetCost's post-intro read rate moved; re-derive the catalog ratios");
  assert.match(serverSrc, /cache5m:\s*3\.75\b/, "videoSonnetCost's post-intro write rate moved; re-derive the catalog ratios");
  for (const m of MODELS.filter((x) => x.provider === "anthropic")) {
    assert.ok(Math.abs(m.cacheHitCost - m.inCost * 0.1) < 1e-9, m.id + " read rate is not 1/10 of input");
    assert.ok(Math.abs(m.cacheWriteCost - m.inCost * 1.25) < 1e-9, m.id + " write rate is not 1.25x input");
  }
});

t("a cache WRITE is billed as a write, not as ordinary input", () => {
  const rec = row("anthropic/claude-haiku-4-5");
  const inTok = 10_000, written = 6_000, outTok = 300;
  const u = { prompt_tokens: inTok, completion_tokens: outTok, cache_creation_input_tokens: written };
  const got = catalogCallCost(rec, u);
  const want = ((inTok - written) * rec.inCost + written * rec.cacheWriteCost + outTok * rec.outCost) / 1e6;
  assert.equal(got, want);
  const asPlainInput = (inTok * rec.inCost + outTok * rec.outCost) / 1e6;
  assert.ok(got > asPlainInput, "a write costs 1.25x, so ignoring it undercharges and Dominion eats the difference");
});

t("reads and writes in the same turn are each billed once, at their own rate", () => {
  const rec = row("anthropic/claude-sonnet-5");
  const inTok = 20_000, cached = 12_000, written = 3_000, outTok = 400;
  const u = {
    prompt_tokens: inTok, completion_tokens: outTok,
    prompt_tokens_details: { cached_tokens: cached }, cache_creation_input_tokens: written,
  };
  const got = catalogCallCost(rec, u);
  const fresh = inTok - cached - written;
  const want = (fresh * rec.inCost + cached * rec.cacheHitCost + written * rec.cacheWriteCost + outTok * rec.outCost) / 1e6;
  assert.equal(got, want);
  assert.ok(got < (inTok * rec.inCost + outTok * rec.outCost) / 1e6,
    "a mostly-cached turn must still come out cheaper than an uncached one");
});

t("a provider with no write fee is completely unaffected by the write term", () => {
  const rec = row("deepseek/deepseek-v4-pro");
  assert.equal(typeof rec.cacheWriteCost, "undefined", "DeepSeek charges nothing to write; a rate here would be invented");
  const u = { prompt_tokens: 9_000, completion_tokens: 100, prompt_cache_hit_tokens: 7_000 };
  const want = ((9_000 - 7_000) * rec.inCost + 7_000 * rec.cacheHitCost + 100 * rec.outCost) / 1e6;
  assert.equal(catalogCallCost(rec, u), want);
});

t("a write can never be counted inside the cached slice", () => {
  // A provider double-reporting the same tokens as both read and written must not bill twice.
  const rec = row("anthropic/claude-opus-4-8");
  const u = {
    prompt_tokens: 5_000, completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 5_000 }, cache_creation_input_tokens: 5_000,
  };
  const got = catalogCallCost(rec, u);
  assert.equal(got, (5_000 * rec.cacheHitCost) / 1e6, "the overlap must resolve to reads only, never reads plus writes");
});

/* ---- the breakpoint that makes any of it happen ----------------------------------------- */

t("the Anthropic payload carries a cache_control breakpoint on the system prompt", () => {
  const payload = buildAnthropicMessagesPayload("claude-haiku-4-5-20251001", [
    { role: "system", content: "You are Dominion." },
    { role: "user", content: "hello" },
  ]);
  assert.ok(Array.isArray(payload.system),
    "system must be an array of blocks; a bare string has nowhere to hang cache_control");
  const last = payload.system[payload.system.length - 1];
  assert.deepEqual(last.cache_control, { type: "ephemeral" },
    "without this marker Anthropic caches NOTHING: two identical turns both bill full freight (cacheprobe 2026-08-03)");
  assert.match(last.text, /You are Dominion\./, "the system text itself must survive the wrapping");
});

t("the breakpoint sits at the END, so it covers the tool definitions as well", () => {
  // Anthropic matches the prefix as tools -> system -> messages, so one marker at the end of
  // system caches the tool array too. The tool array is the larger half, up to 128 schemas.
  const payload = buildAnthropicMessagesPayload("claude-haiku-4-5-20251001", [
    { role: "system", content: "A" },
    { role: "user", content: "B" },
  ]);
  const marked = payload.system.filter((b) => b && b.cache_control);
  assert.equal(marked.length, 1, "exactly one breakpoint; four are allowed and more than one here buys nothing");
  assert.equal(payload.system[payload.system.length - 1], marked[0], "it has to be the LAST block or it caches less");
});

t("a turn with no system prompt does not grow an empty cached block", () => {
  const payload = buildAnthropicMessagesPayload("claude-haiku-4-5-20251001", [{ role: "user", content: "hi" }]);
  assert.ok(!payload.system || (Array.isArray(payload.system) && payload.system.length === 0),
    "an empty system array is a wasted field and an empty cache entry");
});

console.log("\ncachebilling: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
