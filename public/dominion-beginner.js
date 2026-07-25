/*
 * The Crucible in Beginner mode: one conversation, from an idea to an app on the internet.
 *   Fred's ruling 2026-07-24, written after watching a non-technical person try the expert page.
 *
 * WHY THIS IS A SEPARATE SURFACE AND NOT CSS OVER THE OLD ONE.
 * Beginner mode used to be the engineer's page with drawers hidden. Everything a beginner did not
 * need was still there, one class away, and the shape of the screen still said "configure me".
 * A beginner needs the opposite shape: a big friendly conversation, a way to shout for help, and
 * nothing else on the screen at all. So this is its own surface, with its own five views, and the
 * expert page stands down entirely while it is up.
 *
 * THE FIVE VIEWS, in the order a person meets them:
 *   chat      the greeting, the interview, saved projects, HELP I'M STUCK, and BUILD IT when ready
 *   building  a game of Pong against the machine, with a welding robot counting the build down
 *   done      one button the size of the screen: SEE MY APP
 *   preview   the running app, with a conversation under it for changes and for going online
 *   (help)    a side conversation over any of them, which never touches the main one
 *
 * WHAT IT DOES NOT OWN. No build machinery, no folders, no job state: every one of those goes
 * through window.dominionIdeBridge, so this file cannot drift from what the engine actually did.
 * Progress numbers arrive on `dominion-build-progress` from dominion-lenses.js, derived from the
 * real job journal, which is why the robot's percentage and the Blueprint always agree.
 */
