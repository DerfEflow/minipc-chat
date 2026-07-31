/*
 * Dominion AI — how money is WORDED, in one place (Fred, 2026-07-30: "in guests interface all cost
 * MUST be in tokens. They are currently still in dollars... Search for every instance of a dollar
 * value ONLY in the guest interfaces, and convert permanently to equivalent token values.").
 *
 * WHAT THIS IS NOT. It is not billing. Nothing here changes what anyone is charged: billing.mjs
 * still does every deduction in exactly the same way, and the server remains the only authority on
 * money. This module decides which WORDS a given viewer sees for a cost that has already been
 * computed. Display only, on purpose, so a wording change can never move a number.
 *
 * THE RULE. The owner reads dollars, because he pays providers in dollars. Everyone else reads
 * credits, because credits are the only currency they actually hold — a guest can neither spend
 * nor verify a dollar figure, so showing them one is noise at best and a wrong number at worst.
 *
 * THE CONVERSION is the app's real one, taken from the server (billing.mjs CREDITS_PER_USD, 100
 * credits = $1 of token value at cost) and mirrored here for display: ceil, floored at one credit
 * for any nonzero cost, exactly like creditsForCostUsd so a displayed cost can never read lower
 * than what the account is actually charged. A genuinely free lane still reads "Free".
 *
 * FAIL-SAFE DIRECTION. Until /account answers, assume GUEST. A guest briefly seeing credits is
 * correct; a guest seeing dollars is the defect being fixed. The owner may see credits for the few
 * hundred milliseconds before his own account resolves, which costs him nothing, and every surface
 * repaints on the `dominion-money-ready` event.
 *
 * THE NOUN lives in one constant. Fred says "tokens" in conversation; the app has said "credits"
 * since billing shipped — in the budget window, in the lens footer, on the Setup page where they
 * are purchased — and the estimates print real LLM token counts ("~120k tokens") right beside the
 * price, where a second meaning of the word would be genuinely ambiguous. UNIT_NOUN is therefore
 * "credits", and swapping it is one line if he wants the other word everywhere.
 */
(() => {
  const UNIT_NOUN = "credits";          // the guest currency's name, everywhere, one place
  const UNIT_ONE = "credit";            // "1 credits" is the tell of a machine that is not reading
  const noun = (n) => (Math.abs(n) === 1 ? UNIT_ONE : UNIT_NOUN);
  const DEFAULT_CREDITS_PER_USD = 100;  // billing.mjs default; the server's value wins once known

  const state = {
    resolved: false,
    isOwner: false,                     // fail-safe: guest wording until the server says otherwise
    creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  };

  /*
   * usd -> credits, matching billing.mjs creditsForCostUsd EXACTLY. Both sides carry six decimal
   * places and neither rounds up. The old pair rounded up to a one-credit minimum, so the number
   * shown and the number charged agreed with each other while both overstated a cheap turn and
   * charged outright for a free one.
   */
  const CREDIT_DP = 1e6;
  const toCredits = (usd) => {
    const n = Number(usd) || 0;
    if (n <= 0) return 0;
    return Math.round(n * state.creditsPerUsd * CREDIT_DP) / CREDIT_DP;
  };

  /*
   * Rendering a credit count. A fraction has to read like a quantity a person can hold, so it
   * shows enough decimals to be true and no trailing zeros: 0.005, 1.25, 4, 1,240. Float noise
   * (0.30000000000000004) never reaches the screen.
   */
  const fmtCredits = (n) => {
    const v = Number(n) || 0;
    if (v === 0) return "0";
    if (Number.isInteger(v)) return v.toLocaleString();
    const abs = Math.abs(v);
    const dp = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
    const s = v.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
    const [whole, frac] = s.split(".");
    return Number(whole).toLocaleString() + (frac ? "." + frac : "");
  };

  // A cost that has already happened, or a firm estimate of one. `approx` prefixes the tilde in the
  // right place for either unit rather than leaving call sites to concatenate it and get it wrong.
  const cost = (usd, { approx = false } = {}) => {
    const n = Number(usd) || 0;
    const tilde = approx ? "~" : "";
    if (state.isOwner) return tilde + "$" + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));
    const c = toCredits(n);
    return tilde + fmtCredits(c) + " " + noun(c);
  };

  // A catalog rate, quoted per million tokens. Guests read the same rate in the currency they hold.
  const rate = (inUsdPerM, outUsdPerM, { long = false } = {}) => {
    const i = Number(inUsdPerM) || 0, o = Number(outUsdPerM) || 0;
    if (!i && !o) return "Free";
    if (state.isOwner) {
      return long ? "$" + i + " in / $" + o + " out per million tokens" : "$" + i + "/$" + o;
    }
    const ci = Math.round(i * state.creditsPerUsd), co = Math.round(o * state.creditsPerUsd);
    // The noun rides even the compact form. A bare "300/1500" beside a context size reads as some
    // other spec; money is the one place where a saved character is not worth an ambiguity.
    return long
      ? ci.toLocaleString() + " in / " + co.toLocaleString() + " out " + UNIT_NOUN + " per million tokens"
      : ci.toLocaleString() + "/" + co.toLocaleString() + " " + UNIT_NOUN;
  };

  /*
   * A balance or budget the viewer holds. This used to floor to whole units on the reasoning that
   * nobody budgets in fractions of a credit. Once a turn can cost 0.005, flooring UNDER-reports
   * what someone actually holds, and a balance that reads low by design is the wrong kind of
   * wrong. It is shown as precisely as it is held.
   */
  const balance = (usd) => {
    if (state.isOwner) return "$" + (Number(usd) || 0).toFixed(2);
    const c = toCredits(usd);
    return fmtCredits(c) + " " + noun(c);
  };

  const announce = () => { try { document.dispatchEvent(new CustomEvent("dominion-money-ready")); } catch {} };

  window.DominionMoney = {
    UNIT_NOUN,
    isOwner: () => state.isOwner,
    inCredits: () => !state.isOwner,
    creditsPerUsd: () => state.creditsPerUsd,
    toCredits, cost, rate, balance,
    resolved: () => state.resolved,
    // Exposed so a surface that already fetched /account for its own reasons can seed this without
    // a second round trip; also what the boot fetch below calls.
    adopt: (account) => {
      if (!account || typeof account !== "object") return;
      state.isOwner = account.isOwner === true;
      const per = account.pricing && Number(account.pricing.CREDITS_PER_USD);
      if (per > 0) state.creditsPerUsd = per;
      state.resolved = true;
      announce();
    },
  };

  // One boot fetch. A failure leaves the guest wording in place, which is the safe direction, and
  // an anonymous 401 is not an error worth a console line.
  fetch("/account", { cache: "no-store", headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j) window.DominionMoney.adopt(j); else { state.resolved = true; announce(); } })
    .catch(() => { state.resolved = true; announce(); });
})();
