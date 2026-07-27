/*
 * Adopt Existing Project: the read-only scan and the state-of-the-app brief.
 *   SOW:        docs/ADOPT-EXISTING-SOW.md
 *   Build pack: docs/ADOPT-BUILD.md
 *
 * A person points a workspace at an app they already started, and this module walks the tree
 * through their own hands node, reads the manifests and a bounded sample of source, and states
 * what is actually there: built, half-built, missing. Nothing is executed and nothing is written.
 * The brief is DETERMINISTIC by design (no model call): a composer that only restates observed
 * facts cannot invent progress, which is the honest-numbers doctrine applied to adoption. It also
 * means no file content leaves the user's machine at scan time, and the scan costs nothing.
 *
 * Dependency-injected like ide.mjs and idesee.mjs: `hands` is async (tool, args) -> node result,
 * so the whole thing tests with a fake node and no server.
 */
import { runPlanFor } from "./idesee.mjs";

/*
 * The ceilings (Fred's ruling 2026-07-26: "never limit an app build"). These are NOT sanitizer
 * limits on legitimate work: they are sized so no honest app ever meets them, including big
 * monorepos. This repo itself tripped the first, miserly numbers during verification, which is
 * exactly the failure the ruling forbids. What remains is disaster protection only: a workspace
 * pointed at a whole drive, or a truly pathological tree, stops at these ceilings instead of
 * grinding the user's machine and timing the request out. A ceiling that trips is still REPORTED
 * in the facts, so the brief says "at least" instead of pretending the tally is complete.
 */
export const ADOPT_MAX_DEPTH = 8;         // levels below the root the walk descends
export const ADOPT_MAX_DIRS = 500;        // directories listed (junk dirs excluded from the count)
export const ADOPT_MAX_FILES = 12_000;    // files catalogued before the walk stops
export const ADOPT_MAX_READ_BYTES = 24_000;     // per file read
export const ADOPT_MAX_TOTAL_BYTES = 1_200_000; // across every read of the scan
export const ADOPT_MAX_SAMPLES = 48;      // architecture-ranked source files retained for analysis
export const ADOPT_WALK_PARALLEL = 6;     // fs_list calls in flight (hands correlation ids make
                                          // parallel READ dispatch safe; writes are another story)
export const ADOPT_BRIEF_CHARS = 3600;    // rides the 4000-char chat sanitizer with room to spare

// Folders that are machinery, caches or third-party code: walking them would burn the whole
// dir budget saying nothing about the user's own work.
export const ADOPT_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", ".output", ".vercel", ".turbo",
  "vendor", "__pycache__", ".venv", "venv", "coverage", ".cache", ".svelte-kit", ".idea",
  ".vscode", "target", "bin", "obj", ".dominion-snapshots", ".snapshots", ".devdata",
]);

// Extensions that count as source for the sample reads.
const CODE_EXT = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte", "py", "rb", "go", "rs", "php",
  "java", "cs", "css", "scss", "html", "sql",
]);

const MANIFESTS = [
  "package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml",
  "composer.json", "Gemfile",
];

