/*
 * The Crucible in Vibe Coder mode: Crucible App Launcher.
 *   Fred's hand-drawn layout, dictated 2026-07-24/25. Spec: docs/VIBE-CODER-SOW.md (committed
 *   before this file existed, so the drawing survives any context loss).
 *
 * THE SHAPE, top to bottom, exactly as drawn:
 *   1. App Project Slider — a draggable rail of project cards, Future Project Slot first.
 *   2. + New / TBD / Start Over / Save to: — the left column of small controls.
 *   3. Customize Your Workspace — the Studio's presets and eight modules, inline, with Apply.
 *   4. Plan with AI — Main plus optional Second and Third windows, each with its own model and
 *      its own background colour, each draggable taller, each able to route across windows.
 *   5. Agent Army — the orchestrator row and the per-task crew table. ONLY when the Agent Crew
 *      module is checked; unchecked, the section is absent and the build runs the default AI
 *      autonomously (bridge.clearAF()).
 *   6. Begin Building — one wide button.
 *
 * WHAT IT DOES NOT OWN: build machinery, folders, job state, studio truth. All of it goes through
 * window.dominionIdeBridge, same discipline as the beginner surface, so the engine sees one
 * contract no matter which surface wrote it.
 *
 * THE STANDING RULE (Fred, verbatim): "Whichever window is the receiver, they treat the sent
 * message as another opinion, not a command from the user. Only commands from the user are ever
 * acted upon." The server enforces the wire framing (/ide/planchat + planchatMessages); this file
 * only tags each turn with the window it came from and never invents a user turn.
 */
