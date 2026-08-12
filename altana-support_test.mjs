/*
 * Altana support playbook self-test. Run: node altana-support_test.mjs
 *
 * WHAT THIS SUITE PROVES, and why each half exists.
 *
 * Fred, 2026-08-12: "It should have a full customer service workflow ... with a database of a
 * significant amount of text responses and actions to customer issues, including how to report an
 * issue to me and how to follow up with the user after actions have take place."
 *
 * altana-support.mjs opens by claiming that this file enforces three rules across the whole table
 * rather than trusting the author. That claim is the reason this suite exists, so it is checked
 * literally: every sentence a customer can be shown is walked, not sampled.
 *
 *   A. The table is well formed. Unique ids, real severities, a say worth reading, an act list.
 *   B. Every customer-facing sentence obeys the three rules in the module header: no technical
 *      vocabulary, no house-style violations, and no promise of an outcome the app cannot see.
 *   C. Classification puts a real complaint on the right entry, in the words an angry or confused
 *      person actually types rather than in keyword soup.
 *   D. Classification never drops anything. A support request that classified as nothing is a
 *      complaint on the floor, which is the one outcome the module says is not allowed.
 *   E. supportPlanFor wires severity to its three consequences: Fred now, a promise to the user,
 *      and a chase clock.
 *   F. escalationEmail carries what a decision needs, and has NO recipient parameter. Fred's rule
 *      that this never emails anyone but him has to be structural, not a convention.
 *   G. digestEmail rolls up the rest, and sends nothing when there is nothing.
 *   H. None of the four entry points throw on rubbish input. A support desk that crashes on a
 *      weird message has lost the message.
 *
 * Zero dependencies. node:assert/strict only.
 */
import assert from "node:assert/strict";
import {
  SUPPORT_PLAYBOOK, SEVERITY, SEVERITY_ORDER,
  classifyIssue, supportPlanFor, escalationEmail, digestEmail, playbookFor,
} from "./altana-support.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

/* ============================================================================================== *
 * A. THE TABLE IS WELL FORMED
 * ============================================================================================== */

t("A1 the playbook is a non-empty array", () => {
  assert.ok(Array.isArray(SUPPORT_PLAYBOOK), "SUPPORT_PLAYBOOK is not an array, so nothing else in this suite can be trusted");
  assert.ok(SUPPORT_PLAYBOOK.length >= 10, "the playbook has fewer than 10 entries, which is not the significant body of responses Fred asked for");
});

t("A2 every id is present, a string, and unique across the table", () => {
  const seen = new Set();
  for (const p of SUPPORT_PLAYBOOK) {
    assert.equal(typeof p.id, "string", "an entry has a non-string id, and ids are referenced by tickets forever");
    assert.ok(p.id.trim().length > 0, "an entry has an empty id, so its tickets could never be traced back to it");
    assert.ok(!seen.has(p.id), "duplicate playbook id " + p.id + ", so one of the two entries can never be looked up");
    seen.add(p.id);
  }
});

t("A3 every severity is a real key of SEVERITY", () => {
  for (const p of SUPPORT_PLAYBOOK) {
    assert.ok(SEVERITY[p.severity], "entry " + p.id + " has severity " + JSON.stringify(p.severity) + " which is not in the SEVERITY table, so its escalation and chase rules are undefined");
  }
});

t("A4 every SEVERITY key is listed in SEVERITY_ORDER and carries its four rules", () => {
  for (const key of Object.keys(SEVERITY)) {
    assert.ok(SEVERITY_ORDER.includes(key), "severity " + key + " is missing from SEVERITY_ORDER, so it cannot be sorted or ranked");
    const s = SEVERITY[key];
    assert.equal(typeof s.rank, "number", "severity " + key + " has no numeric rank, so ties cannot be broken");
    assert.ok(["immediate", "digest"].includes(s.escalate), "severity " + key + " has an escalate value that is neither immediate nor digest");
    assert.equal(typeof s.followUp, "boolean", "severity " + key + " does not say whether a follow-up is promised");
    assert.equal(typeof s.chaseAfterHours, "number", "severity " + key + " has no chase clock, so a stale ticket would sit forever");
  }
});

t("A5 every type is a non-empty string, because the roll-up groups by it", () => {
  for (const p of SUPPORT_PLAYBOOK) {
    assert.equal(typeof p.type, "string", "entry " + p.id + " has a non-string type, so it cannot be grouped in Fred's roll-up");
    assert.ok(p.type.trim().length > 0, "entry " + p.id + " has an empty type, so it would land in an unnamed group");
  }
});

