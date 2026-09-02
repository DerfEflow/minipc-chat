import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyExecutorRecovery, selectExecutorCancellation } from "./hands/gamefactory-executor.mjs";

// The executor topology is retained only as inert source history. Keep this legacy test filename
// stable for existing runners, but exercise the active controller→static-broker contract instead.
const ACTIVE_STATIC_BROKER_TOPOLOGY = true;
if (ACTIVE_STATIC_BROKER_TOPOLOGY) {
  await import("./gamefactorybroker_static_test.mjs");
} else {
const ROOT = dirname(fileURLToPath(import.meta.url));
const HANDS = join(ROOT, "hands");
const text = (path) => readFileSync(join(HANDS, path), "utf8");
const legacyCompose = text("docker-compose.yml");
const compose = text("docker-compose.gx10-worker.yml");
const dockerfile = text("gx10-gamefactory/Dockerfile");
const overlay = text("gx10-gamefactory/Dockerfile.overlay");
const envExample = text("gx10-worker.env.example");
const handsSource = text("hands.mjs");
const controllerSource = text("gamefactory-controller.mjs");
const executorSource = text("gamefactory-executor.mjs");
const ipcSource = text("gamefactory-ipc.mjs");
const controllerSeccomp = JSON.parse(text("gx10-gamefactory/seccomp-gx10-gamefactory-controller.json"));
const executorSeccomp = JSON.parse(text("gx10-gamefactory/seccomp-gx10-gamefactory-executor.json"));

const controllerStage = dockerfile.slice(dockerfile.indexOf(" AS controller"), dockerfile.indexOf(" AS executor"));
const executorStage = dockerfile.slice(dockerfile.indexOf(" AS executor"));
const controllerService = compose.slice(compose.indexOf("  gx10-game-factory-controller:"), compose.indexOf("  gx10-game-factory-executor:"));
const executorService = compose.slice(compose.indexOf("  gx10-game-factory-executor:"));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok - " + name); }
  catch (error) { console.error("not ok - " + name); throw error; }
}
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await test("legacy Hands topology remains separate from the factory lane", () => {
  assert.match(legacyCompose, /container_name:\s*dominion-hands/);
  assert.match(legacyCompose, /- \/:\/host:rw/);
  assert.doesNotMatch(compose, /dominion-hands-gx10(?:\s|$)/);
  assert.match(compose, /^name:\s*dominion-gx10-game-factory$/m);
});

await test("controller image contains no executor, toolchain, browser, or shell surface", () => {
  for (const module of ["hands.mjs", "snapshot.mjs", "gamefactory-controller.mjs", "gamefactory-ipc.mjs", "gx10-controller-entrypoint.mjs"]) {
    assert.match(controllerStage, new RegExp(escaped(module)), `controller omits ${module}`);
  }
  for (const forbidden of ["gamefactory-worker.mjs", "gamefactory-executor.mjs", "gamefactory-runner.mjs", "browser.mjs", "desktop.mjs", "/usr/bin/bwrap", "/opt/godot"]) {
    assert.doesNotMatch(controllerStage, new RegExp(escaped(forbidden)), `controller includes ${forbidden}`);
  }
  assert.match(controllerStage, /USER 10001:10001/);
  assert.match(controllerStage, /groups 11000/);
  assert.match(controllerStage, /ENTRYPOINT \["node", "\/app\/gx10-controller-entrypoint[.]mjs"\]/);
});

await test("executor image is tokenless Web/Godot-only with a direct Godot binary", () => {
  for (const module of ["gamefactory-worker.mjs", "gamefactory-executor.mjs", "gamefactory-ipc.mjs", "gx10-executor-entrypoint.mjs"]) {
    assert.match(executorStage, new RegExp(escaped(module)), `executor omits ${module}`);
  }
  for (const forbidden of ["hands.mjs", "snapshot.mjs", "gamefactory-controller.mjs", "browser.mjs", "desktop.mjs", "gamefactory-runner.mjs"]) {
    assert.doesNotMatch(executorStage, new RegExp(escaped(forbidden)), `executor includes ${forbidden}`);
  }
  assert.match(executorStage, /Godot_v\$\{GODOT_VERSION\}-stable_linux[.]arm64/);
  assert.match(executorStage, /ln -s "\/opt\/godot\/Godot_v\$\{GODOT_VERSION\}-stable_linux[.]arm64" \/usr\/local\/bin\/godot/);
  assert.doesNotMatch(executorStage, /godot-wrapper|sdkmanager|--licenses|openjdk|android-sdk|ANDROID_(?:HOME|SDK_ROOT)|\bgradle\b/i);
  assert.match(executorStage, /USER 10002:10002/);
  assert.match(executorStage, /ENTRYPOINT \["node", "\/app\/gx10-executor-entrypoint[.]mjs"\]/);
  assert.match(overlay, /Android[^\n]*disabled/i);
  assert.match(overlay, /exit 78/);
});

