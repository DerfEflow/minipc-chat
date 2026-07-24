/*
 * Dominion Works - the task-graph build spine (Fred's redesign 2026-07-23).
 *
 * The build is a NUMBERED TASK ROADMAP, not a set of file-ownership parts. No phases, no
 * timelines: just tasks in order, each declaring the files it touches and which earlier tasks it
 * needs. File ownership is demoted to a COLLISION MAP (two tasks that touch the same file may not
 * run at the same time) and a compile guide, rather than the primary decomposition.
 *
 * Why: a task is naturally small, so it chunks to any model's context window for free; the shape
 * is identical to the long-run harness (numbered units + ledger), so the two unify; and agent
 * count becomes real, meaning "run independent tasks at once" plus recursive division of one task.
 *
 * One mechanism at every level: divide, referee (the cookie rule: no two concurrent units share a
 * file), run. Applied to the whole goal it makes the roadmap; applied to a single task it answers
 * "can three agents split task 6, or is it irreducible?".
 *
 * Pure module: no http, no fs, no model. The caller runs the model; this parses, schedules, and
 * decides. Tests with plain data.
 */
import { normalizeRegister, plannerVoice } from "./idelang.mjs";

const norm = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/* ---- the orchestrator prompt: a numbered roadmap, no phases, no timelines ------------------- */
export function taskRoadmapMessages({ goal = "", maxTasks = 12, register = "plain", persona = "" } = {}) {
  const r = normalizeRegister(register);
  const system = [
    "You are the orchestrator. Turn one build goal into a NUMBERED TASK ROADMAP: the ordered list",
    "of concrete tasks that build the whole thing. No phases. No timelines. No estimates. Just tasks.",
    "",
    "Reply in EXACTLY this format, nothing else. For each task:",
    "  <n>. <a short imperative title>",
    "  FILES: <comma-separated relative paths this task creates or edits>",
    "  NEEDS: <comma-separated numbers of tasks that must finish first, or 'none'>",
    "",
    "Example:",
    "1. Create the data store",
    "FILES: src/db.js, src/schema.sql",
    "NEEDS: none",
    "2. Build the API over the store",
    "FILES: src/api.js",
    "NEEDS: 1",
    "3. Build the page that shows the data",
    "FILES: public/index.html, public/app.js",
    "NEEDS: 2",
    "",
    "RULES:",
    "1. Every task names the exact files it touches. Keep each task small: one coherent piece of work.",
    "2. If two tasks can be done at the same time, give them no dependency on each other and do not",
    "   let them share a file. Tasks that must be sequential list the earlier one in NEEDS.",
    "3. At most " + maxTasks + " tasks. Prefer more small tasks over few large ones: small tasks fit",
    "   any model and can run in parallel.",
    "4. A file should be owned by ONE task where possible; if two tasks truly must edit the same file,",
    "   make one NEED the other so they never run at the same time.",
    "",
    "VOICE: " + plannerVoice(r),
    ...(persona ? ["", persona] : []),
  ].join("\n");
  const msgs = [{ role: "system", content: system }];
  if (goal) msgs.push({ role: "user", content: "Goal: " + goal });
  return msgs;
}

