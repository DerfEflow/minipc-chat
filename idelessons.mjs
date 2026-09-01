/*
 * Dominion Works: the lessons-learned store for the Crucible build engine.
 *
 * WHY THIS EXISTS. ideengine.mjs runMove retries a failing move on the SAME model with no
 * diagnosis and no escalation, and whatever went wrong is forgotten the moment the build ends.
 * The 2026-09-01 reliability overhaul (main c57e2a2) measured six live failure lanes and fixed
 * each one by hand - planner prose, satisfied moves that could not pass, refused installs routed
 * around repair, unattended freezes, wrapped repair calls losing format under the manager prompt,
 * checks failing against files a later move was going to build. Every one of those was a real
 * build watched failing on a real GX10 model before the fix was written (rule 8.6). That overhaul
 * hard-coded six specific fixes; it did not give the engine a way to notice the SEVENTH kind of
 * failure on its own. This module is that mechanism: every failed move gets a dossier, a brain
 * model reads the dossier and proposes a fix, a frontier model is asked only when the brain does
 * not know or its fix does not work, and whatever generalizes past this one project is kept as a
 * lesson and injected into every future build's prompts as a policy line. Mistakes stop being
 * paid for twice.
 *
 * Pure module: no fs beyond its own lessons.json, no network, no model call. The caller
 * (ideengine.mjs) builds the dossier, sends the message arrays this module builds to whatever
 * chat function it already has open, parses the reply with the parsers here, and records the
 * result here. This module never picks up the phone itself.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LESSON_SCOPES = ["planner", "move", "repair", "verify", "install"];
const LESSON_SOURCES = new Set(["brain", "frontier", "human"]);
const DOSSIER_STAGES = new Set(["format", "coverage", "no_change_contested", "verify", "install", "planner"]);
const ROOT_CAUSES = new Set([
  "model_format", "model_logic", "missing_dependency", "test_isolation",
  "wrong_file_scope", "environment", "plan_granularity", "unknown",
]);

/* ---- small pure helpers, no store needed ----------------------------------------------------- */

function clipHead(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, n) : str;
}
function clipTail(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(-n) : str;
}

// A short stopword list, just enough to keep the dedupe check from being fooled by two sentences
// that share only glue words. Not a general NLP tool, on purpose: this only has to catch a brain
// model restating the same complaint in slightly different words within one build.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were", "are", "not", "but", "had",
  "has", "have", "its", "into", "onto", "out", "over", "under", "then", "than", "when", "what",
  "which", "who", "how", "why", "did", "does", "use", "used", "you", "your", "all", "any", "can",
  "one", "two", "get", "got", "will", "would", "should", "could", "each", "every", "before", "after",
]);

function tokenize(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

// Normalize a candidate lesson's text: trim, collapse internal whitespace, strip a trailing
// period (lessons read like a policy line, not a sentence needing punctuation), cap at 280 chars.
function normalizeLessonText(text) {
  let s = String(text == null ? "" : text).trim().replace(/\s+/g, " ");
  s = s.replace(/\.+$/, "");
  if (s.length > 280) s = s.slice(0, 280);
  return s.trim();
}

/*
 * The privacy filter for a "lesson" field. Fred's rule, stated in both prompts below: tenants
 * share one lesson store across every project, so a lesson must read as a policy that would help
 * ANY build, never as a fact about THIS one. Reject anything that looks like it carries project
 * data along for the ride: an absolute path, a URL, an email shape, a token-looking run of
 * characters, or more path separators than a bare "dir/file" reference needs.
 */
export function isSafeLesson(text) {
  const s = String(text || "");
  if (/[A-Za-z]:[\\/]/.test(s)) return false;
  if (/(^|\s)\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+/.test(s)) return false;
  if (/https?:\/\/|www\./i.test(s)) return false;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(s)) return false;
  if (/[A-Za-z0-9_-]{24,}/.test(s)) return false;
  const seps = (s.match(/[\\/]/g) || []).length;
  if (seps > 2) return false;
  return true;
}

function normLessonField(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 12) return null;
  if (!isSafeLesson(s)) return null;
  return s;
}

/* ---- the store: <dir>/lessons.json, atomic write, tolerant load ------------------------------- */

