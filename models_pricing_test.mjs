/*
 * Catalog prices, pinned.
 *
 * Every number in here is charged to a customer. A price that drifts by a typo does not throw, does
 * not log, and does not show up anywhere except a bill, so the only defence is a test that states
 * the published figures out loud and fails when they change. Changing a price should require
 * editing this file too, deliberately.
 *
 * OpenAI's 2026-07-30 cut is the current pinned state: Luna down 80%, Terra down 20%, Sol
 * unchanged, and Fast mode (service_tier "fast") introduced at exactly 2x the standard price.
 */
import assert from "node:assert/strict";
import { MODELS as CATALOG } from "./models.catalog.mjs";

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };
const byId = (id) => {
  const r = CATALOG.find((m) => m.id === id);
  assert.ok(r, "catalog is missing " + id);
  return r;
};

t("GPT-5.6 prices match OpenAI's published rates of 2026-07-30", () => {
  // Announced: Luna $0.20/$1.20 per million, Terra $2/$12 per million.
  const luna = byId("openai/gpt-5.6-luna");
  assert.equal(luna.inCost, 0.20, "Luna input is $0.20 per million");
  assert.equal(luna.outCost, 1.20, "Luna output is $1.20 per million");

  const terra = byId("openai/gpt-5.6-terra");
  assert.equal(terra.inCost, 2.00, "Terra input is $2 per million");
  assert.equal(terra.outCost, 12.00, "Terra output is $12 per million");

  // Sol was NOT part of the cut. If this fails, someone moved a price that OpenAI did not.
  const sol = byId("openai/gpt-5.6-sol");
  assert.equal(sol.inCost, 5.00, "Sol input is unchanged at $5 per million");
  assert.equal(sol.outCost, 30.00, "Sol output is unchanged at $30 per million");
});

t("the cut is exactly the announced percentage off the previous rates", () => {
  // The rows this replaced were Luna 1.00/6.00 and Terra 2.50/15.00. Reconciling the deltas against
  // the announced percentages cross-checks the new numbers AND the ones that were already here.
  const luna = byId("openai/gpt-5.6-luna"), terra = byId("openai/gpt-5.6-terra");
  assert.equal(Math.round((1 - luna.inCost / 1.00) * 100), 80, "Luna input fell 80%");
  assert.equal(Math.round((1 - luna.outCost / 6.00) * 100), 80, "Luna output fell 80%");
  assert.equal(Math.round((1 - terra.inCost / 2.50) * 100), 20, "Terra input fell 20%");
  assert.equal(Math.round((1 - terra.outCost / 15.00) * 100), 20, "Terra output fell 20%");
});

t("Luna is the cheapest OpenAI seat, by a wide margin", () => {
  /*
   * The first draft of this test asserted Luna was the cheapest PAID model in the entire catalog
   * and failed: five OpenRouter seats undercut it. The assumption was wrong, the catalog was
   * right, and the corrected claim is the one that actually matters for routing advice.
   */
  const luna = byId("openai/gpt-5.6-luna");
  const openai = CATALOG.filter((m) => m.provider === "openai" && (m.inCost || 0) > 0);
  const lunaTotal = luna.inCost + luna.outCost;
  for (const m of openai) {
    if (m.id === luna.id) continue;
    assert.ok(m.inCost + m.outCost > lunaTotal, m.id + " should not undercut Luna on OpenAI's own lane");
  }
  // A tenth of Terra and a twenty-fifth of Sol: the reason high-volume work moves here.
  assert.ok(lunaTotal * 9 < byId("openai/gpt-5.6-terra").inCost + byId("openai/gpt-5.6-terra").outCost,
    "Luna should be roughly an order of magnitude under Terra");
});

t("Fast mode is offered only where OpenAI guarantees it, and at exactly 2x", () => {
  const fast = CATALOG.filter((m) => m.fastTier);
  assert.deepEqual(fast.map((m) => m.id), ["openai/gpt-5.6-sol"],
    "the announcement gives the 2.5x speed guarantee for Sol alone");
  for (const m of fast) {
    assert.equal(m.fastMultiplier, 2, m.id + " fast mode is exactly twice the standard price");
    assert.equal(m.provider, "openai", "service_tier is an OpenAI concept");
  }
});

