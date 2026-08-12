/*
 * altana-money self-test. Run: node altana-money_test.mjs
 *
 * The highest-consequence code in the Altana build, so this suite is written to attack it rather than
 * to demonstrate it. Fred, 2026-08-12:
 *
 *   "I want altana to be able to add credits to the users account with explicit authorization from
 *    the user, and a 'please type the amount of credits you would like to purchase' field that it
 *    follows, as well as turn on and off the top-off feature for a user with their explicit
 *    instruction, with a 'type #####' to confirm field."
 *
 * The invariant everything below exists to defend: THE MODEL NEVER SUPPLIES THE NUMBER. If a test
 * here ever has to be relaxed to let a figure reach a charge from anywhere except a human's
 * keystrokes, the relaxation is the bug.
 *
 * The store half runs against the REAL SQLite store rather than a fake, because the replay defence is
 * a property of the database write and a mock would prove nothing about it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MIN_PURCHASE_USD, MAX_PURCHASE_USD, CONFIRM_TTL_MS,
  MONEY_TOOLS, MONEY_CARVE_OUT, buyCreditsTool, setTopOffTool, readMoneyTool,
  parseTypedAmount, creditsForUsd, typedConfirmCode, codeMatches,
  confirmRequestFor, decideTypedAnswer, purchaseOutcome, topOffOutcome, topOffConsequence,
  assertMoneyToolsSafe, AMOUNT_SHAPED, PROMPTS,
} from "./altana-money.mjs";
import { createAltanaStore, ALTANA_TOOLS, screenToolCall, confirmationToken, carveOutFor } from "./altana.mjs";
import { MIN_TOPUP_USD, TOPUP_TIERS, CREDITS_PER_USD, MARKUP } from "./billing.mjs";
import { plainEnglish } from "./altana-plain.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };

/*
 * Built from a code point rather than typed, so `grep -c` for the literal character across the repo
 * stays a working house-style check. Fred's rule is that no em dash reaches his prose or the app's;
 * a test file that spelled the character out would be the one false positive in every future sweep.
 */
const EM_DASH = String.fromCharCode(0x2014);

/* ============================================================================================== *
 * 1. THE MODEL CANNOT NAME A FIGURE
 * ============================================================================================== */

console.log("\n=== the model never supplies the number ===");

t("buy_credits takes no arguments at all", () => {
  assert.deepEqual(Object.keys(buyCreditsTool.parameters.properties), [],
    "buy_credits declares arguments; the amount must be the user's keystrokes");
  assert.equal(buyCreditsTool.parameters.additionalProperties, false,
    "buy_credits allows unnamed arguments, so an amount could arrive anyway");
});

t("no money tool takes an amount-shaped argument", () => {
  for (const tool of MONEY_TOOLS) {
    for (const p of Object.keys(tool.parameters.properties || {})) {
      assert.ok(!AMOUNT_SHAPED.test(p), `${tool.name} takes "${p}", which a model could fill with a figure`);
    }
  }
});

t("assertMoneyToolsSafe refuses a tool that could be handed an amount", () => {
  for (const bad of ["usd", "amount", "credits", "cents", "total", "price", "topup"]) {
    assert.throws(
      () => assertMoneyToolsSafe([{ name: "buy_credits", typedConfirm: "amount", parameters: { type: "object", properties: { [bad]: { type: "number" } }, additionalProperties: false } }]),
      /amount-shaped|must take no arguments/,
      `an argument named "${bad}" was allowed onto a money tool`,
    );
  }
});

t("assertMoneyToolsSafe refuses a money tool with no typed confirmation", () => {
  assert.throws(
    () => assertMoneyToolsSafe([{ name: "set_top_off", parameters: { type: "object", properties: {}, additionalProperties: false } }]),
    /typedConfirm/,
  );
});

t("assertMoneyToolsSafe refuses open-ended parameters", () => {
  assert.throws(
    () => assertMoneyToolsSafe([{ name: "set_top_off", typedConfirm: "code", parameters: { type: "object", properties: {} } }]),
    /additional properties/i,
  );
});

t("the shipped money tools pass their own assertion", () => {
  assert.equal(assertMoneyToolsSafe(), true);
});

