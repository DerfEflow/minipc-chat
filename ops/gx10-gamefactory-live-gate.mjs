#!/usr/bin/env node
/*
 * Reproducible live gate for the dedicated GX10 static Game Factory broker.
 * Run this as the fixed controller identity (uid/gid 10001, supplementary gid
 * 11000). It does not need a Hands token and never mounts the workspace.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createGameFactoryBrokerController } from "../hands/gamefactory-broker-controller.mjs";
import { decodeBrokerReadiness, decodeBrokerResult } from "../hands/gamefactory-broker-protocol.mjs";

const COMMANDS = resolve(process.env.GX10_GAME_FACTORY_COMMANDS || "/srv/dominion-game-factory/commands-loop");
const RESULTS = resolve(process.env.GX10_GAME_FACTORY_RESULTS || "/srv/dominion-game-factory/broker-results-loop");
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "PAUSED"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");

function fail(message) { throw new Error(message); }
function deviceParts(value) {
  const device = BigInt(value);
  return {
    major: ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor: (device & 0xffn) | ((device >> 12n) & 0xffffff00n),
  };
}
function assertActiveGenerationLease(ready) {
  if (process.platform !== "linux") fail("the live gate requires Linux kernel lock evidence");
  const expected = deviceParts(ready.leaseDev);
  const matches = readFileSync("/proc/locks", "utf8").split(/\r?\n/).filter(Boolean).filter((line) => {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/i.exec(line);
    return !!match && BigInt(`0x${match[1]}`) === expected.major
      && BigInt(`0x${match[2]}`) === expected.minor && match[3] === ready.leaseIno;
  });
  assert.equal(matches.length, 1, "readiness does not bind to exactly one active per-generation kernel flock");
}
function runKey(runId) { return sha(runId).slice(0, 32); }
function journal(runId) {
  return JSON.parse(readFileSync(resolve(COMMANDS, `run-${runKey(runId)}.json`), "utf8"));
}
function rawResults(runId) {
  const value = journal(runId);
  return value.packets.flatMap((packet) => {
    try {
      const bytes = readFileSync(resolve(RESULTS, `result-${packet.generationId}.bin`));
      return [{ bytes, value: decodeBrokerResult(bytes) }];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  });
}

const ready = decodeBrokerReadiness(readFileSync(resolve(RESULTS, "broker-ready.bin")));
assertActiveGenerationLease(ready);
const expected = Object.fromEntries([
  "brokerBinarySha256", "nodeGuardSha256", "godotGuardSha256", "nodeExecutableSha256",
  "godotExecutableSha256", "nodeFilterSha256", "godotFilterSha256", "appArmorPolicySha256",
  "outerSeccompSha256", "deploymentPolicySha256",
].map((field) => [field, ready[field]]));
const controller = createGameFactoryBrokerController({
  commandDir: COMMANDS,
  resultDir: RESULTS,
  node: "gx10-gamefactory-live-gate",
  brokerOwnerUid: 10003,
  spoolGid: 11000,
  expected,
  isolationAttested: true,
  toolchainAttested: true,
});

const SCENARIOS = Object.freeze({
  fast: {
    taskId: "gx10-live-fast", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-fast.mjs"], cwdRelative: ".", timeoutMs: 15_000 }], collect: [] },
  },
  isolation: {
    taskId: "gx10-live-isolation", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-isolation.mjs"], cwdRelative: ".", timeoutMs: 30_000 }], collect: [] },
  },
  output: {
    taskId: "gx10-live-output-cap", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-output-cap.mjs"], cwdRelative: ".", timeoutMs: 30_000 }], collect: [] },
  },
  artifact: {
    taskId: "gx10-live-artifact", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-artifact.mjs"], cwdRelative: ".", timeoutMs: 30_000 }],
      collect: ["dist/index.html", "dist/manifest.json"] },
  },
  long: {
    taskId: "gx10-live-long", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-long.mjs"], cwdRelative: ".", timeoutMs: 120_000 }], collect: [] },
  },
  quota_blocks: {
    taskId: "gx10-live-quota-blocks", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-quota.mjs", "blocks"], cwdRelative: ".", timeoutMs: 600_000 }], collect: [] },
  },
  quota_inodes: {
    taskId: "gx10-live-quota-inodes", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "node", args: ["live-quota.mjs", "inodes"], cwdRelative: ".", timeoutMs: 600_000 }], collect: [] },
  },
  pause: {
    taskId: "gx10-live-pause", projectId: "system-canary", capability: "quality_assurance",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [
      { program: "node", args: ["live-fast.mjs"], cwdRelative: ".", timeoutMs: 15_000 },
      { program: "node", args: ["live-artifact.mjs"], cwdRelative: ".", timeoutMs: 30_000 },
    ], collect: [] },
  },
  godot: {
    taskId: "gx10-live-godot-web", projectId: "system-canary", capability: "godot",
    workspaceRoot: "/workspace/system-canary",
    plan: { steps: [{ program: "godot", args: ["--headless", "--path", "godot-canary", "--export-release", "Web",
      "dist/index.html"], cwdRelative: ".", timeoutMs: 600_000 }],
      collect: [
        "godot-canary/dist/index.apple-touch-icon.png",
        "godot-canary/dist/index.audio.position.worklet.js",
        "godot-canary/dist/index.audio.worklet.js",
        "godot-canary/dist/index.html",
        "godot-canary/dist/index.icon.png",
        "godot-canary/dist/index.js",
        "godot-canary/dist/index.pck",
        "godot-canary/dist/index.png",
        "godot-canary/dist/index.wasm",
      ] },
  },
});

function recipe(name, runId, resumeFrom = null) {
  const base = SCENARIOS[name];
  if (!base) fail(`unknown scenario: ${name}`);
  return { ...base, runId, ...(resumeFrom ? { resumeFrom } : {}) };
}
async function waitFor(runId, { timeoutMs = 180_000, advance = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = controller.status(runId, { advance });
    if (!current.ok || TERMINAL.has(current.status) || current.status === "SAFE_BOUNDARY") return current;
    await delay(100);
  }
  fail(`timed out waiting for ${runId}: ${JSON.stringify(current)}`);
}
async function acknowledge(runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = controller.acknowledge(runId);
    if (!current.ok || current.retentionPruned === true) return current;
    await delay(100);
  }
  fail(`timed out waiting for retention pruning: ${JSON.stringify(current)}`);
}
async function complete(name, runId, expectedState = "SUCCEEDED") {
  const started = controller.start(recipe(name, runId));
  assert.equal(started.ok, true, started.error);
  const longGate = name === "godot" || name === "quota_blocks" || name === "quota_inodes";
  const terminal = await waitFor(runId, { timeoutMs: longGate ? 700_000 : 180_000 });
  assert.equal(terminal.ok, true, terminal.error);
  assert.equal(terminal.status, expectedState, JSON.stringify(terminal));
  assert.equal(terminal.cancellationResolved, true, JSON.stringify(terminal));
  const collected = controller.collect(runId);
  assert.equal(collected.ok, true, collected.error);
  const raw = rawResults(runId);
  assert.ok(raw.length >= 1);
  const last = raw.at(-1).value;
  assert.notEqual(last.payloadState, "unresolved");
  const pruned = await acknowledge(runId);
  assert.equal(pruned.ok, true, pruned.error);
  assert.equal(pruned.retentionPruned, true, JSON.stringify(pruned));
  return { started, terminal, collected, raw: raw.map((item) => item.value), pruned };
}

async function main() {
  assert.equal(process.platform, "linux", "live gate requires Linux");
  assert.equal(process.getuid(), 10001, "live gate requires controller uid 10001");
  assert.equal(process.getgid(), 10001, "live gate requires controller gid 10001");
  const [command, name, runId, extra] = process.argv.slice(2);
  if (command === "probe") {
    const value = controller.probe();
    assert.equal(value.ok, true, value.error);
    console.log(JSON.stringify({ command, value, ready }));
    return;
  }
  if (command === "start") {
    const value = controller.start(recipe(name, runId));
    console.log(JSON.stringify({ command, name, runId, value }));
    if (!value.ok) process.exitCode = 1;
    return;
  }
  if (command === "wait") {
    const value = await waitFor(name, { timeoutMs: Number(runId) || 180_000, advance: extra !== "no-advance" });
    console.log(JSON.stringify({ command, runId: name, value, raw: rawResults(name).map((item) => item.value) }));
    return;
  }
  if (command === "cancel") {
    const value = controller.cancel(name, { mode: runId || "immediate", reason: "GX10 live gate" });
    console.log(JSON.stringify({ command, runId: name, value }));
    if (!value.ok) process.exitCode = 1;
    return;
  }
  if (command === "ack") {
    const value = await acknowledge(name);
    console.log(JSON.stringify({ command, runId: name, value }));
    if (!value.ok) process.exitCode = 1;
    return;
  }
  if (command === "ack-once") {
    const value = controller.acknowledge(name);
    console.log(JSON.stringify({ command, runId: name, value }));
    if (!value.ok) process.exitCode = 1;
    return;
  }
  if (command === "inspect") {
    console.log(JSON.stringify({ command, runId: name, journal: journal(name),
      raw: rawResults(name).map((item) => item.value) }));
    return;
  }
  if (command === "run") {
    const value = await complete(name, runId, extra || "SUCCEEDED");
    console.log(JSON.stringify({ command, name, runId, value }));
    return;
  }
  if (command === "pause") {
    const started = controller.start(recipe("pause", name));
    assert.equal(started.ok, true, started.error);
    let boundary;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      boundary = controller.status(name, { advance: false });
      if (!boundary.ok || boundary.status === "SAFE_BOUNDARY") break;
      await delay(100);
    }
    assert.equal(boundary.ok, true, boundary.error);
    assert.equal(boundary.status, "SAFE_BOUNDARY", JSON.stringify(boundary));
    const paused = controller.cancel(name, { mode: "safe", reason: "GX10 live safe-boundary gate" });
    assert.equal(paused.ok, true, paused.error);
    assert.equal(paused.status, "PAUSED", JSON.stringify(paused));
    assert.ok(paused.checkpoint?.lineage);
    const resumedId = runId;
    const resumed = controller.start(recipe("pause", resumedId, paused.checkpoint.lineage));
    assert.equal(resumed.ok, true, resumed.error);
    const terminal = await waitFor(resumedId);
    assert.equal(terminal.ok, true, terminal.error);
    assert.equal(terminal.status, "SUCCEEDED", JSON.stringify(terminal));
    const pruned = await acknowledge(resumedId);
    assert.equal(pruned.ok, true, pruned.error);
    assert.equal(pruned.retentionPruned, true, JSON.stringify(pruned));
    console.log(JSON.stringify({ command, sourceRunId: name, resumedId, started, paused, resumed, terminal, pruned }));
    return;
  }
  fail("usage: probe | start SCENARIO RUN_ID | wait RUN_ID [TIMEOUT] [no-advance] | cancel RUN_ID [immediate|safe] | ack RUN_ID | ack-once RUN_ID | inspect RUN_ID | run SCENARIO RUN_ID [EXPECTED_STATE] | pause SOURCE_RUN_ID RESUMED_RUN_ID");
}

await main();
