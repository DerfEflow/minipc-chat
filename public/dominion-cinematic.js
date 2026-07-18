(() => {
  "use strict";

  function buildCinematicShell() {
    const sprite = document.querySelector("svg.svg-sprite");
    if (sprite && !document.getElementById("i-shield")) {
      sprite.insertAdjacentHTML("beforeend", `
        <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.6-2.8 8-7 10-4.2-2-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-5"/></symbol>
        <symbol id="i-chip" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></symbol>
        <symbol id="i-wave" viewBox="0 0 24 24"><path d="M3 13h2l1.5-5 3 10 3-14 3 14 2-8 1.5 3H21"/></symbol>
        <symbol id="i-link" viewBox="0 0 24 24"><path d="M9.5 14.5l5-5M7 17H5a4 4 0 010-8h4M17 7h2a4 4 0 010 8h-4"/></symbol>
        <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3M12 14v2"/></symbol>
        <symbol id="i-gauge" viewBox="0 0 24 24"><path d="M4 17a8 8 0 1116 0"/><path d="M12 13l4-4M7 17h10"/></symbol>
        <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></symbol>`);
    }

    const sidebar = document.getElementById("sidebar");
    if (sidebar && !sidebar.classList.contains("archive-rail")) {
      sidebar.classList.add("archive-rail");
      const head = sidebar.querySelector(".sb-head");
      head?.insertAdjacentHTML("afterend", '<div class="rail-cap">Strategic Sessions</div>');
      const chatlist = document.getElementById("chatlist");
      chatlist?.insertAdjacentHTML("afterend", `
        <section class="vault-module" aria-label="Knowledge vault">
          <div class="rail-cap">Knowledge Vault</div>
          <div class="vault-grid">
            <button type="button"><svg class="glyph"><use href="#i-artifact"></use></svg><span>Corporate Intelligence</span></button>
            <button type="button"><svg class="glyph"><use href="#i-context"></use></svg><span>Technology Archive</span></button>
            <button type="button"><svg class="glyph"><use href="#i-memory"></use></svg><span>Personal Playbook</span></button>
          </div>
        </section>
        <section class="prime-module">
          <span class="prime-core"><svg class="glyph"><use href="#i-core"></use></svg><i></i></span>
          <div><b>Dominion Prime</b><small>Core link: stable</small></div>
          <span class="prime-bars"><i></i><i></i><i></i><i></i></span>
        </section>`);
    }

    const brand = document.querySelector(".brand-copy");
    if (brand && !brand.querySelector(".brand-motto")) brand.insertAdjacentHTML("beforeend", '<span class="brand-motto">Master. Strategize. Transcend.</span>');

    const labels = { artifacts:"Artifacts", improve:"Mentor", persona:"Persona Forge", memory:"Memory", tools:"Tools", settings:"Settings" };
    Object.entries(labels).forEach(([id,label]) => {
      const button = document.getElementById(id);
      if (button && !button.querySelector(".command-label")) button.insertAdjacentHTML("beforeend", `<span class="command-label">${label}</span>`);
    });

    const pane = document.getElementById("neural-glass");
    const scan = pane?.querySelector(".glass-scan");
    if (pane && !pane.querySelector(".scene-core")) {
      scan?.insertAdjacentHTML("afterend", `
        <div class="pane-title"><span>Strategic Intelligence Surface</span><i></i></div>
        <div class="scene-core" aria-hidden="true">
          <div class="core-halo h1"></div><div class="core-halo h2"></div>
          <div class="processor"><svg class="glyph"><use href="#i-core"></use></svg><span>DOMINION CORE</span><i></i></div>
          <div class="circuit-spine s1"></div><div class="circuit-spine s2"></div><div class="circuit-spine s3"></div>
        </div>`);
    }

    const send = document.getElementById("send");
    if (send && !document.querySelector(".console-tune")) send.insertAdjacentHTML("beforebegin", '<button type="button" class="mic console-tune" title="Command controls" aria-label="Command controls"><svg class="glyph"><use href="#i-sliders"></use></svg></button>');

    if (pane && !document.querySelector(".telemetry-rail")) {
      pane.insertAdjacentHTML("afterend", `
        <aside class="telemetry-rail" aria-label="System telemetry">
          <section class="telemetry-card efficiency-card">
            <div class="module-title"><svg class="glyph"><use href="#i-gauge"></use></svg><span>System Telemetry</span></div>
            <div class="efficiency-gauge" id="efficiency-gauge"><div><b id="efficiency-value">98.7%</b><small>Efficiency</small></div></div>
            <dl class="telemetry-list">
              <div><dt>UI Load</dt><dd id="telemetry-load">24%</dd></div>
              <div><dt>Device Memory</dt><dd id="telemetry-memory">--</dd></div>
              <div><dt>Threads</dt><dd id="telemetry-threads">--</dd></div>
              <div><dt>Session</dt><dd id="telemetry-session">00:00</dd></div>
              <div><dt>Link</dt><dd class="green">Stable</dd></div>
            </dl>
          </section>
          <section class="telemetry-card context-card">
            <div class="module-title"><svg class="glyph"><use href="#i-context"></use></svg><span>Context Window</span></div>
            <div class="context-cube"><span></span><i></i></div>
            <b class="context-count" id="context-count">128K / 128K</b><small>Available tokens</small>
          </section>
          <section class="telemetry-card security-card">
            <div class="module-title"><svg class="glyph"><use href="#i-shield"></use></svg><span>Security Status</span></div>
            <div class="security-row"><svg class="glyph"><use href="#i-lock"></use></svg><span>Local route<b>AES transport</b></span></div>
            <div class="security-row"><svg class="glyph"><use href="#i-shield"></use></svg><span>Integrity<b>Verified</b></span></div>
          </section>
        </aside>
        <div class="console-footer" aria-label="Dominion system status">
          <div class="clock-module"><b id="hud-time">--:--</b><small id="hud-date">---</small></div>
          <div class="footer-module"><svg class="glyph"><use href="#i-wave"></use></svg><span>Uptime<b id="hud-uptime">00D 00H 00M</b></span></div>
          <div class="footer-module"><svg class="glyph"><use href="#i-link"></use></svg><span>Nexus Link<b>Stable</b></span></div>
          <div class="core-link"><i></i><span>Dominion AI Core Link</span><b>ONLINE</b><i></i></div>
          <div class="footer-module data-module"><svg class="glyph"><use href="#i-network"></use></svg><span>Data Stream<b id="hud-stream">Ready</b></span><em></em></div>
        </div>`);
    }

    // The richer v31 empty-state copy is authored in index.html so it paints immediately and
    // stays available when this enhancement layer is disabled. Do not flatten it at runtime.
  }

  buildCinematicShell();

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const pane = $("neural-glass");
  const reflection = pane?.querySelector(".glass-reflection");
  const commandbar = $("commandbar");
  const send = $("send");
  const speak = $("speak");
  const mic = $("mic");
  const model = $("model");
  const mode = $("mode");
  const wrap = $("wrap");
  const activity = $("activity-status");
  const connection = $("connection-status");
  const context = $("context-status");
  const video = $("bgvideo");
  const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const coarse = !!window.matchMedia?.("(pointer: coarse)").matches;
  const sessionStarted = Date.now();

  const icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "glyph");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  };

  function setButtonIcon(button, name) {
    if (!button) return;
    const existing = button.querySelector("svg.glyph");
    if (existing?.querySelector("use")?.getAttribute("href") === "#i-" + name) return;
    button.replaceChildren(icon(name));
  }

  function syncVoiceIcons() {
    setButtonIcon(speak, "speaker");
    setButtonIcon(mic, "mic");
  }

  function syncConnection() {
    const online = navigator.onLine;
    body.dataset.online = String(online);
    if (!connection) return;
    connection.classList.toggle("is-live", online);
    connection.classList.toggle("is-offline", !online);
    const label = connection.querySelector("span");
    if (label) label.textContent = online ? "Online" : "Offline";
  }

  function syncBusy() {
    const busy = !!send?.classList.contains("stop");
    body.classList.toggle("is-thinking", busy);
    if (activity) activity.textContent = busy ? "Processing directive" : "All systems nominal";
  }

  // syncContext() writes into the context-status label, which lives inside document.body — the
  // very subtree the MutationObserver below watches. Assigning textContent (even the same value)
  // is a childList mutation, so an unconditional write here made the observer fire, call
  // syncContext() again, write again… a self-triggering microtask loop that pegged the main
  // thread before the first paint, so the redesigned UI never came up. Track the state we last
  // rendered and only touch the DOM on a real transition, so the observer settles instead of
  // looping forever.
  let contextState = null;
  function syncContext() {
    if (!context || !wrap) return;
    const next = wrap.querySelector(".msgmeta, .ctx, .tool") ? "active" : "ready";
    if (next === contextState) return;
    contextState = next;
    const label = context.querySelector("span");
    const text = next === "active" ? "Context active" : "Context ready";
    if (label && label.textContent !== text) label.textContent = text;
    context.classList.toggle("is-live", next === "active");
  }

  const actionMap = new Map([
    ["Edit", "edit"], ["Copy", "copy"], ["Save", "save"], ["Critique", "critique"],
    ["Continue", "continue"], ["Regenerate", "regenerate"], ["🔎", "inspect"],
    ["💡", "lesson"], ["🧪", "eval"], ["Delete", "delete"], ["Back", "continue"],
  ]);

  function decorateAction(button) {
    if (!(button instanceof HTMLElement) || button.dataset.dominionIcon) return;
    const text = (button.textContent || "").trim();
    const name = actionMap.get(text);
    if (!name) return;
    button.dataset.dominionIcon = name;
    const label = text === "🔎" ? "Inspect" : text === "💡" ? "Save lesson" : text === "🧪" ? "Create evaluation" : text;
    button.textContent = "";
    button.append(icon(name), document.createTextNode(label));
  }

  function decorateChatRow(node) {
    if (!(node instanceof HTMLElement)) return;
    node.querySelectorAll(".ci .x").forEach((el) => {
      const title = (el.getAttribute("title") || "").toLowerCase();
      const name = title.includes("rename") ? "edit" : title.includes("delete") ? "delete" : null;
      if (!name || el.dataset.dominionIcon) return;
      el.dataset.dominionIcon = name;
      el.textContent = "";
      el.appendChild(icon(name));
    });
  }

  const emojiRules = [
    [/^🧠\s*/, "memory"], [/^📄\s*/, "artifact"], [/^💬\s*/, "context"],
    [/^🔧\s*/, "tools"], [/^🔒\s*/, "lock"], [/^⏸\s*/, "mode"],
  ];

  function decorateContextNode(node) {
    if (!(node instanceof HTMLElement) || node.dataset.dominionDecorated) return;
    if (!node.matches(".msgmeta span, .ctx")) return;
    const raw = node.textContent || "";
    const rule = emojiRules.find(([rx]) => rx.test(raw));
    if (!rule) return;
    node.dataset.dominionDecorated = "1";
    node.textContent = raw.replace(rule[0], "");
    node.prepend(icon(rule[1]));
  }

  function decorateTool(node) {
    if (!(node instanceof HTMLElement) || !node.matches(".tool") || node.dataset.dominionTool) return;
    node.dataset.dominionTool = "1";
    const label = Array.from(node.children).find((child) => child.tagName === "SPAN" && !child.classList.contains("sp") && !child.classList.contains("cls"));
    if (!label) return;
    label.textContent = (label.textContent || "").replace(/^[🔧🔒✓✗⛔⃠]\s*/, "");
    label.prepend(icon(node.classList.contains("gated") ? "lock" : "tools"));
  }

  function decorate(scope = document) {
    scope.querySelectorAll?.(".act").forEach(decorateAction);
    decorateChatRow(scope);
    scope.querySelectorAll?.(".msgmeta span, .ctx").forEach(decorateContextNode);
    scope.querySelectorAll?.(".tool").forEach(decorateTool);
    syncVoiceIcons();
  }

  const pulseCommand = () => {
    if (!commandbar || reduced) return;
    body.classList.remove("panel-transition");
    void body.offsetWidth;
    body.classList.add("panel-transition");
    window.setTimeout(() => body.classList.remove("panel-transition"), 850);
  };

  commandbar?.querySelectorAll(".command-icon").forEach((button) => button.addEventListener("click", pulseCommand));
  document.querySelector(".console-tune")?.addEventListener("click", pulseCommand);
  model?.addEventListener("change", pulseCommand);
  mode?.addEventListener("change", pulseCommand);

  function ensureVideo() {
    if (!video) return;
    const live = () => body.classList.remove("video-fallback");
    const failed = () => body.classList.add("video-fallback");
    video.addEventListener("playing", live);
    video.addEventListener("canplay", live);
    video.addEventListener("error", failed);
    video.addEventListener("stalled", failed);
    const kick = () => video.play().then(live).catch(failed);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
    window.addEventListener("pageshow", kick);
    window.setTimeout(() => {
      if (video.readyState < 2 || video.paused) failed();
      kick();
    }, 900);
    kick();
  }

  if (pane && !reduced && !coarse) {
    let frame = 0;
    let pending = null;
    const renderPointer = () => {
      frame = 0;
      if (!pending) return;
      const rect = pane.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (pending.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (pending.clientY - rect.top) / rect.height));
      root.style.setProperty("--glare-x", (x * 100).toFixed(2) + "%");
      root.style.setProperty("--glare-y", (y * 100).toFixed(2) + "%");
      root.style.setProperty("--signal-x", (x * 100).toFixed(2) + "%");
      if (reflection) reflection.style.transform = `translateX(${((x - .5) * 230).toFixed(1)}px) rotate(17deg)`;
    };
    window.addEventListener("pointermove", (event) => {
      pending = event;
      if (!frame) frame = requestAnimationFrame(renderPointer);
    }, { passive: true });
    pane.addEventListener("pointerleave", () => {
      if (reflection) reflection.style.transform = "translateX(0) rotate(17deg)";
    });
  }

  let frameCount = 0;
  let frameWindow = performance.now();
  let uiLoad = 22;
  function sampleFrames(now) {
    frameCount++;
    if (now - frameWindow > 1200) {
      const fps = frameCount * 1000 / (now - frameWindow);
      uiLoad = Math.max(8, Math.min(78, Math.round(82 - fps)));
      frameCount = 0;
      frameWindow = now;
    }
    requestAnimationFrame(sampleFrames);
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function updateTelemetry() {
    const now = new Date();
    const elapsed = Math.max(0, Date.now() - sessionStarted);
    const minutes = Math.floor(elapsed / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const minuteRemainder = minutes % 60;
    const hourRemainder = hours % 24;
    const efficiency = 98.1 + Math.sin(Date.now() / 5200) * .7;
    const effAngle = Math.max(310, Math.min(358, efficiency / 100 * 360));
    root.style.setProperty("--eff-angle", effAngle.toFixed(1) + "deg");

    const time = $("hud-time");
    const date = $("hud-date");
    const uptime = $("hud-uptime");
    const stream = $("hud-stream");
    const efficiencyValue = $("efficiency-value");
    const load = $("telemetry-load");
    const memory = $("telemetry-memory");
    const threads = $("telemetry-threads");
    const session = $("telemetry-session");

    if (time) time.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (date) date.textContent = now.toLocaleDateString([], { month: "short", day: "2-digit", year: "numeric" });
    if (uptime) uptime.textContent = `${pad(days)}D ${pad(hourRemainder)}H ${pad(minuteRemainder)}M`;
    if (stream) stream.textContent = body.classList.contains("is-thinking") ? "Streaming" : "Ready";
    if (efficiencyValue) efficiencyValue.textContent = efficiency.toFixed(1) + "%";
    if (load) load.textContent = uiLoad + "%";
    if (memory) memory.textContent = navigator.deviceMemory ? navigator.deviceMemory + " GB" : "Ready";
    if (threads) threads.textContent = navigator.hardwareConcurrency || "--";
    if (session) session.textContent = `${pad(hours)}:${pad(minuteRemainder)}`;
  }

  window.addEventListener("online", syncConnection);
  window.addEventListener("offline", syncConnection);

  if (send) new MutationObserver(syncBusy).observe(send, { attributes: true, childList: true, subtree: true });
  if (speak) new MutationObserver(syncVoiceIcons).observe(speak, { attributes: true, childList: true, subtree: true });

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        decorate(node);
        if (node.matches(".act")) decorateAction(node);
        if (node.matches(".tool")) decorateTool(node);
        if (node.matches(".msgmeta span, .ctx")) decorateContextNode(node);
      }
    }
    syncContext();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (reflection) reflection.style.transform = "translateX(0) rotate(17deg)";
  ensureVideo();
  syncConnection();
  syncBusy();
  syncContext();
  decorate();
  updateTelemetry();
  setInterval(updateTelemetry, 1000);
  requestAnimationFrame(sampleFrames);

  // ===== Command deck: exclusive panels, click-away close, live Knowledge Vault, readout popovers =====
  const MODAL_IDS = ["smodal", "mmodal", "pmodal", "tmodal", "amodal", "imodal", "vault-panel"];
  const MODAL_FOR = { settings: "smodal", memory: "mmodal", persona: "pmodal", tools: "tmodal", artifacts: "amodal", improve: "imodal" };
  const openModals = () => MODAL_IDS.map((id) => $(id)).filter((m) => m && !m.hidden);
  const closeModals = (except) => { MODAL_IDS.forEach((id) => { if (id === except) return; const m = $(id); if (m && !m.hidden) m.hidden = true; }); };

  // Opening any panel closes the others first (capture phase runs before app.js's own open handler),
  // so the header icons SWITCH panels instead of stacking sheets the user must x out of one by one.
  Object.entries(MODAL_FOR).forEach(([buttonId, modalId]) => {
    $(buttonId)?.addEventListener("click", () => { closeModals(modalId); closePopover(); }, true);
  });
  // Click anywhere outside the open sheet closes it; clicking the dim backdrop does too.
  document.addEventListener("pointerdown", (event) => {
    const open = openModals();
    if (!open.length) return;
    const target = event.target;
    if (target.closest?.(".command-icon") || target.closest?.(".vault-grid")) return;
    open.forEach((m) => { if (target === m || !m.contains(target)) m.hidden = true; });
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeModals(); closePopover(); } });

  // ---- Knowledge Vault: the three rail entries open live, tenant-scoped data terminals ----
  function ensureVault() {
    if ($("vault-panel")) return;
    const panel = document.createElement("section");
    panel.id = "vault-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.innerHTML = `
      <div class="vp-frame">
        <div class="vp-head"><span class="vp-title" id="vault-title">VAULT</span><button type="button" class="vp-close" id="vault-close" aria-label="Close">×</button></div>
        <div class="vp-body" id="vault-body"></div>
        <div class="vp-foot"><i></i><span>DOMINION KNOWLEDGE VAULT · SECURE CHANNEL</span><i></i></div>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector("#vault-close").addEventListener("click", () => { panel.hidden = true; });
  }
  const vpLine = (text, cls) => `<div class="vp-line${cls ? " " + cls : ""}">${text}</div>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function openVault(kind) {
    ensureVault();
    closeModals("vault-panel");
    closePopover();
    // On the phone the rail is the slide-in menu; opening a terminal should put the menu away.
    document.getElementById("sidebar")?.classList.remove("open");
    document.getElementById("overlay")?.classList.remove("show");
    const panel = $("vault-panel"), title = $("vault-title"), out = $("vault-body");
    const names = { ci: "CORPORATE INTELLIGENCE", ta: "TECHNOLOGY ARCHIVE", pp: "PERSONAL PLAYBOOK" };
    title.textContent = names[kind] || "VAULT";
    panel.hidden = false;
    out.innerHTML = vpLine("ACCESSING SECURE ARCHIVE…", "dim");
    try {
      if (kind === "ci") {
        const d = await (await fetch("/artifacts")).json();
        const items = (d && d.items) || [];
        out.innerHTML = items.length
          ? vpLine("FILED DOCUMENTS · " + items.length, "cap") + items.map((a) =>
              `<div class="vp-row"><b>${esc(a.title)}</b><span>${esc(a.type || "doc")} · ${esc(a.status || "")} · v${esc(a.version ?? 1)} · ${esc(a.wordCount ?? 0)} words</span></div>`).join("")
          : vpLine("ARCHIVE EMPTY.", "cap") + vpLine("Documents you generate or save land here. Open the Artifacts panel to create, export, and manage them.", "dim");
        out.innerHTML += vpLine("Full controls live in the Artifacts panel (top bar).", "hint");
      } else if (kind === "ta") {
        const d = await (await fetch("/api/models", { cache: "no-store" })).json();
        const groups = (d && d.groups) || [];
        out.innerHTML = vpLine("MODEL ARSENAL · LIVE CATALOG", "cap") + groups.map((g) =>
          vpLine(esc(g.category || "MODELS"), "group") + (g.models || []).map((m) =>
            `<div class="vp-row"><b>${esc(m.name)}${m.toolCapable ? ' <em class="vp-badge">TOOLS</em>' : ""}</b><span>${[m.params && m.params !== "undisclosed" ? esc(m.params) : null, m.ctx ? esc(Math.round(m.ctx / 1000)) + "K context" : null, (!m.inCost && !m.outCost) ? "free" : "$" + esc(m.inCost) + " / $" + esc(m.outCost) + " per M"].filter(Boolean).join(" · ")}</span></div>`).join("")).join("");
        out.innerHTML += vpLine("Pick any of these from the Model selector in the command bar.", "hint");
      } else {
        const d = await (await fetch("/memory")).json();
        const items = (d && d.items) || [];
        out.innerHTML = items.length
          ? vpLine("PLAYBOOK ENTRIES · " + items.length, "cap") + items.map((m) =>
              `<div class="vp-row"><b>${esc((m.text || m.content || m.summary || "").slice(0, 90) || "(entry)")}</b><span>${esc(m.kind || m.status || "saved")}</span></div>`).join("")
          : vpLine("PLAYBOOK EMPTY.", "cap") + vpLine("Lasting facts, preferences, and lessons the assistant saves about your work land here. Ask it to remember something important.", "dim");
        out.innerHTML += vpLine("Full controls live in the Memory panel (top bar).", "hint");
      }
    } catch {
      out.innerHTML = vpLine("LINK ERROR — the archive did not answer. Try again.", "err");
    }
  }
  document.querySelectorAll(".vault-grid button").forEach((button, index) => {
    button.addEventListener("click", () => openVault(["ci", "ta", "pp"][index]));
  });

  // ---- Readout popovers: the header status lights answer when touched ----
  let pop = null;
  function closePopover() { if (pop) { pop.remove(); pop = null; } }
  function showPopover(anchor, title, lines) {
    closePopover();
    pop = document.createElement("div");
    pop.className = "readout-pop";
    pop.innerHTML = `<b>${title}</b>` + lines.map((l) => `<span>${l}</span>`).join("");
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 10) + "px";
    pop.style.left = Math.max(12, Math.min(window.innerWidth - pop.offsetWidth - 12, r.left + r.width / 2 - pop.offsetWidth / 2)) + "px";
  }
  document.addEventListener("pointerdown", (event) => {
    if (pop && !pop.contains(event.target) && !event.target.closest?.(".readout")) closePopover();
  });
  connection?.addEventListener("click", () => {
    showPopover(connection, navigator.onLine ? "ONLINE" : "OFFLINE", [
      navigator.onLine ? "Link to the Dominion core is live." : "No network. Reconnect to continue.",
      "Answers, memory, and documents flow over this link.",
    ]);
  });
  context?.addEventListener("click", () => {
    const active = contextState === "active";
    showPopover(context, active ? "CONTEXT ACTIVE" : "CONTEXT READY", [
      "Context is what the assistant loads alongside your message:",
      "your saved memories, filed documents, and tool results.",
      active ? "This conversation is drawing on loaded context now." : "Nothing loaded yet. It fills as you work.",
    ]);
  });
  document.getElementById("cloudbadge")?.addEventListener("click", (event) => {
    const label = document.getElementById("model-current")?.textContent?.trim() || "a cloud model";
    showPopover(event.currentTarget, "CLOUD ROUTE", [
      "Answers are routing to: " + label + ".",
      "Paid cloud model: each reply draws on your balance.",
      "Switch models anytime from the Model selector.",
    ]);
  });

  // ---- The sliders button becomes the command-controls shortcut it claims to be ----
  document.querySelector(".console-tune")?.addEventListener("click", () => {
    closeModals();
    document.getElementById("model-trigger")?.click();
  });

  // ---- Context Window card: real numbers for the picked model (was a hard-coded "128K" prop) ----
  const contextCount = $("context-count");
  let ctxMap = null;
  const fmtC = (n) => !n ? "--" : n >= 950000 ? String(Math.round(n / 100000) / 10).replace(/\.0$/, "") + "M" : Math.round(n / 1000) + "K";
  async function loadCtxMap() {
    try {
      const d = await (await fetch("/api/models", { cache: "no-store" })).json();
      ctxMap = new Map();
      for (const g of (d.groups || [])) for (const m of (g.models || [])) ctxMap.set(m.id, m.ctx || 0);
    } catch { ctxMap = new Map(); }
    updateContextCard();
  }
  function updateContextCard() {
    if (!contextCount || !ctxMap) return;
    const id = model ? model.value : "";
    // Local models are not in the cloud catalog; Qwen3's native window is 32K on-box.
    const total = ctxMap.get(id) || 32768;
    const usedTokens = Math.round((wrap ? wrap.textContent.length : 0) / 4);   // rough: 4 chars per token
    const available = Math.max(0, total - usedTokens);
    contextCount.textContent = fmtC(available) + " / " + fmtC(total);
  }
  model?.addEventListener("change", updateContextCard);
  setInterval(updateContextCard, 5000);
  loadCtxMap();
})();