t("a clicked Yes can never satisfy a money verb", () => {
  /*
   * The most important single check in this file. If a confirmation token satisfied buy_credits, then
   * "shall I add credits?" plus one click would be a charge, and the amount would still be whatever
   * the model had in mind. The verdict must stay typed-confirm no matter what tokens are presented.
   */
  const everyToken = [confirmationToken("buy_credits", {}), confirmationToken("set_top_off", { on: false }), "deadbeef"];
  const a = screenToolCall({ name: "buy_credits", args: {} }, { confirmations: everyToken });
  assert.equal(a.verdict, "typed-confirm", "a click authorised a purchase");
  const b = screenToolCall({ name: "set_top_off", args: { on: false } }, { confirmations: everyToken });
  assert.equal(b.verdict, "typed-confirm", "a click authorised a top-off change");
});

t("a money verb survives a document in the turn instead of being silently blocked", () => {
  /*
   * The injection guard blocks writes when a document reads as an instruction, which is right for a
   * setting flip and wrong here: the verdict is a request to draw a text box, and a document cannot
   * type into a text box. Blocking would make asking for credits fail at random.
   */
  const v = screenToolCall({ name: "buy_credits", args: {} }, { injectionFlagged: true, toolResultPresent: true });
  assert.equal(v.verdict, "typed-confirm");
});

/* ============================================================================================== *
 * 2. PARSING WHAT A HUMAN TYPED
 * ============================================================================================== */

console.log("\n=== parsing a typed amount ===");

for (const [input, expected] of [
  ["25", 25], ["$25", 25], ["25.00", 25], [" 50 ", 50], ["$12.50", 12.5],
  ["12.5", 12.5], ["$100", 100], ["1,000", null], ["$1,000", null],
  ["25 dollars", 25], ["$25usd", 25], ["25.99", 25.99], ["$199.99", 199.99],
]) {
  t(`accepts ${JSON.stringify(input)}`, () => {
    const r = parseTypedAmount(input);
    if (expected === null) {
      // Over the ceiling, which is a refusal rather than a parse failure.
      assert.equal(r.ok, false);
      assert.equal(r.tooLarge, true, "1000 should be refused as too large, not unparseable");
    } else {
      assert.equal(r.ok, true, "refused with: " + r.reason);
      assert.equal(r.usd, expected);
    }
  });
}

for (const bad of ["", "   ", "abc", "twenty five", "25-30", "25 to 30", "-25", "0", "$0",
  "1e3", "12.505", "$$25", "25%", "NaN", "Infinity", "0x19", "２５"]) {
  t(`refuses ${JSON.stringify(bad)} with a reason`, () => {
    const r = parseTypedAmount(bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + " was accepted as " + r.usd);
    assert.ok(r.reason && r.reason.length > 12, "refused with no useful reason");
    assert.ok(/[.!?]$/.test(r.reason), "the reason is not a sentence: " + r.reason);
  });
}

t("the floor is enforced and named", () => {
  const r = parseTypedAmount("5");
  assert.equal(r.ok, false);
  assert.equal(r.tooSmall, true);
  assert.match(r.reason, /12\.50/, "the refusal does not say what the floor is");
});

t("the ceiling is enforced and offers a way round it", () => {
  const r = parseTypedAmount("5000");
  assert.equal(r.ok, false);
  assert.equal(r.tooLarge, true);
  assert.match(r.reason, /payment screen/i, "the refusal is a dead end");
});

t("every real tier fits under the ceiling and the ceiling itself is reachable", () => {
  // Fred set $200 on 2026-08-12, twice the largest tier the app sells.
  for (const tier of TOPUP_TIERS) {
    assert.equal(parseTypedAmount(String(tier)).ok, true, "a real tier ($" + tier + ") was refused");
  }
  assert.equal(parseTypedAmount("200").ok, true, "the ceiling itself must be reachable");
  assert.equal(parseTypedAmount("201").ok, false, "one dollar over the ceiling must be refused");
});

