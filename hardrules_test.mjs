/*
 * Crucible HARD RULES self-test. Run with: node hardrules_test.mjs
 *
 * Every assertion here corresponds to a rule in docs/CRUCIBLE-HARD-RULES.md, and every rule
 * corresponds to a defect that actually shipped. The reference failure is the Speak-Easy build
 * (ide_656a18b1-254, 2026-08-02): 149 minutes, $1.88, ~4,980 lines of real code, and an app that
 * cannot launch — which then vanished from the interface without a word.
 *
 * Proves:
 *   R1  every terminal state notifies; checkpoint notifies at high urgency with its count
 *   R2  a checkpointed build stays visible in a "needs attention" bucket and carries its reason
 *   R7  a build that verified nothing reports ran:false with a stated reason (caller blocks `done`)
 *   R8  verification discovers Gradle roots and NESTED package.json/tsconfig, each with its own dir
 *   R8b a Gradle project with no wrapper is a named blocker, never a silent skip
 */
import assert from "node:assert/strict";
import { escalationFor, unnotifiedTerminals } from "./idepush.mjs";
import { TERMINAL, createIdeJobs } from "./idejobs.mjs";
import { discoverVerificationPlan } from "./ideengine.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

/* ── R1 ──────────────────────────────────────────────────────────────────────────────────────── */

await t("R1: EVERY terminal state notifies — no terminal may be silent by omission", () => {
  const gaps = unnotifiedTerminals(TERMINAL);
  assert.deepEqual(gaps, [],
    "these terminal states produce no notification and are not declared silent: " + gaps.join(", "));
});

await t("R1: a checkpoint notifies at HIGH urgency and leads with the count", () => {
  const note = escalationFor({ type: "checkpoint", remaining: ["MainActivity.kt was never written", "b", "c"] },
    { workspaceName: "Speak-Easy" });
  assert.ok(note, "a checkpoint must never be silent — this is exactly what fell off Fred's screen");
  assert.equal(note.urgency, "high", "unfinished work is waiting on the user; that outranks a clean finish");
  assert.match(note.title, /unfinished/i);
  assert.match(note.body, /^3 items still need you/, "the count leads so it is actionable from a lock screen");
  assert.match(note.body, /MainActivity/, "and the first item travels with it");
});

await t("R1: one remaining item reads as singular, and zero still notifies", () => {
  assert.match(escalationFor({ type: "checkpoint", remaining: ["x"] }).body, /^1 item still needs you/);
  assert.ok(escalationFor({ type: "checkpoint", remaining: [] }), "a bare checkpoint still reaches the user");
});

await t("R1: routine progress stays silent (the original ruling is intact)", () => {
  for (const type of ["move", "plan", "file", "diff", "run", "cost", "snapshot"]) {
    assert.equal(escalationFor({ type }), null, type + " must never buzz a phone");
  }
  assert.equal(escalationFor({ type: "stopped" }), null, "the user pressed stop; they already know");
});

/* ── R2 ──────────────────────────────────────────────────────────────────────────────────────── */

