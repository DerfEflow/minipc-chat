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
        '<button type="button" role="tab" data-lens="blueprint">Blueprint</button>' +
        '<button type="button" role="tab" data-lens="workshop">Workshop</button>' +
      '</div>' +
      '<div class="cru-meter" id="cru-meter"><span class="lbl">Cost</span><span class="val" id="cru-cost">nothing yet</span></div>';

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
    let closed = false;
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "gone") { es.close(); return; }
      state.events.push(ev);
      render();
    };
    es.onerror = () => { if (!closed) { closed = true; es.close(); } };
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

  /* ---------- rendering ----------------------------------------------------------------------- */
  function render() {
    const body = $("#cru-body");
    if (!body) return;
    const d = digest(state.events);
    paintCost(d);

    if (!state.jobId) { body.replaceChildren(emptyState()); return; }
    body.replaceChildren(state.lens === "blueprint" ? blueprint(d) : workshop(d));
  }

  function paintCost(d) {
    const el = $("#cru-cost");
    if (!el) return;
    if (!state.jobId) { el.textContent = "nothing yet"; return; }
    if (!d.costUsd && !d.costCredits) { el.textContent = "nothing spent"; return; }
    el.textContent = d.costCredits ? d.costCredits + " credits" : "$" + d.costUsd.toFixed(4);
  }

  function emptyState() {
    const el = document.createElement("div");
    el.className = "cru-empty";
    el.innerHTML = "<h3>No builds yet</h3>" +
      "<p>When you start one, it appears here. You can close the app while it runs; " +
      "it keeps going and calls you back if it needs an answer.</p>";
    return el;
  }

  /* ---------- BLUEPRINT: the plain-English lens ------------------------------------------------
   * A move card says what it will do, why, and what it touched. No jargon on this lens, ever: it
   * is the one a non-programmer reads.
   */
  const STATE_WORDS = {
    planned: "Waiting", running: "Working", done: "Done", failed: "Stopped",
    blocked: "Refused", warned: "Done with a note", repairing: "Fixing a problem",
  };

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
      const badge = document.createElement("span"); badge.className = "c-state"; badge.textContent = STATE_WORDS[m.state] || m.state || "";
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
      s.textContent = d.snapshots.length === 1
        ? "A restore point was made before anything was written."
        : d.snapshots.length + " restore points were made before writing.";
      wrap.append(s);
    }
    if (d.outcome) wrap.append(outcomeLine(d));
    return wrap;
  }

  function outcomeLine(d) {
    const el = document.createElement("p");
    el.className = "cru-outcome";
    el.dataset.outcome = d.outcome;
    el.textContent = d.interrupted ? "This build was interrupted when the server restarted. Its work up to that point is on disk."
      : d.outcome === "done" ? "Finished."
      : d.outcome === "stopped" ? "Stopped by you."
      : "Stopped before it finished.";
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
    const filesBox = section("Files touched");
    const files = [...d.files.values()];
    if (!files.length) filesBox.append(note("Nothing written yet."));
    else filesBox.append(tree(files));
    wrap.append(filesBox);

    // Diffs, when the engine has produced them.
    const withDiff = files.filter((f) => f.diff);
    const diffBox = section("Changes");
    if (!withDiff.length) diffBox.append(note("No diffs recorded for this build."));
    else for (const f of withDiff) diffBox.append(diffView(f));
    wrap.append(diffBox);

    // The console: exactly what ran and what it said.
    const runBox = section("Checks");
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
    badge.textContent = r.skipped ? "" : r.ok ? "passed" : "failed";
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

  window.dominionLenses = { mount, sync, follow, setLens, digest, get state() { return state; } };
})();
