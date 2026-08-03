/*
 * Pins the prompt-cache prefix invariant (SOW Phase 0, fix 2026-08-03) so it cannot silently
 * regress: turn N+1's request must be a byte-stable extension of turn N's, with the volatile
 * EXECUTION MANAGER directive riding only as the tail behind history.
 *
 * The defect this guards against sat in production from at least 07-19 to 08-03: the directive
 * (carrying the turn's goal) was concatenated into the SYSTEM message, so message zero changed on
 * every request and no provider ever cached a byte. Zero hits, app-wide, at DeepSeek's ~1/120th
 * cached-input price. One innocent `s += goal` anywhere ahead of history brings it back, which is
 * exactly the kind of edit that reads harmless in review.
 *
 * Delegates to cacheprefix_probe.mjs, which boots the REAL server against a local capture
 * endpoint and diffs the actual request bodies. Nothing reaches a provider; nothing is billed.
 * Heavier than a unit test, same weight as the other boot-the-server suites here, and the only
 * honest way to test bytes-on-the-wire: a unit test of a prompt HELPER cannot see an assembly-site
 * mistake, and the assembly site is where this bug lived.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(HERE, "cacheprefix_probe.mjs")], { encoding: "utf8", timeout: 150000 });
const out = String((r.stdout || "") + (r.stderr || ""));

if (r.status !== 0) {
  console.error(out.trim().split("\n").slice(-25).join("\n"));
  console.error("\ncacheprefix_test: FAILED — the prompt prefix churned (or the directive vanished); see above.");
  process.exit(1);
}
if (!/PREFIX STABLE/.test(out)) {
  console.error(out.trim().split("\n").slice(-25).join("\n"));
  console.error("\ncacheprefix_test: FAILED — probe exited 0 without declaring the prefix stable.");
  process.exit(1);
}
console.log("cacheprefix_test: turn 2 extends turn 1 byte-for-byte; the volatile directive rides only behind history");
