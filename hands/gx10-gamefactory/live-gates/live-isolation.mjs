import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import {
  accessSync, constants, linkSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import net from "node:net";

const passed = [];
function denied(label, operation) {
  try { operation(); }
  catch (error) {
    passed.push({ label, code: String(error?.code || error?.name || "denied") });
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}
function deniedPath(label, operation) {
  try { operation(); }
  catch (error) {
    const code = String(error?.code || error?.name || "denied");
    if (code !== "EACCES" && code !== "EPERM") {
      throw new Error(`${label} was not a policy denial: ${code}`);
    }
    passed.push({ label, code });
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}
function absentPath(label, operation) {
  try { operation(); }
  catch (error) {
    const code = String(error?.code || error?.name || "missing");
    if (code !== "ENOENT") throw new Error(`${label} was not absent: ${code}`);
    passed.push({ label, code });
    return;
  }
  throw new Error(`${label} unexpectedly existed`);
}
function exactPublicLink(label, path, target) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), true, `${label} is not a symlink shell`);
  assert.equal(metadata.uid, 10003, `${label} owner differs`);
  assert.equal(metadata.gid, 10003, `${label} group differs`);
  assert.equal(metadata.nlink, 1, `${label} link count differs`);
  assert.equal(metadata.mode & 0o7777, 0o777, `${label} mode differs`);
  passed.push({ label: `${label}-lstat`, code: "SYMLINK" });
  assert.equal(readlinkSync(path), target, `${label} target differs`);
  passed.push({ label: `${label}-readlink`, code: "REVIEWED_RELATIVE_TARGET" });
}
async function deniedAsync(label, operation) {
  try { await operation(); }
  catch (error) {
    passed.push({ label, code: String(error?.code || error?.name || "denied") });
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}
async function deniedAsyncPath(label, operation) {
  try { await operation(); }
  catch (error) {
    const code = String(error?.code || error?.name || "denied");
    if (code !== "EACCES" && code !== "EPERM") {
      throw new Error(`${label} was not a policy denial: ${code}`);
    }
    passed.push({ label, code });
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}
function deniedSpawn(label, executable, args = []) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 2_000 });
  if (result.status === 0 && !result.error) throw new Error(`${label} unexpectedly succeeded`);
  passed.push({ label, code: String(result.error?.code || result.signal || result.status || "denied") });
}

writeFileSync("live-own.txt", "own-project-content\n", { mode: 0o600 });
assert.equal(readFileSync("live-own.txt", "utf8"), "own-project-content\n");
renameSync("live-own.txt", "live-own-renamed.txt");
renameSync("live-own-renamed.txt", "live-own.txt");
passed.push({ label: "own-content-round-trip", code: "OK" });

const workspaceSiblingSentinel = "/workspace/system-canary-sibling/isolation-sentinel.txt";
const runtimeSiblingSentinel = "/runtime/payload/system-canary-sibling/isolation-sentinel.txt";
const fixedSiblingProjects = [
  "vector-vault", "bolt-bloom", "pocket-gravity", "chromalock", "tiny-foundry",
  "letter-loom", "pulse-path", "shelf-shift", "wobble-works", "signal-grid",
];
exactPublicLink("selected-project-shell", "/workspace/system-canary", ".projects/system-canary/data");
exactPublicLink("test-sibling-shell", "/workspace/system-canary-sibling", ".projects/system-canary-sibling/data");
exactPublicLink("workspace-lost-found-shell", "/workspace/lost+found", ".projects/lost-found-gate/data");
exactPublicLink("runtime-retained-shell", "/runtime/payload/retained", ".private/retained-gate/data");
exactPublicLink("runtime-sibling-shell", "/runtime/payload/system-canary-sibling", ".private/sibling-gate/data");
exactPublicLink("runtime-lost-found-shell", "/runtime/lost+found",
  "payload/.private/lost-found-gate/data");

