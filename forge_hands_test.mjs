/*
 * Forge-over-hands self-test — run: node forge_hands_test.mjs
 * Proves forge_read/forge_write/forge_run now reach the machine through the hands NODE (not the
 * retired bridge), and the node's carve-outs still hold. ctx.hands.dispatch is wired straight to the
 * node executor (the same code the real hub dispatches to).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WORK = mkdtempSync(join(tmpdir(), "forge-hands-"));
process.env.HANDS_ROOTS = WORK;                       // the node's allowed root (set before import)
const { executeJob } = await import("./hands/hands.mjs");
const { runTool } = await import("./tools.mjs");

// ctx.hands.dispatch -> the real node executor (what the hub forwards to).
const ctx = { hands: { dispatch: (tool, args) => executeJob(tool, args) } };
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

await t("forge_write creates a file on the machine", async () => {
  const p = join(WORK, "hello.txt");
  const out = await runTool("forge_write", { path: p, content: "forge-was-here" }, ctx);
  assert.match(out, /Wrote 14 bytes/);
  assert.equal(readFileSync(p, "utf8"), "forge-was-here");
});

await t("forge_read reads it back", async () => {
  const out = await runTool("forge_read", { op: "read", path: join(WORK, "hello.txt") }, ctx);
  assert.equal(out, "forge-was-here");
});

await t("forge_read op:list shows the folder", async () => {
  const out = await runTool("forge_read", { op: "list", path: WORK }, ctx);
  assert.match(out, /hello\.txt/);
});

await t("forge_run runs a command and returns output", async () => {
  const cmd = process.platform === "win32" ? "Write-Output forge-run-ok" : "echo forge-run-ok";
  const out = await runTool("forge_run", { command: cmd }, ctx);
  assert.match(out, /forge-run-ok/);
});

await t("carve-out holds: forge_read on D:\\ is refused (not a bridge call)", async () => {
  const out = await runTool("forge_read", { op: "read", path: "D:\\backups\\corpus.db" }, ctx);
  assert.match(out, /Refused|carve-out|protected/i);
});

await t("carve-out holds: forge_write under app-backups is refused", async () => {
  const out = await runTool("forge_write", { path: join(WORK, "db-backups", "x"), content: "x" }, ctx);
  assert.match(out, /Refused|carve-out|protected/i);
});

await t("no hands node wired -> honest message, NO bridge reference", async () => {
  const out = await runTool("forge_write", { path: "/x", content: "y" }, {});   // ctx without .hands
  assert.match(out, /hands node/i);
  assert.doesNotMatch(out, /bridge|SYNC_SECRET/i);
});

await t("forge_send redirects to direct tools when hands present (no bridge)", async () => {
  const out = await runTool("forge_send", { repo: "x", title: "t", instructions: "do" }, ctx);
  assert.match(out, /forge_write|forge_run/);
});

try { rmSync(WORK, { recursive: true, force: true }); } catch {}
console.log(`\nforge_hands_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
