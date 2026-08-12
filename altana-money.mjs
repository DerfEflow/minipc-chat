/*
 * Dominion AI. THE TWO MONEY VERBS ALTANA IS ALLOWED, and the wall that makes them safe.
 *
 * FRED, 2026-08-12, amending his own boundary of 2026-08-03:
 *
 *   "I want altana to be able to add credits to the users account with explicit authorization from
 *    the user, and a 'please type the amount of credits you would like to purchase' field that it
 *    follows, as well as turn on and off the top-off feature for a user with their explicit
 *    instruction, with a 'type #####' to confirm field."
 *
 * The 2026-08-03 boundary said billing and budgets were absolute. This narrows it to two named verbs
 * and leaves the rest shut. Cards, invoices, spend caps, other people's accounts and the price list
 * are all still outside her reach and outside this file.
 *
 * ============================================================================================
 * THE ONE IDEA THIS FILE IS BUILT ON: THE MODEL NEVER SUPPLIES THE NUMBER.
 * ============================================================================================
 *
 * Every safe design for "an assistant can spend money" has to answer one question: what stops the
 * model from choosing the amount? Prompting does not stop it. A confirmation dialog does not stop it,
 * because a user who is told "shall I add credits?" says yes to whatever number is behind the
 * sentence. Reviewing the argument does not stop it, because by then the number is already the
 * model's number.
 *
 * So the tool takes NO AMOUNT. There is no argument to put one in. `buyCreditsTool` below declares an
 * empty schema, and `assertMoneyToolsSafe` fails the build if anyone ever adds an amount-shaped
 * property to it. What the tool does is ASK, and the amount enters the system as keystrokes from the
 * person whose money it is. A model that has been talked into spending five hundred dollars by a web
 * page is left holding a request for a text box.
 *
 * The same shape covers the toggle. She cannot flip top-off by deciding to. She can only put a
 * five-digit number on screen and wait for it to be typed back, which is a thing no document, no
 * fetched page and no prompt injection can do.
 *
 * ============================================================================================
 * WHAT THIS FILE DOES NOT DO
 * ============================================================================================
 *
 * It never sees a card number, never renders a card field, and never asks for one. A first purchase
 * with no card already on file is handed to the app's own secure payment page, which is where card
 * details have always been entered and where they stay. Altana's part ends at "type the amount".
 *
 * It also holds no money logic of its own. Rates, markup, balances and the ledger belong to
 * billing.mjs, which is the live money engine. (credits.mjs is dead code with a conflicting model and
 * a rejected rounding rule; it is imported by nothing but its own test. Do not wire it here.)
 */

import { createHash } from "node:crypto";

/* ============================================================================================== *
 * 1. THE BOUNDS ON A TYPED AMOUNT
 * ============================================================================================== */

/*
 * The floor is the app's own minimum, restated here rather than imported so this module stays pure
 * and testable. It is asserted against billing.mjs at wiring time by altana-money_test.mjs, so a
 * drift is a red test rather than a silent disagreement about the smallest legal purchase.
 */
export const MIN_PURCHASE_USD = 12.5;

/*
 * THE CEILING. Set by Fred at $200 on 2026-08-12.
 *
 * `POST /billing/topup` has no upper bound today, which was defensible when the only way to reach it
 * was a person choosing a tier on a page. It is not defensible once a conversational assistant is
 * anywhere near the path, because the failure is no longer a user picking a big number on purpose, it
 * is a typo in a chat box: "200" meant as twenty dollars, or a stray zero on 20.
 *
 * $200 is twice the largest tier the app offers ($100), so every deliberate purchase the app has ever
 * sold still fits with room over, and a slipped zero on any of those tiers ($125, $250, $500, $1000)
 * lands outside and is refused in plain words. A refusal here is cheap and reversible: she says the
 * number is above what she can do in one go and offers the payment screen, which has no ceiling.
 * I proposed $500; Fred chose $200, which is the tighter and better answer.
 */
export const MAX_PURCHASE_USD = 200;

/*
 * How long a typed-confirmation request stays live. Long enough for someone to go and check their
 * balance in another tab, short enough that an abandoned confirmation cannot be completed tomorrow by
 * somebody else at the same desk.
 */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;

