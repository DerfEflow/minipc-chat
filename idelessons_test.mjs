/*
 * Lessons-learned store self-test - run: node idelessons_test.mjs
 * Covers the store (record/dedupe/select/policies/retire/persistence/corrupt-file tolerance), the
 * brain and frontier prompt builders and their parsers, the failure dossier's clipping, the
 * escalation chooser's three branches, and the plain-English journal line.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LESSON_SCOPES, createLessonStore, failureDossier,
  BRAIN_SYSTEM, brainReportMessages, parseBrainReport,
  FRONTIER_SYSTEM, frontierCorrectionMessages, parseFrontierCorrection,
  guidanceTurn, strongerModelFor, STRONGER_ATTEMPTS, reportLine, isSafeLesson,
} from "./idelessons.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };

const tmp = () => mkdtempSync(join(tmpdir(), "idelessons-"));

/* ---- store: record, dedupe, reinforce, upgrade ------------------------------------------------ */

t("record adds a new active lesson with hits:1", () => {
  const store = createLessonStore({ dir: tmp() });
  const { lesson, reinforced } = store.record({
    text: "Always create the test helper file before the test that imports it.",
    scope: "move", source: "brain", model: "gx10/qwen3-coder-30b", tags: ["setup", "Setup", ""],
  });
  assert.ok(lesson);
  assert.equal(reinforced, false);
  assert.equal(lesson.hits, 1);
  assert.equal(lesson.status, "active");
  assert.equal(lesson.source, "brain");
  assert.deepEqual(lesson.tags, ["setup"], "tags are trimmed, lowercased, deduped-of-blanks");
  assert.equal(lesson.id.length, 8);
});

t("empty or short text is refused, no lesson created", () => {
  const store = createLessonStore({ dir: tmp() });
  assert.deepEqual(store.record({ text: "", scope: "move", source: "brain" }), { lesson: null, reinforced: false });
  assert.deepEqual(store.record({ text: "too short", scope: "move", source: "brain" }), { lesson: null, reinforced: false });
});

t("unknown scope falls back to move", () => {
  const store = createLessonStore({ dir: tmp() });
  const { lesson } = store.record({ text: "This is a perfectly generalizable lesson sentence.", scope: "bogus", source: "brain" });
  assert.equal(lesson.scope, "move");
});

t("a near-duplicate reinforces instead of duplicating", () => {
  const store = createLessonStore({ dir: tmp() });
  store.record({ text: "Always run npm install before running the test suite.", scope: "install", source: "brain", model: "gx10/qwen3-coder-30b" });
  const { lesson, reinforced } = store.record({ text: "Always run npm install before running the test suite!", scope: "install", source: "brain", model: "gx10/qwen3-coder-30b" });
  assert.equal(reinforced, true);
  assert.equal(lesson.hits, 2);
  assert.equal(store.list({ scope: "install" }).length, 1, "no duplicate record was added");
});

t("a frontier source upgrades a brain lesson's source and wording", () => {
  const store = createLessonStore({ dir: tmp() });
  store.record({ text: "Name the export exactly as the test file imports it.", scope: "verify", source: "brain", model: "gx10/gpt-oss-120b" });
  const { lesson, reinforced } = store.record({ text: "Name the export exactly as the test file imports it, case included.", scope: "verify", source: "frontier", model: "openai/gpt-5.5" });
  assert.equal(reinforced, true);
  assert.equal(lesson.source, "frontier", "frontier wording outranks the brain guess");
  assert.match(lesson.text, /case included/);
});

t("a genuinely different lesson in the same scope does not reinforce", () => {
  const store = createLessonStore({ dir: tmp() });
  store.record({ text: "Always run npm install before running the test suite.", scope: "install", source: "brain" });
  const { reinforced } = store.record({ text: "Pin the Node engine version in package.json to avoid a stale toolchain.", scope: "install", source: "brain" });
  assert.equal(reinforced, false);
  assert.equal(store.list({ scope: "install" }).length, 2);
});

/* ---- select: ranking, applied counter, policiesBlock ------------------------------------------ */

