// Dominion Image Generator — Codex design wired live. Self-contained IIFE, same contract as
// dominion-forge.js: injects its own DOM under #dfi-root, owns the slide-right reveal (the
// whole interface slides off RIGHT; back/close in the command rail return), and keeps every
// generated image in the DEVICE's IndexedDB store. Brand rule: the engine cell reads DOMINION
// AI, never a model name. All user-facing copy is plain language — the words on screen say
// what actually happens (saved in this browser / downloaded / saved to your folder), no theme.
// Server wire: /api/images/{config,generate,refine,batch,batches}.
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
    draft: { available: false, model: "", refs: false, brand: "Free Draft Engine" },
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
    parked: false,            // the glass door: pane shoved aside, backdrop exposed
    quality: "medium",
    aspect: "square",
    batch: false,
    draft: false,              // ARSENAL Wave 3: free NVIDIA lane, mutually exclusive with batch
    refs: [],                 // staged reference plates [{dataUrl, name}]
    queue: [],                // foundry directives [{prompt, quality, aspect}]
    jobs: [],
    filter: "all",
    search: "",
    generating: false,
    pollTimer: null,
    faultTimer: null,
    progressTimer: null,
    startedAt: 0,             // wall-clock of the run in flight, for the honest elapsed counter
    arrowTimer: null,         // the wordless "look down here" hint under the forge button
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
        // v2 adds a "handles" store for the linked device folder. A FileSystemDirectoryHandle is
        // structured-cloneable, so IndexedDB can hold the actual grant across sessions;
        // localStorage could not (it only takes strings). Both stores are guarded so a v1 vault
        // upgrades in place without losing a single image.
        const rq = indexedDB.open(DB_NAME, 2);
        rq.onupgradeneeded = () => {
          const d = rq.result;
          if (!d.objectStoreNames.contains("images")) {
            const store = d.createObjectStore("images", { keyPath: "id" });
            store.createIndex("ts", "ts");
          }
          if (!d.objectStoreNames.contains("handles")) d.createObjectStore("handles", { keyPath: "key" });
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    }
    return dbPromise;
  }
  // Handle store, kept apart from the image transactions below.
  async function handleGet(key) {
    const d = await db();
    return new Promise((resolve) => {
      const rq = d.transaction("handles").objectStore("handles").get(key);
      rq.onsuccess = () => resolve(rq.result ? rq.result.value : null);
      rq.onerror = () => resolve(null);
    });
  }
  async function handlePut(key, value) {
    const d = await db();
    return new Promise((resolve) => {
      const t = d.transaction("handles", "readwrite");
      t.objectStore("handles").put({ key, value });
      t.oncomplete = resolve; t.onerror = resolve;
    });
  }
  async function handleDelete(key) {
    const d = await db();
    return new Promise((resolve) => {
      const t = d.transaction("handles", "readwrite");
      t.objectStore("handles").delete(key);
      t.oncomplete = resolve; t.onerror = resolve;
    });
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

  // ---------- device folder (Fred, 2026-07-19) ----------
  // Images live on the device by design (the service does not pay to house them), which left them
  // stranded on whichever device forged them. This links ONE folder on this machine and writes
  // every forged image into it, so whatever already backs that folder up (Google Photos, Drive for
  // desktop, OneDrive, a NAS) carries the images everywhere without Dominion storing a byte.
  //
  // The grant is a real FileSystemDirectoryHandle held in IndexedDB, so it survives restarts. Two
  // browser facts shape the UI: the picker exists only on desktop Chromium (Firefox, Safari and
  // Chrome-on-Android have no directory picker), and a handle that comes back needing permission
  // can only be re-granted from a user gesture. So the phone gets the share sheet instead
  // ("Save to Photos"), and a control that cannot work here is never drawn.
  const FOLDER_KEY = "vaultDir";
  const folderSupported = () => typeof window.showDirectoryPicker === "function";
  const shareSupported = () => !!(navigator.canShare && navigator.share);
  let folderHandle = null, folderPerm = "none";          // none | granted | prompt | denied
  let autoSave = localStorage.getItem("dfi.autosave") !== "0";

  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  function fileNameFor(rec) {
    const d = new Date(rec.ts || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const tail = slug(rec.prompt);
    return `dominion-image-${pad4(rec.seq || 0)}-${stamp}${tail ? "-" + tail : ""}.png`;
  }

  // queryPermission/requestPermission are Chromium extensions to FileSystemHandle. A handle that
  // lacks them is one the engine hands over already usable, so absence reads as "granted" rather
  // than as a failure that would strand a perfectly good folder.
  const permOf = async (h) => (typeof h.queryPermission === "function" ? h.queryPermission({ mode: "readwrite" }) : "granted");
  const askPerm = async (h) => (typeof h.requestPermission === "function" ? h.requestPermission({ mode: "readwrite" }) : "granted");

  async function restoreFolder() {
    if (!folderSupported()) return;
    try {
      const h = await handleGet(FOLDER_KEY);
      if (!h) return;
      folderHandle = h;
      folderPerm = await permOf(h);
    } catch { folderHandle = null; folderPerm = "none"; }
  }
  async function linkFolder() {
    if (!folderSupported()) return;
    try {
      const h = await window.showDirectoryPicker({ id: "dominion-forge", mode: "readwrite", startIn: "pictures" });
      folderHandle = h;
      folderPerm = await permOf(h);
      if (folderPerm !== "granted") folderPerm = await askPerm(h);
      await handlePut(FOLDER_KEY, h);
      renderFolderBar();
      setStatus(`Folder set to ${h.name}. New images will be saved there automatically.`);
    } catch (e) {
      if (e && e.name === "AbortError") return;          // the user closed the picker: not an error
      showFault("Could not use that folder: " + (e && e.message ? e.message : "unknown error"));
    }
  }
  async function reconnectFolder() {
    if (!folderHandle) return linkFolder();
    try {
      folderPerm = await askPerm(folderHandle);
      renderFolderBar();
      if (folderPerm === "granted") setStatus(`Reconnected to ${folderHandle.name}.`);
    } catch { showFault("This browser would not restore access to that folder. Choose it again."); }
  }
  async function unlinkFolder() {
    folderHandle = null; folderPerm = "none";
    await handleDelete(FOLDER_KEY);
    renderFolderBar();
  }
  const folderReady = () => !!(folderHandle && folderPerm === "granted");

  /*
   * Re-arm the linked folder while a click is still "warm".
   *
   * THE BUG THIS FIXES (Fred, 2026-07-22: forged images, went to the folder, found nothing).
   * Chrome does not persist directory permission across a browser restart: the handle survives in
   * IndexedDB but queryPermission drops to "prompt". The forge path guarded its write with
   * `if (autoSave && folderReady())` and then reported "Vision sealed to local vault" either way,
   * so a lapsed permission meant the file went to IndexedDB, never to disk, and NOTHING said so.
   *
   * requestPermission needs transient user activation, which is long gone by the time an image
   * finishes generating. So it is asked HERE, on the click that starts the forge, while the
   * activation is still live. Returns true when the folder is usable afterwards.
   */
  async function armFolder() {
    if (!folderHandle || !autoSave) return folderReady();
    if (folderPerm === "granted") return true;
    try {
      folderPerm = await askPerm(folderHandle);
      renderFolderBar();
    } catch { /* denied or unavailable: the caller reports it honestly below */ }
    return folderReady();
  }

  // Write one vault record into the linked folder. Returns true when the file landed.
  async function writeToFolder(rec) {
    if (!folderReady()) return false;
    try {
      const name = fileNameFor(rec);
      const fh = await folderHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(rec.blob);
      await w.close();
      rec.savedAt = Date.now();
      rec.savedName = name;
      await vaultPut(rec);
      return true;
    } catch (e) {
      // A revoked or moved folder is the common case: say so rather than failing silently.
      try { folderPerm = folderHandle ? await permOf(folderHandle) : "none"; } catch { folderPerm = "prompt"; }
      renderFolderBar();
      showFault("Could not write to the linked folder: " + (e && e.message ? e.message : "access lost"));
      return false;
    }
  }
  async function saveAllToFolder(btn) {
    if (!folderReady()) return;
    let recs = [];
    try { recs = await vaultAll(); } catch {}
    const pending = recs.filter((r) => !r.savedAt);
    if (!pending.length) { setStatus("Every image is already saved in the folder."); return; }
    if (btn) { btn.disabled = true; btn.textContent = "SAVING…"; }
    let done = 0;
    for (const rec of pending) {
      if (!(await writeToFolder(rec))) break;
      done++;
      if (done % 5 === 0) setStatus(`Saving to ${folderHandle.name}… ${done}/${pending.length}`);
    }
    if (btn) { btn.disabled = false; btn.textContent = "SAVE ALL"; }
    setStatus(`${done} image${done === 1 ? "" : "s"} saved to ${folderHandle.name}.`);
    renderFolderBar();
    renderGallery();
  }
  // The folder bar's own status line, so folder feedback appears where the user is looking
  // instead of hijacking the generation strip.
  function setStatus(text) {
    const n = $("#dfi-folder-note");
    if (n) n.textContent = text;
  }

  // Redraw the folder bar for the current capability + permission state. Every branch says
  // something true about THIS device rather than offering a control that cannot work here.
  async function renderFolderBar() {
    const bar = $("#dfi-folder-bar");
    if (!bar) return;
    const nameEl = $("#dfi-folder-name"), actions = $("#dfi-folder-actions");
    // On phones there is no folder to set, so the bar is titled for what it can do there.
    const heading = bar.querySelector(".folder-copy > span");
    if (heading) heading.textContent = folderSupported() ? "DOWNLOAD FOLDER" : "SAVING IMAGES";
    actions.innerHTML = "";
    const mkBtn = (label, fn, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "filter-button" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", () => fn(b));
      actions.append(b);
      return b;
    };

    if (!folderSupported()) {
      bar.dataset.state = "unsupported";
      nameEl.textContent = shareSupported() ? "SAVE TO PHOTOS" : "DOWNLOAD ONLY";
      setStatus(shareSupported()
        ? "Phones can't auto-save to a folder. Open any image and tap Save to Photos or Download."
        : "Open any image and tap Download to save it to this device.");
      return;
    }
    if (!folderHandle) {
      bar.dataset.state = "unlinked";
      nameEl.textContent = "NOT SET";
      setStatus("Choose a folder on this computer and every new image is saved there automatically.");
      mkBtn("CHOOSE FOLDER", () => linkFolder(), "active");
      return;
    }
    if (folderPerm !== "granted") {
      bar.dataset.state = "needs-permission";
      nameEl.textContent = String(folderHandle.name || "FOLDER").toUpperCase();
      // Say how many are stranded. "Needs one click" is easy to ignore; "6 images are not on your
      // disk" is not, and that gap is exactly what went unnoticed before.
      let waiting = 0;
      try { waiting = (await vaultAll()).filter((r) => !r.savedAt).length; } catch {}
      setStatus(waiting
        ? `${waiting} image${waiting === 1 ? " is" : "s are"} not in your folder yet. The browser asks for folder access again after a restart: tap RECONNECT, then SAVE ALL.`
        : "Tap RECONNECT to give this browser access to your folder again.");
      mkBtn("RECONNECT", () => reconnectFolder(), "active");
      mkBtn("UNLINK", () => unlinkFolder());
      return;
    }

    bar.dataset.state = "linked";
    nameEl.textContent = String(folderHandle.name || "FOLDER").toUpperCase();
    let recs = [];
    try { recs = await vaultAll(); } catch {}
    const saved = recs.filter((r) => r.savedAt).length;
    setStatus(autoSave
      ? `Auto-saving every new image here. ${saved} of ${recs.length} saved so far.`
      : `Auto-save is off. ${saved} of ${recs.length} saved so far.`);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "power-toggle";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(autoSave));
    toggle.setAttribute("aria-label", "Auto-save new images to this folder");
    toggle.title = "Auto-save every new image";
    toggle.innerHTML = "<i></i>";
    toggle.addEventListener("click", () => {
      autoSave = !autoSave;
      localStorage.setItem("dfi.autosave", autoSave ? "1" : "0");
      renderFolderBar();
    });
    actions.append(toggle);
    if (recs.length > saved) mkBtn("SAVE ALL", (b) => saveAllToFolder(b), "active");
    mkBtn("UNLINK", () => unlinkFolder());
  }

  /* ---------- keeping the pictures ------------------------------------------------------------
   * THE PROBLEM (Fred, 2026-07-24). "It is not obvious at all that they have to pick a folder from
   * their desktop in order to download the pictures", and a beginner does not know the app can be
   * installed on a computer at all. The folder bar that explains it sits at the bottom of the vault,
   * which nobody scrolls to. So the first time a picture actually lands, the app says it once,
   * plainly, and then never again.
   *
   * ON THE THREE DAYS. Fred asked for "images are saved for 3 days and then permanently deleted".
   * Nothing in the code does that, and it is not what happens: single pictures are never stored on
   * the server at all (images.mjs keeps no copy), they live in THIS browser's storage on THIS
   * device, and what actually removes them is clearing browsing data, a private window closing,
   * the device reclaiming space, or Safari's own housekeeping when the app goes about a week
   * unopened. Printing a three-day countdown the code does not enforce would be the same lie as
   * the old "sealed to the vault" message that printed when nothing had been written. So the
   * notice below carries the real reasons, with the same urgency: to keep one, get it off the
   * browser. If Fred wants a true three-day sweep, that is a deliberate delete to build, not a
   * sentence to print.
   */
  const KEEP_SEEN = "dfi.keepNoticeSeen";
  function maybeOfferKeeping() {
    if (folderReady()) return;                                  // already set up: no popup, ever
    if (localStorage.getItem(KEEP_SEEN) === "1") return;         // said once is enough
    if ($("#dfi-keep")) return;
    const scrim = document.createElement("div");
    scrim.className = "dfi-viewer dfi-keep";
    scrim.id = "dfi-keep";
    const how = folderSupported()
      ? "<p><b>On this computer:</b> choose a folder once and every new picture is written into it automatically. You can also open any picture and press DOWNLOAD.</p>"
      : (shareSupported()
        ? "<p><b>On this phone:</b> open a picture and press SAVE TO PHOTOS. It lands in your camera roll, where your usual backup keeps it.</p>" +
          "<p><b>For automatic folders:</b> phone browsers cannot hold a folder. Open app.dominion.tools on a computer in Chrome or Edge, install it from the address bar, and pictures can be written straight into a folder there.</p>"
        : "<p>Open any picture and press DOWNLOAD to save it where you want it.</p>");
    const card = document.createElement("div");
    card.className = "dfi-viewer-card dfi-keep-card";
    card.innerHTML = `
      <div class="dfi-keep-body">
        <h3>KEEP YOUR PICTURES</h3>
        <p>Your pictures are saved in this browser, on this device. They are not in the cloud, and Dominion keeps no copy.</p>
        <p><b>That storage is not permanent.</b> Clearing your browsing history removes them, a private window loses them when it closes, a device short on space can throw them out, and an iPhone or iPad deletes them if you do not open the app for about a week.</p>
        <p>To keep a picture for good, get it out of the browser.</p>
        ${how}
        <div class="dfi-viewer-actions"></div>
      </div>`;
    const actions = card.querySelector(".dfi-viewer-actions");
    const done = () => { localStorage.setItem(KEEP_SEEN, "1"); scrim.remove(); };
    if (folderSupported()) {
      const link = document.createElement("button");
      link.className = "primary";
      link.textContent = "CHOOSE A FOLDER";
      link.addEventListener("click", async () => { done(); await linkFolder(); });
      actions.append(link);
    }
    const ok = document.createElement("button");
    ok.textContent = folderSupported() ? "NOT NOW" : "GOT IT";
    ok.addEventListener("click", done);
    actions.append(ok);
    scrim.append(card);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) done(); });
    ($("#dfi-root") || document.body).append(scrim);
  }

  // Phone path: hand the file to the OS share sheet, which is where "Save to Photos" lives.
  async function shareImage(rec) {
    try {
      const file = new File([rec.blob], fileNameFor(rec), { type: "image/png" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error("unsupported");
      await navigator.share({ files: [file], title: "Dominion AI" });
      return true;
    } catch (e) {
      if (e && e.name === "AbortError") return false;
      showFault("This device would not open the share sheet. Use Download instead.");
      return false;
    }
  }

  // ---------- helpers ----------
  // Which way the gallery sits: beside the deck on a wide screen, under it on a phone (the layout
  // flips at 620px in dominion-images.css). Copy that says "below" must be true on both.
  const wide = () => window.matchMedia("(min-width: 621px)").matches;
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
  // Reflects CFG.draft.available (known only after refreshConfig resolves) and state.draft.
  function syncDraftToggle(root) {
    const toggle = $("#draft-toggle", root || document);
    const mod = $("#draft-module", root || document);
    const note = $("#draft-note", root || document);
    if (!toggle) return;
    toggle.disabled = !CFG.draft.available;
    toggle.setAttribute("aria-checked", String(state.draft));
    if (mod) mod.classList.toggle("active", state.draft);
    if (mod) mod.classList.toggle("unavailable", !CFG.draft.available);
    if (note) note.textContent = CFG.draft.available
      ? "Same picture, a faster free engine. No reference images yet — turn this off to use your own photos."
      : "Not configured on the server yet.";
  }
  function renderEstimate() {
    $("#token-estimate").textContent = state.draft ? "—" : tokensFor().toLocaleString();
    $("#cost-estimate").textContent = state.draft ? "FREE" : fmtUsd(priceFor(state.batch));
    $("#route-estimate").textContent = state.draft ? "IMMEDIATE · FREE" : state.batch ? "BATCH · <24H" : "IMMEDIATE";
    $("#size-label").textContent = SIZES[state.aspect];
    const lit = { low: 3, medium: 6, high: 10 }[state.quality] || 6;
    $$("#dfi-root .energy-meter i").forEach((bar, i) => bar.classList.toggle("lit", i < lit));
    $("b", $("#forge-button")).textContent = state.batch ? "ADD TO BATCH" : state.draft ? "GENERATE (FREE)" : "GENERATE";
  }

  /* ---------- the deck-side working state ----------------------------------------------------
   * Everything here exists because the vault (and therefore the old progress strip) is BELOW the
   * fold on a phone. These three live in the control deck, inches under the button that was just
   * pressed, so "is it doing anything?" is answered without scrolling. */
  function setDeckWorking(on) {
    const w = $("#dfi-working");
    if (w) w.hidden = !on;
    const secs = $("#dfi-working-secs");
    if (secs && on) secs.textContent = "0s";
  }
  function setDeckNote(text, isFault) {
    const n = $("#dfi-deck-note");
    if (!n) return;
    n.hidden = !text;
    n.textContent = text || "";
    n.classList.toggle("is-fault", !!isFault);
  }
  // The wordless hint Fred asked for: it blinks, it points down, it leaves after five seconds.
  function flashArrow() {
    const p = $("#dfi-point");
    if (!p) return;
    p.hidden = false;
    clearTimeout(state.arrowTimer);
    state.arrowTimer = setTimeout(() => { p.hidden = true; }, 5000);
  }

  // ---------- fault/status strip ----------
  function strip() { return $("#generation-strip"); }
  function showFault(message) {
    const s = strip();
    s.hidden = false;
    s.classList.add("fault");
    $("#generation-status").textContent = message;
    s.querySelector("b").textContent = "SOMETHING WENT WRONG";
    $("#generation-progress").style.width = "100%";
    $("#generation-percent").textContent = "!";
    clearTimeout(state.faultTimer);
    state.faultTimer = setTimeout(() => { if (!state.generating) s.hidden = true; s.classList.remove("fault"); }, 12000);
    // A fault message is the one thing that must never be off-screen either.
    setDeckWorking(false);
    setDeckNote(message, true);
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
    // The counter has been counting up honestly, so the last thing it says is how long it took.
    $("#generation-percent").textContent = "done";
    $("#generation-status").textContent = status;
    setTimeout(() => { if (!state.generating) strip().hidden = true; }, 4000);
  }

  // ---------- markup ----------
  function buildPanel() {
    const root = document.createElement("section");
    root.id = "dfi-root";
    root.setAttribute("aria-label", "Dominion image generator");
    root.innerHTML = `
  <div class="scene" aria-hidden="true">
    <div class="scene-grid"></div>
    <div class="scene-reactor"></div>
    <div class="scene-furnace-edge furnace-left"></div>
    <div class="scene-furnace-edge furnace-right"></div>
    <div class="scene-smoke"><i></i><i></i><i></i></div>
    <div class="scene-sparks"><i></i><i></i><i></i><i></i><i></i><i></i></div>
  </div>

  <!-- The glass-door "SLIDE" handle (park the pane aside to reveal the backdrop) was REMOVED
       2026-07-20: shipped unverified, it hid the entire Forge Images UI behind decorative
       artwork and the only way back was a tiny edge tab, which read as a freeze. It is a purely
       cosmetic flourish with no functional value, so it is gone rather than half-fixed. The park
       CSS/JS below is now inert (resetDoor's null checks keep it safe). Rebuild with real motion
       verification if it is ever wanted back. -->

  <div class="app-shell">
    <header class="command-rail">
      <div class="brand-lockup">
        <button class="rail-button back-button" type="button" aria-label="Return to Dominion AI">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7M8 12h11"/></svg>
        </button>
        <div class="brand-reactor" aria-hidden="true"><span></span><i></i></div>
        <div>
          <p class="eyebrow">DOMINION AI</p>
          <h1>IMAGE <span>GENERATOR</span></h1>
        </div>
      </div>

      <div class="rail-status" aria-label="Status">
        <div class="status-cell"><span class="pulse-dot"></span><small>ENGINE</small><b>DOMINION AI</b></div>
        <div class="status-cell"><svg viewBox="0 0 24 24"><path d="M4 8h16v11H4zM8 8V5h8v3M8 12h8M8 15h5"/></svg><small>SAVED ON</small><b>THIS DEVICE</b></div>
        <div class="status-cell"><svg viewBox="0 0 24 24"><path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/></svg><small>STORAGE</small><b id="dfi-vault-load">—</b></div>
      </div>

      <button class="rail-button close-button" type="button" aria-label="Close the image generator">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>

    <main class="forge-layout">
      <aside class="control-deck glass-panel">
        <div class="panel-specular" aria-hidden="true"></div>
        <div class="furnace-seam" aria-hidden="true"><i></i><i></i><i></i></div>
        <section class="deck-section directive-section">
          <div class="section-heading">
            <div><span>01</span><p>WHAT TO MAKE</p></div>
            <div class="section-heading-tools">
              <button type="button" id="dfi-refine" aria-label="Enhance prompt"><svg viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3ZM18.5 15l.7 2.1 2.3.9-2.3.9-.7 2.1-.7-2.1-2.3-.9 2.3-.9.7-2.1Z"/></svg><span>Refine</span></button>
              <small id="prompt-count">0 / ${PROMPT_CAP}</small>
            </div>
          </div>
          <div class="prompt-frame">
            <textarea id="prompt" maxlength="${PROMPT_CAP}" aria-label="Image prompt" placeholder="Describe the picture you want…"></textarea>
            <div class="prompt-tools">
              <button type="button" id="dfi-clear" aria-label="Clear prompt"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14"/></svg></button>
            </div>
          </div>
          <!-- The primary action lives DIRECTLY under the input (Fred, 2026-07-23: a non-technical
               user just wants a picture and should not have to hunt past every option to make one).
               Everything below this is optional, for those who go looking. -->
          <button id="forge-button" class="forge-button" type="button">
            <span class="forge-core" aria-hidden="true"><i></i></span>
            <span><small>DOMINION AI</small><b>GENERATE</b></span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5"/></svg>
          </button>
          <!-- Wordless blinking arrow, directly beneath the button, for about five seconds after
               the forge is lit: it points at where the picture will appear. Phone layout only,
               where the gallery really is below; on a wide screen the gallery is to the right and
               a down arrow would be pointing at nothing (CSS hides it there). -->
          <div class="forge-point" id="dfi-point" hidden aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3v15M5 12l7 7 7-7"/></svg>
          </div>
          <!-- The working state, where the finger just was. The vault's strip is off-screen on a
               phone, which is the whole reason the app looked frozen while it was busy. -->
          <div class="forge-working" id="dfi-working" hidden aria-live="polite">
            <span class="fw-spin" aria-hidden="true"><i></i><i></i></span>
            <span class="fw-copy">
              <b>MAKING YOUR PICTURE</b>
              <small>It appears in the gallery below when it is ready. <span id="dfi-working-secs">0s</span> so far.</small>
            </span>
          </div>
          <p class="forge-deck-note" id="dfi-deck-note" hidden></p>
          <p class="forge-optional-note">Just want a picture? Type it above and press Generate. The settings below are optional.</p>
          <div class="reference-well" id="dfi-ref-well" tabindex="0" role="button" aria-label="Add reference images">
            <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM7 15l3-3 3 3 2-2 3 3M15.5 8.5h.01"/></svg>
            <div><b>ADD YOUR OWN IMAGES</b><small id="dfi-ref-note">Optional. Copy the look of pictures you add (up to ${REF_CAP})</small></div>
            <span>+</span>
          </div>
          <div class="reference-tray" id="dfi-ref-tray"></div>
          <input id="dfi-ref-input" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden />
        </section>

        <section class="deck-section">
          <div class="section-heading"><div><span>02</span><p>QUALITY</p></div><small>HOW DETAILED</small></div>
          <div class="segment-grid quality-grid" role="radiogroup" aria-label="Render quality">
            <button type="button" class="segment" data-quality="low" role="radio" aria-checked="false"><span class="quality-rune">I</span><b>LOW</b><small>Rapid concept</small></button>
            <button type="button" class="segment selected" data-quality="medium" role="radio" aria-checked="true"><span class="quality-rune">II</span><b>MEDIUM</b><small>Production</small></button>
            <button type="button" class="segment" data-quality="high" role="radio" aria-checked="false"><span class="quality-rune">III</span><b>HIGH</b><small>Maximum detail</small></button>
          </div>
        </section>

        <section class="deck-section">
          <div class="section-heading"><div><span>03</span><p>SHAPE</p></div><small id="size-label">1024 × 1024</small></div>
          <div class="segment-grid aspect-grid" role="radiogroup" aria-label="Image orientation">
            <button type="button" class="segment selected" data-aspect="square" role="radio" aria-checked="true"><i class="shape square"></i><b>SQUARE</b><small>1:1</small></button>
            <button type="button" class="segment" data-aspect="portrait" role="radio" aria-checked="false"><i class="shape portrait"></i><b>PORTRAIT</b><small>2:3</small></button>
            <button type="button" class="segment" data-aspect="landscape" role="radio" aria-checked="false"><i class="shape landscape"></i><b>LANDSCAPE</b><small>3:2</small></button>
          </div>
        </section>

        <section class="draft-module" id="draft-module">
          <div class="draft-icon" aria-hidden="true"><i></i><i></i><i></i></div>
          <div><span>FREE DRAFT ENGINE</span><b>$0</b><small id="draft-note">Same picture, a faster free engine. No reference images yet — turn this off to use your own photos.</small></div>
          <button id="draft-toggle" class="power-toggle" type="button" role="switch" aria-checked="false" aria-label="Use the free draft engine"><i></i></button>
        </section>

        <section class="batch-module" id="batch-module">
          <div class="batch-icon" aria-hidden="true"><i></i><i></i><i></i></div>
          <div><span>MAKE SEVERAL AT ONCE</span><b>HALF PRICE</b><small>Optional. Queue several pictures and they are made within a day. You pay when you send the batch.</small></div>
          <button id="batch-toggle" class="power-toggle" type="button" role="switch" aria-checked="false" aria-label="Make several at once for half price"><i></i></button>
        </section>

        <section class="telemetry-module" aria-live="polite">
          <div class="telemetry-line"><span>EST. TOKENS</span><b id="token-estimate">1,767</b></div>
          <div class="telemetry-line"><span>EST. COST</span><b id="cost-estimate">$0.053</b></div>
          <div class="telemetry-line"><span>DELIVERY</span><b id="route-estimate">IMMEDIATE</b></div>
          <div class="energy-meter"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <p>Published OpenAI figures per setting. The final charge follows real usage.</p>
        </section>

        <section class="foundry-tray" id="dfi-foundry" hidden>
          <header><b>YOUR BATCH · <span id="dfi-foundry-count">0</span></b><button type="button" id="dfi-foundry-clear" title="Empty the batch">×</button></header>
          <div id="dfi-foundry-rows"></div>
          <button type="button" class="foundry-submit" id="dfi-foundry-submit">SEND THE BATCH · HALF PRICE</button>
        </section>
      </aside>

      <section class="vault glass-panel">
        <div class="panel-specular" aria-hidden="true"></div>
        <div class="vault-caustic" aria-hidden="true"></div>
        <header class="vault-header">
          <div>
            <p class="eyebrow"><span class="pulse-dot"></span> GALLERY</p>
            <h2>YOUR <span>IMAGES</span></h2>
            <p class="vault-note">Saved in this browser, on this device — never in the cloud. Download the ones you want to keep.</p>
          </div>
          <div class="vault-actions">
            <label class="search-control"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg><input id="dfi-search" type="search" placeholder="Search your images" aria-label="Search your images"></label>
            <button type="button" class="filter-button active" data-filter="all">ALL <span id="dfi-count-all">0</span></button>
            <button type="button" class="filter-button" data-filter="favorite" aria-label="Show favorites"><svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg></button>
            <button type="button" class="filter-button" data-filter="batch">BATCH</button>
          </div>
        </header>

        <div class="generation-strip" id="generation-strip" hidden>
          <div class="forge-spinner"><i></i><i></i><i></i></div>
          <div><b>WORKING</b><span id="generation-status">Starting…</span></div>
          <div class="progress-track"><i id="generation-progress"></i></div>
          <strong id="generation-percent">0%</strong>
        </div>

        <div class="gallery" id="gallery"></div>

        <section class="folder-bar" id="dfi-folder-bar">
          <div class="folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h6l2 2h8v10H4z"/><path d="M8 13h8M12 11v4"/></svg></div>
          <div class="folder-copy">
            <span>DOWNLOAD FOLDER</span>
            <b id="dfi-folder-name">NOT SET</b>
            <small id="dfi-folder-note">Choose a folder on this computer and every new image is saved there automatically.</small>
          </div>
          <div class="folder-actions" id="dfi-folder-actions"></div>
        </section>

        <footer class="vault-footer">
          <div><span class="storage-light"></span><b id="dfi-vault-title">STORAGE</b><small id="dfi-vault-stats">—</small></div>
          <button type="button" id="dfi-purge">DELETE ALL <svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14"/></svg></button>
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

    const doorHandle = $("#dfi-door-handle", root);
    if (doorHandle) doorHandle.addEventListener("click", () => setDoor(!state.parked));

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
      if (state.batch) { state.draft = false; syncDraftToggle(root); }
      batchToggle.setAttribute("aria-checked", String(state.batch));
      $("#batch-module", root).classList.toggle("active", state.batch);
      renderEstimate();
    });

    const draftToggle = $("#draft-toggle", root);
    draftToggle.addEventListener("click", () => {
      if (!CFG.draft.available) return;
      if (!state.draft && state.refs.length) return showFault("Your own images only work with the paid engine. Remove them, or leave Free Draft off.");
      state.draft = !state.draft;
      if (state.draft) {
        state.batch = false;
        batchToggle.setAttribute("aria-checked", "false");
        $("#batch-module", root).classList.remove("active");
      }
      syncDraftToggle(root);
      renderEstimate();
    });
    syncDraftToggle(root);

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
      if (!confirm("Delete every image saved on this device? This cannot be undone.")) return;
      await vaultClear();
      renderGallery();
    });

    renderEstimate();
    renderFoundry();
    renderRefs();
    renderFolderBar();
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
      ? state.refs.length + " of " + REF_CAP + " added · single pictures only, not batches"
      : "Optional. Copy the look of pictures you add (up to " + REF_CAP + ")";
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

  /* ---------- forging ----------------------------------------------------------------------
   * THE THREE THINGS THAT WERE WRONG (Fred, 2026-07-24, from his brother's pass):
   *
   * 1. "The progress indicator is not stable. Sometimes it shows up, sometimes it is not."
   *    It was never unstable. It lives in the vault panel, and below 620px the layout is ONE
   *    column with the vault UNDER the control deck, so on a phone the strip appeared entirely
   *    off-screen, below the fold, while the user stared at a deck that had not visibly changed.
   *    The fix is to put a working state where the finger just was, under the forge button.
   *
   * 2. "There is an indicator of amount of time, but it's always wrong and always takes longer."
   *    The percentage was theatre: a curve creeping toward 92% on a timer, with no connection to
   *    the actual request. It promised 92% done while nothing was known. It is gone. What replaces
   *    it counts UP, which cannot be wrong: seconds elapsed, plus a bar that reads as motion
   *    rather than as measured completion.
   *
   * 3. "You might think that it's hanging."
   *    So a placeholder card now sits in the gallery, in the exact spot the finished picture will
   *    occupy, from the moment the forge is lit. The place they look for the picture is the place
   *    that says it is coming.
   */
  const STATUS_LINE = [
    [0, "Sending your description to the engine…"],
    [8, "Drawing the picture. This is the slow part…"],
    [30, "Still drawing. Bigger pictures take longer…"],
    [70, "Still working. Nothing has gone wrong…"],
  ];
  function elapsedSecs() { return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0; }
  function paintElapsed() {
    const secs = elapsedSecs();
    let phase = STATUS_LINE[0][1];
    for (const [at, text] of STATUS_LINE) if (secs >= at) phase = text;
    const status = $("#generation-status");
    if (status) status.textContent = phase;
    const pct = $("#generation-percent");
    if (pct) pct.textContent = secs + "s";
    const deck = $("#dfi-working-secs");
    if (deck) deck.textContent = secs + "s";
  }
  function startProgress() {
    state.startedAt = Date.now();
    const track = $(".progress-track");
    if (track) track.classList.add("indeterminate");   // motion, not a claim about how far along
    paintElapsed();
    clearInterval(state.progressTimer);
    state.progressTimer = setInterval(paintElapsed, 1000);
  }
  function stopProgress() {
    clearInterval(state.progressTimer);
    state.progressTimer = null;
    state.startedAt = 0;
    const track = $(".progress-track");
    if (track) track.classList.remove("indeterminate");
  }

  async function onIgnite() {
    const prompt = $("#prompt").value.trim();
    if (!prompt) return showFault("Describe the picture you want first.");
    if (state.draft && state.refs.length) return showFault("Your own images only work with the paid engine. Remove them, or turn off Free Draft.");
    if (state.batch) {
      if (state.refs.length) return showFault("Your own images only work on a single picture made right now. Turn off the batch, or remove your images.");
      const maxItems = CFG.batch.maxItemsOwner || 200;
      if (state.queue.length >= maxItems) return showFault("The batch is full.");
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
    setDeckNote("");
    setDeckWorking(true);      // "it is working" says so where the button is, not below the fold
    flashArrow();              // and points at where the picture will land
    renderGallery();           // puts the waiting tile in the gallery immediately
    // Ask for folder permission NOW, on the warm click, not after the image lands (see armFolder).
    const wantFolder = !!(autoSave && folderHandle);
    const folderArmed = await armFolder();
    stripBusy("MAKING YOUR PICTURE", "Sending your description to the engine…");
    startProgress();
    try {
      const r = await apiJson(API.generate, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt, quality: state.quality, aspect: state.aspect, n: 1,
          refs: state.draft ? [] : state.refs.map((x) => x.dataUrl),
          draft: state.draft,
        }),
      });
      let wrote = 0, made = 0, unsaved = 0;
      for (const img of r.images || []) {
        // The image is already generated and CHARGED server-side, and the server keeps no copy.
        // So it must never vanish because on-device storage failed (a guest's private-mode or
        // storage-blocked browser is exactly how "the photo did not appear" happens). If the
        // vault write throws, keep the image in memory and show it anyway, honestly labelled, so
        // it can still be opened and saved by hand. A paid-for image is never invisible.
        try {
          const rec = await vaultSave(img.b64, { prompt, quality: r.quality, aspect: r.aspect, source: r.draft ? "draft" : "sync" });
          made++;
          if (folderArmed && folderReady() && (await writeToFolder(rec))) wrote++;
        } catch (saveErr) {
          unsaved++;
          state.transient = state.transient || [];
          state.transient.unshift({ b64: img.b64, prompt, quality: r.quality, aspect: r.aspect, ts: Date.now() });
        }
      }
      const took = elapsedSecs();      // read BEFORE stopProgress clears the clock
      stopProgress();
      setDeckWorking(false);
      if (unsaved) {
        showFault("Your image was created, but this browser would not save it to the on-device gallery (often private browsing, or storage is full or blocked). It is shown below so you can long-press or use OPEN to keep it. Try a normal browser window to have it saved automatically.");
      }
      // Never claim more than happened. "Sealed to the vault" used to print even when the folder
      // write was skipped, which is how an image could look saved and be nowhere on disk.
      const where = wrote ? ` · written to ${folderHandle.name}`
        : (wantFolder ? " · NOT written to your folder yet (tap RECONNECT below)" : "");
      stripDone("Your picture is ready" + (took ? " · took " + took + "s" : "") + where + " · " + (r.usage && r.usage.outputTokens ? r.usage.outputTokens.toLocaleString() + " tokens · " : "") + fmtUsd(r.costUsd || 0));
      if (!unsaved) setDeckNote("Your picture is ready" + (took ? ", made in " + took + " seconds" : "") + ". It is in the gallery" + (wide() ? " on the right." : " below."));
      if (wantFolder && !wrote) showFault(`Your image is saved in this browser, but was NOT saved to ${folderHandle.name}. The browser asks for folder access again after it restarts. Tap RECONNECT in the folder bar, then SAVE ALL to catch up.`);
      renderFolderBar();
      state.refs = [];
      renderRefs();
      if (made) maybeOfferKeeping();
    } catch (e) {
      stopProgress();
      setDeckWorking(false);
      showFault(friendly(e));
    } finally {
      state.generating = false;
      btn.disabled = false;
      btn.classList.remove("igniting");
      btn.removeAttribute("aria-busy");
      // AFTER the flag clears, and on BOTH paths. The waiting tile is drawn from state.generating,
      // so a redraw inside the failure branch would put it straight back, and a failed run would
      // sit there promising a picture that is never coming (caught in the browser, 2026-07-24).
      renderGallery();
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
    $("#dfi-foundry-submit").textContent = `SEND THE BATCH · ${state.queue.length} PICTURE${state.queue.length === 1 ? "" : "S"} · ${fmtUsd(est)} NOW`;
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
      stripBusy("YOUR BATCH IS SENT", `${r.count} picture${r.count === 1 ? "" : "s"} on the way · ${fmtUsd(r.estUsd)} charged · ready within ${CFG.batch.window} (usually sooner)`);
      stripDone("If it costs less than estimated, the difference comes back to your credits.");
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
    validating: "VALIDATING", in_progress: "GENERATING", finalizing: "FINALIZING",
    completed: "READY", failed: "FAILED · REFUNDED", expired: "EXPIRED · REFUNDED", cancelled: "CANCELLED · REFUNDED", cancelling: "CANCELLING",
  };
  async function collectBatch(id, btn) {
    btn.disabled = true;
    btn.textContent = "COLLECTING…";
    let offset = 0, saved = 0, wrote = 0;
    // COLLECT is the warm click for a batch, same reasoning as the forge button (see armFolder).
    const wantFolder = !!(autoSave && folderHandle);
    const folderArmed = await armFolder();
    stripBusy("BATCH READY", "Collecting your images…");
    startProgress();
    try {
      for (;;) {
        const r = await apiJson(API.batch + "/" + encodeURIComponent(id) + "?offset=" + offset + "&limit=4");
        if (r.status !== "completed") { stopProgress(); showFault("Batch is " + (JOB_LABELS[r.status] || r.status).toLowerCase() + "."); break; }
        for (const img of r.images || []) {
          const rec = await vaultSave(img.b64, { prompt: img.prompt, quality: img.quality, aspect: img.aspect, source: "batch" });
          if (folderArmed && folderReady() && (await writeToFolder(rec))) wrote++;
          saved++;
        }
        $("#generation-status").textContent = `Collecting your images… ${saved}/${r.total}`;
        renderGallery();
        offset += (r.images || []).length;
        if (r.done || !(r.images || []).length) {
          stopProgress();
          const settle = r.refundedCredits ? ` · ${r.refundedCredits} credit${r.refundedCredits === 1 ? "" : "s"} returned` : r.extraCredits ? ` · ${r.extraCredits} extra credit${r.extraCredits === 1 ? "" : "s"} for overage` : "";
          const where = wrote ? ` · ${wrote} written to ${folderHandle.name}`
            : (wantFolder ? " · NOT written to your folder yet (tap RECONNECT below)" : "");
          stripDone(`${saved} image${saved === 1 ? "" : "s"} added to your gallery` + where + (r.failed ? ` · ${r.failed} failed` : "") + (r.costUsd != null ? ` · ${fmtUsd(r.costUsd)} actual` : "") + settle);
          if (wantFolder && saved && !wrote) showFault(`${saved} image${saved === 1 ? " is" : "s are"} saved in this browser, but none were saved to ${folderHandle.name}. The browser asks for folder access again after it restarts. Tap RECONNECT in the folder bar, then SAVE ALL.`);
          renderFolderBar();
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
      <div class="card-chrome"><span>BATCH · ${esc(label)}</span></div>
      <div class="creation-meta"><div><b>BATCH OF ${j.count} IMAGE${j.count === 1 ? "" : "S"}</b><small>${new Date(j.ts).toLocaleString()} · ${fmtUsd(j.estUsd)} charged when sent</small></div></div>`;
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

    // The picture being made right now holds its own place in the gallery, from the moment the
    // forge is lit (Fred, 2026-07-24: "you might think that it's hanging"). It sits where the
    // finished image will sit, so the place a person looks for the picture is the place that says
    // it is coming. It is never a real record: no vault write, nothing to clean up.
    if (state.generating) {
      const waiting = document.createElement("article");
      waiting.className = "creation-card pending-card";
      waiting.innerHTML = `
        <div class="creation-art art-forge"><i></i><i></i><i></i></div>
        <div class="card-chrome"><span>BEING MADE NOW</span></div>
        <div class="creation-meta"><div><b>YOUR PICTURE IS ON ITS WAY</b><small>It appears right here when it is done. More detail and bigger shapes take longer.</small></div></div>`;
      gallery.append(waiting);
    }

    // live foundry jobs surface as cards under ALL and BATCH
    if (state.filter !== "favorite" && !q) {
      for (const j of state.jobs) gallery.append(jobCard(j));
    }

    // Images that were forged this session but could NOT be written to on-device storage show
    // here from memory, so a paid-for image is never invisible (Fred's brother, 2026-07-23). They
    // are labelled UNSAVED and use a data URL directly, independent of IndexedDB.
    if (state.filter !== "favorite" && !q && (state.transient || []).length) {
      for (const t of state.transient) {
        const card = document.createElement("article");
        card.className = "creation-card unsaved-card";
        card.innerHTML = `
          <div class="creation-art"><img class="creation-img" alt="${esc(t.prompt.slice(0, 80))}" src="data:image/png;base64,${t.b64}"></div>
          <div class="card-chrome"><span>UNSAVED · long-press to keep</span></div>
          <div class="creation-meta"><div><b>${esc(t.prompt.toUpperCase().slice(0, 60) || "UNTITLED")}</b><small>${esc(cap(t.quality))} · ${esc(cap(t.aspect))} · not on this device</small></div></div>`;
        const open = document.createElement("button");
        open.className = "card-action";
        open.setAttribute("aria-label", "Open image");
        open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>';
        open.addEventListener("click", (e) => { e.stopPropagation(); openViewer({ prompt: t.prompt, quality: t.quality, aspect: t.aspect }, "data:image/png;base64," + t.b64); });
        card.querySelector(".creation-meta").append(open);
        gallery.append(card);
      }
    }

    shown.forEach((rec, i) => {
      const url = URL.createObjectURL(rec.blob);
      objectUrls.push(url);
      const card = document.createElement("article");
      card.className = "creation-card" + (i === 0 && state.filter === "all" && !q ? " hero-card" : "");
      card.dataset.kind = rec.favorite ? "favorite" : rec.source === "batch" ? "batch" : "all";
      card.innerHTML = `
        <div class="creation-art"><img class="creation-img" loading="lazy" alt="${esc(rec.prompt.slice(0, 80))}"></div>
        <div class="card-chrome"><span>${rec.source === "batch" ? "BATCH" : rec.source === "draft" ? "FREE DRAFT" : "STANDARD"} · ${pad4(rec.seq || 0)}${rec.savedAt ? " · SAVED" : ""}</span></div>
        <div class="creation-meta"><div><b>${esc(rec.prompt.toUpperCase().slice(0, 60) || "UNTITLED")}</b><small>${esc(cap(rec.quality))} · ${esc(cap(rec.aspect))} · ${SIZES[rec.aspect] || ""}</small></div></div>`;
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

    if (!shown.length && !state.jobs.length && !(state.transient || []).length && !state.generating) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = q ? "NO IMAGES MATCH THAT SEARCH." : "NO IMAGES YET. EVERYTHING YOU CREATE IS SAVED ON THIS DEVICE.";
      gallery.append(empty);
    }

    renderFolderBar();
    $("#dfi-vault-title").textContent = "STORAGE";
    $("#dfi-vault-stats").textContent = `${recs.length} image${recs.length === 1 ? "" : "s"}`;
    updateStorage(recs.length);
    // Cards are rebuilt from scratch here, so their reflections start at the default position.
    // Seed them now rather than leaving every card identically lit until the next scroll.
    updateOptics();
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  async function updateStorage(count) {
    try {
      const est = await navigator.storage.estimate();
      const gb = (n) => (n / 1e9).toFixed(n >= 1e8 ? 2 : 3);
      $("#dfi-vault-load").textContent = `${gb(est.usage || 0)} GB / ${Math.round((est.quota || 0) / 1e9)} GB`;
      $("#dfi-vault-stats").textContent = `${count} image${count === 1 ? "" : "s"} · ${gb(est.usage || 0)} GB used`;
    } catch {}
  }

  function openViewer(rec, url) {
    const scrim = document.createElement("div");
    scrim.className = "dfi-viewer";
    const card = document.createElement("div");
    card.className = "dfi-viewer-card";
    card.innerHTML = `
      <img src="${url}" alt="${esc(rec.prompt || "Generated image")}">
      <div class="dfi-viewer-meta">
        <p>${esc(rec.prompt || "(no description saved)")}</p>
        <small>${esc(cap(rec.quality))} · ${SIZES[rec.aspect] || ""} · ${new Date(rec.ts).toLocaleString()} · ${rec.source === "batch" ? "FROM A BATCH" : rec.source === "draft" ? "FREE DRAFT" : "MADE NOW"}</small>
        <div class="dfi-viewer-actions"></div>
      </div>`;
    const actions = card.querySelector(".dfi-viewer-actions");
    const dl = document.createElement("a");
    dl.className = "primary";
    dl.textContent = "DOWNLOAD";
    dl.href = url;
    dl.download = "dominion-image-" + new Date(rec.ts).toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
    const fav = document.createElement("button");
    fav.textContent = rec.favorite ? "★ FAVORITED" : "☆ FAVORITE";
    fav.addEventListener("click", async () => {
      rec.favorite = !rec.favorite;
      await vaultPut(rec);
      fav.textContent = rec.favorite ? "★ FAVORITED" : "☆ FAVORITE";
      renderGallery();
    });
    // Getting THIS image off the device: the folder on a desktop, the share sheet on a phone.
    if (folderSupported()) {
      const toFolder = document.createElement("button");
      toFolder.textContent = rec.savedAt ? "IN FOLDER ✓" : "SAVE TO FOLDER";
      toFolder.addEventListener("click", async () => {
        if (!folderReady()) { if (!folderHandle) await linkFolder(); else await reconnectFolder(); }
        if (!folderReady()) return;
        toFolder.disabled = true;
        const ok = await writeToFolder(rec);
        toFolder.disabled = false;
        toFolder.textContent = ok ? "IN FOLDER ✓" : "SAVE TO FOLDER";
        renderFolderBar();
      });
      actions.append(toFolder);
    } else if (shareSupported()) {
      const share = document.createElement("button");
      share.textContent = "SAVE TO PHOTOS";
      share.addEventListener("click", () => shareImage(rec));
      actions.append(share);
    }
    // Browser / device BACK must close THIS viewer, not exit the whole app (Fred's brother,
    // 2026-07-23: back on the image page poofed everything). We push one history entry when the
    // viewer opens; BACK pops it and we remove the scrim. A button-close calls history.back() so
    // the same single path runs and the pushed entry never dangles.
    let hasHist = false;
    const removeScrim = () => {
      if (!scrim.isConnected) return;
      scrim.remove();
      window.removeEventListener("popstate", onPop);
    };
    const onPop = () => { hasHist = false; removeScrim(); };
    const dismiss = () => { if (hasHist) { hasHist = false; try { history.back(); return; } catch {} } removeScrim(); };

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "DELETE";
    del.addEventListener("click", async () => { if (rec.id) await vaultDelete(rec.id); dismiss(); renderGallery(); });
    const close = document.createElement("button");
    close.textContent = "CLOSE";
    close.addEventListener("click", dismiss);
    actions.append(dl, fav, del, close);
    scrim.append(card);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) dismiss(); });
    $("#dfi-root").append(scrim);
    try { history.pushState({ dfiViewer: true }, ""); hasHist = true; } catch { hasHist = false; }
    window.addEventListener("popstate", onPop);
  }

  // ---------- the glass door (park + return) ----------
  // A second motion on top of open/close: this shoves the whole pane to the right and leaves the
  // surface behind it exposed, then pulls it back. Open/close moves #dfi-root; the door moves
  // .app-shell inside it, so the two never fight over the same transform.
  function setDoor(parked) {
    const handle = $("#dfi-door-handle");
    if (!handle || !state.open) return;
    if (document.body.classList.contains("dfi-door-moving")) return;   // ignore taps mid-travel
    state.parked = parked;
    document.body.classList.add("dfi-door-moving");
    document.body.classList.toggle("dfi-parked", parked);
    handle.setAttribute("aria-expanded", String(!parked));
    handle.setAttribute("aria-label", parked
      ? "Slide the image generator back into view"
      : "Slide the image generator aside");

    // transitionend is the accurate signal but it is not guaranteed: it never fires when reduced
    // motion zeroes the duration, and it is dropped if the transition is interrupted. The timer
    // is the floor, and `done` keeps whichever arrives first from being undone by the other.
    let done = false;
    const settle = () => { if (done) return; done = true; document.body.classList.remove("dfi-door-moving"); };
    const shell = $("#dfi-root .app-shell");
    if (shell) {
      // A parked pane is off-screen but still in the tab order, so a keyboard user would fall into
      // controls they cannot see. inert takes the whole deck out of focus and hit-testing until it
      // comes back.
      shell.inert = parked;
      shell.addEventListener("transitionend", settle, { once: true });
    }
    setTimeout(settle, 1100);
  }
  function resetDoor() {
    state.parked = false;
    document.body.classList.remove("dfi-parked", "dfi-door-moving");
    const handle = $("#dfi-door-handle");
    if (handle) {
      handle.setAttribute("aria-expanded", "true");
      handle.setAttribute("aria-label", "Slide the image generator aside");
    }
  }

  // ---------- glass optics ----------
  // Scroll moves each card's specular streak independently; the pointer moves the vault's caustic.
  // Both only write CSS custom properties, so the compositor does the animating and this never
  // touches layout. Bound on open and unbound on close: nothing runs while the panel is shut.
  let opticsTimer = 0;
  function updateOptics() {
    opticsTimer = 0;
    const root = $("#dfi-root");
    if (!root) return;
    // #dfi-root is the scroll container (overflow-y:auto), not the window, so the offset comes
    // from scrollTop. Reading window.scrollY here would return a constant 0 and freeze the glare.
    const scroll = root.scrollTop || 0;
    const h = window.innerHeight || 1;
    root.style.setProperty("--scroll-glare", scroll + "px");
    $$(".creation-card", root).forEach((card, i) => {
      const r = card.getBoundingClientRect();
      const travel = ((r.top + r.height / 2) / h - 0.5) * 150;
      card.style.setProperty("--card-glare-y", travel.toFixed(1) + "px");
      card.style.setProperty("--card-glare-x", ((scroll * 0.085 + i * 19) % Math.max(180, r.width + 90)).toFixed(1) + "px");
    });
  }
  const onOpticsScroll = () => { if (!opticsTimer) opticsTimer = setTimeout(updateOptics, 36); };
  function onVaultPointer(e) {
    const vault = $("#dfi-root .vault");
    if (!vault) return;
    const r = vault.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
    vault.style.setProperty("--pointer-x", x.toFixed(1) + "%");
    vault.style.setProperty("--pointer-y", y.toFixed(1) + "%");
  }
  function onVaultLeave() {
    const vault = $("#dfi-root .vault");
    if (!vault) return;
    vault.style.setProperty("--pointer-x", "72%");
    vault.style.setProperty("--pointer-y", "18%");
  }
  function bindOptics() {
    const root = $("#dfi-root");
    if (!root) return;
    root.addEventListener("scroll", onOpticsScroll, { passive: true });
    window.addEventListener("resize", onOpticsScroll, { passive: true });
    const vault = $("#dfi-root .vault");
    if (vault) {
      vault.addEventListener("pointermove", onVaultPointer);
      vault.addEventListener("pointerleave", onVaultLeave);
    }
    updateOptics();
  }
  function unbindOptics() {
    const root = $("#dfi-root");
    if (root) root.removeEventListener("scroll", onOpticsScroll);
    window.removeEventListener("resize", onOpticsScroll);
    const vault = $("#dfi-root .vault");
    if (vault) {
      vault.removeEventListener("pointermove", onVaultPointer);
      vault.removeEventListener("pointerleave", onVaultLeave);
    }
    if (opticsTimer) { clearTimeout(opticsTimer); opticsTimer = 0; }
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
    // The folder grant is restored before the gallery paints, so the bar never flashes "NOT LINKED"
    // at someone who linked it yesterday.
    restoreFolder().then(renderFolderBar);
    renderGallery();
    refreshJobs();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => { if (state.open) refreshJobs({ quiet: true }); }, 60000);
    resetDoor();      // never reopen parked, even if a previous close was interrupted
    bindOptics();
  }
  function closePanel() {
    state.open = false;
    document.body.classList.remove("dfi-open");
    unbindOptics();
    // Must outlast --dfi-slide-dur (.86s). This used to be 500ms against a 450ms slide; leaving it
    // there after the retune would hit display:none mid-flight and make the pane vanish instead of
    // leaving. If the slide duration changes again, this floor changes with it.
    setTimeout(() => {
      if (!state.open) { document.body.classList.remove("dfi-anim"); resetDoor(); }
    }, 950);
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }
  async function refreshConfig() {
    try {
      const c = await apiJson(API.config);
      if (c && c.tokens) CFG = c;
      if (!CFG.draft) CFG.draft = { available: false, model: "", refs: false, brand: "Free Draft Engine" };
      syncDraftToggle();
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
    btn.title = "Image Generator";
    btn.setAttribute("aria-label", "Open the image generator");
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
