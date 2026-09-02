/* Spawn-free primitives shared by the directional controller/executor filesystem spool. */
import {
  chmodSync, chownSync, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, linkSync,
  lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const GAME_FACTORY_WORKER_PROTOCOL = "game-factory-worker/1";
export const GAME_FACTORY_EXECUTOR_PROTOCOL = "game-factory-executor/1";
export const GAME_FACTORY_TERMINAL_STATES = Object.freeze(["SUCCEEDED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"]);
export const GAME_FACTORY_SPOOL_GID = 11000;
const SECRET_NAME = /(authorization|cookie|credential|password|passwd|private.?key|recovery.?code|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret|(^|[_-])pat($|[_-]))/i;

export const stableValue = (value) => Array.isArray(value) ? value.map(stableValue)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])])) : value;
export const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

export function redactWorkerText(value, max = 20_000) {
  return String(value == null ? "" : value).slice(0, max)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, "[redacted-private-key]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[redacted-token]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, "[redacted-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/("(?:authorization|cookie|credential|password|passwd|private.?key|secret|signature|token|keystore|api.?key|database.?url|connection.?string|access.?key|client.?secret|webhook.?secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/\b((?:database|redis|postgres|mysql|mongo(?:db)?|amqp)_?url|connection_?string|aws_access_key_id|aws_secret_access_key|gh_pat|client_?secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_?token|api_?key|key|password|secret|signature)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(access_?token|api_?key|password|passwd|private_?key|secret|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export function sanitizeWorkerValue(value, depth = 0, key = "") {
  if (SECRET_NAME.test(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactWorkerText(value);
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeWorkerValue(item, depth + 1));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  if (typeof value !== "object") return redactWorkerText(value);
  return Object.fromEntries(Object.entries(value).slice(0, 200)
    .map(([name, item]) => [String(name).slice(0, 120), sanitizeWorkerValue(item, depth + 1, name)]));
}

export function workerRequestHash(value) {
  const copy = { ...(value || {}) }; delete copy.createdAt; delete copy.requestHash;
  return sha256Text(JSON.stringify(stableValue(copy)));
}
export function spoolCommandHash(value) {
  const copy = { ...(value || {}) }; delete copy.commandHash;
  return sha256Text(JSON.stringify(stableValue(copy)));
}

const DURABLE_OPS = Object.freeze({
  closeSync, fchmodSync, fchownSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync,
});
function fsyncParent(path, operations = DURABLE_OPS) {
  const fd = operations.openSync(dirname(path), "r");
  try { operations.fsyncSync(fd); }
  catch (error) {
    // The production spool is Linux-only. Windows refuses directory fsync handles outright; retain
    // file fsync semantics there so the cross-platform protocol tests can exercise every other gate.
    if (process.platform !== "win32" || !["EPERM", "EINVAL", "EBADF"].includes(error?.code)) throw error;
  } finally { operations.closeSync(fd); }
}

function exactSpoolMetadata(fd, mode, gid, operations) {
  operations.fchmodSync(fd, mode);
  if (process.platform !== "win32" && Number.isInteger(gid)) operations.fchownSync(fd, -1, gid);
}
function pendingError(directory = "") {
  const error = new Error("spool publication is pending durable recovery");
  error.code = "SPOOL_PUBLICATION_PENDING";
  error.spoolDirectory = directory;
  return error;
}
function waitForNoPublisher(dir) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt++) {
    const active = readdirSync(dir).some((name) => /^\.publish-[a-f0-9-]+$/i.test(name));
    if (!active) return;
    if (attempt < 19) Atomics.wait(wait, 0, 0, 5);
  }
  throw pendingError(dir);
}

/*
 * A publication marker blocks readers before the final link can become visible. The marker stays
 * behind on every pre-commit failure/crash; the sole writer removes it only after the final name
 * and its single-link state have been fsynced. Startup recovery is therefore fail-closed.
 */
export function durableNoReplace(path, value, mode = 0o640, { gid = GAME_FACTORY_SPOOL_GID, operations = {} } = {}) {
  const io = { ...DURABLE_OPS, ...operations };
  const id = randomUUID();
  const marker = join(dirname(path), `.publish-${id}`);
  const temp = join(dirname(path), `.tmp-${id}`);
  let fd = io.openSync(marker, "wx", mode);
  try {
    exactSpoolMetadata(fd, mode, gid, io);
    io.writeFileSync(fd, `${new Date().toISOString()}\n`);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  fsyncParent(marker, io);
  fd = io.openSync(temp, "wx", mode);
  try {
    exactSpoolMetadata(fd, mode, gid, io);
    io.writeFileSync(fd, value);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  try {
    io.linkSync(temp, path);
    io.unlinkSync(temp);
    fsyncParent(path, io);
  } catch (error) {
    if (error?.code === "EEXIST") {
      // A replay did not publish anything. Remove only this call's private entries, durably,
      // then let the caller verify the existing immutable final file.
      try { io.unlinkSync(temp); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "replay temp cleanup failed"); }
      fsyncParent(temp, io);
      io.unlinkSync(marker);
      fsyncParent(marker, io);
      throw error;
    }
    // The marker intentionally remains. Readers will not consume a partial/uncertain publication.
    throw error;
  }
  io.unlinkSync(marker);
  // The data entry was already durable before the marker was removed. A crash during this final
  // fsync can only resurrect a blocking marker, never make an uncommitted command executable.
  fsyncParent(marker, io);
}

export function durableReplace(path, value, mode = 0o640, { gid = GAME_FACTORY_SPOOL_GID, operations = {} } = {}) {
  const io = { ...DURABLE_OPS, ...operations };
  const id = randomUUID();
  const marker = join(dirname(path), `.publish-${id}`);
  const temp = join(dirname(path), `.tmp-${id}`);
  let fd = io.openSync(marker, "wx", mode);
  try {
    exactSpoolMetadata(fd, mode, gid, io);
    io.writeFileSync(fd, `${new Date().toISOString()}\n`);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  fsyncParent(marker, io);
  fd = io.openSync(temp, "wx", mode);
  try {
    exactSpoolMetadata(fd, mode, gid, io);
    io.writeFileSync(fd, value);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  io.renameSync(temp, path);
  fsyncParent(path, io);
  io.unlinkSync(marker);
  fsyncParent(marker, io);
}

export function readTrustedBytes(path, { ownerUid = null, ownerGid = null, maxBytes = 1_000_000, allowEmpty = false } = {}) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt++) {
    waitForNoPublisher(dirname(path));
    // Linux uses O_NOFOLLOW below. Windows lacks that flag in Node, so reject a visible reparse
    // symlink before opening; the production worker never runs on Windows.
    if (process.platform === "win32" && lstatSync(path).isSymbolicLink()) throw new Error("spool symlinks are forbidden");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const metadata = fstatSync(fd);
      if (metadata.nlink !== 1 && attempt < 19) { Atomics.wait(wait, 0, 0, 5); continue; }
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < (allowEmpty ? 0 : 2) || metadata.size > maxBytes
          || (ownerUid != null && metadata.uid !== ownerUid) || (ownerGid != null && metadata.gid !== ownerGid)
          || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o640)) {
        throw new Error("spool file type, ownership, link count, mode, or size is invalid");
      }
      const bytes = Buffer.alloc(metadata.size); let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (offset !== bytes.length || after.dev !== metadata.dev || after.ino !== metadata.ino
          || after.size !== metadata.size || after.nlink !== 1
          || (ownerUid != null && after.uid !== ownerUid) || (ownerGid != null && after.gid !== ownerGid)
          || (process.platform !== "win32" && (after.mode & 0o777) !== 0o640)) {
        throw new Error("spool file changed while it was being verified");
      }
      return bytes;
    } finally { closeSync(fd); }
  }
  throw new Error("spool file publication did not reach a single-link durable state");
}