t("select ranks same-provider lessons first, then by hits", () => {
  const store = createLessonStore({ dir: tmp() });
  store.record({ text: "Lesson from a different provider entirely, generalizable enough.", scope: "move", source: "brain", model: "openai/gpt-5.5" });
  store.record({ text: "Same provider lesson, lower hit count than the next one.", scope: "move", source: "brain", model: "gx10/qwen3-coder-30b" });
  store.record({ text: "Same provider lesson, hit twice so it should rank first here.", scope: "move", source: "brain", model: "gx10/qwen3-coder-30b" });
  store.record({ text: "Same provider lesson, hit twice so it should rank first here!!", scope: "move", source: "brain", model: "gx10/qwen3-coder-30b" });
  const picked = store.select({ scope: "move", model: "gx10/gpt-oss-120b" });
  assert.equal(picked[0].hits, 2, "the twice-hit same-provider lesson leads");
  assert.ok(picked[0].model.startsWith("gx10/"));
  assert.ok(picked.slice(0, 2).every((l) => l.model.startsWith("gx10/")), "same-provider lessons sort before the other provider's");
  assert.equal(picked[2].model, "openai/gpt-5.5", "the other-provider lesson sorts last");
});

t("select and policiesBlock increment applied on every returned lesson", () => {
  const store = createLessonStore({ dir: tmp() });
  const { lesson } = store.record({ text: "Reread the current file before claiming NO-CHANGE against it.", scope: "verify", source: "brain" });
  assert.equal(lesson.applied, 0);
  store.select({ scope: "verify", model: "gx10/qwen3-coder-30b" });
  const afterOne = store.list({ scope: "verify" })[0];
  assert.equal(afterOne.applied, 1);
  const block = store.policiesBlock({ scope: "verify", model: "gx10/qwen3-coder-30b" });
  assert.match(block, /^POLICIES FROM PAST BUILDS/);
  assert.match(block, /Reread the current file/);
  const afterTwo = store.list({ scope: "verify" })[0];
  assert.equal(afterTwo.applied, 2, "policiesBlock uses select(), so it counts as a second injection");
});

t("policiesBlock is empty string when there is nothing to inject", () => {
  const store = createLessonStore({ dir: tmp() });
  assert.equal(store.policiesBlock({ scope: "planner", model: "x" }), "");
});

t("noteWinFor credits wins without counting as an injection", () => {
  const store = createLessonStore({ dir: tmp() });
  store.record({ text: "Install the exact dependency version the lockfile pins, not latest.", scope: "install", source: "brain", model: "gx10/qwen3-coder-30b" });
  const credited = store.noteWinFor({ scope: "install", model: "gx10/qwen3-coder-30b" });
  assert.equal(credited, 1);
  const rec = store.list({ scope: "install" })[0];
  assert.equal(rec.wins, 1);
  assert.equal(rec.applied, 0, "noteWinFor must not touch applied");
});

t("creditWin bumps wins for the given ids", () => {
  const store = createLessonStore({ dir: tmp() });
  const { lesson } = store.record({ text: "Verify the port is free before starting the dev server.", scope: "verify", source: "brain" });
  store.creditWin([lesson.id, "not-a-real-id"]);
  assert.equal(store.list({ scope: "verify" })[0].wins, 1);
});

/* ---- retire, stats, bumpReports ---------------------------------------------------------------- */

t("retire at maxActive drops the weakest lesson and keeps the strong ones selectable", () => {
  const store = createLessonStore({ dir: tmp(), maxActive: 3 });
  const texts = [
    "Distinct filler lesson about environment setup timing quirks.",
    "Different filler lesson about database connection pooling limits.",
    "Another filler lesson about frontend build cache invalidation bugs.",
  ];
  const ids = texts.map((text) => store.record({ text, scope: "move", source: "brain" }).lesson.id);
  // Give the first two some strength before the fourth pushes the store over the cap.
  store.creditWin([ids[0], ids[0], ids[1]]);
  const fourth = store.record({ text: "One more filler lesson about test runner flakiness under load.", scope: "move", source: "brain" });
  assert.equal(store.stats().active, 3, "the cap holds at maxActive");
  assert.equal(store.stats().retired, 1, "exactly one lesson was retired to make room");
  const active = store.list({ status: "active" }).map((l) => l.id);
  assert.ok(active.includes(fourth.lesson.id), "the newly added lesson survives");
  assert.ok(active.includes(ids[0]), "the strongest lesson survives");
});

