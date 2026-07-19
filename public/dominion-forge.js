/*
 * Dominion AI — Forge dial + universal text editor.
 *
 * window.askText(opts) -> Promise<string|null>
 *   The half-screen editor that replaces every native prompt() typing box. 11pt, resizable,
 *   Esc cancels, Ctrl/Cmd+Enter saves. Resolves the raw string on save, null on cancel — same
 *   control-flow contract as prompt(), so callers keep their `if (t == null) return` guards.
 *
 * The Forge dial: Ember/Flame/Furnace, revealed from the composer. Persists to localStorage.
 *   forgeTierValue() feeds the chat body. Ember returns "" so the turn is byte-identical to the
 *   pre-dial default (server treats absent forgeMode and "ember" the same; sending nothing proves it).
 */
(function () {
  "use strict";

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ============================ universal text editor ============================
  window.askText = function (opts) {
    opts = opts || {};
    const title = opts.title || "Edit";
    const kicker = opts.kicker || "Dominion";
    const value = opts.value == null ? "" : String(opts.value);
    const multiline = opts.multiline !== false;   // default true: the half-screen editor
    const placeholder = opts.placeholder || "";
    const saveLabel = opts.saveLabel || "Save";
    const cancelLabel = opts.cancelLabel || "Cancel";
    const hint = opts.hint || "";
    const maxlen = opts.maxlen || 0;

    return new Promise((resolve) => {
      const scrim = el("div", "dfe-scrim");
      const panel = el("div", "dfe-panel");

      const head = el("div", "dfe-head");
      head.appendChild(el("div", "dfe-kicker", kicker));
      head.appendChild(el("h3", "dfe-title", title));
      if (hint) head.appendChild(el("p", "dfe-hint", hint));
      panel.appendChild(head);

      const body = el("div", "dfe-body");
      const field = multiline ? document.createElement("textarea") : document.createElement("input");
      if (!multiline) field.type = "text";
      field.className = "dfe-field " + (multiline ? "multi" : "single");
      field.value = value;
      if (placeholder) field.placeholder = placeholder;
      if (maxlen) field.maxLength = maxlen;
      body.appendChild(field);
      panel.appendChild(body);

      const foot = el("div", "dfe-foot");
      const count = el("span", "dfe-count", "");
      const cancel = el("button", "dfe-btn dfe-cancel", cancelLabel);
      const save = el("button", "dfe-btn dfe-save", saveLabel);
      save.appendChild(el("span", "dfe-kbd", multiline ? "  ⌘/Ctrl+↵" : "  ↵"));
      foot.append(count, cancel, save);
      panel.appendChild(foot);

      scrim.appendChild(panel);
      document.body.appendChild(scrim);

      const updateCount = () => { count.textContent = field.value.length + (maxlen ? " / " + maxlen : "") + " chars"; };
      updateCount();
      field.addEventListener("input", updateCount);

      let closed = false;
      const close = (val) => {
        if (closed) return; closed = true;
        scrim.classList.remove("in");
        document.removeEventListener("keydown", onKey, true);
        setTimeout(() => scrim.remove(), 220);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); close(field.value); }
      };
      document.addEventListener("keydown", onKey, true);
      cancel.onclick = () => close(null);
      save.onclick = () => close(field.value);
      scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(null); });

      requestAnimationFrame(() => {
        scrim.classList.add("in");
        field.focus();
        try { const n = field.value.length; field.setSelectionRange(n, n); } catch (e) {}
      });
    });
  };

  // ============================ Forge dial ============================
  const TIERS = ["ember", "flame", "furnace"];
  const TIER_META = {
    ember:   { name: "Ember",   desc: "The always-on floor. Fast, direct, everyday answers.", cost: "Standard credits" },
    flame:   { name: "Flame",   desc: "Fuller reasoning and voice, for work with real weight.", cost: "More credits · slower" },
    furnace: { name: "Furnace", desc: "The whole framework, applied deliberately. Highest quality.", cost: "Most credits · slowest" },
  };
  const ANGLE = { ember: -52, flame: 0, furnace: 52 };
  const KEY = "dominion.forgeTier";

  const getTier = () => { const t = localStorage.getItem(KEY); return TIERS.includes(t) ? t : "ember"; };
  function setTier(t) {
    if (!TIERS.includes(t)) t = "ember";
    localStorage.setItem(KEY, t);
    if (triggerEl) triggerEl.setAttribute("data-tier", t);
  }
  // Ember => "" so the chat turn omits forgeMode entirely and stays byte-identical to today.
  window.forgeTierValue = () => { const t = getTier(); return t === "ember" ? "" : t; };
  window.forgeCurrentTier = getTier;

  let triggerEl = null;

  const FLAME_SVG =
    '<svg class="dial-flame" viewBox="0 0 60 74" aria-hidden="true">' +
      '<defs>' +
        '<linearGradient id="fg-outer" x1="0" y1="1" x2="0" y2="0">' +
          '<stop offset="0" stop-color="#ff5a1e"/><stop offset=".55" stop-color="#ff8a3a"/><stop offset="1" stop-color="#ffb454"/>' +
        '</linearGradient>' +
        '<linearGradient id="fg-inner" x1="0" y1="1" x2="0" y2="0">' +
          '<stop offset="0" stop-color="#ffb04a"/><stop offset="1" stop-color="#ffe08a"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path class="f-outer" d="M30 2C34 16 48 22 48 42a18 18 0 0 1-36 0C12 30 22 30 22 20c0-6-2-9 8-18z"/>' +
      '<path class="f-inner" d="M30 24c2 8 10 12 10 22a10 10 0 0 1-20 0c0-7 6-9 6-15 0-3-1-5 4-7z"/>' +
      '<circle class="f-core" cx="30" cy="52" r="5"/>' +
    '</svg>';

  function openDial() {
    const cur = getTier();
    const scrim = el("div", "dial-scrim");
    const card = el("div", "dial-card");
    card.setAttribute("data-tier", cur);
    card.innerHTML =
      '<div class="dial-kicker">Forge Intensity</div>' +
      '<div class="dial-title">Ember · Flame · Furnace</div>' +
      '<div class="dial-stage" tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="2" aria-label="Forge intensity">' +
        '<div class="dial-glow"></div><div class="dial-bezel"></div><div class="dial-ticks"></div>' +
        '<div class="dial-knob"></div>' +
        '<div class="dial-core">' + FLAME_SVG + '</div>' +
        '<div class="dial-spark s1"></div><div class="dial-spark s2"></div><div class="dial-spark s3"></div>' +
      '</div>' +
      '<div class="dial-readout"><div class="dial-tier-name"></div><div class="dial-tier-desc"></div><span class="dial-cost"></span></div>' +
      '<div class="dial-scale">' +
        '<button class="dial-step" data-t="ember">Ember</button>' +
        '<button class="dial-step" data-t="flame">Flame</button>' +
        '<button class="dial-step" data-t="furnace">Furnace</button>' +
      '</div>' +
      '<button class="dial-done">Done</button>';
    scrim.appendChild(card);
    document.body.appendChild(scrim);

    const stage = card.querySelector(".dial-stage");
    const knob = card.querySelector(".dial-knob");
    const nameEl = card.querySelector(".dial-tier-name");
    const descEl = card.querySelector(".dial-tier-desc");
    const costEl = card.querySelector(".dial-cost");
    const steps = Array.prototype.slice.call(card.querySelectorAll(".dial-step"));

    let live = cur;
    function paint(t) {
      stage.setAttribute("data-tier", t);
      card.setAttribute("data-tier", t);
      knob.style.transform = "rotate(" + ANGLE[t] + "deg)";
      const m = TIER_META[t];
      nameEl.textContent = m.name; descEl.textContent = m.desc; costEl.textContent = m.cost;
      stage.setAttribute("aria-valuenow", TIERS.indexOf(t));
      steps.forEach((s) => s.setAttribute("aria-current", s.dataset.t === t ? "true" : "false"));
    }
    function apply(t, persist) { live = t; paint(t); if (persist !== false) setTier(t); }
    paint(cur);

    knob.addEventListener("click", (e) => { e.stopPropagation(); apply(TIERS[(TIERS.indexOf(live) + 1) % TIERS.length]); });
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      apply(TIERS[Math.min(TIERS.length - 1, Math.max(0, TIERS.indexOf(live) + dir))]);
    }, { passive: false });
    stage.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); apply(TIERS[Math.min(2, TIERS.indexOf(live) + 1)]); }
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); apply(TIERS[Math.max(0, TIERS.indexOf(live) - 1)]); }
    });

    // drag to rotate -> nearest detent (top = flame, right = furnace, left = ember)
    let dragging = false;
    const center = () => { const r = stage.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const angleToTier = (deg) => (deg <= -26 ? "ember" : deg >= 26 ? "furnace" : "flame");
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".dial-step") || e.target.closest(".dial-done")) return;
      dragging = true; try { stage.setPointerCapture(e.pointerId); } catch (er) {}
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const c = center();
      let deg = Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180 / Math.PI + 90;
      if (deg > 180) deg -= 360;
      apply(angleToTier(deg), false);
    });
    const endDrag = () => { if (dragging) { dragging = false; setTier(live); } };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);

    steps.forEach((s) => s.addEventListener("click", (e) => { e.stopPropagation(); apply(s.dataset.t); }));
    card.querySelectorAll(".dial-spark").forEach((sp, i) => sp.style.setProperty("--drift", (i % 2 ? -1 : 1) * (4 + i * 3) + "px"));

    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      setTier(live);
      scrim.classList.remove("in");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => scrim.remove(), 240);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true);
    card.querySelector(".dial-done").addEventListener("click", close);
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });

    requestAnimationFrame(() => { scrim.classList.add("in"); stage.focus(); });
  }
  window.openForgeDial = openDial;

  function initTrigger() {
    triggerEl = document.getElementById("forge-trigger");
    if (!triggerEl) return;
    triggerEl.setAttribute("data-tier", getTier());
    triggerEl.addEventListener("click", (e) => { e.preventDefault(); openDial(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTrigger);
  else initTrigger();
})();