const selectedPublic = statSync("/workspace/system-canary");
const selectedCanonical = statSync("/workspace/.projects/system-canary/data");
assert.equal(selectedPublic.dev, selectedCanonical.dev);
assert.equal(selectedPublic.ino, selectedCanonical.ino);
accessSync("/workspace/system-canary", constants.R_OK | constants.X_OK);
readdirSync("/workspace/system-canary");
passed.push({ label: "selected-project-stat-access-readdir", code: "BOUND_INODE" });
const selectedWrapper = lstatSync("/workspace/.projects/system-canary");
assert.equal(selectedWrapper.uid, 10003);
assert.equal(selectedWrapper.gid, 10003);
assert.equal(selectedWrapper.mode & 0o7777, 0o700);
passed.push({ label: "selected-wrapper-lstat-mode-owner", code: "10003:10003:700" });
deniedPath("selected-wrapper-readdir", () => readdirSync("/workspace/.projects/system-canary"));

for (const slug of fixedSiblingProjects) {
  const publicPath = `/workspace/${slug}`;
  const wrapperPath = `/workspace/.projects/${slug}`;
  exactPublicLink(`portfolio-${slug}-shell`, publicPath, `.projects/${slug}/data`);
  const siblingWrapper = lstatSync(wrapperPath);
  assert.equal(siblingWrapper.uid, 10003, `${slug} wrapper owner differs`);
  assert.equal(siblingWrapper.gid, 10003, `${slug} wrapper group differs`);
  assert.equal(siblingWrapper.mode & 0o7777, 0o000, `${slug} wrapper mode differs`);
  passed.push({ label: `sibling-wrapper-lstat-mode-owner-${slug}`, code: "10003:10003:000" });
  deniedPath(`${slug}-wrapper-access`, () => accessSync(wrapperPath, constants.X_OK));
  deniedPath(`${slug}-wrapper-readdir`, () => readdirSync(wrapperPath));
  deniedPath(`${slug}-wrapper-data-lstat`, () => lstatSync(`${wrapperPath}/data`));
  deniedPath(`${slug}-public-stat`, () => statSync(publicPath));
  deniedPath(`${slug}-public-access`, () => accessSync(publicPath, constants.R_OK));
  deniedPath(`${slug}-public-readdir`, () => readdirSync(publicPath));
}
deniedPath("workspace-root-readdir", () => readdirSync("/workspace"));
deniedPath("workspace-private-root-readdir", () => readdirSync("/workspace/.projects"));
deniedPath("lost-found-stat", () => statSync("/workspace/lost+found"));
deniedPath("lost-found-access", () => accessSync("/workspace/lost+found", constants.R_OK));
deniedPath("lost-found-readdir", () => readdirSync("/workspace/lost+found"));
deniedPath("test-sibling-stat", () => statSync("/workspace/system-canary-sibling"));
deniedPath("test-sibling-access", () => accessSync(workspaceSiblingSentinel, constants.R_OK));
deniedPath("test-sibling-content", () => readFileSync(workspaceSiblingSentinel));
deniedPath("test-sibling-readdir", () => readdirSync("/workspace/system-canary-sibling"));
deniedPath("runtime-sibling-stat", () => statSync("/runtime/payload/system-canary-sibling"));
deniedPath("runtime-sibling-access", () => accessSync(runtimeSiblingSentinel, constants.R_OK));
deniedPath("runtime-sibling-content", () => readFileSync(runtimeSiblingSentinel));
deniedPath("runtime-sibling-readdir", () => readdirSync("/runtime/payload/system-canary-sibling"));
deniedPath("retained-runtime-stat", () => statSync("/runtime/payload/retained"));
deniedPath("retained-runtime-access", () => accessSync("/runtime/payload/retained", constants.R_OK));
deniedPath("retained-runtime-readdir", () => readdirSync("/runtime/payload/retained"));
deniedPath("runtime-lost-found-stat", () => statSync("/runtime/lost+found"));
deniedPath("runtime-lost-found-access", () => accessSync("/runtime/lost+found", constants.R_OK));
deniedPath("runtime-lost-found-readdir", () => readdirSync("/runtime/lost+found"));
deniedPath("runtime-root-readdir", () => readdirSync("/runtime"));
deniedPath("runtime-payload-root-readdir", () => readdirSync("/runtime/payload"));
deniedPath("runtime-private-root-readdir", () => readdirSync("/runtime/payload/.private"));
const retainedGate = lstatSync("/runtime/payload/.private/retained-gate");
assert.equal(retainedGate.uid, 10003);
assert.equal(retainedGate.gid, 10003);
assert.equal(retainedGate.mode & 0o7777, 0o000);
passed.push({ label: "runtime-retained-gate-lstat-mode-owner", code: "10003:10003:000" });
deniedPath("runtime-retained-gate-readdir", () => readdirSync("/runtime/payload/.private/retained-gate"));
absentPath("nonselected-active-runtime-lstat", () => lstatSync("/runtime/payload/active/vector-vault"));
let siblingLinkCreated = false;
try {
  symlinkSync(workspaceSiblingSentinel, "live-sibling-link");
  siblingLinkCreated = true;
  passed.push({ label: "symlink-create-to-sibling", code: "CREATED_BUT_NOT_TRUSTED" });
} catch (error) {
  const code = String(error?.code || error?.name || "denied");
  if (code !== "EACCES" && code !== "EPERM") throw error;
  passed.push({ label: "symlink-create-to-sibling", code });
}
if (siblingLinkCreated) {
  deniedPath("symlink-follow-to-sibling", () => readFileSync("live-sibling-link"));
  rmSync("live-sibling-link");
}
deniedPath("hardlink-from-sibling", () => linkSync(workspaceSiblingSentinel, "live-hardlink"));
deniedPath("rename-to-sibling", () => renameSync("live-own.txt", "/workspace/system-canary-sibling/renamed.txt"));
denied("broker-results", () => readFileSync("/broker-results/broker-ready.bin"));
const brokerRequestsMetadata = lstatSync("/broker-requests");
assert.equal(brokerRequestsMetadata.isDirectory(), true);
passed.push({ label: "broker-requests-lstat", code: "METADATA_ONLY" });
deniedPath("broker-requests-readdir", () => readdirSync("/broker-requests"));
denied("proc-self", () => readFileSync("/proc/self/status"));
denied("cgroup", () => readFileSync("/sys/fs/cgroup/cgroup.procs"));
denied("host-etc", () => readFileSync("/etc/passwd"));

