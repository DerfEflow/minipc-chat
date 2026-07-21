/*
 * The Crucible's guided tour (Fred's ruling 2026-07-21).
 *
 * A person who has never made an app gets numbered popups that hover NEXT TO the thing they
 * explain, one step at a time, with Next moving the view. Skippable at the very start, and
 * recallable any time from a small ? button in the panel rail that covers nothing. After the
 * explain pass, Begin switches to guide mode: an arrowed prompt points at the control the user
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

  const STEPS = [
    { target: ".st-lang", t: "tour_s1_t", b: "tour_s1_b" },
    { target: "#st-ws-row", t: "tour_s2_t", b: "tour_s2_b" },
    { target: "#st-prompt", t: "tour_s3_t", b: "tour_s3_b" },
    { target: "#st-tools", t: "tour_s4_t", b: "tour_s4_b" },
    { target: "#st-go", t: "tour_s5_t", b: "tour_s5_b" },
  ];

  let pop = null;          // the one floating card, explain and guide modes both use it
  let hi = null;           // the currently highlighted target
  let stepIndex = -1;      // explain-mode position, -1 = not touring
  let guidePoll = 0;       // guide-mode timer

  function clear() {
    if (pop) { pop.remove(); pop = null; }
    if (hi) { hi.classList.remove("tour-hi"); hi = null; }
    clearInterval(guidePoll);
    guidePoll = 0;
    stepIndex = -1;
  }

  /*
   * Place the card beside its target: below when there is room, above otherwise, arrow pointing
   * at the target either way. position:fixed keeps the math in viewport space, immune to the
   * stage's own scrolling; a scroll listener re-places it.
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
    // The arrow slides along the card's edge to keep pointing at the target's center.
    const ax = Math.max(18, Math.min(r.left + r.width / 2 - left, w - 18));
    pop.style.setProperty("--ax", ax + "px");
  }

  function highlight(target) {
    if (hi) hi.classList.remove("tour-hi");
    hi = target;
    if (hi) hi.classList.add("tour-hi");
  }

  function card(target, html) {
    if (pop) pop.remove();
    pop = document.createElement("div");
    pop.className = "ide-tour-pop";
    pop.innerHTML = html;
    document.body.append(pop);
    highlight(target);
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
    // Two passes: once now, once after the smooth scroll has settled.
    place(target);
    setTimeout(() => place(target), 420);
    return pop;
  }

  // ---------- the explain pass -------------------------------------------------------------
  function showStep(n) {
    if (n >= STEPS.length) { beginGuide(); return; }
    stepIndex = n;
    const step = STEPS[n];
    const target = $(step.target);
    if (!target) { showStep(n + 1); return; }
    const last = n === STEPS.length - 1;
    const c = card(target,
      '<div class="tp-num">' + (n + 1) + "/" + STEPS.length + '</div>' +
      '<h4>' + L(step.t) + '</h4>' +
      '<p>' + L(step.b) + '</p>' +
      '<div class="tp-btns">' +
        (n === 0 ? '<button type="button" class="tp-skip">' + L("tour_skip") + '</button>' : '') +
        '<button type="button" class="tp-next">' + L(last ? "tour_begin" : "tour_next") + '</button>' +
      '</div>');
    const skip = c.querySelector(".tp-skip");
    if (skip) skip.addEventListener("click", () => { markDone(); clear(); });
    c.querySelector(".tp-next").addEventListener("click", () => showStep(n + 1));
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
      const target = $("#st-go");
      const c = card(target,
        '<h4>' + L("tour_done_t") + '</h4><p>' + L("tour_done_b") + '</p>' +
        '<div class="tp-btns"><button type="button" class="tp-next">' + L("intro_ok") + '</button></div>');
      c.querySelector(".tp-next").addEventListener("click", clear);
    };
    document.addEventListener("dominion-ide-build-started", onStarted);
  }

  // ---------- entry points -----------------------------------------------------------------
  function start() { clear(); showStep(0); }

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

  // Register changes repaint the words in place.
  document.addEventListener("dominion-register-changed", () => {
    const btn = $("#ide-tour-btn");
    if (btn) { btn.title = L("tour_recall"); btn.setAttribute("aria-label", L("tour_recall")); }
  });

  window.addEventListener("resize", () => { if (pop && hi) place(hi); });
})();
