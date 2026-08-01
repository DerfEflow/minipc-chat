/*
 * A project's folder has to EXIST before anything is asked to look inside it.
 *
 * Fred, 2026-08-01: he made a project, chose drive F, planned it, assigned models, pressed BEGIN
 * BUILDING, and nothing appeared to happen. Twice. Scrolling up showed
 * "hands fs_list failed: ENOENT: no such file or directory, scandir 'F:\Calorie Count Test'", and
 * the top of the page said the build had failed and stopped early.
 *
 * A workspace is a POINTER to a folder on the user's own machine, which is the design and is
 * correct. What was wrong is that ONE of the two doors that create a pointer also created the
 * folder. /ide/workspace/auto did. /ide/workspace, the one behind "Choose a folder on this
 * computer", did not, so choosing where your app lives produced a project aimed at nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const engine = readFileSync(new URL("./ideengine.mjs", import.meta.url), "utf8");
const vibe   = readFileSync(new URL("./public/dominion-vibe.js", import.meta.url), "utf8");
const ide    = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");

const route = server.slice(server.indexOf('path === "/ide/workspace") {'), server.indexOf('path === "/ide/workspace/auto"'));
assert.ok(route.length > 400, "found the workspace-create route");

test("choosing a folder creates it, rather than registering a pointer to nothing", () => {
  assert.match(route, /fs_mkdir/, "the cloud workshop has fs_mkdir and no shell");
  assert.match(route, /New-Item -ItemType Directory -Force/, "the installed hands node has a shell and no fs_mkdir");
  assert.ok(route.indexOf("fs_mkdir") < route.indexOf("New-Item"),
    "try the structured op first; the shell is the fallback, not the default");
});

test("a folder that cannot be created is refused out loud, and nothing is saved", () => {
  assert.match(route, /That folder could not be created on your computer/);
  assert.match(route, /Nothing was saved/, "a dangling project is worse than no project");
});

test("adopting an existing folder never creates one", () => {
  assert.match(route, /body\.existing !== true/,
    "a typo must not conjure an empty folder and then be reported back as an adopted app");
  assert.match(vibe, /node: onMachine, existing: true/, "the adopt door says which case it is");
});

test("the build makes the folder too, so projects created before this still work", () => {
  assert.match(engine, /async function ensureRoot\(root\)/);
  const snap = engine.slice(engine.indexOf("async function snapshot(job, workspace)"), engine.indexOf("async function verify"));
  assert.match(snap, /const made = await ensureRoot\(root\)/);
  assert.ok(snap.indexOf("ensureRoot") < snap.indexOf("git -C"),
    "the folder must exist before anything asks git or the shell what is in it");
  assert.match(snap, /The project folder could not be created/, "and the failure says which step failed");
});

test("ensureRoot tries both kinds of machine", () => {
  const fn = engine.slice(engine.indexOf("async function ensureRoot"), engine.indexOf("async function snapshot"));
  assert.match(fn, /hands\("fs_mkdir"/);
  assert.match(fn, /hands\("shell_run"/);
  assert.match(fn, /replace\(\/'\/g, "''"\)/, "a folder name may legitimately contain an apostrophe");
});

/* ---- the verdict has to reach the control that caused it ---------------------------------- */

test("a build outcome is announced, not only painted at the top of the page", () => {
  assert.match(ide, /dominion-ide-build-outcome/, "the surface that owns the button decides where it goes");
  assert.match(vibe, /document\.addEventListener\("dominion-ide-build-outcome"/);
  // To the end of the listener rather than a fixed window: it grew a clear-on-project-switch
  // branch (see buildbanner_test.mjs), and a character count is not what this test is about.
  const listener = vibe.slice(vibe.indexOf('addEventListener("dominion-ide-build-outcome"'), vibe.indexOf("window.dominionVibe"));
  assert.match(listener, /status\(/, "said directly under BEGIN BUILDING, where the finger just was");
});