t("A6 every entry has something to say, and it is at least 80 characters", () => {
  for (const p of SUPPORT_PLAYBOOK) {
    assert.equal(typeof p.say, "string", "entry " + p.id + " has no say string, so Altana would answer this complaint with nothing");
    assert.ok(p.say.trim().length > 0, "entry " + p.id + " has an empty say, which is a silent reply to a customer");
    assert.ok(p.say.length >= 80, "entry " + p.id + " says only " + p.say.length + " characters, which is too short to both acknowledge the problem and state a next step");
  }
});

t("A7 every act is an array, and an empty one is allowed as an honest answer", () => {
  for (const p of SUPPORT_PLAYBOOK) {
    assert.ok(Array.isArray(p.act), "entry " + p.id + " has an act that is not an array, so supportPlanFor would hand the caller something it cannot iterate");
    for (const a of p.act) {
      assert.equal(typeof a, "string", "entry " + p.id + " has a non-string act, and acts are named as her own tool verbs");
      assert.ok(a.trim().length > 0, "entry " + p.id + " has an empty act name, which would run nothing under a name nobody can read");
    }
  }
});

t("A8 every ask is an array of short questions, at most three", () => {
  for (const p of SUPPORT_PLAYBOOK) {
    const ask = p.ask === undefined ? [] : p.ask;
    assert.ok(Array.isArray(ask), "entry " + p.id + " has an ask that is not an array");
    assert.ok(ask.length <= 3, "entry " + p.id + " asks " + ask.length + " questions, and past two questions it stops being a conversation and becomes a form");
  }
});

t("A9 the unknown entry exists, has no cues, and is the fallback", () => {
  const unknown = playbookFor("unknown");
  assert.ok(unknown, "there is no entry with id unknown, so an unmatched complaint has nowhere to land");
  assert.deepEqual(unknown.cues, [], "the unknown entry has cues, which would let it win a match instead of only catching what nothing else caught");
  assert.ok(unknown.say.length >= 80, "the unknown fallback has nothing substantial to say, and it is the entry a confused user is most likely to hit");
  assert.ok(unknown.ask.length >= 1, "the unknown fallback asks the user nothing, so the ticket it files would be useless to Fred");
  assert.equal(classifyIssue("qqqq zzzz wwww").entry.id, "unknown", "a complaint matching no cue did not fall through to the unknown entry");
});

t("A10 playbookFor returns null for an id that does not exist", () => {
  assert.equal(playbookFor("no-such-entry"), null, "playbookFor invented an entry for an unknown id instead of returning null");
  assert.equal(playbookFor(undefined), null, "playbookFor did not return null for an undefined id");
});

/* ============================================================================================== *
 * B. EVERY CUSTOMER-FACING SENTENCE OBEYS THE THREE RULES
 * ============================================================================================== */

/*
 * Every string a customer can be shown, tagged with where it came from so a failure names the entry.
 */
const CUSTOMER_FACING = [];
for (const p of SUPPORT_PLAYBOOK) {
  if (typeof p.say === "string" && p.say) CUSTOMER_FACING.push({ id: p.id, field: "say", text: p.say });
  if (typeof p.followUp === "string" && p.followUp) CUSTOMER_FACING.push({ id: p.id, field: "followUp", text: p.followUp });
}

/*
 * Rule 1: no technical vocabulary. Word boundaries so that "stack" is caught and "stacked shelves"
 * is not, and so that "api" does not fire on "rapid".
 */
const BANNED_VOCABULARY = [
  "null", "undefined", "error code", "stack", "traceback", "exception", "database",
  "schema", "sql", "api", "endpoint", "server log", "regex", "webhook", "payload",
  "json", "http", "500", "404", "502",
].map((w) => ({ word: w, re: new RegExp("\\b" + w + "\\b", "i") }));
BANNED_VOCABULARY.push({ word: ".mjs", re: /\.mjs\b/i });
BANNED_VOCABULARY.push({ word: ".js", re: /\.js\b/i });

/*
 * The whole-table sweeps collect every violation before failing, so one run names every offending
 * entry. Failing on the first one would hide the rest behind it and turn a single fix into a queue.
 */
const sweep = (label, check) => {
  const hits = [];
  for (const s of CUSTOMER_FACING) {
    const why = check(s.text);
    if (why) hits.push(s.id + "." + s.field + ": " + why);
  }
  assert.deepEqual(hits, [], label + "\n      " + hits.join("\n      "));
};

t("B1 no customer-facing sentence contains technical vocabulary", () => {
  sweep("these sentences use technical vocabulary, and Fred's rule is that a customer never reads a technical explanation:", (text) => {
    const found = BANNED_VOCABULARY.filter((b) => b.re.test(text)).map((b) => b.word);
    return found.length ? "uses " + found.join(", ") : "";
  });
});

t("B2 no customer-facing sentence contains an em dash", () => {
  sweep("these sentences contain an em dash, which is a hard house rule against:", (text) => (text.includes("—") ? "contains an em dash" : ""));
});

