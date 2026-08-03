import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVideoMeter } from "./video-meter.mjs";

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
