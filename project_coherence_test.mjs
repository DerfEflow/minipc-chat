/*
 * A project is the same project on every device, and Crucible state belongs to the project.
 *
 * Fred, 2026-08-01: "something has changed about the interaction for users between the mobile
 * versions and desktop versions. They do not seem to be loading the others projects. The intent was
 * to have any project seamlessly change from mobile to desktop and desktop to mobile."
 *
 * Three separate defects stacked into that one symptom:
 *   1. Projects live on the server keyed to the account, so the list really was shared, but the
 *      client only fetched it ONCE at page boot. The recurring refresh and the come-back-to-the-app
 *      refresh both asked for jobs alone. A phone resumes from the background without reloading,
 *      so it could sit for days on a stale list.
 *   2. Everything BEHIND a project card (the three planning conversations, the agreed vision, the
 *      decision record) lived in one global localStorage draft: it belonged to a device, and it did
 *      not even switch when you picked a different project on that same device.
 *   3. The switch position and the interface were "any device that has ever chosen wins forever",
 *      so a phone that once opened Beginner could never follow the laptop into Vibe Coder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createIdeStore, MAX_CRUCIBLE_JSON } from "./ide.mjs";
import { isProtectedPath } from "./tools.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ide  = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");
const vibe = readFileSync(new URL("./public/dominion-vibe.js", import.meta.url), "utf8");

/* ---- 1. the list has to travel ------------------------------------------------------------- */

test("coming back to the app re-reads the project list, not only the jobs", () => {
  assert.match(ide, /async function refreshWorkspaces\(\)/);
  assert.match(ide, /window\.addEventListener\("pageshow", \(\) => \{ refreshJobs\(\); refreshWorkspaces\(\); \}\)/,
    "pageshow is the phone case: an installed app resuming without ever reloading");
  assert.match(ide, /visibilitychange", \(\) => \{ if \(!document\.hidden\) \{ refreshJobs\(\); refreshWorkspaces\(\); \}/);
  assert.match(ide, /refreshJobs\(\); refreshWorkspaces\(\); \} \}, 20000\)/, "and the recurring poll");
});

test("the refresh touches the project list and leaves settings alone", () => {
  const fn = ide.slice(ide.indexOf("async function refreshWorkspaces"), ide.indexOf("async function refreshJobs"));
  assert.match(fn, /\/ide\/workspaces/, "the narrow endpoint, not the whole state payload");
  assert.ok(!/state\.prefs|state\.assignments|state\.routing/.test(fn),
    "yanking settings out from under someone mid-edit would be a worse bug than the one being fixed");
  assert.match(fn, /w\.updatedAt/, "a project whose planning state changed elsewhere counts as news");
  assert.match(fn, /state\.workspaceId = ""/, "a project deleted elsewhere cannot stay selected here");
});

/* ---- 2. state belongs to the project, and travels with it ---------------------------------- */