t("a slipped zero is caught on every tier a ceiling can catch it on", () => {
  /*
   * WHAT A CEILING CAN AND CANNOT DO, stated honestly because the first version of this test asserted
   * something false and failed. A ceiling only catches a slip that lands ABOVE it. $12.50 typed as
   * $125 is a tenfold error and it is still a perfectly ordinary purchase, so nothing here can refuse
   * it without also refusing a real customer buying $125 of credits. That case is caught by the user
   * reading the confirmation, which states the dollars and the credits before anything is charged.
   *
   * What the ceiling does catch is the slip on every tier from $25 up, which is where the money that
   * would actually hurt lives.
   */
  for (const tier of TOPUP_TIERS.filter((v) => v * 10 > MAX_PURCHASE_USD)) {
    const slipped = parseTypedAmount(String(tier * 10));
    assert.equal(slipped.ok, false, "a slipped zero on $" + tier + " was accepted as $" + (tier * 10));
    assert.equal(slipped.tooLarge, true);
  }
  assert.ok(TOPUP_TIERS.filter((v) => v * 10 > MAX_PURCHASE_USD).length >= 3,
    "the ceiling has drifted so high that it no longer catches a slipped zero on most tiers");
  // And the one it honestly cannot catch, pinned so nobody later believes it does.
  assert.equal(parseTypedAmount("125").ok, true, "$125 is a legitimate purchase and must not be refused");
});

t("cents never survive as a float artefact", () => {
  for (const v of ["12.50", "25.10", "99.99", "33.33"]) {
    const r = parseTypedAmount(v);
    assert.equal(r.ok, true);
    assert.equal(Math.round(r.usd * 100), r.usd * 100, "a third decimal survived in " + v);
  }
});

t("parseTypedAmount never throws on hostile input", () => {
  for (const v of [null, undefined, {}, [], 42, true, "$".repeat(5000), " ", "((((", "$^[]\\"]) {
    parseTypedAmount(v);
  }
});

/* ============================================================================================== *
 * 3. AGREEMENT WITH THE LIVE MONEY ENGINE
 * ============================================================================================== */

console.log("\n=== agreement with billing.mjs, the live ledger ===");

t("the minimum here is the app's own minimum", () => {
  assert.equal(MIN_PURCHASE_USD, MIN_TOPUP_USD,
    "altana-money and billing disagree about the smallest legal purchase");
});

t("the ceiling is above the largest offered tier", () => {
  assert.ok(MAX_PURCHASE_USD > Math.max(...TOPUP_TIERS),
    "the ceiling is below a tier the app already sells, so a legitimate purchase would be refused");
});

t("credits per dollar match the ledger's own arithmetic", () => {
  for (const usd of TOPUP_TIERS) {
    assert.equal(creditsForUsd(usd, { creditsPerUsd: CREDITS_PER_USD, markup: MARKUP }),
      Math.round(usd / MARKUP * CREDITS_PER_USD), "credit conversion drifted at $" + usd);
  }
  // The published number, stated in the FAQ: $12.50 buys 1000 credits.
  assert.equal(creditsForUsd(12.5), 1000, "the shipped price copy says $12.50 is 1000 credits");
});

/* ============================================================================================== *
 * 4. THE FIVE DIGIT CODE
 * ============================================================================================== */

console.log("\n=== the typed confirmation code ===");

t("it is always exactly five digits", () => {
  for (let i = 0; i < 400; i++) {
    const code = typedConfirmCode("nonce-" + i, { tool: "set_top_off", args: { on: i % 2 === 0 }, uid: "u" + i });
    assert.match(code, /^\d{5}$/, "not five digits: " + code);
  }
});

t("on and off produce different codes, so an approval cannot be replayed against the opposite action", () => {
  const on = typedConfirmCode("n1", { tool: "set_top_off", args: { on: true }, uid: "u1" });
  const off = typedConfirmCode("n1", { tool: "set_top_off", args: { on: false }, uid: "u1" });
  assert.notEqual(on, off);
});

t("two accounts never share a code for the same action", () => {
  const a = typedConfirmCode("n1", { tool: "set_top_off", args: { on: true }, uid: "alice" });
  const b = typedConfirmCode("n1", { tool: "set_top_off", args: { on: true }, uid: "bob" });
  assert.notEqual(a, b, "one user's screenshot would authorise another user's account");
});