t("every model that does NOT offer fast mode is unmarked, not defaulted", () => {
  // A model silently inheriting fastTier would bill double for a lane it never rode.
  for (const m of CATALOG) {
    if (m.id === "openai/gpt-5.6-sol") continue;
    assert.ok(!m.fastTier, m.id + " must not claim a fast tier it does not have");
  }
});

t("Gemini prices match Google's published AI Studio rates of 2026-08-03", () => {
  // Read from ai.google.dev/gemini-api/docs/pricing the day the lane was wired. The oddity worth
  // pinning on purpose: 3.6 Flash is newer AND cheaper on output than 3.5 Flash ($7.50 vs $9.00),
  // which is why 3.5 Flash holds no catalog seat at all.
  const flash = byId("google/gemini-3.6-flash");
  assert.equal(flash.inCost, 1.50, "3.6 Flash input is $1.50 per million");
  assert.equal(flash.outCost, 7.50, "3.6 Flash output is $7.50 per million");
  assert.equal(flash.cacheHitCost, 0.15, "3.6 Flash cached input is $0.15 per million");

  const pro = byId("google/gemini-3.1-pro-preview");
  assert.equal(pro.inCost, 2.00, "3.1 Pro input is $2 per million at the base (<=200k) tier");
  assert.equal(pro.outCost, 12.00, "3.1 Pro output is $12 per million at the base tier");

  const lite = byId("google/gemini-3.5-flash-lite");
  assert.equal(lite.inCost, 0.30, "Flash-Lite input is $0.30 per million");
  assert.equal(lite.outCost, 2.50, "Flash-Lite output is $2.50 per million");

  for (const m of [flash, pro, lite]) {
    assert.equal(m.provider, "google", m.id + " rides the AI Studio lane");
    assert.ok(m.directId && !m.directId.includes("/"), m.id + " directId is the bare AI Studio id");
  }
});

/*
 * DeepSeek R1's limits, pinned to what the WIRE enforces rather than what the model page advertises.
 * Both numbers here were wrong on 2026-08-09 and every R1 call failed because of it. They are pinned
 * with the evidence so nobody "corrects" them back up to the advertised figures:
 *   maxOut 16000 - OpenRouter's max_completion_tokens for this endpoint. The old 16384 asked for
 *                  more output than the model will ever return.
 *   ctx    64000 - the limit the serving provider actually enforced ("this endpoint's maximum
 *                  context length is 64000 tokens"). OpenRouter's advertised 163840 is the best
 *                  case across providers, not a guarantee for the one that takes your call, and
 *                  trusting it made the router escalate into long_context and then blow the limit.
 */
t("DeepSeek R1's window and output cap match what the endpoint enforces, not what it advertises", () => {
  const r1 = byId("deepseek/deepseek-r1");
  assert.equal(r1.maxOut, 16000, "R1 output cap must not exceed OpenRouter's max_completion_tokens");
  assert.equal(r1.ctx, 64000, "R1 context must be the enforced floor, not the advertised 163840");
  // The failure mode was a request whose input + output together crossed the endpoint limit, so the
  // reserve has to be real: a full-size answer must still leave room for a prompt.
  assert.ok(r1.maxOut < r1.ctx / 2, "R1 must reserve most of its window for input, not output");
  // No provider field = OpenRouter (finalize defaults it). R1 has no direct or NVIDIA route, so if
  // this ever gains a provider the routing assumption above needs revisiting.
  assert.equal(r1.provider, "openrouter", "R1 is reachable only through OpenRouter");
});

t("no catalog row carries a negative or absurd price", () => {
  for (const m of CATALOG) {
    const i = Number(m.inCost), o = Number(m.outCost);
    assert.ok(Number.isFinite(i) && i >= 0, m.id + " has a broken input price: " + m.inCost);
    assert.ok(Number.isFinite(o) && o >= 0, m.id + " has a broken output price: " + m.outCost);
    // A per-million price above $500 is a decimal-point slip, not a real rate.
    assert.ok(i < 500 && o < 500, m.id + " price looks like a decimal slip: " + i + "/" + o);
  }
});

console.log(`\n${passed}/8 checks passed - the published prices are pinned, and fast mode costs what it costs`);
