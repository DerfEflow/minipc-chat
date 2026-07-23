/*
 * AF pipeline self-test. Run with: node ideaf_test.mjs
 * Proves:
 *   1. classification of the four template row texts recognizes dividers, workers, reviewers, qc
 *   2. sanitize clamps task/model length, forces non-worker n to 1, caps rows at 8
 *   3. classifyAfRows errors when divider or worker is missing
 *   4. dividerMessages format round-trips through parseDividerPlan
 *   5. overlap detection catches case-insensitive shared file claims and normalizes slashes
 *   6. path rejection for absolute paths and dot-dot traversal
 *   7. maxParts overflow is an error
 *   8. afAssignFor("") returns null
 */
import assert from "node:assert/strict";
import {
  classifyAfRow,
  sanitizeAfRows,
  classifyAfRows,
  dividerMessages,
  parseDividerPlan,
  verifyDisjoint,
  afAssignFor, orchestratorEligible, adequacyWarning, chunksForPart, customDividerNote,
} from "./ideaf.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ok  " + name);
    })
    .catch((e) => {
      failed++;
      console.error("FAIL  " + name + "\n      " + (e && e.message));
    });
}

await t("divider row is recognized by divide/split/contract keywords", () => {
  assert.equal(classifyAfRow("Divide the work and write the contracts"), "divider");
  assert.equal(classifyAfRow("DIVIDE it"), "divider");
  assert.equal(classifyAfRow("split this into parts"), "divider");
  assert.equal(classifyAfRow("create a contract"), "divider");
});

await t("worker row is the default when no keyword matches", () => {
  assert.equal(classifyAfRow("Build the parts, one agent per part"), "worker");
  assert.equal(classifyAfRow("Write the frontend"), "worker");
  assert.equal(classifyAfRow(""), "worker");
});

await t("reviewer row is recognized by review/fix keywords", () => {
  assert.equal(classifyAfRow("Review and fix each finished part"), "reviewer");
  assert.equal(classifyAfRow("REVIEW the output"), "reviewer");
  assert.equal(classifyAfRow("Fix bugs"), "reviewer");
});

await t("qc row is recognized by check/qc/quality keywords", () => {
  assert.equal(classifyAfRow("Final quality check of the whole"), "qc");
  assert.equal(classifyAfRow("check everything"), "qc");
  assert.equal(classifyAfRow("run QC tests"), "qc");
  assert.equal(classifyAfRow("quality assurance"), "qc");
});

await t("sanitize clamps task to 160 chars and model to 80 chars", () => {
  const row = {
    task: "a".repeat(200),
    model: "b".repeat(100),
    n: 5,
  };
  const san = sanitizeAfRows([row])[0];
  assert.equal(san.task.length, 160);
  assert.equal(san.model.length, 80);
  assert.equal(san.n, 5);
});

await t("sanitize forces non-worker rows to n=1", () => {
  const dividerRow = { task: "divide the work", model: "gpt4", n: 5 };
  const workerRow = { task: "build it", model: "gpt4", n: 3 };
  const reviewerRow = { task: "review and fix", model: "gpt4", n: 7 };
  const qcRow = { task: "final quality check", model: "gpt4", n: 10 };
  const cleaned = sanitizeAfRows([dividerRow, workerRow, reviewerRow, qcRow]);
  assert.equal(cleaned[0].n, 1, "divider forced to 1");
  assert.equal(cleaned[1].n, 3, "worker kept as is");
  assert.equal(cleaned[2].n, 1, "reviewer forced to 1");
  assert.equal(cleaned[3].n, 1, "qc forced to 1");
});

await t("sanitize clamps rows to at most 8", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    task: "task " + i,
    n: 1,
  }));
  const cleaned = sanitizeAfRows(rows);
  assert.equal(cleaned.length, 8);
});

await t("sanitize returns [] for non-array input", () => {
  assert.deepEqual(sanitizeAfRows(null), []);
  assert.deepEqual(sanitizeAfRows("not an array"), []);
  assert.deepEqual(sanitizeAfRows({ task: "oh" }), []);
});

await t("classifyAfRows errors when no divider row", () => {
  const rows = [
    { task: "Build the api", n: 1 },
    { task: "Build the ui", n: 1 },
  ];
  const result = classifyAfRows(rows);
  assert.equal(result.error, "no divider row");
  assert.ok(!result.ok);
});

await t("classifyAfRows errors when no worker row", () => {
  const rows = [
    { task: "Divide the work", n: 1 },
    { task: "Review and fix", n: 1 },
  ];
  const result = classifyAfRows(rows);
  assert.equal(result.error, "no worker row");
});

await t("classifyAfRows picks first of each role and all workers in order", () => {
  const rows = [
    { task: "Divide the work", n: 1 },
    { task: "Build part 1", n: 2 },
    { task: "Build part 2", n: 3 },
    { task: "Review and fix", n: 1 },
    { task: "Final check", n: 1 },
  ];
  const result = classifyAfRows(rows);
  assert.ok(!result.error);
  assert.equal(result.divider.task, "Divide the work");
  assert.equal(result.workers.length, 2);
  assert.equal(result.workers[0].n, 2);
  assert.equal(result.workers[1].n, 3);
  assert.equal(result.reviewer.task, "Review and fix");
  assert.equal(result.qc.task, "Final check");
});

