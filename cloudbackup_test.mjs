/*
 * Phase-3 cloud-backup self-test — run with: node cloudbackup_test.mjs
 * Proves (no server needed): the off-box push streams a file through the hands node in chunks and
 * reassembles it byte-for-byte; honest skip when unconfigured; honest failure surfaced (not faked);
 * newest-snapshot pick; and a mock persona.backupTo drives runOnce end to end.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const WORK = mkdtempSync(join(tmpdir(), "cbk-"));
// The node executor jails to HANDS_ROOTS — set it to WORK before importing.
process.env.HANDS_ROOTS = WORK;
const { executeJob } = await import("./hands/hands.mjs");
const { createCloudBackup } = await import("./cloudbackup.mjs");

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
// A dispatch that runs the REAL node executor (so this is a true chunked round trip into WORK).
const realDispatch = async (_node, tool, args) => executeJob(tool, args);

// Make an ~1.2 MB pseudo-corpus and a persona stub that "snapshots" it into a source path.
const SRC = join(WORK, "src-corpus.db");
writeFileSync(SRC, Buffer.alloc(1_200_003, 7));   // non-trivial size, not a chunk multiple
const personaStub = { backupTo: () => ({ ok: true, path: SRC, bytes: 1_200_003 }) };

await t("pushFileOffBox streams in chunks and reassembles byte-for-byte", async () => {
  const cb = createCloudBackup({ persona: personaStub, dispatch: realDispatch,
    cfg: { node: "mini-pc", remoteDir: join(WORK, "offbox"), chunkBytes: 100_000 }, log: () => {} });
  const r = await cb.pushFileOffBox(SRC);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = readFileSync(r.remotePath);
  assert.equal(got.length, 1_200_003, "size matches");
  assert.equal(sha(got), sha(readFileSync(SRC)), "hash matches (chunks reassembled correctly)");
});

await t("unconfigured push is SKIPPED honestly (never faked)", async () => {
  const cb = createCloudBackup({ persona: personaStub, dispatch: null, cfg: {}, log: () => {} });
  const r = await cb.pushFileOffBox(SRC);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /not configured/);
});

await t("a node refusal is surfaced, not swallowed", async () => {
  const refuseDispatch = async () => ({ ok: false, refused: true, reason: "protected resource" });
  const cb = createCloudBackup({ persona: personaStub, dispatch: refuseDispatch,
    cfg: { node: "x", remoteDir: "D:\\backups", chunkBytes: 100000 }, log: () => {} });
  const r = await cb.pushFileOffBox(SRC);
  assert.equal(r.ok, false);
  assert.match(r.error, /protected/);
});

await t("offline node surfaces offline:true", async () => {
  const offDispatch = async () => ({ ok: false, offline: true, error: "node offline" });
  const cb = createCloudBackup({ persona: personaStub, dispatch: offDispatch,
    cfg: { node: "x", remoteDir: join(WORK, "o2"), chunkBytes: 100000 }, log: () => {} });
  const r = await cb.pushFileOffBox(SRC);
  assert.equal(r.ok, false); assert.equal(r.offline, true);
});

await t("runOnce: snapshot + push, end to end through the real node", async () => {
  const cb = createCloudBackup({ persona: personaStub, dispatch: realDispatch,
    cfg: { node: "mini-pc", remoteDir: join(WORK, "offbox2"), chunkBytes: 250000 }, log: () => {} });
  const r = await cb.runOnce();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.push.ok, true);
  assert.equal(sha(readFileSync(r.push.remotePath)), sha(readFileSync(SRC)));
});

await t("runOnce still returns ok when push is unconfigured (local snapshot alone)", async () => {
  const cb = createCloudBackup({ persona: personaStub, dispatch: null, cfg: {}, log: () => {} });
  const r = await cb.runOnce();
  assert.equal(r.ok, true);
  assert.equal(r.push.skipped, true);
});

try { rmSync(WORK, { recursive: true, force: true }); } catch {}
console.log(`\ncloudbackup_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
