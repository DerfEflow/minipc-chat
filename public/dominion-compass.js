/*
 * Dominion Compass: one handle to move between every surface.
 *   SOW docs/IDE-MODE-ROADMAP.md - build pack docs/IDE-MODE-BUILD.md
 *
 * WHY THIS EXISTS.
 * The composer grew a button per surface: the dial, the image forge, and then The Crucible. On a
 * 320px phone that was seven controls totalling 296px inside a 270px bar, in five different sizes,
 * so they physically stacked on top of each other. Adding an eighth button was never going to be
 * the answer. This replaces three of them with one handle.
 *
 * WHY A HANDLE AND NOT EDGE GESTURES.
 * Edge swipes were the first design. They are unbuildable on mobile: Android claims BOTH side
 * edges for back and the bottom for home, iOS claims the left edge, and a PWA cannot override any
 * of it (w3c/manifest#1041 has been open for years). An interior handle has no such conflict, and
 * it has the added virtue of being visible, where an edge gesture is invisible until someone tells
 * you it is there.
 *
 * THE PHYSICS.
 * Your finger drags the panel, one to one, so it tracks your hand rather than playing an animation
 * at you. Past one third of the screen it is committed and finishes on its own. Short of that it
 * falls back, which doubles as the "changed my mind" gesture. The handle itself barely moves: it
 * is the grab point, and the panels do the travelling.
 *
 * DIRECTION. Your finger moves WITH the panel that is arriving:
 *   drag right -> the image forge slides in from the left
 *   drag left  -> the dial slides in from the right
 *   drag up    -> The Crucible rises from below
 * Inside any panel, one arrow points home.
 */
