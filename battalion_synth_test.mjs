/*
 * The merged answer is no longer capped at one chunk.
 *
 * THE DEFECT THIS CLOSES. SYNTH_TOKENS was the ceiling on the whole merge, not a chunk size, which
 * made the swarm narrower than its own inputs: four workers can produce up to 4 x PART_TOKENS of
 * material and the editor was told to fit all of it into 8192. The more the swarm gathered, the
 * harder it compressed, so "give me the long version" was the one thing it could not do. The failure
 * path preserved MORE, because stitched parts skip the merge entirely, which is the tell that the
 * happy path was the lossy one.
 *
 * Resuming on a length stop is exactly what the single-engine path has always done. These tests
 * prove the resume happens, that it stops when it should, and that a natural stop is untouched -
 * that last one matters most, because a continuation loop that fires on a normal answer would
 * double every reply in the product.
 */
import assert from "node:assert/strict";
import { createBattalion } from "./battalion.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  ok  " + name); passed++; };

const ROSTER = {
  assess: "seat-assess", orchestrator: "seat-orch", synthesizer: "seat-synth",
  single: "seat-single", workers: ["seat-w1", "seat-w2", "seat-w3", "seat-w4"],
};
const QUESTION = "Write the long version of this, thoroughly. ".repeat(8);

/* A bench whose synthesizer stops on "length" `cuts` times, then stops naturally. */
function bench(cuts, { failAt = -1 } = {}) {
  const streamed = [];
  let synthCalls = 0;
  const callSeat = async (id, msgs, opts, onDelta) => {
    if (id === ROSTER.assess) return { ok: true, content: "COMPLEX" };
    if (id === ROSTER.orchestrator) return { ok: true, content: JSON.stringify({ parts: [
      { title: "A", instructions: "a".repeat(60) }, { title: "B", instructions: "b".repeat(60) },
    ] }) };
    if (id === ROSTER.synthesizer) {
      const n = synthCalls++;
      if (n === failAt) return { ok: false, content: "", error: "seat died mid-continuation" };
      const chunk = "[chunk" + n + "]";
      if (onDelta) onDelta(chunk);
      return { ok: true, content: chunk, finishReason: n < cuts ? "length" : "stop" };
    }
    return { ok: true, content: "part output" };
  };
  return { streamed, callSeat, synthCalls: () => synthCalls };
}

await t("a merge cut off at the output cap resumes and delivers the whole answer", async () => {
  const b = bench(3);
  const streamed = [];
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: QUESTION, onToken: (d) => streamed.push(d) });
  assert.ok(r.ok);
  // 3 length stops then a natural one = 4 synthesizer calls, all four chunks in the answer.
  assert.equal(b.synthCalls(), 4, "expected three continuations after the first pass");
  assert.equal(r.content, "[chunk0][chunk1][chunk2][chunk3]");
  // Every continuation streams through the SAME onToken, so the user sees one continuous answer.
  assert.deepEqual(streamed, ["[chunk0]", "[chunk1]", "[chunk2]", "[chunk3]"]);
  const stage = r.manifest.stages.find((s) => s.stage === "synthesize");
  assert.equal(stage.continuations, 3, "the manifest must record how many continuations ran");
});

await t("an answer that stops naturally is NOT continued", async () => {
  const b = bench(0);
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: QUESTION, onToken: () => {} });
  assert.ok(r.ok);
  assert.equal(b.synthCalls(), 1, "a natural stop must not trigger a continuation");
  assert.equal(r.content, "[chunk0]");
  const stage = r.manifest.stages.find((s) => s.stage === "synthesize");
  assert.equal(stage.continuations, undefined, "no continuations means the field stays absent");
});

await t("a model that never stops is cut off, and the answer says so", async () => {
  const b = bench(999);
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: QUESTION, onToken: () => {} });
  assert.ok(r.ok, "hitting the continuation limit must still deliver what was written");
  // 1 first pass + SYNTH_CONT_MAX continuations.
  assert.equal(b.synthCalls(), 9, "expected the loop bounded at eight continuations, saw " + b.synthCalls());
  assert.ok(r.manifest.notes.some((n) => /continuation limit/.test(n)),
    "reaching the limit must be announced, not silently truncated");
});

await t("a continuation that dies keeps what was already written and says so", async () => {
  const b = bench(999, { failAt: 2 });
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: QUESTION, onToken: () => {} });
  assert.ok(r.ok, "a dead continuation must not throw away the answer so far");
  assert.equal(r.content, "[chunk0][chunk1]", "text written before the failure survives");
  assert.ok(r.manifest.notes.some((n) => /cut short/.test(n)),
    "a failed continuation must be announced in the manifest");
});

await t("an abort mid-continuation stops asking for more", async () => {
  const b = bench(999);
  let calls = 0;
  const battalion = createBattalion({
    callSeat: async (...a) => { if (a[0] === ROSTER.synthesizer) calls++; return b.callSeat(...a); },
    roster: ROSTER,
  });
  const r = await battalion.run({ question: QUESTION, onToken: () => {}, isAborted: () => calls >= 3 });
  assert.ok(calls < 9, "an aborted turn must stop continuing, saw " + calls + " synthesizer calls");
});

console.log(`\nbattalion_synth: ${passed} passed, 0 failed`);
