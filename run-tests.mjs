/*
 * The test gate (Kimi: "you need a mechanical backstop for the days discipline is tired").
 * Runs every *_test.mjs in this directory sequentially and exits non-zero if ANY fails, so a red
 * test can block a deploy. Run: node run-tests.mjs   (or: npm test)
 *
 * Zero deps, sync spawn, honest tail on failure. Deliberately NOT parallel: some suites boot a
 * real server on a port and would collide.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * The gate scanned ONLY this directory, so hands/*_test.mjs never ran and could never block a
 * deploy. The hands node is where the 2026-07-22 F:\ baseline incident happened — an empty snapshot
 * reported as a real rollback point — which makes it precisely the code that most needs the
 * mechanical backstop. Subdirectories holding real modules are scanned too.
 */
const TEST_DIRS = ["", "hands"];
const files = TEST_DIRS.flatMap((sub) => {
  let names = [];
  try { names = readdirSync(sub ? join(HERE, sub) : HERE); } catch { return []; }
  return names.filter((n) => n.endsWith("_test.mjs")).map((n) => (sub ? sub + "/" + n : n));
}).sort();

let passed = 0, failed = 0;
const failures = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(HERE, f)], { encoding: "utf8", timeout: 180000 });
  if (r.status === 0) { passed++; console.log("PASS " + f); }
  else {
    failed++; failures.push(f);
    console.log("FAIL(" + r.status + ") " + f);
    const tail = String((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-8);
    for (const line of tail) console.log("    " + line);
  }
}
console.log("\n" + passed + " suites passed, " + failed + " failed" + (failures.length ? " (" + failures.join(", ") + ")" : ""));
process.exit(failed ? 1 : 0);
