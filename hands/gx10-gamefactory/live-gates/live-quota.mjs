import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";

const mode = process.argv[2];
const root = `live-quota-${mode}`;
// These limits mirror the fixed system-canary project limits in
// provision-loopback-filesystems.sh.  The probe is bounded at exactly one
// allocation attempt beyond each reviewed limit so a smaller loop can never
// produce false quota evidence after a provisioning change.
const REVIEWED_PROJECT_BLOCK_LIMIT_KIB = 1_048_576;
const REVIEWED_PROJECT_INODE_LIMIT = 131_072;
const BLOCK_CHUNK_BYTES = 1024 * 1024;
const BLOCK_WRITE_LIMIT = Math.ceil((REVIEWED_PROJECT_BLOCK_LIMIT_KIB * 1024) / BLOCK_CHUNK_BYTES) + 1;
const INODE_CREATE_LIMIT = REVIEWED_PROJECT_INODE_LIMIT + 1;
mkdirSync(root, { mode: 0o700 });
let count = 0;
let code = "";
let errno = null;
let syscall = "";
try {
  if (mode === "blocks") {
    const chunk = Buffer.alloc(BLOCK_CHUNK_BYTES, 0x51);
    for (; count < BLOCK_WRITE_LIMIT; count++) {
      const descriptor = openSync(`${root}/${String(count).padStart(6, "0")}.bin`, "wx", 0o600);
      try { writeSync(descriptor, chunk); } finally { closeSync(descriptor); }
    }
  } else if (mode === "inodes") {
    for (; count < INODE_CREATE_LIMIT; count++) {
      const descriptor = openSync(`${root}/${String(count).padStart(6, "0")}.txt`, "wx", 0o600);
      closeSync(descriptor);
    }
  } else {
    throw new Error("unknown quota test mode");
  }
} catch (error) {
  code = String(error?.code || "");
  errno = Number.isSafeInteger(error?.errno) ? error.errno : null;
  syscall = String(error?.syscall || "");
} finally {
  rmSync(root, { recursive: true, force: true });
}
// Node/libuv can surface Linux EDQUOT (errno 122) as code=UNKNOWN.  Require
// either the canonical name or the exact EDQUOT/ENOSPC errno; UNKNOWN alone is
// never accepted as quota evidence.
const quotaBlocked = ["EDQUOT", "ENOSPC"].includes(code) || [-122, -28, 122, 28].includes(errno);
assert.ok(quotaBlocked,
  `quota did not block: mode=${mode} count=${count} code=${code} errno=${errno} syscall=${syscall}`);
console.log(JSON.stringify({ protocol: "gx10-game-factory-quota/1", ok: true, mode, count, code, errno, syscall }));
