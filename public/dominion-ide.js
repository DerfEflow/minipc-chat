/*
 * Dominion Works (IDE mode). Phase 1: the toggle and the third reveal.
 *   SOW:        docs/IDE-MODE-ROADMAP.md
 *   Build pack: docs/IDE-MODE-BUILD.md
 *
 * Scope of THIS phase: the drawer toggle, the reveal shell, the motion, and the mutual-exclusion
 * protocol with the other two reveals. The workspace picker and build surface land in Phase 2, so
 * the stage carries an honest empty state rather than mock UI.
 *
 * Two separate ideas, deliberately not conflated:
 *   ALLOWED  = the server says this account may use IDE mode (GET /account -> ideMode, driven by
 *              the IDE_MODE env gate in ide.mjs). Guests are dark until Phase 8.
 *   ENGAGED  = the user flipped the toggle on. Per device, localStorage.
 * A user who is not ALLOWED never sees the row at all, so ENGAGED cannot be reached.
 */
(() => {
  "use strict";

  const ENGAGED_KEY = "dominion.ide.enabled.v1";

  const state = { allowed: false, engaged: false, open: false };

  const $ = (sel) => document.querySelector(sel);
  const readEngaged = () => {
    try { return localStorage.getItem(ENGAGED_KEY) === "1"; } catch { return false; }
  };
  const writeEngaged = (on) => {
    try { localStorage.setItem(ENGAGED_KEY, on ? "1" : "0"); } catch {}
  };

  // ---------- the reveal ----------------------------------------------------------------
  // Built once and KEPT (the Forge Images lifecycle, not the dial's destroy-on-close), so the
  // CSS `body:not(.ide-anim) #ide-root { display:none }` guard is load-bearing: without it the
  // parked panel would sit over the chat surface and swallow clicks.
  function buildPanel() {
    if ($("#ide-root")) return;
    const root = document.createElement("section");
    root.id = "ide-root";
    root.setAttribute("aria-label", "Dominion Works");

    const rail = document.createElement("div");
    rail.className = "ide-rail";

    const back = document.createElement("button");
    back.type = "button";
    back.className = "ide-rail-btn";
    back.id = "ide-back";
    back.title = "Back to conversation";
    back.setAttribute("aria-label", "Back to conversation");
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

    const title = document.createElement("div");
    title.className = "ide-rail-title";
    title.innerHTML = '<span class="t">Dominion Works</span>'
      + '<span class="s">Build surface for applications and design</span>';

    const lamp = document.createElement("span");
    lamp.className = "ide-lamp";
    lamp.id = "ide-lamp";
    lamp.dataset.state = "idle";
    lamp.innerHTML = '<i aria-hidden="true"></i><span id="ide-lamp-text">Standby</span>';

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ide-rail-btn";
    close.id = "ide-close";
    close.title = "Close Dominion Works";
    close.setAttribute("aria-label", "Close Dominion Works");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    rail.append(back, title, lamp, close);

    const stage = document.createElement("div");
    stage.className = "ide-stage";
    stage.id = "ide-stage";
    // Honest empty state. This is scaffolding with the truth on it, never mock UI pretending to
    // be a feature that does not exist yet.
    stage.innerHTML = '<div class="ide-empty">'
      + '<span class="ide-empty-core" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>'
      + '</span>'
      + '<h2>The works are open</h2>'
      + '<p>This is where a build gets planned, assigned to models, and run on your own machine. '
      + 'The shell, the toggle, and the motion are live now.</p>'
      + '<p class="note">Phase 1 of 8 is in. Workspaces and the job spine land in Phase 2, model '
      + 'assignment in Phase 3, and background builds that keep running after you close the app in '
      + 'Phase 4. Nothing here bills you yet.</p>'
      + '</div>';

    root.append(rail, stage);
    document.body.append(root);

    back.addEventListener("click", closePanel);
    close.addEventListener("click", closePanel);
  }

  function openPanel() {
    if (!state.allowed || !state.engaged) return;
    if (state.open) return;
    // One reveal at a time. The dial and Forge Images each transform the same four shell
    // elements; two open at once would stack transform contexts and strand the shell off-screen.
    if (window.closeForgeDial) window.closeForgeDial();
    if (window.closeForgeImages) window.closeForgeImages();
    buildPanel();
    state.open = true;
    document.body.classList.add("ide-anim");
    // Force a style flush between the two classes so the lift transitions instead of jumping.
    void $("#ide-root").offsetWidth;
    document.body.classList.add("ide-open");
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;
    document.body.classList.remove("ide-open");
    // Keep the transform context alive until the travel finishes, then drop it so position:fixed
    // resolves normally again for the shell's own descendants.
    setTimeout(() => { if (!state.open) document.body.classList.remove("ide-anim"); }, 500);
  }

  // ---------- the toggle ----------------------------------------------------------------
  function paintToggle() {
    const row = $("#sb-ide");
    if (row) {
      row.classList.toggle("on", state.allowed);
      row.setAttribute("aria-pressed", state.engaged ? "true" : "false");
      const label = row.querySelector(".ide-row-label");
      if (label) label.textContent = state.engaged ? "IDE Mode: on" : "IDE Mode";
    }
    const trig = $("#ide-trigger");
    if (trig) {
      trig.classList.toggle("on", state.allowed && state.engaged);
      trig.dataset.ide = state.engaged ? "on" : "off";
    }
  }

  function setEngaged(on, { reveal = false, push = true } = {}) {
    state.engaged = !!on;
    writeEngaged(state.engaged);
    paintToggle();
    if (!state.engaged) closePanel();
    else if (reveal) openPanel();
    // Remember it on the ACCOUNT too, so flipping it on the laptop is already on when the phone
    // opens (ledger L-5). The local copy stays authoritative for the first paint: the switch must
    // never wait on a network round trip to look right.
    if (push) {
      fetch("/ide/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engaged: state.engaged }),
      }).catch(() => {});
    }
  }

  function initToggleRow() {
    const row = $("#sb-ide");
    if (!row) return;
    row.addEventListener("click", () => {
      // Flipping it ON opens the works immediately: Fred's spec is that flipping the switch takes
      // you there, not that it arms a second control you then have to find.
      setEngaged(!state.engaged, { reveal: true });
    });
    paintToggle();
  }

  function initTrigger() {
    if ($("#ide-trigger")) return;
    const barLeft = document.getElementById("bar-left");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "";
    btn.id = "ide-trigger";
    btn.title = "Dominion Works";
    btn.setAttribute("aria-label", "Open Dominion Works");
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>';
    btn.addEventListener("click", openPanel);
    if (barLeft) barLeft.append(btn);
    else document.body.append(btn);
    paintToggle();
  }

  // ---------- boot ----------------------------------------------------------------------
  // Availability comes from the server, never from the client's own opinion. A guest who edits
  // localStorage still gets nothing: the row stays hidden, openPanel refuses, and every Phase 2+
  // endpoint will gate server-side as well.
  async function loadAllowed() {
    try {
      const r = await fetch("/account", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const a = await r.json();
      state.allowed = a && a.ideMode === true;
    } catch {}
    if (!state.allowed) { state.engaged = false; closePanel(); paintToggle(); return; }
    paintToggle();
    // Now that we know we are allowed, adopt the account's remembered switch position if this
    // device has never set one. A device that HAS a stored preference keeps it: the person holding
    // this phone gets the last word over what some other device decided.
    try {
      const r = await fetch("/ide/state", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const s = await r.json();
      const deviceHasOpinion = (() => { try { return localStorage.getItem(ENGAGED_KEY) !== null; } catch { return false; } })();
      if (!deviceHasOpinion && s && s.prefs && s.prefs.engaged === true) {
        setEngaged(true, { reveal: false, push: false });
      }
    } catch {}
  }

  function init() {
    state.engaged = readEngaged();
    initToggleRow();
    initTrigger();
    paintToggle();
    loadAllowed();
  }

  // Escape closes the works. Registered WITHOUT capture so the dial and askText (both capture:true)
  // keep their precedence; mutual exclusion means only one reveal is ever open anyway, and the
  // state.open check makes this a no-op otherwise.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open) { e.preventDefault(); closePanel(); }
  });

  window.openIdeMode = openPanel;
  window.closeIdeMode = closePanel;
  window.ideModeEngaged = () => state.engaged;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
