/*
 * gamefactorykit/runtime.js -- the browser boot shim every generated game's index.html loads:
 *   import { boot } from "./kit/runtime.js";
 *   boot({ rules, render, content, meta, theme });
 *
 * Browser-only (uses document/window/canvas/localStorage/requestAnimationFrame). This file is
 * NEVER imported by the Node QA harness (qa/run.mjs) -- it is syntax-checked there via the vm.Script
 * fallback (see qa/run.mjs's stripEsmForSyntaxCheck) precisely because importing it in Node would
 * throw on the very first browser global it touches. Every browser-global access below happens
 * inside a function body, never at module scope, so the file still PARSES cleanly under Node.
 *
 * No network calls of any kind (see the offline QA suite's static bundle scan, which this file
 * must stay clean of -- deliberately not spelling out the scanned-for API names here, since a
 * docstring that names them would itself match the scan).
 */
import { createPorts } from "./ports.js";

const SAVE_SCHEMA_VERSION = 1;

// Storage adapter: versioned save written atomically (temp key first, then the real key, so a
// mid-write crash can never leave a torn value under the real key -- "rename by copy" without an
// actual localStorage rename primitive, since localStorage has none). In a sandboxed iframe,
// localStorage access throws synchronously on the very first probe write; fall back to an
// in-memory store for the life of the page and mark that fact on window.__gfStorage so the preview
// dialog can tell the owner saves will not persist across reloads.
function createStorage(slug) {
  const key = "gf:" + slug + ":save";
  let memory = null;
  let usesMemory = false;
  try {
    const probeKey = key + ".__probe__";
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
  } catch (e) { usesMemory = true; }
  try { window.__gfStorage = usesMemory ? "memory" : "localStorage"; } catch (e) { /* ignore */ }

  function save(payloadText) {
    if (usesMemory) { memory = payloadText; return; }
    try {
      const tempKey = key + ".tmp";
      localStorage.setItem(tempKey, payloadText);
      localStorage.setItem(key, payloadText);
      localStorage.removeItem(tempKey);
    } catch (e) {
      usesMemory = true; memory = payloadText;
      try { window.__gfStorage = "memory"; } catch (e2) { /* ignore */ }
    }
  }
  function load() {
    if (usesMemory) return memory;
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  return { save, load };
}

export function boot({ rules, render, content, meta, theme }) {
  const ports = createPorts({ consent: "denied" });
  const storage = createStorage(meta.slug);

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;touch-action:none;display:block;";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  document.body.style.background = (theme.palette && theme.palette[0]) || "#000";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const statusLine = document.createElement("div");
  statusLine.style.cssText = "position:fixed;top:env(safe-area-inset-top,0px);left:0;right:0;padding:6px 10px;" +
    "font:14px sans-serif;color:" + ((theme.palette && theme.palette[4]) || "#fff") + ";pointer-events:none;";
  document.body.appendChild(statusLine);

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.textContent = "Next";
  nextButton.style.cssText = "position:fixed;top:env(safe-area-inset-top,8px);right:8px;display:none;" +
    "font:14px sans-serif;padding:8px 14px;";
  document.body.appendChild(nextButton);

  let warnedOnce = false;
  function restoreOrCreate() {
    const raw = storage.load();
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        return rules.deserialize(saved.state);
      } catch (e) {
        if (!warnedOnce) { warnedOnce = true; try { console.warn("[" + meta.slug + "] save data was corrupt, starting fresh: " + (e && e.message)); } catch (e2) { /* ignore */ } }
      }
    }
    return rules.createState({ levelIndex: 0, seed: 1 });
  }

  let state = restoreOrCreate();
  let layout = null;
  let running = true;
  let rafId = null;

  function persist() {
    try {
      const payload = JSON.stringify({ schemaVersion: SAVE_SCHEMA_VERSION, savedAt: Date.now(), level: state.levelIndex, state: rules.serialize(state) });
      storage.save(payload);
    } catch (e) { /* a save failure must never break gameplay */ }
  }

  function updateStatusLine() {
    const level = content.levels[state.levelIndex];
    statusLine.textContent = (level ? level.name : meta.name) + " - " + state.status;
    nextButton.style.display = (state.status === "won" && state.levelIndex + 1 < content.levels.length) ? "block" : "none";
  }

  function dispatch(action) {
    if (!action) return;
    const result = rules.applyAction(state, action);
    state = result.state;
    if (ports.consent.state() === "granted") {
      for (const ev of result.events) ports.analytics.track(ev.name, ev.props);
    }
    persist();
    updateStatusLine();
  }

  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = window.innerWidth, height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout = rules.layout(width, height);
  }

  function applyReducedMotion() {
    try { theme.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { theme.reducedMotion = false; }
  }

  function pointFromEvent(e, type) {
    const rect = canvas.getBoundingClientRect();
    const src = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { type, x: src.clientX - rect.left, y: src.clientY - rect.top, dx: 0, dy: 0 };
  }

  function onPointerDown(e) {
    e.preventDefault();
    dispatch(rules.actionForPointer(state, layout, pointFromEvent(e, "down")));
  }

  function onKeyDown(e) {
    const action = rules.actionForKey(state, e.key);
    if (action) { e.preventDefault(); dispatch(action); }
  }

  canvas.addEventListener("mousedown", onPointerDown);
  canvas.addEventListener("touchstart", onPointerDown, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", resize);
  nextButton.addEventListener("click", function () { dispatch({ type: "next" }); });

  try {
    applyReducedMotion();
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq && mq.addEventListener) mq.addEventListener("change", applyReducedMotion);
  } catch (e) { theme.reducedMotion = false; }

  document.addEventListener("visibilitychange", function () {
    running = !document.hidden;
    if (document.hidden) {
      if (ports.consent.state() === "granted") ports.analytics.track("session_end", { level_id: state.levelId });
      persist();
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (rafId === null) {
      rafId = requestAnimationFrame(frame);
    }
  });

  function frame(t) {
    if (!running) return;
    if (!layout) resize();
    render.draw(ctx, state, layout, theme, t);
    rafId = requestAnimationFrame(frame);
  }

  resize();
  updateStatusLine();
  rafId = requestAnimationFrame(frame);

  if ("serviceWorker" in navigator) {
    try {
      const sandboxed = window.top !== window.self;
      if (!sandboxed) navigator.serviceWorker.register("./sw.js").catch(function () { /* never fatal */ });
    } catch (e) { /* cross-origin sandboxed access to window.top throws -- treat as sandboxed, skip registration */ }
  }

  return { getState: function () { return state; }, ports: ports };
}
