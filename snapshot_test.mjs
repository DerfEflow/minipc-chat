/*
 * Snapshot spine self-test - run with: node snapshot_test.mjs
 * Proves the reversibility guarantee Fred asked for, by exercising it rather than reading it:
 *   1. overwriting an existing file captures the prior bytes, and restore returns them EXACTLY
 *   2. creating a new file records existed:false, and restore DELETES it (correct inverse)
 *   3. a truncating append is captured; a plain append chunk is deliberately NOT (retention)
 *   4. shell_run inside a git work tree records a real HEAD anchor
 *   5. shell_run outside any repo degrades to journal-only and still lets the job proceed
 *   6. every mutation lands in the append-only journal
 *   7. retention prunes by age without touching fresh snapshots
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initSnapshots, beforeMutation, listSnapshots, restoreSnapshot, prune, extractPaths } from "./hands/snapshot.mjs";

const root = mkdtempSync(join(tmpdir(), "snaptest-"));
const snapDir = join(root, ".snapshots");
initSnapshots({ dir: snapDir, maxAgeDays: 14, maxTotalMb: 5000 });
let passed = 0;
const ok = (name) => { console.log("  PASS  " + name); passed++; };

// 1. overwrite an existing file, then restore it byte-for-byte
{
  const f = join(root, "existing.txt");
  const original = "the original contents, which must come back verbatim\n";
  writeFileSync(f, original);
  const snap = beforeMutation("fs_write", { path: f, content: "clobbered" }, { node: "test" });
  assert.equal(snap.method, "file-copy", "an existing file should be copied aside");
  writeFileSync(f, "clobbered");
  assert.equal(readFileSync(f, "utf8"), "clobbered");
  const r = restoreSnapshot(snap.id);
  assert.equal(r.ok, true, "restore should succeed: " + JSON.stringify(r.failed));
  assert.equal(readFileSync(f, "utf8"), original, "restored bytes must match the original exactly");
  ok("overwrite is captured and restores byte-for-byte");
}

// 2. a newly created file rolls back by being deleted
{
  const f = join(root, "brand-new.txt");
  const snap = beforeMutation("fs_write", { path: f, content: "hello" }, { node: "test" });
  assert.equal(snap.method, "new-file");
  writeFileSync(f, "hello");
  assert.equal(existsSync(f), true);
  const r = restoreSnapshot(snap.id);
  assert.equal(r.ok, true);
  assert.equal(existsSync(f), false, "rolling back a creation must delete the file");
  ok("file creation rolls back by deletion");
}

// 3. truncating append captured; plain append chunk deliberately skipped
{
  const f = join(root, "chunked.bin");
  writeFileSync(f, "seed");
  const first = beforeMutation("fs_append", { path: f, truncate: true }, { node: "test" });
  assert.equal(first.method, "file-copy", "the truncating first chunk IS a mutation of prior state");
  const later = beforeMutation("fs_append", { path: f, truncate: false }, { node: "test" });
  assert.equal(later.method, "append-only", "a later chunk records intent without copying");
  ok("chunked transfer snapshots the first chunk only");
}

// 4. shell_run inside a git repo gets a real anchor
{
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "seed");
  const snap = beforeMutation("shell_run", { command: `cd ${repo} && npm run build` }, { node: "test" });
  assert.equal(snap.method, "git-anchor", "a command touching a repo must anchor it");
  assert.equal(snap.anchors.length, 1);
  assert.match(snap.anchors[0].head, /^[0-9a-f]{40}$/, "anchor must record a real HEAD sha");
  ok("shell_run in a git tree records a HEAD anchor");
}

// 5. shell_run outside any repo degrades honestly, never blocks
{
  const snap = beforeMutation("shell_run", { command: "echo hello" }, { node: "test" });
  assert.equal(snap.method, "journal-only", "no repo means journal-only, not failure");
  assert.ok(snap.notes.some((n) => /not restorable/.test(n)), "it must say plainly that it is not restorable");
  ok("shell_run outside a repo degrades to journal-only and proceeds");
}

// 6. the journal caught everything
{
  const lines = readFileSync(join(snapDir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const mutations = lines.filter((l) => l.kind === "mutation");
  assert.ok(mutations.length >= 6, "every mutation attempt should be journalled, saw " + mutations.length);
  assert.ok(lines.some((l) => l.kind === "restore"), "restores are journalled too");
  ok("append-only journal recorded every mutation and restore");
}

// 7. retention prunes old snapshots and spares fresh ones
{
  const before = readdirSync(snapDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  const stale = readdirSync(snapDir, { withFileTypes: true }).filter((e) => e.isDirectory())[0].name;
  const old = new Date(Date.now() - 40 * 86400000);
  utimesSync(join(snapDir, stale), old, old);
  const { pruned } = prune();
  assert.equal(pruned, 1, "exactly the aged snapshot should go");
  const after = readdirSync(snapDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  assert.equal(after, before - 1, "fresh snapshots must survive pruning");
  ok("retention prunes by age and spares fresh snapshots");
}

// 8. path extraction heuristic behaves on the shapes models actually emit
{
  assert.ok(extractPaths("cd C:\\work\\proj && npm test").some((p) => /work/i.test(p)));
  assert.ok(extractPaths("Set-Location 'C:/a/b'; ls").length > 0);
  assert.equal(extractPaths("echo hi").length, 0);
  ok("path extraction handles cd, Set-Location, and absolute tokens");
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed}/8 checks passed - snapshot spine verified`);
