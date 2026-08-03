/*
 * sequential.mjs, the framework above the Ember floor.
 *
 * Three things are actually load-bearing here and each has a test that fails if it breaks:
 *   1. The MCP server can be launched by THIS repo's npx launcher, and it speaks the protocol.
 *      Gated behind DOMINION_SEQUENTIAL_LIVE=1 because it downloads a package on a cold cache.
 *   2. When the server cannot start, a turn still completes with the old prompt-only depth. That
 *      is the path a user hits on a host with no npm, and it is tested with an injected spawn so
 *      it runs in milliseconds instead of never being run at all.
 *   3. The forge dial has no effect on the assembled prompt while FORGE_DIAL_ENABLED is off
 *      (SOW Phase 3, item 4), so nobody re-enables it by accident and nobody re-derives that it
 *      is live.
 *
 * Run: node sequential_test.mjs        (live MCP: DOMINION_SEQUENTIAL_LIVE=1 node sequential_test.mjs)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SEQUENTIAL_SERVER, SEQUENTIAL_THRESHOLD_DEFAULT, COMPLEXITY_BANDS,
  sequentialThreshold, classifyComplexity, effectiveForgeTier,
  createSequentialThinker, sequentialPlan, sequentialDegraded,
} from "./sequential.mjs";
import { forgeFrameworkPrompt, FORGE_DIAL_ENABLED } from "./execution-policy.mjs";

// ---- a fake server, so the wiring is testable without the registry ------------------------------
// Mirrors the REAL bookkeeping shape captured from the live handshake on 2026-08-03.
function fakeServer({ failSpawn = "", failAt = 0 } = {}) {
  let history = 0;
  const conn = failSpawn
    ? { child: null, pending: new Map(), dead: true, deadReason: failSpawn }
    : { child: { kill() {} }, pending: new Map(), dead: false, deadReason: "" };
  const calls = [];
  const rpc = async (_c, method, params, notify = false) => {
    calls.push({ method, params });
    if (notify) return null;
    if (method === "initialize") {
      return { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "sequential-thinking-server", version: "0.2.0" } };
    }
    if (method === "tools/call") {
      history += 1;
      if (failAt && history === failAt) throw new Error("the connector stopped answering after 90s.");
      const a = params.arguments;
      return { structuredContent: { thoughtNumber: a.thoughtNumber, totalThoughts: a.totalThoughts,
        nextThoughtNeeded: a.nextThoughtNeeded, branches: a.branchId ? [a.branchId] : [],
        thoughtHistoryLength: history } };
    }
    return {};
  };
  return { spawn: () => conn, rpc, calls };
}

const thinkFor = (n) => async ({ stepNumber }) =>
  ({ thought: `step ${stepNumber} of the plan`, nextThoughtNeeded: stepNumber < n });

// ---- 1. the classifier (CONTRACT FOR LANE I) ----------------------------------------------------

test("classifyComplexity returns the whole Lane I contract, frozen, on any input", () => {
  for (const input of ["", "hi", { text: "" }, null, undefined, 42]) {
    const c = classifyComplexity(input);
    assert.ok(Object.isFrozen(c), "the record must be frozen so a caller cannot edit a routing decision");
    for (const k of ["score", "band", "threshold", "needsSequential", "suggestedTier", "reasoning",
                     "minContextTokens", "taskKind", "workKind", "signals", "rationale"]) {
      assert.ok(Object.hasOwn(c, k), `missing contract field ${k} for input ${JSON.stringify(input)}`);
    }
    assert.ok(COMPLEXITY_BANDS.includes(c.band));
    assert.ok(c.score >= 0 && c.score <= 100);
  }
});

test("simple asks stay below the gate and heavy build work rises above it", () => {
  const light = [
    "What is the capital of France?",
    "Summarize this in one line.",
    "Give me a quick answer: is 17 prime?",
  ];
  for (const q of light) {
    const c = classifyComplexity(q);
    assert.equal(c.needsSequential, false, `${q} -> ${c.score} (${c.rationale})`);
    assert.equal(c.suggestedTier, "ember", q);
  }
  const heavy = [
    "Refactor the entire auth module across the codebase, migrate the sessions table, and then update every caller. It must never drop a live session.",
    "Work on this until it is done: diagnose why the build fails, find the root cause, fix it end to end, and verify with a real run.",
  ];
  for (const q of heavy) {
    const c = classifyComplexity(q);
    assert.equal(c.needsSequential, true, `${q} -> ${c.score} (${c.rationale})`);
    assert.ok(["flame", "furnace"].includes(c.suggestedTier), q);
  }
});

test("an explicit request for brevity outranks the raisers that would escalate it", () => {
  const long = "Compare the trade-offs and explain why the design fails across the whole codebase.";
  const brief = "Briefly compare the trade-offs and explain why the design fails across the whole codebase.";
  assert.ok(classifyComplexity(brief).score < classifyComplexity(long).score,
    "someone who asked for a short answer must not be handed a twelve-step deliberation they pay for");
});

test("\"just\" as a time adverb does not read as a request for brevity", () => {
  // Found during review: a bare \bjust\b in BREVITY_RE took 12 points off every "I just deployed
  // and it broke", which is the opening of a hard debugging ask, not a request for a short answer.
  for (const q of ["I just deployed and the build fails, why?",
                   "It just started throwing after the migration. Diagnose the root cause.",
                   "Here is an article I just read, what do you make of it?"]) {
    assert.ok(!classifyComplexity(q).signals.includes("brevity-requested"), q);
  }
  // A real request for brevity still lowers the score, in both of its normal shapes.
  for (const q of ["Just tell me the answer.", "Simply give me the number.", "Briefly: why did it fail?"]) {
    assert.ok(classifyComplexity(q).signals.includes("brevity-requested"), q);
  }
});

test("the threshold is a named, observable, tunable number and rides in every result", () => {
  assert.equal(sequentialThreshold({}), SEQUENTIAL_THRESHOLD_DEFAULT);
  assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: "10" }), 10);
  assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: "nonsense" }), SEQUENTIAL_THRESHOLD_DEFAULT);
  assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: "500" }), SEQUENTIAL_THRESHOLD_DEFAULT);

  const q = "Explain why this fails.";
  const strict = classifyComplexity(q, { env: { DOMINION_SEQUENTIAL_THRESHOLD: "99" } });
  const loose = classifyComplexity(q, { env: { DOMINION_SEQUENTIAL_THRESHOLD: "1" } });
  assert.equal(strict.needsSequential, false);
  assert.equal(loose.needsSequential, true);
  assert.equal(strict.score, loose.score, "moving the gate must not move the score");
  assert.match(strict.rationale, /threshold of 99/, "the decision must be legible without reading the code");
});

test("the classifier agrees with execution-policy on the task class rather than inventing one", () => {
  assert.equal(classifyComplexity("Fix the login bug and deploy it.").taskKind, "build");
  assert.equal(classifyComplexity("Audit the repo for security issues.").taskKind, "audit");
  assert.equal(classifyComplexity("Keep working until it is complete.").taskKind, "long-run");
  // A caller-declared class wins, exactly as it does for createTaskContract.
  assert.equal(classifyComplexity({ text: "hello", taskKind: "build" }).taskKind, "build");
});

// ---- 2. the dial is off, and off means it changes nothing ---------------------------------------

test("SOW Phase 3 item 4: the forge dial has NO effect on the assembled prompt while the flag is off", () => {
  assert.equal(FORGE_DIAL_ENABLED, false,
    "the dial is off by design pending Fred's decision on user override; see execution-policy.mjs");

  const ask = "What is the capital of France?";
  const base = effectiveForgeTier({ ask });
  for (const requested of ["ember", "flame", "furnace", "FURNACE", " Flame ", "nonsense", "", null]) {
    const d = effectiveForgeTier({ requestedTier: requested, ask });
    assert.equal(d.tier, base.tier, `requesting ${JSON.stringify(requested)} moved the tier while the dial is off`);
    assert.equal(d.honoredRequest, false);
    assert.equal(d.source, "complexity-router");
    assert.equal(forgeFrameworkPrompt(d.tier), forgeFrameworkPrompt(base.tier),
      "same prompt bytes, whatever the client sent");
  }
});

test("with the dial hypothetically on, the user's tier is honored again (the code stays usable)", () => {
  const d = effectiveForgeTier({ requestedTier: "furnace", ask: "hi", dialEnabled: true });
  assert.equal(d.tier, "furnace");
  assert.equal(d.honoredRequest, true);
  assert.equal(d.source, "user-dial");
});

test("As Fred still reaches furnace, because it is a mode and not the dial", () => {
  const d = effectiveForgeTier({ mode: "as_fred", ask: "What is the capital of France?" });
  assert.equal(d.tier, "furnace");
  assert.equal(d.source, "as-fred-mode");
});

test("depth now comes from complexity, and the decision can be explained after the fact", () => {
  const light = effectiveForgeTier({ ask: "Give me a quick one-line answer: what is 2+2?" });
  const heavy = effectiveForgeTier({ ask: "Diagnose the root cause of the failing build across the entire codebase, fix it end to end, and then verify it." });
  assert.equal(light.tier, "ember");
  assert.notEqual(heavy.tier, "ember");
  assert.ok(light.complexity.rationale.length > 0 && heavy.complexity.rationale.length > 0);
});

// ---- 3. DEGRADATION: a dead server must never take the turn with it -----------------------------

test("DEGRADATION: no npm on the host degrades to the existing behavior instead of failing the turn", async () => {
  const f = fakeServer({ failSpawn: "this server has no npm/npx available, so connectors that run a local server cannot start here" });
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc, firstMs: 50, callMs: 50 });
  const r = await t.plan("Refactor the auth module end to end.", { think: thinkFor(3), tier: "flame" });

  assert.equal(r.ok, true, "the turn must still complete");
  assert.equal(r.degraded, true);
  assert.equal(r.via, "degraded");
  assert.match(r.reason, /no npm/, "and it must say the real reason, never a fictional timeout");
  assert.deepEqual([...r.steps], []);
  assert.equal(r.directive, forgeFrameworkPrompt("flame"),
    "the executor keeps exactly the depth it had before this module existed");
});

test("DEGRADATION: an initialize that never answers degrades instead of hanging the turn", async () => {
  const conn = { child: { kill() {} }, pending: new Map(), dead: false, deadReason: "" };
  const t = createSequentialThinker({
    spawn: () => conn,
    rpc: (_c, method) => method === "initialize" ? new Promise(() => {}) : Promise.resolve({}),
    firstMs: 60, callMs: 60,
  });
  const r = await t.plan("Do the hard thing.", { think: thinkFor(2), tier: "furnace" });
  assert.equal(r.degraded, true);
  assert.match(r.reason, /did not answer initialize/);
  assert.equal(r.directive, forgeFrameworkPrompt("furnace"));
});

test("DEGRADATION: a server that dies mid-sequence keeps the recorded steps and still returns a directive", async () => {
  const f = fakeServer({ failAt: 3 });
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc, firstMs: 500, callMs: 500 });
  const r = await t.plan("Migrate the schema.", { think: thinkFor(6), tier: "flame" });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.steps.length, 2, "the two thoughts that were recorded before the failure survive");
  assert.match(r.reason, /kept 2 recorded steps/);
  assert.equal(r.directive, forgeFrameworkPrompt("flame"));
});

test("DEGRADATION: no thought source is stated plainly, because this server logs reasoning and does not produce it", async () => {
  const f = fakeServer();
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc });
  const r = await t.plan("Anything at all.", { tier: "flame" });
  assert.equal(r.degraded, true);
  assert.match(r.reason, /records reasoning and does not produce it/);
  assert.equal(f.calls.length, 0, "and it must not have spawned or spoken to anything");
});

/*
 * The two below were added during the adversarial review on 2026-08-03. Each pins a defect that
 * was live and that the original suite did not reach.
 */