export function readTrustedJson(path, options = {}) {
  return JSON.parse(readTrustedBytes(path, options).toString("utf8"));
}

export function readTrustedText(path, options = {}) {
  return readTrustedBytes(path, { maxBytes: 5_000_000, ...options, allowEmpty: true }).toString("utf8");
}

/*
 * Durable removal for the sole-writer command spool. Keep the verified descriptor open across the
 * unlink and parent fsync so a path substitution cannot turn retention cleanup into an arbitrary
 * deletion primitive. Missing entries are an idempotent success; every visible entry must have
 * the same exact metadata contract used by readTrustedBytes().
 */
export function durableRemoveTrusted(path, { ownerUid = null, ownerGid = null, mode = 0o640 } = {}) {
  waitForNoPublisher(dirname(path));
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  try {
    const before = fstatSync(fd); const visible = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1
        || (process.platform !== "win32" && (before.mode & 0o777) !== mode)
        || before.dev !== visible.dev || before.ino !== visible.ino || visible.isSymbolicLink()
        || (ownerUid != null && before.uid !== ownerUid)
        || (ownerGid != null && before.gid !== ownerGid)) {
      throw new Error("spool cleanup target type, ownership, link count, mode, or identity is invalid");
    }
    unlinkSync(path);
    fsyncParent(path);
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 0
        || after.size !== before.size
        || (process.platform !== "win32" && (after.mode & 0o777) !== mode)) {
      throw new Error("spool cleanup target changed during durable removal");
    }
    return true;
  } finally { closeSync(fd); }
}

