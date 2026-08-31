import assert from "node:assert/strict";
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createGameFactoryWorker, normalizeWorkerRequest, processAlive, sanitizeWorkerEnvironment,
  redactWorkerText, workerRequestHash,
} from "./hands/gamefactory-worker.mjs";
import { createGameFactoryWorkerAdapter } from "./gamefactoryworker.mjs";

const root = mkdtempSync(join(tmpdir(), "dominion-gfw-"));
const workspace = join(root, "workspace");
const stateDir = join(root, "state");
const runtimeDir = join(root, "runtime");
mkdirSync(workspace, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for worker state: " + JSON.stringify(last));
}

function request(runId, steps, collect = []) {
  return {
    runId, taskId: `task-${runId}`, projectId: "project-1", capability: "quality_assurance",
    attempt: 1, workspaceRoot: workspace, plan: { steps, collect },
  };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok - " + name); }
  catch (error) { console.error("not ok - " + name); throw error; }
}

try {
  await test("sanitizes credential-looking variables from child environments", async () => {
    const env = sanitizeWorkerEnvironment({
      PATH: "x", API_KEY: "no", HANDS_TOKEN: "no", SAFE_VALUE: "no",
      DATABASE_URL: "postgres://secret", AWS_ACCESS_KEY_ID: "no", GH_PAT: "no", HOME: "unsafe",
    }, { homeDir: join(root, "isolated-home") });
    assert.equal(env.PATH, "x");
    assert.equal(env.SAFE_VALUE, undefined);
    assert.equal(env.API_KEY, undefined);
    assert.equal(env.HANDS_TOKEN, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.GH_PAT, undefined);
    assert.equal(env.HOME, join(root, "isolated-home"));
    assert.equal(env.GAME_FACTORY_WORKER, "1");
  });

  const worker = createGameFactoryWorker({
    stateDir, runtimeDir, isolationAttested: true, toolchainAttested: true, node: "gx10", roots: [workspace], allowedPrograms: ["node"],
    pathGuard: () => ({ ok: true }),
  });

  await test("runs a detached recipe, manifests artifacts, and survives a Hands restart", async () => {
    const script = join(workspace, "success.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync("artifact.txt", "factory-ok"); console.log("built");\n`);
    const input = request("run-success", [{ program: process.execPath, args: [script], cwd: workspace }], ["artifact.txt"]);
    const started = worker.start(input);
    assert.equal(started.ok, true);
    const replay = worker.start(input);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    const done = await waitFor(() => {
      const state = worker.status("run-success");
      return state.status === "SUCCEEDED" ? state : null;
    });
    assert.deepEqual(done.checkpoint, { completedSteps: 1, complete: true, safeBoundary: true });
    const collected = worker.collect("run-success");
    assert.equal(collected.ok, true);
    assert.equal(collected.artifacts.length, 1);
    assert.equal(collected.artifacts[0].path, "artifact.txt");
    assert.match(collected.artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(collected.stdout, /built/);

    const restarted = createGameFactoryWorker({
      stateDir, runtimeDir, isolationAttested: true, toolchainAttested: true, node: "gx10", roots: [workspace], allowedPrograms: ["node"], pathGuard: () => ({ ok: true }),
    });
    assert.equal(restarted.status("run-success").status, "SUCCEEDED");
    const conflict = restarted.start(request("run-success", [{ program: process.execPath, args: [script, "changed"], cwd: workspace }]));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    const duplicateAttempt = restarted.start({
      ...request("run-success-duplicate", [{ program: process.execPath, args: [script], cwd: workspace }]),
      taskId: input.taskId,
    });
    assert.equal(duplicateAttempt.ok, false);
    assert.equal(duplicateAttempt.conflict, true);
    assert.match(duplicateAttempt.error, /task attempt already belongs/);
  });

  await test("rejects inline Node evaluation and paths outside configured roots", async () => {
    const inline = worker.start(request("run-inline", [{ program: process.execPath, args: ["-e", "console.log(1)"], cwd: workspace }]));
    assert.equal(inline.ok, false);
    assert.match(inline.error, /forbidden Node execution flag/);
    const outside = createGameFactoryWorker({ stateDir: join(root, "other-state"), runtimeDir: join(root, "other-runtime"), isolationAttested: true, toolchainAttested: true, node: "gx10", roots: [join(root, "not-workspace")], allowedPrograms: ["node"] });
    assert.match(outside.start(request("run-outside", [{ program: process.execPath, args: ["nothing.mjs"], cwd: workspace }])).error, /configured roots/);
    const script = join(workspace, "success.mjs");
    const lookalike = worker.start(request("run-lookalike", [{ program: join(workspace, "node.exe"), args: [script], cwd: workspace }]));
    assert.equal(lookalike.ok, false);
    assert.match(lookalike.error, /absolute executable path|Node runtime/);
    const traversal = worker.start(request("run-traversal", [{ program: process.execPath, args: [script, "nested/../../../outside"], cwd: workspace }]));
    assert.equal(traversal.ok, false);
    assert.match(traversal.error, /escapes the workspace/);
    const secret = worker.start(request("run-secret-arg", [{ program: process.execPath, args: [script, "api_key=do-not-persist"], cwd: workspace }]));
    assert.equal(secret.ok, false);
    assert.match(secret.error, /credential material/);
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(10)}`;
    assert.match(worker.start(request("run-jwt-arg", [{ program: process.execPath, args: [script, jwt], cwd: workspace }])).error, /credential material/);
    assert.match(worker.start(request("run-json-secret", [{ program: process.execPath, args: [script, '{"password":"do-not-persist"}'], cwd: workspace }])).error, /credential material/);
    assert.match(worker.start(request("run-basic-auth", [{ program: process.execPath, args: [script, "Authorization: Basic Zm9vOmJhcg=="], cwd: workspace }])).error, /credential material/);
    const reporterInjection = worker.start(request("run-node-reporter", [{ program: process.execPath, args: ["--test", "--test-reporter=data:text/javascript,export default class X{}", script], cwd: workspace }]));
    assert.equal(reporterInjection.ok, false);
    assert.match(reporterInjection.error, /forbidden Node execution flag/);
    assert.throws(() => normalizeWorkerRequest(request("run-response-file", [{ program: process.execPath, args: [script, "@C:\\outside\\args.txt"], cwd: workspace }]), { roots: [workspace], allowedPrograms: ["node"] }), /response-file argument/);
    assert.throws(() => normalizeWorkerRequest(request("run-java-agent", [{ program: "java", args: ["-javaagent:C:\\outside\\agent.jar", "Main"], cwd: workspace }]), { roots: [workspace], allowedPrograms: ["java"] }), /forbidden Java agent/);
    assert.throws(() => normalizeWorkerRequest(request("run-gradle-init", [{ program: "gradle", args: ["-IC:\\outside\\init.gradle", "build"], cwd: workspace }]), { roots: [workspace], allowedPrograms: ["gradle"] }), /forbidden Gradle init-script/);
    assert.match(worker.start({ ...request("run-secret-build", [{ program: process.execPath, args: [script], cwd: workspace }]), buildId: "password=do-not-persist" }).error, /buildId contains credential material/);
    assert.match(worker.start({ ...request("run-bad-attempt", [{ program: process.execPath, args: [script], cwd: workspace }]), attempt: 1.5 }).error, /positive protocol integer/);
    assert.match(worker.start({ ...request("run-too-many-collect", [{ program: process.execPath, args: [script], cwd: workspace }]), plan: { steps: [{ program: process.execPath, args: [script], cwd: workspace }], collect: Array.from({ length: 101 }, (_, i) => `artifact-${i}`) } }).error, /artifact limit/);
    const outsideDir = join(root, "outside-link-target");
    mkdirSync(outsideDir, { recursive: true });
    const linked = join(workspace, "outside-link");
    symlinkSync(outsideDir, linked, "junction");
    const linkedEscape = worker.start(request("run-linked-escape", [{ program: process.execPath, args: [script, "outside-link/new-output.txt"], cwd: workspace }]));
    assert.equal(linkedEscape.ok, false);
    assert.match(linkedEscape.error, /link outside the workspace/);
    const forgedResume = worker.start({
      ...request("run-forged-resume", [{ program: process.execPath, args: [script], cwd: workspace }]),
      attempt: 2, resumeFrom: { completedSteps: 1, complete: true, safeBoundary: true },
    });
    assert.equal(forgedResume.ok, false);
    assert.match(forgedResume.error, /resume lineage/);
  });

  await test("provisioning fails closed without separate runtime and isolation attestation", async () => {
    const script = join(workspace, "success.mjs");
    const noAttestation = createGameFactoryWorker({
      stateDir: join(root, "unattested-state"), runtimeDir: join(root, "unattested-runtime"),
      node: "gx10", roots: [workspace], allowedPrograms: ["node"],
    });
    assert.equal(noAttestation.probe().ok, false);
    assert.equal(noAttestation.probe().isolationRequired, true);
    assert.match(noAttestation.start(request("run-unattested", [{ program: process.execPath, args: [script], cwd: workspace }])).error, /isolation attestation/);
    const noRuntime = createGameFactoryWorker({
      stateDir: join(root, "no-runtime-state"), isolationAttested: true, toolchainAttested: true,
      node: "gx10", roots: [workspace], allowedPrograms: ["node"],
    });
    assert.equal(noRuntime.probe().ok, false);
    assert.match(noRuntime.probe().error, /separate GAME_FACTORY_WORKER_RUNTIME_DIR/);
    const noToolchain = createGameFactoryWorker({
      stateDir: join(root, "no-toolchain-state"), runtimeDir: join(root, "no-toolchain-runtime"), isolationAttested: true,
      node: "gx10", roots: [workspace], allowedPrograms: ["node"],
    });
    assert.equal(noToolchain.probe().ok, false);
    assert.match(noToolchain.probe().error, /toolchain attestation/);
    const overlapping = createGameFactoryWorker({
      stateDir: join(workspace, "unsafe-state"), runtimeDir: join(root, "safe-runtime"), isolationAttested: true, toolchainAttested: true,
      node: "gx10", roots: [workspace], allowedPrograms: ["node"],
    });
    assert.match(overlapping.start(request("run-overlap", [{ program: process.execPath, args: [script], cwd: workspace }])).error, /must not overlap/);
    assert.equal(worker.describe().secureForUntrustedCode, false);
    assert.equal(worker.describe().isolationAttested, true);
    assert.equal(worker.describe().separateRuntimeDirectory, true);
    assert.equal(worker.describe().toolchainAttested, true);
  });

  await test("recovers a crash after immutable intent but before launch state", async () => {
    const script = join(workspace, "recovered.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync("recovered.txt", "ok");\n`);
    const input = request("run-intent-only", [{ program: process.execPath, args: [script], cwd: workspace }], ["recovered.txt"]);
    const normalized = normalizeWorkerRequest(input, { roots: [workspace], allowedPrograms: ["node"] });
    const stored = { ...normalized, requestHash: workerRequestHash(normalized) };
    const runDir = join(stateDir, "run-" + createHash("sha256").update(input.runId).digest("hex").slice(0, 32));
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "request.json"), JSON.stringify(stored, null, 2) + "\n");
    const recovered = worker.start(input);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.replayed, true);
    await waitFor(() => worker.status(input.runId).status === "SUCCEEDED");
    assert.equal(existsSync(join(workspace, "recovered.txt")), true);
  });

  await test("redacts secret-shaped child output before it reaches disk or collection", async () => {
    const marker = "worker-log-secret-7812";
    const script = join(workspace, "redact-log.mjs");
    writeFileSync(script, `console.log("api_key=${marker}"); console.log("DATABASE_URL=postgres://owner:${marker}@db.example/game"); console.log(JSON.stringify({password:"${marker}"})); console.log("Authorization: Basic ${marker}"); console.log("Cookie: sid=${marker}"); process.stdout.write("A".repeat(140000) + JSON.stringify({password:"${marker}"}) + "\\n"); console.error("Bearer ${marker}"); console.error("-----BEGIN PRIVATE KEY-----\\n${marker}");\n`);
    assert.equal(worker.start(request("run-redacted-log", [{ program: process.execPath, args: [script], cwd: workspace }])).ok, true);
    await waitFor(() => worker.status("run-redacted-log").status === "SUCCEEDED");
    const collected = worker.collect("run-redacted-log");
    assert.equal(JSON.stringify(collected).includes(marker), false);
    assert.match(collected.stdout, /redacted/);
    assert.match(collected.stderr, /redacted/);
    const runDir = join(stateDir, "run-" + createHash("sha256").update("run-redacted-log").digest("hex").slice(0, 32));
    assert.equal(readFileSync(join(runDir, "stdout.log"), "utf8").includes(marker), false);
    assert.equal(readFileSync(join(runDir, "stderr.log"), "utf8").includes(marker), false);
    assert.equal(redactWorkerText(`{"password":"${marker}"}`).includes(marker), false);
    assert.equal(redactWorkerText(`Authorization: Basic ${marker}`).includes(marker), false);
    assert.equal(redactWorkerText(`-----BEGIN PRIVATE KEY-----\n${marker}`, 50).includes(marker), false);
  });

  await test("safe cancellation waits for the current step boundary", async () => {
    const first = join(workspace, "safe-first.mjs");
    const second = join(workspace, "safe-second.mjs");
    writeFileSync(first, `import { writeFileSync } from "node:fs"; await new Promise(r => setTimeout(r, 350)); writeFileSync("safe-first.txt", "done");\n`);
    writeFileSync(second, `import { writeFileSync } from "node:fs"; writeFileSync("safe-second.txt", "should-not-run");\n`);
    const input = request("run-safe-cancel", [
      { program: process.execPath, args: [first], cwd: workspace },
      { program: process.execPath, args: [second], cwd: workspace },
    ]);
    assert.equal(worker.start(input).ok, true);
    await waitFor(() => {
      const state = worker.status("run-safe-cancel");
      return state.status === "RUNNING" && state.childPid ? state : null;
    });
    const requested = worker.cancel("run-safe-cancel", { mode: "safe", reason: "pause test" });
    assert.equal(requested.status, "CANCEL_REQUESTED");
    const paused = await waitFor(() => {
      const state = worker.status("run-safe-cancel");
      return state.status === "PAUSED" ? state : null;
    });
    assert.equal(paused.checkpoint.completedSteps, 1);
    assert.equal(paused.checkpoint.safeBoundary, true);
    assert.equal(existsSync(join(workspace, "safe-first.txt")), true);
    assert.equal(existsSync(join(workspace, "safe-second.txt")), false);
    const resumedInput = { ...input, runId: "run-safe-cancel-resumed", attempt: 2, resumeFrom: paused.checkpoint };
    assert.equal(worker.start(resumedInput).ok, true);
    await waitFor(() => worker.status(resumedInput.runId).status === "SUCCEEDED");
    assert.equal(existsSync(join(workspace, "safe-second.txt")), true);
  });

  await test("immediate cancellation terminates the detached process tree", async () => {
    const script = join(workspace, "long.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; await new Promise(r => setTimeout(r, 15000)); writeFileSync("too-late.txt", "bad");\n`);
    assert.equal(worker.start(request("run-immediate", [{ program: process.execPath, args: [script], cwd: workspace }])).ok, true);
    const running = await waitFor(() => {
      const state = worker.status("run-immediate");
      return state.status === "RUNNING" && state.runnerPid && state.childPid ? state : null;
    });
    const busy = worker.start(request("run-over-capacity", [{ program: process.execPath, args: [script], cwd: workspace }]));
    assert.equal(busy.ok, false);
    assert.equal(busy.busy, true);
    assert.equal(busy.retryable, true);
    const cancelled = worker.cancel("run-immediate", { mode: "immediate", reason: "stop test" });
    assert.equal(cancelled.status, "CANCELLED");
    await waitFor(() => !processAlive(running.runnerPid), { timeoutMs: 10_000 });
    assert.equal(worker.status("run-immediate").status, "CANCELLED");
    assert.equal(existsSync(join(workspace, "too-late.txt")), false);
  });

  await test("adapter always dispatches to the configured node and checks provenance", async () => {
    const calls = [];
    const adapter = createGameFactoryWorkerAdapter({
      node: "GX10",
      dispatch: async (node, tool, args) => {
        calls.push({ node, tool, args });
        return { ok: true, node: "gx10", status: "RUNNING", runId: args.runId || "r" };
      },
    });
    assert.equal((await adapter.probe()).ok, true);
    assert.equal((await adapter.status("run-1")).ok, true);
    assert.deepEqual(calls.map((call) => call.node), ["gx10", "gx10"]);
    assert.deepEqual(calls.map((call) => call.tool), ["game_factory_probe", "game_factory_status"]);
    const invalidRun = await adapter.status("r".repeat(241));
    assert.equal(invalidRun.refused, true);
    assert.equal(calls.length, 2);

    const wrong = createGameFactoryWorkerAdapter({ node: "gx10", dispatch: async () => ({ ok: true, node: "mini" }) });
    const refused = await wrong.probe();
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, true);
    const missingProvenance = createGameFactoryWorkerAdapter({ node: "gx10", dispatch: async () => ({ ok: true }) });
    assert.equal((await missingProvenance.probe()).refused, true);
    const disabled = createGameFactoryWorkerAdapter({ node: "", dispatch: async () => { throw new Error("must not call"); } });
    assert.equal((await disabled.probe()).disabled, true);

    const marker = "adapter-secret-marker-991";
    const redacting = createGameFactoryWorkerAdapter({ node: "gx10", dispatch: async () => ({
      ok: true, node: "gx10",
      stdout: `api_key=${marker}\n{"password":"${marker}"}\nAuthorization: Basic ${marker}\nCookie: sid=${marker}\n-----BEGIN PRIVATE KEY-----\n${marker}`,
    }) });
    const cleanResult = await redacting.collect("run-1");
    assert.equal(JSON.stringify(cleanResult).includes(marker), false);
    assert.match(cleanResult.stdout, /redacted/);
  });

  await test("Hands exposes the protocol when configured and old minimal bundles still boot when disabled", async () => {
    const actualHands = join(process.cwd(), "hands", "hands.mjs");
    const handsUrl = pathToFileURL(actualHands).href;
    const configuredState = join(root, "hands-state");
    const probeCode = `import { executeJob } from ${JSON.stringify(handsUrl)}; console.log(JSON.stringify(await executeJob("game_factory_probe", {})));`;
    const probed = spawnSync(process.execPath, ["--input-type=module", "-e", probeCode], {
      encoding: "utf8", timeout: 15_000,
      env: {
        ...process.env, HANDS_ROOTS: workspace, GAME_FACTORY_WORKER_DIR: configuredState,
        GAME_FACTORY_WORKER_RUNTIME_DIR: join(root, "hands-runtime"), GAME_FACTORY_WORKER_ISOLATION_ATTESTED: "1",
        GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED: "1", GAME_FACTORY_WORKER_PROGRAMS: "node", HANDS_NODE: "gx10",
      },
    });
    assert.equal(probed.status, 0, probed.stderr);
    const response = JSON.parse(probed.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(response.ok, true);
    assert.equal(response.node, "gx10");
    assert.equal(response.protocol, "game-factory-worker/1");

    const minimal = join(root, "minimal-hands");
    mkdirSync(minimal, { recursive: true });
    copyFileSync(actualHands, join(minimal, "hands.mjs"));
    copyFileSync(join(process.cwd(), "hands", "snapshot.mjs"), join(minimal, "snapshot.mjs"));
    const minimalUrl = pathToFileURL(join(minimal, "hands.mjs")).href;
    const infoCode = `import { executeJob } from ${JSON.stringify(minimalUrl)}; console.log(JSON.stringify(await executeJob("node_info", {})));`;
    const infoRun = spawnSync(process.execPath, ["--input-type=module", "-e", infoCode], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, GAME_FACTORY_WORKER_DIR: "" },
    });
    assert.equal(infoRun.status, 0, infoRun.stderr);
    const info = JSON.parse(infoRun.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(info.ok, true);
    assert.equal(info.gameFactoryWorker.configured, false);
  });

  console.log(`\n${passed} game factory worker tests passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