test("DEGRADATION: a REJECTED tool call is a failure, never a one-step plan that reads as success", async () => {
  // The exact body the live server returns for invalid arguments, captured from a real handshake.
  const reject = {
    content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool sequentialthinking" }],
    isError: true,
  };
  const rpc = async (_c, method) => {
    if (method === "initialize") return { serverInfo: { name: "sequential-thinking-server", version: "0.2.0" } };
    if (method === "notifications/initialized") return null;
    return reject;
  };
  const t = createSequentialThinker({ spawn: () => ({ child: { kill() {} }, pending: new Map(), dead: false, deadReason: "" }), rpc });
  const r = await t.plan("Plan the migration.", { think: thinkFor(4), tier: "flame", maxSteps: 6 });

  assert.equal(r.ok, true, "the turn still completes");
  assert.equal(r.degraded, true, "a server that refused every thought did NOT produce a plan");
  assert.equal(r.via, "degraded");
  assert.match(r.reason, /rejected the thought/);
  assert.equal(r.steps.length, 0);
  assert.equal(r.directive, forgeFrameworkPrompt("flame"), "and the executor keeps its depth");
});

test("DEGRADATION: a body that is not step bookkeeping is a failure, not an empty success", async () => {
  const rpc = async (_c, method) => {
    if (method === "initialize") return { serverInfo: { name: "x" } };
    if (method === "notifications/initialized") return null;
    return { content: [{ type: "text", text: "<html>502 Bad Gateway</html>" }] };
  };
  const t = createSequentialThinker({ spawn: () => ({ child: { kill() {} }, pending: new Map(), dead: false, deadReason: "" }), rpc });
  const r = await t.plan("Plan the migration.", { think: thinkFor(4), tier: "furnace", maxSteps: 6 });
  assert.equal(r.degraded, true);
  assert.match(r.reason, /not step bookkeeping/);
  assert.equal(r.directive, forgeFrameworkPrompt("furnace"));
});

