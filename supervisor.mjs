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
const NO_PROGRESS_LIMIT = 2;          // two mutation attempts on one target with no byte delta = stall

const estTok = (chars) => Math.ceil(chars / 4);

// Detect a model looping inside ONE answer. Tool/round supervision cannot see this shape because
// the provider is still producing a single completion. Six consecutive copies is far beyond
// legitimate rhetorical repetition; cut at the third copy so the user gets enough context to
// recognize what happened without receiving pages of it.
export function textLoopEvidence(text, minRepeats = 6) {
  const rows = [];
  const re = /[^\r\n]+/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const normalized = m[0].trim().replace(/\s+/g, " ").toLowerCase();
    if (normalized.length >= 16) rows.push({ normalized, at: m.index, raw: m[0].trim() });
  }
  let prior = "", run = 0, thirdAt = 0;
  for (const row of rows) {
    if (row.normalized === prior) run++;
    else { prior = row.normalized; run = 1; thirdAt = 0; }
    if (run === 3) thirdAt = row.at;
    if (run >= minRepeats) return { looping: true, phrase: row.raw.slice(0, 160), repeats: run, cutAt: thirdAt || row.at };
  }
  return { looping: false };
}

const normalizedTarget = (name, args = {}) => {
  if (args.path) return String(args.path).replace(/\\/g, "/").toLowerCase();
  if (name !== "forge_run") return "";
  const command = String(args.command || "");
  const quoted = [...command.matchAll(/["']([^"']+\.[a-z0-9_-]{1,12})["']/ig)].map((m) => m[1]);
  const bare = command.match(/(?:[a-z]:[\\/]|\.{0,2}[\\/])[^;\r\n|]+?\.[a-z0-9_-]{1,12}\b/i);
  return String(quoted[0] || (bare && bare[0]) || "").trim().replace(/\\/g, "/").toLowerCase();
};
const isMutationAttempt = (name, args = {}) => {
  if (name === "forge_write" || name === "forge_edit") return true;
  if (name !== "forge_run") return false;
  return /\b(set-content|out-file|add-content|copy-item|move-item|rename-item|remove-item|new-item|sed\s+-i|perl\s+-pi|python(?:3)?\s+-c)\b|(?:^|\s)(?:>>?|2>)\s*\S/i.test(String(args.command || ""));
};

// Exit zero is execution success, not mutation success: only the explicit change marker proves
// that bytes moved.
export function summarizeToolOutcome({ name = "?", args = {}, result = "", failed = false } = {}) {
  const text = String(result || "");
  const target = normalizedTarget(name, args);
  const mutation = isMutationAttempt(name, args);
  const changed = mutation
    ? (/^(?:CHANGED:)|\nCHANGE:/m.test(text) ? true
      : /^(?:NO CHANGE:|EDIT REFUSED)|\nNO TRACKED CHANGE:/m.test(text) || failed ? false : null)
    : null;
  const outcome = failed ? "failed"
    : changed === true ? "changed bytes"
    : changed === false ? "no byte change"
    : "completed";
  return {
    summary: `${name} · ${outcome}${target ? ` · ${target}` : ""}`,
    mutation, changed, target,
  };
}

// Deterministic loop detector: catches both identical calls and semantically equivalent mutation
// attempts whose arguments vary but whose target never changes.
export function createLoopWatch() {
  const counts = new Map();
  const stalledTargets = new Map();
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
    outcome(event) {
      const evidence = summarizeToolOutcome(event);
      if (!evidence.mutation || !evidence.target) return { looping: false, ...evidence };
      if (evidence.changed === true) {
        stalledTargets.delete(evidence.target);
        return { looping: false, ...evidence };
      }
      if (evidence.changed !== false) return { looping: false, ...evidence };
      const n = (stalledTargets.get(evidence.target) || 0) + 1;
      stalledTargets.set(evidence.target, n);
      return {
        looping: n >= NO_PROGRESS_LIMIT,
        sig: `${n} mutation attempts changed no bytes in ${evidence.target}`,
        ...evidence,
      };
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
    trail + "\n\nOnly observable evidence counts: changed bytes, newly learned file contents, passing " +
    "checks, or completed deliverables. A command exiting successfully without a file delta is NOT " +
    "progress, and action volume is not progress. Is it genuinely advancing, or is it stuck " +
    "(repeating itself, failing the same way, wandering)? " +
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