await test("compose enforces separate identities, cgroups, profiles, and credentials", () => {
  for (const block of [controllerService, executorService]) {
    assert.match(block, /privileged:\s*false/);
    assert.match(block, /read_only:\s*true/);
    assert.match(block, /cap_drop:\s*\n\s*- ALL/);
    assert.match(block, /no-new-privileges:true/);
    assert.match(block, /apparmor=dominion-gx10-gamefactory-/);
    assert.match(block, /seccomp=\$\{GX10_GAME_FACTORY_/);
    assert.match(block, /group_add:\s*\n\s*- "11000"/);
    assert.match(block, /pids_limit:\s*\d+/);
    assert.match(block, /mem_limit:/);
    assert.match(block, /memswap_limit:/);
    assert.match(block, /restart:\s*unless-stopped/);
  }
  assert.match(controllerService, /user:\s*"10001:10001"/);
  assert.match(controllerService, /HANDS_TOKEN:/);
  assert.match(controllerService, /HANDS_NODE:\s*gx10-gamefactory/);
  assert.match(controllerService, /GAME_FACTORY_CONTROLLER_ONLY:\s*"1"/);
  assert.match(executorService, /user:\s*"10002:10002"/);
  assert.match(executorService, /network_mode:\s*none/);
  assert.doesNotMatch(executorService, /\bHANDS_[A-Z0-9_]+\s*:/);
  assert.notEqual(controllerService.match(/pids_limit:\s*(\d+)/)?.[1], executorService.match(/pids_limit:\s*(\d+)/)?.[1]);
  assert.doesNotMatch(compose, /\bcap_add\s*:|docker[.]sock|\bpid:\s*host\b|\bipc:\s*host\b|\bnetwork_mode:\s*host\b/);
});

await test("directional mounts keep workspace/runtime and writes out of the controller", () => {
  assert.match(controllerService, /GX10_GAME_FACTORY_COMMANDS[\s\S]*?target:\s*\/commands[\s\S]*?read_only:\s*false/);
  assert.match(controllerService, /GX10_GAME_FACTORY_REPLIES[\s\S]*?target:\s*\/replies[\s\S]*?read_only:\s*true/);
  assert.doesNotMatch(controllerService, /target:\s*\/(?:workspace|runtime|state)\b/);
  assert.match(executorService, /GX10_GAME_FACTORY_COMMANDS[\s\S]*?target:\s*\/commands[\s\S]*?read_only:\s*true/);
  assert.match(executorService, /GX10_GAME_FACTORY_REPLIES[\s\S]*?target:\s*\/replies[\s\S]*?read_only:\s*false/);
  assert.match(executorService, /GX10_GAME_FACTORY_WORKSPACE[\s\S]*?target:\s*\/workspace[\s\S]*?read_only:\s*false/);
  assert.match(executorService, /GX10_GAME_FACTORY_RUNTIME[\s\S]*?target:\s*\/runtime[\s\S]*?read_only:\s*false/);
  assert.equal((compose.match(/^\s+create_host_path:\s*false\s*$/gm) || []).length, 6);
});

await test("capabilities and sandbox defaults remain blocked and Web-only", () => {
  assert.match(controllerService, /GAME_FACTORY_WORKER_ISOLATION_ATTESTED:\s*"\$\{GAME_FACTORY_WORKER_ISOLATION_ATTESTED:-0\}"/);
  assert.match(controllerService, /GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED:\s*"\$\{GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED:-0\}"/);
  assert.match(controllerService, /GAME_FACTORY_WORKER_SANDBOX_REQUIRED:\s*"1"/);
  assert.match(executorService, /GAME_FACTORY_WORKER_SANDBOX_PROGRAM:\s*\/usr\/bin\/bwrap/);
  assert.match(executorService, /GAME_FACTORY_WORKER_PROGRAMS:\s*node,godot/);
  assert.match(executorService, /XDG_DATA_HOME:\s*\/opt\/godot-data/);
  assert.match(controllerSource, /allowedCapabilities = \["quality_assurance", "godot"\]/);
  assert.doesNotMatch(controllerSource, /allowedCapabilities = \[[^\]]*"web"/);
  assert.match(envExample, /^GAME_FACTORY_WORKER_ISOLATION_ATTESTED=0$/m);
  assert.match(envExample, /^GAME_FACTORY_WORKER_TOOLCHAIN_ATTESTED=0$/m);
  assert.match(envExample, /Android[^\n]*disabled/i);
});

await test("controller-only dispatch and module split remove generic token-side execution", () => {
  assert.match(handsSource, /GAME_FACTORY_CONTROLLER_ONLY/);
  for (const operation of ["node_info", "game_factory_probe", "game_factory_start", "game_factory_authorization_absent",
    "game_factory_status", "game_factory_cancel", "game_factory_collect", "game_factory_acknowledge"]) {
    assert.match(handsSource, new RegExp(`"${operation}"`));
  }
  assert.match(handsSource, /token-bearing Hands process is restricted to the game-factory controller protocol/);
  assert.doesNotMatch(controllerSource, /node:child_process|gamefactory-worker|gamefactory-runner|\bspawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(executorSource, /from\s+["'][.\/]hands[.]mjs|from\s+["'][.\/]gamefactory-controller[.]mjs|process[.]env[.]HANDS_/);
  assert.doesNotMatch(ipcSource, /node:child_process|\bspawn(?:Sync)?\s*\(/);
});

await test("seccomp keeps ordinary threads, exact bwrap namespaces, and clone3 fallback", () => {
  for (const profile of [controllerSeccomp, executorSeccomp]) {
    const allows = profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW");
    assert.equal(allows.some((rule) => rule.names?.includes("clone") && !(rule.args || []).length), false);
    assert.equal(allows.some((rule) => rule.names?.includes("clone") && rule.args?.some((arg) => arg.op === "SCMP_CMP_MASKED_EQ" && arg.value === 2114060288 && arg.valueTwo === 0)), true);
    const clone3 = profile.syscalls.find((rule) => rule.names?.includes("clone3"));
    assert.equal(clone3?.action, "SCMP_ACT_ERRNO"); assert.equal(clone3?.errnoRet, 38);
    for (const forbidden of ["ptrace", "process_vm_readv", "process_vm_writev", "socketcall"]) {
      assert.equal(allows.some((rule) => rule.names?.includes(forbidden)), false, `${forbidden} is allowed`);
    }
  }
  const executorAllows = executorSeccomp.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW");
  assert.equal(executorAllows.some((rule) => rule.names?.includes("clone") && rule.args?.some((arg) => arg.op === "SCMP_CMP_EQ" && arg.value === 2080505873)), true);
  assert.equal(executorAllows.some((rule) => rule.names?.includes("socket")), false);
  const controllerFamilies = controllerSeccomp.syscalls.filter((rule) => rule.names?.includes("socket")).map((rule) => rule.args?.[0]?.value).sort((a, b) => a - b);
  assert.deepEqual(controllerFamilies, [2, 10, 16]);
});

await test("recovery never replays an orphan and immediate cancellation dominates safe", () => {
  assert.deepEqual(classifyExecutorRecovery([], 2), { action: "accept", completedSteps: 0 });
  assert.deepEqual(classifyExecutorRecovery([{ status: "ACCEPTED", checkpoint: { completedSteps: 0 } }], 2), { action: "resume", completedSteps: 0 });
  assert.deepEqual(classifyExecutorRecovery([{ status: "STEP_SUCCEEDED", checkpoint: { completedSteps: 1 } }], 2), { action: "resume", completedSteps: 1 });
  assert.deepEqual(classifyExecutorRecovery([{ status: "STEP_STARTED", executorId: "same", checkpoint: { completedSteps: 1 } }], 2), { action: "interrupt", completedSteps: 1 });
  const selected = selectExecutorCancellation([
    { mode: "immediate", requestedAt: "2026-08-31T10:00:00.000Z", id: "immediate" },
    { mode: "safe", requestedAt: "2026-08-31T11:00:00.000Z", id: "later-safe" },
  ]);
  assert.equal(selected.id, "immediate");
});

console.log(`\n${passed} Hands container tests passed`);
}

// The active topology assertions above are superseded by the static broker suite, but these two
// pure helpers still describe how any retained legacy executor record is classified. Keep their
// behavioral coverage even though the executor is excluded from every active image/service.
assert.deepEqual(classifyExecutorRecovery([], 2), { action: "accept", completedSteps: 0 });
assert.deepEqual(classifyExecutorRecovery([
  { status: "ACCEPTED", checkpoint: { completedSteps: 0 } },
], 2), { action: "resume", completedSteps: 0 });
assert.deepEqual(classifyExecutorRecovery([
  { status: "STEP_SUCCEEDED", checkpoint: { completedSteps: 1 } },
], 2), { action: "resume", completedSteps: 1 });
assert.deepEqual(classifyExecutorRecovery([
  { status: "STEP_STARTED", executorId: "same", checkpoint: { completedSteps: 1 } },
], 2), { action: "interrupt", completedSteps: 1 });
assert.equal(selectExecutorCancellation([
  { mode: "immediate", requestedAt: "2026-08-31T10:00:00.000Z", id: "immediate" },
  { mode: "safe", requestedAt: "2026-08-31T11:00:00.000Z", id: "later-safe" },
]).id, "immediate");
console.log("ok - inert executor recovery helpers retain their legacy safety behavior");
