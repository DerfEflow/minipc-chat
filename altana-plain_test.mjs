/*
 * altana-plain self-test. Run: node altana-plain_test.mjs
 *
 * Proves Fred's 2026-08-12 rule ("it should not respond with it actual technical actions, code, etc.
 * It should ALWAYS respond in plain english") is enforced by shape and not by hope, and proves the
 * more dangerous half: that the filter does NOT eat her real answer book.
 *
 * The second half is the one worth having. A filter that strips everything passes every leak test
 * and leaves the assistant mute, and there is no way to notice that from a leak test alone. So a
 * sample of REAL entries from docs/altana-faq is read off disk and asserted to survive byte for byte.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { plainEnglish, readsTechnical, ASSURANCE } from "./altana-plain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

/* ---------- 1. technical content never reaches a customer ------------------------------------- */

const MUST_BE_CAUGHT = [
  ["a fenced code block", "Here is the fix:\n```js\nconst x = billing.setAutorecharge(email, false, 12.5);\n```\nThat should do it."],
  ["an unterminated fence", "I found it. ```js\nfunction broken(  "],
  ["a stack frame", "It failed here:\n    at Object.<anonymous> (server.mjs:5798:12)\n    at Module._compile"],
  ["an error class", "TypeError: Cannot read properties of undefined (reading 'balance')"],
  ["a posix errno", "The call came back ECONNREFUSED 127.0.0.1:11434 so I could not reach it."],
  ["a windows path", "Your project is at C:\\Users\\rjfla\\Documents\\thing and I opened it."],
  ["a posix path", "It writes to /data/billing/billing.db every time."],
  ["a source file name", "The problem is in altana.mjs and I have noted it."],
  ["a relative source path", "Look at public/altana.js for the panel."],
  ["a SQL statement", "I ran SELECT balance FROM credits WHERE email = ? to check."],
  ["a create table", "It needs CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY);"],
  ["a raw payload", 'The server answered {"ok": true, "balance": 812.5, "lane": "openai-luna"} just now.'],
  ["an env var", "You need to set STRIPE_SECRET_KEY on the server first."],
  ["a method call", "I used billing.grantUsd(email, 25) to add them."],
  ["an html tag", "The <div class=\"altana-panel\"> is not rendering for you."],
  ["localhost", "It is served from localhost:8080 on your machine."],
  ["a private address", "Your machine answers on 100.111.181.71 right now."],
  ["a commit hash", "This shipped in 4ce0c7bd91af2e and should be live."],
  ["tool narration", "I called the log_complaint tool and it returned ok, so you are all set."],
  ["a tool result claim", "The set_setting function returned an error so it did not apply."],
  ["an HTTP status", "The provider gave me HTTP 529 so I switched seats."],
  ["a status code", "It came back with status: 500 which means the far end broke."],
  ["log talk", "According to the server logs your build stopped at step four."],
  /*
   * A bare technical noun with no user-facing meaning. Deliberately NOT "table" or "log" or "deploy":
   * those are the app's own interface vocabulary (the task table, the build log, deploying an app),
   * and the first version of this rule caught them and mangled eight shipped answers. See the note
   * above the last NARRATION_RULES entry.
   */
  ["a bare technical noun", "The schema has no index on that, which is why it is slow."],
  ["a stack trace by name", "I read the stack trace and the fault is in the second step."],
];

for (const [label, sample] of MUST_BE_CAUGHT) {
  t("caught: " + label, () => {
    const r = plainEnglish(sample);
    assert.equal(r.stripped, true, "nothing was stripped from: " + sample);
    assert.equal(readsTechnical(sample), true, "readsTechnical disagreed");
  });
}

t("no output ever keeps a code fence", () => {
  for (const [, sample] of MUST_BE_CAUGHT) {
    const out = plainEnglish(sample).text;
    assert.ok(!out.includes("```"), "a fence survived: " + out);
    assert.ok(!/\.mjs\b/.test(out), "a source file name survived: " + out);
    assert.ok(!/[A-Za-z]:\\/.test(out), "a windows path survived: " + out);
    assert.ok(!/\bat Object\./.test(out), "a stack frame survived: " + out);
  }
});

