/*
 * Dominion AI — corpus restore (deploy step 4).
 *
 * Gets the 885-doc persona corpus onto the Railway volume WITHOUT ever writing to a live SQLite
 * handle. The upload endpoint streams the snapshot to `<corpusDir>/incoming.db` in base64 chunks;
 * finalize verifies it (SHA-256 + integrity_check + the four canonical counts) and, only if every
 * check passes, drops a marker `incoming.ok`. The actual swap happens at BOOT, before the persona
 * store opens its handle, so there is no open-handle corruption window (WAL/SHM are cleared too).
 *
 * The four canonical numbers (the 2026-07-13 snapshot): docs 885 · chunks 14,696 ·
 * non-null vectors 14,696 · FTS 'Fred' 834 · integrity_check ok · SHA-256 981E9B08…C0E652.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));           // 88MB fits comfortably in memory; simple + correct
  return h.digest("hex").toUpperCase();
}

// Open a candidate DB read-only and report integrity + the four canonical counts + hash.
export function verifyCorpusFile(path, expect = {}) {
  const out = { path, ok: false };
  if (!existsSync(path)) return { ...out, error: "file not found" };
  out.bytes = statSync(path).size;
  out.sha256 = sha256File(path);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    out.integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    out.docs = db.prepare("SELECT count(*) n FROM docs").get().n;
    out.chunks = db.prepare("SELECT count(*) n FROM chunks").get().n;
    out.vectors = db.prepare("SELECT count(*) n FROM chunks WHERE vec IS NOT NULL").get().n;
    try { out.ftsFred = db.prepare("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'Fred'").get().n; }
    catch { out.ftsFred = null; }   // fts table may be named differently in an old snapshot
  } catch (e) { return { ...out, error: "open/query failed: " + e.message }; }
  finally { try { db && db.close(); } catch {} }
  // Gate: integrity ok, plus any provided expectations (sha/docs/chunks) must match exactly.
  const reasons = [];
  if (out.integrity !== "ok") reasons.push("integrity_check=" + out.integrity);
  if (expect.sha256 && out.sha256 !== String(expect.sha256).toUpperCase()) reasons.push("sha mismatch");
  if (expect.docs != null && out.docs !== Number(expect.docs)) reasons.push(`docs ${out.docs}!=${expect.docs}`);
  if (expect.chunks != null && out.chunks !== Number(expect.chunks)) reasons.push(`chunks ${out.chunks}!=${expect.chunks}`);
  out.ok = reasons.length === 0;
  if (!out.ok) out.reasons = reasons;
  return out;
}

// Called at BOOT, before the persona store opens. If a verified incoming corpus is staged, swap it
// into place (clearing any stale WAL/SHM) so the store opens the restored DB fresh.
export function swapIncomingIfPresent(corpusDir, log = () => {}) {
  const incoming = join(corpusDir, "incoming.db");
  const marker = join(corpusDir, "incoming.ok");
  if (!existsSync(incoming) || !existsSync(marker)) return { swapped: false };
  let expectSha = "";
  try { expectSha = String(readFileSync(marker, "utf8")).trim(); } catch {}
  // Re-verify the hash at swap time (belt and suspenders — the file must not have changed since finalize).
  const sha = sha256File(incoming);
  if (expectSha && sha !== expectSha) {
    log(`corpus-restore: incoming hash changed since finalize (${sha} != ${expectSha}) — refusing swap`);
    return { swapped: false, error: "hash mismatch at swap" };
  }
  const target = join(corpusDir, "corpus.db");
  try {
    for (const f of [target, target + "-wal", target + "-shm"]) { try { if (existsSync(f)) rmSync(f); } catch {} }
    renameSync(incoming, target);
    try { rmSync(marker); } catch {}
    log(`corpus-restore: swapped incoming corpus into place (sha ${sha.slice(0, 12)}…, ${statSync(target).size} bytes)`);
    return { swapped: true, sha, bytes: statSync(target).size };
  } catch (e) { log("corpus-restore: swap failed: " + e.message); return { swapped: false, error: e.message }; }
}

// Finalize helper: verify the staged incoming.db and, if good, write the marker with its hash.
export function finalizeIncoming(corpusDir, expect = {}) {
  const incoming = join(corpusDir, "incoming.db");
  const report = verifyCorpusFile(incoming, expect);
  if (report.ok) { try { writeFileSync(join(corpusDir, "incoming.ok"), report.sha256, "utf8"); } catch (e) { return { ...report, ok: false, error: "could not write marker: " + e.message }; } }
  return report;
}
