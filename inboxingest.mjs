/*
 * Dominion AI — remote inbox ingest (mission ledger L-009).
 *
 * Before cutover, Fred dumps files into `E:\DominionCorpus\inbox` on the mini-PC and the box ingests
 * them. After the brain moves to Railway, the cloud can't see that folder. This closes the gap
 * WITHOUT changing Fred's workflow: he keeps dropping files on the box; the cloud orchestrator reaches
 * them through the on-box hands node (fs_list + fs_read) and ingests each into the persona corpus.
 *
 * Deliberately conservative for now:
 *   - Reads text-ish files (.txt/.md/.markdown/.html/.htm/.json/.csv/.log). Binary formats
 *     (.docx/.pdf/…) are REPORTED as skipped ("needs local extraction"), never ingested as garbage.
 *   - Never deletes anything on the box (no remote delete). Re-runs are safe: persona.ingestText
 *     dedups by content, so an already-ingested file comes back `deduped`.
 *   - Honest offline: if the node isn't connected, returns { ok:false, offline:true } and ingests
 *     nothing.
 */
const TEXT_EXT = new Set(["txt", "md", "markdown", "html", "htm", "json", "csv", "log", "text"]);
const extOf = (name) => { const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ""; };

export function createInboxIngest({ persona, dispatch, cfg = {}, htmlToText = null, log = () => {} }) {
  const node = cfg.node || "";
  const dir = cfg.dir || "";
  const maxFiles = Math.max(Number(cfg.maxFiles) || 100, 1);
  const configured = !!(node && dir && typeof dispatch === "function");

  async function ingestRemoteInbox({ kind = "other" } = {}) {
    if (!configured) return { ok: false, error: "remote ingest not configured (set CLOUD_INGEST_NODE + CLOUD_INGEST_DIR)" };
    const listed = await dispatch(node, "fs_list", { path: dir });
    if (!listed || !listed.ok) return { ok: false, offline: !!(listed && listed.offline), error: (listed && (listed.reason || listed.error)) || "could not list the inbox" };
    const files = (listed.entries || []).filter((e) => e.type === "file").slice(0, maxFiles);
    const result = { ok: true, node, dir, seen: files.length, ingested: 0, deduped: 0, skipped: [], errors: [] };
    for (const f of files) {
      const ext = extOf(f.name);
      if (!TEXT_EXT.has(ext)) { result.skipped.push({ name: f.name, reason: "binary/needs local extraction (." + (ext || "?") + ")" }); continue; }
      const path = (/\\/.test(dir) ? dir.replace(/[\\/]+$/, "") + "\\" : dir.replace(/\/+$/, "") + "/") + f.name;
      const read = await dispatch(node, "fs_read", { path, base64: true });
      if (!read || !read.ok) { result.errors.push({ name: f.name, error: (read && (read.reason || read.error)) || "read failed" }); continue; }
      let text = "";
      try { text = Buffer.from(read.base64 || "", "base64").toString("utf8"); } catch { result.errors.push({ name: f.name, error: "decode failed" }); continue; }
      if (/\.html?$/.test(f.name) && typeof htmlToText === "function") text = htmlToText(text);
      if (!text || text.trim().length < 20) { result.skipped.push({ name: f.name, reason: "empty/too short" }); continue; }
      const ing = persona.ingestText({ text, kind, title: f.name, source: "remote-inbox:" + node });
      if (ing.error) { result.errors.push({ name: f.name, error: ing.error }); continue; }
      if (ing.deduped) result.deduped++; else result.ingested++;
    }
    log(`inbox-ingest: ${node}:${dir} -> seen ${result.seen}, ingested ${result.ingested}, deduped ${result.deduped}, skipped ${result.skipped.length}, errors ${result.errors.length}`);
    return result;
  }

  return { ingestRemoteInbox, configured };
}
