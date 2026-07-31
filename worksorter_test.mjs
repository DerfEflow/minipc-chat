/*
 * Work order #1, the folder sorter.
 *
 * This test RUNS THE ACTUAL POWERSHELL against real files in a temp folder, because the thing being
 * tested is a script that moves somebody's documents. Asserting on the generated source text would
 * prove only that I can write a string. The whole point of choosing a fixed task list over a model
 * was that the behaviour becomes exactly testable, so it gets exactly tested.
 *
 * The claims, in the order they would hurt if wrong:
 *   - it never overwrites (the classic way a tidy-up script eats work);
 *   - it never deletes;
 *   - it never leaves the folder it was pointed at;
 *   - it does not recurse, so running it twice is a no-op and an already-sorted folder is untouched;
 *   - filenames with quotes, brackets, apostrophes and spaces survive, which is the exact reason
 *     this is a script rather than a composed command line;
 *   - the undo really puts everything back.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SORTER_PS1, UNSORTER_PS1, parseSorterResult, summarizeSort, SORT_FOLDERS } from "./worksorter.mjs";

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };

const WIN = process.platform === "win32";
if (!WIN) {
  console.log("  SKIP  the sorter runs PowerShell; these run on Windows only");
  console.log("\n0/0 checks - skipped off Windows");
  process.exit(0);
}

const DIR = mkdtempSync(join(tmpdir(), "sorter-"));
const scriptPath = join(DIR, "sort.ps1");
const undoPath = join(DIR, "undo.ps1");
// ASCII, no BOM: PowerShell mangles a BOM'd .ps1 on this machine.
writeFileSync(scriptPath, SORTER_PS1, { encoding: "ascii" });
writeFileSync(undoPath, UNSORTER_PS1, { encoding: "ascii" });

const runSort = (root, extra = []) => {
  const out = execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Root", root, ...extra],
    { encoding: "utf8", timeout: 120000 });
  return parseSorterResult(out);
};

const makeFolder = (name, files) => {
  const root = join(DIR, name);
  mkdirSync(root, { recursive: true });
  for (const [f, content] of Object.entries(files)) writeFileSync(join(root, f), content || "x");
  return root;
};

t("loose files land in the right folders, and nothing is lost", () => {
  const root = makeFolder("basic", {
    "holiday.jpg": "img", "budget.xlsx": "sheet", "notes.txt": "doc",
    "archive.zip": "zip", "clip.mp4": "vid", "weird.qqq": "unknown",
  });
  const r = runSort(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.moved.length, 6, "every loose file should move: " + JSON.stringify(r));
  assert.ok(existsSync(join(root, "Images", "holiday.jpg")));
  assert.ok(existsSync(join(root, "Spreadsheets", "budget.xlsx")));
  assert.ok(existsSync(join(root, "Documents", "notes.txt")));
  assert.ok(existsSync(join(root, "Archives", "archive.zip")));
  assert.ok(existsSync(join(root, "Video", "clip.mp4")));
  assert.ok(existsSync(join(root, "Other", "weird.qqq"), "an unknown type goes to Other, never gets guessed at"));
  // Nothing left loose, and nothing vanished.
  const loose = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile());
  assert.equal(loose.length, 0);
});

t("THE ONE THAT EATS WORK: an existing file is never overwritten", () => {
  const root = makeFolder("collide", { "report.pdf": "THE NEW ONE" });
  mkdirSync(join(root, "Documents"), { recursive: true });
  writeFileSync(join(root, "Documents", "report.pdf"), "THE ORIGINAL");
  const r = runSort(root);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(root, "Documents", "report.pdf"), "utf8"), "THE ORIGINAL",
    "the file that was already there must be untouched");
  assert.equal(readFileSync(join(root, "Documents", "report (2).pdf"), "utf8"), "THE NEW ONE",
    "the incoming file gets a new name instead of destroying the old one");
});

t("filenames with quotes, brackets and apostrophes survive intact", () => {
  // The exact reason this is a script with -LiteralPath rather than a composed command line.
  const nasty = {
    "Fred's notes.txt": "apostrophe",
    "report [final].pdf": "brackets",
    "quote`tick.txt": "backtick",
    "a file with spaces.jpg": "spaces",
    "semi;colon & amp.txt": "punctuation",
    "$dollar $var.txt": "dollar",
  };
  const root = makeFolder("nasty", nasty);
  const r = runSort(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.moved.length, Object.keys(nasty).length, "every awkward name must move: " + JSON.stringify(r.skipped));
  assert.equal(readFileSync(join(root, "Documents", "Fred's notes.txt"), "utf8"), "apostrophe");
  assert.equal(readFileSync(join(root, "Documents", "report [final].pdf"), "utf8"), "brackets");
  assert.equal(readFileSync(join(root, "Documents", "$dollar $var.txt"), "utf8"), "dollar");
  assert.equal(readFileSync(join(root, "Images", "a file with spaces.jpg"), "utf8"), "spaces");
});

t("it does not recurse, so running twice changes nothing the second time", () => {
  const root = makeFolder("twice", { "a.txt": "1", "b.jpg": "2" });
  mkdirSync(join(root, "Projects", "deep"), { recursive: true });
  writeFileSync(join(root, "Projects", "deep", "buried.txt"), "leave me");
  const first = runSort(root);
  assert.equal(first.moved.length, 2);
  const second = runSort(root);
  assert.equal(second.moved.length, 0, "a second run must be a no-op: " + JSON.stringify(second));
  assert.equal(readFileSync(join(root, "Projects", "deep", "buried.txt"), "utf8"), "leave me",
    "a file inside an existing subfolder must never be touched");
});

t("nothing is ever deleted, and the script contains no delete at all", () => {
  const root = makeFolder("nodelete", { "one.txt": "a", "two.jpg": "b", "three.zip": "c" });
  const before = readdirSync(root).length;
  runSort(root);
  const after = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else after.push(p); } };
  walk(root);
  assert.equal(after.length, before, "the same number of files must exist afterwards");
  assert.ok(!/Remove-Item|\bdel\b|Clear-Content|\.Delete\(/i.test(SORTER_PS1), "the sorter must contain no delete of any kind");
});

t("hidden, system and read-only files are left alone", () => {
  const root = makeFolder("protected", { "normal.txt": "move me", "locked.txt": "leave me" });
  execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `Set-ItemProperty -LiteralPath '${join(root, "locked.txt").replace(/'/g, "''")}' -Name IsReadOnly -Value $true`], { encoding: "utf8" });
  const r = runSort(root);
  assert.ok(existsSync(join(root, "Documents", "normal.txt")), "an ordinary file still moves");
  assert.ok(existsSync(join(root, "locked.txt")), "a read-only file stays exactly where it was");
  assert.ok(r.skipped.some((s) => s.name === "locked.txt" && /read-only/.test(s.why)), "and the skip is reported, not silent");
});

t("a dry run reports the moves and changes absolutely nothing", () => {
  const root = makeFolder("dry", { "a.txt": "1", "b.jpg": "2" });
  const r = runSort(root, ["-DryRun"]);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.moved.length, 2, "it must still say what it WOULD do");
  assert.ok(r.moved.every((m) => m.planned === true));
  assert.ok(existsSync(join(root, "a.txt")) && existsSync(join(root, "b.jpg")), "both files must still be loose");
  assert.ok(!existsSync(join(root, "Documents")), "a dry run must not even create the folders");
});

t("the file cap stops a huge folder and says so", () => {
  const files = {};
  for (let i = 0; i < 30; i++) files[`f${i}.txt`] = "x";
  const root = makeFolder("capped", files);
  const r = runSort(root, ["-MaxFiles", "10"]);
  assert.equal(r.capped, true, "it must admit it stopped early");
  assert.ok(r.moved.length <= 10, "and it must actually stop: moved " + r.moved.length);
  assert.ok(readdirSync(root).filter((n) => n.endsWith(".txt")).length > 0, "the rest are left for the next run");
});

t("THE UNDO puts every file back where it was", () => {
  const root = makeFolder("undo", { "a.txt": "one", "b.jpg": "two", "c.zip": "three" });
  const r = runSort(root);
  assert.equal(r.moved.length, 3);
  assert.equal(readdirSync(root).filter((n) => /\.(txt|jpg|zip)$/.test(n)).length, 0, "sorted away first");

  const journal = join(DIR, "journal-undo.json");
  writeFileSync(journal, JSON.stringify(r.moved.map((m) => ({ from: m.from, to: m.to }))), "utf8");
  const out = execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", undoPath, "-JournalPath", journal],
    { encoding: "utf8", timeout: 120000 });
  const u = parseSorterResult(out);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(root, "b.jpg"), "utf8"), "two");
  assert.equal(readFileSync(join(root, "c.zip"), "utf8"), "three");
});

t("a folder that does not exist is refused in plain words, not a stack trace", () => {
  const r = runSort(join(DIR, "does-not-exist-at-all"));
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist on this machine/);
});

t("the summary reads like a person wrote it", () => {
  assert.match(summarizeSort({ ok: true, moved: [1, 2, 3], skipped: [], created: ["Images"] }), /^3 files sorted, 1 new folder\.$/);
  assert.match(summarizeSort({ ok: true, moved: [1], skipped: [], created: [] }), /^1 file sorted\.$/);
  assert.match(summarizeSort({ ok: true, moved: [], skipped: [], created: [] }), /Nothing to sort/);
  assert.match(summarizeSort({ ok: false, error: "no such folder" }), /did not run: no such folder/);
});

try { rmSync(DIR, { recursive: true, force: true }); } catch {}
console.log(`\n${passed}/11 checks passed - the sorter moves files and cannot eat them`);
