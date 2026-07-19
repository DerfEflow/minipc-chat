/*
 * Dominion Works task router self-test. Run with: node iderouter_test.mjs
 * Proves the routing promise Fred bought:
 *   1. design work reaches OpenAI and image work reaches the image engine, automatically
 *   2. classification is deterministic and FREE for the ordinary cases (no classifier call)
 *   3. the ambiguous cases are the only ones that pay for a tiebreaker, and a failing
 *      tiebreaker degrades to the free answer rather than stalling
 *   4. every decision carries a reason a human can audit
 *   5. All-In-One collapses text work onto one model without pretending it can draw
 */
import assert from "node:assert/strict";
import {
  classifyMove, classifyMoveSmart, resolveAssignments, routeMove,
  TASK_CLASSES, DEFAULT_ASSIGNMENTS, IMAGE_ENGINE, CLASSIFIER_THRESHOLD, CLASS_INFO,
  PRESETS, presetById,
} from "./iderouter.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const cls = (m) => classifyMove(m).taskClass;

await t("stylesheets and components route to design, servers and schemas to engineering", () => {
  assert.equal(cls({ title: "Tidy the spacing", files: ["src/styles/app.css"] }), "design_code");
  assert.equal(cls({ title: "x", files: ["src/theme.scss"] }), "design_code");
  assert.equal(cls({ title: "x", files: ["index.html"] }), "design_code");
  assert.equal(cls({ title: "x", files: ["server/api/users.ts"] }), "build_code");
  assert.equal(cls({ title: "x", files: ["db/migrations/003_add_users.sql"] }), "build_code");
  assert.equal(cls({ title: "x", files: ["lib/parser.py"] }), "build_code");
});

await t("a request for a picture goes to the image engine and beats every other signal", () => {
  const r = classifyMove({ title: "Design a logo for the landing page", files: ["src/styles/app.css"] });
  assert.equal(r.taskClass, "design_visual", "asking for a logo is image work even next to a css file");
  assert.equal(r.confidence, 0.9);
  assert.match(r.why, /image engine/);
  assert.equal(cls({ title: "Generate an image for the hero" }), "design_visual");
  assert.equal(cls({ title: "Make a favicon" }), "design_visual");
  assert.equal(routeMove({ title: "Draw an icon set" }, {}).model, IMAGE_ENGINE);
});

await t("the SAME extension routes differently by folder, which is the whole trick", () => {
  assert.equal(cls({ title: "x", files: ["src/components/Button.tsx"] }), "design_code");
  assert.equal(cls({ title: "x", files: ["src/ui/Card.jsx"] }), "design_code");
  assert.equal(cls({ title: "x", files: ["src/api/handler.tsx"] }), "build_code");
  assert.equal(cls({ title: "x", files: ["server/services/billing.tsx"] }), "build_code");
  // a bare component with no folder hint leans design, since that is what components usually are
  assert.equal(cls({ title: "x", files: ["Widget.tsx"] }), "design_code");
});

await t("config, docs and renames are mechanical (they go to the cheap model)", () => {
  assert.equal(cls({ title: "x", files: ["package.json"] }), "mechanical");
  assert.equal(cls({ title: "x", files: [".gitignore"] }), "mechanical");
  assert.equal(cls({ title: "x", files: ["README.md"] }), "mechanical");
  assert.equal(cls({ title: "Bump the version and format the config" }), "mechanical");
  assert.equal(cls({ title: "Rename the file to something sensible" }), "mechanical");
});

await t("tests and verification are review work, by filename or by wording", () => {
  assert.equal(cls({ title: "x", files: ["src/__tests__/auth.js"] }), "review");
  assert.equal(cls({ title: "x", files: ["src/auth.test.ts"] }), "review");
  assert.equal(cls({ title: "x", files: ["spec/user_spec.rb"] }), "review");
  assert.equal(cls({ title: "Add unit tests for the parser" }), "review");
  assert.equal(cls({ title: "Verify the build passes typecheck" }), "review");
});

await t("the ordinary cases are FREE: no classifier call is even suggested", () => {
  const ordinary = [
    { title: "Restyle the hero", files: ["src/styles/hero.css"] },
    { title: "Add the payments endpoint", files: ["server/api/pay.ts"] },
    { title: "Design a logo" },
    { title: "Bump the version", files: ["package.json"] },
    { title: "Add tests", files: ["src/x.test.ts"] },
  ];
  for (const m of ordinary) {
    const r = classifyMove(m);
    assert.equal(r.needsClassifier, false, JSON.stringify(m.title) + " should not need a paid tiebreaker");
    assert.ok(r.confidence >= CLASSIFIER_THRESHOLD);
  }
});

