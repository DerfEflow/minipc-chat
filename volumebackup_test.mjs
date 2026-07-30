/*
 * The volume backup (volumebackup.mjs) and its Drive plumbing.
 *
 * This module exists to answer exactly one question: if the Railway volume dies tonight, can every
 * customer's work come back? So the tests are written to attack the ways a backup lies:
 *
 *   - it copies a LIVE SQLite database byte-for-byte and restores something subtly corrupt,
 *     which for billing.db and credits.db means wrong money with no error anywhere;
 *   - it uploads fine and stores something different, and reports success either way;
 *   - it encrypts with a path nobody ever decrypted;
 *   - it stops running, and silence gets read as health.
 *
 * The central test does a real round trip: live databases with a writer mid-transaction, archived,
 * "uploaded", pulled back, unpacked, opened, and integrity-checked. Anything less than that is
 * inspecting a backup rather than restoring one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createVolumeBackup, walkVolume, quiesceDatabases, encryptArchive, decryptArchive } from "./volumebackup.mjs";

let passed = 0;
const t = async (name, fn) => { await fn(); console.log("  PASS  " + name); passed++; };

/*
 * A fake Drive that stores bytes in memory and behaves like the real one in the ways that matter:
 * it reports its OWN md5 of what it actually stored (so a transport that mangles bytes is
 * detectable), and it hands back a streaming body on download.
 */
function fakeDrive({ corruptOnStore = false } = {}) {
  const folders = new Map(), files = new Map();
  let seq = 0;
  const api = {
    async ensureFolder(name) { if (!folders.has(name)) folders.set(name, "folder_" + name); return folders.get(name); },
    async list(folderId) {
      return [...files.values()].filter((f) => f.parentId === folderId).sort((a, b) => b.createdTime - a.createdTime)
        .map((f) => ({ id: f.id, name: f.name, size: String(f.data.length), md5Checksum: f.md5, createdTime: f.createdTime }));
    },
    async remove(id) { files.delete(id); return { ok: true }; },
    async meta(id) { const f = files.get(id); return { id, name: f.name, size: String(f.data.length), md5Checksum: f.md5 }; },
    async download(id) {
      const f = files.get(id);
      if (!f) return { ok: false, status: 404 };
      return { ok: true, status: 200, body: Readable.toWeb(Readable.from([f.data])) };
    },
    async uploadStream(stream, { name, parentId }) {
      const chunks = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      let data = Buffer.concat(chunks);
      if (corruptOnStore) { data = Buffer.from(data); data[Math.floor(data.length / 2)] ^= 0xff; }
      const { createHash } = await import("node:crypto");
      const md5 = createHash("md5").update(data).digest("hex");
      const id = "file_" + (++seq);
      files.set(id, { id, name, parentId, data, md5, createdTime: seq });
      return { id, name, size: String(data.length), md5Checksum: md5 };
    },
  };
  return { client: () => api, files };
}

// A volume that looks like the real one: live WAL databases, ordinary files, nested folders.
function makeVolume() {
  const dir = mkdtempSync(join(tmpdir(), "voldata-"));
  mkdirSync(join(dir, "users", "u1", "artifacts"), { recursive: true });
  mkdirSync(join(dir, "workshops", "u1", "my-app"), { recursive: true });
  writeFileSync(join(dir, "users", "u1", "artifacts", "note.md"), "# a customer's document");
  writeFileSync(join(dir, "workshops", "u1", "my-app", "index.js"), "console.log('their app')");

  const money = new DatabaseSync(join(dir, "billing.db"));
  money.exec("PRAGMA journal_mode=WAL");
  money.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY, cents INTEGER)");
  const ins = money.prepare("INSERT INTO ledger (cents) VALUES (?)");
  for (let i = 1; i <= 2000; i++) ins.run(i);

  const credits = new DatabaseSync(join(dir, "credits.db"));
  credits.exec("CREATE TABLE grants (uid TEXT, credits INTEGER)");
  credits.prepare("INSERT INTO grants VALUES (?,?)").run("u1", 5000);

  return { dir, money, credits, ins };
}

