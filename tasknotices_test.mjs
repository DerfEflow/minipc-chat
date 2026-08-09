/*
 * Task notices self-test — run with: node tasknotices_test.mjs
 *
 * The delivery half of the concurrent-work spec: a task that finishes while you are on another
 * screen has to come find you, once, with a button back to where it came from.
 *
 * Two parts. A booted server proves the HTTP contract and that the driver is actually running
 * (built-but-never-started is exactly the bug this file exists to catch). Source guards pin the
 * properties that only exist as code shape: payload-free push, seen-is-not-notified, and a deep
 * link that cannot become an open redirect.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
}
const dirs = [];

console.log("task notices");

/* ---- the live contract ----------------------------------------------------------------------- */
{
  const PORT = 18851;
  const dir = mkdtempSync(join(tmpdir(), "dominion-notices-")); dirs.push(dir);
  const env = {
    ...process.env, PORT: String(PORT), DATA_DIR: join(dir, "data"),
    MEMORY_DIR: join(dir, "m"), CHATLOG_DIR: join(dir, "c"), ARTIFACT_DIR: join(dir, "a"),
    PERSONA_DIR: join(dir, "p"), PERSONA_STAGING: join(dir, "s"), FLYWHEEL_DIR: join(dir, "f"),
    LOG_DIR: join(dir, "l"), SANDBOX_DIR: join(dir, "sb"),
    AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", SYNC_SECRET: "t", RUN_PASSWORD: "",
  };
  const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const get = (path) => new Promise((resolve, reject) => {
    const rq = http.get({ host: "127.0.0.1", port: PORT, path, headers: { accept: "application/json" } }, (rs) => {
      let b = ""; rs.on("data", (d) => (b += d));
      rs.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: rs.statusCode, body: j, raw: b }); });
    });
    rq.on("error", reject);
  });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/toolruns" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }

  await t("the server boots with the kernel and driver wired", () => {
    assert.ok(up, "server never came up:\n" + log.slice(-1200));
  });
  await t("the driver actually STARTS (built-but-never-started is the bug this catches)", () => {
    assert.match(log, /taskdriver: started/, "the driver was constructed but never started:\n" + log.slice(-800));
  });
  await t("/tasks/notices answers with both the actionable set and the running set", async () => {
    const r = await get("/tasks/notices");
    assert.equal(r.status, 200, r.raw);
    assert.ok(Array.isArray(r.body.unseen), "unseen must be a list");
    assert.ok(Array.isArray(r.body.live), "live must be a list, so the UI can show context without implying action");
  });
  child.kill();
}

/* ---- properties that live in the code's shape ------------------------------------------------ */
await t("the push carries no content of its own", () => {
  const sw = readFileSync(join(HERE, "public", "sw.js"), "utf8");
  const push = sw.slice(sw.indexOf('addEventListener("push"'), sw.indexOf('addEventListener("notificationclick"'));
  assert.ok(push.length > 200, "failed to isolate the push handler");
  // The wakeup must not be trusted for text. Everything shown is fetched fresh, which is what
  // stops a result already read on the laptop from buzzing the phone a minute later.
  assert.match(push, /fetch\("\/tasks\/notices"/, "the worker must ask the server what is outstanding");
  assert.ok(!/e\.data\.json\(\)|event\.data\.text\(\)/.test(push),
    "the notification text must never come from the push payload");
  assert.match(push, /postMessage\(\{ type: "tasks-changed" \}\)/,
    "open tabs must be told to refresh, or the card and the system notice can disagree");
});

await t("seen and notified are kept apart", () => {
  const server = readFileSync(join(HERE, "server.mjs"), "utf8");
  const seen = server.slice(server.indexOf("async function handleTaskSeen"));
  const body = seen.slice(0, seen.indexOf("\nfunction "));
  assert.match(body, /markSeen/, "acknowledging must record that the user LOOKED");
  assert.ok(!/markNotified/.test(body), "acknowledging must not be confused with having sent a push");
  // Acknowledging is a write, so it must not cross an account boundary.
  assert.match(body, /T\.isOwner \|\| row\.uid === T\.uid/, "a user must not be able to acknowledge another's notice");
});

await t("the deep link cannot become an open redirect", () => {
  const src = readFileSync(join(HERE, "public", "dominion-task-notices.js"), "utf8");
  assert.match(src, /u\.origin === location\.origin/, "a notice must only ever navigate same-origin");
  assert.match(src, /notice\.href/, "the destination comes from the server's own record");
  // Dismissing has to reach the server, or the card returns on the next poll and nags forever.
  assert.match(src, /fetch\("\/tasks\/seen"/, "dismissing must persist, not just remove a node");
});

await t("notices are surface-agnostic, so a new task kind needs no edit here", () => {
  const src = readFileSync(join(HERE, "public", "dominion-task-notices.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const kind of ["simplify", "video", "image", "build"]) {
    assert.ok(!new RegExp(`["']${kind}["']`).test(code),
      `the notice renderer must not special-case "${kind}" — it renders whatever the server sends`);
  }
});

await t("the notice module is actually loaded by the app", () => {
  const html = readFileSync(join(HERE, "public", "index.html"), "utf8");
  assert.match(html, /dominion-task-notices\.js/, "a popup nobody includes is a popup nobody sees");
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
