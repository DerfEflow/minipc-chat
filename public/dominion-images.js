// Dominion Forge Images — Codex design wired live. Self-contained IIFE, same contract as
// dominion-forge.js: injects its own DOM under #dfi-root, owns the slide-right reveal (the
// whole interface slides off RIGHT; back/close in the command rail return), and keeps every
// forged image in the DEVICE's IndexedDB vault. Brand rule: the engine cell reads DOMINION
// FORGE, never a model name. Server wire: /api/images/{config,generate,refine,batch,batches}.
(() => {
  "use strict";

  const API = {
    config: "/api/images/config",
    generate: "/api/images/generate",
    refine: "/api/images/refine",
    batch: "/api/images/batch",
    batches: "/api/images/batches",
  };
  const SIZES = { square: "1024 × 1024", portrait: "1024 × 1536", landscape: "1536 × 1024" };
  const PROMPT_CAP = 4000;
  const REF_CAP = 10;

  // Fallback copy of the published gpt-image-2 tables; /api/images/config overrides at runtime.
  let CFG = {
    available: true,
    syncMaxN: 4,
    tokens: {
      low: { square: 200, portrait: 167, landscape: 167 },
      medium: { square: 1767, portrait: 1367, landscape: 1367 },
      high: { square: 7033, portrait: 5500, landscape: 5500 },
    },
    prices: {
      low: { square: 0.006, portrait: 0.005, landscape: 0.005 },
      medium: { square: 0.053, portrait: 0.041, landscape: 0.041 },
      high: { square: 0.211, portrait: 0.165, landscape: 0.165 },
    },
    batch: { discount: 0.5, window: "24h", maxItemsGuest: 50, maxItemsOwner: 200 },
  };

  const state = {
    open: false,
    quality: "medium",
    aspect: "square",
    batch: false,
    refs: [],                 // staged reference plates [{dataUrl, name}]
    queue: [],                // foundry directives [{prompt, quality, aspect}]
    jobs: [],
    filter: "all",
    search: "",
    generating: false,
    pollTimer: null,
    faultTimer: null,
    progressTimer: null,
  };
  try { state.queue = JSON.parse(localStorage.getItem("dfi.queue") || "[]"); } catch {}
  const dismissed = new Set(JSON.parse(localStorage.getItem("dfi.dismissedJobs") || "[]"));
  const saveQueue = () => localStorage.setItem("dfi.queue", JSON.stringify(state.queue));
  const saveDismissed = () => localStorage.setItem("dfi.dismissedJobs", JSON.stringify([...dismissed]));

  // ---------- local vault (IndexedDB) ----------
  const DB_NAME = "dominion-forge-images";
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const rq = indexedDB.open(DB_NAME, 1);
        rq.onupgradeneeded = () => {
          const store = rq.result.createObjectStore("images", { keyPath: "id" });
          store.createIndex("ts", "ts");
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    }
    return dbPromise;
  }
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("images", mode);
      const out = fn(t.objectStore("images"));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  };
  const vaultPut = (rec) => tx("readwrite", (s) => s.put(rec));
  const vaultDelete = (id) => tx("readwrite", (s) => s.delete(id));
  const vaultClear = () => tx("readwrite", (s) => s.clear());
  async function vaultAll() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const rq = d.transaction("images").objectStore("images").index("ts").getAll();
      rq.onsuccess = () => resolve((rq.result || []).reverse());
      rq.onerror = () => reject(rq.error);
    });
  }
  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || "image/png" });
  }
  async function vaultSave(b64, meta) {
    const seq = (parseInt(localStorage.getItem("dfi.seq") || "0", 10) || 0) + 1;
    localStorage.setItem("dfi.seq", String(seq));
    const rec = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      blob: b64ToBlob(b64, "image/png"),
      ts: Date.now(),
      seq,
      prompt: meta.prompt || "",
      quality: meta.quality || "",
      aspect: meta.aspect || "",
      source: meta.source || "sync",
      favorite: false,
    };
    await vaultPut(rec);
    return rec;
  }

  // ---------- helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtUsd = (v) => "$" + (v >= 0.01 ? v.toFixed(3) : v.toFixed(4));
  const pad4 = (n) => String(n).padStart(4, "0");
  async function apiJson(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const err = new Error((j && j.error) || "Request failed (HTTP " + r.status + ").");
      err.code = j && j.code;
      throw err;
    }
    return j || {};
  }
  function friendly(e) {
    if (e.code === "needs_invite" || e.code === "needs_credits") return e.message + " Open Setup to continue.";
    return e.message;
  }

  // ---------- estimates (published OpenAI tables) ----------
  const tokensFor = () => (CFG.tokens[state.quality] || {})[state.aspect] || 0;
  const priceFor = (batch) => ((CFG.prices[state.quality] || {})[state.aspect] || 0) * (batch ? CFG.batch.discount : 1);
  function renderEstimate() {
    $("#token-estimate").textContent = tokensFor().toLocaleString();
    $("#cost-estimate").textContent = fmtUsd(priceFor(state.batch));
    $("#route-estimate").textContent = state.batch ? "BATCH · <24H" : "IMMEDIATE";
    $("#size-label").textContent = SIZES[state.aspect];
    const lit = { low: 3, medium: 6, high: 10 }[state.quality] || 6;
    $$("#dfi-root .energy-meter i").forEach((bar, i) => bar.classList.toggle("lit", i < lit));
    $("b", $("#forge-button")).textContent = state.batch ? "QUEUE IN BATCH FOUNDRY" : "IGNITE THE FORGE";
  }

  // ---------- fault/status strip ----------
  function strip() { return $("#generation-strip"); }
  function showFault(message) {
    const s = strip();
    s.hidden = false;
    s.classList.add("fault");
    $("#generation-status").textContent = message;
    s.querySelector("b").textContent = "FORGE CHAMBER FAULT";
    $("#generation-progress").style.width = "100%";
    $("#generation-percent").textContent = "!";
    clearTimeout(state.faultTimer);
    state.faultTimer = setTimeout(() => { if (!state.generating) s.hidden = true; s.classList.remove("fault"); }, 7000);
  }
  function stripBusy(title, status) {
    const s = strip();
    s.hidden = false;
    s.classList.remove("fault");
    s.querySelector("b").textContent = title;
    $("#generation-status").textContent = status;
  }
  function stripDone(status) {
    $("#generation-progress").style.width = "100%";
    $("#generation-percent").textContent = "100%";
    $("#generation-status").textContent = status;
    setTimeout(() => { if (!state.generating) strip().hidden = true; }, 1600);
  }

  // ---------- markup ----------
  function buildPanel() {
    const root = document.createElement("section");
    root.id = "dfi-root";
    root.setAttribute("aria-label", "Dominion Forge Images");
    root.innerHTML = `
  <div class="scene" aria-hidden="true">
    <div class="scene-grid"></div>
    <div class="scene-reactor"></div>
    <div class="scene-sparks"><i></i><i></i><i></i><i></i><i></i><i></i></div>
  </div>

  <div class="app-shell">
    <header class="command-rail">
      <div class="brand-lockup">
        <button class="rail-button back-button" type="button" aria-label="Return to Dominion AI">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7M8 12h11"/></svg>
        </button>
        <div class="brand-reactor" aria-hidden="true"><span></span><i></i></div>
        <div>
          <p class="eyebrow">DOMINION CREATIVE SYSTEMS</p>
          <h1>FORGE <span>IMAGES</span></h1>
        </div>
      </div>

      <div class="rail-status" aria-label="Forge status">
        <div class="status-cell"><span class="pulse-dot"></span><small>ENGINE</small><b>DOMINION FORGE</b></div>
        <div class="status-cell"><svg viewBox="0 0 24 24"><path d="M4 8h16v11H4zM8 8V5h8v3M8 12h8M8 15h5"/></svg><small>ARCHIVE</small><b>THIS DEVICE</b></div>
        <div class="status-cell"><svg viewBox="0 0 24 24"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg><small>VAULT LOAD</small><b id="dfi-vault-load">—</b></div>
      </div>

      <button class="rail-button close-button" type="button" aria-label="Close Forge Images">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>

    <main class="forge-layout">
      <aside class="control-deck glass-panel">
        <div class="panel-specular" aria-hidden="true"></div>
        <section class="deck-section directive-section">
          <div class="section-heading">
            <div><span>01</span><p>CREATIVE DIRECTIVE</p></div>
            <small id="prompt-count">0 / ${PROMPT_CAP}</small>
          </div>
          <div class="prompt-frame">
            <textarea id="prompt" maxlength="${PROMPT_CAP}" aria-label="Image prompt" placeholder="Describe the vision to forge…"></textarea>
            <div class="prompt-tools">
              <button type="button" id="dfi-refine" aria-label="Enhance prompt"><svg viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3ZM18.5 15l.7 2.1 2.3.9-2.3.9-.7 2.1-.7-2.1-2.3-.9 2.3-.9.7-2.1Z"/></svg><span>Refine</span></button>
              <button type="button" id="dfi-clear" aria-label="Clear prompt"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14"/></svg></button>
            </div>
          </div>
          <div class="reference-well" id="dfi-ref-well" tabindex="0" role="button" aria-label="Add reference images">
            <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM7 15l3-3 3 3 2-2 3 3M15.5 8.5h.01"/></svg>
            <div><b>ADD REFERENCE PLATES</b><small id="dfi-ref-note">Drop or select up to ${REF_CAP} images · immediate forges only</small></div>
            <span>+</span>
          </div>
          <div class="reference-tray" id="dfi-ref-tray"></div>
          <input id="dfi-ref-input" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden />
        </section>

        <section class="deck-section">
          <div class="section-heading"><div><span>02</span><p>RENDER FIDELITY</p></div><small>OUTPUT QUALITY</small></div>
          <div class="segment-grid quality-grid" role="radiogroup" aria-label="Render quality">
            <button type="button" class="segment" data-quality="low" role="radio" aria-checked="false"><span class="quality-rune">I</span><b>LOW</b><small>Rapid concept</small></button>
            <button type="button" class="segment selected" data-quality="medium" role="radio" aria-checked="true"><span class="quality-rune">II</span><b>MEDIUM</b><small>Production</small></button>
            <button type="button" class="segment" data-quality="high" role="radio" aria-checked="false"><span class="quality-rune">III</span><b>HIGH</b><small>Maximum detail</small></button>
          </div>
        </section>

        <section class="deck-section">
          <div class="section-heading"><div><span>03</span><p>FRAME GEOMETRY</p></div><small id="size-label">1024 × 1024</small></div>
          <div class="segment-grid aspect-grid" role="radiogroup" aria-label="Image orientation">
            <button type="button" class="segment selected" data-aspect="square" role="radio" aria-checked="true"><i class="shape square"></i><b>SQUARE</b><small>1:1</small></button>
            <button type="button" class="segment" data-aspect="portrait" role="radio" aria-checked="false"><i class="shape portrait"></i><b>PORTRAIT</b><small>2:3</small></button>
            <button type="button" class="segment" data-aspect="landscape" role="radio" aria-checked="false"><i class="shape landscape"></i><b>LANDSCAPE</b><small>3:2</small></button>
          </div>
        </section>

        <section class="batch-module" id="batch-module">
          <div class="batch-icon" aria-hidden="true"><i></i><i></i><i></i></div>
          <div><span>BATCH FOUNDRY</span><b>50% RATE REDUCTION</b><small>Charged when you seal the batch · overcharges return as credits · completes within 24 hours</small></div>
          <button id="batch-toggle" class="power-toggle" type="button" role="switch" aria-checked="false" aria-label="Use Batch Foundry"><i></i></button>
        </section>

        <section class="telemetry-module" aria-live="polite">
          <div class="telemetry-line"><span>EST. IMAGE TOKENS</span><b id="token-estimate">1,767</b></div>
          <div class="telemetry-line"><span>EST. OUTPUT COST</span><b id="cost-estimate">$0.053</b></div>
          <div class="telemetry-line"><span>DELIVERY ROUTE</span><b id="route-estimate">IMMEDIATE</b></div>
          <div class="energy-meter"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <p>Published OpenAI figures per setting. The final charge follows real usage.</p>
        </section>

        <button id="forge-button" class="forge-button" type="button">
          <span class="forge-core" aria-hidden="true"><i></i></span>
          <span><small>DOMINION IMAGE ENGINE</small><b>IGNITE THE FORGE</b></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5"/></svg>
        </button>

        <section class="foundry-tray" id="dfi-foundry" hidden>
          <header><b>FOUNDRY QUEUE · <span id="dfi-foundry-count">0</span></b><button type="button" id="dfi-foundry-clear" title="Empty the queue">×</button></header>
          <div id="dfi-foundry-rows"></div>
          <button type="button" class="foundry-submit" id="dfi-foundry-submit">SEAL THE BATCH · CHARGE NOW AT 50%</button>
        </section>
      </aside>

      <section class="vault glass-panel">
        <div class="panel-specular" aria-hidden="true"></div>
        <header class="vault-header">
          <div>
            <p class="eyebrow"><span class="pulse-dot"></span> LOCAL CREATION VAULT</p>
            <h2>YOUR <span>FORGED VISIONS</span></h2>
            <p class="vault-note">Images remain on this device. Dominion stores no cloud gallery.</p>
          </div>
          <div class="vault-actions">
            <label class="search-control"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg><input id="dfi-search" type="search" placeholder="Search this device" aria-label="Search local gallery"></label>
            <button type="button" class="filter-button active" data-filter="all">ALL <span id="dfi-count-all">0</span></button>
            <button type="button" class="filter-button" data-filter="favorite" aria-label="Show favorites"><svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg></button>
            <button type="button" class="filter-button" data-filter="batch">BATCH</button>
          </div>
        </header>

        <div class="generation-strip" id="generation-strip" hidden>
          <div class="forge-spinner"><i></i><i></i><i></i></div>
          <div><b>FORGE CHAMBER ACTIVE</b><span id="generation-status">Charging creative lattice…</span></div>
          <div class="progress-track"><i id="generation-progress"></i></div>
          <strong id="generation-percent">0%</strong>
        </div>

        <div class="gallery" id="gallery"></div>

        <footer class="vault-footer">
          <div><span class="storage-light"></span><b id="dfi-vault-title">LOCAL VAULT</b><small id="dfi-vault-stats">—</small></div>
          <button type="button" id="dfi-purge">PURGE VAULT <svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14"/></svg></button>
        </footer>
      </section>
    </main>
  </div>`;
    document.body.append(root);
    wirePanel(root);
  }

  // ---------- wiring ----------
  function wirePanel(root) {
    $$(".back-button, .close-button", root).forEach((b) => b.addEventListener("click", closePanel));

    $$("[data-quality]", root).forEach((b) => b.addEventListener("click", () => {
      state.quality = b.dataset.quality;
      $$("[data-quality]", root).forEach((x) => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", String(x === b)); });
      renderEstimate();
    }));
    $$("[data-aspect]", root).forEach((b) => b.addEventListener("click", () => {
      state.aspect = b.dataset.aspect;
      $$("[data-aspect]", root).forEach((x) => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", String(x === b)); });
      renderEstimate();
    }));

    const batchToggle = $("#batch-toggle", root);
    batchToggle.addEventListener("click", () => {
      state.batch = !state.batch;
      batchToggle.setAttribute("aria-checked", String(state.batch));
      $("#batch-module", root).classList.toggle("active", state.batch);
      renderEstimate();
    });

    const prompt = $("#prompt", root);
    const count = $("#prompt-count", root);
    const updateCount = () => { count.textContent = prompt.value.length.toLocaleString() + " / " + PROMPT_CAP; };
    prompt.addEventListener("input", updateCount);
    updateCount();

    $("#dfi-clear", root).addEventListener("click", () => { prompt.value = ""; prompt.focus(); updateCount(); });

    $("#dfi-refine", root).addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const text = prompt.value.trim();
      if (!text || btn.disabled) return;
      btn.disabled = true;
      btn.querySelector("span").textContent = "Refining…";
      try {
        const r = await apiJson(API.refine, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: text }) });
        if (r.prompt) { prompt.value = r.prompt.slice(0, PROMPT_CAP); updateCount(); }
        btn.querySelector("span").textContent = "Refined";
      } catch (e) {
        showFault(friendly(e));
        btn.querySelector("span").textContent = "Refine";
      } finally {
        setTimeout(() => { btn.querySelector("span").textContent = "Refine"; btn.disabled = false; }, 1200);
      }
    });

    // reference plates
    const refInput = $("#dfi-ref-input", root);
    $("#dfi-ref-well", root).addEventListener("click", () => refInput.click());
    $("#dfi-ref-well", root).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); refInput.click(); } });
    refInput.addEventListener("change", async () => {
      for (const f of [...refInput.files].slice(0, REF_CAP - state.refs.length)) {
        try { state.refs.push({ dataUrl: await downscale(f), name: f.name }); } catch {}
      }
      refInput.value = "";
      renderRefs();
    });

    $("#forge-button", root).addEventListener("click", onIgnite);
    $("#dfi-foundry-submit", root).addEventListener("click", onFoundrySubmit);
    $("#dfi-foundry-clear", root).addEventListener("click", () => { state.queue = []; saveQueue(); renderFoundry(); });

    $("#dfi-search", root).addEventListener("input", (e) => { state.search = e.target.value.trim().toLowerCase(); renderGallery(); });
    $$("[data-filter]", root).forEach((b) => b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      $$("[data-filter]", root).forEach((x) => x.classList.toggle("active", x === b));
      renderGallery();
    }));

    $("#dfi-purge", root).addEventListener("click", async () => {
      if (!confirm("Purge every image from the on-device vault? This cannot be undone.")) return;
      await vaultClear();
      renderGallery();
    });

    renderEstimate();
    renderFoundry();
    renderRefs();
  }

  function renderRefs() {
    const tray = $("#dfi-ref-tray");
    if (!tray) return;
    tray.innerHTML = "";
    state.refs.forEach((r, i) => {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = r.dataUrl;
      img.alt = r.name || "reference";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "Remove reference";
      rm.addEventListener("click", () => { state.refs.splice(i, 1); renderRefs(); });
      fig.append(img, rm);
      tray.append(fig);
    });
    const note = $("#dfi-ref-note");
    if (note) note.textContent = state.refs.length
      ? state.refs.length + " of " + REF_CAP + " plates staged · immediate forges only"
      : "Drop or select up to " + REF_CAP + " images · immediate forges only";
  }

  function downscale(file, max = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.87));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
      img.src = url;
    });
  }

  // ---------- forging ----------
  const STATUS_LINE = [
    [20, "Interpreting creative directive…"],
    [42, "Forming spatial composition…"],
    [64, "Casting luminous materials…"],
    [84, "Resolving final detail lattice…"],
  ];
  function startProgress() {
    let progress = 6, si = 0;
    $("#generation-progress").style.width = progress + "%";
    $("#generation-percent").textContent = progress + "%";
    clearInterval(state.progressTimer);
    state.progressTimer = setInterval(() => {
      progress = Math.min(92, progress + Math.max(0.4, (92 - progress) * 0.045));
      while (STATUS_LINE[si] && progress >= STATUS_LINE[si][0]) { $("#generation-status").textContent = STATUS_LINE[si][1]; si++; }
      $("#generation-progress").style.width = progress + "%";
      $("#generation-percent").textContent = Math.round(progress) + "%";
    }, 300);
  }
  function stopProgress() { clearInterval(state.progressTimer); state.progressTimer = null; }

  async function onIgnite() {
    const prompt = $("#prompt").value.trim();
    if (!prompt) return showFault("Describe the vision first.");
    if (state.batch) {
      if (state.refs.length) return showFault("Reference plates ride immediate forges only. Disengage the Batch Foundry or clear the plates.");
      const maxItems = CFG.batch.maxItemsOwner || 200;
      if (state.queue.length >= maxItems) return showFault("The foundry queue is full.");
      state.queue.push({ prompt, quality: state.quality, aspect: state.aspect });
      saveQueue();
      renderFoundry();
      return;
    }
    if (state.generating) return;
    state.generating = true;
    const btn = $("#forge-button");
    btn.disabled = true;
    btn.classList.add("igniting");
    btn.setAttribute("aria-busy", "true");
    stripBusy("FORGE CHAMBER ACTIVE", "Charging creative lattice…");
    startProgress();
    try {
      const r = await apiJson(API.generate, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, quality: state.quality, aspect: state.aspect, n: 1, refs: state.refs.map((x) => x.dataUrl) }),
      });
      for (const img of r.images || []) await vaultSave(img.b64, { prompt, quality: r.quality, aspect: r.aspect, source: "sync" });
      stopProgress();
      stripDone("Vision sealed to local vault · " + (r.usage && r.usage.outputTokens ? r.usage.outputTokens.toLocaleString() + " tokens · " : "") + fmtUsd(r.costUsd || 0));
      state.refs = [];
      renderRefs();
      renderGallery();
    } catch (e) {
      stopProgress();
      showFault(friendly(e));
    } finally {
      state.generating = false;
      btn.disabled = false;
      btn.classList.remove("igniting");
      btn.removeAttribute("aria-busy");
    }
  }

  // ---------- foundry (batch) ----------
  function renderFoundry() {
    const tray = $("#dfi-foundry");
    if (!tray) return;
    tray.hidden = !state.queue.length;
    $("#dfi-foundry-count").textContent = state.queue.length;
    const rows = $("#dfi-foundry-rows");
    rows.innerHTML = "";
    let est = 0;
    state.queue.forEach((q, i) => {
      est += ((CFG.prices[q.quality] || {})[q.aspect] || 0) * CFG.batch.discount;
      const row = document.createElement("div");
      row.className = "foundry-row";
      row.innerHTML = `<span>${esc(q.prompt)}</span><small>${esc(q.quality)} · ${SIZES[q.aspect]}</small>`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.addEventListener("click", () => { state.queue.splice(i, 1); saveQueue(); renderFoundry(); });
      row.append(rm);
      rows.append(row);
    });
    $("#dfi-foundry-submit").textContent = `SEAL THE BATCH · ${state.queue.length} VISION${state.queue.length === 1 ? "" : "S"} · ${fmtUsd(est)} CHARGED NOW`;
  }
  async function onFoundrySubmit() {
    if (!state.queue.length) return;
    const btn = $("#dfi-foundry-submit");
    btn.disabled = true;
    try {
      const r = await apiJson(API.batch, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: state.queue }) });
      state.queue = [];
      saveQueue();
      renderFoundry();
      stripBusy("BATCH FOUNDRY SEALED", `${r.count} vision${r.count === 1 ? "" : "s"} queued · ${fmtUsd(r.estUsd)} charged · ready within ${CFG.batch.window} (usually sooner)`);
      stripDone("Overcharges return to your credits at collection.");
      refreshJobs();
    } catch (e) {
      showFault(friendly(e));
    } finally {
      btn.disabled = false;
    }
  }
  async function refreshJobs(opts) {
    try {
      const r = await apiJson(API.batches);
      state.jobs = (r.jobs || []).filter((j) => !dismissed.has(j.id));
      renderGallery();
    } catch (e) {
      if (!opts || !opts.quiet) renderGallery();
    }
  }
  const JOB_LABELS = {
    validating: "VALIDATING", in_progress: "FORGING", finalizing: "FINALIZING",
    completed: "READY", failed: "FAILED · REFUNDED", expired: "EXPIRED · REFUNDED", cancelled: "CANCELLED · REFUNDED", cancelling: "CANCELLING",
  };
  async function collectBatch(id, btn) {
    btn.disabled = true;
    btn.textContent = "COLLECTING…";
    let offset = 0, saved = 0;
    stripBusy("FOUNDRY DELIVERY", "Collecting forged visions…");
    startProgress();
    try {
      for (;;) {
        const r = await apiJson(API.batch + "/" + encodeURIComponent(id) + "?offset=" + offset + "&limit=4");
        if (r.status !== "completed") { stopProgress(); showFault("Batch is " + (JOB_LABELS[r.status] || r.status).toLowerCase() + "."); break; }
        for (const img of r.images || []) {
          await vaultSave(img.b64, { prompt: img.prompt, quality: img.quality, aspect: img.aspect, source: "batch" });
          saved++;
        }
        $("#generation-status").textContent = `Collecting forged visions… ${saved}/${r.total}`;
        renderGallery();
        offset += (r.images || []).length;
        if (r.done || !(r.images || []).length) {
          stopProgress();
          const settle = r.refundedCredits ? ` · ${r.refundedCredits} credit${r.refundedCredits === 1 ? "" : "s"} returned` : r.extraCredits ? ` · ${r.extraCredits} extra credit${r.extraCredits === 1 ? "" : "s"} for overage` : "";
          stripDone(`${saved} vision${saved === 1 ? "" : "s"} sealed to the vault` + (r.failed ? ` · ${r.failed} failed` : "") + (r.costUsd != null ? ` · ${fmtUsd(r.costUsd)} actual` : "") + settle);
          dismissed.add(id);
          saveDismissed();
          break;
        }
      }
      refreshJobs({ quiet: true });
    } catch (e) {
      stopProgress();
      showFault(friendly(e));
      btn.disabled = false;
      btn.textContent = "COLLECT";
    }
  }

  // ---------- vault rendering ----------
  const objectUrls = [];
  function jobCard(j) {
    const card = document.createElement("article");
    card.className = "creation-card";
    card.dataset.kind = "batch";
    const label = JOB_LABELS[j.status] || j.status.toUpperCase();
    card.innerHTML = `
      <div class="creation-art art-forge"><i></i><i></i><i></i></div>
      <div class="card-chrome"><span>FOUNDRY · ${esc(label)}</span></div>
      <div class="creation-meta"><div><b>${j.count} VISION${j.count === 1 ? "" : "S"} IN THE FOUNDRY</b><small>${new Date(j.ts).toLocaleString()} · ${fmtUsd(j.estUsd)} charged at seal</small></div></div>`;
    const meta = card.querySelector(".creation-meta");
    if (j.status === "completed") {
      const c = document.createElement("button");
      c.className = "card-action collect";
      c.textContent = "COLLECT";
      c.addEventListener("click", (e) => { e.stopPropagation(); collectBatch(j.id, c); });
      meta.append(c);
    } else if (["validating", "in_progress", "finalizing"].includes(j.status)) {
      const chk = document.createElement("button");
      chk.className = "card-action collect";
      chk.textContent = "CHECK";
      chk.addEventListener("click", async (e) => {
        e.stopPropagation(); chk.disabled = true;
        try { const r = await apiJson(API.batch + "/" + encodeURIComponent(j.id)); j.status = r.status; } catch {}
        chk.disabled = false; renderGallery();
      });
      meta.append(chk);
    } else {
      const x = document.createElement("button");
      x.className = "card-action";
      x.textContent = "×";
      x.title = "Dismiss";
      x.addEventListener("click", (e) => { e.stopPropagation(); dismissed.add(j.id); saveDismissed(); refreshJobs({ quiet: true }); });
      meta.append(x);
    }
    return card;
  }
  async function renderGallery() {
    const gallery = $("#gallery");
    if (!gallery) return;
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
    gallery.innerHTML = "";
    let recs = [];
    try { recs = await vaultAll(); } catch {}

    $("#dfi-count-all").textContent = recs.length;
    const q = state.search;
    const shown = recs.filter((r) => {
      if (state.filter === "favorite" && !r.favorite) return false;
      if (state.filter === "batch" && r.source !== "batch") return false;
      if (q && !r.prompt.toLowerCase().includes(q)) return false;
      return true;
    });

    // live foundry jobs surface as cards under ALL and BATCH
    if (state.filter !== "favorite" && !q) {
      for (const j of state.jobs) gallery.append(jobCard(j));
    }

    shown.forEach((rec, i) => {
      const url = URL.createObjectURL(rec.blob);
      objectUrls.push(url);
      const card = document.createElement("article");
      card.className = "creation-card" + (i === 0 && state.filter === "all" && !q ? " hero-card" : "");
      card.dataset.kind = rec.favorite ? "favorite" : rec.source === "batch" ? "batch" : "all";
      card.innerHTML = `
        <div class="creation-art"><img class="creation-img" loading="lazy" alt="${esc(rec.prompt.slice(0, 80))}"></div>
        <div class="card-chrome"><span>${rec.source === "batch" ? "BATCH" : "STANDARD"} · ${pad4(rec.seq || 0)}</span></div>
        <div class="creation-meta"><div><b>${esc(rec.prompt.toUpperCase().slice(0, 60) || "FORGED VISION")}</b><small>${esc(cap(rec.quality))} · ${esc(cap(rec.aspect))} · ${SIZES[rec.aspect] || ""}</small></div></div>`;
      card.querySelector(".creation-img").src = url;
      const fav = document.createElement("button");
      fav.className = "favorite" + (rec.favorite ? " active" : "");
      fav.textContent = rec.favorite ? "★" : "☆";
      fav.setAttribute("aria-label", rec.favorite ? "Remove from favorites" : "Add to favorites");
      fav.addEventListener("click", async (e) => {
        e.stopPropagation();
        rec.favorite = !rec.favorite;
        await vaultPut(rec);
        renderGallery();
      });
      card.querySelector(".card-chrome").append(fav);
      const open = document.createElement("button");
      open.className = "card-action";
      open.setAttribute("aria-label", "Open image");
      open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>';
      open.addEventListener("click", (e) => { e.stopPropagation(); openViewer(rec, url); });
      card.querySelector(".creation-meta").append(open);
      card.addEventListener("click", () => openViewer(rec, url));
      gallery.append(card);
    });

    if (!shown.length && !state.jobs.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = q ? "NOTHING IN THE VAULT MATCHES THAT SEARCH." : "THE VAULT AWAITS ITS FIRST FORGED VISION. EVERYTHING YOU CREATE STAYS ON THIS DEVICE.";
      gallery.append(empty);
    }

    $("#dfi-vault-title").textContent = recs.length ? "LOCAL VAULT HEALTHY" : "LOCAL VAULT";
    $("#dfi-vault-stats").textContent = `${recs.length} creation${recs.length === 1 ? "" : "s"}`;
    updateStorage(recs.length);
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  async function updateStorage(count) {
    try {
      const est = await navigator.storage.estimate();
      const gb = (n) => (n / 1e9).toFixed(n >= 1e8 ? 2 : 3);
      $("#dfi-vault-load").textContent = `${gb(est.usage || 0)} GB / ${Math.round((est.quota || 0) / 1e9)} GB`;
      $("#dfi-vault-stats").textContent = `${count} creation${count === 1 ? "" : "s"} · ${gb(est.usage || 0)} GB used`;
    } catch {}
  }

  function openViewer(rec, url) {
    const scrim = document.createElement("div");
    scrim.className = "dfi-viewer";
    const card = document.createElement("div");
    card.className = "dfi-viewer-card";
    card.innerHTML = `
      <img src="${url}" alt="${esc(rec.prompt || "Forged vision")}">
      <div class="dfi-viewer-meta">
        <p>${esc(rec.prompt || "(no directive saved)")}</p>
        <small>${esc(cap(rec.quality))} · ${SIZES[rec.aspect] || ""} · ${new Date(rec.ts).toLocaleString()} · ${rec.source === "batch" ? "BATCH FOUNDRY" : "IMMEDIATE FORGE"}</small>
        <div class="dfi-viewer-actions"></div>
      </div>`;
    const actions = card.querySelector(".dfi-viewer-actions");
    const dl = document.createElement("a");
    dl.className = "primary";
    dl.textContent = "DOWNLOAD";
    dl.href = url;
    dl.download = "dominion-forge-" + new Date(rec.ts).toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
    const fav = document.createElement("button");
    fav.textContent = rec.favorite ? "★ FAVORITED" : "☆ FAVORITE";
    fav.addEventListener("click", async () => {
      rec.favorite = !rec.favorite;
      await vaultPut(rec);
      fav.textContent = rec.favorite ? "★ FAVORITED" : "☆ FAVORITE";
      renderGallery();
    });
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "DELETE";
    del.addEventListener("click", async () => { await vaultDelete(rec.id); scrim.remove(); renderGallery(); });
    const close = document.createElement("button");
    close.textContent = "CLOSE";
    close.addEventListener("click", () => scrim.remove());
    actions.append(dl, fav, del, close);
    scrim.append(card);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) scrim.remove(); });
    $("#dfi-root").append(scrim);
  }

  // ---------- open/close (the slide) ----------
  function openPanel() {
    if (window.closeForgeDial) window.closeForgeDial();   // one reveal at a time
    if (window.closeIdeMode) window.closeIdeMode();       // ...including Dominion Works
    if (!$("#dfi-root")) buildPanel();
    state.open = true;
    document.body.classList.add("dfi-anim");
    // Force a style flush between the two classes so the slide transitions instead of jumping.
    void $("#dfi-root").offsetWidth;
    document.body.classList.add("dfi-open");
    refreshConfig();
    renderGallery();
    refreshJobs();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => { if (state.open) refreshJobs({ quiet: true }); }, 60000);
  }
  function closePanel() {
    state.open = false;
    document.body.classList.remove("dfi-open");
    setTimeout(() => { if (!state.open) document.body.classList.remove("dfi-anim"); }, 500);
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }
  async function refreshConfig() {
    try {
      const c = await apiJson(API.config);
      if (c && c.tokens) CFG = c;
      renderEstimate();
      renderFoundry();
      if (!CFG.available) showFault("Image generation is not configured on the server yet (missing OpenAI key).");
    } catch {}
  }

  // ---------- trigger ----------
  function initTrigger() {
    const barLeft = document.getElementById("bar-left");
    const btn = document.createElement("button");
    btn.className = "dfi-trigger";
    btn.id = "dfi-trigger";
    btn.title = "Dominion Forge Images";
    btn.setAttribute("aria-label", "Open Dominion Forge Images");
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4.5 18l5-5 3.5 3.5L17 12l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener("click", openPanel);
    if (barLeft) barLeft.append(btn);
    else document.body.append(btn);
  }

  window.openForgeImages = openPanel;
  window.closeForgeImages = closePanel;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTrigger);
  else initTrigger();
})();