t("stats totals hits, applied, wins, reports across the store", () => {
  const store = createLessonStore({ dir: tmp() });
  store.record({ text: "First lesson about a coverage gap in the generated test file.", scope: "move", source: "brain" });
  store.record({ text: "Second lesson about a different coverage gap entirely, unrelated wording.", scope: "move", source: "brain" });
  store.bumpReports();
  store.bumpReports();
  const s = store.stats();
  assert.equal(s.active, 2);
  assert.equal(s.retired, 0);
  assert.equal(s.hits, 2);
  assert.equal(s.reports, 2);
});

t("retire(id) marks a specific lesson retired and it drops out of select", () => {
  const store = createLessonStore({ dir: tmp() });
  const { lesson } = store.record({ text: "This lesson is about to be retired by hand in the test.", scope: "repair", source: "human" });
  assert.equal(store.retire(lesson.id), true);
  assert.equal(store.retire(lesson.id), false, "retiring twice is a no-op the second time");
  assert.equal(store.select({ scope: "repair", model: "x" }).length, 0);
  assert.equal(store.list({ scope: "repair", status: "retired" }).length, 1);
});

/* ---- persistence and corruption tolerance ------------------------------------------------------ */

t("a lesson persists across a second createLessonStore on the same dir", () => {
  const dir = tmp();
  const first = createLessonStore({ dir });
  const { lesson } = first.record({ text: "Persisted lesson: always close the db handle in a finally block.", scope: "verify", source: "brain" });
  assert.ok(existsSync(join(dir, "lessons.json")));
  const second = createLessonStore({ dir });
  const found = second.list({ scope: "verify" }).find((l) => l.id === lesson.id);
  assert.ok(found, "the second store instance loaded the first one's write");
  assert.equal(found.text, lesson.text);
});

t("a corrupt lessons.json is tolerated and the store starts empty", () => {
  const dir = tmp();
  writeFileSync(join(dir, "lessons.json"), "{ this is not json");
  const store = createLessonStore({ dir });
  assert.deepEqual(store.stats(), { active: 0, retired: 0, hits: 0, applied: 0, wins: 0, reports: 0 });
  // And it can still write normally afterward, overwriting the corrupt file.
  store.record({ text: "A fresh lesson recorded after recovering from a corrupt file.", scope: "move", source: "brain" });
  const raw = JSON.parse(readFileSync(join(dir, "lessons.json"), "utf8"));
  assert.equal(raw.lessons.length, 1);
});

t("a missing lessons.json is tolerated (no file yet, no crash)", () => {
  const dir = tmp();
  const store = createLessonStore({ dir });
  assert.equal(store.stats().active, 0);
});

/* ---- brain report: messages + parser ------------------------------------------------------------ */

t("brainReportMessages lays out STAGE/MOVE/FILES/MODEL/ATTEMPT/GOAL and the policies block", () => {
  const dossier = failureDossier({
    move: { id: "m1", title: "Build the API route", files: ["src/api.js"] },
    model: "gx10/qwen3-coder-30b", taskClass: "backend", stage: "verify", attempt: 2,
    reply: "here is my attempt", checkOutput: "Error: cannot find module", pipelineNotes: "retried once already", goal: "a todo API",
  });
  const msgs = brainReportMessages(dossier, { policies: "POLICIES FROM PAST BUILDS (learned from real failures; follow them):\n- always do X" });
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, BRAIN_SYSTEM);
  assert.match(msgs[1].content, /STAGE: verify/);
  assert.match(msgs[1].content, /MOVE: Build the API route/);
  assert.match(msgs[1].content, /FILES: src\/api\.js/);
  assert.match(msgs[1].content, /MODEL: gx10\/qwen3-coder-30b/);
  assert.match(msgs[1].content, /ATTEMPT: 2/);
  assert.match(msgs[1].content, /GOAL: a todo API/);
  assert.match(msgs[1].content, /WHAT THE MODEL RETURNED \(head\):/);
  assert.match(msgs[1].content, /CHECK OUTPUT \(tail\):/);
  assert.match(msgs[1].content, /WHAT THE PIPELINE ALREADY TRIED:/);
  assert.match(msgs[1].content, /always do X/);
  assert.match(msgs[1].content, /Answer NOW with ONLY the JSON object\.$/);
});

