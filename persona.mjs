/*
 * Dominion AI — Persona Forge ("become an expert in Fred") — SQLite-scale edition.
 *
 * A corpus of Fred's OWN material — jokes, maxims, essays, stories, poems, stray thoughts,
 * future plans, favorites/lists, choice AI chats, and scraped pages from his sites — chunked,
 * embedded, and retrievable, plus a distilled structured "Fred Profile" (voice, humor, vocabulary,
 * wit, specialties, reasoning, interests). This is NOT model fine-tuning: it captures voice via
 * retrieval-augmented conditioning (profile + real exemplars injected at answer time), so it updates
 * the instant new files land and needs no retraining.
 *
 * STORAGE: node:sqlite (built into Node 24 — still zero external deps), WAL mode, at dir/corpus.db.
 *   docs / chunks tables + an FTS5 full-text index for lexical candidates + Float32 vector BLOBs
 *   with an in-RAM cosine cache for semantic re-ranking. Built for a MASSIVE corpus (hundreds of
 *   thousands of chunks) that builds over time — no whole-store rewrites, no meaningful caps.
 *   Legacy docs.json/chunks.json stores migrate automatically on first boot.
 * STAGING: multiple inbox folders (the mini-PC's C: corpus inbox + the E: flash-drive staging zone) —
 *   raw files are read ONCE at ingest, so slow USB flash is fine as the bulk holding pen.
 * BACKUP: online `VACUUM INTO` snapshots (default onto the E: flash drive), pruned to the last 5.
 *
 * This store NEVER touches customer DBs or app backups (mini-PC D:).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import http from "node:http";
import https from "node:https";

// Corpus kinds Fred named. "short" kinds are split into individual items (one joke/maxim = one
// chunk); "long" kinds are windowed. Unknown kinds fall back to "other" (windowed).
export const KINDS = ["joke", "maxim", "essay", "story", "poem", "thought", "plan", "favorite", "chat", "web", "other"];
const SHORT_KINDS = new Set(["joke", "maxim", "thought", "favorite"]);
// VOICE kinds = Fred's own composed/conversational writing — the only material that trains the
// profile and gets quoted as exemplars. "other"/"web" = reference KNOWLEDGE (manuals, specs,
// scraped pages): searchable and useful, but never presented as Fred's voice.
const NON_VOICE = ["other", "web"];
const nonVoiceSql = "('" + NON_VOICE.join("','") + "')";

const tokenize = (s) => (String(s || "").toLowerCase().match(/[a-z0-9]{2,}/g) || []);
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const nowIso = () => new Date().toISOString();

// Vocab-grade tokenizer for statVocab: keeps apostrophes ("didn't", not "didn"), drops URLs/domains,
// bare numbers/years, and AI-transcript artifacts — the first whole-corpus distill surfaced
// "chatgpt/user/https/didn" as Fred's "favored words", which was the tooling, not Fred.
const VOCAB_JUNK = new Set(["chatgpt", "gpt", "openai", "user", "assistant", "http", "https", "www", "com"]);
function vocabTokenize(s) {
  const cleaned = String(s || "").toLowerCase().replace(/https?:\/\/\S+|www\.\S+|\S+\.(com|net|org|io)\b/g, " ");
  const raw = cleaned.match(/[a-z][a-z0-9']*[a-z0-9]/g) || [];
  return raw.map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w.length >= 2 && !VOCAB_JUNK.has(w) && !/^\d+$/.test(w));
}

// Split an AI-chat transcript into Fred's turns vs the assistant's. Handles the common export
// shapes: "You said:" / "ChatGPT said:", "**You:**" / "**ChatGPT:**", "User:" / "Assistant:".
// Returns null when no markers are found (can't attribute — caller keeps the text whole).
const USER_MARK = /^\s*(?:\*\*)?(you said:|you:|user:|fred:)(?:\*\*)?\s*$/i;
const AI_MARK = /^\s*(?:\*\*)?(chatgpt said:|chatgpt:|assistant:|ai:|gpt(?:-[\w.]+)? said:)(?:\*\*)?\s*$/i;
const INLINE_USER = /^\s*(?:\*\*)?(?:you said:|you:|user:|fred:)(?:\*\*)?\s+/i;
const INLINE_AI = /^\s*(?:\*\*)?(?:chatgpt said:|chatgpt:|assistant:|ai:)(?:\*\*)?\s+/i;
export function splitChatTranscript(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let sawMarker = false, side = null;   // null until the first marker
  const fred = [];
  for (const line of lines) {
    if (USER_MARK.test(line)) { sawMarker = true; side = "user"; continue; }
    if (AI_MARK.test(line)) { sawMarker = true; side = "ai"; continue; }
    if (INLINE_USER.test(line)) { sawMarker = true; side = "user"; fred.push(line.replace(INLINE_USER, "")); continue; }
    if (INLINE_AI.test(line)) { sawMarker = true; side = "ai"; continue; }
    if (side === "user") fred.push(line);
  }
  if (!sawMarker) return null;
  const out = fred.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length >= 20 ? out : null;   // markers but nothing usable -> treat as unsplittable
}

// Common-word stoplist so statistical vocabulary surfaces Fred's DISTINCTIVE words, not "the/and/of".
const STOPWORDS = new Set(("a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves just also get got like really much many one two get").split(" "));

function cosineF32(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? Math.max(0, dot / d) : 0;
}
const vecToBlob = (v) => Buffer.from(new Float32Array(v).buffer);
const blobToVec = (b) => (b && b.length ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : null);

// ---- chunking ----
// Short kinds: one item per line/blank-separated block. Long kinds: ~1100-char windows with overlap,
// preferring paragraph boundaries.
function chunkText(text, kind) {
  const t = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  if (SHORT_KINDS.has(kind)) {
    let parts = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) parts = t.split(/\n/).map((s) => s.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
    return parts.map((s) => s.slice(0, 1200));
  }
  const MAX = 1100, OVER = 180;
  const paras = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let buf = "";
  for (const p of paras) {
    if (p.length > MAX) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < p.length; i += MAX - OVER) out.push(p.slice(i, i + MAX));
      continue;
    }
    if ((buf + "\n\n" + p).length > MAX) { if (buf) out.push(buf); buf = p; }
    else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf) out.push(buf);
  return out.length ? out : [t.slice(0, MAX)];
}

// ---- file parsers (zero-dep) ----
const decodeEntities = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return _; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|h[1-6]|li|br|tr|section|article|blockquote)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").split("\n").map((l) => l.trim()).join("\n").trim();
}

// Minimal .docx reader: a .docx is a ZIP; pull word/document.xml (DEFLATE via zlib) and strip XML.
// Exported so docwriters.mjs's writer can be round-trip verified against it (E3 test).
export function docxToText(buf) {
  try {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return "";
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdCount = buf.readUInt16LE(eocd + 10);
    let p = cdOffset;
    for (let i = 0; i < cdCount && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (name !== "word/document.xml") continue;
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return "";
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      const xml = method === 8 ? inflateRawSync(raw).toString("utf8") : raw.toString("utf8");
      const text = xml
        .replace(/<w:p[ >]/g, "\n<w:p ").replace(/<w:tab\b[^>]*\/>/g, "\t").replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<[^>]+>/g, "");
      return decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
  } catch {}
  return "";
}

// Minimal PDF text extractor: inflate every stream, then read text-showing operators (Tj / TJ / ')
// from BT..ET blocks. Handles the common case (standard encodings); CID/subset-encoded fonts come
// out as garbage, so the caller sanity-checks the result and skips unreadable files.
function pdfStringDecode(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[c] ?? c))
    .replace(/\\(\d{1,3})/g, (_, o) => { try { return String.fromCharCode(parseInt(o, 8)); } catch { return ""; } });
}
function pdfExtractFromContent(content) {
  const out = [];
  const bt = content.match(/BT[\s\S]*?ET/g) || [content];
  for (const block of bt) {
    // (string) Tj  |  (string) '  |  [ (a) -120 (b) ] TJ
    const re = /\((?:[^()\\]|\\.)*\)\s*(?:Tj|')|\[(?:[^\]\\]|\\.)*\]\s*TJ/g;
    let m;
    while ((m = re.exec(block))) {
      const tok = m[0];
      if (tok.endsWith("TJ")) {
        const inner = tok.slice(tok.indexOf("[") + 1, tok.lastIndexOf("]"));
        const parts = inner.match(/\((?:[^()\\]|\\.)*\)/g) || [];
        out.push(parts.map((p) => pdfStringDecode(p.slice(1, -1))).join(""));
      } else {
        const str = tok.slice(tok.indexOf("(") + 1, tok.lastIndexOf(")"));
        out.push(pdfStringDecode(str));
      }
    }
    out.push("\n");
  }
  return out.join(" ");
}
function pdfToText(buf) {
  try {
    if (buf.slice(0, 5).toString("latin1") !== "%PDF-") return "";
    const raw = buf.toString("latin1");
    const pieces = [];
    const streamRe = /stream\r?\n/g;
    let m;
    while ((m = streamRe.exec(raw))) {
      const start = m.index + m[0].length;
      const end = raw.indexOf("endstream", start);
      if (end < 0) break;
      const data = buf.slice(start, end);
      let text = "";
      try { text = inflateSync(data).toString("latin1"); }
      catch { try { text = inflateRawSync(data).toString("latin1"); } catch { text = data.toString("latin1"); } }
      if (/(Tj|TJ|BT)/.test(text)) pieces.push(pdfExtractFromContent(text));
      streamRe.lastIndex = end;
    }
    let out = pieces.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    // Sanity check: subset/CID-encoded PDFs decode to gibberish — require a readable ratio.
    const printable = (out.match(/[a-zA-Z0-9 .,;:'"!?()\-\n]/g) || []).length;
    if (!out || printable / out.length < 0.8) return "";
    return out;
  } catch { return ""; }
}

// Parse a file buffer to plain text by extension. Returns null for unsupported/unreadable types.
export function parseFileBuffer(name, buf) {
  const ext = extname(name).toLowerCase();
  if ([".txt", ".md", ".markdown", ".text", ".csv", ".log"].includes(ext)) return buf.toString("utf8");
  if ([".html", ".htm"].includes(ext)) return htmlToText(buf.toString("utf8"));
  if (ext === ".json") { try { const j = JSON.parse(buf.toString("utf8")); return typeof j === "string" ? j : JSON.stringify(j, null, 2); } catch { return buf.toString("utf8"); } }
  if (ext === ".docx") { const t = docxToText(buf); return t || null; }
  if (ext === ".pdf") { const t = pdfToText(buf); return t || null; }
  return null;
}

// Guess a corpus kind from a filename / containing subfolder (inbox/<kind>/file.txt).
export function guessKind(pathish) {
  const s = String(pathish || "").toLowerCase();
  for (const k of KINDS) { if (s.includes(k)) return k; }
  if (/poem|verse/.test(s)) return "poem";
  if (/essay|article/.test(s)) return "essay";
  if (/story|fiction|chapter/.test(s)) return "story";
  if (/joke|humou?r/.test(s)) return "joke";
  if (/maxim|aphorism|quote/.test(s)) return "maxim";
  if (/plan|goal|future/.test(s)) return "plan";
  if (/favorite|favourite|list/.test(s)) return "favorite";
  if (/chat|transcript|conversation/.test(s)) return "chat";
  return "other";
}

// ---- web fetch (server-side; follows one redirect; browser UA per the Cloudflare-UA gotcha) ----
export function fetchUrl(url, redirects = 1) {
  return new Promise((resolvePromise) => {
    let u;
    try { u = new URL(url); } catch { return resolvePromise({ error: "bad url" }); }
    if (!/^https?:$/.test(u.protocol)) return resolvePromise({ error: "only http(s) urls" });
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36", accept: "text/html,application/xhtml+xml" }, timeout: 25000 },
      (resp) => {
        const code = resp.statusCode || 0;
        if (code >= 300 && code < 400 && resp.headers.location && redirects > 0) {
          resp.resume();
          const next = new URL(resp.headers.location, u).toString();
          return resolvePromise(fetchUrl(next, redirects - 1));
        }
        let buf = ""; resp.on("data", (d) => { if (buf.length < 4e6) buf += d; }); resp.on("end", () => resolvePromise({ status: code, body: buf, contentType: resp.headers["content-type"] || "" }));
      }
    );
    req.on("error", (e) => resolvePromise({ error: String(e.message) }));
    req.on("timeout", () => { req.destroy(); resolvePromise({ error: "timeout" }); });
    req.end();
  });
}

export function createPersonaStore(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\corpus");
  const inbox = join(dir, "inbox");
  // Staging zone (the E: flash drive by default): a second inbox + the backup target. Missing drive = skipped.
  const staging = opts.staging ? resolve(opts.staging) : "E:\\DominionCorpus";
  const stagingInbox = join(staging, "inbox");
  const embed = typeof opts.embed === "function" ? opts.embed : null;
  const MAX_DOC_TEXT = opts.maxDocText || 2000000;   // 2MB per doc (a whole novel fits)

  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "corpus.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, source TEXT, tags TEXT,
      text TEXT NOT NULL, nchunks INTEGER DEFAULT 0, createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, docId TEXT NOT NULL, kind TEXT NOT NULL, idx INTEGER,
      title TEXT, text TEXT NOT NULL, vec BLOB, createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(docId);
    CREATE INDEX IF NOT EXISTS idx_chunks_kind ON chunks(kind);
    CREATE INDEX IF NOT EXISTS idx_chunks_unembedded ON chunks(id) WHERE vec IS NULL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Multi-tenant persona exclusion (SOW): a doc/chunk is 'shared' (default) or 'owner_only'. Non-owner
  // retrieval, quoting, and listing exclude owner_only. Additive migration (safe on the live corpus).
  const hasCol = (table, col) => { try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; } };
  if (!hasCol("docs", "visibility")) db.exec("ALTER TABLE docs ADD COLUMN visibility TEXT DEFAULT 'shared'");
  if (!hasCol("chunks", "visibility")) db.exec("ALTER TABLE chunks ADD COLUMN visibility TEXT DEFAULT 'shared'");
  let fts = true;
  try { db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='rowid')"); }
  catch { fts = false; }   // FTS5 missing from the sqlite build -> lexical falls back to a scan

  const stmt = {
    insDoc: db.prepare("INSERT INTO docs (id,kind,title,source,tags,text,nchunks,createdAt) VALUES (?,?,?,?,?,?,?,?)"),
    insChunk: db.prepare("INSERT INTO chunks (id,docId,kind,idx,title,text,createdAt) VALUES (?,?,?,?,?,?,?)"),
    dupDoc: db.prepare("SELECT id,kind,title FROM docs WHERE kind = ? AND length(text) = ? LIMIT 20"),
    docById: db.prepare("SELECT * FROM docs WHERE id = ?"),
    delDoc: db.prepare("DELETE FROM docs WHERE id = ?"),
    delChunks: db.prepare("DELETE FROM chunks WHERE docId = ?"),
    chunkIdsByDoc: db.prepare("SELECT rowid, id FROM chunks WHERE docId = ?"),
    setVec: db.prepare("UPDATE chunks SET vec = ? WHERE id = ?"),
    pending: db.prepare("SELECT id, text FROM chunks WHERE vec IS NULL LIMIT ?"),
    counts: db.prepare("SELECT (SELECT COUNT(*) FROM docs) AS docs, (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM chunks WHERE vec IS NOT NULL) AS embedded"),
    byKind: db.prepare("SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    chunkByIds: null, // built per-query (IN list)
  };

  // ---- in-RAM vector cache for cosine re-ranking (Float32Array per chunk) ----
  // ~3KB per chunk at 768 dims: 100k chunks ≈ 300MB. Loaded lazily on first semantic query.
  let vecCache = null;   // Map<chunkId, Float32Array>
  function ensureVecCache() {
    if (vecCache) return vecCache;
    vecCache = new Map();
    const rows = db.prepare("SELECT id, vec FROM chunks WHERE vec IS NOT NULL").all();
    for (const r of rows) { const v = blobToVec(r.vec); if (v) vecCache.set(r.id, v); }
    return vecCache;
  }

  // ---- one-time migration from the legacy JSON store ----
  function migrateFromJson() {
    const docsFile = join(dir, "docs.json");
    if (!existsSync(docsFile)) return 0;
    const already = stmt.counts.get();
    let n = 0;
    if (!already.docs) {
      try {
        const old = JSON.parse(readFileSync(docsFile, "utf8"));
        if (Array.isArray(old)) for (const d of old) { const r = ingestText({ text: d.text, kind: d.kind, title: d.title, source: d.source, tags: d.tags }); if (!r.error && !r.deduped) n++; }
      } catch {}
    }
    for (const f of ["docs.json", "chunks.json"]) { try { renameSync(join(dir, f), join(dir, f + ".migrated")); } catch {} }
    return n;
  }

  function embedChunkAsync(id, text) {
    if (!embed) return;
    Promise.resolve(embed(text)).then((v) => {
      if (Array.isArray(v) && v.length) { const f32 = new Float32Array(v); stmt.setVec.run(vecToBlob(v), id); if (vecCache) vecCache.set(id, f32); }
    }).catch(() => {});
  }

  // Embed a batch of pending chunks SEQUENTIALLY (the continuous background embedder calls this).
  // Returns how many it embedded; 0 = queue empty or embedder down.
  async function embedPending(max = 8) {
    if (!embed) return 0;
    const rows = stmt.pending.all(max);
    let done = 0;
    for (const r of rows) {
      try {
        const v = await embed(r.text);
        if (!Array.isArray(v) || !v.length) break;
        stmt.setVec.run(vecToBlob(v), r.id);
        if (vecCache) vecCache.set(r.id, new Float32Array(v));
        done++;
      } catch { break; }
    }
    return done;
  }

  // Ingest a block of text as one document + its chunks. Dedupes identical documents.
  // AI-chat transcripts get speaker-split: only Fred's turns land as VOICE (kind chat); the full
  // two-sided transcript is kept as knowledge (kind other) so nothing is lost — the assistant's
  // half must never train the profile or be quoted as Fred (the first distill proved why).
  function ingestText({ text, kind, title, source, tags, _noSplit } = {}) {
    const body0 = String(text || "").trim();
    if (body0.length < 2) return { error: "empty text" };
    let body = body0;
    let k = KINDS.includes(kind) ? kind : "other";
    if (k === "chat" && !_noSplit) {
      const fredOnly = splitChatTranscript(body0);
      if (fredOnly) {
        ingestText({ text: body0, kind: "other", title: (title || "chat") + " (full transcript)", source, tags, _noSplit: true });
        body = fredOnly;
      }
    }
    // cheap dedupe: same kind + same length -> compare normalized text
    for (const c of stmt.dupDoc.all(k, body.length)) {
      const full = stmt.docById.get(c.id);
      if (full && norm(full.text) === norm(body)) return { doc: { id: c.id, kind: k, title: c.title }, deduped: true, chunks: 0 };
    }
    const id = randomUUID();
    const docTitle = String(title || "").slice(0, 140) || (body.split("\n")[0] || k).slice(0, 60);
    const pieces = chunkText(body.slice(0, MAX_DOC_TEXT), k);
    const now = nowIso();
    db.exec("BEGIN");
    try {
      stmt.insDoc.run(id, k, docTitle, String(source || "manual").slice(0, 200), JSON.stringify(Array.isArray(tags) ? tags.slice(0, 12).map(String) : []), body.slice(0, MAX_DOC_TEXT), pieces.length, now);
      const chunkIds = [];
      pieces.forEach((piece, idx) => { const cid = randomUUID(); chunkIds.push(cid); stmt.insChunk.run(cid, id, k, idx, docTitle, piece, now); });
      if (fts) {
        const rows = stmt.chunkIdsByDoc.all(id);
        const ins = db.prepare("INSERT INTO chunks_fts (rowid, text) SELECT rowid, text FROM chunks WHERE id = ?");
        for (const r of rows) ins.run(r.id);
      }
      db.exec("COMMIT");
      // embed the first few immediately; the background embedder mops up the rest
      const rows = stmt.chunkIdsByDoc.all(id).slice(0, 3);
      for (const r of rows) { const c = db.prepare("SELECT text FROM chunks WHERE id = ?").get(r.id); if (c) embedChunkAsync(r.id, c.text); }
      return { doc: { id, kind: k, title: docTitle }, chunks: pieces.length };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      return { error: "ingest failed: " + e.message };
    }
  }

  // Scan the inbox folders (corpus inbox + the staging drive). Bounded per call (maxFiles) so the
  // server can run it as a resumable background job. Ingested files move to a sibling processed/
  // folder ON THE SAME DRIVE (fast rename, no cross-drive copy).
  function scanInbox({ maxFiles = 25 } = {}) {
    const results = { ingested: 0, chunks: 0, skipped: [], files: [], remaining: 0 };
    for (const root of [inbox, stagingInbox]) {
      try { mkdirSync(root, { recursive: true }); } catch { continue; }   // staging drive absent -> skip
      const processed = join(root, "..", "processed");
      try { mkdirSync(processed, { recursive: true }); } catch {}
      let entries = [];
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
      const work = [];
      for (const e of entries) {
        const full = join(root, e.name);
        if (e.isDirectory()) {
          const kind = guessKind(e.name);
          let files = []; try { files = readdirSync(full).map((n) => join(full, n)); } catch {}
          for (const f of files) work.push({ f, kind });
        } else work.push({ f: full, kind: guessKind(e.name) });
      }
      for (const { f, kind } of work) {
        if (results.ingested + results.skipped.length >= maxFiles) { results.remaining += 1; continue; }
        try {
          if (!statSync(f).isFile()) continue;
          const buf = readFileSync(f);
          const text = parseFileBuffer(f, buf);
          if (text == null) { results.skipped.push(basename(f) + " (unsupported/unreadable)"); moveProcessed(f, processed, "skipped_"); continue; }
          const r = ingestText({ text, kind, title: basename(f), source: "inbox:" + basename(f) });
          if (r.error) { results.skipped.push(basename(f) + " (" + r.error + ")"); moveProcessed(f, processed, "error_"); continue; }
          results.ingested++; results.chunks += r.chunks || 0;
          results.files.push(basename(f) + " → " + kind + (r.deduped ? " (dupe)" : ""));
          moveProcessed(f, processed, "");
        } catch (err) { results.skipped.push(basename(f) + " (" + err.message + ")"); }
      }
    }
    return results;
  }
  function moveProcessed(f, processedDir, prefix) {
    try { renameSync(f, join(processedDir, prefix + Date.now() + "_" + basename(f))); } catch {}
  }

  const lexScore = (qTokens, text) => {
    const t = new Set(tokenize(text)); if (!t.size || !qTokens.length) return 0;
    let hits = 0; for (const w of qTokens) if (t.has(w)) hits++;
    return hits / qTokens.length;
  };

  // Hybrid retrieval at scale: FTS5 bm25 candidates (lexical) ∪ top-cosine candidates (semantic,
  // via the RAM vec cache) -> re-rank the union with 0.45*lex + 0.55*cos. Degrades gracefully:
  // no FTS -> bounded scan; no embedder/vectors -> pure lexical.
  async function retrieve(query, { limit = 6, kind = "", minScore = 0.08, voiceOnly = false, sharedOnly = false } = {}) {
    const q = tokenize(query);
    let qvec = null;
    if (embed && query) { try { const v = await embed(String(query).slice(0, 2000)); if (Array.isArray(v) && v.length) qvec = new Float32Array(v); } catch {} }
    const voiceClause = voiceOnly ? ` AND c.kind NOT IN ${nonVoiceSql} ` : " ";
    const voiceClauseBare = voiceOnly ? ` kind NOT IN ${nonVoiceSql} ` : "";

    const candidates = new Map();   // id -> row
    if (fts && q.length) {
      const match = q.map((w) => '"' + w.replace(/"/g, "") + '"').join(" OR ");
      try {
        const rows = db.prepare(
          "SELECT c.id, c.kind, c.title, c.text FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ? " +
          (kind ? "AND c.kind = ? " : "") + voiceClause + "ORDER BY bm25(chunks_fts) LIMIT 200"
        ).all(...(kind ? [match, kind] : [match]));
        for (const r of rows) candidates.set(r.id, r);
      } catch {}
    } else if (q.length) {
      const where = [kind ? "kind = ?" : "", voiceClauseBare].filter(Boolean).join(" AND ");
      const rows = db.prepare("SELECT id, kind, title, text FROM chunks " + (where ? "WHERE " + where + " " : "") + "LIMIT 5000").all(...(kind ? [kind] : []));
      for (const r of rows) { if (lexScore(q, r.text) > 0) candidates.set(r.id, r); }
    }
    if (qvec) {
      const cache = ensureVecCache();
      const top = [];
      for (const [id, v] of cache) {
        const s = cosineF32(qvec, v);
        if (top.length < 150) { top.push({ id, s }); if (top.length === 150) top.sort((a, b) => a.s - b.s); }
        else if (s > top[0].s) { top[0] = { id, s }; top.sort((a, b) => a.s - b.s); }
      }
      const missing = top.map((t) => t.id).filter((id) => !candidates.has(id));
      for (let i = 0; i < missing.length; i += 100) {
        const ids = missing.slice(i, i + 100);
        const extra = (kind ? " AND kind = ?" : "") + (voiceOnly ? ` AND kind NOT IN ${nonVoiceSql}` : "");
        const rows = db.prepare(`SELECT id, kind, title, text FROM chunks WHERE id IN (${ids.map(() => "?").join(",")})` + extra).all(...(kind ? [...ids, kind] : ids));
        for (const r of rows) candidates.set(r.id, r);
      }
    }
    // Non-owner exclusion: drop any candidate chunk whose doc is owner_only (Fred's excluded subjects).
    // One small query over the assembled candidate set covers the FTS, lexical, AND vector paths.
    if (sharedOnly && candidates.size) {
      const ids = [...candidates.keys()];
      for (let i = 0; i < ids.length; i += 300) {
        const slice = ids.slice(i, i + 300);
        try { for (const r of db.prepare(`SELECT id FROM chunks WHERE visibility='owner_only' AND id IN (${slice.map(() => "?").join(",")})`).all(...slice)) candidates.delete(r.id); } catch {}
      }
    }
    if (!candidates.size) return [];
    const cache = qvec ? ensureVecCache() : null;
    return [...candidates.values()]
      .map((r) => {
        const lex = lexScore(q, r.text);
        const v = cache ? cache.get(r.id) : null;
        const cos = (qvec && v) ? cosineF32(qvec, v) : 0;
        const s = (qvec && v) ? 0.45 * lex + 0.55 * cos : lex;
        return { r, s };
      })
      .filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, limit)
      .map(({ r, s }) => ({ id: r.id, kind: r.kind, title: r.title, text: r.text, score: Number(s.toFixed(3)) }));
  }

  // Distinctive vocabulary + recurring phrases across the WHOLE corpus (no LLM, no token limit).
  function statVocab({ topWords = 50, topPhrases = 30, voiceOnly = true } = {}) {
    const wc = new Map(), pc = new Map();
    const it = db.prepare("SELECT text FROM docs" + (voiceOnly ? ` WHERE kind NOT IN ${nonVoiceSql}` : ""));
    for (const d of it.iterate()) {
      const toks = vocabTokenize(d.text);
      for (const w of toks) { if (w.length >= 4 && !STOPWORDS.has(w)) wc.set(w, (wc.get(w) || 0) + 1); }
      for (let i = 0; i < toks.length - 1; i++) {
        const a = toks[i], b = toks[i + 1];
        if (!(STOPWORDS.has(a) && STOPWORDS.has(b))) { const bg = a + " " + b; pc.set(bg, (pc.get(bg) || 0) + 1); }
        if (i < toks.length - 2) { const c = toks[i + 2]; if (!(STOPWORDS.has(a) && STOPWORDS.has(c))) { const tg = a + " " + b + " " + c; pc.set(tg, (pc.get(tg) || 0) + 1); } }
      }
    }
    const words = [...wc.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, topWords).map(([w, n]) => ({ w, n }));
    const phrases = [...pc.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, topPhrases).map(([p, n]) => ({ p, n }));
    return { words, phrases };
  }

  // Build context-window-sized text batches over the corpus for map-reduce distillation.
  // Past the budget, chunks are stratified evenly (capped runs report digested X of Y).
  // opts.kinds restricts to a kind whitelist — used by the dedicated CONVICTIONS pass, because
  // majority-voting beliefs across a volume-skewed corpus buries them (200 poems outvoted the
  // Westminster-confessional essays in distill v3; convictions come from ASSERTION kinds only).
  function buildBatches({ batchChars = 90000, maxBatches = 60, voiceOnly = true, kinds = null } = {}) {
    const kindFilter = Array.isArray(kinds) && kinds.length
      ? ` WHERE kind IN ('${kinds.map((k) => String(k).replace(/'/g, "")).join("','")}')`
      : (voiceOnly ? ` WHERE kind NOT IN ${nonVoiceSql}` : "");
    const totalChunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks" + kindFilter).get()).n;
    const totalChars = (db.prepare("SELECT COALESCE(SUM(length(text)),0) AS n FROM chunks" + kindFilter).get()).n;
    const budget = batchChars * maxBatches;
    const capped = totalChars > budget;
    const keepEvery = capped ? Math.ceil(totalChars / budget) : 1;
    const batches = [];
    let buf = "", bufN = 0, i = 0, pool = 0;
    for (const c of db.prepare("SELECT kind, text FROM chunks" + kindFilter + " ORDER BY rowid").iterate()) {
      if (i++ % keepEvery !== 0) continue;
      pool++;
      const piece = `[${c.kind}] ${c.text}`;
      if (bufN + piece.length > batchChars && buf) { batches.push(buf); buf = ""; bufN = 0; if (batches.length >= maxBatches) break; }
      buf += (buf ? "\n\n---\n\n" : "") + piece; bufN += piece.length;
    }
    if (buf && batches.length < maxBatches) batches.push(buf);
    return { batches, capped, totalChars, coveredChars: batches.reduce((n, b) => n + b.length, 0), poolChunks: pool, totalChunks };
  }

  // A diverse sample across kinds (kept for quick previews).
  function sampleForProfile({ perKind = 6, maxChars = 14000 } = {}) {
    const out = []; let total = 0;
    for (const k of KINDS) {
      const rows = db.prepare("SELECT kind, title, text FROM chunks WHERE kind = ? ORDER BY rowid LIMIT ?").all(k, perKind);
      for (const c of rows) { const t = c.text.slice(0, 700); if (total + t.length > maxChars) return out; out.push({ kind: c.kind, title: c.title, text: t }); total += t.length; }
    }
    return out;
  }

  function getProfile() {
    const r = stmt.metaGet.get("profile");
    if (!r) return null;
    try { return JSON.parse(r.value); } catch { return null; }
  }
  function setProfile(p) {
    const counts = stmt.counts.get();
    const profile = { ...p, updatedAt: nowIso(), corpusDocs: counts.docs, corpusChunks: counts.chunks };
    stmt.metaSet.run("profile", JSON.stringify(profile));
    return profile;
  }

  // Boot-time warmer: load the in-RAM vector cache eagerly so the first semantic retrieve (e.g. the
  // first As-Fred query after a restart) doesn't pay the full whole-corpus vector load inside an
  // interactive request. Pure wrapper around the existing lazy loader; returns the cached count.
  function warmCache() { return ensureVecCache().size; }

  // The block injected into "As Fred" prompts: the rendered profile + retrieved exemplars.
  async function personaBlock(query, { exemplars = 4, sharedOnly = false } = {}) {   // 4×400 chars: prefill is the latency bottleneck on the CPU box
    const profile = getProfile();
    const parts = [];
    // Render LIVE from facets (not the stored systemBlock) so hard-coded voice laws in
    // renderFacets reach every answer immediately — stored blocks go stale between distills.
    if (profile && profile.facets && Object.keys(profile.facets).length) {
      parts.push(renderFacets(profile.facets) + (profile.facets.summary ? "\n- In short: " + profile.facets.summary : ""));
    } else if (profile && profile.systemBlock) parts.push(profile.systemBlock);
    // sharedOnly (non-owners): exclude Fred's owner_only subjects from the quoted exemplars.
    const ex = await retrieve(query || "", { limit: exemplars, voiceOnly: true, sharedOnly });   // never quote reference material as Fred's voice
    if (ex.length) parts.push("Real excerpts of Fred's own writing, retrieved for THIS question. They carry two things: his voice (echo the rhythm and word-choice; don't quote verbatim unless asked) and his BELIEFS — if these excerpts answer or bear on the question, Fred's position in them IS the answer; never substitute a generic or contrary position for his stated one:\n" + ex.map((e) => `— [${e.kind}] ${e.text.slice(0, 400)}`).join("\n\n"));
    return { block: parts.join("\n\n"), exemplars: ex, hasProfile: !!profile };
  }

  function list({ kind = "", q = "", limit = 200, sharedOnly = false } = {}) {
    let sql = "SELECT id, kind, title, source, tags, nchunks, length(text) AS chars, createdAt, visibility FROM docs";
    const where = [], args = [];
    if (kind) { where.push("kind = ?"); args.push(kind); }
    if (q) { where.push("(title LIKE ? OR text LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
    if (sharedOnly) where.push("(visibility IS NULL OR visibility = 'shared')");   // non-owners: hide owner_only titles too
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY createdAt DESC LIMIT ?"; args.push(Math.min(limit, 500));
    return db.prepare(sql).all(...args).map((d) => ({ id: d.id, kind: d.kind, title: d.title, source: d.source, tags: JSON.parse(d.tags || "[]"), chars: d.chars, chunks: d.nchunks, createdAt: d.createdAt, visibility: d.visibility || "shared" }));
  }
  // Owner controls: mark a doc (and its chunks) shared|owner_only. owner_only = never quoted/shown to others.
  function setVisibility(docId, visibility) {
    const v = visibility === "owner_only" ? "owner_only" : "shared";
    const a = db.prepare("UPDATE docs SET visibility=? WHERE id=?").run(v, docId);
    db.prepare("UPDATE chunks SET visibility=? WHERE docId=?").run(v, docId);
    return { ok: !!a.changes, visibility: v };
  }
  // The three excluded subjects (Fred, 2026-07-16). A prefilter of trigger words narrows which docs
  // get the (slower) local-model read; anything a word hits is classified. Euphemism-safe: the model
  // decides, the words only widen the net.
  const EXCLUDE_SUBJECTS = [
    { key: "sexual_confession", label: "the author's own sexual sin or confession", words: /\b(lust|sexual|sin|confess|adulter|porn|impure|temptation|fornicat|masturbat)\b/i },
    { key: "negative_about_kids", label: "anything negative the author said about his own children/kids", words: /\b(son|daughter|kid|child|children|boy|girl)\b/i },
    { key: "financial_hardship", label: "the author's personal financial hardship", words: /\b(broke|debt|bankrupt|afford|money|financ|bills?|poverty|paycheck|foreclos|evict|struggl)\b/i },
  ];
  // Owner-triggered sensitivity scan. `classify(text)` MUST run on the LOCAL model (this content never
  // egresses). Returns {match:boolean}. Conservative: on error/uncertain the caller marks owner_only.
  async function scanSensitivity({ classify, onProgress } = {}) {
    if (typeof classify !== "function") return { error: "no local classifier provided" };
    const docs = db.prepare("SELECT id, kind, title, text FROM docs").all();
    let scanned = 0, flagged = 0;
    for (const d of docs) {
      scanned++;
      const blob = (d.title || "") + "\n" + (d.text || "");
      const hit = EXCLUDE_SUBJECTS.filter((s) => s.words.test(blob));
      if (!hit.length) { if (onProgress) onProgress({ scanned, total: docs.length, flagged }); continue; }
      let match = false;
      try { const r = await classify(blob.slice(0, 6000), hit.map((h) => h.label)); match = !!(r && r.match); }
      catch { match = true; }   // conservative: if the read fails, exclude
      if (match) { setVisibility(d.id, "owner_only"); flagged++; }
      if (onProgress) onProgress({ scanned, total: docs.length, flagged });
    }
    return { scanned, flagged };
  }
  function getDoc(id) { return stmt.docById.get(id) || null; }
  function removeDoc(id) {
    const rows = stmt.chunkIdsByDoc.all(id);
    db.exec("BEGIN");
    try {
      if (fts) { const del = db.prepare("INSERT INTO chunks_fts (chunks_fts, rowid, text) SELECT 'delete', rowid, text FROM chunks WHERE id = ?"); for (const r of rows) del.run(r.id); }
      stmt.delChunks.run(id);
      const res = stmt.delDoc.run(id);
      db.exec("COMMIT");
      if (vecCache) for (const r of rows) vecCache.delete(r.id);
      return { removed: Number(res.changes) };
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} return { removed: 0, error: e.message }; }
  }

  // One-time migration for chats ingested BEFORE speaker-splitting existed: each chat doc with
  // detectable markers is retagged to knowledge (kind other, incl. its chunks) and Fred's turns
  // are re-ingested fresh as the voice doc. Idempotent: split docs carry a splitDone tag.
  function reprocessChats() {
    const out = { checked: 0, split: 0, unsplittable: 0 };
    const docsToCheck = db.prepare("SELECT id, title, source, tags, text FROM docs WHERE kind = 'chat'").all();
    for (const d of docsToCheck) {
      out.checked++;
      const tags = JSON.parse(d.tags || "[]");
      if (tags.includes("splitDone")) continue;
      const fredOnly = splitChatTranscript(d.text);
      if (!fredOnly) { out.unsplittable++; continue; }
      // retag the full transcript (and its chunks) to knowledge
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE docs SET kind = 'other', title = title || ' (full transcript)' WHERE id = ?").run(d.id);
        db.prepare("UPDATE chunks SET kind = 'other' WHERE docId = ?").run(d.id);
        db.exec("COMMIT");
      } catch (e) { try { db.exec("ROLLBACK"); } catch {} continue; }
      const r = ingestText({ text: fredOnly, kind: "chat", title: d.title, source: d.source, tags: [...tags, "splitDone"], _noSplit: true });
      if (!r.error) out.split++;
    }
    if (out.split) vecCache = null;   // kinds moved; rebuild the cache lazily
    return out;
  }

  // Online backup: VACUUM INTO a timestamped snapshot (default target = the staging/flash drive).
  // Prunes to the newest 5. No-op (with reason) if the target drive is absent.
  function backupTo(destDir) {
    const target = destDir || join(staging, "backups");
    try { mkdirSync(target, { recursive: true }); } catch (e) { return { error: "backup target unavailable: " + e.message }; }
    const name = "corpus-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".db";
    const dest = join(target, name);
    try {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      const old = readdirSync(target).filter((f) => /^corpus-.*\.db$/.test(f)).sort().reverse().slice(5);
      for (const f of old) { try { unlinkSync(join(target, f)); } catch {} }
      return { ok: true, path: dest, bytes: statSync(dest).size };
    } catch (e) { return { error: "backup failed: " + e.message }; }
  }

  function stats() {
    const c = stmt.counts.get();
    const byKind = {};
    for (const r of stmt.byKind.all()) byKind[r.kind] = r.n;
    const profile = getProfile();
    let dbBytes = 0; try { dbBytes = statSync(join(dir, "corpus.db")).size; } catch {}
    return {
      docs: c.docs, chunks: c.chunks, embedded: c.embedded, pendingEmbeds: c.chunks - c.embedded,
      byKind, vectors: !!embed, fts, dbBytes,
      profile: profile ? { updatedAt: profile.updatedAt, corpusDocs: profile.corpusDocs, corpusChunks: profile.corpusChunks, method: profile.method } : null,
    };
  }

  const migrated = migrateFromJson();

  return { ingestText, scanInbox, retrieve, sampleForProfile, statVocab, buildBatches, personaBlock, getProfile, setProfile, list, getDoc, removeDoc, setVisibility, scanSensitivity, EXCLUDE_SUBJECTS, reprocessChats, embedPending, backfillEmbeddings: embedPending, warmCache, backupTo, stats, KINDS, dir, inbox, stagingInbox, staging, migrated, fts };
}

// Render the structured facets into a system-prompt block (fallback when no pre-rendered systemBlock).
// The substance/delivery law is HARD-CODED (Fred, 2026-07-03): he never answers WITH poetry —
// substance is always logic, doctrine, history, facts; the poetic register is a delivery device
// applied on top for impact and memorability. Every profile render carries it, every distill or not.
export function renderFacets(f = {}) {
  const lines = [
    "You are writing and thinking AS Frederick (Fred) Wolfe — in his own voice, not as a generic assistant.",
    "FRED'S LAW OF SUBSTANCE AND DELIVERY (his own words, inviolable): he never answers questions with poetry — ever. He answers with grounded, sharp logic, doctrine, history, and facts; SOMETIMES delivered in a poetic way to increase impact, remembrance, and beauty. Substance first, always; poetry is a manner, never the matter. Often it is both — that is what makes his voice unique.",
    "Fred's profile:",
  ];
  const add = (label, v) => { if (v && (Array.isArray(v) ? v.length : String(v).trim())) lines.push(`- ${label}: ${Array.isArray(v) ? v.join("; ") : v}`); };
  add("Voice & style", f.voice_style);
  add("Sense of humor", f.humor);
  add("Nuanced vocabulary & favored words", f.vocabulary);
  add("Wit & rhetorical moves", f.wit);
  add("Specialties & expertise", f.specialties);
  add("Reasoning & intelligence", f.reasoning);
  add("Interests, habits, hobbies, life work", f.interests);
  add("CORE CONVICTIONS & WORLDVIEW — these govern the CONTENT of every answer, not just its style", f.convictions);
  add("Favored words (use naturally, don't force)", f.favored_words);
  add("Recurring phrases", f.favored_phrases);
  add("Hard do-nots", f.avoid);
  return lines.join("\n");
}
