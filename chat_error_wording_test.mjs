/*
 * What a customer is told when a chat turn fails to start. Run: node chat_error_wording_test.mjs
 *
 * FROM A REAL GUEST REPORT, 2026-08-12, verbatim: "http 530 chat failed - tap send to retry".
 *
 * Two defects in one sentence. It showed a raw HTTP status to a paying customer, which is the exact
 * thing Fred forbade and which Altana already has a structural filter against while the main chat did
 * not. And it was wrong about what had happened: 530 is the front door reporting it could not reach
 * the app at all, which on this deployment means the container was mid-swap during a release. The turn
 * never started, nothing was charged, and the honest instruction is to wait rather than to tap send
 * again immediately, which only fails again.
 *
 * This suite reads the shipped public/app.js and exercises the real classifier out of it, so it tests
 * the code that actually runs rather than a copy of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };

/*
 * Newlines normalised before anything looks at this. The repo checks out CRLF on Windows, so a
 * search for "\n}\n" finds nothing in a file whose lines end "\r\n", and the extractor below failed
 * on its first run for exactly that reason rather than for anything to do with the code under test.
 */
const src = readFileSync(new URL("./public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/*
 * Lift the function out of the shipped file. app.js is a browser module full of DOM references, so it
 * cannot be imported here; extracting the one self-contained function keeps this test honest without
 * dragging a headless browser into a suite that runs on every commit.
 */
function loadClassifier() {
  const setMatch = /const UNREACHABLE_STATUS = new Set\(\[[^\]]*\]\);/.exec(src);
  const fnStart = src.indexOf("function chatFailureMessage(");
  assert.ok(setMatch, "UNREACHABLE_STATUS is gone from app.js");
  assert.ok(fnStart > 0, "chatFailureMessage is gone from app.js");
  // Read to the closing brace at column 0, which is how every top-level function in this file ends.
  const fnEnd = src.indexOf("\n}\n", fnStart);
  assert.ok(fnEnd > fnStart, "could not find the end of chatFailureMessage");
  const body = setMatch[0] + "\n" + src.slice(fnStart, fnEnd + 3);
  // eslint-disable-next-line no-new-func
  return new Function("navigator", body + "\nreturn chatFailureMessage;")({ onLine: true });
}
const chatFailureMessage = loadClassifier();

/* ---------- 1. no customer ever sees a status code or a developer string -------------------- */

const EVERY_CASE = [
  [530, "cloudflare cannot reach origin"], [502, "bad gateway"], [503, "service unavailable"],
  [504, "gateway timeout"], [521, ""], [522, ""], [523, ""], [524, ""], [525, ""], [526, ""],
  [429, "rate limited"], [401, "unauthorized"], [403, "forbidden"], [500, "internal server error"],
  [400, "bad request"], [0, "TypeError: Failed to fetch"], [0, "network error"], [0, ""],
  [0, "ECONNRESET reading from upstream"], [418, "teapot"],
];

t("no failure message contains a status code", () => {
  for (const [status, err] of EVERY_CASE) {
    const msg = chatFailureMessage(status, err);
    assert.ok(!/\b\d{3}\b/.test(msg), "a status code reached the user for " + status + ": " + msg);
    assert.ok(!/HTTP/i.test(msg), "the word HTTP reached the user for " + status + ": " + msg);
  }
});

t("no failure message repeats the underlying error string", () => {
  for (const [status, err] of EVERY_CASE) {
    if (!err) continue;
    const msg = chatFailureMessage(status, err);
    for (const word of ["TypeError", "ECONNRESET", "gateway", "unauthorized", "cloudflare", "origin", "upstream", "teapot"]) {
      assert.ok(!new RegExp(word, "i").test(msg), "\"" + word + "\" leaked into: " + msg);
    }
  }
});

t("every message is a complete plain sentence", () => {
  for (const [status, err] of EVERY_CASE) {
    const msg = chatFailureMessage(status, err);
    assert.ok(msg.length > 40, "too terse to be useful for " + status + ": " + msg);
    assert.ok(/[.!?]$/.test(msg), "not a finished sentence for " + status + ": " + msg);
    assert.ok(!msg.includes(String.fromCharCode(0x2014)), "an em dash reached user copy: " + msg);
    assert.ok(!/\bnot\s+[^.,;]{1,40},?\s+but\s+/i.test(msg), "antithesis construction: " + msg);
  }
});

t("every message tells the user what to do next", () => {
  for (const [status, err] of EVERY_CASE) {
    const msg = chatFailureMessage(status, err);
    // Any real instruction counts. The first version of this only accepted the word "again" and
    // failed a message reading "give it another go in a moment", which is a perfectly good next step.
    assert.ok(/again|another go|reload|wait|back online|give it a/i.test(msg),
      "no next step offered for " + status + ": " + msg);
  }
});

/* ---------- 2. the failure is named CORRECTLY, which is the half that was wrong -------------- */

t("a deploy swap says the app is updating, not that chat failed", () => {
  for (const status of [502, 503, 504, 521, 522, 523, 524, 525, 526, 530]) {
    const msg = chatFailureMessage(status, "");
    assert.match(msg, /updating/i, "status " + status + " does not explain itself: " + msg);
    assert.match(msg, /nothing was charged/i, "status " + status + " does not reassure about money: " + msg);
    // The original bug: telling someone to tap send immediately at a door that is not there yet.
    assert.ok(!/tap send/i.test(msg), "still tells the user to retry instantly: " + msg);
    assert.match(msg, /minute|moment/i, "does not tell them to wait: " + msg);
  }
});

t("rate limiting says slow down rather than something is broken", () => {
  const msg = chatFailureMessage(429, "");
  assert.match(msg, /wait|seconds/i);
  assert.ok(!/updating/i.test(msg), "a rate limit was described as a deploy: " + msg);
});

t("an expired sign-in says reload rather than retry", () => {
  for (const s of [401, 403]) {
    const msg = chatFailureMessage(s, "");
    assert.match(msg, /sign-in|reload/i, "status " + s + ": " + msg);
  }
});

t("a dropped connection is named as a connection problem", () => {
  const msg = chatFailureMessage(0, "TypeError: Failed to fetch");
  assert.match(msg, /connection/i);
  assert.match(msg, /still here/i, "does not reassure that their text survived: " + msg);
});

t("an unknown failure stays honest instead of guessing at a cause", () => {
  const msg = chatFailureMessage(500, "internal server error");
  assert.ok(!/updating/i.test(msg), "a real server fault was excused as a deploy: " + msg);
  assert.match(msg, /did not send/i);
  assert.match(msg, /nothing was charged/i);
});

t("the classifier never throws, whatever it is handed", () => {
  for (const [s, e] of [[null, null], [undefined, undefined], ["530", "x"], [NaN, {}], [-1, []], [1e9, "a".repeat(9000)]]) {
    const msg = chatFailureMessage(s, e);
    assert.equal(typeof msg, "string");
    assert.ok(msg.length > 0);
  }
});

/* ---------- 3. the shipped file itself is clean --------------------------------------------- */

t("app.js no longer builds a user-facing message out of a status code", () => {
  assert.ok(!/errMsg\s*=\s*["'`]Chat failed/.test(src),
    "the old \"Chat failed: HTTP nnn\" message is still in the shipped file");
  assert.ok(!/errMsg[^\n]*\+\s*\(?\s*netErr/.test(src),
    "a raw network error string is still being concatenated into a user-facing message");
});

t("the status is carried on the error so the failure can be classified at all", () => {
  assert.match(src, /err\.status\s*=\s*res\.status/,
    "without this the catch cannot tell a deploy swap from a refusal, and the wording goes back to guessing");
});

console.log(`\nchat_error_wording_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
