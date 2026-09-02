#!/usr/bin/env node
/* Fail-closed preflight and kernel-flock launcher for the tokenless Option C executor. */
import { constants, accessSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { GAME_FACTORY_SPOOL_GID } from "./gamefactory-ipc.mjs";

const EXPECTED_UID = 10002;
const ARTIFACTS = Object.freeze([
  ["/opt/dominion-sandbox/fd-launcher", "GAME_FACTORY_WORKER_SANDBOX_SHA256", 0o555],
  ["/opt/dominion-sandbox/node-seccomp.bpf", "GAME_FACTORY_WORKER_NODE_SECCOMP_SHA256", 0o444],
  ["/opt/dominion-sandbox/godot-seccomp.bpf", "GAME_FACTORY_WORKER_GODOT_SECCOMP_SHA256", 0o444],
  ["/opt/dominion-payload/node", "GAME_FACTORY_PAYLOAD_NODE_SHA256", 0o555],
  ["/opt/dominion-payload/godot", "GAME_FACTORY_PAYLOAD_GODOT_SHA256", 0o555],
  ["/policy/executor.apparmor", "GAME_FACTORY_APPARMOR_POLICY_SHA256", 0o444],
  ["/policy/executor-seccomp.json", "GAME_FACTORY_OUTER_SECCOMP_SHA256", 0o444],
]);
function fail(message) { throw new Error(`[gx10-executor-preflight] ${message}`); }
function mountPath(value) { return String(value || "").replace(/\\(040|011|012|134)/g, (_, code) => ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code]); }
function under(child, parent) { const rel = posix.relative(parent, child); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel)); }
function mounts() {
  return readFileSync("/proc/self/mountinfo", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    return { id: fields[0], target: mountPath(fields[4]), options: new Set(String(fields[5] || "").split(",")),
      fsType: fields[separator + 1] || "", source: fields[separator + 2] || "" };
  });
}
function validateStatus() {
  const status = readFileSync("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s*1$/m.test(status) || !/^Seccomp:\s*2$/m.test(status)) fail("no-new-privileges/seccomp is absent");
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    if (!new RegExp(`^${field}:\\s*0+\\s*$`, "mi").test(status)) fail("Linux capabilities are not empty");
  }
}
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function capacity(path) { const value = statfsSync(path, { bigint: true }); return value.bsize * value.blocks; }