/* ============================================================================================== *
 * 2. PARSING WHAT A HUMAN TYPED
 * ============================================================================================== */

/*
 * People type money the way people talk about money: "25", "$25", "25.00", "$1,000", " 50 ", "50
 * dollars", "$12.50usd". Every one of those is unambiguous and every one of them should work, because
 * a refusal here reads as the app being obtuse about a number the user can see is fine.
 *
 * What must NOT work is anything ambiguous. "twenty five" is not parsed, because guessing at words
 * risks guessing wrong about somebody's money. "25-30" is not parsed, because it is two numbers.
 * "1e3" is not parsed, because nobody types that meaning a thousand dollars on purpose. Each of those
 * returns a plain-English reason instead of a number.
 */
export function parseTypedAmount(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, reason: "I did not catch an amount there. Type it as a number, like 25." };

  // Strip only the decorations a person actually types around a figure.
  const cleaned = text
    .replace(/^\$/, "")
    .replace(/(?:usd|dollars?|bucks?)\.?$/i, "")
    .replace(/,(?=\d{3}\b)/g, "")
    .trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    // Named separately from a plain "that is not a number" so the message can be about the actual
    // mistake, which is what makes the difference between a helpful refusal and a wall.
    if (/[a-z]/i.test(cleaned)) return { ok: false, reason: "Type the amount as digits rather than words, like 25 or 12.50." };
    if (/[-–:/]|\bto\b/.test(cleaned)) return { ok: false, reason: "That looks like a range. Type the single amount you want to add." };
    if (/\.\d{3,}/.test(cleaned)) return { ok: false, reason: "Amounts go to cents, so two places after the point at most, like 12.50." };
    return { ok: false, reason: "I could not read that as an amount. Type it as a number, like 25." };
  }

  const usd = Number(cleaned);
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false, reason: "The amount needs to be more than nothing. Type it as a number, like 25." };

  if (usd < MIN_PURCHASE_USD) {
    return { ok: false, tooSmall: true, usd,
      reason: "The smallest purchase is $" + MIN_PURCHASE_USD.toFixed(2) + ", so $" + usd.toFixed(2) +
        " is under the floor. Type $" + MIN_PURCHASE_USD.toFixed(2) + " or more." };
  }
  if (usd > MAX_PURCHASE_USD) {
    return { ok: false, tooLarge: true, usd,
      reason: "$" + usd.toFixed(2) + " is more than I can add in one go. I can do up to $" + MAX_PURCHASE_USD +
        " here, and I can take you to the payment screen for anything larger." };
  }

  // Round to cents so a float cannot carry a third decimal into a charge.
  return { ok: true, usd: Math.round(usd * 100) / 100 };
}

/**
 * What the user gets for their money, in the app's own arithmetic. Kept as a display helper so the
 * confirmation can state both numbers, which is the difference between authorising "$25" and
 * authorising "$25, which is 2000 credits".
 */
export function creditsForUsd(usd, { creditsPerUsd = 100, markup = 1.25 } = {}) {
  return Math.round((Number(usd) || 0) / markup * creditsPerUsd);
}

/* ============================================================================================== *
 * 3. THE TYPED CONFIRMATION CODE
 * ============================================================================================== */

/*
 * Fred asked for a "type #####" field, so the code is five digits: long enough that it cannot be
 * guessed by accident, short enough to retype without resenting it.
 *
 * DERIVED, NOT RANDOM, and that is deliberate. It is a hash of the action, the account and the
 * server's own confirmation nonce, so:
 *   - the code for "turn top-off OFF" is not the code for "turn it ON", so an approval cannot be
 *     replayed against the opposite action;
 *   - the code is different for every account, so one user's screenshot authorises nothing for
 *     another;
 *   - the code is different for every request, because the nonce is, so yesterday's code is dead.
 * Randomness would give the same properties and would also have to be stored to be checked. This is
 * recomputed from things already stored, which is one less thing to keep in sync.
 *
 * It is not a secret and does not need to be. It is a proof that a human read a specific sentence on
 * a screen and typed a specific answer, which is exactly the thing a prompt injection cannot fake.
 */
