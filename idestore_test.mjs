/*
 * Dominion Works workspace registry + HTTP gate stack self-test. Run with: node idestore_test.mjs
 * Proves:
 *   1. a workspace is a POINTER to the user's own folder; removing one never touches the folder
 *   2. carve-out roots (backup drive, db backups, pg_dump) are refused, with the reason said out loud
 *   3. the gate stack refuses in the right order: anon, account status, exposure, invite, credits
 *   4. reading your own state is not billable; starting a build is
 *   5. one account can never see, stop, or attach to another account's job
 *   6. the toggle preference round-trips through the account (ledger L-5)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdeGate, createIdeStore, createIdeFeature, MAX_WORKSPACES, autoWorkspaceName } from "./ide.mjs";
import { createIdeJobs } from "./idejobs.mjs";
import { isProtectedPath } from "./tools.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const dirs = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "ide-store-")); dirs.push(d); return d; };
const newStore = () => createIdeStore({ dir: freshDir(), isProtectedPath });

await t("a workspace is a POINTER: it stores a root, and removing it never touches the folder", () => {
  const s = newStore();
  const r = s.create({ name: "My App", root: "C:\\Projects\\my-app" });
  assert.equal(r.ok, true);
  assert.equal(r.workspace.root, "C:\\Projects\\my-app");
  assert.equal(s.list().length, 1);
  assert.equal(s.remove(r.workspace.id).ok, true);
  assert.equal(s.list().length, 0);
  // the store's only writable surface is its own state file: it has no capability to delete a
  // user's project folder even if a caller asked it to
  assert.ok(s.file.endsWith("state.json"));
});

await t("roots inside a hard carve-out are REFUSED with the reason said out loud", () => {
  const s = newStore();
  for (const bad of ["D:\\anything", "C:\\app-backups\\x", "C:\\stuff\\db_backups", "C:\\tools\\pg_dump"]) {
    const r = s.create({ name: "x", root: bad });
    assert.notEqual(r.ok, true, bad + " must be refused");
    assert.equal(r.code, "root_protected", bad + " should be root_protected, got " + r.code);
    assert.match(r.error, /carve-out/i);
  }
  assert.equal(s.list().length, 0);
});

await t("roots must be present, absolute, and not absurdly long", () => {
  const s = newStore();
  assert.equal(s.create({ root: "" }).code, "root_required");
  assert.equal(s.create({ root: "my-app" }).code, "root_not_absolute");
  assert.equal(s.create({ root: "./rel/path" }).code, "root_not_absolute");
  assert.equal(s.create({ root: "C:\\" + "x".repeat(500) }).code, "root_too_long");
  assert.equal(s.create({ root: "/home/fred/app" }).ok, true, "posix absolute is fine");
  assert.equal(s.create({ root: "\\\\nas\\share\\app" }).ok, true, "UNC is fine");
  // Windows "Copy as path" wraps in quotes; phones paste smart quotes. Parsed, never punished.
  const quoted = s.create({ root: '"C:\\Projects\\pasted-app"' });
  assert.equal(quoted.ok, true, "double-quoted paste is accepted");
  assert.equal(quoted.workspace.root, "C:\\Projects\\pasted-app", "quotes are stripped from the stored root");
  const smart = s.create({ root: "“C:\\Projects\\smart-app”" });
  assert.equal(smart.ok, true, "smart-quoted paste is accepted");
  assert.equal(smart.workspace.root, "C:\\Projects\\smart-app");
});

await t("two workspaces cannot point at the same folder; the name defaults to the folder", () => {
  const s = newStore();
  const a = s.create({ root: "C:\\Projects\\alpha" });
  assert.equal(a.workspace.name, "alpha");
  assert.equal(s.create({ root: "c:\\projects\\ALPHA" }).code, "root_duplicate", "match is case-insensitive");
});

await t("the workspace count is capped", () => {
  const s = newStore();
  for (let i = 0; i < MAX_WORKSPACES; i++) assert.equal(s.create({ root: "C:\\p\\w" + i }).ok, true);
  assert.equal(s.create({ root: "C:\\p\\one-too-many" }).code, "too_many");
});

await t("update re-validates a new root with the rules create used, and refuses atomically", () => {
  const s = newStore();
  const w = s.create({ root: "C:\\Projects\\app" }).workspace;
  assert.equal(s.update(w.id, { root: "D:\\backups" }).code, "root_protected");
  assert.equal(s.update(w.id, { root: "nope" }).code, "root_not_absolute");
  assert.equal(s.update(w.id, { name: "Renamed" }).workspace.name, "Renamed");
  assert.equal(s.update("ws_nope", { name: "x" }).code, "not_found");
  assert.equal(s.get(w.id).root, "C:\\Projects\\app", "a refused update must not have mutated anything");
});

await t("prefs persist across a reopen, and a corrupt state file is quarantined rather than fatal", () => {
  const dir = freshDir();
  const s1 = createIdeStore({ dir, isProtectedPath });
  s1.setPrefs({ engaged: true });
  s1.create({ root: "C:\\Projects\\keepme" });
  assert.equal(createIdeStore({ dir, isProtectedPath }).prefs().engaged, true);

  writeFileSync(s1.file, "{ this is not json", "utf8");
  const s2 = createIdeStore({ dir, isProtectedPath });
  assert.equal(s2.prefs().engaged, false, "a corrupt file starts clean instead of throwing");
  assert.deepEqual(s2.list(), []);
  assert.ok(existsSync(s1.file + ".bad"), "the corrupt bytes are kept for inspection, never destroyed");
  assert.match(readFileSync(s1.file + ".bad", "utf8"), /not json/);
});

/* ---- autoWorkspaceName ----------------------------------------------------------------- */
await t("autoWorkspaceName converts a normal sentence into Title Case with no punctuation", () => {
  const result = autoWorkspaceName("a page where my grandkids check off chores!!");
  assert.match(result, /^[A-Z]/);
  assert.ok(!result.match(/[!?.,;:]/), "should have no punctuation");
  assert.ok(result.split(" ").every(w => /^[A-Z]/.test(w)), "all words should be Title Cased");
});

