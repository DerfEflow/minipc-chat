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
  const MODE_KEY = "dominion.crucible.mode.v1";
  // When THIS device last chose its switch position or interface, so "the newer choice wins" can
  // be decided against the account's own timestamp instead of "has this device ever chosen".
  const CHOICE_AT_KEY = "dominion.crucible.choice-at.v1";
  const stampChoice = () => { try { localStorage.setItem(CHOICE_AT_KEY, String(Date.now())); } catch {} };
  // Mode sets the register silently (ruling 4a): the machinery underneath stays, one question
  // fewer at the door.
  const MODE_REG = { beginner: "plain", vibe: "hybrid", engineer: "technical" };
  const MODES = ["beginner", "vibe", "engineer"];
  const JOURNEY_PHASES = ["idea", "clarify", "ready", "build", "verify", "ship"];
  const JOURNEY_COPY = {
    idea: ["journey_idea_title", "journey_idea_note"],
    clarify: ["journey_clarify_title", "journey_clarify_note"],
    ready: ["journey_ready_title", "journey_ready_note"],
    build: ["journey_build_title", "journey_build_note"],
    verify: ["journey_verify_title", "journey_verify_note"],
    ship: ["journey_ship_title", "journey_ship_note"],
  };
  const STUDIO_KEY = "dominion.crucible.studio.v1";
  const STUDIO_MODULES = [
    { id: "workspace", title: "studio_workspace_title", note: "studio_workspace_note" },
    { id: "brief", title: "studio_brief_title", note: "studio_brief_note" },
    { id: "crew", title: "studio_crew_title", note: "studio_crew_note" },
    { id: "cost", title: "studio_cost_title", note: "studio_cost_note" },
    { id: "preview", title: "studio_preview_title", note: "studio_preview_note" },
    { id: "checks", title: "studio_checks_title", note: "studio_checks_note" },
    { id: "code", title: "studio_code_title", note: "studio_code_note" },
    { id: "history", title: "studio_history_title", note: "studio_history_note" },
  ];
  const STUDIO_PRESETS = {
    minimal: ["brief", "cost"],
    design: ["brief", "crew", "cost", "preview", "checks"],
    fullstack: STUDIO_MODULES.map((m) => m.id),
    ship: ["cost", "preview", "checks", "history"],
  };

  const state = {
    mode: "",             // "" = never chosen on this device or account: show the picker once
    phase: "idea",        // explicit journey state; never inferred from which DOM node is visible
    studio: { preset: "design", modules: new Set(STUDIO_PRESETS.design) },
    allowed: false, engaged: false, open: false,
    routing: null,        // class labels/blurbs/defaults, from the server
    catalog: [],          // the model list, from the SAME /api/models the chat picker uses
    assignments: {},      // class -> model id ("" means follow the main model)
    allInOne: "",         // one model for every text class, or "" for the board
    workspaceId: "",      // assignments belong to a workspace once one exists
    jobs: [],             // every job on this ACCOUNT, not just the one on screen
    workspaces: [],       // the account's workspace pointers, for the front door
    engineerComingSoon: false, // server launch gate: every Engineer choice stays inert for guests
    pushKey: "",          // VAPID applicationServerKey, "" when push is not configured
    askedPush: false,     // permission is requested at the first real build, never on load
  };

  const $ = (sel) => document.querySelector(sel);
  // Every user-facing string on this surface goes through the register dictionary.
  const L = (k) => (window.DominionLexicon ? window.DominionLexicon.L(k) : k);
  // Money wording for whoever is looking: credits for guests, dollars for the owner (Fred,
  // 2026-07-30). dominion-money.js holds the rule; this fallback keeps the old dollar text if that
  // file fails to load, because an estimate that throws is worse than one in the wrong unit.
  const money = () => window.DominionMoney || {
    cost: (u, o) => ((o && o.approx) ? "~" : "") + "$" + (Number(u) || 0).toFixed(2),
    rate: (i, o, opt) => (opt && opt.long) ? "$" + i + " in / $" + o + " out per million tokens" : "$" + i + "/$" + o,
    inCredits: () => false,
  };
  const readEngaged = () => {
    try { return localStorage.getItem(ENGAGED_KEY) === "1"; } catch { return false; }
  };
  const writeEngaged = (on) => {
    try { localStorage.setItem(ENGAGED_KEY, on ? "1" : "0"); } catch {}
  };
  const announceIdeState = () => {
    try { document.dispatchEvent(new CustomEvent("dominion-ide-state")); } catch {}
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

    /*
     * The way out says where it goes (Fred, 2026-07-24). It used to be a bare arrow beside the words
     * "Dominion Works", and people read the product name as the label of the button next to it, so
     * the one control that leaves this screen was the least obvious thing on it.
     */
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ide-rail-btn ide-rail-back";
    back.id = "ide-back";
    back.title = "Return to chat";
    back.setAttribute("aria-label", "Return to chat");
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>'
      + '<span class="ide-back-label">Return to chat</span>';

    // The title names the surface the CURRENT mode puts you in (paintRailTitle keeps it honest):
    // App Builder, App Launcher, or Full Stack Platform.
    const title = document.createElement("div");
    title.className = "ide-rail-title";
    title.innerHTML = '<span class="t" id="ide-rail-name"></span>';

    /*
     * THE STANDBY LAMP IS GONE (Fred, 2026-07-24: "no one knows what it does. Is it actually
     * useful?"). It showed idle/running/waiting for jobs, which three other places already say in
     * words a person can read: the rail button in the command bar carries the live count, the
     * journey strip names the phase, and the beginner progress screen shows the build itself. A
     * nondescript lamp that needs explaining is worse than the space it occupied.
     */
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ide-rail-btn";
    close.id = "ide-close";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    /*
     * The Welcome Screen promises "You can change it at any time", and until 2026-07-25 that was
     * only true for engineers: the mode switch lived inside the classic starter, which the
     * Beginner and Vibe surfaces hide entirely. This rail button keeps the promise on EVERY
     * surface by reopening the same Welcome Screen the choice was made on. Words, not an icon.
     */
    const level = document.createElement("button");
    level.type = "button";
    level.className = "ide-rail-level";
    level.id = "ide-level";
    level.title = "Change how you work: Beginner, Vibe Coder, or Engineer";
    level.textContent = "Change level";
    level.addEventListener("click", showModePicker);

    rail.append(back, title, level, close);

    const stage = document.createElement("div");
    stage.className = "ide-stage";
    stage.id = "ide-stage";
    const starter = buildStarter();
    stage.append(starter);
    // The board lives INSIDE the Models drawer now: for the engineer it is one labelled drawer
    // among drawers; for everyone else the drawer chrome is invisible and mode CSS decides.
    const slot = starter.querySelector("#dr-models-slot");
    (slot || stage).append(buildBoard());

    root.append(rail, stage);
    document.body.append(root);

    back.addEventListener("click", closePanel);
    close.addEventListener("click", closePanel);

    const afBtn = document.querySelector("#st-af");
    if (afBtn) { afBtn.title = L("af_title"); afBtn.addEventListener("click", openAFPanel); }

    renderBoard();
    renderStarter();
    wireStarter();
    wireStudio();
    paintJourney();
    wireProbe();
    paintEngineerLaunchGate(root);
    const all = $("#ide-allinone");
    if (all) all.addEventListener("change", () => {
      state.allInOne = all.value;
      // With one model driving everything, the per-class pickers stop being the operative control,
      // so they are disabled rather than left looking live while being ignored.
      for (const sel of document.querySelectorAll("#ide-cards select")) sel.disabled = !!state.allInOne;
      saveAssignments();
    });
  }

  /* ---------- AF: Agentic Workflow Window (Phase 3+) -----------------------------------
   * A crew pipeline: rows of Task / Model / Number. One model per row, divider writes contracts,
   * workers build in parallel, reviewer fixes, QC verifies.
   */
  const AF_DEFAULT = [
    { task: "Divide the work and write the contracts", model: "", n: 1 },
    { task: "Build the parts, one agent per part", model: "", n: 5 },
    { task: "Review and fix each finished part", model: "", n: 1 },
    { task: "Final quality check of the whole", model: "", n: 1 },
  ];

  function buildAFPanel() {
    if ($("#af-panel")) return;
    const panel = document.createElement("div");
    panel.className = "af-panel";
    panel.id = "af-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", L("af_title"));

    const backdrop = document.createElement("div");
    backdrop.className = "af-backdrop";
    backdrop.addEventListener("click", closeAFPanel);

    const card = document.createElement("div");
    card.className = "af-card";

    const head = document.createElement("div");
    head.className = "af-head";
    head.innerHTML = '<h3 data-lex="af_title"></h3>'
      + '<button type="button" class="af-close" aria-label="Close" title="Close">'
        + '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button>';
    head.querySelector(".af-close").addEventListener("click", closeAFPanel);

    const hint = document.createElement("p");
    hint.className = "af-hint";
    hint.setAttribute("data-lex", "af_hint");

    const grid = document.createElement("div");
    grid.className = "af-grid";
    grid.id = "af-grid";

    const colTask = document.createElement("div");
    colTask.className = "af-col-header";
    colTask.setAttribute("data-lex", "af_col_task");

    const colModel = document.createElement("div");
    colModel.className = "af-col-header";
    colModel.setAttribute("data-lex", "af_col_model");

    const colN = document.createElement("div");
    colN.className = "af-col-header";
    colN.setAttribute("data-lex", "af_col_n");

    const colAct = document.createElement("div");
    colAct.className = "af-col-header af-col-actions-header";

    grid.append(colTask, colModel, colN, colAct);

    // ---- Full Custom: divide the goal into SECTIONS, then own every one (Phase 2, Fred's spec).
    // A "Plan the sections" button asks the divider for the parts, then each part becomes a row
    // the user configures: any model, any agent count, with a live time/token estimate and a red
    // warning when a pick is inadequate (never a block). Vibe + engineer only; beginners never
    // see the AF window at all.
    const custom = document.createElement("div");
    custom.className = "af-custom";
    custom.id = "af-custom";
    custom.innerHTML =
      '<div class="af-custom-head">' +
        '<span data-lex="af_custom_title"></span>' +
        '<button type="button" id="af-divide" class="af-divide-btn" data-lex="af_plan_tasks"></button>' +
      '</div>' +
      '<p class="af-custom-hint" data-lex="af_tasks_hint"></p>' +
      '<div id="af-sections" class="af-sections"></div>' +
      '<div id="af-plan-total" class="af-plan-total" hidden></div>';
    custom.querySelector("#af-divide").addEventListener("click", planTasks);

    const footer = document.createElement("div");
    footer.className = "af-footer";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "af-add-row";
    addBtn.setAttribute("data-lex", "af_add");
    addBtn.addEventListener("click", () => addAFRow());

    const toggleRow = document.createElement("div");
    toggleRow.className = "af-toggle-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "af-on";
    checkbox.addEventListener("change", (e) => {
      if (!state.assignments.af) state.assignments.af = { on: false, rows: [] };
      state.assignments.af.on = e.target.checked;
      saveAssignments();
    });

    const label = document.createElement("label");
    label.htmlFor = "af-on";
    label.setAttribute("data-lex", "af_on");

    toggleRow.append(checkbox, label);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.setAttribute("data-lex", "af_reset");
    resetBtn.addEventListener("click", resetAFToDefault);

    footer.append(addBtn, toggleRow, resetBtn);

    card.append(head, hint, grid, footer, custom);
    panel.append(backdrop, card);
    const root = $("#ide-root");
    if (root) root.append(panel);

    paintLexicon();
    renderAFRows();
  }

  function openAFPanel() {
    buildAFPanel();
    const panel = $("#af-panel");
    if (panel) {
      panel.classList.add("af-open");
      const checkbox = $("#af-on");
      if (checkbox && state.assignments.af) {
        checkbox.checked = state.assignments.af.on;
      }
    }
  }

  function closeAFPanel() {
    const panel = $("#af-panel");
    if (panel) panel.classList.remove("af-open");
  }

  function renderAFRows() {
    const grid = $("#af-grid");
    if (!grid) return;
    const rows = grid.querySelectorAll(".af-row");
    rows.forEach((r) => r.remove());

    if (!state.assignments.af) {
      state.assignments.af = { on: false, rows: AF_DEFAULT.map((r) => ({ ...r })) };
    }
    const af = state.assignments.af;
    for (let i = 0; i < af.rows.length; i++) {
      const row = af.rows[i];
      const rowEl = document.createElement("div");
      rowEl.className = "af-row";

      const taskInput = document.createElement("input");
      taskInput.type = "text";
      taskInput.className = "af-task-input";
      taskInput.value = row.task || "";
      taskInput.addEventListener("change", () => {
        if (!state.assignments.af) state.assignments.af = { on: false, rows: [] };
        if (!state.assignments.af.rows[i]) state.assignments.af.rows[i] = { task: "", model: "", n: 1 };
        state.assignments.af.rows[i].task = taskInput.value;
        saveAssignments();
      });

      const modelSelect = document.createElement("select");
      modelSelect.className = "af-model-select";
      fillModelOptions(modelSelect, row.model || "", false);
      modelSelect.addEventListener("change", () => {
        if (!state.assignments.af) state.assignments.af = { on: false, rows: [] };
        if (!state.assignments.af.rows[i]) state.assignments.af.rows[i] = { task: "", model: "", n: 1 };
        state.assignments.af.rows[i].model = modelSelect.value;
        saveAssignments();
      });

      const nInput = document.createElement("input");
      nInput.type = "number";
      nInput.className = "af-n-input";
      nInput.min = "1";
      nInput.max = "25";
      nInput.value = row.n || 1;
      nInput.addEventListener("change", () => {
        if (!state.assignments.af) state.assignments.af = { on: false, rows: [] };
        if (!state.assignments.af.rows[i]) state.assignments.af.rows[i] = { task: "", model: "", n: 1 };
        const v = parseInt(nInput.value, 10);
        state.assignments.af.rows[i].n = isNaN(v) ? 1 : Math.max(1, Math.min(25, v));
        nInput.value = state.assignments.af.rows[i].n;
        saveAssignments();
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "af-remove-row";
      removeBtn.title = "Remove row";
      removeBtn.setAttribute("aria-label", "Remove row");
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      removeBtn.addEventListener("click", () => removeAFRow(i));

      rowEl.append(taskInput, modelSelect, nInput, removeBtn);
      const grid = $("#af-grid");
      if (grid) grid.append(rowEl);
    }
    updateAFButtonState();
  }

  /*
   * The Task Board (Fred's redesign). "Plan the tasks" asks the orchestrator for a numbered task
   * roadmap; each task is a row the user owns with a model, an agent count, and an optional group
   * tag (tasks sharing a tag share a model + agents). Bumping a task above one agent asks the
   * server whether the task can be split (the reduce check) and shows the honest verdict. Live
   * estimates ride each task and roll up. The confirmed tasks + groups drive the build.
   */
  let afTasks = null;   // { tasks: [{n,title,files,needs}], picks: [{model, agents, group, reduce}] }

  async function planTasks() {
    const goal = (intake.messages[0] && intake.messages[0].content) || ($("#st-prompt") && $("#st-prompt").value.trim()) || "";
    const btn = $("#af-divide"), box = $("#af-sections");
    if (!goal) { if (box) box.innerHTML = '<p class="af-section-empty">' + L("af_need_brief") + "</p>"; return; }
    if (btn) { btn.disabled = true; btn.textContent = L("af_planning"); }
    window.ideFlame.show(L("af_planning"));
    try {
      const r = await fetch("/ide/tasks", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: goal, mode: state.mode, register: window.DominionLexicon ? window.DominionLexicon.register : "plain" }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { if (box) box.innerHTML = '<p class="af-section-empty">' + (j.error || j.reason || L("af_plan_failed")) + "</p>"; return; }
      afTasks = { tasks: j.tasks, picks: j.tasks.map(() => ({ model: "", agents: 1, group: "", reduce: null })) };
      renderTasks();
    } catch (e) {
      if (box) box.innerHTML = '<p class="af-section-empty">' + L("af_plan_failed") + "</p>";
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = L("af_plan_tasks"); }
      window.ideFlame.hide();
    }
  }

  // Tasks sharing a non-empty group tag mirror the FIRST such task's model + agents.
  function syncGroups() {
    const leader = new Map();
    afTasks.picks.forEach((p) => { const g = (p.group || "").trim(); if (g && !leader.has(g)) leader.set(g, p); });
    afTasks.picks.forEach((p) => { const g = (p.group || "").trim(); if (g && leader.get(g) !== p) { p.model = leader.get(g).model; p.agents = leader.get(g).agents; } });
  }

  function renderTasks() {
    const box = $("#af-sections");
    if (!box || !afTasks) return;
    box.innerHTML = "";
    afTasks.tasks.forEach((task, i) => {
      const p = afTasks.picks[i];
      const row = document.createElement("div");
      row.className = "af-section af-task";
      const title = document.createElement("div");
      title.className = "af-section-title";
      title.textContent = task.n + ". " + task.title;
      const files = document.createElement("div");
      files.className = "af-section-files";
      files.textContent = (task.files || []).join(", ") + (task.needs && task.needs.length ? "  ·  after " + task.needs.join(", ") : "");

      const controls = document.createElement("div");
      controls.className = "af-section-controls";
      const sel = document.createElement("select");
      sel.className = "af-model-select";
      fillModelOptions(sel, p.model || "", false);
      sel.addEventListener("change", () => { p.model = sel.value; syncGroups(); renderTasksSoft(); refreshTaskEstimates(); persistTasks(); });

      const stepper = document.createElement("div");
      stepper.className = "af-agents";
      const minus = document.createElement("button"); minus.type = "button"; minus.textContent = "-";
      const count = document.createElement("span"); count.className = "af-agent-count"; count.textContent = p.agents;
      const plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+";
      const setAgents = (v) => {
        p.agents = Math.max(1, Math.min(6, v)); count.textContent = p.agents;
        if (p.agents > 1) checkReduce(i); else { p.reduce = null; renderTasksSoft(); }
        syncGroups(); refreshTaskEstimates(); persistTasks();
      };
      minus.addEventListener("click", () => setAgents(p.agents - 1));
      plus.addEventListener("click", () => setAgents(p.agents + 1));
      const agentsLabel = document.createElement("span"); agentsLabel.className = "af-agents-label"; agentsLabel.setAttribute("data-lex", "af_agents");
      stepper.append(minus, count, plus, agentsLabel);

      const group = document.createElement("input");
      group.type = "text"; group.className = "af-group-input"; group.value = p.group || "";
      group.setAttribute("data-lex-ph", "af_group_ph");
      group.placeholder = L("af_group_ph");
      group.addEventListener("change", () => { p.group = group.value.trim(); syncGroups(); renderTasksSoft(); refreshTaskEstimates(); persistTasks(); });

      controls.append(sel, stepper, group);

      const est = document.createElement("div"); est.className = "af-section-est"; est.id = "af-est-" + i; est.textContent = L("af_est_pending");
      const warn = document.createElement("div"); warn.className = "af-section-warn"; warn.id = "af-warn-" + i; warn.hidden = true;
      const red = document.createElement("div"); red.className = "af-reduce"; red.id = "af-reduce-" + i; red.hidden = !p.reduce;
      if (p.reduce) { red.textContent = p.reduce.note || ""; red.className = "af-reduce af-reduce-" + (p.reduce.mode === "irreducible" ? "irr" : "ok"); }

      row.append(title, files, controls, est, warn, red);
      box.append(row);
    });
    paintLexicon();
    refreshTaskEstimates();
  }

  // A light repaint of just the model selects + agent counts + group inputs, without rebuilding
  // the DOM (so a group-sync does not steal focus mid-edit).
  function renderTasksSoft() {
    const box = $("#af-sections");
    if (!box || !afTasks) return;
    [...box.querySelectorAll(".af-task")].forEach((row, i) => {
      const p = afTasks.picks[i]; if (!p) return;
      const sel = row.querySelector(".af-model-select"); if (sel && sel.value !== (p.model || "")) sel.value = p.model || "";
      const cnt = row.querySelector(".af-agent-count"); if (cnt) cnt.textContent = p.agents;
      const red = row.querySelector(".af-reduce");
      if (red) { if (p.reduce) { red.hidden = false; red.textContent = p.reduce.note || ""; red.className = "af-reduce af-reduce-" + (p.reduce.mode === "irreducible" ? "irr" : "ok"); } else red.hidden = true; }
    });
  }

  async function checkReduce(i) {
    const task = afTasks.tasks[i], p = afTasks.picks[i];
    p.reduce = { mode: "checking", note: L("af_reduce_checking") };
    renderTasksSoft();
    try {
      const r = await fetch("/ide/reduce", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, agents: p.agents, model: p.model, mode: state.mode, register: window.DominionLexicon ? window.DominionLexicon.register : "plain" }) });
      const j = await r.json();
      if (!r.ok) { p.reduce = null; }
      else {
        p.reduce = { mode: j.mode, note: j.note || "" };
        if (j.mode === "irreducible") { p.agents = 1; }        // forced single agent
        else if (j.usableAgents && j.usableAgents < p.agents) { p.agents = j.usableAgents; }
      }
    } catch { p.reduce = null; }
    renderTasksSoft();
    persistTasks();
  }

  let estimateTimer = 0;
  function refreshTaskEstimates() {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(async () => {
      if (!afTasks) return;
      // The estimate endpoint speaks "parts"; a task IS a part for sizing (files + a short label).
      const parts = afTasks.tasks.map((t) => ({ title: t.title, files: t.files, contract: (t.needs || []).join(",") }));
      const picks = afTasks.picks.map((p) => ({ model: p.model, agents: p.agents }));
      try {
        const r = await fetch("/ide/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts, picks }) });
        const j = await r.json();
        if (!r.ok) return;
        (j.per || []).forEach((e, i) => {
          const est = $("#af-est-" + i), warn = $("#af-warn-" + i);
          if (est) {
            const mins = e.seconds >= 90 ? Math.round(e.seconds / 60) + " min" : e.seconds + "s";
            const basis = e.basis === "prior" ? " " + L("af_est_prior") : "";
            est.textContent = "~" + mins + " · ~" + Math.round(e.tokens / 1000) + "k tokens · " + money().cost(e.usd, { approx: true }) + basis;
          }
          if (warn) { if (e.warning) { warn.hidden = false; warn.textContent = e.warning.text; warn.className = "af-section-warn af-warn-" + e.warning.level; } else warn.hidden = true; }
        });
        const total = $("#af-plan-total");
        if (total && j.plan) {
          total.hidden = false;
          const tmin = j.plan.seconds >= 90 ? Math.round(j.plan.seconds / 60) + " min" : j.plan.seconds + "s";
          total.textContent = L("af_plan_total") + " ~" + tmin + " · ~" + Math.round(j.plan.tokens / 1000) + "k tokens · " + money().cost(j.plan.usd, { approx: true });
        }
      } catch {}
    }, 280);
  }

  // The build payload: the confirmed task roadmap + the groups the user formed. taskMode flips the
  // engine to the task-graph runner. Ungrouped tasks become singleton groups server-side.
  function persistTasks() {
    if (!state.assignments.af) state.assignments.af = { on: false, rows: [] };
    if (!afTasks) { delete state.assignments.af.taskMode; delete state.assignments.af.taskPlan; delete state.assignments.af.groups; saveAssignments(); return; }
    state.assignments.af.taskMode = true;
    state.assignments.af.taskPlan = afTasks.tasks.map((t) => ({ n: t.n, title: t.title, files: t.files, needs: t.needs }));
    const groups = [];
    const byTag = new Map();
    afTasks.tasks.forEach((t, i) => {
      const p = afTasks.picks[i];
      const tag = (p.group || "").trim();
      if (tag) {
        if (!byTag.has(tag)) { byTag.set(tag, { id: tag, taskNumbers: [], model: p.model, agents: p.agents }); groups.push(byTag.get(tag)); }
        byTag.get(tag).taskNumbers.push(t.n);
      } else {
        groups.push({ id: "t" + t.n, taskNumbers: [t.n], model: p.model, agents: p.agents });
      }
    });
    state.assignments.af.groups = groups;
    saveAssignments();
  }

  function addAFRow() {
    if (!state.assignments.af) state.assignments.af = { on: false, rows: [] };
    if (state.assignments.af.rows.length >= 8) return;
    state.assignments.af.rows.push({ task: "", model: "", n: 1 });
    renderAFRows();
    updateAFButtonState();
    saveAssignments();
  }

  function updateAFButtonState() {
    const addBtn = document.querySelector(".af-add-row");
    if (addBtn && state.assignments.af) {
      addBtn.disabled = state.assignments.af.rows.length >= 8;
    }
  }

  function removeAFRow(idx) {
    if (!state.assignments.af) return;
    state.assignments.af.rows.splice(idx, 1);
    renderAFRows();
    updateAFButtonState();
    saveAssignments();
  }

  function resetAFToDefault() {
    state.assignments.af = { on: false, rows: AF_DEFAULT.map((r) => ({ ...r })) };
    renderAFRows();
    const checkbox = $("#af-on");
    if (checkbox) checkbox.checked = false;
    saveAssignments();
  }

  /* ---------- Assignment Board (Phase 3) ------------------------------------------------
   * You set the model per KIND of work, once. The router then decides which kind each move is,
   * so nobody picks a model per message ever again. Design defaults to OpenAI; grunt work to
   * something cheap; engineering to whatever you chose.
   */
  const CARD_ORDER = ["design_visual", "design_code", "build_code", "mechanical", "review"];

  function buildBoard() {
    const board = document.createElement("div");
    board.className = "ide-board";
    board.id = "ide-board";

    const head = document.createElement("div");
    head.className = "ide-board-head";
    head.innerHTML = '<h2>Assignment Board</h2>'
      + '<p>Set these once. Every job is sorted into one of these kinds automatically, and goes '
      + 'where you said. You never pick a model per message.</p>';

    const allInOne = document.createElement("div");
    allInOne.className = "ide-allinone";
    allInOne.innerHTML = '<span class="lbl">One model for everything</span>'
      + '<select id="ide-allinone" aria-label="Use one model for every kind of work">'
      + '<option value="">Off: use the board below</option></select>'
      + '<span class="hint">Pictures still come from Dominion Forge.</span>';

    const presets = document.createElement("div");
    presets.className = "ide-presets";
    presets.id = "ide-presets";

    const cards = document.createElement("div");
    cards.className = "ide-cards";
    cards.id = "ide-cards";

    const probe = document.createElement("div");
    probe.className = "ide-probe";
    probe.innerHTML = '<input id="ide-probe-input" type="text" autocomplete="off" '
      + 'placeholder="Try it: describe a job, for example &quot;restyle the hero section&quot;" />'
      + '<div class="ide-verdict" id="ide-verdict"></div>';

    board.append(head, presets, allInOne, cards, probe);
    return board;
  }

  // One-click starting points. The board underneath stays fully manual; a preset just fills it in.
  function renderPresets() {
    const host = $("#ide-presets");
    if (!host || !state.routing) return;
    host.textContent = "";
    for (const preset of (state.routing.presets || [])) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ide-preset";
      b.innerHTML = '<span class="p-label"></span><span class="p-blurb"></span>';
      b.querySelector(".p-label").textContent = preset.label;
      b.querySelector(".p-blurb").textContent = preset.blurb;
      b.addEventListener("click", () => {
        // A preset turns All-In-One off: they are two different answers to the same question, and
        // leaving both on would show a board that is not actually driving anything.
        state.allInOne = "";
        const all = $("#ide-allinone");
        if (all) all.value = "";
        state.assignments = { ...state.assignments, ...preset.assignments };
        renderBoard();
        saveAssignments();
      });
      host.append(b);
    }
  }

  // Paint the cards from the server's routing description plus the live model catalog.
  function renderBoard() {
    const cards = $("#ide-cards");
    if (!cards || !state.routing) return;
    const info = state.routing.classes || {};
    const assigned = state.assignments || {};
    cards.textContent = "";

    for (const cls of CARD_ORDER) {
      const meta = info[cls] || { label: cls, blurb: "" };
      const card = document.createElement("div");
      card.className = "ide-card" + (cls === "design_visual" ? " is-image" : "");

      const top = document.createElement("div");
      top.className = "ide-card-top";
      top.innerHTML = '<span class="name"></span><span class="tag"></span>';
      top.querySelector(".name").textContent = meta.label;
      if (cls === "design_visual") top.querySelector(".tag").textContent = "always OpenAI";

      const blurb = document.createElement("div");
      blurb.className = "blurb";
      blurb.textContent = meta.blurb || "";

      card.append(top, blurb);

      if (cls === "design_visual") {
        // Brand lock: the image engine cell reads DOMINION FORGE, never a provider model name.
        const cell = document.createElement("div");
        cell.className = "engine-cell";
        cell.textContent = "Dominion Forge";
        const note = document.createElement("div");
        note.className = "price";
        note.textContent = "Images cannot come from a text model, so this one is fixed.";
        card.append(cell, note);
      } else {
        const sel = document.createElement("select");
        sel.dataset.cls = cls;
        sel.setAttribute("aria-label", meta.label + " model");
        fillModelOptions(sel, assigned[cls] || "");
        const price = document.createElement("div");
        price.className = "price";
        price.dataset.for = cls;
        card.append(sel, price);
        // Paint through the element we already hold. Looking it up by selector here would find
        // nothing, since the card is not in the document until the append below.
        const setPrice = (v) => {
          if (!v) { price.textContent = "Follows your main model."; return; }
          const m = findModel(v);
          price.textContent = m && m.priceLong ? m.priceLong : "";
        };
        setPrice(sel.value);
        sel.addEventListener("change", () => {
          state.assignments[cls] = sel.value;
          setPrice(sel.value);
          saveAssignments();
        });
        if (state.allInOne) sel.disabled = true;
      }
      cards.append(card);
    }
    fillModelOptions($("#ide-allinone"), state.allInOne || "", true);
    renderPresets();
  }

  /*
   * Options come from the SAME catalog the chat picker uses (GET /api/models), so there is one
   * price list, not two. Unavailable models are shown DISABLED with the reason, never hidden and
   * never silently swapped, matching how the chat picker refuses rather than substitutes.
   */
  function fillModelOptions(sel, current, isAllInOne) {
    if (!sel) return;
    const keep = sel.value;
    sel.textContent = "";
    if (isAllInOne) sel.append(new Option("Off: use the board below", ""));
    else sel.append(new Option("Use my main model", ""));
    for (const g of state.catalog || []) {
      const grp = document.createElement("optgroup");
      grp.label = g.label;
      for (const m of g.models) {
        const o = new Option(m.name + (m.priceShort ? "  " + m.priceShort : ""), m.id);
        if (m.unavailable) { o.disabled = true; o.text = m.name + "  (needs a provider key)"; }
        grp.append(o);
      }
      sel.append(grp);
    }
    sel.value = current || keep || "";
  }


  function findModel(id) {
    for (const g of state.catalog || []) for (const m of g.models) if (m.id === id) return m;
    return null;
  }


  /*
   * Assignments belong to the workspace. With no workspace yet they are held as the account's
   * starting point, so the board is usable before the first project exists.
   *
   * TWO THINGS THIS RETURNS THAT IT USED TO SWALLOW (Fred, 2026-08-01: the 12-task plan he approved
   * ran as an unrelated 6-step build). It takes an explicit target, because the caller sometimes
   * knows which folder the work is bound for before this module's own state catches up; and it
   * RETURNS THE PROMISE, because a caller about to start a build has to know the plan actually
   * landed. Fire-and-forget was a race that the build usually won.
   */
  function saveAssignments(targetWorkspaceId) {
    const body = { assignments: { ...state.assignments, allInOne: state.allInOne || "" } };
    const wsId = targetWorkspaceId || state.workspaceId;
    const url = wsId ? "/ide/workspace/update" : "/ide/prefs";
    const payload = wsId ? { id: wsId, patch: body } : { engaged: state.engaged, ...body };
    const done = fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .then((r) => r.ok)
      .catch(() => false);
    paintModelLine();   // the vibe coder's one-line summary must never contradict the board
    return done;
  }

  // Live routing preview: type a job, see where it would go and why. Costs nothing: the server
  // answers from the deterministic table and never calls a model for a preview.
  let probeTimer = 0;
  function wireProbe() {
    const input = $("#ide-probe-input");
    const out = $("#ide-verdict");
    if (!input || !out) return;
    input.addEventListener("input", () => {
      clearTimeout(probeTimer);
      const text = input.value.trim();
      if (!text) { out.classList.remove("on"); return; }
      probeTimer = setTimeout(async () => {
        try {
          const r = await fetch("/ide/route/preview", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: text, workspaceId: state.workspaceId || "" }),
          });
          if (!r.ok) return;
          const v = await r.json();
          const model = v.isImage ? "Dominion Forge"
            : (findModel(v.model) ? findModel(v.model).name : (v.model || "your main model"));
          out.textContent = "";
          const cls = document.createElement("span"); cls.className = "cls"; cls.textContent = v.label;
          const to = document.createElement("span"); to.className = "to"; to.textContent = model;
          const arrow = document.createElement("span"); arrow.textContent = "handles this";
          const why = document.createElement("span"); why.className = "why"; why.textContent = "Why: " + v.why + ".";
          out.append(cls, arrow, to, why);
          out.classList.add("on");
        } catch {}
      }, 260);
    });
  }

  /*
   * Pull the catalog once, from the SAME GET /api/models the chat picker uses, so there is one
   * price list rather than two. The payload is ALREADY grouped by category ({groups:[{category,
   * models}]}), and `available` reports which providers actually have a key on this server.
   * A model whose provider has no key is shown DISABLED with the reason, never hidden and never
   * silently swapped, matching how the chat picker refuses instead of substituting.
   */
  async function loadCatalog() {
    try {
      const r = await fetch("/api/models", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const data = await r.json();
      const avail = data && data.available && typeof data.available === "object" ? data.available : null;
      const hasKey = (provider) => {
        if (!avail) return true;                       // no report: assume usable rather than grey out the world
        if (!(provider in avail)) return true;
        return avail[provider] !== false;
      };
      const groups = Array.isArray(data && data.groups) ? data.groups : [];
      state.catalog = groups.map((g) => ({
        label: g.category || "Models",
        models: (g.models || []).filter((m) => m && m.id).map((m) => {
          const inC = Number(m.inCost), outC = Number(m.outCost);
          const priced = isFinite(inC) && isFinite(outC);
          return {
            id: m.id,
            name: m.name || m.id,
            priceShort: priced ? money().rate(inC, outC) : "",
            priceLong: priced ? money().rate(inC, outC, { long: true }) : "",
            unavailable: !hasKey(m.provider),
            // The one slot in the app with a floor (Vibe SOW 5.1). The server computes the rule;
            // this only carries the verdict to the orchestrator row's picker.
            orchestratorOk: m.orchestratorOk === true,
          };
        }),
      })).filter((g) => g.models.length);
    } catch {}
  }

  /* ---------- the front door: start a build -----------------------------------------------
   * The mission line promises a beginner ships something in five minutes. Until this existed,
   * the Crucible could WATCH builds and could not START one, which made the whole surface a
   * spectator sport. One folder, one sentence, one button.
   */
  function buildStarter() {
    const el = document.createElement("section");
    el.className = "ide-start";
    el.id = "ide-start";
    el.innerHTML =
      '<div class="st-head-row">' +
        '<h3 data-lex="start_heading"></h3>' +
        '<div class="st-mode-switch" id="st-mode-switch" role="tablist" aria-label="Working mode">' +
          '<button type="button" data-mode="beginner" data-lex="mode_name_beginner"></button>' +
          '<button type="button" data-mode="vibe" data-lex="mode_name_vibe"></button>' +
          '<button type="button" data-mode="engineer" data-lex="mode_name_engineer"></button>' +
        '</div>' +
      '</div>' +
      '<div class="st-journey" id="st-journey" aria-live="polite">' +
        '<div class="st-journey-copy">' +
          '<span class="st-journey-kicker" data-lex="journey_kicker"></span>' +
          '<strong id="st-journey-title"></strong>' +
          '<span id="st-journey-note"></span>' +
        '</div>' +
        '<ol class="st-journey-track" aria-label="Build journey">' +
          JOURNEY_PHASES.map((phase) => '<li data-phase="' + phase + '"><span></span></li>').join("") +
        '</ol>' +
      '</div>' +
      '<div class="st-vibe-toolbar">' +
        '<div><strong data-lex="studio_toolbar_title"></strong><span id="st-studio-summary"></span></div>' +
        '<button type="button" id="st-studio-open" aria-haspopup="dialog" data-lex="studio_open"></button>' +
      '</div>' +
      '<details class="st-drawer" id="dr-folder" open>' +
        '<summary data-lex="drawer_folder"></summary>' +
        '<div class="st-row" id="st-ws-row">' +
          '<select id="st-ws" aria-label="Which project folder to build in"></select>' +
          '<button type="button" id="st-add" data-lex="add_folder"></button>' +
          // Workshop accounts (no machine attached) get a one-tap folder instead of a demand for an
          // absolute path they could not possibly know (Fred, 2026-07-30). Hidden for anyone whose
          // account reaches a real computer, where the typed path is the honest input.
          '<button type="button" id="st-workshop-new" hidden>New project folder</button>' +
        '</div>' +
        '<p class="st-workshop-note" id="st-workshop-note" hidden></p>' +
        // The lane choice, shown ONLY to an account that actually has both (Fred, 2026-07-30).
        // Someone with a computer attached may still prefer the throwaway cloud machine, and
        // "I would rather not have this run on my work laptop" is a completely reasonable thing
        // to want. It governs NEW projects; every existing one keeps running where its files are.
        '<div class="st-lane" id="st-lane" hidden>' +
          '<label for="st-lane-pick">Where new builds run</label>' +
          '<select id="st-lane-pick">' +
            '<option value="mine">On my computer</option>' +
            '<option value="cloud">In Dominion\'s cloud workshop</option>' +
          '</select>' +
          '<span class="st-lane-note" id="st-lane-note"></span>' +
        '</div>' +
        '<div class="st-new" id="st-new" hidden>' +
          '<input id="st-new-path" type="text" autocomplete="off" spellcheck="false" />' +
          '<input id="st-new-name" type="text" autocomplete="off" />' +
          '<div class="st-new-btns">' +
            '<button type="button" id="st-browse" data-lex="browse_btn"></button>' +
            '<button type="button" id="st-new-go" data-lex="use_folder"></button>' +
          '</div>' +
          '<div class="st-tree" id="st-tree" hidden></div>' +
        '</div>' +
        // Adopt Existing Project (docs/ADOPT-EXISTING-SOW.md). Engineer placement: the folder
        // drawer, because the folder IS the input. The classic page only exists in Engineer mode
        // now (beginner and vibe surfaces stand it down), so this control is engineer-only by
        // construction, exactly as the placement ruling demands.
        '<div class="st-adopt-row">' +
          '<button type="button" id="st-adopt">Adopt existing app</button>' +
          '<span class="st-adopt-note">Point at a project you already started. Dominion reads what is actually there, briefs you honestly, and plans the finish. Read-only until you say build.</span>' +
        '</div>' +
      '</details>' +
      '<details class="st-drawer" id="dr-brief" open>' +
        '<summary data-lex="drawer_brief"></summary>' +
        '<textarea id="st-prompt" rows="3"></textarea>' +
      '</details>' +
      // Plan Pipeline (Phase 2A): start a project from a plan built in chat. Paste one, or pick a
      // saved plan; it names the project and fills the brief, then the normal build proceeds.
      '<details class="st-drawer st-plan-drawer" id="dr-plan">' +
        '<summary data-lex="plan_drawer"></summary>' +
        '<div class="st-plan-pick" id="st-plan-pick">' +
          '<label data-lex="plan_from_saved"></label>' +
          '<div class="st-plan-pick-row">' +
            '<select id="st-plan-select" aria-label="Saved plans"></select>' +
            '<button type="button" id="st-plan-load" data-lex="plan_load"></button>' +
          '</div>' +
        '</div>' +
        '<textarea id="st-plan-text" rows="4" data-lex-ph="plan_paste_ph"></textarea>' +
        '<div class="st-row">' +
          '<input id="st-plan-name" type="text" autocomplete="off" data-lex-ph="plan_name_ph" />' +
          '<button type="button" id="st-plan-start" class="st-primary" data-lex="plan_start"></button>' +
        '</div>' +
      '</details>' +
      '<details class="st-drawer" id="dr-models" open>' +
        '<summary data-lex="drawer_models"></summary>' +
        '<div class="st-tools" id="st-tools">' +
          '<span class="st-tools-label" data-lex="tools_label"></span>' +
          '<div class="st-model-line-row">' +
            '<div class="st-model-line" id="st-model-line" hidden></div>' +
            '<button type="button" id="st-af" data-lex="af_btn" hidden></button>' +
          '</div>' +
          '<div class="st-tools-btns">' +
            '<button type="button" id="st-tools-default" data-lex="tools_default"></button>' +
            '<button type="button" id="st-tools-custom" data-lex="tools_customize"></button>' +
          '</div>' +
        '</div>' +
        '<div id="dr-models-slot"></div>' +
      '</details>' +
      '<details class="st-drawer" id="dr-session" open>' +
        '<summary data-lex="drawer_session"></summary>' +
        '<div class="st-row st-lang">' +
          '<span class="st-lang-label" data-lex="lang_label"></span>' +
          '<select id="st-lang" aria-label="How Dominion talks to you">' +
            '<option value="plain"></option><option value="technical"></option><option value="hybrid"></option>' +
          '</select>' +
        '</div>' +
      '</details>' +
      '<div class="st-chat" id="st-chat">' +
        '<div class="st-chat-head">' +
          '<span data-lex="intake_title"></span>' +
          '<span class="st-chat-head-btns">' +
            '<button type="button" id="st-fresh" data-lex="fresh_start"></button>' +
            '<button type="button" id="st-chat-min" data-lex="intake_min"></button>' +
          '</span>' +
        '</div>' +
        '<div class="st-chat-log" id="st-chat-log" aria-live="polite"></div>' +
        '<div class="st-chat-row" id="st-chat-row">' +
          '<textarea id="st-chat-in" rows="1"></textarea>' +
          '<button type="button" id="st-chat-send" data-lex="intake_send"></button>' +
        '</div>' +
        '<div class="st-chat-actions" id="st-chat-actions" hidden>' +
          '<button type="button" id="st-chat-build" class="st-primary" data-lex="intake_build"></button>' +
          '<button type="button" id="st-chat-more" data-lex="intake_more"></button>' +
        '</div>' +
        '<button type="button" id="st-chat-skip" class="st-link" data-lex="intake_skip"></button>' +
      '</div>' +
      '<div class="st-row">' +
        '<button type="button" id="st-go" class="st-primary" data-lex="start_go"></button>' +
        '<span class="st-status" id="st-status" role="status"></span>' +
      '</div>' +
      '<div class="st-studio-shell" id="st-studio-shell" hidden>' +
        '<button type="button" class="st-studio-backdrop" id="st-studio-backdrop" aria-label="Close workspace customization"></button>' +
        '<section class="st-studio-panel" role="dialog" aria-modal="true" aria-labelledby="st-studio-title">' +
          '<header>' +
            '<div><span class="st-studio-kicker" data-lex="studio_kicker"></span><h3 id="st-studio-title" data-lex="studio_title"></h3></div>' +
            '<button type="button" class="st-studio-close" id="st-studio-close" aria-label="Close">×</button>' +
          '</header>' +
          '<p class="st-studio-intro" data-lex="studio_intro"></p>' +
          '<div class="st-studio-presets" id="st-studio-presets" aria-label="Workspace presets"></div>' +
          '<div class="st-studio-modules" id="st-studio-modules"></div>' +
          '<footer><span data-lex="studio_immediate"></span><button type="button" class="st-primary" id="st-studio-done" data-lex="studio_done"></button></footer>' +
        '</section>' +
      '</div>';
    return el;
  }

  function readStudio() {
    try {
      const raw = JSON.parse(localStorage.getItem(STUDIO_KEY) || "null");
      const valid = new Set(STUDIO_MODULES.map((m) => m.id));
      const modules = Array.isArray(raw && raw.modules) ? raw.modules.filter((id) => valid.has(id)) : null;
      if (modules) {
        state.studio = {
          preset: typeof raw.preset === "string" ? raw.preset : "custom",
          modules: new Set(modules),
        };
      }
    } catch {}
  }

  function saveStudio() {
    try {
      localStorage.setItem(STUDIO_KEY, JSON.stringify({
        preset: state.studio.preset,
        modules: [...state.studio.modules],
      }));
    } catch {}
  }

  function studioPresetFor(modules) {
    const chosen = [...modules].sort().join(",");
    for (const [name, ids] of Object.entries(STUDIO_PRESETS)) {
      if ([...ids].sort().join(",") === chosen) return name;
    }
    return "custom";
  }

  function paintJourney() {
    const root = $("#ide-root");
    if (root) root.dataset.phase = state.phase;
    const copy = JOURNEY_COPY[state.phase] || JOURNEY_COPY.idea;
    const title = $("#st-journey-title"), note = $("#st-journey-note");
    if (title) title.textContent = L(copy[0]);
    if (note) note.textContent = L(copy[1]);
    const activeIndex = JOURNEY_PHASES.indexOf(state.phase);
    for (const [index, step] of [...document.querySelectorAll("#st-journey-track li")].entries()) {
      step.classList.toggle("on", index === activeIndex);
      step.classList.toggle("done", index < activeIndex);
      step.setAttribute("aria-label", L(JOURNEY_COPY[step.dataset.phase][0]));
      step.setAttribute("aria-current", index === activeIndex ? "step" : "false");
    }
  }

  function setJourneyPhase(phase) {
    if (!JOURNEY_PHASES.includes(phase) || state.phase === phase) return;
    state.phase = phase;
    paintJourney();
    try {
      document.dispatchEvent(new CustomEvent("dominion-journey-changed", { detail: { phase } }));
    } catch {}
  }

  function paintStudio() {
    const root = $("#ide-root");
    if (!root) return;
    const modules = [...state.studio.modules];
    root.dataset.studioModules = modules.join(" ");
    const preset = studioPresetFor(state.studio.modules);
    state.studio.preset = preset;
    const summary = $("#st-studio-summary");
    if (summary) {
      const names = { minimal: "studio_preset_minimal", design: "studio_preset_design", fullstack: "studio_preset_fullstack", ship: "studio_preset_ship", custom: "studio_preset_custom" };
      summary.textContent = L(names[preset] || names.custom) + " · " + modules.length + " " + L("studio_tools_count");
    }
    for (const b of document.querySelectorAll("#st-studio-presets button")) {
      const on = b.dataset.preset === preset;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const input of document.querySelectorAll("#st-studio-modules input")) {
      input.checked = state.studio.modules.has(input.value);
    }
    try { document.dispatchEvent(new CustomEvent("dominion-studio-changed", { detail: { modules } })); } catch {}
  }

  function closeStudio() {
    const shell = $("#st-studio-shell");
    if (!shell || shell.hidden) return;
    shell.hidden = true;
    document.body.classList.remove("studio-open");
    $("#st-studio-open") && $("#st-studio-open").focus();
  }

  function openStudio() {
    if (state.mode !== "vibe") return;
    const shell = $("#st-studio-shell");
    if (!shell) return;
    shell.hidden = false;
    document.body.classList.add("studio-open");
    // The drawer always opens at its top (Fred, layout pass 07-23).
    const mods = shell.querySelector(".st-studio-modules");
    if (mods) mods.scrollTop = 0;
    const first = shell.querySelector("button, input");
    if (first) first.focus();
  }

  function wireStudio() {
    readStudio();
    const presets = $("#st-studio-presets");
    const presetNames = { minimal: "studio_preset_minimal", design: "studio_preset_design", fullstack: "studio_preset_fullstack", ship: "studio_preset_ship" };
    for (const [id, modules] of Object.entries(STUDIO_PRESETS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.preset = id;
      b.dataset.lex = presetNames[id];
      b.textContent = L(presetNames[id]);
      b.addEventListener("click", () => {
        state.studio = { preset: id, modules: new Set(modules) };
        saveStudio();
        paintStudio();
      });
      presets.append(b);
    }
    const list = $("#st-studio-modules");
    for (const module of STUDIO_MODULES) {
      const label = document.createElement("label");
      label.className = "st-studio-module";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = module.id;
      const copy = document.createElement("span");
      copy.innerHTML = "<strong></strong><small></small>";
      copy.querySelector("strong").dataset.lex = module.title;
      copy.querySelector("small").dataset.lex = module.note;
      copy.querySelector("strong").textContent = L(module.title);
      copy.querySelector("small").textContent = L(module.note);
      input.addEventListener("change", () => {
        if (input.checked) state.studio.modules.add(module.id);
        else state.studio.modules.delete(module.id);
        state.studio.preset = studioPresetFor(state.studio.modules);
        saveStudio();
        paintStudio();
      });
      label.append(input, copy);
      list.append(label);
    }
    $("#st-studio-open").addEventListener("click", openStudio);
    $("#st-studio-close").addEventListener("click", closeStudio);
    $("#st-studio-backdrop").addEventListener("click", closeStudio);
    $("#st-studio-done").addEventListener("click", closeStudio);
    paintStudio();
  }

  // Pour the chosen register into every tagged element. One function, called on mount and on
  // every register change, so no string can be left behind in the old voice.
  function paintLexicon() {
    for (const el of document.querySelectorAll("[data-lex]")) el.textContent = L(el.dataset.lex);
    for (const el of document.querySelectorAll("[data-lex-ph]")) el.placeholder = L(el.dataset.lexPh);
    const prompt = $("#st-prompt");
    if (prompt) prompt.placeholder = L("start_prompt_ph");
    const path = $("#st-new-path");
    if (path) path.placeholder = L("folder_ph");
    const name = $("#st-new-name");
    if (name) name.placeholder = L("st_name_ph");
    const chatIn = $("#st-chat-in");
    if (chatIn) {
      chatIn.placeholder = intake.messages.length === 0 ? L("dream_ph") : L("intake_ph");
    }
    const goBtn = $("#st-go");
    if (goBtn) goBtn.textContent = state.mode === "beginner" ? L("start_talk") : L("start_go");
    const lang = $("#st-lang");
    if (lang) {
      lang.value = window.DominionLexicon ? window.DominionLexicon.register : "plain";
      const opts = lang.querySelectorAll("option");
      if (opts.length === 3) {
        opts[0].textContent = L("lang_plain");
        opts[1].textContent = L("lang_technical");
        opts[2].textContent = L("lang_hybrid");
      }
    }
  }

  /*
   * The folder row has two honest shapes. An account with a real computer attached types a real
   * path and browses its real drives. A WORKSHOP account has neither, and asking it for "a full
   * path, for example C:\Projects\my-app" was asking for a fact it could not have — which is why
   * the folder never got chosen and the build button appeared to do nothing (Fred, 2026-07-30).
   * The workshop shape asks for a NAME and makes the folder server-side in one tap.
   */
  function paintFolderShape() {
    const mk = $("#st-workshop-new"), add = $("#st-add"), note = $("#st-workshop-note"), typed = $("#st-new");
    if (!mk) return;
    const workshop = state.workshop === true;
    mk.hidden = !workshop;
    if (add) add.hidden = workshop;                 // the typed-path opener has nothing to offer here
    if (workshop && typed) typed.hidden = true;
    if (note) {
      note.hidden = !workshop;
      note.textContent = workshop
        ? (state.canChooseLane
            ? "New projects are built in a workshop on Dominion's server, in a machine that exists only while a command runs. Files here are real and yours to download. Switch back above to build straight onto your own computer."
            : "Your projects are built in a workshop on Dominion's server. Files here are real and yours to download. To build straight onto your own computer instead, install a Dominion node from Setup.")
        : "";
    }
    paintLaneChoice();
  }

  /*
   * The lane control appears only when there is a genuine choice: a machine attached AND a cloud
   * workshop available. With no machine the cloud is not a preference, it is the only thing there
   * is, and a toggle that cannot be moved is worse than no toggle. The note says out loud that the
   * choice governs new work, because the one thing a user could reasonably fear is that flipping it
   * strands the project they already have.
   */
  function paintLaneChoice() {
    const box = $("#st-lane"), pick = $("#st-lane-pick"), n = $("#st-lane-note");
    if (!box || !pick) return;
    box.hidden = state.canChooseLane !== true;
    if (box.hidden) return;
    pick.value = state.buildWhere === "cloud" ? "cloud" : "mine";
    if (n) n.textContent = "Applies to new projects. Anything you already started keeps building where its files are.";
  }

  function renderStarter() {
    const sel = $("#st-ws");
    if (!sel) return;
    paintLexicon();
    paintFolderShape();
    paintEngineerLaunchGate();
    sel.textContent = "";
    if (!state.workspaces.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = L("no_folder_yet");
      sel.append(o);
      // A beginner on a real machine gets the typed-path box opened for them. A workshop account
      // must NOT: that box demands a path they cannot supply, and opening it is what made the
      // starter look broken.
      if (state.mode === "beginner" && !state.workshop) {
        const newEl = $("#st-new");
        if (newEl) newEl.hidden = false;
      }
    }
    for (const w of state.workspaces) {
      const o = document.createElement("option");
      o.value = w.id;
      o.textContent = w.name + "  (" + w.root + ")";
      if (w.id === state.workspaceId) o.selected = true;
      sel.append(o);
    }
  }

  /*
   * The Plan Pipeline intake (Phase 2A). Load a plan built in chat (saved as a "plan" artifact),
   * or paste one, then start a project from it: it names the workspace and fills the brief, and
   * the build proceeds the normal way. Opening the drawer loads the saved-plan list once.
   */
  async function loadPlanList() {
    const sel = $("#st-plan-select");
    if (!sel) return;
    try {
      const r = await fetch("/artifacts?type=plan");
      const j = await r.json();
      const items = (j && j.items) || [];
      sel.innerHTML = '<option value="">' + L("plan_none") + "</option>"
        + items.map((a) => '<option value="' + a.id + '">' + (a.title || "Untitled plan").replace(/</g, "&lt;") + "</option>").join("");
      sel.dataset.loaded = "1";
    } catch {}
  }

  function wirePlan(status) {
    const drawer = $("#dr-plan");
    if (drawer) drawer.addEventListener("toggle", () => { if (drawer.open && $("#st-plan-select") && !$("#st-plan-select").dataset.loaded) loadPlanList(); });
    const loadBtn = $("#st-plan-load");
    if (loadBtn) loadBtn.addEventListener("click", async () => {
      const id = $("#st-plan-select") && $("#st-plan-select").value;
      if (!id) { status(L("plan_pick_first"), true); return; }
      try {
        const r = await fetch("/artifacts/" + encodeURIComponent(id));
        const j = await r.json();
        const a = j && (j.artifact || j.item || j);
        const content = (a && (a.content || a.currentContent)) || "";
        const title = (a && a.title) || "";
        if (content) $("#st-plan-text").value = content;
        if (title && $("#st-plan-name")) $("#st-plan-name").value = title;
        status(L("plan_loaded"));
      } catch { status(L("plan_load_failed"), true); }
    });
    const startBtn = $("#st-plan-start");
    if (startBtn) startBtn.addEventListener("click", () => {
      const plan = $("#st-plan-text") ? $("#st-plan-text").value.trim() : "";
      if (!plan) { status(L("plan_empty"), true); return; }
      const name = ($("#st-plan-name") && $("#st-plan-name").value.trim()) || plan.split("\n")[0].replace(/^#+\s*/, "").slice(0, 40) || "New project";
      // Seed the brief with the plan, mark it as the agreed spec, and drop the name into the new-
      // folder field so the user confirms a folder the normal way. Journey moves to "clarify".
      const brief = "PROJECT: " + name + "\n\nBUILD THIS PLAN:\n" + plan;
      if ($("#st-prompt")) $("#st-prompt").value = brief;
      if ($("#st-new-name")) $("#st-new-name").value = name;
      const folder = $("#dr-folder"); if (folder) folder.open = true;
      const nb = $("#st-new"); if (nb) { nb.hidden = false; }
      setJourneyPhase("clarify");
      saveDraft();
      status(L("plan_started"));
      const prompt = $("#st-prompt"); if (prompt) prompt.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function wireStarter() {
    const status = (msg, bad) => { const el = $("#st-status"); if (el) { el.textContent = msg || ""; el.classList.toggle("bad", !!bad); } };
    $("#st-add").addEventListener("click", () => { const n = $("#st-new"); n.hidden = !n.hidden; if (!n.hidden) $("#st-new-path").focus(); });
    /*
     * One tap, one folder. The server names the path (it is inside a sandbox the guest cannot see),
     * so all this asks for is what to call the project — and it accepts an empty answer, because a
     * person who just wants to start should not be stopped by a naming ceremony.
     */
    /*
     * The lane switch. It writes to the ACCOUNT, not the device, because where a build runs is a
     * fact about the build and not about the screen you happen to be holding. The optimistic paint
     * is reverted on failure: a control that shows "cloud" while the server still says "mine" would
     * send someone's next build to a machine they thought they had opted out of.
     */
    const lanePick = $("#st-lane-pick");
    if (lanePick) lanePick.addEventListener("change", async () => {
      const want = lanePick.value === "cloud" ? "cloud" : "mine";
      const was = state.buildWhere;
      state.buildWhere = want;
      lanePick.disabled = true;
      try {
        const r = await fetch("/ide/prefs", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ engaged: state.engaged, buildWhere: want }) });
        if (!r.ok) throw new Error("save failed");
        // Re-read rather than trust the optimistic paint: the server is the authority on which
        // lane the account is actually in, and the folder row's whole shape hangs off that answer.
        const s = await fetch("/ide/state", { headers: { accept: "application/json" } }).then((x) => (x.ok ? x.json() : null));
        if (s) {
          state.workshop = s.workshop === true;
          state.hasNode = s.hasNode === true;
          state.canChooseLane = s.canChooseLane === true;
          state.buildWhere = s.buildWhere === "cloud" ? "cloud" : "mine";
        }
        renderStarter();
        status(want === "cloud"
          ? "New projects will be built in Dominion's cloud workshop."
          : "New projects will be built on your own computer.");
      } catch {
        state.buildWhere = was;
        paintLaneChoice();
        status("That setting could not be saved. Nothing changed.", true);
      } finally { lanePick.disabled = false; }
    });

    const mkWorkshop = $("#st-workshop-new");
    if (mkWorkshop) mkWorkshop.addEventListener("click", async () => {
      mkWorkshop.disabled = true;
      window.ideFlame.show("Making your project folder…");
      try {
        const suggested = ($("#st-new-name") && $("#st-new-name").value.trim())
          || ($("#st-prompt") && $("#st-prompt").value.trim().split(/\s+/).slice(0, 4).join("-"))
          || "my-app";
        const r = await fetch("/ide/workspace/new", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: suggested }) });
        const j = await r.json();
        if (!r.ok || j.error) { status((j && j.error) || "The folder could not be created.", true); return; }
        state.workspaces.push(j.workspace);
        state.workspaceId = j.workspace.id;
        renderStarter();
        status("Ready. Your project folder is " + j.workspace.name + ".");
        document.dispatchEvent(new CustomEvent("dominion-ide-workspace"));
      } catch { status("The server could not be reached.", true); }
      finally { mkWorkshop.disabled = false; window.ideFlame.hide(); }
    });
    $("#st-lang").addEventListener("change", async () => {
      const reg = $("#st-lang").value;
      if (window.DominionLexicon) window.DominionLexicon.set(reg);
      paintLexicon();
      try { await fetch("/ide/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engaged: state.engaged, language: reg }) }); } catch {}
    });
    $("#st-new-go").addEventListener("click", async () => {
      // The server strips wrapping quotes too, but doing it here keeps the visible field honest.
      // Smart quotes included: phones curl pasted quotes automatically.
      const root = $("#st-new-path").value.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
      const name = $("#st-new-name").value.trim();
      if (!root) { status(L("type_path_first"), true); return; }
      try {
        const r = await fetch("/ide/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, root }) });
        const j = await r.json();
        if (!r.ok || j.error) { status(j.error || "That folder could not be added.", true); return; }
        state.workspaces.push(j.workspace);
        state.workspaceId = j.workspace.id;
        renderStarter();
        $("#st-new").hidden = true;
        $("#st-new-path").value = "";
        $("#st-new-name").value = "";
        status(L("folder_saved"));
        document.dispatchEvent(new CustomEvent("dominion-ide-workspace"));
      } catch { status("The server could not be reached.", true); }
    });
    /*
     * Adopt Existing Project (Engineer path). The selected workspace IS the app; the scan runs
     * through the same hands wall as everything else, the honest brief replaces the blank-page
     * interview opening, and every intake turn from here carries adopt so the interviewer plans
     * finish/fix/new against reality. Read-only: the button changes nothing on disk.
     */
    $("#st-adopt").addEventListener("click", async () => {
      const workspaceId = $("#st-ws").value;
      if (!workspaceId) { status(L("pick_folder_first"), true); return; }
      const btn = $("#st-adopt");
      btn.disabled = true;
      window.ideFlame.show();
      status("Reading what is actually there…");
      try {
        const r = await fetch("/ide/adopt", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, mode: state.mode || "engineer" }) });
        const j = await r.json();
        if (!r.ok || j.error) { status((j && j.error) || "The scan could not run.", true); return; }
        const opening = j.brief
          + (j.analysis ? "\n\n" + j.analysis : "")
          + (j.analysisError ? "\n\n(" + j.analysisError + ")" : "");
        intake.adopt = true;
        intake.adoptionContext = opening;
        intake.messages = [{ role: "assistant", content: opening }];
        intake.vision = null;
        const log = $("#st-chat-log"); if (log) log.textContent = "";
        chatBubble("ai", opening);
        setJourneyPhase("clarify");
        paintLexicon();
        saveDraft();
        status("");
        const input = $("#st-chat-in"); if (input) input.focus();
      } catch (e) { status(friendlyError(e), true); }
      finally { btn.disabled = false; window.ideFlame.hide(); }
    });
    wirePlan(status);
    wireBrowse(status);
    wireTools();
    wireIntake(status);
    for (const b of document.querySelectorAll("#st-mode-switch button")) {
      b.addEventListener("click", () => requestMode(b.dataset.mode));
    }
    $("#st-go").addEventListener("click", () => beginIntake(status));
  }

  /* ---------- the folder picker (Fred's ruling 2026-07-21) --------------------------------
   * The folder lives on the BUILD machine, so no native browser picker can reach it. The hands
   * node lists its own drives and folders (fs_browse, carve-outs refused at the node) and the
   * phone taps through them.
   */
  function wireBrowse(status) {
    const tree = $("#st-tree");
    // Which machine this walk is on. Sent with every request so the tree cannot hop computers
    // mid-walk, which is what made the drive list change between taps when both nodes were up.
    let onMachine = "";
    const browse = async (path, machine) => {
      tree.hidden = false;
      tree.textContent = L("browse_loading");
      if (machine !== undefined) onMachine = machine || "";
      let j = null, err = null;
      try {
        const r = await fetch("/ide/browse", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: path || "", node: onMachine }) });
        j = await r.json();
      } catch (e) { err = e; }
      if (!j || j.error) { tree.textContent = j && j.error ? j.error : friendlyError(err); return; }
      if (j.node) onMachine = j.node;
      if (!path) onMachine = "";                 // back at the drive list: no machine chosen yet
      renderTree(j.path || "", j.dirs || []);
    };
    const renderTree = (path, dirs) => {
      tree.textContent = "";
      const bar = document.createElement("div");
      bar.className = "tr-bar";
      const where = document.createElement("span");
      where.className = "tr-where";
      // Always say which computer you are looking at. Not knowing was the whole bug.
      where.textContent = (path || "…") + (onMachine ? "  ·  " + onMachine : "");
      bar.append(where);
      if (path) {
        const up = document.createElement("button");
        up.type = "button"; up.className = "tr-up"; up.textContent = L("browse_up");
        // Parent of "F:\Projects" is "F:\"; parent of a drive root is the drive list.
        up.addEventListener("click", () => {
          const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
          if (parts.length <= 1) { browse("", ""); return; }   // back to the drive list, machine cleared
          const parent = parts.slice(0, -1).join("\\");
          browse(parts.length === 2 ? parts[0] + "\\" : parent, onMachine);
        });
        const use = document.createElement("button");
        use.type = "button"; use.className = "tr-use"; use.textContent = L("browse_here");
        use.addEventListener("click", () => {
          $("#st-new-path").value = path;
          tree.hidden = true;
          $("#st-new-go").click();
        });
        bar.append(up, use);
      }
      tree.append(bar);
      if (!dirs.length && path) {
        const none = document.createElement("div");
        none.className = "tr-empty";
        none.textContent = L("browse_empty");
        tree.append(none);
        return;
      }
      for (const d of dirs) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "tr-dir";
        b.textContent = d.name;
        // At the drive list each entry names its machine, because C:\ appears once per computer
        // and picking the wrong one used to be invisible until the build ran somewhere unexpected.
        if (!path && d.machine) {
          const tag = document.createElement("small");
          tag.className = "tr-machine";
          tag.textContent = d.machine;
          b.append(tag);
        }
        b.addEventListener("click", () => browse(d.path, d.machine));
        tree.append(b);
      }
    };
    $("#st-browse").addEventListener("click", () => {
      if (!tree.hidden) { tree.hidden = true; return; }
      // Start where the user already works: the newest workspace's drive, else the drive list.
      const last = state.workspaces[state.workspaces.length - 1];
      const start = last && last.root ? last.root.replace(/[\\/][^\\/]*$/, "") || "" : "";
      browse(start);
    });
  }

  /* ---------- the three modes (SOW docs/CRUCIBLE-MODES-ROADMAP.md, rulings 1a/2a/4a) --------
   * One switch changes everything downstream. The user picks from three cards exactly once
   * (never inferred: a robot guessing "you seem like a beginner" is a bad first date), and a
   * small persistent switch in the starter head changes it any time. Mode drives layout via
   * data-mode CSS, the register silently, the board's visibility, the tour, and the persona.
   */
  const readMode = () => { try { const v = localStorage.getItem(MODE_KEY); return MODES.includes(v) ? v : ""; } catch { return ""; } };

  /*
   * The guest Engineer launch gate must survive every way those controls are created: the
   * persistent switch, the first-session Welcome Screen, and Change level. A central painter
   * prevents a later DOM rebuild from accidentally restoring a live-looking button.
   */
  function paintEngineerLaunchGate(scope = document) {
    const locked = state.engineerComingSoon === true;
    for (const b of scope.querySelectorAll('[data-mode="engineer"]')) {
      b.disabled = locked;
      b.setAttribute("aria-disabled", locked ? "true" : "false");
      b.classList.toggle("ide-engineer-locked", locked);
      if (locked) {
        b.title = "Engineer — coming soon";
        if (!/coming soon/i.test(b.textContent)) b.textContent = (b.textContent || "Engineer").trim() + " · Coming soon";
      }
    }
  }

  /*
   * THE ENGINEER GATE, client half (Fred, 2026-07-25). Entering Engineer asks the server first;
   * a 403 means Automatic Top-Off is not armed, and the one-click enable panel appears instead.
   * The server is the wall (it refuses the pref and downgrades served prefs when top-off lapses);
   * this panel is the door handle. A network blip lets the UI in rather than bricking the app —
   * every real spend still hits the server-side gate.
   */
  async function requestMode(m) {
    if (m !== "engineer") return applyMode(m);
    if (state.engineerComingSoon) return;
    try {
      const r = await fetch("/ide/prefs", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ engaged: state.engaged, mode: "engineer", language: MODE_REG.engineer }) });
      if (r.status === 403) { const d = await r.json().catch(() => ({})); showTopoffPanel(d); return; }
    } catch {}
    applyMode("engineer");
  }
  function showTopoffPanel(d) {
    if (document.getElementById("eng-topoff")) return;
    const wrap = document.createElement("div");
    wrap.id = "eng-topoff";
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147480000;display:flex;align-items:center;justify-content:center;background:rgba(0,3,8,.55);backdrop-filter:blur(8px);padding:18px";
    const unavailable = d && (d.code === "engineer_unavailable" || d.code === "engineer_coming_soon");
    wrap.innerHTML = '<div style="max-width:520px;background:#0d1117;border:1px solid rgba(214,150,90,.55);border-radius:12px;padding:22px;color:#e8edf2;font-size:15px;line-height:1.5">' +
      '<div style="font-size:17px;font-weight:700;margin-bottom:10px">Engineer requires Automatic Top-Off</div>' +
      (unavailable
        ? '<p style="margin:0 0 6px">' + (d.error || "Not available on this account.") + '</p>'
        : '<p style="margin:0 0 10px">The Engineer interface runs long, real builds, so it needs an account that cannot stall mid-job.</p>' +
          '<button id="eng-topoff-go" type="button" style="background:#d6965a;color:#111;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer;margin:2px 0 8px">Enable Automatic Top-Off</button>' +
          '<div style="font-size:12px;opacity:.75">You will only be charged when your account runs low ($1 remaining), and credits will be added at your pre-set top-off amount in Settings.</div>') +
      '<div style="margin-top:14px"><button id="eng-topoff-x" type="button" style="background:none;border:1px solid rgba(255,255,255,.3);color:inherit;border-radius:8px;padding:6px 14px;cursor:pointer">Close</button></div></div>';
    document.body.appendChild(wrap);
    const x = wrap.querySelector("#eng-topoff-x"); if (x) x.onclick = () => wrap.remove();
    const go = wrap.querySelector("#eng-topoff-go");
    if (go) go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await fetch("/ide/topoff-enable", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok) { wrap.remove(); applyMode("engineer"); return; }   // armed: the button is gone for good
        if (j && j.needsCard) { location.href = "/setup.html"; return; }   // add a card, then come back
        go.disabled = false;
      } catch { go.disabled = false; }
    };
  }
  function applyMode(m, { save = true } = {}) {
    if (!MODES.includes(m)) return;
    if (m === "engineer" && state.engineerComingSoon) return;
    state.mode = m;
    try { localStorage.setItem(MODE_KEY, m); } catch {}
    // `save` marks a deliberate switch of interface, which is the thing recency is measured on.
    if (save) stampChoice();
    const root = $("#ide-root");
    if (root) root.dataset.mode = m;
    const picker = $("#cw");
    if (picker) picker.remove();
    // Switching modes re-lays the page; start it from the top (Fred, layout pass 07-23).
    const stage = $("#ide-stage");
    if (stage) stage.scrollTop = 0;
    // Engineers get closed drawers, named by function, in dependency order (the ruling). For
    // everyone else the drawer chrome disappears and the sections read as one open page.
    for (const d of document.querySelectorAll(".st-drawer")) d.open = m !== "engineer";
    // Register follows the mode (ruling 4a); the lang select stays as the engineer's override.
    if (window.DominionLexicon) window.DominionLexicon.set(MODE_REG[m]);
    paintLexicon();
    paintJourney();
    paintRailTitle();
    paintModeSwitch();
    /*
     * BEGINNER IS ITS OWN SURFACE NOW (Fred's ruling 2026-07-24). It is not the expert page with
     * pieces hidden by CSS any more: `beginnerSurface` builds a conversation-first screen of its
     * own, and the classic starter page plus both build lenses stand down while it is up. The two
     * other modes are untouched.
     */
    const beginner = m === "beginner";
    if (root) root.classList.toggle("bg-on", beginner);
    if (window.dominionBeginner) {
      if (beginner) window.dominionBeginner.open();
      else window.dominionBeginner.close();
    }
    // The Vibe Coder is its own surface too (Fred's drawn layout, docs/VIBE-CODER-SOW.md): slider,
    // studio, Plan with AI, Agent Army, Begin Building. Same pattern as the beginner: the classic
    // starter stands down entirely while it is up; the engineer keeps the classic page untouched.
    const vibe = m === "vibe";
    if (root) root.classList.toggle("vb-on", vibe);
    if (window.dominionVibe) {
      if (vibe) window.dominionVibe.open();
      else window.dominionVibe.close();
    }
    paintTools();
    paintModelLine();
    paintStudio();
    if (m !== "vibe") closeStudio();
    if (save) {
      fetch("/ide/prefs", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ engaged: state.engaged, mode: m, language: MODE_REG[m] }) }).catch(() => {});
    }
  }

  function paintModeSwitch() {
    for (const b of document.querySelectorAll("#st-mode-switch button")) {
      b.classList.toggle("on", b.dataset.mode === state.mode);
    }
    paintEngineerLaunchGate();
  }

  /*
   * The surface is named for what the mode actually gives you (Fred, 2026-07-24). One product,
   * three honest names: a beginner is building an app, a vibe coder is launching one, an engineer
   * has the whole stack. The header carries it in every mode, so nobody has to remember which
   * interface they are looking at.
   */
  const RAIL_NAME = {
    beginner: "Crucible App Builder",
    vibe: "Crucible App Launcher",
    engineer: "Crucible Full Stack Platform",
  };
  function paintRailTitle() {
    const el = $("#ide-rail-name");
    if (el) el.textContent = RAIL_NAME[state.mode] || RAIL_NAME.beginner;
  }

  /* ---------- the Crucible Welcome Screen -----------------------------------------------------
   * Fred's ruling 2026-07-24: the FIRST thing on opening the Crucible in a session is a layer OVER
   * the whole interface, blocking it out, with three buttons and one word of explanation under each.
   * It was previously a card list prepended into the page, which meant the machinery behind it was
   * still visible around the edges and read as "here is a wall of controls, and also, choose".
   *
   * ONCE PER SESSION, not once ever: the mode is a decision about who is at the keyboard today, and
   * on a shared or family device that changes. The chosen mode still persists, so the screen opens
   * with the last choice already correct; it just asks again.
   */
  const WELCOME_KEY = "dominion.crucible.welcomed.v1";
  const MODE_TITLE = { beginner: "Beginner", vibe: "Vibe Coder", engineer: "Engineer" };
  const MODE_LEVEL = { beginner: "Newbie", vibe: "Intermediate", engineer: "Professional" };
  /*
   * Plain words on purpose, and NOT from the lexicon: this screen is read BEFORE a mode exists, so
   * the register is still whatever the last session left behind. An engineer reading a plain
   * sentence loses nothing; a first-timer reading "intentional feature set with upfront cost and
   * complexity" loses the only decision this screen exists to help them make.
   */
  const MODE_WHY = {
    beginner: "You describe it, we talk it through, and it gets built. No technical words, ever.",
    vibe: "You know roughly how this works. Clear options and honest costs, no clutter.",
    engineer: "Everything, in labelled drawers: models, budgets, code, diffs.",
  };
  const welcomedThisSession = () => { try { return sessionStorage.getItem(WELCOME_KEY) === "1"; } catch { return false; } };
  const markWelcomed = () => { try { sessionStorage.setItem(WELCOME_KEY, "1"); } catch {} };

  /*
   * SEND TO CRUCIBLE (Fred, 2026-07-30). The chat hands over a name and a brief; this side does the
   * rest: open the Crucible, make or reuse a folder, seed the brief, and show the level picker,
   * because the level stays the person's choice and the surface then dresses itself around what the
   * chat already decided. The handover is an event rather than a function call, so the two surfaces
   * stay separable and either can be worked on without the other.
   */
  let pendingHandoff = null;
  document.addEventListener("dominion-to-crucible", async (e) => {
    const d = (e && e.detail) || {};
    if (!d.brief) return;
    // 8,000 here was the third place the corpus got cut. The record and its source both survive now.
    pendingHandoff = {
      name: String(d.name || "").slice(0, 60),
      brief: String(d.brief || "").slice(0, 200000),
      transcript: String(d.transcript || "").slice(0, 400000),
    };
    setEngaged(true, { reveal: true });
    await new Promise((r) => setTimeout(r, 120));
    // The brief lands first so the level picker is covering a screen that already knows the plan.
    if ($("#st-prompt")) $("#st-prompt").value = pendingHandoff.brief;
    if ($("#st-new-name")) $("#st-new-name").value = pendingHandoff.name;
    saveDraft();
    await ensureHandoffFolder();
    setJourneyPhase("clarify");
    renderStarter();
    // Always ask the level on a hand-off, even for someone who answered earlier in the session: the
    // question "how would you like to work" is about THIS project, and this is a new one.
    if (!$("#cw")) showModePicker();
  });

  /*
   * A hand-off should not stall on a folder question. A workshop account gets one made silently; an
   * account with a real machine keeps its existing folder if it has one, and otherwise is left at
   * the normal folder row with the name already filled in — the one case where a person must still
   * choose, because only they know their own disk.
   */
  async function ensureHandoffFolder() {
    if (state.workspaceId) return;
    if (state.workspaces && state.workspaces.length) { state.workspaceId = state.workspaces[0].id; return; }
    if (!state.workshop) { const f = $("#dr-folder"); if (f) f.open = true; return; }
    try {
      const r = await fetch("/ide/workspace/new", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: (pendingHandoff && pendingHandoff.name) || "my-app" }) });
      const j = await r.json();
      if (r.ok && j.workspace) { state.workspaces.push(j.workspace); state.workspaceId = j.workspace.id; }
    } catch {}
  }

  function showModePicker() {
    const root = $("#ide-root");
    if (!root || $("#cw")) return;
    const el = document.createElement("div");
    el.className = "cw";
    el.id = "cw";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Crucible Welcome Screen");
    el.innerHTML =
      '<div class="cw-card">' +
        '<span class="cw-kicker">THE CRUCIBLE</span>' +
        '<h2>How would you like to work?</h2>' +
        '<p class="cw-sub">Pick the one that sounds like you. You can change it at any time.</p>' +
        '<div class="cw-choices">' +
          MODES.map((m) =>
            '<div class="cw-choice">' +
              '<button type="button" class="cw-btn" data-mode="' + m + '">' + MODE_TITLE[m] + '</button>' +
              '<span class="cw-level">(' + MODE_LEVEL[m] + ')</span>' +
              '<span class="cw-why">' + MODE_WHY[m] + '</span>' +
            '</div>').join("") +
        '</div>' +
        // The way out (Fred, 2026-07-26): this layer blocks the whole interface, and until now
        // the only exits were picking a profile or killing the app. Leaving without choosing is
        // a legitimate answer; the screen simply asks again next time.
        '<button type="button" class="cw-exit" id="cw-exit">Return to chat</button>' +
      '</div>';
    root.append(el);
    paintLexicon();
    paintEngineerLaunchGate(el);
    for (const b of el.querySelectorAll(".cw-btn")) {
      b.addEventListener("click", () => {
        markWelcomed();
        el.remove();
        requestMode(b.dataset.mode);
        maybeShowIntro();
        document.dispatchEvent(new CustomEvent("dominion-crucible-open"));
      });
    }
    const exit = el.querySelector("#cw-exit");
    if (exit) exit.addEventListener("click", () => { el.remove(); closePanel(); });
  }

  // The vibe coder sees one honest sentence instead of a board: who does the work, at what rate.
  function paintModelLine() {
    const line = $("#st-model-line");
    if (!line || !state.routing) return;
    const name = (id) => { const m = findModel(id); return m ? m.name : ""; };
    const eng = state.allInOne || state.assignments.build_code || (state.routing.defaults && state.routing.defaults.build_code) || "";
    const des = state.allInOne || state.assignments.design_code || (state.routing.defaults && state.routing.defaults.design_code) || "";
    const engM = findModel(eng);
    const parts = [];
    parts.push((name(eng) || "Your main model") + (engM && engM.priceShort ? " (" + engM.priceShort + ")" : ""));
    if (des && des !== eng && name(des)) parts.push(name(des) + " for design");
    parts.push("Dominion Forge for pictures");
    line.textContent = L("model_line_intro") + " " + parts.join(" · ");
  }

  /* ---------- tools choice (Fred's ruling 2026-07-21) -------------------------------------
   * The Assignment Board is expert furniture, so it hides behind "Customize". "Use all the
   * default tools" is the recommended one-tap answer and clears any customization, so what the
   * button says is what the build does. Mode outranks it: beginners never see the choice at
   * all, engineers get the board standing open.
   */
  const TOOLS_KEY = "dominion.crucible.tools.v1";
  let toolsChoice = "default";

  function paintTools() {
    const board = $("#ide-board");
    const btnDef = $("#st-tools-default"), btnCus = $("#st-tools-custom");
    const afBtn = $("#st-af");
    if (!btnDef) return;
    if (board) {
      board.hidden = state.mode === "beginner" ? true
        : state.mode === "engineer" ? false
        : toolsChoice !== "custom";
    }
    btnDef.classList.toggle("on", toolsChoice !== "custom");
    btnCus.classList.toggle("on", toolsChoice === "custom");
    if (afBtn) {
      afBtn.hidden = state.mode === "beginner";
    }
  }

  function wireTools() {
    const board = $("#ide-board");
    const btnDef = $("#st-tools-default"), btnCus = $("#st-tools-custom");
    const paint = () => paintTools();
    try { toolsChoice = localStorage.getItem(TOOLS_KEY) === "custom" ? "custom" : "default"; } catch {}
    let mode = toolsChoice;
    paint(mode);
    btnDef.addEventListener("click", () => {
      toolsChoice = "default";
      try { localStorage.setItem(TOOLS_KEY, "default"); } catch {}
      paint();
      // Defaults MEAN defaults: the server stores NO keys (deleted, not blanked, since an empty
      // string counts as a choice and routes to the main model instead of the curated default).
      state.allInOne = "";
      const wsId = state.workspaceId;
      const body = { assignments: { allInOne: "" } };
      fetch(wsId ? "/ide/workspace/update" : "/ide/prefs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(wsId ? { id: wsId, patch: body } : { engaged: state.engaged, ...body }),
      }).catch(() => {});
      // The hidden board repaints to the curated defaults, so Customize later opens on the truth.
      state.assignments = {};
      for (const cls of CARD_ORDER) {
        if (cls === "design_visual") continue;
        state.assignments[cls] = (state.routing && state.routing.defaults && state.routing.defaults[cls]) || "";
      }
      const all = $("#ide-allinone");
      if (all) all.value = "";
      renderBoard();
      paintModelLine();
    });
    btnCus.addEventListener("click", () => {
      toolsChoice = "custom";
      try { localStorage.setItem(TOOLS_KEY, "custom"); } catch {}
      paint();
      if (board) board.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ---------- progress flame (Fred's ruling 2026-07-21) -----
   * A visible indicator that work is being sent, preventing the UI from looking frozen.
   */
  /*
   * TWO CHANNELS, because one was a lie (Fred, 2026-07-30: "the kit lights flash on and then
   * disappear when working"). The scanner used to bracket the HTTP REQUEST rather than the WORK:
   * startBuild POSTs /ide/job, gets a job id back in about a second, and its finally-block hid the
   * light while the build it just started ran on the server for minutes. Every job-starting flow
   * had the same shape. On top of that, a single global `active` flag meant any one operation's
   * hide() killed the indicator for every other operation still in flight (the lenses poll,
   * running every couple of seconds, was a reliable assassin).
   *
   *   request channel : refcounted show()/hide() pairs around short fetches. Depth, not a boolean,
   *                     so overlapping requests cannot switch each other off. Floored at zero, so
   *                     a call site that hides twice on one path can only under-count, never go
   *                     negative and wedge the light on forever.
   *   work channel    : track(labelOrFalse) — server-side jobs, which outlive their start request.
   *                     Set at build start, reconciled by refreshJobs() against real job state,
   *                     and cleared the instant the lens sees a terminal event. hide() cannot
   *                     touch it, which is the whole point.
   *
   * The light is lit while EITHER channel wants it. The green sweep still means exactly what the
   * CSS comment says it means: work is happening right now. A job that is waiting on the user is
   * not working, and refreshJobs() clears the channel for it.
   */
  window.ideFlame = (() => {
    let depth = 0, tracking = false, trackLabel = "", timer = null, startTime = 0, lastLabel = "";
    const el = () => {
      let flame = $("#ide-flame");
      if (!flame) {
        flame = document.createElement("div");
        flame.id = "ide-flame";
        flame.innerHTML = '<div class="if-inner"><div class="if-scanner"><span class="if-led"></span></div></div><strong class="if-label"></strong><div class="if-timer"></div>';
        document.body.append(flame);
      }
      return flame;
    };
    // One paint for both channels. The elapsed clock starts when the light first comes on and keeps
    // running across a handover (request -> tracked job), because from the user's side it is one
    // continuous wait, not two.
    const paint = () => {
      const want = depth > 0 || tracking;
      if (!want) {
        if (timer) { clearInterval(timer); timer = null; }
        const flame = $("#ide-flame");
        if (flame) {
          flame.classList.remove("on");
          setTimeout(() => { if (flame && !(depth > 0 || tracking)) flame.remove(); }, 200);
        }
        lastLabel = "";
        return;
      }
      const flame = el();
      const label = (tracking && trackLabel) || lastLabel || L("flame_working");
      if (label !== lastLabel) { flame.querySelector(".if-label").textContent = label; lastLabel = label; }
      flame.classList.add("on");
      if (!timer) {
        startTime = Date.now();
        const timerEl = flame.querySelector(".if-timer");
        const tick = () => {
          const sec = Math.floor((Date.now() - startTime) / 1000);
          const m = Math.floor(sec / 60), s = sec % 60;
          timerEl.textContent = (m > 0 ? m + ":" : "") + (s < 10 ? "0" : "") + s;
        };
        tick();
        timer = setInterval(tick, 1000);
      }
    };
    const show = (label) => { depth++; if (label) { lastLabel = label; const f = el(); f.querySelector(".if-label").textContent = label; } paint(); };
    const hide = () => { depth = Math.max(0, depth - 1); paint(); };
    // No pre-seeding of lastLabel here: paint() compares against it to decide whether to write, so
    // setting it first made the handover silently keep the request's wording ("starting build")
    // after the work channel had taken over with a truer one ("Building").
    const track = (labelOrFalse) => {
      tracking = !!labelOrFalse;
      trackLabel = typeof labelOrFalse === "string" ? labelOrFalse : "";
      paint();
    };
    // Hard reset for a surface teardown: forget both channels rather than leaving a stuck light.
    const clear = () => { depth = 0; tracking = false; trackLabel = ""; paint(); };
    return { show, hide, track, clear, isOn: () => depth > 0 || tracking };
  })();

  // Friendly error messages for network and timeout issues.
  function friendlyError(e) {
    return (e && e.name === "AbortError") ? L("err_timeout") : L("err_network");
  }

  /*
   * Forge is part of the build contract, not ambient page state. Capture both controls at the
   * exact request boundary so a detached Crucible job keeps the tier/mode it started with even if
   * the user later changes the dial in chat. `wolfeTier` is the established server field;
   * `forgeTier` travels beside it as the explicit shared-policy name during the compatibility
   * window. Sending Ember and false is intentional: omission must never make the server inherit a
   * stale setting from another chat or build.
   */
  function forgeExecutionFields() {
    let tier = "ember";
    let mode = false;
    try {
      const selected = window.forgeTierValue && window.forgeTierValue();
      if (selected === "ember" || selected === "flame" || selected === "furnace") tier = selected;
    } catch {}
    try { mode = !!(window.forgeModeValue && window.forgeModeValue()); } catch {}
    return { wolfeTier: tier, forgeTier: tier, forgeMode: mode };
  }

  const JOB_UI = {
    complete: { label: "Complete", message: "Build complete.", error: false },
    checkpointed: { label: "Checkpoint saved", message: "Checkpoint saved. The work is ready to continue.", error: false },
    paused: { label: "Paused", message: "Build paused. The work so far is saved.", error: false },
    failed: { label: "Failed", message: "Build failed before completion. The work so far is saved.", error: true },
    stopped: { label: "Stopped", message: "Build stopped before completion. The work so far is saved.", error: false },
    running: { label: "Building", message: "", error: false },
  };

  function jobUiState(job) {
    const raw = String((job && (job.executionState || job.status || job.outcome || job.state)) || "").toLowerCase();
    if (raw === "complete" || raw === "completed" || raw === "done") return "complete";
    if (raw === "checkpoint" || raw === "checkpointed" || raw === "checkpoint_context" || raw === "retry") return "checkpointed";
    if (raw === "pause" || raw === "paused" || raw === "paused_budget" || (job && job.waiting)) return "paused";
    if (raw === "error" || raw === "failed" || raw === "failure" || (job && job.interrupted)) return "failed";
    if (raw === "stop" || raw === "stopped" || (job && job.stopped)) return "stopped";
    return job && job.done ? "failed" : "running";
  }

  /*
   * Nothing has been built on this page yet, so nothing may be claimed about it. Called when the
   * selected project has no build of its own to report; without it, switching from a project that
   * failed to one that has never run left the first project's verdict sitting on the second one.
   */
  function clearBuildStatus() {
    const el = $("#st-status");
    const root = $("#ide-root");
    if (root) delete root.dataset.buildState;
    if (el) { el.textContent = ""; el.classList.remove("bad"); }
    try { document.dispatchEvent(new CustomEvent("dominion-ide-build-outcome", { detail: { kind: "", message: "", error: false, clear: true } })); } catch {}
  }

  /*
   * `announce: false` paints the line at the top of the page without telling the rest of the app
   * that a build just ended. Replaying an outcome the page found already finished when it loaded
   * is not news, and the surfaces that put news under the BEGIN BUILDING button must not be made
   * to shout an old one at somebody who has just opened a project.
   */
  function paintBuildStatus(kind, { announce = true } = {}) {
    const spec = JOB_UI[kind] || JOB_UI.failed;
    const el = $("#st-status");
    const root = $("#ide-root");
    if (root) root.dataset.buildState = kind;
    if (el) {
      el.textContent = spec.message;
      el.classList.toggle("bad", !!spec.error);
    }
    if (!announce) return;
    /*
     * THE OUTCOME HAS TO REACH THE BUTTON THAT CAUSED IT (Fred, 2026-08-01: "Pressed build, nothing
     * happened. Pressed again, nothing... The top also said Build failed, stopped early").
     *
     * This line lives at the top of the page while BEGIN BUILDING is at the bottom. The build did
     * start and it did fail, and the only report of that was somewhere he was not looking, so the
     * button read as dead and he pressed it twice. Announcing the outcome lets each surface put it
     * where its own user is actually looking. Third time this exact trap has been hit in this app:
     * a verdict rendered far from the control that produced it reads as no verdict at all.
     */
    try {
      document.dispatchEvent(new CustomEvent("dominion-ide-build-outcome", {
        detail: { kind, message: spec.message, error: !!spec.error },
      }));
    } catch {}
  }

  /* ---------- the intake conversation (Fred's ruling 2026-07-21) ---------------------------
   * The old flow assumed almost everything, which can build an app that looks or acts like
   * nothing the user intended, on their money. Now the model interviews the user, one question
   * at a time, judges their experience level from their own words, and states the vision back
   * as bullets. The user approves the bullets; THAT is what gets built. A skip link keeps the
   * old fast path for people who know exactly what they typed.
   */
  // adopt: this interview opened from an Adopt Existing Project brief, so every /ide/intake turn
  // carries the flag and the interviewer plans what exists toward what it should become.
  const intake = { messages: [], vision: null, busy: false, adopt: false, adoptionContext: "" };

  function chatBubble(role, text) {
    const log = $("#st-chat-log");
    const b = document.createElement("div");
    b.className = "cb " + (role === "user" ? "cb-user" : "cb-ai");
    b.textContent = text;
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function visionCard(vision) {
    const log = $("#st-chat-log");
    const card = document.createElement("div");
    card.className = "cb cb-vision";
    const h = document.createElement("h4");
    h.textContent = L("intake_vision_title");
    const body = document.createElement("div");
    body.textContent = vision;
    card.append(h, body);
    log.append(card);
    log.scrollTop = log.scrollHeight;
  }

  /*
   * What this surface has already been told, in words a model can use (Fred, 2026-08-01: "it
   * should also be context aware of any setting in that page so that it doesn't have to be
   * reiterated"). The project folder itself is NOT in here on purpose: it travels as an id and the
   * server reads the real record, so a browser can never assert a path it does not own.
   */
  function starterSettings() {
    const out = [];
    const add = (label, value) => { if (value) out.push({ label, value }); };
    const surface = state.mode === "vibe" ? "Vibe Coder" : state.mode === "engineer" ? "Engineer" : "beginner";
    add("Which interface they are using", surface);
    const reg = window.DominionLexicon ? window.DominionLexicon.register : "plain";
    add("How they want things explained", reg === "plain" ? "plain English, no jargon"
      : reg === "technical" ? "technical terms, they speak the language" : "the technical term with a short plain-English gloss");
    const mods = STUDIO_MODULES.filter((m) => state.studio.modules.has(m.id)).map((m) => L(m.title));
    add("Workspace setup they chose", state.studio.preset || "custom");
    add("Workspace panels switched on", mods.length ? mods.join(", ") : "none beyond the basics");
    const id = ($("#st-ws") && $("#st-ws").value) || state.workspaceId || "";
    const ws = (state.workspaces || []).find((w) => w.id === id);
    const cap = Number(ws && ws.budget && ws.budget.capUsd) || 0;
    add("Spend limit on this project", cap > 0 ? money().cost(cap) + ": the build pauses before passing it" : "none set; the build will not stop itself");
    if (intake.adopt) add("This is an app they already started", "yes; it was scanned and the report is above");
    return out;
  }

  async function intakeTurn(status) {
    if (intake.busy) return;
    intake.busy = true;
    window.ideFlame.show();
    const thinking = chatBubble("ai", L("intake_thinking"));
    thinking.classList.add("cb-thinking");
    let j = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const r = await fetch("/ide/intake", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: intake.messages, workspaceId: $("#st-ws").value || "",
          mode: state.mode || "beginner", adopt: !!intake.adopt,
          adoptionContext: intake.adoptionContext || "",
          // The classic starter's own switches, so the interviewer stops asking about settings the
          // person has already set on the screen in front of them (Fred, 2026-08-01).
          settings: starterSettings(),
          register: window.DominionLexicon ? window.DominionLexicon.register : "plain" }),
        signal: controller.signal });
      j = await r.json();
    } catch (e) {
      status(friendlyError(e), true);
    } finally {
      clearTimeout(timeout);
      window.ideFlame.hide();
    }
    thinking.remove();
    intake.busy = false;
    if (!j || j.error) { status((j && j.error) || friendlyError(null), true); return; }
    intake.messages.push({ role: "assistant", content: (j.reply ? j.reply + "\n" : "")
      + (j.mockups || []).map((m) => "MOCKUP: " + m + "\n").join("")
      + (j.vision ? "VISION READY\n" + j.vision : "") });
    saveDraft();
    if (j.reply) chatBubble("ai", j.reply);
    for (const m of (j.mockups || [])) renderMockup(m);
    if (j.vision) {
      intake.vision = j.vision;
      visionCard(j.vision);
      setJourneyPhase("ready");
      saveDraft();
      if (j.involves && state.mode !== "beginner") renderInvolves(j.involves);
      $("#st-chat-actions").hidden = false;
      document.dispatchEvent(new CustomEvent("dominion-ide-vision"));
    }
  }

  /*
   * A MOCKUP directive becomes a real picture in the chat (the beginner aesthetics loop): the
   * Forge pipeline paints it, the user taps "That one", and the choice is spoken back into the
   * interview so the model folds it into the vision.
   */
  async function renderMockup(promptText) {
    const log = $("#st-chat-log");
    const card = document.createElement("div");
    card.className = "cb cb-mock";
    card.innerHTML = '<div class="mk-wait">' + L("mockup_making") + '</div>';
    log.append(card);
    log.scrollTop = log.scrollHeight;
    window.ideFlame.show();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const r = await fetch("/api/images/generate", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "A clean, beautiful mockup of a phone app screen: " + promptText + ". No device frame text, no watermark.", n: 1 }),
        signal: controller.signal });
      const j = await r.json();
      const b64 = j && j.images && j.images[0] && j.images[0].b64;
      if (!r.ok || !b64) throw new Error((j && j.error) || "no image");
      card.innerHTML = "";
      const img = document.createElement("img");
      img.src = "data:image/png;base64," + b64;
      img.alt = promptText;
      img.addEventListener("click", () => img.classList.toggle("zoom"));
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "mk-pick";
      pick.textContent = L("mockup_pick");
      pick.addEventListener("click", () => {
        intake.messages.push({ role: "user", content: "I choose this look: " + promptText });
        chatBubble("user", L("mockup_pick") + " ✓");
        $("#st-chat-actions").hidden = true;
        saveDraft();
        intakeTurn(() => {});
      });
      card.append(img, pick);
      log.scrollTop = log.scrollHeight;
    } catch {
      card.innerHTML = "";
      card.className = "cb cb-ai";
      card.textContent = L("mockup_failed");
    } finally {
      clearTimeout(timeout);
      window.ideFlame.hide();
    }
  }

  // The vibe coder's honesty card: the cost band and every real-world commitment the vision
  // implies, before the Build button, never after the money is gone.
  /*
   * "What this involves" quotes a cost BAND. In credits the two ends are whole numbers, so a band
   * whose ends round together collapses to a single figure rather than printing "3 and 3", and a
   * band that rounds to nothing at all says so in words instead of quoting a confident zero.
   */
  function involvesBand(inv) {
    const lo = Number(inv && inv.lowUsd), hi = Number(inv && inv.highUsd);
    if (!money().inCredits() || !isFinite(lo) || !isFinite(hi)) return (inv && inv.band) || "";
    const c = window.DominionMoney;
    const a = c.toCredits(lo), b = c.toCredits(hi);
    if (!a && !b) return "under one credit";
    return a === b ? c.cost(lo) : c.cost(lo) + " to " + c.cost(hi);
  }

  function renderInvolves(inv) {
    const log = $("#st-chat-log");
    const card = document.createElement("div");
    card.className = "cb cb-involves";
    const h = document.createElement("h4");
    h.textContent = L("involves_title");
    card.append(h);
    const cost = document.createElement("div");
    cost.className = "inv-cost";
    // Guests read the band in credits. The server's pre-worded string is the fallback for a payload
    // that predates the raw numbers, and it is what the owner sees regardless.
    cost.textContent = L("involves_cost") + " " + involvesBand(inv);
    card.append(cost);
    const flags = Array.isArray(inv.flags) ? inv.flags : [];
    if (!flags.length) {
      const ok = document.createElement("div");
      ok.className = "inv-none";
      ok.textContent = L("involves_none");
      card.append(ok);
    } else {
      const ul = document.createElement("ul");
      for (const f of flags) {
        const li = document.createElement("li");
        li.textContent = f.label;
        ul.append(li);
      }
      card.append(ul);
    }
    log.append(card);
    log.scrollTop = log.scrollHeight;
  }

  let nodePollingInterval = 0;

  function startIntakeWithDream(dream, status) {
    // For beginner and vibe: auto-create workspace in background and start interview immediately.
    // For engineer: require workspace to be selected first.
    const workspaceId = $("#st-ws").value;
    if (!workspaceId && (state.mode === "engineer")) {
      status(L("pick_folder_first"), true);
      return;
    }
    if (!workspaceId && (state.mode === "beginner" || state.mode === "vibe")) {
      // Auto-create the workspace SILENTLY in the background: the interview neither waits for it
      // nor mentions it, and the flame stays owned by the interview turn (a hide here would kill
      // the working indicator mid-thought).
      fetch("/ide/workspace/auto", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hint: dream }) })
        .then(r => r.json())
        .then(j => {
          if (j.ok && j.workspace) {
            state.workspaces.push(j.workspace);
            state.workspaceId = j.workspace.id;
            renderStarter();
          } else if (j.offline) {
            // The build computer is not connected: the folksy install explanation, then watch.
            chatBubble("ai", L("node_offline_explain"));
            chatBubble("ai", L("node_watching"));
            startNodePolling(dream, status);
          } else if (j.error) {
            status(j.error, true);
          }
        })
        .catch(() => {
          chatBubble("ai", L("node_offline_explain"));
          chatBubble("ai", L("node_watching"));
          startNodePolling(dream, status);
        });
      // Start interview immediately regardless of workspace result.
      continueIntakeWithPrompt(dream, status);
      return;
    }
    status("");
    continueIntakeWithPrompt(dream, status);
  }

  function startNodePolling(dream, status) {
    if (nodePollingInterval) clearInterval(nodePollingInterval);
    // Every 20 seconds, for as long as the panel stays open: a person setting up their computer
    // for the first time needs many minutes, and the promise was "let me know when it is set up",
    // never "hurry". closePanel and the build start both clear this.
    nodePollingInterval = setInterval(async () => {
      try {
        const r = await fetch("/ide/node", { headers: { accept: "application/json" } });
        if (!r.ok) return;
        const j = await r.json();
        if (j.online) {
          clearInterval(nodePollingInterval);
          nodePollingInterval = 0;
          // Node is now online: celebrate and retry workspace auto-creation.
          chatBubble("ai", L("node_connected_celebrate"));
          fetch("/ide/workspace/auto", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ hint: dream }) })
            .then(r => r.json())
            .then(j => {
              if (j.ok && j.workspace) {
                state.workspaces.push(j.workspace);
                state.workspaceId = j.workspace.id;
                renderStarter();
              }
            })
            .catch(() => {});
        }
      } catch {}
    }, 20000);
  }

  // The brief-box entry (#st-go, vibe and engineer) funnels into the same start path as the chat,
  // so the workspace rules cannot drift between the two doors.
  function beginIntake(status) {
    const prompt = $("#st-prompt").value.trim();
    if (!prompt) { status("Say what you want built.", true); return; }
    startIntakeWithDream(prompt, status);
  }

  function continueIntakeWithPrompt(prompt, status) {
    if (intake.messages.length > 0 && intake.messages[0].content === prompt) {
      return;
    }
    intake.messages = [{ role: "user", content: prompt }];
    intake.vision = null;
    setJourneyPhase("clarify");
    // Draw the brief as the user's first turn exactly once, here in the shared start path, so both
    // entry paths (chat send and the start button) show it and neither shows it twice. The howdy
    // above it stays; the log is never wiped, because the chat is the conversation now.
    chatBubble("user", prompt);
    $("#st-chat-actions").hidden = true;
    $("#st-go").disabled = true;
    // The interview is running now, so the chat input asks for an answer instead of a dream.
    paintLexicon();
    status("");
    saveDraft();
    intakeTurn(status);
  }

  let draftSaveTimer = 0;
  const withAdoptionReport = (prompt) => !intake.adopt ? prompt :
    "ADOPTED PROJECT: the selected workspace already holds this app. Work against what exists; " +
    "preserve working behavior and implement the agreed finish/fix/new scope.\n\n" + prompt +
    "\n\nSTATE OF THE APP (scanned before planning):\n" + (intake.adoptionContext || "");

  function wireIntake(status) {
    const input = $("#st-chat-in");
    // Readiness detection was exact-match, so "ok go ahead" or "yes, build it!" fell through and
    // the user sat talking to a wall (Kimi #9: the emotional climax of the beginner flow). Now it
    // matches the intent ANYWHERE in a short reply: a clear go-word, tolerant of leading "ok/yes",
    // trailing punctuation, and "build it/this/that". Long replies are treated as more brief, not
    // as consent, so a sentence that merely contains "go" does not trip a build.
    const affirmative = (t) => {
      const s = String(t || "").trim().toLowerCase().replace(/[!.]+$/, "");
      if (s.split(/\s+/).length > 6) return false;
      return /\b(build|ship|make|launch)\s+(it|this|that|now)?\b/.test(s)
        || /^(ok(ay)?\s+|sure\s+|yes\s+|yep\s+|yeah\s+)?(go|go\s+ahead|do\s+it|let'?s\s+go|send\s+it|proceed|begin|start)\b/.test(s)
        || /^(build|ship|go|proceed|begin|yes|yep|yeah)$/.test(s);
    };
    const send = () => {
      const text = input.value.trim();
      if (!text || intake.busy) return;
      input.value = "";
      // When chat entry is the dream/brief (intake.messages.length === 0):
      if (intake.messages.length === 0) {
        // The typed text IS the brief. Mirror it into the drawer so drafts and the same-prompt
        // guard can see it, then start the interview; the user bubble and the placeholder swap
        // are handled once, by the shared start path.
        $("#st-prompt").value = text;
        saveDraft();
        startIntakeWithDream(text, status);
        return;
      }
      // During the interview, continue the conversation:
      if (state.mode === "beginner" && intake.vision && affirmative(text)) {
        const goal = intake.messages[0] ? intake.messages[0].content : $("#st-prompt").value.trim();
        const full = goal + "\n\nAGREED VISION (approved by the user; build exactly this):\n" + intake.vision;
        intake.messages.push({ role: "user", content: text });
        chatBubble("user", text);
        saveDraft();
        startBuild(full, status);
      } else {
        intake.messages.push({ role: "user", content: text });
        chatBubble("user", text);
        $("#st-chat-actions").hidden = true;
        saveDraft();
        intakeTurn(status);
      }
    };
    $("#st-chat-send").addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $("#st-fresh").addEventListener("click", startFresh);
    $("#st-chat-min").addEventListener("click", () => {
      const chat = $("#st-chat");
      chat.classList.toggle("min");
      $("#st-chat-min").textContent = chat.classList.contains("min") ? L("intake_recall") : L("intake_min");
    });
    $("#st-chat-more").addEventListener("click", () => {
      $("#st-chat-actions").hidden = true;
      input.focus();
    });
    $("#st-chat-build").addEventListener("click", () => {
      const goal = intake.adopt ? "Finish the adopted app according to the agreed vision."
        : (intake.messages[0] ? intake.messages[0].content : $("#st-prompt").value.trim());
      const full = intake.vision ? goal + "\n\nAGREED VISION (approved by the user; build exactly this):\n" + intake.vision : goal;
      startBuild(withAdoptionReport(full), status);
    });
    $("#st-chat-skip").addEventListener("click", () => {
      const goal = intake.adopt ? "Assess and finish the adopted app for production using the report below."
        : (intake.messages[0] ? intake.messages[0].content : $("#st-prompt").value.trim());
      if (!goal) { status("Say what you want built.", true); return; }
      startBuild(withAdoptionReport(goal), status);
    });
    // An abandoned interview must never strand the start button: touching the brief re-arms it.
    const prompt = $("#st-prompt");
    if (prompt) {
      prompt.addEventListener("input", () => {
        $("#st-go").disabled = false;
        clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => saveDraft(), 400);
      });
      prompt.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && state.mode === "beginner") {
          e.preventDefault();
          beginIntake(status);
        }
      });
    }
  }

  async function startBuild(prompt, status) {
    // The select first, then this module's own selection: a folder created seconds ago exists in
    // state before the select has been repainted, and a build must not be refused for that.
    const workspaceId = $("#st-ws").value || state.workspaceId || "";
    if (!workspaceId) { status("Pick or add a folder first.", true); return; }
    if (nodePollingInterval) clearInterval(nodePollingInterval);
    nodePollingInterval = 0;
    window.ideFlame.show();
    const go = $("#st-go");
    go.disabled = true;
    status("Starting...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const r = await fetch("/ide/job", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "build", workspaceId, prompt, ...forgeExecutionFields() }),
        signal: controller.signal });
      const j = await r.json();
      if (!r.ok || j.error) { status(j.error || "The build could not start.", true); go.disabled = false; window.ideFlame.hide(); return; }
      // The request is over; the WORK has just begun. Hand the scanner to the work channel here so
      // there is no dark gap between this response and the first refreshJobs() reconciliation.
      window.ideFlame.track(JOB_UI.running.label);
      status("");
      setJourneyPhase("build");
      const chat = $("#st-chat");
      if (chat && !chat.hidden) chatBubble("ai", L("chat_build_started"));
      go.disabled = false;
      state.workspaceId = workspaceId;
      // The permission moment: the FIRST real build is when notifications become worth having,
      // and a prompt at page load is when people reflexively refuse them.
      ensurePush().then((p) => {
        if (p && p.reason === "ios_needs_install" && p.message) status(p.message);
      });
      if (window.dominionLenses) { window.dominionLenses.follow(j.jobId); }
      document.dispatchEvent(new CustomEvent("dominion-ide-build-started"));
      refreshJobs();
    } catch (e) {
      status(friendlyError(e), true);
      go.disabled = false;
    } finally {
      clearTimeout(timeout);
      window.ideFlame.hide();
    }
  }

  /* ---------- Phase 4: a build you can walk away from ------------------------------------
   * Everything here works because the job lives on the SERVER. The browser is a window onto it:
   * close it, reload it, or open a different device, and the work is untouched.
   */

  // The rail sits in the command bar and stays visible on the CHAT surface, because a build you
  // cannot see is a build you will assume died.
  function initRail() {
    if ($("#ide-rail")) return;
    const bar = document.querySelector("#commandbar .command-controls") || document.querySelector("#commandbar");
    if (!bar) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "ide-rail";
    btn.title = "Your builds";
    btn.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="txt"></span><span class="count"></span>';
    btn.addEventListener("click", () => { setEngaged(true, { reveal: true }); });
    bar.append(btn);
  }

  function paintRail() {
    const rail = $("#ide-rail");
    if (!rail) return;
    const live = (state.jobs || []).filter((j) => !j.done);
    const asking = live.find((j) => j.waiting);
    const latest = live[0] || (state.jobs || [])[0] || null;
    const uiState = latest ? jobUiState(latest) : "";
    rail.classList.toggle("on", state.allowed && state.engaged && !!latest);
    const txt = rail.querySelector(".txt"), count = rail.querySelector(".count");
    if (asking) {
      rail.dataset.state = "paused";
      txt.textContent = "Paused — needs you";
      count.textContent = "";
    } else if (live.length) {
      rail.dataset.state = uiState;
      txt.textContent = uiState === "running" && live[0].move && live[0].move.title
        ? live[0].move.title.slice(0, 34)
        : (JOB_UI[uiState] || JOB_UI.running).label;
      count.textContent = live.length > 1 ? "+" + (live.length - 1) : "";
    } else if (latest) {
      rail.dataset.state = uiState;
      txt.textContent = (JOB_UI[uiState] || JOB_UI.failed).label;
      count.textContent = "";
    } else {
      rail.dataset.state = "idle";
      txt.textContent = "";
      count.textContent = "";
    }
  }

  /*
   * The scanner's work channel, reconciled against real job state. A job that is RUNNING lights it
   * and names the move in flight; a job waiting on the user does not, because the green sweep is
   * reserved for "burning tokens right now" (see the CSS note) and a paused wait is the opposite.
   * No live job at all clears the channel, which is what finally turns the light off after a build
   * ends while the page was in the background.
   */
  function trackFlameFromJobs() {
    if (!window.ideFlame) return;
    const live = (state.jobs || []).filter((j) => !j.done);
    const working = live.find((j) => !j.waiting && jobUiState(j) === "running");
    if (!working) return window.ideFlame.track(false);
    const move = working.move && working.move.title ? working.move.title.slice(0, 40) : "";
    window.ideFlame.track(move || JOB_UI.running.label);
  }

  /*
   * Reconcile with the server. Called on boot, on becoming visible, and on pageshow. This IS the
   * "come back and it is still there" promise: the client keeps no build state of its own, it
   * simply asks what is true now.
   */
  /*
   * THE PROJECT LIST TRAVELS (Fred, 2026-08-01: "They do not seem to be loading the others
   * projects. The intent was to have any project seamlessly change from mobile to desktop and
   * desktop to mobile").
   *
   * Projects always lived on the server, keyed to the account, so both devices really were looking
   * at one list. The list was only ever FETCHED ONCE, during page boot. The recurring refresh and
   * the come-back-to-the-tab refresh both asked for jobs and nothing else. On a laptop that is
   * invisible, because tabs get closed and reopened all day. A phone resumes from the background
   * instead of reloading, so it could sit for days on the list it saw when it last cold-started,
   * and a project made on the laptop would never appear.
   *
   * This deliberately touches ONLY the workspace list. Prefs, routing and the assignment board are
   * left alone, because overwriting those from a background poll would yank settings out from
   * under someone mid-edit.
   */
  async function refreshWorkspaces() {
    if (!state.allowed) return false;
    let list;
    try {
      const r = await fetch("/ide/workspaces", { headers: { accept: "application/json" } });
      if (!r.ok) return false;
      const d = await r.json();
      list = Array.isArray(d.workspaces) ? d.workspaces : null;
    } catch { return false; }
    if (!list) return false;
    // updatedAt is in the signature so a project whose PLANNING STATE changed on another device
    // also counts as news, not just one that was renamed or moved.
    const before = JSON.stringify((state.workspaces || []).map((w) => [w.id, w.name, w.root, w.updatedAt]));
    const after = JSON.stringify(list.map((w) => [w.id, w.name, w.root, w.updatedAt]));
    state.workspaces = list;
    // A project deleted on another device must not stay selected here.
    if (state.workspaceId && !list.some((w) => w.id === state.workspaceId)) state.workspaceId = "";
    if (before === after) return false;
    renderStarter();
    // The Vibe project row paints itself; it listens rather than being reached into from here.
    document.dispatchEvent(new CustomEvent("dominion-workspaces-changed"));
    return true;
  }

  /*
   * WHOSE OUTCOME IS THIS? (Fred and a guest testing together, 2026-08-01: "both of us noticed a
   * warning at the bottom of the page before we even split the project into tasks".)
   *
   * /ide/jobs is per ACCOUNT on purpose: a build keeps running while you look at something else,
   * and the rail is meant to say so. But the status line and the journey phase describe THE
   * PROJECT ON SCREEN, and this function painted them from state.jobs[0] — the newest job
   * anywhere in the account, of any age. So opening a project that had never been built told you
   * "Build failed before completion. The work so far is saved." about some other project, on some
   * other day. Once that verdict also started being announced under the button, it arrived with
   * "Scroll up to the run for the reason" attached, pointing at a run that is not on this page.
   *
   * The rail keeps the whole account. The verdict is scoped to the project it belongs to.
   */
  const selectedWorkspaceId = () => (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
  function jobsHere() {
    const here = selectedWorkspaceId();
    if (!here) return [];
    return (state.jobs || []).filter((j) => j && j.workspaceId === here);
  }

  /*
   * An ended build is announced under the button only when it ENDED WHILE THIS PAGE WAS WATCHING.
   * A job this page has already seen in some other state and now sees terminal is news. A job that
   * was over before the page loaded is history, and history goes in the status line, quietly.
   */
  const jobSeen = new Map();

  async function refreshJobs() {
    if (!state.allowed) return;
    try {
      const r = await fetch("/ide/jobs", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const d = await r.json();
      state.jobs = d.jobs || [];
    } catch { return; }
    paintRail();
    renderAsk();
    trackFlameFromJobs();
    const mine = jobsHere();
    const latest = mine.find((j) => !j.done) || mine[0] || null;
    if (!latest) { clearBuildStatus(); return; }
    const kind = jobUiState(latest);
    const announce = jobSeen.has(latest.id) && jobSeen.get(latest.id) !== kind;
    jobSeen.set(latest.id, kind);
    if (kind === "running") {
      if (state.phase !== "verify") setJourneyPhase("build");
      return;
    }
    paintBuildStatus(kind, { announce });
    if (!latest.done) return setJourneyPhase("ready");
    setJourneyPhase(kind === "complete" ? "ship"
      : (intake.vision ? "ready" : (intake.messages.length ? "clarify" : "idea")));
  }

  // A frozen build asking for a human. Answering is one tap, and the card says plainly that
  // nothing is being spent while it waits, since that is the fact that makes walking away safe.
  function renderAsk() {
    const stage = $("#ide-stage");
    if (!stage) return;
    const asking = (state.jobs || []).find((j) => !j.done && j.waiting);
    const existing = stage.querySelector(".ide-ask");
    if (!asking) { if (existing) existing.remove(); return; }
    if (existing && existing.dataset.jobId === asking.id) return;
    if (existing) existing.remove();

    const q = asking.needsInput || {};
    const card = document.createElement("div");
    card.className = "ide-ask";
    card.dataset.jobId = asking.id;

    const h = document.createElement("h3");
    h.textContent = L("ask_title");
    const p = document.createElement("p");
    p.className = "q";
    p.textContent = q.question || "It needs an answer to continue.";

    const opts = document.createElement("div");
    opts.className = "opts";
    for (const opt of (q.options || [])) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      b.addEventListener("click", () => answerJob(asking.id, q.id, opt));
      opts.append(b);
    }

    const free = document.createElement("div");
    free.className = "free";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Or tell it what to do";
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Send";
    const send = () => { if (input.value.trim()) answerJob(asking.id, q.id, input.value.trim()); };
    go.addEventListener("click", send);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    free.append(input, go);

    const note = document.createElement("div");
    note.className = "cost-note";
    note.textContent = "This build is paused and spending nothing while it waits.";

    card.append(h, p, opts, free, note);
    stage.prepend(card);
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function answerJob(jobId, questionId, text) {
    window.ideFlame.show();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      await fetch("/ide/job/answer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, questionId, answer: text, ...forgeExecutionFields() }),
        signal: controller.signal,
      });
    } catch {} finally {
      clearTimeout(timeout);
      window.ideFlame.hide();
    }
    await refreshJobs();
  }

  /*
   * Push permission, asked at the first real build and never on page load: browsers penalize
   * load-time prompts and people refuse them reflexively. On iOS push only reaches a PWA that was
   * installed to the home screen, so there we say so plainly instead of pretending a notification
   * is on its way.
   */
  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  async function ensurePush() {
    if (state.askedPush || !state.allowed) return { ok: false, reason: "skipped" };
    state.askedPush = true;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return { ok: false, reason: "unsupported" };
    if (isIos() && !isStandalone()) {
      return { ok: false, reason: "ios_needs_install",
        message: "On iPhone, notifications only work once this app is added to your home screen." };
    }
    try {
      const keyRes = await fetch("/ide/push/key", { headers: { accept: "application/json" } });
      const info = keyRes.ok ? await keyRes.json() : {};
      if (!info.configured || !info.publicKey) return { ok: false, reason: "server_unconfigured" };
      state.pushKey = info.publicKey;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return { ok: false, reason: "denied" };
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(info.publicKey),
      });
      await fetch("/ide/push/subscribe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), label: navigator.platform || "device" }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "error", message: String(e && e.message) };
    }
  }

  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // Shown once, before the first build. This is the Replit conversation had up front: built on
  // YOUR computer, running is local, putting it online is a separate offered step.
  const INTRO_KEY = "dominion.crucible.intro.v1";
  function maybeShowIntro() {
    try { if (localStorage.getItem(INTRO_KEY) === "1") return; } catch {}
    /*
     * Never in beginner mode (Fred, 2026-07-24: the beginner screen is the conversation, the saved
     * projects, the help button, "thats it, nothing else"). Everything this card explains is said in
     * the conversation itself, at the moment it matters: the interviewer covers what the app will
     * be, and the build path says plainly when the computer is not connected.
     */
    if (state.mode === "beginner") return;
    const stage = $("#ide-stage");
    if (!stage || $("#ide-intro")) return;
    const card = document.createElement("section");
    card.className = "ide-intro";
    card.id = "ide-intro";
    card.innerHTML = '<h3 data-lex="intro_title"></h3><p data-lex="intro_body"></p>'
      + '<button type="button" id="ide-intro-ok" data-lex="intro_ok"></button>';
    stage.prepend(card);
    paintLexicon();
    $("#ide-intro-ok").addEventListener("click", () => {
      try { localStorage.setItem(INTRO_KEY, "1"); } catch {}
      card.remove();
    });
  }

  // Draft persistence: save and load from localStorage.
  function saveDraft() {
    const prompt = $("#st-prompt").value.trim();
    const draft = { prompt, messages: intake.messages, vision: intake.vision, adopt: !!intake.adopt,
      adoptionContext: intake.adoptionContext || "", at: Date.now() };
    try { localStorage.setItem("dominion.crucible.draft.v1", JSON.stringify(draft)); } catch {}
  }
  function loadDraft() {
    try {
      const stored = localStorage.getItem("dominion.crucible.draft.v1");
      if (!stored) return null;
      const draft = JSON.parse(stored);
      if (!draft || !draft.at) return null;
      const age = Date.now() - draft.at;
      if (age > 48 * 3600 * 1000) return null;
      return draft;
    } catch { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem("dominion.crucible.draft.v1"); } catch {}
  }

  /*
   * Start fresh (Fred, phone pass 07-23): a restored dead build left the chat stuck with no
   * exit. One tap abandons the composing surface: draft gone (one-level backup kept for a fat
   * finger), interview reset, Howdy again, inputs live. Server-side jobs are untouched: this
   * clears the desk, it does not reach into the machine room.
   */
  function startFresh() {
    try { const d = localStorage.getItem("dominion.crucible.draft.v1"); if (d) localStorage.setItem("dominion.crucible.draft.bak", d); } catch {}
    clearDraft();
    intake.messages = [];
    intake.vision = null;
    intake.busy = false;
    intake.adopt = false;
    intake.adoptionContext = "";
    const log = $("#st-chat-log");
    if (log) log.textContent = "";
    const prompt = $("#st-prompt"); if (prompt) prompt.value = "";
    const chatIn = $("#st-chat-in"); if (chatIn) { chatIn.value = ""; chatIn.disabled = false; }
    const send = $("#st-chat-send"); if (send) send.disabled = false;
    const go = $("#st-go"); if (go) go.disabled = false;
    const actions = $("#st-chat-actions"); if (actions) actions.hidden = true;
    setJourneyPhase("idea");
    chatBubble("ai", L("howdy"));
    const status = $("#st-status"); if (status) status.textContent = L("fresh_done");
  }

  function openPanel() {
    if (!state.allowed || !state.engaged) return;
    if (state.open) return;
    // One reveal at a time. The dial and Forge Images each transform the same four shell
    // elements; two open at once would stack transform contexts and strand the shell off-screen.
    if (window.closeForgeDial) window.closeForgeDial();
    if (window.closeForgeImages) window.closeForgeImages();
    buildPanel();
    /*
     * The first question the surface asks is who it is talking to, ONCE PER SESSION (Fred,
     * 2026-07-24). A remembered mode is applied underneath first, so the welcome layer covers a
     * correctly-skinned screen and dismissing it never re-lays the page; only a session that has
     * already answered skips straight in.
     */
    const chosen = state.mode || readMode();
    if (chosen) applyMode(chosen, { save: false });
    if (welcomedThisSession()) {
      if (chosen) maybeShowIntro();
      else showModePicker();
    } else {
      showModePicker();
    }
    // Restore draft if it exists.
    const draft = loadDraft();
    let hasConversation = false;
    if (draft && draft.prompt) {
      // A prompt on its own restores the box and nothing else: no chat, no answer row, because no
      // conversation happened yet. A draft that carries messages IS a conversation, so its chat and
      // its answer row both come back.
      $("#st-prompt").value = draft.prompt;
      if (draft.messages && draft.messages.length > 0) {
        intake.messages = draft.messages;
        intake.vision = draft.vision || null;
        intake.adopt = !!draft.adopt;
        intake.adoptionContext = String(draft.adoptionContext || "");
        hasConversation = true;
        const log = $("#st-chat-log");
        if (log) {
          log.textContent = "";
          for (const msg of draft.messages) {
            if (msg.role === "user") {
              chatBubble("user", msg.content);
            } else if (msg.role === "assistant") {
              const before = msg.content.split("VISION READY\n");
              if (before[0]) chatBubble("ai", before[0].replace(/MOCKUP: .+\n/g, ""));
              if (before[1] && intake.vision) visionCard(intake.vision);
            }
          }
        }
        const status = $("#st-status");
        if (status) status.textContent = L("draft_restored");
        // A restored conversation is a running interview, so the chat input asks for an answer.
        paintLexicon();
        setJourneyPhase(intake.vision ? "ready" : "clarify");
      }
    }
    // Opening beat: if chat log is empty (no draft with messages), show the howdy bubble.
    if (!hasConversation) {
      const log = $("#st-chat-log");
      if (log && log.textContent.trim() === "") {
        chatBubble("ai", L("howdy"));
      }
    }
    // Paint from whatever is true right now. The panel is built lazily, so anything reconciled
    // while it did not exist (a question that arrived while the works were closed) has to be
    // drawn on the way in, or it stays invisible until the next poll.
    renderAsk();
    refreshJobs();
    // Every entrance starts at the top of the page (Fred, layout pass 07-23): a stage scrolled
    // from last time would otherwise open mid-content.
    const stage = $("#ide-stage");
    if (stage) stage.scrollTop = 0;
    state.open = true;
    document.body.classList.add("ide-anim");
    // Force a style flush between the two classes so the lift transitions instead of jumping.
    void $("#ide-root").offsetWidth;
    document.body.classList.add("ide-open");
    // The guided tour listens for this; it decides for itself whether to appear. While the welcome
    // layer is up nothing else may claim the screen, so the choice fires it instead.
    if (chosen && !$("#cw")) document.dispatchEvent(new CustomEvent("dominion-crucible-open"));
  }

  function closePanel() {
    if (!state.open) return;
    closeStudio();
    state.open = false;
    if (nodePollingInterval) clearInterval(nodePollingInterval);
    nodePollingInterval = 0;
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
    announceIdeState();
    if (!state.engaged) closePanel();
    else if (reveal) openPanel();
    // Remember it on the ACCOUNT too, so flipping it on the laptop is already on when the phone
    // opens (ledger L-5). The local copy stays authoritative for the first paint: the switch must
    // never wait on a network round trip to look right.
    // `push` is what separates a choice from an echo: a user flipping the switch pushes, while
    // adopting the account's own answer does not. Only a real choice is stamped.
    if (push) stampChoice();
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
      const [s] = await Promise.all([
        fetch("/ide/state", { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)),
        loadCatalog(),
      ]);
      if (!s) return;
      state.routing = s.routing || null;
      // Where this account's files actually live. `workshop` means the server-side sandbox, which
      // changes what the folder row asks for and what the machine-only surfaces are allowed to
      // promise (Fred, 2026-07-30).
      state.workshop = s.workshop === true;
      state.hasNode = s.hasNode === true;
      // Both come from the server on every sync rather than being inferred here, so a node that
      // connects or drops mid-session moves the control without a reload.
      state.canChooseLane = s.canChooseLane === true;
      state.buildWhere = s.buildWhere === "cloud" ? "cloud" : "mine";
      state.workspaces = s.workspaces || [];
      const ws = state.workspaces[0] || null;
      state.workspaceId = ws ? ws.id : "";
      renderStarter();
      const stored = (ws && ws.assignments) || (s.prefs && s.prefs.assignments) || {};
      state.allInOne = stored.allInOne || "";
      state.assignments = {};
      for (const cls of CARD_ORDER) {
        if (cls === "design_visual") continue;
        state.assignments[cls] = typeof stored[cls] === "string"
          ? stored[cls]
          : ((s.routing && s.routing.defaults && s.routing.defaults[cls]) || "");
      }
      if ($("#ide-cards")) renderBoard();

      /*
       * WHICHEVER CHOICE IS NEWER WINS (Fred, 2026-08-01). The rule was meant to be "the person
       * holding this phone gets the last word", and it was implemented as "any device that has ever
       * chosen keeps its answer forever". So a phone that once picked Beginner could never follow
       * the laptop into Vibe Coder, and Beginner has no project row on it: the phone looked like it
       * had lost Crucible entirely. Both sides now carry a timestamp, and the later one wins.
       */
      const localChoiceAt = (() => { try { return Number(localStorage.getItem(CHOICE_AT_KEY) || 0) || 0; } catch { return 0; } })();
      const accountChoiceAt = Number((s.prefs && s.prefs.at) || 0);
      const accountIsNewer = accountChoiceAt > localChoiceAt;
      const deviceHasOpinion = (() => { try { return localStorage.getItem(ENGAGED_KEY) !== null; } catch { return false; } })();
      if ((!deviceHasOpinion || accountIsNewer) && s.prefs && typeof s.prefs.engaged === "boolean") {
        setEngaged(s.prefs.engaged === true, { reveal: false, push: false });
      }
      if ((!readMode() || accountIsNewer) && s.prefs && MODES.includes(s.prefs.mode)) {
        state.mode = s.prefs.mode;
        try { localStorage.setItem(MODE_KEY, s.prefs.mode); } catch {}
      }
      // Engineer gate lapse: the server serves engineerLocked when top-off was disarmed. This
      // device drops out of Engineer immediately and shows the enable panel once.
      if (s.prefs && s.prefs.engineerLocked && (readMode() === "engineer" || state.mode === "engineer")) {
        state.mode = "vibe";
        try { localStorage.setItem(MODE_KEY, "vibe"); } catch {}
        showTopoffPanel(s.prefs.engineerLocked);
      }
      // Launch gate (Fred, 2026-07-25): Engineer greyed as Coming Soon for guests until the
      // rebuild ships. The grey is honesty; the server 403 is the actual wall.
      if (s.engineerComingSoon) {
        state.engineerComingSoon = true;
        if (readMode() === "engineer" || state.mode === "engineer") {
          state.mode = "vibe";
          try { localStorage.setItem(MODE_KEY, "vibe"); } catch {}
        }
        paintEngineerLaunchGate();
      }
      if (state.open && (state.mode || readMode())) applyMode(state.mode || readMode(), { save: false });
      announceIdeState();
    } catch {}
  }

  function init() {
    state.engaged = readEngaged();
    initToggleRow();
    initTrigger();
    initRail();
    paintToggle();
    loadAllowed().then(() => refreshJobs());
  }

  // Escape closes the works or the AF panel. Registered WITHOUT capture so the dial and askText
  // (both capture:true) keep their precedence; mutual exclusion means only one reveal is ever open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const studio = $("#st-studio-shell");
      const afPanel = $("#af-panel");
      if (studio && !studio.hidden) {
        e.preventDefault();
        closeStudio();
      } else if (afPanel && afPanel.classList.contains("af-open")) {
        e.preventDefault();
        closeAFPanel();
      } else if (state.open) {
        e.preventDefault();
        closePanel();
      }
    }
  });

  // The engine and its lenses advance the same explicit journey; completion is not inferred from
  // a success-colored card or a hidden button.
  document.addEventListener("dominion-build-verifying", () => setJourneyPhase("verify"));
  document.addEventListener("dominion-build-done", () => {
    setJourneyPhase("ship");
    paintBuildStatus("complete");
    clearDraft();
  });
  document.addEventListener("dominion-build-checkpointed", () => {
    paintBuildStatus("checkpointed");
    setJourneyPhase("ready");
  });
  document.addEventListener("dominion-build-paused", () => {
    paintBuildStatus("paused");
    setJourneyPhase("ready");
  });
  document.addEventListener("dominion-build-ended", (e) => {
    const outcome = String((e && e.detail && e.detail.outcome) || "").toLowerCase();
    paintBuildStatus(outcome === "stopped" ? "stopped"
      : (outcome === "paused" || outcome === "paused_budget") ? "paused"
      : (outcome === "checkpoint" || outcome === "checkpointed") ? "checkpointed"
      : "failed");
    setJourneyPhase(intake.vision ? "ready" : (intake.messages.length ? "clarify" : "idea"));
  });

  // The reattach triad. A build that ran while the app was closed reappears on the next of these.
  /*
   * Coming back to the app re-reads the PROJECT LIST as well as the jobs. `pageshow` is the one
   * that matters most on a phone: an installed app resuming from the background fires it without
   * ever reloading the page, which is precisely the case that used to show a days-old list.
   */
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshJobs(); refreshWorkspaces(); } });
  window.addEventListener("pageshow", () => { refreshJobs(); refreshWorkspaces(); });
  setInterval(() => { if (!document.hidden && state.allowed && state.engaged) { refreshJobs(); refreshWorkspaces(); } }, 20000);

  // A tapped notification focuses the tab already open and tells it where to go, rather than
  // stacking up new windows.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "ide-open") { setEngaged(true, { reveal: true }); refreshJobs(); }
    });
  }
  // Cold start from a notification: /?ide=1&job=...
  try {
    if (new URLSearchParams(location.search).get("ide") === "1") {
      setTimeout(() => setEngaged(true, { reveal: true }), 400);
    }
  } catch {}

  window.openIdeMode = openPanel;
  window.closeIdeMode = closePanel;
  window.ideModeEngaged = () => state.engaged;
  // The Command Rail needs both facts (it inherited them from the retired compass): ALLOWED
  // decides whether The Crucible entry may act at all, and programmatic engage lets a deliberate
  // tap turn the mode on instead of silently hitting openPanel's engaged gate (the compass-era
  // live bug: left and right worked, up did nothing).
  window.ideModeAllowed = () => state.allowed;
  window.ideModeSetEngaged = (on) => setEngaged(!!on, { reveal: false, push: true });
  window.ideRefreshJobs = refreshJobs;
  window.ideEnsurePush = ensurePush;
  window.ideForgeExecutionFields = forgeExecutionFields;
  window.ideJobUiState = jobUiState;
  window.dominionStudioHas = (module) => state.mode !== "vibe" || state.studio.modules.has(module);
  window.dominionJourneyPhase = () => state.phase;

  /*
   * The bridge the beginner surface builds on (dominion-beginner.js). It deliberately exposes
   * BEHAVIOUR, not internals: the beginner screen never reaches into this module's DOM or state, so
   * the two can be reasoned about separately and the expert page keeps working untouched.
   */
  window.dominionIdeBridge = {
    mode: () => state.mode,
    setMode: (m) => applyMode(m),
    workspaces: () => (state.workspaces || []).slice(),
    workspaceId: () => (($("#st-ws") && $("#st-ws").value) || state.workspaceId || ""),
    // Selecting a saved project routes through the real select so every other reader (the build
    // path, the folder drawer, drafts) sees the same choice.
    selectWorkspace: (id) => {
      const sel = $("#st-ws");
      if (sel && [...sel.options].some((o) => o.value === id)) {
        sel.value = id; state.workspaceId = id;
        /*
         * The verdict is scoped to the project, so CHANGING the project has to repaint it now.
         * Without this the scoping is still correct and still twenty seconds late: you move to a
         * project that has never been built and the last one's failure sits there until the next
         * poll, which is precisely the window in which somebody reads it and believes it.
         */
        refreshJobs();
        return true;
      }
      return false;
    },
    // Make a project folder for a beginner who has none, exactly as the silent auto-path does.
    autoWorkspace: async (hint) => {
      const r = await fetch("/ide/workspace/auto", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hint: hint || "" }) });
      const j = await r.json();
      if (j && j.ok && j.workspace) {
        state.workspaces.push(j.workspace);
        state.workspaceId = j.workspace.id;
        renderStarter();
      }
      return j || {};
    },
    /*
     * Register a workspace the CALLER already created on the server (the Vibe adopt browse does
     * this via POST /ide/workspace). Without it the new project exists server-side while every
     * picker painted from workspaces() lacks it, so selecting it was silently impossible: the
     * exact bug Fred hit picking an F:\ folder on 2026-07-26.
     */
    addWorkspace: (ws) => {
      if (!ws || !ws.id) return;
      if (!state.workspaces.some((w) => w.id === ws.id)) state.workspaces.push(ws);
      state.workspaceId = ws.id;
      renderStarter();
    },
    /*
     * The spend limit for ONE project, in dollars on the wire (the UI speaks credits to guests and
     * converts). capUsd 0 means no limit, which is what budgetCheck already treats as unlimited.
     *
     * This is the arming switch for a brake that already existed and was never pulled: a new
     * project carries no budget, budgetCheck opens with `if (capUsd <= 0) return stop:false`, and
     * a build quoted at $0.30 ran to $9 with nothing between it and the card (Fred, 2026-07-31).
     * The limit is the user's number and carries no ceiling of ours.
     */
    setBudget: async (capUsd) => {
      const id = (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
      if (!id) return { error: "no_workspace" };
      const cap = Math.max(0, Number(capUsd) || 0);
      const r = await fetch("/ide/workspace/update", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, budget: cap > 0 ? { capUsd: cap } : null }) });
      const j = await r.json().catch(() => ({}));
      const w = (state.workspaces || []).find((x) => x.id === id);
      if (w && j && j.ok) w.budget = cap > 0 ? { capUsd: cap } : null;
      return j || {};
    },
    budgetUsd: () => {
      const id = (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
      const w = (state.workspaces || []).find((x) => x.id === id);
      return Number(w && w.budget && w.budget.capUsd) || 0;
    },
    /*
     * SHIP TO GITHUB, per project (Fred, 2026-08-01). Off unless it is switched on, and read back
     * from the workspace record rather than from a local preference, so the answer to "will this
     * build push my code?" is the same on the phone and the laptop.
     */
    shipToGithub: () => {
      const id = (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
      const w = (state.workspaces || []).find((x) => x.id === id);
      return !!(w && w.ship && w.ship.github);
    },
    setShipToGithub: async (on) => {
      const id = (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
      if (!id) return { error: "no_workspace" };
      // `private: true` is not offered as a choice here on purpose: a repo created public by
      // mistake cannot be un-leaked, and nobody has asked for public repos yet.
      const ship = on ? { github: true, private: true, repo: "" } : null;
      const r = await fetch("/ide/workspace/update", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ship }) });
      const j = await r.json().catch(() => ({}));
      const w = (state.workspaces || []).find((x) => x.id === id);
      if (w && j && j.ok) w.ship = ship;
      return j || {};
    },
    // Is a GitHub account actually connected? The switch says so plainly rather than letting a
    // build get all the way to the push before discovering there is no account behind it.
    githubConnected: async () => {
      try {
        const r = await fetch("/connectors", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        const row = ((j && j.connectors) || []).find((c) => c && c.id === "github");
        // Matches connectors.usable(): credentials present AND this account is allowed to use it.
        // The separate on/off `enabled` toggle is deliberately NOT required, because secretFor()
        // does not require it either, and a switch that disagrees with the engine is worse than none.
        return !!(row && row.configured && row.usable !== false);
      } catch { return false; }
    },
    startBuild: (prompt, status) => startBuild(prompt, status || (() => {})),
    jobs: () => (state.jobs || []).slice(),
    refreshJobs,
    follow: (jobId, opts) => { if (window.dominionLenses) window.dominionLenses.follow(jobId, opts); },
    journey: (phase) => setJourneyPhase(phase),
    startFresh,
    // ---- added for the Vibe surface (docs/VIBE-CODER-SOW.md) --------------------------------
    // The grouped model catalog, one load for the whole panel (carries orchestratorOk per model).
    models: () => (state.catalog || []).slice(),
    /*
     * The Agent Army writes THROUGH the same assignments contract the AF window uses, so the build
     * engine sees one shape no matter which surface set it. saveAF replaces the af block wholesale;
     * clearAF is the Agent-Crew-unchecked rule made real: with no af block, startBuild runs the
     * default AI over the whole job, autonomously, exactly as before the crew existed.
     */
    getAF: () => (state.assignments.af ? JSON.parse(JSON.stringify(state.assignments.af)) : null),
    // Both return the save promise, and both accept the workspace the caller means, so an approved
    // plan can be pinned to the folder a build is about to run in rather than the one that happened
    // to be selected when the user was still picking models.
    saveAF: (af, targetWorkspaceId) => { state.assignments.af = af; return saveAssignments(targetWorkspaceId); },
    clearAF: (targetWorkspaceId) => { delete state.assignments.af; return saveAssignments(targetWorkspaceId); },
    /*
     * The workspace a build will ACTUALLY use. startBuild reads the starter's select, while the
     * Vibe surface tracks its own selection, and the two could disagree the moment a folder was
     * auto-created (the select had not been repainted yet). One getter, consulted by both, so the
     * plan and the build can never be pinned to different folders.
     */
    buildWorkspaceId: () => (($("#st-ws") && $("#st-ws").value) || state.workspaceId || ""),
    /*
     * A project's Crucible state, stored beside the project itself so it reaches every device the
     * account signs in from (Fred, 2026-08-01). Reading is free: the workspace list already carries
     * it. Writing returns a result rather than a promise of silence, because a planning
     * conversation that failed to sync must be able to say so.
     */
    refreshWorkspaces,
    crucibleFor: (wsId) => {
      const w = (state.workspaces || []).find((x) => x.id === wsId);
      return (w && w.crucible) || null;
    },
    saveCrucible: async (wsId, blob) => {
      if (!wsId) return { ok: false, error: "No project is selected, so there is nowhere to save this." };
      try {
        const r = await fetch("/ide/workspace/update", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: wsId, patch: { crucible: blob } }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) return { ok: false, error: j.error || "The project could not be saved.", code: j.code || "" };
        // Keep the local copy in step so a refresh does not immediately read back the old one.
        const w = (state.workspaces || []).find((x) => x.id === wsId);
        if (w) { w.crucible = blob; if (j.workspace && j.workspace.updatedAt) w.updatedAt = j.workspace.updatedAt; }
        return { ok: true };
      } catch { return { ok: false, error: "The server could not be reached, so this is saved on this device only." }; }
    },
    studioModules: () => [...state.studio.modules],
    studioPreset: () => state.studio.preset,
    /*
     * The full record for the project on screen, not just its id (Fred, 2026-08-01: the planner
     * "is not aware of which folder was chosen or what its contents are"). Surfaces need the name,
     * the folder and the machine to SAY where a build lands; the wire needs the id so the server
     * can look the same record up for itself and never trust a client-supplied path.
     */
    workspaceInfo: () => {
      const id = (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
      const w = (state.workspaces || []).find((x) => x.id === id);
      if (!w) return null;
      return { id: w.id, name: w.name || w.id, root: w.root || "", node: w.node || "",
        cloud: w.node === "workshop", budgetUsd: Number(w.budget && w.budget.capUsd) || 0 };
    },
    /*
     * A live peek inside the chosen folder, straight from the user's own machine. Deterministic,
     * free, and no model call: the surface can show that the folder is understood before anyone
     * spends money proving it in conversation.
     */
    peekProject: async (id) => {
      const wsId = id || (($("#st-ws") && $("#st-ws").value) || state.workspaceId || "");
      if (!wsId) return { error: "no_workspace" };
      try {
        const r = await fetch("/ide/project/peek", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: wsId }) });
        return (await r.json()) || {};
      } catch { return { error: "The workshop could not be reached." }; }
    },
    // The names of the modules that are ticked, in the viewer's own register, for the settings
    // block that rides to the planner. Ids like "crew" mean nothing to a model or to a person.
    studioModuleLabels: () => STUDIO_MODULES.filter((m) => state.studio.modules.has(m.id)).map((m) => L(m.title)),
    // The vibe surface draws its own Customize Your Workspace panel; the choice still lives HERE,
    // in the one studio state every gate reads (dominion-studio-changed fires from paintStudio).
    setStudioModules: (modules) => {
      const valid = new Set(STUDIO_MODULES.map((m) => m.id));
      state.studio.modules = new Set((modules || []).filter((id) => valid.has(id)));
      state.studio.preset = studioPresetFor(state.studio.modules);
      saveStudio();
      paintStudio();
    },
    studioPresets: () => JSON.parse(JSON.stringify(STUDIO_PRESETS)),
    /*
     * The chat hand-off, for the Vibe surface (Fred, 2026-07-31: "it just opened the screen with
     * no plan"). The brief used to land only in the classic starter's textarea, which the Vibe
     * surface never reads — the plan was genuinely lost the moment Vibe Coder was picked. Now the
     * surface asks for it on open and clears it once consumed, so a later manual visit to Vibe
     * does not replay an old plan.
     */
    pendingPlan: () => (pendingHandoff ? { ...pendingHandoff } : null),
    clearPendingPlan: () => { pendingHandoff = null; },
    // Remove a project pointer (the folder and its files stay on disk; the server says the same).
    removeWorkspace: async (id) => {
      const r = await fetch("/ide/workspace/delete", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && !j.error) {
        state.workspaces = (state.workspaces || []).filter((w) => w.id !== id);
        if (state.workspaceId === id) state.workspaceId = "";
        renderStarter();
      }
      return j || {};
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