async function jobsFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "hardrules-"));
  const jobs = createIdeJobs({ dir, log: () => {} });
  try { return await run(jobs); } finally {
    try { jobs.dispose && jobs.dispose(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

await t("R2: a checkpointed build leaves 'active' but lands in 'needs attention' — it never vanishes", () =>
  jobsFixture((jobs) => {
    const job = jobs.create({ uid: "fred", kind: "build", workspaceId: "ws1" });
    jobs.finish(job.id, { type: "checkpoint", complete: false,
      remaining: ["Task 7 did not finish after adaptive retries.", "MainActivity.kt was never written."],
      message: "Checkpoint saved. The build is not complete: Task 7 did not finish after adaptive retries." });

    assert.equal(jobs.activeFor("fred").length, 0, "it is genuinely not running any more");
    const attention = jobs.needsAttentionFor("fred");
    assert.equal(attention.length, 1, "but it MUST still be somewhere the user can see it");
    assert.equal(jobs.openFor("fred").length, 1, "and a status rail that renders openFor() shows it");

    const s = attention[0];
    assert.equal(s.unfinished, true);
    assert.equal(s.outcome, "checkpoint");
    assert.equal(s.remainingCount, 2, "the count travels with the summary");
    assert.match(s.why, /not complete/i, "and one plain sentence says why, without replaying the journal");
  }));

await t("R2: a build that finished cleanly DOES disappear — done is the only quiet outcome", () =>
  jobsFixture((jobs) => {
    const job = jobs.create({ uid: "fred", kind: "build", workspaceId: "ws1" });
    jobs.finish(job.id, { type: "done" });
    assert.equal(jobs.needsAttentionFor("fred").length, 0);
    assert.equal(jobs.openFor("fred").length, 0);
    assert.equal(jobs.listFor("fred")[0].unfinished, false);
  }));

await t("R2: errored and stopped builds also stay visible", () =>
  jobsFixture((jobs) => {
    const a = jobs.create({ uid: "fred", kind: "build", workspaceId: "ws1" });
    jobs.finish(a.id, { type: "error", message: "provider refused" });
    const b = jobs.create({ uid: "fred", kind: "build", workspaceId: "ws2" });
    jobs.stop(b.id, "stopped by the user");
    assert.equal(jobs.needsAttentionFor("fred").length, 2);
  }));

/* ── R8 ──────────────────────────────────────────────────────────────────────────────────────── */

// The actual Speak-Easy layout: Gradle at the root, a Node/TS server nested in server/, no
// root package.json. The old planner saw no root package.json and verified NOTHING.
const SPEAK_EASY_TREE = [
  "settings.gradle.kts",
  "build.gradle.kts",
  "gradle/libs.versions.toml",
  "app/build.gradle.kts",
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/speakeasy/data/remote/ApiClient.kt",
  "server/package.json",
  "server/tsconfig.json",
  "server/src/app.ts",
];

await t("R8: the exact Speak-Easy layout no longer verifies nothing", async () => {
  const plan = await discoverVerificationPlan({
    entries: SPEAK_EASY_TREE,
    readFile: async (p) => p === "server/package.json"
      ? JSON.stringify({ scripts: { build: "tsc", start: "node dist/app.js" } })
      : "",
  });
  assert.ok(plan.commands.length > 0,
    "this is the whole bug: 'Nothing to verify: no package.json scripts' on a real two-part project");
  const server = plan.commands.find((c) => c.dir === "server");
  assert.ok(server, "the nested server/ must be discovered");
  assert.equal(server.dir, "server", "and its check must run in ITS OWN directory, not the repo root");
  assert.match(server.cmd, /npm run build/);
});

await t("R8: a TypeScript project that declares no check script is still compiled", async () => {
  const plan = await discoverVerificationPlan({
    entries: ["api/package.json", "api/tsconfig.json"],
    readFile: async () => JSON.stringify({ scripts: { start: "node ." } }),   // no check/build/test
  });
  const tsc = plan.commands.find((c) => /tsc/.test(c.cmd));
  assert.ok(tsc, "a tsconfig with no declared check must still get tsc --noEmit");
  assert.equal(tsc.dir, "api");
});

await t("R8: a Gradle project WITH a wrapper gets a real build command", async () => {
  const plan = await discoverVerificationPlan({
    entries: ["settings.gradle.kts", "gradlew", "gradlew.bat", "app/src/main/AndroidManifest.xml"],
    readFile: async () => "",
  });
  const gradle = plan.commands.find((c) => /gradlew/i.test(c.cmd));
  assert.ok(gradle, "Gradle must be recognised as a project type at all");
  assert.match(gradle.cmd, /assembleDebug/, "an AndroidManifest means the Android build is the check");
});

await t("R8b: a Gradle project with NO wrapper is a named blocker, not a silent skip", async () => {
  const plan = await discoverVerificationPlan({
    entries: SPEAK_EASY_TREE,   // no gradlew anywhere — exactly what shipped
    readFile: async () => "",
  });
  assert.ok(plan.blockers.some((b) => /gradlew/.test(b)),
    "no wrapper means the app cannot be built, and that must be said out loud");
});

await t("R8: node_modules is never mistaken for a project", async () => {
  const plan = await discoverVerificationPlan({
    entries: ["node_modules/left-pad/package.json"],
    readFile: async () => JSON.stringify({ scripts: { test: "exit 1" } }),
  });
  assert.equal(plan.commands.length, 0);
});

await t("R7: an unrecognised project yields no commands AND an explaining reason", async () => {
  const plan = await discoverVerificationPlan({ entries: ["notes.txt", "photo.png"], readFile: async () => "" });
  assert.equal(plan.commands.length, 0);
  assert.match(plan.why, /no recognised project markers/i,
    "the caller turns 'nothing ran' into 'cannot be called finished', so the reason must be legible");
});

console.log("\nhardrules: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