(() => {
  "use strict";

  // The four shell pieces every reveal transforms. Kept in one place because all three panels
  // enumerate exactly these, and a fifth element added to the shell must be added here too.
  const SHELL = ["#sidebar", "#commandbar", "#neural-glass", "#overlay"];
  const COMMIT = 1 / 3;          // Fred's ruling: one third of the screen is the point of no return
  const START_SLOP = 8;          // px before a drag is a drag, so a tap stays a tap

  /*
   * Each destination: where its root parks, how the shell leaves, and along which axis. The
   * numbers mirror the CSS exactly (dominion-forge.css, dominion-images.css, dominion-ide.css);
   * if those change, these must change with them.
   */
  const PANELS = {
    images:   { axis: "x", sign: +1, root: "#dfi-root", anim: "dfi-anim", open: "dfi-open",
                shellTo: 108, rootFrom: -104, unit: "vw",
                label: "Image forge", icon: "M4 17l5-6 4 5 3-4 4 5H4z", open_: () => window.openForgeImages, close: () => window.closeForgeImages },
    dial:     { axis: "x", sign: -1, root: "#dfd-root", anim: "dfd-anim", open: "dfd-open",
                shellTo: -108, rootFrom: 104, unit: "vw",
                label: "Forge dial", icon: "M12 4v4M12 16v4M4 12h4M16 12h4", open_: () => window.openForgeDial, close: () => window.closeForgeDial },
    crucible: { axis: "y", sign: -1, root: "#ide-root", anim: "ide-anim", open: "ide-open",
                shellTo: -112, rootFrom: 104, unit: "vh",
                label: "The Crucible", icon: "M9 8l-4 4 4 4M15 8l4 4-4 4", open_: () => window.openIdeMode, close: () => window.closeIdeMode },
  };

  const $ = (s) => document.querySelector(s);
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Which surface are we on? Read from the body classes the panels already set, so the compass has
  // no state of its own to drift out of sync.
  function current() {
    for (const [id, p] of Object.entries(PANELS)) if (document.body.classList.contains(p.open)) return id;
    return "main";
  }

  /* ---------- the handle ------------------------------------------------------------------ */
  function build() {
    if ($("#compass")) return;
    const host = document.querySelector("#bar-mid") || document.querySelector("#send")?.closest(".bar");
    if (!host) return;

    const el = document.createElement("div");
    el.id = "compass";
    el.dataset.surface = "main";
    el.innerHTML =
      '<button class="cx-arm" data-dir="left"  type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<div class="cx-core">' +
        '<button class="cx-arm cx-up" data-dir="up" type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 15l7-7 7 7"/></svg></button>' +
        '<span class="cx-dot" role="button" tabindex="0" aria-label="Move between surfaces. Drag left, right or up, or press to open the menu."></span>' +
        '<button class="cx-arm cx-down" data-dir="down" type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 9l7 7 7-7"/></svg></button>' +
      '</div>' +
      '<button class="cx-arm" data-dir="right" type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>';

    if (host.id === "bar-mid") host.append(el);
    else host.insertBefore(el, $("#send"));
    wire(el);
    paint();
  }

  // Which directions are live from where you are standing. On a panel there is exactly one way
  // out, which is what makes the handle a "you are here" marker as well as a control.
  function routesFor(surface) {
    if (surface === "main") return { left: "dial", right: "images", up: "crucible" };
    if (surface === "images") return { left: "main" };      // it came from the left, so it leaves leftward
    if (surface === "dial") return { right: "main" };
    if (surface === "crucible") return { down: "main" };
    return {};
  }

  function paint() {
    const el = $("#compass");
    if (!el) return;
    const here = current();
    el.dataset.surface = here;
    const routes = routesFor(here);
    for (const arm of el.querySelectorAll(".cx-arm")) {
      arm.classList.toggle("on", !!routes[arm.dataset.dir]);
    }
    const dot = el.querySelector(".cx-dot");
    dot.setAttribute("aria-label", here === "main"
      ? "Move between surfaces. Drag left for the dial, right for the image forge, up for The Crucible."
      : "Return to the conversation. Drag, or press.");
  }

  /* ---------- drag -------------------------------------------------------------------------
   * The panel tracks the finger. Transitions are switched off for the duration so nothing fights
   * the drag, then switched back on for the release so the hand-off is a single smooth motion.
   */
  let drag = null;

  function shellEls() { return SHELL.map((s) => $(s)).filter(Boolean); }

  function beginDrag(target, back) {
    const p = PANELS[target];
    if (!p) return null;
    let root = $(p.root);
    if (!root && !back) {
      // Cold start: the panel has never been opened, so its DOM does not exist yet. Ask it to
      // open (which builds it), then immediately undo the open state. Nothing has painted between
      // those two lines, so there is no flash, and from here the drag drives it by hand.
      const opener = p.open_();
      if (typeof opener !== "function") return null;
      opener();
      document.body.classList.remove(p.open);
      root = $(p.root);
      if (!root) return null;
    }
    document.body.classList.add(p.anim, "cx-dragging");
    if (back) document.body.classList.add(p.open);      // dragging OUT of a panel starts fully open
    const els = [...shellEls(), root].filter(Boolean);
    for (const e of els) e.style.transition = "none";
    return { target, p, root, back, els, progress: back ? 1 : 0 };
  }

  function applyProgress(d, progress) {
    const { p, root } = d;
    const t = Math.max(0, Math.min(1, progress));
    d.progress = t;
    const shellVal = p.shellTo * t;
    const rootVal = p.rootFrom * (1 - t);
    const axis = p.axis === "x" ? "X" : "Y";
    // setProperty with "important" is required, not stylistic: dominion-rendered-v2.css carries
    // `.neural-glass { transform: none !important }` to stop the cursor-glare effect moving the
    // geometry, and a plain inline style loses to it. That rule has been quietly freezing the chat
    // surface during every reveal; see the companion fix in dominion-compass.css.
    const shellCss = "translate" + axis + "(" + shellVal + p.unit + ")";
    for (const e of shellEls()) e.style.setProperty("transform", shellCss, "important");
    if (root) root.style.setProperty("transform", "translate" + axis + "(" + rootVal + p.unit + ")", "important");
    // Set on BODY, because the edge feedback is body::before/::after. Setting it on the handle
    // would look right and light nothing.
    document.body.style.setProperty("--cx-progress", t.toFixed(3));
  }

  function endDrag(d, commit) {
    const { p, els } = d;
    for (const e of els) { e.style.transition = ""; e.style.removeProperty("transform"); }
    document.body.classList.remove("cx-dragging");
    document.body.style.removeProperty("--cx-progress");

    if (commit) {
      if (d.back) {
        document.body.classList.remove(p.open);
        setTimeout(() => { document.body.classList.remove(p.anim); paint(); }, 500);
      } else {
        document.body.classList.add(p.open);
        setTimeout(paint, 60);
      }
    } else {
      // Snap back to wherever we started from.
      if (d.back) document.body.classList.add(p.open);
      else {
        document.body.classList.remove(p.open);
        setTimeout(() => { document.body.classList.remove(p.anim); }, 500);
      }
      setTimeout(paint, 60);
    }
    drag = null;
  }

  function wire(el) {
    const dot = el.querySelector(".cx-dot");
    let start = null, decided = null, moved = false;

    const onDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      decided = null; moved = false;
      dot.setPointerCapture?.(e.pointerId);
      el.classList.add("awake");
    };

    const onMove = (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!decided) {
        if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return;
        moved = true;
        const horizontal = Math.abs(dx) > Math.abs(dy);
        const dir = horizontal ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        const dest = routesFor(current())[dir];
        if (!dest) { start = null; return; }             // no route that way: ignore rather than fight
        if (dest === "main") {
          const from = current();
          drag = beginDrag(from, true);
        } else {
          drag = beginDrag(dest, false);
        }
        if (!drag) {                                      // cannot drag this one, so tap it open
          const fn = PANELS[dest] && PANELS[dest].open_();
          if (typeof fn === "function") fn();
          start = null; return;
        }
        decided = dir;
      }
      if (!drag) return;
      const span = drag.p.axis === "x" ? window.innerWidth : window.innerHeight;
      const travel = drag.p.axis === "x" ? dx : dy;
      // Progress always runs 0 -> 1 in the direction that opens the panel.
      // sign carries the direction that OPENS each panel (drag right for images, left for the
      // dial, up for The Crucible), so progress always runs 0 -> 1 the way the panel travels.
      const signed = travel * (drag.back ? -drag.p.sign : drag.p.sign);
      applyProgress(drag, drag.back ? 1 - signed / span : signed / span);
      e.preventDefault();
    };

    const onUp = () => {
      el.classList.remove("awake");
      if (drag) {
        const committed = drag.back ? drag.progress <= 1 - COMMIT : drag.progress >= COMMIT;
        endDrag(drag, committed);
      } else if (start && !moved) {
        // A plain press with no drag: on a panel it goes home, on the main screen it wakes the
        // arrows so a first-time user can see what the thing does.
        const here = current();
        if (here !== "main") { const c = PANELS[here].close(); if (typeof c === "function") c(); setTimeout(paint, 60); }
        else { el.classList.add("hint"); setTimeout(() => el.classList.remove("hint"), 2200); }
      }
      start = null; decided = null;
    };

    dot.addEventListener("pointerdown", onDown);
    dot.addEventListener("pointermove", onMove);
    dot.addEventListener("pointerup", onUp);
    dot.addEventListener("pointercancel", onUp);
    dot.addEventListener("keydown", (e) => {
      const routes = routesFor(current());
      const map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
      const dir = map[e.key];
      if (dir && routes[dir]) {
        e.preventDefault();
        const dest = routes[dir];
        if (dest === "main") { const c = PANELS[current()].close(); if (typeof c === "function") c(); }
        else { const o = PANELS[dest].open_(); if (typeof o === "function") o(); }
        setTimeout(paint, 60);
      }
    });

    // Arrows are also plain tap targets, for anyone who would rather not drag at all.
    for (const arm of el.querySelectorAll(".cx-arm")) {
      arm.addEventListener("click", () => {
        const dest = routesFor(current())[arm.dataset.dir];
        if (!dest) return;
        if (dest === "main") { const c = PANELS[current()].close(); if (typeof c === "function") c(); }
        else { const o = PANELS[dest].open_(); if (typeof o === "function") o(); }
        setTimeout(paint, 60);
      });
    }
  }

  // The panels change body classes from their own buttons too, so watch rather than assume.
  const observer = new MutationObserver(() => paint());

  function init() {
    build();
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.dominionCompass = { paint, routesFor, current };
})();
