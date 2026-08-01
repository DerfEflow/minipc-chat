/*
 * The plan you approved is the plan that runs, and nothing swaps it in silence.
 *
 * Fred, 2026-08-01, holding two screenshots of the same build: "This app build has two different
 * accounts of the tasks. The tasks built by the orchestrator and the AIs I assigned to them, and
 * then while the build happens, half the number of tasks are visible." The 12-task plan carried
 * four different models; the running build showed six steps on one model.
 *
 * Three defects sat behind that, and a fourth was blocking guests entirely:
 *   1. The approved plan is stored per PROJECT, and Begin Building could change the project after
 *      the plan was stored, so the build read an empty one and planned its own.
 *   2. The save was fire-and-forget, so even the right project was a race.
 *   3. When a stored plan could not be read back, the server re-planned without a word.
 *   4. The orchestrator seat inherits the General's model, and an inherited model below the seat's
 *      size floor was REFUSED on every press rather than promoted.
 *
 * These checks pin the fixes at the source, because the failure is invisible at runtime: a build
 * that quietly plans itself looks exactly like a build doing what it was told.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const vibe   = readFileSync(new URL("./public/dominion-vibe.js", import.meta.url), "utf8");
const ide    = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");

/* ---- 1. the guest who could never plan anything ------------------------------------------- */

const tasksHandler = server.slice(server.indexOf("async function handleIdeTasks"), server.indexOf("async function handleIdeReduce"));
assert.ok(tasksHandler.length > 800, "found the /ide/tasks handler");

t("an inherited orchestrator seat is promoted over the floor, never refused", () => {
  assert.match(tasksHandler, /body\.inherited === true/, "the server is told whether the seat was chosen or inherited");
  assert.match(tasksHandler, /if \(!inherited\) \{[\s\S]{0,220}below the size floor/,
    "the by-name refusal is now reachable ONLY for a deliberate pick");
  assert.match(tasksHandler, /promoted = \{/, "an inherited sub-floor model is promoted instead");
});

t("a deliberate sub-floor pick is still refused by name", () => {
  assert.match(tasksHandler, /is below the size floor for the orchestrator slot/,
    "choosing a model on purpose and having it silently swapped would be the lie this avoids");
});

t("the promotion is reported, never silent", () => {
  assert.match(tasksHandler, /fallback, promoted,/, "the response carries it");
  assert.match(vibe, /if \(j\.promoted\)/, "the surface renders it");
  assert.match(vibe, /Your General is unchanged/, "and says the General was not altered");
});

t("the client tells the server which kind of seat it is sending", () => {
  const plan = vibe.slice(vibe.indexOf("async function planArmy"), vibe.indexOf("function renderArmy"));
  assert.match(plan, /const deliberate = \$\("#vb-orch-model"\)\.value/);
  assert.match(plan, /inherited: !deliberate/);
});

t("promotion cannot land on a model with no provider key", () => {
  assert.match(tasksHandler, /ORCHESTRATOR_FALLBACKS\.find\(\(f\) => f !== id && keyForModel\(f\)\)/,
    "a promotion to a keyless model would trade one dead end for another");
});

/* ---- 2. the approved plan must reach the folder the build uses ----------------------------- */

t("the assignment save is targetable and awaitable", () => {
  assert.match(ide, /function saveAssignments\(targetWorkspaceId\)/, "the caller may name the project");
  assert.match(ide, /const wsId = targetWorkspaceId \|\| state\.workspaceId/);
  assert.match(ide, /return done;/, "and can wait for it; fire-and-forget was the race");
  assert.match(ide, /saveAF: \(af, targetWorkspaceId\) =>[\s\S]{0,80}return saveAssignments\(targetWorkspaceId\)/);
});

t("one answer for which workspace a build uses", () => {
  assert.match(ide, /buildWorkspaceId: \(\) =>/, "the plan and the build must not pin to different folders");
  assert.match(ide, /const workspaceId = \$\("#st-ws"\)\.value \|\| state\.workspaceId/,
    "a folder made seconds ago exists in state before the select is repainted");
});

t("Begin Building pins the approved plan to the settled folder and waits", () => {
  const begin = vibe.slice(vibe.indexOf("async function beginBuilding"), vibe.indexOf("function budgetIsCredits"));
  assert.match(begin, /const landed = await persistArmy\(target\)/, "written last, against the settled answer");
  assert.ok(begin.indexOf("persistArmy") > begin.indexOf("autoWorkspace"),
    "it must run AFTER the folder is chosen or created, which is the whole defect");
  assert.ok(begin.indexOf("persistArmy") < begin.indexOf("b.startBuild"),
    "and BEFORE the job starts");
});

t("a plan that fails to save stops the build instead of running a different one", () => {
  const begin = vibe.slice(vibe.indexOf("async function beginBuilding"), vibe.indexOf("function budgetIsCredits"));
  assert.match(begin, /if \(!landed\)/);
  assert.match(begin, /Nothing has run and nothing was charged/,
    "silently building something else is the failure being fixed; refusing out loud is the fix");
});

t("persistArmy returns its promise so callers can wait", () => {
  assert.match(vibe, /function persistArmy\(targetWorkspaceId\)/);
  assert.match(vibe, /return bridge\(\)\.saveAF\(/);
});

/* ---- 3. no silent substitution of a confirmed plan ----------------------------------------- */

const taskGraph = server.slice(server.indexOf("const runTaskGraph = async"), server.indexOf("Task-graph mode (Fred's redesign) wins"));
assert.ok(taskGraph.length > 500, "found runTaskGraph");

t("an unreadable approved plan asks the user rather than re-planning", () => {
  assert.match(taskGraph, /approvedPlanFailed/);
  assert.match(taskGraph, /await ask\("plan-unreadable"/, "the user owns this trade, so the user is asked");
  assert.match(taskGraph, /Stop and let me fix the plan/, "stopping is offered, not just a fresh plan");
  assert.match(taskGraph, /will not keep the models you set per task/,
    "the cost of re-planning is stated before it happens, not discovered afterwards");
});

t("the blueprint carries each task's model from the first paint", () => {
  assert.match(taskGraph, /model: \(assignByN\.get\(t\.n\) \|\| \{\}\)\.model \|\| workerModel/,
    "the two screens must be comparable while there is still time to object");
});

t("a self-planned build says so", () => {
  const std = server.slice(server.indexOf("if (!afRan) {"), server.indexOf("const queue = afRan ? [] : moves"));
  assert.match(std, /selfPlanned: true/);
  assert.match(std, /No approved task plan came with this build/);
  assert.match(std, /Plan the tasks before pressing Begin Building/, "it names the control that prevents a repeat");
});

t("the approved-plan blueprint is marked as approved", () => {
  assert.match(taskGraph, /approved: !!\(af\.taskPlan && af\.taskPlan\.length\)/,
    "so a surface can tell an approved plan from one the builder wrote itself");
});

console.log(`\nplan_fidelity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
