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

  // The contract exposes progress through rules.status(state) and levels carry `title` (some games
  // say `name`); reading state.status directly showed "undefined" for every game that kept its status
  // elsewhere (integration review 2026-09-03).
  function currentStatus() {
    try { return typeof rules.status === "function" ? rules.status(state) : (state.status || "playing"); } catch (e) { return state.status || "playing"; }
  }
  function updateStatusLine() {
    const level = content.levels[state.levelIndex];
    const title = level ? (level.title || level.name || ("Level " + (state.levelIndex + 1))) : meta.name;
    const status = currentStatus();
    statusLine.textContent = title + " - " + status;
    nextButton.style.display = (status === "won" && state.levelIndex + 1 < content.levels.length) ? "block" : "none";
  }

  // Step controls are drawn by the kit so every game gets visible, 44 px, high-contrast buttons with
  // labels even when its render.js draws only the board (the accessibility rule: step buttons mirror
  // gestures). A render.js that also draws its controls paints the same geometry; the kit's pass lands
  // on top, so the two never disagree about where a control is.
  function drawControls() {
    if (!layout || !Array.isArray(layout.controls)) return;
    const palette = theme.palette || [];
    const fg = palette[4] || "#ffffff", accent = palette[1] || "#38e8ff", ground = palette[0] || "#000";
    for (const c of layout.controls) {
      if (!c || !(c.w > 0) || !(c.h > 0)) continue;
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = ground;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(c.x, c.y, c.w, c.h, 8); else ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = fg;
      ctx.font = Math.max(12, Math.min(16, Math.floor(c.h * 0.34))) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = String(c.label || (c.action && c.action.type) || "").slice(0, 18);
      ctx.fillText(label, c.x + c.w / 2, c.y + c.h / 2);
      ctx.restore();
    }
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

  // Pointer: down, move and up all reach the game (drag gestures need move/up; the contract's pointer
  // shape carries dx/dy relative to the previous point). A game that only answers to "down" simply
  // returns null for the others.
  let lastPoint = null;
  function pointerEvent(e, type) {
    const p = pointFromEvent(e, type);
    if (lastPoint && type !== "down") { p.dx = p.x - lastPoint.x; p.dy = p.y - lastPoint.y; }
    lastPoint = type === "up" ? null : { x: p.x, y: p.y };
    return p;
  }
  function onPointerDown(e) { e.preventDefault(); dispatch(rules.actionForPointer(state, layout, pointerEvent(e, "down"))); }
  function onPointerMove(e) { if (!lastPoint) return; e.preventDefault(); dispatch(rules.actionForPointer(state, layout, pointerEvent(e, "move"))); }
  function onPointerUp(e) { if (!lastPoint) return; e.preventDefault(); dispatch(rules.actionForPointer(state, layout, pointerEvent(e, "up"))); }

  function onKeyDown(e) {
    const action = rules.actionForKey(state, e.key);
    if (action) { e.preventDefault(); dispatch(action); }
  }

  canvas.addEventListener("mousedown", onPointerDown);
  canvas.addEventListener("mousemove", onPointerMove);
  window.addEventListener("mouseup", onPointerUp);
  canvas.addEventListener("touchstart", onPointerDown, { passive: false });
  canvas.addEventListener("touchmove", onPointerMove, { passive: false });
  canvas.addEventListener("touchend", onPointerUp, { passive: false });
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
    try { render.draw(ctx, state, layout, theme, t); }
    catch (e) { try { console.error("[" + meta.slug + "] draw failed:", e); } catch (e2) { /* ignore */ } }
    drawControls();
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