export function createLessonStore({ dir, maxActive = 400, maxInject = 12 } = {}) {
  if (!dir) throw new Error("createLessonStore needs a dir");
  const file = join(dir, "lessons.json");
  let state = { lessons: [], reports: 0, updatedAt: 0 };

  function load() {
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && Array.isArray(parsed.lessons)) {
        state = { lessons: parsed.lessons, reports: Number(parsed.reports) || 0, updatedAt: Number(parsed.updatedAt) || 0 };
      }
    } catch {
      // A missing or corrupt file starts empty rather than blocking the build on a broken store.
      state = { lessons: [], reports: 0, updatedAt: 0 };
    }
  }
  function persist() {
    try {
      mkdirSync(dir, { recursive: true });
      state.updatedAt = Date.now();
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, file);
    } catch {
      // A failed write should not crash the build the lesson came from; the lesson is simply not
      // durable this time, and the next successful write catches the store back up.
    }
  }
  load();

  // Retire the weakest active lesson (lowest hits+wins, oldest lastSeenAt breaks ties) until the
  // active count is back at the cap. Retired lessons stay in the file for stats/audit; they just
  // stop being selected.
  function enforceMaxActive() {
    let actives = state.lessons.filter((l) => l.status === "active");
    while (actives.length > maxActive) {
      actives.sort((a, b) => {
        const as = (a.hits || 0) + (a.wins || 0);
        const bs = (b.hits || 0) + (b.wins || 0);
        if (as !== bs) return as - bs;
        return (a.lastSeenAt || 0) - (b.lastSeenAt || 0);
      });
      const victim = actives.shift();
      victim.status = "retired";
    }
  }

  /*
   * Add or reinforce a lesson. A near-duplicate (token-Jaccard >= 0.6 against an active lesson in
   * the same scope) is not added again; it reinforces the existing record instead, because two
   * builds hitting the same wording is a stronger signal than two separate weak lessons. A
   * frontier correction outranks a brain guess: if the source upgrading in is "frontier" and the
   * lesson it matches came from "brain", the frontier wording replaces the brain wording.
   */
  function record({ text, scope, source, model, tags } = {}) {
    const sc = LESSON_SCOPES.includes(scope) ? scope : "move";
    const src = LESSON_SOURCES.has(source) ? source : "brain";
    const norm = normalizeLessonText(text);
    if (!norm || norm.length < 12) return { lesson: null, reinforced: false };
    const cleanTags = Array.isArray(tags)
      ? [...new Set(tags.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))].slice(0, 8)
      : [];
    const now = Date.now();
    const newTokens = tokenize(norm);

    let best = null, bestScore = 0;
    for (const l of state.lessons) {
      if (l.status !== "active" || l.scope !== sc) continue;
      const score = jaccard(newTokens, tokenize(l.text));
      if (score >= 0.6 && score > bestScore) { best = l; bestScore = score; }
    }
    if (best) {
      best.hits = (best.hits || 0) + 1;
      best.lastSeenAt = now;
      if (src === "frontier" && best.source === "brain") {
        best.source = "frontier";
        best.text = norm;
      }
      persist();
      return { lesson: { ...best }, reinforced: true };
    }

    const lesson = {
      id: randomUUID().replace(/-/g, "").slice(0, 8),
      text: norm,
      scope: sc,
      source: src,
      model: model ? String(model) : "",
      tags: cleanTags,
      hits: 1,
      applied: 0,
      wins: 0,
      createdAt: now,
      lastSeenAt: now,
      status: "active",
    };
    state.lessons.push(lesson);
    enforceMaxActive();
    persist();
    return { lesson: { ...lesson }, reinforced: false };
  }

  // The ranked pool for one scope/model, as live store references (not copies) so `touch` can
  // increment `applied` on the actual records before persisting. Ranking: same provider prefix as
  // `model` first (the string before the first "/"), then hits*2+wins descending, then most
  // recently seen first.
  function selectInternal({ scope, model, limit } = {}, { touch = true } = {}) {
    const lim = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : maxInject;
    const provider = model ? String(model).split("/")[0] : "";
    const pool = state.lessons.filter((l) => l.status === "active" && l.scope === scope);
    pool.sort((a, b) => {
      const ap = a.model && String(a.model).split("/")[0] === provider ? 0 : 1;
      const bp = b.model && String(b.model).split("/")[0] === provider ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const as = (a.hits || 0) * 2 + (a.wins || 0);
      const bs = (b.hits || 0) * 2 + (b.wins || 0);
      if (as !== bs) return bs - as;
      return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    });
    const picked = pool.slice(0, lim);
    if (touch && picked.length) {
      for (const l of picked) l.applied = (l.applied || 0) + 1;
      persist();
    }
    return picked;
  }

  // The public select: touches `applied` (this IS how injection counts get counted) and returns
  // copies so a caller mutating the result can never corrupt the store.
  function select(args) {
    return selectInternal(args, { touch: true }).map((l) => ({ ...l }));
  }

  function policiesBlock({ scope, model, limit } = {}) {
    const lessons = select({ scope, model, limit });
    if (!lessons.length) return "";
    return "POLICIES FROM PAST BUILDS (learned from real failures; follow them):\n" +
      lessons.map((l) => "- " + l.text).join("\n");
  }

  function creditWin(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let n = 0;
    for (const id of list) {
      const l = state.lessons.find((x) => x.id === id);
      if (l) { l.wins = (l.wins || 0) + 1; n++; }
    }
    if (n) persist();
    return n;
  }

  // Convenience for "this move/build passed": credit wins to whatever select() would hand out for
  // this scope/model, WITHOUT counting it as a fresh injection (no ids in hand, no applied bump).
  function noteWinFor({ scope, model } = {}) {
    const picked = selectInternal({ scope, model, limit: maxInject }, { touch: false });
    if (!picked.length) return 0;
    for (const l of picked) l.wins = (l.wins || 0) + 1;
    persist();
    return picked.length;
  }

  function retire(id) {
    const l = state.lessons.find((x) => x.id === id);
    if (!l || l.status === "retired") return false;
    l.status = "retired";
    persist();
    return true;
  }

  function list({ scope, status } = {}) {
    return state.lessons
      .filter((l) => (!scope || l.scope === scope) && (!status || l.status === status))
      .map((l) => ({ ...l }));
  }

  function stats() {
    let active = 0, retired = 0, hits = 0, applied = 0, wins = 0;
    for (const l of state.lessons) {
      if (l.status === "active") active++; else retired++;
      hits += l.hits || 0;
      applied += l.applied || 0;
      wins += l.wins || 0;
    }
    return { active, retired, hits, applied, wins, reports: state.reports };
  }

  function bumpReports() {
    state.reports = (state.reports || 0) + 1;
    persist();
    return state.reports;
  }

  return { record, select, policiesBlock, creditWin, retire, list, stats, bumpReports, noteWinFor };
}

