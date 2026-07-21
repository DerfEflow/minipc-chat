/*
 * The Crucible: two lenses on one build.
 *   SOW docs/IDE-MODE-ROADMAP.md (Phase 5.1-5.6) - build pack docs/IDE-MODE-BUILD.md
 *
 * THE PROBLEM THIS SOLVES. Beginner tools patronise professionals and professional tools lose
 * everyone else. So there is one build state and two ways of looking at it:
 *
 *   BLUEPRINT  numbered cards in plain English. What each move does, why, what it touches, what
 *              it cost. Approve, skip, or ask for an explanation. This is the default.
 *   WORKSHOP   the file tree, the diffs, the console output, the audit trail.
 *
 * They are VIEWS, never modes: both read the same job events, so they cannot disagree about what
 * happened. Switching is instant and changes nothing about the build.
 *
 * Everything here renders from the durable job journal (idejobs.mjs) delivered over
 * /ide/job/attach, so a reload or a week later replays identically. The client holds no build
 * state of its own.
 */
(() => {
  "use strict";

  const LENS_KEY = "dominion.crucible.lens.v1";
  const $ = (s, r) => (r || document).querySelector(s);
  const L = (k) => (window.DominionLexicon ? window.DominionLexicon.L(k) : k);

  const state = {
    lens: "blueprint",
    jobId: "",
    events: [],
    detach: null,
    mounted: false,
  };

  const readLens = () => { try { return localStorage.getItem(LENS_KEY) || "blueprint"; } catch { return "blueprint"; } };
  const writeLens = (v) => { try { localStorage.setItem(LENS_KEY, v); } catch {} };

  /* ---------- reducing the journal to something renderable ---------------------------------
   * One pass over the events. Later events for the same move supersede earlier ones, which is
   * what makes replay and live-tail produce identical output.
   */
  function digest(events) {
    const d = { title: "", moves: new Map(), files: new Map(), runs: [], costUsd: 0, costCredits: 0,
                snapshots: [], question: null, outcome: "", interrupted: false, started: 0, ended: 0 };
    for (const ev of events) {
      switch (ev.type) {
        case "job": d.started = ev.at || 0; break;
        case "plan":
          d.title = ev.title || d.title;
          for (const m of (ev.moves || [])) {
            if (!d.moves.has(m.id)) d.moves.set(m.id, { id: m.id, title: m.title || "", why: m.why || "", files: m.files || [], state: "planned" });
          }
          break;
        case "move": {
          const prev = d.moves.get(ev.id) || { id: ev.id, files: [] };
          d.moves.set(ev.id, { ...prev,
            title: ev.title || prev.title || "", why: ev.why || prev.why || "",
            state: ev.state || prev.state || "planned",
            taskClass: ev.taskClass || prev.taskClass || "", model: ev.model || prev.model || "",
            reason: ev.routeWhy || prev.reason || "", message: ev.message || "",
            fileCount: typeof ev.files === "number" ? ev.files : prev.fileCount });
          break;
        }
        case "file": d.files.set(ev.path, { path: ev.path, bytes: ev.bytes || 0 }); break;
        case "diff": {
          const f = d.files.get(ev.path) || { path: ev.path };
          d.files.set(ev.path, { ...f, diff: ev.diff || "", added: ev.added, removed: ev.removed });
          break;
        }
        case "run": d.runs.push(ev); break;
        case "cost": d.costUsd += Number(ev.usd) || 0; d.costCredits += Number(ev.credits) || 0; break;
        case "snapshot": d.snapshots.push(ev); break;
        case "need_input": d.question = ev; break;
        case "answer": d.question = null; break;
        case "done": case "error": case "stopped":
          d.outcome = ev.type; d.ended = ev.at || 0;
          if (ev.code === "interrupted") d.interrupted = true;
          break;
      }
    }
    return d;
  }

  /* ---------- the shell ---------------------------------------------------------------------- */
  function mount() {
    const stage = $("#ide-stage");
    if (!stage || $("#cru")) return;
    state.lens = readLens();

    const root = document.createElement("section");
    root.id = "cru";
    root.dataset.lens = state.lens;

    const head = document.createElement("div");
    head.className = "cru-head";
    head.innerHTML =
      '<div class="cru-switch" role="tablist" aria-label="How to view this build">' +
        '<button type="button" role="tab" data-lens="blueprint">' + L("lens_blueprint") + '</button>' +
        '<button type="button" role="tab" data-lens="workshop">' + L("lens_workshop") + '</button>' +
      '</div>' +
      '<div class="cru-meter" id="cru-meter"><span class="lbl">' + L("cost_label") + '</span><span class="val" id="cru-cost">' + L("cost_none") + '</span></div>';

    const body = document.createElement("div");
    body.className = "cru-body";
    body.id = "cru-body";

    root.append(head, body);
    stage.prepend(root);

    for (const b of head.querySelectorAll(".cru-switch button")) {
      b.addEventListener("click", () => setLens(b.dataset.lens));
    }
    paintSwitch();
    state.mounted = true;
    render();
  }

  function setLens(lens) {
    if (lens !== "blueprint" && lens !== "workshop") return;
    state.lens = lens;
    writeLens(lens);
    const root = $("#cru");
    if (root) root.dataset.lens = lens;
    paintSwitch();
    render();
  }

  function paintSwitch() {
    for (const b of document.querySelectorAll("#cru .cru-switch button")) {
      const on = b.dataset.lens === state.lens;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  /* ---------- following a build --------------------------------------------------------------
   * Attach replays the whole journal from event zero and then live-tails, so opening a build that
   * finished yesterday and watching one that is running right now take the identical path.
   */
  function follow(jobId) {
    if (!jobId || jobId === state.jobId) return;
    if (state.detach) { try { state.detach(); } catch {} state.detach = null; }
    state.jobId = jobId;
    state.events = [];
    render();

    const es = new EventSource("/ide/job/attach?job=" + encodeURIComponent(jobId) + "&from=0");
    let closed = false, ended = false;
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "gone") { es.close(); return; }
      if (ev.type === "done" || ev.type === "error" || ev.type === "stopped") ended = true;
      state.events.push(ev);
      render();
    };
    /*
     * On error, close and RESET rather than merely closing. follow() refuses to re-attach to the
     * job it thinks it is already following, so closing while keeping state.jobId froze the lens
     * permanently after any transient network blip. Clearing the id lets the retry re-attach, and
     * re-attaching replays from zero into an emptied event list, so nothing double-counts.
     */
    es.onerror = () => {
      if (closed) return;
      closed = true;
      es.close();
      /*
       * Two very different closes share this handler. A finished job's stream ends NORMALLY and
       * the browser still reports it as an error; treating that as a drop put the lens in a
       * clear-and-reattach loop every two seconds, flashing empty between cycles. So: terminal
       * event already seen means the story is complete, keep it on screen and stop. Only a close
       * with the job still live is a real drop worth resetting and retrying.
       */
      if (ended) return;
      state.jobId = "";
      setTimeout(() => { if (document.body.classList.contains("ide-open")) sync(); }, 2000);
    };
    state.detach = () => { closed = true; es.close(); };
  }

  // Pick what to show: whatever is running, else the most recent build.
  async function sync() {
    try {
      const r = await fetch("/ide/jobs", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const jobs = (await r.json()).jobs || [];
      const live = jobs.find((j) => !j.done);
      const pick = live || jobs[0];
      if (pick) follow(pick.id);
      else { state.jobId = ""; state.events = []; render(); }
    } catch {}
  }

  /* ---------- rendering -----------------------------------------------------------------------
   * Coalesced to one paint per frame. A replay delivers the whole journal in a burst, and
   * rebuilding the DOM once per event is work the eye never sees.
   */
  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    // A short TIMER, never requestAnimationFrame: rAF does not fire in hidden tabs at all, so an
    // rAF debounce leaves the lens permanently blank anywhere the page is considered background
    // (embedded panes, a PWA behind another app). 16ms batches a replay burst just as well.
    setTimeout(() => { renderQueued = false; renderNow(); }, 16);
  }
  function renderNow() {
    const body = $("#cru-body");
    if (!body) return;
    const d = digest(state.events);
    paintCost(d);
    paintStop(d);

    if (!state.jobId) { body.replaceChildren(emptyState()); return; }
    body.replaceChildren(state.lens === "blueprint" ? blueprint(d) : workshop(d));
    maybeOfferPublish(d);
  }

  /*
   * The publish invitation (Fred's ruling 2026-07-21): when a build finishes, the user sees
   * "Put this online so everyone can use it" in their own register. Behind it sits an HONEST
   * explanation of what that involves; the guided deploy itself ships later, and this card says
   * so plainly rather than promising a button that does not exist yet. Shown once per build.
   */
  function maybeOfferPublish(d) {
    if (d.outcome !== "done" || !state.jobId) return;
    let seen = null;
    try { seen = localStorage.getItem("dominion.publish.seen." + state.jobId); } catch {}
    if (seen) return;
    if ($("#cru-publish")) return;
    const isBuild = state.events.some((e) => e.type === "job" && e.kind === "build");
    if (!isBuild) return;

    const card = document.createElement("section");
    card.id = "cru-publish";
    card.className = "cru-publish";
    const done = document.createElement("p"); done.className = "pub-done"; done.textContent = L("publish_done_line");
    const cta = document.createElement("h3"); cta.textContent = L("publish_cta");
    const row = document.createElement("div"); row.className = "pub-row";
    const show = document.createElement("button"); show.type = "button"; show.textContent = L("publish_show");
    const later = document.createElement("button"); later.type = "button"; later.className = "pub-later"; later.textContent = L("publish_later");
    row.append(show, later);
    const body2 = document.createElement("p"); body2.className = "pub-explain"; body2.hidden = true; body2.textContent = L("publish_explain");
    card.append(done, cta, row, body2);

    show.addEventListener("click", () => { body2.hidden = !body2.hidden; });
    later.addEventListener("click", () => {
      try { localStorage.setItem("dominion.publish.seen." + state.jobId, "1"); } catch {}
      card.remove();
    });
    const bodyEl = $("#cru-body");
    if (bodyEl) bodyEl.prepend(card);
  }

  // The Stop control exists exactly while there is something to stop.
  function paintStop(d) {
    const head = $("#cru .cru-head");
    if (!head) return;
    let btn = $("#cru-stop");
    const running = state.jobId && !d.outcome;
    if (!running) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "cru-stop";
      btn.textContent = L("stop_build");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await fetch("/ide/job/stop", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId: state.jobId }) });
        } catch {}
        btn.disabled = false;
      });
      head.append(btn);
    }
  }

  function paintCost(d) {
    const el = $("#cru-cost");
    if (!el) return;
    if (!state.jobId) { el.textContent = L("cost_none"); return; }
    if (!d.costUsd && !d.costCredits) { el.textContent = L("cost_zero"); return; }
    el.textContent = d.costCredits ? d.costCredits + " credits" : "$" + d.costUsd.toFixed(4);
  }

  function emptyState() {
    const el = document.createElement("div");
    el.className = "cru-empty";
    const h = document.createElement("h3"); h.textContent = L("no_builds_title");
    const pp = document.createElement("p"); pp.textContent = L("no_builds_body");
    el.append(h, pp);
    return el;
  }

  /* ---------- BLUEPRINT: the plain-English lens ------------------------------------------------
   * A move card says what it will do, why, and what it touched. No jargon on this lens, ever: it
   * is the one a non-programmer reads.
   */
  const stateWord = (st) => L("st_" + st) === "st_" + st ? (st || "") : L("st_" + st);

  function blueprint(d) {
    const wrap = document.createElement("div");
    wrap.className = "cru-blueprint";

    if (d.title) {
      const h = document.createElement("h3");
      h.className = "cru-title";
      h.textContent = d.title;
      wrap.append(h);
    }

    const moves = [...d.moves.values()];
    if (!moves.length) {
      const p = document.createElement("p");
      p.className = "cru-note";
      p.textContent = "This build has not laid out its plan yet.";
      wrap.append(p);
    }

    moves.forEach((m, i) => {
      const card = document.createElement("article");
      card.className = "cru-card";
      card.dataset.state = m.state;

      const top = document.createElement("div");
      top.className = "c-top";
      const num = document.createElement("span"); num.className = "c-num"; num.textContent = String(i + 1);
      const title = document.createElement("span"); title.className = "c-title"; title.textContent = m.title || "Move " + (i + 1);
      const badge = document.createElement("span"); badge.className = "c-state"; badge.textContent = stateWord(m.state);
      top.append(num, title, badge);
      card.append(top);

      if (m.why) { const why = document.createElement("p"); why.className = "c-why"; why.textContent = m.why; card.append(why); }
      if (m.message) { const msg = document.createElement("p"); msg.className = "c-msg"; msg.textContent = m.message; card.append(msg); }

      const foot = document.createElement("div");
      foot.className = "c-foot";
      if (m.files && m.files.length) {
        const f = document.createElement("span");
        f.className = "c-files";
        f.textContent = m.files.length === 1 ? "1 file" : m.files.length + " files";
        f.title = m.files.join("\n");
        foot.append(f);
      }
      if (typeof m.fileCount === "number" && m.state === "done") {
        const w = document.createElement("span"); w.className = "c-files";
        w.textContent = m.fileCount + (m.fileCount === 1 ? " file written" : " files written");
        foot.append(w);
      }
      // The model is named, and the router's reason with it, because a build you cannot audit is
      // a build you cannot trust.
      if (m.model && m.model !== "dominion-forge") {
        const chip = document.createElement("span"); chip.className = "c-model"; chip.textContent = friendly(m.model);
        if (m.reason) chip.title = m.reason;
        foot.append(chip);
      } else if (m.model === "dominion-forge") {
        const chip = document.createElement("span"); chip.className = "c-model is-forge"; chip.textContent = "Dominion Forge";
        foot.append(chip);
      }
      if (foot.children.length) card.append(foot);
      wrap.append(card);
    });

    if (d.snapshots.length) {
      const s = document.createElement("p");
      s.className = "cru-note";
      s.textContent = d.snapshots.length === 1 ? L("snapshot_note_one")
        : d.snapshots.length + " " + L("snapshot_note_one").toLowerCase();
      wrap.append(s);
    }
    if (d.outcome) wrap.append(outcomeLine(d));
    return wrap;
  }

  function outcomeLine(d) {
    const el = document.createElement("p");
    el.className = "cru-outcome";
    el.dataset.outcome = d.outcome;
    el.textContent = d.interrupted ? L("outcome_interrupted")
      : d.outcome === "done" ? L("outcome_done")
      : d.outcome === "stopped" ? L("outcome_stopped")
      : L("outcome_error");
    return el;
  }

  // Never print a raw provider id at a person. The catalog name is the display name.
  function friendly(id) {
    const s = String(id || "");
    const tail = s.includes("/") ? s.split("/").pop() : s;
    return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /* ---------- WORKSHOP: the lens for someone who wants the machinery ---------------------------- */
  function workshop(d) {
    const wrap = document.createElement("div");
    wrap.className = "cru-workshop";

    // Files, as a tree of what this build actually touched.
    const filesBox = section(L("files_touched"));
    const files = [...d.files.values()];
    if (!files.length) filesBox.append(note("Nothing written yet."));
    else filesBox.append(tree(files));
    wrap.append(filesBox);

    // Diffs, when the engine has produced them.
    const withDiff = files.filter((f) => f.diff);
    const diffBox = section(L("changes"));
    if (!withDiff.length) diffBox.append(note("No diffs recorded for this build."));
    else for (const f of withDiff) diffBox.append(diffView(f));
    wrap.append(diffBox);

    // The console: exactly what ran and what it said.
    const runBox = section(L("checks"));
    if (!d.runs.length) runBox.append(note("Nothing has been run yet."));
    else for (const r of d.runs) runBox.append(runView(r));
    wrap.append(runBox);

    return wrap;
  }

  function section(title) {
    const s = document.createElement("div");
    s.className = "w-section";
    const h = document.createElement("h4");
    h.textContent = title;
    s.append(h);
    return s;
  }
  function note(text) { const p = document.createElement("p"); p.className = "cru-note"; p.textContent = text; return p; }

  // Fold a flat path list into a real tree, dirs first, so a big build stays readable.
  function tree(files) {
    const rootNode = {};
    for (const f of files) {
      const parts = f.path.split("/");
      let cur = rootNode;
      parts.forEach((p, i) => {
        if (i === parts.length - 1) (cur.__files = cur.__files || []).push({ name: p, bytes: f.bytes });
        else cur = (cur[p] = cur[p] || {});
      });
    }
    const build = (node, depth) => {
      const ul = document.createElement("ul");
      ul.className = "w-tree";
      for (const key of Object.keys(node).filter((k) => k !== "__files").sort()) {
        const li = document.createElement("li");
        li.className = "is-dir";
        li.textContent = key;
        li.append(build(node[key], depth + 1));
        ul.append(li);
      }
      for (const f of (node.__files || []).sort((a, b) => a.name.localeCompare(b.name))) {
        const li = document.createElement("li");
        li.className = "is-file";
        li.textContent = f.name;
        if (f.bytes) { const b = document.createElement("span"); b.className = "w-bytes"; b.textContent = kb(f.bytes); li.append(b); }
        ul.append(li);
      }
      return ul;
    };
    return build(rootNode, 0);
  }
  const kb = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " kB");

  function diffView(f) {
    const box = document.createElement("div");
    box.className = "w-diff";
    const h = document.createElement("div");
    h.className = "w-diff-head";
    h.textContent = f.path;
    if (typeof f.added === "number" || typeof f.removed === "number") {
      const s = document.createElement("span");
      s.className = "w-diff-stat";
      s.textContent = "+" + (f.added || 0) + " / -" + (f.removed || 0);
      h.append(s);
    }
    const pre = document.createElement("pre");
    for (const line of String(f.diff).split("\n").slice(0, 400)) {
      const row = document.createElement("span");
      row.className = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      row.textContent = line;
      pre.append(row, document.createTextNode("\n"));
    }
    box.append(h, pre);
    return box;
  }

  function runView(r) {
    const box = document.createElement("div");
    box.className = "w-run";
    box.dataset.ok = r.skipped ? "skipped" : r.ok ? "yes" : "no";
    const h = document.createElement("div");
    h.className = "w-run-head";
    h.textContent = r.skipped ? "Skipped" : (r.command || "check");
    const badge = document.createElement("span");
    badge.className = "w-run-badge";
    badge.textContent = r.skipped ? "" : r.ok ? L("check_passed") : L("check_failed");
    h.append(badge);
    box.append(h);
    const text = r.message || r.output || "";
    if (text) { const pre = document.createElement("pre"); pre.textContent = String(text).slice(-4000); box.append(pre); }
    return box;
  }

  /* ---------- lifecycle ------------------------------------------------------------------------ */
  // Mount when The Crucible opens, and refresh whenever it is opened again.
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains("ide-open")) {
      if (!state.mounted) mount();
      sync();
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && document.body.classList.contains("ide-open")) sync();
  });

  // A register change rebuilds the chrome so every string flips voice at once.
  document.addEventListener("dominion-register-changed", () => {
    const root = $("#cru");
    if (!root) return;
    const bp = root.querySelector('[data-lens="blueprint"]'), wk = root.querySelector('[data-lens="workshop"]');
    if (bp) bp.textContent = L("lens_blueprint");
    if (wk) wk.textContent = L("lens_workshop");
    const lbl = root.querySelector(".cru-meter .lbl");
    if (lbl) lbl.textContent = L("cost_label");
    render();
  });

  window.dominionLenses = { mount, sync, follow, setLens, digest, get state() { return state; } };
})();