/* ---- parse the roadmap (tolerant: markdown emphasis, any casing) ---------------------------- */
export function parseTaskRoadmap(text, maxTasks = 12) {
  const clean = (line) => String(line).replace(/^[\s>#*_]+/, "").replace(/\*+\s*$/, "").trimEnd();
  const lines = String(text == null ? "" : text).split(/\r?\n/).map(clean);
  const tasks = [];
  let cur = null;
  const pushCur = () => { if (cur) { tasks.push(cur); cur = null; } };
  for (const line of lines) {
    const head = line.match(/^\**\s*(\d+)[.)]\s*(.+?)\s*\**$/);
    if (head) {
      pushCur();
      cur = { n: parseInt(head[1], 10), title: head[2].replace(/^[\s*_]+/, "").replace(/[\s*_]+$/, "").trim(), files: [], needs: [] };
      continue;
    }
    if (!cur) continue;
    const files = line.match(/^\**\s*FILES\s*:\**\s*(.*)$/i);
    if (files) {
      cur.files = files[1].split(",").map((f) => f.trim().replace(/\\/g, "/").replace(/^["']|["']$/g, "")).filter(Boolean);
      continue;
    }
    const needs = line.match(/^\**\s*NEEDS\s*:\**\s*(.*)$/i);
    if (needs) {
      const body = needs[1].trim();
      if (!/^none\b/i.test(body)) cur.needs = (body.match(/\d+/g) || []).map((x) => parseInt(x, 10));
      continue;
    }
  }
  pushCur();
  if (!tasks.length) return { ok: false, tasks: [], error: "no tasks found" };
  if (tasks.length > maxTasks) return { ok: false, tasks: [], error: "more than " + maxTasks + " tasks" };
  // Refuse tasks with no files (nothing to own) and unsafe paths, honestly.
  for (const t of tasks) {
    if (!t.files.length) return { ok: false, tasks: [], error: "task " + t.n + " names no files" };
    for (const f of t.files) {
      if (f.includes("..")) return { ok: false, tasks: [], error: "task " + t.n + " climbs out of the workspace (" + f + ")" };
      if (/^[a-zA-Z]:[\\/]/.test(f) || f.startsWith("/")) return { ok: false, tasks: [], error: "task " + t.n + " uses an absolute path (" + f + ")" };
    }
  }
  // Drop dependency numbers that point at tasks that do not exist (a model miscount), so the
  // scheduler never deadlocks waiting on a phantom.
  const present = new Set(tasks.map((t) => t.n));
  for (const t of tasks) t.needs = t.needs.filter((n) => present.has(n) && n !== t.n);
  return { ok: true, tasks };
}

/* ---- the collision map: which task pairs share a file (may not run together) ---------------- */
export function collisionPairs(tasks) {
  const pairs = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = new Set((tasks[i].files || []).map(norm));
      const shared = (tasks[j].files || []).map(norm).filter((f) => a.has(f));
      if (shared.length) pairs.push({ a: tasks[i].n, b: tasks[j].n, files: shared });
    }
  }
  return pairs;
}
export function filesCollide(t1, t2) {
  const a = new Set((t1.files || []).map(norm));
  return (t2.files || []).some((f) => a.has(norm(f)));
}

/* ---- the scheduler: which tasks may start RIGHT NOW ----------------------------------------
 * A task is ready when every task it needs is done, it is not already done or running, and it
 * shares no file with any task currently running (the cookie rule at run time). Returns the
 * runnable set; the runner picks up to its concurrency budget from it.
 */
export function readyTasks(tasks, { done = new Set(), running = [] } = {}) {
  const byN = new Map(tasks.map((t) => [t.n, t]));
  const runningTasks = running.map((n) => byN.get(n)).filter(Boolean);
  return tasks.filter((t) => {
    if (done.has(t.n) || running.includes(t.n)) return false;
    if (!t.needs.every((n) => done.has(n))) return false;
    if (runningTasks.some((rt) => filesCollide(t, rt))) return false;
    return true;
  });
}

// A roadmap is schedulable only if it can actually finish: no dependency cycle. Returns
// { ok, order } (a valid completion order) or { ok:false, error } naming the stuck tasks.
export function topoOrder(tasks) {
  const byN = new Map(tasks.map((t) => [t.n, t]));
  const done = new Set(), order = [];
  let progressed = true;
  while (order.length < tasks.length && progressed) {
    progressed = false;
    for (const t of tasks) {
      if (done.has(t.n)) continue;
      if (t.needs.every((n) => done.has(n) || !byN.has(n))) { done.add(t.n); order.push(t.n); progressed = true; }
    }
  }
  if (order.length < tasks.length) {
    const stuck = tasks.filter((t) => !done.has(t.n)).map((t) => t.n);
    return { ok: false, error: "these tasks depend on each other in a loop: " + stuck.join(", ") };
  }
  return { ok: true, order };
}

/* ---- grouping: resolve each task's model + agent count from the user's groups --------------
 * groups: [{ taskNumbers: [n...], model, agents }]. A task in no group falls back to the default.
 * Later groups win a conflict (a task listed twice), so the UI's last assignment sticks.
 */
export function resolveTaskAssignments(tasks, groups = [], fallback = { model: "", agents: 1 }) {
  const map = new Map();
  for (const g of groups || []) {
    for (const n of g.taskNumbers || []) {
      map.set(n, { model: g.model || fallback.model, agents: Math.max(1, Math.trunc(Number(g.agents) || 1)), group: g.id || null });
    }
  }
  return tasks.map((t) => ({ n: t.n, ...(map.get(t.n) || { model: fallback.model, agents: 1, group: null }) }));
}

/* ---- recursive reduction: "put N agents on task 6" ----------------------------------------
 * The caller runs the divider on ONE task with this goal, then hands the parsed sub-parts and the
 * referee's disjointness verdict to classifyReduction. Nothing here calls a model.
 */
export function reduceTaskGoal(task, agents) {
  return "Split THIS ONE TASK into at most " + agents + " independent sub-tasks that together finish it, " +
    "each owning DIFFERENT files (no two sub-tasks share a file). Task: " + (task.title || "") +
    ". The task's files: " + (task.files || []).join(", ") +
    ". If the task cannot be cleanly split because its files are too interdependent, return a single part.";
}

/*
 * Decide what a reduction attempt means:
 *   clean       - got as many disjoint sub-parts as agents requested; use them all.
 *   partial     - got 2..(agents-1) disjoint sub-parts; use that many agents, tell the user.
 *   irreducible - got one part, or no disjoint split; one agent must do the whole task.
 * disjointOk is the referee's verdict on the returned parts (from verifyDisjoint).
 */
export function classifyReduction({ parts = [], requestedAgents = 1, disjointOk = true } = {}) {
  const n = parts.length;
  if (n <= 1 || !disjointOk) {
    return { mode: "irreducible", usableAgents: 1, parts: [], note: "This task is one tight piece of work; a single agent will do it cleanly." };
  }
  if (n >= requestedAgents) {
    return { mode: "clean", usableAgents: requestedAgents, parts: parts.slice(0, requestedAgents), note: "" };
  }
  return { mode: "partial", usableAgents: n, parts, note: "This task split cleanly into " + n + " pieces, so " + n + " agents will work it (you asked for " + requestedAgents + ")." };
}