/* ---- the failure dossier: one clipped, plain-object snapshot of what went wrong --------------- */

export function failureDossier({ move, model, taskClass, stage, attempt, reply, checkOutput, pipelineNotes, goal } = {}) {
  return {
    id: (move && move.id) || "",
    title: (move && move.title) || "",
    files: (move && move.files) || [],
    model: model || "",
    taskClass: taskClass || "",
    stage: DOSSIER_STAGES.has(stage) ? stage : "verify",
    attempt: Number(attempt) || 0,
    // The model's own reply is clipped from the HEAD (the format/intent is usually stated up
    // front); check output is clipped from the TAIL (the actual failing assertion is at the end
    // of a scrolling log, not the setup noise at the top).
    reply: clipHead(reply, 6000),
    checkOutput: clipTail(checkOutput, 8000),
    pipelineNotes: clipHead(pipelineNotes, 1500),
    goal: clipHead(goal, 800),
  };
}

function dossierLines(d) {
  return [
    "STAGE: " + (d.stage || "verify"),
    "MOVE: " + (d.title || d.id || ""),
    "FILES: " + (Array.isArray(d.files) ? d.files.join(", ") : ""),
    "MODEL: " + (d.model || ""),
    "ATTEMPT: " + (d.attempt || 0),
    "GOAL: " + (d.goal || ""),
    "",
    "WHAT THE MODEL RETURNED (head):",
    d.reply || "(nothing)",
    "",
    "CHECK OUTPUT (tail):",
    d.checkOutput || "(none)",
    "",
    "WHAT THE PIPELINE ALREADY TRIED:",
    d.pipelineNotes || "(nothing recorded)",
  ];
}

/* ---- the brain: a cheap model gets first look at a failure ------------------------------------ */

