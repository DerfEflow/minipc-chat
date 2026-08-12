/*
 * Dominion AI. THE PLAIN ENGLISH WALL on everything Altana says.
 *
 * FRED, 2026-08-12: "it should not respond with it actual technical actions, code, etc. It should
 * ALWAYS respond in plain english, assuring the user it will be proactively working on the issue.
 * and follow up when it is done."
 *
 * WHY A FILTER AND NOT A SENTENCE IN HER PROMPT. Her prompt already tells her not to reveal the
 * app's internals, and that instruction has held for the doctrine it was written for. It cannot hold
 * for this, because this is not a rule about SECRETS, it is a rule about REGISTER: a model that is
 * being helpful about a broken build will quote the failure, and quoting the failure is the single
 * most natural helpful act available to it. A preference loses that argument eventually. So the
 * promise is kept the same way every other promise in this subsystem is kept, by making the
 * unwanted thing structurally unable to reach the wire.
 *
 * This is the mirror image of altana-context.mjs. That module filters what comes IN so a secret
 * cannot reach her. This one filters what goes OUT so a technicality cannot reach the customer.
 *
 * TWO TIERS, and the distinction is the whole design:
 *
 *   SOFTEN  Something technical in FORM that the user genuinely wants to know. A setting called
 *           `privacy_mode` is a real answer to "what did you change"; it is only the underscore that
 *           is wrong. Softening rewrites it into English and keeps the meaning.
 *   STRIP   Something with no plain English meaning at all: a code block, a stack frame, a file
 *           path, a query, a raw payload. There is nothing to preserve, so it goes, and what
 *           replaces it is a sentence about what happens next.
 *
 * WHAT THIS MUST NOT DO, and the reason the rules target SHAPES rather than WORDS. Her answer book
 * is full of legitimate references to real controls: "Buy credits", "the Setup screen", "Deep Think",
 * "$12.50", "DOMI-4F2A-9K3B", "100 credits is one dollar". A filter that hunted technical VOCABULARY
 * would eat the answer book and leave her unable to explain her own app. Every rule below is written
 * against a shape a human never types in a sentence, and altana-plain_test.mjs asserts that a sample
 * of real FAQ answers passes through byte for byte.
 */

/* ============================================================================================== *
 * 1. THE STRIP RULES: content with no plain English meaning
 * ============================================================================================== */

/*
 * Ordered longest-shape-first so a fenced block is removed whole before its innards can be matched
 * as separate paths and identifiers, which would leave a drift of markers where one clean sentence
 * belongs.
 */
