/*
 * Dominion AI — the kept-promise guard (Fred, 2026-07-19).
 *
 * THE FAILURE: a model answers "let me familiarize myself with the project first" and then stops.
 * No tool call, no further text, turn over. The user is left holding a promise. Fred saw it on
 * DeepSeek V4 Pro and has seen it on other models, and it violates the thing this product is FOR:
 * when Dominion says it is going to do something, it does it.
 *
 * WHY THE EXISTING GUARDS MISS IT. The chat loop already handles three ways a turn can end badly:
 * output truncated at the length cap (it continues), an empty reply (it retries for plain text),
 * and a research loop that runs out of tool budget (it forces a conclusion). All three test the
 * SHAPE of the reply. This failure has a perfectly healthy shape: real content, a clean stop, no
 * tool calls. Only the MEANING gives it away, so that is what this reads.
 *
 * THE RULE: a turn may not end on a stated intention to act. If the final sentence promises an
 * action the model could have taken with the tools it was holding, the loop gets one more round
 * with an explicit instruction to do it now. One nudge per turn, never a loop.
 *
 * FALSE POSITIVES ARE THE REAL RISK, since a wrong fire costs a wasted round and a confused model.
 * The tests hold the line: a promise only counts when it is the LAST thing said (nothing delivered
 * after it), it names a real action verb, and it is not a question, a refusal, or a mere intention
 * to keep something in mind.
 */

// First-person commitments to act. Deliberately narrow: these are the phrasings that precede an
// action, not the ones that decorate a finished answer.
const COMMIT = /\b(?:i(?:'|’)?ll|i will|i'?m going to|i am going to|let me|allow me to|i need to|i should|first,?\s+(?:i(?:'|’)?ll|i will|let me)|give me (?:a |one )?(?:moment|second|minute|sec)|one moment|hold on|stand ?by|bear with me)\b/i;

// The verbs that mean "go get / go do", i.e. work the tools exist for. "keep in mind", "remember
// that", "be careful" and friends are absent on purpose: they promise nothing retrievable.
const ACTION = /\b(?:look|check|read|search|find|review|examine|inspect|explore|familiari[sz]e|investigate|analy[sz]e|verify|confirm|gather|collect|fetch|pull|retrieve|open|list|scan|browse|query|run|execute|test|write|create|build|draft|generate|make|update|edit|modify|fix|start|begin|proceed|dig|study|survey|map|trace|audit|compare|calculate|compute|call|use|consult|reference|access|load|import|download|upload|save|store)\b/i;

// Signals that the tail is NOT an unkept promise.
const REFUSAL = /\b(?:i (?:can'?t|cannot|won'?t|will not|am unable|do not have|don'?t have))\b/i;

/** Split off the last meaningful sentence, ignoring trailing whitespace and list punctuation. */
function lastSentence(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  // Sentence enders, but keep decimals/abbreviations from splitting mid-number.
  const parts = t.split(/(?<=[.!?:])\s+(?=[A-Z"'\-*_#\d])/);
  let tail = parts[parts.length - 1] || t;
  // A trailing markdown bullet or heading line on its own is the real tail.
  const lines = tail.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length) tail = lines[lines.length - 1];
  return tail.trim();
}

/**
 * Does this answer end on a promise the model never kept?
 *   answer          the model's final text for the round
 *   toolsAvailable  were tool schemas actually attached this round? (no tools = nothing to keep)
 * Returns { unkept, promise } — promise is the offending sentence, for the nudge and the log.
 */
export function unkeptIntent(answer, { toolsAvailable = true } = {}) {
  const text = String(answer || "").trim();
  if (!text || !toolsAvailable) return { unkept: false, promise: "" };

  const tail = lastSentence(text);
  if (!tail) return { unkept: false, promise: "" };

  // A question hands the turn back to the user on purpose. That is a kept turn, not a broken one.
  if (/\?\s*$/.test(tail)) return { unkept: false, promise: "" };
  // An honest "I can't do that" is also a complete answer.
  if (REFUSAL.test(tail)) return { unkept: false, promise: "" };

  if (!COMMIT.test(tail) || !ACTION.test(tail)) return { unkept: false, promise: "" };

  // The commitment has to come BEFORE the action word ("let me check" counts; "check whether I'll
  // need it" does not).
  const c = tail.search(COMMIT), a = tail.search(ACTION);
  if (c < 0 || a < 0 || a < c) return { unkept: false, promise: "" };

  return { unkept: true, promise: tail.slice(0, 220) };
}

/** The instruction that goes back to the model. User role: agent-tuned models ignore trailing
 *  system messages (learned the hard way on the MiniMax mute bug, 2026-07-12). */
export function intentNudge(promise) {
  return "[Dominion system notice — not Fred] You ended your turn on a promise: \"" + promise +
    "\" — and then did nothing. Do it NOW, in this turn: call the tool you need and act. " +
    "If the tool you need is not available or the task cannot be done, say so plainly in one line " +
    "and give your best answer from what you already have. Never end a turn on an intention.";
}