t("a reply that was mostly code becomes the assurance", () => {
  const r = plainEnglish("```js\n" + "const a = 1;\n".repeat(20) + "```", { assurance: "working" });
  assert.equal(r.gutted, true);
  assert.equal(r.text, ASSURANCE.working);
});

t("a gutted reply picks the assurance it was asked for", () => {
  const code = "```sql\nSELECT * FROM credits;\n```";
  assert.equal(plainEnglish(code, { assurance: "reported" }).text, ASSURANCE.reported);
  assert.equal(plainEnglish(code, { assurance: "cannot" }).text, ASSURANCE.cannot);
  assert.equal(plainEnglish(code, { assurance: "nonsense-key" }).text, ASSURANCE.neutral);
});

t("a partly technical reply keeps its prose and gains the promise", () => {
  const r = plainEnglish(
    "Your balance did not update when it should have, and I can see that. I am recording it now so it is not lost. " +
    "The failure was TypeError: cannot read balance of undefined.",
    { assurance: "reported" },
  );
  assert.ok(/balance did not update/.test(r.text), "the real answer was lost: " + r.text);
  assert.ok(!/TypeError/.test(r.text), "the error class survived: " + r.text);
  assert.ok(r.text.includes(ASSURANCE.reported), "the assurance was not appended: " + r.text);
});

t("she is not made to promise twice", () => {
  const r = plainEnglish(
    "I have written it up and I will follow up with you here as soon as it is dealt with. It failed in server.mjs.",
    { assurance: "reported" },
  );
  const promises = r.text.split("follow up").length - 1;
  assert.equal(promises, 1, "promised more than once: " + r.text);
});

/* ---------- 2. softening keeps the meaning ---------------------------------------------------- */

t("a setting key becomes English and survives", () => {
  const r = plainEnglish("Sure, I am setting privacy_mode to trusted for you now.");
  assert.match(r.text, /privacy mode/);
  assert.ok(!r.text.includes("privacy_mode"));
  assert.match(r.text, /trusted/);
});

t("autorecharge is spoken the way the app names it", () => {
  assert.match(plainEnglish("I switched autorecharge off.").text, /automatic top-off/);
  assert.match(plainEnglish("Your auto_recharge is on.").text, /automatic top-off/);
});

t("an unknown snake_case identifier still reads as words", () => {
  const r = plainEnglish("I changed your some_future_setting for you.");
  assert.match(r.text, /some future setting/);
});

t("softening alone is not reported as stripping", () => {
  const r = plainEnglish("I am setting privacy_mode to trusted.");
  assert.equal(r.softened, true);
  assert.equal(r.stripped, false, "a harmless rewrite was counted as a strip");
  assert.ok(!r.text.includes(ASSURANCE.neutral), "an assurance was bolted onto a clean reply");
});

/* ---------- 3. THE IMPORTANT HALF: her real answers must survive untouched -------------------- */

/*
 * Every answer body in the shipped FAQ, run through the filter. These are the sentences she says all
 * day, they are already plain English by construction, and the filter must be invisible to them.
 * A failure here means the filter is eating the product.
 */
