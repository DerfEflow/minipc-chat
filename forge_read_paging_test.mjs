/*
 * forge_read honest-paging self-test — run: node forge_read_paging_test.mjs
 * Proves the silent 8000-char cut is gone: big files page with explicit continuation offsets,
 * small files come back bare (unchanged wire shape), trees surface the node's truncated flag,
 * and 500-entry listings say they are capped. Same harness as forge_hands_test: ctx.hands.dispatch
 * is wired straight to the real node executor.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WORK = mkdtempSync(join(tmpdir(), "forge-paging-"));
process.env.HANDS_ROOTS = WORK;
const { executeJob } = await import("./hands/hands.mjs");
const { runTool } = await import("./tools.mjs");

const ctx = { hands: { dispatch: (tool, args) => executeJob(tool, args) } };
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// A 37KB file like the one that burned Fred's test session: MeasurementsStep.jsx at 37,000 chars.
const BIG = join(WORK, "MeasurementsStep.jsx");
const bigText = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, "0")} `.padEnd(37, "x")).join("\n"); // 37,999 chars
writeFileSync(BIG, bigText);

await t("small file returns bare text, no wrapper (old wire shape preserved)", async () => {
  const p = join(WORK, "small.txt");
  writeFileSync(p, "just a small file");
  const out = await runTool("forge_read", { op: "read", path: p }, ctx);
  assert.equal(out, "just a small file");
});

await t("big file page 1: window header + continuation offset, nothing silent", async () => {
  const out = await runTool("forge_read", { op: "read", path: BIG }, ctx);
  assert.match(out, /^\[showing characters 0 to 16000 of \d+\]/);
  assert.match(out, /file continues: \d+ characters remain/);
  assert.match(out, /offset:16000/);
  assert.ok(out.includes(bigText.slice(0, 16000)), "page 1 must contain the exact first 16000 chars");
});

await t("big file page 2 via the offset page 1 gave", async () => {
  const out = await runTool("forge_read", { op: "read", path: BIG, offset: 16000 }, ctx);
  assert.match(out, /^\[showing characters 16000 to 32000 of \d+\]/);
  assert.ok(out.includes(bigText.slice(16000, 32000)), "page 2 must contain the exact next window");
  assert.match(out, /offset:32000/);
});

await t("last page says [end of file], no continuation bait", async () => {
  const out = await runTool("forge_read", { op: "read", path: BIG, offset: 32000 }, ctx);
  assert.match(out, /\[end of file\]/);
  assert.doesNotMatch(out, /file continues/);
});

await t("three pages stitched = the exact original file", async () => {
  let text = "", offset = 0;
  for (let i = 0; i < 10; i++) {
    const out = await runTool("forge_read", { op: "read", path: BIG, offset }, ctx);
    const m = out.match(/^\[showing characters (\d+) to (\d+) of (\d+)\]\n([\s\S]*)\n\[(?:end of file|file continues)/);
    assert.ok(m, "every page must carry the window header");
    text += m[4];
    offset = Number(m[2]);
    if (out.includes("[end of file]")) break;
  }
  assert.equal(text, bigText, "stitched pages must reproduce the file byte for byte");
});

await t("offset past the end is an honest message, not an empty string", async () => {
  const out = await runTool("forge_read", { op: "read", path: BIG, offset: 999999 }, ctx);
  assert.match(out, /nothing at offset 999999/);
  assert.match(out, /\d+ characters long/);
});

await t("custom limit is respected and clamped to sane bounds", async () => {
  const out = await runTool("forge_read", { op: "read", path: BIG, limit: 2000 }, ctx);
  assert.match(out, /^\[showing characters 0 to 2000 of \d+\]/);
  const tiny = await runTool("forge_read", { op: "read", path: BIG, limit: 5 }, ctx); // below floor -> 1000
  assert.match(tiny, /^\[showing characters 0 to 1000 of \d+\]/);
});

await t("deep tree surfaces the node's truncated flag instead of eating it", async () => {
  // 900 files across subfolders busts the node's 800-line tree cap.
  for (let d = 0; d < 30; d++) {
    const dir = join(WORK, "deep", `sub${String(d).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 30; f++) writeFileSync(join(dir, `f${f}.txt`), "x");
  }
  const out = await runTool("forge_read", { op: "tree", path: join(WORK, "deep") }, ctx);
  assert.match(out, /\[tree truncated at \d+ lines/);
  assert.match(out, /subfolder/);
});

await t("tree depth arg passes through (depth 1 shows only the top level)", async () => {
  const out = await runTool("forge_read", { op: "tree", path: join(WORK, "deep"), depth: 1 }, ctx);
  assert.doesNotMatch(out, /f0\.txt/);
  assert.match(out, /sub00\//);
});

await t("500-entry listing says it is capped", async () => {
  const flat = join(WORK, "flat");
  mkdirSync(flat, { recursive: true });
  for (let i = 0; i < 520; i++) writeFileSync(join(flat, `e${String(i).padStart(3, "0")}.txt`), "x");
  const out = await runTool("forge_read", { op: "list", path: flat }, ctx);
  assert.match(out, /listing capped at 500 entries/);
});

await t("small folder listing has no cap note", async () => {
  const out = await runTool("forge_read", { op: "list", path: WORK }, ctx);
  assert.doesNotMatch(out, /listing capped/);
});

rmSync(WORK, { recursive: true, force: true });
console.log(`\nforge_read_paging: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
