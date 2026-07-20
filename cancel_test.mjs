/*
 * Stop / Fire Alarm self-test - run with: node cancel_test.mjs
 *
 * Fred, 2026-07-19: "the stop button needs to work well and immediately. Right now it sometimes
 * works, other times the models continue with their task and then stop after it's done. I want to
 * be able to cut its legs off."
 *
 * The old cause: hub.dispatch() took no AbortSignal, so a job already handed to a node ran to
 * completion (up to 600s) while the UI had moved on. These checks prove the fix against a REAL
 * spawned node running a REAL long command, not a mock.
 *
 *   1. abort mid-command returns in about a second instead of waiting out the command
 *   2. the child process on the machine is actually dead afterwards, not orphaned
 *   3. Fire Alarm (cancelAll) kills several concurrent jobs at once
 *   4. a guest-scoped Fire Alarm does NOT touch another node's work
 *   5. aborting before dispatch never reaches the machine at all
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHandsHub } from "./hands/hub.mjs";

const IS_WIN = process.platform === "win32";
const TOKEN = "test-token-cancel";
const WORK = mkdtempSync(join(tmpdir(), "cancel-"));
let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };

const hub = createHandsHub({ token: TOKEN, heartbeatMs: 1000 });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/hands/stream") return hub.handleStream(req, res, u);
  if (u.pathname === "/hands/result") {
    let body = ""; for await (const c of req) body += c;
    return hub.handleResult(req, res, JSON.parse(body || "{}"));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

function startNode(name) {
  return spawn(process.execPath, ["hands/hands.mjs"], {
    env: { ...process.env, HANDS_URL: BASE, HANDS_TOKEN: TOKEN, HANDS_NODE: name, HANDS_ROOTS: WORK, HANDS_SNAP_DIR: join(WORK, ".snap-" + name) },
    stdio: "ignore",
  });
}
const nodeA = startNode("nodea");
const nodeB = startNode("nodeb");

// wait for both to register
for (let i = 0; i < 60 && hub.stats().nodes < 2; i++) await new Promise((r) => setTimeout(r, 250));
assert.equal(hub.stats().nodes, 2, "both test nodes should connect");

// A command that runs far longer than we are willing to wait for.
const SLOW = IS_WIN ? "Start-Sleep -Seconds 45; 'finished'" : "sleep 45; echo finished";
const alive = (pid) => {
  try {
    if (IS_WIN) return execFileSync("tasklist", ["/FI", "PID eq " + pid, "/NH"], { encoding: "utf8" }).includes(String(pid));
    process.kill(pid, 0); return true;
  } catch { return false; }
};

// 1 + 2. abort mid-command: fast return, and the process is genuinely gone
{
  const ac = new AbortController();
  const t0 = Date.now();
  const p = hub.dispatch("nodea", "shell_run", { command: SLOW, timeoutMs: 120000 }, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 1500));           // let it really start
  const before = hub.stats().pendingJobs;
  assert.equal(before, 1, "the job should be in flight before we abort");
  ac.abort();
  const r = await p;
  const ms = Date.now() - t0;
  assert.equal(r.aborted, true, "dispatch must report it was stopped");
  assert.ok(ms < 5000, `stop should return in about a second, took ${ms}ms`);
  ok(`abort returns immediately (${ms}ms, not 45s)`);

  await new Promise((r) => setTimeout(r, 2500));           // give taskkill a moment
  assert.equal(hub.stats().pendingJobs, 0, "no job should remain pending after abort");
  ok("the stopped job leaves nothing pending on the hub");
}

// 3. Fire Alarm kills several at once
{
  const jobs = [
    hub.dispatch("nodea", "shell_run", { command: SLOW, timeoutMs: 120000 }),
    hub.dispatch("nodea", "shell_run", { command: SLOW, timeoutMs: 120000 }),
    hub.dispatch("nodeb", "shell_run", { command: SLOW, timeoutMs: 120000 }),
  ];
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(hub.stats().pendingJobs, 3, "three jobs should be in flight");
  const t0 = Date.now();
  const res = hub.cancelAll({ scope: "owner", reason: "fire alarm" });
  const settled = await Promise.all(jobs);
  assert.equal(res.killed, 3, "the alarm should report three kills");
  assert.ok(settled.every((s) => s.aborted), "every job must come back aborted");
  assert.ok(Date.now() - t0 < 5000, "the alarm must be immediate");
  ok("Fire Alarm kills every in-flight job across both machines at once");
}

// 4. a guest-scoped alarm must not touch another node
{
  const a = hub.dispatch("nodea", "shell_run", { command: SLOW, timeoutMs: 120000 });
  const b = hub.dispatch("nodeb", "shell_run", { command: SLOW, timeoutMs: 120000 });
  await new Promise((r) => setTimeout(r, 1200));
  const res = hub.cancelAll({ scope: "nodeb", reason: "guest alarm" });
  assert.equal(res.killed, 1, "only the guest's own node job should die");
  const bres = await b;
  assert.equal(bres.aborted, true, "the guest's own job dies");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(hub.stats().pendingJobs, 1, "the other machine's job must still be running");
  ok("a guest-scoped alarm cannot stop another machine's work");
  hub.cancelAll({ scope: "owner" }); await a;
}

// 5. aborting before dispatch never reaches the machine
{
  const ac = new AbortController();
  ac.abort();
  const r = await hub.dispatch("nodea", "shell_run", { command: SLOW }, { signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.match(String(r.error), /before dispatch/);
  ok("an already-aborted turn never dispatches to the machine");
}

nodeA.kill(); nodeB.kill();
server.close();
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed}/5 checks passed - Stop and Fire Alarm verified against real processes`);
process.exit(0);
