/*
 * A verdict belongs to the project it happened in. Run: node buildbanner_test.mjs
 *
 * Fred, 2026-08-01, testing beside a guest: "both of us noticed a warning at the bottom of the
 * page before we even split the project into tasks: Build failed before completion. The work so
 * far is saved. Scroll up to the run for the reason."
 *
 * There was no run to scroll up to. /ide/jobs is per ACCOUNT, which is right — a build keeps going
 * while you look elsewhere and the rail is meant to say so — but refreshJobs painted the status
 * line and the journey phase from state.jobs[0], the newest job anywhere in the account, of any
 * age. So a brand-new project inherited the last failure of a different project, and the surface
 * that had just learned to repeat that verdict under the BEGIN BUILDING button repeated it there
 * too, with directions to a run that was never on the page.
 *
 * The rail still shows the whole account. The verdict is scoped, and an outcome is only announced
 * as news when it happened while the page was watching.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ide = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");
const vibe = readFileSync(new URL("./public/dominion-vibe.js", import.meta.url), "utf8");

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
};

const refreshJobs = ide.slice(ide.indexOf("async function refreshJobs()"), ide.indexOf("function renderAsk()"));

/* ---- the scoping, executed rather than merely read ----------------------------------------- */

// Lifted verbatim from dominion-ide.js so the test moves when the code does.
function functionAt(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, "cannot find " + header);
  // The body brace is the first "{" outside the parameter list, so a destructured default like
  // `{ announce = true } = {}` does not get mistaken for the start of the function.
  let paren = 0, depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{" && (paren === 0 || depth > 0)) depth++;
    else if (c === "}" && depth > 0) { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  throw new Error("unbalanced braces after " + header);
}
const jobsHereSrc = functionAt(ide, "function jobsHere() {");
const jobsHere = new Function("state", "selectedWorkspaceId", jobsHereSrc + "\nreturn jobsHere();");

const JOBS = [
  { id: "j3", workspaceId: "ws-bill", done: false, outcome: "" },
  { id: "j2", workspaceId: "ws-other", done: true, outcome: "error" },
  { id: "j1", workspaceId: "ws-bill", done: true, outcome: "done" },
];

t("a job from another project is not this project's news", () => {
  const here = jobsHere({ jobs: JOBS }, () => "ws-bill");
  assert.deepEqual(here.map((j) => j.id), ["j3", "j1"]);
  assert.ok(!here.some((j) => j.workspaceId === "ws-other"), "the other project's failure stays out");
});

t("a brand-new project with no build of its own reports nothing at all", () => {
  const failedElsewhere = [{ id: "old", workspaceId: "ws-calorie", done: true, outcome: "error" }];
  assert.deepEqual(jobsHere({ jobs: failedElsewhere }, () => "ws-bill"), [],
    "this is the exact case Fred and the guest hit: a fresh project inheriting a stranger's verdict");
});

t("no project selected means no verdict, rather than the newest one anywhere", () => {
  assert.deepEqual(jobsHere({ jobs: JOBS }, () => ""), []);
});

t("a job carrying no project is never adopted by the project on screen", () => {
  assert.deepEqual(jobsHere({ jobs: [{ id: "x", done: true, outcome: "error" }] }, () => "ws-bill"), []);
});

t("junk in the list does not throw on a page that polls every twenty seconds", () => {
  assert.deepEqual(jobsHere({ jobs: [null, undefined, { id: "ok", workspaceId: "ws-bill" }] }, () => "ws-bill").map((j) => j.id), ["ok"]);
  assert.deepEqual(jobsHere({}, () => "ws-bill"), []);
});

/* ---- news versus history -------------------------------------------------------------------- */

t("an outcome is announced only when it changed under this page's eyes", () => {
  const seen = new Map();
  const announceFor = (id, kind) => {
    const news = seen.has(id) && seen.get(id) !== kind;
    seen.set(id, kind);
    return news;
  };
  assert.equal(announceFor("j9", "failed"), false, "already over when the page loaded: history, not news");
  assert.equal(announceFor("j9", "failed"), false, "and polling it again does not make it news");

  const seen2 = new Map();
  const announce2 = (id, kind) => { const n = seen2.has(id) && seen2.get(id) !== kind; seen2.set(id, kind); return n; };
  assert.equal(announce2("j10", "running"), false, "a build starting is not an outcome");
  assert.equal(announce2("j10", "failed"), true, "a build ending while you watch IS the news");
  assert.equal(announce2("j10", "failed"), false, "and it is announced once, not every twenty seconds");
});

t("refreshJobs uses the scoped list and the seen-map, not state.jobs[0]", () => {
  assert.ok(!/state\.jobs\[0\]/.test(refreshJobs), "the account-wide newest job must not drive this project's line");
  assert.match(refreshJobs, /const mine = jobsHere\(\);/);
  assert.match(refreshJobs, /jobSeen\.has\(latest\.id\) && jobSeen\.get\(latest\.id\) !== kind/);
  assert.match(refreshJobs, /if \(!latest\) \{ clearBuildStatus\(\); return; \}/,
    "no build here means the line is cleared, not left showing the last project's");
});

t("the rail still watches the whole account, because a build elsewhere is still running", () => {
  assert.match(refreshJobs, /paintRail\(\);/);
  const rail = ide.slice(ide.indexOf("function paintRail()"), ide.indexOf("function paintRail()") + 400);
  assert.match(rail, /\(state\.jobs \|\| \[\]\)\.filter\(\(j\) => !j\.done\)/,
    "scoping the rail too would hide a live build from the person who started it");
});

/* ---- the surface that repeats the verdict --------------------------------------------------- */

t("paintBuildStatus can paint without announcing", () => {
  const fn = functionAt(ide, "function paintBuildStatus(");
  assert.match(fn, /\{ announce = true \} = \{\}/, "announcing stays the default, so every existing caller is unchanged");
  assert.match(fn, /if \(!announce\) return;/);
  assert.ok(fn.indexOf("if (!announce) return;") < fn.indexOf("dominion-ide-build-outcome"),
    "the early return has to sit above the broadcast to suppress anything");
});

t("clearing takes down a build verdict and leaves other messages alone", () => {
  assert.match(ide, /function clearBuildStatus\(\)/);
  assert.match(ide, /detail: \{ kind: "", message: "", error: false, clear: true \}/);
  const listener = vibe.slice(vibe.indexOf('document.addEventListener("dominion-ide-build-outcome"'), vibe.indexOf("window.dominionVibe"));
  assert.match(listener, /if \(d\.clear\) \{/);
  assert.match(listener, /if \(statusFromBuild\) \{ status\(""\); statusFromBuild = false; \}/,
    '"Updated from your other device." must survive a project switch');
  assert.ok(listener.indexOf("statusFromBuild = true;") < listener.indexOf("Scroll up to the run"),
    "the flag is set on the same path that writes the verdict");
});

console.log("\nbuildbanner: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
