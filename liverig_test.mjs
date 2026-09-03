/*
 * ops/live-rig.mjs default-workspace test (2026-09-03, foundry lane, DEFICIENCIES.md #27 tooling
 * half, LANE-foundry.md item 4). ops/live-rig.mjs cannot be imported and exercised directly here:
 * it is a script with top-level side effects that spawns real child processes and dials out the
 * moment it loads. This is a static/textual check instead -- it reads the source and asserts the
 * default workspace path is no longer the permanently-retired Z: drive and IS the standing F:
 * sandbox, and that the env override (LIVE_RIG_WORKSPACE) is still respected first.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const src = readFileSync(join(HERE, "ops", "live-rig.mjs"), "utf8");

t("the default workspace is no longer the dead Z: drive", () => {
  assert.equal(/Z:\\\\?dominion-livetest/i.test(src), false, "found a Z:\\dominion-livetest literal in ops/live-rig.mjs -- Z: died 2026-08-03 and is permanently retired");
});

t("the default workspace falls under F:\\Claude Sandbox\\dominion-livetest", () => {
  assert.match(src, /WORKSPACE\s*=\s*process\.env\.LIVE_RIG_WORKSPACE\s*\|\|\s*"F:\\\\Claude Sandbox\\\\dominion-livetest"/,
    "expected WORKSPACE = process.env.LIVE_RIG_WORKSPACE || \"F:\\\\Claude Sandbox\\\\dominion-livetest\"");
});

t("LIVE_RIG_WORKSPACE still overrides the default (env wins, same as every other lane's rig)", () => {
  assert.match(src, /process\.env\.LIVE_RIG_WORKSPACE\s*\|\|/, "the env var must be checked BEFORE the F: default, not replaced by it");
});

console.log(`\nlive-rig default-path suite: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