await deniedAsyncPath("tcp-network", () => new Promise((resolve, reject) => {
  const socket = net.connect({ host: "127.0.0.1", port: 9 });
  socket.once("connect", () => { socket.destroy(); resolve(); });
  socket.once("error", reject);
  setTimeout(() => { socket.destroy(); reject(new Error("network attempt timed out")); }, 1_000).unref();
}));
await deniedAsyncPath("udp-network", () => new Promise((resolve, reject) => {
  const socket = dgram.createSocket("udp4");
  socket.once("listening", () => { socket.close(); resolve(); });
  socket.once("error", (error) => {
    try { socket.close(); } catch { }
    reject(error);
  });
  socket.bind(0, "127.0.0.1");
}));
await deniedAsync("unix-special-file", () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("listening", () => server.close(resolve));
  server.once("error", reject);
  server.listen("live-special.sock");
}));
rmSync("live-special.sock", { force: true });

deniedSpawn("process-clone", "/opt/dominion-payload/node", ["--version"]);
deniedSpawn("namespace-unshare", "/usr/bin/unshare", ["--user", "--map-root-user", "true"]);
deniedSpawn("namespace-setns", "/usr/bin/nsenter", ["--target", "1", "--mount", "true"]);
deniedSpawn("mount", "/usr/bin/mount", ["--bind", ".", "live-mount"]);
deniedSpawn("keyring", "/usr/bin/keyctl", ["show"]);
rmSync("live-own.txt", { force: true });

assert.ok(passed.length >= 52);
console.log(JSON.stringify({ protocol: "gx10-game-factory-isolation/1", ok: true, passed }));