t("a new request produces a new code", () => {
  const a = typedConfirmCode("n1", { tool: "set_top_off", args: { on: true }, uid: "u" });
  const b = typedConfirmCode("n2", { tool: "set_top_off", args: { on: true }, uid: "u" });
  assert.notEqual(a, b, "yesterday's code still works");
});

t("it is stable for the same request, so a re-render does not change the number under the user", () => {
  const a = typedConfirmCode("n1", { tool: "set_top_off", args: { on: true }, uid: "u" });
  const b = typedConfirmCode("n1", { tool: "set_top_off", args: { on: true }, uid: "u" });
  assert.equal(a, b);
});

t("codeMatches is strict and tolerant in the right places", () => {
  assert.equal(codeMatches("12345", "12345"), true);
  assert.equal(codeMatches(" 12345 ", "12345"), true, "trimming should not defeat a correct code");
  assert.equal(codeMatches("12-345", "12345"), true, "punctuation a user might type should not fail");
  assert.equal(codeMatches("12346", "12345"), false);
  assert.equal(codeMatches("1234", "12345"), false);
  assert.equal(codeMatches("123456", "12345"), false);
  assert.equal(codeMatches("", "12345"), false);
  assert.equal(codeMatches("12345", ""), false);
  assert.equal(codeMatches(null, null), false, "two empties must not match each other");
  assert.equal(codeMatches("abcde", "12345"), false);
});

/* ============================================================================================== *
 * 5. THE CONFIRMATION REQUEST
 * ============================================================================================== */

console.log("\n=== what the user is shown ===");

t("the purchase field asks Fred's own question", () => {
  const r = confirmRequestFor({ tool: "buy_credits", uid: "u", nonce: "n" });
  assert.equal(r.kind, "amount");
  assert.match(r.prompt, /type the amount of credits you would like to purchase/i);
  assert.equal(r.min, MIN_PURCHASE_USD);
  assert.equal(r.max, MAX_PURCHASE_USD);
  assert.equal(r.code, undefined, "a purchase must not carry a code to type instead of an amount");
});

t("the purchase field states the balance they are deciding from", () => {
  const r = confirmRequestFor({ tool: "buy_credits", uid: "u", nonce: "n", account: { balance: 812.4 } });
  assert.match(r.context, /812/, "the user is deciding from memory rather than the real number");
});

t("the toggle field carries a code and the consequence of using it", () => {
  const off = confirmRequestFor({ tool: "set_top_off", args: { on: false }, uid: "u", nonce: "n" });
  assert.equal(off.kind, "code");
  assert.match(off.code, /^\d{5}$/);
  assert.match(off.prompt, /type the number/i);
  // The honest half: switching it off breaks video and Engineer, and they are told BEFORE they type.
  assert.match(off.context, /video/i, "turning it off does not warn that video stops working");
  assert.match(off.context, /engineer/i, "turning it off does not warn about the Engineer view");
});

t("turning it on states what it buys them rather than warning them", () => {
  const on = confirmRequestFor({ tool: "set_top_off", args: { on: true }, uid: "u", nonce: "n" });
  assert.match(on.context, /tops itself up|not die halfway/i);
  assert.ok(!/stop working/i.test(on.context), "switching it ON should not read like a warning");
});

t("the consequence text is plain English and survives the outbound filter", () => {
  for (const text of [topOffConsequence(true), topOffConsequence(false), PROMPTS.amount, PROMPTS.amountHint]) {
    const r = plainEnglish(text);
    assert.equal(r.stripped, false, "the plain-English filter would rewrite: " + text + " -> " + r.text);
    // Written as an escape rather than the character, so a repo-wide grep for the literal stays a
    // reliable house-style check instead of matching the test that enforces it.
    assert.ok(!text.includes(EM_DASH), "an em dash reached user-facing copy: " + text);
  }
});

t("an unknown tool gets no confirmation request at all", () => {
  assert.equal(confirmRequestFor({ tool: "set_setting", uid: "u", nonce: "n" }), null);
  assert.equal(confirmRequestFor({ tool: "", uid: "u", nonce: "n" }), null);
});

/* ============================================================================================== *
 * 6. DECIDING A TYPED ANSWER
 * ============================================================================================== */

console.log("\n=== deciding what a typed answer means ===");

