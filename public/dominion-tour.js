/*
 * The Crucible's guided tour (Fred's ruling 2026-07-21).
 *
 * A person who has never made an app gets numbered popups that hover NEXT TO the thing they
 * explain, one step at a time, with Next moving the view. Skippable at the very start, and
 * recallable any time from a small ? button in the panel rail that covers nothing. After the
 * explain pass, Begin switches to guide mode: an arrowed prompt points at the ONE control the user
 * should touch NOW (folder, brief, start), advancing as they actually do each one. Once seen,
 * it never auto-appears again; the ? brings it back on request.
 *
 * Every string goes through the register dictionary, so the tour speaks the user's chosen
 * language like everything else on this surface.
 */
(() => {
  "use strict";
  const KEY = "dominion.crucible.tour.v1";
  const $ = (s) => document.querySelector(s);
  const L = (k) => (window.DominionLexicon ? window.DominionLexicon.L(k) : k);
  const seen = () => { try { return localStorage.getItem(KEY) === "done"; } catch { return false; } };
  const markDone = () => { try { localStorage.setItem(KEY, "done"); } catch {} };

  let pop = null;          // the one floating card, explain and guide modes both use it
  let hi = null;           // the currently highlighted target
  let stepIndex = -1;      // explain-mode position, -1 = not touring
  let guidePoll = 0;       // guide-mode timer
  let veil = null;         // the full-screen darkening veil
  let currentSteps = [];   // steps array for the current mode
  let repaint = null;      // re-renders the visible card in the active register

  function clear() {
    if (pop) { pop.remove(); pop = null; }
    if (hi) { hi.classList.remove("tour-hi", "tour-lift"); hi = null; }
    if (veil) { veil.remove(); veil = null; }
    clearInterval(guidePoll);
    guidePoll = 0;
    stepIndex = -1;
    repaint = null;
  }

  /*
   * Place the card beside its target: below when there is room, above otherwise, arrow pointing
   * at the target either way. position:fixed keeps the math in viewport space, immune to the
   * stage's own scrolling; a scroll listener re-places it. Clamp maxHeight to keep it on screen.
   */
  function place(target) {
    if (!pop || !target) return;
    const r = target.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    pop.style.width = w + "px";
    const ph = pop.offsetHeight || 160;
    const below = r.bottom + ph + 18 < window.innerHeight;
    const top = below ? r.bottom + 12 : Math.max(8, r.top - ph - 12);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
    pop.style.top = top + "px";
    pop.style.left = left + "px";
    pop.classList.toggle("above", !below);

    // Clamp maxHeight to keep the card on screen: min(70% of innerHeight, innerHeight - top - 12).
    const maxH = Math.min(window.innerHeight * 0.7, window.innerHeight - top - 12);
    pop.style.maxHeight = maxH + "px";

    // The arrow slides along the card's edge to keep pointing at the target's center.
    const ax = Math.max(18, Math.min(r.left + r.width / 2 - left, w - 18));
    pop.style.setProperty("--ax", ax + "px");
  }

  function highlight(target) {
    if (hi) hi.classList.remove("tour-hi", "tour-lift");
    hi = target;
    if (hi) {
      hi.classList.add("tour-hi", "tour-lift");
    }
  }

  // The veil and the card live INSIDE #ide-root on purpose. #ide-root is a fixed, z-index:70,
  // will-change:transform stacking context, so anything at document.body level (like a body-level
  // veil) would paint OVER the whole panel and the tour-lift target could never rise above it. Kept
  // in the same context, the veil (330), the lifted target (335) and the card (340) order the way the
  // numbers intend. #ide-root fills the viewport (inset:0), so the card's fixed math still lines up.
  function stageRoot() { return document.getElementById("ide-root") || document.body; }

  function createVeil() {
    if (veil) veil.remove();
    veil = document.createElement("div");
    veil.className = "ide-tour-veil";
    stageRoot().append(veil);
  }

  function card(target, html) {
    if (pop) pop.remove();
    createVeil();
    pop = document.createElement("div");
    pop.className = "ide-tour-pop";
    pop.innerHTML = html;
    stageRoot().append(pop);
    highlight(target);
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
    // Two passes: once now, once after the smooth scroll has settled.
    place(target);
    setTimeout(() => place(target), 420);
    return pop;
  }

  // ---------- the explain pass -------------------------------------------------------------
  function buildStepsForMode() {
    const root = document.getElementById("ide-root");
    const mode = root ? root.dataset.mode : "beginner";

    const baseSteps = [
      { target: "#st-ws-row", t: "tour_s2_t", b: "tour_s2_b" },
      { target: "#st-prompt", t: "tour_s3_t", b: "tour_s3_b" },
      { target: "#st-go", t: "tour_s5_t", b: "tour_s5_b" },
    ];

    if (mode === "vibe") {
      baseSteps.splice(2, 0, { target: "#st-tools", t: "tour_s4_t", b: "tour_s4_b" });
    }

    return baseSteps;
  }

  function isStepComplete(step) {
    const target = $(step.target);
    if (!target) return false;

    if (step.target === "#st-ws-row") {
      const ws = $("#st-ws");
      return !!(ws && ws.value);
    }
    if (step.target === "#st-prompt") {
      const prompt = $("#st-prompt");
      return !!(prompt && prompt.value.trim());
    }
    return false;
  }

  function showStep(n) {
    if (n >= currentSteps.length) { beginGuide(); return; }

    // Auto-advance past completed steps.
    if (isStepComplete(currentSteps[n])) {
      showStep(n + 1);
      return;
    }

    stepIndex = n;
    const step = currentSteps[n];
    const target = $(step.target);
    if (!target) { showStep(n + 1); return; }
    const last = n === currentSteps.length - 1;
    const c = card(target,
      '<div class="tp-num">' + (n + 1) + "/" + currentSteps.length + '</div>' +
      '<h4>' + L(step.t) + '</h4>' +
      '<p>' + L(step.b) + '</p>' +
      '<div class="tp-btns">' +
        (n === 0 ? '<button type="button" class="tp-skip">' + L("tour_skip") + '</button>' : '') +
        '<button type="button" class="tp-next">' + L(last ? "tour_begin" : "tour_next") + '</button>' +
      '</div>');
    const skip = c.querySelector(".tp-skip");
    if (skip) skip.addEventListener("click", () => { markDone(); clear(); });
    c.querySelector(".tp-next").addEventListener("click", () => showStep(n + 1));
    repaint = () => showStep(n);
  }

  /* ---------- guide mode -------------------------------------------------------------------
   * After Begin, the card shrinks to an arrowed prompt pointing at the ONE control to touch
   * now, and advances when the user actually does it: folder picked, brief written, build
   * started. Watching real state (a poll) beats wiring every possible event source.
   */
  function beginGuide() {
    stepIndex = -1;
    const stages = [
      { target: "#st-ws-row", text: "tour_go_folder", done: () => { const s = $("#st-ws"); return !!(s && s.value); } },
      { target: "#st-prompt", text: "tour_go_prompt", done: () => { const p = $("#st-prompt"); return !!(p && p.value.trim()); } },
      { target: "#st-go", text: "tour_go_start", done: () => false },   // advanced by the build-started event
    ];
    let g = 0;
    while (g < stages.length - 1 && stages[g].done()) g++;
    const point = () => {
      const st = stages[g];
      const target = $(st.target);
      if (!target) return;
      card(target, '<p class="tp-guide">' + L(st.text) + '</p>');
      repaint = point;
    };
    point();
    clearInterval(guidePoll);
    guidePoll = setInterval(() => {
      if (!document.body.classList.contains("ide-open")) return;
      if (g < stages.length - 1 && stages[g].done()) { g++; point(); }
    }, 800);
    const onStarted = () => {
      document.removeEventListener("dominion-ide-build-started", onStarted);
      clearInterval(guidePoll);
      guidePoll = 0;
      markDone();
      repaint = null;   // the halt card is terminal; do not let a register change re-point the guide
      const target = $("#cru") || $("#ide-stage");
      const c = card(target,
        '<h4>' + L("tour_halt_t") + '</h4><p>' + L("tour_halt_b") + '</p>' +
        '<div class="tp-btns"><button type="button" class="tp-next">' + L("intro_ok") + '</button></div>');
      c.querySelector(".tp-next").addEventListener("click", clear);
    };
    document.addEventListener("dominion-ide-build-started", onStarted);
  }

  // Listen for build start during explain pass and halt the tour.
  function setupBuildStartHalt() {
    const onStarted = () => {
      if (stepIndex === -1) return;  // Not in explain pass, guide mode handles it.
      document.removeEventListener("dominion-ide-build-started", onStarted);
      clearInterval(guidePoll);
      guidePoll = 0;
      markDone();
      repaint = null;   // the halt card is terminal; do not let a register change re-render the step
      const target = $("#cru") || $("#ide-stage");
      const c = card(target,
        '<h4>' + L("tour_halt_t") + '</h4><p>' + L("tour_halt_b") + '</p>' +
        '<div class="tp-btns"><button type="button" class="tp-next">' + L("intro_ok") + '</button></div>');
      c.querySelector(".tp-next").addEventListener("click", clear);
    };
    document.addEventListener("dominion-ide-build-started", onStarted);
  }

  // ---------- entry points -----------------------------------------------------------------
  function start() { clear(); currentSteps = buildStepsForMode(); setupBuildStartHalt(); showStep(0); }

  // The recall control: a small ? in the panel rail, present always, covering nothing.
  function mountRecall() {
    if ($("#ide-tour-btn")) return;
    const rail = document.querySelector("#ide-root .ide-rail");
    if (!rail) return;
    const b = document.createElement("button");
    b.type = "button";
    b.id = "ide-tour-btn";
    b.textContent = "?";
    b.title = L("tour_recall");
    b.setAttribute("aria-label", L("tour_recall"));
    b.addEventListener("click", start);
    const close = $("#ide-close");
    if (close) rail.insertBefore(b, close); else rail.append(b);
  }

  document.addEventListener("dominion-crucible-open", () => {
    mountRecall();
    if (seen()) return;
    // Auto-show is for beginners (mode ruling): engineers skipped school on purpose, and vibe
    // coders get it too since the surface is new to everyone. The ? recalls it for all modes.
    const root = document.getElementById("ide-root");
    if (root && root.dataset.mode === "engineer") { markDone(); return; }
    // The intro card (built-vs-deployed) goes first; the tour begins when it is acknowledged.
    const intro = $("#ide-intro");
    if (!intro) { setTimeout(start, 450); return; }
    const ok = $("#ide-intro-ok");
    if (ok) ok.addEventListener("click", () => setTimeout(start, 250), { once: true });
  });

  // The panel closing takes the tour with it; reopening offers it again only if never finished.
  new MutationObserver(() => {
    if (!document.body.classList.contains("ide-open") && (pop || guidePoll)) clear();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // Register changes repaint the words in place: the recall button, and the open card if any.
  document.addEventListener("dominion-register-changed", () => {
    const btn = $("#ide-tour-btn");
    if (btn) { btn.title = L("tour_recall"); btn.setAttribute("aria-label", L("tour_recall")); }
    if (pop && repaint) repaint();
  });

  window.addEventListener("resize", () => { if (pop && hi) place(hi); });
})();
