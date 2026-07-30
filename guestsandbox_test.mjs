/*
 * The guest workshop (guestsandbox.mjs). This is a containment boundary standing between one
 * visitor and a server that holds every other tenant's data, so the tests that matter most are the
 * ones that try to get OUT of it: absolute paths elsewhere, traversal, and symlinks, which are the
 * three ways a "safe" sandbox is usually not one.
 *
 * The rest checks that it is a real workshop and not a stub: files written are files readable, the
 * snapshot is an actual tree copy (the engine refuses to write without a rollback path, so a fake
 * one would be worse than none), and every machine-only capability refuses by name instead of
 * pretending or hanging.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { createGuestSandbox } from "./guestsandbox.mjs";

const WORK = mkdtempSync(join(tmpdir(), "workshop-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "outside-"));
writeFileSync(join(OUTSIDE, "secrets.env"), "OPENAI_KEY=sk-should-never-be-read");

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  PASS  " + name); passed++; };

const sandbox = createGuestSandbox({ rootDir: WORK });
const UID = "guest123";
const run = sandbox.dispatch(UID);
const root = sandbox.rootFor(UID);

await t("each account gets its own root, and one cannot name another's", async () => {
  const other = sandbox.rootFor("someoneelse");
  assert.notEqual(root, other);
  // A uid carrying separators or dots is scrubbed, never joined raw. Dots are dropped outright:
  // a uid of ".." would otherwise resolve to the PARENT of the whole workshop directory.
  assert.equal(sandbox.rootFor("../../etc"), join(WORK, "etc"));
  assert.equal(sandbox.rootFor("a/b"), join(WORK, "ab"));
  assert.equal(sandbox.rootFor(".."), "", "a uid that scrubs to nothing gets no root at all");
  assert.equal(sandbox.rootFor("."), "", "and neither does a single dot");
});

await t("an absolute path outside the workshop is refused, not clamped", async () => {
  const r = await run("fs_read", { path: join(OUTSIDE, "secrets.env") });
  assert.equal(r.ok, false, "reading outside must fail");
  assert.equal(r.refused, true, "and it must be an explicit refusal");
  assert.ok(!String(r.text || "").includes("sk-"), "no content may leak");
});

await t("traversal out of the workshop is refused", async () => {
  for (const p of ["../../etc/passwd", root + "/../../etc/passwd", "..\\..\\windows\\win.ini"]) {
    const r = await run("fs_write", { path: p, content: "x" });
    assert.equal(r.ok, false, "traversal must fail for " + p);
  }
});

await t("a symlink pointing out of the workshop cannot be read through", async () => {
  const link = join(root, "escape");
  try { symlinkSync(OUTSIDE, link, "junction"); } catch { console.log("       (symlink unavailable on this host; skipped)"); return; }
  const r = await run("fs_read", { path: join(link, "secrets.env") });
  assert.equal(r.ok, false, "a symlinked path out of the sandbox must be refused");
  assert.ok(!String(r.text || "").includes("sk-"), "no content may leak through a link");
  rmSync(link, { recursive: true, force: true });
});

await t("write, read, list and tree work like a real folder", async () => {
  const file = join(root, "app", "index.js");
  const w = await run("fs_write", { path: file, content: "console.log('hi')\n" });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.changed, true);
  const again = await run("fs_write", { path: file, content: "console.log('hi')\n" });
  assert.equal(again.changed, false, "an identical write reports no change");
  const r = await run("fs_read", { path: file });
  assert.match(r.text, /console\.log/);
  const l = await run("fs_list", { path: join(root, "app") });
  assert.ok(l.entries.some((e) => e.name === "index.js" && e.type === "file"));
  const tr = await run("fs_tree", { path: root, depth: 3 });
  assert.ok(tr.tree.some((line) => line.includes("index.js")));
});

await t("a relative path is resolved against the account's own root", async () => {
  const r = await run("fs_read", { path: "app/index.js" });
  assert.equal(r.ok, true, "a bare project-relative path must resolve inside the workshop");
});

await t("fs_edit refuses an ambiguous match instead of guessing", async () => {
  const file = join(root, "twice.txt");
  await run("fs_write", { path: file, content: "alpha\nalpha\n" });
  const bad = await run("fs_edit", { path: file, find: "alpha", replace: "beta" });
  assert.equal(bad.ok, false, "two matches must refuse");
  const good = await run("fs_edit", { path: file, find: "alpha", replace: "beta", all: true });
  assert.equal(good.ok, true);
  assert.equal(readFileSync(file, "utf8"), "beta\nbeta\n");
});

await t("the snapshot is a real tree copy, not a promise", async () => {
  const snap = await run("fs_snapshot", { path: root, stamp: "test1" });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  assert.ok(existsSync(join(snap.path, "app", "index.js")), "the copy must contain the project's files");
  assert.equal(readFileSync(join(snap.path, "app", "index.js"), "utf8"), "console.log('hi')\n");
  assert.ok(snap.files >= 2, "it must count what it copied");
});

await t("the snapshot skips dependency dumps and its own folder", async () => {
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "// huge");
  const snap = await run("fs_snapshot", { path: root, stamp: "test2" });
  assert.equal(snap.ok, true);
  assert.ok(!existsSync(join(snap.path, "node_modules")), "node_modules must not be copied");
  assert.ok(!existsSync(join(snap.path, ".dominion-snapshots")), "snapshots must not nest into themselves");
});

await t("node_info tells the truth about what this place is", async () => {
  const i = await run("node_info", {});
  assert.equal(i.ok, true);
  assert.equal(i.sandbox, true, "callers branch on this to stop promising a machine");
  assert.equal(i.shell, false);
  assert.deepEqual(i.roots, [root]);
});

await t("machine-only capabilities refuse by name, and say what is missing", async () => {
  for (const tool of ["shell_run", "preview_fetch", "browser_control", "claude_code"]) {
    const r = await run(tool, { command: "echo hi" });
    assert.equal(r.ok, false, tool + " must not silently succeed");
    assert.equal(r.refused, true, tool + " must refuse explicitly");
    assert.ok(/computer|command line/i.test(r.error), tool + " must explain what is missing: " + r.error);
  }
});

await t("a new project folder is created without the guest naming a path", async () => {
  const a = sandbox.newProjectDir(UID, "My Cool App");
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.ok(a.path.startsWith(root + sep), "it must land inside the account's own root");
  assert.ok(existsSync(a.path));
  const b = sandbox.newProjectDir(UID, "My Cool App");
  assert.notEqual(b.path, a.path, "a repeated name must not collide with the first folder");
});

rmSync(WORK, { recursive: true, force: true });
rmSync(OUTSIDE, { recursive: true, force: true });
console.log(`\n${passed}/12 checks passed - the guest workshop holds its walls`);