await t("classifyAfRows caps total worker n at 25", () => {
  const rows = [
    { task: "Divide the work", n: 1 },
    { task: "Build 1", n: 15 },
    { task: "Build 2", n: 15 },
  ];
  const result = classifyAfRows(rows);
  assert.equal(result.error, "total worker n exceeds 25");
});

await t("dividerMessages returns a messages array for a divider call", () => {
  const msgs = dividerMessages({ goal: "Build a todo app", maxParts: 5, register: "plain" });
  assert.ok(Array.isArray(msgs));
  assert.equal(msgs.length, 2, "should have system + user when goal provided");
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.ok(msgs[0].content.includes("partition"), "system prompt mentions partition");
  assert.ok(msgs[0].content.includes("PART"), "system prompt mentions PART format");
  assert.ok(msgs[0].content.includes("FILES:"), "system prompt mentions FILES:");
  assert.ok(msgs[0].content.includes("CONTRACT:"), "system prompt mentions CONTRACT:");
});

await t("dividerMessages includes goal as a user turn if provided", () => {
  const msgs = dividerMessages({ goal: "Build a todo app", maxParts: 5, register: "plain" });
  assert.ok(msgs.some((m) => m.role === "user" && m.content.includes("Build a todo app")));
});

await t("dividerMessages omits user turn if goal is empty", () => {
  const msgs = dividerMessages({ maxParts: 5, register: "plain" });
  assert.equal(msgs.filter((m) => m.role === "user").length, 0);
});

await t("parseDividerPlan parses the standard format", () => {
  const text = `PART 1: Backend
FILES: src/api.mjs, src/db.sql
CONTRACT: Provides /data endpoint returning JSON.
PART 2: Frontend
FILES: public/app.js, public/index.html
CONTRACT: Consumes /data and renders a list.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(result.ok);
  assert.equal(result.parts.length, 2);
  assert.equal(result.parts[0].title, "Backend");
  assert.ok(result.parts[0].files.includes("src/api.mjs"));
  assert.ok(result.parts[0].contract.includes("JSON"));
  assert.equal(result.parts[1].title, "Frontend");
});

await t("parseDividerPlan tolerates markdown emphasis and any casing (Kimi #4)", () => {
  // The shapes real models actually emit: bold, headings, lowercase, colon variants.
  const text = "## **Part 1:** Backend\n" +
    "**Files:** src/api.mjs\n" +
    "*Contract:* Provides /data.\n" +
    "part 2 - Frontend\n" +
    "FILES : public/app.js\n" +
    "contract: Renders it.";
  const result = parseDividerPlan(text, 5);
  assert.ok(result.ok, "a stylistic flourish must not yield zero parts");
  assert.equal(result.parts.length, 2);
  assert.equal(result.parts[0].title, "Backend");
  assert.ok(result.parts[0].files.includes("src/api.mjs"));
  assert.ok(result.parts[0].contract.includes("/data"));
  assert.equal(result.parts[1].title, "Frontend");
  assert.ok(result.parts[1].files.includes("public/app.js"));
});

await t("parseDividerPlan normalizes backslashes to forward slashes", () => {
  const text = `PART 1: Code
FILES: src\\api.mjs, src\\db.sql
CONTRACT: API backend.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(result.ok);
  assert.ok(result.parts[0].files.some((f) => f === "src/api.mjs"));
  assert.ok(result.parts[0].files.some((f) => f === "src/db.sql"));
});

await t("parseDividerPlan rejects absolute paths", () => {
  const text = `PART 1: Code
FILES: /root/api.mjs
CONTRACT: API backend.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("absolute"));
});

await t("parseDividerPlan rejects paths with dot-dot", () => {
  const text = `PART 1: Code
FILES: ../secret/api.mjs
CONTRACT: API backend.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("dot-dot"));
});

await t("parseDividerPlan errors if part has no FILES line", () => {
  const text = `PART 1: Code
CONTRACT: API backend.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("FILES"));
});

await t("parseDividerPlan errors if more than maxParts parts", () => {
  const text = `PART 1: A
FILES: a.mjs
CONTRACT: A.
PART 2: B
FILES: b.mjs
CONTRACT: B.
PART 3: C
FILES: c.mjs
CONTRACT: C.`;
  const result = parseDividerPlan(text, 2);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("more than"));
});

await t("parseDividerPlan errors if part has no files", () => {
  const text = `PART 1: Code
FILES:
CONTRACT: API.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(!result.ok);
});

await t("parseDividerPlan errors if part has more than 40 files", () => {
  const fileList = Array.from({ length: 50 }, (_, i) => "file" + i + ".mjs").join(", ");
  const text = `PART 1: Code
FILES: ${fileList}
CONTRACT: API.`;
  const result = parseDividerPlan(text, 5);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("more than 40"));
});