t("B3 no customer-facing sentence uses the banned antithesis construction", () => {
  const ANTITHESIS = /\bnot\s+[^.,;]{1,40},?\s+but\s+/i;
  sweep("these sentences use the banned antithesis construction, which is a hard house rule against:", (text) => {
    const m = text.match(ANTITHESIS);
    return m ? "uses " + JSON.stringify(m[0]) : "";
  });
});

t("B4 every say ends in sentence punctuation", () => {
  for (const p of SUPPORT_PLAYBOOK) {
    assert.match(String(p.say).trim(), /[.!?]$/, "entry " + p.id + " has a say that trails off without a full stop, so the reply looks truncated to the customer");
  }
});

t("B5 no say promises a fix that has already happened", () => {
  const CLAIMS_DONE = /\b(?:it is|it's|this is|that is|that's)\s+(?:now\s+)?(?:fixed|resolved|sorted|working again)\b/i;
  for (const p of SUPPORT_PLAYBOOK) {
    const m = String(p.say).match(CLAIMS_DONE);
    assert.ok(!m, "entry " + p.id + " tells the customer " + JSON.stringify(m && m[0]) + " at the moment they complain, which is a claim about the world that the app cannot see; she may promise effort only");
  }
});

t("B6 every say states a next step rather than only apologising", () => {
  const NEXT_STEP = /\b(?:i (?:am|will|can)|i'm|let me|tell me|you will|you can|goes to|going to)\b/i;
  for (const p of SUPPORT_PLAYBOOK) {
    assert.match(p.say, NEXT_STEP, "entry " + p.id + " says nothing about what happens next, and sorry without a next step is not support");
  }
});

t("B7 no customer-facing sentence names a file, a module or a provider brand", () => {
  const LEAKS = [/\.mjs/i, /\bnode\b/i, /\bpostgres\b/i, /\bsupabase\b/i, /\brailway\b/i, /\bvercel\b/i, /\banthropic\b/i, /\bopenai\b/i, /\bstripe\b/i];
  sweep("these sentences name an implementation detail, and a written line cannot leak what it does not contain:", (text) => {
    const found = LEAKS.filter((re) => re.test(text)).map(String);
    return found.length ? "matches " + found.join(", ") : "";
  });
});

/* ============================================================================================== *
 * C. CLASSIFICATION PUTS A REAL COMPLAINT ON THE RIGHT ENTRY
 * ============================================================================================== */

/* Sentences written the way an angry or confused person types them, not as keyword soup. */
const CASES = [
  ["you charged me twice for the same thing", "charged-wrong-amount"],
  ["it billed me twice for the same order", "charged-wrong-amount"],
  ["I paid for credits an hour ago and my balance is still zero", "credits-missing"],
  ["where are my credits, I bought them yesterday", "credits-missing"],
  ["my card keeps getting declined", "payment-declined"],
  ["it wont take my card at all", "payment-declined"],
  ["I want a refund", "refund-request"],
  ["I want my money back please", "refund-request"],
  ["I burned through my credits far faster than expected", "unexpected-spend"],
  ["why did that cost so much", "unexpected-spend"],
  ["it recharged itself and took money automatically", "top-off-surprise"],
  ["I want to cancel my subscription, stop billing me", "subscription-confusion"],
  ["my build failed again", "build-failed"],
  ["it took ages and then the build died", "build-failed"],
  ["it has been building for three hours and nothing is happening", "build-stuck"],
  ["it is spinning forever and not moving", "build-stuck"],
  ["my app wont deploy, it is not going live", "app-wont-deploy"],
  ["I cannot log in, the code never arrived", "cannot-sign-in"],
  ["the sign in code didnt arrive in my email", "cannot-sign-in"],
  ["all my work is gone", "lost-work"],
  ["my project is gone, everything vanished overnight", "lost-work"],
  ["I cant find my project anywhere", "lost-work"],
  ["the model just stops responding", "model-not-answering"],
  ["it wont let me use that model, it is greyed out", "model-refused"],
  ["that answer was wrong, it made things up", "answer-quality"],
  ["the picture didnt generate at all, image failed", "images-failing"],
  ["the image came out completely wrong", "image-wrong"],
  ["video failed to render", "video-failing"],
  ["the video looks bad and the audio is out of sync", "video-quality"],
  ["I cannot hear anything, voice is not working", "voice-broken"],
  ["google is not connected any more, I have to reconnect", "connector-broken"],
  ["the whole app is so slow and laggy today", "app-slow"],
  ["the text is cut off and I cant click the button", "ui-broken"],
  ["none of the buttons work on my phone", "mobile-broken"],
  ["the chat I made on my laptop is not on my phone", "sync-missing"],
  ["where do i find the settings screen", "dont-know-where"],
  ["how do i get to the billing screen", "dont-know-where"],
  ["this is far too complicated for me", "too-complicated"],
  ["I dont understand any of this, it is over my head", "too-complicated"],
  ["you should add dark mode", "feature-missing"],
  ["I wish it could export to a spreadsheet", "feature-missing"],
  ["is my data safe, do you train on it?", "privacy-worry"],
  ["delete my data, gdpr", "privacy-worry"],
  ["this is a complete waste of money and I have had enough", "angry"],
  ["I am absolutely furious, this is unacceptable", "angry"],
  ["I have had enough of this, cancel my account", "angry"],
  ["I want to talk to a real person", "wants-human"],
  ["who do i contact about this", "wants-human"],
];

for (const [text, want] of CASES) {
  t("C " + JSON.stringify(text) + " goes to " + want, () => {
    const r = classifyIssue(text);
    assert.equal(r.entry.id, want, "this complaint routed to " + r.entry.id + " instead of " + want + ", so the customer gets the wrong words and Fred gets the wrong severity");
  });
}

/* Genuinely ambiguous sentences, where forcing one answer would be inventing a right answer. */
const AMBIGUOUS = [
  ["my video has no sound at all", ["video-failing", "video-quality"]],
  ["everything on the ipad is off screen", ["ui-broken", "mobile-broken"]],
  ["the app is frozen and not moving", ["build-stuck", "app-slow", "ui-broken"]],
];
for (const [text, allowed] of AMBIGUOUS) {
  t("C ambiguous, either answer is defensible: " + JSON.stringify(text) + " goes to one of " + allowed.join(" or "), () => {
    const r = classifyIssue(text);
    assert.ok(allowed.includes(r.entry.id), "this genuinely ambiguous complaint routed to " + r.entry.id + ", which is outside the defensible set " + allowed.join(", "));
  });
}

t("C classify returns confidence in 0..1 and alternatives as ids that exist", () => {
  for (const [text] of CASES) {
    const r = classifyIssue(text);
    assert.ok(r.confidence >= 0 && r.confidence <= 1, "confidence for " + JSON.stringify(text) + " was " + r.confidence + ", which is outside 0..1 and would break any threshold built on it");
    assert.ok(Array.isArray(r.alternatives), "alternatives for " + JSON.stringify(text) + " is not an array");
    for (const id of r.alternatives) {
      assert.ok(playbookFor(id), "alternatives for " + JSON.stringify(text) + " names " + id + ", which is not an entry in the playbook");
    }
    assert.ok(!r.alternatives.includes(r.entry.id), "the chosen entry for " + JSON.stringify(text) + " also appears in its own alternatives list");
  }
});

/*
 * Confidence is the winner's SHARE of the total score, not an absolute certainty, so a sentence with
 * a single candidate always reports 1. The bar is therefore only meaningful where entries compete,
 * and that is what is tested here.
 */
t("C a raised minConfidence pushes a contested match to unknown rather than guessing", () => {
  const contested = "none of the buttons work on my phone";
  const natural = classifyIssue(contested);
  assert.ok(natural.confidence < 0.9, "the test sentence is no longer contested, so this test would prove nothing about the confidence bar");
  assert.notEqual(natural.entry.id, "unknown", "the contested sentence does not classify at all at the default bar, so raising the bar proves nothing");
  const strict = classifyIssue(contested, { minConfidence: 0.9 });
  assert.equal(strict.entry.id, "unknown", "a raised confidence bar still returned a specific entry on a contested sentence, so the bar is not honoured and a guess can reach the customer");
});

t("C a lone candidate reports full confidence, which is a share and not a certainty", () => {
  const lone = classifyIssue("the whole app is so slow and laggy today");
  assert.equal(lone.alternatives.length, 0, "the test sentence has competitors, so it cannot demonstrate the lone-candidate case");
  assert.equal(lone.confidence, 1, "a lone candidate did not report a full share of the score, which is what confidence measures here");
});

/* ============================================================================================== *
 * D. CLASSIFICATION NEVER DROPS ANYTHING
 * ============================================================================================== */

const NO_CUE_AT_ALL = [
  "the weather is nice today",
  "asdfgh",
  "",
  "hello",
  "thanks!",
  "good morning to you",
  "12345",
  "     ",
  "((((",
  "$^[]\\",
  "zzzzz qqqqq wwwww",
];

t("D every unmatched sentence still returns an entry, and that entry is unknown", () => {
  for (const s of NO_CUE_AT_ALL) {
    const r = classifyIssue(s);
    assert.ok(r, "classifyIssue returned nothing for " + JSON.stringify(s) + ", which is a support request dropped on the floor");
    assert.ok(r.entry, "classifyIssue returned no entry for " + JSON.stringify(s) + ", which is a support request dropped on the floor");
    assert.equal(r.entry.id, "unknown", JSON.stringify(s) + " matched no cue yet routed to " + r.entry.id + " instead of the unknown fallback, so a customer would be answered about a problem they did not report");
    assert.equal(r.confidence, 0, JSON.stringify(s) + " matched no cue yet reported a confidence above zero");
  }
});

t("D every complaint in the whole corpus produces an entry that is really in the table", () => {
  for (const s of [...NO_CUE_AT_ALL, ...CASES.map((c) => c[0])]) {
    const r = classifyIssue(s);
    assert.ok(playbookFor(r.entry.id), "classifyIssue returned an entry id " + r.entry.id + " for " + JSON.stringify(s) + " that is not in the playbook");
  }
});

t("D supportPlanFor also never returns a plan without an issue id", () => {
  for (const s of NO_CUE_AT_ALL) {
    const plan = supportPlanFor(s);
    assert.ok(plan && plan.issueId, "supportPlanFor produced no issue id for " + JSON.stringify(s) + ", so the ticket it filed would be untraceable");
    assert.ok(plan.say && plan.say.length > 0, "supportPlanFor produced no words to say for " + JSON.stringify(s) + ", so the customer would be answered with silence");
  }
});

/* ============================================================================================== *
 * E. SEVERITY IS WIRED TO ITS CONSEQUENCES
 * ============================================================================================== */

t("E1 a critical issue escalates to Fred at once", () => {
  const plan = supportPlanFor("my project is gone, everything vanished overnight");
  assert.equal(plan.severity, "critical", "lost work did not come back as critical, and losing a customer's work is the top of the scale");
  assert.equal(plan.escalate, "immediate", "a critical issue was queued for the digest instead of going to Fred at once");
  assert.equal(plan.escalateNow, true, "escalateNow was false on a critical issue, so Fred would not be told today");
});

t("E2 a low issue promises no follow-up", () => {
  const plan = supportPlanFor("you should add dark mode");
  assert.equal(plan.severity, "low", "a feature wish did not come back as low severity");
  assert.equal(plan.promiseFollowUp, false, "a low severity wish promised the customer a follow-up, which is a promise nobody is committed to keeping");
  assert.equal(plan.escalateNow, false, "a low severity wish interrupted Fred immediately instead of waiting for the roll-up");
  assert.equal(plan.chaseAfterHours, 0, "a low severity wish set a chase clock, so the sweep would chase something nobody promised to do");
});

t("E3 an explicit escalate on the entry beats the severity default", () => {
  /* Forcing refund-request down to low makes the severity default digest. Its own escalate is
     immediate, and the entry has to win, otherwise a money question could be downgraded silently. */
  const forced = supportPlanFor("I want a refund", { severityOverride: "low" });
  assert.equal(forced.severity, "low", "the severity override was not applied at all");
  assert.equal(SEVERITY.low.escalate, "digest", "the low severity default is no longer digest, so this test no longer proves an override");
  assert.equal(forced.escalate, "immediate", "the entry's own immediate escalation was overwritten by the severity default, so a refund request could be demoted into a daily roll-up");
  assert.equal(forced.escalateNow, true, "escalateNow did not follow the entry's own escalation setting");

  /* An entry with no escalate of its own must follow the severity, so the override is proven to be
     the entry speaking rather than everything escalating regardless. */
  const plain = supportPlanFor("the whole app is so slow and laggy today", { severityOverride: "low" });
  assert.equal(plain.escalate, "digest", "an entry with no escalate of its own did not fall back to the severity default, so the default is dead code");
});

t("E4 a severityOverride naming a real severity is honoured", () => {
  const plan = supportPlanFor("the whole app is so slow and laggy today", { severityOverride: "critical" });
  assert.equal(plan.severity, "critical", "a valid severity override was ignored, so Fred cannot raise a ticket by hand");
  assert.equal(plan.escalateNow, true, "raising a ticket to critical did not make it escalate immediately");
  assert.equal(plan.chaseAfterHours, SEVERITY.critical.chaseAfterHours, "the chase clock did not follow the overridden severity");
});

t("E5 a severityOverride naming nonsense is ignored, not obeyed", () => {
  const natural = supportPlanFor("the whole app is so slow and laggy today");
  for (const junk of ["banana", "", "URGENT", "0", "constructor", "toString"]) {
    const plan = supportPlanFor("the whole app is so slow and laggy today", { severityOverride: junk });
    assert.equal(plan.severity, natural.severity, "the override " + JSON.stringify(junk) + " was accepted as a severity, so a bad caller could give a ticket rules that do not exist");
    assert.equal(typeof plan.chaseAfterHours, "number", "the override " + JSON.stringify(junk) + " left the plan without a numeric chase clock");
  }
});

t("E6 promiseFollowUp is never true without a sentence to send", () => {
  /* Across the whole table, at every severity, the promise and the sentence move together. */
  for (const p of SUPPORT_PLAYBOOK) {
    for (const sev of SEVERITY_ORDER) {
      const promised = !!SEVERITY[sev].followUp && !!p.followUp;
      if (promised) {
        assert.ok(String(p.followUp).trim().length > 0, "entry " + p.id + " at severity " + sev + " promises a follow-up with no sentence to send, so the customer would be told to expect a message that does not exist");
      }
    }
  }
  /* And through the real function, on every entry reachable by its own first cue. */
  for (const p of SUPPORT_PLAYBOOK) {
    if (!p.cues || !p.cues.length) continue;
    const plan = supportPlanFor(p.cues[0]);
    if (plan.promiseFollowUp) {
      assert.ok(plan.followUpText && plan.followUpText.length > 0, "the plan for " + plan.issueId + " promises a follow-up but carries an empty followUpText");
    }
  }
});

t("E7 an entry with an empty follow-up promises nothing", () => {
  const plan = supportPlanFor("the image came out completely wrong");
  const entry = playbookFor(plan.issueId);
  if (!entry.followUp) {
    assert.equal(plan.promiseFollowUp, false, "entry " + plan.issueId + " has no follow-up sentence yet the plan promised one");
  }
});

t("E8 every plan carries the whole decision, so a caller cannot apply half of it", () => {
  const plan = supportPlanFor("you charged me twice for the same thing");
  for (const key of ["issueId", "type", "severity", "say", "ask", "act", "escalate", "escalateNow", "promiseFollowUp", "followUpText", "chaseAfterHours"]) {
    assert.ok(key in plan, "the plan is missing " + key + ", so the caller would have to decide it themselves and could decide it differently");
  }
  assert.equal(plan.escalateNow, plan.escalate === "immediate", "escalateNow and escalate disagree, so two callers reading the same plan would do different things");
});

/* ============================================================================================== *
 * F. THE ESCALATION FRED READS
 * ============================================================================================== */

const SAMPLE_PLAN = supportPlanFor("you charged me twice for the same thing");
const SAMPLE_MAIL = escalationEmail({
  ticketId: 4172,
  plan: SAMPLE_PLAN,
  complaint: "you charged me twice for the same thing and I am not paying it again",
  user: { email: "angry.customer@example.com", tier: "credit", contactEmail: "reply.here@example.com" },
  surface: "phone",
  history: ["is anyone there", "still waiting on this"],
  repeats: 2,
});

t("F1 the subject carries the ticket number and the uppercased severity", () => {
  assert.ok(SAMPLE_MAIL.subject.includes("4172"), "the subject does not contain the ticket number, so Fred cannot tell two escalations apart in a mailbox");
  assert.ok(SAMPLE_MAIL.subject.includes("CRITICAL"), "the subject does not shout the severity in capitals, so an urgent one does not stand out from a routine one");
  assert.ok(!SAMPLE_MAIL.subject.includes("critical"), "the severity in the subject is not uppercased");
});

t("F2 the body carries the user's own words, the account, the reply-to and the surface", () => {
  const b = SAMPLE_MAIL.body;
  assert.ok(b.includes("you charged me twice for the same thing and I am not paying it again"), "the customer's own words are missing from the body, so Fred would have to go and look them up");
  assert.ok(b.includes("angry.customer@example.com"), "the account identifier is missing from the body, so Fred cannot tell whose account it is");
  assert.ok(b.includes("reply.here@example.com"), "the reply-to address is missing from the body, so Fred cannot answer the person");
  assert.ok(b.includes("phone"), "the surface is missing from the body, so Fred cannot tell where they were when it happened");
  assert.ok(b.includes("credit"), "the tier is missing from the body, so Fred cannot tell what the account is entitled to");
  assert.ok(b.includes("open_ticket"), "the acts Altana ran are missing from the body, so Fred cannot tell what has already been tried");
});

t("F3 a repeat offender is called out, and a first report is not", () => {
  assert.match(SAMPLE_MAIL.body, /reported this same issue 2 time\(s\) before/, "a repeated complaint does not say so, so Fred cannot see that this account has been let down more than once");
  const first = escalationEmail({ ticketId: 1, plan: SAMPLE_PLAN, complaint: "first time", repeats: 0 });
  assert.ok(!/time\(s\) before/.test(first.body), "a first-time complaint was labelled as a repeat");
});

t("F4 a promised follow-up is quoted back exactly, so Fred sees what resolving sends", () => {
  assert.equal(SAMPLE_PLAN.promiseFollowUp, true, "the sample plan does not promise a follow-up, so this test proves nothing");
  assert.ok(SAMPLE_MAIL.body.includes(SAMPLE_PLAN.followUpText), "the exact sentence the customer will receive is not in the body, so Fred could resolve the ticket without knowing what it sends on his behalf");
  assert.ok(/TOLD THEM/.test(SAMPLE_MAIL.body), "the body does not flag that a promise was made to the customer");
});

t("F5 when nothing was promised, the body says so plainly", () => {
  const mail = escalationEmail({ ticketId: 9, plan: supportPlanFor("you should add dark mode"), complaint: "add dark mode" });
  assert.ok(mail.body.includes("No follow-up was promised."), "an escalation with no promise does not say so, leaving Fred to guess whether resolving it messages the customer");
});

t("F6 the recipient is not a parameter and is not in the result", () => {
  const src = escalationEmail.toString();
  const params = src.slice(src.indexOf("("), src.indexOf(") {") + 1);
  assert.ok(!/\b(to|cc|bcc|recipient|recipients|sendTo|mailTo|toAddress|address)\b/i.test(params),
    "escalationEmail accepts a recipient in its parameters, so a caller could point Fred's escalation at somebody else; Fred's rule that this never emails anyone but him has to be structural");
  assert.deepEqual(Object.keys(SAMPLE_MAIL).sort(), ["body", "subject"], "escalationEmail returns keys beyond subject and body, and anything else could be read as an address by a mail sender");
  for (const key of Object.keys(SAMPLE_MAIL)) {
    assert.ok(!/^(to|cc|bcc|recipient|recipients|from|replyTo)$/i.test(key), "escalationEmail returned a " + key + " field, which a mail sender would treat as an address");
  }
});

t("F7 with no addresses anywhere in the input, the result contains no address at all", () => {
  const mail = escalationEmail({
    ticketId: 5,
    plan: supportPlanFor("my build failed again"),
    complaint: "it broke again and I have lost the morning",
    user: { uid: "abc123def456", tier: "free" },
    surface: "web",
  });
  assert.ok(!JSON.stringify(mail).includes("@"), "the escalation carries an address that came from nowhere in its input, which means the module is supplying a destination of its own");
});

t("F8 an escalation with no arguments still produces a subject and a body", () => {
  const mail = escalationEmail();
  assert.equal(typeof mail.subject, "string", "escalationEmail with no arguments produced no subject");
  assert.ok(mail.subject.length > 0, "escalationEmail with no arguments produced an empty subject, so an alert would arrive looking like spam");
  assert.ok(mail.body.length > 0, "escalationEmail with no arguments produced an empty body");
  assert.ok(mail.body.includes("(no words recorded)"), "an escalation with no complaint text does not say that no words were recorded, so Fred would think the body was truncated");
});

t("F9 a very long complaint is trimmed rather than mailed whole", () => {
  const mail = escalationEmail({ ticketId: 3, plan: SAMPLE_PLAN, complaint: "z".repeat(20000) });
  assert.ok(mail.body.length < 12000, "a 20000 character complaint went into the escalation whole, which makes the alert unreadable and can bounce the message");
});

/* ============================================================================================== *
 * G. THE DAILY ROLL-UP
 * ============================================================================================== */

const DIGEST_ROWS = [
  { id: 11, type: "billing", issueId: "refund-request", userEmail: "a@example.com", summary: "wants money back", promiseFollowUp: true },
  { id: 12, type: "billing", issueId: "refund-request", userEmail: "b@example.com", summary: "also wants money back", promiseFollowUp: true },
  { id: 13, type: "billing", issueId: "refund-request", userEmail: "c@example.com", summary: "third refund today" },
  { id: 14, type: "interface", issueId: "ui-broken", uid: "deadbeef", summary: "cannot click the save button" },
  { id: 15, type: "feedback", issueId: "feature-missing", userEmail: "d@example.com", summary: "wants dark mode" },
];

t("G1 nothing to send means no mail at all", () => {
  assert.equal(digestEmail([]), null, "an empty roll-up produced a message, so Fred would get a daily email telling him nothing happened");
  assert.equal(digestEmail(), null, "a roll-up called with no argument produced a message instead of nothing");
});

t("G2 the roll-up counts the tickets in its subject and its body", () => {
  const d = digestEmail(DIGEST_ROWS);
  assert.ok(d, "a roll-up with five tickets produced nothing");
  assert.ok(d.subject.includes("5"), "the subject does not carry the ticket count, so Fred cannot tell a quiet day from a bad one without opening it");
  assert.ok(d.body.includes("5 ticket(s)"), "the body does not state how many tickets are in the roll-up");
});

t("G3 the roll-up groups by type and issue and shows each group's count", () => {
  const d = digestEmail(DIGEST_ROWS);
  assert.ok(d.body.includes("3x  billing/refund-request"), "three refund requests were not grouped and counted together, so a pattern would read as three unrelated tickets");
  assert.ok(d.body.includes("1x  interface/ui-broken"), "the interface ticket was not grouped under its own type and issue");
  assert.ok(d.body.includes("1x  feedback/feature-missing"), "the feedback ticket was not grouped under its own type and issue");
  assert.ok(d.body.indexOf("3x  billing/refund-request") < d.body.indexOf("1x  interface/ui-broken"), "the biggest group is not listed first, so the loudest pattern is not what Fred reads first");
});

t("G4 the roll-up names who reported each ticket", () => {
  const d = digestEmail(DIGEST_ROWS);
  assert.ok(d.body.includes("a@example.com"), "a reporter's address is missing from the roll-up, so Fred cannot follow one up");
  assert.ok(d.body.includes("deadbeef"), "a ticket with no address does not fall back to the account id, so it would read as coming from nobody");
  assert.ok(d.body.includes("cannot click the save button"), "a ticket summary is missing from the roll-up");
});

t("G5 the roll-up reports how many people are waiting on a follow-up", () => {
  const d = digestEmail(DIGEST_ROWS);
  assert.ok(d.body.includes("2 of these were promised a follow-up"), "the roll-up does not say how many customers are waiting to hear back, which is the part that turns stale into a broken promise");
  const none = digestEmail([{ id: 1, type: "feedback", issueId: "feature-missing", summary: "a wish" }]);
  assert.ok(!/promised a follow-up/.test(none.body), "a roll-up where nobody was promised anything still talks about follow-ups");
});

t("G6 a group larger than four is truncated with the remainder counted", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, type: "build", issueId: "build-failed", userEmail: "u" + i + "@example.com", summary: "build broke" }));
  const d = digestEmail(many);
  assert.ok(d.body.includes("9x  build/build-failed"), "a group of nine was not counted as nine");
  assert.ok(d.body.includes("...and 5 more"), "a long group was not truncated with the remainder counted, so one bad day would produce an unreadable wall of text");
});

