/*
 * A supplied plan skips the orchestrator, and a bad one degrades instead of breaking.
 *
 * WHY A SUPPLIED PLAN AT ALL. Battalion pays an orchestrator seat every complex turn to invent a
 * split, and that call can fail outright ("orchestrator unreachable; single seat answered"). A
 * blueprint that declares a fan-out already HAS the split, designed rather than invented, so the
 * call is waste. This proves the skip actually happens by counting seat calls, not by reading code.
 *
 * WHAT MUST NOT HAPPEN. A blueprint's step SEQUENCE must never become the parts. Steps are a
 * pipeline - 162 of the catalog's 285 reference a prior step's output - and battalion's workers run
 * in parallel without coordinating, so a pipeline handed to it would have every downstream worker
 * inventing the input its predecessor never delivered. Only the one declared fan-out step travels.
 */
import assert from "node:assert/strict";
import { createBattalion, normalizePlan } from "./battalion.mjs";
import { blueprintParts, blueprintFanoutStep, BLUEPRINTS } from "./blueprints.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  ok  " + name); passed++; };

const ROSTER = {
  assess: "seat-assess", orchestrator: "seat-orch", synthesizer: "seat-synth",
  single: "seat-single", workers: ["seat-w1", "seat-w2", "seat-w3", "seat-w4"],
};

// A fake bench that records every seat it is asked for, so "was the orchestrator called" is a fact.
function bench() {
  const calls = [];
  const callSeat = async (catalogId, messages, opts, onDelta) => {
    calls.push(catalogId);
    if (catalogId === ROSTER.assess) return { ok: true, content: "COMPLEX" };
    if (catalogId === ROSTER.orchestrator) {
      return { ok: true, content: JSON.stringify({ parts: [
        { title: "Invented A", instructions: "a".repeat(60) },
        { title: "Invented B", instructions: "b".repeat(60) },
      ] }) };
    }
    if (catalogId === ROSTER.synthesizer) { onDelta && onDelta("merged"); return { ok: true, content: "merged answer" }; }
    return { ok: true, content: "part output from " + catalogId };
  };
  return { calls, callSeat };
}

const QUESTION = "Review this pull request thoroughly across every dimension. ".repeat(6);

await t("a supplied plan skips BOTH the sizing and orchestrator seats", async () => {
  const b = bench();
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: QUESTION, plan: blueprintParts("code-review") });
  assert.ok(r.ok);
  assert.ok(!b.calls.includes(ROSTER.orchestrator), "orchestrator was called despite a supplied plan");
  assert.ok(!b.calls.includes(ROSTER.assess), "sizing seat was called despite a supplied plan");
  assert.equal(r.manifest.mode, "swarm");
  assert.equal(r.manifest.parts, 4, "code-review declares four lenses");
  assert.ok(r.manifest.notes.some((n) => /plan supplied by the caller/.test(n)),
    "a supplied plan must be announced in the manifest, never silent");
});

await t("without a plan, the orchestrator still runs exactly as before", async () => {
  const b = bench();
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: QUESTION });
  assert.ok(r.ok);
  assert.ok(b.calls.includes(ROSTER.orchestrator), "the orchestrator must still plan an unsupplied turn");
  assert.equal(r.manifest.parts, 2, "the invented plan's two parts should be used");
});

await t("a malformed plan degrades to the orchestrator instead of breaking the turn", async () => {
  for (const bad of [[], [{ title: "only one", instructions: "x".repeat(60) }], "not an array",
                     [{ title: "", instructions: "" }, { title: "", instructions: "" }]]) {
    const b = bench();
    const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
    const r = await battalion.run({ question: QUESTION, plan: bad });
    assert.ok(r.ok, "a bad plan must not fail the turn");
    assert.ok(b.calls.includes(ROSTER.orchestrator), "a rejected plan must fall back to the orchestrator");
    assert.ok(r.manifest.notes.some((n) => /rejected as malformed/.test(n)),
      "a rejected plan must say so in the manifest");
  }
});

await t("normalizePlan holds a supplied plan to the same bounds as the orchestrator's own output", () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan([{ title: "a", instructions: "x".repeat(60) }]), null, "one part is below the minimum");
  const five = Array.from({ length: 5 }, (_, i) => ({ title: "t" + i, instructions: "x".repeat(60) }));
  assert.equal(normalizePlan(five), null, "five parts is above the maximum");
  const ok = normalizePlan([{ title: "a", instructions: "x".repeat(60) }, { title: "b", instructions: "y".repeat(60) }]);
  assert.equal(ok.length, 2);
  const long = normalizePlan([{ title: "t".repeat(500), instructions: "x".repeat(9000) },
                              { title: "b", instructions: "y".repeat(60) }]);
  assert.equal(long[0].title.length, 160, "titles clamp exactly as extractPlan clamps them");
  assert.equal(long[0].instructions.length, 2000);
});

await t("every declared fan-out survives normalizePlan, and the step sequence never becomes the plan", () => {
  const withFanout = BLUEPRINTS.filter((b) => b.fanout);
  assert.equal(withFanout.length, 10);
  for (const b of withFanout) {
    const parts = blueprintParts(b.id);
    assert.ok(normalizePlan(parts), b.id + " declares a fan-out battalion would reject");
    // The lanes are the LANES of one step, never the steps themselves. If these ever coincide, a
    // pipeline is being passed to a parallel executor.
    const stepNames = b.steps.map((s) => s.name.replace(/_/g, " ").toLowerCase());
    for (const p of parts) {
      assert.ok(!stepNames.includes(p.title.toLowerCase()),
        b.id + " part '" + p.title + "' is a pipeline STEP, not a fan-out lane");
    }
    assert.ok(b.steps.some((s) => s.name === blueprintFanoutStep(b.id)),
      b.id + " fans out on a step it does not have");
  }
});

await t("blueprints without a declared fan-out supply nothing, so battalion plans normally", () => {
  const without = BLUEPRINTS.filter((b) => !b.fanout);
  assert.equal(without.length, 39);
  for (const b of without) assert.equal(blueprintParts(b.id), null, b.id + " should supply no plan");
  assert.equal(blueprintParts("no-such-blueprint"), null);
});

console.log(`\nbattalion_plan: ${passed} passed, 0 failed`);
