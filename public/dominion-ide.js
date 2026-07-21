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

  const state = {
    allowed: false, engaged: false, open: false,
    routing: null,        // class labels/blurbs/defaults, from the server
    catalog: [],          // the model list, from the SAME /api/models the chat picker uses
    assignments: {},      // class -> model id ("" means follow the main model)
    allInOne: "",         // one model for every text class, or "" for the board
    workspaceId: "",      // assignments belong to a workspace once one exists
    jobs: [],             // every job on this ACCOUNT, not just the one on screen
    workspaces: [],       // the account's workspace pointers, for the front door
    pushKey: "",          // VAPID applicationServerKey, "" when push is not configured
    askedPush: false,     // permission is requested at the first real build, never on load
  };

  const $ = (sel) => document.querySelector(sel);
  // Every user-facing string on this surface goes through the register dictionary.
  const L = (k) => (window.DominionLexicon ? window.DominionLexicon.L(k) : k);
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
    stage.append(buildStarter(), buildBoard());

    root.append(rail, stage);
    document.body.append(root);

    back.addEventListener("click", closePanel);
    close.addEventListener("click", closePanel);

    renderBoard();
    renderStarter();
    wireStarter();
    wireProbe();
    const all = $("#ide-allinone");
    if (all) all.addEventListener("change", () => {
      state.allInOne = all.value;
      // With one model driving everything, the per-class pickers stop being the operative control,
      // so they are disabled rather than left looking live while being ignored.
      for (const sel of document.querySelectorAll("#ide-cards select")) sel.disabled = !!state.allInOne;
      saveAssignments();
    });
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


  // Assignments belong to the workspace. With no workspace yet they are held as the account's
  // starting point, so the board is usable before the first project exists.
  function saveAssignments() {
    const body = { assignments: { ...state.assignments, allInOne: state.allInOne || "" } };
    const wsId = state.workspaceId;
    const url = wsId ? "/ide/workspace/update" : "/ide/prefs";
    const payload = wsId ? { id: wsId, patch: body } : { engaged: state.engaged, ...body };
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .catch(() => {});
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
            priceShort: priced ? "$" + inC + "/$" + outC : "",
            priceLong: priced ? "$" + inC + " in / $" + outC + " out per million tokens" : "",
            unavailable: !hasKey(m.provider),
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
      '<h3 data-lex="start_heading"></h3>' +
      '<div class="st-row st-lang">' +
        '<span class="st-lang-label" data-lex="lang_label"></span>' +
        '<select id="st-lang" aria-label="How Dominion talks to you">' +
          '<option value="plain"></option><option value="technical"></option><option value="hybrid"></option>' +
        '</select>' +
      '</div>' +
      '<div class="st-row">' +
        '<select id="st-ws" aria-label="Which project folder to build in"></select>' +
        '<button type="button" id="st-add" data-lex="add_folder"></button>' +
      '</div>' +
      '<div class="st-new" id="st-new" hidden>' +
        '<input id="st-new-path" type="text" autocomplete="off" spellcheck="false" />' +
        '<input id="st-new-name" type="text" autocomplete="off" placeholder="Name (optional)" />' +
        '<button type="button" id="st-new-go" data-lex="use_folder"></button>' +
      '</div>' +
      '<textarea id="st-prompt" rows="3"></textarea>' +
      '<div class="st-row">' +
        '<button type="button" id="st-go" class="st-primary" data-lex="start_go"></button>' +
        '<span class="st-status" id="st-status" role="status"></span>' +
      '</div>';
    return el;
  }

  // Pour the chosen register into every tagged element. One function, called on mount and on
  // every register change, so no string can be left behind in the old voice.
  function paintLexicon() {
    for (const el of document.querySelectorAll("[data-lex]")) el.textContent = L(el.dataset.lex);
    const prompt = $("#st-prompt");
    if (prompt) prompt.placeholder = L("start_prompt_ph");
    const path = $("#st-new-path");
    if (path) path.placeholder = L("folder_ph");
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

  function renderStarter() {
    const sel = $("#st-ws");
    if (!sel) return;
    paintLexicon();
    sel.textContent = "";
    if (!state.workspaces.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = L("no_folder_yet");
      sel.append(o);
    }
    for (const w of state.workspaces) {
      const o = document.createElement("option");
      o.value = w.id;
      o.textContent = w.name + "  (" + w.root + ")";
      if (w.id === state.workspaceId) o.selected = true;
      sel.append(o);
    }
  }

  function wireStarter() {
    const status = (msg, bad) => { const el = $("#st-status"); if (el) { el.textContent = msg || ""; el.classList.toggle("bad", !!bad); } };

    $("#st-add").addEventListener("click", () => { const n = $("#st-new"); n.hidden = !n.hidden; if (!n.hidden) $("#st-new-path").focus(); });

    $("#st-lang").addEventListener("change", async () => {
      const reg = $("#st-lang").value;
      if (window.DominionLexicon) window.DominionLexicon.set(reg);
      paintLexicon();
      // The server phrases its own sentences (questions, endings), so it needs the choice too.
      try {
        await fetch("/ide/prefs", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ engaged: state.engaged, language: reg }) });
      } catch {}
    });

    $("#st-new-go").addEventListener("click", async () => {
      const root = $("#st-new-path").value.trim();
      const name = $("#st-new-name").value.trim();
      if (!root) { status("Type the folder path first.", true); return; }
      try {
        const r = await fetch("/ide/workspace", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, root }) });
        const j = await r.json();
        if (!r.ok || j.error) { status(j.error || "That folder could not be added.", true); return; }
        state.workspaces.push(j.workspace);
        state.workspaceId = j.workspace.id;
        renderStarter();
        $("#st-new").hidden = true;
        $("#st-new-path").value = ""; $("#st-new-name").value = "";
        status("Folder added.");
      } catch { status("The server could not be reached.", true); }
    });

    $("#st-go").addEventListener("click", async () => {
      const workspaceId = $("#st-ws").value;
      const prompt = $("#st-prompt").value.trim();
      if (!workspaceId) { status("Pick or add a folder first.", true); return; }
      if (!prompt) { status("Say what you want built.", true); return; }
      const go = $("#st-go");
      go.disabled = true;
      status("Starting...");
      try {
        const r = await fetch("/ide/job", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "build", workspaceId, prompt }) });
        const j = await r.json();
        if (!r.ok || j.error) { status(j.error || "The build could not start.", true); go.disabled = false; return; }
        status("");
        $("#st-prompt").value = "";
        state.workspaceId = workspaceId;
        // The permission moment: the FIRST real build is when notifications become worth having,
        // and a prompt at page load is when people reflexively refuse them.
        ensurePush().then((p) => {
          if (p && p.reason === "ios_needs_install" && p.message) status(p.message);
        });
        if (window.dominionLenses) { window.dominionLenses.follow(j.jobId); }
        refreshJobs();
      } catch { status("The server could not be reached.", true); go.disabled = false; }
    });
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
    rail.classList.toggle("on", state.allowed && state.engaged && live.length > 0);
    const txt = rail.querySelector(".txt"), count = rail.querySelector(".count");
    if (asking) {
      rail.dataset.state = "waiting";
      txt.textContent = "Needs you";
      count.textContent = "";
    } else if (live.length) {
      rail.dataset.state = "running";
      txt.textContent = live[0].move && live[0].move.title ? live[0].move.title.slice(0, 34) : "Building";
      count.textContent = live.length > 1 ? "+" + (live.length - 1) : "";
    } else {
      rail.dataset.state = "idle";
      txt.textContent = "";
      count.textContent = "";
    }
    paintLamp(asking ? "waiting" : (live.length ? "running" : "idle"), live.length);
  }

  function paintLamp(mode, n) {
    const lamp = $("#ide-lamp"), text = $("#ide-lamp-text");
    if (!lamp || !text) return;
    lamp.dataset.state = mode === "idle" ? "idle" : "live";
    text.textContent = mode === "waiting" ? "Waiting on you"
      : mode === "running" ? (n > 1 ? n + " running" : "Running") : "Standby";
  }

  /*
   * Reconcile with the server. Called on boot, on becoming visible, and on pageshow. This IS the
   * "come back and it is still there" promise: the client keeps no build state of its own, it
   * simply asks what is true now.
   */
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
    h.textContent = "Your build needs you";
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
  }

  async function answerJob(jobId, questionId, text) {
    try {
      await fetch("/ide/job/answer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, questionId, answer: text }),
      });
    } catch {}
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

  function openPanel() {
    if (!state.allowed || !state.engaged) return;
    if (state.open) return;
    // One reveal at a time. The dial and Forge Images each transform the same four shell
    // elements; two open at once would stack transform contexts and strand the shell off-screen.
    if (window.closeForgeDial) window.closeForgeDial();
    if (window.closeForgeImages) window.closeForgeImages();
    buildPanel();
    maybeShowIntro();
    // Paint from whatever is true right now. The panel is built lazily, so anything reconciled
    // while it did not exist (a question that arrived while the works were closed) has to be
    // drawn on the way in, or it stays invisible until the next poll.
    renderAsk();
    refreshJobs();
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
      const [s] = await Promise.all([
        fetch("/ide/state", { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)),
        loadCatalog(),
      ]);
      if (!s) return;
      state.routing = s.routing || null;
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

      const deviceHasOpinion = (() => { try { return localStorage.getItem(ENGAGED_KEY) !== null; } catch { return false; } })();
      if (!deviceHasOpinion && s.prefs && s.prefs.engaged === true) {
        setEngaged(true, { reveal: false, push: false });
      }
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

  // Escape closes the works. Registered WITHOUT capture so the dial and askText (both capture:true)
  // keep their precedence; mutual exclusion means only one reveal is ever open anyway, and the
  // state.open check makes this a no-op otherwise.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open) { e.preventDefault(); closePanel(); }
  });

  // The reattach triad. A build that ran while the app was closed reappears on the next of these.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshJobs(); });
  window.addEventListener("pageshow", () => refreshJobs());
  setInterval(() => { if (!document.hidden && state.allowed && state.engaged) refreshJobs(); }, 20000);

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
  window.ideRefreshJobs = refreshJobs;
  window.ideEnsurePush = ensurePush;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