await t("verifyDisjoint finds overlapping file claims", () => {
  const parts = [
    { title: "A", files: ["src/api.mjs", "src/db.sql"] },
    { title: "B", files: ["src/db.sql", "src/ui.js"] },
  ];
  const result = verifyDisjoint(parts);
  assert.ok(!result.ok);
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].file, "src/db.sql");
  assert.equal(result.overlaps[0].a, 1);
  assert.equal(result.overlaps[0].b, 2);
});

await t("verifyDisjoint is case-insensitive", () => {
  const parts = [
    { title: "A", files: ["src/API.mjs"] },
    { title: "B", files: ["src/api.mjs"] },
  ];
  const result = verifyDisjoint(parts);
  assert.ok(!result.ok);
  assert.equal(result.overlaps.length, 1);
});

await t("verifyDisjoint normalizes backslashes", () => {
  const parts = [
    { title: "A", files: ["src\\api.mjs"] },
    { title: "B", files: ["src/api.mjs"] },
  ];
  const result = verifyDisjoint(parts);
  assert.ok(!result.ok);
  assert.equal(result.overlaps.length, 1);
});

await t("verifyDisjoint reports every pair when three parts claim one file", () => {
  const parts = [
    { title: "A", files: ["src/shared.mjs"] },
    { title: "B", files: ["src/shared.mjs"] },
    { title: "C", files: ["src/shared.mjs"] },
  ];
  const result = verifyDisjoint(parts);
  assert.ok(!result.ok);
  assert.equal(result.overlaps.length, 3);
  const pairs = result.overlaps.map((o) => o.a + "-" + o.b).sort();
  assert.deepEqual(pairs, ["1-2", "1-3", "2-3"]);
});

await t("verifyDisjoint passes when files are disjoint", () => {
  const parts = [
    { title: "A", files: ["src/api.mjs", "src/db.sql"] },
    { title: "B", files: ["public/index.html", "public/app.js"] },
  ];
  const result = verifyDisjoint(parts);
  assert.ok(result.ok);
  assert.equal(result.overlaps.length, 0);
});

await t("afAssignFor returns null when modelId is empty string", () => {
  assert.equal(afAssignFor(""), null);
  assert.equal(afAssignFor(null), null);
  assert.equal(afAssignFor(undefined), null);
});

await t("afAssignFor returns assignments object with modelId for all classes", () => {
  const assign = afAssignFor("gpt-4");
  assert.ok(assign);
  assert.equal(assign.design_visual, "gpt-4");
  assert.equal(assign.design_code, "gpt-4");
  assert.equal(assign.build_code, "gpt-4");
  assert.equal(assign.mechanical, "gpt-4");
  assert.equal(assign.review, "gpt-4");
  assert.equal(assign.allInOne, "gpt-4");
});

/* ---- AF Full Custom rules (Phase 2) ------------------------------------------------------ */
await t("orchestrator floor: a real model qualifies, a tiny one does not", () => {
  assert.equal(orchestratorEligible({ paramsB: 400, ctx: 200000, outCost: 15 }), true);
  assert.equal(orchestratorEligible({ paramsB: 3, ctx: 8000, outCost: 0.1 }), false, "tiny local model cannot lead");
  assert.equal(orchestratorEligible({ paramsB: 4, ctx: 130000, outCost: 0.3 }), true, "small params but big context clears");
  assert.equal(orchestratorEligible(null), false);
});

await t("adequacy never blocks but warns RED when a part overflows the context", () => {
  const small = { id: "x/small", name: "Small", ctx: 8000, outCost: 1 };
  const w = adequacyWarning({ rec: small, role: "worker", partTokens: 6000, agents: 1 });
  assert.equal(w.level, "red");
  assert.match(w.text, /truncated|holds only/i);
  assert.match(w.text, /yours to try/i, "the warning invites experimentation, never forbids");
  const big = { id: "x/big", name: "Big", ctx: 1000000, outCost: 15 };
  assert.equal(adequacyWarning({ rec: big, role: "worker", partTokens: 6000 }), null, "roomy model, no warning");
});

await t("adequacy flags a too-small orchestrator specifically", () => {
  const tiny = { id: "x/tiny", name: "Tiny", ctx: 8000, paramsB: 3, outCost: 0.1 };
  const w = adequacyWarning({ rec: tiny, role: "orchestrator", partTokens: 100 });
  assert.equal(w.level, "red");
  assert.match(w.text, /divide a build/i);
});

await t("chunksForPart respects both agent count and context ceiling", () => {
  const big = { ctx: 1000000 };
  assert.equal(chunksForPart({ rec: big, partTokens: 2000, agents: 3 }), 3, "agents drive when context is roomy");
  const small = { ctx: 8000 };
  assert.ok(chunksForPart({ rec: small, partTokens: 40000, agents: 1 }) > 1, "context forces more chunks");
});

await t("customDividerNote names each part's model and context, or is empty", () => {
  assert.equal(customDividerNote([]), "");
  const note = customDividerNote([{ title: "Backend", model: "x/big", modelName: "Big", ctx: 200000, agents: 2 }]);
  assert.match(note, /Backend/);
  assert.match(note, /Big/);
  assert.match(note, /200,000/);
});

console.log("\nideaf: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
