/*
 * Dominion AI — nightly off-box backup of the whole /data volume into the owner's Google Drive.
 *
 * WHY. Everything a customer has ever made lives on one Railway volume: chat history, artifacts,
 * billing and credit ledgers, connector tokens, the persona corpus, and now the guest workshops
 * where people's actual projects live. Railway does not back that volume up. Until today the only
 * off-box copy was cloudbackup.mjs, which covers the persona corpus ALONE (93MB of a 1.03GB volume)
 * and only when Fred's laptop happens to be awake to receive it. Everything else was one disk
 * failure from gone. Fred has 19.5TB free in Drive, so the capacity question answers itself.
 *
 * WHAT MAKES THIS DIFFERENT FROM COPYING FILES.
 *
 * 1. LIVE SQLITE. At least seven SQLite databases are open and being written while this runs, and
 *    two of them (billing.db, credits.db) are money. Copying a live SQLite file byte-for-byte can
 *    capture a torn write, and the result LOOKS like a backup until the day you restore it. Every
 *    database is therefore snapshotted with VACUUM INTO from a read-only handle, which SQLite
 *    guarantees to be a consistent point-in-time image. Verified rather than assumed before this
 *    module was written: with a writer mid-transaction, the snapshot contained exactly the
 *    committed rows, the uncommitted ones were correctly absent, and integrity_check returned ok.
 *
 * 2. SIZE. 1.03GB today and it grows with every customer. Nothing is ever held whole in memory:
 *    the archive streams (tarstream.mjs) through gzip, optionally through a cipher, into Drive's
 *    resumable upload. Peak memory is a few chunks no matter how big the volume gets.
 *
 * 3. THE FAILURE THAT MATTERS IS THE QUIET ONE. A backup that runs nightly, reports success, and
 *    cannot be restored is worse than no backup, because it removes the worry that would otherwise
 *    make someone check. So every run VERIFIES: Drive's own md5 of the stored bytes is compared
 *    against the md5 computed while streaming, and a mismatch fails the run. Beyond that, verify()
 *    pulls a backup back down, unpacks it, and runs integrity_check on a real database out of it.
 *
 * WHAT IS DELIBERATELY NOT ENCRYPTED BY DEFAULT. This lands in Fred's own private Drive, the same
 * trust boundary the existing corpus backup already uses. Encryption is available (BACKUP_KEY) and
 * off unless he sets it, because for a non-technical owner a lost key turns every backup into
 * noise, and that is a worse expected outcome than the risk it removes. When the key IS set the
 * archive is AES-256-GCM and the key never leaves the environment.
 */
import { createGzip, createGunzip } from "node:zlib";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readdirSync, statSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Transform, Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { tarStream, extractStream } from "./tarstream.mjs";

const DB_RE = /\.(db|sqlite|sqlite3)$/i;
// SQLite's sidecars are meaningless beside a VACUUMed snapshot and actively misleading in a restore.
const SKIP_RE = /(\.db-wal|\.db-shm|\.sqlite-wal|\.sqlite-shm|\.tmp|\.partial)$/i;
const STAGE_DIR = "backup-staging";

const stamp = (d) => new Date(d).toISOString().slice(0, 19).replace(/[:T]/g, "-");

/*
 * Walk the volume. Returns plain files only; directories are implied by their entries' names, which
 * is enough for tar and avoids emitting entries for directories that vanish mid-walk.
 */
export function walkVolume(root, { skipDirs = [], maxFiles = 200000, onSkip = () => {} } = {}) {
  const out = [];
  const skip = new Set(skipDirs);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (e) { onSkip(dir, String((e && e.message) || e)); continue; }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = relative(root, full).split(sep).join("/");
      if (skip.has(rel) || skip.has(ent.name)) continue;
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;                       // sockets, symlinks: never in a data volume backup
      if (SKIP_RE.test(ent.name)) continue;
      if (out.length >= maxFiles) { onSkip(full, "file cap reached"); return out; }
      let size = 0, mtime = 0;
      try { const st = statSync(full); size = st.size; mtime = Math.floor(st.mtimeMs / 1000); }
      catch (e) { onSkip(full, String((e && e.message) || e)); continue; }
      out.push({ path: full, name: rel, size, mtime });
    }
  }
  return out;
}

/*
 * Snapshot every SQLite database into a staging directory using VACUUM INTO, and return a rewritten
 * file list where each database points at its consistent snapshot instead of the live file.
 *
 * A database that cannot be snapshotted is REPORTED and its live file is excluded rather than
 * silently included raw. A raw copy of a live database is the single most dangerous thing this
 * archive could contain, because it restores without complaint and is wrong.
 */