const freshPending = (over = {}) => ({
  nonce: "n1", uid: "u1", tool: "buy_credits", kind: "amount", argsJson: "{}",
  expectedCode: "", createdAt: Date.now(), spentAt: null, ...over,
});

t("a valid amount with a saved card charges", () => {
  const d = decideTypedAnswer({ pending: freshPending(), typed: "25", uid: "u1", account: { hasCard: true } });
  assert.equal(d.ok, true);
  assert.equal(d.verdict, "charge");
  assert.equal(d.usd, 25);
  assert.equal(d.credits, 2000);
});

t("a valid amount with no saved card goes to the secure payment page, never to a card field", () => {
  const d = decideTypedAnswer({ pending: freshPending(), typed: "25", uid: "u1", account: { hasCard: false } });
  assert.equal(d.verdict, "checkout");
  assert.match(d.say, /never see card details/i, "she does not say she stays away from the card");
  assert.ok(!/card number|enter your card|cvv|expiry/i.test(d.say), "she implied she would take a card");
});

t("an already-spent confirmation is refused, and this is the replay wall", () => {
  const d = decideTypedAnswer({ pending: freshPending({ spentAt: Date.now() }), typed: "25", uid: "u1", account: { hasCard: true } });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, "already");
  assert.match(d.say, /already/i);
});

t("an expired confirmation lapses rather than acting", () => {
  const d = decideTypedAnswer({ pending: freshPending({ createdAt: Date.now() - CONFIRM_TTL_MS - 1000 }), typed: "25", uid: "u1", account: { hasCard: true } });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, "expired");
});

t("a confirmation belonging to another account is refused", () => {
  const d = decideTypedAnswer({ pending: freshPending({ uid: "someone-else" }), typed: "25", uid: "u1", account: { hasCard: true } });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, "wrong-account");
});

t("a missing confirmation is refused rather than assumed", () => {
  const d = decideTypedAnswer({ pending: null, typed: "25", uid: "u1" });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, "unknown");
});

t("a bad amount is retryable, so the user is not made to start over", () => {
  const d = decideTypedAnswer({ pending: freshPending(), typed: "5", uid: "u1", account: { hasCard: true } });
  assert.equal(d.ok, false);
  assert.equal(d.retryable, true);
  assert.match(d.say, /12\.50/);
});

t("the right code flips the toggle, the wrong one changes nothing", () => {
  const pending = { nonce: "n2", uid: "u1", tool: "set_top_off", kind: "code", argsJson: '{"on":false}', expectedCode: "54321", createdAt: Date.now(), spentAt: null };
  const good = decideTypedAnswer({ pending, typed: "54321", uid: "u1" });
  assert.equal(good.ok, true);
  assert.equal(good.verdict, "toggle");
  assert.equal(good.on, false);

  const bad = decideTypedAnswer({ pending, typed: "54322", uid: "u1" });
  assert.equal(bad.ok, false);
  assert.equal(bad.verdict, "bad-code");
  assert.equal(bad.retryable, true);
  assert.match(bad.say, /changed nothing/i, "a wrong code must say plainly that nothing happened");
});

t("an empty typed value never counts as confirmation", () => {
  const pending = { nonce: "n3", uid: "u1", tool: "set_top_off", kind: "code", argsJson: '{"on":true}', expectedCode: "00000", createdAt: Date.now(), spentAt: null };
  for (const v of ["", "   ", null, undefined]) {
    const d = decideTypedAnswer({ pending, typed: v, uid: "u1" });
    assert.equal(d.ok, false, JSON.stringify(v) + " was accepted as a confirmation of 00000");
  }
});

t("decideTypedAnswer never throws", () => {
  for (const p of [null, undefined, {}, { kind: "nonsense", createdAt: Date.now() }, { kind: "code", argsJson: "not json", createdAt: Date.now() }]) {
    decideTypedAnswer({ pending: p, typed: "x", uid: "u1" });
  }
});

/* ============================================================================================== *
 * 7. REPORTING THE REAL OUTCOME
 * ============================================================================================== */

console.log("\n=== reporting outcomes honestly and in plain English ===");

