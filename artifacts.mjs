/*
 * Dominion AI — Phase 4 artifact studio ("the artifacts").
 *
 * Generated documents are not disposable chat text — they're versioned, editable artifacts with
 * metadata, a full version history (every revision kept), line diffs between versions, text export,
 * and a review-attach hook (Phase 5 wires external mentors; Phase 4 attaches local review notes).
 *
 * Zero-dep JSON-file store on the mini-PC. LAX: artifacts auto-save; version history IS the rollback
 * (no destructive overwrite). Never touches customer DBs or the backup system.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TYPES = new Set(["markdown", "docx", "pdf", "spreadsheet", "json", "code", "report", "checklist", "other"]);
const nowIso = () => new Date().toISOString();
const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;
const tokenize = (s) => (String(s || "").toLowerCase().match(/[a-z0-9]{2,}/g) || []);
const EXT = { markdown: "md", md: "md", json: "json", code: "txt", txt: "txt", text: "txt", html: "html", htm: "html", report: "md", checklist: "md" };

// LCS line diff -> unified-ish (+ added / - removed /   unchanged). Capped to stay cheap.
function lineDiff(aText, bText) {
  const a = String(aText || "").split("\n"), b = String(bText || "").split("\n");
  if (a.length > 1500 || b.length > 1500) return `(too large for line diff: v-from has ${a.length} lines, v-to has ${b.length} lines)`;
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push("  " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("- " + a[i]); i++; }
    else { out.push("+ " + b[j]); j++; }
  }
  while (i < n) { out.push("- " + a[i++]); }
  while (j < m) { out.push("+ " + b[j++]); }
  return out.join("\n");
}

export function createArtifactStore(opts = {}) {
  const dir = resolve(opts.dir || "C:\\minipc-chat\\artifacts");
  const file = join(dir, "artifacts.json");
  const exportsDir = join(dir, "exports");
  const MAX_ITEMS = opts.maxItems || 1000;
  const MAX_LEN = opts.maxLen || 200000;
  let items = [];

  const load = () => { try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(j)) items = j; } } catch { items = []; } };
  const persist = () => { try { mkdirSync(dir, { recursive: true }); const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(items, null, 2)); renameSync(tmp, file); } catch {} };
  load();

  const find = (id) => items.find((a) => a.id === id) || null;
  const curContent = (a) => { const v = a.versions[a.version - 1] || a.versions[a.versions.length - 1]; return v ? v.content : ""; };
  const meta = (a) => ({ id: a.id, title: a.title, type: a.type, status: a.status, version: a.version, versionCount: a.versions.length, createdAt: a.createdAt, updatedAt: a.updatedAt, modelProviderId: a.modelProviderId, mentorReviewed: a.mentorReviewed, hasReview: !!a.reviewNotes, sourceChatId: a.sourceChatId, tags: a.tags, wordCount: wordCount(curContent(a)) });
  const full = (a) => ({ ...meta(a), content: curContent(a), reviewNotes: a.reviewNotes || null, versions: a.versions.map((v) => ({ version: v.version, createdAt: v.createdAt, model: v.model, promptSummary: v.promptSummary, wordCount: wordCount(v.content) })) });

  function create({ title, type, content, model, sourceChatId, tags, promptSummary } = {}) {
    const body = String(content || "").slice(0, MAX_LEN);
    if (body.trim().length < 1) return { error: "empty content" };
    const now = nowIso();
    const a = {
      id: randomUUID(), title: String(title || "Untitled").slice(0, 200), type: TYPES.has(type) ? type : "markdown",
      status: "draft", createdAt: now, updatedAt: now, sourceChatId: sourceChatId || null,
      modelProviderId: model || "", mentorReviewed: false, reviewNotes: null, version: 1,
      tags: Array.isArray(tags) ? tags.slice(0, 12).map(String) : [],
      versions: [{ version: 1, content: body, createdAt: now, model: model || "", promptSummary: String(promptSummary || "").slice(0, 300) }],
    };
    items.push(a); if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS); persist();
    return { item: full(a) };
  }

  // A revision is a NEW version — prior versions are never lost (the rollback guarantee).
  function addVersion(id, { content, model, promptSummary } = {}) {
    const a = find(id); if (!a) return { error: "not found" };
    const v = a.versions.length + 1;
    a.versions.push({ version: v, content: String(content || "").slice(0, MAX_LEN), createdAt: nowIso(), model: model || "", promptSummary: String(promptSummary || "").slice(0, 300) });
    a.version = v; a.updatedAt = nowIso(); if (a.status === "archived" || a.status === "final") a.status = "draft"; a.mentorReviewed = false;
    persist(); return { item: full(a) };
  }

  function setVersion(id, n) { const a = find(id); if (!a) return { error: "not found" }; if (n >= 1 && n <= a.versions.length) { a.version = n; a.updatedAt = nowIso(); persist(); } return { item: full(a) }; }

  function update(id, patch = {}) {
    const a = find(id); if (!a) return { error: "not found" };
    if (typeof patch.title === "string" && patch.title.trim()) a.title = patch.title.trim().slice(0, 200);
    if (patch.status && ["draft", "reviewed", "final", "archived"].includes(patch.status)) a.status = patch.status;
    if (TYPES.has(patch.type)) a.type = patch.type;
    if (Array.isArray(patch.tags)) a.tags = patch.tags.slice(0, 12).map(String);
    if (typeof patch.mentorReviewed === "boolean") a.mentorReviewed = patch.mentorReviewed;
    a.updatedAt = nowIso(); persist(); return { item: full(a) };
  }

  function attachReview(id, notes) { const a = find(id); if (!a) return { error: "not found" }; a.reviewNotes = String(notes || "").slice(0, 20000); a.mentorReviewed = true; if (a.status === "draft") a.status = "reviewed"; a.updatedAt = nowIso(); persist(); return { item: full(a) }; }

  function remove(id) { const before = items.length; items = items.filter((a) => a.id !== id); persist(); return { removed: before - items.length }; }

  function list(filter = {}) {
    let out = items;
    if (filter.status) out = out.filter((a) => a.status === filter.status);
    if (filter.type) out = out.filter((a) => a.type === filter.type);
    if (filter.q) { const q = tokenize(filter.q); out = out.filter((a) => { const t = new Set(tokenize(a.title + " " + curContent(a))); return q.some((w) => t.has(w)); }); }
    return [...out].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(meta);
  }
  const get = (id) => { const a = find(id); return a ? full(a) : null; };
  const getContent = (id, n) => { const a = find(id); if (!a) return null; const v = n ? a.versions[n - 1] : a.versions[a.version - 1]; return v ? v.content : null; };

  function diff(id, va, vb) {
    const a = find(id); if (!a) return { error: "not found" };
    const A = a.versions[(va || a.version - 1) - 1], B = a.versions[(vb || a.version) - 1];
    if (!A || !B) return { error: "bad version numbers" };
    return { from: A.version, to: B.version, diff: lineDiff(A.content, B.content) };
  }

  // Text export — writes a NEW file (source versions preserved). docx/pdf go through the Forge.
  function exportArtifact(id, format) {
    const a = find(id); if (!a) return { error: "not found" };
    const fmt = String(format || a.type || "markdown").toLowerCase();
    if (["docx", "pdf", "spreadsheet"].includes(fmt)) return { error: `${fmt} export needs the Forge (Claude Code holds those skills) — export markdown here, then use forge_send to convert.` };
    let body = curContent(a);
    const ext = EXT[fmt] || "txt";
    if (fmt === "json") { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {} }
    try {
      mkdirSync(exportsDir, { recursive: true });
      const safe = (a.title || "artifact").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60);
      const path = join(exportsDir, `${safe}-v${a.version}.${ext}`);
      writeFileSync(path, body, "utf8");
      return { path, bytes: Buffer.byteLength(body), format: fmt };
    } catch (e) { return { error: "export failed: " + e.message }; }
  }

  function stats() { const by = {}; for (const a of items) by[a.status] = (by[a.status] || 0) + 1; return { total: items.length, byStatus: by }; }

  return { create, addVersion, setVersion, update, attachReview, remove, list, get, getContent, diff, exportArtifact, stats };
}
