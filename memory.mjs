/*
 * Dominion AI — Phase 2 governed memory store ("the memory").
 *
 * Zero-dep JSON-file store on the mini-PC. Holds typed MemoryItems with an inbox
 * (pending/approved/rejected/archived), gating rules, and lexical retrieval. Only APPROVED
 * memory ever reaches a prompt; pending/rejected/archived are ignored by the context builder.
 *
 * LAX posture ([[feedback_dominion_ai_lax_safety]]): candidates auto-approve by default
 * (autoApprove=true), but the full governance plumbing exists so it can be flipped to require
 * approval per-item without code changes. This store NEVER touches customer DBs or app backups.
 *
 * Retrieval is HYBRID: lexical keyword overlap blended with cosine similarity over embeddings
 * (opts.embed = async text->vector, e.g. Ollama /api/embed with nomic-embed-text). If the embedder
 * is unavailable or a vector is missing, scoring degrades gracefully to pure lexical — the store
 * never blocks on embeddings. Retention is enforced: expired items auto-archive on read.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TYPES = new Set(["profile", "workspace", "session", "episodic", "failure"]);
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

export function createMemoryStore(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\memory");
  const file = join(dir, "memory.json");
  const autoApprove = opts.autoApprove !== false;          // LAX default: true
  const embed = typeof opts.embed === "function" ? opts.embed : null;
  const MAX_ITEMS = opts.maxItems || 2000;
  const MAX_LEN = opts.maxLen || 2000;
  let items = [];
  let lastSweep = 0;

  function load() {
    try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(j)) items = j; } } catch { items = []; }
  }
  function persist() {
    try { mkdirSync(dir, { recursive: true }); const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(items, null, 2)); renameSync(tmp, file); } catch {}
  }
  load();

  const find = (id) => items.find((m) => m.id === id) || null;
  const toCtx = (m, s) => ({ id: m.id, sourceType: "memory", title: m.type, content: m.content, score: Number((s).toFixed(3)), createdAt: m.createdAt, sourceRef: m.id, citationLabel: "mem:" + m.id.slice(0, 8) });

  // Retention enforcement: past-expiry items auto-archive (never silently used again, still inspectable).
  function sweep() {
    const now = Date.now();
    if (now - lastSweep < 60000) return;   // at most once a minute
    lastSweep = now;
    let dirty = false;
    for (const m of items) {
      if (m.expiresAt && (m.status === "approved" || m.status === "pending") && Date.parse(m.expiresAt) < now) { m.status = "archived"; m.updatedAt = nowIso(); dirty = true; }
    }
    if (dirty) persist();
  }

  // Fire-and-forget embedding of an item (never blocks or throws into the caller).
  function embedItem(m) {
    if (!embed || m.vec) return;
    Promise.resolve(embed(m.content)).then((v) => { if (Array.isArray(v) && v.length) { m.vec = roundVec(v); persist(); } }).catch(() => {});
  }
  // Boot-time backfill for items saved before embeddings existed (sequential, capped).
  async function backfillEmbeddings(max = 100) {
    if (!embed) return 0;
    let done = 0;
    for (const m of items) {
      if (done >= max) break;
      if (m.vec || m.status === "rejected") continue;
      try { const v = await embed(m.content); if (Array.isArray(v) && v.length) { m.vec = roundVec(v); done++; } else break; } catch { break; }
    }
    if (done) persist();
    return done;
  }

  // Gating: user_explicit always auto-saves; never-save junk is rejected; near-identical content is deduped.
  function propose(input = {}) {
    const content = String(input.content || "").trim().slice(0, MAX_LEN);
    if (content.length < 3) return { error: "empty content" };
    const kind = (input.source && input.source.kind) || "assistant_inferred";
    const dup = items.find((m) => m.status !== "rejected" && norm(m.content) === norm(content));
    if (dup) { dup.updatedAt = nowIso(); if (input.pinned) dup.pinned = true; persist(); return { item: dup, deduped: true }; }
    const userExplicit = kind === "user_explicit";
    const now = nowIso();
    // Retention discipline: "temporary" items expire in 24h unless an explicit expiry was given.
    const retention = input.retention || "durable";
    const expiresAt = input.expiresAt || (retention === "temporary" ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : null);
    const item = {
      id: randomUUID(),
      type: TYPES.has(input.type) ? input.type : "profile",
      scope: input.scope || "global",
      content,
      source: { kind, referenceId: (input.source && input.source.referenceId) || null },
      confidence: typeof input.confidence === "number" ? input.confidence : (userExplicit ? 1 : 0.6),
      createdAt: now,
      updatedAt: now,
      status: userExplicit ? "approved" : (autoApprove ? "approved" : "pending"),
      retention,
      expiresAt,
      pinned: !!input.pinned,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [],
    };
    items.push(item);
    if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
    persist();
    embedItem(item);
    return { item };
  }

  // Inbox actions + edits.
  function update(id, patch = {}) {
    const m = find(id); if (!m) return { error: "not found" };
    const a = patch.action;
    if (a === "approve") m.status = "approved";
    else if (a === "reject") m.status = "rejected";
    else if (a === "archive") m.status = "archived";
    else if (a === "pin") m.pinned = true;
    else if (a === "unpin") m.pinned = false;
    if (typeof patch.content === "string" && patch.content.trim() && patch.content.trim().slice(0, MAX_LEN) !== m.content) { m.content = patch.content.trim().slice(0, MAX_LEN); m.vec = null; embedItem(m); }
    if (TYPES.has(patch.type)) m.type = patch.type;
    if (Array.isArray(patch.tags)) m.tags = patch.tags.slice(0, 12).map(String);
    if (typeof patch.pinned === "boolean") m.pinned = patch.pinned;
    m.updatedAt = nowIso();
    persist();
    return { item: m };
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((m) => m.id !== id);
    persist();
    return { removed: before - items.length };
  }

  const pub = (m) => { const { vec, ...rest } = m; return rest; };   // vectors stay server-side
  function list(filter = {}) {
    sweep();
    let out = items;
    if (filter.status) out = out.filter((m) => m.status === filter.status);
    if (filter.type) out = out.filter((m) => m.type === filter.type);
    if (filter.q) { const q = tokenize(filter.q); out = out.filter((m) => { const t = new Set(tokenize(m.content)); return q.some((w) => t.has(w)); }); }
    return [...out].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updatedAt).localeCompare(String(a.updatedAt))).map(pub);
  }

  const lexScore = (qTokens, m) => {
    const t = new Set(tokenize(m.content)); if (!t.size) return 0;
    let hits = 0; for (const w of qTokens) if (t.has(w)) hits++;
    return hits / qTokens.length;
  };
  const boost = (m) => (m.pinned ? 1.4 : 1) * (m.type === "profile" ? 1.1 : 1);

  // Lexical retrieval over APPROVED memory -> RetrievedContext[] (sync fallback path).
  function retrieve(query, { limit = 4, minScore = 0.15 } = {}) {
    sweep();
    const q = tokenize(query); if (!q.length) return [];
    const approved = items.filter((m) => m.status === "approved");
    return approved.map((m) => ({ m, s: lexScore(q, m) * boost(m) })).filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, limit).map(({ m, s }) => toCtx(m, s));
  }

  // Hybrid retrieval: 0.5*lexical + 0.5*cosine when embeddings are available; pure lexical otherwise.
  async function retrieveHybrid(query, { limit = 4, minScore = 0.15 } = {}) {
    sweep();
    const q = tokenize(query); if (!q.length) return [];
    let qvec = null;
    if (embed) { try { const v = await embed(String(query).slice(0, 2000)); if (Array.isArray(v) && v.length) qvec = v; } catch {} }
    if (!qvec) return retrieve(query, { limit, minScore });
    const approved = items.filter((m) => m.status === "approved");
    return approved
      .map((m) => { const lex = lexScore(q, m); const cos = m.vec ? cosine(qvec, m.vec) : 0; const s = (m.vec ? 0.5 * lex + 0.5 * cos : lex) * boost(m); return { m, s }; })
      .filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, limit).map(({ m, s }) => toCtx(m, s));
  }

  // Always loaded by the context builder regardless of query: pinned + profile (durable prefs).
  function alwaysLoaded({ limit = 6 } = {}) {
    sweep();
    return items.filter((m) => m.status === "approved" && (m.pinned || m.type === "profile")).slice(0, limit).map((m) => toCtx(m, 1));
  }

  function stats() {
    const by = {}; for (const m of items) by[m.status] = (by[m.status] || 0) + 1;
    return { total: items.length, byStatus: by, autoApprove, embedded: items.filter((m) => m.vec).length, vectors: !!embed };
  }

  return { propose, update, remove, list, get: find, retrieve, retrieveHybrid, alwaysLoaded, backfillEmbeddings, stats, autoApprove };
}