export const BRAIN_SYSTEM = [
  "You are the build brain inside Dominion Works. You receive a failed step from an automated",
  "build: a coding model tried a move, a repair, or a check, and it did not pass. Your job is to",
  "diagnose what actually went wrong and hand the coding model a fix it can act on in one retry.",
  "",
  "Return ONLY a JSON object, no prose before or after it, with exactly these keys:",
  "diagnosis: 2 sentences max, what actually went wrong.",
  "rootCause: one of \"model_format\", \"model_logic\", \"missing_dependency\", \"test_isolation\",",
  "  \"wrong_file_scope\", \"environment\", \"plan_granularity\", \"unknown\".",
  "fix: concrete instructions the CODING model can act on in one retry. Name the file and the",
  "  change. 600 characters or fewer.",
  "lesson: ONE generalizable sentence that would prevent this class of failure in ANY project, or",
  "  null when the failure is specific to this project.",
  "confidence: a number from 0 to 1.",
  "",
  "PRIVACY RULE FOR lesson: tenants share this lesson store across projects. A lesson must read as",
  "a policy, never as data about this build. It must never contain a project name, a file's",
  "contents, a secret, a URL, or a path longer than a bare filename. If you cannot state the lesson",
  "that way, return null for it instead of guessing.",
].join("\n");

export function brainReportMessages(dossier, { policies = "" } = {}) {
  const d = dossier || {};
  const lines = dossierLines(d);
  if (policies) { lines.push(""); lines.push(policies); }
  lines.push("");
  lines.push("Answer NOW with ONLY the JSON object.");
  return [
    { role: "system", content: BRAIN_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

/* ---- JSON extraction shared by both parsers ---------------------------------------------------
 * Fenced block first, then the whole raw text, then a bracket-balanced scan for the first {...}
 * span. Deliberately NOT a greedy regex: a greedy match on prose containing two separate
 * JSON-looking blocks would swallow everything between them instead of stopping at the first
 * object's real closing brace. The scan tracks string literals so a brace typed inside a quoted
 * "fix" string never miscounts as structural depth.
 */
function extractJsonObject(text) {
  const raw = String(text == null ? "" : text);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced && fenced[1], raw].filter((c) => typeof c === "string");

  for (const c of candidates) {
    try {
      const p = JSON.parse(c.trim());
      if (p && typeof p === "object" && !Array.isArray(p)) return p;
    } catch {}
  }
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false, quote = "";
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === quote) inStr = false;
        continue;
      }
      if (ch === "\"" || ch === "'") { inStr = true; quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const span = c.slice(start, i + 1);
          try {
            const p = JSON.parse(span);
            if (p && typeof p === "object" && !Array.isArray(p)) return p;
          } catch {}
          break;
        }
      }
    }
  }
  return null;
}

function normRootCause(v) {
  return ROOT_CAUSES.has(v) ? v : "unknown";
}
function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export function parseBrainReport(text) {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, report: null, error: "no JSON object found" };
  if (typeof obj.fix !== "string" || !obj.fix.trim()) return { ok: false, report: null, error: "no fix" };
  const report = {
    diagnosis: clipHead(obj.diagnosis, 600),
    rootCause: normRootCause(obj.rootCause),
    fix: clipHead(obj.fix.trim(), 600),
    lesson: normLessonField(obj.lesson),
    confidence: clampConfidence(obj.confidence),
  };
  return { ok: true, report, error: "" };
}

/* ---- the frontier reviewer: called only when the brain does not know, or its fix did not work - */

export const FRONTIER_SYSTEM = [
  "You are the frontier reviewer of last resort for an automated build. A smaller brain model",
  "already diagnosed this failure and its guidance did not resolve it, or it was unsure. You get",
  "one shot at a correction the coding model can act on.",
  "",
  "Return ONLY a JSON object, no prose before or after it, with exactly these keys:",
  "correction: what the coder must do, concrete, 800 characters or fewer. May include a short code",
  "  snippet.",
  "whyBrainWasWrong: one sentence, or null if the brain was simply unsure rather than wrong.",
  "lesson: ONE generalizable sentence that would prevent this class of failure in ANY project, or",
  "  null when the failure is specific to this project.",
  "confidence: a number from 0 to 1.",
  "",
  "PRIVACY RULE FOR lesson: tenants share this lesson store across projects. A lesson must read as",
  "a policy, never as data about this build. It must never contain a project name, a file's",
  "contents, a secret, a URL, or a path longer than a bare filename. If you cannot state the lesson",
  "that way, return null for it instead of guessing.",
].join("\n");

