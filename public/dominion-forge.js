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
  const ANGLE = { ember: -38, flame: 0, furnace: 38 };
  const KEY = "dominion.forgeTier";
  const MODE_KEY = "dominion.forgeModeEnabled";

  const getTier = () => { const t = localStorage.getItem(KEY); return TIERS.includes(t) ? t : "ember"; };
  function setTier(t) {
    if (!TIERS.includes(t)) t = "ember";
    localStorage.setItem(KEY, t);
    if (triggerEl) triggerEl.setAttribute("data-tier", t);
  }
  const getForgeMode = () => localStorage.getItem(MODE_KEY) === "1";
  function setForgeMode(on) {
    localStorage.setItem(MODE_KEY, on ? "1" : "0");
    if (triggerEl) triggerEl.setAttribute("data-forge", on ? "on" : "off");
  }

  /*
   * WILDFIRE (Fred, 2026-07-19). A THIRD, independent control, deliberately not folded into either
   * of the two above.
   *
   * The dial is reasoning effort. Forge Mode is machine reach, and it stays exactly as it was for
   * everyone, including guests and Fred's small-model experiments. Wildfire is broad authority: the
   * full tool surface, both machines, auto-approved, for a model on the roster.
   *
   * It is owner-only and the server enforces that independently (a guest posting the flag is
   * refused and logged). This only decides whether the switch is drawn at all.
   *
   * It does NOT persist across sessions. Broad authority should be a thing you turn on for a job,
   * not a thing you left on three weeks ago and forgot. Session storage, so a reload keeps it and
   * a new tab does not.
   */
  const WILDFIRE_KEY = "dominion.wildfireArmed";
  const isOwner = () => window.dominionIsOwner === true;
  const getWildfire = () => isOwner() && sessionStorage.getItem(WILDFIRE_KEY) === "1";
  function setWildfire(on) {
    if (!isOwner()) on = false;
    sessionStorage.setItem(WILDFIRE_KEY, on ? "1" : "0");
    if (triggerEl) triggerEl.setAttribute("data-wildfire", on ? "on" : "off");
    document.body.classList.toggle("wildfire-armed", !!on);
  }
  // The dial chooses reasoning effort. Forge Mode is a separate, explicit tool/agent gate.
  window.forgeTierValue = getTier;
  window.forgeModeValue = getForgeMode;
  window.forgeCurrentTier = getTier;
  window.wildfireValue = getWildfire;
  window.setWildfire = setWildfire;
  // Re-assert the body class after a reload so the armed glow survives a refresh.
  try { if (getWildfire()) document.body.classList.add("wildfire-armed"); } catch {}

  let triggerEl = null;
  let dialRoot = null;

  function openDial() {
    if (dialRoot) return;                       // already open
    if (window.closeForgeImages) window.closeForgeImages();   // one reveal at a time
    const cur = getTier();
    let forgeOn = getForgeMode();

    // Full-screen reveal: the whole interface slides off to the LEFT (body.dfd-open, mirror of
    // the Forge Images slide-right) and the dial owns the screen. The scrim keeps its exact
    // classes so the rendered-master art styling applies unchanged; nested inside the
    // transformed root, its position:fixed resolves against the root's box.
    dialRoot = el("section", "dfd-root");
    dialRoot.id = "dfd-root";
    dialRoot.setAttribute("aria-label", "The Forge — model effort dial");
    const back = el("button", "dfd-back");
    back.title = "Return to Dominion";
    back.setAttribute("aria-label", "Return to the Dominion interface");
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4l-8 8 8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    dialRoot.appendChild(back);

    const scrim = el("div", "dial-scrim");
    const card = el("div", "dial-card");
    card.setAttribute("data-tier", cur);
    card.setAttribute("data-forge", forgeOn ? "on" : "off");
    card.innerHTML =
      '<div class="dial-kicker">Dominion Effort Core</div>' +
      '<div class="dial-title">The Forge</div>' +
      '<div class="dial-stage" tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="2" aria-label="Model effort">' +
        '<img class="dial-art dial-art-ember" src="/assets/forge-dial/forge-dial-ember-v2.jpg" alt="" aria-hidden="true">' +
        '<img class="dial-art dial-art-flame" src="/assets/forge-dial/forge-dial-flame-v2.jpg" alt="" aria-hidden="true">' +
        '<img class="dial-art dial-art-furnace" src="/assets/forge-dial/forge-dial-furnace-v2.jpg" alt="" aria-hidden="true">' +
        '<div class="dial-knob" aria-hidden="true"><i class="dial-rod"></i><i class="dial-tip"></i><i class="dial-hub"></i></div>' +
        '<button class="dial-step dial-station dial-station-ember" data-t="ember"><span>Ember</span></button>' +
        '<button class="dial-step dial-station dial-station-flame" data-t="flame"><span>Flame</span></button>' +
        '<button class="dial-step dial-station dial-station-furnace" data-t="furnace"><span>Furnace</span></button>' +
        '<button class="dial-forge-mode" type="button" aria-pressed="false"><span>Forge Mode</span><small>Standby</small></button>' +
        (isOwner() ? '<button class="dial-wildfire" type="button" aria-pressed="false" title="Broad authority across both machines, for a starred model"><span>Wildfire</span><small>Contained</small></button>' : "") +
        '<div class="dial-glass-live" aria-hidden="true"></div>' +
        '<div class="dial-spark s1"></div><div class="dial-spark s2"></div><div class="dial-spark s3"></div>' +
      '</div>' +
      '<div class="dial-readout"><div class="dial-tier-name"></div><div class="dial-tier-desc"></div><span class="dial-cost"></span></div>' +
      '<button class="dial-done">Seal Setting</button>';
    scrim.appendChild(card);
    dialRoot.appendChild(scrim);
    document.body.appendChild(dialRoot);

    const stage = card.querySelector(".dial-stage");
    const knob = card.querySelector(".dial-knob");
    const nameEl = card.querySelector(".dial-tier-name");
    const descEl = card.querySelector(".dial-tier-desc");
    const costEl = card.querySelector(".dial-cost");
    const forgeButton = card.querySelector(".dial-forge-mode");
    const wildfireButton = card.querySelector(".dial-wildfire");
    const steps = Array.prototype.slice.call(card.querySelectorAll(".dial-step"));

    let live = cur;
    let wildOn = getWildfire();
    function paint(t) {
      stage.setAttribute("data-tier", t);
      card.setAttribute("data-tier", t);
      knob.style.transform = "rotate(" + ANGLE[t] + "deg)";
      const m = TIER_META[t];
      nameEl.textContent = m.name; descEl.textContent = m.desc; costEl.textContent = m.cost;
      stage.setAttribute("aria-valuenow", TIERS.indexOf(t));
      stage.setAttribute("aria-valuetext", m.name);
      steps.forEach((s) => s.setAttribute("aria-current", s.dataset.t === t ? "true" : "false"));
    }
    function paintForge() {
      card.setAttribute("data-forge", forgeOn ? "on" : "off");
      forgeButton.setAttribute("aria-pressed", forgeOn ? "true" : "false");
      forgeButton.querySelector("small").textContent = forgeOn ? "Engaged" : "Standby";
    }
    /*
     * The armed state names the currently selected model, because the roster is the whole point:
     * arming Wildfire on a model that is not starred does nothing except earn a refusal from the
     * server. Saying so here, at the moment of arming, beats discovering it mid-job.
     */
    function paintWildfire() {
      if (!wildfireButton) return;
      const sel = document.getElementById("model");
      const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
      const starred = !!(opt && opt.dataset && opt.dataset.broad === "1");
      card.setAttribute("data-wildfire", wildOn ? "on" : "off");
      wildfireButton.setAttribute("aria-pressed", wildOn ? "true" : "false");
      wildfireButton.classList.toggle("dial-wildfire-mismatch", wildOn && !starred);
      wildfireButton.querySelector("small").textContent =
        !wildOn ? "Contained"
        : starred ? "ARMED"
        : "Armed, but this model is not starred";
    }
    function apply(t, persist) { live = t; paint(t); if (persist !== false) setTier(t); }
    paint(cur);
    paintForge();
    paintWildfire();

    if (wildfireButton) {
      wildfireButton.addEventListener("click", (e) => {
        e.stopPropagation();
        wildOn = !wildOn;
        setWildfire(wildOn);
        paintWildfire();
      });
    }

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
    const center = () => { const r = stage.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * .56 }; };
    const angleToTier = (deg) => (deg <= -26 ? "ember" : deg >= 26 ? "furnace" : "flame");
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".dial-step") || e.target.closest(".dial-forge-mode") || e.target.closest(".dial-done")) return;
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
    forgeButton.addEventListener("click", (e) => {
      e.stopPropagation();
      forgeOn = !forgeOn;
      setForgeMode(forgeOn);
      paintForge();
      card.classList.remove("forge-pulse");
      requestAnimationFrame(() => card.classList.add("forge-pulse"));
    });
    card.querySelectorAll(".dial-spark").forEach((sp, i) => sp.style.setProperty("--drift", (i % 2 ? -1 : 1) * (4 + i * 3) + "px"));

    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      setTier(live);
      setForgeMode(forgeOn);
      scrim.classList.remove("in");
      document.body.classList.remove("dfd-open");
      document.removeEventListener("keydown", onKey, true);
      // Drop the transform context and the panel after the slide-back completes.
      setTimeout(() => {
        document.body.classList.remove("dfd-anim");
        if (dialRoot) { dialRoot.remove(); dialRoot = null; }
      }, 500);
    };
    window.closeForgeDial = close;
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true);
    card.querySelector(".dial-done").addEventListener("click", close);
    back.addEventListener("click", close);
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });

    // Force a style flush between the two classes so the slide transitions instead of jumping
    // (no requestAnimationFrame dependency — throttled or absent in some webviews).
    document.body.classList.add("dfd-anim");
    void dialRoot.offsetWidth;
    document.body.classList.add("dfd-open");
    scrim.classList.add("in");
    stage.focus();
  }
  window.openForgeDial = openDial;

  function initTrigger() {
    triggerEl = document.getElementById("forge-trigger");
    if (!triggerEl) return;
    triggerEl.setAttribute("data-tier", getTier());
    triggerEl.setAttribute("data-forge", getForgeMode() ? "on" : "off");
    triggerEl.addEventListener("click", (e) => { e.preventDefault(); openDial(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTrigger);
  else initTrigger();
})();
