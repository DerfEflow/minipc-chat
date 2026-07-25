/*
 * Training opt-out tests — run with: node --test optout_test.mjs
 * Fred's rule (2026-07-25): the consent notice carries a GENUINE opt-out. A checked box must sever
 * the training pipeline server-side; consent alone no longer implies collection. This pins the
 * tenancy flag and the exact gate expression meterTurn uses.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createUsersStore } from "./tenancy.mjs";

const dir = mkdtempSync(join(tmpdir(), "dominion-optout-test-"));
const users = createUsersStore({ dir, ownerEmail: "fred@example.com" });

test("opt-out flag: default off, settable, reversible, survives identify()", () => {
  users.ensure("guest@example.com");
  users.markConsented("guest@example.com");
  const t0 = users.identify({ dominionIdentity: { email: "guest@example.com" } });
  assert.equal(t0.consented, true);
  assert.equal(t0.trainingOptOut, false, "default: pipeline on after consent");
  users.setTrainingOptOut("guest@example.com", true);
  const t1 = users.identify({ dominionIdentity: { email: "guest@example.com" } });
  assert.equal(t1.trainingOptOut, true, "flag persists and rides identify()");
  users.setTrainingOptOut("guest@example.com", false);
  assert.equal(users.identify({ dominionIdentity: { email: "guest@example.com" } }).trainingOptOut, false, "reversible by the user's own choice");
});

test("the pipeline gate: consented alone is NOT enough once opted out", () => {
  users.ensure("optout@example.com");
  users.markConsented("optout@example.com");
  users.setTrainingOptOut("optout@example.com", true);
  const T = users.identify({ dominionIdentity: { email: "optout@example.com" } });
  // The exact expression meterTurn uses to guard trainingSinkRecord:
  const pipelineFeeds = !!(T.consented && !T.trainingOptOut);
  assert.equal(pipelineFeeds, false, "a consented-but-opted-out user must never feed the sink");
});

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
