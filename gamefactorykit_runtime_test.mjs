/*
 * Boot smoke for gamefactorykit/runtime.js, the browser shim every generated game loads.
 *
 * The QA harness deliberately never imports runtime.js (it is browser-only), so until this test the
 * file had only ever been syntax-checked. This gives it a small fake DOM (document, window, canvas
 * with a recording 2D context, localStorage that throws like a sandboxed iframe, requestAnimationFrame
 * that runs a bounded number of frames) and boots the reference game through it, then optionally a real
 * assembled bundle named by GF_RUNTIME_BUNDLE (the rig's latest build). Proof kind: UNIT with a fake
 * DOM, not a browser; it catches undefined references, wrong contract fields and invisible controls,
 * not layout pixels.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as kit from "./gamefactorykit/kit.mjs";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok - " + name); }

function fakeDom({ width = 390, height = 844, sandboxed = true } = {}) {
  const calls = {};
  const count = (k) => { calls[k] = (calls[k] || 0) + 1; };
  const ctx = new Proxy({ canvas: null }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return (t) => { count("measureText"); return { width: String(t).length * 7 }; };
      return (...args) => { count(String(prop)); return undefined; };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const listeners = {};
  const el = (tag) => ({
    tag, style: {}, children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    getContext() { return ctx; },
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text || ""; },
    getElementById() { return null; },
  });
  const canvas = el("canvas"); ctx.canvas = canvas;
  const body = el("body");
  const doc = { body, hidden: false, createElement: (tag) => (tag === "canvas" ? canvas : el(tag)), getElementById: () => null, addEventListener(type, fn) { (listeners["doc:" + type] ||= []).push(fn); } };
  let frames = 0; const rafQueue = [];
  const win = {
    innerWidth: width, innerHeight: height, devicePixelRatio: 2, __gfStorage: undefined,
    addEventListener(type, fn) { (listeners["win:" + type] ||= []).push(fn); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame(fn) { frames++; if (frames <= 3) rafQueue.push(fn); return frames; },
    cancelAnimationFrame() {},
  };
  win.top = win; win.self = win;
  const storage = sandboxed ? { setItem() { throw new Error("SecurityError: sandboxed"); }, getItem() { throw new Error("sandboxed"); }, removeItem() { throw new Error("sandboxed"); } }
    : (() => { const m = new Map(); return { setItem: (k, v) => m.set(k, String(v)), getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k) }; })();
  Object.assign(globalThis, { window: win, document: doc, localStorage: storage, requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame });
  // Node exposes `navigator` as a getter-only global; shadow it with a plain object (no serviceWorker).
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  const runFrames = () => { while (rafQueue.length) rafQueue.shift()(performance.now()); };
  return { calls, canvas, body, win, doc, listeners, runFrames, statusText: () => body.children.map((c) => c._text || "").join(" | ") };
}

async function loadGame(dir) {
  const rules = await import(pathToFileURL(join(dir, "game", "rules.js")).href + "?t=" + Date.now());
  const render = await import(pathToFileURL(join(dir, "game", "render.js")).href + "?t=" + Date.now());
  const content = (await import(pathToFileURL(join(dir, "game", "content.js")).href + "?t=" + Date.now())).default;
  return { rules, render, content };
}

async function bootGame(dir, label) {
  const dom = fakeDom();
  const { boot } = await import(pathToFileURL(join(dir, "kit", "runtime.js")).href + "?t=" + Date.now());
  const { rules, render, content } = await loadGame(dir);
  const theme = { palette: ["#0B1020", "#38E8FF", "#FFC857", "#FF5D73", "#F5F7FF"], reducedMotion: false };
  const app = boot({ rules, render, content, meta: { slug: label, name: label }, theme });
  dom.runFrames();
  assert.ok(app && typeof app.getState === "function", "boot returns the app handle");
  assert.equal(globalThis.window.__gfStorage, "memory", "a throwing localStorage falls back to memory");
  const status = dom.statusText();
  assert.doesNotMatch(status, /undefined/, "status line must not read undefined: " + status);
  assert.match(status, /playing/, "status line shows the game status: " + status);
  const layout = rules.layout(390, 844);
  assert.ok(layout.controls.length > 0, "the game declares controls");
  assert.ok((dom.calls.fillText || 0) >= layout.controls.length, `the kit draws a label for every control (${dom.calls.fillText || 0} fillText for ${layout.controls.length} controls)`);
  // Tap the first control through the canvas listeners and make sure nothing throws.
  const c = layout.controls[0];
  const before = JSON.stringify(app.getState());
  for (const fn of dom.canvas.listeners.mousedown || []) fn({ preventDefault() {}, clientX: c.x + c.w / 2, clientY: c.y + c.h / 2 });
  for (const fn of dom.listeners["win:mouseup"] || []) fn({ preventDefault() {}, clientX: c.x + c.w / 2, clientY: c.y + c.h / 2 });
  for (const fn of dom.listeners["win:keydown"] || []) fn({ preventDefault() {}, key: "h" });
  dom.runFrames();
  assert.ok(typeof JSON.stringify(app.getState()) === "string", "state survives pointer and key dispatch");
  return { changed: before !== JSON.stringify(app.getState()), calls: dom.calls };
}

const tmp = mkdtempSync(join(tmpdir(), "gf-runtime-"));
try {
  await test("the reference game boots through the kit runtime with a fake DOM, draws its controls and takes input", async () => {
    const dir = join(tmp, "reference");
    mkdirSync(join(dir, "game"), { recursive: true }); mkdirSync(join(dir, "kit"), { recursive: true });
    const files = kit.kitFiles();
    writeFileSync(join(dir, "kit", "runtime.js"), files["kit/runtime.js"]);
    writeFileSync(join(dir, "kit", "ports.js"), files["kit/ports.js"]);
    const ref = kit.referenceGame("vector-vault");
    for (const name of ["game/rules.js", "game/render.js", "game/content.js"]) writeFileSync(join(dir, name), ref[name]);
    const r = await bootGame(dir, "vector-vault");
    console.log("    canvas calls:", Object.entries(r.calls).map(([k, v]) => k + "=" + v).join(" "));
  });

  const bundle = process.env.GF_RUNTIME_BUNDLE || "";
  if (bundle && existsSync(join(bundle, "game", "rules.js"))) {
    await test("the assembled bundle at GF_RUNTIME_BUNDLE boots through the runtime the same way", async () => {
      // Use the CURRENT kit runtime against the bundle's generated game, so a fix to the runtime is
      // proven against a real generated title, not only the hand-written reference.
      const dir = join(tmp, "bundle");
      mkdirSync(join(dir, "game"), { recursive: true }); mkdirSync(join(dir, "kit"), { recursive: true });
      const files = kit.kitFiles();
      writeFileSync(join(dir, "kit", "runtime.js"), files["kit/runtime.js"]);
      writeFileSync(join(dir, "kit", "ports.js"), files["kit/ports.js"]);
      const { readFileSync } = await import("node:fs");
      for (const name of ["game/rules.js", "game/render.js", "game/content.js"]) writeFileSync(join(dir, name), readFileSync(join(bundle, name), "utf8"));
      const r = await bootGame(dir, "bundle");
      console.log("    canvas calls:", Object.entries(r.calls).map(([k, v]) => k + "=" + v).join(" "));
    });
  } else console.log("skip - GF_RUNTIME_BUNDLE not set or has no game/rules.js (rig bundle boot not exercised here)");
  console.log(`\n${passed} gamefactorykit runtime tests passed.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