export function quiesceDatabases(files, stageRoot, { log = () => {} } = {}) {
  mkdirSync(stageRoot, { recursive: true });
  const out = [], snapshotted = [], failed = [];
  for (const f of files) {
    if (!DB_RE.test(f.name)) { out.push(f); continue; }
    const dest = join(stageRoot, f.name.replace(/[\\/]/g, "__"));
    let db = null;
    try {
      db = new DatabaseSync(f.path, { readOnly: true });
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      const st = statSync(dest);
      out.push({ path: dest, name: f.name, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      snapshotted.push(f.name);
    } catch (e) {
      failed.push({ name: f.name, error: String((e && e.message) || e) });
      log(`volume-backup: EXCLUDED ${f.name} — could not snapshot it consistently (${String((e && e.message) || e).slice(0, 120)})`);
    } finally { try { if (db) db.close(); } catch {} }
  }
  return { files: out, snapshotted, failed };
}

// A pass-through that hashes everything crossing it, so the md5 costs one traversal, not two.
function hashingPass(hash) {
  return new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
}

/*
 * ARCHIVE FORMAT WHEN ENCRYPTED:  iv(12) || ciphertext || authTag(16)
 *
 * A generator rather than a pipe, because AES-GCM's authentication tag only exists once the cipher
 * has seen the last byte, so it cannot be attached by any arrangement of pipes. Writing it as a
 * pipe and hoping is how an archive ends up unauthenticated, which for GCM means undecryptable.
 * decryptArchive below is the exact inverse and the test drives them as a pair, because an
 * encryption path that has never been decrypted is a backup that has never been restored.
 */
export async function* encryptArchive(plain, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  yield iv;
  for await (const chunk of plain.pipe(cipher)) yield chunk;
  yield cipher.getAuthTag();
}

/*
 * The inverse. GCM will not release plaintext it cannot authenticate, so a tampered or truncated
 * archive throws here rather than yielding believable garbage. The tag is the LAST 16 bytes, which
 * means the final block has to be held back until the stream ends.
 */
export async function* decryptArchive(cipherStream, keyHex) {
  const it = cipherStream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  while (buf.length < 12) {
    const { value, done } = await it.next();
    if (done) throw new Error("archive is too short to be an encrypted backup");
    buf = Buffer.concat([buf, value]);
  }
  const iv = buf.subarray(0, 12);
  buf = buf.subarray(12);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  /*
   * Always keep the trailing 16 bytes in hand, because they might turn out to be the tag. Whatever
   * is left when the source ends IS the tag, plus any body that never got flushed. The first draft
   * only handled the tail inside the loop, so an archive that arrived as a single chunk fell
   * straight past the loop with the entire ciphertext still buffered and was declared truncated.
   * Small archives break this; large ones do not, which is the wrong way round for a safety net.
   */
  while (true) {
    const { value, done } = await it.next();
    if (done) break;
    buf = Buffer.concat([buf, value]);
    if (buf.length > 16) {
      const body = buf.subarray(0, buf.length - 16);
      buf = buf.subarray(buf.length - 16);
      const piece = decipher.update(body);
      if (piece.length) yield piece;
    }
  }
  if (buf.length < 16) throw new Error("encrypted archive is truncated: no authentication tag");
  const tag = buf.subarray(buf.length - 16);
  const rest = buf.subarray(0, buf.length - 16);
  if (rest.length) { const piece = decipher.update(rest); if (piece.length) yield piece; }
  decipher.setAuthTag(tag);
  const last = decipher.final();               // throws if the archive was altered
  if (last.length) yield last;
}

export function createVolumeBackup({
  dataDir,
  drive,                                  // (T) => drive client, from google.mjs
  ownerTenant = { isOwner: true, uid: "owner" },
  folderName = "Dominion Volume Backups",
  keep = 7,
  encryptionKey = "",                     // hex; "" leaves the archive unencrypted in Fred's own Drive
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const stageRoot = join(dataDir, STAGE_DIR);
  const statusFile = join(dataDir, "backup-status.json");

  const readStatus = () => { try { return JSON.parse(readFileSync(statusFile, "utf8")); } catch { return {}; } };
  const writeStatus = (patch) => {
    const s = { ...readStatus(), ...patch };
    try { mkdirSync(dataDir, { recursive: true }); writeFileSync(statusFile, JSON.stringify(s, null, 2)); } catch {}
    return s;
  };

  async function runOnce() {
    const started = now();
    const label = "dominion-volume-" + stamp(started) + ".tar.gz" + (encryptionKey ? ".enc" : "");
    let client;
    try { client = drive(ownerTenant); }
    catch (e) { return fail("drive_unavailable", String((e && e.message) || e), started); }

    // Clear any staging left by a crashed run before measuring or archiving anything.
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch {}

    const skips = [];
    const all = walkVolume(dataDir, {
      // Never archive our own staging, and never archive previous archives.
      skipDirs: [STAGE_DIR, "corpus-backups"],
      onSkip: (p, why) => skips.push({ path: p, why }),
    });
    const q = quiesceDatabases(all, stageRoot, { log });
    const files = q.files;
    const rawBytes = files.reduce((n, f) => n + (f.size || 0), 0);
    log(`volume-backup: ${files.length} files, ${(rawBytes / 1e6).toFixed(1)}MB raw, ${q.snapshotted.length} database(s) snapshotted`);

    try {
      const folderId = await client.ensureFolder(folderName);
      const md5 = createHash("md5");
      const plain = tarStream(files, { onSkip: (f, why) => skips.push({ path: f.name, why }) }).pipe(createGzip({ level: 6 }));
      const source = encryptionKey ? Readable.from(encryptArchive(plain, encryptionKey)) : plain;
      const uploaded = await client.uploadStream(source.pipe(hashingPass(md5)), {
        name: label, parentId: folderId, mimeType: "application/gzip",
      });
      const localMd5 = md5.digest("hex");

      /*
       * THE CHECK THAT MAKES THIS A BACKUP RATHER THAN AN UPLOAD. Drive computes its own md5 of the
       * bytes it actually stored. If it disagrees with what we streamed, something was lost or
       * mangled in transit and this run must be recorded as a FAILURE, however healthy it looked.
       */
      const remoteMd5 = String(uploaded.md5Checksum || "");
      if (remoteMd5 && remoteMd5 !== localMd5) {
        return fail("checksum_mismatch", `Drive stored bytes that do not match what was sent (local ${localMd5}, Drive ${remoteMd5})`, started);
      }

      const pruned = await prune(client, folderId);
      const done = now();
      const s = writeStatus({
        lastSuccessAt: done, lastError: "", lastErrorAt: 0,
        lastFileId: uploaded.id, lastName: label,
        lastBytes: Number(uploaded.size || 0), lastRawBytes: rawBytes,
        lastFiles: files.length, lastDurationMs: done - started,
        lastMd5: localMd5, checksumVerified: !!remoteMd5,
        databasesSnapshotted: q.snapshotted, databasesFailed: q.failed,
        skipped: skips.slice(0, 50), prunedCount: pruned.length, folderId,
      });
      log(`volume-backup: OK ${label} ${(Number(uploaded.size || 0) / 1e6).toFixed(1)}MB in ${Math.round((done - started) / 1000)}s` +
          (remoteMd5 ? " (checksum verified)" : " (Drive returned no checksum)") + (pruned.length ? `, pruned ${pruned.length}` : ""));
      return { ok: true, ...s };
    } catch (e) {
      const msg = String((e && e.message) || e);
      /*
       * Distinguished because it is the most likely state on a fresh install and the only one with
       * a one-click cure. drive(T) itself never touches a token, so the "not connected" error
       * surfaces here on the first API call rather than at construction, and lumping it in with
       * upload_failed would send Fred hunting a network problem that does not exist.
       */
      const notConnected = /not connected|reconnect google|refresh failed|invalid_grant/i.test(msg);
      return fail(notConnected ? "drive_not_connected" : "upload_failed", msg, started);
    } finally {
      try { rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    }
  }

  function fail(code, error, started) {
    const s = writeStatus({ lastError: code + ": " + error, lastErrorAt: now(), lastFailDurationMs: now() - started });
    log("volume-backup: FAILED " + code + " — " + error);
    return { ok: false, code, error, ...s };
  }

  // Retention. Newest `keep` survive; the rest are removed so 19.5TB does not become a landfill.
  async function prune(client, folderId) {
    const files = (await client.list(folderId)).filter((f) => /^dominion-volume-/.test(f.name || ""));
    const doomed = files.slice(keep);
    const gone = [];
    for (const f of doomed) { try { await client.remove(f.id); gone.push(f.name); } catch (e) { log("volume-backup: could not prune " + f.name + ": " + e.message); } }
    return gone;
  }

  /*
   * The restore drill. Downloads a stored backup, unpacks it, and opens a real database out of it
   * to run integrity_check. This is the only evidence that actually answers "could we recover?",
   * which is the only question a backup exists to answer.
   */
  async function verify({ fileId = "", into = "" } = {}) {
    const client = drive(ownerTenant);
    const folderId = await client.ensureFolder(folderName);
    const list = (await client.list(folderId)).filter((f) => /^dominion-volume-/.test(f.name || ""));
    const target = fileId ? list.find((f) => f.id === fileId) : list[0];
    if (!target) return { ok: false, error: "no backup found in Drive to verify" };

    const dest = into || join(dataDir, "backup-verify");
    try { rmSync(dest, { recursive: true, force: true }); } catch {}
    mkdirSync(dest, { recursive: true });
    const written = [];
    try {
      const r = await client.download(target.id);
      if (!r.ok) return { ok: false, error: "download failed: HTTP " + r.status, name: target.name };

      /*
       * Streamed end to end, on purpose. The obvious implementation buffers the archive and unpacks
       * it in memory, which would mean proving that a gigabyte can be restored by first holding a
       * gigabyte in a container that has nothing like that to spare. The drill would then fail on
       * exactly the large backups it exists to check, and pass on the small ones that never needed
       * checking. Only the databases are written to disk, and only long enough to be opened.
       */
      let bytes = Readable.fromWeb(r.body);
      if (encryptionKey) bytes = Readable.from(decryptArchive(bytes, encryptionKey));
      const tar = bytes.pipe(createGunzip());
      const counts = await extractStream(tar, {
        want: (name) => DB_RE.test(name),
        onEntry: ({ name }) => { const p = join(dest, name.replace(/[\\/]/g, "__")); written.push({ name, path: p }); return p; },
      });

      let dbOk = 0, firstBad = "";
      for (const w of written) {
        let db = null;
        try {
          db = new DatabaseSync(w.path, { readOnly: true });
          const res = db.prepare("PRAGMA integrity_check").get();
          if (String(res.integrity_check || "").toLowerCase() === "ok") dbOk++;
          else if (!firstBad) firstBad = w.name + ": " + res.integrity_check;
        } catch (err) { if (!firstBad) firstBad = w.name + ": " + String((err && err.message) || err); }
        finally { try { if (db) db.close(); } catch {} }
      }
      const ok = written.length > 0 && dbOk === written.length;
      writeStatus({ lastVerifyAt: now(), lastVerifyOk: ok, lastVerifyName: target.name, lastVerifyDbs: `${dbOk}/${written.length}`, lastVerifyError: firstBad });
      return { ok, name: target.name, entries: counts.entries, databases: written.length, healthy: dbOk, firstBad };
    } catch (e) {
      const msg = String((e && e.message) || e);
      writeStatus({ lastVerifyAt: now(), lastVerifyOk: false, lastVerifyName: target.name, lastVerifyError: msg });
      return { ok: false, error: msg, name: target.name };
    } finally { try { rmSync(dest, { recursive: true, force: true }); } catch {} }
  }

  /*
   * Status, shaped for a human and for the health sweep. `stale` is the field that matters: a job
   * that stopped running two weeks ago produces no errors at all, which is precisely why silence
   * must never be read as health.
   */
  function status() {
    const s = readStatus();
    const age = s.lastSuccessAt ? now() - s.lastSuccessAt : null;
    return {
      configured: !!dataDir,
      encrypted: !!encryptionKey,
      lastSuccessAt: s.lastSuccessAt || 0,
      ageHours: age == null ? null : Math.round(age / 3600000 * 10) / 10,
      stale: age == null || age > 48 * 3600000,
      lastError: s.lastError || "",
      lastName: s.lastName || "",
      lastBytes: s.lastBytes || 0,
      lastFiles: s.lastFiles || 0,
      checksumVerified: !!s.checksumVerified,
      databasesSnapshotted: s.databasesSnapshotted || [],
      databasesFailed: s.databasesFailed || [],
      lastVerifyAt: s.lastVerifyAt || 0,
      lastVerifyOk: !!s.lastVerifyOk,
      lastVerifyDbs: s.lastVerifyDbs || "",
    };
  }

  let timer = null;
  function start(intervalMs) {
    const ms = Math.max(Number(intervalMs) || 24 * 3600000, 3600000);
    if (timer) clearInterval(timer);
    setTimeout(() => runOnce().catch((e) => log("volume-backup error: " + e.message)), 120000);
    timer = setInterval(() => runOnce().catch((e) => log("volume-backup error: " + e.message)), ms);
    log(`volume-backup: scheduled every ${Math.round(ms / 3600000 * 10) / 10}h -> Drive/${folderName}, keep ${keep}${encryptionKey ? ", encrypted" : ""}`);
    return { intervalMs: ms };
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { runOnce, verify, status, prune, start, stop, folderName, keep };
}