test("A BLANK THRESHOLD ENV VAR IS NOT ZERO (a declared-but-empty Railway variable ships as \"\")", () => {
  // Number("") is 0, and a threshold of 0 sends every greeting through sequential thinking. That is
  // the cost defect this gate exists to prevent, reachable by leaving one variable blank.
  for (const blank of ["", "   ", "\t", null, undefined]) {
    assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: blank }), SEQUENTIAL_THRESHOLD_DEFAULT,
      `a blank value (${JSON.stringify(blank)}) must fall back to the default, never to zero`);
  }
  for (const notAnObject of [null, undefined, "", 0, false, "45"]) {
    assert.equal(sequentialThreshold(notAnObject), SEQUENTIAL_THRESHOLD_DEFAULT,
      `a non-object env (${JSON.stringify(notAnObject)}) must fall back to the default`);
  }
  // An explicit zero is still honored, because someone who types a zero means it.
  assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: "0" }), 0);
  assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: 0 }), 0);
  assert.equal(sequentialThreshold({ DOMINION_SEQUENTIAL_THRESHOLD: " 30 " }), 30);
  // And the gate must actually stay shut on trivial work when the variable is blank.
  assert.equal(classifyComplexity("hi", { env: { DOMINION_SEQUENTIAL_THRESHOLD: "" } }).needsSequential, false);
});

