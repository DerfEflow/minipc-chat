/*
 * Crucible execution-contract boundary test.
 *
 * This stays below server.mjs: createIdeFeature is dependency-injected, so the captured runner
 * arguments are exactly what the /ide/job route spreads into runIdeBuild. A client-selected Forge
 * contract must survive this boundary unchanged instead of silently falling back to Ember/off.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createIdeFeature, createIdeGate } from "./ide.mjs";
import { createIdeEngine } from "./ideengine.mjs";

test("Forge fields survive the IDE feature boundary into runIdeBuild arguments", () => {
  const owner = {
    role: "owner",
    isOwner: true,
    uid: "owner",
    email: "owner@example.test",
    status: "active",
    invited: true,
  };
  const workspace = {
    id: "ws_contract",
    name: "Contract Test",
    root: "C:/Projects/contract-test",
    assignments: { build_code: "openai/gpt-5.6-sol" },
  };
  const store = {
    get: (id) => id === workspace.id ? workspace : null,
    prefs: () => ({ language: "technical", mode: "engineer", assignments: {} }),
  };
  const jobs = {
    activeFor: () => [],
    create: ({ uid, workspaceId, kind, isOwner }) => ({
      id: "ide_contract",
      uid,
      workspaceId,
      kind,
      isOwner,
      done: false,
    }),
  };
  const feature = createIdeFeature({
    gate: createIdeGate("owner"),
    storeFor: () => store,
    jobs,
    multiTenant: false,
  });

  let dispatched = null;
  const response = feature.startJob(owner, {
    kind: "build",
    workspaceId: workspace.id,
    prompt: "Audit the repository and finish every verified fix.",
    wolfeTier: "furnace",
    forgeTier: "furnace",
    forgeMode: true,
  }, {
    runner: (job, extra) => { dispatched = { job, extra }; },
  });

  assert.equal(response.status, 200);
  assert.ok(dispatched, "the build runner should be dispatched");
  assert.equal(dispatched.extra.forgeTier, "furnace",
    "the selected Wolfe/Forge effort tier must reach runIdeBuild in canonical form");
  assert.equal(dispatched.extra.forgeMode, true,
    "the persistent Forge execution switch must reach runIdeBuild");
  assert.equal(dispatched.extra.mode, "engineer",
    "existing Crucible mode forwarding remains intact");
  assert.deepEqual(dispatched.extra.assignments, workspace.assignments,
    "existing custom model assignments remain intact");
});

test("a truncated file response is rejected atomically and retried before any write", async () => {
  const events = [];
  const modelCalls = [];
  const writes = [];
  const replies = [
    { ok: true, content: "```path=src/app.ts\nexport const incomplete =", costUsd: 0.01 },
    { ok: true, content: "```path=src/app.ts\nexport const complete = true;\n```", costUsd: 0.02 },
  ];
  const engine = createIdeEngine({
    jobs: { emit: (_id, event) => events.push(event) },
    chat: async (call) => {
      modelCalls.push(call);
      return replies[modelCalls.length - 1];
    },
    hands: async (tool, args) => {
      if (tool === "fs_read" && String(args.path).endsWith("package.json")) {
        return { ok: true, content: "{}" };
      }
      if (tool === "fs_read") return { ok: true, content: "export const old = true;" };
      if (tool === "shell_run" && /rev-parse/.test(args.command)) return { ok: true, code: 0, stdout: "true" };
      if (tool === "shell_run") return { ok: true, code: 0, stdout: "" };
      if (tool === "fs_write") {
        writes.push(args);
        return { ok: true, changed: true };
      }
      return { ok: true };
    },
    router: () => ({ taskClass: "build_code", model: "openai/gpt-5.6-sol", why: "test" }),
  });

  const result = await engine.runMove({ id: "ide_truncation" }, {
    move: { id: "m1", title: "Finish the file", why: "test", files: ["src/app.ts"] },
    workspace: { root: "C:/Projects/contract-test", name: "Contract Test" },
    assignments: {},
    goal: "Finish every requested change.",
  });

  assert.equal(result.ok, true);
  assert.equal(modelCalls.length, 2, "the incomplete provider response must be retried");
  assert.match(modelCalls[1].messages.at(-1).content, /nothing could be written/i);
  assert.equal(writes.length, 1, "the truncated first response must never reach fs_write");
  assert.match(writes[0].content, /complete = true/);
  assert.doesNotMatch(writes[0].content, /incomplete/);
  assert.ok(events.some((event) => event.type === "move" && /asking once more/i.test(event.message || "")));
});

test("Crucible steering stays tenant-local and honors guest training opt-out", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /const ideSteeringFlywheel = T\.flywheel \|\| flywheel/);
  assert.match(source, /const mayDistillSteering = !!T\.isOwner \|\| \(!!T\.consented && !T\.trainingOptOut\)/);
  assert.match(source, /ideSteeringFlywheel\.addPipelineLog\(/);
  assert.match(source, /mayDistillSteering && \["format_retry", "verification_retry", "no_change", "false_completion"\]\.includes\(kind\)/);
});

test("AF workers and task-graph units cannot succeed by echoing unchanged files", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /write\.failed\.length \|\| \(!allowEmpty && !write\.written\.length\)/,
    "mutation-required AF workers must reject an all-unchanged write");
  assert.match(source, /write\.failed\.length \|\| !write\.written\.length/,
    "task-graph units must reject an all-unchanged write");
});

test("an exhausted workspace-inspection window returns a resumable incomplete checkpoint", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /const roundsPerEpoch = persistent \? 24 : 12/);
  assert.match(source, /round % roundsPerEpoch === 0[\s\S]{0,180}compactExecutionMessages/);
  assert.match(source, /workspace inspection reached its bounded \$\{maxEpochs\}-epoch\/\$\{maxRounds\}-round/);
  assert.match(source, /checkpoint:\s*true,\s*\n\s*incomplete:\s*true/);
  assert.match(source, /resumeState:\s*\{\s*\n\s*convo,/);
  assert.match(source, /chat\(\{ model: decision\.model, messages, resumeState \}\)/,
    "AF retries must carry provider turns and read cursors across bounded inspection windows");
  assert.match(source, /chat\(\{ model, messages, resumeState \}\)/,
    "task-graph retries must carry provider turns and read cursors across bounded inspection windows");
  assert.doesNotMatch(source, /The read-only inspection window is complete\.[\s\S]{0,500}const final = await ideChatOnce/,
    "a capped inspection must not be converted into a no-tool success turn");
});

test("every Crucible provider call reserves session budget before dispatch and settles actual usage", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /const ideBudgetGuard = \{/);
  assert.match(source, /budget\.capUsd - budget\.spentUsd - budget\.reservedUsd/);
  assert.match(source, /num_predict: permit\.maxOutputTokens \|\| requestedOutputTokens/);
  assert.match(source, /budgetGuard\.settle\(permit, r\)/);
  assert.match(source, /budget\.spentUsd \+= Math\.max\(0, ideCloudCost\(ticket\.model, result\)\)/);
});

test("planned and owned file sets require complete coverage before a build can finish", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /fileCoverage\(move\.files \|\| \[\], own\.kept\)/);
  assert.match(source, /fileCoverage\(r\.grant \|\| \[\], own\.kept\)/);
  assert.match(source, /const chunkUnits = \(part, baseId, baseTitle, contract = ""\)/);
  assert.match(source, /originalParts\.flatMap\(\(part, sourcePart\) =>/);
  assert.match(source, /Planned file was never returned by its assigned implementation step/);
});

test("the final Crucible repair and unfinished-work sweep cover every expected file in batches", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /for \(let offset = 0; offset < repairFiles\.length; offset \+= MAX_FILES_PER_MOVE\)/);
  assert.match(source, /for \(const file of \[\.\.\.expectedFiles\]\)/);
  assert.doesNotMatch(source, /writtenAtGate\.slice\(0, MAX_FILES_PER_MOVE\)/);
});