// Explicit engineering markers, counted per sampled file. Requiring the conventional trailing
// colon avoids counting code that implements a TODO detector or prose that merely discusses one.
const TODO_RE = /(?:^|\n)\s*(?:(?:\/\/|#|\/\*+|\*|<!--|--)\s*)?\b(TODO|FIXME|HACK|XXX|PLACEHOLDER)\b(?:\([^)]*\))?\s*:/gim;

// What a dependency name reveals about the stack. First match per manifest wins the headline;
// all matches are reported.
const FRAMEWORK_RULES = [
  { dep: "next", label: "Next.js" },
  { dep: "react", label: "React" },
  { dep: "vue", label: "Vue" },
  { dep: "svelte", label: "Svelte" },
  { dep: "express", label: "Express" },
  { dep: "fastify", label: "Fastify" },
  { dep: "electron", label: "Electron" },
  { dep: "vite", label: "Vite" },
];
const PY_RULES = [
  { dep: "django", label: "Django" },
  { dep: "flask", label: "Flask" },
  { dep: "fastapi", label: "FastAPI" },
];

const lower = (s) => String(s || "").toLowerCase();
const shouldSkipDir = (name) => {
  const n = lower(name);
  return ADOPT_SKIP_DIRS.has(n) || /^\.devdata(?:-|$)/.test(n) || /^\.snapshots?(?:-|$)/.test(n);
};
const isTestPath = (rel) => /(^|\/)(tests?|__tests__|spec|fixtures?|mocks?)(\/|$)/i.test(rel) ||
  /(\.|_)(test|spec)\.[a-z0-9]+$/i.test(rel) || /(^|\/)test_[^/]+$/i.test(rel);
const extOf = (name) => {
  const i = String(name).lastIndexOf(".");
  return i > 0 ? lower(String(name).slice(i + 1)) : "";
};

export function createAdoptScanner({ hands } = {}) {
  if (!hands) throw new Error("createAdoptScanner needs hands");

  /*
   * Walk the tree breadth-first under the root. One fs_list per directory, every cap enforced
   * here rather than trusted to the node. A THROW from the dispatcher on the very first call
   * means the machine is unreachable (offline); a thrown call later aborts the walk and the scan
   * says so instead of presenting a half-walk as the whole truth.
   */
  async function walk(root) {
    const cleanRoot = String(root || "").replace(/[\\/]+$/, "");
    const files = [];       // { rel, name, size, depth }
    const skipped = [];     // junk dir names seen (unique)
    const topDirs = [];     // first-level folder names, for the layout line
    let dirsVisited = 0, truncated = false, aborted = "";

    /*
     * Breadth-first in PARALLEL BATCHES (Fred's ruling: a real app scans completely, so the
     * ceilings are high and the walk must stay fast under them). Each fs_list is a round trip
     * over the hands tunnel; sequentially, five hundred directories would take the better part
     * of a minute on a slow link. Six in flight cuts that to seconds. Reads are safe to
     * parallelise on the hub (correlation ids); nothing here writes.
     */
    let queue = [{ path: cleanRoot, rel: "", depth: 0 }];
    while (queue.length && !aborted) {
      if (dirsVisited >= ADOPT_MAX_DIRS) { truncated = true; break; }
      const batch = queue.splice(0, Math.min(ADOPT_WALK_PARALLEL, ADOPT_MAX_DIRS - dirsVisited));
      const results = await Promise.all(batch.map(async (cur) => {
        try { return { cur, r: await hands("fs_list", { path: cur.path }) }; }
        catch { return { cur, threw: true }; }
      }));
      for (const { cur, r, threw } of results) {
        if (threw) {
          if (dirsVisited === 0) return { offline: true, error: "The computer that holds this app is not reachable right now." };
          aborted = "the connection to the computer dropped mid-scan";
          break;
        }
        if (!r || r.ok === false) {
          // The node refused (outside its roots, or a carve-out) or errored. On the root that is
          // the whole answer; deeper in, note it and keep walking what we may see. Some
          // dispatchers THROW when no machine is connected (the guest hub) and some RETURN an
          // ok:false result saying so (the owner hub, seen live on devboot), so connectivity-
          // shaped messages map to offline too; the caller's wording depends on that flag.
          if (dirsVisited === 0) {
            const msg = (r && (r.reason || r.error)) || "That folder could not be read.";
            const refused = !!(r && r.refused);
            const offline = !refused && /no machine|not connected|not reachable|offline|hands node/i.test(msg);
            return { error: msg, refused, offline };
          }
          dirsVisited++;
          continue;
        }
        dirsVisited++;
        for (const e of Array.isArray(r.entries) ? r.entries : []) {
          const name = typeof e === "string" ? e : e && e.name;
          if (!name) continue;
          const type = typeof e === "string" ? "file" : e.type;
          const rel = cur.rel ? cur.rel + "/" + name : name;
          if (type === "dir") {
            // The layout line shows the person's OWN folders; machinery and hidden dirs are noise.
            if (cur.depth === 0 && !shouldSkipDir(name) && !name.startsWith(".")) topDirs.push(name);
            if (shouldSkipDir(name)) { if (!skipped.includes(name)) skipped.push(name); continue; }
            if (cur.depth + 1 < ADOPT_MAX_DEPTH) queue.push({ path: cur.path + "/" + name, rel, depth: cur.depth + 1 });
            else truncated = true;
          } else {
            if (files.length >= ADOPT_MAX_FILES) { truncated = true; continue; }
            files.push({ rel, name, size: (e && typeof e.size === "number") ? e.size : 0, depth: cur.depth });
          }
        }
      }
    }
    if (queue.length) truncated = true;
    return { root: cleanRoot, files, skipped, topDirs, dirsVisited, truncated, aborted };
  }

  // One bounded read. Failures (too big, vanished, refused) return "" rather than sinking the scan.
  async function readCapped(path, budget) {
    if (budget.spent >= ADOPT_MAX_TOTAL_BYTES) return "";
    try {
      // partial:true asks hands/2+ for a bounded page instead of refusing a large source file.
      const r = await hands("fs_read", { path, maxBytes: ADOPT_MAX_READ_BYTES, offset: 0, partial: true });
      const text = (r && r.ok !== false && (r.text || r.content)) || "";
      budget.spent += text.length;
      return String(text);
    } catch { return ""; }
  }

  async function scan(root) {
    const w = await walk(root);
    if (w.error || w.offline) return { ok: false, error: w.error, offline: !!w.offline, refused: !!w.refused };

    const budget = { spent: 0 };
    // DEEP ANALYSIS material (Fred, 2026-07-26: the first brief "just said the files existed").
    // Every file text the scanner reads is now RETAINED, capped per-file and in total, so a model
    // can read the actual code and say what the app DOES — not merely that it exists.
    const samples = [];
    let sampleChars = 0;
    const keep = (rel, text) => {
      if (!text || sampleChars >= 180000 || samples.some((s) => lower(s.path) === lower(rel))) return;
      const t = String(text).slice(0, 12000);
      samples.push({ path: rel, text: t });
      sampleChars += t.length;
    };
    const has = (name) => w.files.some((f) => f.depth === 0 && lower(f.name) === lower(name));
    const fileAt = (rel) => w.files.find((f) => lower(f.rel) === lower(rel));

    // Manifests and the README, root level only: that is where honest projects keep them.
    const manifests = [];
    let pkgText = "", pkg = null;
    for (const name of MANIFESTS) {
      if (!has(name)) continue;
      const text = await readCapped(w.root + "/" + name, budget);
      manifests.push({ name, bytes: text.length });
      if (name === "package.json") {
        pkgText = text;
        try { pkg = JSON.parse(text); } catch { pkg = null; }
      }
      keep(name, text);
      if (name === "requirements.txt" || name === "pyproject.toml") manifests[manifests.length - 1].text = text.slice(0, 4000);
    }
    const rootReadme = w.files.find((f) => f.depth === 0 && /^readme([.]|$)/i.test(f.name));
    if (rootReadme) keep(rootReadme.rel, await readCapped(w.root + "/" + rootReadme.rel, budget));

    // Stack detection from what the manifests actually declare.
    const frameworks = [];
    let declaresDeps = false;
    if (pkg) {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      declaresDeps = Object.keys(deps).length > 0;
      for (const rule of FRAMEWORK_RULES) if (deps[rule.dep]) frameworks.push(rule.label);
      if (!frameworks.length && declaresDeps) frameworks.push("Node.js");
    }
    for (const m of manifests) {
      if (m.name === "requirements.txt" || m.name === "pyproject.toml") {
        const t = lower(m.text || "");
        for (const rule of PY_RULES) if (t.includes(rule.dep)) frameworks.push(rule.label);
        if (!PY_RULES.some((r) => t.includes(r.dep))) frameworks.push("Python");
      }
      if (m.name === "go.mod") frameworks.push("Go");
      if (m.name === "Cargo.toml") frameworks.push("Rust");
      if (m.name === "composer.json") frameworks.push("PHP");
      if (m.name === "Gemfile") frameworks.push("Ruby");
    }

    // What runs: the same verdict the live preview uses, so adoption and preview never disagree.
    const runs = runPlanFor(pkgText, { hasIndexHtml: has("index.html") });

    // Entry points worth reading: what package.json names and invokes, then the classic suspects.
    const entryCandidates = [];
    if (pkg && typeof pkg.main === "string") entryCandidates.push(pkg.main.replace(/^[.][/]/, ""));
    if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
      // Runtime scripts reveal entry points; test/lint/format scripts reveal tooling, not the app.
      const runtimeKeys = /^(start|dev|serve|preview|build|prod|production)$/i;
      const scriptText = Object.entries(pkg.scripts).filter(([k, v]) => runtimeKeys.test(k) && typeof v === "string")
        .map(([, v]) => v).join("\n").replaceAll("\\", "/");
      for (const f of w.files) {
        if (f.depth <= 3 && CODE_EXT.has(extOf(f.name)) && scriptText.includes(f.rel.replaceAll("\\", "/")) &&
            !entryCandidates.some((p) => lower(p) === lower(f.rel))) entryCandidates.push(f.rel);
      }
    }
    for (const cand of ["server.js", "server.mjs", "app.js", "app.mjs", "index.js", "index.mjs",
                        "src/index.js", "src/index.ts", "src/main.js", "src/main.ts",
                        "src/App.jsx", "src/App.tsx", "public/index.html", "public/app.js",
                        "main.py", "app.py", "src/main.py", "index.html"]) {
      if (entryCandidates.length >= 12) break;
      if (fileAt(cand) && !entryCandidates.includes(cand)) entryCandidates.push(cand);
    }
    const entries = [];
    const todoFiles = [];
    const stubs = [];
    let todoTotal = 0;
    const noteSignals = (rel, text) => {
      // Test fixtures routinely contain the literal strings TODO, "not implemented", and
      // placeholders to verify detectors. They are evidence about tests, not unfinished product.
      if (!text || isTestPath(rel)) return;
      const hits = text.match(TODO_RE);
      if (hits && hits.length) { todoTotal += hits.length; todoFiles.push({ path: rel, count: hits.length }); }
      if (/not (yet )?implemented|coming soon/i.test(text)) stubs.push({ path: rel, reason: "says it is not implemented yet" });
    };
    for (const rel of entryCandidates) {
      const f = fileAt(rel);
      if (!f) continue;
      const text = await readCapped(w.root + "/" + rel, budget);
      if (text) { entries.push({ path: rel, bytes: f.size }); noteSignals(rel, text); keep(rel, text); }
    }

    // Rank by architectural value. The previous smallest-file-first rule filled the context with
    // test fixtures and loaders while excluding large server/client entry points — exactly the
    // opposite of what an adoption analyst needs.
    const sampled = new Set(entryCandidates.map(lower));
    const architectureScore = (f) => {
      const rel = lower(f.rel);
      const name = lower(f.name);
      const ext = extOf(name);
      let score = Math.max(0, 30 - (f.depth * 4));
      if (/^(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs)$/.test(ext)) score += 25;
      if (/^(css|scss|sass|less)$/.test(ext)) score -= 15;
      if (/^(server|app|main|index|router|routes?|schema|database|db|auth|config)\./.test(name)) score += 55;
      if (/^(ide|hands|memory|connectors?|billing|router|engine|models?)/.test(name)) score += 25;
      if (/(^|\/)(src|server|api|routes?|controllers?|services?|models?|database|db|auth|connectors?|tools?|public)(\/|$)/.test(rel)) score += 30;
      if (/(route|schema|migration|auth|connector|provider|tool|workspace|billing|deploy|preview)/.test(rel)) score += 22;
      if (/^(package\.json|dockerfile|compose\.ya?ml)$/.test(name)) score += 18;
      if (isTestPath(rel)) score -= 90;
      if (/(^|\/)(examples?|docs?|assets?|generated)(\/|$)/.test(rel)) score -= 20;
      if (/(^|\/)\./.test(rel)) score -= 40;
      return score;
    };
    const candidates = w.files
      .filter((f) => CODE_EXT.has(extOf(f.name)) && !sampled.has(lower(f.rel)) && f.size > 0)
      .sort((a, b) => architectureScore(b) - architectureScore(a) || a.size - b.size || a.rel.localeCompare(b.rel))
      .slice(0, ADOPT_MAX_SAMPLES);
    for (const f of candidates) {
      const text = await readCapped(w.root + "/" + f.rel, budget);
      noteSignals(f.rel, text);
      keep(f.rel, text);
      if (f.size === 0) stubs.push({ path: f.rel, reason: "empty file" });
    }
    for (const f of w.files) {
      if (f.size === 0 && CODE_EXT.has(extOf(f.name)) && !stubs.some((s) => s.path === f.rel)) {
        stubs.push({ path: f.rel, reason: "empty file" });
        if (stubs.length >= 12) break;
      }
    }

    // Language tally by extension, code files only.
    const languages = {};
    for (const f of w.files) {
      const ext = extOf(f.name);
      if (CODE_EXT.has(ext)) languages[ext] = (languages[ext] || 0) + 1;
    }

    const facts = {
      root: w.root,
      counts: { dirs: w.dirsVisited, files: w.files.length, truncated: w.truncated, aborted: w.aborted || "" },
      topDirs: w.topDirs.slice(0, 20),
      skippedDirs: w.skipped,
      manifests: manifests.map((m) => m.name),
      frameworks: [...new Set(frameworks)],
      runs,
      entries,
      git: w.skipped.includes(".git") || !!w.files.some((f) => lower(f.rel).startsWith(".git/")),
      readme: !!w.files.some((f) => f.depth === 0 && /^readme([.]|$)/i.test(f.name)),
      lockfile: has("package-lock.json") || has("pnpm-lock.yaml") || has("yarn.lock"),
      // Only meaningful when the manifest declares dependencies; a zero-dep project with no
      // node_modules is complete, and telling it otherwise would be invented un-progress.
      declaresDeps,
      depsInstalled: w.skipped.includes("node_modules"),
      envExample: has(".env.example") || has(".env.sample"),
      tests: {
        // tests/ dirs, dot-style names, AND underscore-style names (this very repo's idiom is
        // *_test.mjs; a scan that told it "no tests" over 60 suites taught this line).
        present: w.files.some((f) => /(^|\/)(tests?|__tests__|spec)\//i.test(f.rel) || /(\.|_)(test|spec)\.[a-z]+$/i.test(f.name) || /^test_[^/]+$/i.test(f.name)),
      },
      todos: { count: todoTotal, files: todoFiles.slice(0, 8) },
      stubs: stubs.slice(0, 8),
      languages,
    };
    // The catalog lets the analysis agent request additional files by name without another full
    // tree walk. Contents are still read lazily through bounded, read-only workspace tools.
    const catalog = w.files.map((f) => ({ path: f.rel, bytes: f.size }));
    return { ok: true, facts, samples, catalog };
  }

  return { scan };
}

/* ============================================================================================
   The deep-analysis prompt (Fred, 2026-07-26). The deterministic brief inventories; THIS is the
   comprehension pass: a model reads the retained samples and produces the rundown Fred specified —
   what the app does, its state, dependencies, features, what is left to build, obvious gaps —
   and provides a production roadmap. Grounding rule is explicit: only claim what the samples
   show; name the file when claiming.
   ============================================================================================ */
export function analysisPrompt({ name = "", facts = {}, samples = [], catalog = [] } = {}) {
  const body = samples.map((s) => "=== " + s.path + " ===\n" + s.text).join("\n\n").slice(0, 100000);
  return "You are analyzing a partially completed app called " + (name || "this app") + " that the user wants finished. " +
    "Below are REAL file contents read from their machine, plus a structural inventory. Write an APP ANALYSIS with exactly these sections, in this order, markdown headed:\n" +
    "1. WHAT IT DOES — the app's purpose and how it works, from the actual code.\n" +
    "2. CURRENT STATE — what genuinely works vs half-built vs broken. Cite file names.\n" +
    "3. DEPENDENCIES — what it relies on (frameworks, services, packages) and whether they are installed/configured.\n" +
    "4. FEATURES PRESENT — a plain list of features that exist in the code.\n" +
    "5. LEFT TO BUILD — what the code clearly intends but has not finished.\n" +
    "6. OBVIOUS GAPS — missing essentials (auth, error handling, tests, deployment, data persistence, whatever applies).\n" +
    "7. PRODUCTION ROADMAP — an ordered, concrete plan from the present state to production. Include priorities, dependencies, acceptance checks, and release risks.\n" +
    "Ground every claim in the files shown; name the file. If the samples do not show something, say so plainly rather than guessing. " +
    "Do not ask what to do next. Deliver the complete analysis and roadmap in this response.\n\n" +
    "STRUCTURAL INVENTORY:\n" + JSON.stringify({ counts: facts.counts, topDirs: facts.topDirs, frameworks: facts.frameworks, manifests: facts.manifests, entries: facts.entries, runs: facts.runs, tests: facts.tests, todos: facts.todos, stubs: facts.stubs, languages: facts.languages }).slice(0, 4000) +
    "\n\nFULL FILE CATALOG (path and byte size; use the workspace tools to inspect relevant files not already shown):\n" +
    JSON.stringify(catalog).slice(0, 30000) +
    "\n\nFILE CONTENTS:\n" + body;
}

/* ============================================================================================
   The brief composer. Pure function over facts; every sentence traces to an observation. The
   voice is the honest inventory the SOW ordered: built, half-built, missing, and a plain line
   admitting the limits of a read-only look.
   ============================================================================================ */
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

export function composeBrief(facts, { name = "" } = {}) {
  const f = facts || {};
  const c = f.counts || {};
  const out = [];
  const atLeast = c.truncated ? "at least " : "";

  const stack = (f.frameworks && f.frameworks.length) ? f.frameworks.join(" + ") : "no framework I recognize";
  out.push("STATE OF THE APP" + (name ? ": " + name : ""));
  out.push("");
  out.push("What is here: " + atLeast + plural(c.files || 0, "file") +
    (f.topDirs && f.topDirs.length ? " across " + f.topDirs.slice(0, 8).join(", ") + (f.topDirs.length > 8 ? " and more" : "") : "") +
    ". Stack: " + stack + ".");

  const langs = Object.entries(f.languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([ext, n]) => "." + ext + " (" + n + ")").join(", ");
  if (langs) out.push("Code by type: " + langs + ".");

  const runs = f.runs || {};
  out.push("What runs: " + (runs.mode
    ? (runs.mode === "static" ? "it serves as a static page (" + runs.why + ")." : runs.command + " (" + runs.why + ").")
    : "nothing starts yet (" + (runs.why || "no start script and no index.html") + ")."));

  // Built: the signals that real work exists.
  const built = [];
  if (f.manifests && f.manifests.length) built.push("project manifest" + (f.manifests.length > 1 ? "s" : "") + " (" + f.manifests.join(", ") + ")");
  if (f.entries && f.entries.length) built.push("entry point" + (f.entries.length > 1 ? "s" : "") + " " + f.entries.map((e) => e.path).slice(0, 4).join(", "));
  if (f.declaresDeps && f.depsInstalled) built.push("dependencies installed");
  if (f.git) built.push("a git history");
  if (f.readme) built.push("a README");
  if (f.tests && f.tests.present) built.push("tests");
  out.push("");
  out.push("Built: " + (built.length ? built.join("; ") + "." : "very little I can point to yet."));

  // Half-built: unfinished-work signals, named by file so nothing is vague.
  const half = [];
  if (f.todos && f.todos.count) {
    half.push(plural(f.todos.count, "unfinished-work marker") + " (TODO, FIXME, placeholder)" +
      (f.todos.files && f.todos.files.length ? " in " + f.todos.files.map((t) => t.path).slice(0, 5).join(", ") : ""));
  }
  for (const s of (f.stubs || []).slice(0, 5)) half.push(s.path + " (" + s.reason + ")");
  out.push("Half-built: " + (half.length ? half.join("; ") + "." : "no explicit unfinished markers in what I sampled."));

  // Missing: the absences that matter for finishing.
  const missing = [];
  if (!(f.tests && f.tests.present)) missing.push("no tests");
  if (!f.readme) missing.push("no README");
  if (f.declaresDeps && !f.depsInstalled) missing.push("dependencies not installed");
  if (f.declaresDeps && !f.lockfile) missing.push("no lockfile");
  if (!f.git) missing.push("no git history");
  if (!(runs && runs.mode)) missing.push("no way to start it");
  out.push("Missing: " + (missing.length ? missing.join("; ") + "." : "nothing obvious at this level."));

  if (c.truncated || c.aborted) {
    out.push("");
    out.push("Scan limits: " + (c.aborted ? c.aborted + "; " : "") +
      (c.truncated ? "the tree is bigger than the scan window, so the tallies above are floors, honestly marked." : "").trim());
  }
  out.push("");
  out.push("This comes from reading the files, not from running anything, so behavior and breakage are still unproven.");
  out.push("The detailed analysis and production roadmap follow.");

  let text = out.join("\n");
  if (text.length > ADOPT_BRIEF_CHARS) {
    text = text.slice(0, ADOPT_BRIEF_CHARS - 60).replace(/\n[^\n]*$/, "") +
      "\n(Trimmed to fit; the full facts are in the scan itself.)";
  }
  return text;
}
