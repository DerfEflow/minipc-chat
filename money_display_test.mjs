/*
 * Money WORDING (public/dominion-money.js), which is the only thing standing between a guest and a
 * dollar figure they cannot spend (Fred, 2026-07-30). The module is browser code, so it runs here
 * inside a minimal fake window; that is deliberate, because the alternative — trusting a rendered
 * screenshot — is how the dollars survived this long.
 *
 * The load-bearing claims:
 *   1. a guest never sees a "$" from any formatter, at any amount, including zero and huge;
 *   2. a displayed cost is never LESS than what billing will actually deduct (creditsForCostUsd);
 *   3. the owner still reads dollars;
 *   4. before /account answers, the wording is the guest's — the safe direction.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { creditsForCostUsd, CREDITS_PER_USD } from "./billing.mjs";

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };

// A window just big enough for the module: a document that can dispatch, and a fetch that never
// resolves, so every test controls the owner/guest state explicitly through adopt().
function loadMoney() {
  const listeners = [];
  const ctx = createContext({
    window: {},
    document: {
      dispatchEvent: (e) => { listeners.forEach((f) => f(e)); return true; },
      addEventListener: (_n, f) => listeners.push(f),
    },
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: () => new Promise(() => {}),   // never settles: state stays exactly where a test puts it
  });
  runInContext(readFileSync("./public/dominion-money.js", "utf8"), ctx);
  return ctx.window.DominionMoney;
}

const AMOUNTS = [0, 0.0001, 0.004, 0.005, 0.01, 0.42, 1, 3.999, 12.5, 250, 10000];

t("before /account answers, wording is the guest's (fail-safe direction)", () => {
  const M = loadMoney();
  assert.equal(M.inCredits(), true, "an unresolved viewer must be treated as a guest");
  assert.ok(!/\$/.test(M.cost(1.23)), "no dollars before the account is known: " + M.cost(1.23));
});

t("a guest never sees a dollar sign, at any amount, from any formatter", () => {
  const M = loadMoney();
  M.adopt({ isOwner: false, pricing: { CREDITS_PER_USD } });
  for (const n of AMOUNTS) {
    for (const s of [M.cost(n), M.cost(n, { approx: true }), M.balance(n), M.rate(n, n), M.rate(n, n, { long: true })]) {
      assert.ok(!s.includes("$"), `"${s}" leaked a dollar sign at ${n}`);
    }
  }
});

t("a displayed cost is never less than what billing actually deducts", () => {
  const M = loadMoney();
  M.adopt({ isOwner: false, pricing: { CREDITS_PER_USD } });
  for (const n of AMOUNTS) {
    if (n <= 0) { assert.equal(M.toCredits(n), 0, "a genuinely free lane stays zero"); continue; }
    assert.equal(M.toCredits(n), creditsForCostUsd(n),
      `display and billing disagree at $${n}: shown ${M.toCredits(n)}, charged ${creditsForCostUsd(n)}`);
  }
});

t("the noun agrees with the number", () => {
  const M = loadMoney();
  M.adopt({ isOwner: false, pricing: { CREDITS_PER_USD } });
  // $0.01 is exactly one credit. This used to be written as $0.005 because the old rounding-up
  // rule turned half a credit into a whole one; with exact charging, half a credit stays half.
  assert.match(M.cost(0.01), /^1 credit$/, "one credit is singular: " + M.cost(0.01));
  assert.match(M.cost(0.05), /^5 credits$/, "five is plural: " + M.cost(0.05));
});

/*
 * Fractions have to survive the trip to the screen, or the fix is invisible where it matters most:
 * the number a guest actually reads. Float noise (0.30000000000000004) must never surface either.
 */
t("a fraction of a credit is shown as a fraction, cleanly", () => {
  const M = loadMoney();
  M.adopt({ isOwner: false, pricing: { CREDITS_PER_USD } });
  assert.match(M.cost(0.005), /^0\.5 credits$/, "half a credit reads as half: " + M.cost(0.005));
  assert.match(M.cost(0.00005), /^0\.005 credits$/, "Fred's example: " + M.cost(0.00005));
  assert.equal(M.cost(0), "0 credits", "a free turn quotes zero, not a minimum");
  assert.ok(!/\d{6,}/.test(M.cost(0.003)), "no float noise on screen: " + M.cost(0.003));
});

t("a free lane says Free rather than quoting zero", () => {
  const M = loadMoney();
  M.adopt({ isOwner: false, pricing: { CREDITS_PER_USD } });
  assert.equal(M.rate(0, 0), "Free");
  M.adopt({ isOwner: true, pricing: { CREDITS_PER_USD } });
  assert.equal(M.rate(0, 0), "Free");
});

t("the owner still reads dollars everywhere", () => {
  const M = loadMoney();
  M.adopt({ isOwner: true, pricing: { CREDITS_PER_USD } });
  assert.equal(M.inCredits(), false);
  assert.equal(M.cost(3.4, { approx: true }), "~$3.40");
  assert.equal(M.balance(12.5), "$12.50");
  assert.equal(M.rate(3, 15), "$3/$15");
  assert.match(M.rate(3, 15, { long: true }), /per million tokens/);
});

t("the server's rate wins over the built-in default", () => {
  const M = loadMoney();
  M.adopt({ isOwner: false, pricing: { CREDITS_PER_USD: 250 } });
  assert.equal(M.creditsPerUsd(), 250);
  assert.equal(M.toCredits(1), 250, "one dollar of value must convert at the server's rate");
});

console.log(`\n${passed}/7 checks passed - guest money wording holds`);