export function frontierCorrectionMessages(dossier, { brainReport, policies = "" } = {}) {
  const d = dossier || {};
  const br = brainReport || {};
  const lines = dossierLines(d);
  lines.push("");
  lines.push("BRAIN'S DIAGNOSIS: " + (br.diagnosis || "(none)"));
  lines.push("BRAIN'S FIX (did not work): " + (br.fix || "(none)"));
  if (policies) { lines.push(""); lines.push(policies); }
  lines.push("");
  lines.push("Answer NOW with ONLY the JSON object.");
  return [
    { role: "system", content: FRONTIER_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

// Mirrors parseBrainReport's { ok, report, error } shape so ideengine.mjs can handle either
// answer the same way; `report` just carries different keys (correction/whyBrainWasWrong instead
// of diagnosis/fix/rootCause).
export function parseFrontierCorrection(text) {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, report: null, error: "no JSON object found" };
  if (typeof obj.correction !== "string" || !obj.correction.trim()) return { ok: false, report: null, error: "no correction" };
  const report = {
    correction: clipHead(obj.correction.trim(), 800),
    whyBrainWasWrong: (typeof obj.whyBrainWasWrong === "string" && obj.whyBrainWasWrong.trim())
      ? clipHead(obj.whyBrainWasWrong.trim(), 300)
      : null,
    lesson: normLessonField(obj.lesson),
    confidence: clampConfidence(obj.confidence),
  };
  return { ok: true, report, error: "" };
}

/* ---- handing guidance to the coding model's retry ---------------------------------------------- */

export function guidanceTurn({ source, text } = {}) {
  const label = source === "frontier" ? "frontier reviewer" : "brain";
  const SOURCE = String(source || "brain").toUpperCase();
  return {
    role: "user",
    content: SOURCE + " GUIDANCE (from the build's " + label + "; act on it in this retry):\n" + String(text || ""),
  };
}

/* ---- model escalation: when the brain (and maybe the frontier) cannot fix it in place ---------- */

// One escalation attempt per failure. Fred's ruling: a stronger model gets ONE shot with the
// diagnosis in hand, not a ladder-climb through the whole catalog burning budget on a move that
// may simply be under-specified.
export const STRONGER_ATTEMPTS = 1;

export function strongerModelFor(model, { catalog = [], keyed = () => false, fallbacks = [] } = {}) {
  const current = (catalog || []).find((c) => c && c.id === model) || null;
  if (current) {
    const provider = current.provider;
    const curParams = Number.isFinite(current.paramsB) ? current.paramsB : 0;
    let best = null;
    for (const c of catalog || []) {
      if (!c || c.id === model || c.provider !== provider) continue;
      const p = Number.isFinite(c.paramsB) ? c.paramsB : 0;
      if (!(p > curParams)) continue;
      if (!keyed(c.id) || !c.toolCapable) continue;
      const bestP = best ? (Number.isFinite(best.paramsB) ? best.paramsB : 0) : -1;
      if (p > bestP) best = c;
    }
    if (best) return best.id;
  }
  for (const id of fallbacks || []) {
    if (id === model || !keyed(id)) continue;
    const rec = (catalog || []).find((c) => c && c.id === id);
    // A fallback id absent from the catalog is assumed capable: the list is curated by the caller
    // specifically as a strongest-first contingency, the same trust already placed in `catalog`.
    if (rec && rec.toolCapable === false) continue;
    return id;
  }
  return null;
}

/* ---- the one-line journal entry -----------------------------------------------------------------
 * e.g. "Brain (gx10/gpt-oss-120b, confidence 0.8): the test imports a path that was never
 * created. Fix: create test/helpers.js exporting seedDb()."
 */
export function reportLine(report, { source, model } = {}) {
  const r = report || {};
  const label = source === "frontier" ? "Frontier" : "Brain";
  const confNum = Number(r.confidence);
  const conf = Number.isFinite(confNum) ? Math.round(confNum * 100) / 100 : "?";
  const head = source === "frontier"
    ? (r.correction || "")
    : ((r.diagnosis ? r.diagnosis + " " : "") + "Fix: " + (r.fix || ""));
  let line = label + " (" + (model || "") + ", confidence " + conf + "): " + head;
  if (line.length > 300) line = line.slice(0, 297) + "...";
  return line;
}
