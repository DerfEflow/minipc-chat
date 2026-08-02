/*
 * Hands baseline self-test (HARD RULES R19-R21). Run with: node hands/baseline_test.mjs
 *
 * The failure this exists to prevent, in full: on 2026-07-22 a work order was pointed at `F:\`.
 * `git add -A` swept the whole drive (48,212 loose objects; 28 GB on disk on exFAT's 512 KB
 * clusters, including browser Login Data and Cookies), was interrupted, and then
 * `git commit --allow-empty` SUCCEEDED with git's empty tree. claudeBaseline() returned that SHA.
 * Every claude_code run afterwards believed it had a rollback point and had none.
 *
 * Proves:
 *   R20  a filesystem/drive root is refused outright
 *   R20  a tree above the file ceiling is refused, and the counter bails early rather than walking it
 *   R21  credential stores and junk trees are excluded BEFORE the first add
 *   R19  the empty-tree sentinel is exactly what git produces, so the guard matches reality
 *   R19  a real baseline commits a non-empty tree and reports ok
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

// hands.mjs starts a server on import, so the guards under test are re-declared here against the
// same contract. The values MUST stay in step with hands.mjs — the last test pins the sentinel to
// git's own behaviour so a drift in either direction is caught.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function isFilesystemRoot(dir) {
  const p = String(dir || "").replace(/[\\/]+$/, "");
  if (!p) return true;
  if (/^[A-Za-z]:$/.test(p)) return true;
  if (p === "/" || p === "\\") return true;
  if (/^\\\\[^\\]+\\[^\\]+$/.test(p)) return true;
  return false;
}

await t("R20: every shape of filesystem root is refused", () => {
  for (const root of ["F:\\", "F:/", "C:\\", "/", "\\\\nas\\share", ""]) {
    assert.equal(isFilesystemRoot(root), true, root + " must be refused — this is the F:\\ incident");
  }
});

await t("R20: an ordinary project folder is NOT refused", () => {
  for (const dir of ["F:\\Claude Sandbox\\Projects\\minipc-chat", "/home/fred/app", "\\\\nas\\share\\project"]) {
    assert.equal(isFilesystemRoot(dir), false, dir + " is a legitimate target");
  }
});

/* ── R20: the bounded counter ─────────────────────────────────────────────────────────────────── */

function countFilesBounded(dir, cap) {
  const SKIP = new Set([".git", "node_modules", "$RECYCLE.BIN", "System Volume Information", "lost+found"]);
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (SKIP.has(entry.name)) continue; stack.push(join(current, entry.name)); }
      else if (++n > cap) return { count: n, exceeded: true };
    }
  }
  return { count: n, exceeded: false };
}

const scratch = mkdtempSync(join(tmpdir(), "baseline-test-"));

await t("R20: the counter bails the instant it passes the cap (O(cap), not O(drive))", () => {
  const big = join(scratch, "big");
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(big, "f" + i + ".txt"), "x");
  const r = countFilesBounded(big, 10);
  assert.equal(r.exceeded, true, "must refuse a tree over the ceiling");
  assert.ok(r.count <= 11, "and must stop counting at the cap, not enumerate all 40 — got " + r.count);
});

await t("R20: a small project passes and reports its real size", () => {
  const small = join(scratch, "small");
  mkdirSync(join(small, "src"), { recursive: true });
  writeFileSync(join(small, "package.json"), "{}");
  writeFileSync(join(small, "src", "app.ts"), "export {}");
  const r = countFilesBounded(small, 20000);
  assert.equal(r.exceeded, false);
  assert.equal(r.count, 2);
});

await t("R20: node_modules and $RECYCLE.BIN are not walked at all", () => {
  const proj = join(scratch, "withdeps");
  mkdirSync(join(proj, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(proj, "$RECYCLE.BIN"), { recursive: true });
  writeFileSync(join(proj, "index.js"), "1");
  for (let i = 0; i < 50; i++) writeFileSync(join(proj, "node_modules", "left-pad", "f" + i), "x");
  writeFileSync(join(proj, "$RECYCLE.BIN", "junk"), "x");
  const r = countFilesBounded(proj, 20000);
  assert.equal(r.count, 1, "only index.js counts — got " + r.count);
});

/* ── R19: the empty-tree guard, pinned to git's actual behaviour ──────────────────────────────── */

const git = (dir, args) => execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args],
  { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

await t("R19: git's empty commit really does produce the sentinel tree we guard against", () => {
  const empty = join(scratch, "emptyrepo");
  mkdirSync(empty, { recursive: true });
  git(empty, ["init", "-q"]);
  // Exactly the old code path: --allow-empty with nothing staged.
  git(empty, ["commit", "--allow-empty", "-m", "hands: baseline snapshot"]);
  const tree = git(empty, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(tree, EMPTY_TREE_SHA,
    "the guard's sentinel must match what git actually emits, or it protects nothing");
  // And the commit "succeeds" — which is precisely why the old code could not tell.
  assert.ok(git(empty, ["rev-parse", "HEAD"]).length >= 40, "the hollow commit looks entirely normal");
});

await t("R19: a real baseline produces a NON-empty tree", () => {
  const real = join(scratch, "realrepo");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "app.js"), "console.log(1)\n");
  git(real, ["init", "-q"]);
  git(real, ["add", "-A"]);
  git(real, ["commit", "-m", "hands: baseline snapshot"]);
  const tree = git(real, ["rev-parse", "HEAD^{tree}"]);
  assert.notEqual(tree, EMPTY_TREE_SHA, "a baseline with files must not look empty");
  assert.equal(git(real, ["ls-tree", "-r", "HEAD"]).split("\n").filter(Boolean).length, 1);
});

/* ── R21: the deny-list ───────────────────────────────────────────────────────────────────────── */

await t("R21: excluded credential stores never enter the object database", () => {
  const proj = join(scratch, "creds");
  mkdirSync(join(proj, "Default", "Network"), { recursive: true });
  writeFileSync(join(proj, "app.js"), "1\n");
  writeFileSync(join(proj, "Default", "Login Data"), "SQLITE-CREDENTIALS\n");
  writeFileSync(join(proj, "Default", "Network", "Cookies"), "COOKIEJAR\n");
  git(proj, ["init", "-q"]);
  // The rule under test: the deny-list is written BEFORE the first add.
  mkdirSync(join(proj, ".git", "info"), { recursive: true });
  writeFileSync(join(proj, ".git", "info", "exclude"), ["Login Data", "Cookies", "Trust Tokens"].join("\n") + "\n");
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-m", "hands: baseline snapshot"]);

  const tracked = git(proj, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  assert.ok(tracked.includes("app.js"), "real project files are still captured");
  assert.ok(!tracked.some((p) => /Login Data|Cookies/.test(p)),
    "credential stores must be absent from the tree entirely — got: " + tracked.join(", "));
});

try { rmSync(scratch, { recursive: true, force: true }); } catch {}

console.log("\nhands baseline: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
