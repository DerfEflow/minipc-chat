/*
 * Dominion Works: the build engine.
 *   SOW docs/IDE-MODE-ROADMAP.md (Phase 5) - build pack docs/IDE-MODE-BUILD.md
 *
 * Turns a sentence into a numbered plan, then runs the plan one move at a time against the user's
 * OWN machine through their hands node. Everything expensive or dangerous is bounded here:
 *
 *   CONTEXT BY MANIFEST. A move sees only the files it declared. Whole-repo dumps are the single
 *   biggest way these systems get slow and expensive, and they make the model worse, not better.
 *
 *   BYTE-STABLE PREFIX. The system block is a frozen constant and per-move facts ride in the user
 *   message. Provider caches match on an exact prefix; the measured hit rate on the chat path was
 *   ZERO (server.mjs comment, 2026-07-18), and this is the feature meant to fix that. Never
 *   interpolate anything per-move into SYSTEM_PREFIX.
 *
 *   SNAPSHOT BEFORE WRITES. Always, no exceptions. Git commit where the workspace is a repo,
 *   file copies where it is not.
 *
 *   METER ONCE PER MOVE, ON A FINALLY PATH. Per-call metering overcharges (billing.mjs has a
 *   1-credit floor per charge) and metering only on success means an aborted build is free, which
 *   is the leak the chat path still has.
 *
 * The pure helpers below carry the logic worth testing; the orchestrator wires them to injected
 * dependencies so none of this needs a server or a provider to exercise.
 */

export const MAX_FILES_PER_MOVE = 24;
export const MAX_FILE_BYTES = 120000;      // one file's worth of context, generous but bounded
export const MAX_MOVES = 40;
export const VERIFY_TIMEOUT_MS = 180000;

/*
 * The frozen system block. Changing this text invalidates every provider-side cache entry, so
 * treat edits as a deliberate cost, not a tidy-up. NOTHING per-move goes in here.
 */
export const SYSTEM_PREFIX = [
  "You are the build engine inside Dominion Works. You write real files on the user's own machine.",
  "",
  "Rules:",
  "1. Return ONLY file blocks. No preamble, no explanation, no closing remarks.",
  "2. Each file is a fenced block whose info string is the path, exactly:",
  "   ```path=src/thing.ts",
  "   ...complete file contents...",
  "   ```",
  "3. Always write the file COMPLETE. Never abbreviate with comments like 'rest unchanged'.",
  "4. Only touch files listed in the move's manifest. If you need another file, say so in a block",
  "   with the path `NEED:` followed by the path, and write nothing else.",
  "5. Match the surrounding code's style, naming, and comment density.",
].join("\n");

/* ---------------------------------------------------------------------------------------------
 * Smallness check: does this even need a plan?
 * A plan for "fix the typo in the header" is ceremony that costs a model call and the user's
 * patience. Deterministic, because asking a model whether to ask a model is absurd.
 * ------------------------------------------------------------------------------------------- */
const SMALL_VERBS = /\b(fix|rename|tweak|adjust|change|update|bump|remove|delete|add)\b/i;
const BIG_SIGNALS = /\b(build|create|scaffold|app|application|system|dashboard|site|website|api|full|entire|whole|from scratch|end[- ]to[- ]end|multi|several|pipeline|integrate|migrate|refactor)\b/i;

export function isSmallAsk(prompt, { files = [] } = {}) {
  const text = String(prompt || "").trim();
  if (!text) return { small: false, why: "nothing to do" };
  if (text.length > 240) return { small: false, why: "the ask is long enough to deserve a plan" };
  if (BIG_SIGNALS.test(text)) return { small: false, why: "this sounds like more than one move" };
  if (files.length > 2) return { small: false, why: "it touches several files" };
  if (SMALL_VERBS.test(text) || files.length === 1) {
    return { small: true, why: "one small change, so it runs straight away instead of planning first" };
  }
  return { small: false, why: "unclear scope, so it gets a plan" };
}

/* ---------------------------------------------------------------------------------------------
 * Blueprint parsing. Models wrap JSON in prose and fences no matter how firmly you ask them not
 * to, so this digs the array out rather than trusting the envelope, and refuses honestly when
 * there is nothing usable rather than inventing a plan.
 * ------------------------------------------------------------------------------------------- */
