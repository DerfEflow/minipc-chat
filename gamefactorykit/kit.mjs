/*
 * gamefactorykit/kit.mjs -- the Game Kit index. Every other lane imports from here (see
 * GAME-FACTORY-BUILD.md section 4: "Interfaces between lanes are exactly the exports named in each
 * LANE-*.md"). See LANE-gfkit.md for the exact export list this file must provide.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.mjs";
import { assembleBundle, verifyBundle, KIT_VERSION } from "./assemble.mjs";
// gamefactory.mjs is pure domain rules (no imports, no side effects -- verified before depending
// on it here) owned by the integration lane; read-only import so QA_SUITES can never drift from
// the store's own QA_REQUIRED_SUITES order.
import { QA_REQUIRED_SUITES } from "../gamefactory.mjs";

export { assembleBundle, verifyBundle, KIT_VERSION };

const HERE = dirname(fileURLToPath(import.meta.url));

export const QA_SUITES = QA_REQUIRED_SUITES;

/*
 * KIT_CONTRACT_TEXT -- the frozen game/rules.js + game/render.js + qa/fixtures.json contract from
 * GAME-FACTORY-BUILD.md section 2, as one string, for the forge (lane gfforge) to paste into its
 * code-generation prompts. Keep this byte-stable once other lanes start depending on it (a change
 * here changes what every future forge prompt says the contract is).
 */
export const KIT_CONTRACT_TEXT = `GAME KIT CONTRACT (frozen, GAME-FACTORY-BUILD.md section 2)

Bundle layout (assembled by gamefactorykit/assemble.mjs into DATA_DIR/game-factory/builds/<buildId>/bundle/):
  index.html                 kit template, filled with game meta
  manifest.webmanifest       kit template
  sw.js                      kit template (precache list generated at assembly)
  kit/runtime.js             kit: boot, canvas, input, layout, storage, ports wiring, reduced motion
  kit/ports.js               kit: AnalyticsPort, ConsentPort, MonetizationPort, HapticsPort (fakes, default off)
  game/rules.js               GENERATED: pure deterministic game logic (contract below)
  game/render.js              GENERATED: draw(ctx, state, layout, theme, t) using Canvas 2D only
  game/content.js             GENERATED: export default { schemaVersion, levels:[...], tutorial:[...] }
  game/meta.json              assembled: name, slug, version, palette, analytics schema, actions
  assets/icon-512.png        visual_design (Foundry or kit fallback)
  assets/icon-192.png        visual_design
  assets/splash.png          visual_design
  assets/provenance.json     visual_design: engine, model, prompt, sha256 per asset
  qa/fixtures.json           GENERATED: { levels: { [levelId]: { win: [actions], fail: [actions] } } }
  qa/run.mjs                 kit: the 12-suite harness (runs in node, imports game/rules.js)
  build.json                  supervisor: buildId, versionName, bundleSha256, files[{path,sha256,size}], toolchain

game/rules.js (ES module, no imports except ./content.js, no DOM, no Date/Math.random for game
logic -- the kit passes a deterministic seed):
  export const meta = { slug, name, actions: [{ type, params: [names] }], events: [names], schemaVersion: 1 };
  export function createState({ levelIndex = 0, seed = 1 }) -> state        // plain JSON object, never throws for a valid index
  export function applyAction(state, action) -> { state, events: [{ name, props }] } // pure; unknown/illegal action returns same state and []
  export function status(state) -> "playing" | "won" | "lost"
  export function levelCount() -> number
  export function serialize(state) -> string
  export function deserialize(text) -> state          // throws on corruption; kit catches
  export function validate(state) -> true | string    // invariants; used by fuzz
  export function layout(width, height) -> { board: {x,y,w,h}, controls: [{ id, label, x, y, w, h, action }] } // pure, all controls >= 44 px, none overlapping
  export function actionForPointer(state, layout, pointer) -> action | null   // pointer: { type: "down"|"move"|"up", x, y, dx, dy }
  export function actionForKey(state, key) -> action | null                    // arrow keys, Enter, Space, Escape, u (undo), r (restart), h (hint)
  export function hint(state) -> action | null                                 // deterministic

Reserved action types every game must handle: {type:"undo"}, {type:"restart"}, {type:"hint"},
{type:"next"} (after won), {type:"select_level", index}. applyAction must emit level_start-style
events named from meta.events only, with props limited to numbers, booleans and short enum strings
(no free text).

game/render.js: export function draw(ctx, state, layout, theme, t); may call only Canvas 2D methods
(fillRect, strokeRect, beginPath, moveTo, lineTo, arc, closePath, fill, stroke, fillText, save,
restore, translate, rotate, scale, setLineDash, clearRect, measureText, roundRect if present, and
the fillStyle/strokeStyle/lineWidth/font/textAlign/textBaseline/globalAlpha properties). theme
carries the palette from the visual system (a FLAT array of hex strings -- see themeFromVisual).
Reduced-motion is theme.reducedMotion === true.

qa/run.mjs output (qa/results.json):
  { schema: "gf-qa/1", bundleSha256, startedAt, endedAt, runner: "server-qa",
    suites: { "<suite>": { status: "PASSED"|"FAILED", summary: "one sentence", metrics: {...}, failures: [strings] } } }
All 12 QA_REQUIRED_SUITES keys always present, in this order: ${QA_REQUIRED_SUITES.join(", ")}.`;