(() => {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const bridge = () => window.dominionIdeBridge || null;
  const L = (k) => (window.DominionLexicon ? window.DominionLexicon.L(k) : k);
  const reg = () => (window.DominionLexicon ? window.DominionLexicon.register : "hybrid");

  const WINDOWS = ["main", "second", "third"];
  /*
   * Army ranks (Fred, 2026-07-26): the planning stage speaks the Agent Army's language. The
   * General plans in the Main window; the Captain and the Sergeant advise. Insignia are drawn
   * inline so they ride each window's own hue: four stars, twin bars, three chevrons.
   */
  const WNAME = { main: "The General", second: "The Captain", third: "The Sergeant" };
  const WSUB = { main: "Main AI planner", second: "Secondary AI planner", third: "Third AI planner" };
  const star = (x) => '<path transform="translate(' + x + ',0)" d="M8 1l2.06 4.17 4.6.67-3.33 3.25.79 4.58L8 11.5l-4.12 2.17.79-4.58L1.34 5.84l4.6-.67z"/>';
  const chevron = (y) => '<path transform="translate(0,' + y + ')" d="M2 6L10 2l8 4v3l-8-4-8 4z"/>';
  const WRANK_SVG = {
    main: '<svg class="vb-rank" viewBox="0 0 64 16" aria-hidden="true">' + [0, 16, 32, 48].map(star).join("") + '</svg>',
    second: '<svg class="vb-rank" viewBox="0 0 26 16" aria-hidden="true"><rect x="2" y="1" width="9" height="14" rx="1.5"/><rect x="15" y="1" width="9" height="14" rx="1.5"/></svg>',
    third: '<svg class="vb-rank" viewBox="0 0 20 21" aria-hidden="true">' + [0, 5, 10].map(chevron).join("") + '</svg>',
  };
  const DRAFT_KEY = "dominion.vibe.plan.v1";

  const state = {
    open: false,
    built: false,
    // One conversation per window. Every turn is {from: "user"|"main"|"second"|"third", content},
    // which is exactly the wire shape /ide/planchat consumes: the from-tag IS the routing truth.
    chats: {
      main: { messages: [], model: "", busy: false, open: true },
      second: { messages: [], model: "", busy: false, open: false },
      third: { messages: [], model: "", busy: false, open: false },
    },
    vision: null,
    army: null,          // { tasks, picks[], orchestrator, fallbackNote } once planned
    armyBusy: false,
    // Adopt Existing Project (docs/ADOPT-EXISTING-SOW.md): { workspaceId, name, brief } once a
    // scan has landed. The brief seeds the Main window, every Main turn carries adopt on the
    // wire, and Begin Building bakes the brief into the build prompt for THAT workspace only.
    adopt: null,
  };

  const device = () => (window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 620 ? "mobile" : "desktop");

  /* ================= draft persistence ====================================================== */

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        chats: Object.fromEntries(WINDOWS.map((w) => [w, {
          // Pictures are not persisted (a phone photo in localStorage would blow the quota fast);
          // multimodal turns collapse to their text on reload, which is the honest cheap trade.
          messages: state.chats[w].messages.map((m) => ({ from: m.from, content: typeof m.content === "string" ? m.content : (m.content.find((p) => p.type === "text") || { text: "(picture)" }).text })).slice(-40),
          model: state.chats[w].model, open: state.chats[w].open,
        }])),
        vision: state.vision, adopt: state.adopt, at: Date.now(),
      }));
    } catch {}
  }
  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!d || !d.chats) return;
      for (const w of WINDOWS) {
        if (d.chats[w]) {
          state.chats[w].messages = Array.isArray(d.chats[w].messages) ? d.chats[w].messages : [];
          state.chats[w].model = d.chats[w].model || "";
          state.chats[w].open = w === "main" ? true : !!d.chats[w].open;
        }
      }
      state.vision = d.vision || null;
      state.adopt = (d.adopt && d.adopt.workspaceId && d.adopt.brief) ? d.adopt : null;
    } catch {}
  }

  /* ================= the shell =============================================================== */

  function build() {
    if (state.built) return $("#vb-shell");
    const stage = $("#ide-stage");
    if (!stage) return null;

    const el = document.createElement("section");
    el.className = "vb-shell";
    el.id = "vb-shell";
    el.innerHTML =
      // ---- 1. App Project Slider ------------------------------------------------------------
      '<div class="vb-strip">' +
        '<h3 class="vb-h">App Project Slider</h3>' +
        '<div class="vb-slider" id="vb-slider" aria-label="Your projects. Drag left and right."></div>' +
      '</div>' +

      // ---- 2. the small-controls row --------------------------------------------------------
      '<div class="vb-controls">' +
        '<button type="button" class="vb-square" id="vb-new" title="Start a new project">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New</span>' +
        '</button>' +
        // Adopt Existing Project (docs/ADOPT-EXISTING-SOW.md): the prominent door for an app the
        // person already started. Beside New per the placement ruling; the reserved TBD slot
        // stays reserved because Fred has not assigned it.
        '<button type="button" class="vb-square vb-adopt" id="vb-adopt" title="Bring an app you already started">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10M8 9l4 4 4-4M4 15v5h16v-5"/></svg><span>Adopt an App</span>' +
        '</button>' +
        // Fred: "TBD is just a placeholder for now." A visibly inert reserved slot beats an
        // invented feature; it does nothing and says so on hover.
        '<div class="vb-square vb-tbd" title="Reserved. Fred has not decided what lives here yet." aria-hidden="true"><span>TBD</span></div>' +
        '<button type="button" class="vb-small" id="vb-startover">Start Over</button>' +
        '<label class="vb-small vb-saveto">Save to: <select id="vb-saveto" aria-label="Which project folder the build lands in"></select></label>' +
      '</div>' +

      // ---- 2b. the Adopt panel (opens from the Adopt an App square) -------------------------
      // The intro line is the feature's one-sentence introduction (Fred's marketing seed, placed
      // subtly as body copy rather than shouted as a banner).
      '<div class="vb-box vb-adopt-panel" id="vb-adopt-panel" hidden>' +
        '<div class="vb-box-head"><h3 class="vb-h">Adopt an App You Already Started</h3>' +
          '<button type="button" class="vb-adopt-x" id="vb-adopt-close" aria-label="Close">&times;</button></div>' +
        '<p class="vb-adopt-intro">Bring your half-finished app. We read what\'s actually there, tell you the truth about it, and finish it.</p>' +
        '<div class="vb-adopt-pick">' +
          '<label class="vb-adopt-lab">It lives in: <select id="vb-adopt-ws" aria-label="Which project folder holds the app you already started"></select></label>' +
          '<button type="button" class="vb-small" id="vb-adopt-browse">Browse this computer</button>' +
        '</div>' +
        '<div class="vb-adopt-tree" id="vb-adopt-tree" hidden></div>' +
        '<div class="vb-box-foot"><span class="vb-note" id="vb-adopt-note">Reading only. Nothing in the folder changes until you say build.</span>' +
          '<button type="button" class="vb-apply" id="vb-adopt-go">Analyze my app</button></div>' +
      '</div>' +

      // ---- 3. Customize Your Workspace ------------------------------------------------------
      '<div class="vb-box" id="vb-studio">' +
        '<div class="vb-box-head"><h3 class="vb-h">Customize Your Workspace</h3><span class="vb-note">Preloads</span></div>' +
        '<div class="vb-presets" id="vb-presets">' +
          '<button type="button" data-preset="minimal">Minimal</button>' +
          '<button type="button" data-preset="design">Design Studio</button>' +
          '<button type="button" data-preset="fullstack">Full Stack</button>' +
        '</div>' +
        '<div class="vb-mods" id="vb-mods"></div>' +
        '<div class="vb-box-foot"><span class="vb-note">Custom picks make it yours; Apply makes it so.</span><button type="button" class="vb-apply" id="vb-apply">Apply</button></div>' +
      '</div>' +

      // ---- 3b. Active module designations (Fred, 2026-07-25) --------------------------------
      // Every PICKED module shows a tile here the moment Apply lands. Fix for "Apply does
      // nothing": most modules' real surfaces (Live Preview, Files/Diffs, Results, History)
      // only exist once a build runs, so applying them changed nothing visible. The tiles are
      // normal document flow — they wrap on mobile, never overlap, and are never pinned.
      '<div class="vb-desig" id="vb-desig" aria-live="polite"></div>' +

      // ---- 4. Plan with AI ------------------------------------------------------------------
      '<div class="vb-plan">' +
        '<h3 class="vb-h">Plan with AI</h3>' +
        windowHtml("main") +
        '<div class="vb-plan-row">' + windowHtml("second") + windowHtml("third") + '</div>' +
      '</div>' +

      // ---- 5. Agent Army (present only when the Agent Crew module is checked) ---------------
      // The dividing banner (Fred, 2026-07-26): planning above, building below, said at the same
      // size as the Plan with AI banner. It rides the Agent Army's gate: no crew module, no
      // troops to assign, no banner.
      '<h3 class="vb-h vb-banner" id="vb-army-banner" hidden>Assign Your Troops for the Build</h3>' +
      '<div class="vb-box vb-army" id="vb-army" hidden>' +
        '<div class="vb-box-head"><h3 class="vb-h">Agent Army</h3>' +
          '<button type="button" id="vb-plan-tasks">Plan the tasks</button></div>' +
        '<div class="vb-orch" id="vb-orch">' +
          '<span class="vb-orch-label">Orchestrator</span>' +
          '<select id="vb-orch-model" aria-label="The one model that plans and divides the whole build"></select>' +
          '<span class="vb-orch-note" id="vb-orch-note">Plans and divides the whole build. This one seat is limited to the bigger models.</span>' +
        '</div>' +
        '<div class="vb-army-grid" id="vb-army-grid" hidden>' +
          '<div class="vb-army-head">Task</div><div class="vb-army-head">Model</div>' +
          '<div class="vb-army-head"># of agents</div><div class="vb-army-head">Est Cost</div>' +
          '<div class="vb-army-head">Est Time</div>' +
        '</div>' +
        '<div class="vb-army-total" id="vb-army-total" hidden></div>' +
      '</div>' +

      // ---- 6. Begin Building ----------------------------------------------------------------
      '<button type="button" class="vb-begin" id="vb-begin">BEGIN BUILDING</button>' +
      '<div class="vb-status" id="vb-status" role="status"></div>';

    // Before the classic starter, so the lens area (#cru: preview, results, files/diffs — the
    // studio-gated modules) keeps its place below everything.
    const starter = $("#ide-start");
    if (starter) stage.insertBefore(el, starter); else stage.append(el);
    state.built = true;
    wire();
    return el;
  }

  function windowHtml(w) {
    const optional = w === "main" ? "" : " · optional";
    const title =
      '<b class="vb-win-title">' + WRANK_SVG[w] +
        '<span class="vb-rank-name">' + WNAME[w] + '</span>' +
        '<em class="vb-rank-sub">(' + WSUB[w] + optional + ')</em>' +
      '</b>';
    const picker = '<select class="vb-win-model" id="vb-model-' + w + '" aria-label="Model for ' + WNAME[w] + '"></select>';
    // The General keeps the picker beside the title (the drawing's upper-left note). The Captain
    // and the Sergeant carry theirs just BELOW the title (Fred, 2026-07-26): rank first, seat under.
    const head = w === "main"
      ? '<header class="vb-win-head">' + picker + title + '</header>'
      : '<header class="vb-win-head vb-win-head-col">' +
          '<div class="vb-win-toprow">' + title +
            // Fresh start (Fred, 2026-07-26): wipe THIS advisor's conversation mid-planning for an
            // unbiased second opinion. Main never carries it — the General's thread is the plan.
            '<button type="button" class="vb-win-fresh" data-win="' + w + '" title="Clear this conversation and start ' + WNAME[w] + ' from scratch">Fresh start</button>' +
            '<button type="button" class="vb-win-toggle" data-win="' + w + '" aria-expanded="false">Open chat</button>' +
          '</div>' + picker +
        '</header>';
    return (
      '<section class="vb-win vb-win-' + w + '" id="vb-win-' + w + '" data-win="' + w + '">' +
        head +
        '<div class="vb-win-body" id="vb-body-' + w + '"' + (w === "main" ? "" : " hidden") + '>' +
          '<div class="vb-log" id="vb-log-' + w + '" aria-live="polite"></div>' +
          '<div class="vb-grab" data-win="' + w + '" title="Drag to make this window taller" aria-hidden="true"><i></i></div>' +
          '<div class="vb-row">' +
            '<textarea id="vb-in-' + w + '" rows="1" placeholder="Type here…" aria-label="Message for ' + WNAME[w] + '"></textarea>' +
            '<div class="vb-sendstack" id="vb-sendstack-' + w + '">' +
              // The chevron says out loud that Send opens the destination stack (Fred, 2026-07-30:
              // "no obvious control to send those chat portions to any of the AIs").
              '<button type="button" class="vb-send" id="vb-send-' + w + '">Send &#9662;</button>' +
              '<div class="vb-sendto" id="vb-sendto-' + w + '" hidden></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>');
  }

  /* ================= models ================================================================= */

  function fillModels(sel, current, { orchestratorOnly = false, allowDefault = true } = {}) {
    if (!sel || !bridge()) return;
    sel.textContent = "";
    if (allowDefault) sel.append(new Option(orchestratorOnly ? "Default (recommended)" : "My main model", ""));
    for (const g of bridge().models()) {
      const grp = document.createElement("optgroup");
      grp.label = g.label;
      let any = false;
      for (const m of g.models) {
        if (orchestratorOnly && !m.orchestratorOk) continue;   // the one floor in the app
        const o = new Option(m.name + (m.priceShort ? "  " + m.priceShort : ""), m.id);
        if (m.unavailable) { o.disabled = true; o.text = m.name + "  (needs a provider key)"; }
        grp.append(o); any = true;
      }
      if (any) sel.append(grp);
    }
    sel.value = current || "";
  }

  function paintAllModelSelects() {
    for (const w of WINDOWS) fillModels($("#vb-model-" + w), state.chats[w].model);
    fillModels($("#vb-orch-model"), (state.army && state.army.orchestrator) || "", { orchestratorOnly: true });
    if (state.army) for (const [i, p] of state.army.picks.entries()) fillModels($("#vb-tmodel-" + i), p.model || "");
  }

  /* ================= 1. the slider =========================================================== */

  function renderSlider() {
    const rail = $("#vb-slider");
    if (!rail || !bridge()) return;
    rail.textContent = "";
    // The Future Project Slot leads: the empty card IS the invitation.
    const future = document.createElement("button");
    future.type = "button";
    future.className = "vb-card vb-card-future";
    future.innerHTML = "<span>+</span><small>Future Project Slot</small>";
    future.addEventListener("click", newProject);
    rail.append(future);
    for (const ws of bridge().workspaces()) {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "vb-card" + (bridge().workspaceId() === ws.id ? " on" : "");
      c.innerHTML = '<span class="vb-card-name"></span><small>project</small>';
      c.querySelector(".vb-card-name").textContent = ws.name || ws.id;
      c.addEventListener("click", () => { bridge().selectWorkspace(ws.id); renderSlider(); renderSaveTo(); });
      rail.append(c);
    }
    const more = document.createElement("div");
    more.className = "vb-card vb-card-more";
    more.innerHTML = "<span>→ ?</span><small>what's next</small>";
    rail.append(more);
  }

  // Drag left and right, as drawn. Native horizontal scroll does the physics; the pointer drag
  // just feeds it, so momentum and overscroll stay the platform's problem, not ours.
  function wireSliderDrag(rail) {
    let down = null;
    rail.addEventListener("pointerdown", (e) => { down = { x: e.clientX, left: rail.scrollLeft, moved: false }; });
    rail.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 6) { down.moved = true; rail.setPointerCapture?.(e.pointerId); }
      if (down.moved) rail.scrollLeft = down.left - dx;
    });
    const up = (e) => {
      // A drag must not also count as a tap on whatever card it ended over.
      if (down && down.moved) e.target.closest && e.target.closest(".vb-card") && e.stopPropagation();
      down = null;
    };
    rail.addEventListener("pointerup", up, true);
    rail.addEventListener("pointercancel", () => { down = null; });
  }

  function renderSaveTo() {
    const sel = $("#vb-saveto");
    if (!sel || !bridge()) return;
    sel.textContent = "";
    sel.append(new Option("(new folder at build time)", ""));
    for (const ws of bridge().workspaces()) sel.append(new Option(ws.name || ws.id, ws.id));
    sel.value = bridge().workspaceId() || "";
  }

  function newProject() {
    // A new project is a clean slate pointed at no folder: the build makes one when it starts.
    bridge() && bridge().selectWorkspace("");
    const sel = $("#vb-saveto");
    if (sel) sel.value = "";
    startOver();
  }

  function startOver() {
    for (const w of WINDOWS) { state.chats[w].messages = []; state.chats[w].busy = false; renderLog(w); }
    state.vision = null;
    state.adopt = null;
    closeAdopt();
    state.army = null;
    $("#vb-army-grid").hidden = true;
    $("#vb-army-total").hidden = true;
    const grid = $("#vb-army-grid");
    [...grid.querySelectorAll(".vb-army-cell")].forEach((n) => n.remove());
    orchNote("");
    bridge() && bridge().clearAF();
    saveDraft();
    status("Fresh page. Nothing carried over.");
  }

  /* ================= 3. Customize Your Workspace ============================================ */

  const MOD_LABELS = {
    workspace: "Workspace", brief: "Build Brief", crew: "Agent Crew", cost: "Cost",
    preview: "Live Preview", checks: "Results", history: "History", code: "Files/Diffs",
  };
  let pendingModules = null;   // staged picks; Apply commits them to the real studio

  function renderStudio() {
    const box = $("#vb-mods");
    if (!box || !bridge()) return;
    const current = new Set(pendingModules || bridge().studioModules());
    box.textContent = "";
    for (const [id, label] of Object.entries(MOD_LABELS)) {
      const lab = document.createElement("label");
      lab.className = "vb-mod";
      const input = document.createElement("input");
      input.type = "checkbox"; input.value = id; input.checked = current.has(id);
      input.addEventListener("change", () => {
        pendingModules = [...box.querySelectorAll("input:checked")].map((i) => i.value);
        paintPresetButtons();
      });
      lab.append(input, document.createTextNode(" " + label));
      box.append(lab);
    }
    paintPresetButtons();
    paintDesignations();   // the applied set's tiles stay in step with every repaint
  }

  function paintPresetButtons() {
    if (!bridge()) return;
    const presets = bridge().studioPresets();
    const chosen = [...(pendingModules || bridge().studioModules())].sort().join(",");
    for (const b of document.querySelectorAll("#vb-presets button")) {
      const ids = presets[b.dataset.preset] || [];
      b.classList.toggle("on", [...ids].sort().join(",") === chosen);
    }
  }

  // Where each module's REAL surface lives, told honestly on its tile.
  const MOD_HOMES = {
    workspace: "folder drawer, below the build area",
    brief: "brief drawer, below the build area",
    crew: "Agent Army section, right on this page",
    cost: "cost meter, below the build area",
    preview: "appears in the build windows once a build runs",
    checks: "appears in the build windows once a build runs",
    code: "appears in the build windows once a build runs",
    history: "log button, below the build area",
  };
  function paintDesignations() {
    const box = $("#vb-desig");
    if (!box || !bridge()) return;
    const active = bridge().studioModules();
    box.textContent = "";
    for (const id of active) {
      if (!MOD_LABELS[id]) continue;
      const t = document.createElement("div");
      t.className = "vb-desig-tile";
      t.innerHTML = "<b></b><span></span>";
      t.querySelector("b").textContent = MOD_LABELS[id];
      t.querySelector("span").textContent = MOD_HOMES[id] || "";
      box.append(t);
    }
    box.hidden = !box.childNodes.length;
  }

  function applyStudio() {
    if (!bridge()) return;
    bridge().setStudioModules(pendingModules || bridge().studioModules());
    pendingModules = null;
    paintDesignations();
    const names = bridge().studioModules().map((id) => MOD_LABELS[id] || id);
    status("Workspace applied: " + (names.length ? names.join(", ") : "minimal — no extra modules") + ".");
  }

  /*
   * THE RULE THAT MAKES THE CHECKBOX LOAD-BEARING (Fred, 2026-07-25): no Agent Crew module means
   * NO Agent Army section — absent, not greyed — and the build reverts to the default AI for the
   * entire job, run autonomously. clearAF() is what makes the second half true: with no af block
   * in the assignments, the engine takes the ordinary single-model path it always had.
   */
  function gateArmy() {
    const has = !bridge() || bridge().studioModules().includes("crew");
    const army = $("#vb-army");
    if (army) army.hidden = !has;
    const banner = $("#vb-army-banner");
    if (banner) banner.hidden = !has;
    if (!has && bridge()) { bridge().clearAF(); state.army = null; }
  }

  /* ================= 2b. Adopt an App (docs/ADOPT-EXISTING-SOW.md) ========================== */

  const adoptNote = (text, bad, good) => {
    const el = $("#vb-adopt-note");
    if (!el) return;
    el.textContent = text || "Reading only. Nothing in the folder changes until you say build.";
    el.classList.toggle("is-bad", !!bad);
    el.classList.toggle("is-good", !!good);
  };

  // A chosen folder announces itself: green confirmation naming the project, and the Analyze
  // button pulses so the next press is unmissable. Quiet success was the bug (Fred, 2026-07-26:
  // "neither of which did anything I could see").
  function adoptChosen(name) {
    adoptNote("“" + (name || "That folder") + "” is chosen. Press Analyze my app.", false, true);
    const st = $("#vb-saveto");
    const go = $("#vb-adopt-go");
    if (go) { go.classList.remove("vb-pulse"); void go.offsetWidth; go.classList.add("vb-pulse"); }
    return st;
  }

  function paintAdoptChoices() {
    const sel = $("#vb-adopt-ws");
    if (!sel || !bridge()) return;
    const keep = sel.value;
    sel.textContent = "";
    sel.append(new Option("Pick the folder that holds it…", ""));
    for (const ws of bridge().workspaces()) sel.append(new Option(ws.name || ws.id, ws.id));
    // Follow the Save to: pick when it names a real project; a fresh browse pick wins over both.
    sel.value = keep || $("#vb-saveto").value || "";
  }

  function openAdopt() {
    const p = $("#vb-adopt-panel");
    if (!p) return;
    p.hidden = false;
    paintAdoptChoices();
    adoptNote("");
    p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeAdopt() {
    const p = $("#vb-adopt-panel");
    if (p) p.hidden = true;
    const tree = $("#vb-adopt-tree");
    if (tree) { tree.hidden = true; tree.textContent = ""; }
  }

  /*
   * The folder walk, for an app that is not a workspace yet. Same /ide/browse contract as the
   * engineer drawer: the node lists its own drives and folders, carve-outs refused at the node,
   * and the walk stays pinned to one machine (C:\ exists on more than one computer). Picking a
   * folder creates the workspace pointer; a folder that is already a workspace is reused rather
   * than duplicated, because the server refuses duplicate pointers by design.
   */
  function wireAdoptBrowse() {
    const tree = $("#vb-adopt-tree");
    let onMachine = "";
    const browse = async (path, machine) => {
      tree.hidden = false;
      tree.textContent = "Reading folders…";
      if (machine !== undefined) onMachine = machine || "";
      let j = null;
      try {
        const r = await fetch("/ide/browse", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: path || "", node: onMachine }) });
        j = await r.json();
      } catch { j = null; }
      if (!j || j.error) { tree.textContent = (j && j.error) || "The build computer could not be reached."; return; }
      if (j.node) onMachine = j.node;
      if (!path) onMachine = "";
      render(j.path || "", j.dirs || []);
    };
    const render = (path, dirs) => {
      tree.textContent = "";
      const bar = document.createElement("div");
      bar.className = "vb-adopt-bar";
      const where = document.createElement("span");
      where.textContent = (path || "This computer") + (onMachine ? "  ·  " + onMachine : "");
      bar.append(where);
      if (path) {
        const up = document.createElement("button");
        up.type = "button"; up.textContent = "Up";
        up.addEventListener("click", () => {
          const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
          if (parts.length <= 1) { browse("", ""); return; }
          browse(parts.length === 2 ? parts[0] + "\\" : parts.slice(0, -1).join("\\"), onMachine);
        });
        const use = document.createElement("button");
        use.type = "button"; use.className = "vb-adopt-use"; use.textContent = "This folder holds it";
        use.addEventListener("click", () => useFolder(path));
        bar.append(up, use);
      }
      tree.append(bar);
      /*
       * Every row offers BOTH gestures (Fred, 2026-07-26: "it would not let me pick a parent
       * folder, it would only click past it"): the name steps INSIDE the folder; the This one
       * button CHOOSES that folder directly, no descent required. Choosing at the drive list
       * pins the machine first, same rule as walking.
       */
      for (const d of dirs) {
        const row = document.createElement("div");
        row.className = "vb-adopt-dirrow";
        const b = document.createElement("button");
        b.type = "button"; b.className = "vb-adopt-dir";
        b.textContent = d.name + (!path && d.machine ? "   " + d.machine : "");
        b.addEventListener("click", () => browse(d.path, d.machine));
        const pick = document.createElement("button");
        pick.type = "button"; pick.className = "vb-adopt-pickone";
        pick.textContent = "This one";
        pick.title = "Choose this folder without opening it";
        pick.addEventListener("click", () => {
          if (!path && d.machine) onMachine = d.machine;
          useFolder(d.path);
        });
        row.append(b, pick);
        tree.append(row);
      }
      if (!dirs.length && path) {
        const none = document.createElement("div");
        none.className = "vb-adopt-empty";
        none.textContent = "No folders inside this one.";
        tree.append(none);
      }
    };
    const useFolder = async (path) => {
      const existing = bridge().workspaces().find((w) => String(w.root || "").toLowerCase() === path.toLowerCase());
      if (existing) {
        bridge().selectWorkspace(existing.id);
        renderSlider(); renderSaveTo();
        paintAdoptChoices();
        $("#vb-adopt-ws").value = existing.id;
        const st = adoptChosen(existing.name); if (st) st.value = existing.id;
        tree.hidden = true;
        return;
      }
      const name = path.split(/[\\/]/).filter(Boolean).pop() || "Adopted App";
      try {
        const r = await fetch("/ide/workspace", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, root: path, node: onMachine }) });
        const j = await r.json();
        if (!r.ok || j.error) { adoptNote(j.error || "That folder could not be added.", true); return; }
        /*
         * The order is the fix (Fred's report 2026-07-26): the bridge learns the new workspace
         * FIRST, so every list painted below actually contains it and the select can hold it.
         * Before this, the option did not exist, the set silently failed, and Analyze refused
         * with a note too quiet to notice.
         */
        if (bridge() && bridge().addWorkspace) bridge().addWorkspace(j.workspace);
        document.dispatchEvent(new CustomEvent("dominion-ide-workspace"));
        renderSlider(); renderSaveTo();
        paintAdoptChoices();
        $("#vb-adopt-ws").value = j.workspace.id;
        const st = adoptChosen(j.workspace.name); if (st) st.value = j.workspace.id;
        tree.hidden = true;
      } catch { adoptNote("The server could not be reached.", true); }
    };
    $("#vb-adopt-browse").addEventListener("click", () => {
      if (!tree.hidden) { tree.hidden = true; return; }
      browse("");
    });
  }

  async function runAdopt() {
    const wsId = $("#vb-adopt-ws").value;
    if (!wsId) { adoptNote("Pick the folder that holds your app, or browse to it.", true); return; }
    const go = $("#vb-adopt-go");
    go.disabled = true;
    adoptNote("Reading what is actually there…");
    window.ideFlame.show("Reading your app…");
    try {
      adoptNote("Reading what is actually there, then Claude Opus 4.8 does the deep read — this can take a minute…");
      const r = await fetch("/ide/adopt", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: wsId, mode: "vibe" }) });
      const j = await r.json();
      if (!r.ok || j.error || !j.ok) {
        adoptNote((j && j.error) || "The scan could not run.", true);
        return;
      }
      // The full opening = structural brief + the model's deep analysis (what it does, state,
      // dependencies, features, left-to-build, gaps, and the production roadmap). A failed
      // deep read degrades honestly: the brief lands with the stated reason, never silence.
      const opening = j.brief
        + (j.analysis ? "\n\n" + j.analysis : "")
        + (j.analysisError ? "\n\n(" + j.analysisError + ")" : "");
      state.adopt = { workspaceId: j.workspaceId, name: j.name || "", brief: opening };
      // The General defaults to the analyst that just read the app (Fred, 2026-07-26), so the
      // conversation continues with the model that holds the deepest grasp. Changeable — and a
      // switch keeps everything, because every turn resends the full thread.
      if (j.analysisModel) {
        state.chats.main.model = j.analysisModel;
        const sel = $("#vb-model-main");
        if (sel && [...sel.options].some((o) => o.value === j.analysisModel)) sel.value = j.analysisModel;
      }
      // The adopted folder becomes the working project everywhere the surface reads one.
      bridge() && bridge().selectWorkspace(j.workspaceId);
      const st = $("#vb-saveto"); if (st) st.value = j.workspaceId;
      renderSlider();
      // The brief opens the Main conversation as the Main AI's own words, which is exactly what
      // it is: the ground truth the planning starts from.
      state.chats.main.messages.push({ from: "main", content: opening });
      renderLog("main");
      toggleWin("main", true);
      closeAdopt();
      bridge() && bridge().journey("clarify");
      saveDraft();
      status("Adopted " + (j.name || "your app") + ". The General has the honest state of it; tell it what this should become.");
      const input = $("#vb-in-main"); if (input) input.focus();
    } catch {
      adoptNote("The workshop could not be reached. Try again.", true);
    } finally { go.disabled = false; window.ideFlame.hide(); }
  }

  /* ================= 4. Plan with AI ========================================================= */

  function bubble(w, cls, content, pics) {
    const log = $("#vb-log-" + w);
    if (!log) return null;
    const b = document.createElement("div");
    b.className = "vpb " + cls;
    const text = typeof content === "string" ? content
      : (content.find((p) => p.type === "text") || { text: "" }).text;
    if (text) { const p = document.createElement("p"); p.textContent = text; b.append(p); }
    for (const src of pics || []) {
      const img = document.createElement("img"); img.className = "vpb-pic"; img.src = src; img.alt = "picture"; b.append(img);
    }
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  // Rebuild one window's log from its message list. The class encodes WHO a turn came from, which
  // is what makes the colour rule work: a turn from another window wears that window's colour.
  // Every bubble that IS a message carries its index (data-mi), which is what lets the silent
  // tick boxes map a checkbox back to the exact message it stands for.
  function renderLog(w) {
    const log = $("#vb-log-" + w);
    if (!log) return;
    log.textContent = "";
    for (const [i, m] of state.chats[w].messages.entries()) {
      const cls = m.from === "user" ? "vpb-user"
        : m.from === w ? "vpb-ai"
        : "vpb-from vpb-from-" + m.from;
      const b = bubble(w, cls, m.content);
      if (b) b.dataset.mi = String(i);
      if (b && m.from !== "user" && m.from !== w) {
        const tag = document.createElement("small");
        tag.className = "vpb-tag";
        tag.textContent = WNAME[m.from] + " · opinion";
        b.prepend(tag);
      }
    }
    if (w === "main" && state.vision) visionCard();
  }

  /* ---------- silent message selection (Fred, 2026-07-26) -----------------------------------
   * Opening the Send destinations quietly puts a tick box on every message in that window, with
   * the last exchange (the user's message and the AI's reply) already ticked. Crossing to
   * another rank sends exactly the ticked messages. Nothing on screen explains this (clutter);
   * the user guide carries it. Send-here and Enter ignore the ticks entirely, so talking to one
   * rank alone, indefinitely, stays the unforced default.
   */
  function enterSelect(w) {
    const log = $("#vb-log-" + w);
    if (!log) return;
    const n = state.chats[w].messages.length;
    for (const b of log.querySelectorAll(".vpb[data-mi]")) {
      if (b.querySelector(".vpb-pick")) continue;
      const lab = document.createElement("label");
      lab.className = "vpb-pick";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = Number(b.dataset.mi) >= n - 2;   // the last exchange rides by default
      lab.append(box);
      b.append(lab);
    }
    log.classList.add("vb-selecting");
  }
  function exitSelect(w) {
    const log = $("#vb-log-" + w);
    if (!log) return;
    log.classList.remove("vb-selecting");
    for (const p of log.querySelectorAll(".vpb-pick")) p.remove();
  }
  function pickedIndexes(w) {
    const log = $("#vb-log-" + w);
    if (!log) return [];
    return [...log.querySelectorAll(".vpb[data-mi] .vpb-pick input:checked")]
      .map((box) => Number(box.closest(".vpb").dataset.mi))
      .sort((a, b) => a - b);
  }

  function visionCard() {
    const log = $("#vb-log-main");
    if (!log || log.querySelector(".vpb-vision")) return;
    const card = document.createElement("div");
    card.className = "vpb vpb-vision";
    card.innerHTML = "<h4>Here is what gets built</h4><div></div>";
    card.querySelector("div").textContent = state.vision;
    log.append(card);
    log.scrollTop = log.scrollHeight;
  }

  function thinking(w) {
    const b = bubble(w, "vpb-ai vpb-thinking", "");
    if (b) b.innerHTML = "<i></i><i></i><i></i>";
    return b || { remove() {} };
  }

  async function askWindow(w) {
    const c = state.chats[w];
    if (c.busy) return;
    c.busy = true;
    const t = thinking(w);
    let j = null;
    try {
      const r = await fetch("/ide/planchat", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ window: w, model: c.model || "", messages: c.messages, register: reg(), mode: "vibe", device: device(),
          adopt: !!state.adopt, adoptionContext: state.adopt ? state.adopt.brief : "",
          adoptionWorkspaceId: state.adopt ? state.adopt.workspaceId : "" }) });
      j = await r.json();
    } catch { j = { error: "The workshop could not be reached. Try again." }; }
    t.remove();
    c.busy = false;
    if (!j || j.error) { bubble(w, "vpb-ai vpb-err", (j && j.error) || "Something went wrong."); return; }
    c.messages.push({ from: w, content: (j.reply || "") + (j.vision ? "\nVISION READY\n" + j.vision : "") });
    if (j.reply) { const b = bubble(w, "vpb-ai", j.reply); if (b) b.dataset.mi = String(c.messages.length - 1); }
    if (w === "main" && j.vision) {
      state.vision = j.vision;
      visionCard();
      bridge() && bridge().journey("ready");
    }
    saveDraft();
  }

  /*
   * The Send stack (Fred: "when you click send, there is an additional two buttons that extend
   * down from it; the selection determines where the message goes").
   *
   * First press reveals the destinations extending downward: this window, and the other two by
   * name (written out, not M/T/M/S). Choosing THIS window sends the typed text as the user's own
   * turn — a command. Choosing ANOTHER window routes it across: it lands there tagged as coming
   * from this window, wearing this window's colour, framed by the server as an opinion — because
   * Fred's rule is that nothing crossing windows ever commands. If the composer is empty, the
   * cross-window buttons forward this window's LAST AI REPLY instead, which is the independent-
   * audit move the drawing's arrows described.
   */
  function wireSend(w) {
    const input = $("#vb-in-" + w);
    const send = $("#vb-send-" + w);
    const menu = $("#vb-sendto-" + w);

    const closeMenu = () => { menu.hidden = true; menu.textContent = ""; exitSelect(w); };

    // What a forwarded message reads as: its speaker's rank, then its words. Pictures collapse to
    // their text the same way drafts do; pixels never cross windows.
    const textOf = (c) => (typeof c === "string" ? c : ((c.find((p) => p.type === "text") || {}).text || "(picture)"));
    const speaker = (from) => (from === "user" ? "User" : WNAME[from] || from);

    const deliver = (target) => {
      const text = (input.value || "").trim();
      if (target === w) {
        // Send here: the ordinary conversation with THIS rank alone. Ticks are ignored and
        // cleared; pressing Send twice (or Enter) never crosses a window. Not required to ever
        // pick a destination: this path is the whole conversation for as long as the user wants.
        closeMenu();
        if (!text || state.chats[w].busy) return;
        input.value = ""; input.style.height = "";
        state.chats[w].messages.push({ from: "user", content: text });
        const b = bubble(w, "vpb-user", text);
        if (b) b.dataset.mi = String(state.chats[w].messages.length - 1);
        saveDraft();
        askWindow(w);
        return;
      }
      /*
       * Crossing ranks: exactly the TICKED messages travel (default: the last exchange), joined
       * as a labelled transcript in one forwarded turn, which the server stamps as opinion. Text
       * in the composer rides separately AS THE USER, never inside the forwarded block, so the
       * user's own words can never be mistaken for an AI's opinion.
       */
      const picks = pickedIndexes(w);
      closeMenu();
      const msgs = state.chats[w].messages;
      let joined = picks.map((i) => msgs[i] ? "[" + speaker(msgs[i].from) + "] " + textOf(msgs[i].content) : "").filter(Boolean).join("\n\n");
      if (joined.length > 3800) joined = "(earlier ticked messages trimmed)\n\n" + joined.slice(-3800);
      if (!joined && !text) { status("Nothing selected to send to " + WNAME[target] + "."); return; }
      input.value = ""; input.style.height = "";
      if (joined) state.chats[target].messages.push({ from: w, content: joined });
      if (text) state.chats[target].messages.push({ from: "user", content: text });
      if (!state.chats[target].open) toggleWin(target, true);
      renderLog(target);
      saveDraft();
      askWindow(target);
    };

    send.addEventListener("click", () => {
      if (!menu.hidden) { deliver(w); return; }   // second press = send here, ranks stay separate
      menu.textContent = "";
      const here = document.createElement("button");
      here.type = "button";
      here.textContent = "Send here";
      here.addEventListener("click", () => deliver(w));
      menu.append(here);
      for (const other of WINDOWS.filter((x) => x !== w)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "vb-sendto-" + other;
        b.textContent = "To " + WNAME[other];
        b.addEventListener("click", () => deliver(other));
        menu.append(b);
      }
      // Discoverability (Fred, 2026-07-26: "no obvious way to send chat between AIs"): the menu
      // now says out loud what the tick boxes are for, instead of appearing silently.
      const hint = document.createElement("div");
      hint.className = "vb-dest-hint";
      hint.textContent = "Tick any messages above to include them, then pick where this goes. Ticked messages travel as a labelled transcript.";
      menu.append(hint);
      menu.hidden = false;
      enterSelect(w);
      // Anywhere else closes the stack; capture so a tap on another window's send does not stack
      // two. Taps on the tick boxes themselves must NOT close it, or nothing could be ticked.
      setTimeout(() => {
        const away = (e) => {
          if (menu.contains(e.target) || e.target === send || e.target.closest(".vpb-pick")) return;
          closeMenu();
          document.removeEventListener("pointerdown", away, true);
        };
        document.addEventListener("pointerdown", away, true);
      }, 0);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); deliver(w); }
    });
    input.addEventListener("input", () => { input.style.height = ""; input.style.height = Math.min(120, input.scrollHeight) + "px"; });
  }

  // Fred: "drag them down to open up the chat window taller and the rest of the page just extends
  // below it." A full-width grab bar under each log; the drag writes the log's height directly.
  function wireGrab(bar) {
    const w = bar.dataset.win;
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      const log = $("#vb-log-" + w);
      drag = { y: e.clientY, h: log.getBoundingClientRect().height };
      bar.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const log = $("#vb-log-" + w);
      log.style.height = Math.max(140, Math.min(window.innerHeight * 0.8, drag.h + (e.clientY - drag.y))) + "px";
    });
    const up = () => { drag = null; };
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  }

  function toggleWin(w, force) {
    const c = state.chats[w];
    c.open = force != null ? force : !c.open;
    const body = $("#vb-body-" + w);
    const btn = document.querySelector('.vb-win-toggle[data-win="' + w + '"]');
    if (body) body.hidden = !c.open;
    if (btn) { btn.textContent = c.open ? "Close" : "Open chat"; btn.setAttribute("aria-expanded", String(c.open)); }
    saveDraft();
  }

  /* ================= 5. Agent Army =========================================================== */

  function orchNote(text, isFallback) {
    const n = $("#vb-orch-note");
    if (!n) return;
    n.textContent = text || "Plans and divides the whole build. This one seat is limited to the bigger models.";
    n.classList.toggle("is-fallback", !!isFallback);
  }

  function goalText() {
    const first = state.chats.main.messages.find((m) => m.from === "user");
    return first ? (typeof first.content === "string" ? first.content : "") : "";
  }

  async function planArmy() {
    if (state.armyBusy) return;
    const goal = goalText();
    if (!goal) { status("Tell the General what you want built first.", true); return; }
    state.armyBusy = true;
    const btn = $("#vb-plan-tasks");
    btn.disabled = true; btn.textContent = "Planning…";
    orchNote("");
    try {
      const orchestrator = $("#vb-orch-model").value || "";
      const r = await fetch("/ide/tasks", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: goal + (state.vision ? "\n\nAGREED VISION:\n" + state.vision : ""), model: orchestrator, mode: "vibe", register: reg() }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { status(j.error || j.reason || "The plan could not be made.", true); return; }
      /*
       * The fallback notice (SOW 5.1): the server says WHICH model actually sat in the seat. The
       * row keeps saying it until the next plan, because a notice that vanishes was never read.
       */
      if (j.fallback) {
        orchNote("Changed for this plan: " + j.fallback.fromName + " could not do it (" + j.fallback.reason + "), so " + j.fallback.toName + " stepped in.", true);
        $("#vb-orch-model").value = "";   // the pick did not hold; do not display it as if it did
      }
      state.army = { tasks: j.tasks, picks: j.tasks.map(() => ({ model: "", agents: 1, reduce: null })), orchestrator: j.fallback ? "" : ($("#vb-orch-model").value || "") };
      renderArmy();
      persistArmy();
    } catch { status("The plan could not be made.", true); }
    finally { state.armyBusy = false; btn.disabled = false; btn.textContent = "Plan the tasks"; }
  }

  function renderArmy() {
    const grid = $("#vb-army-grid");
    if (!grid || !state.army) return;
    [...grid.querySelectorAll(".vb-army-cell")].forEach((n) => n.remove());
    grid.hidden = false;
    state.army.tasks.forEach((task, i) => {
      const p = state.army.picks[i];
      const cell = (cls, node) => {
        const d = document.createElement("div");
        d.className = "vb-army-cell " + cls;
        if (node) d.append(node);
        grid.append(d);
        return d;
      };
      const title = cell("vb-c-task");
      title.innerHTML = "<b></b><small></small><span class='vb-reduce' id='vb-reduce-" + i + "' hidden></span>";
      title.querySelector("b").textContent = task.n + ". " + task.title;
      title.querySelector("small").textContent = (task.files || []).join(", ") + (task.needs && task.needs.length ? " · after " + task.needs.join(", ") : "");

      const sel = document.createElement("select");
      sel.id = "vb-tmodel-" + i;
      fillModels(sel, p.model || "");
      sel.addEventListener("change", () => { p.model = sel.value; refreshEstimates(); persistArmy(); });
      cell("vb-c-model", sel);

      const stepper = document.createElement("div");
      stepper.className = "vb-agents";
      const minus = document.createElement("button"); minus.type = "button"; minus.textContent = "-";
      const count = document.createElement("span"); count.textContent = p.agents;
      const plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+";
      const setAgents = (v) => {
        p.agents = Math.max(1, Math.min(6, v));
        count.textContent = p.agents;
        // The irreducible rule (SOW 5.3): more than one agent must survive the split check, or the
        // row is forced back to one and told why. Same server verdict Full Custom uses.
        if (p.agents > 1) checkReduce(i, count); else { p.reduce = null; paintReduce(i); }
        refreshEstimates(); persistArmy();
      };
      minus.addEventListener("click", () => setAgents(p.agents - 1));
      plus.addEventListener("click", () => setAgents(p.agents + 1));
      stepper.append(minus, count, plus);
      cell("vb-c-agents", stepper);

      const cost = cell("vb-c-cost"); cost.id = "vb-cost-" + i; cost.textContent = "…";
      const time = cell("vb-c-time"); time.id = "vb-time-" + i; time.textContent = "…";
    });
    refreshEstimates();
  }

  function paintReduce(i) {
    const el = $("#vb-reduce-" + i);
    if (!el) return;
    const p = state.army.picks[i];
    if (!p.reduce) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = p.reduce.note || "";
    el.className = "vb-reduce vb-reduce-" + (p.reduce.mode === "irreducible" ? "irr" : "ok");
  }

  async function checkReduce(i, countEl) {
    const task = state.army.tasks[i], p = state.army.picks[i];
    p.reduce = { mode: "checking", note: "Checking whether this task splits…" };
    paintReduce(i);
    try {
      const r = await fetch("/ide/reduce", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, agents: p.agents, model: p.model, mode: "vibe", register: reg() }) });
      const j = await r.json();
      if (!r.ok) { p.reduce = null; }
      else {
        p.reduce = { mode: j.mode, note: j.note || "" };
        if (j.mode === "irreducible") p.agents = 1;
        else if (j.usableAgents && j.usableAgents < p.agents) p.agents = j.usableAgents;
        if (countEl) countEl.textContent = p.agents;
      }
    } catch { p.reduce = null; }
    paintReduce(i);
    refreshEstimates();
    persistArmy();
  }

  /*
   * Live estimates (Fred: "it needs to live update when all the values are entered"). Cost and
   * time per task, from the model's real rates and observed throughput (/ide/estimate leans on
   * idetelemetry), debounced so a stepper spree costs one request, not six. The numbers stay
   * labelled as estimates: honest approximation, never a promise.
   */
  let estTimer = 0;
  function refreshEstimates() {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      if (!state.army) return;
      const parts = state.army.tasks.map((t) => ({ title: t.title, files: t.files, contract: (t.needs || []).join(",") }));
      const picks = state.army.picks.map((p) => ({ model: p.model, agents: p.agents }));
      try {
        const r = await fetch("/ide/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts, picks }) });
        const j = await r.json();
        if (!r.ok) return;
        (j.per || []).forEach((e, i) => {
          const cost = $("#vb-cost-" + i), time = $("#vb-time-" + i);
          if (cost) cost.textContent = "~$" + e.usd.toFixed(2) + (e.basis === "prior" ? "*" : "");
          if (time) time.textContent = e.seconds >= 90 ? "~" + Math.round(e.seconds / 60) + " min" : "~" + e.seconds + "s";
        });
        const total = $("#vb-army-total");
        if (total && j.plan) {
          total.hidden = false;
          const tmin = j.plan.seconds >= 90 ? Math.round(j.plan.seconds / 60) + " min" : j.plan.seconds + "s";
          total.textContent = "Whole plan: ~" + tmin + " · ~" + Math.round(j.plan.tokens / 1000) + "k tokens · ~$" + j.plan.usd.toFixed(2) + "  (estimates; * = little data yet)";
        }
      } catch {}
    }, 280);
  }

  // Same wire contract Full Custom writes (taskMode/taskPlan/groups), plus the orchestrator seat,
  // so the engine cannot tell which surface configured the crew.
  function persistArmy() {
    if (!bridge() || !state.army) return;
    const groups = state.army.tasks.map((t, i) => ({ id: "t" + t.n, taskNumbers: [t.n], model: state.army.picks[i].model, agents: state.army.picks[i].agents }));
    bridge().saveAF({
      on: true, rows: [], taskMode: true,
      taskPlan: state.army.tasks.map((t) => ({ n: t.n, title: t.title, files: t.files, needs: t.needs })),
      groups,
      orchestrator: state.army.orchestrator || "",
    });
  }

  /* ================= 6. Begin Building ======================================================= */

  function status(text, bad) {
    const el = $("#vb-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-bad", !!bad);
  }

  async function beginBuilding() {
    const b = bridge();
    if (!b) return;
    // An adopted brief describes ONE folder. If Save to: points somewhere else, the brief stands
    // down for this build rather than describing a folder the build will not touch.
    const saveTo = $("#vb-saveto").value;
    const adopted = state.adopt && (!saveTo || saveTo === state.adopt.workspaceId) ? state.adopt : null;
    const goal = goalText() || (adopted ? "Finish this app as agreed, from the state of the app below." : "");
    if (!goal) { status("Tell the General what you want built first.", true); return; }
    // The Save to: pick is the folder; an adoption binds to its own folder; none picked means one
    // is made, same as the beginner path.
    if (saveTo) b.selectWorkspace(saveTo);
    else if (adopted) { b.selectWorkspace(adopted.workspaceId); renderSaveTo(); }
    if (!b.workspaceId()) {
      const made = await b.autoWorkspace(goal);
      if (!made.ok) {
        status(made.offline
          ? "Your computer is not connected, so there is nowhere to build. Open app.dominion.tools on the build machine, then press this again."
          : (made.error || "No folder could be made. Try again."), true);
        return;
      }
      renderSlider(); renderSaveTo();
    }
    let full = state.vision ? goal + "\n\nAGREED VISION (approved by the user; build exactly this):\n" + state.vision : goal;
    if (adopted) {
      // Brief LAST: the job door caps prompts, and a truncated tail must only ever cost brief
      // detail, never the agreed vision (see ide.mjs startJob).
      full = "ADOPTED PROJECT: the workspace folder already holds this app. Work against what exists; " +
        "[finish]/[fix]/[new] tags in the vision mark work on the existing code.\n\n" + full +
        "\n\nSTATE OF THE APP (scanned before planning):\n" + adopted.brief;
    }
    status("Starting…");
    b.startBuild(full, (msg, bad) => status(msg || "", bad));
  }

  /* ================= wiring ================================================================== */

  function wire() {
    wireSliderDrag($("#vb-slider"));
    $("#vb-new").addEventListener("click", newProject);
    $("#vb-adopt").addEventListener("click", openAdopt);
    $("#vb-adopt-close").addEventListener("click", closeAdopt);
    $("#vb-adopt-go").addEventListener("click", runAdopt);
    wireAdoptBrowse();
    $("#vb-startover").addEventListener("click", startOver);
    $("#vb-saveto").addEventListener("change", (e) => { bridge() && bridge().selectWorkspace(e.target.value); renderSlider(); });
    for (const b of document.querySelectorAll("#vb-presets button")) {
      b.addEventListener("click", () => {
        pendingModules = (bridge() ? bridge().studioPresets()[b.dataset.preset] : null) || [];
        renderStudio();
      });
    }
    $("#vb-apply").addEventListener("click", applyStudio);
    for (const w of WINDOWS) {
      wireSend(w);
      const sel = $("#vb-model-" + w);
      sel.addEventListener("change", () => { state.chats[w].model = sel.value; saveDraft(); });
    }
    for (const t of document.querySelectorAll(".vb-win-toggle")) t.addEventListener("click", () => toggleWin(t.dataset.win));
    // Fresh start (Fred, 2026-07-26): wipe an advisor window mid-planning for an unbiased opinion.
    for (const f of document.querySelectorAll(".vb-win-fresh")) f.addEventListener("click", () => {
      const w = f.dataset.win;
      if (!state.chats[w] || !state.chats[w].messages.length) { status(WNAME[w] + " is already a blank slate."); return; }
      state.chats[w].messages = [];
      renderLog(w);
      saveDraft();
      status(WNAME[w] + " has a clean slate — ask for a fresh opinion.");
    });
    for (const g of document.querySelectorAll(".vb-grab")) wireGrab(g);
    $("#vb-orch-model").addEventListener("change", (e) => { if (state.army) { state.army.orchestrator = e.target.value; persistArmy(); } orchNote(""); });
    $("#vb-plan-tasks").addEventListener("click", planArmy);
    $("#vb-begin").addEventListener("click", beginBuilding);
  }

  /* ================= open and close ========================================================== */

  function open() {
    const el = build();
    if (!el) return;
    if (!state.open) loadDraft();
    state.open = true;
    el.hidden = false;
    renderSlider();
    renderSaveTo();
    renderStudio();
    paintAllModelSelects();
    gateArmy();
    for (const w of WINDOWS) { renderLog(w); toggleWin(w, state.chats[w].open); }
  }

  function close() {
    const el = $("#vb-shell");
    state.open = false;
    if (el) el.hidden = true;
  }

  // Workspaces and the catalog both load after the panel exists; repaint when they land.
  document.addEventListener("dominion-ide-state", () => { if (state.open) { renderSlider(); renderSaveTo(); paintAllModelSelects();
    if ($("#vb-adopt-panel") && !$("#vb-adopt-panel").hidden) paintAdoptChoices(); } });
  document.addEventListener("dominion-studio-changed", () => { if (state.open) { gateArmy(); paintDesignations(); } });

  window.dominionVibe = { open, close };
})();
