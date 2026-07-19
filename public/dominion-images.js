// Dominion Forge Images — client panel. Self-contained IIFE, same contract as dominion-forge.js:
// injects its own DOM, owns the slide-right reveal (the whole Dominion interface slides off to
// the right; an arrow at the right edge brings it back), and keeps every generated image in the
// DEVICE's IndexedDB gallery — nothing is stored in the cloud.
// Layout/theme here is deliberately functional: the visual pass is being designed separately.
(() => {
  "use strict";

  const API = {
    config: "/api/images/config",
    generate: "/api/images/generate",
    batch: "/api/images/batch",
    batches: "/api/images/batches",
  };

  // Fallback copy of the published OpenAI tables; /api/images/config overrides at runtime.
  let CFG = {
    available: true,
    model: "gpt-image-1.5",
    syncMaxN: 4,
    tokens: {
      low: { square: 272, portrait: 408, landscape: 400 },
      medium: { square: 1056, portrait: 1584, landscape: 1568 },
      high: { square: 4160, portrait: 6240, landscape: 6208 },
    },
    prices: {
      low: { square: 0.009, portrait: 0.013, landscape: 0.013 },
      medium: { square: 0.034, portrait: 0.05, landscape: 0.05 },
      high: { square: 0.133, portrait: 0.2, landscape: 0.2 },
    },
    batch: { discount: 0.5, window: "24h", maxItemsGuest: 50, maxItemsOwner: 200 },
  };

  const SIZES = { square: "1024×1024", portrait: "1024×1536", landscape: "1536×1024" };
  const state = {
    open: false,
    quality: "low",
    aspect: "square",
    n: 1,
    queue: [],          // pending batch items {prompt, quality, aspect}
    jobs: [],
    busy: false,
    pollTimer: null,
  };

  // ---------- local gallery (IndexedDB) ----------
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
  async function galleryAdd(rec) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("images", "readwrite");
      tx.objectStore("images").put(rec);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function galleryAll() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const rq = d.transaction("images").objectStore("images").index("ts").getAll();
      rq.onsuccess = () => resolve((rq.result || []).reverse());
      rq.onerror = () => reject(rq.error);
    });
  }
  async function galleryDelete(id) {
    const d = await db();
    return new Promise((resolve) => {
      const tx = d.transaction("images", "readwrite");
      tx.objectStore("images").delete(id);
      tx.oncomplete = resolve;
    });
  }
  async function galleryClear() {
    const d = await db();
    return new Promise((resolve) => {
      const tx = d.transaction("images", "readwrite");
      tx.objectStore("images").clear();
      tx.oncomplete = resolve;
    });
  }
  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || "image/png" });
  }
  async function saveImage(b64, meta) {
    const rec = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      blob: b64ToBlob(b64, "image/png"),
      ts: Date.now(),
      prompt: meta.prompt || "",
      quality: meta.quality || "",
      aspect: meta.aspect || "",
      model: meta.model || CFG.model,
      source: meta.source || "sync",
    };
    await galleryAdd(rec);
    return rec;
  }

  // ---------- helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmtUsd = (v) => (v >= 0.01 ? "$" + v.toFixed(3).replace(/0$/, "") : "$" + v.toFixed(4));
  function setMsg(text, isErr) {
    const m = $("#dfi-msg");
    if (!m) return;
    m.textContent = text || "";
    m.classList.toggle("dfi-err", !!isErr);
  }
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
    if (e.code === "needs_invite" || e.code === "needs_credits") {
      return e.message + " Open Setup to continue.";
    }
    return e.message;
  }

  // ---------- estimates (published OpenAI numbers) ----------
  function estimate(quality, aspect, n, batch) {
    const tok = (CFG.tokens[quality] || {})[aspect] || 0;
    const price = ((CFG.prices[quality] || {})[aspect] || 0) * (batch ? CFG.batch.discount : 1);
    return { tokens: tok, perImage: price, total: price * n, totalTokens: tok * n };
  }
  function renderEstimate() {
    const box = $("#dfi-estimate");
    if (!box) return;
    const e = estimate(state.quality, state.aspect, state.n, false);
    const b = estimate(state.quality, state.aspect, 1, true);
    box.innerHTML = "";
    box.append(
      el("div", "dfi-est-line", `${SIZES[state.aspect]} · ${state.quality} · ≈${e.tokens.toLocaleString()} tokens per image`),
      el("div", "dfi-est-line dfi-est-strong", `Generate now: ${fmtUsd(e.perImage)}/image · ${state.n} image${state.n > 1 ? "s" : ""} ≈ ${fmtUsd(e.total)}`),
      el("div", "dfi-est-line", `Batch (50% off, up to ${CFG.batch.window}): ${fmtUsd(b.perImage)}/image`)
    );
  }

  // ---------- panel DOM ----------
  function segRow(labelText, options, current, onPick) {
    const row = el("div", "dfi-seg-row");
    row.append(el("span", "dfi-seg-label", labelText));
    const seg = el("div", "dfi-seg");
    for (const [value, label] of options) {
      const b = el("button", "dfi-seg-btn" + (value === current ? " on" : ""), label);
      b.type = "button";
      b.dataset.value = value;
      b.addEventListener("click", () => {
        seg.querySelectorAll(".dfi-seg-btn").forEach((x) => x.classList.toggle("on", x === b));
        onPick(value);
        renderEstimate();
      });
      seg.append(b);
    }
    row.append(seg);
    return row;
  }

  function buildPanel() {
    const root = el("section", "dfi-root");
    root.id = "dfi-root";
    root.setAttribute("aria-label", "Dominion Forge Images");

    // Return arrow: the interface slid off to the right, so the way back sits on the right edge.
    const back = el("button", "dfi-back", "");
    back.id = "dfi-back";
    back.title = "Return to Dominion";
    back.setAttribute("aria-label", "Return to the Dominion interface");
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    back.addEventListener("click", closePanel);

    const inner = el("div", "dfi-inner");

    const head = el("header", "dfi-head");
    head.append(el("h1", "dfi-title", "Dominion Forge Images"));
    head.append(el("p", "dfi-sub", "Forged by OpenAI imaging · every image is saved to this device only"));
    inner.append(head);

    // --- compose card
    const compose = el("div", "dfi-card");
    compose.append(el("h2", "dfi-card-h", "Forge an image"));
    const prompt = el("textarea", "dfi-prompt");
    prompt.id = "dfi-prompt";
    prompt.rows = 3;
    prompt.placeholder = "Describe the image to forge…";
    compose.append(prompt);
    compose.append(segRow("Quality", [["low", "Low"], ["medium", "Medium"], ["high", "High"]], state.quality, (v) => (state.quality = v)));
    compose.append(segRow("Shape", [["square", "Square"], ["portrait", "Portrait"], ["landscape", "Landscape"]], state.aspect, (v) => (state.aspect = v)));
    compose.append(segRow("Count", [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], "1", (v) => (state.n = Number(v))));
    const estBox = el("div", "dfi-estimate");
    estBox.id = "dfi-estimate";
    compose.append(estBox);
    const actions = el("div", "dfi-actions");
    const genBtn = el("button", "dfi-btn dfi-btn-primary", "Generate now");
    genBtn.id = "dfi-generate";
    genBtn.addEventListener("click", onGenerate);
    const queueBtn = el("button", "dfi-btn", "Add to batch (50% off)");
    queueBtn.id = "dfi-queue-add";
    queueBtn.addEventListener("click", onQueueAdd);
    actions.append(genBtn, queueBtn);
    compose.append(actions);
    const msg = el("div", "dfi-msg");
    msg.id = "dfi-msg";
    compose.append(msg);
    inner.append(compose);

    // --- batch card
    const batch = el("div", "dfi-card");
    const bh = el("h2", "dfi-card-h", "Batch forge: half price, ready within 24h");
    batch.append(bh);
    batch.append(el("p", "dfi-note", "Queue prompts, submit them together, and OpenAI runs them at 50% of the live rate. Your credits are charged when you submit; when you collect, any overcharge comes back to your credits automatically, and a failed batch refunds in full."));
    const qlist = el("div", "dfi-queue");
    qlist.id = "dfi-queue";
    batch.append(qlist);
    const brow = el("div", "dfi-actions");
    const submitBtn = el("button", "dfi-btn dfi-btn-primary", "Submit batch");
    submitBtn.id = "dfi-batch-submit";
    submitBtn.addEventListener("click", onBatchSubmit);
    brow.append(submitBtn);
    batch.append(brow);
    const jobs = el("div", "dfi-jobs");
    jobs.id = "dfi-jobs";
    batch.append(jobs);
    inner.append(batch);

    // --- gallery card
    const gal = el("div", "dfi-card");
    const gh = el("div", "dfi-gal-head");
    gh.append(el("h2", "dfi-card-h", "Gallery: on this device"));
    const clearBtn = el("button", "dfi-btn dfi-btn-ghost", "Clear all");
    clearBtn.addEventListener("click", async () => {
      if (!confirm("Delete every image in the on-device gallery? This cannot be undone.")) return;
      await galleryClear();
      renderGallery();
    });
    gh.append(clearBtn);
    gal.append(gh);
    const grid = el("div", "dfi-grid");
    grid.id = "dfi-grid";
    gal.append(grid);
    const galNote = el("p", "dfi-note");
    galNote.id = "dfi-gal-note";
    gal.append(galNote);
    inner.append(gal);

    root.append(back, inner);
    document.body.append(root);
    renderEstimate();
    renderQueue();
  }

  // ---------- open/close (the slide) ----------
  function openPanel() {
    if (!$("#dfi-root")) buildPanel();
    state.open = true;
    document.body.classList.add("dfi-anim");
    // Force a style flush between the two classes so the slide transitions instead of jumping,
    // without depending on requestAnimationFrame (throttled or absent in some webviews).
    void document.getElementById("dfi-root").offsetWidth;
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
    // Drop the transform context after the slide so position:fixed app chrome behaves normally.
    setTimeout(() => { if (!state.open) document.body.classList.remove("dfi-anim"); }, 500);
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function refreshConfig() {
    try {
      const c = await apiJson(API.config);
      if (c && c.tokens) CFG = c;
      renderEstimate();
      if (!CFG.available) setMsg("Image generation is not configured on the server yet (missing OpenAI key).", true);
    } catch {}
  }

  // ---------- generate now ----------
  async function onGenerate() {
    const prompt = $("#dfi-prompt").value.trim();
    if (!prompt) return setMsg("Describe the image first.", true);
    if (state.busy) return;
    state.busy = true;
    const btn = $("#dfi-generate");
    btn.disabled = true;
    btn.textContent = "Forging…";
    setMsg("Forging " + state.n + " image" + (state.n > 1 ? "s" : "") + ". High quality can take a minute.");
    try {
      const r = await apiJson(API.generate, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, quality: state.quality, aspect: state.aspect, n: state.n }),
      });
      for (const img of r.images || []) {
        await saveImage(img.b64, { prompt, quality: r.quality, aspect: r.aspect, model: r.model, source: "sync" });
      }
      setMsg(`Forged ${r.images.length} image${r.images.length > 1 ? "s" : ""} · ${r.usage && r.usage.outputTokens ? r.usage.outputTokens.toLocaleString() + " tokens · " : ""}${fmtUsd(r.costUsd || 0)} · saved to your gallery.`);
      renderGallery();
    } catch (e) {
      setMsg(friendly(e), true);
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = "Generate now";
    }
  }

  // ---------- batch ----------
  function renderQueue() {
    const box = $("#dfi-queue");
    if (!box) return;
    box.innerHTML = "";
    if (!state.queue.length) {
      box.append(el("p", "dfi-note", "Nothing queued yet. Set a prompt above and tap “Add to batch”."));
      $("#dfi-batch-submit").disabled = true;
      return;
    }
    let total = 0;
    for (let i = 0; i < state.queue.length; i++) {
      const q = state.queue[i];
      const e = estimate(q.quality, q.aspect, 1, true);
      total += e.perImage;
      const row = el("div", "dfi-queue-row");
      row.append(el("span", "dfi-queue-txt", q.prompt.length > 70 ? q.prompt.slice(0, 70) + "…" : q.prompt));
      row.append(el("span", "dfi-queue-meta", `${q.quality} · ${SIZES[q.aspect]} · ${fmtUsd(e.perImage)}`));
      const rm = el("button", "dfi-x", "×");
      rm.title = "Remove";
      rm.addEventListener("click", () => { state.queue.splice(i, 1); renderQueue(); });
      row.append(rm);
      box.append(row);
    }
    box.append(el("p", "dfi-queue-total", `${state.queue.length} image${state.queue.length > 1 ? "s" : ""} queued · estimated ${fmtUsd(total)} at the 50% batch rate`));
    $("#dfi-batch-submit").disabled = false;
  }
  function onQueueAdd() {
    const prompt = $("#dfi-prompt").value.trim();
    if (!prompt) return setMsg("Describe the image first.", true);
    for (let i = 0; i < state.n; i++) state.queue.push({ prompt, quality: state.quality, aspect: state.aspect });
    setMsg(`Added to the batch queue (${state.queue.length} queued).`);
    renderQueue();
  }
  async function onBatchSubmit() {
    if (!state.queue.length || state.busy) return;
    state.busy = true;
    const btn = $("#dfi-batch-submit");
    btn.disabled = true;
    btn.textContent = "Submitting…";
    try {
      const r = await apiJson(API.batch, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: state.queue }),
      });
      state.queue = [];
      renderQueue();
      setMsg(`Batch submitted: ${r.count} image${r.count > 1 ? "s" : ""} · ${fmtUsd(r.estUsd)} charged now${r.chargedCredits ? " (" + r.chargedCredits + " credits)" : ""} · ready within 24h (usually much sooner). Overcharges settle back at collection.`);
      refreshJobs();
    } catch (e) {
      setMsg(friendly(e), true);
    } finally {
      state.busy = false;
      btn.textContent = "Submit batch";
      btn.disabled = !state.queue.length;
    }
  }
  async function refreshJobs(opts) {
    try {
      const r = await apiJson(API.batches);
      state.jobs = r.jobs || [];
      renderJobs();
    } catch (e) {
      if (!opts || !opts.quiet) renderJobs();
    }
  }
  const JOB_LABELS = {
    validating: "Validating…", in_progress: "Forging…", finalizing: "Finalizing…",
    completed: "Ready", failed: "Failed", expired: "Expired", cancelled: "Cancelled", cancelling: "Cancelling…",
  };
  function renderJobs() {
    const box = $("#dfi-jobs");
    if (!box) return;
    box.innerHTML = "";
    if (!state.jobs.length) return;
    box.append(el("h3", "dfi-jobs-h", "Batch jobs"));
    for (const j of state.jobs.slice(0, 12)) {
      const row = el("div", "dfi-job-row");
      const when = new Date(j.ts).toLocaleString();
      row.append(el("span", "dfi-queue-txt", `${j.count} image${j.count > 1 ? "s" : ""} · ${when}`));
      row.append(el("span", "dfi-job-status dfi-job-" + j.status, JOB_LABELS[j.status] || j.status));
      row.append(el("span", "dfi-queue-meta", j.settled && j.costUsd != null ? fmtUsd(j.costUsd) + " final" : fmtUsd(j.estUsd) + " charged"));
      if (j.status === "completed") {
        const c = el("button", "dfi-btn dfi-btn-small", "Collect");
        c.addEventListener("click", () => collectBatch(j.id, c));
        row.append(c);
      } else if (["validating", "in_progress", "finalizing"].includes(j.status)) {
        const chk = el("button", "dfi-btn dfi-btn-small dfi-btn-ghost", "Check");
        chk.addEventListener("click", async () => { chk.disabled = true; await pollJob(j.id); chk.disabled = false; });
        row.append(chk);
        const cx = el("button", "dfi-x", "×");
        cx.title = "Cancel batch";
        cx.addEventListener("click", async () => {
          if (!confirm("Cancel this batch job?")) return;
          try { await apiJson(API.batch + "/" + encodeURIComponent(j.id) + "/cancel", { method: "POST" }); } catch (e) { setMsg(friendly(e), true); }
          refreshJobs();
        });
        row.append(cx);
      }
      box.append(row);
    }
  }
  async function pollJob(id) {
    try {
      const r = await apiJson(API.batch + "/" + encodeURIComponent(id));
      const j = state.jobs.find((x) => x.id === id);
      if (j) { j.status = r.status; j.costUsd = r.costUsd; }
      renderJobs();
      return r;
    } catch (e) {
      setMsg(friendly(e), true);
      return null;
    }
  }
  async function collectBatch(id, btn) {
    btn.disabled = true;
    btn.textContent = "Collecting…";
    let offset = 0, saved = 0, total = null;
    try {
      for (;;) {
        const r = await apiJson(API.batch + "/" + encodeURIComponent(id) + "?offset=" + offset + "&limit=4");
        if (r.status !== "completed") { setMsg("Batch is " + (JOB_LABELS[r.status] || r.status), true); break; }
        total = r.total;
        for (const img of r.images || []) {
          await saveImage(img.b64, { prompt: img.prompt, quality: img.quality, aspect: img.aspect, source: "batch" });
          saved++;
        }
        setMsg(`Collecting batch… ${saved}/${total} saved to your gallery.`);
        renderGallery();
        offset += (r.images || []).length;
        if (r.done || !(r.images || []).length) {
          const settle = r.refundedCredits ? ` · ${r.refundedCredits} credit${r.refundedCredits === 1 ? "" : "s"} returned` : r.extraCredits ? ` · ${r.extraCredits} extra credit${r.extraCredits === 1 ? "" : "s"} for overage` : "";
          setMsg(`Batch collected: ${saved} image${saved === 1 ? "" : "s"} in your gallery` + (r.failed ? ` · ${r.failed} failed` : "") + (r.costUsd != null ? ` · ${fmtUsd(r.costUsd)} actual at the 50% batch rate` : "") + settle + ".");
          break;
        }
      }
      refreshJobs();
    } catch (e) {
      setMsg(friendly(e), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Collect";
    }
  }

  // ---------- gallery ----------
  const objectUrls = [];
  async function renderGallery() {
    const grid = $("#dfi-grid");
    if (!grid) return;
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
    grid.innerHTML = "";
    let recs = [];
    try { recs = await galleryAll(); } catch {}
    const note = $("#dfi-gal-note");
    if (!recs.length) {
      note.textContent = "No images yet. Everything you forge is stored on this device only; clearing site data clears the gallery.";
      return;
    }
    note.textContent = recs.length + " image" + (recs.length > 1 ? "s" : "") + " stored locally on this device.";
    for (const rec of recs) {
      const url = URL.createObjectURL(rec.blob);
      objectUrls.push(url);
      const cell = el("button", "dfi-cell");
      cell.type = "button";
      const img = el("img", "dfi-thumb");
      img.src = url;
      img.alt = rec.prompt.slice(0, 80) || "Forged image";
      img.loading = "lazy";
      cell.append(img);
      cell.addEventListener("click", () => openViewer(rec, url));
      grid.append(cell);
    }
  }
  function openViewer(rec, url) {
    const scrim = el("div", "dfi-viewer");
    const card = el("div", "dfi-viewer-card");
    const img = el("img", "dfi-viewer-img");
    img.src = url;
    img.alt = rec.prompt || "Forged image";
    card.append(img);
    const meta = el("div", "dfi-viewer-meta");
    meta.append(el("p", "dfi-viewer-prompt", rec.prompt || "(no prompt saved)"));
    meta.append(el("p", "dfi-queue-meta", `${rec.quality} · ${SIZES[rec.aspect] || rec.aspect} · ${new Date(rec.ts).toLocaleString()} · ${rec.source === "batch" ? "batch forge" : "live forge"}`));
    const row = el("div", "dfi-actions");
    const dl = el("a", "dfi-btn dfi-btn-primary", "Download");
    dl.href = url;
    dl.download = "dominion-forge-" + new Date(rec.ts).toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
    const del = el("button", "dfi-btn dfi-btn-ghost", "Delete");
    del.addEventListener("click", async () => { await galleryDelete(rec.id); scrim.remove(); renderGallery(); });
    const close = el("button", "dfi-btn", "Close");
    close.addEventListener("click", () => scrim.remove());
    row.append(dl, del, close);
    meta.append(row);
    card.append(meta);
    scrim.append(card);
    scrim.addEventListener("click", (ev) => { if (ev.target === scrim) scrim.remove(); });
    document.body.append(scrim);
  }

  // ---------- trigger ----------
  function initTrigger() {
    const barLeft = document.getElementById("bar-left");
    const btn = el("button", "dfi-trigger");
    btn.id = "dfi-trigger";
    btn.title = "Dominion Forge Images";
    btn.setAttribute("aria-label", "Open Dominion Forge Images");
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4.5 18l5-5 3.5 3.5L17 12l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener("click", openPanel);
    if (barLeft) barLeft.append(btn);
    else { btn.classList.add("dfi-trigger-floating"); document.body.append(btn); }
  }

  window.openForgeImages = openPanel;
  window.closeForgeImages = closePanel;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTrigger);
  else initTrigger();
})();