export const STRIP_RULES = [
  // Fenced code, whole. The fence is the clearest possible declaration of "this is not prose".
  { kind: "code", re: /```[\s\S]*?```/g },
  { kind: "code", re: /~~~[\s\S]*?~~~/g },
  // An unterminated fence: the model started a block and ran out of tokens. Everything after it goes,
  // because a half-printed program is still a program.
  { kind: "code", re: /```[\s\S]*$/g },
  // Stack frames. Any one of these lines means the reply has turned into a crash report.
  { kind: "trace", re: /^\s*at\s+[\w$.<>[\] ]+\s*\(?[^\n)]*\)?\s*$/gm },
  { kind: "trace", re: /\b[A-Za-z]*Error\b:?[^\n]{0,200}/g },
  { kind: "trace", re: /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EACCES|ENOENT|EPIPE)\b[^\n]{0,120}/g },
  // Windows and POSIX absolute paths, and anything with a directory separator and a file extension.
  { kind: "path", re: /\b[A-Za-z]:\\(?:[^\s\\"'<>|]+\\)*[^\s\\"'<>|]*/g },
  { kind: "path", re: /(?:^|[\s"'(=])(\/(?:home|root|Users|var|etc|opt|srv|mnt|proc|app|data|tmp)\/[^\s"'),;]*)/g, group: 1 },
  { kind: "path", re: /\b[\w.-]+\/[\w.-]+\.(?:mjs|js|cjs|ts|tsx|jsx|py|json|sql|sh|ps1|yml|yaml|css|html|md)\b/g },
  // A bare source file name. Bounded to real extensions so "setup.html" in a sentence about the
  // Setup screen is caught (it is a file name and the user does not need it) while "Dominion AI"
  // and "GPT-5.6" are untouched.
  { kind: "file", re: /\b[\w-]+\.(?:mjs|cjs|jsx|tsx|ts|py|json|sql|ps1|yml|yaml|env)\b/g },
  // SQL. Anchored on a verb plus its own keyword so ordinary prose containing "select" or "update"
  // is left alone.
  { kind: "query", re: /\b(?:SELECT\s+[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|INDEX)\b)[^\n;]{0,200};?/gi },
  // A raw payload. Deliberately requires a quoted key and a colon, so a sentence with braces in it
  // is safe and a serialised object is not.
  { kind: "payload", re: /\{[^{}\n]{0,80}"[\w-]+"\s*:[\s\S]{0,400}?\}/g },
  // Environment variable names: screaming snake case with at least one underscore.
  { kind: "config", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g, unless: /^(?:DOMI|FAQ|AI|API)$/ },
  // A function or method call written as code.
  { kind: "code", re: /\b[a-z][\w$]*(?:\.[a-z][\w$]*)+\s*\([^)\n]{0,120}\)/gi },
  // HTML and XML tags.
  { kind: "markup", re: /<\/?[a-z][\w-]*(?:\s[^<>\n]{0,200})?>/gi },
  // Internal hosts and ports.
  { kind: "host", re: /\b(?:localhost|0\.0\.0\.0)(?::\d{2,5})?\b/gi },
  /*
   * ANY dotted quad, rather than an enumeration of private ranges. The first version listed the
   * RFC1918 blocks and missed 100.111.181.71, which is the machine address this project actually uses
   * (Tailscale hands out 100.64/10, and that block is neither RFC1918 nor obvious). Enumerating
   * ranges is a promise to remember every range, and the enumeration was already wrong on the first
   * address it met. Four dot-separated numbers is a shape no customer needs to read in any case, and
   * it cannot collide with prose: a price ($12.50) and a version (GPT-5.6) have one dot, not three.
   */
  { kind: "host", re: /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g },
  // A long hex or base64ish run: a commit, an id, a hash, a key. Never something to read aloud.
  { kind: "identifier", re: /\b(?=[0-9a-f]{12,}\b)[0-9a-f]{12,}\b/gi },
];

/*
 * A sentence that NAMES a technical act. Softening cannot help here, because the problem is not the
 * spelling of one token, it is that the whole clause is the assistant narrating its own machinery at
 * a person who asked for help. The clause is removed and the surrounding prose is kept.
 *
 * "I called the log_complaint tool and it returned ok" has no plain English version worth keeping.
 * "I have made a note of that for you" is what the user needed, and she says it elsewhere.
 */
export const NARRATION_RULES = [
  { kind: "narration", re: /\b(?:I|I'?ll|I have|I've|let me)\s+(?:just\s+)?(?:call|called|calling|invoke|invoked|invoking|run|ran|running|execute|executed|executing)\s+(?:the\s+)?[\w_.-]+\s+(?:tool|function|endpoint|command|query|script|api)\b[^.!?\n]{0,80}[.!?]?/gi },
  { kind: "narration", re: /\bthe\s+[\w_.-]+\s+(?:tool|function|endpoint|handler|module|parameter|argument|schema)\s+(?:returned|responded|failed|threw|expects?|requires?)\b[^.!?\n]{0,100}[.!?]?/gi },
  /*
   * "According to the SERVER logs". The first version allowed only an optional "the" before the noun,
   * so one qualifier word was enough to walk straight through it, and "according to the server logs"
   * is the single most likely phrasing of the thing being caught.
   */
  { kind: "narration", re: /\b(?:according to|based on|per)\s+(?:the\s+)?(?:\w+\s+){0,2}(?:logs?|stack\s?trace|error\s?(?:message|output|log)|trace)\b[^.!?\n]{0,100}[.!?]?/gi },
  { kind: "narration", re: /\bHTTP\s*\d{3}\b[^.!?\n]{0,80}[.!?]?/gi },
  { kind: "narration", re: /\b(?:status|error)\s*(?:code)?\s*[:=]?\s*\d{3}\b[^.!?\n]{0,80}[.!?]?/gi },
  /*
   * BARE TECHNICAL NOUNS, and this list is short on purpose. It began as a broad sweep of
   * infrastructure words guarded by "does the sentence also look technical", and both halves were
   * wrong. The guard tested for the same words the rule matched, so it was satisfied by its own hit
   * and never once refused anything. And the word list contained the vocabulary of the app's own
   * interface: `table` is the task table, `log` is the build log, `deploy` is what a user does to
   * their app, `query` is a search, `endpoint` appears in a real answer about provider failover. It
   * mangled eight shipped answers, including turning "just because one endpoint stopped answering"
   * into a dangling clause.
   *
   * So the list is now only nouns with NO user-facing meaning anywhere in this app: a customer never
   * has a legitimate reason to read any of these, and no FAQ answer contains one. The guard is gone,
   * because a correctly narrow list does not need one.
   */
  { kind: "narration", re: /\b(?:schema|regex|middleware|webhook|payload|stack\s?trace|migration|null|undefined|stdout|stderr|traceback)\b[^.!?\n]{0,80}[.!?]?/gi },
];

/* ============================================================================================== *
 * 2. THE SOFTEN RULES: technical in form, useful in meaning
 * ============================================================================================== */

/*
 * Applied AFTER narration removal and BEFORE stripping, and both halves of that order are load-bearing.
 *
 * AFTER NARRATION, learned the hard way. Softening ran first in the original and it silently disarmed
 * the narration rules: "I called the log_complaint tool and it returned ok" became "I called the
 * recording the problem tool ...", which no longer matches a pattern expecting one token before
 * "tool", so the whole clause sailed through. Softening a tool's NAME destroys the evidence that a
 * tool was being narrated. Take the clause out first, then rewrite whatever is left.
 *
 * BEFORE STRIPPING, for the original reason: `set_setting` written with parentheses would be eaten
 * whole by the function-call rule, and softening first means the meaning survives.
 */
export const SOFTEN_RULES = [
  // Known setting and screen keys, spelled the way a person would say them.
  { re: /\bprivacy[_-]mode\b/gi, to: "privacy mode" },
  { re: /\bauto(?:recharge|_recharge)\b/gi, to: "automatic top-off" },
  /*
   * `topup` and `top_off` are identifiers. "top-up" WITH A HYPHEN is ordinary English and appears in
   * shipped answers ("$12.50 is the smallest top-up", "a payment method with auto top-up enabled"),
   * so the hyphen is deliberately excluded. The first version rewrote the app's own price copy.
   */
  { re: /\btop(?:up|_up|_off)\b/gi, to: "top-off" },
  { re: /\bset[_-]setting\b/gi, to: "that setting" },
  { re: /\bopen[_-]screen\b/gi, to: "opening that screen" },
  { re: /\blog[_-]complaint\b/gi, to: "recording the problem" },
  { re: /\bsearch[_-]help\b/gi, to: "looking it up" },
  { re: /\blist[_-](?:work|settings)\b/gi, to: "listing that for you" },
  { re: /\bdelete[_-]saved[_-]work\b/gi, to: "deleting that saved work" },
  { re: /\bdelete[_-]work[_-]order\b/gi, to: "deleting that scheduled job" },
  { re: /\bbuy[_-]credits\b/gi, to: "adding credits" },
  { re: /\bset[_-]top[_-]off\b/gi, to: "switching automatic top-off" },
  { re: /\bopen[_-]ticket\b/gi, to: "recording it" },
  { re: /\bescalate[_-]to[_-]owner\b/gi, to: "getting it in front of Fred" },
  // Any remaining lowercase snake_case identifier reads as words. This is the general case and it
  // runs last of the soften rules so the named ones above win their own phrasing.
  { re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g, to: (m) => m.replace(/_/g, " ") },
];

/* ============================================================================================== *
 * 3. THE ASSURANCE: what replaces what was taken out
 * ============================================================================================== */

/*
 * Fred asked for two things in one sentence: plain English, and an assurance that she is working the
 * issue and will come back. So a reply that lost its substance to the filter is not left as a shrug.
 * It is replaced by the promise, which is the thing he actually wants said.
 *
 * Chosen by what the turn was ABOUT, because "I am on it" is right for a fault and wrong for a
 * question about pricing.
 */
export const ASSURANCE = {
  working: "I am on this now. I will keep working at it and come back to you the moment it is sorted, so you do not need to chase it.",
  reported: "I have written this up properly and it is with Fred now. I will follow up with you here as soon as it has been dealt with.",
  acted: "That is done. If it does not look right on your end, tell me and I will stay on it.",
  cannot: "This one is not mine to change, so I am not going to pretend otherwise. I have recorded it and passed it on, and I will let you know what comes back.",
  neutral: "Let me get that sorted for you. I will come back to you when it is done.",
};

/* ============================================================================================== *
 * 4. THE FILTER
 * ============================================================================================== */

const collapse = (s) => String(s)
  .replace(/[ \t]{2,}/g, " ")
  // A marker left touching its punctuation reads as a redaction. Tidy the seams.
  .replace(/\s+([.,;:!?])/g, "$1")
  .replace(/\(\s*\)/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .replace(/^[ \t]+|[ \t]+$/gm, "")
  .trim();

function applyNarration(text, hits) {
  let out = text;
  for (const rule of NARRATION_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    out = out.replace(re, () => {
      hits[rule.kind] = (hits[rule.kind] || 0) + 1;
      return " ";
    });
  }
  return out;
}

/**
 * Make one reply safe to show a customer.
 *
 * Returns { text, hits, stripped, softened, gutted } where `hits` counts what was caught by kind,
 * `stripped` is true when anything at all was removed, and `gutted` is true when so much went that
 * the assurance replaced the reply rather than joining it.
 *
 * Pure and idempotent: running it on its own output changes nothing, because a marker and a softened
 * phrase both match no rule.
 */
export function plainEnglish(reply, { assurance = "neutral", minKeptChars = 24 } = {}) {
  const original = String(reply == null ? "" : reply);
  if (!original.trim()) {
    return { text: "", hits: {}, stripped: false, softened: false, gutted: false };
  }

  const hits = Object.create(null);
  let text = original;
  let softened = false;

  // Tier 1. Whole clauses of self-narration, FIRST, while the tool names in them are still spelled
  // the way the patterns expect. See the note above SOFTEN_RULES for what happens when this runs second.
  text = applyNarration(text, hits);

  // Tier 2. Meaning-preserving rewrites, so the strip pass has less to destroy.
  for (const rule of SOFTEN_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    text = text.replace(re, (...args) => {
      softened = true;
      hits.softened = (hits.softened || 0) + 1;
      return typeof rule.to === "function" ? rule.to(args[0]) : rule.to;
    });
  }

  // Tier 3. Content with no plain meaning. Removed outright rather than marked: a marker like
  // "[removed]" is itself a technical artefact, and Fred's rule is that the customer sees none.
  for (const rule of STRIP_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    text = text.replace(re, (...args) => {
      const whole = args[0];
      const groups = args.slice(1, -2);
      const target = rule.group ? groups[rule.group - 1] : whole;
      if (rule.unless && rule.unless.test(String(target))) return whole;
      hits[rule.kind] = (hits[rule.kind] || 0) + 1;
      if (rule.group) return whole.replace(target, " ");
      return " ";
    });
  }

  text = collapse(text);

  /*
   * Did anything survive worth reading? A reply that was 90% code leaves behind a fragment like
   * "Here is the fix:" which is worse than saying nothing, because it promises something that is no
   * longer there. Two tests, and either one condemns it: too little left in absolute terms, or too
   * little left relative to what arrived.
   */
  const strippedAnything = Object.keys(hits).some((k) => k !== "softened");
  /*
   * `measure` flattens newlines and exists ONLY to judge how much survived. The returned value is
   * `text`, which keeps its paragraphs. Returning the flattened form instead was a real defect: it
   * silently collapsed every multi-paragraph reply into one block, and it broke idempotency, because
   * a second pass would eat the blank line the first pass had just put before the assurance.
   */
  const measure = text.replace(/\s+/g, " ").trim();
  const gutted = strippedAnything && (measure.length < minKeptChars || measure.length < original.trim().length * 0.35);

  const line = ASSURANCE[assurance] || ASSURANCE.neutral;
  if (gutted) return { text: line, hits, stripped: true, softened, gutted: true };

  /*
   * Something was removed and enough remains to read. The assurance is APPENDED rather than
   * substituted, because the surviving prose is the answer and the promise is the part Fred asked to
   * always be there. Skipped when she already said it, so she does not promise twice in one breath,
   * and skipped when the assurance is already the tail of the text so a second pass adds nothing.
   */
  if (strippedAnything
    && !/\b(?:come back to you|follow up|let you know|keep working|stay on it|on this now)\b/i.test(measure)
    && !measure.endsWith(line.replace(/\s+/g, " ").trim())) {
    return { text: text + "\n\n" + line, hits, stripped: true, softened, gutted: false };
  }

  return { text, hits, stripped: strippedAnything, softened, gutted: false };
}

/**
 * Would this reply have been changed? A cheap read-only check for logging and for tests, so a spike
 * in technical leakage is visible without diffing every reply.
 */
export function readsTechnical(reply) {
  const r = plainEnglish(reply);
  return r.stripped;
}

export default plainEnglish;
