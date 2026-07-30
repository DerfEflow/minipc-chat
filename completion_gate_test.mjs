/*
 * The completion gate's two live failures, kept honest by tests (2026-07-30).
 *
 * 1. WORD SENSE. The gate reads the user's REQUEST, never the incidental spelling of a path. A
 *    repair aimed at "Z:\dominion-livetest\crucible-build" was judged to require a validation
 *    step because the FOLDER NAME contains "build"; a static page has no test to run, so the
 *    demand was unsatisfiable and the turn rejected itself 100+ times over 172 tool calls.
 * 2. FINITENESS. Three identical rejections release the work with the unmet condition NAMED.
 *    A demand nobody can satisfy must end the turn honestly, never spend the budget proving it.
 *
 * These mirror server.mjs's logic exactly; server_test coverage lives in the e2e suites.
 * Run: node completion_gate_test.mjs
 */
import assert from "node:assert/strict";

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); } };

// ---- 1. word sense: the prose-only scrub used by the gate ---------------------------------------
const objectiveProse = (objective) => String(objective)
  .replace(/[a-z]:[\\/][^\s"'`,;]*/gi, " ")
  .replace(/(?:[\w@.-]+[\\/])+[\w@.-]*/g, " ")
  .replace(/\b[\w@-]+\.[a-z0-9]{1,10}\b/gi, " ");
const wantsValidation = (objective) =>
  /\b(?:tests?|testing|typecheck(?:s|ing)?|check(?:s|ing|ed)?|lint(?:s|ing|ed)?|build(?:s|ing)?|verif(?:y|ies|ied|ication)|validate[sd]?|validation)\b/i.test(objectiveProse(objective));

t("a folder named ...-build does not conjure a validation requirement", () => {
  const real = "In the folder Z:\\dominion-livetest\\crucible-build there is a web page that does not work. Fix the script tag in index.html so it points at the real file.";
  assert.equal(wantsValidation(real), false, "the path's spelling must not become a demand");
});

t("paths named check/test/lint are equally inert", () => {
  for (const p of ["C:/work/spec-check/app.js", "Z:\\apps\\lint-tool\\index.html", "/srv/test-bed/site.html"]) {
    assert.equal(wantsValidation("Update the heading in " + p + " and nothing else."), false, p);
  }
});

t("a user who actually asks for verification still gets the requirement", () => {
  // Plurals and -ing forms count: the original list matched "test" but not "tests", so the most
  // natural phrasing of all silently skipped the requirement.
  assert.equal(wantsValidation("Fix the parser and run the tests."), true);
  assert.equal(wantsValidation("Build the app in Z:\\apps\\thing and verify it starts."), true);
  assert.equal(wantsValidation("Add the endpoint, then lint the project."), true);
  assert.equal(wantsValidation("Add the feature and make sure the checks pass."), true);
  assert.equal(wantsValidation("Refactor it, then run testing on the result."), true);
});

t("scrubbing never swallows the whole request", () => {
  const objective = "Fix the script tag in Z:\\dominion-livetest\\crucible-build\\index.html";
  assert.ok(objectiveProse(objective).trim().length > 0, "prose must survive the scrub");
  assert.ok(/fix the script tag/i.test(objectiveProse(objective)));
});

// ---- 1b. path sense: a person's filename vs a machine's absolute path ---------------------------
const normalizeEvidencePath = (v) => String(v || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();
const evidencePathRelated = (a, b) => {
  const left = normalizeEvidencePath(a), right = normalizeEvidencePath(b);
  if (!left || !right || left === "." || right === ".") return false;
  if (left === right || left.startsWith(right + "/") || right.startsWith(left + "/")) return true;
  if (left.endsWith("/" + right) || right.endsWith("/" + left)) return true;
  if (left.includes("/" + right + "/") || right.includes("/" + left + "/")) return true;
  const leftBase = left.split("/").pop(), rightBase = right.split("/").pop();
  return !!leftBase && leftBase === rightBase && /\.[a-z0-9]{1,10}$/.test(leftBase);
};

t("a named file matches the absolute path a tool actually reports", () => {
  // The live rejection: "the cited mutation does not touch any file named in the request", while
  // the edit was on exactly that file. The drive prefix had broken the containment test.
  assert.equal(evidencePathRelated("index.html", "Z:\\dominion-livetest\\crucible-build\\index.html"), true);
  assert.equal(evidencePathRelated("dominion-livetest/crucible-build", "Z:\\dominion-livetest\\crucible-build\\index.html"), true);
  assert.equal(evidencePathRelated("src/app.mjs", "C:/work/proj/src/app.mjs"), true);
});

t("unrelated files and bare folder names never masquerade as the same target", () => {
  assert.equal(evidencePathRelated("index.html", "Z:/other/styles.css"), false);
  assert.equal(evidencePathRelated("src", "C:/elsewhere/src"), true, "a folder still matches by containment");
  assert.equal(evidencePathRelated("app/src", "C:/other/lib/src"), false, "but not two unrelated 'src' folders");
});

// ---- 2. finiteness: the unsatisfiable-demand breaker --------------------------------------------
function runGate(rejections, { limit = 3 } = {}) {
  let repeatedRejections = 0, lastRejectionSig = "", caveats = [], released = false, attempts = 0;
  for (const contradictions of rejections) {
    attempts++;
    const approved = contradictions.length === 0;
    const sig = contradictions.slice().sort().join(" | ");
    if (!approved && sig && sig === lastRejectionSig) repeatedRejections++;
    else repeatedRejections = approved ? 0 : 1;
    lastRejectionSig = approved ? "" : sig;
    if (!approved && repeatedRejections >= limit) { released = true; caveats = contradictions.slice(0, 6); break; }
    if (approved) return { released: false, approved: true, attempts, caveats: [] };
  }
  return { released, approved: released, attempts, caveats };
}

t("three identical rejections release the work with the condition named", () => {
  const same = ["the request requires validation, but no cited evidence id belongs to an observed validation action"];
  const r = runGate([same, same, same, same, same]);
  assert.equal(r.released, true, "an unsatisfiable demand must not loop");
  assert.equal(r.attempts, 3, "it must break at the third identical rejection, not later");
  assert.deepEqual(r.caveats, same, "the unmet condition travels to the user verbatim");
});

t("a worker that fixes its evidence is never released early", () => {
  const a = ["no successful state-changing action is present in Dominion's execution ledger"];
  const b = ["task_complete did not cite any Dominion evidence ids from successful tool results"];
  const r = runGate([a, b, a, []]);
  assert.equal(r.released, false, "changing complaints mean steering is working");
  assert.equal(r.approved, true, "and the honest completion is accepted normally");
});

t("alternating complaints still converge instead of running forever", () => {
  const a = ["A"], b = ["B"];
  const r = runGate([a, b, a, b, a, b, b, b]);
  assert.equal(r.released, true, "a flapping pair must still terminate once one side repeats");
  assert.deepEqual(r.caveats, b);
});

t("contradiction order never changes the signature", () => {
  const r = runGate([["B", "A"], ["A", "B"], ["B", "A"]]);
  assert.equal(r.released, true, "the same set in a different order is the same complaint");
});

console.log("\ncompletion gate: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
