/*
 * The learning loop's self-test — run: node feedback_test.mjs
 *
 * Three of these tests exist because the feature would be a liability without them rather than
 * merely unfinished: the review queue must never carry a uid (Fred's "no identifiable info" rule),
 * a guest must never be able to spend more than ten of Fred's Opus 5 calls per kind per day, and an
 * approved lesson must land on exactly the accounts it was scoped to and no others.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFeedback, createDistiller, parseDistillation, deidentify } from "./feedback.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  - " + name); }
  catch (e) { fail++; console.log("  FAIL - " + name + "\n        " + (e.message || e)); }
}
// Windows holds the SQLite WAL handle until the store is closed, so every scratch store is closed
// before its directory goes, and the removal itself never fails the run.
function teardown(store, path) {
  try { store.close(); } catch {}
  try { rmSync(path, { recursive: true, force: true }); } catch {}
}
console.log("feedback_test:");

const dir = mkdtempSync(join(tmpdir(), "fb-"));
let calls = [];
// A stub distiller: records what it was asked and answers in the real shape.
const stub = async (kind, payload) => {
  calls.push({ kind, payload });
  return { ok: true, lesson: `lesson for ${kind}`, why: `because ${kind}`, report: `report for ${kind}`,
    fix: kind === "inspect" ? "the fix" : "", model: "claude-opus-5" };
};
let clock = "2026-08-08T12:00:00.000Z";
const fb = createFeedback({ dir, distill: stub, now: () => clock });

const OWNER = { isOwner: true, uid: "owner", role: "owner" };
const ALICE = { isOwner: false, uid: "u_alice", role: "credit" };
const BOB = { isOwner: false, uid: "u_bob", role: "credit" };

await t("a guest thumb queues a lesson and applies nothing yet", async () => {
  const r = await fb.react(ALICE, { kind: "positive", question: "how do I deploy?", answer: "Run npm run deploy." });
  assert.equal(r.ok, true);
  assert.equal(r.applied, false, "a guest's lesson must wait for Fred");
  assert.equal(fb.promptBlock(ALICE), "", "nothing reaches the prompt before approval");
  assert.equal(fb.pendingCount(), 1);
});

await t("THE PRIVACY RULE: the review queue carries no account identity", async () => {
  const rows = fb.pending();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(!("uid" in row), "uid must never appear in the owner-facing list");
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("u_alice"), "no uid anywhere in the payload");
  assert.ok(!serialized.includes("@"), "no email-shaped content");
  // Everything Fred asked to see IS there.
  assert.ok(row.lesson && row.why && row.kind && row.createdAt);
});

await t("the compiled file exists and is anonymous too", () => {
  const text = readFileSync(fb.filePath, "utf8");
  assert.ok(text.includes("lesson for positive"));
  assert.ok(!text.includes("u_alice"), "the file on disk cannot carry what the screen refuses to show");
});

await t("approving a guest lesson applies it to THAT account only", async () => {
  const id = fb.pending()[0].id;
  const d = fb.decide(OWNER, id, "approve");
  assert.equal(d.ok, true);
  assert.equal(d.scope, "user");
  assert.match(fb.promptBlock(ALICE), /lesson for positive/);
  assert.equal(fb.promptBlock(BOB), "", "one guest's taste never leaks to another");
  assert.equal(fb.promptBlock(OWNER), "", "nor to the owner");
});

await t("denying drops it for good", async () => {
  await fb.react(BOB, { kind: "negative", question: "q", answer: "a" });
  const id = fb.pending()[0].id;
  assert.equal(fb.decide(OWNER, id, "deny").ok, true);
  assert.equal(fb.promptBlock(BOB), "", "a denied lesson never reaches a prompt");
  assert.equal(fb.decide(OWNER, id, "approve").ok, false, "and cannot be decided twice");
});

await t("'later' keeps it in the queue for the next time Fred opens the app", async () => {
  await fb.react(BOB, { kind: "positive", question: "q", answer: "a" });
  const id = fb.pending()[0].id;
  assert.equal(fb.decide(OWNER, id, "later").ok, true);
  assert.equal(fb.pendingCount(), 1, "still waiting");
  assert.equal(fb.promptBlock(BOB), "", "deferred is not approved");
  assert.equal(fb.decide(OWNER, id, "approve").ok, true, "and can still be decided later");
  assert.match(fb.promptBlock(BOB), /lesson for positive/);
});

await t("only the owner decides anything", () => {
  const r = fb.decide(ALICE, 1, "approve");
  assert.equal(r.ok, false);
  assert.match(r.error, /owner only/);
});

await t("THE RATE LIMIT: ten positive and ten negative per guest per day, counted separately", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "fb2-"));
  let c = "2026-08-08T09:00:00.000Z";
  const fb2 = createFeedback({ dir: d2, distill: stub, now: () => c });
  const CARL = { isOwner: false, uid: "u_carl", role: "credit" };
  for (let i = 0; i < 10; i++) {
    assert.equal((await fb2.react(CARL, { kind: "positive", question: "q", answer: "a" })).ok, true, `positive ${i + 1} should pass`);
  }
  const over = await fb2.react(CARL, { kind: "positive", question: "q", answer: "a" });
  assert.equal(over.ok, false);
  assert.equal(over.rateLimited, true);
  assert.match(over.error, /resets tomorrow/);
  // The negative budget is its own bucket, untouched by ten positives.
  assert.equal((await fb2.react(CARL, { kind: "negative", question: "q", answer: "a" })).ok, true);
  // Tomorrow the counter resets.
  c = "2026-08-09T09:00:00.000Z";
  assert.equal((await fb2.react(CARL, { kind: "positive", question: "q", answer: "a" })).ok, true);
  teardown(fb2, d2);
});

await t("the gate runs BEFORE the model, so a rate-limited tap costs Fred nothing", async () => {
  const d3 = mkdtempSync(join(tmpdir(), "fb3-"));
  const fb3 = createFeedback({ dir: d3, distill: stub, now: () => "2026-08-08T09:00:00.000Z", dailyLimit: 2 });
  const DEE = { isOwner: false, uid: "u_dee", role: "credit" };
  await fb3.react(DEE, { kind: "positive", question: "q", answer: "a" });
  await fb3.react(DEE, { kind: "positive", question: "q", answer: "a" });
  calls = [];
  await fb3.react(DEE, { kind: "positive", question: "q", answer: "a" });
  assert.equal(calls.length, 0, "no Opus 5 call may happen once the budget is spent");
  teardown(fb3, d3);
});

await t("the owner is exempt from the limit and skips the queue entirely", async () => {
  const d4 = mkdtempSync(join(tmpdir(), "fb4-"));
  const fb4 = createFeedback({ dir: d4, distill: stub, now: () => "2026-08-08T09:00:00.000Z", dailyLimit: 1 });
  for (let i = 0; i < 5; i++) {
    const r = await fb4.react(OWNER, { kind: "positive", question: "q", answer: "a" });
    assert.equal(r.ok, true, "the owner is never rationed against his own key");
    assert.equal(r.applied, true, "and never waits for his own approval");
  }
  assert.equal(fb4.pendingCount(), 0, "nothing of the owner's sits in the queue");
  assert.match(fb4.promptBlock(OWNER), /lesson for positive/, "it is live immediately");
  teardown(fb4, d4);
});

await t("critique and inspect are owner-only, report at once, and queue GLOBALLY", async () => {
  const d5 = mkdtempSync(join(tmpdir(), "fb5-"));
  const fb5 = createFeedback({ dir: d5, distill: stub, now: () => "2026-08-08T09:00:00.000Z" });
  assert.equal((await fb5.report(ALICE, { kind: "critique", answer: "a" })).ok, false, "a guest cannot run the owner's lenses");

  const crit = await fb5.report(OWNER, { kind: "critique", question: "q", answer: "a" });
  assert.equal(crit.ok, true);
  assert.match(crit.report, /report for critique/, "the report comes back on the spot");

  const insp = await fb5.report(OWNER, { kind: "inspect", question: "q", answer: "a" });
  assert.equal(insp.fix, "the fix", "inspect proposes a fix, critique does not");

  // Not applied until approved — and then applied to EVERYONE, per Fred's ruling.
  assert.equal(fb5.promptBlock(OWNER), "");
  const d = fb5.decide(OWNER, crit.id, "approve");
  assert.equal(d.scope, "global");
  assert.match(fb5.promptBlock(OWNER), /lesson for critique/, "lands on the owner");
  assert.match(fb5.promptBlock(ALICE), /lesson for critique/, "and on every guest");
  assert.match(fb5.promptBlock(BOB), /lesson for critique/);
  teardown(fb5, d5);
});

await t("a distillation with no lesson in it is not stored as one", async () => {
  const d6 = mkdtempSync(join(tmpdir(), "fb6-"));
  const empty = async () => ({ ok: true, lesson: "   ", why: "nothing generalizable here" });
  const fb6 = createFeedback({ dir: d6, distill: empty, now: () => "2026-08-08T09:00:00.000Z" });
  const r = await fb6.react(ALICE, { kind: "positive", question: "q", answer: "a" });
  assert.equal(r.ok, false, "an empty lesson is a non-event, not a queue entry");
  assert.equal(fb6.pendingCount(), 0);
  teardown(fb6, d6);
});

await t("a failed distillation does not consume the guest's daily budget", async () => {
  const d7 = mkdtempSync(join(tmpdir(), "fb7-"));
  const broken = async () => ({ ok: false, error: "provider down" });
  const fb7 = createFeedback({ dir: d7, distill: broken, now: () => "2026-08-08T09:00:00.000Z", dailyLimit: 3 });
  const EVE = { isOwner: false, uid: "u_eve", role: "credit" };
  for (let i = 0; i < 5; i++) await fb7.react(EVE, { kind: "positive", question: "q", answer: "a" });
  assert.equal(fb7.quota(EVE, "positive").used, 0, "an outage must not eat someone's ten");
  teardown(fb7, d7);
});

await t("identifying details are scrubbed even if the model writes them", async () => {
  const leaky = async () => ({ ok: true, lesson: "Email fred@example.com about C:\\Users\\rjfla\\secret.txt", why: "see https://internal.example/x" });
  const d8 = mkdtempSync(join(tmpdir(), "fb8-"));
  const fb8 = createFeedback({ dir: d8, distill: leaky, now: () => "2026-08-08T09:00:00.000Z" });
  await fb8.react(ALICE, { kind: "positive", question: "q", answer: "a" });
  const row = fb8.pending()[0];
  assert.ok(!row.lesson.includes("fred@example.com"), "an email never survives storage");
  assert.ok(!row.lesson.includes("C:\\Users"), "nor a path");
  assert.ok(!row.why.includes("https://"), "nor a link");
  teardown(fb8, d8);
});

await t("deidentify leaves an ordinary lesson untouched", () => {
  const plain = "Lead with the exact command, then explain what it does.";
  assert.equal(deidentify(plain), plain);
});

await t("the distiller's JSON survives fences and surrounding prose", () => {
  assert.equal(parseDistillation('{"lesson":"a","why":"b"}').lesson, "a");
  assert.equal(parseDistillation('```json\n{"lesson":"a","why":"b"}\n```').why, "b");
  assert.equal(parseDistillation('Here you go:\n{"lesson":"a","why":"b"}\nHope that helps').lesson, "a");
  assert.equal(parseDistillation("not json at all"), null);
});

await t("the distiller sends Opus 5 no sampling parameters and handles a refusal", async () => {
  const seen = [];
  const fakeStream = async (model, messages, opts) => {
    seen.push({ model, messages, opts });
    return { ok: true, content: '{"lesson":"x","why":"y"}', model };
  };
  const d = createDistiller({ stream: fakeStream, apiKey: () => "sk-test" });
  const out = await d("positive", { question: "q", answer: "a" });
  assert.equal(out.ok, true);
  assert.equal(seen[0].model, "claude-opus-5");
  for (const banned of ["temperature", "topP", "top_p", "topK", "top_k", "thinkingBudget", "budget_tokens"]) {
    assert.ok(!(banned in seen[0].opts), `${banned} is rejected by Opus 5 and must not be sent`);
  }
  // A safety decline is a normal 200 — it must be read from stopReason, never from content.
  const refusing = createDistiller({
    stream: async () => ({ ok: true, stopReason: "refusal", stopDetails: { category: "cyber" }, content: "" }),
    apiKey: () => "sk-test",
  });
  const r = await refusing("inspect", { question: "q", answer: "a" });
  assert.equal(r.ok, false);
  assert.match(r.error, /declined/);
});

await t("with no key configured it says so instead of failing silently", async () => {
  const d = createDistiller({ stream: async () => ({ ok: true }), apiKey: () => "" });
  const r = await d("positive", { question: "q", answer: "a" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/);
});

teardown(fb, dir);
console.log(`\nfeedback_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