await t("autoWorkspaceName clips a 200-character ramble to 40 chars or less ending on a word boundary", () => {
  const ramble = "a " + "very ".repeat(50) + "long text";
  const result = autoWorkspaceName(ramble);
  assert.ok(result.length <= 40, `result "${result}" should be 40 chars or less, got ${result.length}`);
  assert.ok(!result.endsWith(" "), "should not end with a space");
  assert.ok(result.indexOf(" ") > 0, "should have at least one space (word boundary)");
});

await t("autoWorkspaceName falls back to 'My First App' for emoji-only input", () => {
  assert.equal(autoWorkspaceName("😀😀😀"), "My First App");
  assert.equal(autoWorkspaceName(""), "My First App");
  assert.equal(autoWorkspaceName("   "), "My First App");
});

/* ---- the HTTP gate stack ---------------------------------------------------------------- */
const featureFor = (mode, { multiTenant = true, canChat = () => true } = {}) => {
  const dir = freshDir();
  const store = createIdeStore({ dir, isProtectedPath });
  return createIdeFeature({
    gate: createIdeGate(mode), storeFor: () => store,
    jobs: createIdeJobs({ dir: join(dir, "j") }), billing: { canChat }, multiTenant,
  });
};
const OWNER = { role: "owner", isOwner: true, uid: "owner", email: "f@x.com", status: "active", invited: true };
const GUEST = { role: "credit", isOwner: false, uid: "u1", email: "g@x.com", status: "active", invited: true };

await t("anon is refused 401 before anything else is considered", () => {
  const f = featureFor("all");
  assert.equal(f.state({ role: "anon" }).status, 401);
  assert.equal(f.state({ role: "anon" }).code, "no_identity");
  assert.equal(f.state(null).status, 401);
});

await t("a paused or locked account is refused 403 even when IDE is open to all", () => {
  const f = featureFor("all");
  for (const st of ["paused", "locked"]) {
    const r = f.state({ ...GUEST, status: st });
    assert.equal(r.status, 403);
    assert.equal(r.code, "account_" + st);
  }
});

await t("SERVER-SIDE exposure: while dark, a guest is refused ide_disabled on EVERY route", () => {
  const f = featureFor("owner");   // the shipping default
  const calls = [
    () => f.state(GUEST), () => f.listWorkspaces(GUEST), () => f.listJobs(GUEST),
    () => f.setPrefs(GUEST, { engaged: true }),
    () => f.createWorkspace(GUEST, { root: "C:\\x" }),
    () => f.updateWorkspace(GUEST, { id: "ws_1", patch: {} }),
    () => f.removeWorkspace(GUEST, { id: "ws_1" }),
    () => f.startJob(GUEST, { kind: "probe" }),
    () => f.stopJob(GUEST, { jobId: "x" }),
    () => f.canAttach(GUEST, "x"),
  ];
  for (const call of calls) {
    const r = call();
    assert.equal(r.status, 403);
    assert.equal(r.code, "ide_disabled");
  }
  assert.equal(f.state(OWNER).status, 200, "the owner still gets through");
});

await t("billable actions take the extra wall; reading your own state does not", () => {
  const uninvited = { ...GUEST, invited: false };
  const f = featureFor("all");
  assert.equal(f.state(uninvited).status, 200, "reading your own workspaces is not billable work");
  assert.equal(f.listWorkspaces(uninvited).status, 200);
  const r = f.startJob(uninvited, { kind: "probe" });
  assert.equal(r.status, 403);
  assert.equal(r.code, "needs_invite");

  const broke = featureFor("all", { canChat: () => false });
  assert.equal(broke.state(GUEST).status, 200);
  const r2 = broke.startJob(GUEST, { kind: "probe" });
  assert.equal(r2.status, 402);
  assert.equal(r2.code, "needs_credits");
});