(() => {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const bridge = () => window.dominionIdeBridge || null;

  // The greeting Fred wrote, word for word. It is preloaded, so the conversation has already
  // started warmly by the time a person finishes reading the screen.
  const GREETING = "Great! I'm looking forward to walking you through this. If you want to build an app, "
    + "you came to the right place. I am here to walk you through it, step by step. Why don't you tell me "
    + "a bit about what you are trying to accomplish, and we can go from there?";
  const HELP_GREETING = "Hey, heard you were having trouble. What's up?";
  const REVIEW_GREETING = "What do you think? Do you like it as-is, or do you want to change it?";

  const state = {
    open: false,
    view: "chat",
    messages: [],          // the interview, in provider shape (content may carry pictures)
    vision: null,
    busy: false,
    jobId: "",
    staged: [],            // pictures waiting to ride the next message
    progress: { percent: 0, done: 0, total: 0, remainingMs: 0 },
    help: { messages: [], busy: false, staged: [] },
    review: { messages: [], busy: false, change: null },
    pong: null,
  };

  // A phone gets told about the CAMERA, a computer about the PAPERCLIP, and the interviewer is told
  // which one so it never points at a control this person cannot see.
  const isPhone = () => window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 620;
  const device = () => (isPhone() ? "mobile" : "desktop");

  /* ================= the shell ============================================================== */

  function build() {
    if ($("#bg-shell")) return $("#bg-shell");
    const stage = $("#ide-stage");
    if (!stage) return null;

    const el = document.createElement("section");
    el.className = "bg-shell";
    el.id = "bg-shell";
    el.innerHTML =
      // ---- the conversation view -------------------------------------------------------------
      '<div class="bg-view bg-view-chat" id="bg-view-chat">' +
        '<div class="bg-build-bar" id="bg-build-bar" hidden>' +
          '<button type="button" class="bg-build-btn" id="bg-build">BUILD IT</button>' +
        '</div>' +
        '<div class="bg-chat" id="bg-chat">' +
          '<div class="bg-log" id="bg-log" aria-live="polite"></div>' +
          '<div class="bg-tray" id="bg-tray" hidden></div>' +
          '<div class="bg-row">' +
            '<button type="button" class="bg-icon" id="bg-clip" title="Attach a picture" aria-label="Attach a picture">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5l6-6a3 3 0 014.2 4.2l-7.8 7.8a5 5 0 01-7-7l7.6-7.6"/></svg>' +
            '</button>' +
            '<button type="button" class="bg-icon" id="bg-cam" title="Take a photo" aria-label="Take a photo">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>' +
            '</button>' +
            '<textarea id="bg-in" rows="1" placeholder="Type here…" aria-label="Your message"></textarea>' +
            '<button type="button" class="bg-send" id="bg-send" aria-label="Send">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="bg-projects" id="bg-projects">' +
            '<span class="bg-projects-h">Saved Projects</span>' +
            '<div class="bg-projects-row" id="bg-projects-row"></div>' +
          '</div>' +
        '</div>' +
        '<div class="bg-under">' +
          '<button type="button" class="bg-stuck" id="bg-stuck">HELP,<br>I\'M STUCK</button>' +
        '</div>' +
      '</div>' +

      // ---- the build view: a game, and a robot that counts it down ---------------------------
      '<div class="bg-view bg-view-building" id="bg-view-building" hidden>' +
        '<h3 class="bg-build-title">Your app is being built. Fancy a game while you wait?</h3>' +
        '<div class="bg-pong-wrap">' +
          '<canvas id="bg-pong" width="640" height="400" aria-label="A game of Pong while you wait"></canvas>' +
          '<div class="bg-pong-hint" id="bg-pong-hint">Drag up and down to play</div>' +
        '</div>' +
        '<div class="bg-meter">' +
          '<div class="bg-robot" aria-hidden="true">' +
            '<svg viewBox="0 0 120 100">' +
              '<rect class="r-body" x="34" y="30" width="52" height="42" rx="10"/>' +
              '<rect class="r-neck" x="56" y="22" width="8" height="10"/>' +
              '<circle class="r-eye" cx="50" cy="48" r="8"/><circle class="r-eye" cx="70" cy="48" r="8"/>' +
              '<circle class="r-pupil" cx="50" cy="48" r="3.4"/><circle class="r-pupil" cx="70" cy="48" r="3.4"/>' +
              '<rect class="r-mouth" x="52" y="61" width="16" height="3" rx="1.5"/>' +
              '<circle class="r-ant" cx="60" cy="18" r="4"/>' +
              '<rect class="r-arm" x="84" y="52" width="20" height="6" rx="3"/>' +
              '<g class="r-torch"><rect x="100" y="50" width="14" height="10" rx="2"/></g>' +
              '<g class="r-sparks"><i></i></g>' +
              '<rect class="r-work" x="88" y="72" width="30" height="8" rx="2"/>' +
              '<g class="r-spark-dots">' +
                '<circle cx="112" cy="66" r="2"/><circle cx="106" cy="70" r="1.6"/><circle cx="117" cy="71" r="1.4"/>' +
              '</g>' +
            '</svg>' +
          '</div>' +
          '<div class="bg-meter-copy">' +
            '<div class="bg-bar"><i id="bg-bar-fill"></i></div>' +
            '<div class="bg-meter-line"><b id="bg-percent">Getting started</b><span id="bg-eta"></span></div>' +
            '<small id="bg-step"></small>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="bg-link" id="bg-watch">Show me what it is doing instead</button>' +
      '</div>' +

      // ---- the finished view ------------------------------------------------------------------
      '<div class="bg-view bg-view-done" id="bg-view-done" hidden>' +
        '<button type="button" class="bg-see" id="bg-see">SEE MY APP</button>' +
      '</div>' +

      // ---- the preview + review view ---------------------------------------------------------
      '<div class="bg-view bg-view-preview" id="bg-view-preview" hidden>' +
        '<div class="bg-frame-wrap" id="bg-frame-wrap"></div>' +
        '<div class="bg-chat bg-chat-review" id="bg-review">' +
          '<div class="bg-log" id="bg-review-log" aria-live="polite"></div>' +
          '<div class="bg-change-bar" id="bg-change-bar" hidden>' +
            '<button type="button" class="bg-build-btn" id="bg-change">MAKE THAT CHANGE</button>' +
          '</div>' +
          '<div class="bg-tray" id="bg-review-tray" hidden></div>' +
          '<div class="bg-row">' +
            '<button type="button" class="bg-icon" id="bg-review-clip" title="Attach a picture" aria-label="Attach a picture">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5l6-6a3 3 0 014.2 4.2l-7.8 7.8a5 5 0 01-7-7l7.6-7.6"/></svg>' +
            '</button>' +
            '<textarea id="bg-review-in" rows="1" placeholder="Tell me what you think…" aria-label="Your message"></textarea>' +
            '<button type="button" class="bg-send" id="bg-review-send" aria-label="Send">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // ---- the help conversation, over everything ---------------------------------------------
      '<div class="bg-help" id="bg-help" hidden role="dialog" aria-modal="true" aria-label="Help">' +
        '<div class="bg-help-card">' +
          '<header><b>HELP</b><button type="button" id="bg-help-x" aria-label="Close help">×</button></header>' +
          '<div class="bg-log" id="bg-help-log" aria-live="polite"></div>' +
          '<div class="bg-tray" id="bg-help-tray" hidden></div>' +
          '<div class="bg-row">' +
            '<button type="button" class="bg-icon" id="bg-help-clip" title="Attach a picture" aria-label="Attach a picture">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5l6-6a3 3 0 014.2 4.2l-7.8 7.8a5 5 0 01-7-7l7.6-7.6"/></svg>' +
            '</button>' +
            '<button type="button" class="bg-icon" id="bg-help-cam" title="Take a photo" aria-label="Take a photo">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>' +
            '</button>' +
            '<textarea id="bg-help-in" rows="1" placeholder="What happened?" aria-label="Your message"></textarea>' +
            '<button type="button" class="bg-send" id="bg-help-send" aria-label="Send">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // One file input per purpose. `capture` is what turns the phone's picker into the camera.
      '<input id="bg-file" type="file" accept="image/*" hidden />' +
      '<input id="bg-photo" type="file" accept="image/*" capture="environment" hidden />';

    stage.append(el);
    wire();
    return el;
  }

  /* ================= views ================================================================== */

  const VIEWS = ["chat", "building", "done", "preview"];
  function setView(v) {
    if (!VIEWS.includes(v)) return;
    state.view = v;
    for (const name of VIEWS) {
      const el = $("#bg-view-" + name);
      if (el) el.hidden = name !== v;
    }
    if (v === "building") startPong();
    else stopPong();
    const shell = $("#bg-shell");
    if (shell) shell.dataset.view = v;
  }

  /* ================= chat plumbing ========================================================== */

  function bubble(logSel, role, text, pictures) {
    const log = $(logSel);
    if (!log) return null;
    const b = document.createElement("div");
    b.className = "bgb " + (role === "user" ? "bgb-me" : "bgb-ai");
    if (text) {
      const p = document.createElement("p");
      p.textContent = text;
      b.append(p);
    }
    for (const src of pictures || []) {
      const img = document.createElement("img");
      img.className = "bgb-pic";
      img.src = src;
      img.alt = "The picture you sent";
      b.append(img);
    }
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function thinking(logSel) {
    const b = bubble(logSel, "ai", "");
    if (!b) return { remove() {} };
    b.classList.add("bgb-thinking");
    b.innerHTML = '<i></i><i></i><i></i>';
    return b;
  }

  // Pictures ride as provider-shaped parts. The text always comes first so a model that only reads
  // the first part still gets the question.
  function partsFor(text, pics) {
    if (!pics || !pics.length) return text;
    const parts = [];
    if (text) parts.push({ type: "text", text });
    for (const url of pics) parts.push({ type: "image_url", image_url: { url } });
    return parts;
  }

  async function askServer(phase, messages) {
    const r = await fetch("/ide/intake", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages, phase, device: device(),
        mode: "beginner", register: "plain",
        workspaceId: bridge() ? bridge().workspaceId() : "",
      }),
    });
    return r.json();
  }

  /* ---------- the main interview ---------------------------------------------------------- */

  async function sendMain() {
    const input = $("#bg-in");
    const text = (input.value || "").trim();
    const pics = state.staged.slice();
    if ((!text && !pics.length) || state.busy) return;
    input.value = "";
    input.style.height = "";
    state.staged = [];
    renderTray();
    bubble("#bg-log", "user", text, pics);
    state.messages.push({ role: "user", content: partsFor(text || "Here is a picture of what I mean.", pics) });
    await turn();
  }

  async function turn() {
    state.busy = true;
    const t = thinking("#bg-log");
    let j = null;
    try { j = await askServer("intake", state.messages); }
    catch { j = { error: "I could not reach the workshop just then. Try that again." }; }
    t.remove();
    state.busy = false;
    if (!j || j.error) { bubble("#bg-log", "ai", (j && j.error) || "Something went wrong. Try that again."); return; }
    // The assistant's turn is recorded with its markers intact, so the model can see its own
    // agreed vision on later turns exactly as the expert path records it.
    state.messages.push({ role: "assistant", content: (j.reply ? j.reply + "\n" : "") + (j.vision ? "VISION READY\n" + j.vision : "") });
    if (j.reply) bubble("#bg-log", "ai", j.reply);
    if (j.vision) {
      state.vision = j.vision;
      visionCard(j.vision);
      showBuildButton();
      if (bridge()) bridge().journey("ready");
    }
  }

  function visionCard(vision) {
    const log = $("#bg-log");
    const card = document.createElement("div");
    card.className = "bgb bgb-vision";
    const h = document.createElement("h4");
    h.textContent = "Here is what I will build";
    const body = document.createElement("div");
    body.textContent = vision;
    card.append(h, body);
    log.append(card);
    log.scrollTop = log.scrollHeight;
  }

  function showBuildButton() {
    const bar = $("#bg-build-bar");
    if (!bar) return;
    bar.hidden = false;
    bar.classList.add("just-arrived");
    setTimeout(() => bar.classList.remove("just-arrived"), 4000);
  }

  /* ---------- saved projects -------------------------------------------------------------- */

  function renderProjects() {
    const row = $("#bg-projects-row");
    if (!row || !bridge()) return;
    row.textContent = "";
    const list = bridge().workspaces();
    if (!list.length) {
      const none = document.createElement("span");
      none.className = "bg-project none";
      none.textContent = "None Saved";
      row.append(none);
      return;
    }
    for (const ws of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bg-project";
      b.textContent = ws.name || ws.id;
      b.addEventListener("click", () => openProject(ws));
      row.append(b);
    }
  }

  /*
   * Opening a saved project goes wherever that project actually IS, which is the honest thing to do
   * with a name someone taps: a finished build lands on SEE MY APP, a running one on the game, and
   * a project with no build yet simply becomes the folder this conversation will build into.
   */
  function openProject(ws) {
    const b = bridge();
    if (!b) return;
    b.selectWorkspace(ws.id);
    const jobs = b.jobs().filter((j) => j.workspaceId === ws.id);
    const live = jobs.find((j) => !j.done);
    const last = jobs.find((j) => j.done && j.outcome === "done");
    if (live) {
      state.jobId = live.id;
      b.follow(live.id);
      setView("building");
      return;
    }
    if (last) {
      state.jobId = last.id;
      b.follow(last.id, { replay: true });
      setView("done");
      return;
    }
    bubble("#bg-log", "ai", "Alright, we are working in " + (ws.name || "that project") + " now. Tell me what you would like to do with it.");
  }

  /* ---------- the build ------------------------------------------------------------------- */

  async function beginBuild(promptText) {
    const b = bridge();
    if (!b) return;
    const bar = $("#bg-build-bar");
    if (bar) bar.hidden = true;
    setView("building");
    resetMeter();
    // A beginner never picks a folder: if there is not one yet, one is made for them, quietly.
    if (!b.workspaceId()) {
      const first = state.messages.find((m) => m.role === "user");
      const hint = typeof (first && first.content) === "string" ? first.content : "my app";
      const made = await b.autoWorkspace(hint);
      if (!made.ok) {
        setView("chat");
        bubble("#bg-log", "ai", made.offline
          ? "Your computer is not connected yet, so there is nowhere to build this. Open app.dominion.tools on the computer you want the app built on, then come back here and press BUILD IT again. Nothing you have told me is lost."
          : (made.error || "I could not make a folder for the app just then. Try BUILD IT again in a moment."));
        showBuildButton();
        return;
      }
    }
    b.startBuild(promptText, (msg, bad) => {
      if (bad && msg) {
        setView("chat");
        bubble("#bg-log", "ai", msg);
        showBuildButton();
      }
    });
  }

  function resetMeter() {
    state.progress = { percent: 0, done: 0, total: 0, remainingMs: 0 };
    const fill = $("#bg-bar-fill"), pct = $("#bg-percent"), eta = $("#bg-eta"), step = $("#bg-step");
    if (fill) fill.style.width = "2%";
    if (pct) pct.textContent = "Getting started";
    if (eta) eta.textContent = "";
    if (step) step.textContent = "";
  }

  // Every number here came from the job journal (dominion-lenses.js). Nothing is invented: with no
  // finished step there is no average, so no time is shown at all.
  function onProgress(e) {
    const d = e.detail || {};
    state.progress = d;
    if (d.jobId) state.jobId = d.jobId;
    const fill = $("#bg-bar-fill"), pct = $("#bg-percent"), eta = $("#bg-eta"), step = $("#bg-step");
    if (!fill) return;
    fill.style.width = Math.max(2, d.percent || 0) + "%";
    if (pct) pct.textContent = d.total ? (d.percent || 0) + "% done" : "Getting started";
    if (eta) {
      eta.textContent = d.remainingMs > 0 ? "about " + humanMs(d.remainingMs) + " left (my best guess)" : "";
    }
    if (step) step.textContent = d.total ? "step " + Math.min(d.done + 1, d.total) + " of " + d.total : "";
    if (d.outcome === "done") finish();
    else if (d.outcome === "error" || d.outcome === "stopped") {
      setView("chat");
      bubble("#bg-log", "ai", "The build stopped before it finished. Nothing is lost. Tell me to try again, or tell me what to change first.");
      showBuildButton();
    }
  }

  function humanMs(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + " seconds";
    const m = Math.round(s / 60);
    return m + (m === 1 ? " minute" : " minutes");
  }

  function finish() {
    if (state.view === "done" || state.view === "preview") return;
    const fill = $("#bg-bar-fill"), pct = $("#bg-percent"), eta = $("#bg-eta");
    if (fill) fill.style.width = "100%";
    if (pct) pct.textContent = "Finished";
    if (eta) eta.textContent = "";
    setView("done");
  }

  /* ---------- the preview and the review conversation ------------------------------------- */

  async function openPreview() {
    const b = bridge();
    const wrap = $("#bg-frame-wrap");
    if (!wrap || !b) return;
    setView("preview");
    wrap.textContent = "";
    const waiting = document.createElement("p");
    waiting.className = "bg-frame-note";
    waiting.textContent = "Starting your app…";
    wrap.append(waiting);
    let j = null;
    try {
      const r = await fetch("/ide/preview/start", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: b.workspaceId() }) });
      j = await r.json();
    } catch { j = { error: "I could not start it just then." }; }
    wrap.textContent = "";
    if (!j || j.error) {
      const bad = document.createElement("p");
      bad.className = "bg-frame-note is-bad";
      // Honest: the app is built and on disk even when the preview cannot run.
      bad.textContent = (j && j.error) || "I could not start your app to show it here. It is still built and saved on your computer.";
      wrap.append(bad);
    } else {
      const frame = document.createElement("iframe");
      frame.className = "bg-frame";
      frame.src = "/ide/preview/p/?t=" + encodeURIComponent(state.jobId || "");
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
      frame.title = "Your app";
      wrap.append(frame);
    }
    if (!state.review.messages.length) {
      bubble("#bg-review-log", "ai", REVIEW_GREETING);
      // The review conversation carries the agreed vision as its opening context, so it can talk
      // about what was built without interviewing anybody again.
      state.review.messages.push({ role: "user", content: "The app you built for me is on the screen now. This is what we agreed to build:\n"
        + (state.vision || "(the conversation above)") + "\n\nI am looking at it now." });
      state.review.messages.push({ role: "assistant", content: REVIEW_GREETING });
    }
  }

  async function sendReview() {
    const input = $("#bg-review-in");
    const text = (input.value || "").trim();
    const pics = state.review.staged || [];
    if ((!text && !pics.length) || state.review.busy) return;
    input.value = "";
    input.style.height = "";
    state.review.staged = [];
    renderTray();
    bubble("#bg-review-log", "user", text, pics);
    state.review.messages.push({ role: "user", content: partsFor(text || "Here is a picture.", pics) });
    state.review.busy = true;
    const changeBar = $("#bg-change-bar");
    if (changeBar) changeBar.hidden = true;
    const t = thinking("#bg-review-log");
    let j = null;
    try { j = await askServer("review", state.review.messages); }
    catch { j = { error: "I could not reach the workshop just then. Try that again." }; }
    t.remove();
    state.review.busy = false;
    if (!j || j.error) { bubble("#bg-review-log", "ai", (j && j.error) || "Something went wrong. Try that again."); return; }
    state.review.messages.push({ role: "assistant", content: (j.reply ? j.reply + "\n" : "") + (j.vision ? "CHANGE READY\n" + j.vision : "") });
    if (j.reply) bubble("#bg-review-log", "ai", j.reply);
    if (j.vision) {
      state.review.change = j.vision;
      const card = document.createElement("div");
      card.className = "bgb bgb-vision";
      const h = document.createElement("h4");
      h.textContent = "The change I will make";
      const body = document.createElement("div");
      body.textContent = j.vision;
      card.append(h, body);
      $("#bg-review-log").append(card);
      $("#bg-review-log").scrollTop = $("#bg-review-log").scrollHeight;
      if (changeBar) changeBar.hidden = false;
    }
  }

  /* ---------- the help conversation ------------------------------------------------------- */

  function openHelp() {
    const panel = $("#bg-help");
    if (!panel) return;
    panel.hidden = false;
    if (!state.help.messages.length) {
      bubble("#bg-help-log", "ai", HELP_GREETING);
      state.help.messages.push({ role: "user", content: "I pressed HELP, I'M STUCK." });
      state.help.messages.push({ role: "assistant", content: HELP_GREETING });
    }
    const input = $("#bg-help-in");
    if (input) input.focus();
  }

  async function sendHelp() {
    const input = $("#bg-help-in");
    const text = (input.value || "").trim();
    const pics = state.help.staged || [];
    if ((!text && !pics.length) || state.help.busy) return;
    input.value = "";
    input.style.height = "";
    state.help.staged = [];
    renderTray();
    bubble("#bg-help-log", "user", text, pics);
    state.help.messages.push({ role: "user", content: partsFor(text || "Here is a picture of the problem.", pics) });
    state.help.busy = true;
    const t = thinking("#bg-help-log");
    let j = null;
    try { j = await askServer("stuck", state.help.messages); }
    catch { j = { error: "I could not reach the workshop just then. Try that again." }; }
    t.remove();
    state.help.busy = false;
    if (!j || j.error) { bubble("#bg-help-log", "ai", (j && j.error) || "Something went wrong. Try that again."); return; }
    state.help.messages.push({ role: "assistant", content: j.reply || "" });
    bubble("#bg-help-log", "ai", j.reply || "I am not sure what to say to that. Ask me another way?");
  }

  /* ---------- pictures -------------------------------------------------------------------- */

  let stageTarget = "main";

  // Phone photos are 4000px wide and several megabytes. Downscaled on the device before it ever
  // leaves, both because the provider caps request size and because a beginner on mobile data
  // should not pay to upload a photograph of a napkin at full resolution.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const edge = 1400;
        const scale = Math.min(1, edge / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
      img.src = url;
    });
  }

  function stagedFor(target) {
    return target === "help" ? state.help.staged : target === "review" ? state.review.staged : state.staged;
  }

  function renderTray() {
    const map = { main: "#bg-tray", help: "#bg-help-tray", review: "#bg-review-tray" };
    for (const [target, sel] of Object.entries(map)) {
      const tray = $(sel);
      if (!tray) continue;
      const pics = stagedFor(target) || [];
      tray.textContent = "";
      tray.hidden = !pics.length;
      pics.forEach((src, i) => {
        const cell = document.createElement("span");
        cell.className = "bg-tray-cell";
        const img = document.createElement("img");
        img.src = src;
        img.alt = "Picture to send";
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.setAttribute("aria-label", "Remove this picture");
        x.addEventListener("click", () => { pics.splice(i, 1); renderTray(); });
        cell.append(img, x);
        tray.append(cell);
      });
    }
  }

  async function takeFiles(input, target) {
    const files = [...(input.files || [])].filter((f) => /^image\//.test(f.type)).slice(0, 2);
    input.value = "";
    for (const f of files) {
      try {
        const url = await shrink(f);
        const pics = stagedFor(target);
        if (pics.length < 2) pics.push(url);
      } catch {
        const logs = { main: "#bg-log", help: "#bg-help-log", review: "#bg-review-log" };
        bubble(logs[target] || "#bg-log", "ai", "I could not read that picture. Try another one?");
      }
    }
    renderTray();
  }

  /* ================= Pong ==================================================================
   * A real game, deliberately kept to about a hundred lines: paddle, ball, wall bounces, a machine
   * opponent that tracks the ball with a deliberate lag so it can be beaten, and a score. It exists
   * because a build takes minutes and a progress bar alone makes minutes feel like hours.
   *
   * It stops dead when the view changes or the tab is hidden: a canvas loop running behind a
   * finished build is battery a phone should not be spending.
   */
  function startPong() {
    const cv = $("#bg-pong");
    if (!cv || state.pong) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const g = {
      raf: 0, timer: 0, watchdog: 0, frames: 0, driver: "raf", running: true,
      py: H / 2 - 34, ay: H / 2 - 34, ph: 68, pw: 9,
      bx: W / 2, by: H / 2, vx: 4.2, vy: 2.6, r: 6,
      you: 0, them: 0,
    };
    state.pong = g;

    const move = (clientY) => {
      const rect = cv.getBoundingClientRect();
      const y = (clientY - rect.top) * (H / rect.height);
      g.py = Math.max(0, Math.min(H - g.ph, y - g.ph / 2));
    };
    g.onMove = (e) => { move(e.clientY); if (e.cancelable) e.preventDefault(); };
    g.onKey = (e) => {
      if (e.key === "ArrowUp") { g.py = Math.max(0, g.py - 26); e.preventDefault(); }
      else if (e.key === "ArrowDown") { g.py = Math.min(H - g.ph, g.py + 26); e.preventDefault(); }
    };
    cv.addEventListener("pointermove", g.onMove);
    cv.addEventListener("pointerdown", g.onMove);
    cv.addEventListener("keydown", g.onKey);
    cv.tabIndex = 0;

    const reset = (toward) => {
      g.bx = W / 2; g.by = H / 2;
      g.vx = 4.2 * toward; g.vy = (Math.random() > 0.5 ? 1 : -1) * (1.8 + Math.random() * 1.6);
    };

    const step = () => {
      if (!g.running) return;
      // paddle for the machine: tracks the ball, but slowly enough to be beatable
      const target = g.by - g.ph / 2;
      g.ay += Math.max(-3.4, Math.min(3.4, target - g.ay)) * 0.9;
      g.ay = Math.max(0, Math.min(H - g.ph, g.ay));

      g.bx += g.vx; g.by += g.vy;
      if (g.by - g.r < 0) { g.by = g.r; g.vy = -g.vy; }
      if (g.by + g.r > H) { g.by = H - g.r; g.vy = -g.vy; }

      // your paddle, on the left
      if (g.bx - g.r < 22 + g.pw && g.bx > 22 && g.by > g.py && g.by < g.py + g.ph && g.vx < 0) {
        g.vx = Math.abs(g.vx) * 1.03;
        g.vy += ((g.by - (g.py + g.ph / 2)) / (g.ph / 2)) * 1.5;
      }
      // the machine's paddle, on the right
      if (g.bx + g.r > W - 22 - g.pw && g.bx < W - 22 && g.by > g.ay && g.by < g.ay + g.ph && g.vx > 0) {
        g.vx = -Math.abs(g.vx) * 1.03;
        g.vy += ((g.by - (g.ay + g.ph / 2)) / (g.ph / 2)) * 1.5;
      }
      g.vy = Math.max(-7, Math.min(7, g.vy));
      if (g.bx < -20) { g.them++; reset(1); }
      if (g.bx > W + 20) { g.you++; reset(-1); }

      // paint
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "rgba(255,255,255,.09)";
      for (let y = 8; y < H; y += 30) ctx.fillRect(W / 2 - 1.5, y, 3, 16);
      ctx.fillStyle = "#d4823c";
      ctx.fillRect(22, g.py, g.pw, g.ph);
      ctx.fillStyle = "#76ff68";
      ctx.fillRect(W - 22 - g.pw, g.ay, g.pw, g.ph);
      ctx.beginPath();
      ctx.arc(g.bx, g.by, g.r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff3dc";
      ctx.fill();
      ctx.font = "600 26px ui-monospace, monospace";
      ctx.fillStyle = "rgba(255,255,255,.35)";
      ctx.textAlign = "center";
      ctx.fillText(String(g.you), W / 2 - 46, 38);
      ctx.fillText(String(g.them), W / 2 + 46, 38);

      g.frames++;
      if (g.driver === "raf") g.raf = requestAnimationFrame(step);
    };

    /*
     * TWO DRIVERS, and the reason is a trap this codebase has already paid for once (see the note in
     * dominion-lenses.js): requestAnimationFrame NEVER fires where the page is considered hidden,
     * and some environments call themselves hidden while the person is looking straight at them.
     * An embedded browser pane does it, and a PWA behind another app does it. rAF alone would leave
     * a blank black box exactly where a game was promised. So: start on rAF, and if no frame has
     * arrived within a quarter of a second, take over with a 30fps timer.
     *
     * A LATER, REAL transition to hidden still stops the game (see the visibilitychange handler):
     * an initial hidden state is the lie, a transition is the truth.
     */
    g.driver = "raf";
    g.raf = requestAnimationFrame(step);
    g.watchdog = setTimeout(() => {
      if (g.frames > 0 || !g.running) return;
      g.driver = "timer";
      g.timer = setInterval(step, 33);
    }, 250);
  }

  function stopPong() {
    const g = state.pong;
    if (!g) return;
    g.running = false;
    cancelAnimationFrame(g.raf);
    clearTimeout(g.watchdog);
    clearInterval(g.timer);
    const cv = $("#bg-pong");
    if (cv) {
      cv.removeEventListener("pointermove", g.onMove);
      cv.removeEventListener("pointerdown", g.onMove);
      cv.removeEventListener("keydown", g.onKey);
    }
    state.pong = null;
  }

  /*
   * A TRANSITION to hidden is a real signal (the person switched apps), so the game stops and stops
   * spending battery. The INITIAL hidden state is not trustworthy, which is why startPong never
   * consults document.hidden and leans on its own watchdog instead.
   */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPong();
    else if (state.open && state.view === "building") startPong();
  });

  /* ================= wiring ================================================================ */

  function autosize(el) {
    el.style.height = "";
    el.style.height = Math.min(120, el.scrollHeight) + "px";
  }

  function wire() {
    const main = $("#bg-in");
    $("#bg-send").addEventListener("click", sendMain);
    main.addEventListener("input", () => autosize(main));
    main.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMain(); } });

    $("#bg-clip").addEventListener("click", () => { stageTarget = "main"; $("#bg-file").click(); });
    $("#bg-cam").addEventListener("click", () => { stageTarget = "main"; $("#bg-photo").click(); });
    $("#bg-file").addEventListener("change", (e) => takeFiles(e.target, stageTarget));
    $("#bg-photo").addEventListener("change", (e) => takeFiles(e.target, stageTarget));

    $("#bg-build").addEventListener("click", () => {
      const first = state.messages.find((m) => m.role === "user");
      const goal = typeof (first && first.content) === "string" ? first.content : "the app we discussed";
      beginBuild(state.vision
        ? goal + "\n\nAGREED VISION (approved by the user; build exactly this):\n" + state.vision
        : goal);
    });

    $("#bg-stuck").addEventListener("click", openHelp);
    $("#bg-help-x").addEventListener("click", () => { $("#bg-help").hidden = true; });
    const help = $("#bg-help-in");
    $("#bg-help-send").addEventListener("click", sendHelp);
    help.addEventListener("input", () => autosize(help));
    help.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHelp(); } });
    $("#bg-help-clip").addEventListener("click", () => { stageTarget = "help"; $("#bg-file").click(); });
    $("#bg-help-cam").addEventListener("click", () => { stageTarget = "help"; $("#bg-photo").click(); });

    $("#bg-see").addEventListener("click", openPreview);
    $("#bg-watch").addEventListener("click", () => {
      // The escape hatch for anyone who would rather watch the machinery than play a game. It shows
      // the real build view, which is the same one every other mode uses.
      const shell = $("#bg-shell");
      if (shell) shell.classList.add("bg-watching");
      stopPong();
    });

    const review = $("#bg-review-in");
    $("#bg-review-send").addEventListener("click", sendReview);
    review.addEventListener("input", () => autosize(review));
    review.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReview(); } });
    $("#bg-review-clip").addEventListener("click", () => { stageTarget = "review"; $("#bg-file").click(); });
    $("#bg-change").addEventListener("click", () => {
      const change = state.review.change;
      if (!change) return;
      $("#bg-change-bar").hidden = true;
      // A change is a build like any other, against the same folder, described as a change so the
      // engine works on what exists instead of starting over.
      beginBuild("CHANGE TO THE APP THAT IS ALREADY BUILT IN THIS FOLDER. Make exactly this change and nothing else:\n" + change);
    });
  }

  /* ================= open and close ========================================================= */

  function open() {
    const el = build();
    if (!el) return;
    state.open = true;
    el.hidden = false;
    document.body.classList.add("bg-mode");
    if (!$("#bg-log").children.length) bubble("#bg-log", "ai", GREETING);
    renderProjects();
    renderTray();
    if (state.view === "chat" && state.vision) showBuildButton();
    setView(state.view);
  }

  function close() {
    const el = $("#bg-shell");
    state.open = false;
    stopPong();
    document.body.classList.remove("bg-mode");
    if (el) el.hidden = true;
    const help = $("#bg-help");
    if (help) help.hidden = true;
  }

  document.addEventListener("dominion-build-progress", onProgress);
  // A build that finishes while the beginner is somewhere else still lands on SEE MY APP.
  document.addEventListener("dominion-build-done", () => { if (state.open) finish(); });
  // Workspaces load after the panel opens, so the saved-projects row is painted again when they land.
  document.addEventListener("dominion-ide-state", () => { if (state.open) renderProjects(); });

  window.dominionBeginner = { open, close, view: () => state.view, setView };
})();