await t("only a genuinely ambiguous move asks for a tiebreaker", () => {
  const nothing = classifyMove({ title: "Do the thing" });
  assert.equal(nothing.needsClassifier, true);
  assert.equal(nothing.taskClass, "build_code", "the safe default is the user's own main model");
  assert.match(nothing.why, /nothing specific/);

  // files say one thing, words say another
  const conflict = classifyMove({ title: "Rework the database schema", files: ["src/styles/app.css"] });
  assert.equal(conflict.needsClassifier, true);
  assert.equal(conflict.taskClass, "design_code", "files are facts, so they win the fallback");
  assert.match(conflict.why, /but the wording suggests/);
});

await t("a tiebreaker answer is adopted; a broken tiebreaker degrades to the FREE answer", async () => {
  const move = { title: "Do the thing" };
  const good = await classifyMoveSmart(move, { classify: async () => "mechanical" });
  assert.equal(good.taskClass, "mechanical");
  assert.equal(good.classifier, true);

  const nonsense = await classifyMoveSmart(move, { classify: async () => "banana" });
  assert.equal(nonsense.taskClass, "build_code", "an answer outside the list is ignored");
  assert.equal(nonsense.classifierFailed, true);

  const broken = await classifyMoveSmart(move, { classify: async () => { throw new Error("upstream 500"); } });
  assert.equal(broken.taskClass, "build_code", "a failing classifier must never stall the build");
  assert.equal(broken.classifierFailed, true);

  // and a confident move never spends the call at all
  let called = 0;
  await classifyMoveSmart({ title: "Restyle the hero", files: ["a.css"] }, { classify: async () => { called++; return "mechanical"; } });
  assert.equal(called, 0, "a confident move must not pay for a classifier");
});

await t("every decision carries a reason written for a human", () => {
  for (const m of [
    { title: "Restyle", files: ["a.css"] }, { title: "Design a logo" },
    { title: "Do the thing" }, { title: "Add tests", files: ["a.test.js"] },
  ]) {
    const r = classifyMove(m);
    assert.ok(r.why && r.why.length > 8, "every route needs a readable reason");
    assert.ok(!/[{}\[\]]/.test(r.why), "the reason should read as prose, not a data dump");
    assert.ok(TASK_CLASSES.includes(r.taskClass));
    assert.ok(CLASS_INFO[r.taskClass], "every class needs a label for the board");
  }
});

await t("defaults send design to OpenAI, grunt work to the cheap model, engineering to yours", () => {
  const a = resolveAssignments({}, { fallback: "anthropic/claude-opus-4-8" });
  assert.equal(a.design_code, "openai/gpt-5.6-terra", "Fred's ruling: design_code anchors on terra");
  assert.equal(a.design_visual, IMAGE_ENGINE);
  assert.equal(a.mechanical, DEFAULT_ASSIGNMENTS.mechanical);
  assert.equal(a.build_code, "anthropic/claude-opus-4-8", "engineering follows the workspace model");
  assert.equal(a.review, "anthropic/claude-opus-4-8", "review matches engineering unless told otherwise");
});

await t("an explicit per-class override beats the default", () => {
  const a = resolveAssignments({ design_code: "openai/gpt-5.6-sol", review: "deepseek/deepseek-v4-flash" },
    { fallback: "openai/gpt-4o" });
  assert.equal(a.design_code, "openai/gpt-5.6-sol");
  assert.equal(a.review, "deepseek/deepseek-v4-flash");
  assert.equal(a.build_code, "openai/gpt-4o");
});

await t("All-In-One collapses text work onto one model but never claims it can draw", () => {
  const a = resolveAssignments({ design_code: "openai/gpt-5.6-sol" }, { allInOne: "anthropic/claude-opus-4-8" });
  for (const c of ["design_code", "build_code", "mechanical", "review"]) {
    assert.equal(a[c], "anthropic/claude-opus-4-8", c + " should collapse onto the one model");
  }
  assert.equal(a.design_visual, IMAGE_ENGINE, "no text model returns a PNG, and we say so rather than pretend");
});

await t("routeMove hands back the class, the model, and both reasons in one object", () => {
  const r = routeMove({ title: "Restyle the hero", files: ["src/styles/hero.css"] }, {}, { fallback: "openai/gpt-4o" });
  assert.equal(r.taskClass, "design_code");
  assert.equal(r.model, "openai/gpt-5.6-terra");
  assert.equal(r.isImage, false);
  assert.ok(r.why);
  assert.equal(r.assignments.build_code, "openai/gpt-4o");

  const img = routeMove({ title: "Make a hero image" }, {}, { fallback: "openai/gpt-4o" });
  assert.equal(img.isImage, true);
  assert.equal(img.model, IMAGE_ENGINE);
});

await t("junk input is classified rather than crashing", () => {
  for (const m of [undefined, null, {}, { files: null }, { title: 123, files: [null, "", 5] },
                   { title: "x".repeat(5000) }]) {
    const r = classifyMove(m || undefined);
    assert.ok(TASK_CLASSES.includes(r.taskClass));
  }
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