t("a success states what was added and where they now stand", () => {
  const s = purchaseOutcome({ ok: true, balance: 2812, credits: 2000, usd: 25 });
  assert.match(s, /2000 credits/);
  assert.match(s, /\$25\.00/);
  assert.match(s, /2812/);
});

t("every failure is plain English with a way out, and never repeats the provider's words", () => {
  const errors = [
    "card_declined", "Your card has expired.", "requires_action", "insufficient_funds",
    "no payment method", "stripe not configured", "ECONNRESET reading from api.stripe.com", "",
  ];
  for (const e of errors) {
    const s = purchaseOutcome({ ok: false, error: e });
    assert.ok(s.length > 40, "a bare failure message for: " + e);
    const filtered = plainEnglish(s);
    assert.equal(filtered.stripped, false, "the outcome leaked technical content: " + s + " -> " + filtered.text);
    assert.ok(!/stripe|ECONNRESET|card_declined|requires_action|insufficient_funds/i.test(s),
      "the provider's own error language reached the user: " + s);
    assert.ok(/payment screen|recorded|come back to you|secure payment/i.test(s),
      "a failure with no way out: " + s);
  }
});

t("a locked account is explained without blame", () => {
  const s = purchaseOutcome({ ok: false, locked: true });
  assert.match(s, /held/i);
  assert.match(s, /payment screen/i);
});

t("the toggle reports the state read back, not the state requested", () => {
  assert.match(topOffOutcome({ asked: true, actual: true }), /is on/i);
  assert.match(topOffOutcome({ asked: false, actual: false }), /is off/i);
  // The one that matters: asked and actual disagree, so she must not claim success.
  const lying = topOffOutcome({ asked: false, actual: true });
  assert.match(lying, /not going to tell you it worked/i, "a failed toggle was reported as done");
  assert.ok(!/is off\./i.test(lying));
});

t("switching it off repeats the consequence so nobody is ambushed later", () => {
  assert.match(topOffOutcome({ asked: false, actual: false }), /video/i);
});

t("every outcome sentence survives the plain-English filter untouched", () => {
  const all = [
    purchaseOutcome({ ok: true, balance: 100, credits: 1000, usd: 12.5 }),
    purchaseOutcome({ ok: false, error: "card_declined" }),
    purchaseOutcome({ ok: false, locked: true }),
    topOffOutcome({ asked: true, actual: true }),
    topOffOutcome({ asked: false, actual: false }),
    topOffOutcome({ asked: false, actual: true }),
    topOffOutcome({ asked: true, actual: false, error: "boom" }),
  ];
  for (const s of all) {
    const r = plainEnglish(s);
    assert.equal(r.text, s, "the filter rewrote an outcome sentence: " + s + " -> " + r.text);
    assert.ok(!s.includes(EM_DASH), "an em dash reached user-facing copy: " + s);
  }
});

/* ============================================================================================== *
 * 8. THE CARVE-OUT IS DOCUMENTED
 * ============================================================================================== */

console.log("\n=== the carve-out records its own reason ===");

t("every money tool is carved out, names its zones, and says why", () => {
  for (const tool of MONEY_TOOLS) {
    const carve = carveOutFor(tool.name);
    assert.ok(carve, tool.name + " crosses a money zone with no carve-out record");
    assert.ok(Array.isArray(carve.zones) && carve.zones.length, tool.name + " grants no zones");
    assert.ok(carve.why && carve.why.length > 40, tool.name + " records no reason it was allowed");
    assert.ok(carve.requires, tool.name + " does not say what the user must type");
  }
});