/**
 * kitFiles() -> the three static kit files verbatim, keyed by their bundle-relative path. Reads
 * directly off disk relative to this file (NOT from assemble.mjs, to avoid a circular import --
 * assemble.mjs imports assembleBundle/verifyBundle FROM here indirectly via re-export, so this
 * file cannot import assemble.mjs's private file-reading helper back).
 */
export function kitFiles() {
  return {
    "kit/runtime.js": readFileSync(join(HERE, "runtime.js"), "utf8"),
    "kit/ports.js": readFileSync(join(HERE, "ports.js"), "utf8"),
    "qa/run.mjs": readFileSync(join(HERE, "qa", "run.mjs"), "utf8"),
  };
}

function hexToRgb(hex) {
  const h = String(hex || "#000000").replace("#", "");
  const norm = h.length === 3 ? h.split("").map((c) => c + c).join("") : (h + "000000").slice(0, 6);
  return [parseInt(norm.slice(0, 2), 16) || 0, parseInt(norm.slice(2, 4), 16) || 0, parseInt(norm.slice(4, 6), 16) || 0];
}

/**
 * fallbackIconPng({ size, palette, glyph }) -> Buffer. A deterministic, code-drawn PNG icon so
 * ASSET_GENERATION can never fail purely for lack of art (D8 in GAME-FACTORY-BUILD.md): background
 * palette[0], a simple geometric glyph in palette[1]. `glyph` selects the shape: "circle"
 * (default), "diamond", "square", or "triangle". Same inputs always produce the same output byte
 * for byte (no randomness, no timestamps).
 */
export function fallbackIconPng({ size = 512, palette = ["#0B1020", "#38E8FF"], glyph = "circle" } = {}) {
  const s = Math.max(16, Math.trunc(size) || 512);
  const [bgR, bgG, bgB] = hexToRgb(palette[0]);
  const [fgR, fgG, fgB] = hexToRgb(palette[1] || "#FFFFFF");
  const rgba = new Uint8Array(s * s * 4);
  const cx = s / 2, cy = s / 2, r = s * 0.34;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      let inside;
      if (glyph === "diamond") inside = Math.abs(dx) / r + Math.abs(dy) / r <= 1;
      else if (glyph === "square") inside = Math.abs(dx) <= r * 0.85 && Math.abs(dy) <= r * 0.85;
      else if (glyph === "triangle") inside = dy <= r && dy >= -r && Math.abs(dx) <= r * (1 - (dy + r) / (2 * r));
      else inside = dx * dx + dy * dy <= r * r;
      const idx = (y * s + x) * 4;
      if (inside) { rgba[idx] = fgR; rgba[idx + 1] = fgG; rgba[idx + 2] = fgB; rgba[idx + 3] = 255; }
      else { rgba[idx] = bgR; rgba[idx + 1] = bgG; rgba[idx + 2] = bgB; rgba[idx + 3] = 255; }
    }
  }
  return encodePng({ width: s, height: s, rgba });
}

/**
 * referenceGame(slug = "vector-vault") -> { "game/rules.js", "game/render.js", "game/content.js",
 * "qa/fixtures.json" } strings, read from gamefactorykit/reference/<slug>/. Only "vector-vault"
 * ships with this build; an unknown slug throws with the list of what is actually available.
 */
export function referenceGame(slug = "vector-vault") {
  const dir = join(HERE, "reference", slug);
  let entries;
  try { entries = readdirSync(join(HERE, "reference")); } catch { entries = []; }
  if (!entries.includes(slug)) throw new Error(`referenceGame: unknown slug "${slug}" (available: ${entries.join(", ") || "none"})`);
  return {
    "game/rules.js": readFileSync(join(dir, "rules.js"), "utf8"),
    "game/render.js": readFileSync(join(dir, "render.js"), "utf8"),
    "game/content.js": readFileSync(join(dir, "content.js"), "utf8"),
    "qa/fixtures.json": readFileSync(join(dir, "fixtures.json"), "utf8"),
  };
}

/**
 * themeFromVisual(visual) -> { palette: [hex...], names: [...], type, reducedMotion: false }.
 * Adapts a portfolio catalog visual entry (gamefactorytemplates.mjs: visual.palette is an array of
 * [name, hex] pairs) into the FLAT hex-array shape render.js and assembleBundle's meta.palette
 * both expect. This is the one place that conversion happens; callers should never hand-roll it.
 */
export function themeFromVisual(visual) {
  const pairs = Array.isArray(visual && visual.palette) ? visual.palette : [];
  return {
    palette: pairs.map((p) => (Array.isArray(p) ? p[1] : p)),
    names: pairs.map((p) => (Array.isArray(p) ? p[0] : "")),
    type: (visual && visual.type) || "",
    reducedMotion: false,
  };
}
