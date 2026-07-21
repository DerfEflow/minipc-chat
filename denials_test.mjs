/*
 * Forbidden-access log self-test - run with: node denials_test.mjs
 * Proves what Fred actually asked for: that a REFUSED attempt still leaves a trace, with enough
 * identity to tell one accident from a pattern, and without copying secrets into the log.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDenials, recordDenial, readDenials, denialSummary } from "./denials.mjs";

const dir = mkdtempSync(join(tmpdir(), "denials-"));
const { path } = initDenials({ dir });
let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };

// 1. a refusal is recorded even though nothing happened
recordDenial({ source: "app", tool: "forge_run", reason: "references a protected resource", args: { command: "dir D:\\db-backups" }, model: "claude-opus-4-8", user: "owner", role: "owner" });
assert.equal(existsSync(path), true, "the log file must exist after one denial");
let rows = readDenials({});
assert.equal(rows.length, 1);
assert.equal(rows[0].tool, "forge_run");
assert.equal(rows[0].model, "claude-opus-4-8");
assert.equal(rows[0].user, "owner");
ok("a failed attempt is still logged, with tool, model and user");

// 2. secrets in the attempted args do not reach the log
recordDenial({ source: "node", tool: "forge_write", reason: "carve-out", args: { path: "D:\\x", content: "password=hunter2 and token: abc123" }, user: "u_9" });
rows = readDenials({});
const blob = rows[rows.length - 1].args;
assert.ok(!/hunter2/.test(blob), "a password in the args must not land in the log");
assert.ok(!/abc123/.test(blob), "a token in the args must not land in the log");
assert.ok(/redacted/.test(blob), "it should say plainly that something was redacted");
ok("secrets in the attempted arguments are redacted");

// 3. oversized args are truncated rather than bloating the log
recordDenial({ source: "app", tool: "forge_write", reason: "carve-out", args: { content: "x".repeat(5000) }, user: "u_1" });
rows = readDenials({});
assert.ok(rows[rows.length - 1].args.length < 900, "args must be truncated");
ok("oversized arguments are truncated");

// 4. the summary answers the question that matters: one bump, or a pattern?
for (let i = 0; i < 12; i++) recordDenial({ source: "node", tool: "forge_run", reason: "carve-out", args: { command: "probe " + i }, user: "u_probe", model: "some-model" });
const s = denialSummary({ days: 7 });
assert.equal(s.total, 15);
assert.equal(s.byUser.u_probe, 12, "a repeat prober should stand out by count");
assert.equal(s.byTool.forge_run, 13);
assert.ok(s.bySource.node >= 13);
assert.ok(s.recent.length > 0 && s.recent.length <= 25);
ok("summary counts by tool, source, user and model");

// 5. the time window actually filters (a cutoff in the future excludes everything already written)
assert.equal(readDenials({ sinceMs: Date.now() + 60000 }).length, 0, "a future cutoff should exclude every existing row");
assert.equal(readDenials({ sinceMs: Date.now() - 60000 }).length, 15, "a one-minute window should include all 15");
ok("the reporting window filters by time");

// 6. a torn final line does not take the whole log down
const fs = await import("node:fs");
fs.appendFileSync(path, '{"at":"broken",');
rows = readDenials({});
assert.ok(rows.length >= 15, "a half-written line must be skipped, not fatal");
ok("a torn log line is skipped rather than fatal");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed}/6 checks passed - forbidden-access log verified`);
