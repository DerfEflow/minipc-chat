import assert from "node:assert/strict";
import {
  chmodSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GAME_FACTORY_EXECUTOR_PROTOCOL, durableNoReplace, durableReplace, readSpoolEvents,
  readTrustedJson, readTrustedText, recoverDurableTree, sha256Text, stableValue,
} from "./hands/gamefactory-ipc.mjs";
import { createGameFactorySpoolController } from "./hands/gamefactory-controller.mjs";

const uid = process.getuid?.() ?? null;
const root = mkdtempSync(join(tmpdir(), "dominion-gamefactory-ipc-"));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok - " + name); }
  catch (error) { console.error("not ok - " + name); throw error; }
}
const directory = (name) => { const path = join(root, name); mkdirSync(path, { recursive: true }); chmodSync(path, 0o750); return path; };
const publish = (path, value, options = {}) => durableNoReplace(path, value, 0o640, { gid: null, ...options });

try {
  await test("no-replace publication is exact-mode, replay-safe, and leaves no visible temp", () => {
    const dir = directory("basic"); const path = join(dir, "command.json");
    publish(path, "first\n");
    assert.equal(readTrustedText(path, { ownerUid: uid }), "first\n");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.throws(() => publish(path, "second\n"), (error) => error?.code === "EEXIST");
    assert.equal(readTrustedText(path, { ownerUid: uid }), "first\n");
    assert.deepEqual(readdirSync(dir).filter((name) => /^\.(?:tmp|publish)-/.test(name)), []);
  });

  await test("parent-fsync failure remains blocked until startup recovery", () => {
    const dir = directory("fsync-fault"); const path = join(dir, "command.json"); let calls = 0;
    const injected = { fsyncSync(fd) { calls++; if (calls === 4) { const error = new Error("injected parent fsync"); error.code = "EIO"; throw error; } fsyncSync(fd); } };
    assert.throws(() => publish(path, "durable-content\n", { operations: injected }), /injected parent fsync/);
    assert.equal(existsSync(path), true);
    assert.throws(() => readTrustedText(path, { ownerUid: uid }), (error) => error?.code === "SPOOL_PUBLICATION_PENDING" && error.spoolDirectory === dir);
    recoverDurableTree(dir, { ownerUid: uid, ownerGid: null });
    assert.equal(readTrustedText(path, { ownerUid: uid }), "durable-content\n");
  });

  await test("ENOSPC before link creates no final and is recoverable without guessing success", () => {
    const dir = directory("enospc"); const path = join(dir, "command.json"); let writes = 0;
    const injected = { writeFileSync(fd, value) { writes++; if (writes === 2) { const error = new Error("injected ENOSPC"); error.code = "ENOSPC"; throw error; } writeFileSync(fd, value); } };
    assert.throws(() => publish(path, "never-final\n", { operations: injected }), (error) => error?.code === "ENOSPC");
    assert.equal(existsSync(path), false);
    recoverDurableTree(dir, { ownerUid: uid, ownerGid: null });
    assert.deepEqual(readdirSync(dir), []);
  });

  await test("link/unlink crash window is rejected then repaired to one link", () => {
    const dir = directory("link-crash"); const path = join(dir, "command.json"); let unlinks = 0;
    const injected = { unlinkSync(target) { unlinks++; if (unlinks === 1) { const error = new Error("injected unlink crash"); error.code = "EIO"; throw error; } unlinkSync(target); } };
    assert.throws(() => publish(path, "linked\n", { operations: injected }), /injected unlink crash/);
    assert.equal(statSync(path).nlink, 2);
    assert.throws(() => readTrustedText(path, { ownerUid: uid }), (error) => error?.code === "SPOOL_PUBLICATION_PENDING");
    recoverDurableTree(dir, { ownerUid: uid, ownerGid: null });
    assert.equal(statSync(path).nlink, 1);
    assert.equal(readTrustedText(path, { ownerUid: uid }), "linked\n");
  });

  await test("flat ext4 recovery skips only the exact inaccessible lost+found shell", () => {
    const dir = directory("flat-ext4-recovery"); const lostFound = join(dir, "lost+found");
    mkdirSync(lostFound); chmodSync(lostFound, 0o700);
    const pending = join(dir, ".tmp-00000000-0000-4000-8000-000000000001");
    writeFileSync(pending, "pending\n", { mode: 0o600 });
    if (process.platform !== "win32" && uid !== 0) {
      assert.throws(() => recoverDurableTree(dir, {
        ownerUid: uid, ownerGid: null, requireExt4LostFound: true, flat: true,
      }), /invalid ext4 lost[+]found shell/);
      return;
    }
    recoverDurableTree(dir, {
      ownerUid: uid, ownerGid: null, requireExt4LostFound: true, flat: true,
    });
    assert.equal(existsSync(pending), false);
    assert.equal(statSync(lostFound).mode & 0o7777, 0o700);
    const unexpected = join(dir, "unexpected"); mkdirSync(unexpected);
    assert.throws(() => recoverDurableTree(dir, {
      ownerUid: uid, ownerGid: null, requireExt4LostFound: true, flat: true,
    }), /unexpected directory/);
  });

  await test("trusted reads reject hardlinks and symlinks", () => {
    const dir = directory("link-guards"); const path = join(dir, "value.json"); const alias = join(dir, "alias.json");
    publish(path, "{\"ok\":true}\n"); linkSync(path, alias);
    assert.throws(() => readTrustedJson(path, { ownerUid: uid }), /link count/);
    unlinkSync(alias); assert.deepEqual(readTrustedJson(path, { ownerUid: uid }), { ok: true });
    const symlink = join(dir, "symlink.json");
    try { symlinkSync(path, symlink, "file"); assert.throws(() => readTrustedJson(symlink, { ownerUid: uid })); }
    catch (error) { if (!/privilege|permitted|operation not permitted/i.test(String(error))) throw error; }
  });

  await test("event reader binds protocol, run, request, policy, transitions, and hash chain", () => {
    const replies = directory("events"); const runKey = "a".repeat(32); const runDir = join(replies, `run-${runKey}`); mkdirSync(runDir);
    const requestHash = "b".repeat(64), policyHash = "c".repeat(64); let previousHash = "";
    const add = (sequence, status, checkpoint) => {
      const event = { protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, runKey, sequence, previousHash,
        runId: "run-1", requestHash, policyHash, executorId: "executor-1", at: new Date().toISOString(), status, checkpoint };
      event.eventHash = sha256Text(JSON.stringify(stableValue(event))); previousHash = event.eventHash;
      publish(join(runDir, `event-${String(sequence).padStart(8, "0")}-00000000-0000-4000-8000-00000000000${sequence}.json`), JSON.stringify(event) + "\n");
    };
    add(1, "ACCEPTED", { completedSteps: 0, safeBoundary: true });
    add(2, "STEP_STARTED", { completedSteps: 0, safeBoundary: true });
    add(3, "STEP_SUCCEEDED", { completedSteps: 1, safeBoundary: true });
    assert.deepEqual(readSpoolEvents(replies, runKey, { ownerUid: uid }).map((event) => event.status), ["ACCEPTED", "STEP_STARTED", "STEP_SUCCEEDED"]);
    const tail = readdirSync(runDir).sort().at(-1); const corrupt = JSON.parse(readFileSync(join(runDir, tail), "utf8")); corrupt.policyHash = "d".repeat(64);
    writeFileSync(join(runDir, tail), JSON.stringify(corrupt) + "\n"); chmodSync(join(runDir, tail), 0o640);
    assert.throws(() => readSpoolEvents(replies, runKey, { ownerUid: uid }), /identity changed|hash is invalid/);
    assert.throws(() => readSpoolEvents(replies, runKey, { ownerUid: uid, quarantine: true }));
    assert.equal(existsSync(join(replies, `quarantined-${runKey}.json`)), true);
  });

  await test("non-success events cannot advance or regress the completed checkpoint", () => {
    const replies = directory("checkpoint-events"); const requestHash = "5".repeat(64), policyHash = "6".repeat(64);
    const publishChain = (runKey, secondStatus, secondCompleted) => {
      const runDir = join(replies, `run-${runKey}`); mkdirSync(runDir); let previousHash = "";
      const add = (sequence, status, completedSteps) => {
        const event = { protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, runKey, sequence, previousHash,
          runId: `run-${runKey}`, requestHash, policyHash, executorId: "executor-1", at: new Date().toISOString(),
          status, checkpoint: { completedSteps, safeBoundary: true } };
        event.eventHash = sha256Text(JSON.stringify(stableValue(event))); previousHash = event.eventHash;
        publish(join(runDir, `event-${String(sequence).padStart(8, "0")}-00000000-0000-4000-8000-10000000000${sequence}.json`), JSON.stringify(event) + "\n");
      };
      add(1, "ACCEPTED", 0); add(2, secondStatus, secondCompleted);
    };
    publishChain("1".repeat(32), "PAUSED", 1);
    assert.throws(() => readSpoolEvents(replies, "1".repeat(32), { ownerUid: uid }), /changed the completed safe checkpoint/);
    publishChain("2".repeat(32), "FAILED", -1);
    assert.throws(() => readSpoolEvents(replies, "2".repeat(32), { ownerUid: uid }), /checkpoint is invalid/);
  });

  await test("controller rejects future readiness and preserves run/attempt conflict ordering", () => {
    const commands = directory("controller-commands"), replies = directory("controller-replies");
    const sandboxSha = "1".repeat(64), nodeSeccompSha = "2".repeat(64), godotSeccompSha = "3".repeat(64);
    const appArmorPolicySha = "4".repeat(64), outerSeccompSha = "5".repeat(64);
    const readinessPath = join(replies, "executor-ready.json");
    const readiness = (updatedAt) => ({ protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, executorId: "executor-1", updatedAt,
      programs: ["node", "godot"], workspace: { path: "/workspace", dev: "11", ino: "22" },
      toolchain: {
        node: { path: "/opt/dominion-payload/node", sha256: "6".repeat(64), dev: "33", ino: "44" },
        godot: { path: "/opt/dominion-payload/godot", sha256: "7".repeat(64), dev: "55", ino: "66" },
      }, sandbox: { kind: "fd-launcher", version: "dominion-fd-launcher/1", sha256: sandboxSha,
        appArmorComponents: {
          launcher: ["dominion-gx10-fd-launcher", "dominion-gx10-gamefactory-executor"],
          node: ["dominion-gx10-fd-launcher", "dominion-gx10-gamefactory-executor", "dominion-gx10-payload-node"],
          godot: ["dominion-gx10-fd-launcher", "dominion-gx10-gamefactory-executor", "dominion-gx10-payload-godot"],
        }, seccomp: { node: { sha256: nodeSeccompSha }, godot: { sha256: godotSeccompSha } },
        appArmorPolicySha256: appArmorPolicySha, outerSeccompSha256: outerSeccompSha } });
    durableReplace(readinessPath, JSON.stringify(readiness(new Date().toISOString())) + "\n", 0o640, { gid: null });
    const controller = createGameFactorySpoolController({ commandDir: commands, replyDir: replies, node: "gx10-gamefactory",
      isolationAttested: true, toolchainAttested: true, sandboxSha256: sandboxSha,
      nodeSeccompSha256: nodeSeccompSha, godotSeccompSha256: godotSeccompSha,
      appArmorPolicySha256: appArmorPolicySha, outerSeccompSha256: outerSeccompSha,
      spoolGid: null, executorOwnerUid: uid });
    const request = { runId: "run-1", taskId: "task-1", projectId: "project-1", attempt: 1,
      capability: "quality_assurance", workspaceRoot: "/workspace",
      plan: { steps: [{ program: "node", args: ["--version"], cwd: "/workspace" }], collect: [] } };
    assert.equal(controller.start(request).ok, true);
    assert.equal(controller.start(request).replayed, true);
    const attemptsBefore = readdirSync(commands).filter((name) => name.startsWith("attempt-")).length;
    const runConflict = controller.start({ ...request, taskId: "task-2", attempt: 2 });
    assert.equal(runConflict.conflict, true);
    assert.equal(readdirSync(commands).filter((name) => name.startsWith("attempt-")).length, attemptsBefore);
    const attemptConflict = controller.start({ ...request, runId: "run-2" });
    assert.equal(attemptConflict.conflict, true);
    assert.equal(readdirSync(commands).some((name) => name.includes(sha256Text("run-2").slice(0, 32))), false);
    const firstImmediate = controller.cancel("run-1", { mode: "immediate", reason: "security stop" });
    const replayImmediate = controller.cancel("run-1", { mode: "immediate", reason: "different retry text is ignored" });
    assert.equal(firstImmediate.ok, true); assert.equal(firstImmediate.replayed, false);
    assert.equal(replayImmediate.ok, true); assert.equal(replayImmediate.replayed, true);
    assert.equal(replayImmediate.cancellationResolved, false);
    assert.deepEqual(readdirSync(commands).filter((name) => name.startsWith("cancel-")).sort(),
      [`cancel-${sha256Text("run-1").slice(0, 32)}-immediate.json`]);
    const absent = controller.cancel("never-published", { mode: "immediate" });
    assert.equal(absent.commandAbsent, true); assert.equal(absent.cancellationResolved, false);
    assert.equal("notFound" in absent, false);
    durableReplace(readinessPath, JSON.stringify(readiness(new Date(Date.now() + 60_000).toISOString())) + "\n", 0o640, { gid: null });
    assert.equal(controller.probe().ok, false);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} game-factory IPC tests passed`);
