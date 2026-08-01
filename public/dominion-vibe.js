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
  // Guests read plan estimates in credits (Fred, 2026-07-30); see dominion-money.js for the rule.
  const money = () => window.DominionMoney || { cost: (u, o) => ((o && o.approx) ? "~" : "") + "$" + (Number(u) || 0).toFixed(2), inCredits: () => false };
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
    // `docs` is the reading desk (Fred, 2026-08-01): documents attached to the CONVERSATION, not
    // to one message, so a rank can be asked about a spec turn after turn. See the reading desk
    // section below.
    chats: {
      main: { messages: [], model: "", busy: false, open: true, docs: [] },
      second: { messages: [], model: "", busy: false, open: false, docs: [] },
      third: { messages: [], model: "", busy: false, open: false, docs: [] },
    },
    vision: null,
    // The plan carried over from the main chat, word for word (Fred, 2026-07-31: it used to
    // vanish the moment Vibe Coder opened). { name, brief } once a hand-off landed.
    plan: null,
    army: null,          // { tasks, picks[], orchestrator, fallbackNote } once planned
    armyBusy: false,
    // Adopt Existing Project (docs/ADOPT-EXISTING-SOW.md): { workspaceId, name, brief } once a
    // scan has landed. The brief seeds the Main window, every Main turn carries adopt on the
    // wire, and Begin Building bakes the brief into the build prompt for THAT workspace only.
    adopt: null,
  };

  const device = () => (window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 620 ? "mobile" : "desktop");

  /* ================= the reading desk ======================================================== */
  /*
   * Fred, 2026-08-01: "I want the user to be able to attach word, pdf, md, txt, or json files to
   * the General chat, and have it automatically detect them and have access to any tool necessary
   * to read and interpret them, then interact about them."
   *
   * The plan windows could receive typed words and nothing else. Anyone holding a written spec had
   * to paste it in, past a 4,000-character sanitizer that ate the rest without saying so.
   *
   * Every format is read HERE, on the device, through attach-extract.mjs: the same vendored pdf.js
   * and dependency-free zip reader the main chat has used since July. Two consequences worth the
   * detour: a document works with EVERY model, local ones included, because what crosses the wire
   * is plain text; and the server never grows a binary parser or a place to put uploaded files.
   * A scanned PDF has no text layer to extract, so it takes the existing /api/ocr door and comes
   * back as text like everything else, which is the "any tool necessary" part of the ask.
   *
   * The desk is per window and per conversation, NOT per message: a file stays attached until it
   * is taken off, and rides every turn. That is what makes "interact about them" work rather than
   * answering one question and forgetting.
   */
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  // Mirrors PLAN_MAX_DOCS / PLAN_DOC_CHARS in ideintake.mjs. Extracting to the same ceiling the
  // server enforces is the point: what the chip says was read is exactly what the model receives.
  const DESK_MAX_DOCS = 6;
  const DESK_DOC_CHARS = 60_000;
  // A whole desk of documents would blow the ~5MB localStorage budget the draft shares with the
  // transcript, so the draft keeps text up to this much and beyond it keeps the NAMES only, marked
  // as needing re-attachment. Losing a file silently would be worse than saying it must come back.
  const DESK_DRAFT_CHARS = 120_000;
  const DOC_TEXT_EXT = /\.(txt|md|markdown|csv|json|log|xml|yaml|yml|html|css|js|mjs|ts|py|sql|sh|ps1)$/i;
  const DOC_BINARY_EXT = /\.(pdf|docx|xlsx)$/i;

  let extractMod = null, pdfjsLib = null;
  const docsOf = (w) => (state.chats[w].docs = Array.isArray(state.chats[w].docs) ? state.chats[w].docs : []);

  // Read one file into { name, text, how }. `how` is shown on the chip so the person can tell an
  // extracted PDF from an OCR'd scan from a plain text read.
  async function readOneDocument(f) {
    const name = (f.name || "file").slice(0, 160);
    const isBinary = f.type === "application/pdf" || f.type === DOCX_MIME || f.type === XLSX_MIME || DOC_BINARY_EXT.test(name);
    if (isBinary) {
      if (!("DecompressionStream" in window)) throw new Error("this browser cannot unpack documents; paste the text instead");
      extractMod ||= await import("/attach-extract.mjs?v=2");
      const buf = await f.arrayBuffer();
      if (f.type === XLSX_MIME || /\.xlsx$/i.test(name)) {
        const r = await extractMod.extractXlsx(buf, { maxChars: DESK_DOC_CHARS });
        return { name, text: r.text, how: "spreadsheet read" };
      }
      if (f.type === "application/pdf" || /\.pdf$/i.test(name)) {
        pdfjsLib ||= await extractMod.loadPdfjsBrowser();
        try {
          const r = await extractMod.extractPdf(buf, pdfjsLib, { maxChars: DESK_DOC_CHARS });
          return { name, text: r.text, how: "PDF text read" };
        } catch (e) {
          if (!/scanned or image-only/.test((e && e.message) || "")) throw e;
          // No text layer: render the pages here and let the server's vision OCR transcribe them.
          const rp = await extractMod.renderPdfPages(buf, pdfjsLib, { maxPages: 12 });
          const resp = await fetch("/api/ocr", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, pages: rp.pages, source: "pdf" }) });
          const j = await resp.json().catch(() => ({}));
          if (!resp.ok || j.error) throw new Error(j.error || "the scan could not be read");
          let text = String(j.text || "");
          if (rp.total > rp.rendered) text += "\n\n(Only the first " + rp.rendered + " of " + rp.total + " pages were transcribed; that is the reading limit for a scan.)";
          return { name, text, how: "scanned, read by OCR" };
        }
      }
      const r = await extractMod.extractDocx(buf, { maxChars: DESK_DOC_CHARS });
      return { name, text: r.text, how: "Word document read" };
    }
    const text = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => resolve("");
      r.readAsText(f.slice(0, DESK_DOC_CHARS * 4));   // UTF-8 bytes, trimmed to chars below
    });
    return { name, text: text.slice(0, DESK_DOC_CHARS), how: /\.json$/i.test(name) ? "JSON read" : "text read" };
  }

  async function addDocuments(w, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const clip = $("#vb-clip-" + w);
    const skipped = [];
    if (clip) clip.classList.add("is-busy");
    winNote(w, "Reading " + files.length + " file" + (files.length === 1 ? "" : "s") + "…");
    try {
      for (const f of files) {
        const name = f.name || "file";
        if (docsOf(w).length >= DESK_MAX_DOCS) { skipped.push(name + " (the desk holds " + DESK_MAX_DOCS + ")"); continue; }
        if (/\.(doc|xls|ppt)$/i.test(name)) {
          skipped.push(name + " (old Office format; save it as .docx or .xlsx first)");
          continue;
        }
        const known = f.type === "application/pdf" || f.type === DOCX_MIME || f.type === XLSX_MIME ||
          f.type === "application/json" || (f.type || "").startsWith("text/") ||
          DOC_BINARY_EXT.test(name) || DOC_TEXT_EXT.test(name);
        if (!known) { skipped.push(name + " (Word, PDF, markdown, text, JSON and spreadsheets)"); continue; }
        try {
          const d = await readOneDocument(f);
          if (!d.text.trim()) { skipped.push(name + " (nothing readable inside it)"); continue; }
          docsOf(w).push({ ...d, chars: d.text.length, truncated: d.text.length >= DESK_DOC_CHARS });
        } catch (e) {
          skipped.push(name + " (" + ((e && e.message) || "could not be read") + ")");
        }
      }
    } finally {
      if (clip) clip.classList.remove("is-busy");
    }
    renderDesk(w);
    saveDraft();
    const onDesk = docsOf(w).length;
    winNote(w, skipped.length
      ? "Not added: " + skipped.join(", ") + (onDesk ? ". " + onDesk + " on the desk." : "")
      : onDesk
        ? onDesk + " document" + (onDesk === 1 ? "" : "s") + " on the desk. " + WNAME[w] + " reads " + (onDesk === 1 ? "it" : "them") + " on the next message you send."
        : "", !!skipped.length);
  }

  function renderDesk(w) {
    const el = $("#vb-desk-" + w);
    if (!el) return;
    const docs = docsOf(w);
    el.textContent = "";
    el.hidden = !docs.length;
    if (!docs.length) return;
    for (const [i, d] of docs.entries()) {
      const chip = document.createElement("span");
      chip.className = "vb-doc" + (d.needsReattach ? " is-stale" : "");
      const label = document.createElement("b");
      label.textContent = d.name;
      const meta = document.createElement("small");
      meta.textContent = d.needsReattach
        ? "attach it again after the reload"
        : d.how + " · " + d.chars.toLocaleString() + " characters" + (d.truncated ? " (the rest was too long to send)" : "");
      const x = document.createElement("button");
      x.type = "button"; x.className = "vb-doc-x"; x.textContent = "×";
      x.title = "Take " + d.name + " off the desk";
      x.setAttribute("aria-label", "Take " + d.name + " off the desk");
      x.addEventListener("click", () => {
        docsOf(w).splice(i, 1);
        renderDesk(w); saveDraft();
        winNote(w, "");
      });
      chip.append(label, meta, x);
      el.append(chip);
    }
  }

  // What actually crosses the wire. A document whose text did not survive a reload is NOT sent as
  // an empty file; it is left off, and its chip says it must be attached again.
  const documentsFor = (w) => docsOf(w).filter((d) => !d.needsReattach && d.text)
    .slice(0, DESK_MAX_DOCS).map((d) => ({ name: d.name, text: d.text }));

  /* ================= what the planners are told about this page ============================== */
  /*
   * Fred, 2026-08-01, verbatim: "when choosing the project and the project folder the general is
   * not aware of which folder was chosen or what its contents are until you tell it in the chat...
   * It should also be context aware of any setting in that page so that it doesn't have to be
   * reiterated."
   *
   * Everything the person set on this screen is knowledge this surface already holds and used to
   * keep to itself. Two halves, split by who can be trusted with which:
   *   - the PROJECT (which folder, where, what is in it) travels as an ID only. The server looks
   *     the record up in the caller's own workspace list and reads the folder itself, so a path
   *     can never be asserted by the browser.
   *   - the SETTINGS are screen state that exists nowhere else, so they travel as plain
   *     label/value display text and are treated as such at the far end.
   */
  function pageSettings() {
    const b = bridge();
    const out = [];
    const add = (label, value) => { if (value) out.push({ label, value }); };
    add("Which interface they are using", "Vibe Coder (the Crucible App Launcher)");
    add("How they want things explained", reg() === "plain" ? "plain English, no jargon"
      : reg() === "technical" ? "technical terms, they speak the language" : "the technical term with a short plain-English gloss");
    if (b) {
      const ws = b.workspaceInfo && b.workspaceInfo();
      if (ws) add("Spend limit on this project", ws.budgetUsd > 0
        ? money().cost(ws.budgetUsd) + ": the build pauses and asks before passing it"
        : "none set; the build will not stop itself");
      const mods = (b.studioModuleLabels && b.studioModuleLabels()) || [];
      add("Workspace setup they chose", (b.studioPreset && b.studioPreset()) || "custom");
      add("Workspace panels switched on", mods.length ? mods.join(", ") : "none beyond the basics");
      add("Agent Army", (b.studioModules && b.studioModules().includes("crew"))
        ? (state.army ? "on; " + state.army.tasks.length + " task(s) planned, orchestrator: " + (state.army.orchestrator || "same as the General")
                      : "on, but the tasks have not been planned yet")
        : "off; one AI runs the whole build by itself");
    }
    add("Model in the General's window", modelLabel(state.chats.main.model));
    // Read the window's real state off the panel, not off a flag that a draft restore can leave
    // stale. A settings block that reports an adviser as "open" when it is folded away is the same
    // class of untruth this whole change exists to remove.
    for (const w of ["second", "third"]) {
      const body = $("#vb-body-" + w);
      const openNow = !!(body && !body.hidden);
      if (!openNow && !state.chats[w].messages.length) continue;
      add(WNAME[w] + "'s window", (openNow ? "open" : "closed, but it has already been used") +
        ", model: " + modelLabel(state.chats[w].model));
    }
    // The desk is named in the settings too, so a rank knows a file is loaded even before it
    // reaches the ATTACHED DOCUMENT blocks, and so an adviser can be told what the General holds.
    const desk = docsOf("main").filter((d) => !d.needsReattach).map((d) => d.name);
    if (desk.length) add("Documents the user attached to the General", desk.join(", "));
    if (state.plan) add("A plan was carried over from the main chat", state.plan.name || "yes");
    if (state.adopt) add("This is an app they already started", "adopted: " + (state.adopt.name || "yes"));
    if (state.vision) add("A vision has already been agreed", "yes; do not re-run the interview unless they change it");
    return out;
  }

  const modelLabel = (id) => {
    if (!id) return "their main model (no specific pick)";
    for (const g of (bridge() && bridge().models()) || []) {
      for (const m of g.models || []) if (m && m.id === id) return m.name || id;
    }
    return id;
  };

  // The id the server resolves the folder from. Empty until a project is chosen, and that is a fact
  // worth sending too: it tells the planner to talk about picking one rather than inventing one.
  const currentWorkspaceId = () => {
    const b = bridge();
    if (!b) return "";
    if (state.adopt && state.adopt.workspaceId) return state.adopt.workspaceId;
    return (b.workspaceId && b.workspaceId()) || "";
  };

  /* ================= draft persistence ====================================================== */

  /*
   * The desk in the draft. localStorage is a few megabytes for the whole app, and six PDFs would
   * take all of it, so text is kept up to DESK_DRAFT_CHARS and every document past that budget
   * keeps its NAME with `needsReattach`. A chip that says "attach it again after the reload" is
   * honest; a chip that silently stood for an empty file would not be.
   */
  function draftDocs(w) {
    let budget = DESK_DRAFT_CHARS;
    return docsOf(w).map((d) => {
      if (d.needsReattach || !d.text || d.text.length > budget) {
        return { name: d.name, how: d.how, chars: d.chars, truncated: !!d.truncated, needsReattach: true, text: "" };
      }
      budget -= d.text.length;
      return { name: d.name, how: d.how, chars: d.chars, truncated: !!d.truncated, needsReattach: false, text: d.text };
    });
  }

  /*
   * ONE DRAFT PER PROJECT, KEPT WITH THE PROJECT (Fred, 2026-08-01: "The intent was to have any
   * project seamlessly change from mobile to desktop and desktop to mobile", and before that: "A
   * new project = chats reset. Pick a project from the project carousel, all settings from that
   * project populate").
   *
   * There used to be ONE draft for the whole surface, in this device's local storage. Two
   * consequences, both of which Fred hit. It could not travel, so the phone never saw what the
   * laptop planned. And it did not follow the project, so picking a different project on the same
   * device still showed the last thing typed on it.
   *
   * Now: local storage is keyed by project and acts as the fast, offline copy, while the project
   * record on the server is the copy that travels. Whichever is newer wins on load. Work done
   * before any project exists is kept under the "unattached" key and moves into the first project
   * that adopts it, because planning legitimately happens before the folder is chosen.
   */
  const draftKeyFor = (wsId) => "dominion.vibe.project." + (wsId || "unattached") + ".v1";
  const currentProjectId = () => { const b = bridge(); return (b && (b.buildWorkspaceId ? b.buildWorkspaceId() : b.workspaceId())) || ""; };

  function snapshotState() {
    return {
      chats: Object.fromEntries(WINDOWS.map((w) => [w, {
        // Pictures are not persisted (a phone photo in localStorage would blow the quota fast);
        // multimodal turns collapse to their text on reload, which is the honest cheap trade.
        messages: state.chats[w].messages.map((m) => ({ from: m.from, content: typeof m.content === "string" ? m.content : (m.content.find((p) => p.type === "text") || { text: "(picture)" }).text })).slice(-40),
        model: state.chats[w].model, open: state.chats[w].open,
        docs: draftDocs(w),
      }])),
      // The transcript can be hundreds of KB and localStorage is a few MB total, so the draft
      // keeps the decision record (what planning needs) and drops the raw source. A reload
      // therefore loses the appendix, never the decisions.
      planTranscriptDropped: !!(state.plan && state.plan.transcript),
      vision: state.vision, adopt: state.adopt,
      plan: state.plan ? { name: state.plan.name, brief: state.plan.brief } : null,
      at: Date.now(),
    };
  }

  const isEmptyState = (d) => !d || !d.chats || (!WINDOWS.some((w) => d.chats[w] && (d.chats[w].messages || []).length) && !d.plan && !d.vision && !d.adopt);

  /*
   * The sync to the project record, debounced. Typing must not post on every keystroke, and the
   * last write of a burst is the one that matters. It also fires on the way out of the page, so
   * closing the laptop lid does not strand the last minute of planning on one device.
   */
  let syncTimer = 0, syncWarned = false;
  function syncProject(blob, wsId) {
    const b = bridge();
    if (!b || !b.saveCrucible || !wsId) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      const r = await b.saveCrucible(wsId, blob);
      if (r && r.ok) { syncWarned = false; return; }
      // Said once per problem, never on a loop: the work is safe on this device either way.
      if (!syncWarned) {
        syncWarned = true;
        status((r && r.code === "crucible_too_large")
          ? "This planning conversation is too long to sync between devices. It is saved on this device, and the build still gets all of it."
          : "Saved on this device. It could not be synced to your other devices just now.", true);
      }
    }, 1200);
  }

  function saveDraft(flush) {
    const blob = snapshotState();
    const wsId = currentProjectId();
    try { localStorage.setItem(draftKeyFor(wsId), JSON.stringify(blob)); } catch {}
    /*
     * On the way out there is no time for a debounce and no guarantee a normal fetch survives the
     * page. sendBeacon is built for exactly this: the browser takes the payload and delivers it
     * after the page is gone. The local copy is already written above either way.
     */
    if (flush && wsId) {
      clearTimeout(syncTimer);
      try {
        const body = new Blob([JSON.stringify({ id: wsId, patch: { crucible: blob } })], { type: "application/json" });
        if (navigator.sendBeacon && navigator.sendBeacon("/ide/workspace/update", body)) return;
      } catch {}
    }
    syncProject(blob, wsId);
  }

  // Everything a project owns, wiped. Used by New Project and by picking a project with no state.
  function blankState() {
    for (const w of WINDOWS) {
      state.chats[w].messages = [];
      state.chats[w].docs = [];
      state.chats[w].open = w === "main";
    }
    state.vision = null;
    state.adopt = null;
    state.plan = null;
    state.army = null;
  }

  function applyState(d) {
    if (!d || !d.chats) { blankState(); return; }
    try {
      // Start from empty, so a project whose state names only one window cannot leave the previous
      // project's other two windows on screen.
      blankState();
      for (const w of WINDOWS) {
        if (d.chats[w]) {
          state.chats[w].messages = Array.isArray(d.chats[w].messages) ? d.chats[w].messages : [];
          state.chats[w].model = d.chats[w].model || "";
          state.chats[w].open = w === "main" ? true : !!d.chats[w].open;
          state.chats[w].docs = (Array.isArray(d.chats[w].docs) ? d.chats[w].docs : [])
            .filter((x) => x && x.name)
            .slice(0, DESK_MAX_DOCS)
            .map((x) => ({ name: String(x.name), text: String(x.text || ""), how: String(x.how || "read"),
              chars: Number(x.chars) || 0, truncated: !!x.truncated, needsReattach: !!x.needsReattach || !x.text }));
        }
      }
      state.vision = d.vision || null;
      state.adopt = (d.adopt && d.adopt.workspaceId && d.adopt.brief) ? d.adopt : null;
      state.plan = (d.plan && d.plan.brief) ? d.plan : null;
    } catch { blankState(); }
  }

  const readLocal = (wsId) => { try { return JSON.parse(localStorage.getItem(draftKeyFor(wsId)) || "null"); } catch { return null; } };

  /*
   * Load ONE project's Crucible state, taking whichever copy is newer: the one this device saved,
   * or the one that came back with the project record from the server. A phone that planned on the
   * train wins over a laptop that has not been touched since yesterday, and the other way round.
   * Equal timestamps keep the local copy, because it is the one already on screen.
   */
  function loadProject(wsId) {
    const b = bridge();
    const remote = (b && b.crucibleFor) ? b.crucibleFor(wsId) : null;
    const local = readLocal(wsId);
    let pick = local;
    if (remote && (!local || Number(remote.at || 0) > Number(local.at || 0))) pick = remote;
    /*
     * Work planned before any project existed moves into the first project that adopts it. Planning
     * legitimately starts before the folder is chosen (the whole point of Begin Building making one
     * for a first-timer), and that work must not evaporate the moment the folder appears. A project
     * that ALREADY has state is never overwritten by it.
     */
    if (isEmptyState(pick) && wsId) {
      const unattached = readLocal("");
      if (!isEmptyState(unattached)) {
        pick = unattached;
        try { localStorage.removeItem(draftKeyFor("")); } catch {}
        applyState(pick);
        saveDraft();   // re-home it under this project, on this device and on the server
        repaintProject();
        return;
      }
    }
    applyState(pick);
    repaintProject();
  }

  // Everything on screen that belongs to a project, repainted after the state under it changed.
  function repaintProject() {
    if (!state.open) return;
    for (const w of WINDOWS) { renderLog(w); renderDesk(w); toggleWin(w, state.chats[w].open); }
    const pv = $("#vb-plan-view"); if (pv) pv.hidden = !state.plan;
    const grid = $("#vb-army-grid"); if (grid && !state.army) grid.hidden = true;
    renderSlider(); renderSaveTo(); renderBudget(); paintAllModelSelects(); gateArmy();
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
      '<div class="vb-saveto-where" id="vb-saveto-where" hidden></div>' +

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
      // Four choices (Fred, 2026-07-31): three ready-made setups plus Custom. The tick boxes only
      // exist under Custom; the explainer tiles are gone, their words folded into the boxes.
      '<div class="vb-box" id="vb-studio">' +
        '<div class="vb-box-head"><h3 class="vb-h">Customize Your Workspace</h3></div>' +
        '<div class="vb-presets" id="vb-presets">' +
          '<button type="button" data-preset="minimal">Minimal</button>' +
          '<button type="button" data-preset="design">Design Studio</button>' +
          '<button type="button" data-preset="fullstack">Full Stack</button>' +
          '<button type="button" data-preset="custom">Custom</button>' +
        '</div>' +
        '<div class="vb-mods" id="vb-mods" hidden></div>' +
        '<div class="vb-box-foot"><span class="vb-note" id="vb-studio-note"></span><button type="button" class="vb-apply" id="vb-apply">Apply</button></div>' +
      '</div>' +

      // ---- 4. Plan with AI ------------------------------------------------------------------
      '<div class="vb-plan">' +
        '<div class="vb-plan-head"><h3 class="vb-h">Plan with AI</h3>' +
          // The plan that rode over from the main chat, word for word, one press away. Hidden
          // until a hand-off actually happened (Fred, 2026-07-31: the plan used to vanish here).
          '<button type="button" class="vb-plan-view" id="vb-plan-view" hidden>See the plan from chat</button>' +
        '</div>' +
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

      /*
       * ---- 6. The spend limit, then Begin Building ------------------------------------------
       * Directly above the button that starts spending, because a limit read after the fact is a
       * receipt. The estimate above it is a best case (one model call per step); the engine
       * retries, repairs, reviews and re-checks, so the real number can land far above the quote.
       * A build once ran to $9.07 against a ~$0.30 estimate with nothing to stop it, since a new
       * project carried no budget and no budget means unlimited. The number is the user's and has
       * no ceiling of ours; leaving it empty is still allowed and still means no limit, but now it
       * says so out loud instead of being the silent default.
       */
      '<div class="vb-budget" id="vb-budget-row">' +
        '<label class="vb-budget-label" for="vb-budget">Stop this project at</label>' +
        '<input id="vb-budget" class="vb-budget-input" type="text" inputmode="decimal" autocomplete="off" placeholder="no limit" />' +
        '<span class="vb-budget-unit" id="vb-budget-unit"></span>' +
        '<span class="vb-budget-note" id="vb-budget-note"></span>' +
      '</div>' +
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
    // The old "Copy chat" header button confused (Fred, 2026-07-31); copying now lives on every
    // bubble and in the Copy all control above the typing field.
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
    /*
     * THE SPLIT SEND (Fred, 2026-07-31). The button is cut in half: the top half is Send, which
     * always talks to THIS rank and nothing else. The bottom half is Advisors, a toggle. On, two
     * third-size buttons appear to its left, each wearing the OTHER two ranks' colours and
     * insignias, and a tick box appears on every message. Tick any number, press an insignia,
     * and exactly those messages travel to that rank — never the whole chat.
     */
    const others = WINDOWS.filter((x) => x !== w);
    const advisorBtns = others.map((o) =>
      '<button type="button" class="vb-adv-btn vb-adv-' + o + '" data-from="' + w + '" data-to="' + o + '" title="Send the ticked messages to ' + WNAME[o] + '" aria-label="Send the ticked messages to ' + WNAME[o] + '">' + WRANK_SVG[o] + '</button>').join("");
    return (
      '<section class="vb-win vb-win-' + w + '" id="vb-win-' + w + '" data-win="' + w + '">' +
        head +
        '<div class="vb-win-body" id="vb-body-' + w + '"' + (w === "main" ? "" : " hidden") + '>' +
          '<div class="vb-log" id="vb-log-' + w + '" aria-live="polite"></div>' +
          '<div class="vb-grab" data-win="' + w + '" title="Drag to make this window taller" aria-hidden="true"><i></i></div>' +
          '<div class="vb-copyall-row"><button type="button" class="vb-copyall" data-win="' + w + '" title="Copy this whole conversation as clean text">Copy all</button></div>' +
          // Advisor-flow feedback lands HERE, beside the buttons that caused it. The first build
          // sent refusals to the page-bottom status line, 900+ px below the insignia on a laptop
          // screen: the app looked dead while it was asking for context (Fred, 2026-07-31,
          // "either the handoff to the advisors is broken or im doing it wrong" — neither; the
          // answer was rendering off-screen).
          '<div class="vb-win-note" id="vb-note-' + w + '" aria-live="polite" hidden></div>' +
          /*
           * THE READING DESK (Fred, 2026-08-01): Word, PDF, markdown, plain text, JSON and
           * spreadsheets, attached to the conversation rather than to one message. Each file is
           * read on THIS device and stays on the desk until it is taken off, so the rank can be
           * asked about it turn after turn. The strip is the receipt: name, size, and how it was
           * read, so nobody has to trust that the file landed.
           */
          '<div class="vb-desk" id="vb-desk-' + w + '" hidden></div>' +
          '<div class="vb-row">' +
            '<button type="button" class="vb-clip" id="vb-clip-' + w + '" title="Attach a document for ' + WNAME[w] + ' to read (Word, PDF, markdown, text, JSON, spreadsheet)" aria-label="Attach a document">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5l-8.2 8.2a4.6 4.6 0 0 1-6.5-6.5l8.6-8.6a3 3 0 0 1 4.3 4.3l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8"/></svg>' +
            '</button>' +
            '<input type="file" id="vb-file-' + w + '" class="vb-file" multiple hidden ' +
              'accept=".pdf,.docx,.xlsx,.md,.markdown,.txt,.json,.csv,.log,.xml,.yaml,.yml,.html,.css,.js,.mjs,.ts,.py,.sql,application/pdf,' + DOCX_MIME + ',' + XLSX_MIME + ',text/*,application/json" />' +
            '<textarea id="vb-in-' + w + '" rows="1" placeholder="Type here…" aria-label="Message for ' + WNAME[w] + '"></textarea>' +
            '<div class="vb-adv-btns" id="vb-adv-' + w + '" hidden>' + advisorBtns + '</div>' +
            '<div class="vb-sendstack vb-split" id="vb-sendstack-' + w + '">' +
              '<button type="button" class="vb-send vb-send-top" id="vb-send-' + w + '">Send</button>' +
              '<button type="button" class="vb-send-adv" id="vb-advtoggle-' + w + '" aria-pressed="false">Advisors</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>');
  }

  /* ================= models ================================================================= */

  function fillModels(sel, current, { orchestratorOnly = false, allowDefault = true, defaultLabel = "" } = {}) {
    if (!sel || !bridge()) return;
    sel.textContent = "";
    if (allowDefault) sel.append(new Option(defaultLabel || (orchestratorOnly ? "Default (recommended)" : "My main model"), ""));
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
    const catalogLoaded = bridge() && bridge().models().length > 0;
    /*
     * THE SEATS (Fred, 2026-07-31): the General defaults to GPT-5.6 Luna, universally. The
     * Captain and the Sergeant have NO default — their pickers open on "Pick a model…" and a
     * send without a pick is refused out loud (wireSend). The orchestrator's empty value means
     * "same as the General": planArmy passes the General's model when the seat is left alone.
     */
    if (catalogLoaded && !state.chats.main.model) {
      const luna = "openai/gpt-5.6-luna";
      const has = bridge().models().some((g) => g.models.some((m) => m.id === luna && !m.unavailable));
      if (has) state.chats.main.model = luna;
    }
    fillModels($("#vb-model-main"), state.chats.main.model);
    for (const w of ["second", "third"]) fillModels($("#vb-model-" + w), state.chats[w].model, { defaultLabel: "Pick a model…" });
    fillModels($("#vb-orch-model"), (state.army && state.army.orchestrator) || "", { orchestratorOnly: true, defaultLabel: "Same as the General" });
    // A saved model that the catalog no longer offers must not linger invisibly: sync state to
    // what the select actually landed on, but only once the catalog is real.
    if (catalogLoaded) for (const w of WINDOWS) {
      const sel = $("#vb-model-" + w);
      if (sel && sel.value !== state.chats[w].model) state.chats[w].model = sel.value;
    }
    if (state.army) for (const [i, p] of state.army.picks.entries()) fillModels($("#vb-tmodel-" + i), p.model || "");
  }

  /* ================= 1. the slider =========================================================== */

  /*
   * THE PROJECT ROW (Fred, 2026-07-31). Boxes across the whole page: filled with projects when
   * they exist, blank with no words otherwise. New highlights a blank box and puts a name field
   * in it; once the name is entered, the Save to: selector lights up and asks where the project
   * lives — a folder on this computer, or the Dominion cloud. The Future Project Slot card and
   * the "what's next" card are gone. Every project carries a quiet × to remove it from the list
   * (the folder and its files stay on disk).
   */
  let staged = null;   // { name, editing } — a named project waiting for its folder
  const MIN_BOXES = 6;

  function renderSlider() {
    const rail = $("#vb-slider");
    if (!rail || !bridge()) return;
    rail.textContent = "";
    for (const ws of bridge().workspaces()) {
      const c = document.createElement("div");
      c.className = "vb-card vb-card-ws" + (bridge().workspaceId() === ws.id ? " on" : "");
      c.setAttribute("role", "button");
      c.tabIndex = 0;
      c.innerHTML = '<span class="vb-card-name"></span><small>project</small><button type="button" class="vb-card-x" title="Remove this project from the list" aria-label="Remove this project from the list">&times;</button>';
      c.querySelector(".vb-card-name").textContent = ws.name || ws.id;
      /*
       * PICKING A PROJECT POPULATES EVERYTHING IT OWNS (Fred, 2026-08-01: "Pick a project from the
       * project carousel, all settings from that project populate"). The current project's work is
       * written down first, so switching away never costs the thing you were in the middle of.
       */
      const pick = () => {
        if (ws.id === bridge().workspaceId()) return;
        saveDraft();
        bridge().selectWorkspace(ws.id);
        loadProject(ws.id);
      };
      c.addEventListener("click", (e) => { if (!e.target.closest(".vb-card-x")) pick(); });
      c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      c.querySelector(".vb-card-x").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!window.confirm('Remove "' + (ws.name || ws.id) + '" from the project list? The folder and its files stay where they are.')) return;
        const r = await bridge().removeWorkspace(ws.id);
        if (r && r.error) { status(r.error, true); return; }
        renderSlider(); renderSaveTo(); renderBudget();
        status("Removed. The folder itself was not touched.");
      });
      rail.append(c);
    }
    if (staged) {
      const c = document.createElement("div");
      c.className = "vb-card vb-card-staged";
      if (staged.editing) {
        c.innerHTML = '<input class="vb-card-input" type="text" maxlength="48" placeholder="Name it…" aria-label="New project name"><small>new project</small>';
        const inp = c.querySelector("input");
        inp.value = staged.name || "";
        const commit = () => {
          const name = inp.value.trim();
          if (!name) return;
          staged = { name, editing: false };
          renderSlider();
          highlightSaveTo();
        };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { staged = null; renderSlider(); } });
        inp.addEventListener("blur", () => { if (inp.value.trim()) commit(); });
        setTimeout(() => inp.focus(), 0);
      } else {
        c.innerHTML = '<span class="vb-card-name"></span><small>pick a folder below</small><button type="button" class="vb-card-x" title="Cancel this new project" aria-label="Cancel this new project">&times;</button>';
        c.querySelector(".vb-card-name").textContent = staged.name;
        c.querySelector(".vb-card-x").addEventListener("click", () => { staged = null; renderSlider(); unhighlightSaveTo(); });
      }
      rail.append(c);
    }
    // Blank boxes fill out the row, wordless by design. Clicking one starts a new project there.
    const filled = bridge().workspaces().length + (staged ? 1 : 0);
    for (let i = filled; i < MIN_BOXES; i++) {
      const blank = document.createElement("button");
      blank.type = "button";
      blank.className = "vb-card vb-card-blank";
      blank.setAttribute("aria-label", "Start a new project here");
      blank.addEventListener("click", () => newProject());
      rail.append(blank);
    }
  }

  function highlightSaveTo() {
    const lab = document.querySelector(".vb-saveto");
    if (lab) { lab.classList.remove("vb-pulse"); void lab.offsetWidth; lab.classList.add("vb-pulse"); }
    status('Now choose where "' + (staged ? staged.name : "") + '" is saved: a folder on this computer, or the Dominion cloud.');
  }
  function unhighlightSaveTo() {
    const lab = document.querySelector(".vb-saveto");
    if (lab) lab.classList.remove("vb-pulse");
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

  const SAVE_CLOUD = "__cloud__";
  const SAVE_BROWSE = "__browse__";

  function renderSaveTo() {
    const sel = $("#vb-saveto");
    if (!sel || !bridge()) return;
    sel.textContent = "";
    sel.append(new Option("(new folder at build time)", ""));
    // Both homes a project can live in, offered side by side (Fred, 2026-07-31): the Dominion
    // cloud folder, or a folder on the user's own machine picked through the folder walk.
    sel.append(new Option("Dominion cloud folder", SAVE_CLOUD));
    sel.append(new Option("Choose a folder on this computer…", SAVE_BROWSE));
    /*
     * SAY WHERE IT IS (Fred, 2026-07-31: "it also just has the name of a folder in the save to
     * dropdown, I have no idea where that is stored"). A bare project name is not an address. The
     * option now carries the real path, and the row below spells out the full location plus the
     * machine, because a build writes real files and the person should know onto what.
     */
    for (const ws of bridge().workspaces()) {
      const where = ws.root ? "  ·  " + ws.root : "";
      sel.append(new Option((ws.name || ws.id) + where, ws.id));
    }
    sel.value = bridge().workspaceId() || "";
    paintWhere();
  }

  /*
   * The chosen folder's full path, under the selector, in plain sight — and, since 2026-08-01,
   * WHAT IS IN IT and whether the planners can read it.
   *
   * Fred could not tell whether the General knew about the folder because nothing on screen ever
   * said so, and it did not. This line is the receipt: it names the folder, counts what is inside,
   * and states out loud that the AIs on this page can open it. When the machine holding the folder
   * is not reachable, it says THAT instead, which is the one fact that changes what the planners
   * can do for you.
   */
  let peekToken = 0;
  function paintWhere() {
    const el = $("#vb-saveto-where");
    if (!el || !bridge()) return;
    const id = $("#vb-saveto") ? $("#vb-saveto").value : "";
    const ws = bridge().workspaces().find((w) => w.id === id);
    if (!ws) { el.textContent = ""; el.hidden = true; return; }
    el.textContent = "Saves to: " + (ws.root || "(folder not reported)") + (ws.node ? "  on " + (ws.node === "workshop" ? "the Dominion cloud" : ws.node) : "");
    el.hidden = false;
    paintProjectPeek(ws, el);
  }

  async function paintProjectPeek(ws, el) {
    const mine = ++peekToken;
    let line = document.createElement("span");
    line.className = "vb-saveto-peek";
    line.textContent = "Reading what is in that folder…";
    el.append(document.createElement("br"), line);
    const j = await (bridge().peekProject ? bridge().peekProject(ws.id) : Promise.resolve({}));
    if (mine !== peekToken) return;                     // a faster switch already won
    const p = j && j.project;
    if (!p || j.error) {
      line.textContent = "Dominion could not open that folder right now" + (j && j.error ? " (" + j.error + ")" : "") + ", so the planners cannot read it this session.";
      line.classList.add("is-bad");
      return;
    }
    if (p.unreadable) {
      line.textContent = "Dominion cannot read that folder right now: " + p.unreadable + ". The planners will say so rather than guess.";
      line.classList.add("is-bad");
      return;
    }
    if (p.empty) { line.textContent = "That folder is empty, and every AI on this page knows it. A clean start."; return; }
    const names = (p.entries || []).slice(0, 6).map((e) => e.name + (e.type === "dir" ? "/" : "")).join(", ");
    line.textContent = "Inside: " + (p.entries || []).length + (p.truncated ? "+" : "") + " item(s): " + names +
      ((p.entries || []).length > 6 ? ", …" : "") + ". Every AI on this page can see this and can open the files.";
  }

  function newProject(prefName) {
    // Naming comes FIRST (Fred: "You should be able to name it right away"): the card takes the
    // name, then the Save to: selector lights up and asks for the folder.
    /*
     * A NEW PROJECT RESETS THE CHATS (Fred, 2026-08-01: "A new project = chats reset"). Starting a
     * different app while the last app's planning conversation is still on screen is how a build
     * ends up carrying decisions that belonged to something else. The work being left behind is
     * written down first, under the project it belongs to, so nothing is lost by resetting.
     */
    saveDraft();
    blankState();
    try { localStorage.removeItem(draftKeyFor("")); } catch {}   // no stale unattached work follows it
    repaintProject();
    staged = { name: typeof prefName === "string" ? prefName : "", editing: true };
    renderSlider();
  }

  async function createStagedCloud() {
    const name = staged && staged.name;
    if (!name) return;
    try {
      const r = await fetch("/ide/workspace/new", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, cloud: true }) });
      const j = await r.json();
      if (!r.ok || j.error || !j.workspace) { status((j && j.error) || "The cloud folder could not be made.", true); return; }
      bridge() && bridge().addWorkspace && bridge().addWorkspace(j.workspace);
      bridge() && bridge().selectWorkspace(j.workspace.id);
      staged = null;
      unhighlightSaveTo();
      renderSlider(); renderSaveTo(); renderBudget();
      status('"' + j.workspace.name + '" lives in the Dominion cloud now. Plan below, then press BEGIN BUILDING.');
    } catch { status("The server could not be reached.", true); }
  }

  async function createStagedAt(parentPath, machine) {
    const name = staged && staged.name;
    if (!name) return;
    const winPath = /^[A-Za-z]:/.test(parentPath) || parentPath.includes("\\");
    const root = parentPath.replace(/[\\/]+$/, "") + (winPath ? "\\" : "/") + name.replace(/[^A-Za-z0-9 ._-]/g, "").trim();
    try {
      const r = await fetch("/ide/workspace", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, root, node: machine || "" }) });
      const j = await r.json();
      if (!r.ok || j.error || !j.workspace) { status((j && j.error) || "That folder could not be used.", true); return; }
      bridge() && bridge().addWorkspace && bridge().addWorkspace(j.workspace);
      bridge() && bridge().selectWorkspace(j.workspace.id);
      staged = null;
      unhighlightSaveTo();
      renderSlider(); renderSaveTo(); renderBudget();
      status('"' + j.workspace.name + '" will be saved at ' + root + ". Plan below, then press BEGIN BUILDING.");
    } catch { status("The server could not be reached.", true); }
  }

  /*
   * The folder walk for Save to:, same /ide/browse contract as the adopt walk, in a small modal
   * so it works identically on the phone. Picking a folder answers the one question this exists
   * for and the modal leaves.
   */
  function openFolderPicker(onPick) {
    const old = $("#vb-pick-modal"); if (old) old.remove();
    const overlay = document.createElement("div");
    overlay.className = "vb-modal"; overlay.id = "vb-pick-modal";
    overlay.innerHTML =
      '<div class="vb-modal-card">' +
        '<div class="vb-modal-head"><h3 class="vb-h">Choose a folder</h3><button type="button" class="vb-modal-x" aria-label="Close">&times;</button></div>' +
        '<div class="vb-adopt-tree" id="vb-pick-tree"></div>' +
      '</div>';
    document.body.append(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".vb-modal-x").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const tree = overlay.querySelector("#vb-pick-tree");
    let onMachine = "";
    const browse = async (path, machine) => {
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
        use.type = "button"; use.className = "vb-adopt-use"; use.textContent = "Save it here";
        use.addEventListener("click", () => { close(); onPick(path, onMachine); });
        bar.append(up, use);
      }
      tree.append(bar);
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
        pick.title = "Save into this folder without opening it";
        pick.addEventListener("click", () => {
          if (!path && d.machine) onMachine = d.machine;
          close(); onPick(d.path, onMachine);
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
    browse("");
  }

  // The Save to: selector's one handler, staged-aware. A staged project turns a pick into a
  // creation; without one the selector keeps its old job of pointing at an existing project.
  function handleSaveTo(value) {
    const sel = $("#vb-saveto");
    if (staged && !staged.editing) {
      if (value === SAVE_CLOUD) { createStagedCloud(); return; }
      if (value === SAVE_BROWSE) { openFolderPicker((path, machine) => createStagedAt(path, machine)); if (sel) sel.value = ""; return; }
      status("Pick Dominion cloud folder, or choose a folder on this computer, for the new project.", true);
      if (sel) sel.value = "";
      return;
    }
    if (value === SAVE_CLOUD || value === SAVE_BROWSE) {
      status("Press New and name the project first. Then pick where it lives.", true);
      if (sel) sel.value = bridge() ? (bridge().workspaceId() || "") : "";
      return;
    }
    bridge() && bridge().selectWorkspace(value);
    renderSlider(); renderBudget(); paintWhere();
  }

  function startOver() {
    // Start Over clears the desks too: a new project planned against the previous project's spec
    // is exactly the kind of quiet contamination this control exists to prevent.
    for (const w of WINDOWS) {
      state.chats[w].messages = []; state.chats[w].busy = false; state.chats[w].docs = [];
      renderLog(w); renderDesk(w); winNote(w, "");
    }
    state.vision = null;
    state.adopt = null;
    staged = null;
    unhighlightSaveTo();
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

  /*
   * FOUR CHOICES (Fred, 2026-07-31): Minimal, Design Studio, Full Stack, Custom. The tick boxes
   * exist only under Custom; the old separate explainer tiles are gone, their words folded into
   * each tick box, and the "Preloads" caption is deleted.
   */
  const MOD_LABELS = {
    workspace: "Workspace", brief: "Build Brief", crew: "Agent Crew", cost: "Cost",
    preview: "Live Preview", checks: "Results", history: "History", code: "Files/Diffs",
  };
  const MOD_NOTES = {
    workspace: "pick and manage the project folder (drawer below the build area)",
    brief: "the written brief the build follows (drawer below the build area)",
    crew: "the Agent Army on this page: split the build across models",
    cost: "live spend meter below the build area",
    preview: "watch the app run, once a build starts",
    checks: "pass/fail results, once a build runs",
    code: "every file and change, once a build runs",
    history: "the build log, below the build area",
  };
  let pendingModules = null;   // staged picks; Apply commits them to the real studio
  let studioTab = "";          // which of the four buttons is lit; "" = derive from the applied set

  function studioTabNow() {
    if (studioTab) return studioTab;
    if (!bridge()) return "custom";
    const presets = bridge().studioPresets();
    const chosen = [...(pendingModules || bridge().studioModules())].sort().join(",");
    for (const key of ["minimal", "design", "fullstack"]) {
      if ([...(presets[key] || [])].sort().join(",") === chosen) return key;
    }
    return "custom";
  }

  function renderStudio() {
    const box = $("#vb-mods");
    if (!box || !bridge()) return;
    const tab = studioTabNow();
    box.hidden = tab !== "custom";
    const note = $("#vb-studio-note");
    if (note) note.textContent = tab === "custom" ? "Tick what you want; Apply makes it so." : "Apply makes it so.";
    const current = new Set(pendingModules || bridge().studioModules());
    box.textContent = "";
    for (const [id, label] of Object.entries(MOD_LABELS)) {
      const lab = document.createElement("label");
      lab.className = "vb-mod";
      const input = document.createElement("input");
      input.type = "checkbox"; input.value = id; input.checked = current.has(id);
      input.addEventListener("change", () => {
        pendingModules = [...box.querySelectorAll("input:checked")].map((i) => i.value);
        studioTab = "custom";
        paintPresetButtons();
      });
      const words = document.createElement("span");
      words.className = "vb-mod-words";
      words.innerHTML = "<b></b><small></small>";
      words.querySelector("b").textContent = label;
      words.querySelector("small").textContent = MOD_NOTES[id] || "";
      lab.append(input, words);
      box.append(lab);
    }
    paintPresetButtons();
  }

  function paintPresetButtons() {
    const tab = studioTabNow();
    for (const b of document.querySelectorAll("#vb-presets button")) {
      b.classList.toggle("on", b.dataset.preset === tab);
    }
  }

  function applyStudio() {
    if (!bridge()) return;
    bridge().setStudioModules(pendingModules || bridge().studioModules());
    pendingModules = null;
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

  /*
   * COPY (Fred, 2026-07-31: "add a copy feature for each of the chats in general, captain and
   * sergeant"). The main Dominion chat has had per-message Copy since long ago; these three
   * windows had no way to lift text at all, which is where the actual plan gets written.
   *
   * Per bubble AND per window: one to take a single answer, one to take the whole thread, because
   * a plan worth keeping is usually the conversation rather than one reply.
   */
  async function copyToClipboard(text) {
    const t = String(text || "");
    if (!t) return false;
    try { await navigator.clipboard.writeText(t); return true; } catch {}
    // Clipboard API needs a secure context and permission; this path is the one that works when it
    // is refused, and it is why copy still works over a plain-http node.
    try {
      const a = document.createElement("textarea");
      a.value = t; a.setAttribute("readonly", ""); a.style.position = "fixed"; a.style.opacity = "0";
      document.body.appendChild(a); a.select();
      const ok = document.execCommand("copy");
      a.remove();
      return ok;
    } catch { return false; }
  }
  /*
   * When the clipboard is refused (a browser can deny the permission outright, which the rig does),
   * SELECT the text before saying "Press Ctrl+C". Saying it without selecting anything is a broken
   * promise: the keystroke would copy whatever happened to be highlighted, or nothing at all.
   */
  function selectElementText(el) {
    if (!el || !window.getSelection || !document.createRange) return false;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      return true;
    } catch { return false; }
  }
  function flashCopied(btn, ok, fallbackEl) {
    if (!btn) return;
    const selected = ok ? false : selectElementText(fallbackEl);
    const was = btn.textContent;
    btn.textContent = ok ? "Copied" : (selected ? "Selected: press Ctrl+C" : "Copy failed");
    btn.classList.toggle("is-done", !!ok);
    setTimeout(() => { btn.textContent = was; btn.classList.remove("is-done"); }, 1800);
  }
  /*
   * Clean text for pasting (Fred, 2026-07-31: "neat and tidy text that can be pasted without all
   * the artifacts or asterisks"). Markdown markup comes OFF: emphasis stars and underscores,
   * backticks, heading hashes, blockquote arrows; list dashes become a plain bullet. Content is
   * never dropped, only the punctuation that reads as noise in a text editor or an email.
   */
  function cleanText(s) {
    return String(s || "")
      .replace(/```[a-z]*\n?/gi, "")                      // fence lines
      .replace(/`([^`]+)`/g, "$1")                         // inline code
      .replace(/\*\*([^*]+)\*\*/g, "$1")                   // bold
      .replace(/\*([^*\n]+)\*/g, "$1")                     // italic
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1$2")
      .replace(/^#{1,6}\s+/gm, "")                         // heading hashes
      .replace(/^>\s?/gm, "")                              // blockquotes
      .replace(/^(\s*)[-*]\s+/gm, "$1• ")                  // list markers -> a real bullet
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // The whole thread, attributed and cleaned, so a pasted plan still says who proposed what.
  function threadText(w) {
    const c = state.chats[w];
    if (!c || !c.messages.length) return "";
    return c.messages.map((m) => {
      const who = m.from === "user" ? "You" : (WNAME[m.from] || m.from);
      const text = typeof m.content === "string" ? m.content
        : (m.content.find((p) => p.type === "text") || { text: "(picture)" }).text;
      return who + ": " + cleanText(text);
    }).join("\n\n");
  }

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
    // Thinking placeholders and errors carry no text worth lifting, so they get no button.
    // The traditional quiet clipboard glyph at the bottom of the bubble (Fred, 2026-07-31),
    // copying the message as clean text with the markdown noise stripped.
    if (text && !/vpb-thinking/.test(cls)) {
      const copy = document.createElement("button");
      copy.type = "button"; copy.className = "vpb-copy";
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
      copy.title = "Copy this message";
      copy.setAttribute("aria-label", "Copy this message");
      copy.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await copyToClipboard(cleanText(text));
        copy.classList.toggle("is-done", ok);
        if (!ok) selectElementText(b.querySelector("p"));
        setTimeout(() => copy.classList.remove("is-done"), 1500);
      });
      b.append(copy);
    }
    // A message arriving WHILE the Advisors ticks are up gets its own tick box immediately;
    // without this, a reply that lands mid-selection is the one message that cannot be sent on.
    if (text && !/vpb-thinking/.test(cls) && log.classList.contains("vb-selecting")) {
      const lab = document.createElement("label");
      lab.className = "vpb-pick";
      const box = document.createElement("input");
      box.type = "checkbox";
      lab.append(box);
      b.append(lab);
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

  /* ---------- message selection (reworked 2026-07-31) ---------------------------------------
   * The Advisors toggle puts a tick box on every message in that window, all UNCHECKED: the
   * user checks any number of them, then presses another rank's insignia to send exactly those.
   * Send and Enter ignore the ticks entirely, so talking to one rank alone, indefinitely, stays
   * the unforced default.
   */
  function enterSelect(w) {
    const log = $("#vb-log-" + w);
    if (!log) return;
    for (const b of log.querySelectorAll(".vpb[data-mi]")) {
      if (b.querySelector(".vpb-pick")) continue;
      const lab = document.createElement("label");
      lab.className = "vpb-pick";
      const box = document.createElement("input");
      box.type = "checkbox";
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
    // The planning has an END and it says so (Fred, 2026-07-31: "It is not clear when the
    // planning is supposed to end").
    card.innerHTML = "<h4>Here is what gets built</h4><div></div><p class='vpb-vision-done'>Planning is done. Press BEGIN BUILDING below, or keep talking to change the plan.</p>";
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
          seedPlan: !!(w === "main" && state.plan),
          adopt: !!state.adopt, adoptionContext: state.adopt ? state.adopt.brief : "",
          adoptionWorkspaceId: state.adopt ? state.adopt.workspaceId : "",
          // The project, the page, and the reading desk, every turn, to every rank (Fred, 08-01).
          workspaceId: currentWorkspaceId(), settings: pageSettings(),
          documents: documentsFor(w) }) });
      j = await r.json();
    } catch { j = { error: "The workshop could not be reached. Try again." }; }
    t.remove();
    c.busy = false;
    winNote(w, "");   // "Answering…" and any stale refusal stand down the moment the turn settles
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
   * The split Send (Fred, 2026-07-31). Send, the top half, ALWAYS talks to this rank and nothing
   * else — first click sends, no menu, no surprises, and Enter does the same. Advisors, the
   * bottom half, is a toggle: on, the two insignia buttons appear beside it and every message
   * grows a tick box. Tick any number, press an insignia, and exactly those messages cross to
   * that rank — never the whole chat. The receiving rank gets NO other context, so its opinion
   * stays uninfluenced; if no context was typed, the sender is prompted to add a line first.
   */
  // The per-window note: feedback rendered beside the control that caused it, never only at the
  // page-bottom status line (which sits 900+ px away and taught Fred the feature was "broken").
  function winNote(w, text, bad) {
    const el = $("#vb-note-" + w);
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    el.classList.toggle("is-bad", !!bad);
  }

  function wireSend(w) {
    const input = $("#vb-in-" + w);
    const send = $("#vb-send-" + w);
    const advToggle = $("#vb-advtoggle-" + w);
    const advBtns = $("#vb-adv-" + w);
    const clip = $("#vb-clip-" + w);
    const file = $("#vb-file-" + w);

    // The paperclip, plus drag-and-drop onto the window, plus paste. Three ways in because a
    // document is most often already on screen somewhere when someone decides to hand it over.
    if (clip && file) {
      clip.addEventListener("click", () => file.click());
      file.addEventListener("change", () => { addDocuments(w, file.files); file.value = ""; });
    }
    const body = $("#vb-body-" + w);
    if (body) {
      body.addEventListener("dragover", (e) => {
        if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault(); body.classList.add("is-dropping");
      });
      body.addEventListener("dragleave", (e) => { if (e.target === body) body.classList.remove("is-dropping"); });
      body.addEventListener("drop", (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault(); body.classList.remove("is-dropping");
        addDocuments(w, e.dataTransfer.files);
      });
    }
    if (input) {
      input.addEventListener("paste", (e) => {
        const files = [...((e.clipboardData && e.clipboardData.files) || [])];
        if (!files.length) return;
        e.preventDefault();
        addDocuments(w, files);
      });
    }

    // What a forwarded message reads as: its speaker's rank, then its words. Pictures collapse to
    // their text the same way drafts do; pixels never cross windows.
    const textOf = (c) => (typeof c === "string" ? c : ((c.find((p) => p.type === "text") || {}).text || "(picture)"));
    const speaker = (from) => (from === "user" ? "User" : WNAME[from] || from);

    const setAdvisors = (on) => {
      advBtns.hidden = !on;
      advToggle.classList.toggle("on", on);
      advToggle.setAttribute("aria-pressed", String(on));
      if (on) enterSelect(w); else exitSelect(w);
      // The flow teaches itself the moment it opens, right where the eye already is.
      const others = WINDOWS.filter((x) => x !== w).map((o) => WNAME[o]).join(" or ");
      winNote(w, on ? "Tick any messages above, type one line of context in the box, then press " + others + "'s insignia." : "");
    };

    const sendHere = () => {
      const text = (input.value || "").trim();
      if (!text || state.chats[w].busy) return;
      // Advisors that never got a model have no seat to answer from (Fred: no default for the
      // Captain or the Sergeant) — say so instead of quietly running on some other model.
      if (w !== "main" && !state.chats[w].model) {
        winNote(w, "Pick a model for " + WNAME[w] + " in its corner first.", true);
        return;
      }
      winNote(w, "");
      input.value = ""; input.style.height = "";
      state.chats[w].messages.push({ from: "user", content: text });
      const b = bubble(w, "vpb-user", text);
      if (b) b.dataset.mi = String(state.chats[w].messages.length - 1);
      saveDraft();
      askWindow(w);
    };

    /*
     * Crossing ranks: exactly the TICKED messages travel, joined as a labelled transcript in one
     * forwarded turn, which the server stamps as opinion. Text in the composer rides separately
     * AS THE USER, never inside the forwarded block, so the user's own words can never be
     * mistaken for an AI's opinion. Context is REQUIRED: an advisor handed a bare transcript
     * with no ask does not know what to do with it, so the sender is prompted to type one line.
     */
    const sendToAdvisor = (target) => {
      const text = (input.value || "").trim();
      const picks = pickedIndexes(w);
      if (!picks.length) { winNote(w, "Tick the messages to send to " + WNAME[target] + " first (the boxes on each message).", true); return; }
      if (!text) {
        winNote(w, "Type a line of context for " + WNAME[target] + " in the box below (what should they do with these messages?), then press their insignia again.", true);
        input.focus();
        return;
      }
      if (target !== "main" && !state.chats[target].model) {
        winNote(w, "Pick a model for " + WNAME[target] + " in its corner first.", true);
        return;
      }
      const msgs = state.chats[w].messages;
      let joined = picks.map((i) => msgs[i] ? "[" + speaker(msgs[i].from) + "] " + textOf(msgs[i].content) : "").filter(Boolean).join("\n\n");
      if (joined.length > 3800) joined = "(earlier ticked messages trimmed)\n\n" + joined.slice(-3800);
      input.value = ""; input.style.height = "";
      state.chats[target].messages.push({ from: w, content: joined });
      state.chats[target].messages.push({ from: "user", content: text });
      if (!state.chats[target].open) toggleWin(target, true);
      renderLog(target);
      setAdvisors(false);
      saveDraft();
      askWindow(target);
      const sentLine = "Sent " + picks.length + " message" + (picks.length === 1 ? "" : "s") + " to " + WNAME[target] + " below.";
      winNote(w, sentLine);
      winNote(target, "Answering what " + WNAME[w] + " sent over…");
      status(sentLine);
      // Bring the receiving window to the eye: scroll it into view and flash its border, so the
      // crossing is SEEN to happen instead of taken on faith.
      const winEl = $("#vb-win-" + target);
      if (winEl) {
        winEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        winEl.classList.remove("vb-flash"); void winEl.offsetWidth; winEl.classList.add("vb-flash");
      }
    };

    send.addEventListener("click", sendHere);
    advToggle.addEventListener("click", () => setAdvisors(advBtns.hidden));
    for (const b of advBtns.querySelectorAll(".vb-adv-btn")) {
      b.addEventListener("click", () => sendToAdvisor(b.dataset.to));
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHere(); }
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
      /*
       * The empty seat means "same as the General" (Fred, 2026-07-31): whatever model the user
       * gave the General runs the orchestration too, unless they picked one here deliberately.
       *
       * `inherited` tells the server WHICH of those two it is getting (Fred, 2026-08-01). It is the
       * whole fix for the guest who could never plan anything: the General's picker offers the
       * whole catalog, this seat has a size floor, and an inherited model below that floor used to
       * be refused outright on every press. A deliberate pick is still refused by name, because
       * swapping a model somebody chose on purpose would be a lie. An inherited one gets promoted
       * and the row says so.
       */
      const deliberate = $("#vb-orch-model").value;
      const orchestrator = deliberate || state.chats.main.model || "";
      const r = await fetch("/ide/tasks", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: goal + (state.vision ? "\n\nAGREED VISION:\n" + state.vision : ""), model: orchestrator, inherited: !deliberate, mode: "vibe", register: reg() }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { status(j.error || j.reason || "The plan could not be made.", true); return; }
      /*
       * The fallback notice (SOW 5.1): the server says WHICH model actually sat in the seat. The
       * row keeps saying it until the next plan, because a notice that vanishes was never read.
       */
      if (j.promoted) {
        orchNote("The General's model (" + j.promoted.fromName + ") cannot plan a whole build, so " + j.promoted.toName
          + " drew up this task list. Your General is unchanged. Pick a model here to choose the planner yourself.", true);
      }
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
          if (cost) cost.textContent = money().cost(e.usd, { approx: true }) + (e.basis === "prior" ? "*" : "");
          if (time) time.textContent = e.seconds >= 90 ? "~" + Math.round(e.seconds / 60) + " min" : "~" + e.seconds + "s";
        });
        const total = $("#vb-army-total");
        if (total && j.plan) {
          total.hidden = false;
          /*
           * A RANGE, with the high end shown, because the single number used to be the luckiest
           * possible build: one clean model call per step, nothing re-read, nothing retried. Fred
           * was quoted ~10 min and ~$0.30 for a plan that ran past 30 minutes and $9. The upper
           * figure is the one to set the spend limit against, so it is the one that gets said.
           */
          const fmtT = (s) => (s >= 90 ? Math.round(s / 60) + " min" : s + "s");
          const hiUsd = Number(j.plan.usdHigh) || j.plan.usd;
          const hiSec = Number(j.plan.secondsHigh) || j.plan.seconds;
          const timePart = hiSec > j.plan.seconds ? fmtT(j.plan.seconds) + " to " + fmtT(hiSec) : "~" + fmtT(j.plan.seconds);
          const costPart = hiUsd > j.plan.usd
            ? money().cost(j.plan.usd) + " to " + money().cost(hiUsd)
            : money().cost(j.plan.usd, { approx: true });
          total.textContent = "Whole plan: " + timePart + " · " + costPart
            + "  (estimate; builds that retry land nearer the higher figure" + (j.plan.basis === "prior" ? "; little data yet" : "") + ")";
        }
      } catch {}
    }, 280);
  }

  /*
   * Same wire contract Full Custom writes (taskMode/taskPlan/groups), plus the orchestrator seat,
   * so the engine cannot tell which surface configured the crew.
   *
   * THE PLAN FOLLOWS THE FOLDER (Fred, 2026-08-01: he approved a 12-task plan with four different
   * models and watched a 6-step build run on one model). The approved plan is stored on a PROJECT.
   * Every model pick here saved it to whichever project was selected at that second, and then Begin
   * Building could select a different project, or create a brand new one, whose stored plan was
   * empty. The engine read the empty one, found no task plan, and quietly planned its own build.
   * Passing the target explicitly, and returning the promise so the caller can wait, is what makes
   * "the plan I approved is the plan that runs" true rather than usually true.
   */
  function persistArmy(targetWorkspaceId) {
    if (!bridge() || !state.army) return Promise.resolve(false);
    const groups = state.army.tasks.map((t, i) => ({ id: "t" + t.n, taskNumbers: [t.n], model: state.army.picks[i].model, agents: state.army.picks[i].agents }));
    return bridge().saveAF({
      on: true, rows: [], taskMode: true,
      taskPlan: state.army.tasks.map((t) => ({ n: t.n, title: t.title, files: t.files, needs: t.needs })),
      groups,
      orchestrator: state.army.orchestrator || "",
    }, targetWorkspaceId);
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
    /*
     * THE CORPUS REACHES THE BUILD (Fred, 2026-07-31: "otherwise a completely different app might
     * be built, which is what would have happened on this test"). The planning chat only ever held
     * the decision record; the verbatim source stayed out of every planchat turn to keep those
     * cheap. The build is a single call and the door takes 3,000,000 characters, so this is where
     * the full record and its source belong. Ordered decisions-first: if anything is ever cut, the
     * appendix goes before the decisions do.
     */
    if (state.plan && state.plan.brief) {
      full += "\n\nDECISION RECORD FROM THE PLANNING CONVERSATION (complete; treat every line as settled unless the vision above overrides it):\n" + state.plan.brief;
      if (state.plan.transcript) {
        full += "\n\nSOURCE CONVERSATION (verbatim, for checking details the record may have compressed):\n" + state.plan.transcript;
      }
    }
    if (adopted) {
      // Brief LAST: the job door caps prompts, and a truncated tail must only ever cost brief
      // detail, never the agreed vision (see ide.mjs startJob).
      full = "ADOPTED PROJECT: the workspace folder already holds this app. Work against what exists; " +
        "[finish]/[fix]/[new] tags in the vision mark work on the existing code.\n\n" + full +
        "\n\nSTATE OF THE APP (scanned before planning):\n" + adopted.brief;
    }
    /*
     * Arm the limit BEFORE the first move, and only once the workspace exists (a folder is made
     * above for a first-timer). Saving it after startBuild would leave the opening moves
     * unguarded, which is where a runaway does its damage.
     */
    const armed = await armBudget(b);
    if (armed === false) return;   // the field held something that is not a number; say so, do not guess
    /*
     * PIN THE APPROVED PLAN TO THE FOLDER THIS BUILD WILL USE, and wait for it to land, before the
     * job starts (Fred, 2026-08-01). Everything above this line may have changed which project is
     * selected: a Save to: pick, an adoption, or a folder created moments ago for a first-timer.
     * The plan is stored per project, so it is written here, last, against the settled answer.
     */
    if (state.army) {
      const target = b.buildWorkspaceId ? b.buildWorkspaceId() : b.workspaceId();
      const landed = await persistArmy(target);
      if (!landed) {
        status("Your task plan could not be saved to the project folder, so the build was not started. Nothing has run and nothing was charged. Try again.", true);
        return;
      }
    }
    status("Starting…");
    b.startBuild(full, (msg, bad) => status(msg || "", bad));
  }

  /*
   * The spend limit, in the currency the viewer holds: credits for guests, dollars for the owner.
   * Empty means no limit, stated rather than assumed. No maximum is imposed (Fred, 2026-07-31:
   * "with no limit to the budget they can set in credits"), so the only rejection is text that is
   * not a number, which is refused out loud instead of quietly becoming unlimited.
   */
  function budgetIsCredits() { const m = money(); return !!(m.inCredits && m.inCredits()); }
  function renderBudget() {
    const row = $("#vb-budget-row"), input = $("#vb-budget"), unit = $("#vb-budget-unit"), note = $("#vb-budget-note");
    if (!row || !input) return;
    const credits = budgetIsCredits();
    if (unit) unit.textContent = credits ? (money().UNIT_NOUN || "credits") : "dollars";
    const b = bridge();
    const capUsd = b && b.budgetUsd ? b.budgetUsd() : 0;
    if (document.activeElement !== input) {
      input.value = capUsd > 0 ? String(credits ? Math.round(capUsd * 100 * 1e6) / 1e6 : capUsd) : "";
    }
    if (note) note.textContent = capUsd > 0 ? "The build pauses and asks before passing this." : "No limit set: the build will not stop itself.";
  }
  async function armBudget(b) {
    const input = $("#vb-budget");
    if (!input || !b || !b.setBudget) return true;
    const raw = String(input.value || "").trim().replace(/[$,\s]/g, "");
    if (!raw) { await b.setBudget(0); renderBudget(); return true; }   // explicit "no limit"
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) { status("That spend limit is not a number. Enter an amount, or clear it for no limit.", true); return false; }
    await b.setBudget(budgetIsCredits() ? n / 100 : n);                // credits -> dollars on the wire
    renderBudget();
    return true;
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
    $("#vb-saveto").addEventListener("change", (e) => handleSaveTo(e.target.value));
    // The limit follows the project, so switching folders never shows another project's number.
    $("#vb-budget").addEventListener("input", () => { const n = $("#vb-budget-note"); if (n) n.textContent = String($("#vb-budget").value || "").trim() ? "Saved when the build starts." : "No limit set: the build will not stop itself."; });
    for (const b of document.querySelectorAll("#vb-presets button")) {
      b.addEventListener("click", () => {
        studioTab = b.dataset.preset;
        if (studioTab !== "custom") pendingModules = (bridge() ? bridge().studioPresets()[studioTab] : null) || [];
        renderStudio();
      });
    }
    $("#vb-apply").addEventListener("click", applyStudio);
    $("#vb-plan-view").addEventListener("click", showPlanModal);
    for (const w of WINDOWS) {
      wireSend(w);
      const sel = $("#vb-model-" + w);
      sel.addEventListener("change", () => { state.chats[w].model = sel.value; saveDraft(); });
    }
    for (const t of document.querySelectorAll(".vb-win-toggle")) t.addEventListener("click", () => toggleWin(t.dataset.win));
    // Fresh start (Fred, 2026-07-26): wipe an advisor window mid-planning for an unbiased opinion.
    // It clears THAT window's conversation and nothing else.
    for (const f of document.querySelectorAll(".vb-win-fresh")) f.addEventListener("click", () => {
      const w = f.dataset.win;
      const hadDocs = docsOf(w).length;
      if (!state.chats[w] || (!state.chats[w].messages.length && !hadDocs)) { status(WNAME[w] + " is already a blank slate."); return; }
      state.chats[w].messages = [];
      // The desk goes with the conversation. An "unbiased second opinion" formed from the same
      // attached spec is not unbiased, and leaving files loaded after a wipe would be a surprise.
      state.chats[w].docs = [];
      renderLog(w);
      renderDesk(w);
      winNote(w, "");
      saveDraft();
      status(WNAME[w] + " has a clean slate" + (hadDocs ? " (documents taken off the desk too)" : "") + ". Ask for a fresh opinion.");
    });
    // Copy all: the whole conversation as clean text, one press, above the typing field.
    for (const c of document.querySelectorAll(".vb-copyall")) c.addEventListener("click", async () => {
      const w = c.dataset.win;
      const text = threadText(w);
      if (!text) { status(WNAME[w] + " has nothing to copy yet."); return; }
      const ok = await copyToClipboard(text);
      flashCopied(c, ok, document.getElementById("vb-log-" + w));
      if (ok) status(WNAME[w] + "'s conversation is on your clipboard, cleaned up for pasting.");
    });
    for (const g of document.querySelectorAll(".vb-grab")) wireGrab(g);
    $("#vb-orch-model").addEventListener("change", (e) => { if (state.army) { state.army.orchestrator = e.target.value; persistArmy(); } orchNote(""); });
    $("#vb-plan-tasks").addEventListener("click", planArmy);
    $("#vb-begin").addEventListener("click", beginBuilding);
  }

  /* ================= the plan from chat ====================================================== */

  // The full plan, word for word, in a window of its own (Fred, 2026-07-31: "a button that brings
  // up a window with the full plan, word for word from the chat").
  function showPlanModal() {
    if (!state.plan) return;
    const old = $("#vb-plan-modal"); if (old) old.remove();
    const overlay = document.createElement("div");
    overlay.className = "vb-modal"; overlay.id = "vb-plan-modal";
    overlay.innerHTML =
      '<div class="vb-modal-card">' +
        '<div class="vb-modal-head"><h3 class="vb-h">The plan from chat</h3>' +
          '<button type="button" class="vb-modal-copy">Copy</button>' +
          '<button type="button" class="vb-modal-x" aria-label="Close">&times;</button></div>' +
        '<div class="vb-modal-body"></div>' +
      '</div>';
    const body = overlay.querySelector(".vb-modal-body");
    body.textContent = (state.plan.name ? state.plan.name + "\n\n" : "") + state.plan.brief +
      (state.plan.transcript
        ? "\n\n" + "=".repeat(60) + "\nTHE CONVERSATION THIS CAME FROM, word for word\n" + "=".repeat(60) + "\n\n" + state.plan.transcript
        : "");
    document.body.append(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".vb-modal-x").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const copy = overlay.querySelector(".vb-modal-copy");
    copy.addEventListener("click", async () => { flashCopied(copy, await copyToClipboard(state.plan.brief), body); });
  }

  /*
   * Consume the chat hand-off (Fred, 2026-07-31: "It tells me it is reading the plan, brings me
   * to the profile selector, I pressed vibe coder, and then it just opened the screen with no
   * plan"). The plan is stored word for word behind the See-the-plan button, the project card is
   * staged with the plan's name ready to save, and the General opens the conversation itself:
   * a confirmation, a short summary, and the question of whether there is anything to add.
   */
  function consumePlanHandoff() {
    const b = bridge();
    if (!b || typeof b.pendingPlan !== "function") return;
    const ph = b.pendingPlan();
    if (!ph || !ph.brief) return;
    b.clearPendingPlan();
    state.plan = { name: ph.name || "", brief: ph.brief, transcript: ph.transcript || "" };
    const btn = $("#vb-plan-view"); if (btn) btn.hidden = false;
    /*
     * ASK for the name, always (Fred, 2026-07-31: "It created a box for a project, did not ask me
     * for a name"). The plan's suggested name is PREFILLED so one keystroke accepts it, but the
     * field opens focused and editable, because the project's name is the user's to choose and a
     * silently-named box teaches them the app decides such things on its own.
     */
    if (!staged) { staged = { name: ph.name || "", editing: true }; renderSlider(); }
    // Kick the General exactly once: only when its thread is empty (a later reopen must not
    // replay the hand-off on top of a conversation already underway).
    if (!state.chats.main.messages.length) {
      state.chats.main.messages.push({ from: "user", content: "Here is the plan from our chat, word for word:\n\n" + ph.brief });
      renderLog("main");
      toggleWin("main", true);
      askWindow("main");
    }
    saveDraft();
  }

  /* ================= open and close ========================================================== */

  /*
   * The one-off move from the old single global draft to per-project drafts. It runs once, and it
   * hands the old draft to the project on screen (or keeps it as unattached work when there is no
   * project yet) rather than dropping it. Nobody loses a planning conversation to a deploy.
   */
  function migrateLegacyDraft() {
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch {}
    if (!legacy) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    if (isEmptyState(legacy)) return;
    const wsId = currentProjectId();
    const existing = readLocal(wsId);
    const b = bridge();
    const remote = (b && b.crucibleFor && wsId) ? b.crucibleFor(wsId) : null;
    if (!isEmptyState(existing) || !isEmptyState(remote)) return;   // never overwrite real state
    try { localStorage.setItem(draftKeyFor(wsId), JSON.stringify(legacy)); } catch {}
  }

  function open() {
    const el = build();
    if (!el) return;
    if (!state.open) { migrateLegacyDraft(); loadProject(currentProjectId()); }
    state.open = true;
    el.hidden = false;
    renderSlider();
    renderSaveTo();
    renderBudget();
    renderStudio();
    paintAllModelSelects();
    gateArmy();
    for (const w of WINDOWS) { renderLog(w); renderDesk(w); toggleWin(w, state.chats[w].open); }
    // A plan saved from an earlier visit keeps its button; a fresh hand-off arms everything.
    const pv = $("#vb-plan-view"); if (pv) pv.hidden = !state.plan;
    consumePlanHandoff();
  }

  function close() {
    const el = $("#vb-shell");
    state.open = false;
    if (el) el.hidden = true;
  }

  // Workspaces and the catalog both load after the panel exists; repaint when they land.
  document.addEventListener("dominion-ide-state", () => { if (state.open) { renderSlider(); renderSaveTo(); paintAllModelSelects();
    if ($("#vb-adopt-panel") && !$("#vb-adopt-panel").hidden) paintAdoptChoices(); } });
  /*
   * The other device spoke. The project list is refreshed when the app comes back to the
   * foreground, and if the project on screen was planned on further elsewhere, the newer copy is
   * adopted here. loadProject compares timestamps, so this can never overwrite newer local work
   * with an older remote copy.
   */
  document.addEventListener("dominion-workspaces-changed", () => {
    if (!state.open) return;
    const wsId = currentProjectId();
    renderSlider(); renderSaveTo();
    if (!wsId) return;
    const b = bridge();
    const remote = (b && b.crucibleFor) ? b.crucibleFor(wsId) : null;
    const localAt = Number((readLocal(wsId) || {}).at || 0);
    if (remote && Number(remote.at || 0) > localAt) {
      loadProject(wsId);
      status("Updated from your other device.");
    }
  });
  // Closing the tab, backgrounding the app, or locking the phone flushes the pending sync rather
  // than stranding the last minute of planning on one device.
  window.addEventListener("pagehide", () => { if (state.open) saveDraft(true); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && state.open) saveDraft(true); });
  document.addEventListener("dominion-studio-changed", () => { if (state.open) gateArmy(); });

  window.dominionVibe = { open, close };
})();
