/*
 * Dominion AI — Phase 2 governed memory store ("the memory").
 *
 * Zero-dep JSON-file store on the mini-PC. Holds typed MemoryItems with an inbox
 * (pending/approved/rejected/archived), the spec's THREE-TIER gating matrix, the never-save
 * list, scope-aware retrieval, and hybrid lexical+vector search. Only APPROVED memory ever
 * reaches a prompt; pending/rejected/archived are ignored by the context builder.
 *
 * GATING (spec 617-640), config-driven via opts.gating:
 *   - auto tier: only the safest categories (user_explicit; a user-confirmed repeated workflow
 *     preference) commit without approval.
 *   - approval tier: assistant_inferred, failure memories, mentor_suggested, tool_observed,
 *     eval_failure, and anything sensitive-flagged land PENDING in the inbox (spec mode).
 *     LAX mode ([[feedback_dominion_ai_lax_safety]]) auto-approves the approval tier but still
 *     runs the classification and records gatedAs/gatedReasons, so flipping MEMORY_GATING=spec
 *     is meaningful (and audit-able retroactively). ONE lax exception: mentor_suggested content
 *     is an UNVERIFIED mentor claim (never-save list: "do not save as ground truth without
 *     validation") — it always lands pending, flagged unverified, until Fred approves it.
 *   - never-save tier: raw hidden reasoning, secrets, interrupted outputs, unlabeled
 *     hallucinations, and near-duplicates are BLOCKED in every mode.
 *
 * SCOPE (spec MemoryItem.scope) is validated on write and ENFORCED on read: retrieval and
 * always-loaded paths take a scopeCtx ({chatId, workspace, tool, model, mode}) — chat-scoped
 * memories only surface in their chat, tool-scoped only in tool contexts, etc. Global always.
 *
 * Retrieval is HYBRID: lexical keyword overlap blended with cosine similarity over embeddings
 * (opts.embed = async text->vector, e.g. Ollama /api/embed with nomic-embed-text). If the embedder
 * is unavailable or a vector is missing, scoring degrades gracefully to pure lexical — the store
 * never blocks on embeddings. Retention is enforced: expired items auto-archive on read.
 * This store NEVER touches customer DBs or app backups.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./mentor.mjs";

const TYPES = new Set(["profile", "workspace", "session", "episodic", "failure"]);
const SCOPES = new Set(["global", "workspace", "chat", "tool", "model"]);
const SOURCE_KINDS = new Set(["user_explicit", "assistant_inferred", "mentor_suggested", "tool_observed", "eval_failure"]);

// ---- B1: the three-tier per-category gating matrix (spec 617-631) ----
// "auto" = safest categories commit without approval; "approval" = pending in the inbox (spec
// mode) / auto-approved-but-recorded (lax mode). The matrix is data, not code — flipping a
// category's tier is a one-line change and the classifier below reads it verbatim.
export const GATING_MATRIX = {
  user_explicit: "auto",          // "user explicitly says to remember something" / user-instructed setting change
  assistant_inferred: "approval", // inferred personal preferences
  mentor_suggested: "approval",   // mentor-suggested memories (ALSO unverified — see never-save handling)
  tool_observed: "approval",
  eval_failure: "approval",
};

// Classify a candidate against the matrix + the spec's extra approval conditions.
// Returns { tier: "auto"|"approval", reasons: [] } — never-save is checked separately.
export function classifyGate(input = {}, { sensitive = false } = {}) {
  const kind = (input.source && input.source.kind) || "assistant_inferred";
  const reasons = [];
  let tier = GATING_MATRIX[kind] || "approval";
  if (tier === "approval") reasons.push("source:" + kind);
  // Spec auto case: "a repeated workflow preference is confirmed" — an inferred preference the
  // user explicitly confirmed may auto-save.
  if (kind === "assistant_inferred" && input.confirmedWorkflow === true) { tier = "auto"; reasons.length = 0; }
  // Spec approval overrides (these force approval even for otherwise-auto content):
  if (input.type === "failure") { tier = "approval"; reasons.push("failure memory"); }
  if (sensitive) { tier = "approval"; reasons.push("sensitive content"); }
  if (input.broadImpact === true) { tier = "approval"; reasons.push("broad behavioral impact"); }
  return { tier, reasons: [...new Set(reasons)] };
}

// ---- B3: the never-save list (spec 633-640) — ALWAYS blocks, even under LAX ----
const RAW_REASONING_RE = /<think>|<\/think>|chain[ -]of[ -]thought|internal (monologue|reasoning)|hidden reasoning/i;
const COT_OPENER_RE = /^(okay|alright|hmm),?\s+(so\s+)?(the user|let'?s think|i (need|should) to think)/i;
// Hard secrets from the shared redaction layer = "accidental private data" → block outright.
const BLOCKING_REDACTIONS = new Set(["[api-key]", "[token]", "[jwt]", "[hex-secret]", "[secret]"]);
// Softer personal/sensitive signals → not blocked, but sensitive-flagged (approval tier).
const SENSITIVE_RE = /\b(ssn|social security|credit card|card number|routing number|bank account|medical|diagnos\w*|prescription|therapy|salary|tax return|passport number|driver'?s license)\b/i;

// Returns { blocked: reason|null, sensitive: boolean, redactions: [] }.
export function neverSaveCheck(content, input = {}) {
  const text = String(content || "");
  const kind = (input.source && input.source.kind) || "assistant_inferred";
  if (RAW_REASONING_RE.test(text) || (COT_OPENER_RE.test(text) && text.length > 200))
    return { blocked: "raw hidden reasoning is never saved", sensitive: false, redactions: [] };
  if (input.interrupted === true)
    return { blocked: "incomplete interrupted output is never saved", sensitive: false, redactions: [] };
  const r = redact(text);
  const hardSecret = r.applied.filter((a) => BLOCKING_REDACTIONS.has(a));
  if (hardSecret.length)
    return { blocked: "contains private data (" + hardSecret.join(", ") + ") — never saved", sensitive: true, redactions: r.applied };
  if (input.hallucination === true && input.type !== "failure")
    return { blocked: "hallucinations are never saved except as labeled failure records", sensitive: false, redactions: r.applied };
  const sensitive = r.applied.length > 0 || SENSITIVE_RE.test(text) || input.sensitive === true ||
    kind === "mentor_suggested" && /\b(fred|user)('s)? (health|finances|family)\b/i.test(text);
  return { blocked: null, sensitive, redactions: r.applied };
}
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
  // Gating mode: "lax" (default — approval tier auto-approves but gets RECORDED via gatedAs) or
  // "spec" (approval tier lands pending). opts.autoApprove===false is the legacy spec-mode switch.
  const gating = opts.gating === "spec" || opts.autoApprove === false ? "spec" : "lax";
  const autoApprove = gating === "lax";                     // back-compat surface for stats/logs
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

  // Gating (B1+B3): never-save list first (always blocks), then the three-tier matrix.
  // Near-identical content is deduped; scope + source.kind are VALIDATED on write.
  function propose(input = {}) {
    const content = String(input.content || "").trim().slice(0, MAX_LEN);
    if (content.length < 3) return { error: "empty content" };   // one-off trivia floor
    const kindRaw = (input.source && input.source.kind) || "assistant_inferred";
    const kind = SOURCE_KINDS.has(kindRaw) ? kindRaw : "assistant_inferred";
    // Never-save list (spec 633-640) — enforced in EVERY mode, LAX included.
    const ns = neverSaveCheck(content, { ...input, source: { kind } });
    if (ns.blocked) return { error: "never-save: " + ns.blocked, blocked: ns.blocked };
    const dup = items.find((m) => m.status !== "rejected" && norm(m.content) === norm(content));
    if (dup) { dup.updatedAt = nowIso(); if (input.pinned) dup.pinned = true; persist(); return { item: dup, deduped: true }; }
    const gate = classifyGate({ ...input, type: TYPES.has(input.type) ? input.type : "profile", source: { kind } }, { sensitive: ns.sensitive });
    // Status decision:
    //   auto tier            -> approved (both modes)
    //   mentor_suggested     -> PENDING in both modes (unverified mentor claim — the lax exception)
    //   approval tier (spec) -> pending
    //   approval tier (lax)  -> approved, with gatedAs/gatedReasons recording what spec mode would do
    const unverifiedMentor = kind === "mentor_suggested";
    let status;
    if (gate.tier === "auto") status = "approved";
    else if (unverifiedMentor || gating === "spec") status = "pending";
    else status = "approved";
    const now = nowIso();
    // Retention discipline: "temporary" items expire in 24h unless an explicit expiry was given.
    const retention = input.retention || "durable";
    const expiresAt = input.expiresAt || (retention === "temporary" ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : null);
    const item = {
      id: randomUUID(),
      type: TYPES.has(input.type) ? input.type : "profile",
      scope: SCOPES.has(input.scope) ? input.scope : "global",           // B2: validated on write
      scopeRef: input.scopeRef ? String(input.scopeRef).slice(0, 120) : null,   // chatId / workspace / tool / model the scope binds to
      content,
      source: { kind, referenceId: (input.source && input.source.referenceId) || null },
      confidence: typeof input.confidence === "number" ? input.confidence : (kind === "user_explicit" ? 1 : 0.6),
      createdAt: now,
      updatedAt: now,
      status,
      retention,
      expiresAt,
      pinned: !!input.pinned,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [],
    };
    if (gate.tier === "approval") { item.gatedAs = "approval"; item.gatedReasons = gate.reasons; }   // recorded even when lax auto-approved
    if (ns.sensitive) item.sensitive = true;
    if (unverifiedMentor) item.unverified = true;   // cleared on explicit approval
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
    if (a === "approve") { m.status = "approved"; if (m.unverified) { m.unverified = false; m.verifiedAt = nowIso(); } }   // approval IS the validation of a mentor claim
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

  // B2: scope enforcement on read. scopeCtx = { chatId, workspace, tool, model, mode }.
  //   global (or legacy unscoped)  -> always visible
  //   chat      -> only inside the chat it was scoped to (a chat scope with no ref never surfaces)
  //   workspace -> visible when unbound, or when bound to the active workspace
  //   tool      -> visible in tool contexts (mode "tool"), or when bound to the active tool
  //   model     -> visible when unbound, or when bound to the active model tier/name
  function scopeVisible(m, ctx) {
    const scope = m.scope || "global";
    if (scope === "global") return true;
    const c = ctx || {};
    if (scope === "chat") return !!m.scopeRef && m.scopeRef === c.chatId;
    if (scope === "workspace") return !m.scopeRef || m.scopeRef === c.workspace;
    if (scope === "tool") return m.scopeRef ? m.scopeRef === c.tool : c.mode === "tool";
    if (scope === "model") return !m.scopeRef || m.scopeRef === c.model;
    return true;
  }
  const eligible = (scopeCtx) => items.filter((m) => m.status === "approved" && scopeVisible(m, scopeCtx));

  // Lexical retrieval over APPROVED, scope-visible memory -> RetrievedContext[] (sync fallback path).
  function retrieve(query, { limit = 4, minScore = 0.15, scopeCtx = null } = {}) {
    sweep();
    const q = tokenize(query); if (!q.length) return [];
    return eligible(scopeCtx).map((m) => ({ m, s: lexScore(q, m) * boost(m) })).filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, limit).map(({ m, s }) => toCtx(m, s));
  }

  // Hybrid retrieval: 0.5*lexical + 0.5*cosine when embeddings are available; pure lexical otherwise.
  async function retrieveHybrid(query, { limit = 4, minScore = 0.15, scopeCtx = null } = {}) {
    sweep();
    const q = tokenize(query); if (!q.length) return [];
    let qvec = null;
    if (embed) { try { const v = await embed(String(query).slice(0, 2000)); if (Array.isArray(v) && v.length) qvec = v; } catch {} }
    if (!qvec) return retrieve(query, { limit, minScore, scopeCtx });
    return eligible(scopeCtx)
      .map((m) => { const lex = lexScore(q, m); const cos = m.vec ? cosine(qvec, m.vec) : 0; const s = (m.vec ? 0.5 * lex + 0.5 * cos : lex) * boost(m); return { m, s }; })
      .filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, limit).map(({ m, s }) => toCtx(m, s));
  }

  // Always loaded by the context builder regardless of query: pinned + profile (durable prefs) —
  // still scope-filtered, so a chat-pinned note doesn't leak into every conversation.
  function alwaysLoaded({ limit = 6, scopeCtx = null } = {}) {
    sweep();
    return eligible(scopeCtx).filter((m) => m.pinned || m.type === "profile").slice(0, limit).map((m) => toCtx(m, 1));
  }

  function stats() {
    const by = {}; for (const m of items) by[m.status] = (by[m.status] || 0) + 1;
    const gatedLax = items.filter((m) => m.gatedAs === "approval" && m.status === "approved").length;
    return { total: items.length, byStatus: by, gating, autoApprove, gatedLax, unverified: items.filter((m) => m.unverified).length, embedded: items.filter((m) => m.vec).length, vectors: !!embed };
  }

  return { propose, update, remove, list, get: find, retrieve, retrieveHybrid, alwaysLoaded, backfillEmbeddings, stats, autoApprove, gating };
}