export function executorPreflight(env = process.env) {
  if (process.platform !== "linux" || process.getuid() !== EXPECTED_UID || process.getgid() !== EXPECTED_UID) fail("fixed Linux UID/GID 10002 is required");
  if (!process.getgroups().includes(GAME_FACTORY_SPOOL_GID)) fail("shared spool GID 11000 is required");
  if (Object.keys(env).some((key) => /^(?:HANDS_|DATABASE_URL|.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL).*)$/i.test(key))) fail("executor environment contains a controller credential variable");
  if (env.GAME_FACTORY_WORKER_PROGRAMS !== "node,godot") fail("executor program allowlist must be exactly node,godot");
  if (env.GAME_FACTORY_WORKER_SANDBOX_PROGRAM !== "/opt/dominion-sandbox/fd-launcher") fail("exact fd-launcher path is required");
  if (env.GAME_FACTORY_WORKER_NODE_SECCOMP_PATH !== "/opt/dominion-sandbox/node-seccomp.bpf"
      || env.GAME_FACTORY_WORKER_GODOT_SECCOMP_PATH !== "/opt/dominion-sandbox/godot-seccomp.bpf") fail("runtime-specific child filter paths are invalid");
  const all = mounts(), byTarget = new Map(all.map((item) => [item.target, item]));
  if (!byTarget.get("/")?.options.has("ro")) fail("root filesystem is not read-only");
  const directions = { "/commands": "ro", "/replies": "rw", "/workspace": "rw", "/runtime": "rw" };
  for (const [target, option] of Object.entries(directions)) if (!byTarget.get(target)?.options.has(option)) fail(`executor mount ${target} must be ${option}`);
  for (const [target, uid] of [["/commands", 10001], ["/replies", 10002]]) {
    const metadata = statSync(target);
    if (!metadata.isDirectory() || metadata.uid !== uid || metadata.gid !== GAME_FACTORY_SPOOL_GID
        || (metadata.mode & 0o7777) !== 0o2750) fail(`${target} must be owner-specific, GID 11000, and mode 2750`);
  }
  for (const root of Object.keys(directions)) if (all.some((item) => item.target !== root && under(item.target, root))) fail("executor scoped root contains a descendant mount");
  const workspaceMount = byTarget.get("/workspace"), runtimeMount = byTarget.get("/runtime");
  if (workspaceMount.id === runtimeMount.id || workspaceMount.id === byTarget.get("/")?.id || runtimeMount.id === byTarget.get("/")?.id) {
    fail("workspace/runtime must be distinct mounts from each other and the container root");
  }
  if (workspaceMount.fsType !== "ext4" || runtimeMount.fsType !== "ext4"
      || !/^\/dev\/loop\d+$/.test(workspaceMount.source) || !/^\/dev\/loop\d+$/.test(runtimeMount.source)) {
    fail("workspace/runtime must be dedicated fixed-size ext4 loopback filesystems");
  }
  for (const [target, mount] of [["/workspace", workspaceMount], ["/runtime", runtimeMount]]) {
    if (!["rw", "noexec", "nosuid", "nodev"].every((option) => mount.options.has(option))) {
      fail(`${target} loopback filesystem must retain rw,noexec,nosuid,nodev mount flags`);
    }
  }
  const workspaceBytes = capacity("/workspace"), runtimeBytes = capacity("/runtime");
  if (workspaceBytes < 1n * 1024n ** 3n || workspaceBytes > 16n * 1024n ** 3n
      || runtimeBytes < 128n * 1024n ** 2n || runtimeBytes > 1n * 1024n ** 3n) {
    fail("workspace/runtime fixed filesystem capacity is outside the reviewed bounds");
  }
  const temp = byTarget.get("/tmp");
  if (temp?.fsType !== "tmpfs" || !["rw", "noexec", "nosuid", "nodev"].every((option) => temp.options.has(option))) fail("hardened tmpfs is missing");
  validateStatus();
  if (readFileSync("/proc/self/attr/current", "utf8").trim() !== "dominion-gx10-gamefactory-executor (enforce)") fail("executor AppArmor profile is not enforced");
  const devices = readFileSync("/proc/net/dev", "utf8").split(/\r?\n/).slice(2).map((line) => line.split(":")[0].trim()).filter(Boolean);
  if (devices.some((name) => name !== "lo") || readFileSync("/proc/net/route", "utf8").split(/\r?\n/).slice(1).some((line) => line.trim())) fail("executor has an external network interface or route");
  for (const [path, variable, mode] of ARTIFACTS) {
    const expected = String(env[variable] || "").trim().toLowerCase(), metadata = statSync(path);
    if (!/^[a-f0-9]{64}$/.test(expected) || realpathSync(path) !== path || !metadata.isFile()
        || metadata.uid !== 0 || metadata.gid !== 0 || metadata.nlink !== 1
        || (metadata.mode & 0o7777) !== mode || sha(path) !== expected) fail(`immutable artifact ${path} is invalid`);
  }
  accessSync("/commands", constants.R_OK | constants.X_OK);
  try { accessSync("/commands", constants.W_OK); fail("executor command mount is writable"); } catch (error) { if (/writable/.test(error.message)) throw error; }
  for (const target of ["/replies", "/workspace", "/runtime"]) accessSync(target, constants.R_OK | constants.W_OK | constants.X_OK);
  return true;
}

function launch() {
  try { executorPreflight(); } catch (error) { console.error(error.message || error); process.exit(78); }
  const child = spawn("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "75", "/replies/executor.lock",
    process.execPath, "/app/gamefactory-executor.mjs"], { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => { process.exitCode = Number.isInteger(code) ? code : 1; });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) launch();