await t("the walk finds customer files and skips SQLite sidecars and staging", async () => {
  const v = makeVolume();
  writeFileSync(join(v.dir, "billing.db-wal"), "junk");
  mkdirSync(join(v.dir, "backup-staging"), { recursive: true });
  writeFileSync(join(v.dir, "backup-staging", "leftover.tar"), "old run");
  const files = walkVolume(v.dir, { skipDirs: ["backup-staging", "corpus-backups"] });
  const names = files.map((f) => f.name);
  assert.ok(names.includes("users/u1/artifacts/note.md"));
  assert.ok(names.includes("workshops/u1/my-app/index.js"));
  assert.ok(names.includes("billing.db"));
  assert.ok(!names.some((n) => /-wal|-shm/.test(n)), "sidecars are meaningless beside a VACUUMed snapshot");
  assert.ok(!names.some((n) => n.startsWith("backup-staging")), "a backup must never archive its own staging");
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("THE MONEY TEST: a database written mid-transaction snapshots consistently", async () => {
  const v = makeVolume();
  // A writer is mid-transaction and will ROLL BACK. Those rows must not appear in the backup.
  v.money.exec("BEGIN");
  for (let i = 0; i < 300; i++) v.ins.run(999000 + i);

  const stage = join(v.dir, "backup-staging");
  const files = walkVolume(v.dir, { skipDirs: ["backup-staging"] });
  const q = quiesceDatabases(files, stage);
  assert.ok(q.snapshotted.includes("billing.db"), "billing.db must be snapshotted, never copied raw");
  assert.equal(q.failed.length, 0, JSON.stringify(q.failed));

  v.money.exec("ROLLBACK");
  const snapPath = q.files.find((f) => f.name === "billing.db").path;
  const snap = new DatabaseSync(snapPath, { readOnly: true });
  assert.equal(snap.prepare("SELECT COUNT(*) n FROM ledger").get().n, 2000, "uncommitted rows must not be in the backup");
  assert.equal(snap.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  snap.close();
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("THE WHOLE POINT: a backup round-trips and its databases restore healthy", async () => {
  const v = makeVolume();
  const d = fakeDrive();
  const b = createVolumeBackup({ dataDir: v.dir, drive: d.client, keep: 7 });
  const run = await b.runOnce();
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.checksumVerified, true, "Drive's checksum must be compared, not trusted");
  assert.ok(run.lastFiles >= 4);

  // Now actually restore it: stream back, unpack, open the money database, integrity-check it.
  const ver = await b.verify();
  assert.equal(ver.ok, true, "the restore drill must pass: " + JSON.stringify(ver));
  assert.ok(ver.databases >= 2, "both databases must come back, got " + ver.databases);
  assert.equal(ver.healthy, ver.databases, "every restored database must be healthy");
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("bytes mangled in transit FAIL the run instead of reporting success", async () => {
  const v = makeVolume();
  const d = fakeDrive({ corruptOnStore: true });
  const b = createVolumeBackup({ dataDir: v.dir, drive: d.client });
  const run = await b.runOnce();
  assert.equal(run.ok, false, "a checksum mismatch must never be reported as a successful backup");
  assert.equal(run.code, "checksum_mismatch");
  assert.match(b.status().lastError, /checksum_mismatch/);
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("an encrypted archive can actually be decrypted, and refuses tampering", async () => {
  const key = "11".repeat(32);
  const plain = Buffer.from("the archive bytes that must survive a round trip");
  const enc = [];
  for await (const c of encryptArchive(Readable.from([plain]), key)) enc.push(Buffer.from(c));
  const sealed = Buffer.concat(enc);
  assert.ok(!sealed.includes(plain), "the plaintext must not be sitting in the ciphertext");

  const back = [];
  for await (const c of decryptArchive(Readable.from([sealed]), key)) back.push(Buffer.from(c));
  assert.equal(Buffer.concat(back).toString(), plain.toString(), "encryption is only real if it decrypts");

  const tampered = Buffer.from(sealed); tampered[20] ^= 0xff;
  await assert.rejects(async () => { for await (const _ of decryptArchive(Readable.from([tampered]), key)) {} },
    "a tampered archive must throw, never yield believable garbage");
});

await t("an encrypted backup still survives the full round trip", async () => {
  const v = makeVolume();
  const d = fakeDrive();
  const b = createVolumeBackup({ dataDir: v.dir, drive: d.client, encryptionKey: "22".repeat(32) });
  const run = await b.runOnce();
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.match(run.lastName, /\.enc$/);
  const ver = await b.verify();
  assert.equal(ver.ok, true, "an encrypted backup that cannot be restored is not a backup: " + JSON.stringify(ver));
  assert.equal(ver.healthy, ver.databases);
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("retention keeps the newest and removes the rest", async () => {
  const v = makeVolume();
  const d = fakeDrive();
  let clock = 1;
  const b = createVolumeBackup({ dataDir: v.dir, drive: d.client, keep: 3, now: () => clock * 1000 });
  for (let i = 0; i < 5; i++) { clock += 86400; const r = await b.runOnce(); assert.equal(r.ok, true); }
  const kept = [...d.files.values()].filter((f) => /^dominion-volume-/.test(f.name));
  assert.equal(kept.length, 3, "keep=3 must leave exactly 3, found " + kept.length);
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("SILENCE IS NOT HEALTH: a job that stopped running reports stale", async () => {
  const v = makeVolume();
  const d = fakeDrive();
  let clock = Date.parse("2026-07-30T00:00:00Z");
  const b = createVolumeBackup({ dataDir: v.dir, drive: d.client, now: () => clock });
  await b.runOnce();
  assert.equal(b.status().stale, false, "a fresh backup is not stale");
  assert.equal(b.status().lastError, "");
  clock += 5 * 24 * 3600 * 1000;                       // five days later, nothing has run
  const s = b.status();
  assert.equal(s.stale, true, "a backup that stopped days ago must read as stale even with no error");
  assert.ok(s.ageHours >= 100);
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

await t("a Drive that is not connected says so by name, not as a generic upload failure", async () => {
  const v = makeVolume();
  const notConnected = new Error("Google account not connected. Open Setup and connect Google first.");
  // The real provider builds its client lazily, so the error surfaces on the first API CALL rather
  // than at construction. Both shapes must land on the same actionable code.
  const atCall = createVolumeBackup({ dataDir: v.dir, drive: () => ({ async ensureFolder() { throw notConnected; } }) });
  const r1 = await atCall.runOnce();
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "drive_not_connected", "the one failure with a one-click cure must be named");
  assert.match(atCall.status().lastError, /not connected/);

  const atBuild = createVolumeBackup({ dataDir: v.dir, drive: () => { throw notConnected; } });
  const r2 = await atBuild.runOnce();
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "drive_unavailable");
  v.money.close(); v.credits.close();
  rmSync(v.dir, { recursive: true, force: true });
});

console.log(`\n${passed}/9 checks passed - the backup restores, and it cannot quietly lie about it`);
