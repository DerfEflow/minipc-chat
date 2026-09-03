/*
 * SD Tech Mobile Game Factory — server forge (LANE-gfforge.md).
 *
 * The second durable-queue worker beside gamefactoryorchestrator.mjs (GAME-FACTORY-BUILD.md D2/D8).
 * It claims product_planning, visual_design and gameplay_engineering tasks from the same store the
 * GX10 lane uses, and turns them into a design document, app icons/splash art, and a playable
 * dependency-free HTML5-canvas game bundle, one task at a time. Every model/engine call is a rung on
 * a ladder (D8): a rung that errors, returns no content, or fails local QA never ends the task — the
 * next rung is tried, and only when every rung is exhausted does the task fail, honestly, via
 * failTask({ retryable: false }). Nothing here ever throws an unhandled rejection out of a running
 * task; every code path inside processTask() is wrapped so a bug becomes an honest failTask call
 * instead of a crashed worker.
 *
 * Every external capability is injected (store, chat, generateImages, readArtifact, kit, qaRunner) so
 * this module never imports server.mjs or a concrete model/image provider, per AGENT-RULES.md and the
 * lane's own file-ownership boundary. The kit itself (gamefactorykit/*, gamefactoryqa.mjs) is being
 * written in parallel by lane gfkit; this file codes to the exact export names in LANE-gfkit.md and a
 * small in-file fake in gamefactoryforge_test.mjs stands in for it until the real kit lands.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { portfolioGame } from "./gamefactorytemplates.mjs";

const WORKER_ID = "game-factory:server-forge";

// GAME-FACTORY-BUILD.md section 3: this worker claims in this fixed priority order every tick, one
// task total per tick (never more than one task in flight at a time — "one task at a time" per
// LANE-gfforge.md). gameplay_engineering goes first so a game that is mid-build (and therefore
// closest to a playable result) is never starved behind a fresh game's planning work.
const CAPABILITY_ORDER = Object.freeze(["gameplay_engineering", "product_planning", "visual_design"]);

// The four files a gameplay_engineering task must produce (LANE-gfforge.md "Ask for exactly four
// files"). Order matters only for the prompt's block instructions; REQUIRED_FILES itself is used as
// a set everywhere else.
const REQUIRED_FILES = Object.freeze(["game/rules.js", "game/render.js", "game/content.js", "qa/fixtures.json"]);

// GAME-FACTORY-BUILD.md section 2: the local validation loop's "must-pass-locally" set. The other
// three of the 12 QA_REQUIRED_SUITES (monetization, privacy-consent, store-readiness) exercise
// kit/ports.js and the assembled manifest/provenance rather than the four generated files, so the
// forge does not gate a repair round on them; the server QA runner still records real results for
// all 12 once a build reaches AUTOMATED_TESTING (gfsupervisor's job, not this file's).
const MUST_PASS_LOCALLY = Object.freeze([
  "launch-smoke", "core-loop", "controls", "save-state", "crash-regression",
  "viewport", "performance", "analytics", "offline",
]);

// D8: "gx10/qwen3-coder-30b (free) first" for design JSON, and the free rung code generation gets
// only when GAME_FACTORY_FORGE_FREE_FIRST=1. One fixed id covers both ladders (D8 names the same
// model for both). TODO(fred): if the real GX10 broker ever exposes more than one free coder model,
// this constant is the one place to make it configurable instead of a second hardcoded id.
const GX10_FREE_MODEL = "gx10/qwen3-coder-30b";
const DEFAULT_DESIGN_MODELS = Object.freeze([GX10_FREE_MODEL, "deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-5"]);
const DEFAULT_CODE_MODELS = Object.freeze(["deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"]);

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const safeErr = (value) => {
  if (!value) return "";
  const s = value instanceof Error ? value.message : String(value);
  return s.slice(0, 2000);
};
function truncate(text, max) {
  const s = String(text == null ? "" : text);
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}
function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function ensureParentDir(path) { mkdirSync(dirname(path), { recursive: true }); }

/*
 * Tolerant JSON extraction for the design-document model response: strips a wrapping ``` fence if
 * present, then takes the outermost {...} span so a model that prefixes "Here is the JSON:" (against
 * instructions, but models do this) still parses. Returns null rather than throwing on any failure —
 * every caller treats a null as "this rung/round did not produce valid JSON" and moves on.
 */
function tryParseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/*
 * Exported for direct unit testing (LANE-gfforge.md test 6 "Parser"). Not part of the interface
 * other lanes consume — createGameFactoryForge is the only export named in LANE-gfforge.md — but a
 * named export costs nothing and keeps the parser test fast and isolated from the store/chat/qa
 * machinery it does not need to exercise.
 */