/* Run only before the sole writer starts serving. It completes link/unlink crash recovery. */
export function recoverDurableTree(root, {
  ownerUid = null, ownerGid = GAME_FACTORY_SPOOL_GID, maxEntries = 20_000,
  requireExt4LostFound = false, flat = false,
} = {}) {
  const stack = [root]; const rootMetadata = lstatSync(root); let seen = 0, sawLostFound = false;
  while (stack.length) {
    const dir = stack.pop(); const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (++seen > maxEntries) throw new Error("durable spool recovery exceeded its entry bound");
      const path = join(dir, entry.name);
      if (dir === root && entry.name === "lost+found" && requireExt4LostFound) {
        const metadata = lstatSync(path);
        if (sawLostFound || !entry.isDirectory() || !metadata.isDirectory()
            || metadata.dev !== rootMetadata.dev || metadata.uid !== 0 || metadata.gid !== 0
            || (metadata.mode & 0o7777) !== 0o700) {
          throw new Error("durable spool recovery found an invalid ext4 lost+found shell");
        }
        // This inode is created by mkfs and intentionally denies the controller traversal. It is
        // structural filesystem state, never protocol state and never a recovery-cleanup target.
        sawLostFound = true;
        continue;
      }
      if (entry.isDirectory()) {
        if (flat) throw new Error("flat durable spool recovery found an unexpected directory");
        stack.push(path); continue;
      }
      if (!/^\.(?:tmp|publish)-[a-f0-9-]+$/i.test(entry.name)) continue;
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.nlink < 1 || metadata.nlink > 2
          || (ownerUid != null && metadata.uid !== ownerUid)
          || (ownerGid != null && metadata.gid !== ownerGid)
          || (process.platform !== "win32" && (metadata.mode & 0o022) !== 0)) {
        throw new Error("durable spool recovery found an untrusted temporary entry");
      }
      unlinkSync(path);
    }
    // This also makes a surviving final hard link reach nlink=1 durably before readers start.
    fsyncParent(join(dir, ".recovery"));
    try { chmodSync(dir, (lstatSync(dir).mode & 0o7000) | 0o750); } catch {}
  }
  if (requireExt4LostFound && !sawLostFound) {
    throw new Error("durable spool recovery requires the ext4 lost+found shell");
  }
}