test("every degraded record has the same shape as a successful one, so no caller has to branch", async () => {
  const f = fakeServer();
  const ok = await createSequentialThinker({ spawn: f.spawn, rpc: f.rpc }).plan("Ship it.", { think: thinkFor(2), tier: "flame" });
  const bad = sequentialDegraded("anything", "flame");
  for (const k of ["ok", "via", "degraded", "reason", "task", "tier", "complexity", "steps",
                   "totalThoughts", "branches", "historyLength", "directive"]) {
    assert.ok(Object.hasOwn(ok, k) && Object.hasOwn(bad, k), `both records must carry ${k}`);
  }
  assert.equal(ok.degraded, false);
});

// ---- 4. the happy path against the fake, and the gate ------------------------------------------

test("a sequence is driven to the server's own stopping signal, numbered and revisable", async () => {
  const f = fakeServer();
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc });
  const r = await t.plan("Plan the migration.", {
    tier: "flame",
    think: async ({ stepNumber }) => stepNumber === 3
      ? { thought: "step 2 was wrong about the index", isRevision: true, revisesThought: 2, nextThoughtNeeded: false }
      : { thought: `step ${stepNumber}`, nextThoughtNeeded: true },
  });
  assert.equal(r.via, "mcp");
  assert.equal(r.degraded, false);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3]);
  assert.equal(r.steps[2].isRevision, true);
  assert.equal(r.steps[2].revisesThought, 2);
  assert.equal(r.server.name, SEQUENTIAL_SERVER.expectedServerName);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.steps));
});

