/*
 * Dominion AI — Persona Forge ("become an expert in Fred").
 *
 * A corpus of Fred's OWN material — jokes, maxims, essays, stories, poems, stray thoughts,
 * future plans, favorites/lists, choice AI chats, and scraped pages from his sites — chunked,
 * embedded, and retrievable, plus a distilled structured "Fred Profile" (voice, humor, vocabulary,
 * wit, specialties, reasoning, interests). This is NOT model fine-tuning: it captures voice via
 * retrieval-augmented conditioning (profile + real exemplars injected at answer time), so it updates
 * the instant new files land and needs no retraining. Runs on the mini-PC; zero external deps.
 *
 * Retrieval mirrors memory.mjs: hybrid lexical+cosine when an embedder is present, pure lexical
 * otherwise — it never blocks on embeddings. This store NEVER touches customer DBs or app backups.
 *
 * Persistence: docs.json (full source text + metadata) + chunks.json (chunks + server-side vectors)
 * + profile.json (the distilled Fred Profile). Vectors never leave the server.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import http from "node:http";
import https from "node:https";

// Corpus kinds Fred named. "short" kinds are split into individual items (one joke/maxim = one
// chunk); "long" kinds are windowed. Unknown kinds fall back to "other" (windowed).
export const KINDS = ["joke", "maxim", "essay", "story", "poem", "thought", "plan", "favorite", "chat", "web", "other"];
const SHORT_KINDS = new Set(["joke", "maxim", "thought", "favorite"]);

const tokenize = (s) => (String(s || "").toLowerCase().match(/[a-z0-9]{2,}/g) || []);
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const nowIso = () => new Date().toISOString();

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? Math.max(0, dot / d) : 0;
}
const roundVec = (v) => (Array.isArray(v) ? v.map((x) => Math.round(x * 1e4) / 1e4) : null);

// ---- chunking ----
// Short kinds: one item per line/blank-separated block. Long kinds: ~1100-char windows with overlap,
// preferring paragraph boundaries (and blank-line stanza boundaries for poems).
function chunkText(text, kind) {
  const t = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  if (SHORT_KINDS.has(kind)) {
    // Split on blank lines first; if it's really one-per-line (a list), split on newlines.
    let parts = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) parts = t.split(/\n/).map((s) => s.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
    return parts.map((s) => s.slice(0, 1200));
  }
  const MAX = 1100, OVER = 180;
  const paras = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let buf = "";
  for (const p of paras) {
    if (p.length > MAX) {                         // a giant paragraph: hard-window it with overlap
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
// Supports STORED (0) and DEFLATE (8) entries. Returns "" if it can't parse (caller skips the file).
function docxToText(buf) {
  try {
    // Find the "word/document.xml" local file header via the End-of-Central-Directory + central dir.
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
      // Read the local header to find where the data starts (its name/extra lengths differ).
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return "";
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      const xml = method === 8 ? inflateRawSync(raw).toString("utf8") : raw.toString("utf8");
      // Paragraphs = <w:p>; tabs/breaks -> spaces; text lives in <w:t>.
      const text = xml
        .replace(/<w:p[ >]/g, "\n<w:p ").replace(/<w:tab\b[^>]*\/>/g, "\t").replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<[^>]+>/g, "");
      return decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
  } catch {}
  return "";
}

// Parse a file buffer to plain text by extension. Returns null for unsupported types.
export function parseFileBuffer(name, buf) {
  const ext = extname(name).toLowerCase();
  if ([".txt", ".md", ".markdown", ".text", ".csv", ".log"].includes(ext)) return buf.toString("utf8");
  if ([".html", ".htm"].includes(ext)) return htmlToText(buf.toString("utf8"));
  if (ext === ".json") { try { const j = JSON.parse(buf.toString("utf8")); return typeof j === "string" ? j : JSON.stringify(j, null, 2); } catch { return buf.toString("utf8"); } }
  if (ext === ".docx") { const t = docxToText(buf); return t || null; }
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
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: "bad url" }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ error: "only http(s) urls" });
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36", accept: "text/html,application/xhtml+xml" }, timeout: 25000 },
      (resp) => {
        const code = resp.statusCode || 0;
        if (code >= 300 && code < 400 && resp.headers.location && redirects > 0) {
          resp.resume();
          const next = new URL(resp.headers.location, u).toString();
          return resolve(fetchUrl(next, redirects - 1));
        }
        let buf = ""; resp.on("data", (d) => { if (buf.length < 4e6) buf += d; }); resp.on("end", () => resolve({ status: code, body: buf, contentType: resp.headers["content-type"] || "" }));
      }
    );
    req.on("error", (e) => resolve({ error: String(e.message) }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.end();
  });
}

export function createPersonaStore(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\corpus");
  const inbox = join(dir, "inbox");
  const processed = join(dir, "processed");
  const docsFile = join(dir, "docs.json");
  const chunksFile = join(dir, "chunks.json");
  const profileFile = join(dir, "profile.json");
  const embed = typeof opts.embed === "function" ? opts.embed : null;
  const MAX_DOCS = opts.maxDocs || 5000;
  const MAX_CHUNKS = opts.maxChunks || 40000;
  let docs = [], chunks = [], profile = null;

  function loadJson(file, dflt) { try { if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")); } catch {} return dflt; }
  function persist() {
    try {
      mkdirSync(dir, { recursive: true });
      const w = (f, o) => { const tmp = f + ".tmp"; writeFileSync(tmp, JSON.stringify(o)); renameSync(tmp, f); };
      w(docsFile, docs); w(chunksFile, chunks); if (profile) w(profileFile, profile);
    } catch {}
  }
  docs = loadJson(docsFile, []); if (!Array.isArray(docs)) docs = [];
  chunks = loadJson(chunksFile, []); if (!Array.isArray(chunks)) chunks = [];
  profile = loadJson(profileFile, null);

  function embedChunk(c) {
    if (!embed || c.vec) return;
    Promise.resolve(embed(c.text)).then((v) => { if (Array.isArray(v) && v.length) { c.vec = roundVec(v); persist(); } }).catch(() => {});
  }
  async function backfillEmbeddings(max = 200) {
    if (!embed) return 0;
    let done = 0;
    for (const c of chunks) {
      if (done >= max) break;
      if (c.vec) continue;
      try { const v = await embed(c.text); if (Array.isArray(v) && v.length) { c.vec = roundVec(v); done++; } else break; } catch { break; }
    }
    if (done) persist();
    return done;
  }

  // Ingest a block of text as one document + its chunks. Dedupes identical documents.
  function ingestText({ text, kind, title, source, tags } = {}) {
    const body = String(text || "").trim();
    if (body.length < 2) return { error: "empty text" };
    const k = KINDS.includes(kind) ? kind : "other";
    const dup = docs.find((d) => d.kind === k && norm(d.text) === norm(body));
    if (dup) return { doc: dup, deduped: true, chunks: chunks.filter((c) => c.docId === dup.id).length };
    const id = randomUUID();
    const doc = {
      id, kind: k,
      title: String(title || "").slice(0, 140) || (body.split("\n")[0] || k).slice(0, 60),
      source: String(source || "manual").slice(0, 200),
      text: body.slice(0, 200000),
      tags: Array.isArray(tags) ? tags.slice(0, 12).map(String) : [],
      createdAt: nowIso(),
    };
    docs.push(doc);
    if (docs.length > MAX_DOCS) { const drop = docs.shift(); chunks = chunks.filter((c) => c.docId !== drop.id); }
    const pieces = chunkText(doc.text, k);
    const made = [];
    pieces.forEach((piece, idx) => {
      const c = { id: randomUUID(), docId: id, kind: k, idx, text: piece, title: doc.title, createdAt: doc.createdAt, vec: null };
      chunks.push(c); made.push(c);
    });
    if (chunks.length > MAX_CHUNKS) chunks = chunks.slice(-MAX_CHUNKS);
    persist();
    made.forEach(embedChunk);
    return { doc, chunks: made.length };
  }

  // Scan the inbox folder: parse every readable file, ingest, then move it to processed/.
  function scanInbox() {
    mkdirSync(inbox, { recursive: true }); mkdirSync(processed, { recursive: true });
    const results = { ingested: 0, chunks: 0, skipped: [], files: [] };
    let entries = [];
    try { entries = readdirSync(inbox, { withFileTypes: true }); } catch { return results; }
    for (const e of entries) {
      const full = join(inbox, e.name);
      let kind = "other";
      let files = [];
      if (e.isDirectory()) { kind = guessKind(e.name); try { files = readdirSync(full).map((n) => join(full, n)); } catch {} }
      else files = [full];
      for (const f of files) {
        try {
          if (!statSync(f).isFile()) continue;
          const buf = readFileSync(f);
          const text = parseFileBuffer(f, buf);
          if (text == null) { results.skipped.push(basename(f) + " (unsupported type)"); continue; }
          const k = e.isDirectory() ? kind : guessKind(f);
          const r = ingestText({ text, kind: k, title: basename(f), source: "inbox:" + basename(f) });
          if (r.error) { results.skipped.push(basename(f) + " (" + r.error + ")"); continue; }
          results.ingested++; results.chunks += r.chunks || 0; results.files.push(basename(f) + " → " + k + (r.deduped ? " (dupe)" : ""));
          try { renameSync(f, join(processed, Date.now() + "_" + basename(f))); } catch {}
        } catch (err) { results.skipped.push(basename(f) + " (" + err.message + ")"); }
      }
    }
    return results;
  }

  const lexScore = (qTokens, text) => {
    const t = new Set(tokenize(text)); if (!t.size || !qTokens.length) return 0;
    let hits = 0; for (const w of qTokens) if (t.has(w)) hits++;
    return hits / qTokens.length;
  };

  // Hybrid retrieval over chunks -> exemplar list. Optional kind filter. Degrades to lexical.
  async function retrieve(query, { limit = 6, kind = "", minScore = 0.08 } = {}) {
    const pool = kind ? chunks.filter((c) => c.kind === kind) : chunks;
    if (!pool.length) return [];
    const q = tokenize(query);
    let qvec = null;
    if (embed && query) { try { const v = await embed(String(query).slice(0, 2000)); if (Array.isArray(v) && v.length) qvec = v; } catch {} }
    if (!q.length && !qvec) return pool.slice(0, limit).map((c) => ({ id: c.id, kind: c.kind, title: c.title, text: c.text, score: 0 }));
    return pool
      .map((c) => { const lex = lexScore(q, c.text); const cos = (qvec && c.vec) ? cosine(qvec, c.vec) : 0; const s = (qvec && c.vec) ? 0.45 * lex + 0.55 * cos : lex; return { c, s }; })
      .filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, limit)
      .map(({ c, s }) => ({ id: c.id, kind: c.kind, title: c.title, text: c.text, score: Number(s.toFixed(3)) }));
  }

  // A diverse sample across kinds for profile distillation (round-robin so no single kind dominates).
  function sampleForProfile({ perKind = 6, maxChars = 14000 } = {}) {
    const byKind = {};
    for (const c of chunks) { (byKind[c.kind] ||= []).push(c); }
    const picks = [];
    for (const k of Object.keys(byKind)) {
      const arr = byKind[k];
      const step = Math.max(1, Math.floor(arr.length / perKind));
      for (let i = 0, taken = 0; i < arr.length && taken < perKind; i += step, taken++) picks.push(arr[i]);
    }
    let total = 0; const out = [];
    for (const c of picks) { const t = c.text.slice(0, 700); if (total + t.length > maxChars) break; out.push({ kind: c.kind, title: c.title, text: t }); total += t.length; }
    return out;
  }

  function getProfile() { return profile; }
  function setProfile(p) {
    profile = { ...p, updatedAt: nowIso(), corpusDocs: docs.length, corpusChunks: chunks.length };
    persist();
    return profile;
  }

  // The block injected into "As Fred" prompts: the rendered profile + retrieved exemplars.
  async function personaBlock(query, { exemplars = 6 } = {}) {
    const parts = [];
    if (profile && profile.systemBlock) parts.push(profile.systemBlock);
    else if (profile && profile.facets) parts.push(renderFacets(profile.facets));
    const ex = await retrieve(query || "", { limit: exemplars });
    if (ex.length) parts.push("Real examples of Fred's own writing (match this voice — echo the rhythm and word-choice, do NOT quote them verbatim unless asked):\n" + ex.map((e) => `— [${e.kind}] ${e.text.slice(0, 500)}`).join("\n\n"));
    return { block: parts.join("\n\n"), exemplars: ex, hasProfile: !!profile };
  }

  function list({ kind = "", q = "" } = {}) {
    let out = docs;
    if (kind) out = out.filter((d) => d.kind === kind);
    if (q) { const qt = tokenize(q); out = out.filter((d) => { const t = new Set(tokenize(d.title + " " + d.text)); return qt.some((w) => t.has(w)); }); }
    return [...out].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((d) => ({ id: d.id, kind: d.kind, title: d.title, source: d.source, tags: d.tags, chars: d.text.length, chunks: chunks.filter((c) => c.docId === d.id).length, createdAt: d.createdAt }));
  }
  function getDoc(id) { return docs.find((d) => d.id === id) || null; }
  function removeDoc(id) {
    const before = docs.length;
    docs = docs.filter((d) => d.id !== id);
    chunks = chunks.filter((c) => c.docId !== id);
    persist();
    return { removed: before - docs.length };
  }

  function stats() {
    const byKind = {};
    for (const d of docs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
    return {
      docs: docs.length, chunks: chunks.length, embedded: chunks.filter((c) => c.vec).length,
      byKind, vectors: !!embed,
      profile: profile ? { updatedAt: profile.updatedAt, corpusDocs: profile.corpusDocs, corpusChunks: profile.corpusChunks } : null,
    };
  }

  return { ingestText, scanInbox, retrieve, sampleForProfile, personaBlock, getProfile, setProfile, list, getDoc, removeDoc, backfillEmbeddings, stats, KINDS, dir, inbox };
}

// Render the structured facets into a system-prompt block (fallback when no pre-rendered systemBlock).
export function renderFacets(f = {}) {
  const lines = ["You are writing and thinking AS Frederick (Fred) Wolfe — in his own voice, not as a generic assistant. Fred's profile:"];
  const add = (label, v) => { if (v && (Array.isArray(v) ? v.length : String(v).trim())) lines.push(`- ${label}: ${Array.isArray(v) ? v.join("; ") : v}`); };
  add("Voice & style", f.voice_style);
  add("Sense of humor", f.humor);
  add("Nuanced vocabulary & favored words", f.vocabulary);
  add("Wit & rhetorical moves", f.wit);
  add("Specialties & expertise", f.specialties);
  add("Reasoning & intelligence", f.reasoning);
  add("Interests, habits, hobbies, life work", f.interests);
  add("Hard do-nots", f.avoid);
  return lines.join("\n");
}