t("the carve-out quotes Fred rather than paraphrasing him", () => {
  const why = MONEY_CARVE_OUT.map((c) => c.why).join(" ");
  assert.match(why, /2026-08-12/, "the carve-out is undated");
  assert.match(why, /please type the amount|type ##### to confirm/i, "Fred's own words are not recorded");
});

t("all three money verbs are actually in her toolset", () => {
  for (const name of ["read_money_state", "buy_credits", "set_top_off"]) {
    assert.ok(ALTANA_TOOLS.some((t2) => t2.name === name), name + " is missing from ALTANA_TOOLS");
  }
});

t("the read verb needs no typed value, and the two write verbs do", () => {
  assert.equal(readMoneyTool.typedConfirm, "none");
  assert.equal(readMoneyTool.write, false);
  assert.equal(buyCreditsTool.typedConfirm, "amount");
  assert.equal(setTopOffTool.typedConfirm, "code");
});

/* ============================================================================================== *
 * 9. THE STORE: SINGLE USE, AGAINST THE REAL DATABASE
 * ============================================================================================== */

console.log("\n=== single use, proved against the real store ===");

const dir = mkdtempSync(join(tmpdir(), "altana-money-"));
const store = createAltanaStore({ dir });

t("a confirmation can be spent exactly once", () => {
  store.putConfirm({ nonce: "once", uid: "u1", tool: "buy_credits", kind: "amount", args: {}, at: Date.now() });
  assert.equal(store.spendConfirm("once"), true, "the first spend was refused");
  assert.equal(store.spendConfirm("once"), false, "THE REPLAY WALL FAILED: it spent twice");
  assert.equal(store.spendConfirm("once"), false);
});

t("a confirmation is only visible to the account it was issued to", () => {
  store.putConfirm({ nonce: "mine", uid: "alice", tool: "buy_credits", kind: "amount", args: {}, at: Date.now() });
  assert.ok(store.getConfirm("mine", "alice"), "alice cannot see her own confirmation");
  assert.equal(store.getConfirm("mine", "bob"), null, "bob can see alice's confirmation");
});

t("the expected code round-trips so a toggle can be checked later", () => {
  const code = typedConfirmCode("tog", { tool: "set_top_off", args: { on: false }, uid: "u1" });
  store.putConfirm({ nonce: "tog", uid: "u1", tool: "set_top_off", kind: "code", args: { on: false }, expectedCode: code, at: Date.now() });
  const row = store.getConfirm("tog", "u1");
  assert.equal(row.expectedCode, code);
  const d = decideTypedAnswer({ pending: row, typed: code, uid: "u1" });
  assert.equal(d.ok, true);
  assert.equal(d.on, false);
});

t("a purchase nonce cannot be used twice, even if the spend flag were bypassed", () => {
  assert.equal(store.beginPurchase({ nonce: "buy1", uid: "u1", usd: 25, credits: 2000 }).ok, true);
  const second = store.beginPurchase({ nonce: "buy1", uid: "u1", usd: 25, credits: 2000 });
  assert.equal(second.ok, false, "THE SECOND REPLAY WALL FAILED: one authorisation bought twice");
  assert.equal(second.duplicate, true);
});

t("a purchase records its real outcome", () => {
  store.beginPurchase({ nonce: "buy2", uid: "u1", usd: 50, credits: 4000 });
  store.settlePurchase("buy2", { status: "charged", ref: "pi_123" });
  const row = store.purchase("buy2");
  assert.equal(row.status, "charged");
  assert.equal(row.ref, "pi_123");
  assert.ok(row.settledAt, "a settled purchase has no settlement time");
});

t("a failed purchase keeps the reason without leaking it to the user", () => {
  store.beginPurchase({ nonce: "buy3", uid: "u1", usd: 25, credits: 2000 });
  store.settlePurchase("buy3", { status: "failed", error: "card_declined by acquirer" });
  assert.equal(store.purchase("buy3").status, "failed");
  // The record keeps the technical reason; what the USER is told does not.
  assert.ok(!/card_declined/.test(purchaseOutcome({ ok: false, error: "card_declined by acquirer" })));
});

t("purchases are listed per account only", () => {
  store.beginPurchase({ nonce: "other", uid: "someone-else", usd: 25, credits: 2000 });
  const mine = store.purchasesFor("u1", 50);
  assert.ok(mine.length >= 3);
  assert.ok(mine.every((p) => p.uid === "u1"), "another account's purchases were listed");
});

t("the complaint book still works exactly as it did", () => {
  // The new tables are additive. Losing a customer's complaint to a schema change would be the worst
  // possible trade for a tidier database.
  const r = store.log({ uid: "u1", userEmail: "a@b.c", summary: "the old path still writes" });
  assert.equal(r.ok, true);
  assert.ok(store.recent(5).some((c) => c.summary === "the old path still writes"));
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\naltana-money_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
