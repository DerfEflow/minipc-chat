#!/usr/bin/env node
/*
 * gamefactorykit/qa/run.mjs -- the 12-suite QA harness for an assembled Game Kit bundle.
 * Usage: node qa/run.mjs --bundle <dir> --out <file>
 *
 * This file is copied VERBATIM into every bundle's qa/ directory by assembleBundle (it is a kit
 * file, not generated per-project), so it is fully self-contained: zero imports from outside the
 * bundle it ships in, zero npm dependencies, only node: built-ins.
 *
 * Suite order matches gamefactory.mjs's QA_REQUIRED_SUITES exactly (and gamefactorykit/kit.mjs's
 * QA_SUITES, which imports that same array) -- see SUITE_NAMES below; keep the three in sync.
 *
 * Each suite runs in its own try/catch (a crash in one suite must never hide the other 11 -- see
 * runSuite()). The file always writes all 12 suite results and exits 0 once the results file is
 * written; PASS/FAIL is data in the file, never the process exit code (a supervisor reads the
 * file, not the exit code, to decide what happened).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";

const SUITE_NAMES = Object.freeze([
  "core-loop", "launch-smoke", "crash-regression", "controls", "save-state",
  "viewport", "performance", "monetization", "offline", "analytics",
  "privacy-consent", "store-readiness",
]);

// -- CLI ------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle") out.bundle = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

// -- small deterministic helpers -------------------------------------------------------------------

// mulberry32: tiny seeded PRNG, deterministic across runs/platforms (per AGENT-RULES.md, tests
// must be deterministic; per the kit contract, "seeded RNG for fuzz").
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function readText(path) { return readFileSync(path, "utf8"); }

// -- recording Canvas 2D context (launch-smoke, performance) ----------------------------------------

const ALLOWED_CANVAS_METHODS = new Set([
  "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "arc", "closePath", "fill", "stroke",
  "fillText", "save", "restore", "translate", "rotate", "scale", "setLineDash", "clearRect",
  "measureText", "roundRect",
]);
const ALLOWED_CANVAS_PROPS = new Set([
  "fillStyle", "strokeStyle", "lineWidth", "font", "textAlign", "textBaseline", "globalAlpha",
]);

function createRecordingContext() {
  const counts = {};
  const state = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", globalAlpha: 1 };
  const target = {};
  for (const m of ALLOWED_CANVAS_METHODS) {
    target[m] = (...args) => {
      counts[m] = (counts[m] || 0) + 1;
      if (m === "measureText") return { width: String(args[0] || "").length * 6 };
      return undefined;
    };
  }
  const ctx = new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "__counts") return counts;
      if (prop in obj) return obj[prop];
      if (ALLOWED_CANVAS_PROPS.has(prop)) return state[prop];
      throw new Error(`recording canvas context: '${String(prop)}' is not in the allowed Canvas 2D subset`);
    },
    set(obj, prop, value) {
      if (ALLOWED_CANVAS_PROPS.has(prop)) { state[prop] = value; return true; }
      throw new Error(`recording canvas context: '${String(prop)}' is not an allowed Canvas 2D property to set`);
    },
  });
  return ctx;
}

// -- best-effort ESM syntax check via vm.Script ------------------------------------------------------
//
// MEASURED (rule 8.6), not guessed: on this machine (Node v24.14.1) vm.SourceTextModule is not a
// constructor without --experimental-vm-modules, and child_process is denied under --permission
// without an explicit --allow-child-process grant (which gamefactoryqa.mjs deliberately does not
// give this process -- see its own file header). That rules out both `node --check` (needs
// child_process) and a real ESM-aware parse (needs --experimental-vm-modules, an extra flag this
// build does not add). vm.Script parses as a classic (non-module) script, so raw `import`/`export`
// syntax is a SyntaxError to it even in a perfectly valid module. This strips top-level
// import/export syntax (turning `export default X` into an assignment so object/array literals
// still parse as expressions, not as a labelled block statement) before handing the rest of the
// file to vm.Script. It is a best-effort smoke check, not a full parser -- it can be fooled by
// import/export keywords inside strings, and it does not re-verify files that get imported for
// real elsewhere in this harness (game/rules.js, game/render.js, game/content.js, kit/ports.js: a
// successful dynamic import() of those IS a strictly stronger proof than vm.Script). It exists
// specifically for browser-only files this harness never imports (kit/runtime.js), so their syntax
// still gets checked somehow.
function stripEsmForSyntaxCheck(source) {
  return source
    .replace(/^\s*import\s+[^;]*?from\s+["'][^"']*["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'][^"']*["'];?\s*$/gm, "")
    .replace(/^(\s*)export\s+default\s+/gm, "$1globalThis.__qa_esm_default__ = ")
    .replace(/^(\s*)export\s+(const|let|var|function|class|async\s+function)\s+/gm, "$1$2 ")
    .replace(/^(\s*)export\s*\{[^}]*\}\s*;?\s*$/gm, "");
}

function checkSyntax(source, filename) {
  try { new Script(stripEsmForSyntaxCheck(source), { filename }); return null; }
  catch (e) { return e.message; }
}

// -- suite runner scaffold -------------------------------------------------------------------------

async function runSuite(name, fn) {
  const startedAt = Date.now();
  try {
    const r = await fn();
    return { status: r.ok ? "PASSED" : "FAILED", summary: r.summary, metrics: r.metrics || {}, failures: r.failures || [], _ms: Date.now() - startedAt };
  } catch (e) {
    return { status: "FAILED", summary: "the suite crashed: " + (e && e.message || String(e)), metrics: {}, failures: [String(e && e.stack || e)], _ms: Date.now() - startedAt };
  }
}

// -- main ---------------------------------------------------------------------------------------

async function main() {
  const { bundle, out } = parseArgs(process.argv.slice(2));
  if (!bundle || !out) {
    process.stderr.write("usage: node qa/run.mjs --bundle <dir> --out <file>\n");
    process.exit(2);
    return;
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const bundleFiles = walk(bundle); // relative, forward-slash paths
  let buildJson = null, metaJson = null;
  try { buildJson = readJson(join(bundle, "build.json")); } catch { /* handled per-suite */ }
  try { metaJson = readJson(join(bundle, "game", "meta.json")); } catch { /* handled per-suite */ }

  let rules = null, render = null, fixtures = null, ports = null;
  const loadErrors = {};
  try { rules = await import(pathToFileURL(join(bundle, "game", "rules.js")).href); } catch (e) { loadErrors.rules = String(e && e.message || e); }
  try { render = await import(pathToFileURL(join(bundle, "game", "render.js")).href); } catch (e) { loadErrors.render = String(e && e.message || e); }
  try { fixtures = readJson(join(bundle, "qa", "fixtures.json")); } catch (e) { loadErrors.fixtures = String(e && e.message || e); }
  try { ports = await import(pathToFileURL(join(bundle, "kit", "ports.js")).href); } catch (e) { loadErrors.ports = String(e && e.message || e); }

  function allLevelIds() {
    if (!rules) return [];
    const n = rules.levelCount();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(rules.createState({ levelIndex: i, seed: 1 }).levelId);
    return ids;
  }

  const suites = {};

  // -- launch-smoke ------------------------------------------------------------------------------
  suites["launch-smoke"] = await runSuite("launch-smoke", async () => {
    const failures = [];
    const requiredTop = ["index.html", "manifest.webmanifest", "sw.js", "build.json",
      "kit/runtime.js", "kit/ports.js", "game/rules.js", "game/render.js", "game/content.js", "game/meta.json",
      "qa/fixtures.json", "qa/run.mjs"];
    for (const f of requiredTop) if (!bundleFiles.includes(f)) failures.push(`missing required bundle file: ${f}`);

    for (const f of bundleFiles) {
      if (!/\.(m?js)$/.test(f)) continue;
      const src = readText(join(bundle, f));
      const err = checkSyntax(src, f);
      if (err) failures.push(`syntax error in ${f}: ${err}`);
    }

    if (bundleFiles.includes("index.html")) {
      const html = readText(join(bundle, "index.html"));
      const refs = [...html.matchAll(/(?:src|href)=["']([^"':][^"']*)["']/g)].map((m) => m[1]).filter((r) => !/^https?:|^data:|^\/\//.test(r));
      for (const r of refs) {
        const clean = r.split("?")[0].split("#")[0].replace(/^\.\//, "");
        if (clean && !bundleFiles.includes(clean)) failures.push(`index.html references missing file: ${clean}`);
      }
    } else failures.push("index.html missing, cannot check references");

    if (loadErrors.rules) failures.push("game/rules.js failed to import: " + loadErrors.rules);
    if (loadErrors.render) failures.push("game/render.js failed to import: " + loadErrors.render);

    if (rules) {
      const n = rules.levelCount();
      for (let i = 0; i < n; i++) {
        try { rules.createState({ levelIndex: i, seed: 1 }); }
        catch (e) { failures.push(`createState(${i}) threw: ${e.message}`); }
      }
    }
    if (rules && render) {
      const n = rules.levelCount();
      for (let i = 0; i < n; i++) {
        const state = rules.createState({ levelIndex: i, seed: 1 });
        const layoutInfo = rules.layout(390, 844);
        const ctx = createRecordingContext();
        try { render.draw(ctx, state, layoutInfo, { palette: ["#000", "#111", "#222", "#333", "#fff"], reducedMotion: false }, 0); }
        catch (e) { failures.push(`render.draw threw for level ${i} (frame 0): ${e.message}`); }
      }
    }
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} launch-smoke problem(s)` : "every bundle file present, every .js/.mjs syntax-checked, frame 0 draws cleanly for every level", failures };
  });

  // -- core-loop -----------------------------------------------------------------------------------
  suites["core-loop"] = await runSuite("core-loop", async () => {
    if (!rules || !fixtures) return { ok: false, summary: "rules.js or qa/fixtures.json unavailable", failures: [loadErrors.rules, loadErrors.fixtures].filter(Boolean) };
    const failures = [];
    const ids = allLevelIds();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const fx = fixtures.levels && fixtures.levels[id];
      if (!fx) { failures.push(`no fixtures for level ${id}`); continue; }
      let s = rules.createState({ levelIndex: i, seed: 1 });
      for (const a of fx.win || []) s = rules.applyAction(s, a).state;
      if (rules.status(s) !== "won") failures.push(`level ${id}: win fixture did not reach "won" (got "${rules.status(s)}")`);

      let s2 = rules.createState({ levelIndex: i, seed: 1 });
      for (const a of fx.fail || []) s2 = rules.applyAction(s2, a).state;
      if (rules.status(s2) !== "lost") failures.push(`level ${id}: fail fixture did not reach "lost" (got "${rules.status(s2)}")`);
      const restarted = rules.applyAction(s2, { type: "restart" }).state;
      if (rules.status(restarted) !== "playing") failures.push(`level ${id}: restart after loss did not return to "playing"`);

      const fresh = rules.createState({ levelIndex: i, seed: 1 });
      const beforeSerialized = rules.serialize(fresh);
      const afterOne = rules.applyAction(fresh, { type: "select_vector", index: -1 }).state;
      const undone = rules.applyAction(afterOne, { type: "undo" }).state;
      if (rules.serialize(undone) !== beforeSerialized) failures.push(`level ${id}: undo after one action did not restore the prior serialized state`);
    }
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} core-loop problem(s)` : `${ids.length} levels: win/fail/restart/undo all correct`, failures };
  });

  // -- crash-regression ------------------------------------------------------------------------------
  suites["crash-regression"] = await runSuite("crash-regression", async () => {
    if (!rules) return { ok: false, summary: "rules.js unavailable", failures: [loadErrors.rules].filter(Boolean) };
    const failures = [];
    const ids = allLevelIds();
    const ACTIONS_PER_LEVEL = 2000;
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter", "Escape", "u", "r", "h", "Tab", "x"];
    const types = ["select_vector", "rotate", "magnitude", "launch", "undo", "restart", "hint", "next", "select_level"];
    for (let i = 0; i < ids.length; i++) {
      const rnd = mulberry32(0xC0FFEE + i);
      let state = rules.createState({ levelIndex: i, seed: 1 });
      const layoutInfo = rules.layout(390, 844);
      for (let k = 0; k < ACTIONS_PER_LEVEL; k++) {
        const kind = Math.floor(rnd() * 3);
        let action = null;
        if (kind === 0) action = rules.actionForKey(state, keys[Math.floor(rnd() * keys.length)]);
        else if (kind === 1) { const c = layoutInfo.controls[Math.floor(rnd() * layoutInfo.controls.length)]; action = { ...c.action }; }
        else action = { type: types[Math.floor(rnd() * types.length)], index: Math.floor(rnd() * 5) - 1, delta: Math.floor(rnd() * 11) - 5 };
        if (!action) continue;
        try {
          const r = rules.applyAction(state, action);
          state = r.state;
          const problem = rules.validate(state);
          if (problem !== true) { failures.push(`level ${ids[i]} step ${k}: validate() failed after ${JSON.stringify(action)}: ${problem}`); break; }
        } catch (e) {
          failures.push(`level ${ids[i]} step ${k}: applyAction threw on ${JSON.stringify(action)}: ${e.message}`);
          break;
        }
      }
    }
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} level(s) hit a crash or invariant break` : `${ids.length} levels x ${ACTIONS_PER_LEVEL} random actions, zero throws, invariants held`, failures, metrics: { levelsChecked: ids.length, actionsPerLevel: ACTIONS_PER_LEVEL } };
  });

  // -- controls -------------------------------------------------------------------------------------
  suites["controls"] = await runSuite("controls", async () => {
    if (!rules) return { ok: false, summary: "rules.js unavailable", failures: [loadErrors.rules].filter(Boolean) };
    const failures = [];
    const layoutInfo = rules.layout(390, 844);
    for (const c of layoutInfo.controls) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      const state = rules.createState({ levelIndex: 0, seed: 1 });
      const got = rules.actionForPointer(state, layoutInfo, { type: "down", x: cx, y: cy, dx: 0, dy: 0 });
      if (!got || JSON.stringify(got) !== JSON.stringify(c.action)) failures.push(`control ${c.id}: tap at centre yielded ${JSON.stringify(got)}, expected ${JSON.stringify(c.action)}`);
    }
    // A recognized action is one the GAME declares (rules.meta.actions) or one of the contract's
    // reserved types. Integration review (Fable 2026-09-03): this set was hardcoded to the reference
    // game's own action names, so every generated game with different names failed the key test.
    const RESERVED_TYPES = ["undo", "restart", "hint", "next", "select_level"];
    const KNOWN_TYPES = new Set([...RESERVED_TYPES, ...((rules.meta && Array.isArray(rules.meta.actions)) ? rules.meta.actions.map((a) => a && a.type).filter(Boolean) : [])]);
    const testKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter", "Escape", "u", "r", "h"];
    const freshForKeys = rules.createState({ levelIndex: 0, seed: 1 });
    for (const key of testKeys) {
      const action = rules.actionForKey(freshForKeys, key);
      if (!action || !KNOWN_TYPES.has(action.type)) { failures.push(`key "${key}" did not map to a recognized action (got ${JSON.stringify(action)})`); continue; }
      try { rules.applyAction(freshForKeys, action); } catch (e) { failures.push(`key "${key}" -> ${JSON.stringify(action)} threw in applyAction: ${e.message}`); }
    }
    // Reserved actions (undo, restart, hint, next, select_level) are driven by the kit's own chrome and
    // keys, so a game is not required to give them a board control; everything else the game declares
    // as an action needs a tappable step control (accessibility: step buttons mirror gestures).
    const nonGesture = new Set([...(rules.NON_GESTURE_ACTIONS || []), ...RESERVED_TYPES]);
    for (const a of rules.meta.actions) {
      if (nonGesture.has(a.type)) continue;
      const hasControl = layoutInfo.controls.some((c) => c.action.type === a.type);
      if (!hasControl) failures.push(`gesture action "${a.type}" has no step control in layout()`);
    }
    for (const c of layoutInfo.controls) if (c.w < 44 || c.h < 44) failures.push(`control ${c.id} is smaller than 44px (${c.w}x${c.h})`);
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} control problem(s)` : "every control taps to its action, every gesture key recognized, every gesture class has a control", failures };
  });

  // -- save-state -------------------------------------------------------------------------------------
  suites["save-state"] = await runSuite("save-state", async () => {
    if (!rules) return { ok: false, summary: "rules.js unavailable", failures: [loadErrors.rules].filter(Boolean) };
    const failures = [];
    const ids = allLevelIds();
    for (let i = 0; i < ids.length; i++) {
      const s = rules.createState({ levelIndex: i, seed: 1 });
      const text = rules.serialize(s);
      let restored;
      try { restored = rules.deserialize(text); } catch (e) { failures.push(`level ${ids[i]}: round-trip deserialize threw: ${e.message}`); continue; }
      if (JSON.stringify(restored) !== JSON.stringify(s)) failures.push(`level ${ids[i]}: serialize/deserialize round trip is not equal`);
      if (rules.validate(restored) !== true) failures.push(`level ${ids[i]}: validate() failed after restore`);
    }
    const corrupt = ["", "{", "{\"schemaVersion\":1,\"lev", "not json at all {{{", "12345", "null", "garbage not json 0xFF 0xFE bytes here"];
    for (const bad of corrupt) {
      let threw = false;
      try { rules.deserialize(bad); } catch { threw = true; }
      if (!threw) failures.push(`deserialize(${JSON.stringify(bad)}) did not throw`);
    }
    // v0 save: a plausible legacy shape with no schemaVersion at all.
    const v0 = JSON.stringify({ levelIndex: 0, vectors: [{ angle: 0, magnitude: 1 }], selected: 0 });
    let v0Threw = false;
    try { rules.deserialize(v0); } catch { v0Threw = true; }
    if (!v0Threw) failures.push("deserialize() of a v0 (no schemaVersion) save neither migrated to a valid state nor threw");
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} save-state problem(s)` : `${ids.length} levels round-trip cleanly; corruption and v0 saves are all rejected`, failures };
  });

  // -- viewport ---------------------------------------------------------------------------------------
  suites["viewport"] = await runSuite("viewport", async () => {
    if (!rules) return { ok: false, summary: "rules.js unavailable", failures: [loadErrors.rules].filter(Boolean) };
    const failures = [];
    const sizes = [[390, 844], [768, 1024], [1024, 768], [360, 640]];
    for (const [w, h] of sizes) {
      const layoutInfo = rules.layout(w, h);
      const { board, controls } = layoutInfo;
      const items = [{ id: "board", ...board }, ...controls];
      for (const it of items) {
        if (it.id !== "board" && (it.w < 44 || it.h < 44)) failures.push(`${w}x${h}: control ${it.id} is ${it.w}x${it.h}, under 44px`);
        if (it.x < 0 || it.y < 0 || it.x + it.w > w + 1e-6 || it.y + it.h > h + 1e-6) failures.push(`${w}x${h}: ${it.id} is outside the viewport (${JSON.stringify(it)})`);
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i], b = controls[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          if (overlap) failures.push(`${w}x${h}: controls ${a.id} and ${b.id} overlap`);
        }
      }
    }
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} viewport problem(s)` : "4 viewports: no control under 44px, none overlapping, everything on-screen", failures };
  });

  // -- performance ------------------------------------------------------------------------------------
  suites["performance"] = await runSuite("performance", async () => {
    if (!rules) return { ok: false, summary: "rules.js unavailable", failures: [loadErrors.rules].filter(Boolean) };
    const failures = [];
    const metrics = {};
    let state = rules.createState({ levelIndex: 0, seed: 1 });
    const t0 = Date.now();
    for (let i = 0; i < 20000; i++) state = rules.applyAction(state, { type: "select_vector", index: i % 2 === 0 ? -1 : -2 }).state;
    metrics.applyActionMs = Date.now() - t0;
    if (metrics.applyActionMs >= 2000) failures.push(`20000 applyAction calls took ${metrics.applyActionMs}ms, budget is 2000ms`);

    if (render) {
      const layoutInfo = rules.layout(390, 844);
      const ctx = createRecordingContext();
      const theme = { palette: ["#0B1020", "#38E8FF", "#FFC857", "#FF5D73", "#F5F7FF"], reducedMotion: false };
      const t1 = Date.now();
      for (let i = 0; i < 120; i++) render.draw(ctx, state, layoutInfo, theme, i * 16);
      metrics.drawMs = Date.now() - t1;
      if (metrics.drawMs >= 1000) failures.push(`120 draw() calls took ${metrics.drawMs}ms, budget is 1000ms`);
    } else failures.push("render.js unavailable, cannot measure draw performance");

    // Stress the save-size budget with a state carrying a FULL undo history (worst case).
    let stressed = rules.createState({ levelIndex: 0, seed: 1 });
    for (let i = 0; i < 25; i++) stressed = rules.applyAction(stressed, { type: "select_vector", index: i % 2 === 0 ? -1 : -2 }).state;
    const bytes = Buffer.byteLength(rules.serialize(stressed), "utf8");
    metrics.serializedBytes = bytes;
    if (bytes >= 65536) failures.push(`serialized state is ${bytes} bytes, budget is 65536`);

    return { ok: failures.length === 0, summary: failures.length ? failures.join("; ") : `applyAction ${metrics.applyActionMs}ms/20000, draw ${metrics.drawMs}ms/120, save ${metrics.serializedBytes}B`, failures, metrics };
  });

  // -- monetization -------------------------------------------------------------------------------------
  suites["monetization"] = await runSuite("monetization", async () => {
    if (!ports) return { ok: false, summary: "kit/ports.js unavailable", failures: [loadErrors.ports].filter(Boolean) };
    const failures = [];
    { const p = ports.createPorts().monetization; if (p.state() !== "disabled" || p.enabled()) failures.push("fresh monetization port is not disabled by default"); }
    { const p = ports.createPorts().monetization; p.enable(); const r = p.purchase("sku"); if (!r.ok || !r.receipt || p.state() !== "entitled") failures.push("purchase() did not entitle"); }
    { const p = ports.createPorts().monetization; p.enable(); p.cancel(); if (p.state() === "entitled") failures.push("cancel() left the port entitled"); }
    { const p = ports.createPorts().monetization; p.enable(); p.fail(); if (p.state() === "entitled") failures.push("fail() left the port entitled"); }
    { const p = ports.createPorts().monetization; p.enable(); p.purchase("sku"); p.revoke(); if (p.state() === "entitled") failures.push("revoke() did not clear entitlement");
      const r = p.restore(); if (!r.ok || p.state() !== "entitled") failures.push("restore() did not return entitlement after revoke"); }
    { const p = ports.createPorts().monetization; p.enable(); const receipt = { id: "dup-1" };
      const first = p.callback(receipt), second = p.callback(receipt);
      if (!first.ok) failures.push("first callback() application was not ok");
      if (second.ok) failures.push("duplicate callback() was not idempotent (applied twice)");
      if (p.state() !== "entitled") failures.push("state lost after duplicate callback()"); }

    // "never emits a purchase prompt event during playing": run every level's win fixture and
    // check no emitted event name looks like a purchase prompt while state.status is "playing".
    let purchasePromptDuringPlay = false;
    if (rules && fixtures) {
      const ids = allLevelIds();
      for (let i = 0; i < ids.length; i++) {
        const fx = fixtures.levels && fixtures.levels[ids[i]];
        if (!fx) continue;
        let s = rules.createState({ levelIndex: i, seed: 1 });
        for (const a of fx.win || []) {
          const wasPlaying = s.status === "playing";
          const r = rules.applyAction(s, a);
          s = r.state;
          if (wasPlaying && r.events.some((e) => /purchase/i.test(e.name))) purchasePromptDuringPlay = true;
        }
      }
    }
    if (purchasePromptDuringPlay) failures.push("a purchase-prompt-shaped event fired while status was \"playing\"");

    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} monetization problem(s)` : "fake adapter transitions correctly disabled/unentitled/entitled, idempotent callback, no purchase prompts mid-play", failures };
  });

  // -- offline -------------------------------------------------------------------------------------------
  suites["offline"] = await runSuite("offline", async () => {
    const failures = [];
    const forbidden = [/fetch\(/, /XMLHttpRequest/, /WebSocket/, /importScripts\(/, /navigator\.sendBeacon/, /https?:\/\//];
    // qa/run.mjs is excluded: it is server-side QA tooling (see gamefactoryqa.mjs), never code that
    // runs on the player's device, and its OWN source necessarily contains these pattern names
    // literally (the `forbidden` array right above this comment) because its job is to check for
    // them -- scanning it would be a guaranteed, meaningless self-match, not a real offline defect.
    for (const f of bundleFiles) {
      if (!/\.(m?js)$/.test(f) || f === "qa/run.mjs") continue;
      const text = readText(join(bundle, f));
      for (const pattern of forbidden) {
        if (pattern.test(text)) failures.push(`${f} contains a forbidden network pattern: ${pattern}`);
      }
    }
    if (bundleFiles.includes("sw.js")) {
      const swText = readText(join(bundle, "sw.js"));
      const m = /^const\s+PRECACHE\s*=\s*(\[[\s\S]*?\]);\s*$/m.exec(swText);
      if (!m) failures.push("sw.js has no `const PRECACHE = [...]` list to check");
      else {
        let precache;
        try { precache = JSON.parse(m[1]); } catch (e) { failures.push("sw.js PRECACHE list is not valid JSON: " + e.message); precache = null; }
        if (precache) {
          const expected = bundleFiles.filter((f) => f !== "sw.js" && f !== "build.json").sort();
          const actual = precache.slice().sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            const missing = expected.filter((f) => !actual.includes(f));
            const extra = actual.filter((f) => !expected.includes(f));
            failures.push(`sw.js precache does not equal the bundle file list (missing: ${JSON.stringify(missing)}, extra: ${JSON.stringify(extra)})`);
          }
        }
      }
    } else failures.push("sw.js missing");
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} offline problem(s)` : "no network APIs referenced anywhere in the bundle's JS, sw.js precache matches the file list", failures };
  });

  // -- analytics --------------------------------------------------------------------------------------------
  suites["analytics"] = await runSuite("analytics", async () => {
    if (!rules || !fixtures) return { ok: false, summary: "rules.js or qa/fixtures.json unavailable", failures: [loadErrors.rules, loadErrors.fixtures].filter(Boolean) };
    const failures = [];
    const allowed = new Set((metaJson && metaJson.analytics) || rules.meta.events || []);
    if (allowed.size === 0) failures.push("no declared analytics events found (meta.json analytics / rules.js meta.events both empty)");
    const idPattern = /(email|name|phone|address|id)$/i;
    const ids = allLevelIds();
    let emittedCount = 0;
    for (let i = 0; i < ids.length; i++) {
      const fx = fixtures.levels && fixtures.levels[ids[i]];
      if (!fx) continue;
      let s = rules.createState({ levelIndex: i, seed: 1 });
      for (const a of [...(fx.win || []), ...(fx.fail || [])]) {
        const r = rules.applyAction(s, a);
        s = r.state;
        for (const ev of r.events) {
          emittedCount++;
          if (!allowed.has(ev.name)) failures.push(`event "${ev.name}" (level ${ids[i]}) is not declared in meta.events`);
          for (const [key, value] of Object.entries(ev.props || {})) {
            if (key !== "level_id" && idPattern.test(key)) failures.push(`event "${ev.name}" prop key "${key}" looks like a free identifier field`);
            if (typeof value === "string" && value.length > 32) failures.push(`event "${ev.name}" prop "${key}" is a ${value.length}-char string, over the 32-char budget`);
          }
        }
      }
    }
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} analytics problem(s)` : `${emittedCount} events emitted across fixtures, all declared, no oversized or identifier-shaped props`, failures, metrics: { emittedCount } };
  });

  // -- privacy-consent --------------------------------------------------------------------------------------
  suites["privacy-consent"] = await runSuite("privacy-consent", async () => {
    if (!ports) return { ok: false, summary: "kit/ports.js unavailable", failures: [loadErrors.ports].filter(Boolean) };
    const failures = [];
    const p = ports.createPorts();
    if (p.consent.state() !== "denied") failures.push("consent does not default to denied");
    p.analytics.track("probe_1", { n: 1 });
    p.analytics.track("probe_2", { n: 2 });
    if (p.analytics.sink.length !== 0) failures.push("analytics sink is not empty before consent is granted");
    p.consent.grant();
    if (p.analytics.sink.length !== 2) failures.push("analytics sink was not flushed on grant()");
    p.analytics.track("probe_3", {});
    if (p.analytics.sink.length !== 3) failures.push("track() after grant() did not reach the sink");
    p.consent.revoke();
    if (p.consent.state() !== "denied") failures.push("revoke() did not return consent to denied");
    if (p.analytics.queue().length !== 0) failures.push("revoke() did not empty the pending queue");

    if (metaJson) {
      const piiKeys = /^(email|phone|address|ssn|deviceid|playerid|userid|username|firstname|lastname|fullname)$/i;
      const bad = [];
      (function scan(obj, path) {
        if (!obj || typeof obj !== "object") return;
        for (const [k, v] of Object.entries(obj)) {
          if (piiKeys.test(k)) bad.push(path + "." + k);
          if (v && typeof v === "object") scan(v, path + "." + k);
        }
      })(metaJson, "meta.json");
      if (bad.length) failures.push("meta.json has player-identifying field(s): " + bad.join(", "));
    } else failures.push("game/meta.json unavailable, cannot check for identifier fields");

    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} privacy-consent problem(s)` : "consent defaults denied, analytics withheld until granted, revoke empties the pending queue, meta.json carries no player-identifying fields", failures };
  });

  // -- store-readiness ---------------------------------------------------------------------------------------
  suites["store-readiness"] = await runSuite("store-readiness", async () => {
    const failures = [];
    if (!metaJson) failures.push("game/meta.json missing");
    else {
      for (const field of ["versionName", "slug", "name", "subtitle", "keywords"]) {
        if (metaJson[field] === undefined || metaJson[field] === null || metaJson[field] === "") failures.push(`game/meta.json missing field: ${field}`);
      }
    }
    let manifest = null;
    if (bundleFiles.includes("manifest.webmanifest")) {
      try { manifest = readJson(join(bundle, "manifest.webmanifest")); }
      catch (e) { failures.push("manifest.webmanifest is not valid JSON: " + e.message); }
    } else failures.push("manifest.webmanifest missing");
    if (manifest) {
      for (const field of ["name", "short_name", "start_url", "display"]) {
        if (!manifest[field]) failures.push(`manifest.webmanifest missing field: ${field}`);
      }
      const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
      for (const size of ["192x192", "512x512"]) {
        const entry = icons.find((ic) => ic.sizes === size);
        if (!entry) failures.push(`manifest.webmanifest missing an icon entry sized ${size}`);
        else {
          const rel = entry.src.replace(/^\.?\//, "");
          if (!bundleFiles.includes(rel)) failures.push(`manifest icon ${size} points at missing file: ${entry.src}`);
        }
      }
    }
    let provenance = null;
    if (bundleFiles.includes("assets/provenance.json")) {
      try { provenance = readJson(join(bundle, "assets", "provenance.json")); }
      catch (e) { failures.push("assets/provenance.json is not valid JSON: " + e.message); }
    } else failures.push("assets/provenance.json missing");
    if (provenance) {
      const list = Array.isArray(provenance) ? provenance : (Array.isArray(provenance.assets) ? provenance.assets : null);
      if (!list) failures.push("assets/provenance.json is not a list (and has no .assets list)");
      else {
        for (const entry of list) if (!entry.sha256) failures.push(`provenance entry for ${entry.path || "(unknown)"} has no sha256`);
        const assetFiles = bundleFiles.filter((f) => f.startsWith("assets/") && f !== "assets/provenance.json");
        for (const f of assetFiles) {
          const has = list.some((e) => e.path === f || e.file === f);
          if (!has) failures.push(`asset ${f} has no provenance entry`);
        }
      }
    }
    return { ok: failures.length === 0, summary: failures.length ? `${failures.length} store-readiness problem(s)` : "manifest, meta.json and provenance all present and complete", failures };
  });

  // -- assemble results, always all 12 --------------------------------------------------------------------
  const resultSuites = {};
  for (const name of SUITE_NAMES) {
    resultSuites[name] = suites[name] || { status: "FAILED", summary: `the harness did not report this suite (never ran)`, metrics: {}, failures: [] };
    delete resultSuites[name]._ms;
  }

  let bundleSha256 = buildJson && buildJson.bundleSha256 || "";
  const results = {
    schema: "gf-qa/1",
    bundleSha256,
    startedAt,
    endedAt: new Date().toISOString(),
    runner: "server-qa",
    suites: resultSuites,
  };
  writeFileSync(out, JSON.stringify(results, null, 2));
  process.stderr.write(`[qa] wrote ${out} in ${Date.now() - t0}ms\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write("[qa] fatal: " + (e && e.stack || e) + "\n");
  process.exit(1);
});
