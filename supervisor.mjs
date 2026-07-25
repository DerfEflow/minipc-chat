/*
 * Dominion AI — the work supervisor (Fred's design, 2026-07-25).
 *
 * Replaces the fixed round cap on cloud agent turns with a PROCESS gate: the worker model runs as
 * long as it is genuinely advancing, and is paused only for reasons of quality, fidelity, or
 * context window — never an arbitrary counter. The supervisor judges PROGRESS, not correctness:
 * a supervisor that second-guesses content needs to be as smart as the worker and can wreck good
 * work; one that only asks "still moving? not looping? room left?" is cheap and cannot.
 *
 * Three deterministic gates run in CODE (free, every round):
 *   1. loop detection      — the same tool call (name+args) repeating 3x is a stall, caught here,
 *                            no model opinion required;
 *   2. context headroom    — pause at 75% of the worker's window so the wrap-up itself has room;
 *   3. hard runaway fuse   — 64 rounds. Not a work limit; insurance against a pathological loop
 *                            the signature check can't see (e.g. ever-changing args, same futility).
 * The one genuinely fuzzy question — "is this advancing toward the goal?" — goes to a cheap
 * supervisor model every 8 rounds, fed a rolling DIGEST (never the full transcript, so its own
 * context stays tiny by construction). A supervisor failure defaults to "keep working": the
 * supervisor exists to stop runaways, and must never become one itself by killing good work on a
 * parse hiccup.
 *
 * On any pause, the worker is ordered to write an honest summary: what got done, what remains,
 * why work stopped, naming the monitored model — Fred's rule: a pause is a report, not a shrug.
 */

export const SUP_CHECK_EVERY = 8;     // supervisor verdict cadence (rounds)
export const SUP_HARD_CAP = 64;       // runaway insurance, not a work limit
export const SUP_CTX_FRACTION = 0.75; // pause when the assembled prompt passes 75% of the window
const SIG_LIMIT = 3;                  // identical tool call this many times = loop

const estTok = (chars) => Math.ceil(chars / 4);

// Deterministic loop detector: counts exact tool-call signatures across the whole turn.
export function createLoopWatch() {
  const counts = new Map();
  return {
    note(calls) {
      for (const c of Array.isArray(calls) ? calls : []) {
        const fn = c && c.function || {};
        const sig = (fn.name || "?") + "|" + (typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}));
        const n = (counts.get(sig) || 0) + 1;
        counts.set(sig, n);
        if (n >= SIG_LIMIT) return { looping: true, sig: (fn.name || "?") + " with identical arguments" };
      }
      return { looping: false };
    },
  };
}

// Context headroom: estimate the assembled prompt and compare against the window fraction.
export function contextExceeded({ messages = [], ctx = 128000, fraction = SUP_CTX_FRACTION } = {}) {
  const chars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0)
    + (Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls).length : 0), 0);
  return estTok(chars) > Math.floor(ctx * fraction);
}

// The supervisor sees a digest, not the transcript: the ask, the round count, and the tool trail.
export function supervisorPrompt({ goal = "", rounds = 0, toolSummaries = [] } = {}) {
  const trail = toolSummaries.slice(-20).join("\n") || "(no tool activity)";
  return "You are the work supervisor for an AI agent session. Judge PROGRESS ONLY — not quality, " +
    "not correctness. The agent has run " + rounds + " work rounds toward this goal:\n\n" +
    String(goal).slice(0, 600) + "\n\nIts tool activity so far (name · outcome), most recent last:\n" +
    trail + "\n\nIs it genuinely advancing (new files read, new actions succeeding, visible movement " +
    "toward the goal), or is it stuck (repeating itself, failing the same way, wandering)? " +
    'Reply with ONLY JSON: {"progressing": true|false, "reason": "<one short sentence>"}';
}

// Forgiving verdict parse: any glitch = keep working (the supervisor must never kill good work).
export function parseVerdict(text) {
  try {
    const m = /\{[\s\S]*\}/.exec(String(text || ""));
    if (!m) return { progressing: true, reason: "supervisor unreadable — defaulting to continue" };
    const j = JSON.parse(m[0]);
    if (typeof j.progressing !== "boolean") return { progressing: true, reason: "supervisor unreadable — defaulting to continue" };
    return { progressing: j.progressing, reason: String(j.reason || "").slice(0, 240) };
  } catch { return { progressing: true, reason: "supervisor unreadable — defaulting to continue" }; }
}

// The pause order to the worker: an honest report, never a shrug. Complete work reads as a normal
// finish; stopped work says what/why/who out loud (Fred: name the monitored model for clarity).
export function pauseInstruction({ reason = "", model = "" } = {}) {
  return "[Dominion supervisor notice — not Fred] Work on this turn is being paused: " + reason + ". " +
    "Tool calls are disabled from here on. Write a clear report for the user NOW: " +
    "(1) a summary of everything accomplished so far this turn, " +
    "(2) exactly what remains to be done, if anything, and " +
    "(3) one plain sentence stating why work paused — if the task is actually COMPLETE, say it is " +
    "complete instead. State that the model doing this work was " + model + ". " +
    "Progress is saved; the user can continue with a follow-up message.";
}
