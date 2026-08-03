import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVideoMeter } from "./video-meter.mjs";

const repairConfirmation = (action, settlementKey) => action === "mark_settled"
  ? `MARK_SETTLED ${settlementKey} OPERATOR_VERIFIED_CHARGE_OCCURRED`
  : `RETRY_NOT_CHARGED ${settlementKey} OPERATOR_VERIFIED_NO_CHARGE`;

test("a completed Runware job is charged at most once across meter restarts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-meter-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const charges = []; const tenant = { uid: "tenant_a", email: "a@example.test" };
  const first = createVideoMeter({ dir, charge: async (...args) => { charges.push(args); return { ok: true }; } });
  const a = await first.settle(tenant, .18, { jobId: "job_123", provider: "runware", kind: "video_generation" }); first.close();
  const second = createVideoMeter({ dir, charge: async (...args) => { charges.push(args); return { ok: true }; } });
  const b = await second.settle(tenant, .18, { jobId: "job_123", provider: "runware", kind: "video_generation" }); second.close();
  assert.equal(a.settled, true); assert.equal(b.already, true); assert.equal(charges.length, 1);
});

test("a claimed settlement never auto-retries after an ambiguous charge failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-meter-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let charges = 0; const meter = createVideoMeter({ dir, charge: async () => { charges++; throw new Error("ledger unavailable"); } });
  await assert.rejects(meter.settle({ uid: "tenant_a" }, .1, { jobId: "job_456" }), /ledger unavailable/);
  await assert.rejects(meter.settle({ uid: "tenant_a" }, .1, { jobId: "job_456" }), (error) => error.code === "VIDEO_SETTLEMENT_REPAIR_REQUIRED"); meter.close();
  assert.equal(charges, 1);
});

test("a failure explicitly known to precede charging can be retried safely", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-meter-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let charges = 0; const meter = createVideoMeter({ dir, charge: async () => { charges++; if (charges === 1) { const error = new Error("top-up unavailable"); error.safeToRetry = true; throw error; } return { ok: true }; } });
  await assert.rejects(meter.settle({ uid: "tenant_a" }, .1, { jobId: "job_789" }), /top-up unavailable/);
  const settled = await meter.settle({ uid: "tenant_a" }, .1, { jobId: "job_789" }); meter.close();
  assert.equal(settled.settled, true); assert.equal(charges, 2);
});

test("an operator can mark a held charge settled without charging again, including after restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-meter-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tenant = { uid: "tenant_operator_mark" }; const metadata = { billingId: "provider_generation_mark", provider: "openrouter", kind: "video_screenwrite" };
  let charges = 0;
  const first = createVideoMeter({ dir, charge: async () => { charges++; throw new Error("ledger failure containing a private diagnostic"); } });
  await assert.rejects(first.settle(tenant, .27, metadata), /ledger failure/);

  const held = first.listHeld();
  assert.equal(held.length, 1); assert.equal(held[0].status, "failed"); assert.equal(held[0].hasRecordedError, true);
  assert.equal(Object.hasOwn(held[0], "error"), false);
  assert.equal(JSON.stringify(held).includes("private diagnostic"), false);
  const settlementKey = held[0].settlementKey;
  assert.deepEqual(first.inspect(settlementKey), held[0]);

  assert.throws(() => first.repair({ settlementKey, action: "mark_settled", confirmation: "MARK_SETTLED" }), (error) => error.code === "VIDEO_SETTLEMENT_REPAIR_CONFIRMATION_REQUIRED");
  assert.equal(first.inspect(settlementKey).status, "failed");
  const repaired = first.repair({ settlementKey, action: "mark_settled", confirmation: repairConfirmation("mark_settled", settlementKey) });
  assert.equal(repaired.changed, true); assert.equal(repaired.settlement.status, "settled"); assert.equal(charges, 1);
  const repeated = first.repair({ settlementKey, action: "mark_settled", confirmation: repairConfirmation("mark_settled", settlementKey) });
  assert.equal(repeated.changed, false); assert.equal(repeated.already, true); assert.equal(charges, 1);
  assert.throws(() => first.repair({ settlementKey, action: "retry_not_charged", confirmation: repairConfirmation("retry_not_charged", settlementKey) }), (error) => error.code === "VIDEO_SETTLEMENT_ALREADY_SETTLED");
  first.close();

  const second = createVideoMeter({ dir, charge: async () => { charges++; return { ok: true }; } });
  const afterRestart = await second.settle(tenant, .27, metadata);
  assert.equal(afterRestart.already, true); assert.equal(charges, 1); assert.deepEqual(second.listHeld(), []);
  second.close();
});

test("an operator-verified uncharged claim can be released and retried after restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-meter-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tenant = { uid: "tenant_operator_retry" }; const metadata = { billingId: "provider_generation_retry", provider: "openrouter", kind: "video_screenwrite" };
  let charges = 0;
  const first = createVideoMeter({ dir, charge: async () => { charges++; throw new Error("operator must verify this did not charge"); } });
  await assert.rejects(first.settle(tenant, .31, metadata), /operator must verify/);
  const settlementKey = first.listHeld()[0].settlementKey;

  assert.throws(() => first.repair({ settlementKey, action: "retry_not_charged", confirmation: repairConfirmation("mark_settled", settlementKey) }), (error) => error.code === "VIDEO_SETTLEMENT_REPAIR_CONFIRMATION_REQUIRED");
  assert.throws(() => first.repair({ settlementKey, action: "delete", confirmation: "anything" }), (error) => error.code === "VIDEO_SETTLEMENT_REPAIR_ACTION_INVALID");
  assert.throws(() => first.repair(null), (error) => error.code === "VIDEO_SETTLEMENT_REPAIR_ACTION_INVALID");
  assert.throws(() => first.inspect(` ${settlementKey}`), (error) => error.code === "VIDEO_SETTLEMENT_KEY_INVALID");
  assert.equal(first.inspect(settlementKey).status, "failed"); assert.equal(charges, 1);

  const released = first.repair({ settlementKey, action: "retry_not_charged", confirmation: repairConfirmation("retry_not_charged", settlementKey) });
  assert.equal(released.removed, true); assert.equal(released.previousStatus, "failed"); assert.equal(first.inspect(settlementKey), null); assert.equal(charges, 1);
  first.close();

  const second = createVideoMeter({ dir, charge: async () => { charges++; return { ok: true }; } });
  const retried = await second.settle(tenant, .31, metadata);
  assert.equal(retried.settled, true); assert.equal(charges, 2);
  second.close();
});

test("operator repair refuses a settlement that is still charging in this process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dominion-video-meter-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let finishCharge; let started;
  const charging = new Promise((resolve) => { started = resolve; });
  const meter = createVideoMeter({ dir, charge: async () => { started(); return new Promise((resolve) => { finishCharge = resolve; }); } });
  const pending = meter.settle({ uid: "tenant_active_repair" }, .19, { billingId: "provider_generation_active" });
  await charging;
  const held = meter.listHeld(); assert.equal(held.length, 1); assert.equal(held[0].status, "pending");
  const settlementKey = held[0].settlementKey;
  assert.throws(() => meter.repair({ settlementKey, action: "mark_settled", confirmation: repairConfirmation("mark_settled", settlementKey) }), (error) => error.code === "VIDEO_SETTLEMENT_ACTIVE");
  finishCharge({ ok: true }); await pending;
  meter.close();
});
