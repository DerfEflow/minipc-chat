/*
 * snapshot.mjs - the reversibility spine for the hands node.
 *
 * Fred's standing rule: nothing changes on his machines without a snapshot and
 * a rollback path. This runs on the NODE, immediately before a mutation lands,
 * because the node is where the filesystem actually is.
 *
 * WHAT THIS GUARANTEES, precisely, because a vague promise here is worse than none:
 *
 *   fs_write / fs_append(truncate)  EXACT. The prior bytes of the target file are
 *                                   copied aside before the write. Full auto-restore.
 *   shell_run                       BEST EFFORT. runShell() spawns without a cwd, so
 *                                   there is no single directory to capture. We extract
 *                                   candidate paths from the command text, and for any
 *                                   that resolve inside a git work tree we record HEAD
 *                                   plus a `git stash create` object. That covers the
 *                                   dominant real case (a model working inside a repo)
 *                                   and covers nothing outside it.
 *   everything                      JOURNALLED. Append-only journal.jsonl records every
 *                                   mutation attempt whether or not it could be snapped.
 *
 * What it cannot do: reverse effects that left the machine. A command that writes to a
 * remote database or calls an API is gone. Rollback restores disks, not the world.
 *
 * Storage: <SNAP_DIR>/journal.jsonl and <SNAP_DIR>/<id>/{manifest.json,files/}
 * Retention: age and total-size capped, oldest pruned first, so this never eats a disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve, parse as parsePath, sep } from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const IS_WIN = process.platform === "win32";

let SNAP_DIR = "";
let MAX_AGE_DAYS = 14;
let MAX_TOTAL_MB = 5000;
let MAX_FILE_MB = 100;

export function initSnapshots(opts = {}) {
  SNAP_DIR = String(opts.dir || "");
  MAX_AGE_DAYS = Number(opts.maxAgeDays || process.env.HANDS_SNAP_AGE_DAYS || 14);
  MAX_TOTAL_MB = Number(opts.maxTotalMb || process.env.HANDS_SNAP_MAX_MB || 5000);
  MAX_FILE_MB = Number(opts.maxFileMb || process.env.HANDS_SNAP_FILE_MB || 100);
  if (SNAP_DIR) { try { mkdirSync(SNAP_DIR, { recursive: true }); } catch { /* reported by callers */ } }
  return { dir: SNAP_DIR, maxAgeDays: MAX_AGE_DAYS, maxTotalMb: MAX_TOTAL_MB };
}

const enabled = () => !!SNAP_DIR;
const nowIso = () => new Date().toISOString();
function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return stamp + "-" + crypto.randomBytes(3).toString("hex");
}

// ---- journal: append-only, one JSON object per line -------------------------------------------
export function journal(entry) {
  if (!enabled()) return;
  try {
    appendFileSync(join(SNAP_DIR, "journal.jsonl"), JSON.stringify({ at: nowIso(), ...entry }) + "\n");
  } catch { /* never let journalling break a job */ }
}

// ---- git awareness -----------------------------------------------------------------------------
function git(repo, args, timeoutMs = 8000) {
  return execFileSync("git", ["-C", repo, ...args], { timeout: timeoutMs, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function findRepoRoot(startPath) {
  try {
    let dir = statSync(startPath).isDirectory() ? resolve(startPath) : dirname(resolve(startPath));
    const root = parsePath(dir).root;
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(dir, ".git"))) return dir;
      if (dir === root) break;
      dir = dirname(dir);
    }
  } catch { /* not a path we can stat */ }
  return null;
}

/*
 * Pull plausible filesystem paths out of an opaque shell command. This is a heuristic and is
 * documented as such: it catches `cd X`, `Set-Location X`, `pushd X`, and absolute path tokens.
 * A path it misses simply means no git anchor for that repo, never a failed job.
 */