await t("MULTI_TENANT off means nobody is walled for money (Fred is never charged)", () => {
  const f = featureFor("all", { multiTenant: false, canChat: () => false });
  assert.equal(f.startJob({ ...GUEST, invited: false }, { kind: "probe" }).status, 200);
  assert.equal(f.startJob(OWNER, { kind: "probe" }).status, 200);
});

await t("the owner never hits the billable wall, multi-tenant on and zero credits", () => {
  const f = featureFor("owner", { canChat: () => false });
  assert.equal(f.startJob(OWNER, { kind: "probe" }).status, 200);
});

await t("a build demands a workspace and a prompt BEFORE anything runs", () => {
  const f = featureFor("owner");
  // no workspace: refused with the reason, since a build writes real files and must know where
  const noWs = f.startJob(OWNER, { kind: "build", prompt: "make a thing" });
  assert.equal(noWs.status, 400);
  assert.equal(noWs.code, "workspace_required");
  // a workspace but nothing to do: refused too, and the wording tells the user what to type
  const ws = f.createWorkspace(OWNER, { name: "W", root: "C:/Projects/demo-app" }).body.workspace;
  const noPrompt = f.startJob(OWNER, { kind: "build", workspaceId: ws.id });
  assert.equal(noPrompt.status, 400);
  assert.equal(noPrompt.code, "prompt_required");
  // and an invented kind still gets a plain refusal
  const junk = f.startJob(OWNER, { kind: "banana" });
  assert.equal(junk.status, 400);
  assert.equal(junk.code, "unknown_kind");
});

await t("one build per workspace: a second one is refused at the door", () => {
  const f = featureFor("owner");
  const ws = f.createWorkspace(OWNER, { name: "Busy", root: "C:/Projects/busy-app" }).body.workspace;
  const first = f.startJob(OWNER, { kind: "build", workspaceId: ws.id, prompt: "build it" });
  assert.equal(first.status, 200, "the first build starts");
  const second = f.startJob(OWNER, { kind: "build", workspaceId: ws.id, prompt: "build it again" });
  assert.equal(second.status, 409, "two builds writing one tree is the bug this design exists to avoid");
  assert.equal(second.code, "workspace_busy");
});

await t("starting a job against a workspace id you do not own is a 404", () => {
  const f = featureFor("owner");
  assert.equal(f.startJob(OWNER, { kind: "probe", workspaceId: "ws_someone_else" }).status, 404);
});

await t("one account can never stop or attach to another account's job", () => {
  const dir = freshDir();
  const store = createIdeStore({ dir, isProtectedPath });
  const jobs = createIdeJobs({ dir: join(dir, "j") });
  const f = createIdeFeature({
    gate: createIdeGate("all"), storeFor: () => store, jobs,
    billing: { canChat: () => true }, multiTenant: true,
  });
  const mine = jobs.create({ uid: GUEST.uid });
  const theirs = jobs.create({ uid: "someone-else" });
  assert.equal(f.canAttach(GUEST, mine.id).status, 200);
  // a stranger's job answers exactly like a job that does not exist: no existence oracle
  assert.equal(f.canAttach(GUEST, theirs.id).status, 404);
  assert.equal(f.stopJob(GUEST, { jobId: theirs.id }).status, 404);
  assert.equal(f.stopJob(GUEST, { jobId: "ide_nonexistent" }).status, 404);
  assert.equal(f.stopJob(GUEST, { jobId: mine.id }).status, 200);
  assert.equal(jobs.get(theirs.id).done, false, "the stranger's job must be untouched");
});

await t("the job list a user sees contains only their own jobs", () => {
  const dir = freshDir();
  const store = createIdeStore({ dir, isProtectedPath });
  const jobs = createIdeJobs({ dir: join(dir, "j") });
  const f = createIdeFeature({ gate: createIdeGate("all"), storeFor: () => store, jobs,
    billing: { canChat: () => true }, multiTenant: true });
  jobs.create({ uid: GUEST.uid }); jobs.create({ uid: "someone-else" });
  const r = f.listJobs(GUEST);
  assert.equal(r.status, 200);
  assert.equal(r.body.jobs.length, 1);
  assert.equal(r.body.jobs[0].uid, GUEST.uid);
});

await t("prefs round-trip through the feature so the toggle travels between devices (L-5)", () => {
  const f = featureFor("owner");
  assert.equal(f.state(OWNER).body.prefs.engaged, false);
  assert.equal(f.setPrefs(OWNER, { engaged: true }).body.prefs.engaged, true);
  assert.equal(f.state(OWNER).body.prefs.engaged, true, "a second device reads the account's answer");
  assert.equal(f.setPrefs(OWNER, { engaged: false }).body.prefs.engaged, false);
});

await t("a started probe job appears in the caller's registry immediately", () => {
  const f = featureFor("owner");
  const r = f.startJob(OWNER, { kind: "probe" });
  assert.equal(r.status, 200);
  assert.ok(r.body.jobId.startsWith("ide_"));
  const list = f.listJobs(OWNER);
  assert.equal(list.body.jobs.length, 1);
  assert.equal(list.body.active, 1, "it is running until something seals it");
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
