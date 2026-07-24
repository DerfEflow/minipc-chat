/*
 * task-graph spine self-test - run: node idetasks_test.mjs
 * The whole pure spine of Fred's task-roadmap redesign: tolerant parse, the collision map,
 * the run-time scheduler (deps + file collisions), cycle detection, group resolution, and the
 * recursive-reduction verdicts (clean / partial / irreducible).
 */
import assert from "node:assert/strict";
import {
  taskRoadmapMessages, parseTaskRoadmap, collisionPairs, filesCollide, readyTasks, topoOrder,
  resolveTaskAssignments, reduceTaskGoal, classifyReduction,
} from "./idetasks.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };

const ROADMAP = `1. Create the data store
FILES: src/db.js, src/schema.sql
NEEDS: none
2. Build the API
FILES: src/api.js
NEEDS: 1
3. Build the page
FILES: public/index.html, public/app.js
NEEDS: 2`;

t("prompt asks for numbered tasks with FILES and NEEDS, and forbids phases/timelines", () => {
  const m = taskRoadmapMessages({ goal: "a todo app", maxTasks: 8 });
  assert.match(m[0].content, /NUMBERED TASK ROADMAP/);
  assert.match(m[0].content, /No phases\. No timelines/);
  assert.match(m[0].content, /FILES:/);
  assert.match(m[0].content, /NEEDS:/);
  assert.match(m[1].content, /todo app/);
});

t("parse reads numbers, titles, files, and dependencies", () => {
  const r = parseTaskRoadmap(ROADMAP);
  assert.ok(r.ok);
  assert.equal(r.tasks.length, 3);
  assert.equal(r.tasks[0].title, "Create the data store");
  assert.deepEqual(r.tasks[0].files, ["src/db.js", "src/schema.sql"]);
  assert.deepEqual(r.tasks[0].needs, []);
  assert.deepEqual(r.tasks[1].needs, [1]);
  assert.deepEqual(r.tasks[2].needs, [2]);
});

t("parse tolerates markdown emphasis and any casing", () => {
  const r = parseTaskRoadmap("## **1.** Do the thing\n**Files:** a.js\nneeds: none\n2) Next\nFILES : b.js\nNeeds: 1");
  assert.ok(r.ok);
  assert.equal(r.tasks.length, 2);
  assert.equal(r.tasks[0].title, "Do the thing");
  assert.deepEqual(r.tasks[1].needs, [1]);
});

t("parse refuses empty, fileless, traversal, and absolute-path roadmaps", () => {
  assert.equal(parseTaskRoadmap("just prose").ok, false);
  assert.equal(parseTaskRoadmap("1. no files here\nNEEDS: none").ok, false);
  assert.match(parseTaskRoadmap("1. x\nFILES: ../etc/passwd").error, /climbs out/);
  assert.match(parseTaskRoadmap("1. x\nFILES: C:/Windows/x").error, /absolute/);
});

t("parse drops dependencies on phantom (miscounted) task numbers", () => {
  const r = parseTaskRoadmap("1. a\nFILES: a.js\nNEEDS: 9");
  assert.deepEqual(r.tasks[0].needs, [], "a NEEDS on a task that does not exist is dropped, no deadlock");
});

t("collision map finds shared files; independent tasks do not collide", () => {
  const r = parseTaskRoadmap(ROADMAP);
  assert.equal(collisionPairs(r.tasks).length, 0, "this roadmap is file-disjoint");
  const clash = parseTaskRoadmap("1. a\nFILES: shared.js\nNEEDS: none\n2. b\nFILES: shared.js, other.js\nNEEDS: none");
  const pairs = collisionPairs(clash.tasks);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].files, ["shared.js"]);
  assert.ok(filesCollide(clash.tasks[0], clash.tasks[1]));
});

t("scheduler: only tasks whose deps are done and whose files are free may start", () => {
  const r = parseTaskRoadmap(ROADMAP);
  // Nothing done: only task 1 (no deps) is ready.
  let ready = readyTasks(r.tasks, { done: new Set(), running: [] });
  assert.deepEqual(ready.map((t) => t.n), [1]);
  // Task 1 done: task 2 opens.
  ready = readyTasks(r.tasks, { done: new Set([1]), running: [] });
  assert.deepEqual(ready.map((t) => t.n), [2]);
});

t("scheduler withholds a task that would collide with a running one", () => {
  const clash = parseTaskRoadmap("1. a\nFILES: shared.js\nNEEDS: none\n2. b\nFILES: shared.js\nNEEDS: none").tasks;
  // Both are dep-free, but they share shared.js: if 1 is running, 2 must wait.
  const ready = readyTasks(clash, { done: new Set(), running: [1] });
  assert.equal(ready.length, 0, "the colliding task is withheld until the first frees the file");
});

t("two independent dep-free tasks are both ready (real parallelism)", () => {
  const par = parseTaskRoadmap("1. a\nFILES: a.js\nNEEDS: none\n2. b\nFILES: b.js\nNEEDS: none").tasks;
  assert.deepEqual(readyTasks(par, {}).map((t) => t.n), [1, 2]);
});

t("topo order accepts a DAG and names a dependency loop", () => {
  const r = parseTaskRoadmap(ROADMAP);
  assert.ok(topoOrder(r.tasks).ok);
  const loop = [{ n: 1, files: ["a"], needs: [2] }, { n: 2, files: ["b"], needs: [1] }];
  const v = topoOrder(loop);
  assert.equal(v.ok, false);
  assert.match(v.error, /loop/);
});

t("groups resolve to per-task model + agents; ungrouped tasks fall back", () => {
  const r = parseTaskRoadmap(ROADMAP);
  const groups = [{ id: "g1", taskNumbers: [1, 2], model: "x/big", agents: 3 }];
  const a = resolveTaskAssignments(r.tasks, groups, { model: "x/default", agents: 1 });
  assert.equal(a[0].model, "x/big"); assert.equal(a[0].agents, 3);
  assert.equal(a[2].model, "x/default"); assert.equal(a[2].agents, 1, "task 3 is ungrouped");
});

t("reduction: clean when enough disjoint sub-parts, partial when fewer, irreducible when one", () => {
  const three = [{ files: ["a"] }, { files: ["b"] }, { files: ["c"] }];
  assert.equal(classifyReduction({ parts: three, requestedAgents: 3, disjointOk: true }).mode, "clean");
  assert.equal(classifyReduction({ parts: three.slice(0, 2), requestedAgents: 3, disjointOk: true }).mode, "partial");
  const irr = classifyReduction({ parts: [{ files: ["a"] }], requestedAgents: 3, disjointOk: true });
  assert.equal(irr.mode, "irreducible");
  assert.equal(irr.usableAgents, 1);
  assert.match(irr.note, /single agent/i);
  // A non-disjoint split (referee refused) is irreducible even with many parts.
  assert.equal(classifyReduction({ parts: three, requestedAgents: 3, disjointOk: false }).mode, "irreducible");
});

t("reduceTaskGoal names the task and its files and asks for a single part when stuck", () => {
  const g = reduceTaskGoal({ title: "Write the schema", files: ["schema.sql"] }, 3);
  assert.match(g, /at most 3 independent sub-tasks/);
  assert.match(g, /schema.sql/);
  assert.match(g, /return a single part/i);
});

console.log("\nidetasks: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