test("the step ceiling holds against a think() that would never stop", async () => {
  const f = fakeServer();
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc });
  const r = await t.plan("Loop forever.", { tier: "furnace", maxSteps: 4,
    think: async ({ stepNumber }) => ({ thought: `step ${stepNumber}`, nextThoughtNeeded: true }) });
  assert.equal(r.steps.length, 4);
  assert.equal(r.truncated, true, "a capped sequence must say so rather than read as a finished plan");
});

test("THE GATE: work below the threshold never reaches the server at all", async () => {
  const f = fakeServer();
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc });
  const r = await sequentialPlan("What is the capital of France?", { think: thinkFor(3), thinker: t });
  assert.equal(r.gated, true);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /below the sequential threshold/);
  assert.equal(f.calls.length, 0, "sequential thinking costs more; simple work must not pay for it");
  assert.equal(r.decision.tier, "ember");
});

test("THE GATE: heavy work does reach the server, and carries its decision for logging", async () => {
  const f = fakeServer();
  const t = createSequentialThinker({ spawn: f.spawn, rpc: f.rpc });
  const ask = "Diagnose the root cause across the entire codebase, fix it end to end, and then verify the build.";
  const r = await sequentialPlan(ask, { ask, think: thinkFor(3), thinker: t });
  assert.equal(r.gated, false);
  assert.equal(r.via, "mcp");
  assert.ok(r.steps.length >= 1);
  assert.equal(r.decision.complexity.needsSequential, true);
  assert.ok(f.calls.some((c) => c.method === "initialize"));
});

// ---- 5. the launcher is not reimplemented here ---------------------------------------------------

test("sequential.mjs uses connectors.mjs's launcher and owns no second copy of the npx fix", () => {
  const src = readFileSync(new URL("./sequential.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ spawnMcpStdio, stdioRpc[^}]*\} from "\.\/connectors\.mjs"/,
    "the one npx launcher lives in connectors.mjs and is imported, never copied");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/shell:\s*true/.test(code), "shell:true is the hole the launcher fix closed");
  assert.ok(!/spawn\(\s*["']npx["']/.test(code), "spawn(\"npx\") is ENOENT on Windows; that defect is not coming back");
});

test("no em dashes in the shipped strings (Fred's house rule, and this module writes prompts)", () => {
  for (const f of ["./sequential.mjs", "./execution-policy.mjs", "./wolfe-logic.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8")
      // A character class that MATCHES an em dash in user input is the opposite of writing one.
      .replace(/\[—–\]/g, "");
    /*
     * The exemption that used to sit here is GONE, and so is the violation it covered (2026-08-03).
     * The Cost line of executionManagerPrompt shipped an em dash to the model inside an app whose
     * house style forbids them. Lane E found it and could not close it alone, because the string was
     * pinned by execution-policy_test.mjs and fixing one without the other turns a suite red over a
     * punctuation mark. The integrator changed the string and the pin together, so this assertion is
     * now unconditional. Keep it that way: an exemption here is how the next one survives.
     */
    const hits = (src.match(/—/g) || []).length;
    assert.equal(hits, 0, `${f} contains ${hits} em dash(es)`);
  }
});

// ---- 6. the live server, gated ------------------------------------------------------------------

test("LIVE: the real MCP server launches through this repo's npx launcher and speaks the protocol",
  { skip: process.env.DOMINION_SEQUENTIAL_LIVE === "1" ? false : "set DOMINION_SEQUENTIAL_LIVE=1 (downloads a package)" },
  async () => {
    const t = createSequentialThinker({});
    const why = await t.connect();
    assert.equal(why, "", `the server failed to start: ${why}`);
    const s = t.status();
    assert.equal(s.ready, true);
    assert.equal(s.server.name, SEQUENTIAL_SERVER.expectedServerName);
    const r = await t.plan("Identify the files that must change.", { tier: "flame", think: thinkFor(2) });
    assert.equal(r.via, "mcp");
    assert.equal(r.degraded, false);
    assert.equal(r.steps.length, 2);
    assert.ok(r.historyLength >= 2);
    t.close();
  });