t("G7 a ticket with no type or issue still appears rather than vanishing", () => {
  const d = digestEmail([{ id: 99, summary: "something odd happened" }]);
  assert.ok(d, "a roll-up containing one unlabelled ticket produced nothing at all");
  assert.ok(d.body.includes("other/unknown"), "an unlabelled ticket was not filed under other/unknown, so it would disappear from the roll-up");
  assert.ok(d.body.includes("something odd happened"), "an unlabelled ticket lost its summary");
});

/* ============================================================================================== *
 * H. ROBUSTNESS. A DESK THAT CRASHES ON A WEIRD MESSAGE HAS LOST THE MESSAGE
 * ============================================================================================== */

const RUBBISH = [
  ["null", null],
  ["undefined", undefined],
  ["an empty object", {}],
  ["an empty array", []],
  ["a number", 7],
  ["a very long string", "x".repeat(20000)],
  ["unbalanced brackets", "(((("],
  ["regular expression metacharacters", "$^[]\\"],
  ["more metacharacters", "a*b+c?d|e{2,}"],
];

for (const [label, value] of RUBBISH) {
  t("H classifyIssue survives " + label + " and still returns an entry", () => {
    let r;
    assert.doesNotThrow(() => { r = classifyIssue(value); }, "classifyIssue threw on " + label + ", so a customer message of that shape would be lost instead of answered");
    assert.ok(r && r.entry && r.entry.id, "classifyIssue returned no usable entry for " + label + ", which is a dropped complaint");
  });
  t("H supportPlanFor survives " + label + " and still returns a plan", () => {
    let r;
    assert.doesNotThrow(() => { r = supportPlanFor(value); }, "supportPlanFor threw on " + label + ", so that complaint would never reach a ticket");
    assert.ok(r && r.issueId && r.say, "supportPlanFor returned an unusable plan for " + label);
  });
  t("H escalationEmail survives " + label, () => {
    let r;
    assert.doesNotThrow(() => { r = escalationEmail(value); }, "escalationEmail threw on " + label + ", so Fred would never be told about that ticket");
    assert.ok(r && typeof r.subject === "string" && typeof r.body === "string", "escalationEmail returned something that is not a subject and a body for " + label);
  });
  t("H digestEmail survives " + label, () => {
    assert.doesNotThrow(() => { digestEmail(value); }, "digestEmail threw on " + label + ", so the whole day's roll-up would be lost rather than one ticket");
  });
}

t("H a very long complaint classifies in reasonable time", () => {
  const started = Date.now();
  classifyIssue("my card keeps getting declined. ".repeat(600));
  const took = Date.now() - started;
  assert.ok(took < 3000, "classifying a 20000 character message took " + took + "ms, which would stall the reply to the customer");
});

t("H a complaint made only of punctuation falls to unknown without throwing", () => {
  for (const s of ["!!!!!", "?????", "...", "$$$$", "\\\\\\", "[](){}"]) {
    let r;
    assert.doesNotThrow(() => { r = classifyIssue(s); }, "classifyIssue threw on the punctuation-only message " + JSON.stringify(s));
    assert.equal(r.entry.id, "unknown", "the punctuation-only message " + JSON.stringify(s) + " matched a real issue, so a customer would be answered about a problem they never reported");
  }
});

console.log(`\naltana-support_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