const faqDir = join(HERE, "docs", "altana-faq");
const answers = [];
for (const name of readdirSync(faqDir).filter((n) => /\.md$/i.test(n)).sort()) {
  const text = readFileSync(join(faqDir, name), "utf8");
  for (const block of text.split(/\n(?=## )/).slice(1)) {
    const lines = block.split("\n");
    const q = lines[0].replace(/^##\s*/, "").trim();
    const body = lines.slice(1).join(" ").replace(/\s+/g, " ").trim();
    if (body) answers.push({ file: name, q, body });
  }
}

t("the FAQ was actually found and read", () => {
  assert.ok(answers.length > 400, "expected the real corpus, got " + answers.length + " answers");
});

t("no real FAQ answer is altered by the filter", () => {
  const casualties = [];
  for (const a of answers) {
    const r = plainEnglish(a.body);
    if (r.text !== a.body) casualties.push({ file: a.file, q: a.q, before: a.body, after: r.text, hits: r.hits });
  }
  if (casualties.length) {
    const shown = casualties.slice(0, 6).map((c) =>
      "\n      " + c.file + "  " + c.q +
      "\n        hits:   " + JSON.stringify(c.hits) +
      "\n        before: " + c.before.slice(0, 190) +
      "\n        after:  " + c.after.slice(0, 190)).join("");
    assert.fail(casualties.length + " of " + answers.length + " real FAQ answers were mangled:" + shown);
  }
});

t("no real FAQ answer is ever gutted", () => {
  const gutted = answers.filter((a) => plainEnglish(a.body).gutted).map((a) => a.file + ": " + a.q);
  assert.deepEqual(gutted, [], "answers replaced by an assurance: " + gutted.join(" | "));
});

/* ---------- 4. things a customer legitimately reads about money and controls ------------------ */

const MUST_SURVIVE = [
  "One hundred credits is one dollar of model value at cost, and credits are sold at a 25% markup, so $1.25 buys 100 credits.",
  "$12.50 is the smallest top-up. The offered amounts are $12.50, $25, $50 and $100.",
  "Use \"Buy credits\" on the Setup screen and I can walk you through it.",
  "Your code looks like DOMI-4F2A-9K3B and it can only be used once.",
  "Deep Think pushes the model to reason longer before answering.",
  "There are 27 models in the catalog, and the picker groups them by what they are good at.",
  "I have switched you to Beginner mode, which is conversation first with no technical vocabulary.",
  "Your balance is 812 credits, which is about eight dollars of model value.",
  "The task table shows every step, and the row states tell you what is waiting.",
  "I can take you to the Connectors screen, where reconnecting takes about twenty seconds.",
  "Estimates are shown as a range, and the high figure is the one to set a limit against.",
  "Type the amount you would like to add and I will take it from there.",
  /*
   * These four are the shipped answers the first version of the filter actually damaged. They are
   * kept as named regressions rather than left to the corpus sweep, because a corpus sweep tells you
   * that something broke and these tell you WHICH mistake came back.
   */
  "Yes, the Tool Activity panel logs the tool calls that ran on your behalf, so there is a record rather than a mystery.",
  "That step moves to a backup engine of similar capability and says so in the log. The build does not stop just because one endpoint stopped answering.",
  "Credits and a payment method with auto top-up enabled. Video is the one area with no free path.",
  "The most common reason is three failed automatic top-up attempts. Fixing the payment method on the Setup screen is what unlocks it.",
];

for (const line of MUST_SURVIVE) {
  t("survives untouched: " + line.slice(0, 46) + "...", () => {
    const r = plainEnglish(line);
    assert.equal(r.text, line, "changed to: " + r.text + "  hits " + JSON.stringify(r.hits));
    assert.equal(r.stripped, false);
  });
}

/* ---------- 5. properties -------------------------------------------------------------------- */

t("empty in, empty out, and no assurance invented", () => {
  for (const v of ["", "   ", null, undefined]) {
    const r = plainEnglish(v);
    assert.equal(r.text, "");
    assert.equal(r.stripped, false);
  }
});

t("idempotent: filtering the output changes nothing", () => {
  for (const [, sample] of MUST_BE_CAUGHT) {
    const once = plainEnglish(sample).text;
    const twice = plainEnglish(once).text;
    assert.equal(twice, once, "second pass differed for: " + sample);
  }
});

t("never throws, whatever it is handed", () => {
  const nasty = [{}, [], 42, true, "```", "$".repeat(500), "a".repeat(20000), "\u0000\uFFFD", "((((", "SELECT"];
  for (const v of nasty) plainEnglish(v);
});

console.log(`\naltana-plain_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