export function parseBlueprint(text) {
  const raw = String(text || "");
  let arr = null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced && fenced[1], raw].filter(Boolean);
  for (const c of candidates) {
    try { const p = JSON.parse(c.trim()); arr = Array.isArray(p) ? p : (Array.isArray(p.moves) ? p.moves : null); }
    catch {}
    if (arr) break;
    const bracket = c.match(/\[[\s\S]*\]/);
    if (bracket) { try { const p = JSON.parse(bracket[0]); if (Array.isArray(p)) arr = p; } catch {} }
    if (arr) break;
  }
  if (!arr || !arr.length) return { ok: false, error: "The planner did not return a usable plan.", moves: [] };

  const moves = arr.slice(0, MAX_MOVES).map((m, i) => ({
    id: String((m && m.id) || "m" + (i + 1)),
    title: String((m && m.title) || "Move " + (i + 1)).slice(0, 140),
    why: String((m && m.why) || "").slice(0, 400),
    files: (Array.isArray(m && m.files) ? m.files : []).filter((f) => typeof f === "string" && f.trim())
      .slice(0, MAX_FILES_PER_MOVE).map((f) => f.trim()),
    verify: String((m && m.verify) || "").slice(0, 200),
  })).filter((m) => m.title);
  if (!moves.length) return { ok: false, error: "The planner returned a plan with no usable moves.", moves: [] };
  return { ok: true, moves };
}

/* ---------------------------------------------------------------------------------------------
 * File-block parsing. The model answers in ```path=... blocks; this pulls them out and refuses
 * anything that tries to escape the workspace.
 * ------------------------------------------------------------------------------------------- */
export function parseFileBlocks(text) {
  const out = [], needs = [], issues = [];
  const re = /```(?:path=|file=)?\s*([^\n`]+?)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const rawPath = String(m[1] || "").trim().replace(/^["']|["']$/g, "");
    const body = m[2];
    if (/^NEED:/i.test(rawPath)) { needs.push(rawPath.replace(/^NEED:\s*/i, "")); continue; }
    if (!rawPath || /^(json|js|ts|bash|sh|text|txt|diff)$/i.test(rawPath)) continue;   // a plain language fence
    // Traversal and absolute paths are refused rather than normalized: a build that silently
    // rewrites where it is writing is worse than one that stops and says so.
    if (rawPath.includes("..")) { issues.push({ path: rawPath, reason: "path tries to climb out of the workspace" }); continue; }
    if (/^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith("/") || rawPath.startsWith("\\")) {
      issues.push({ path: rawPath, reason: "path is absolute; moves write inside the workspace only" });
      continue;
    }
    out.push({ path: rawPath.replace(/\\/g, "/"), content: body.replace(/\n$/, "") });
  }
  return { files: out, needs, issues };
}

/* ---------------------------------------------------------------------------------------------
 * Carve-out honesty. The node refuses a write whose ARGS mention a protected resource, and the
 * args include file CONTENTS, so a perfectly innocent backup script containing the word pg_dump
 * gets refused three layers down with no explanation. Catching it here lets the build say exactly
 * which word in which file, and what to do about it. The carve-out itself is never weakened.
 * ------------------------------------------------------------------------------------------- */
const CARVE_HINTS = [
  { re: /pg_dump|pg_restore/i, what: "pg_dump / pg_restore" },
  { re: /(^|[^a-z0-9])d:[\\/]/i, what: "a D: drive path" },
  { re: /app[-_ ]?backups?/i, what: "the words app-backup" },
  { re: /\bdb[-_ ]?backups?\b/i, what: "the words db-backup" },
];

export function carveOutReport(files) {
  const hits = [];
  for (const f of files || []) {
    const blob = String(f.path || "") + "\n" + String(f.content || "");
    for (const h of CARVE_HINTS) {
      if (h.re.test(blob)) { hits.push({ path: f.path, what: h.what }); break; }
    }
  }
  if (!hits.length) return null;
  const first = hits[0];
  return {
    blocked: hits,
    message: "This move was stopped before it wrote anything. " + first.path + " contains " + first.what
      + ", which trips Dominion's hard carve-out protecting the backup drive and database backups. "
      + "That guard scans file CONTENTS as well as paths, so even harmless text can set it off. "
      + "Rename or rephrase that part and run the move again. The carve-out itself is never relaxed.",
  };
}

