/*
 * The second wire.
 *
 * Fred was ready to retire BATTALION after a turn died with "Couldn't reach NVIDIA (direct): read
 * ETIMEDOUT", on the reasonable theory that a free lane is an unreliable lane. The endpoint was up:
 * probed from the production container minutes later, /v1/models answered 200 in 109ms and both
 * flagship seats answered 200 in under half a second.
 *
 * The defect was that the roster is five apparent vendors on ONE HOST, and the in-module
 * "replacement" for a dead seat changes the model name and posts it to the host that just timed out.
 *
 * This file guards the fix, and most of it guards the ways the fix could be worse than the bug:
 * billing a lane advertised as free, printing two answers over each other, or retrying a stop.
 */
import assert from "node:assert/strict";
import { createSeatFailover } from "./seatfailover.mjs";
import { createBattalion } from "./battalion.mjs";
import { BATTALION_FAILOVER, BATTALION_ROSTER, battalionRosterIds, modelById } from "./models.catalog.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  ok  " + name); passed++; };

const DEAD = { ok: false, retryable: true, error: "Couldn't reach NVIDIA (direct): read ETIMEDOUT. Try again, or pick a model from another provider." };
const transportDeath = (r) => !!(r && r.retryable);
const mk = (over = {}) => createSeatFailover({
  call: over.call, map: over.map || { "seat-a": "seat-a:free" },
  keyPresent: over.keyPresent || (() => true),
  isTransportDeath: over.isTransportDeath || transportDeath,
  log: () => {},
});

/* ---- the map itself: the $0 invariant, which is the money-safe part ---- */

await t("every roster seat has a second wire", () => {
  for (const id of new Set(battalionRosterIds())) {
    assert.ok(BATTALION_FAILOVER[id], id + " has no failover route; a bad minute on one host kills it");
  }
});

await t("every failover route is a $0 route", () => {
  /*
   * THE LOAD-BEARING TEST. Measured against OpenRouter 2026-08-09: gpt-oss-20b, ultra-550b,
   * glm-5.2 and minimax-m3 are all PAID under their bare ids. A reroute onto any of them would bill
   * Fred on a lane whose own failure message reads "Nothing was billed", and nothing downstream
   * would catch it, because BATTALION never touches the meter by design. ":free" is OpenRouter's
   * guarantee of a zero-cost route, so it is the invariant asserted rather than a price table that
   * would go stale.
   */
  for (const [seat, alt] of Object.entries(BATTALION_FAILOVER)) {
    assert.ok(alt.endsWith(":free"), seat + " fails over to " + alt + ", which is not a $0 route");
  }
});

await t("a failover route never points back at the wire that just died", () => {
  // Mapping a seat to a DIFFERENT model on the same host is the bug, not the fix. Same id is fine
  // (it is re-posted to another host); a different id that is not a $0 route is not.
  for (const [seat, alt] of Object.entries(BATTALION_FAILOVER)) {
    if (alt === seat) continue;
    const rec = modelById(alt);
    if (rec) assert.equal((rec.inCost || 0) + (rec.outCost || 0), 0, alt + " is priced in the catalog");
  }
});

/* ---- the wrapper: when it fires, and far more importantly when it does not ---- */

await t("a working seat is returned untouched, with no second call", async () => {
  const calls = [];
  const f = mk({ call: async (id) => { calls.push(id); return { ok: true, content: "fine" }; } });
  const r = await f("seat-a", [], {}, null);
  assert.deepEqual(calls, ["seat-a"]);
  assert.equal(r.content, "fine");
  assert.ok(!r.failoverTo, "a healthy call must not be labelled a failover");
});

await t("a transport death is retried once, on the other wire, with the mapped route", async () => {
  const calls = [];
  const f = mk({ call: async (id, m, opts) => { calls.push([id, opts.__forceProvider || null]); return calls.length === 1 ? DEAD : { ok: true, content: "answered" }; } });
  const r = await f("seat-a", [], { num_predict: 100 }, null);
  assert.deepEqual(calls, [["seat-a", null], ["seat-a:free", "openrouter"]]);
  assert.equal(r.content, "answered");
  assert.equal(r.failoverFrom, "seat-a");
  assert.equal(r.failoverTo, "seat-a:free");
});

await t("ONE alternate wire, never a retry loop", async () => {
  let n = 0;
  const f = mk({ call: async () => { n++; return DEAD; } });
  await f("seat-a", [], {}, null);
  assert.equal(n, 2, "expected the original call and exactly one failover, got " + n);
});