test("a project record carries its Crucible state", () => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-coherence-"));
  try {
    const store = createIdeStore({ dir, isProtectedPath });
    const made = store.create({ name: "Coherence", root: "C:/Projects/coherence" });
    assert.ok(made.ok, made.error);
    const id = made.workspace.id;

    const blob = { chats: { main: { messages: [{ from: "user", content: "build me a thing" }] } }, at: 1000 };
    assert.ok(store.update(id, { crucible: blob }).ok);
    assert.deepEqual(store.get(id).crucible, blob, "it comes back with the project, on any device");
    assert.deepEqual(store.list()[0].crucible, blob, "including in the list the phone fetches");

    // null is a deliberate reset, and must not be confused with "too big to store".
    assert.ok(store.update(id, { crucible: null }).ok);
    assert.equal(store.get(id).crucible, null);

    // Oversize is refused BY NAME. Dropping it silently would erase a planning conversation as a
    // punishment for being long, which is the exact class of bug this whole change is about.
    const huge = { chats: {}, filler: "x".repeat(MAX_CRUCIBLE_JSON + 100) };
    const r = store.update(id, { crucible: huge });
    assert.equal(r.code, "crucible_too_large");
    assert.equal(store.get(id).crucible, null, "and the previous value is left as it was");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the draft is keyed by project, never one global draft", () => {
  assert.match(vibe, /const draftKeyFor = \(wsId\) =>/);
  assert.match(vibe, /localStorage\.setItem\(draftKeyFor\(wsId\), JSON\.stringify\(blob\)\)/);
  assert.ok(!/localStorage\.setItem\(DRAFT_KEY/.test(vibe), "the single global draft is gone");
});

test("picking a project loads that project and saves the one being left", () => {
  const pick = vibe.slice(vibe.indexOf("const pick = () =>"), vibe.indexOf("c.addEventListener(\"click\""));
  assert.match(pick, /saveDraft\(\)/, "switching away must not cost the work in progress");
  assert.match(pick, /loadProject\(ws\.id\)/);
});

test("a new project resets the chats", () => {
  const fn = vibe.slice(vibe.indexOf("function newProject(prefName)"), vibe.indexOf("async function createStagedCloud"));
  assert.match(fn, /saveDraft\(\)/, "the outgoing work is written down first");
  assert.match(fn, /blankState\(\)/);
  assert.match(fn, /removeItem\(draftKeyFor\(""\)\)/, "no stale unattached work follows it in");
});

test("the newer copy wins, in both directions", () => {
  const fn = vibe.slice(vibe.indexOf("function loadProject(wsId)"), vibe.indexOf("function repaintProject"));
  assert.match(fn, /Number\(remote\.at \|\| 0\) > Number\(local\.at \|\| 0\)/,
    "a phone that planned on the train beats a laptop untouched since yesterday, and the reverse");
});

test("work planned before a folder existed moves into the project that adopts it", () => {
  const fn = vibe.slice(vibe.indexOf("function loadProject(wsId)"), vibe.indexOf("function repaintProject"));
  assert.match(fn, /const unattached = readLocal\(""\)/);
  assert.match(fn, /isEmptyState\(pick\) && wsId/, "a project that already has state is never overwritten by it");
});

test("the old global draft is carried over, not discarded, on first load", () => {
  const fn = vibe.slice(vibe.indexOf("function migrateLegacyDraft"), vibe.indexOf("function open()"));
  assert.match(fn, /if \(!isEmptyState\(existing\) \|\| !isEmptyState\(remote\)\) return;/,
    "never overwrite real state with the legacy blob");
  assert.match(fn, /setItem\(draftKeyFor\(wsId\), JSON\.stringify\(legacy\)\)/, "nobody loses a plan to a deploy");
});

test("leaving the page flushes the sync instead of stranding it", () => {
  assert.match(vibe, /pagehide", \(\) => \{ if \(state\.open\) saveDraft\(true\)/);
  assert.match(vibe, /navigator\.sendBeacon\("\/ide\/workspace\/update", body\)/,
    "a normal fetch is not guaranteed to survive the page; a beacon is built for this");
});

test("a failed sync is said once and never costs the local copy", () => {
  const fn = vibe.slice(vibe.indexOf("function syncProject"), vibe.indexOf("function saveDraft"));
  assert.match(fn, /syncWarned/, "a warning on a loop is noise, not honesty");
  assert.match(fn, /crucible_too_large/);
  assert.match(fn, /saved on this device/i);
});

/* ---- 3. the phone stops outvoting the account forever -------------------------------------- */

test("the newer CHOICE wins, rather than any device that ever chose", () => {
  assert.match(ide, /const CHOICE_AT_KEY =/);
  assert.match(ide, /const accountIsNewer = accountChoiceAt > localChoiceAt/);
  assert.match(ide, /\(!deviceHasOpinion \|\| accountIsNewer\)/, "the switch position");
  assert.match(ide, /\(!readMode\(\) \|\| accountIsNewer\)/, "and the interface");
});

test("only a deliberate choice is stamped, never an echo of the account", () => {
  assert.match(ide, /if \(push\) stampChoice\(\)/, "adopting the account's own answer is not a new choice");
  assert.match(ide, /if \(save\) stampChoice\(\)/);
});

/*
 * This one is a ROUND TRIP on purpose. The first version of it asserted that the source contained
 * `s.prefs.at = Date.now()`, which was true and useless: read() rebuilds prefs from a whitelist,
 * so the stamp was written to disk and dropped on the way back, and every caller saw undefined.
 * A source-text assertion cannot catch a value that does not survive being stored.
 */
test("the account records WHEN it changed its mind, and it survives a read", () => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-prefsat-"));
  try {
    const store = createIdeStore({ dir, isProtectedPath });
    assert.equal(store.prefs().at, 0, "never chosen starts at zero, not undefined");

    const after = store.setPrefs({ mode: "vibe", engaged: true });
    assert.ok(after.at > 0, "choosing an interface stamps the account");
    assert.equal(store.prefs().at, after.at, "and the stamp survives being stored and read back");

    // A change that touches neither the switch nor the interface must not pretend to be a choice,
    // or an unrelated save on one device would outvote a real decision made on another.
    const was = store.prefs().at;
    store.setPrefs({ language: "technical" });
    assert.equal(store.prefs().at, was, "language is not a choice about which interface to be in");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
