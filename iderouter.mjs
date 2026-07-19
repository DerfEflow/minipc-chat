/*
 * Dominion Works: the task router.
 *   SOW docs/IDE-MODE-ROADMAP.md (Phase 3) - build pack docs/IDE-MODE-BUILD.md
 *
 * THE POINT: you assign models ONCE, by kind of work, and never think about it again. The router
 * decides which kind a move is. Design goes to OpenAI, grunt work goes somewhere cheap, and real
 * engineering goes wherever you said.
 *
 * DETERMINISTIC FIRST, ALWAYS. Classification is a table of file extensions, path shapes, and
 * keywords. It costs nothing, it is instant, and it is inspectable. Only a genuinely ambiguous
 * move gets a classifier call, and even then it is the cheapest model available. This mirrors
 * heuristicRoute in server.mjs, which was built on the same conviction: spending a model call to
 * decide how to spend a model call is how these systems get slow and expensive.
 *
 * EVERY DECISION CARRIES ITS REASON. `why` is written for a human to read in the UI, because a
 * router the user cannot audit is a router the user cannot trust.
 *
 * Pure module: no imports, no io, no provider calls. The classifier is injected by the caller.
 */

export const TASK_CLASSES = ["design_visual", "design_code", "build_code", "mechanical", "review"];

// What each class is FOR, in the words the Assignment Board shows.
export const CLASS_INFO = {
  design_visual: { label: "Visual design", blurb: "Logos, heroes, icons, textures, illustration." },
  design_code:   { label: "Design and layout", blurb: "CSS, components, page structure, wording people read." },
  build_code:    { label: "Engineering", blurb: "Logic, servers, data, integrations. The hard part." },
  mechanical:    { label: "Mechanical", blurb: "Config, renames, boilerplate, formatting, docs." },
  review:        { label: "Review", blurb: "Checking the work: tests, verification, second opinions." },
};

// The image engine is NOT a chat model and is never displayed as one (brand lock: the image cell
// reads DOMINION FORGE, never a provider model name).
export const IMAGE_ENGINE = "dominion-forge";

/*
 * Shipping defaults (Fred's rulings 2026-07-19).
 *   ""  means "use this workspace's chosen model", so a user who picks one model gets one model.
 * design_visual is pinned to the image engine because no text model can return a PNG.
 */
export const DEFAULT_ASSIGNMENTS = {
  design_visual: IMAGE_ENGINE,
  design_code: "openai/gpt-5.6-terra",
  build_code: "",
  mechanical: "deepseek/deepseek-v4-flash",
  review: "",
};

/*
 * One-click presets. The board is still fully manual; these are just the two starting points
 * worth having on tap.
 *
 * KIMI (Fred, 2026-07-19): Kimi K3 takes BOTH the engineering and the design-and-layout work.
 * At $3/$15 against Sol's $5/$30 with a 1M context that is a genuinely strong trade.
 *
 * Two things this preset deliberately does NOT do:
 *   - It leaves mechanical work on the cheap model. Kimi K3's reasoning is MANDATORY at "max"
 *     (models.catalog.mjs), so every call pays for reasoning tokens. That is what you want on
 *     hard problems and pure waste on renaming a file or bumping a version.
 *   - It does not touch visual design. Kimi K3 reads images; it cannot draw one. Pictures stay
 *     with the image engine, which is also what Fred asked for.
 */
export const PRESETS = [
  {
    id: "balanced",
    label: "Balanced",
    blurb: "Design to GPT-5.6 Terra, engineering to your main model, grunt work kept cheap.",
    assignments: { design_code: "openai/gpt-5.6-terra", build_code: "", mechanical: "deepseek/deepseek-v4-flash", review: "" },
  },
  {
    id: "kimi",
    label: "Kimi K3 for code and design",
    blurb: "One frontier reasoner for both the engineering and the look. Pictures still come from Dominion Forge, and renames stay on the cheap model.",
    assignments: { design_code: "moonshotai/kimi-k3", build_code: "moonshotai/kimi-k3", mechanical: "deepseek/deepseek-v4-flash", review: "moonshotai/kimi-k3" },
  },
];

export const presetById = (id) => PRESETS.find((p) => p.id === String(id || "")) || null;

// Confidence bands, same shape as server.mjs routeDecision.
export const CONF_STRONG = 0.9, CONF_OK = 0.7, CONF_WEAK = 0.5;
export const CLASSIFIER_THRESHOLD = 0.7;   // below this, ask the cheap classifier

