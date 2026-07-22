/*
 * The Crucible speaks three languages.
 *   Fred's ruling 2026-07-21, verbatim reasoning: a 56-year-old man just asked him what "deploy"
 *   means. Commit, push, PR: every one of those words costs customers, purely on language. So the
 *   user picks a register at the front door and the app populates it at every level:
 *
 *     plain      Plain English. No jargon anywhere, ever. The default.
 *     technical  Proper terminology, for people who already speak it and find translation noise.
 *     hybrid     Tech speak with English explanations: the terms, each taught in passing.
 *
 * This module is the SERVER's dictionary: every sentence the build runner says to a human comes
 * from here, keyed and per-register. The client mirror lives in public/dominion-lexicon.js and
 * covers the UI chrome; the two share key names where the same idea appears on both sides.
 *
 * Rule for writers: plain never assumes; technical never translates; hybrid does both, term
 * first, meaning in the same breath.
 */

export const REGISTERS = ["plain", "technical", "hybrid"];
export const DEFAULT_REGISTER = "plain";

export const normalizeRegister = (v) => (REGISTERS.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : DEFAULT_REGISTER);

const D = {
  // ---- the runner's questions and endings ---------------------------------------------------
  budget_question: {
    plain: (cap, spent) => "This build has reached its spending limit of " + cap + " (it has used " + spent + " so far). Keep going?",
    technical: (cap, spent) => "Budget cap reached: " + cap + " (spent " + spent + "). Continue past the cap?",
    hybrid: (cap, spent) => "Budget cap reached (the spending limit you set): " + cap + ", with " + spent + " spent. Continue?",
  },
  budget_keep: { plain: "Keep going", technical: "Continue", hybrid: "Continue (keep building)" },
  budget_stop: { plain: "Stop here", technical: "Abort", hybrid: "Abort (stop here)" },
  budget_stopped: {
    plain: "Stopped at the spending limit, at your request.",
    technical: "Aborted at budget cap, per user.",
    hybrid: "Aborted (stopped) at the budget cap, at your request.",
  },
  move_failed_question: {
    plain: (title) => "The step \"" + title + "\" could not finish. The detail is above. What now?",
    technical: (title) => "Move \"" + title + "\" failed. Log above. Action?",
    hybrid: (title) => "The move (build step) \"" + title + "\" failed. The log is above. What now?",
  },
  move_retry: { plain: "Try it again", technical: "Retry", hybrid: "Retry (try it again)" },
  move_skip: { plain: "Skip this step", technical: "Skip", hybrid: "Skip (leave this step out)" },
  move_stop: { plain: "Stop the build", technical: "Abort build", hybrid: "Abort (stop the whole build)" },
  move_stopped: {
    plain: "Stopped after a failed step, at your request.",
    technical: "Build aborted after failed move, per user.",
    hybrid: "Build aborted (stopped) after a failed move, at your request.",
  },
  no_node: {
    plain: "Your computer is not connected. Start the Dominion helper on the computer that holds this project, then run the build again.",
    technical: "No hands node connected. Start the node on the target machine and rerun.",
    hybrid: "No hands node (the small Dominion helper program on your computer) is connected. Start it on the machine holding this project, then rerun.",
  },
  auto_home_fail: {
    plain: "I could not make a home for your app on the computer. Make sure the Dominion helper is running there, then try again.",
    technical: "Auto-workspace creation failed on the node.",
    hybrid: "Could not create the workspace (the app's home folder) on the build machine. Check the node and retry.",
  },
  build_done: {
    plain: "Build complete.",
    technical: "Build complete.",
    hybrid: "Build complete.",
  },
  carveout_stop: {
    plain: "Stopped at a hard safety wall. Nothing was written.",
    technical: "Halted at protected-path carve-out. No writes performed.",
    hybrid: "Halted at a carve-out (a hard safety wall around backups). Nothing was written.",
  },
  move_dead: {
    plain: "A step could not be completed. The detail is above.",
    technical: "Move failed; see log above.",
    hybrid: "A move (build step) failed; the log is above.",
  },
  // The Furnace pass (doctrine 2026-07-21): honesty before "done".
  furnace_question: {
    plain: (n) => "Before calling this done, the work was checked honestly. " + n + " thing" + (n === 1 ? " is" : "s are") + " unfinished or missing; the list is above. Want them closed now?",
    technical: (n) => "Furnace audit: " + n + " finding" + (n === 1 ? "" : "s") + " (above). Close now?",
    hybrid: (n) => "Furnace audit (the honesty check before done): " + n + " finding" + (n === 1 ? "" : "s") + ", listed above. Close now?",
  },
  furnace_fix: { plain: "Close them now", technical: "Fix findings", hybrid: "Fix (close them now)" },
  furnace_finish: { plain: "Finish as is", technical: "Accept as is", hybrid: "Accept (finish as is)" },
};

/*
 * phrase("budget_keep", "plain") or phrase("budget_question", "hybrid", cap, spent).
 * Unknown keys return the key itself so a typo is visible instead of silent, and every key falls
 * back to plain, so an unfinished translation degrades to the register that excludes nobody.
 */
export function phrase(key, register, ...args) {
  const entry = D[key];
  if (!entry) return key;
  const r = normalizeRegister(register);
  const v = entry[r] != null ? entry[r] : entry.plain;
  return typeof v === "function" ? v(...args) : v;
}

// The planner writes card titles and rationales the user reads, so the register reaches it too.
export function plannerVoice(register) {
  const r = normalizeRegister(register);
  if (r === "technical") return "Write move titles and rationales in precise technical terminology; the reader is an engineer.";
  if (r === "hybrid") return "Write move titles in technical terms, each followed by a short plain-English gloss in parentheses.";
  return "Write move titles and rationales in plain English a non-programmer follows; no jargon.";
}

// Answer matching must accept every register's wording for the same choice.
export const ANSWER = {
  keepGoing: /keep|continue|yes|go|proceed/i,
  stop: /stop|abort|halt|cancel/i,
  retry: /try|retry|again/i,
  skip: /skip|leave/i,
  fix: /close|fix|repair|yes|now/i,
};

export const DICT_KEYS = Object.keys(D);
