/*
 * scaffold_project self-test — run: node scaffold_test.mjs
 * Proves scaffold_project writes a whole file tree to the machine through the hands NODE (fs_write),
 * renders the tree, honours the carve-outs per file, and needs a connected node.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WORK = mkdtempSync(join(tmpdir(), "scaffold-"));
process.env.HANDS_ROOTS = WORK;                        // the node's allowed root (set before import)
const { executeJob } = await import("./hands/hands.mjs");
const { runTool } = await import("./tools.mjs");

const ctx = { hands: { dispatch: (tool, args) => executeJob(tool, args) } };
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const root = join(WORK, "my-app").replace(/\\/g, "/");

await t("scaffold_project writes a full tree and reports it", async () => {
  const out = await runTool("scaffold_project", { root, files: [
    { path: "package.json", content: '{"name":"my-app"}' },
    { path: "src/index.js", content: "console.log('hi');" },
    { path: "src/lib/util.js", content: "export const x = 1;" },
    { path: "README.md", content: "# my-app" },
  ] }, ctx);
  assert.match(out, /Scaffolded 4 file\(s\)/);
  assert.ok(existsSync(join(root, "package.json")));
  assert.equal(readFileSync(join(root, "src/lib/util.js"), "utf8"), "export const x = 1;");
});

await t("the report renders a real ASCII tree (dirs first, files nested)", async () => {
  const out = await runTool("scaffold_project", { root: join(WORK, "app2").replace(/\\/g, "/"), files: [
    { path: "src/index.js", content: "a" },
    { path: "src/api/handler.js", content: "b" },
    { path: "package.json", content: "{}" },
  ] }, ctx);
  assert.ok(out.includes("├──") || out.includes("└──"), "has tree branches");
  assert.ok(out.includes("src/"), "shows the src directory");
  assert.ok(out.includes("handler.js"), "shows a nested file");
});

await t("carve-out holds: a file under db-backups is refused, the rest still write", async () => {
  const r = join(WORK, "app3").replace(/\\/g, "/");
  const out = await runTool("scaffold_project", { root: r, files: [
    { path: "ok.txt", content: "fine" },
    { path: "db-backups/secret.txt", content: "nope" },
  ] }, ctx);
  assert.match(out, /1 file\(s\), 1 failed|Scaffolded 1 file/);
  assert.ok(existsSync(join(r, "ok.txt")));
  assert.ok(!existsSync(join(r, "db-backups", "secret.txt")), "carve-out blocked the backup path");
});

await t("no hands node wired -> honest message, no crash", async () => {
  const out = await runTool("scaffold_project", { root, files: [{ path: "x", content: "y" }] }, {});
  assert.match(out, /hands node/i);
});

await t("empty files array is rejected cleanly", async () => {
  const out = await runTool("scaffold_project", { root, files: [] }, ctx);
  assert.match(out, /files/i);
});

try { rmSync(WORK, { recursive: true, force: true }); } catch {}
console.log(`\nscaffold_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
