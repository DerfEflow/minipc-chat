import assert from "node:assert/strict";
import {
  accessSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

if (process.platform !== "linux") {
  console.log("ok - Linux DAC-indirection behavior checks skipped on non-Linux host");
  process.exit(0);
}
const tempRoot = process.env.GAME_FACTORY_LINUX_TEST_TMPDIR || "/tmp";
if (!isAbsolute(tempRoot) || /^[A-Za-z]:[\\/]/.test(tempRoot)) {
  throw new Error("GAME_FACTORY_LINUX_TEST_TMPDIR must name an explicit non-Windows Linux temp root");
}

const projects = [
  "system-canary", "system-canary-sibling", "vector-vault", "bolt-bloom", "pocket-gravity",
  "chromalock", "tiny-foundry", "letter-loom", "pulse-path", "shelf-shift", "wobble-works",
  "signal-grid",
];
const selected = "system-canary";
const uid = process.getuid?.();
const gid = process.getgid?.();
assert.equal(Number.isInteger(uid), true, "Linux uid is unavailable");
assert.notEqual(uid, 0, "DAC behavior must be tested without root or CAP_DAC_OVERRIDE");
const LINUX_O_PATH = 0o10000000;

let passed = 0;
function test(name, operation) {
  operation();
  passed++;
  console.log(`ok - ${name}`);
}
function denied(label, operation) {
  assert.throws(operation, (error) => error?.code === "EACCES" || error?.code === "EPERM", label);
}
function mode(path) { return lstatSync(path).mode & 0o7777; }
function exactLink(path, target) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), true);
  assert.equal(metadata.uid, uid);
  assert.equal(metadata.gid, gid);
  assert.equal(metadata.nlink, 1);
  assert.equal(mode(path), 0o777);
  assert.equal(readlinkSync(path), target);
  assert.equal(target.startsWith("/"), false);
  assert.equal(target.split("/").includes(".."), false);
}

const root = mkdtempSync(join(tempRoot, "dominion-gf-dac-"));
const workspace = join(root, "workspace");
const privateProjects = join(workspace, ".projects");
const runtime = join(root, "runtime");
const payload = join(runtime, "payload");
const runtimePrivate = join(payload, ".private");
const wrapperPaths = [];
const dataIdentities = new Map();
let active = null;