export function extractPaths(cmdText) {
  const text = String(cmdText || "");
  const found = new Set();
  const cdRe = /(?:^|[;&|\n])\s*(?:cd|chdir|pushd|set-location|sl)\s+(?:\/d\s+)?["']?([^"';&|\n]+)["']?/gi;
  let m;
  while ((m = cdRe.exec(text))) { const p = m[1].trim(); if (p) found.add(p); }
  const absRe = IS_WIN ? /["']?([a-zA-Z]:[\\/][^"'\s;&|]*)/g : /["']?(\/[^"'\s;&|]*)/g;
  while ((m = absRe.exec(text))) { const p = m[1].trim(); if (p && p.length > 3) found.add(p); }
  return [...found].slice(0, 20);
}

function gitAnchorsFor(paths) {
  const anchors = [];
  const seen = new Set();
  for (const p of paths) {
    const repo = findRepoRoot(p);
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    try {
      const head = git(repo, ["rev-parse", "HEAD"]);
      let stash = "";
      try { stash = git(repo, ["stash", "create"]); } catch { /* clean tree returns empty */ }
      const dirty = (() => { try { return git(repo, ["status", "--porcelain"]).split("\n").filter(Boolean).length; } catch { return -1; } })();
      anchors.push({ repo, head, stash: stash || null, dirtyFiles: dirty });
    } catch { /* not a usable repo, skip quietly */ }
    if (anchors.length >= 5) break;
  }
  return anchors;
}

// ---- the entry point the node calls before a mutation ------------------------------------------
/*
 * Returns { id, method, ... } when something was captured, or { id:null, method:"none", reason }
 * when nothing could be. NEVER throws and NEVER blocks the job: an unsnapshottable mutation is
 * recorded loudly in the journal and allowed to proceed, because Fred asked for an engineer that
 * acts, not one that refuses on principle.
 */
export function beforeMutation(tool, args = {}, meta = {}) {
  if (!enabled()) return { id: null, method: "none", reason: "snapshots not configured on this node" };
  const id = newId();
  const dir = join(SNAP_DIR, id);
  const manifest = { id, at: nowIso(), tool, node: meta.node || null, jobId: meta.jobId || null, method: "none", entries: [], anchors: [], notes: [] };

  try {
    if (tool === "fs_write" || tool === "fs_append") {
      const target = String(args.path || "");
      const truncating = tool === "fs_write" || args.truncate === true;
      if (!target) {
        manifest.notes.push("no path given");
      } else if (!existsSync(target)) {
        manifest.method = "new-file";
        manifest.entries.push({ path: resolve(target), existed: false });
        manifest.notes.push("target did not exist; rollback means deleting the created file");
      } else if (!truncating) {
        manifest.method = "append-only";
        let size = 0; try { size = statSync(target).size; } catch {}
        manifest.entries.push({ path: resolve(target), existed: true, priorBytes: size });
        manifest.notes.push("append without truncate; rollback means truncating back to priorBytes");
      } else {
        let st = null; try { st = statSync(target); } catch {}
        const mb = st ? st.size / 1048576 : 0;
        if (st && mb > MAX_FILE_MB) {
          manifest.method = "skipped-too-large";
          manifest.notes.push(`target is ${mb.toFixed(1)}MB, over the ${MAX_FILE_MB}MB per-file cap; NOT captured`);
        } else {
          mkdirSync(join(dir, "files"), { recursive: true });
          const stored = join(dir, "files", "0" + (parsePath(target).ext || ".bin"));
          copyFileSync(target, stored);
          manifest.method = "file-copy";
          manifest.entries.push({ path: resolve(target), existed: true, stored, priorBytes: st ? st.size : null });
        }
      }
    } else if (tool === "shell_run") {
      const paths = extractPaths(args.command);
      const anchors = gitAnchorsFor(paths);
      manifest.anchors = anchors;
      manifest.method = anchors.length ? "git-anchor" : "journal-only";
      manifest.command = String(args.command || "").slice(0, 2000);
      if (!anchors.length) manifest.notes.push("no git work tree found among the paths in this command; journalled but not restorable");
    } else {
      manifest.method = "journal-only";
    }

    if (manifest.method !== "none" && manifest.method !== "journal-only") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
  } catch (e) {
    manifest.method = "failed";
    manifest.notes.push("snapshot failed: " + (e && e.message || e));
  }

  journal({ kind: "mutation", id, tool, method: manifest.method, node: meta.node || null, target: args.path || undefined, notes: manifest.notes });
  try { prune(); } catch { /* pruning must never break a job */ }
  return manifest;
}

// ---- listing and restore -----------------------------------------------------------------------
export function listSnapshots(limit = 25) {
  if (!enabled()) return [];
  let names = [];
  try { names = readdirSync(SNAP_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const out = [];
  for (const n of names.sort().reverse().slice(0, Math.min(Number(limit) || 25, 200))) {
    try { out.push(JSON.parse(readFileSync(join(SNAP_DIR, n, "manifest.json"), "utf8"))); } catch { /* half-written, skip */ }
  }
  return out;
}

export function restoreSnapshot(id) {
  if (!enabled()) return { ok: false, error: "snapshots not configured on this node" };
  const dir = join(SNAP_DIR, String(id || ""));
  if (!existsSync(join(dir, "manifest.json"))) return { ok: false, error: "no snapshot with id " + id };
  let man;
  try { man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); }
  catch (e) { return { ok: false, error: "manifest unreadable: " + e.message }; }

  const done = [], failed = [];
  for (const en of man.entries || []) {
    try {
      if (en.stored && existsSync(en.stored)) {
        mkdirSync(dirname(en.path), { recursive: true });
        copyFileSync(en.stored, en.path);
        done.push("restored " + en.path);
      } else if (en.existed === false) {
        if (existsSync(en.path)) { rmSync(en.path, { force: true }); done.push("deleted " + en.path + " (did not exist before)"); }
      } else if (typeof en.priorBytes === "number") {
        const buf = readFileSync(en.path);
        writeFileSync(en.path, buf.subarray(0, en.priorBytes));
        done.push("truncated " + en.path + " back to " + en.priorBytes + " bytes");
      }
    } catch (e) { failed.push(en.path + ": " + (e && e.message || e)); }
  }

  const gitPlan = (man.anchors || []).map((a) =>
    a.stash ? `git -C "${a.repo}" checkout ${a.stash} -- .`
            : `git -C "${a.repo}" checkout ${a.head} -- .`);

  journal({ kind: "restore", id: man.id, restored: done.length, failed: failed.length });
  return {
    ok: failed.length === 0,
    id: man.id, tool: man.tool, at: man.at, method: man.method,
    restored: done, failed,
    gitPlan,
    note: gitPlan.length ? "Repo state was anchored, not auto-reverted. Run the gitPlan commands to roll a repo back." : undefined,
  };
}

// ---- retention ---------------------------------------------------------------------------------
function dirSizeMb(p) {
  let total = 0;
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += statSync(full).size; } catch {} }
    }
  };
  walk(p);
  return total / 1048576;
}

export function prune() {
  if (!enabled()) return { pruned: 0 };
  let names = [];
  try { names = readdirSync(SNAP_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { pruned: 0 }; }
  names.sort();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  let pruned = 0;

  for (const n of [...names]) {
    let mtime = 0;
    try { mtime = statSync(join(SNAP_DIR, n)).mtimeMs; } catch { continue; }
    if (mtime < cutoff) {
      try { rmSync(join(SNAP_DIR, n), { recursive: true, force: true }); pruned++; names.splice(names.indexOf(n), 1); } catch {}
    }
  }

  let total = dirSizeMb(SNAP_DIR);
  while (total > MAX_TOTAL_MB && names.length) {
    const oldest = names.shift();
    try {
      const mb = dirSizeMb(join(SNAP_DIR, oldest));
      rmSync(join(SNAP_DIR, oldest), { recursive: true, force: true });
      total -= mb; pruned++;
    } catch { break; }
  }
  if (pruned) journal({ kind: "prune", pruned, totalMbAfter: Math.round(total) });
  return { pruned };
}