export function typedConfirmCode(nonce, { tool = "", args = {}, uid = "" } = {}) {
  const canon = JSON.stringify([String(tool), sortedish(args), String(uid), String(nonce)]);
  const digest = createHash("sha256").update(canon).digest("hex");
  // Take the first 40 bits and fold to five digits. Uniform enough for a confirmation, and stable.
  const n = parseInt(digest.slice(0, 10), 16) % 100000;
  return String(n).padStart(5, "0");
}

function sortedish(v) {
  if (Array.isArray(v)) return v.map(sortedish);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortedish(v[k]);
    return out;
  }
  return v;
}

/** Constant-time-ish compare on a five digit string, so a typo cannot be probed digit by digit. */
export function codeMatches(typed, expected) {
  const a = String(typed == null ? "" : typed).replace(/\D/g, "");
  const b = String(expected == null ? "" : expected).replace(/\D/g, "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ============================================================================================== *
 * 4. THE TOOLS
 * ============================================================================================== */

/*
 * Both declare `typedConfirm`, which is the field `assertToolsetSafe` in altana.mjs looks for before
 * it will let a tool cross into an excluded zone. A money tool without it does not boot.
 *
 * Note what is absent from both parameter schemas: any amount, any account, any card, any currency,
 * any "confirm: true" the model could set itself. `buy_credits` takes nothing at all. `set_top_off`
 * takes only a direction, and even that is only a REQUEST for a confirmation sentence naming the
 * direction; the flip happens when a human types the number back.
 */
export const buyCreditsTool = {
  name: "buy_credits",
  write: true,
  irreversible: false,          // reversible in the sense that matters: credits can be refunded
  typedConfirm: "amount",       // the carve-out marker. See assertToolsetSafe.
  zone: "billing",
  summary:
    "Add credits to the user's own account. Takes no amount: it opens a field for the user to type " +
    "the dollar amount themselves, and nothing is charged until they do. Use when they ask you to " +
    "buy, add or top up credits.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const setTopOffTool = {
  name: "set_top_off",
  write: true,
  irreversible: false,
  typedConfirm: "code",
  zone: "billing",
  summary:
    "Switch the user's automatic top-off on or off. Shows them a five digit number to type back " +
    "before anything changes. Use when they ask about automatic top-ups, automatic recharging, or " +
    "being charged without asking.",
  parameters: {
    type: "object",
    properties: {
      on: { type: "boolean", description: "true to switch automatic top-off on, false to switch it off." },
    },
    required: ["on"],
    additionalProperties: false,
  },
};

export const readMoneyTool = {
  name: "read_money_state",
  write: false,
  irreversible: false,
  zone: "budgets",
  typedConfirm: "none",         // reads need no typed value, and the carve-out records why below
  summary:
    "Read the user's OWN credit balance and whether automatic top-off is on. Read only. Use before " +
    "answering a question about their balance so you never guess at a number.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const MONEY_TOOLS = [readMoneyTool, buyCreditsTool, setTopOffTool];

/*
 * The carve-out record. Kept next to the tools for the same reason ALTANA_WITHHELD is kept next to
 * ALTANA_TOOLS: a decision that reverses an earlier decision has to be readable by whoever finds it
 * next, or the next person to read the 2026-08-03 comment will assume this is a bug and remove it.
 */
/*
 * `zones` IS A LIST, and it is a list because the first version of this was wrong in a way the wall
 * caught at boot. `buy_credits` was declared as crossing "billing", which is what it does in plain
 * English, and the exclusion regexes actually place it in "budgets" (the word `credits` is a budgets
 * term; a billing term would be `card` or `invoice`). One verb can honestly sit in two zones, so the
 * grant has to name every zone the verb reaches and the assertion has to check all of them. Declaring
 * one zone and being caught by another is exactly the hole a carve-out could otherwise open.
 */
export const MONEY_CARVE_OUT = [
  {
    tool: "read_money_state", zones: ["budgets"], requires: "none",
    why: "She was answering money questions blind. Fred, 2026-08-12: she may add credits, and an " +
      "assistant that can spend on an account it cannot read is worse than one that can do neither. " +
      "Read only, own account only, no other user's balance is reachable.",
  },
  {
    tool: "buy_credits", zones: ["billing", "budgets"], requires: "typed amount from the user",
    why: "Fred, 2026-08-12: 'able to add credits to the users account with explicit authorization " +
      "from the user, and a please type the amount of credits you would like to purchase field'. " +
      "The tool carries no amount argument, so the figure can only ever be the user's keystrokes.",
  },
  {
    tool: "set_top_off", zones: ["billing", "budgets"], requires: "typed five digit code from the user",
    why: "Fred, 2026-08-12: 'turn on and off the top-off feature for a user with their explicit " +
      "instruction, with a type ##### to confirm field'.",
  },
];

/**
 * Refuse a money toolset that could take an amount from the model. Called from altana.mjs at load, so
 * the process does not start if somebody adds `usd`, `amount`, `credits` or `cents` to `buy_credits`
 * in six months' time because it seemed convenient.
 */
export const AMOUNT_SHAPED = /^(?:usd|amount|value|total|sum|price|cost|credits?|cents|dollars?|qty|quantity|topup|top_?up|top_?off)$/i;

export function assertMoneyToolsSafe(tools = MONEY_TOOLS) {
  const problems = [];
  for (const t of tools) {
    if (!t.typedConfirm) problems.push(`money tool "${t.name}" does not declare typedConfirm`);
    const props = Object.keys((t.parameters && t.parameters.properties) || {});
    if (t.name === "buy_credits" && props.length) {
      problems.push(`"buy_credits" must take no arguments at all; it declares ${props.join(", ")}. ` +
        "The amount is the user's keystrokes, never the model's choice.");
    }
    for (const p of props) {
      if (AMOUNT_SHAPED.test(p)) {
        problems.push(`money tool "${t.name}" takes an amount-shaped argument "${p}". ` +
          "A model must never be able to name a figure that becomes a charge.");
      }
    }
    if (t.parameters && t.parameters.additionalProperties !== false) {
      problems.push(`money tool "${t.name}" allows additional properties, so an amount could arrive unnamed.`);
    }
  }
  if (problems.length) throw new Error("Altana money tools are unsafe:\n  - " + problems.join("\n  - "));
  return true;
}

assertMoneyToolsSafe();

/* ============================================================================================== *
 * 5. THE SENTENCES
 * ============================================================================================== */

/*
 * The prompt shown above the typed field, and the consequence line under it. Written here rather than
 * in the client so the wording cannot drift between what the server enforces and what the user is
 * told, and so a test can read them.
 *
 * Fred gave the purchase prompt almost verbatim, so it is used almost verbatim.
 */
export const PROMPTS = {
  amount: "Please type the amount of credits you would like to purchase.",
  amountHint: "In dollars, between $" + MIN_PURCHASE_USD.toFixed(2) + " and $" + MAX_PURCHASE_USD + ". " +
    "$12.50 gets you 1000 credits.",
  codeOn: "Type the number above to switch automatic top-off on.",
  codeOff: "Type the number above to switch automatic top-off off.",
};

/*
 * WHAT TURNING IT OFF ACTUALLY COSTS THEM, said before they type, not after.
 *
 * This is the honest half of giving her the switch. Automatic top-off is not only a convenience in
 * this app: video generation refuses to run without it, and Engineer mode is gated on it too. A user
 * who switches it off to stop surprise charges and then finds video refusing them has been ambushed
 * by their own assistant. So the consequence rides in the confirmation question itself, where it
 * cannot be missed, and the honest upside is stated in the same breath.
 */
export function topOffConsequence(turningOn) {
  return turningOn
    ? "With this on, your balance tops itself up when it runs low, so a long job will not die halfway " +
      "through. It also means credits can be bought without asking you each time."
    : "Worth knowing before you do: with this off, nothing is ever charged without you asking, and " +
      "two things stop working. Video making needs it on, and so does the full Engineer view of the " +
      "app builder. Everything else carries on as normal, and a long job can run out of credits and stop.";
}

/**
 * The whole confirmation request for one money action, assembled in one place so a caller cannot
 * build half of it. Returns what the client needs to draw the field and what the server needs to
 * check the answer.
 */
export function confirmRequestFor({ tool, args = {}, uid = "", nonce = "", account = null } = {}) {
  const name = String(tool || "");
  if (name === "buy_credits") {
    const bal = account && Number.isFinite(Number(account.balance)) ? Number(account.balance) : null;
    return {
      kind: "amount",
      tool: name,
      nonce,
      prompt: PROMPTS.amount,
      hint: PROMPTS.amountHint,
      // Stated so the user is deciding with the real number in front of them rather than from memory.
      context: bal == null ? "" : "You have " + Math.round(bal) + " credits right now.",
      min: MIN_PURCHASE_USD,
      max: MAX_PURCHASE_USD,
      placeholder: "25",
    };
  }
  if (name === "set_top_off") {
    const on = args.on === true || String(args.on).toLowerCase() === "true";
    const code = typedConfirmCode(nonce, { tool: name, args: { on }, uid });
    return {
      kind: "code",
      tool: name,
      nonce,
      code,
      prompt: on ? PROMPTS.codeOn : PROMPTS.codeOff,
      context: topOffConsequence(on),
      hint: "",
      placeholder: "#####",
    };
  }
  return null;
}

/* ============================================================================================== *
 * 6. DECIDING WHAT HAPPENS TO A TYPED ANSWER
 * ============================================================================================== */

/*
 * Pure. It reads the pending record and the account and returns a decision; it charges nothing and
 * writes nothing. The caller performs the decision. Keeping the judgement testable without a Stripe
 * key or a database is the same separation altana.mjs already uses for tool calls.
 */
export function decideTypedAnswer({ pending = null, typed = "", uid = "", account = null, now = Date.now() } = {}) {
  if (!pending) {
    return { ok: false, verdict: "unknown", say: "I have lost track of what that number was for. Ask me again and I will set it up fresh." };
  }
  if (pending.spentAt) {
    /*
     * REPLAY. The single most important branch in this file. A confirmation is single use, so a
     * double-click, a network retry, a resent request or a user pasting the code twice all land here
     * and none of them charges a second time.
     */
    return { ok: false, verdict: "already", say: "That one is already done, so I have not done it twice." };
  }
  if (Number(pending.createdAt || 0) + CONFIRM_TTL_MS < now) {
    return { ok: false, verdict: "expired", say: "That has been sitting a while, so I have let it lapse rather than act on an old confirmation. Ask me again and I will set it up fresh." };
  }
  if (String(pending.uid || "") !== String(uid || "")) {
    // Belt and braces. The store lookup is already scoped by uid; this catches a caller that forgot.
    return { ok: false, verdict: "wrong-account", say: "I could not match that to your account, so I have not acted on it." };
  }

  if (pending.kind === "amount") {
    const parsed = parseTypedAmount(typed);
    if (!parsed.ok) return { ok: false, verdict: "bad-amount", say: parsed.reason, retryable: true };
    const usd = parsed.usd;
    const hasCard = !!(account && account.hasCard);
    return {
      ok: true,
      verdict: hasCard ? "charge" : "checkout",
      usd,
      credits: creditsForUsd(usd),
      /*
       * Two honest paths, and the difference is stated in words rather than hidden. A returning
       * customer is charged where they stand. A first purchase has no card on file, and the only
       * place a card is ever entered is the app's own secure payment page, so she takes them there.
       * She does not ask for a card and there is no field in which she could accept one.
       */
      say: hasCard
        ? "Right, $" + usd.toFixed(2) + " it is. That comes to " + creditsForUsd(usd) + " credits. Adding them now."
        : "Right, $" + usd.toFixed(2) + " for " + creditsForUsd(usd) + " credits. You have no card saved yet, " +
          "so I am opening the secure payment page for you to enter it there. I never see card details.",
    };
  }

  if (pending.kind === "code") {
    if (!codeMatches(typed, pending.expectedCode)) {
      return { ok: false, verdict: "bad-code", retryable: true,
        say: "That number does not match the one I showed you, so I have changed nothing. Have another look and type it again." };
    }
    let args = {};
    try { args = JSON.parse(pending.argsJson || "{}"); } catch { args = {}; }
    const on = args.on === true;
    return { ok: true, verdict: "toggle", on, say: on
      ? "Confirmed. Switching automatic top-off on for you now."
      : "Confirmed. Switching automatic top-off off for you now." };
  }

  return { ok: false, verdict: "unknown-kind", say: "I am not sure what that number was for, so I have not acted on it." };
}

/* ============================================================================================== *
 * 7. REPORTING THE REAL OUTCOME
 * ============================================================================================== */

/*
 * Every sentence below is written from a result the money engine actually returned, never from the
 * fact that a function was called. This app's whole history is machinery reporting success it never
 * delivered, and money is the worst possible place to continue that tradition.
 */
export function purchaseOutcome({ ok, balance = null, credits = 0, usd = 0, error = "", locked = false } = {}) {
  if (ok) {
    const bal = Number.isFinite(Number(balance)) ? Math.round(Number(balance)) : null;
    return "Done. " + credits + " credits added for $" + Number(usd).toFixed(2) + "." +
      (bal == null ? "" : " You are on " + bal + " credits now.");
  }
  /*
   * A DECLINE IS EXPLAINED, IN PLAIN WORDS, WITH A WAY OUT. The provider's own error string is
   * deliberately not repeated: it is written for a developer, it names the processor, and it is
   * exactly the kind of technical spill Fred asked her never to produce. The classification below is
   * on the SHAPE of the failure, and each branch ends in something the user can actually do.
   */
  const e = String(error || "").toLowerCase();
  if (locked) {
    return "The payment did not go through and the account has been held while that is sorted out. " +
      "Updating the card on the payment screen releases it straight away, and I can take you there.";
  }
  if (/insufficient|declin|card_declined|do_not_honor|generic_decline/.test(e)) {
    return "Your card was turned down, and that is usually the bank rather than anything you have done wrong. " +
      "A different card, or a quick check with them, normally clears it. I can take you to the payment screen.";
  }
  if (/expired/.test(e)) {
    return "The card on file has expired, so the payment did not go through. Adding a current one on the payment screen fixes it, and I can take you there.";
  }
  if (/authentication|3ds|requires_action/.test(e)) {
    return "Your bank wants to check it is really you before this goes through. That has to happen on the payment screen, and I can take you there now.";
  }
  if (/no payment method|no_payment_method|no card/.test(e)) {
    return "There is no card saved on the account yet, so I am taking you to the secure payment page to add one. I never see card details myself.";
  }
  if (/not configured|stripe not configured/.test(e)) {
    return "Payments are not answering at the moment, so nothing was charged. I have recorded it and I will come back to you when it is working.";
  }
  return "The payment did not go through, and nothing has been charged. I have recorded it so it gets looked at, and I will come back to you. " +
    "You can also add credits directly on the payment screen if you would rather not wait for me.";
}

/**
 * The toggle, reported from the state read back AFTER the write rather than from the direction asked
 * for. If the two disagree the user is told the truth, which is the only version of this that is
 * worth anything.
 */
export function topOffOutcome({ asked, actual, error = "" } = {}) {
  if (error) {
    return "I could not change that just now, so it is still " + (actual ? "on" : "off") + ". " +
      "I have recorded it and I will come back to you.";
  }
  if (actual === asked) {
    return asked
      ? "Automatic top-off is on. Your balance will keep itself topped up so a long job does not stop halfway."
      : "Automatic top-off is off. Nothing will be charged to you without you asking for it. " +
        "Remember that video making and the full Engineer view both need it on, so tell me if you want it back.";
  }
  return "I asked for that to be turned " + (asked ? "on" : "off") + " and it has come back " +
    (actual ? "on" : "off") + ", so I am not going to tell you it worked. I have recorded it and I will chase it.";
}

export default {
  MIN_PURCHASE_USD, MAX_PURCHASE_USD, CONFIRM_TTL_MS,
  MONEY_TOOLS, MONEY_CARVE_OUT, buyCreditsTool, setTopOffTool, readMoneyTool,
  parseTypedAmount, creditsForUsd, typedConfirmCode, codeMatches,
  confirmRequestFor, decideTypedAnswer, purchaseOutcome, topOffOutcome, topOffConsequence,
  assertMoneyToolsSafe, PROMPTS,
};
