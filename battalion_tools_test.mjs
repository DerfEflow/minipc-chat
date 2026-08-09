/*
 * The swarm reads. It never writes.
 *
 * WHY THIS IS THE ONE THAT MATTERS. Battalion runs 2-4 workers concurrently and tells them their
 * parts must not overlap, so nothing sequences them. Concurrent reads cannot conflict; concurrent
 * writes will, and the confirm gate cannot arbitrate because it assumes a single agent and would
 * raise four indistinguishable prompts at once. Every assertion here exists to keep a write out of
 * a parallel worker's hands.
 *
 * There are two independent guards and this tests both, because either alone is one edit from
 * failing open: the SERVER offers only read_only defs, and BATTALION refuses to execute any name it
 * was not offered. The second is what makes a hallucinated forge_write harmless.
 */
import assert from "node:assert/strict";
import { createBattalion, parseTextToolCalls } from "./battalion.mjs";
import { toolDefs, toolMeta, WRITE_TOOLS } from "./tools.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  ok  " + name); passed++; };

const ROSTER = {
  assess: "seat-assess", orchestrator: "seat-orch", synthesizer: "seat-synth",
  single: "seat-single", workers: ["seat-w1", "seat-w2", "seat-w3", "seat-w4"],
};
// The exact filter server.mjs applies. Kept in step by the first test below, which fails if the
// server ever stops using permissionClass as the criterion.
const TENANT = { tenant: { email: "owner@dev" }, hands: "OWNER_HANDS" };
const readOnlyDefs = () => toolDefs(null).filter((d) => toolMeta(d.function.name).permissionClass === "read_only");

await t("the offered set is read_only only, and cannot intersect WRITE_TOOLS", () => {
  const offered = readOnlyDefs().map((d) => d.function.name);
  assert.ok(offered.length > 20, "expected a substantial read-only set, got " + offered.length);
  for (const n of offered) assert.equal(toolMeta(n).permissionClass, "read_only", n + " is not read_only");
  const overlap = offered.filter((n) => WRITE_TOOLS.has(n));
  assert.deepEqual(overlap, [], "a dangerous tool reached the swarm's offer list: " + overlap.join(", "));
  // The classes deliberately excluded. safe_local_write is the trap: safe for ONE agent, which is
  // precisely the assumption a parallel swarm breaks.
  const all = toolDefs(null).map((d) => d.function.name);
  for (const cls of ["dangerous", "requires_confirmation", "safe_local_write", "draft_only"]) {
    const inClass = all.filter((n) => toolMeta(n).permissionClass === cls);
    const leaked = inClass.filter((n) => offered.includes(n));
    assert.deepEqual(leaked, [], cls + " leaked into the swarm: " + leaked.join(", "));
  }
});

// A bench that hands each worker one tool call, then an answer.
function benchAskingFor(toolName) {
  const executed = [], asked = [];
  let turn = 0;
  const callSeat = async (id, msgs, opts) => {
    if (id === ROSTER.assess) return { ok: true, content: "COMPLEX" };
    if (id === ROSTER.orchestrator) return { ok: true, content: JSON.stringify({ parts: [
      { title: "A", instructions: "a".repeat(60) }, { title: "B", instructions: "b".repeat(60) },
    ] }) };
    if (id === ROSTER.synthesizer) return { ok: true, content: "merged" };
    // worker: ask once, then answer
    const alreadyAsked = msgs.some((m) => m.role === "tool");
    if (!alreadyAsked && opts && opts.tools) {
      asked.push(toolName);
      return { ok: true, content: "", toolCalls: [{ id: "c" + (++turn), function: { name: toolName, arguments: "{}" } }] };
    }
    return { ok: true, content: "part done" };
  };
  return { executed, asked, callSeat };
}

await t("a worker's read-only call is executed and its result fed back", async () => {
  const b = benchAskingFor("recall_memory");
  const battalion = createBattalion({
    callSeat: b.callSeat, roster: ROSTER,
    tools: readOnlyDefs,
    runTool: async (name) => { b.executed.push(name); return "evidence for " + name; },
  });
  const r = await battalion.run({ question: "Research this thoroughly. ".repeat(12), toolContext: TENANT });
  assert.ok(r.ok);
  assert.ok(b.executed.includes("recall_memory"), "an offered read-only tool must actually run");
  assert.ok(r.manifest.stages.some((s) => (s.tools || 0) > 0), "the manifest must record that tools were used");
});

await t("a worker asking for a WRITE tool is refused, and nothing reaches the machine", async () => {
  for (const evil of ["forge_write", "forge_run", "desktop_control", "sandbox_write"]) {
    const b = benchAskingFor(evil);
    const battalion = createBattalion({
      callSeat: b.callSeat, roster: ROSTER,
      tools: readOnlyDefs,
      runTool: async (name) => { b.executed.push(name); return "SHOULD NEVER RUN"; },
    });
    const r = await battalion.run({ question: "Do this thoroughly. ".repeat(12), toolContext: TENANT });
    assert.ok(r.ok, evil + ": a refused tool must not fail the turn");
    assert.deepEqual(b.executed, [], evil + " REACHED runTool - the swarm executed a write");
    assert.ok(r.manifest.notes.some((n) => n.includes(evil)),
      evil + " was refused silently; a refusal must be named in the manifest");
  }
});

