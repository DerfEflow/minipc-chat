/*
 * Dominion AI — Crucible project blueprints (Fred, 2026-08-09).
 *
 * THE GAP THIS FILLS. A Crucible project starts at /ide/intake, a clarifying interview against a
 * blank prompt, and iderouter's PRESETS are two model-assignment starting points whose own comment
 * says "the board is still fully manual". So Dominion has never been short of capability; it has
 * been short of a surface that tells someone what to ask for. These 49 blueprints are project
 * SHAPES: a decomposition, what it needs, what it produces, and how you would know it worked.
 *
 * WHERE THE DATA COMES FROM. blueprints.data.json is vendored from the ai-agentic-workflows catalog
 * (F:\agentic, commit e58f42a). Vendored deliberately: a runtime dependency on a sandbox path would
 * make a Railway container's behaviour depend on a drive it cannot see. Re-vendor by copying the
 * file; the shape is asserted at load below, so a bad copy fails at boot rather than mid-project.
 *
 * The Python skeletons in that catalog are NOT used and should never be imported. They share one
 * engine far simpler than Dominion's, and their framework recommendations (CrewAI, LangGraph,
 * AutoGen, Agno) describe a stack Dominion does not run. Only the designs travel.
 *
 * THE `gate` FIELD IS LOAD-BEARING. "in_flow" means the sequence must hold for a human before it
 * acts, because the acting step posts a comment, files a ticket, or issues an alert that cannot be
 * recalled. "downstream" means a human reads the output afterwards and no in-flow pause is claimed.
 * Seeding a project from a blueprint carries that promise into the plan; dropping it would present
 * a decomposition whose stated review never happens, which is worse than offering no blueprint.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA = fileURLToPath(new URL("./blueprints.data.json", import.meta.url));

/** @type {Array<object>} */
export const BLUEPRINTS = Object.freeze(JSON.parse(readFileSync(DATA, "utf8")));

// Fail at boot, not mid-project. A truncated or reshaped copy is the realistic failure here, and it
// is silent otherwise: the picker renders, a project seeds from an entry with no steps, and the user
// gets a blank plan with no explanation.
const REQUIRED = ["id", "category", "title", "summary", "steps", "inputs", "outputs", "success_metrics", "gate"];
for (const b of BLUEPRINTS) {
  for (const f of REQUIRED) {
    if (b[f] == null) throw new Error(`blueprints.data.json: ${b && b.id} is missing ${f}`);
  }
  if (!Array.isArray(b.steps) || !b.steps.length) throw new Error(`blueprints.data.json: ${b.id} has no steps`);
  if (!["in_flow", "downstream", "none"].includes(b.gate)) throw new Error(`blueprints.data.json: ${b.id} has an unknown gate "${b.gate}"`);
}

const BY_ID = new Map(BLUEPRINTS.map((b) => [b.id, b]));
export const blueprintById = (id) => BY_ID.get(String(id || "")) || null;

// Display order. Development and productivity lead because they are what the Crucible is used for;
// the rest follow alphabetically rather than by any claim about importance.
export const BLUEPRINT_CATEGORIES = Object.freeze([
  "development", "productivity", "business-operations", "content-creation",
  "customer-engagement", "data-analysis", "infrastructure", "research-intelligence",
]);

const CATEGORY_LABELS = {
  "development": "Development",
  "productivity": "Productivity",
  "business-operations": "Business operations",
  "content-creation": "Content creation",
  "customer-engagement": "Customer engagement",
  "data-analysis": "Data analysis",
  "infrastructure": "Infrastructure",
  "research-intelligence": "Research and intelligence",
};
export const categoryLabel = (c) => CATEGORY_LABELS[c] || String(c || "");

/*
 * The picker payload. Deliberately NOT the whole record: steps, inputs, outputs and metrics are
 * several hundred KB across 49 entries and the picker shows none of them. The client asks for one
 * blueprint's detail when the user opens it.
 */
export function blueprintCatalog() {
  const groups = BLUEPRINT_CATEGORIES.map((c) => ({
    category: c,
    label: categoryLabel(c),
    items: BLUEPRINTS.filter((b) => b.category === c).map((b) => ({
      id: b.id, title: b.title, summary: b.summary, complexity: b.complexity,
      patterns: b.patterns, steps: b.steps.length, gate: b.gate,
    })),
  })).filter((g) => g.items.length);
  return { count: BLUEPRINTS.length, groups };
}

const bullet = (s) => "- " + String(s || "").replace(/\s+/g, " ").trim();

/*
 * SEED, not vision. The blueprint becomes the opening USER turn of the intake conversation rather
 * than a pre-agreed VISION READY block, and that choice is deliberate.
 *
 * The intake system prompt adapts to a register: "plain" forbids the words deploy, repo, commit,
 * framework, backend, API and schema outright. Blueprint prose is written in exactly that
 * vocabulary ("Pull the PR diff", "Poll regulatory feeds"). Handing a plain-register beginner a
 * finished vision in catalog language would break the one rule that surface exists to keep. Seeding
 * the conversation instead lets the intake model translate, and leaves every blueprint adjustable by
 * talking, which is what the interview is for.
 *
 * blueprintVision below is the fast path for someone who wants none of that.
 */
export function blueprintSeed(id) {
  const b = blueprintById(id);
  if (!b) return null;
  const lines = [
    `I want to build this: ${b.title}.`,
    "",
    b.summary,
    "",
    "Here is how I think it breaks down, step by step:",
    ...b.steps.map((s, i) => `${i + 1}. ${s.name.replace(/_/g, " ")} — ${s.goal}`),
    "",
    "What it needs to start:",
    ...(b.inputs || []).map(bullet),
    "",
    "What it should produce:",
    ...(b.outputs || []).map(bullet),
    "",
    "How I would know it works:",
    ...(b.success_metrics || []).map(bullet),
  ];
  if (b.gate === "in_flow") {
    lines.push("",
      "One thing that is not optional: this has to stop and ask me before it acts. " +
      (b.review_rationale || "A person approves before anything leaves the system."));
  }
  return lines.join("\n");
}

/*
 * The fast path: a ready-made VISION READY block that parseIntake accepts, for skipping the
 * interview entirely. Marker on its own line with bullets under it, matching what intakeSystem
 * instructs the model to produce, so one parser serves both.
 */
export function blueprintVision(id) {
  const b = blueprintById(id);
  if (!b) return null;
  const bullets = [
    bullet(`What it is: ${b.title}. ${b.summary}`),
    bullet(`What it does, in order: ${b.steps.map((s) => s.name.replace(/_/g, " ")).join(" → ")}`),
    ...(b.inputs || []).map((i) => bullet(`It needs: ${i}`)),
    ...(b.outputs || []).map((o) => bullet(`It produces: ${o}`)),
    ...(b.success_metrics || []).map((m) => bullet(`It works when: ${m}`)),
  ];
  if (b.gate === "in_flow") {
    bullets.push(bullet(`It must pause for a person before it acts. ${b.review_rationale || ""}`.trim()));
  }
  return [
    `Starting from the ${b.title} blueprint.`,
    "",
    "VISION READY",
    ...bullets,
    "",
    "That is the plan. Press BEGIN BUILDING, or keep talking to change any of it.",
  ].join("\n");
}