/* ---------------------------------------------------------------------------------------------
 * Budget. A cap that stops silently is a bug; a build that pauses and asks is a feature.
 * ------------------------------------------------------------------------------------------- */
export function budgetCheck({ spentUsd = 0, capUsd = 0, nextEstUsd = 0 } = {}) {
  if (!capUsd || capUsd <= 0) return { stop: false, warn: false, spentUsd, capUsd: 0 };
  if (spentUsd >= capUsd) return { stop: true, warn: true, spentUsd, capUsd, reason: "cap_reached" };
  if (spentUsd + nextEstUsd > capUsd) return { stop: true, warn: true, spentUsd, capUsd, reason: "next_move_would_exceed" };
  return { stop: false, warn: spentUsd > capUsd * 0.75, spentUsd, capUsd };
}

// Deterministic pre-move estimate from catalog prices. No model call: an estimate that costs
// money to produce is not an estimate.
export function estimateMove({ manifestBytes = 0, inCost = 0, outCost = 0, expectOutTokens = 1800 } = {}) {
  const inTok = Math.ceil(manifestBytes / 3.6) + 700;      // prefix + instructions overhead
  const usd = (inTok * inCost + expectOutTokens * outCost) / 1e6;
  return { inTok, outTok: expectOutTokens, usd: Math.round(usd * 1e6) / 1e6 };
}

/* ---------------------------------------------------------------------------------------------
 * Verify command discovery. Guessing a build command and running it is how you burn three minutes
 * on a project that has no build. This reads package.json and picks what actually exists.
 * ------------------------------------------------------------------------------------------- */
export function verifyCommandFor(packageJsonText) {
  let scripts = null;
  try { scripts = (JSON.parse(String(packageJsonText || "{}")) || {}).scripts || null; } catch {}
  if (!scripts) return { cmd: "", why: "no package.json scripts, so there is nothing to run" };
  for (const name of ["typecheck", "check", "lint", "test", "build"]) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      return { cmd: "npm run " + name + " --silent", why: "package.json defines a " + name + " script" };
    }
  }
  return { cmd: "", why: "package.json has no check, test, or build script" };
}

/*
 * Build the message pair for one move. The system string is the frozen constant; everything
 * variable goes in the user turn, which is what keeps the cacheable prefix identical across every
 * move of every build.
 */
export function buildMoveMessages({ move, manifest = [], workspaceName = "", goal = "" }) {
  const parts = [];
  parts.push("PROJECT: " + (workspaceName || "(unnamed)"));
  if (goal) parts.push("OVERALL GOAL: " + goal);
  parts.push("");
  parts.push("MOVE: " + move.title);
  if (move.why) parts.push("WHY: " + move.why);
  parts.push("");
  if (manifest.length) {
    parts.push("FILES YOU MAY EDIT (current contents follow):");
    for (const f of manifest) {
      parts.push("");
      parts.push("--- " + f.path + (f.missing ? "  (does not exist yet, create it)" : "") + " ---");
      if (!f.missing) parts.push(f.content || "");
    }
  } else {
    parts.push("This move creates new files. None exist yet.");
  }
  parts.push("");
  parts.push("Return the complete contents of every file you changed, each in its own path block.");
  return [
    { role: "system", content: SYSTEM_PREFIX },
    { role: "user", content: parts.join("\n") },
  ];
}

export const PLANNER_SYSTEM = [
  "You plan software builds. Return ONLY a JSON array of moves, no prose.",
  "",
  "Each move: {\"id\":\"m1\",\"title\":\"...\",\"why\":\"...\",\"files\":[\"path\"],\"verify\":\"...\"}",
  "",
  "Rules:",
  "1. Order moves so each one leaves the project working.",
  "2. `files` lists ONLY what that move edits or creates. Keep it small: a move that touches",
  "   twenty files is really several moves.",
  "3. `title` and `why` are read by a non-programmer. Plain English, no jargon.",
  "4. Prefer fewer, meaningful moves over many trivial ones.",
].join("\n");

/*
 * The orchestrator. Dependencies are injected so this file needs no server, provider, or fs:
 *   jobs    the durable spine (emit/finish)
 *   chat    async ({model, messages}) -> {ok, content, usage, costUsd}
 *   hands   async (tool, args) -> node result   (fs_read / fs_write / shell_run / fs_list)
 *   router  ({title, files}) -> {taskClass, model, why}
 *   meter   async (usd) -> void                 (called ONCE per move, on a finally path)
 */