t("parseBrainReport reads fenced JSON", () => {
  const reply = "Here you go:\n```json\n{\"diagnosis\":\"Wrong import path.\",\"rootCause\":\"model_format\",\"fix\":\"Fix the import in src/x.js.\",\"lesson\":null,\"confidence\":0.8}\n```";
  const { ok, report } = parseBrainReport(reply);
  assert.ok(ok);
  assert.equal(report.rootCause, "model_format");
  assert.equal(report.confidence, 0.8);
  assert.equal(report.lesson, null);
});

t("parseBrainReport digs a JSON object out of surrounding prose", () => {
  const reply = "Sure, here is my diagnosis. {\"diagnosis\":\"Missing dep.\",\"rootCause\":\"missing_dependency\",\"fix\":\"npm install left-pad in package.json.\",\"lesson\":\"Always declare a dependency before importing it.\",\"confidence\":0.9} Hope that helps!";
  const { ok, report } = parseBrainReport(reply);
  assert.ok(ok);
  assert.equal(report.rootCause, "missing_dependency");
  assert.equal(report.lesson, "Always declare a dependency before importing it.");
});

t("parseBrainReport fails cleanly when fix is missing", () => {
  const { ok, error } = parseBrainReport('{"diagnosis":"x","rootCause":"unknown","confidence":0.5}');
  assert.equal(ok, false);
  assert.equal(error, "no fix");
});

t("parseBrainReport normalizes a bad rootCause to unknown", () => {
  const { report } = parseBrainReport('{"fix":"do the thing","rootCause":"aliens"}');
  assert.equal(report.rootCause, "unknown");
});

t("parseBrainReport clamps confidence into [0,1] and defaults a missing one to 0.5", () => {
  assert.equal(parseBrainReport('{"fix":"x","confidence":5}').report.confidence, 1);
  assert.equal(parseBrainReport('{"fix":"x","confidence":-3}').report.confidence, 0);
  assert.equal(parseBrainReport('{"fix":"x"}').report.confidence, 0.5);
});

t("parseBrainReport's privacy filter rejects a lesson carrying a path, a URL, or a token", () => {
  assert.equal(parseBrainReport('{"fix":"x","lesson":"Fix the file at C:\\\\Users\\\\fred\\\\project\\\\src\\\\x.js directly."}').report.lesson, null);
  assert.equal(parseBrainReport('{"fix":"x","lesson":"See https://example.com/docs for the real fix here."}').report.lesson, null);
  // A neutral 30-character run stands in for a token: GitHub push protection rejects fixtures
  // shaped like a real vendor key, and the filter only looks at the length of the run anyway.
  assert.equal(parseBrainReport('{"fix":"x","lesson":"Use api key qwertyuiopasdfghjklzxcvbnm1234 for auth."}').report.lesson, null);
  assert.equal(parseBrainReport('{"fix":"x","lesson":"Always match the export name to what the test file imports."}').report.lesson, "Always match the export name to what the test file imports.");
});

/* ---- frontier correction: messages + parser ------------------------------------------------------ */