await t("a partial answer is NEVER retried, or the user reads two answers at once", async () => {
  /*
   * The first wire streamed real text through onDelta before dying, so those words are already on
   * screen. A second call would stream a different answer underneath the first. Losing a tail is
   * bad; printing two answers over each other is worse, and it is exactly the class of mess that
   * reached Fred twice today.
   */
  const calls = [];
  const f = mk({ call: async (id) => { calls.push(id); return { ...DEAD, content: "half an answer that already streamed" }; } });
  const r = await f("seat-a", [], {}, null);
  assert.deepEqual(calls, ["seat-a"], "a partially streamed answer must not be re-posted");
  assert.match(r.content, /half an answer/);
});

await t("a stop is not a failure and summons nothing", async () => {
  const calls = [];
  const f = mk({ call: async (id) => { calls.push(id); return { ok: false, aborted: true, error: "stopped" }; } });
  await f("seat-a", [], {}, null);
  assert.deepEqual(calls, ["seat-a"]);
  // Same for a signal that aborted without the flag coming back on the result.
  const calls2 = [];
  const f2 = mk({ call: async (id) => { calls2.push(id); return DEAD; } });
  await f2("seat-a", [], { signal: { aborted: true } }, null);
  assert.deepEqual(calls2, ["seat-a"], "an aborted turn must not open a call on another host");
});

await t("a non-transport failure is not retried, because the other host says the same thing", async () => {
  const calls = [];
  const f = mk({ call: async (id) => { calls.push(id); return { ok: false, status: 400, error: "invalid request: tools too long" }; } });
  const r = await f("seat-a", [], {}, null);
  assert.deepEqual(calls, ["seat-a"]);
  assert.match(r.error, /invalid request/);
});

await t("an unmapped seat, or a missing key, fails the way it always did", async () => {
  const calls = [];
  const f = mk({ call: async (id) => { calls.push(id); return DEAD; } });
  await f("seat-unmapped", [], {}, null);
  assert.deepEqual(calls, ["seat-unmapped"], "no route means no second call");
  const calls2 = [];
  const f2 = mk({ keyPresent: () => false, call: async (id) => { calls2.push(id); return DEAD; } });
  await f2("seat-a", [], {}, null);
  assert.deepEqual(calls2, ["seat-a"], "no OpenRouter key means no second wire to use");
});

await t("both wires down reports the ORIGINAL death, and names the backup's", async () => {
  const f = mk({ call: async (id) => (id === "seat-a" ? DEAD : { ok: false, retryable: true, error: "OpenRouter: 502 bad gateway" }) });
  const r = await f("seat-a", [], {}, null);
  assert.ok(!r.ok);
  assert.match(r.error, /ETIMEDOUT/, "the lane the user chose is the one that died first");
  assert.match(r.error, /backup wire also failed/, "the log must not imply we only tried once");
  assert.match(r.error, /502 bad gateway/);
  assert.equal(r.failoverTried, "seat-a:free");
});

/* ---- and the manifest, because a downgrade the user cannot see is a lie ---- */

await t("a seat answered on the backup wire says so in the manifest", async () => {
  const ROSTER = { assess: "s-assess", orchestrator: "s-orch", synthesizer: "s-synth", single: "s-single", workers: ["s-single", "s-w2"] };
  const callSeat = async (id) => (id === ROSTER.single
    ? { ok: true, content: "the answer", failoverFrom: "s-single", failoverTo: "s-other:free" }
    : { ok: true, content: "x" });
  const battalion = createBattalion({ callSeat, roster: ROSTER });
  const r = await battalion.run({ question: "a short question" });
  assert.ok(r.ok);
  assert.ok(r.manifest.notes.some((n) => /could not be reached on its own wire/.test(n)),
    "a wire change must be announced: " + JSON.stringify(r.manifest.notes));
  assert.ok(r.manifest.notes.some((n) => /a different model than the seat calls for/.test(n)),
    "substituting a different model is a downgrade and must say so");
});

await t("a seat that reached its own wire adds no note", async () => {
  const ROSTER = { assess: "s-assess", orchestrator: "s-orch", synthesizer: "s-synth", single: "s-single", workers: ["s-single", "s-w2"] };
  const battalion = createBattalion({ callSeat: async () => ({ ok: true, content: "the answer" }), roster: ROSTER });
  const r = await battalion.run({ question: "a short question" });
  assert.ok(r.ok);
  assert.ok(!r.manifest.notes.some((n) => /wire/.test(n)), "a healthy run must not claim a failover");
});

console.log(`\nbattalion_failover: ${passed} passed, 0 failed`);
