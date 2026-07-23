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
  const COMMIT = 0.18;           // threshold: 18% of screen for distance commit
  const VELOCITY_COMMIT = 0.35;  // px/ms: flick faster than this commits even below distance
  const VELOCITY_SAMPLE_MS = 80; // sample window for velocity calculation
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
  /*
   * Is The Crucible available to this account at all? The live bug this answers for: the up
   * arrow showed for everyone, and the drag then died silently inside openIdeMode's permission
   * gate, so up "did nothing" while left and right worked. An arrow that exists must work; an
   * account that is walled off gets no arrow.
   */
  const crucibleAllowed = () => !!(window.ideModeAllowed && window.ideModeAllowed());

  // A deliberate upward drag IS consent: when the mode is allowed on the account and merely not
  // switched on for this device, switch it on rather than refusing a motion the user just made.
  function armCrucible() {
    if (!crucibleAllowed()) return false;
    if (window.ideModeEngaged && !window.ideModeEngaged() && window.ideModeSetEngaged) {
      window.ideModeSetEngaged(true);
    }
    return true;
  }

  function routesFor(surface) {
    if (surface === "main") return { left: "dial", right: "images", ...(crucibleAllowed() ? { up: "crucible" } : {}) };
    if (surface === "images") return { left: "main" };      // it came from the left, so it leaves leftward
    if (surface === "dial") return { right: "main" };
    if (surface === "crucible") return { down: "main" };
    return {};
  }

  function paint() {
    // Whenever the crucible panel exists, make sure its always-on divider bar does too, so the
    // boundary is present for arrow/keyboard reveals as well as drags.
    ensureDivider();
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
      ? "Press for the surface menu. Or drag: left for the dial, right for the image forge, up for The Crucible."
      : "Press for the surface menu, or drag to return to the conversation.");
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
    if (target === "crucible" && !back && !armCrucible()) return null;
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
    return { target, p, root, back, els, progress: back ? 1 : 0, posHistory: [] };
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
        if (d.target === "crucible") hideDividerLabel();
      } else {
        document.body.classList.add(p.open);
        setTimeout(paint, 60);
        // Show and manage divider label during crucible settle (arm the hide on the settle).
        if (d.target === "crucible") showDividerLabel(true);
      }
    } else {
      // Snap back to wherever we started from.
      if (d.back) document.body.classList.add(p.open);
      else {
        document.body.classList.remove(p.open);
        setTimeout(() => { document.body.classList.remove(p.anim); }, 500);
      }
      setTimeout(paint, 60);
      if (d.target === "crucible") hideDividerLabel();
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
          if (dest === "crucible") armCrucible();
          const fn = PANELS[dest] && PANELS[dest].open_();
          if (typeof fn === "function") fn();
          start = null; return;
        }
        decided = dir;
        // Show divider label when dragging upward toward the crucible. No settle timer yet: the
        // drag has no transition running, so arming the hide here would fire mid-gesture.
        if (dir === "up" && drag.target === "crucible") showDividerLabel(false);
      }
      if (!drag) return;
      const span = drag.p.axis === "x" ? window.innerWidth : window.innerHeight;
      const travel = drag.p.axis === "x" ? dx : dy;
      // Progress always runs 0 -> 1 in the direction that opens the panel.
      // sign carries the direction that OPENS each panel (drag right for images, left for the
      // dial, up for The Crucible), so progress always runs 0 -> 1 the way the panel travels.
      const signed = travel * (drag.back ? -drag.p.sign : drag.p.sign);
      applyProgress(drag, drag.back ? 1 - signed / span : signed / span);
      // Record position and timestamp for velocity calculation
      const now = Date.now();
      drag.posHistory.push({ pos: signed, ts: now });
      // Keep only recent history for velocity sample window
      while (drag.posHistory.length > 1 && now - drag.posHistory[0].ts > VELOCITY_SAMPLE_MS) {
        drag.posHistory.shift();
      }
      e.preventDefault();
    };

    const onUp = () => {
      el.classList.remove("awake");
      if (drag) {
        // Decide commit: distance threshold OR velocity threshold
        let committed = drag.back ? drag.progress <= 1 - COMMIT : drag.progress >= COMMIT;
        if (!committed && drag.posHistory.length >= 2) {
          // Check velocity over the last samples
          const now = Date.now();
          const recentStart = drag.posHistory[0];
          const recentEnd = drag.posHistory[drag.posHistory.length - 1];
          const dtMs = recentEnd.ts - recentStart.ts;
          if (dtMs > 0) {
            const posDelta = recentEnd.pos - recentStart.pos;
            const velocity = Math.abs(posDelta) / dtMs;
            // pos already runs 0 -> up in the opening direction for BOTH a forward reveal and a
            // drag back out (applyProgress feeds it drag.back-corrected), so a rising pos always
            // means "moving toward wherever this drag is headed", back or not.
            const towardDest = posDelta > 0;
            if (towardDest && velocity >= VELOCITY_COMMIT) committed = true;
          }
        }
        endDrag(drag, committed);
      } else if (start && !moved) {
        // A plain press with no drag opens the navigation fan (Fred, phone pass 07-23: swiping
        // was unreliable on his phone and the wake-the-arrows hint taught nothing). One tap
        // shows every surface as a big labelled button; one more tap goes there. Dragging
        // still works for anyone who likes it.
        toggleFan(el);
      }
      start = null; decided = null;
    };

    dot.addEventListener("pointerdown", onDown);
    dot.addEventListener("pointermove", onMove);
    dot.addEventListener("pointerup", onUp);
    dot.addEventListener("pointercancel", onUp);
    dot.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFan(el); return; }
      const routes = routesFor(current());
      const map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
      const dir = map[e.key];
      if (dir && routes[dir]) { e.preventDefault(); goTo(routes[dir]); }
    });

    // Arrows are also plain tap targets, for anyone who would rather not drag at all.
    for (const arm of el.querySelectorAll(".cx-arm")) {
      arm.addEventListener("click", () => {
        const dest = routesFor(current())[arm.dataset.dir];
        if (!dest) return;
        goTo(dest);
      });
    }
  }

  /* ---------- the navigation fan -------------------------------------------------------------
   * The reliable path between surfaces: press the handle, get every destination as a big
   * labelled button, tap one. Works from ANY surface to ANY surface (the fan closes the panel
   * you are on, waits out the travel, then opens the next), which the one-way arrows never did.
   */
  function goTo(dest) {
    const here = current();
    if (dest === here) return;
    if (dest === "crucible" && !armCrucible()) return;
    const openDest = () => {
      if (dest === "main") return;   // closing already took us home
      const o = PANELS[dest].open_();
      if (typeof o === "function") o();
      setTimeout(paint, 60);
    };
    if (here !== "main") {
      const c = PANELS[here].close();
      if (typeof c === "function") c();
      // The reveals all transform the same four shell pieces; let the closing travel finish
      // before the next reveal grabs them, or the two transitions fight over one transform.
      setTimeout(openDest, reduced() ? 30 : 420);
    } else {
      openDest();
    }
    setTimeout(paint, 60);
  }

  function toggleFan(el) {
    const oldFan = $("#cx-fan");
    if (oldFan) { oldFan.remove(); return; }
    const here = current();
    const fan = document.createElement("div");
    fan.id = "cx-fan";
    fan.setAttribute("role", "menu");
    const items = [];
    if (here !== "main") items.push({ id: "main", label: "Chat", icon: "M4 5h16v11H8l-4 4z" });
    for (const [id, p] of Object.entries(PANELS)) {
      if (id === here) continue;
      if (id === "crucible" && !crucibleAllowed()) continue;
      items.push({ id, label: p.label, icon: p.icon });
    }
    fan.innerHTML = items.map((it) =>
      '<button type="button" role="menuitem" data-go="' + it.id + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + it.icon + '"/></svg>' +
        '<span>' + it.label + '</span>' +
      '</button>').join("");
    fan.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-go]");
      if (!b) return;
      fan.remove();
      goTo(b.dataset.go);
    });
    el.append(fan);
    // Outside tap or Escape closes it; bind on the next tick so the opening tap does not count.
    setTimeout(() => {
      const away = (e) => { if (!fan.contains(e.target)) { fan.remove(); cleanup(); } };
      const key = (e) => { if (e.key === "Escape") { fan.remove(); cleanup(); } };
      const cleanup = () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", key, true);
      new MutationObserver((m, o) => { if (!document.contains(fan)) { cleanup(); o.disconnect(); } }).observe(el, { childList: true });
    }, 0);
  }

  // Build the divider bar and its label once. #ide-root already spends both ::before and ::after
  // on its deck plate and lift seam, so these are real child elements rather than pseudos. The bar
  // is the always-on copper seam; the label is hidden until a crucible reveal is in flight.
  function ensureDivider() {
    const root = $("#ide-root");
    if (!root) return;
    if (!$("#ide-divider-bar")) {
      const bar = document.createElement("div");
      bar.id = "ide-divider-bar";
      root.insertBefore(bar, root.firstChild);
    }
    if (!$("#ide-divider-label")) {
      const L = window.DominionLexicon ? window.DominionLexicon.L : (k) => k;
      const label = document.createElement("div");
      label.id = "ide-divider-label";
      label.textContent = L("divider_label");
      root.insertBefore(label, root.firstChild);
    }
  }

  // Hide the label (the bar stays: it is always on the panel).
  function hideDividerLabel() {
    const label = $("#ide-divider-label");
    if (!label) return;
    label.classList.remove("on");
  }

  let settleTimeoutId = null;
  let settleTransitionHandler = null;

  // Arm the hide for when the panel comes to rest: the panel's own transform transitionend, with
  // an 800ms fallback. Guards against a bubbled child transition (the label's own opacity fade)
  // ending the label early, and clears any handler from a previous arming so nothing leaks on.
  function armSettleHide() {
    const root = $("#ide-root");
    if (settleTimeoutId) { clearTimeout(settleTimeoutId); settleTimeoutId = null; }
    if (settleTransitionHandler && root) {
      root.removeEventListener("transitionend", settleTransitionHandler);
    }
    settleTransitionHandler = null;
    if (!root) { settleTimeoutId = setTimeout(hideDividerLabel, 800); return; }
    const settle = (e) => {
      if (e && (e.target !== root || e.propertyName !== "transform")) return;
      root.removeEventListener("transitionend", settle);
      clearTimeout(settleTimeoutId);
      settleTimeoutId = null;
      settleTransitionHandler = null;
      hideDividerLabel();
    };
    settleTransitionHandler = settle;
    root.addEventListener("transitionend", settle);
    settleTimeoutId = setTimeout(settle, 800);
  }

  // Show the label. armHide is true only for the post-commit settle; during the drag itself there
  // is no transition running, so arming the hide then would fire the fallback mid-gesture.
  function showDividerLabel(armHide) {
    ensureDivider();
    const label = $("#ide-divider-label");
    if (!label) return;
    label.classList.add("on");
    if (armHide) armSettleHide();
  }

  // The panels change body classes from their own buttons too, so watch rather than assume.
  const observer = new MutationObserver(() => paint());

  function init() {
    build();
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // allowed resolves from a fetch AFTER the compass first paints, so listen for the change or
    // the up arrow stays wrong until some unrelated repaint.
    document.addEventListener("dominion-ide-state", paint);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.dominionCompass = { paint, routesFor, current };
})();