const EXT = {
  design_visual: ["png", "jpg", "jpeg", "webp", "gif", "ico", "avif", "bmp", "tif", "tiff"],
  design_code: ["css", "scss", "sass", "less", "styl", "html", "htm", "svg", "vue", "svelte", "astro"],
  build_code: ["ts", "js", "mjs", "cjs", "py", "go", "rs", "java", "rb", "php", "sql", "kt", "swift", "c", "cpp", "cs", "sh", "ps1"],
  mechanical: ["json", "yml", "yaml", "toml", "ini", "env", "lock", "cfg", "conf", "md", "txt", "gitignore", "editorconfig", "npmrc"],
};

// .jsx/.tsx genuinely straddle design and engineering, so the PATH decides. A component under
// /ui/ is design work; the same extension under /api/ is not.
const STRADDLE_EXT = new Set(["jsx", "tsx"]);
const DESIGN_DIR = /(^|[\\/])(components?|ui|views?|pages?|layouts?|styles?|theme|design|widgets?|partials?)[\\/]/i;
const BUILD_DIR = /(^|[\\/])(api|server|backend|lib|core|db|database|models?|services?|handlers?|routes?|migrations?|workers?)[\\/]/i;
const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[a-z0-9]+$/i;

const KEYWORDS = {
  design_visual: /\b(logo|icon set|favicon|hero image|illustration|artwork|texture|banner|og[- ]?image|thumbnail|mockup image|photo|wallpaper|generate an? image|picture)\b/i,
  design_code: /\b(css|style|styling|stylesheet|layout|responsive|theme|dark mode|light mode|typography|font|spacing|padding|margin|colou?r|palette|animation|transition|hero section|landing page|navbar|header|footer|button|card|modal|form design|ux|copy|wording|headline|tagline|design|look and feel|visual)\b/i,
  build_code: /\b(api|endpoint|server|backend|database|schema|migration|query|auth|authentication|authorization|token|algorithm|logic|state management|integration|webhook|queue|cache|parser|validation|business rule|payment|billing)\b/i,
  mechanical: /\b(rename|move (?:the )?file|bump|version|config|configuration|boilerplate|scaffold|lockfile|format|formatting|lint|prettier|eslint|tsconfig|package\.json|gitignore|env var|environment variable|readme|changelog|docs?|documentation|comment|typo)\b/i,
  review: /\b(test|tests|testing|unit test|integration test|verify|verification|review|audit|check|lint check|typecheck|type check|regression|coverage|qa)\b/i,
};

