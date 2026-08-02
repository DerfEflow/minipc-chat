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
/*
 * Above this many files, a move that came back incomplete is SPLIT rather than discarded.
 *
 * The threshold is the honest boundary of a real trade. Whole-move atomicity is a genuine
 * protection: writing half a change leaves a project in a state nobody asked for. But it was being
 * enforced by throwing away everything the model produced, and the chance of returning every file
 * complete in one reply collapses as the list grows, so a large move could fail forever and write
 * nothing (Fred watched a 17-file repair do exactly that, twice, and read it as the build refusing
 * to try).
 *
 * So small moves keep the strict guarantee, where a plain retry is cheap and a partial write is
 * the worse outcome. Large moves, which are the ones that never converge, are halved into moves
 * that each keep the guarantee on their own scope. It is a deliberate exchange of one big
 * all-or-nothing for several small ones, made only where all-or-nothing was reliably yielding
 * nothing.
 */
export const SPLITTABLE_MOVE_FILES = 4;
export const MAX_FILE_BYTES = 120000;      // one manifest page; large files are paged below
export const MAX_MANIFEST_FILE_BYTES = 600000; // disaster/context guard, disclosed whenever reached
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
const BIG_SIGNALS = /\b(build|create|scaffold|app|application|system|dashboard|site|website|api|full|entire|whole|from scratch|end[- ]to[- ]end|multi|several|pipeline|integrate|migrate|refactor|page|screen|settings|billing|payment|checkout|auth|authentication|login|signup|sign[- ]up|account|database|schema|onboarding|notifications?)\b/i;

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
  /*
   * A line walker with fence-DEPTH tracking (Kimi #5, verified). The old regex ended a file at the
   * first ``` anywhere, so a generated README or doc containing its own fenced code example was
   * truncated at that inner fence. Column zero alone cannot fix it: a README's own closing fence
   * is at column zero too. So instead: an INFO fence (```path or ```lang, anything after the
   * backticks) opens a level, a BARE ``` closes the innermost. A file block is level 1; an inner
   * ```bash example opens level 2 and its bare fence returns to level 1; the file's own bare fence
   * then closes level 1. The file's whole body, inner fences and all, is preserved.
   */
  const lines = String(text || "").split(/\r?\n/);
  let path = null, body = null, depth = 0;
  const fence = (l) => { const m = l.match(/^```(.*)$/); return m ? m[1].trim() : null; };
  const commit = (rawPath, content) => {
    const stripped = rawPath.replace(/^(path=|file=)/i, "").trim().replace(/^["']|["']$/g, "");
    if (/^NEED:/i.test(stripped)) { needs.push(stripped.replace(/^NEED:\s*/i, "")); return; }
    const clean = stripped;
    if (!clean) return;
    // A language tag (a bare word, no dot or slash) is never a file; the well-known extensionless
    // names are the exception.
    const looksLikePath = /[.\/]/.test(clean) || /^(dockerfile|makefile|license|procfile|gemfile|rakefile|readme)$/i.test(clean);
    if (!looksLikePath) return;
    if (clean.includes("..")) { issues.push({ path: clean, reason: "path tries to climb out of the workspace" }); return; }
    if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith("/") || clean.startsWith("\\")) {
      issues.push({ path: clean, reason: "path is absolute; moves write inside the workspace only" });
      return;
    }
    out.push({ path: clean.replace(/\\/g, "/"), content: content.join("\n") });
  };
  for (const line of lines) {
    const info = fence(line);
    if (path === null) {
      // Outside any file: only an INFO fence that looks like a path opens a file block.
      if (info) {
        const stripped = info.replace(/^(path=|file=)/i, "").trim().replace(/^["']|["']$/g, "");
        const looksLikePath = /^NEED:/i.test(stripped) || /[.\/]/.test(stripped) || /^(dockerfile|makefile|license|procfile|gemfile|rakefile|readme)$/i.test(stripped);
        if (looksLikePath) { path = info; body = []; depth = 1; }
      }
      continue;
    }
    // Inside a file block.
    if (info === "") { depth--; if (depth === 0) { commit(path, body); path = null; body = null; continue; } body.push(line); continue; }
    if (info !== null) { depth++; body.push(line); continue; }
    body.push(line);
  }
  // A missing outer closing fence is indistinguishable from a provider-truncated response. Reject
  // the WHOLE response, including earlier complete blocks: writing file A when file B was cut off
  // leaves an internally inconsistent move and is worse than retrying it atomically.
  if (path !== null) {
    const unfinished = String(path).replace(/^(path=|file=)/i, "").trim().replace(/^["']|["']$/g, "");
    issues.push({
      path: unfinished || "(unknown file)",
      reason: "response ended before the closing fence; no files from this truncated response were accepted",
    });
    return { files: [], needs: [], issues, truncated: true };
  }
  return { files: out, needs, issues, truncated: false };
}

function normalizedMovePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

/*
 * A roadmap file is an implementation obligation, not a suggestion. A model may return useful
 * edits for one file while silently skipping its siblings; without an explicit coverage check the
 * move used to look successful. Keep this pure so the standard, relay, and task-graph runners can
 * all enforce the same contract.
 */
export function fileCoverage(expected, returned) {
  const wanted = [...new Set((expected || []).map(normalizedMovePath).filter(Boolean))];
  const got = new Set((returned || []).map((entry) =>
    normalizedMovePath(typeof entry === "string" ? entry : entry && entry.path)).filter(Boolean));
  const original = new Map((expected || []).map((entry) => [normalizedMovePath(entry), String(entry)]));
  const missing = wanted.filter((path) => !got.has(path)).map((path) => original.get(path) || path);
  return { complete: missing.length === 0, missing, covered: wanted.filter((path) => got.has(path)) };
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
/*
 * The pre-move estimate that the spend limit is checked against.
 *
 * It assumed 1,800 output tokens for any move and one model call to produce them. A move writes
 * whole files (nearer 2,500 tokens EACH), and the engine may take three attempts with three
 * inspection windows apiece before a move lands. Under-estimating here is not a cosmeticproblem now
 * that a real cap exists: the gate's job is to stop BEFORE the move that would break the budget,
 * and it cannot do that while it believes every move is the cheapest one possible.
 *
 * `files` scales the output guess; RETRY_ALLOWANCE covers the attempts. The result is deliberately
 * on the generous side, because the failure modes are not symmetric: quoting high pauses a build
 * and asks, quoting low spends money nobody agreed to.
 */
export const OUT_TOKENS_PER_FILE = 2500;
export const RETRY_ALLOWANCE = 2.2;
export function estimateMove({ manifestBytes = 0, inCost = 0, outCost = 0, files = 1, expectOutTokens = 0 } = {}) {
  const fileCount = Math.max(1, Number(files) || 1);
  const outTok = expectOutTokens > 0 ? expectOutTokens : fileCount * OUT_TOKENS_PER_FILE;
  const inTok = Math.ceil(manifestBytes / 3.6) + 700;      // prefix + instructions overhead
  const usd = ((inTok * inCost + outTok * outCost) / 1e6) * RETRY_ALLOWANCE;
  return { inTok, outTok, usd: Math.round(usd * 1e6) / 1e6 };
}

/* ---------------------------------------------------------------------------------------------
 * Verification discovery. Guessing a command is unreliable, while running only the first declared
 * check can call a broken project complete. Build a deterministic plan from every relevant script.
 * ------------------------------------------------------------------------------------------- */
const VERIFY_SCRIPT_ORDER = ["typecheck", "check", "lint", "test", "build"];

/*
 * The hands node runs PowerShell 5.1, where a native command's stderr comes back wrapped in
 * serialized CLIXML: a "#< CLIXML" marker, an <Objs> document, and a "Preparing modules for first
 * use" progress record per invocation. In a real failure Fred pasted, that noise was most of the
 * text and the actual signal was three words. It reached the model's context too, so every repair
 * turn paid tokens to read XML and had the diagnosis buried inside it. Strip it at the boundary.
 */
export function cleanShellOutput(s) {
  let t = String(s == null ? "" : s);
  if (!t) return "";
  t = t.replace(/#<\s*CLIXML\s*/gi, "");
  t = t.replace(/<Objs[\s\S]*?<\/Objs>/gi, "");
  t = t.replace(/<Obj\b[\s\S]*?<\/Obj>/gi, "");
  t = t.replace(/^.*Preparing modules for first use\..*$/gim, "");
  return t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/*
 * A check that failed because its PROGRAM is missing is not a code defect, and must never be sent
 * to a repair loop whose only power is writing files: no TypeScript edit makes `tsc` exist. Fred's
 * build spent a 17-file rewrite attempt on exactly this before giving up.
 */
const MISSING_BINARY_RX = /is not recognized as an internal or external command|command not found|: not found|ENOENT|no such file or directory.*(?:tsc|eslint|vitest|jest|npm|node)|'[^']+' is not recognized/i;
export function isMissingToolFailure(output) {
  return MISSING_BINARY_RX.test(String(output || ""));
}

export function verificationPlanFor(packageJsonText) {
  let scripts = null;
  try { scripts = (JSON.parse(String(packageJsonText || "{}")) || {}).scripts || null; } catch {}
  if (!scripts) return { commands: [], why: "no package.json scripts, so there is nothing to run" };
  const commands = VERIFY_SCRIPT_ORDER
    .filter((name) => typeof scripts[name] === "string" && scripts[name].trim())
    .map((name) => ({
      name,
      cmd: "npm run " + name + " --silent",
      why: "package.json defines a " + name + " script",
    }));
  return commands.length
    ? { commands, why: "package.json defines " + commands.map((c) => c.name).join(", ") }
    : { commands: [], why: "package.json has no check, test, or build script" };
}

// Backward-compatible single-command view for callers that only need a preview. The engine itself
// consumes `verificationPlanFor` and runs the complete plan.
export function verifyCommandFor(packageJsonText) {
  const plan = verificationPlanFor(packageJsonText);
  const first = plan.commands[0];
  return first ? { cmd: first.cmd, why: first.why } : { cmd: "", why: plan.why };
}

/*
 * HARD RULE R8 (Fred, 2026-08-02). VERIFICATION MUST DISCOVER THE PROJECT IT IS ACTUALLY IN.
 *
 * verificationPlanFor() above reads exactly one ROOT package.json. That is why the Speak-Easy build
 * (ide_656a18b1-254) logged, three separate times:
 *
 *   "Nothing to verify: no package.json scripts, so there is nothing to run."
 *
 * It is a Gradle/Android project with a Node server in server/. There is no root package.json, so
 * nothing was ever compiled, and a 660-line transcription route that no entrypoint registers went
 * out the door. `tsc` in server/ takes two seconds and would have caught it.
 *
 * Discovery now walks the listing the node already returns and recognises project markers wherever
 * they sit. Each command carries the directory it must run in. An unrecognised stack is NOT a pass:
 * it produces zero commands, and R7 turns "no commands" into "cannot be called finished".
 */
const dirOf = (p) => { const i = String(p).lastIndexOf("/"); return i < 0 ? "" : String(p).slice(0, i); };
const baseOf = (p) => { const i = String(p).lastIndexOf("/"); return i < 0 ? String(p) : String(p).slice(i + 1); };

export async function discoverVerificationPlan({ entries = [], readFile = async () => "", maxProjects = 6 } = {}) {
  const paths = [...new Set((entries || [])
    .map((e) => String((e && (e.path || e.name)) || e || "").replace(/\\/g, "/").replace(/^\.?\/+/, ""))
    .filter(Boolean))];
  const has = (name) => paths.filter((p) => baseOf(p).toLowerCase() === name.toLowerCase());
  const commands = [];
  const seenDirs = new Set();
  const notes = [];

  // ---- Node / TypeScript, at ANY depth (this is the nested server/ case) ----------------------
  for (const pkgPath of has("package.json").slice(0, maxProjects)) {
    const dir = dirOf(pkgPath);
    if (/(^|\/)node_modules(\/|$)/.test(pkgPath) || seenDirs.has("node:" + dir)) continue;
    seenDirs.add("node:" + dir);
    let scripts = null;
    try { scripts = (JSON.parse(String(await readFile(pkgPath) || "{}")) || {}).scripts || null; } catch {}
    const declared = scripts ? VERIFY_SCRIPT_ORDER.filter((n) => typeof scripts[n] === "string" && scripts[n].trim()) : [];
    for (const name of declared) {
      commands.push({ name: (dir ? dir + ":" : "") + name, dir, cmd: "npm run " + name + " --silent",
        needsInstall: true, why: (dir ? dir + "/" : "") + "package.json defines a " + name + " script" });
    }
    // A TS project that declares no check script still compiles. Not compiling it is the gap.
    if (!declared.length && paths.includes(dir ? dir + "/tsconfig.json" : "tsconfig.json")) {
      commands.push({ name: (dir ? dir + ":" : "") + "tsc", dir, cmd: "npx --yes tsc --noEmit",
        needsInstall: true, why: (dir ? dir + "/" : "") + "tsconfig.json exists but no check script is declared" });
    }
  }

  // ---- Gradle / Android ------------------------------------------------------------------------
  const gradleRoots = [...new Set([...has("settings.gradle"), ...has("settings.gradle.kts")].map(dirOf))];
  for (const dir of gradleRoots.slice(0, maxProjects)) {
    if (seenDirs.has("gradle:" + dir)) continue;
    seenDirs.add("gradle:" + dir);
    const wrapper = paths.some((p) => p === (dir ? dir + "/gradlew" : "gradlew")
      || p === (dir ? dir + "/gradlew.bat" : "gradlew.bat"));
    if (!wrapper) {
      /*
       * No wrapper means no pinned Gradle and no way to build. This is a real blocker, reported as
       * itself rather than silently skipped. Speak-Easy shipped with no gradlew at all.
       */
      notes.push((dir ? dir + "/" : "") + "is a Gradle project with no gradlew wrapper, so it cannot be built");
      continue;
    }
    const gw = (dir ? dir + "/" : "") + "gradlew";
    const isAndroid = paths.some((p) => /(^|\/)AndroidManifest\.xml$/i.test(p));
    commands.push({ name: (dir ? dir + ":" : "") + (isAndroid ? "assembleDebug" : "build"),
      dir, cmd: (process.platform === "win32" ? ".\\gradlew.bat " : "./gradlew ")
        + (isAndroid ? "assembleDebug" : "build") + " --console=plain --no-daemon",
      why: gw + " exists" + (isAndroid ? " and an AndroidManifest.xml was written" : "") });
  }

  // ---- Other ecosystems -------------------------------------------------------------------------
  for (const [marker, name, cmd] of [
    ["Cargo.toml", "cargo check", "cargo check --quiet"],
    ["go.mod", "go build", "go build ./..."],
  ]) {
    for (const p of has(marker).slice(0, maxProjects)) {
      const dir = dirOf(p);
      if (seenDirs.has(marker + ":" + dir)) continue;
      seenDirs.add(marker + ":" + dir);
      commands.push({ name: (dir ? dir + ":" : "") + name, dir, cmd, why: (dir ? dir + "/" : "") + marker + " exists" });
    }
  }

  const why = commands.length
    ? "discovered " + commands.map((c) => c.name).join(", ")
    : (notes.length ? notes.join("; ")
       : "no recognised project markers (package.json, settings.gradle, Cargo.toml, go.mod) were found in the workspace");
  return { commands, why, blockers: notes };
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
      parts.push("--- " + f.path + (f.missing ? "  (does not exist yet, create it)"
        : f.truncated ? "  (partial manifest; page the disclosed remainder before relying on omitted code)" : "") + " ---");
      if (!f.missing) parts.push(f.content || "");
    }
  } else {
    parts.push("This move creates new files. None exist yet.");
  }
  parts.push("");
  parts.push("Return one complete path block for EVERY file listed in this move, including a byte-identical block when inspection proves that file needs no change. Omitting a listed file leaves the move incomplete.");
  return [
    { role: "system", content: SYSTEM_PREFIX },
    { role: "user", content: parts.join("\n") },
  ];
}

/*
 * Line diff for the Workshop lens. Plain LCS, capped: past 400 lines a side it degrades to
 * honest counts with a note instead of burning CPU on a diff nobody will scroll.
 */
export function lineDiff(oldStr, newStr, { cap = 400, maxOut = 200 } = {}) {
  const a = String(oldStr || "").split("\n");
  const b = String(newStr || "").split("\n");
  if (!String(oldStr || "").length) {
    return { added: b.length, removed: 0, diff: b.slice(0, maxOut).map((l) => "+" + l).join("\n") + (b.length > maxOut ? "\n+ ... " + (b.length - maxOut) + " more lines" : ""), truncated: b.length > maxOut };
  }
  if (a.length > cap || b.length > cap) {
    return { added: b.length, removed: a.length, diff: "(file too large for a line diff: " + a.length + " lines before, " + b.length + " after)", truncated: true };
  }
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(" " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("-" + a[i]); removed++; i++; }
    else { out.push("+" + b[j]); added++; j++; }
  }
  while (i < m) { out.push("-" + a[i++]); removed++; }
  while (j < n) { out.push("+" + b[j++]); added++; }
  // Only changed lines plus one line of context either side; whole-file dumps are not a diff.
  const keep = [];
  for (let k = 0; k < out.length; k++) {
    const changed = out[k][0] !== " ";
    const near = (out[k - 1] && out[k - 1][0] !== " ") || (out[k + 1] && out[k + 1][0] !== " ");
    if (changed || near) keep.push(out[k]);
    else if (keep[keep.length - 1] !== "...") keep.push("...");
  }
  const clipped = keep.slice(0, maxOut);
  return { added, removed, diff: clipped.join("\n") + (keep.length > maxOut ? "\n... " + (keep.length - maxOut) + " more lines" : ""), truncated: keep.length > maxOut };
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
        let offset = 0, content = "", missing = false, totalBytes = null, eof = false;
        for (let page = 0; page < Math.ceil(MAX_MANIFEST_FILE_BYTES / MAX_FILE_BYTES); page++) {
          const r = await hands("fs_read", {
            path: full,
            offset,
            maxBytes: Math.min(MAX_FILE_BYTES, MAX_MANIFEST_FILE_BYTES - content.length),
            partial: true,
          });
          if (r && r.ok === false) { missing = offset === 0; break; }
          const text = String((r && (r.content ?? r.text)) || "");
          content += text;
          if (Number.isFinite(Number(r && r.totalBytes))) totalBytes = Number(r.totalBytes);
          const nextOffset = Number(r && r.nextOffset);
          eof = !!(r && r.eof === true) || (totalBytes != null && offset + text.length >= totalBytes);
          if (eof || !text || content.length >= MAX_MANIFEST_FILE_BYTES) break;
          // Older hands nodes returned a single complete string without pagination metadata. Do
          // not duplicate that page; continue only when a cursor or total explicitly proves more.
          const canPage = (Number.isFinite(nextOffset) && nextOffset > offset)
            || (totalBytes != null && offset + text.length < totalBytes);
          if (!canPage) { eof = true; break; }
          offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : offset + text.length;
        }
        if (missing) out.push({ path: rel, missing: true });
        else {
          const truncated = !eof && (totalBytes == null || content.length < totalBytes);
          if (truncated) {
            content += "\n\n[Dominion manifest window: read " + content.length +
              " characters" + (totalBytes != null ? " of " + totalBytes : "") +
              ". The remainder was not silently discarded; use workspace_read with an offset before changing code that depends on it.]";
          }
          out.push({ path: rel, content, truncated, totalBytes });
        }
      } catch { out.push({ path: rel, missing: true }); }
    }
    return out;
  }

  // Snapshot BEFORE any write batch. A repo gets a commit; anything else gets copies. If neither
  // is possible the move does not run: no rollback path means no write.
  /*
   * Make sure the project folder actually exists on the machine that will build in it.
   *
   * Fred, 2026-08-01: he made a project, chose drive F, planned it, pressed BEGIN BUILDING, and got
   * "hands fs_list failed: ENOENT ... scandir 'F:\Calorie Count Test'" followed by a build that
   * stopped early. A workspace is a POINTER, and the folder-picker path registered a pointer to a
   * folder nobody had created. The auto-folder path did create one, so the two doors behaved
   * differently and only one of them worked.
   *
   * Two mechanisms because the two kinds of machine have different tools: the cloud workshop has
   * fs_mkdir and refuses a shell, while the installed hands node has a shell and no fs_mkdir.
   * Trying both means this works on every node already out there, with no reinstall.
   */
  async function ensureRoot(root) {
    const path = String(root || "").replace(/[\\/]+$/, "");
    if (!path) return { ok: false, error: "This project has no folder recorded." };
    try {
      const r = await hands("fs_mkdir", { path });
      if (r && r.ok !== false) return { ok: true };
    } catch {}
    try {
      // Single quotes doubled: a folder name may legitimately contain an apostrophe.
      await hands("shell_run", { command: "New-Item -ItemType Directory -Force -Path '" + path.replace(/'/g, "''") + "' | Out-Null", timeoutMs: 15000 });
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function snapshot(job, workspace) {
    const root = workspace.root;
    // Before anything asks what is in the folder, make sure there IS a folder. A first build into
    // a brand-new project is the normal case, not an error case.
    const made = await ensureRoot(root);
    if (!made.ok) return { ok: false, error: "The project folder could not be created (" + made.error + "), so nothing was written." };
    try {
      /*
       * A workshop account (guestsandbox.mjs) has no command line, so git and PowerShell copies are
       * both out. It offers fs_snapshot instead, which is a real tree copy and therefore a real
       * rollback path — the thing this function's rule actually demands. Without this branch the
       * refusal below would abort every guest build before a single file was written, which is a
       * worse failure than the missing shell (Fred, 2026-07-30).
       */
      let info = null;
      try { info = await hands("node_info", {}); } catch {}
      if (info && info.sandbox === true) {
        const stamp = String(job.id).replace(/[^a-z0-9_]/gi, "");
        const snap = await hands("fs_snapshot", { path: root, stamp });
        if (!snap || snap.ok === false) return { ok: false, error: (snap && snap.error) || "The workshop could not make a restore point." };
        jobs.emit(job.id, { type: "snapshot", kind: "copy", path: snap.path,
          message: "Copied the project to a restore point before writing." });
        return { ok: true, kind: "copy", path: snap.path };
      }
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
    const written = [], unchanged = [], failed = [];
    for (const f of files) {
      try {
        const r = await hands("fs_write", { path: root + "/" + f.path, content: f.content });
        if (r && r.ok === false) failed.push({ path: f.path, reason: r.error || "the node refused the write" });
        else if (r && r.changed === false) unchanged.push(f.path);
        else { written.push(f.path); jobs.emit(job.id, { type: "file", path: f.path, bytes: f.content.length }); }
      } catch (e) { failed.push({ path: f.path, reason: String(e && e.message || e) }); }
    }
    return { written, unchanged, failed };
  }

  // Diff every written file against the manifest's pre-move contents, so the Workshop lens shows
  // what actually changed rather than an empty panel. New files diff against nothing.
  function emitDiffs(job, manifest, files, changedPaths = null) {
    const before = new Map((manifest || []).map((f) => [f.path, f.missing ? "" : (f.content || "")]));
    for (const f of files || []) {
      if (changedPaths && !changedPaths.has(f.path)) continue;
      try {
        const d = lineDiff(before.get(f.path) || "", f.content || "");
        jobs.emit(job.id, { type: "diff", path: f.path, added: d.added, removed: d.removed, diff: d.diff });
      } catch {}
    }
  }

  /*
   * INSTALL BEFORE CHECKING (Fred, 2026-07-31). A build wrote a correct project, ran `npm run
   * typecheck`, and was told 'tsc' is not recognized. All four checks failed the same way, because
   * the toolchain those scripts invoke lives in node_modules/.bin and NOTHING EVER INSTALLED IT.
   * ensureDeps existed the whole time in idesee.mjs, wired only into the preview path, so every
   * build that reached its own verification failed it on a fresh project, every time.
   *
   * Mirrors that function rather than importing it, because the engine is deliberately built from
   * `hands` alone and takes no module dependencies.
   */
  async function installDeps(job, root, pkgText) {
    let deps = null;
    try { const p = JSON.parse(pkgText || "{}"); deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) }; } catch {}
    if (!deps || !Object.keys(deps).length) return { ok: true, skipped: "no dependencies declared" };
    try {
      const ls = await hands("fs_list", { path: root });
      const names = ((ls && ls.entries) || []).map((e) => (typeof e === "string" ? e : e.name));
      if (names.includes("node_modules")) return { ok: true, skipped: "already installed" };
    } catch { /* if the listing fails, attempt the install rather than skip it */ }
    jobs.emit(job.id, { type: "run", command: "npm install", ok: true,
      output: "Installing what the project needs before checking it. This can take a few minutes the first time." });
    let r = null;
    try { r = await hands("shell_run", { command: "cd \"" + root + "\"; npm install --no-audit --no-fund", timeoutMs: 480000 }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    const code = (r && (r.code ?? r.exitCode));
    const ok = code == null ? r && r.ok !== false : Number(code) === 0;
    const out = cleanShellOutput(String((r && (r.stdout || r.output)) || "") + String((r && r.stderr) || ""));
    jobs.emit(job.id, { type: "run", command: "npm install", ok: !!ok, output: out.slice(-2500) });
    return { ok: !!ok, output: out };
  }

  async function verify(job, workspace) {
    const rootPath = workspace.root.replace(/[\\/]+$/, "");
    let pkg = "";
    try {
      const r = await hands("fs_read", { path: rootPath + "/package.json", maxBytes: 20000 });
      pkg = (r && (r.content || r.text)) || "";
    } catch {}

    /*
     * R8: discover across the whole workspace, not just the root package.json. The listing is the
     * same call the Furnace already makes, so this costs one fs_list and finds Gradle projects,
     * nested Node servers, and TypeScript that declares no check script.
     */
    let commands = [], why = "", blockers = [];
    try {
      const listed = await hands("fs_list", { path: rootPath, depth: 4, maxEntries: 1200 });
      const entries = (listed && (listed.entries || listed.files || listed.items)) || [];
      const rel = entries.map((e) => String((e && (e.path || e.name)) || e || "")
        .replace(/\\/g, "/").replace(rootPath.replace(/\\/g, "/"), "").replace(/^\/+/, "")).filter(Boolean);
      const discovered = await discoverVerificationPlan({
        entries: rel,
        readFile: async (p) => {
          if (p === "package.json" && pkg) return pkg;
          try {
            const r = await hands("fs_read", { path: rootPath + "/" + p, maxBytes: 20000 });
            return (r && (r.content || r.text)) || "";
          } catch { return ""; }
        },
      });
      commands = discovered.commands; why = discovered.why; blockers = discovered.blockers || [];
    } catch {}

    // If the listing failed entirely, fall back to the original root-package.json behaviour rather
    // than losing verification altogether.
    if (!commands.length && !blockers.length) {
      const fallback = verificationPlanFor(pkg);
      if (fallback.commands.length) { commands = fallback.commands.map((c) => ({ ...c, dir: "", needsInstall: true })); why = fallback.why; }
      else if (!why) why = fallback.why;
    }

    if (!commands.length) {
      /*
       * R7 lives in the caller: `ran: false` is now a completion blocker, not a shrug. The message
       * says what was looked for so the gap is actionable instead of mysterious.
       */
      jobs.emit(job.id, { type: "run", skipped: true, ok: false,
        message: "Nothing could be verified: " + why + ". This build cannot be called finished." });
      return { ran: false, ok: true, output: "", cmd: "", commands: [], failed: [], why, blockers };
    }
    /*
     * A workshop has no command line, so the checks cannot run. Say that plainly and count the work
     * as unverified rather than failed: an honest "nobody ran the tests" is the truth, while a red
     * failure would blame the code for the absence of a shell (Fred, 2026-07-30).
     */
    try {
      const info = await hands("node_info", {});
      if (info && info.sandbox === true) {
        jobs.emit(job.id, { type: "run", skipped: true,
          message: "The files are written, but nothing could be RUN to check them: this account builds in a workshop with no command line. "
            + "Install a Dominion node on your own computer to run " + commands.map((c) => c.name).join(", ") + " here." });
        return { ran: false, ok: true, unverified: true, output: "", cmd: "", commands: [], failed: [] };
      }
    } catch {}

    /*
     * The install runs once, here, before the first check. If it fails, the checks are not run at
     * all: four red "not recognized" lines blame the code for the absence of a toolchain, and that
     * is the confusion this whole path produced.
     */
    /*
     * R8: install per project directory. A nested server/ needs its own node_modules, and the old
     * single root install silently did nothing for it.
     */
    const installDirs = [...new Set(commands.filter((c) => c.needsInstall).map((c) => c.dir || ""))];
    for (const dir of installDirs) {
      let dirPkg = pkg;
      if (dir) {
        try {
          const r = await hands("fs_read", { path: rootPath + "/" + dir + "/package.json", maxBytes: 20000 });
          dirPkg = (r && (r.content || r.text)) || "";
        } catch { dirPkg = ""; }
      }
      if (!dirPkg) continue;
      const dep = await installDeps(job, dir ? rootPath + "/" + dir : rootPath, dirPkg);
      if (!dep.ok) {
        jobs.emit(job.id, { type: "run", ok: false, command: "npm install" + (dir ? " (" + dir + ")" : ""),
          output: "The project's dependencies did not install, so its checks could not run." });
        return { ran: false, ok: false, toolingBroken: true, output: dep.output || "npm install failed",
                 cmd: "npm install", commands: [], failed: [{ name: "install", cmd: "npm install", ok: false, output: dep.output || "" }],
                 why: "dependency install failed in " + (dir || "the project root") };
      }
    }

    const results = [];
    for (const check of commands) {
      let result;
      try {
        // No "&&": the node runs PowerShell 5.1 on Windows, where "&&" is a parse error. Each
        // discovered check is dispatched separately so every result remains attributable.
        // R8: each check runs in ITS OWN directory. A nested server's `tsc` must not be run from
        // the repository root, where there is no tsconfig.
        const r = await hands("shell_run", {
          command: "cd \"" + workspace.root + (check.dir ? "/" + check.dir : "") + "\"; " + check.cmd,
          timeoutMs: VERIFY_TIMEOUT_MS,
        });
        const rawCode = r && (r.code ?? r.exitCode);
        const hasCode = (typeof rawCode === "number" && Number.isFinite(rawCode))
          || (typeof rawCode === "string" && /^-?\d+$/.test(rawCode.trim()));
        const code = hasCode ? Number(rawCode) : null;
        const hasExplicitOk = !!r && typeof r.ok === "boolean";
        const ok = !!r && r.ok !== false && (hasCode ? code === 0 : r.ok === true);
        let output = cleanShellOutput(String((r && (r.stdout || r.output)) || "") + String((r && r.stderr) || ""));
        if (!hasCode && !hasExplicitOk) {
          output += (output ? "\n" : "") + "Verification command returned no success status or exit code.";
        } else if (r && r.ok === false && !output) {
          output = String(r.error || "The machine reported that the verification command failed.");
        }
        result = { name: check.name, cmd: check.cmd, ran: true, ok, code, output };
      } catch (e) {
        result = {
          name: check.name,
          cmd: check.cmd,
          ran: true,
          ok: false,
          code: null,
          output: String(e && e.message || e),
        };
      }
      results.push(result);
      jobs.emit(job.id, {
        type: "run",
        command: result.cmd,
        ok: result.ok,
        output: result.output.slice(-4000),
      });
    }

    const failed = results.filter((r) => !r.ok);
    /*
     * If every failure is a missing PROGRAM, the code is not implicated and a file-writing repair
     * loop has nothing it can do. Flag it so the caller reports the real blocker instead of asking
     * a model to fix a project that is not broken.
     */
    const toolingBroken = failed.length > 0 && failed.every((r) => isMissingToolFailure(r.output));
    const output = results.map((r) =>
      "[" + r.name + "] " + (r.ok ? "passed" : "failed") + (r.output ? "\n" + r.output : "")
    ).join("\n\n");
    return {
      ran: true,
      toolingBroken,
      ok: failed.length === 0,
      output,
      cmd: results.length === 1 ? results[0].cmd : results.map((r) => r.cmd).join("; "),
      commands: results,
      failed,
      why,
      blockers,
    };
  }

  /*
   * Run one move. Returns { ok, costUsd, blocked }. Metering happens in `finally`, so a move that
   * throws, is stopped, or fails verification still charges for the tokens it actually burned.
   */
  // `depth` is the split recursion guard: a move that cannot be answered atomically is halved and
  // re-run through this same path, and three levels turns a 24-file move into 3-file moves, which
  // is far past the point where the size was the problem.
  async function runMove(job, { move, workspace, assignments, goal }, depth = 0) {
    let costUsd = 0;
    try {
      let decision = router({ title: move.title, description: move.why, files: move.files }, assignments);
      if (decision.isImage || decision.model === "dominion-forge") {
        /*
         * An image-classed move cannot go to a text model: "dominion-forge" is the image engine,
         * and feeding it to the chat pipeline ends in a provider error (found live: a planner
         * move titled "Add high-quality hero image" looped a beginner through retry forever).
         * Until the Forge pipe is wired into builds, these moves run as DESIGN CODE with honest
         * placeholder art, and the card says so.
         */
        const fallbackModel = (decision.assignments && decision.assignments.design_code) || "";
        decision = { ...decision, taskClass: "design_code", model: fallbackModel,
          why: (decision.why || "") + "; image generation is a separate step, so this builds the visual with CSS or SVG placeholder art instead" };
        move = { ...move, why: (move.why ? move.why + " " : "")
          + "NOTE: do not reference image files that do not exist. Build the visual with CSS gradients or inline SVG placeholder art." };
      }
      // `why` belongs to the PLAN (what this move is for, in plain English). The router's reason
      // travels as routeWhy so the two never overwrite each other on the card.
      jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "running",
        why: move.why || "", taskClass: decision.taskClass, model: decision.model, routeWhy: decision.why });

      const manifest = await readManifest(workspace.root, move.files || []);
      const messages = buildMoveMessages({ move, manifest, workspaceName: workspace.name, goal });
      let res = null, resumeState = null;
      for (let inspectionWindow = 0; inspectionWindow < 3; inspectionWindow++) {
        res = await chat({ model: decision.model, messages, resumeState });
        costUsd += Number(res && res.costUsd) || 0;
        if (!res || !res.checkpoint || !res.resumeState) break;
        resumeState = res.resumeState;
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "running",
          message: "The bounded inspection window checkpointed; resuming from its exact tool cursors and evidence." });
      }
      if (!res || !res.ok) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: (res && res.error) || "The model call failed." });
        return { ok: false, costUsd };
      }

      let parsed = parseFileBlocks(res.content);
      // One corrective reprompt before surfacing a zero-file failure (Kimi #8): models disobey the
      // file-block format, and a beginner cannot tell "the model was sloppy" from "the product is
      // broken". Show it its own output and ask again, ONCE. A second empty answer is a real
      // failure and surfaces with a next action below.
      if (!parsed.files.length && !parsed.needs.length) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "running",
          message: "The response was not in the file format; asking once more." });
        const retry = await chat({ model: decision.model, messages: [
          ...messages,
          { role: "assistant", content: String(res.content || "").slice(0, 4000) },
          { role: "user", content: "That reply contained no file blocks, so nothing could be written. Respond ONLY with fenced file blocks, each opening ```<path> on its own line and closing ``` at the start of a line. No prose outside the blocks." },
        ] });
        costUsd += Number(retry && retry.costUsd) || 0;
        if (retry && retry.ok) { const rp = parseFileBlocks(retry.content); if (rp.files.length) { res = retry; parsed = rp; } }
      }
      let coverage = fileCoverage(move.files || [], parsed.files);
      if (parsed.files.length && !parsed.truncated && !coverage.complete) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "running",
          message: "The response omitted " + coverage.missing.length + " planned file(s); asking once for an atomic result." });
        const retry = await chat({ model: decision.model, messages: [
          ...messages,
          { role: "assistant", content: String(res.content || "").slice(0, 12000) },
          { role: "user", content:
            "The move is atomic, but your response omitted these planned files: " + coverage.missing.join(", ") + ". " +
            "Return ONLY complete fenced path blocks for EVERY file in the move. Include a byte-identical complete block if inspection proves one needs no edit." },
        ] });
        costUsd += Number(retry && retry.costUsd) || 0;
        if (retry && retry.ok) {
          res = retry;
          parsed = parseFileBlocks(retry.content);
          coverage = fileCoverage(move.files || [], parsed.files);
        }
      }
      for (const bad of parsed.issues) jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "warned", message: bad.path + ": " + bad.reason });
      if (!parsed.files.length) {
        // A surfaced error carries a NEXT ACTION, never just a verdict (Kimi: flawless fails with
        // instructions). nextAction rides the event so the surface can offer the button.
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: parsed.needs.length
            ? "It needs a file that was not in this move's list: " + parsed.needs.join(", ") + ". Try again, or simplify this step."
            : "The model did not return any files to write, even after a retry. Try again, or simplify the ask.",
          nextAction: parsed.needs.length ? "retry" : "retry_or_simplify" });
        return { ok: false, costUsd };
      }
      if (!coverage.complete) {
        /*
         * SPLIT RATHER THAN DISCARD. Atomicity is right: half a move leaves a project in a state
         * nobody asked for. But it was being enforced by throwing away everything the model DID
         * produce, and the odds of getting every file in one reply fall off a cliff as the list
         * grows. Fred watched a 17-file repair move return partial twice and write nothing at all,
         * which reads as the build refusing to try.
         *
         * A move too big to answer atomically is now RE-RUN IN HALVES, each half atomic in its own
         * right, so the guarantee is kept while the work actually lands. Halving recurses naturally
         * through this same path, and the floor is a single file: if one file alone cannot be
         * returned complete, the model genuinely cannot do it and the honest failure stands.
         */
        const planned = (move.files || []);
        if (planned.length > SPLITTABLE_MOVE_FILES && depth < 3) {
          const mid = Math.ceil(planned.length / 2);
          const halves = [planned.slice(0, mid), planned.slice(mid)];
          jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "running",
            message: "That move was too large to return in one piece, so it is being split into "
              + halves.length + " smaller moves that each stand on their own." });
          let splitCost = costUsd, allCovered = [];
          for (let h = 0; h < halves.length; h++) {
            const sub = await runMove(job, {
              move: { ...move, id: move.id + "-part" + (h + 1), files: halves[h],
                      title: move.title + " (part " + (h + 1) + " of " + halves.length + ")" },
              workspace, assignments, goal,
            }, depth + 1);
            splitCost += Number(sub && sub.costUsd) || 0;
            if (!sub || !sub.ok) return { ok: false, costUsd: splitCost, missing: (sub && sub.missing) || halves[h] };
            allCovered = allCovered.concat(sub.covered || []);
          }
          return { ok: true, costUsd: splitCost, covered: allCovered };
        }
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: "The model still omitted planned files: " + coverage.missing.join(", ") +
            ". Nothing was written because a partial move could leave the project inconsistent.",
          nextAction: "retry" });
        return { ok: false, costUsd, missing: coverage.missing };
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

      const { written, unchanged, failed } = await writeFiles(job, workspace, parsed.files);
      for (const f of failed) jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "warned", message: f.path + ": " + f.reason });
      emitDiffs(job, manifest, parsed.files, new Set(written));
      if (failed.length) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: failed.length + " file write" + (failed.length === 1 ? "" : "s") +
            " failed. The move remains incomplete; successful sibling writes are preserved in the restore point.",
          nextAction: "retry" });
        return { ok: false, costUsd, wroteAnyway: written.length > 0, failed };
      }
      if (!written.length && !failed.length) {
        jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
          message: "The model returned files, but every write was byte-for-byte unchanged. Nothing was implemented. Reread the current files and retry with a specific change.",
          unchanged, nextAction: "retry_or_simplify" });
        return { ok: false, costUsd, unchanged };
      }

      const v = await verify(job, workspace);
      if (v.ran && !v.ok) {
        // Diagnose and retry several times before asking a human. Each attempt receives the newest
        // check evidence and must regenerate complete atomic files; repeated identical/no-file
        // replies are failures, never a route to "done".
        let check = v;
        let priorContent = res.content;
        let repaired = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "repairing",
            message: "Verification failed; repair attempt " + attempt + " of 3." });
          const repair = await chat({ model: decision.model, messages: [
            ...messages,
            { role: "assistant", content: String(priorContent || "") },
            { role: "user", content:
              "Verification failed. Diagnose the actual error, change approach if the last attempt did not help, and return the complete corrected files. " +
              "Do not merely explain the failure.\n\nLATEST CHECK OUTPUT:\n" + String(check.output || "").slice(-12000) },
          ] });
          costUsd += Number(repair && repair.costUsd) || 0;
          if (!repair || !repair.ok) continue;
          priorContent = repair.content;
          const again = parseFileBlocks(repair.content);
          const carve2 = carveOutReport(again.files);
          if (carve2) {
            jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "blocked", message: carve2.message });
            return { ok: false, costUsd, blocked: true };
          }
          if (!again.files.length || again.truncated) continue;
          const repairWrite = await writeFiles(job, workspace, again.files);
          emitDiffs(job, manifest, again.files, new Set(repairWrite.written));
          if (repairWrite.failed.length || !repairWrite.written.length) continue;
          check = await verify(job, workspace);
          if (check.ok) { repaired = true; break; }
        }
        if (!repaired) {
          jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "failed",
            message: "Verification still fails after three adaptive repair attempts. The latest raw check output is above; the build remains incomplete.",
            nextAction: "retry_with_guidance" });
          return { ok: false, costUsd, wroteAnyway: true, verification: check };
        }
      }

      jobs.emit(job.id, { type: "move", id: move.id, title: move.title, state: "done", files: written.length });
      return { ok: true, costUsd, written, covered: parsed.files.map((file) => file.path) };
    } finally {
      // FINALLY, always. Aborted and failed moves still burned tokens, and pretending otherwise is
      // the exact leak the chat path has (its early returns skip metering entirely).
      if (costUsd > 0) { try { await meter(costUsd); } catch (e) { log("[ide] meter failed: " + (e && e.message)); } }
      if (costUsd > 0) jobs.emit(job.id, { type: "cost", usd: Math.round(costUsd * 1e6) / 1e6, move: move.id });
    }
  }

  return { runMove, readManifest, snapshot, verify, writeFiles, ensureRoot };
}
