#!/usr/bin/env node
/* Fail-closed preflight for the token-bearing, non-executing controller container. */
import { constants, accessSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_FACTORY_SPOOL_GID, recoverDurableTree } from "./gamefactory-ipc.mjs";

const APP = "/app";
const EXPECTED_UID = 10001;
function fail(message) { throw new Error(`[gx10-controller-preflight] ${message}`); }
function mountPath(value) { return String(value || "").replace(/\\(040|011|012|134)/g, (_, code) => ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code]); }
function under(child, parent) { const rel = posix.relative(parent, child); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel)); }
function mounts() {
  return readFileSync("/proc/self/mountinfo", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    return { target: mountPath(fields[4]), options: new Set(String(fields[5] || "").split(",")), fsType: fields[separator + 1] || "" };
  });
}
function validateStatus() {
  const status = readFileSync("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s*1$/m.test(status) || !/^Seccomp:\s*2$/m.test(status)) fail("no-new-privileges/seccomp is absent");
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) if (!new RegExp(`^${field}:\\s*0+\\s*$`, "mi").test(status)) fail("Linux capabilities are not empty");
}
export function controllerPreflight(env = process.env) {
  if (process.platform !== "linux" || process.getuid() !== EXPECTED_UID || process.getgid() !== EXPECTED_UID) fail("fixed Linux UID/GID 10001 is required");
  if (!process.getgroups().includes(GAME_FACTORY_SPOOL_GID)) fail("shared spool GID 11000 is required");
  if (env.HANDS_NODE !== "gx10-gamefactory" || env.GAME_FACTORY_WORKER_EXTERNAL_BROKER !== "1"
      || env.GAME_FACTORY_WORKER_EXTERNAL_EXECUTOR) fail("exact static-broker controller identity is required");
  if (env.GAME_FACTORY_CONTROLLER_ONLY !== "1") fail("controller-only dispatch mode is required");
  if (env.GAME_FACTORY_WORKER_PROGRAMS !== "node,godot") fail("controller program allowlist must be exactly node,godot");
  if (env.GAME_FACTORY_WORKER_COMMAND_DIR !== "/broker-requests" || env.GAME_FACTORY_WORKER_REPLY_DIR !== "/broker-results") fail("directional broker spool paths are invalid");
  const all = mounts(), byTarget = new Map(all.map((item) => [item.target, item]));
  if (!byTarget.get("/")?.options.has("ro")) fail("root filesystem is not read-only");
  if (!byTarget.get("/broker-requests")?.options.has("rw") || !byTarget.get("/broker-results")?.options.has("ro")) fail("controller spool mount directions are invalid");
  if (byTarget.get("/broker-requests")?.fsType !== "ext4" || byTarget.get("/broker-results")?.fsType !== "ext4") fail("controller spools must be dedicated ext4 filesystems");
  for (const [target, uid] of [["/broker-requests", 10001], ["/broker-results", 10003]]) {
    const metadata = statSync(target);
    if (!metadata.isDirectory() || metadata.uid !== uid || metadata.gid !== GAME_FACTORY_SPOOL_GID
        || (metadata.mode & 0o7777) !== 0o2750) fail(`${target} must be owner-specific, GID 11000, and mode 2750`);
  }
  for (const protectedPath of ["/workspace", "/runtime", "/state"]) if (byTarget.has(protectedPath)) fail("controller must not mount workspace, runtime, or worker state");
  for (const root of ["/broker-requests", "/broker-results"]) if (all.some((item) => item.target !== root && under(item.target, root))) fail("controller spool contains a descendant mount");
  const temp = byTarget.get("/tmp");
  if (temp?.fsType !== "tmpfs" || !["rw", "noexec", "nosuid", "nodev"].every((option) => temp.options.has(option))) fail("hardened tmpfs is missing");
  validateStatus();
  if (readFileSync("/proc/self/attr/current", "utf8").trim() !== "dominion-gx10-gamefactory-controller (enforce)") fail("controller AppArmor profile is not enforced");
  accessSync("/broker-requests", constants.R_OK | constants.W_OK | constants.X_OK);
  accessSync("/broker-results", constants.R_OK | constants.X_OK);
  try { accessSync("/broker-results", constants.W_OK); fail("controller reply mount is writable"); } catch (error) { if (/writable/.test(error.message)) throw error; }
  for (const file of [APP, join(APP, "gx10-controller-entrypoint.mjs"),
    join(APP, "hands.mjs"), join(APP, "snapshot.mjs"),
    join(APP, "gamefactory-broker-controller.mjs"), join(APP, "gamefactory-broker-protocol.mjs"),
    join(APP, "gamefactory-broker-projects.mjs"), join(APP, "gamefactory-ipc.mjs")]) {
    const metadata = statSync(file); if (metadata.uid !== 0 || (metadata.mode & 0o222) !== 0) fail("controller code is not immutable");
  }
  recoverDurableTree("/broker-requests", {
    ownerUid: EXPECTED_UID, ownerGid: GAME_FACTORY_SPOOL_GID,
    requireExt4LostFound: true, flat: true,
  });
  return true;
}

async function launch() {
  try { controllerPreflight(); } catch (error) { console.error(error.message || error); process.exit(78); }
  // The controller seccomp policy permits pthread creation but deliberately forbids fork-like
  // clone flags. Keep the authenticated stream in this already-attested PID instead of spawning a
  // second Node process whose creation would either fail or require widening the process surface.
  const { runHands } = await import("./hands.mjs");
  await runHands();
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  launch().catch(() => { console.error("[gx10-controller] authenticated stream loop terminated unexpectedly"); process.exitCode = 1; });
}