const extOf = (p) => {
  const s = String(p || "");
  const base = s.split(/[\\/]/).pop() || "";
  if (base.startsWith(".") && !base.slice(1).includes(".")) return base.slice(1).toLowerCase();  // .gitignore
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

// Which class does a single path suggest, and why.
function classOfPath(p) {
  if (TEST_FILE.test(String(p || ""))) return { cls: "review", why: "test file" };
  const e = extOf(p);
  if (!e) return { cls: "", why: "" };
  if (STRADDLE_EXT.has(e)) {
    if (DESIGN_DIR.test(p)) return { cls: "design_code", why: "." + e + " under a design folder" };
    if (BUILD_DIR.test(p)) return { cls: "build_code", why: "." + e + " under an engineering folder" };
    return { cls: "design_code", why: "." + e + " component" };   // components lean design by default
  }
  for (const cls of TASK_CLASSES) {
    if (EXT[cls] && EXT[cls].includes(e)) return { cls, why: "." + e + " file" };
  }
  return { cls: "", why: "" };
}

/*
 * Classify one move. Returns the class, a confidence, a human-readable reason, and whether a
 * classifier call is worth making. Never throws, never calls out.
 */
export function classifyMove({ title = "", description = "", files = [] } = {}) {
  const text = (String(title) + " " + String(description)).trim();
  const list = Array.isArray(files) ? files.filter(Boolean).map(String) : [];

  // 1. FILES are the strongest signal: they are facts about the move, not a description of it.
  const votes = new Map();
  const whys = [];
  for (const f of list) {
    const { cls, why } = classOfPath(f);
    if (!cls) continue;
    votes.set(cls, (votes.get(cls) || 0) + 1);
    if (whys.length < 3 && why) whys.push(why);
  }
  let fileClass = "", fileUnanimous = false;
  if (votes.size) {
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    fileClass = ranked[0][0];
    fileUnanimous = ranked.length === 1;
  }

  // 2. KEYWORDS in what the user actually asked for.
  const hits = [];
  for (const cls of TASK_CLASSES) if (KEYWORDS[cls] && KEYWORDS[cls].test(text)) hits.push(cls);
  // An explicit request for a picture beats everything: you cannot satisfy "draw me a logo" with CSS.
  const wantsImage = hits.includes("design_visual");
  let textClass = wantsImage ? "design_visual" : (hits[0] || "");
  if (hits.includes("review") && !wantsImage) textClass = "review";   // "add tests for X" is review work

  // 3. Decide, and say why in a sentence a human can check.
  let taskClass, confidence, why;
  if (wantsImage) {
    taskClass = "design_visual"; confidence = CONF_STRONG;
    why = "asks for an image, so it goes to the image engine";
  } else if (fileClass && textClass && fileClass === textClass) {
    taskClass = fileClass; confidence = CONF_STRONG;
    why = "the files (" + whys.join(", ") + ") and the wording agree";
  } else if (fileClass && !textClass) {
    taskClass = fileClass; confidence = fileUnanimous ? CONF_STRONG : CONF_OK;
    why = "based on the files: " + whys.join(", ");
  } else if (!fileClass && textClass) {
    taskClass = textClass; confidence = CONF_OK;
    why = "based on the wording of the request";
  } else if (fileClass && textClass) {
    // Genuine disagreement. Files win (they are facts) but confidence drops so the classifier runs.
    taskClass = fileClass; confidence = CONF_WEAK;
    why = "the files suggest " + CLASS_INFO[fileClass].label.toLowerCase()
        + " but the wording suggests " + CLASS_INFO[textClass].label.toLowerCase();
  } else {
    // Nothing to go on. Engineering is the safe default: it routes to the model the user chose,
    // which is never the wrong-but-cheap answer.
    taskClass = "build_code"; confidence = CONF_WEAK;
    why = "nothing specific to go on, so it goes to your main model";
  }

  return {
    taskClass, confidence, why,
    needsClassifier: confidence < CLASSIFIER_THRESHOLD,
    signals: { fileClass, textClass, files: list.length },
  };
}

/*
 * Classify with an optional cheap tiebreaker. `classify` is injected (owner: the free local model,
 * guests: the cheapest cloud model) and only ever called for a move the table could not settle.
 * If it fails, errors, or answers with nonsense, the deterministic answer stands: the fallback is
 * always the free path, never a stall.
 */
export async function classifyMoveSmart(move, { classify } = {}) {
  const base = classifyMove(move);
  if (!base.needsClassifier || typeof classify !== "function") return base;
  try {
    const answer = await classify({ ...move, candidates: TASK_CLASSES });
    const picked = String(answer || "").trim().toLowerCase();
    if (TASK_CLASSES.includes(picked)) {
      return { ...base, taskClass: picked, confidence: CONF_OK,
        why: base.why + ", so a quick classifier settled it", classifier: true };
    }
  } catch {}
  return { ...base, classifierFailed: true };
}

/*
 * Turn stored assignments into a concrete model per class.
 *   allInOne  a model id that collapses every TEXT class onto one model, for people who never
 *             want to think about this. Visual work still goes to the image engine, because no
 *             text model returns a PNG, and saying so is more honest than pretending otherwise.
 *   fallback  the workspace's main model, used wherever an assignment is "".
 */
export function resolveAssignments(stored = {}, { allInOne = "", fallback = "" } = {}) {
  const out = {};
  for (const cls of TASK_CLASSES) {
    if (cls === "design_visual") { out[cls] = IMAGE_ENGINE; continue; }
    if (allInOne) { out[cls] = allInOne; continue; }
    const chosen = stored && typeof stored[cls] === "string" ? stored[cls] : DEFAULT_ASSIGNMENTS[cls];
    out[cls] = chosen || fallback || DEFAULT_ASSIGNMENTS.build_code || "";
  }
  // review defaults to whatever engineering is set to: a second opinion from the same calibre.
  if (!allInOne && !(stored && stored.review)) out.review = out.build_code;
  return out;
}

/*
 * The whole decision for one move, ready to be shown and logged:
 * which class, which model, and why both.
 */
export function routeMove(move, assignments, opts = {}) {
  const cls = classifyMove(move);
  const resolved = resolveAssignments(assignments, opts);
  return {
    ...cls,
    model: resolved[cls.taskClass],
    isImage: cls.taskClass === "design_visual",
    assignments: resolved,
  };
}