function createGate(parent, name) {
  const wrapper = join(parent, name);
  const data = join(wrapper, "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  dataIdentities.set(wrapper, lstatSync(data));
  chmodSync(wrapper, 0o000);
  wrapperPaths.push(wrapper);
  return wrapper;
}
function startupReset() {
  for (const wrapper of wrapperPaths) chmodSync(wrapper, 0o000);
  active = null;
}
function openProject(slug) {
  assert.equal(active, null, "concurrency-one gate admitted a second project");
  const wrapper = join(privateProjects, slug);
  assert.equal(mode(wrapper), 0o000);
  chmodSync(wrapper, 0o700);
  const project = statSync(join(wrapper, "data"));
  assert.equal(project.isDirectory(), true);
  active = slug;
  return project;
}
function closeProject(slug) {
  assert.equal(active, slug);
  const wrapper = join(privateProjects, slug);
  assert.equal(mode(wrapper), 0o700);
  chmodSync(wrapper, 0o000);
  assert.equal(mode(wrapper), 0o000);
  active = null;
}

try {
  mkdirSync(privateProjects, { recursive: true, mode: 0o700 });
  for (const slug of projects) {
    createGate(privateProjects, slug);
    symlinkSync(`.projects/${slug}/data`, join(workspace, slug));
  }
  createGate(privateProjects, "lost-found-gate");
  symlinkSync(".projects/lost-found-gate/data", join(workspace, "lost+found"));
  mkdirSync(join(payload, "active"), { recursive: true, mode: 0o700 });
  createGate(runtimePrivate, "retained-gate");
  createGate(runtimePrivate, "sibling-gate");
  createGate(runtimePrivate, "lost-found-gate");
  symlinkSync(".private/retained-gate/data", join(payload, "retained"));
  symlinkSync(".private/sibling-gate/data", join(payload, "system-canary-sibling"));
  symlinkSync("payload/.private/lost-found-gate/data", join(runtime, "lost+found"));

  test("public shells expose only reviewed relative link targets", () => {
    exactLink(join(workspace, "vector-vault"), ".projects/vector-vault/data");
    exactLink(join(workspace, "lost+found"), ".projects/lost-found-gate/data");
    exactLink(join(payload, "retained"), ".private/retained-gate/data");
    exactLink(join(runtime, "lost+found"), "payload/.private/lost-found-gate/data");
  });

  test("mode000 sibling wrappers deny stat access and readdir while lstat remains truthful", () => {
    const wrapper = join(privateProjects, "vector-vault");
    const metadata = lstatSync(wrapper);
    assert.equal(metadata.uid, uid);
    assert.equal(metadata.gid, gid);
    assert.equal(mode(wrapper), 0o000);
    denied("sibling public stat", () => statSync(join(workspace, "vector-vault")));
    denied("sibling public access", () => accessSync(join(workspace, "vector-vault"), constants.R_OK));
    denied("sibling public readdir", () => readdirSync(join(workspace, "vector-vault")));
    denied("sibling canonical data lstat", () => lstatSync(join(wrapper, "data")));
  });

  test("lost+found and runtime gates deny same-uid metadata traversal", () => {
    for (const path of [join(workspace, "lost+found"), join(payload, "retained"),
      join(payload, "system-canary-sibling"), join(runtime, "lost+found")]) {
      denied(`${path} stat`, () => statSync(path));
      denied(`${path} access`, () => accessSync(path, constants.R_OK));
      denied(`${path} readdir`, () => readdirSync(path));
    }
  });

  test("metadata-only O_PATH binds an inaccessible lost+found inode", () => {
    const gate = join(privateProjects, "lost-found-gate");
    const data = join(gate, "data");
    chmodSync(gate, 0o700);
    chmodSync(data, 0o000);
    denied("ordinary lost+found directory open", () => {
      const fd = openSync(data, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd);
    });
    const fd = openSync(data, LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(fd);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.dev, dataIdentities.get(gate)?.dev);
      assert.equal(metadata.ino, dataIdentities.get(gate)?.ino);
    } finally {
      closeSync(fd);
      chmodSync(data, 0o700);
      chmodSync(gate, 0o000);
    }
  });

  test("selected wrapper binds one inode and closes on completion cancel and error", () => {
    const expected = dataIdentities.get(join(privateProjects, selected));
    assert.ok(expected);
    for (const terminal of ["completion", "cancel", "error"]) {
      const opened = openProject(selected);
      assert.equal(opened.dev, expected.dev, terminal);
      assert.equal(opened.ino, expected.ino, terminal);
      assert.equal(statSync(join(workspace, selected)).ino, expected.ino, terminal);
      assert.throws(() => openProject("vector-vault"), /concurrency-one/, terminal);
      closeProject(selected);
      denied(`${terminal} post-close stat`, () => statSync(join(workspace, selected)));
    }
  });

  test("startup reset revokes a wrapper left open by a crash before readiness", () => {
    openProject(selected);
    assert.equal(mode(join(privateProjects, selected)), 0o700);
    startupReset();
    assert.equal(active, null);
    for (const wrapper of wrapperPaths) assert.equal(mode(wrapper), 0o000);
    denied("post-crash selected stat", () => statSync(join(workspace, selected)));
  });

  test("fixed root-content maps reject unknown entries", () => {
    const expectedWorkspace = new Set([".projects", "lost+found", ...projects]);
    assert.deepEqual(new Set(readdirSync(workspace)), expectedWorkspace);
    mkdirSync(join(workspace, "unknown-entry"), { mode: 0o700 });
    assert.notDeepEqual(new Set(readdirSync(workspace)), expectedWorkspace);
  });
} finally {
  for (const wrapper of wrapperPaths) {
    try { chmodSync(wrapper, 0o700); } catch { }
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} Linux DAC-indirection behavior checks passed`);
