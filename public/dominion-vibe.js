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
  const WNAME = { main: "Main AI", second: "Second AI", third: "Third AI" };
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
        vision: state.vision, at: Date.now(),
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
        // Fred: "TBD is just a placeholder for now." A visibly inert reserved slot beats an
        // invented feature; it does nothing and says so on hover.
        '<div class="vb-square vb-tbd" title="Reserved. Fred has not decided what lives here yet." aria-hidden="true"><span>TBD</span></div>' +
        '<button type="button" class="vb-small" id="vb-startover">Start Over</button>' +
        '<label class="vb-small vb-saveto">Save to: <select id="vb-saveto" aria-label="Which project folder the build lands in"></select></label>' +
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
    const optional = w === "main" ? "" : ' <em>(optional)</em>';
    return (
      '<section class="vb-win vb-win-' + w + '" id="vb-win-' + w + '" data-win="' + w + '">' +
        '<header class="vb-win-head">' +
          '<select class="vb-win-model" id="vb-model-' + w + '" aria-label="Model for the ' + WNAME[w] + '"></select>' +
          '<b>' + WNAME[w] + optional + '</b>' +
          (w === "main" ? "" : '<button type="button" class="vb-win-toggle" data-win="' + w + '" aria-expanded="false">Open</button>') +
        '</header>' +
        '<div class="vb-win-body" id="vb-body-' + w + '"' + (w === "main" ? "" : " hidden") + '>' +
          '<div class="vb-log" id="vb-log-' + w + '" aria-live="polite"></div>' +
          '<div class="vb-grab" data-win="' + w + '" title="Drag to make this window taller" aria-hidden="true"><i></i></div>' +
          '<div class="vb-row">' +
            '<textarea id="vb-in-' + w + '" rows="1" placeholder="Type here…" aria-label="Message for the ' + WNAME[w] + '"></textarea>' +
            '<div class="vb-sendstack" id="vb-sendstack-' + w + '">' +
              '<button type="button" class="vb-send" id="vb-send-' + w + '">Send</button>' +
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
    if (!has && bridge()) { bridge().clearAF(); state.army = null; }
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
  function renderLog(w) {
    const log = $("#vb-log-" + w);
    if (!log) return;
    log.textContent = "";
    for (const m of state.chats[w].messages) {
      const cls = m.from === "user" ? "vpb-user"
        : m.from === w ? "vpb-ai"
        : "vpb-from vpb-from-" + m.from;
      const b = bubble(w, cls, m.content);
      if (b && m.from !== "user" && m.from !== w) {
        const tag = document.createElement("small");
        tag.className = "vpb-tag";
        tag.textContent = WNAME[m.from] + " · opinion";
        b.prepend(tag);
      }
    }
    if (w === "main" && state.vision) visionCard();
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
        body: JSON.stringify({ window: w, model: c.model || "", messages: c.messages, register: reg(), mode: "vibe", device: device() }) });
      j = await r.json();
    } catch { j = { error: "The workshop could not be reached. Try again." }; }
    t.remove();
    c.busy = false;
    if (!j || j.error) { bubble(w, "vpb-ai vpb-err", (j && j.error) || "Something went wrong."); return; }
    c.messages.push({ from: w, content: (j.reply || "") + (j.vision ? "\nVISION READY\n" + j.vision : "") });
    if (j.reply) bubble(w, "vpb-ai", j.reply);
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

    const closeMenu = () => { menu.hidden = true; menu.textContent = ""; };

    const deliver = (target) => {
      const text = (input.value || "").trim();
      closeMenu();
      if (target === w) {
        if (!text || state.chats[w].busy) return;
        input.value = ""; input.style.height = "";
        state.chats[w].messages.push({ from: "user", content: text });
        bubble(w, "vpb-user", text);
        saveDraft();
        askWindow(w);
        return;
      }
      // Crossing windows: the typed text if there is one, else this window's last AI reply.
      let payload = text;
      if (!payload) {
        const last = [...state.chats[w].messages].reverse().find((m) => m.from === w);
        payload = last ? (typeof last.content === "string" ? last.content : "") : "";
      }
      if (!payload) { status("Nothing to send yet from the " + WNAME[w] + "."); return; }
      input.value = ""; input.style.height = "";
      state.chats[target].messages.push({ from: w, content: payload });
      if (!state.chats[target].open) toggleWin(target, true);
      renderLog(target);
      saveDraft();
      askWindow(target);
    };

    send.addEventListener("click", () => {
      if (!menu.hidden) { deliver(w); return; }   // second press = send here
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
      menu.hidden = false;
      // Anywhere else closes the stack; capture so a tap on another window's send does not stack two.
      setTimeout(() => {
        const away = (e) => { if (!menu.contains(e.target) && e.target !== send) { closeMenu(); document.removeEventListener("pointerdown", away, true); } };
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
    if (btn) { btn.textContent = c.open ? "Close" : "Open"; btn.setAttribute("aria-expanded", String(c.open)); }
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
    if (!goal) { status("Tell the Main AI what you want built first.", true); return; }
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
    const goal = goalText();
    if (!goal) { status("Tell the Main AI what you want built first.", true); return; }
    // The Save to: pick is the folder; none picked means one is made, same as the beginner path.
    const saveTo = $("#vb-saveto").value;
    if (saveTo) b.selectWorkspace(saveTo);
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
    const full = state.vision ? goal + "\n\nAGREED VISION (approved by the user; build exactly this):\n" + state.vision : goal;
    status("Starting…");
    b.startBuild(full, (msg, bad) => status(msg || "", bad));
  }

  /* ================= wiring ================================================================== */

  function wire() {
    wireSliderDrag($("#vb-slider"));
    $("#vb-new").addEventListener("click", newProject);
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
  document.addEventListener("dominion-ide-state", () => { if (state.open) { renderSlider(); renderSaveTo(); paintAllModelSelects(); } });
  document.addEventListener("dominion-studio-changed", () => { if (state.open) { gateArmy(); paintDesignations(); } });

  window.dominionVibe = { open, close };
})();