export function createIdeEngine({ jobs, chat, hands, router, meter = async () => {}, log = () => {} } = {}) {
  if (!jobs || !chat || !hands || !router) throw new Error("createIdeEngine needs jobs, chat, hands, router");

  // Read a move's manifest straight off the node. Deliberately NOT through the chat tool loop,
  // whose results are truncated to 8000 chars: a move that silently sees half of a file writes
  // the other half wrong.
  async function readManifest(root, paths) {
    const out = [];
    for (const rel of paths.slice(0, MAX_FILES_PER_MOVE)) {
      const full = root.replace(/[\\/]+$/, "") + "/" + rel;
      try {
        const r = await hands("fs_read", { path: full, maxBytes: MAX_FILE_BYTES });
        const content = (r && (r.content || r.text)) || "";
        if (r && r.ok === false) out.push({ path: rel, missing: true });
        else out.push({ path: rel, content: String(content).slice(0, MAX_FILE_BYTES) });
      } catch { out.push({ path: rel, missing: true }); }
    }
    return out;
  }

  // Snapshot BEFORE any write batch. A repo gets a commit; anything else gets copies. If neither
  // is possible the move does not run: no rollback path means no write.
  async function snapshot(job, workspace) {
    const root = workspace.root;
    try {
      const isRepo = await hands("shell_run", { command: "git -C \"" + root + "\" rev-parse --is-inside-work-tree", timeoutMs: 20000 });
      const inRepo = /true/i.test(String((isRepo && (isRepo.stdout || isRepo.output)) || ""));
      if (inRepo) {
        // ";" not "&&": PowerShell 5.1. A failed add makes commit capture less, never break more.
        await hands("shell_run", { command: "git -C \"" + root + "\" add -A; git -C \"" + root + "\" commit -m \"Dominion Works snapshot\" --allow-empty", timeoutMs: 60000 });
        jobs.emit(job.id, { type: "snapshot", kind: "git", message: "Committed a restore point in the repo before writing." });
        return { ok: true, kind: "git" };
      }
      const stamp = String(job.id).replace(/[^a-z0-9_]/gi, "");
      const dest = root.replace(/[\\/]+$/, "") + "/.dominion-snapshots/" + stamp;
      await hands("shell_run", { command: "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '" + dest + "' | Out-Null; Copy-Item -Path '" + root + "\\*' -Destination '" + dest + "' -Recurse -Force -Exclude '.dominion-snapshots'\"", timeoutMs: 120000 });
      jobs.emit(job.id, { type: "snapshot", kind: "copy", path: dest, message: "Copied the project to a restore point before writing." });
      return { ok: true, kind: "copy", path: dest };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  async function writeFiles(job, workspace, files) {
    const root = workspace.root.replace(/[\\/]+$/, "");
    const written = [], failed = [];
    for (const f of files) {
      try {
        const r = await hands("fs_write", { path: root + "/" + f.path, content: f.content });
        if (r && r.ok === false) failed.push({ path: f.path, reason: r.error || "the node refused the write" });
        else { written.push(f.path); jobs.emit(job.id, { type: "file", path: f.path, bytes: f.content.length }); }
      } catch (e) { failed.push({ path: f.path, reason: String(e && e.message || e) }); }
    }
    return { written, failed };
  }

  async function verify(job, workspace) {
    let pkg = "";
    try {
      const r = await hands("fs_read", { path: workspace.root.replace(/[\\/]+$/, "") + "/package.json", maxBytes: 20000 });
      pkg = (r && (r.content || r.text)) || "";
    } catch {}
    const { cmd, why } = verifyCommandFor(pkg);
    if (!cmd) { jobs.emit(job.id, { type: "run", skipped: true, message: "Nothing to verify: " + why + "." }); return { ran: false, ok: true }; }
    try {
      // No "&&": the node runs PowerShell 5.1 on Windows, where "&&" is a PARSE ERROR (the
      // standing house lesson, relearned live when the first real build failed its check on
      // exactly this). ";" is a statement separator in both PowerShell and sh, and set-location
      // failing on a missing folder makes the check fail loudly rather than run somewhere else.
      const r = await hands("shell_run", { command: "cd \"" + workspace.root + "\"; " + cmd, timeoutMs: VERIFY_TIMEOUT_MS });
      const code = (r && (r.code ?? r.exitCode)) || 0;
      const output = String((r && (r.stdout || r.output)) || "") + String((r && r.stderr) || "");
      jobs.emit(job.id, { type: "run", command: cmd, ok: code === 0, output: output.slice(-4000) });
      return { ran: true, ok: code === 0, output, cmd };
    } catch (e) {
      jobs.emit(job.id, { type: "run", command: cmd, ok: false, output: String(e && e.message || e) });
      return { ran: true, ok: false, output: String(e && e.message || e), cmd };
    }
  }

  /*
   * Run one move. Returns { ok, costUsd, blocked }. Metering happens in `finally`, so a move that
   * throws, is stopped, or fails verification still charges for the tokens it actually burned.
   */
  async function runMove(job, { move, workspace, assignments, goal }) {
    let costUsd = 0;
    try {
      const decision = router({ title: move.title, description: move.why, files: move.files }, assignments);
      // `why` belongs to the PLAN (what this move is for, in plain English). The router's reason
      // travels as routeWhy so the two never overwrite each other on the card.
      jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "running",
        why: move.why || "", taskClass: decision.taskClass, model: decision.model, routeWhy: decision.why });

      const manifest = await readManifest(workspace.root, move.files || []);
      const messages = buildMoveMessages({ move, manifest, workspaceName: workspace.name, goal });
      const res = await chat({ model: decision.model, messages });
      costUsd += Number(res && res.costUsd) || 0;
      if (!res || !res.ok) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: (res && res.error) || "The model call failed." });
        return { ok: false, costUsd };
      }

      const parsed = parseFileBlocks(res.content);
      for (const bad of parsed.issues) jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "warned", message: bad.path + ": " + bad.reason });
      if (!parsed.files.length) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: parsed.needs.length
            ? "It needs a file that was not in this move's list: " + parsed.needs.join(", ")
            : "It returned no files to write." });
        return { ok: false, costUsd };
      }

      // Carve-out BEFORE the snapshot and before any write, so a refusal costs nothing.
      const carve = carveOutReport(parsed.files);
      if (carve) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "blocked", message: carve.message });
        return { ok: false, costUsd, blocked: true };
      }

      const snap = await snapshot(job, workspace);
      if (!snap.ok) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: "No restore point could be made, so nothing was written. " + (snap.error || "") });
        return { ok: false, costUsd };
      }

      const { written, failed } = await writeFiles(job, workspace, parsed.files);
      for (const f of failed) jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "warned", message: f.path + ": " + f.reason });

      const v = await verify(job, workspace);
      if (v.ran && !v.ok) {
        // ONE repair round. Then the raw output is surfaced and the human decides, rather than
        // looping on a red build burning money.
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "repairing" });
        const repair = await chat({ model: decision.model, messages: [
          ...messages,
          { role: "assistant", content: res.content },
          { role: "user", content: "The check failed. Fix it and return the complete corrected files.\n\n" + String(v.output || "").slice(-4000) },
        ] });
        costUsd += Number(repair && repair.costUsd) || 0;
        if (repair && repair.ok) {
          const again = parseFileBlocks(repair.content);
          const carve2 = carveOutReport(again.files);
          if (carve2) {
            jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "blocked", message: carve2.message });
            return { ok: false, costUsd, blocked: true };
          }
          if (again.files.length) {
            await writeFiles(job, workspace, again.files);
            const v2 = await verify(job, workspace);
            if (!v2.ok) {
              jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
                message: "The check still fails after one repair attempt. The output is above; nothing further was tried automatically." });
              return { ok: false, costUsd, wroteAnyway: true };
            }
          }
        }
      }

      jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "done", files: written.length });
      return { ok: true, costUsd, written };
    } finally {
      // FINALLY, always. Aborted and failed moves still burned tokens, and pretending otherwise is
      // the exact leak the chat path has (its early returns skip metering entirely).
      if (costUsd > 0) { try { await meter(costUsd); } catch (e) { log("[ide] meter failed: " + (e && e.message)); } }
      if (costUsd > 0) jobs.emit(job.id, { type: "cost", usd: Math.round(costUsd * 1e6) / 1e6, move: move.id });
    }
  }

  return { runMove, readManifest, snapshot, verify, writeFiles };
}