function quarantineRun(replyDir, runKey, message, gid = GAME_FACTORY_SPOOL_GID) {
  const source = join(replyDir, `run-${runKey}`); const quarantine = join(replyDir, "quarantine");
  mkdirSync(quarantine, { recursive: true, mode: 0o2750 });
  chmodSync(quarantine, 0o2750);
  if (process.platform !== "win32" && Number.isInteger(gid)) chownSync(quarantine, -1, gid);
  const destination = join(quarantine, `run-${runKey}-${Date.now()}-${randomUUID()}`);
  try { renameSync(source, destination); fsyncParent(source); fsyncParent(destination); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const marker = join(replyDir, `quarantined-${runKey}.json`);
  durableNoReplace(marker, JSON.stringify({ protocol: GAME_FACTORY_EXECUTOR_PROTOCOL, runKey,
    quarantinedAt: new Date().toISOString(), error: redactWorkerText(message, 800) }, null, 2) + "\n", 0o640, { gid });
}

function validateEventTransition(previous, event) {
  const allowed = {
    ACCEPTED: new Set(["STEP_STARTED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"]),
    STEP_STARTED: new Set(["STEP_SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]),
    STEP_SUCCEEDED: new Set(["STEP_STARTED", "SUCCEEDED", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"]),
  };
  if (!previous) {
    if (event.status !== "ACCEPTED") throw new Error("executor reply chain does not begin with ACCEPTED");
    if (event.checkpoint?.completedSteps !== 0 || event.checkpoint?.safeBoundary !== true) {
      throw new Error("ACCEPTED checkpoint is invalid");
    }
    return;
  }
  if (GAME_FACTORY_TERMINAL_STATES.includes(previous.status) || !allowed[previous.status]?.has(event.status)) {
    throw new Error("executor reply event transition is invalid");
  }
  const priorCompleted = Number(previous.checkpoint?.completedSteps);
  const completed = Number(event.checkpoint?.completedSteps);
  if (!Number.isInteger(completed) || completed < 0 || completed > 24) throw new Error("executor reply checkpoint is invalid");
  if (event.status === "STEP_SUCCEEDED") {
    if (completed !== priorCompleted + 1) throw new Error("STEP_SUCCEEDED checkpoint is not monotonic");
  } else if (completed !== priorCompleted) {
    throw new Error(`${event.status} changed the completed safe checkpoint`);
  }
  if (event.status === "SUCCEEDED" && event.checkpoint?.complete !== true) throw new Error("SUCCEEDED lacks a complete checkpoint");
}

export function readSpoolEvents(replyDir, runKey, { ownerUid = null, ownerGid = null, quarantine = false } = {}) {
  try {
    let marker = null;
    try { marker = readTrustedJson(join(replyDir, `quarantined-${runKey}.json`), { ownerUid, ownerGid, maxBytes: 16_000 }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (marker) { const error = new Error("executor reply run is quarantined"); error.code = "SPOOL_QUARANTINED"; throw error; }
    const dir = join(replyDir, `run-${runKey}`);
    let names = [];
    try {
      waitForNoPublisher(dir);
      const entries = readdirSync(dir);
      const unexpected = entries.filter((name) => !/^event-\d{8}-[a-f0-9-]+\.json$/i.test(name)
        && !/^(?:stdout|stderr)\.log$/.test(name));
      if (unexpected.length) throw new Error("executor reply directory contains an unexpected entry");
      names = entries.filter((name) => /^event-\d{8}-[a-f0-9-]+\.json$/i.test(name)).sort();
    }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const events = []; let prior = ""; let identity = null;
    for (const name of names) {
      const event = readTrustedJson(join(dir, name), { ownerUid, ownerGid, maxBytes: 1_000_000 });
      if (!event || event.protocol !== GAME_FACTORY_EXECUTOR_PROTOCOL || event.runKey !== runKey
          || event.sequence !== events.length + 1 || event.previousHash !== prior) {
        throw new Error("executor reply event chain has a protocol gap or fork");
      }
      if (!/^[a-f0-9]{64}$/.test(event.requestHash || "") || !/^[a-f0-9]{64}$/.test(event.policyHash || "") || !event.runId) {
        throw new Error("executor reply event identity is invalid");
      }
      const currentIdentity = `${event.runId}\0${event.requestHash}\0${event.policyHash}`;
      if (identity && identity !== currentIdentity) throw new Error("executor reply identity changed within the event chain");
      identity ||= currentIdentity;
      validateEventTransition(events.at(-1), event);
      const copy = { ...event }; delete copy.eventHash;
      if (event.eventHash !== sha256Text(JSON.stringify(stableValue(copy)))) throw new Error("executor reply event hash is invalid");
      prior = event.eventHash; events.push(event);
    }
    return events;
  } catch (error) {
    if (quarantine && error?.code !== "SPOOL_QUARANTINED" && error?.code !== "SPOOL_PUBLICATION_PENDING") {
      quarantineRun(replyDir, runKey, error.message || error, ownerGid);
    }
    throw error;
  }
}