await t("with no tools injected, the swarm behaves exactly as it did before", async () => {
  const b = benchAskingFor("recall_memory");
  const battalion = createBattalion({ callSeat: b.callSeat, roster: ROSTER });
  const r = await battalion.run({ question: "Write about this at length. ".repeat(12) });
  assert.ok(r.ok);
  assert.deepEqual(b.asked, [], "no tools were offered, so no worker should have been able to ask");
  assert.equal(r.manifest.stages.filter((s) => s.tools).length, 0);
});

await t("a worker that never stops calling tools is cut off rather than looping forever", async () => {
  let calls = 0;
  const callSeat = async (id, msgs, opts) => {
    if (id === ROSTER.assess) return { ok: true, content: "COMPLEX" };
    if (id === ROSTER.orchestrator) return { ok: true, content: JSON.stringify({ parts: [
      { title: "A", instructions: "a".repeat(60) }, { title: "B", instructions: "b".repeat(60) },
    ] }) };
    if (id === ROSTER.synthesizer) return { ok: true, content: "merged" };
    // Always asks for another tool, whenever tools are on offer.
    if (opts && opts.tools) { calls++; return { ok: true, content: "", toolCalls: [{ id: "c" + calls, function: { name: "recall_memory", arguments: "{}" } }] }; }
    return { ok: true, content: "forced answer with no tools offered" };
  };
  const battalion = createBattalion({
    callSeat, roster: ROSTER, tools: readOnlyDefs, runTool: async () => "more evidence",
  });
  const r = await battalion.run({ question: "Loop on this. ".repeat(12), toolContext: TENANT });
  assert.ok(r.ok, "a looping worker must still produce a turn");
  // Four rounds offer tools, the fifth deliberately offers none, which forces an answer.
  assert.ok(calls <= 8, "expected the loop to be bounded per worker, saw " + calls + " tool rounds");
});


/*
 * TENANT SCOPING. Added the same day the first two tests shipped, because the first real turn
 * exposed both of these and either one alone is a shipped defect.
 *
 * The severe one: runTool was originally bound to the server's module-level CTX, which carries
 * CTX.hands - the OWNER'S connected machine. BATTALION is a free lane every guest can pick, so a
 * guest's worker could have listed the owner's drives. The context is now per-run and mandatory.
 *
 * The visible one: tools were wired to parallel workers only, so a short question skipped the assess
 * gate, landed on the single seat, found no tools and hallucinated a shell command as prose.
 */
await t("the tenant's context reaches runTool, and nothing else does", async () => {
  const seen = [];
  const b = benchAskingFor("recall_memory");
  const battalion = createBattalion({
    callSeat: b.callSeat, roster: ROSTER, tools: readOnlyDefs,
    runTool: async (name, args, signal, ctx) => { seen.push(ctx); return "ok"; },
  });
  const guestCtx = { tenant: { email: "guest@example.com" }, hands: "GUEST_HANDS" };
  await battalion.run({ question: "Research this thoroughly. ".repeat(12), toolContext: guestCtx });
  assert.ok(seen.length, "a tool ran but no context was recorded");
  for (const ctx of seen) {
    assert.equal(ctx, guestCtx, "a worker ran with a context other than the caller's");
    assert.equal(ctx.hands, "GUEST_HANDS", "a worker reached hands that were not the caller's");
  }
});

await t("no tenant context means NO tools, never a fallback to a global", async () => {
  let ran = 0;
  const b = benchAskingFor("recall_memory");
  const battalion = createBattalion({
    callSeat: b.callSeat, roster: ROSTER, tools: readOnlyDefs,
    runTool: async () => { ran++; return "ok"; },
  });
  // toolContext omitted entirely: the swarm must degrade to text-only rather than borrow anyone's.
  const r = await battalion.run({ question: "Research this thoroughly. ".repeat(12) });
  assert.ok(r.ok, "a context-less turn must still answer, just without tools");
  assert.equal(ran, 0, "a tool ran with no tenant context - this is the cross-tenant hole");
  assert.deepEqual(b.asked, [], "tools must not even be OFFERED without a context");
});

await t("the SINGLE seat gets tools, not just the parallel workers", async () => {
  const executed = [];
  let sawToolsOffered = false;
  const callSeat = async (id, msgs, opts) => {
    // A short question never reaches assess or the orchestrator: it lands here.
    if (id !== ROSTER.single) return { ok: true, content: "unused" };
    if (opts && opts.tools) sawToolsOffered = true;
    const already = msgs.some((m) => m.role === "tool");
    if (!already && opts && opts.tools) {
      return { ok: true, content: "", toolCalls: [{ id: "c1", function: { name: "forge_read", arguments: '{"op":"list","path":"F:\\\\"}' } }] };
    }
    return { ok: true, content: "Drive F contains three projects." };
  };
  const battalion = createBattalion({
    callSeat, roster: ROSTER, tools: readOnlyDefs,
    runTool: async (name) => { executed.push(name); return "F:\ProjectOne\nF:\ProjectTwo"; },
  });
  // Fred's actual question, 91 chars, deliberately under the 160-char assess gate.
  const r = await battalion.run({
    question: "give me a run down on all app projects currently listed on Drive F and Drive Z.",
    toolContext: { tenant: { email: "owner" } }, onToken: () => {},
  });
  assert.ok(r.ok);
  assert.equal(r.manifest.mode, "single", "a short question should stay on one seat");
  assert.ok(sawToolsOffered, "the single seat was never offered tools - this is the reported bug");
  assert.deepEqual(executed, ["forge_read"], "the single seat must be able to list a folder");
  assert.match(r.content, /Drive F contains/, "the answer must come from the tool result, not a guess");
});
