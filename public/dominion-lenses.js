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
    openMoves: new Set(),   // which plan rows the user expanded (survives re-renders)
    codeOpen: false,        // non-engineers opt INTO the code view; engineers get it standing open
    showFullPlan: false,    // after a finished build folds itself, this reopens the steps
    doneAnnounced: "",      // job id whose completion event already fired
    previewOn: false,       // the live try-it frame is open
    terminalWitnessedLive: new Set(), // job ids whose terminal event arrived live on this page
    logOpen: false,         // past-builds log panel visible
    verifyAnnounced: "",    // job whose first recorded check advanced the shared journey
    endedAnnounced: "",     // failed/stopped job whose retryable ending was announced
    autoWorkshop: "",       // job whose completion already flipped the view to the Workshop (once)
    droppedJob: "",         // job whose stream dropped mid-build: re-attach from the cursor, not zero
  };

  // The Crucible's working mode drives how much machinery each lens shows.
  const modeOf = () => {
    const root = document.getElementById("ide-root");
    return (root && root.dataset.mode) || "beginner";
  };

  const readLens = () => { try { return localStorage.getItem(LENS_KEY) || "blueprint"; } catch { return "blueprint"; } };
  const writeLens = (v) => { try { localStorage.setItem(LENS_KEY, v); } catch {} };

  /* ---------- reducing the journal to something renderable ---------------------------------
   * One pass over the events. Later events for the same move supersede earlier ones, which is
   * what makes replay and live-tail produce identical output.
   */
  function digest(events) {
    const d = { title: "", moves: new Map(), files: new Map(), runs: [], costUsd: 0, costCredits: 0,
                snapshots: [], question: null, outcome: "", interrupted: false, started: 0, ended: 0,
                workspaceId: "" };
    for (const ev of events) {
      switch (ev.type) {
        case "job": d.started = ev.at || 0; d.workspaceId = ev.workspaceId || ""; break;
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
        case "done": case "checkpoint": case "error": case "stopped":
          d.outcome = ev.type; d.ended = ev.at || 0;
          if (ev.code === "interrupted") d.interrupted = true;
          break;
      }
    }
    return d;
  }

  /*
   * Task/sub-agent lineage. A divided task's agents emit moves with ids like tg-4-1 (and file
   * batches like tg-4-chunk-2); their parent row is tg-4. Before this, an unknown child id was
   * appended at the BOTTOM of the Blueprint while the parent row sat QUEUED forever - which is
   * how a build working on tasks 1 and 2 looked like it had "started the last tasks first".
   */
  const moveParentOf = (id) => {
    const match = /^tg-(\d+)-/.exec(String(id || ""));
    return match ? "tg-" + match[1] : "";
  };
  function moveChildren(d, moves) {
    const children = new Map();
    for (const m of moves) {
      const pid = moveParentOf(m.id);
      if (pid && d.moves.has(pid)) {
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid).push(m);
      }
    }
    return children;
  }
  // Progress counts LEAVES only: a divided task's parent row and its sub-rows must not both
  // swell the denominator (16 rows for 12 tasks made the bar under-report).
  function moveLeaves(d) {
    const moves = [...d.moves.values()];
    const parents = new Set();
    for (const m of moves) {
      const pid = moveParentOf(m.id);
      if (pid && d.moves.has(pid)) parents.add(pid);
    }
    return moves.filter((m) => !parents.has(m.id));
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

    const logBtn = document.createElement("button");
    logBtn.type = "button";
    logBtn.className = "cru-log-btn";
    logBtn.textContent = L("log_title");
    logBtn.addEventListener("click", () => {
      state.logOpen = !state.logOpen;
      render();
    });
    head.append(logBtn);

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
  /*
   * RESUME, DO NOT REPLAY (2026-08-05). Production logs showed 28 dropped /ide/job/attach streams
   * in a four-hour window — Cloudflare cancelling the tunnel, not the server ending the response.
   * Every one of them re-attached with from=0 into an emptied event list, so a long build replayed
   * its ENTIRE journal on each blip, and the longer the build ran the more each drop cost. That is
   * the "Dominion is slow and unstable" the user feels: the build view resetting and re-reading
   * itself from the beginning under them.
   *
   * The server already indexes events and already honours ?from= (idejobs.attach slices from it).
   * Only the client was throwing its place away. state.events.length IS the cursor: every event
   * the server sends is pushed exactly once, so its length is the count already received.
   */
  function follow(jobId, opts) {
    const resume = !!(opts && opts.resume) && jobId === state.jobId && state.events.length > 0;
    if (!jobId || (jobId === state.jobId && !resume)) return;
    // A follow of a job we already know is finished (opened from the log) is a REPLAY: its journal
    // carried its terminal event before we attached, so it can never earn a live publish
    // invitation. sync() and a fresh build attach live jobs and leave this false.
    const replay = !!(opts && opts.replay);
    if (state.detach) { try { state.detach(); } catch {} state.detach = null; }
    if (!resume) {
      state.jobId = jobId;
      state.events = [];
      state.openMoves = new Set();
      state.showFullPlan = false;
      state.previewOn = false;
      state.verifyAnnounced = "";
      state.endedAnnounced = "";
      state.autoWorkshop = "";
      state.terminalWitnessedLive.clear();
      render();
    }
    state.droppedJob = "";
    const from = resume ? state.events.length : 0;
    const es = new EventSource("/ide/job/attach?job=" + encodeURIComponent(jobId) + "&from=" + from);
    let closed = false, ended = false;
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "gone") { es.close(); return; }
      const terminal = ev.type === "done" || ev.type === "checkpoint"
        || ev.type === "error" || ev.type === "stopped";
      if (terminal) {
        ended = true;
        // Witnessing a build finish live on this page is the ONLY thing that earns a publish
        // invitation. A replayed terminal is marked seen at once so the modal can never surface.
        if (replay) { try { localStorage.setItem("dominion.publish.seen." + jobId, "1"); } catch {} }
        else state.terminalWitnessedLive.add(jobId);
      }
      state.events.push(ev);
      render();
      // Terminal means this journal is settled for this run. Close explicitly instead of waiting
      // for EventSource to interpret the server's normal EOF as a reconnectable network error.
      // A checkpoint is terminal but deliberately not successful; its event remains in `events`
      // for an honest replay and the lifecycle dispatch below reports it as unfinished.
      if (terminal) {
        closed = true;
        es.close();
        // The work really ended, so kill the scanner NOW rather than leaving it sweeping until the
        // next 20-second reconciliation. The request channel is untouched: a fetch still in flight
        // keeps its own light (Fred, 2026-07-30).
        if (window.ideFlame) window.ideFlame.track(false);
      }
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
      /*
       * A real drop on a live job. The old line cleared state.jobId so follow() would agree to
       * re-attach, which also threw away every event received so far and forced a full replay.
       * Instead: remember which job dropped and KEEP the events. sync() re-attaches with resume,
       * follow() computes from=state.events.length, and the server sends only what we missed.
       */
      state.droppedJob = state.jobId;
      setTimeout(() => { if (document.body.classList.contains("ide-open")) sync(); }, 2000);
    };
    state.detach = () => { closed = true; es.close(); };
  }

  // Pick what to show: whatever is running. If all builds are done, show fresh empty state.
  async function sync() {
    try {
      window.ideFlame && window.ideFlame.show();
      const r = await fetch("/ide/jobs", { headers: { accept: "application/json" } });
      window.ideFlame && window.ideFlame.hide();
      if (!r.ok) return;
      const jobs = (await r.json()).jobs || [];
      const live = jobs.find((j) => !j.done);
      // Resume only the job that actually dropped; anything else is a fresh follow from zero.
      if (live) follow(live.id, { resume: state.droppedJob === live.id });
      else { state.jobId = ""; state.droppedJob = ""; state.events = []; render(); }
    } catch {
      window.ideFlame && window.ideFlame.hide();
    }
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
    announceProgress(d);
    paintCost(d);
    paintStop(d);
    if (state.jobId && d.runs.length && !d.outcome && state.verifyAnnounced !== state.jobId) {
      state.verifyAnnounced = state.jobId;
      try { document.dispatchEvent(new CustomEvent("dominion-build-verifying", { detail: { jobId: state.jobId } })); } catch {}
    }

    if (!state.jobId) { body.replaceChildren(emptyState(state.lens)); paintLog(); return; }
    body.replaceChildren(state.lens === "blueprint" ? blueprint(d) : workshop(d));
    // The completion moment, announced exactly once per job and ONLY when witnessed live: the tour
    // ends on it, and the closing flow (windows fold, the invitation leads) keys off the same fact.
    // A replayed done never announces, so reopening an old build stays silent.
    if (d.outcome === "done" && state.terminalWitnessedLive.has(state.jobId) && state.doneAnnounced !== state.jobId) {
      state.doneAnnounced = state.jobId;
      try { document.dispatchEvent(new CustomEvent("dominion-build-done", { detail: { jobId: state.jobId } })); } catch {}
    }
    // Land the reader on the Workshop when their build finishes: the Blueprint is the plan (the
    // "during"), the Workshop is the app itself (the "here it is"). Once per job, and only for a
    // build watched live, so a manual switch back to the Blueprint is respected (Fred, 2026-07-24:
    // the Workshop felt dead because nobody was ever taken to it). setLens re-renders, so return.
    if (d.outcome === "done" && state.terminalWitnessedLive.has(state.jobId) && state.autoWorkshop !== state.jobId) {
      state.autoWorkshop = state.jobId;
      if (state.lens !== "workshop") { setLens("workshop"); return; }
    }
    if ((d.outcome === "checkpoint" || d.outcome === "error" || d.outcome === "stopped")
      && state.terminalWitnessedLive.has(state.jobId) && state.endedAnnounced !== state.jobId) {
      state.endedAnnounced = state.jobId;
      try {
        if (d.outcome === "checkpoint") {
          document.dispatchEvent(new CustomEvent("dominion-build-checkpointed", {
            detail: { jobId: state.jobId, outcome: "checkpoint", complete: false },
          }));
        }
        document.dispatchEvent(new CustomEvent("dominion-build-ended", {
          detail: { jobId: state.jobId, outcome: d.outcome, complete: false },
        }));
      } catch {}
    }
    maybeOfferPublish(d);
    paintLog();
  }

  /* ---------- the progress signal ------------------------------------------------------------
   * The beginner build screen (dominion-beginner.js) shows a percentage and a time remaining while
   * a person plays Pong. Both come from HERE, from the same journal everything else renders, so the
   * cute robot and the Blueprint can never disagree about how far along the build is.
   *
   * WHAT THE NUMBERS MEAN, exactly, because a made-up number is worse than none (the image forge
   * taught us that):
   *   percent = finished moves / planned moves. Before a plan exists it is 0 and the screen says
   *             "getting started" rather than inventing a fraction.
   *   remaining = average REAL seconds per finished move, times the moves left. With nothing
   *             finished yet there is no average, so no time is shown at all.
   * Both are explicitly labelled as estimates in the UI.
   */
  let lastProgress = "";
  function announceProgress(d) {
    const moves = moveLeaves(d);
    const total = moves.length;
    const done = moves.filter((m) => m.state === "done").length;
    const percent = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
    const elapsedMs = d.started ? (d.ended || Date.now()) - d.started : 0;
    // Only a finished move proves how long a move takes on this build, with this model, today.
    const perMove = done > 0 && elapsedMs > 0 ? elapsedMs / done : 0;
    const remainingMs = perMove && total > done ? Math.round(perMove * (total - done)) : 0;
    const detail = { jobId: state.jobId, percent, done, total, remainingMs,
                     outcome: d.outcome || "", title: d.title || "" };
    // Dispatch only on a real change: renderNow runs on every event, and a listener redrawing a
    // canvas for an unchanged number is work nobody sees.
    const sig = [detail.jobId, percent, done, total, Math.round(remainingMs / 5000), detail.outcome].join("|");
    if (sig === lastProgress) return;
    lastProgress = sig;
    try { document.dispatchEvent(new CustomEvent("dominion-build-progress", { detail })); } catch {}
  }

  /*
   * The publish invitation (Fred's ruling 2026-07-21): when a build finishes, the user sees
   * "Put this online so everyone can use it" in their own register. Behind it sits an HONEST
   * explanation of what that involves; the guided deploy itself ships later, and this card says
   * so plainly rather than promising a button that does not exist yet. Shown once per build,
   * only when witnessed live on this page lifetime.
   */
  function maybeOfferPublish(d) {
    if (d.outcome !== "done" || !state.jobId) return;
    if (!state.terminalWitnessedLive.has(state.jobId)) return;
    let seen = null;
    try { seen = localStorage.getItem("dominion.publish.seen." + state.jobId); } catch {}
    if (seen) return;
    if ($("#cru-publish")) return;
    const isBuild = state.events.some((e) => e.type === "job" && e.kind === "build");
    if (!isBuild) return;

    const backdrop = document.createElement("div");
    backdrop.id = "cru-publish";
    backdrop.className = "cru-publish-backdrop";
    // Only a click on the backing itself dismisses; clicks that land on the modal or its buttons
    // pass through so opening the explanation does not also close the card.
    backdrop.addEventListener("click", (e) => {
      if (e.target !== backdrop) return;
      try { localStorage.setItem("dominion.publish.seen." + state.jobId, "1"); } catch {}
      backdrop.remove();
    });

    const modal = document.createElement("div");
    modal.className = "cru-publish-modal";
    const done = document.createElement("p"); done.className = "pub-done"; done.textContent = L("publish_done_line");
    const cta = document.createElement("h3"); cta.textContent = L("publish_cta");
    const row = document.createElement("div"); row.className = "pub-row";
    const show = document.createElement("button"); show.type = "button"; show.textContent = L("publish_show");
    const later = document.createElement("button"); later.type = "button"; later.className = "pub-later"; later.textContent = L("publish_later");
    row.append(show, later);
    const body2 = document.createElement("p"); body2.className = "pub-explain"; body2.hidden = true; body2.textContent = L("publish_explain");
    modal.append(done, cta, row, body2);

    show.addEventListener("click", () => { body2.hidden = !body2.hidden; });
    later.addEventListener("click", () => {
      try { localStorage.setItem("dominion.publish.seen." + state.jobId, "1"); } catch {}
      backdrop.remove();
    });
    backdrop.append(modal);
    // Mounted INSIDE #ide-root, the same lesson the tour veil taught: the panel is a fixed
    // z-index:70 stacking context, so a body-level backdrop paints over the whole panel and
    // its own z-index games mean nothing to the elements underneath. In-context, backdrop
    // (345) sits above the tour layers (330-340) and leaves the rest of the app alone.
    (document.getElementById("ide-root") || document.body).append(backdrop);
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
          window.ideFlame && window.ideFlame.show();
          await fetch("/ide/job/stop", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId: state.jobId }) });
          window.ideFlame && window.ideFlame.hide();
        } catch {
          window.ideFlame && window.ideFlame.hide();
        }
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
    // Credits when the server counted them; otherwise DominionMoney decides by viewer, so a guest
    // never falls through to a dollar figure just because this payload omitted the credit count.
    el.textContent = d.costCredits
      ? Number(d.costCredits).toLocaleString() + " credits"
      : (window.DominionMoney ? window.DominionMoney.cost(d.costUsd) : "$" + d.costUsd.toFixed(4));
  }

  async function paintLog() {
    let panel = $("#cru-log");
    if (!state.logOpen) {
      if (panel) panel.remove();
      return;
    }
    if (panel) return;

    panel = document.createElement("aside");
    panel.id = "cru-log";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "cru-log-close";
    closeBtn.textContent = "x";
    closeBtn.addEventListener("click", () => { state.logOpen = false; render(); });
    panel.append(closeBtn);

    const loading = document.createElement("p");
    loading.className = "cru-log-loading";
    loading.textContent = L("browse_loading");
    panel.append(loading);

    const stage = $("#ide-stage");
    if (stage) stage.append(panel);

    try {
      window.ideFlame && window.ideFlame.show();
      const r = await fetch("/ide/jobs", { headers: { accept: "application/json" } });
      window.ideFlame && window.ideFlame.hide();
      if (!r.ok) { loading.textContent = L("log_empty"); return; }
      const jobs = (await r.json()).jobs || [];
      loading.remove();

      if (!jobs.length) {
        const empty = document.createElement("p");
        empty.className = "cru-log-empty";
        empty.textContent = L("log_empty");
        panel.append(empty);
        return;
      }

      const list = document.createElement("div");
      list.className = "cru-log-list";
      for (const job of jobs) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cru-log-entry";
        // The richest name the registry hands us: the last move's title, then the job kind.
        const title = (job.move && job.move.title) || job.kind || "";
        const dateStr = job.startedAt ? new Date(job.startedAt).toLocaleDateString() : "";
        // A finished job reads through the outcome register; one still running has no outcome yet.
        const outcomeWord = job.done ? outcomeText(job.outcome || "done") : L("st_running");
        const t = document.createElement("span"); t.className = "log-title"; t.textContent = title || job.kind || "";
        const meta = document.createElement("span"); meta.className = "log-meta";
        meta.textContent = (dateStr ? dateStr + " " : "") + outcomeWord;
        row.append(t, meta);
        row.addEventListener("click", () => {
          try { localStorage.setItem("dominion.publish.seen." + job.id, "1"); } catch {}
          state.logOpen = false;
          follow(job.id, { replay: !!job.done });
          render();
        });
        list.append(row);
      }
      panel.append(list);
    } catch {
      window.ideFlame && window.ideFlame.hide();
      loading.textContent = L("log_empty");
    }
  }

  function emptyState(lens) {
    const el = document.createElement("div");
    el.className = "cru-empty";
    // Each tab explains ITS OWN purpose when there is no build, so switching tabs always shows a
    // difference (Fred's phone, 2026-07-24: both tabs showed an identical "No builds yet").
    const key = lens === "workshop" ? ["no_app_title", "no_app_body"]
              : lens === "blueprint" ? ["no_plan_title", "no_plan_body"]
              : ["no_builds_title", "no_builds_body"];
    const h = document.createElement("h3"); h.textContent = L(key[0]);
    const pp = document.createElement("p"); pp.textContent = L(key[1]);
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

    /*
     * ONE container of compact rows, never a stack of fifteen identical boxes (Fred's ruling
     * 2026-07-21 night: repeating every action in its own container is literally a waste of a
     * beginner's time). A row is a line: number, title, state. Tapping it opens the detail
     * (why, message, files, model) for exactly that row. Engineers get the detail chips inline
     * because density is the point for them.
     */
    const mode = modeOf();
    const foldDone = d.outcome === "done" && mode !== "engineer" && !state.showFullPlan;

    if (foldDone && moves.length) {
      // The build is finished and this reader is here for the result: the steps fold into one
      // honest sentence, reopenable, and the invitation card above leads.
      const leafCount = moveLeaves(d).length;
      const filesTotal = d.files.size;
      const sum = document.createElement("button");
      sum.type = "button";
      sum.className = "cru-plansum";
      sum.textContent = leafCount + (leafCount === 1 ? " step" : " steps") + ", "
        + filesTotal + (filesTotal === 1 ? " file" : " files") + " " + stateWord("done").toLowerCase();
      sum.addEventListener("click", () => { state.showFullPlan = true; render(); });
      wrap.append(sum);
    } else if (moves.length) {
      const plan = document.createElement("div");
      plan.className = "cru-plan";
      /*
       * Sub-agent rows nest UNDER their task's row instead of piling up at the bottom of the
       * list, and a parent whose children are working can never sit on "Queued" (the lie that
       * read as "it started the last tasks first"). Server-emitted parent states win; the
       * derivation only covers journals from before the parent rows spoke for themselves.
       */
      const childrenBy = moveChildren(d, moves);
      const topLevel = moves.filter((m) => { const pid = moveParentOf(m.id); return !(pid && d.moves.has(pid)); });
      const shownState = (m) => {
        const kids = childrenBy.get(m.id);
        if (!kids || !kids.length || (m.state && m.state !== "planned")) return m.state;
        return kids.every((k) => k.state === "done") ? "done"
          : kids.some((k) => k.state === "failed") ? "failed"
          : "running";
      };
      const buildRow = (m, numText, depth) => {
        const row = document.createElement("div");
        row.className = "cru-row" + (depth ? " cru-sub" : "");
        row.dataset.state = shownState(m);
        const open = state.openMoves.has(m.id) || mode === "engineer";

        const line = document.createElement("button");
        line.type = "button";
        line.className = "r-line";
        const num = document.createElement("span"); num.className = "c-num"; num.textContent = numText;
        const title = document.createElement("span"); title.className = "c-title"; title.textContent = m.title || "Move " + numText;
        const badge = document.createElement("span"); badge.className = "c-state"; badge.textContent = stateWord(shownState(m));
        line.append(num, title, badge);
        row.append(line);

        if (open) {
          const det = document.createElement("div");
          det.className = "r-detail";
          if (m.why) { const why = document.createElement("p"); why.className = "c-why"; why.textContent = m.why; det.append(why); }
          if (m.message) { const msg = document.createElement("p"); msg.className = "c-msg"; msg.textContent = m.message; det.append(msg); }
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
          // The model is named, and the router's reason with it, because a build you cannot
          // audit is a build you cannot trust.
          if (m.model && m.model !== "dominion-forge") {
            const chip = document.createElement("span"); chip.className = "c-model"; chip.textContent = friendly(m.model);
            if (m.reason) chip.title = m.reason;
            foot.append(chip);
          } else if (m.model === "dominion-forge") {
            const chip = document.createElement("span"); chip.className = "c-model is-forge"; chip.textContent = "Dominion Forge";
            foot.append(chip);
          }
          if (foot.children.length) det.append(foot);
          if (det.children.length) row.append(det);
        }

        if (mode !== "engineer") {
          line.addEventListener("click", () => {
            if (state.openMoves.has(m.id)) state.openMoves.delete(m.id); else state.openMoves.add(m.id);
            render();
          });
        }
        return row;
      };
      topLevel.forEach((m, i) => {
        plan.append(buildRow(m, String(i + 1), 0));
        for (const kid of childrenBy.get(m.id) || []) plan.append(buildRow(kid, "·", 1));
      });
      wrap.append(plan);
    }

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
      : outcomeText(d.outcome);
    return el;
  }

  function outcomeText(outcome) {
    const value = String(outcome || "error").toLowerCase();
    if (value === "checkpoint") return "Checkpoint saved. This build is not complete and is ready to continue.";
    const key = value === "done" ? "outcome_done"
      : value === "stopped" ? "outcome_stopped"
      : "outcome_error";
    return L(key);
  }

  // Never print a raw provider id at a person. The catalog name is the display name.
  function friendly(id) {
    const s = String(id || "");
    const tail = s.includes("/") ? s.split("/").pop() : s;
    return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /* ---------- WORKSHOP: where the thing exists --------------------------------------------------
   * Code reveal is AUTOMATIC for engineers and a toggle for everyone else (Fred's ruling): a
   * beginner opens the Workshop to see their app, never to read a diff, so the machinery waits
   * behind one honest button.
   */
  function workshop(d) {
    const wrap = document.createElement("div");
    wrap.className = "cru-workshop";
    wrap.dataset.mode = modeOf();

    // Honest empty state (Fred, 2026-07-24: the Workshop read as a dead tab when a build had not
    // produced anything yet). Say what this tab IS, so it looks intentional rather than broken.
    if (!d.runs.length && !d.files.size && d.outcome !== "done") {
      const intro = document.createElement("p");
      intro.className = "cru-note w-intro";
      intro.textContent = "This is where your finished app lives. As the build runs, you will try your app "
        + "here, see the checks it passed, and view the code. Nothing to show yet.";
      wrap.append(intro);
    }

    const mode = modeOf();
    const studioCode = mode === "vibe" && window.dominionStudioHas && window.dominionStudioHas("code");
    const codeVisible = mode === "engineer" || studioCode || state.codeOpen;
    const files = [...d.files.values()];

    /*
     * The live preview (ruling 3a): the built app, running on the build machine, tapped through
     * from here via the /ide/preview relay. For a beginner this IS the Workshop; engineers get
     * it beside the code.
     */
    wrap.append(previewSection(d));

    // The console: exactly what ran and what it said. Proof belongs to everyone.
    const runBox = section(L("checks"), "checks");
    if (!d.runs.length) runBox.append(note("Nothing has been run yet."));
    else for (const r of d.runs) runBox.append(runView(r));
    wrap.append(runBox);

    if (!codeVisible) {
      const show = document.createElement("button");
      show.type = "button";
      show.className = "w-code-toggle";
      show.textContent = L("code_show");
      show.addEventListener("click", () => { state.codeOpen = true; render(); });
      wrap.append(show);
      return wrap;
    }

    // Files, as a tree of what this build actually touched.
    const filesBox = section(L("files_touched"), "files");
    if (!files.length) filesBox.append(note("Nothing written yet."));
    else filesBox.append(tree(files));
    wrap.append(filesBox);

    // Diffs, when the engine has produced them.
    const withDiff = files.filter((f) => f.diff);
    const diffBox = section(L("changes"), "changes");
    if (!withDiff.length) diffBox.append(note("No diffs recorded for this build."));
    else for (const f of withDiff) diffBox.append(diffView(f));
    wrap.append(diffBox);

    if (mode !== "engineer") {
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "w-code-toggle";
      hide.textContent = L("code_hide");
      hide.addEventListener("click", () => { state.codeOpen = false; render(); });
      wrap.append(hide);
    }

    return wrap;
  }

  /*
   * The try-it loop: start the app on the build machine, load it in an iframe through the
   * relay, tap around, close it. State survives re-renders; a new job resets it.
   */
  function previewSection(d) {
    const box = document.createElement("div");
    box.className = "w-section w-preview";
    const h = document.createElement("h4");
    h.textContent = L("preview_title");
    box.append(h);

    if (!state.previewOn) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "w-preview-open";
      open.textContent = L("preview_open");
      open.disabled = !d.workspaceId;
      open.addEventListener("click", async () => {
        open.disabled = true;
        open.textContent = L("preview_wait");
        try {
          window.ideFlame && window.ideFlame.show();
          const r = await fetch("/ide/preview/start", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: d.workspaceId }) });
          window.ideFlame && window.ideFlame.hide();
          const j = await r.json();
          if (!r.ok || j.error) { open.textContent = (j && j.error) || L("preview_fail"); open.disabled = false; return; }
          state.previewOn = true;
          render();
        } catch { window.ideFlame && window.ideFlame.hide(); open.textContent = L("preview_fail"); open.disabled = false; }
      });
      box.append(open);
      return box;
    }

    const frame = document.createElement("iframe");
    frame.className = "w-preview-frame";
    frame.src = "/ide/preview/p/?t=" + encodeURIComponent(state.jobId || "");
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
    frame.title = L("preview_title");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "w-preview-close";
    close.textContent = L("preview_close");
    close.addEventListener("click", async () => {
      state.previewOn = false;
      try {
        window.ideFlame && window.ideFlame.show();
        await fetch("/ide/preview/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        window.ideFlame && window.ideFlame.hide();
      } catch {
        window.ideFlame && window.ideFlame.hide();
      }
      render();
    });
    box.append(frame, close);
    return box;
  }

  function section(title, module) {
    const s = document.createElement("div");
    s.className = "w-section" + (module ? " w-" + module : "");
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
  document.addEventListener("dominion-studio-changed", () => render());

  window.dominionLenses = { mount, sync, follow, setLens, digest, get state() { return state; } };
})();
