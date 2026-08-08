/*
 * Admin credit-adjustment self-test — run with: node admincredits_test.mjs
 *
 * Boots the REAL server.mjs (child processes, temp data dirs) because this is the one route in the
 * app that moves money by hand, and a source-regex test would prove nothing about whether the gate
 * actually holds under HTTP.
 *
 * POST /admin/user {adjustCredits} was a single unguarded line for most of this app's life: any
 * number went straight to the ledger under the fixed reason "admin adjust". These tests pin the
 * four guards added on 2026-08-08, plus the owner gate that was always there.
 *
 * Pass 1 (MULTI_TENANT=1, no owner identity): a non-owner cannot move credits at all.
 * Pass 2 (single-tenant, caller IS the owner): the four guards and a real balance move.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
function boot(port, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dominion-admincred-")); dirs.push(dir);
  const env = {
    ...process.env,
    PORT: String(port), DATA_DIR: join(dir, "data"),
    MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
    PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
    LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"),
    AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0",
    MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
    SYNC_SECRET: "test", RUN_PASSWORD: "",
    ...extra,
  };
  const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));
  return { child, logs: () => logs };
}
async function waitForBoot(port) {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => {
      const rq = http.get({ host: "127.0.0.1", port, path: "/toolruns" }, (rs) => { rs.resume(); r(rs.statusCode === 200); });
      rq.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
function post(port, path, body, headers = {}) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } },
      (rs) => { let b = ""; rs.on("data", (d) => (b += d));
                rs.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: rs.statusCode, body: j, raw: b }); }); });
    rq.on("error", reject); rq.end(payload);
  });
}
const adjust = (port, body) => post(port, "/admin/user", body);

console.log("admin credit adjustment");

/* ---- pass 1: a non-owner cannot move credits ------------------------------------------------- */
{
  const PORT = 18841;
  const srv = boot(PORT, { MULTI_TENANT: "1" });
  const up = await waitForBoot(PORT);
  await t("boots in multi-tenant mode", () => assert.ok(up, "server never came up:\n" + srv.logs().slice(-1200)));
  await t("a non-owner cannot move credits", async () => {
    const r = await adjust(PORT, { email: "victim@test.com", adjustCredits: 100000, createIfMissing: true });
    assert.equal(r.status, 403, "the owner gate is the one thing that must never slip, got " + r.status + " " + r.raw);
  });
  srv.child.kill();
}

/* ---- pass 2: the owner's own guards ---------------------------------------------------------- */
{
  const PORT = 18842;
  const srv = boot(PORT);
  const up = await waitForBoot(PORT);
  await t("boots single-tenant (caller is the owner)", () => assert.ok(up, "server never came up:\n" + srv.logs().slice(-1200)));

  await t("a credit move to an account that did not exist is refused", async () => {
    const r = await adjust(PORT, { email: "fred@gmial.com", adjustCredits: 100, reason: "typo test" });
    assert.equal(r.status, 400, r.raw);
    assert.match(String(r.body && r.body.error), /did not exist/i,
      "ensure() would have minted this account and put real credits on it");
  });

  await t("an extra zero is caught before it lands", async () => {
    const r = await adjust(PORT, { email: "big@test.com", adjustCredits: 500000, createIfMissing: true, reason: "oops" });
    assert.equal(r.status, 400, r.raw);
    assert.match(String(r.body && r.body.error), /confirm/i, "a large move must take two keys, not one");
  });

  await t("a large move goes through when confirmed", async () => {
    const r = await adjust(PORT, { email: "big@test.com", adjustCredits: 500000, createIfMissing: true, confirm: true, reason: "deliberate" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.credit.balance, 500000);
  });

  await t("a zero adjustment is refused rather than writing a meaningless ledger row", async () => {
    const r = await adjust(PORT, { email: "big@test.com", adjustCredits: 0, reason: "nothing" });
    assert.equal(r.status, 400);
  });

  await t("a real grant moves the balance and reports it in both units", async () => {
    const r = await adjust(PORT, { email: "grantee@test.com", adjustCredits: 500, createIfMissing: true, reason: "comped for the outage" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.credit.credits, 500);
    assert.equal(r.body.credit.usdValue, 5, "500 credits is $5 of token value");
    assert.equal(r.body.credit.balanceBefore, 0);
    assert.equal(r.body.credit.balance, 500, "the balance must actually move");
    assert.equal(r.body.credit.kind, "grant");
  });

  await t("the same idempotency key cannot grant twice", async () => {
    const req = { email: "idem@test.com", adjustCredits: 300, createIfMissing: true, reason: "double click", idempotencyKey: "abc-123" };
    const first = await adjust(PORT, req);
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.body.credit.balance, 300);
    const second = await adjust(PORT, req);
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.body.credit.replay, true, "a replayed key must be reported, not reapplied");
    assert.equal(second.body.credit.balance, 300, "the balance must NOT have moved twice");
  });

  await t("a negative correction is allowed and can never drive a balance negative", async () => {
    const email = "correct@test.com";
    await adjust(PORT, { email, adjustCredits: 200, createIfMissing: true, reason: "initial" });
    const back = await adjust(PORT, { email, adjustCredits: -50, reason: "over-granted, correcting" });
    assert.equal(back.status, 200, back.raw);
    assert.equal(back.body.credit.kind, "correction");
    assert.equal(back.body.credit.balance, 150);
    const under = await adjust(PORT, { email, adjustCredits: -9999, confirm: true, reason: "full clawback" });
    assert.equal(under.body.credit.balance, 0, "a balance must never go negative");
  });

  await t("adjustments persist to the ledger the automatic grants share", async () => {
    // Proven through the route's own reporting: the second call's balanceBefore can only equal the
    // first call's balance if the first was actually written and read back.
    const email = "ledger@test.com";
    const a = await adjust(PORT, { email, adjustCredits: 111, createIfMissing: true, reason: "first" });
    const b = await adjust(PORT, { email, adjustCredits: 222, reason: "second" });
    assert.equal(b.body.credit.balanceBefore, a.body.credit.balance, "the first grant did not persist");
    assert.equal(b.body.credit.balance, 333);
  });

  await t("the non-credit parts of the endpoint still work", async () => {
    // This route also manages role, status and sponsored cap. The credit guards must not have
    // turned it into a credits-only endpoint.
    const r = await adjust(PORT, { email: "roleonly@test.com", role: "sponsored", capUsd: 20 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.credit, null, "a call with no adjustCredits must report no credit movement");
  });

  srv.child.kill();
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