t("frontierCorrectionMessages carries the brain's failed diagnosis and fix", () => {
  const dossier = failureDossier({ move: { id: "m2", title: "Fix the failing test" }, model: "gx10/gpt-oss-120b", stage: "coverage", attempt: 3 });
  const msgs = frontierCorrectionMessages(dossier, { brainReport: { diagnosis: "It thought the file was missing.", fix: "Create test/helpers.js." }, policies: "" });
  assert.equal(msgs[0].content, FRONTIER_SYSTEM);
  assert.match(msgs[1].content, /BRAIN'S DIAGNOSIS: It thought the file was missing\./);
  assert.match(msgs[1].content, /BRAIN'S FIX \(did not work\): Create test\/helpers\.js\./);
  assert.match(msgs[1].content, /Answer NOW with ONLY the JSON object\.$/);
});

t("parseFrontierCorrection mirrors parseBrainReport's shape and rules", () => {
  const good = parseFrontierCorrection('{"correction":"Rename the export to seedDb.","whyBrainWasWrong":"It named the wrong function.","lesson":"Match export names exactly to what tests import.","confidence":0.95}');
  assert.ok(good.ok);
  assert.equal(good.report.correction, "Rename the export to seedDb.");
  assert.equal(good.report.whyBrainWasWrong, "It named the wrong function.");
  assert.equal(good.report.lesson, "Match export names exactly to what tests import.");
  const missing = parseFrontierCorrection('{"whyBrainWasWrong":"x"}');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "no correction");
});

t("isSafeLesson rejects unix absolute paths and accepts a plain policy sentence", () => {
  assert.equal(isSafeLesson("Check /home/fred/project/src/index.js before editing it."), false);
  assert.equal(isSafeLesson("Always name the export to match what the test imports."), true);
});

/* ---- failureDossier clipping -------------------------------------------------------------------- */

t("failureDossier clips the reply from the HEAD and check output from the TAIL", () => {
  const reply = "HEAD".padEnd(6010, "x");
  const checkOutput = "y".repeat(8010) + "TAIL";
  const d = failureDossier({ move: { id: "m3", title: "t", files: [] }, reply, checkOutput, pipelineNotes: "n".repeat(2000), goal: "g".repeat(900), stage: "not_a_real_stage" });
  assert.equal(d.reply.length, 6000);
  assert.ok(d.reply.startsWith("HEAD"), "reply keeps its head");
  assert.equal(d.checkOutput.length, 8000);
  assert.ok(d.checkOutput.endsWith("TAIL"), "check output keeps its tail");
  assert.equal(d.pipelineNotes.length, 1500);
  assert.equal(d.goal.length, 800);
  assert.equal(d.stage, "verify", "an unknown stage falls back to verify");
});

/* ---- guidanceTurn --------------------------------------------------------------------------------- */

t("guidanceTurn labels the source and uppercases it in the header", () => {
  const g1 = guidanceTurn({ source: "brain", text: "Create the file first." });
  assert.equal(g1.role, "user");
  assert.match(g1.content, /^BRAIN GUIDANCE \(from the build's brain; act on it in this retry\):\n/);
  const g2 = guidanceTurn({ source: "frontier", text: "Rename it." });
  assert.match(g2.content, /^FRONTIER GUIDANCE \(from the build's frontier reviewer; act on it in this retry\):\n/);
});

/* ---- strongerModelFor: all three branches -------------------------------------------------------- */

const CATALOG = [
  { id: "gx10/qwen3-coder-30b", provider: "gx10", paramsB: 30, outCost: 0, toolCapable: true },
  { id: "gx10/gpt-oss-120b", provider: "gx10", paramsB: 117, outCost: 0, toolCapable: true },
  { id: "gx10/unkeyed-70b", provider: "gx10", paramsB: 70, outCost: 0, toolCapable: true },
  { id: "gx10/no-tools-200b", provider: "gx10", paramsB: 200, outCost: 0, toolCapable: false },
  { id: "openai/gpt-5.5", provider: "openai", paramsB: null, outCost: 10, toolCapable: true },
];
const keyedSet = new Set(["gx10/qwen3-coder-30b", "gx10/gpt-oss-120b", "gx10/no-tools-200b", "openai/gpt-5.5"]);
const keyed = (id) => keyedSet.has(id);

t("strongerModelFor branch (a): same provider, larger paramsB, keyed and toolCapable wins", () => {
  const id = strongerModelFor("gx10/qwen3-coder-30b", { catalog: CATALOG, keyed, fallbacks: ["openai/gpt-5.5"] });
  assert.equal(id, "gx10/gpt-oss-120b", "the 117B beats the unkeyed 70B and the un-toolCapable 200B");
});

t("strongerModelFor skips a same-provider candidate that is not keyed", () => {
  // Remove the only keyed larger same-provider model; unkeyed-70b (also larger) must be skipped.
  const catalogNoBigKeyed = CATALOG.filter((c) => c.id !== "gx10/gpt-oss-120b");
  const id = strongerModelFor("gx10/qwen3-coder-30b", { catalog: catalogNoBigKeyed, keyed, fallbacks: ["openai/gpt-5.5"] });
  assert.equal(id, "openai/gpt-5.5", "falls through to the fallback list since the only bigger same-provider model is unkeyed or not toolCapable");
});

t("strongerModelFor branch (b): model not in the catalog goes straight to fallbacks, skipping a not-toolCapable one", () => {
  const id = strongerModelFor("mystery/not-in-catalog", { catalog: CATALOG, keyed, fallbacks: ["gx10/no-tools-200b", "gx10/gpt-oss-120b"] });
  assert.equal(id, "gx10/gpt-oss-120b", "no-tools-200b is keyed but not toolCapable, so the next fallback is used");
});

t("strongerModelFor branch (b) takes the first keyed, toolCapable fallback in order", () => {
  const id = strongerModelFor("mystery/not-in-catalog", { catalog: CATALOG, keyed, fallbacks: ["gx10/gpt-oss-120b", "openai/gpt-5.5"] });
  assert.equal(id, "gx10/gpt-oss-120b", "the first fallback already qualifies, so the second is never reached");
});

t("strongerModelFor branch (c): nothing usable returns null", () => {
  assert.equal(strongerModelFor("gx10/gpt-oss-120b", { catalog: CATALOG, keyed, fallbacks: [] }), null, "already the strongest same-provider model, no fallbacks given");
  assert.equal(strongerModelFor("mystery/not-in-catalog", { catalog: CATALOG, keyed, fallbacks: ["gx10/unkeyed-70b"] }), null, "the only fallback is not keyed");
  assert.equal(strongerModelFor("mystery/not-in-catalog", { catalog: CATALOG, keyed, fallbacks: ["mystery/not-in-catalog"] }), null, "a fallback equal to the current model never counts");
});

t("STRONGER_ATTEMPTS is exactly one escalation shot", () => {
  assert.equal(STRONGER_ATTEMPTS, 1);
});

/* ---- reportLine ------------------------------------------------------------------------------------ */

t("reportLine formats a brain report within the 300-char cap", () => {
  const line = reportLine({ diagnosis: "The test imports a helper that was never created.", fix: "Create test/helpers.js exporting seedDb().", confidence: 0.8 }, { source: "brain", model: "gx10/gpt-oss-120b" });
  assert.match(line, /^Brain \(gx10\/gpt-oss-120b, confidence 0\.8\): The test imports a helper/);
  assert.match(line, /Fix: Create test\/helpers\.js exporting seedDb\(\)\.$/);
  assert.ok(line.length <= 300);
});

t("reportLine caps at 300 chars for an oversized frontier correction", () => {
  const line = reportLine({ correction: "z".repeat(500), confidence: 0.4 }, { source: "frontier", model: "openai/gpt-5.5" });
  assert.ok(line.length <= 300);
  assert.match(line, /^Frontier \(openai\/gpt-5\.5, confidence 0\.4\):/);
});

/* ---- no em dashes in any exported prompt string ----------------------------------------------------- */

t("no exported prompt string contains an em dash", () => {
  const emDash = "\u2014";
  assert.ok(!BRAIN_SYSTEM.includes(emDash), "BRAIN_SYSTEM");
  assert.ok(!FRONTIER_SYSTEM.includes(emDash), "FRONTIER_SYSTEM");
  const dossier = failureDossier({ move: { id: "m4", title: "t", files: [] }, goal: "g" });
  for (const m of brainReportMessages(dossier, { policies: "" })) assert.ok(!m.content.includes(emDash), "brainReportMessages");
  for (const m of frontierCorrectionMessages(dossier, { brainReport: {}, policies: "" })) assert.ok(!m.content.includes(emDash), "frontierCorrectionMessages");
  assert.ok(!guidanceTurn({ source: "brain", text: "x" }).content.includes(emDash));
  assert.ok(!reportLine({ diagnosis: "x", fix: "y", confidence: 0.5 }, { source: "brain", model: "m" }).includes(emDash));
});

console.log("\nidelessons: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