export function parseFileBlocks(text) {
  const files = {};
  const re = /=====\s*FILE:\s*([^\n=]+?)\s*=====\r?\n([\s\S]*?)\r?\n?=====\s*END FILE\s*=====/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const name = match[1].trim();
    if (!REQUIRED_FILES.includes(name)) continue; // ignore any block the model invents beyond the four asked for
    files[name] = stripCodeFence(match[2]);
  }
  const missing = REQUIRED_FILES.filter((name) => !files[name] || !files[name].trim());
  if (missing.length) return { error: `missing or empty file block(s): ${missing.join(", ")}`, files, missing };
  return { files };
}
function stripCodeFence(body) {
  const trimmed = String(body == null ? "" : body).trim();
  const m = /^```[a-zA-Z0-9_.-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return m ? m[1] : body;
}

/*
 * Exported for direct unit testing. Validates the shape LANE-gfforge.md's product_planning section
 * documents; deliberately not exhaustive (a model's JSON will vary in ways that do not matter), but
 * catches every field the rest of this file and the kit's assembleBundle() actually depend on.
 */
export function validateDesignShape(design, levels) {
  const errors = [];
  if (!design || typeof design !== "object" || Array.isArray(design)) return ["the response is not a JSON object"];
  if (!design.name || typeof design.name !== "string") errors.push("name is required");
  if (design.toolchain !== undefined && design.toolchain !== "web-canvas") errors.push('toolchain must be "web-canvas"');
  if (!design.summary || typeof design.summary !== "string") errors.push("summary is required");
  if (!Array.isArray(design.coreLoop) || !design.coreLoop.length) errors.push("coreLoop must be a non-empty array");
  if (!Array.isArray(design.entities)) errors.push("entities must be an array");
  if (!Array.isArray(design.actions) || !design.actions.length) errors.push("actions must be a non-empty array");
  if (!design.rules || typeof design.rules !== "object") errors.push("rules is required");
  else {
    if (!design.rules.win) errors.push("rules.win is required");
    if (!design.rules.fail) errors.push("rules.fail is required");
  }
  if (!Array.isArray(design.levelPlan) || design.levelPlan.length !== levels) errors.push(`levelPlan must have exactly ${levels} entries`);
  else if (design.levelPlan.some((entry) => !entry || entry.id === undefined || entry.id === null || !entry.title)) errors.push("every levelPlan entry needs id and title");
  if (!design.theme || !Array.isArray(design.theme.palette) || !design.theme.palette.length) errors.push("theme.palette must be a non-empty array");
  if (!design.analytics || !Array.isArray(design.analytics.events)) errors.push("analytics.events must be an array");
  return errors;
}

/* Prepends the free GX10 rung when freeFirst is on and the given ladder does not already start with
 * it; otherwise returns the caller's array unchanged (never invents a different order for the models
 * actually named in `models.design` / `models.code`). */
function withFreeFirst(list, enabled) {
  const arr = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!enabled) return arr;
  return arr[0] === GX10_FREE_MODEL ? arr : [GX10_FREE_MODEL, ...arr];
}

// ---------------------------------------------------------------------------------------------
// Prompt templates. Every function here returns exactly what is sent to chat(); pasted verbatim
// (with the dynamic values described) into the lane report per LANE-gfforge.md.
// ---------------------------------------------------------------------------------------------

function buildDesignSystemPrompt() {
  return "You are the design AI for the Dominion AI Game Factory. You turn an approved game concept "
    + "into one machine-readable design document that a separate code-generation model will implement "
    + "as a dependency-free HTML5 canvas game. Respond with ONE JSON object and nothing else: no prose, "
    + "no markdown, no code fences.";
}

function buildDesignUserPrompt({ catalogGame, artifacts, levels }) {
  const lines = [];
  lines.push(`Game: ${catalogGame.name} (slug: ${catalogGame.slug})`);
  lines.push(`Genre: ${catalogGame.genre}`);
  lines.push(`Logline: ${catalogGame.logline}`);
  lines.push(`Input: ${catalogGame.input}`);
  lines.push(`Core loop reference: ${(catalogGame.loop || []).join(" -> ")}`);
  lines.push(`MVP scope: ${(catalogGame.mvp || []).join("; ")}`);
  lines.push("");
  for (const [key, content] of Object.entries(artifacts)) {
    lines.push(`--- ${key} ---`);
    lines.push(content ? truncate(content, 4000) : "(not available)");
    lines.push("");
  }
  lines.push(`Produce exactly ${levels} entries in levelPlan.`);
  lines.push("Return one JSON object with exactly this shape (values below are illustrative, not literal):");
  lines.push(JSON.stringify({
    schemaVersion: 1, slug: catalogGame.slug, name: catalogGame.name, toolchain: "web-canvas",
    summary: "string", coreLoop: ["string"], entities: [{ name: "string", fields: ["string"] }],
    actions: [{ type: "string", params: ["string"], gesture: "string", stepControl: "string" }],
    rules: { win: "string", fail: "string", scoring: "string", undo: true },
    levelPlan: [{ id: "string", title: "string", teaches: "string", difficulty: 1, par: 1 }],
    theme: { palette: ["#rrggbb"], paletteNames: ["string"], type: "string", motion: "string", accessibility: "string" },
    analytics: { events: ["string"], propsAllowed: ["string"] },
    qaFocus: ["string"], notes: ["string"],
  }, null, 2));
  return lines.join("\n");
}

function buildDesignFixPrompt(shapeErrors) {
  return `That response was not valid: ${shapeErrors.join("; ")}. Reply with ONLY the corrected single `
    + "JSON object, no prose, no code fences.";
}

function fileBlockFormatInstruction() {
  return [
    "Respond with exactly these four blocks, in this order, and nothing else outside them:",
    "===== FILE: game/rules.js =====",
    "<complete file contents>",
    "===== END FILE =====",
    "===== FILE: game/render.js =====",
    "<complete file contents>",
    "===== END FILE =====",
    "===== FILE: game/content.js =====",
    "<complete file contents>",
    "===== END FILE =====",
    "===== FILE: qa/fixtures.json =====",
    "<complete file contents>",
    "===== END FILE =====",
  ].join("\n");
}

function buildImplementSystemPrompt({ kit, theme, levels }) {
  return [
    "You are the code-generation AI for the Dominion AI Game Factory.",
    "You write a small, dependency-free HTML5 canvas game as ES modules that plug into a fixed runtime kit.",
    "Follow this contract exactly:",
    "",
    kit.KIT_CONTRACT_TEXT,
    "",
    "Hard rules:",
    "- No DOM APIs anywhere in game/rules.js, game/render.js or game/content.js (render.js only receives a canvas 2D context; it never touches document or window).",
    "- No fetch, XMLHttpRequest, WebSocket, or any network call anywhere in the four files.",
    "- No Math.random() and no Date/Date.now() in game logic; createState receives a seed and every file must be fully deterministic from it.",
    "- game/render.js may only call the Canvas 2D methods and properties the contract above lists.",
    `- game/content.js and qa/fixtures.json must define exactly ${levels} levels.`,
    `- Palette: ${JSON.stringify(theme.palette)}.`,
    '- Handle the reserved action types on every game: {type:"undo"}, {type:"restart"}, {type:"hint"}, {type:"next"}, {type:"select_level", index}.',
    "- Return complete files every time: never a diff, never a partial snippet, never prose outside the file blocks.",
  ].join("\n");
}

function buildImplementUserPrompt({ kind, design, reason, failures, includeReference, kit }) {
  const lines = [];
  if (kind === "repair") {
    lines.push(`The current implementation of "${design.name}" (slug: ${design.slug}) failed local QA. Fix it while keeping the design intent.`);
    lines.push("Design document:");
    lines.push(JSON.stringify(design, null, 2));
    lines.push("");
    lines.push("Failing suites reported by the last build:");
    for (const f of (failures || [])) {
      lines.push(`- ${f.suite}: ${f.summary || "FAILED"}`);
      for (const line of (f.failures || []).slice(0, 12)) lines.push(`    ${line}`);
    }
    lines.push("");
    lines.push("Current files:");
    for (const name of REQUIRED_FILES) { lines.push(`----- ${name} -----`); lines.push((design.__currentFiles || {})[name] || ""); }
  } else if (kind === "revise") {
    lines.push(`The owner requested this change to "${design.name}" (slug: ${design.slug}):`);
    lines.push(`"${reason || "(no reason given)"}"`);
    lines.push("");
    lines.push("Design document:");
    lines.push(JSON.stringify(design, null, 2));
    lines.push("");
    lines.push("Current files:");
    for (const name of REQUIRED_FILES) { lines.push(`----- ${name} -----`); lines.push((design.__currentFiles || {})[name] || ""); }
  } else {
    lines.push(`Implement "${design.name}" (slug: ${design.slug}) from this design document:`);
    lines.push(JSON.stringify(design, null, 2));
    if (includeReference) {
      lines.push("");
      lines.push("For STYLE REFERENCE ONLY, here is a complete, passing example game's game/rules.js from a "
        + "different game (Vector Vault). Study its shape and conventions. Do not copy its mechanics, "
        + "content or names into your own game; write an original game/rules.js for the design above.");
      lines.push("----- reference example: game/rules.js -----");
      lines.push(kit.referenceGame("vector-vault")["game/rules.js"] || "");
      lines.push("----- end reference example -----");
    }
  }
  lines.push("");
  lines.push(fileBlockFormatInstruction());
  return lines.join("\n");
}

function buildMissingFileFeedback(missing) {
  return `Your last response was missing or had an empty file block for: ${missing.join(", ")}.\n\n${fileBlockFormatInstruction()}`;
}

function buildQaRetryFeedback(details) {
  return [
    "Local QA failed for these required suites on your last submission:",
    details,
    "",
    "Return corrected COMPLETE files (not a diff) that fix these failures while keeping the rest of the design intact.",
    fileBlockFormatInstruction(),
  ].join("\n");
}

function buildAssetPrompt(kind, catalogGame, projectName, palette) {
  const desc = kind === "icon"
    ? (catalogGame?.visual?.icon || `${projectName} app icon, simple and iconic, no text.`)
    : (catalogGame?.visual?.thumbnail || catalogGame?.visual?.premise || `${projectName} promotional splash art.`);
  const style = kind === "icon"
    ? "Flat vector app icon style, centered subject, no text, no watermark."
    : "Portrait promotional splash illustration, no text, no watermark.";
  return `${desc} Palette: ${palette.join(", ")}. ${style}`;
}

// ---------------------------------------------------------------------------------------------

class LeaseLostError extends Error {}

export function createGameFactoryForge({
  store, chat, generateImages, readArtifact, kit, qaRunner, dataDir, ownerTenant = null,
  models = { design: DEFAULT_DESIGN_MODELS, code: DEFAULT_CODE_MODELS },
  freeFirst = false, levels = 12, maxRounds = 4, leaseMs = 600_000, heartbeatMs = 30_000, pollMs = 5_000,
  log = () => {}, now = () => Date.now(),
} = {}) {
  if (!store) throw new Error("createGameFactoryForge needs a store");
  if (typeof chat !== "function") throw new Error("createGameFactoryForge needs a chat function");
  if (!kit || typeof kit.assembleBundle !== "function" || typeof kit.fallbackIconPng !== "function"
    || typeof kit.referenceGame !== "function" || typeof kit.themeFromVisual !== "function" || !kit.KIT_CONTRACT_TEXT) {
    throw new Error("createGameFactoryForge needs a kit with assembleBundle, fallbackIconPng, referenceGame, themeFromVisual and KIT_CONTRACT_TEXT");
  }
  if (!dataDir) throw new Error("createGameFactoryForge needs dataDir");
  // LANE-gfkit.md documents the server QA runner as "injected as `qaRunner`"; LANE-gfforge.md's own
  // dependency bullet nests that description under `kit`. The constructor signature line in
  // LANE-gfforge.md does not list a bare `qaRunner` parameter at all, so which of the two the
  // integration layer will actually pass could not be settled from the spec text alone (the real
  // kit/integration code that would resolve it does not exist yet). Accepting both here costs
  // nothing and works either way; said out loud in the lane report as required by AGENT-RULES.md.
  const runner = qaRunner || kit.qaRunner;
  if (!runner || typeof runner.run !== "function") {
    throw new Error("createGameFactoryForge needs a qaRunner with a run({ bundleDir, resultsDir }) method (as its own `qaRunner` option or as `kit.qaRunner`)");
  }

  const stats = { completed: 0, failed: 0, costUsd: 0, lastError: "" };
  let current = null; // { taskId, kind, stage, round, model }
  let timer = null, ticking = null, closed = false;

  const forgeDir = (slug) => join(dataDir, "game-factory", "forge", slug);
  const buildsDir = (buildId) => join(dataDir, "game-factory", "builds", buildId, "bundle");

  function makeCostTracker() {
    let total = 0;
    return { add(resp) { const v = Number(resp && resp.costUsd) || 0; total += v; return v; }, get total() { return total; } };
  }

  /*
   * One heartbeat/pause checkpoint per task run. lastAt starts at -Infinity so the very first check
   * always reaches the store (proves the lease immediately); after that a check only actually calls
   * store.heartbeatTask once heartbeatMs has elapsed, so a fast-moving task does not hammer the store
   * on every rung. A non-200 heartbeat response means this worker no longer owns the task's lease
   * (attempt superseded, or the lease already reclaimed elsewhere) — that is not an owner-requested
   * pause, so it throws LeaseLostError instead of returning true, and processTask() below abandons
   * the task quietly rather than calling completeTask/failTask against a lease it does not hold.
   */
  function makeRunContext(task) {
    let lastAt = -Infinity;
    let stopRequested = false;
    async function heartbeat(stage, round, model) {
      current = { taskId: task.id, kind: (task.payload && task.payload.kind) || task.capability, stage, round, model: model || null };
      if (stopRequested) return true;
      const at = Number(now()) || Date.now();
      if (at - lastAt < heartbeatMs) return stopRequested;
      lastAt = at;
      const r = store.heartbeatTask({ uid: task.uid, taskId: task.id, workerId: WORKER_ID, attempt: task.attempt, leaseMs });
      if (r.status !== 200) throw new LeaseLostError((r.body && r.body.error) || "task lease was lost");
      if (r.body && r.body.stopRequested) stopRequested = true;
      return stopRequested;
    }
    return { heartbeat };
  }

  function completeResult(task, result) {
    const r = store.completeTask({ uid: task.uid, taskId: task.id, workerId: WORKER_ID, attempt: task.attempt, result });
    if (r.status === 200) { stats.completed++; stats.costUsd += Number(result.costUsd) || 0; }
    else stats.lastError = `completeTask ${r.status}: ${(r.body && r.body.error) || ""}`;
    return r;
  }
  function pauseResult(task, stage, round) {
    const r = store.completeTask({
      uid: task.uid, taskId: task.id, workerId: WORKER_ID, attempt: task.attempt,
      result: { status: "PAUSED", kind: (task.payload && task.payload.kind) || task.capability, stage },
      checkpoint: { stage, round },
    });
    if (r.status === 200) stats.completed++;
    else stats.lastError = `completeTask(pause) ${r.status}: ${(r.body && r.body.error) || ""}`;
    return r;
  }
  function failResult(task, error, retryable) {
    const r = store.failTask({ uid: task.uid, taskId: task.id, workerId: WORKER_ID, attempt: task.attempt, error, retryable: !!retryable });
    if (r.status === 200) stats.failed++;
    stats.lastError = error;
    return r;
  }

  // -----------------------------------------------------------------------------------------
  // product_planning {kind:"design"}
  // -----------------------------------------------------------------------------------------
  async function runDesignTask(task, project, rc) {
    const slug = project.slug;
    const catalogGame = portfolioGame(slug);
    if (!catalogGame) return failResult(task, `No portfolio catalog entry exists for slug "${slug}".`, false);
    const artifactKeys = ["00_GAME_BRIEF", "04_GAME_ARCHITECTURE", "05_VISUAL_SYSTEM", "07_QA_AND_TESTING"];
    const artifacts = {};
    for (const key of artifactKeys) {
      try {
        const r = typeof readArtifact === "function" ? await readArtifact({ uid: task.uid, projectId: task.projectId, artifactKey: key }) : null;
        artifacts[key] = r && !r.error && r.content ? String(r.content) : null; // tolerate missing per LANE-gfforge.md
      } catch { artifacts[key] = null; }
    }
    const ladder = withFreeFirst((models.design && models.design.length) ? models.design : DEFAULT_DESIGN_MODELS, freeFirst);
    const cost = makeCostTracker();
    let round = 0, lastFailure = "";
    for (const model of ladder) {
      if (await rc.heartbeat("design", round, model)) return pauseResult(task, "design", round);
      round++;
      const messages = [
        { role: "system", content: buildDesignSystemPrompt() },
        { role: "user", content: buildDesignUserPrompt({ catalogGame, artifacts, levels }) },
      ];
      let resp = await chat({ model, messages, maxTokens: 6000, temperature: 0.4 });
      if (!resp || resp.ok === false || !resp.content) { lastFailure = `${model}: ${safeErr(resp && resp.error) || "no content"}`; continue; }
      cost.add(resp);
      let parsed = tryParseJson(resp.content);
      let shapeErrors = parsed ? validateDesignShape(parsed, levels) : ["invalid JSON"];
      if (shapeErrors.length) {
        if (await rc.heartbeat("design", round, model)) return pauseResult(task, "design", round);
        round++;
        const fixMessages = [...messages, { role: "assistant", content: resp.content }, { role: "user", content: buildDesignFixPrompt(shapeErrors) }];
        const fixResp = await chat({ model, messages: fixMessages, maxTokens: 6000, temperature: 0.2 });
        if (fixResp && fixResp.ok !== false && fixResp.content) {
          cost.add(fixResp);
          const fixParsed = tryParseJson(fixResp.content);
          const fixErrors = fixParsed ? validateDesignShape(fixParsed, levels) : ["invalid JSON"];
          if (!fixErrors.length) { parsed = fixParsed; shapeErrors = []; resp = fixResp; }
          else lastFailure = `${model}: ${fixErrors.join("; ")}`;
        } else lastFailure = `${model}: ${safeErr(fixResp && fixResp.error) || "fix attempt returned no content"}`;
      }
      if (!shapeErrors.length && parsed) {
        parsed.slug = parsed.slug || slug;
        parsed.schemaVersion = parsed.schemaVersion || 1;
        const dir = forgeDir(slug);
        mkdirSync(dir, { recursive: true });
        const text = JSON.stringify(parsed, null, 2);
        writeFileSync(join(dir, "design.json"), text);
        return completeResult(task, {
          kind: "design", designSha256: sha256Hex(Buffer.from(text, "utf8")),
          servedBy: resp.servedBy || { model }, costUsd: cost.total, rounds: round,
        });
      }
    }
    return failResult(task, `No model produced a valid design after ${round} rounds on ${ladder.length} model(s); last failure: ${lastFailure || "unknown"}.`, false);
  }

  // -----------------------------------------------------------------------------------------
  // visual_design {kind:"assets"} — GAME-FACTORY-BUILD.md D8: "can never fail for lack of art".
  // -----------------------------------------------------------------------------------------
  async function runAssetsTask(task, project, rc) {
    const slug = project.slug;
    if (await rc.heartbeat("assets", 0, "generateImages")) return pauseResult(task, "assets", 0);
    const catalogGame = portfolioGame(slug);
    const paletteHexes = ((catalogGame && catalogGame.visual && catalogGame.visual.palette) || []).map(([, hex]) => hex);
    const palette = paletteHexes.length ? paletteHexes : ["#111318", "#F5F7FF"];
    const glyph = (project.name || slug || "G").trim().slice(0, 1).toUpperCase() || "G";
    const iconPrompt = buildAssetPrompt("icon", catalogGame, project.name || slug, palette);
    const splashPrompt = buildAssetPrompt("splash", catalogGame, project.name || slug, palette);

    const cost = makeCostTracker();
    async function tryGenerate(prompt, aspect) {
      if (typeof generateImages !== "function") return { error: "Image generation is not configured on this server." };
      try {
        const r = await generateImages({ tenant: ownerTenant, prompt, quality: "low", aspect, n: 1 });
        if (r && !r.error) cost.add(r);
        return r;
      } catch (error) { return { error: safeErr(error) || "image generation threw" }; }
    }

    const files = {};
    const provenanceEntries = [];
    const iconGen = await tryGenerate(iconPrompt, "square");
    const icon512 = iconGen && !iconGen.error && iconGen.images && iconGen.images[0] && iconGen.images[0].b64
      ? Buffer.from(iconGen.images[0].b64, "base64") : null;
    if (icon512 && icon512.length) {
      files["assets/icon-512.png"] = icon512;
      provenanceEntries.push({
        path: "assets/icon-512.png", engine: (iconGen.servedBy && iconGen.servedBy.engine) || "generated",
        model: (iconGen.servedBy && iconGen.servedBy.model) || iconGen.model || null,
        prompt: iconPrompt, sha256: sha256Hex(icon512), size: icon512.length,
      });
    } else {
      const fallback = kit.fallbackIconPng({ size: 512, palette, glyph });
      files["assets/icon-512.png"] = fallback;
      provenanceEntries.push({ path: "assets/icon-512.png", engine: "kit", model: null, prompt: iconPrompt, sha256: sha256Hex(fallback), size: fallback.length });
    }
    // icon-192 is always kit-drawn: no bitmap resize primitive is injected into the forge, and
    // asking the image engine a second time would return a DIFFERENT picture rather than a resized
    // one, so the two icon sizes would visually disagree. TODO(fred): if the kit lane adds a resize
    // helper, derive icon-192 from the generated icon-512 bytes here instead.
    const icon192 = kit.fallbackIconPng({ size: 192, palette, glyph });
    files["assets/icon-192.png"] = icon192;
    provenanceEntries.push({
      path: "assets/icon-192.png", engine: "kit", model: null,
      prompt: "deterministic kit-drawn icon (no bitmap resize primitive is available to derive this size from the generated icon-512 asset)",
      sha256: sha256Hex(icon192), size: icon192.length,
    });

    const splashGen = await tryGenerate(splashPrompt, "portrait");
    const splashBuf = splashGen && !splashGen.error && splashGen.images && splashGen.images[0] && splashGen.images[0].b64
      ? Buffer.from(splashGen.images[0].b64, "base64") : null;
    if (splashBuf && splashBuf.length) {
      files["assets/splash.png"] = splashBuf;
      provenanceEntries.push({
        path: "assets/splash.png", engine: (splashGen.servedBy && splashGen.servedBy.engine) || "generated",
        model: (splashGen.servedBy && splashGen.servedBy.model) || splashGen.model || null,
        prompt: splashPrompt, sha256: sha256Hex(splashBuf), size: splashBuf.length,
      });
    } else {
      // fallbackIconPng only draws a square; a portrait fallback shape is not something the kit
      // exports today (LANE-gfkit.md section D), so the splash fallback is the same square glyph at
      // a larger size. Said out loud rather than silently shipping a mislabeled non-fallback.
      const fallback = kit.fallbackIconPng({ size: 1024, palette, glyph });
      files["assets/splash.png"] = fallback;
      provenanceEntries.push({ path: "assets/splash.png", engine: "kit", model: null, prompt: splashPrompt, sha256: sha256Hex(fallback), size: fallback.length });
    }

    const provenance = { assets: provenanceEntries, generatedAt: new Date(Number(now()) || Date.now()).toISOString() };
    const dir = forgeDir(slug);
    const assetsDir = join(dir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    for (const [path, buf] of Object.entries(files)) writeFileSync(join(dir, path), buf);
    writeFileSync(join(assetsDir, "provenance.json"), JSON.stringify(provenance, null, 2));

    const primary = provenanceEntries[0] ? { engine: provenanceEntries[0].engine, model: provenanceEntries[0].model } : { engine: "kit", model: null };
    return completeResult(task, { kind: "assets", assets: provenanceEntries, servedBy: primary, costUsd: cost.total });
  }

  // -----------------------------------------------------------------------------------------
  // gameplay_engineering {kind:"implement"|"repair"|"revise"}
  // -----------------------------------------------------------------------------------------
  function readSourceFiles(dir) {
    const sourceDir = join(dir, "source");
    const files = {};
    for (const name of REQUIRED_FILES) {
      const p = join(sourceDir, name);
      if (!existsSync(p)) return null;
      files[name] = readFileSync(p, "utf8");
    }
    return files;
  }
  function persistSource(dir, buildId, files, servedByRecord) {
    const sourceDir = join(dir, "source");
    const historyDir = join(dir, "history", buildId);
    for (const base of [sourceDir, historyDir]) {
      for (const name of REQUIRED_FILES) ensureParentDir(join(base, name));
    }
    for (const name of REQUIRED_FILES) {
      for (const base of [sourceDir, historyDir]) writeFileSync(join(base, name), files[name]);
    }
    writeFileSync(join(sourceDir, ".servedBy.json"), JSON.stringify(servedByRecord, null, 2));
  }
  function loadAssetsForBundle(dir) {
    const assetsDir = join(dir, "assets");
    const names = ["icon-512.png", "icon-192.png", "splash.png"];
    const files = {};
    let real = true;
    for (const name of names) {
      const p = join(assetsDir, name);
      if (existsSync(p)) files[`assets/${name}`] = readFileSync(p);
      else real = false;
    }
    if (real) {
      const provPath = join(assetsDir, "provenance.json");
      files["assets/provenance.json"] = existsSync(provPath)
        ? readFileSync(provPath, "utf8")
        : JSON.stringify({ assets: [], generatedAt: new Date(Number(now()) || Date.now()).toISOString() });
      return files;
    }
    // The assets task has not completed yet (or its output was removed); assemble with deterministic
    // kit-drawn placeholders so IMPLEMENTATION never blocks on ASSET_GENERATION's ordering.
    const palette = ["#111318", "#F5F7FF"];
    const icon512 = kit.fallbackIconPng({ size: 512, palette, glyph: "G" });
    const icon192 = kit.fallbackIconPng({ size: 192, palette, glyph: "G" });
    const splash = kit.fallbackIconPng({ size: 1024, palette, glyph: "G" });
    const provenance = {
      assets: [
        { path: "assets/icon-512.png", engine: "kit", model: null, prompt: "fallback (visual_design has not completed for this game yet)", sha256: sha256Hex(icon512), size: icon512.length },
        { path: "assets/icon-192.png", engine: "kit", model: null, prompt: "fallback (visual_design has not completed for this game yet)", sha256: sha256Hex(icon192), size: icon192.length },
        { path: "assets/splash.png", engine: "kit", model: null, prompt: "fallback (visual_design has not completed for this game yet)", sha256: sha256Hex(splash), size: splash.length },
      ],
      generatedAt: new Date(Number(now()) || Date.now()).toISOString(),
    };
    return { "assets/icon-512.png": icon512, "assets/icon-192.png": icon192, "assets/splash.png": splash, "assets/provenance.json": JSON.stringify(provenance) };
  }
  function buildMeta({ design, catalogGame, theme, buildId, versionName }) {
    return {
      name: design.name || (catalogGame && catalogGame.name) || design.slug,
      slug: design.slug,
      versionName, buildId,
      subtitle: (catalogGame && catalogGame.store && catalogGame.store.subtitle) || design.summary || "",
      keywords: (catalogGame && catalogGame.store && catalogGame.store.keywords) || "",
      palette: theme.palette,
      events: (design.analytics && design.analytics.events) || [],
      actions: design.actions || [],
      theme,
      toolchain: "web-canvas",
    };
  }
  function assembleFinal({ finalDir, generated, meta, assets, expectedSha }) {
    if (existsSync(finalDir) && readdirSync(finalDir).length) {
      const existing = readJsonFile(join(finalDir, "build.json"));
      if (existing && existing.bundleSha256 === expectedSha) return existing; // idempotent retry of the same task attempt
      throw new Error(`A build bundle already exists at this build's path with different content than this task just produced (expected ${expectedSha}, found ${existing ? existing.bundleSha256 : "an unreadable build.json"}); refusing to overwrite it.`);
    }
    return kit.assembleBundle({ outDir: finalDir, generated, meta, assets });
  }

  async function runGameplayTask(task, project, rc) {
    const slug = project.slug;
    const kind = String((task.payload && task.payload.kind) || "implement");
    const buildId = String((task.payload && task.payload.buildId) || "");
    if (!buildId) return failResult(task, "gameplay_engineering task is missing a buildId.", false);
    const dir = forgeDir(slug);
    const design = readJsonFile(join(dir, "design.json"));
    if (!design) return failResult(task, `No design.json exists for "${slug}"; product_planning must complete before gameplay_engineering can run.`, true);
    const catalogGame = portfolioGame(slug);
    const theme = kit.themeFromVisual((catalogGame && catalogGame.visual) || { palette: (design.theme && design.theme.palette || []).map((hex, i) => [`Color ${i + 1}`, hex]) });

    let currentFiles = null, priorServedBy = null;
    if (kind !== "implement") {
      currentFiles = readSourceFiles(dir);
      if (!currentFiles) return failResult(task, `No prior generated source exists for "${slug}" to ${kind}.`, true);
      priorServedBy = readJsonFile(join(dir, "source", ".servedBy.json"));
      design.__currentFiles = currentFiles; // prompt-builder convenience only; never written back to design.json
    }

    let ladder = withFreeFirst((models.code && models.code.length) ? models.code : DEFAULT_CODE_MODELS, freeFirst);
    if (kind === "repair" && priorServedBy && priorServedBy.model && ladder.includes(priorServedBy.model)) {
      ladder = [priorServedBy.model, ...ladder.filter((m) => m !== priorServedBy.model)];
    }
    const assets = loadAssetsForBundle(dir);
    const versionName = (project.activeBuild && project.activeBuild.id === buildId && project.activeBuild.versionName) || "0.1.0";
    const cost = makeCostTracker();
    let totalRounds = 0, lastFailureText = "", referenceUsed = kind !== "implement";

    for (const model of ladder) {
      if (await rc.heartbeat("implement", totalRounds, model)) return pauseResult(task, "implement", totalRounds);
      const messages = [
        { role: "system", content: buildImplementSystemPrompt({ kit, theme, levels }) },
        { role: "user", content: buildImplementUserPrompt({ kind, design, reason: task.payload && task.payload.reason, failures: task.payload && task.payload.failures, includeReference: !referenceUsed, kit }) },
      ];
      if (!referenceUsed) referenceUsed = true;

      for (let round = 1; round <= maxRounds; round++) {
        totalRounds++;
        if (round > 1 && await rc.heartbeat("implement", totalRounds, model)) return pauseResult(task, "implement", totalRounds);
        const resp = await chat({ model, messages, maxTokens: 8000, temperature: 0.3 });
        if (!resp || resp.ok === false || !resp.content) { lastFailureText = `${model}: ${safeErr(resp && resp.error) || "no content"}`; break; }
        cost.add(resp);
        const parsed = parseFileBlocks(resp.content);
        if (parsed.error) {
          lastFailureText = `${model}: ${parsed.error}`;
          if (round < maxRounds) {
            messages.push({ role: "assistant", content: resp.content });
            messages.push({ role: "user", content: buildMissingFileFeedback(parsed.missing) });
            continue;
          }
          break;
        }
        const tempRoot = mkdtempSync(join(tmpdir(), "gf-forge-val-"));
        try {
          const bundleDir = join(tempRoot, "bundle");
          const resultsDir = join(tempRoot, "results");
          mkdirSync(resultsDir, { recursive: true });
          const meta = buildMeta({ design, catalogGame, theme, buildId, versionName });
          const buildDoc = kit.assembleBundle({ outDir: bundleDir, generated: parsed.files, meta, assets });
          const qa = await runner.run({ bundleDir, resultsDir });
          const suites = (qa && qa.results && qa.results.suites) || {};
          const failed = MUST_PASS_LOCALLY.filter((name) => !suites[name] || suites[name].status !== "PASSED");
          if (!failed.length) {
            const finalDoc = assembleFinal({ finalDir: buildsDir(buildId), generated: parsed.files, meta, assets, expectedSha: buildDoc.bundleSha256 });
            const servedBy = resp.servedBy || { model };
            persistSource(dir, buildId, parsed.files, { model, servedBy, at: Number(now()) || Date.now() });
            return completeResult(task, {
              kind, buildId, bundleSha256: finalDoc.bundleSha256, files: finalDoc.files,
              localQa: { passed: MUST_PASS_LOCALLY.filter((n) => !failed.includes(n)), failed: [] },
              servedBy, model, rounds: totalRounds, costUsd: cost.total,
            });
          }
          const details = failed.map((name) => {
            const s = suites[name] || {};
            const lines = (s.failures || []).slice(0, 12);
            return `${name}: ${s.summary || "FAILED"}${lines.length ? `\n  - ${lines.join("\n  - ")}` : ""}`;
          }).join("\n");
          lastFailureText = `${failed.join(", ")} FAILED`;
          if (round < maxRounds) {
            messages.push({ role: "assistant", content: resp.content });
            messages.push({ role: "user", content: buildQaRetryFeedback(details) });
          }
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      }
      // maxRounds exhausted on this rung without a passing build; try the next model from scratch.
    }
    return failResult(task, `No model produced a game that passes the local checks after ${totalRounds} round(s) on ${ladder.length} model(s); last failures: ${lastFailureText || "unknown"}.`, false);
  }

  // -----------------------------------------------------------------------------------------
  // Dispatch loop
  // -----------------------------------------------------------------------------------------
  async function processTask(task) {
    current = { taskId: task.id, kind: (task.payload && task.payload.kind) || task.capability, stage: "claimed", round: 0, model: null };
    const rc = makeRunContext(task);
    try {
      const project = store.getProject(task.uid, task.projectId, { eventLimit: 1 });
      if (!project) { failResult(task, "The project for this task no longer exists.", false); return; }
      if (task.capability === "product_planning") await runDesignTask(task, project, rc);
      else if (task.capability === "visual_design") await runAssetsTask(task, project, rc);
      else if (task.capability === "gameplay_engineering") await runGameplayTask(task, project, rc);
      else failResult(task, `The forge does not implement capability "${task.capability}".`, false);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        stats.lastError = safeErr(error);
        log(`[game-factory-forge] task ${task.id} lease was lost mid-run; abandoning without completing (${stats.lastError}).`);
        return;
      }
      const message = safeErr(error) || "the forge task failed unexpectedly";
      stats.lastError = message;
      try { store.failTask({ uid: task.uid, taskId: task.id, workerId: WORKER_ID, attempt: task.attempt, error: message, retryable: false }); stats.failed++; }
      catch (innerError) { log(`[game-factory-forge] failTask itself failed for task ${task.id}: ${safeErr(innerError)}`); }
    } finally {
      current = null;
    }
  }

  async function runTick() {
    for (const capability of CAPABILITY_ORDER) {
      const task = store.claimNextTask({ workerId: WORKER_ID, capability, leaseMs });
      if (!task) continue;
      await processTask(task);
      return { ok: true, claimed: true, capability, taskId: task.id };
    }
    return { ok: true, claimed: false };
  }

  function tick() {
    if (closed) return Promise.resolve({ ok: false, closed: true });
    if (ticking) return ticking;
    ticking = runTick()
      .catch((error) => {
        stats.lastError = safeErr(error) || "forge tick failed";
        log(`[game-factory-forge] tick failed: ${stats.lastError}`);
        return { ok: false, error: stats.lastError };
      })
      .finally(() => { ticking = null; });
    return ticking;
  }

  async function start() {
    if (closed) throw new Error("forge is closed");
    const first = await tick();
    if (!timer) {
      timer = setInterval(() => { tick(); }, Math.max(Number(pollMs) || 5000, 1000));
      if (typeof timer.unref === "function") timer.unref();
    }
    return first;
  }
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (ticking) await ticking.catch(() => {});
  }
  async function close() { await stop(); closed = true; }

  function health() {
    return {
      enabled: true, workerId: WORKER_ID, busy: current !== null, current: current ? { ...current } : null,
      lastError: stats.lastError, completed: stats.completed, failed: stats.failed, costUsd: stats.costUsd,
    };
  }

  return { start, stop, close, tick, health };
}
