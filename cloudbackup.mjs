/*
 * Dominion AI — cloud corpus backup (mission ledger L-003).
 *
 * The mission exists because the corpus once lived in exactly one place. After cutover the
 * authoritative corpus sits on the Railway volume; if nothing pushes it off Railway it is back to
 * one copy — the exact failure this mission was created to fix. This module closes that gap:
 *
 *   1. LOCAL SNAPSHOT: periodic online `VACUUM INTO` (persona.backupTo) onto the volume, retention
 *      handled by persona. Survives redeploys (the volume persists) but is still on Railway.
 *   2. OFF-BOX PUSH: the newest snapshot is streamed OFF Railway to one of Fred's machines via the
 *      hands node, in bounded base64 chunks (fs_append) so an ~88MB file crosses the SSE job channel
 *      safely. Target = CLOUD_BACKUP_NODE : CLOUD_BACKUP_DIR (e.g. the laptop's `G:\My Drive\...`,
 *      which is Google Drive — a real third location).
 *
 * When no node/dir is configured or the node is offline, the push is SKIPPED HONESTLY (reported,
 * never faked). The local snapshot still runs, so the volume always carries recent restore points.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";

const isWindowsPath = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
const joinRemote = (dir, name) => (isWindowsPath(dir) ? dir.replace(/[\\/]+$/, "") + "\\" + name : dir.replace(/\/+$/, "") + "/" + name);
const baseName = (p) => String(p).split(/[\\/]/).pop();

export function createCloudBackup({ persona, dispatch, cfg = {}, log = () => {} }) {
  const localDir = cfg.localDir || "";                 // snapshot dir on the volume; "" => persona default
  const node = cfg.node || "";                         // CLOUD_BACKUP_NODE
  const remoteDir = cfg.remoteDir || "";               // CLOUD_BACKUP_DIR on that node (off Railway)
  const chunkBytes = Math.max(Number(cfg.chunkBytes) || 4_000_000, 65536);   // raw bytes/chunk (~5.3MB b64 frame)
  const configured = !!(node && remoteDir && typeof dispatch === "function");

  // Stream one file off-box in chunks. truncate on the first chunk (fresh file), append after.
  async function pushFileOffBox(filePath) {
    if (!configured) return { skipped: true, reason: "off-box push not configured (set CLOUD_BACKUP_NODE + CLOUD_BACKUP_DIR)" };
    let data; try { data = readFileSync(filePath); } catch (e) { return { ok: false, error: "cannot read snapshot: " + e.message }; }
    const remotePath = joinRemote(remoteDir, baseName(filePath));
    let offset = 0, first = true;
    while (offset < data.length) {
      const slice = data.subarray(offset, offset + chunkBytes);
      const r = await dispatch(node, "fs_append", { path: remotePath, content: slice.toString("base64"), truncate: first });
      if (!r || !r.ok) return { ok: false, pushedBytes: offset, offline: !!(r && r.offline), error: (r && (r.reason || r.error)) || "dispatch failed" };
      offset += slice.length; first = false;
    }
    return { ok: true, remotePath, bytes: data.length, node };
  }

  // Pick the newest corpus-*.db snapshot in a dir (the one persona just wrote).
  function newestSnapshot(dir) {
    try {
      const f = readdirSync(dir).filter((n) => /^corpus-.*\.db$/.test(n)).sort().reverse()[0];
      return f ? { path: (isWindowsPath(dir) ? dir.replace(/[\\/]+$/, "") + "\\" : dir.replace(/\/+$/, "") + "/") + f } : null;
    } catch { return null; }
  }

  async function runOnce() {
    // 1) local snapshot on the volume (VACUUM INTO + retention, via persona).
    const snap = persona.backupTo(localDir || undefined);
    if (snap.error) { log("cloud-backup: local snapshot failed: " + snap.error); return { ok: false, stage: "snapshot", error: snap.error }; }
    log(`cloud-backup: snapshot ${snap.path} (${snap.bytes} bytes)`);
    // 2) off-box push of that snapshot.
    const push = await pushFileOffBox(snap.path);
    if (push.skipped) { log("cloud-backup: off-box push skipped — " + push.reason); return { ok: true, snapshot: snap, push }; }
    if (!push.ok) { log("cloud-backup: off-box push failed — " + push.error + (push.offline ? " (node offline)" : "")); return { ok: false, stage: "push", snapshot: snap, push }; }
    log(`cloud-backup: pushed off-box -> ${push.node}:${push.remotePath} (${push.bytes} bytes)`);
    return { ok: true, snapshot: snap, push };
  }

  let timer = null;
  function start(intervalMs) {
    const ms = Math.max(Number(intervalMs) || 0, 60000);
    if (timer) clearInterval(timer);
    // Kick once shortly after boot (not at t=0, let the app settle), then on the interval.
    setTimeout(() => runOnce().catch((e) => log("cloud-backup error: " + e.message)), 30000);
    timer = setInterval(() => runOnce().catch((e) => log("cloud-backup error: " + e.message)), ms);
    log(`cloud-backup: scheduled every ${Math.round(ms / 3600000 * 10) / 10}h  ·  off-box ${configured ? node + ":" + remoteDir : "UNCONFIGURED (local snapshots only)"}`);
    return { intervalMs: ms, configured };
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { runOnce, pushFileOffBox, newestSnapshot, start, stop, configured };
}
