/* SD Tech Mobile Game Factory — owner-only, server-authoritative portfolio control surface. */
(() => {
  "use strict";

  const API = "/api/game-factory";
  const HOLD_STATES = new Set(["PAUSED", "BLOCKED", "FAILED"]);
  const EVENT_TYPES = [
    "project.created", "project.transitioned", "project.pause_requested", "project.paused",
    "project.resumed", "project.stop_requested", "project.stopped", "project.retried",
    "project.blocked", "project.revision_requested", "project.evidence_invalidated", "project.workspace_attached", "checkpoint.created", "approval.recorded",
    "build.created", "task.queued", "task.claimed", "task.completed", "task.paused",
    "task.requeued", "task.failed", "task.lease_expired", "artifact.version_created",
    "artifact.copy_updated", "test.recorded", "release.recorded",
  ];
  const TABS = [
    ["overview", "Overview"], ["work", "Work queue"], ["artifacts", "Artifacts"],
    ["quality", "Quality & release"], ["activity", "Activity"],
  ];

  let root = null;
  let bootstrap = null;
  let config = null;
  let detail = null;
  let selectedId = "";
  let currentTab = "overview";
  let filter = "";
  let busy = false;
  let accessError = null;
  let loadToken = 0;
  let openEpoch = 0;
  let eventSource = null;
  let streamProject = "";
  let lastEventId = 0;
  let refreshTimer = null;
  let pollTimer = null;
  let returnFocus = null;
  let previewDialog = null;
  let previewStarted = false;
  let previewQueue = Promise.resolve();
  let decisionDialog = null;
  let artifactDialog = null;
  let backgroundState = [];
  let backgroundObserver = null;
  let pushedRoute = false;
  let returnRoute = "/";

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const human = (value) => String(value || "Unknown").toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);
  const shortDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const identifier = () => globalThis.crypto?.randomUUID?.() || `gf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const $ = (selector, scope = root) => scope?.querySelector(selector) || null;
  const $$ = (selector, scope = root) => [...(scope?.querySelectorAll(selector) || [])];

  async function request(path, options = {}) {
    const headers = { accept: "application/json", ...(options.headers || {}) };
    const method = String(options.method || "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-Dominion-Action"] = "game-factory";
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await fetch(API + path, { credentials: "include", cache: "no-store", ...options, headers });
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json().catch(() => ({})) : {};
    if (!response.ok) {
      const error = new Error(data.error?.message || data.error || data.message || `Game Factory returned ${response.status}.`);
      error.code = data.error?.code || data.code || "factory_request_failed";
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function readable(error) {
    const message = error?.message || "The Game Factory could not complete that request.";
    return error?.code ? `${error.code}: ${message}` : message;
  }

  function setStatus(message = "", tone = "") {
    const node = $("[data-factory-status]");
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone;
  }

  function setLive(state, label) {
    const node = $("[data-factory-live]");
    if (!node) return;
    node.dataset.state = state;
    const text = node.querySelector("span");
    if (text) text.textContent = label;
  }

  function markNavigation(opened) {
    document.querySelectorAll('[data-account-capability="gameFactory"]').forEach((button) => {
      if (opened) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function addStylesheet() {
    if (document.getElementById("dominion-game-factory-style")) return;
    const link = document.createElement("link");
    link.id = "dominion-game-factory-style";
    link.rel = "stylesheet";
    link.href = "/dominion-game-factory.css?v=1";
    document.head.append(link);
  }

  function isolateBackground() {
    const isolate = (node) => {
      if (!(node instanceof HTMLElement) || node === root || node.parentElement !== document.body || backgroundState.some((item) => item.node === node)) return;
      const item = { node, inert: !!node.inert, aria: node.getAttribute("aria-hidden") };
      backgroundState.push(item);
      item.node.inert = true;
      item.node.setAttribute("aria-hidden", "true");
    };
    [...document.body.children].forEach(isolate);
    backgroundObserver = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) isolate(node);
    });
    backgroundObserver.observe(document.body, { childList: true });
  }

  function restoreBackground() {
    backgroundObserver?.disconnect();
    backgroundObserver = null;
    for (const item of backgroundState) {
      if (!item.node.isConnected) continue;
      item.node.inert = item.inert;
      if (item.aria == null) item.node.removeAttribute("aria-hidden");
      else item.node.setAttribute("aria-hidden", item.aria);
    }
    backgroundState = [];
  }

  function trapFocus(event) {
    if (event.key !== "Tab" || !root) return;
    const focusable = $$("button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])").filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function moveTabFocus(event) {
    const tab = event.target.closest?.("[role='tab']");
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return false;
    const tabs = $$('[role="tab"]');
    if (!tabs.length) return false;
    let index = tabs.indexOf(tab);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else index = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[index].focus();
    tabs[index].click();
    return true;
  }

  function shellMarkup() {
    return `<a class="dgf-skip" href="#dgf-main">Skip to selected game</a>
      <div class="dgf-shell">
        <header class="dgf-topbar">
          <span class="dgf-mark" aria-hidden="true">◆</span>
          <div class="dgf-heading"><span class="dgf-kicker">SD Tech · Owner Operations</span><h1 id="dgf-title">Mobile Game Factory</h1><p>Ten-game portfolio, durable work, evidence-gated release.</p></div>
          <div class="dgf-top-actions">
            <span class="dgf-live" data-factory-live data-state="retry"><i></i><span>Connecting</span></span>
            <button class="dgf-icon-button" type="button" data-factory-refresh aria-label="Refresh factory">↻</button>
            <button class="dgf-icon-button" type="button" data-factory-close aria-label="Close Game Factory">×</button>
          </div>
        </header>
        <div class="dgf-status" data-factory-status role="status" aria-live="polite">Loading the durable portfolio…</div>
        <section class="dgf-summary" data-factory-summary aria-label="Portfolio summary">${loadingStats()}</section>
        <div class="dgf-grid">
          <aside class="dgf-panel dgf-portfolio" aria-labelledby="dgf-portfolio-title">
            <header class="dgf-panel-head"><h2 id="dgf-portfolio-title">Portfolio</h2><p>Authoritative state for every planned release.</p><input class="dgf-search" data-factory-search type="search" aria-label="Filter games" placeholder="Filter games or stages" autocomplete="off"></header>
            <div class="dgf-game-list" data-factory-list aria-live="polite"><div class="dgf-empty dgf-loading">Loading games…</div></div>
          </aside>
          <main class="dgf-panel dgf-detail" id="dgf-main" tabindex="-1" data-factory-detail><div class="dgf-detail-empty dgf-loading"><p>Reading the selected game checkpoint…</p></div></main>
        </div>
      </div>`;
  }

  function loadingStats() {
    return ["Games", "Active", "Approvals", "Blocked", "Running"].map((label) => `<article class="dgf-stat dgf-loading"><small>${label}</small><b>—</b></article>`).join("");
  }

  function mount() {
    addStylesheet();
    root = document.createElement("section");
    root.id = "dgf-root";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "dgf-title");
    root.tabIndex = -1;
    root.innerHTML = shellMarkup();
    document.body.append(root);
    document.body.classList.add("dgf-open");
    markNavigation(true);
    isolateBackground();
    root.addEventListener("click", handleClick);
    root.addEventListener("input", handleInput);
    root.addEventListener("keydown", (event) => {
      if (event.target.closest?.("dialog")) return;
      if (moveTabFocus(event)) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else trapFocus(event);
    });
    root.focus();
  }

  function summaryMarkup() {
    const source = bootstrap?.summary || {};
    const values = [
      ["Games", source.total ?? bootstrap?.games?.length ?? 0, ""],
      ["Active", source.active ?? 0, ""],
      ["Approvals", source.approvals ?? 0, "attention"],
      ["Blocked", source.blocked ?? 0, "blocked"],
      ["Running", source.runningTasks ?? 0, ""],
    ];
    return values.map(([label, value, tone]) => `<article class="dgf-stat"${tone ? ` data-tone="${tone}"` : ""}><small>${esc(label)}</small><b>${Number(value) || 0}</b></article>`).join("");
  }

  function renderSummary() {
    const node = $("[data-factory-summary]");
    if (node) node.innerHTML = summaryMarkup();
  }

  function cardAlertCount(game) {
    return Number(!!game.approvalNeeded) + Number(!!game.approvalBlocked) + Number(game.artifacts?.missing || 0) + Number(game.tests?.failed || 0) + Number(HOLD_STATES.has(game.state));
  }

  function renderList() {
    const node = $("[data-factory-list]");
    if (!node) return;
    const query = filter.trim().toLowerCase();
    const games = (bootstrap?.games || []).filter((game) => !query || `${game.name} ${game.slug} ${game.state} ${game.operation}`.toLowerCase().includes(query));
    node.innerHTML = games.length ? games.map((game) => {
      const alerts = cardAlertCount(game);
      return `<button class="dgf-game" type="button" data-game-id="${esc(game.id)}" aria-current="${game.id === selectedId}">
        <span class="dgf-game-number">${String(Number(game.order) || 0).padStart(2, "0")}</span>
        <span class="dgf-game-copy"><b>${esc(game.name)}</b><small>${esc(human(game.operation || game.state))}</small><span class="dgf-mini-progress" aria-hidden="true"><i style="width:${clamp(game.progress, 0, 100)}%"></i></span></span>
        ${alerts ? `<span class="dgf-count" aria-label="${alerts} item${alerts === 1 ? "" : "s"} need attention">${alerts}</span>` : ""}
      </button>`;
    }).join("") : `<div class="dgf-empty">No games match this filter.</div>`;
  }

  function stateTone(game) {
    if (game.state === "DEPLOYED") return "done";
    if (HOLD_STATES.has(game.state) || game.operation?.endsWith("REQUESTED")) return "hold";
    return "";
  }

  function actionMarkup(game) {
    const actions = Array.isArray(game.allowedActions) ? game.allowedActions : [];
    if (!actions.length) return `<p class="dgf-alert">No control-plane action is available at this checkpoint.</p>`;
    return `<div class="dgf-actions" aria-label="Available actions">${actions.map((action) => {
      const needsPayload = action.id === "attach_workspace" && !(action.payload || action.commandPayload);
      const label = needsPayload ? "Workspace managed by orchestrator" : action.label || human(action.id);
      return `<button class="dgf-action" type="button" data-command="${esc(action.id)}" data-kind="${esc(action.kind || "secondary")}"${busy || needsPayload ? " disabled" : ""}${needsPayload ? ' title="No browser file or path control is exposed."' : ""}>${esc(label)}</button>`;
    }).join("")}</div>`;
  }

  function operationNotice(game) {
    if (game.operation === "PAUSE_REQUESTED") return `<div class="dgf-alert">Pause requested. The active task is finishing at a safe checkpoint; the lifecycle state has not been falsified.</div>`;
    if (game.operation === "STOP_REQUESTED") return `<div class="dgf-alert" data-tone="danger">Stop requested. Dominion is waiting for the active writer to leave a safe boundary.</div>`;
    if (game.blocker) return `<div class="dgf-alert" data-tone="danger"><b>Blocked:</b> ${esc(game.blocker)}</div>`;
    if (game.approvalBlocked) return `<div class="dgf-alert" data-tone="danger"><b>Evidence gate:</b> ${esc(game.approvalBlocked)}</div>`;
    if (game.approvalNeeded) {
      const subject = game.approvalSubject?.hash ? ` Evidence ${esc(game.approvalSubject.hash.slice(0, 12))}…` : "";
      return `<div class="dgf-alert"><b>Owner gate:</b> ${esc(human(game.approvalNeeded))} approval is required for ${esc(game.approvalSubject?.label || "the current evidence")}.${subject}</div>`;
    }
    const ownerProgress = (game.allowedActions || []).some((action) => ["advance", "approve", "resume", "retry"].includes(action.id));
    if (!ownerProgress && !HOLD_STATES.has(game.state) && game.state !== "DEPLOYED") {
      return `<div class="dgf-alert"><b>No owner decision is pending.</b> The supervising factory must validate the current evidence and schedule the next stage. This checkpoint will not advance if its worker is unavailable.</div>`;
    }
    return "";
  }

  function tabsMarkup() {
    return `<div class="dgf-tabs" role="tablist" aria-label="Game record">${TABS.map(([id, label]) => `<button class="dgf-tab" type="button" role="tab" data-tab="${id}" aria-selected="${id === currentTab}" aria-controls="dgf-tab-panel" tabindex="${id === currentTab ? "0" : "-1"}">${esc(label)}</button>`).join("")}</div>`;
  }

  function healthCard(label, ready, text) {
    return `<article class="dgf-health" data-ready="${!!ready}"><span><i></i>${esc(label)}</span><b>${esc(text)}</b></article>`;
  }

  function healthMarkup() {
    const health = bootstrap?.health || {};
    const worker = health.worker || {}, mirror = health.mirror || {}, release = health.release || {};
    const workerReady = worker.configured === true && !worker.lastError
      && (worker.state === "running" || worker.available === true || worker.healthy === true);
    const mirrorReady = mirror.complete === true || mirror.healthy === true || mirror.ready === true;
    const releaseReady = release.storeUploadsEnabled === true;
    return `<div class="dgf-health-grid" aria-label="Factory capability health">
      ${healthCard("Build worker", workerReady, workerReady ? "Configured and reachable" : worker.configured ? "Unavailable or unverified" : "Not configured")}
      ${healthCard("Artifact mirrors", mirrorReady, mirrorReady ? "Verified" : mirror.configured ? "Incomplete verification" : "Not configured")}
      ${healthCard("Store release", releaseReady, releaseReady ? "Gated upload capability enabled" : release.assessmentWritesEnabled || release.writesEnabled ? "Readiness recording only" : "Readiness only")}
    </div>`;
  }

  function lifecycleMarkup(game) {
    const states = (config?.states || []).filter((state) => !HOLD_STATES.has(state) && state !== "REVISION");
    const current = (HOLD_STATES.has(game.state) || game.state === "REVISION") && game.resumeState ? game.resumeState : game.state;
    const index = states.indexOf(current);
    return `<div class="dgf-milestones" aria-label="Lifecycle states">${states.map((state, i) => {
      const marker = `<span class="dgf-milestone" data-state="${state === game.state || state === current ? "current" : i < index ? "passed" : "future"}">${esc(human(state))}</span>`;
      return marker + (game.state === "REVISION" && state === current ? `<span class="dgf-milestone" data-state="current">Revision loop</span>` : "");
    }).join("")}</div>`;
  }

  function overviewMarkup(game) {
    const task = game.tasks?.find((item) => item.status === "RUNNING") || null;
    const next = game.tasks?.find((item) => item.status === "QUEUED") || null;
    return `<div class="dgf-section-head"><div><h2>Current checkpoint</h2><p>Facts read from the durable control plane.</p></div><span class="dgf-chip">v${Number(game.version) || 0}</span></div>
      <div class="dgf-cards">
        <article class="dgf-info"><small>Active work</small><b>${esc(task?.title || "No task is writing")}</b><p>${task ? `${esc(human(task.capability))} · attempt ${Number(task.attempt) || 0}/${Number(task.maxAttempts) || 0}` : "A queued task can be claimed only when no other writer owns this game."}</p></article>
        <article class="dgf-info"><small>Next work</small><b>${esc(next?.title || "No task queued")}</b><p>${next ? esc(human(next.capability)) : "The orchestrator has not scheduled another capability."}</p></article>
        <article class="dgf-info"><small>Active build</small><b>${esc(game.activeBuild?.versionName || game.activeBuildId || "Not created")}</b><p>${game.activeBuild ? `${esc(game.activeBuild.status)} · ${Number(game.activeBuild.versionCode) || 0}` : "Release evidence is bound to an immutable build when one exists."}</p></article>
        <article class="dgf-info"><small>Required artifacts</small><b>${game.complete ? "11 of 11 complete" : `${Math.max(0, (game.required?.length || 11) - (game.missing?.length || 0))} of ${game.required?.length || 11} complete`}</b><p>Completion requires a byte-verified Drive copy for every required artifact. Native ChatGPT Project evidence is deferred, not required, and can be completed by the owner later without blocking progress.</p></article>
      </div>
      ${healthMarkup()}
      ${lifecycleMarkup(game)}`;
  }

  function taskRows(game) {
    const tasks = game.tasks || [];
    if (!tasks.length) return `<div class="dgf-empty">No durable tasks have been queued for this game.</div>`;
    return `<div class="dgf-table">${tasks.map((task) => `<article class="dgf-row"><b>${esc(task.title)}</b><small>${esc(human(task.capability))}</small><span class="dgf-chip" data-tone="${["FAILED", "CANCELLED"].includes(task.status) ? "hold" : task.status === "COMPLETED" ? "done" : ""}">${esc(human(task.status))}</span><small>${Number(task.attempt) || 0}/${Number(task.maxAttempts) || 0}</small></article>`).join("")}</div>`;
  }

  function artifactsMarkup(game) {
    const byKey = new Map((game.artifacts || []).map((artifact) => [artifact.artifactKey, artifact]));
    const keys = game.required || config?.requiredArtifacts || [];
    if (!keys.length) return `<div class="dgf-empty">The server did not publish an artifact contract.</div>`;
    return `<div class="dgf-artifact-grid">${keys.map((key) => {
      const artifact = byKey.get(key), copies = artifact?.copies || [], viewer = artifact?.viewer || {};
      const reviewControl = viewer.enabled
        ? `<button class="dgf-action dgf-artifact-open" type="button" data-artifact-key="${esc(key)}" aria-label="Open ${esc(key)} as verified plain text">Read artifact</button>`
        : `<small class="dgf-artifact-unavailable">${esc(viewer.reason || (artifact ? "Verified artifact content is unavailable on this runtime." : "Content is unavailable until a verified text artifact is recorded."))}</small>`;
      return `<article class="dgf-artifact"><header><b>${esc(key)}</b><span class="dgf-chip" data-tone="${artifact?.complete ? "done" : "hold"}">${artifact?.complete ? "Complete" : "Incomplete"}</span></header>
        <p>${artifact ? `Version ${Number(artifact.version) || 1} · ${Number(artifact.size || 0).toLocaleString()} bytes` : "No immutable version recorded."}</p>
        ${copies.length ? copies.map((copy) => {
          const hashBound = copy.algorithm === "sha256" && copy.fingerprint === artifact.sha256;
          const ownerAttested = copy.backend === "chatgpt_project" && copy.status === "OWNER_ATTESTED";
          const nativeApiVerified = copy.backend === "chatgpt_project" && copy.status === "NATIVE_API_VERIFIED";
          // chatgpt_project is a deferred backend as of 2026-09-03 (see gamefactory.mjs and
          // docs/NATIVE_CHATGPT_PROJECT_OWNER_ATTESTATION.md): a DEFERRED copy is expected, optional,
          // and never blocks completion, so its wording must read as informational, not as a failure.
          const deferred = copy.backend === "chatgpt_project" && copy.status === "DEFERRED";
          const verified = hashBound && (copy.status === "VERIFIED" || ownerAttested || nativeApiVerified);
          const status = verified
            ? (ownerAttested ? "Owner-attested browser upload" : nativeApiVerified ? "Native API verified" : "Verified")
            : deferred ? "Deferred (not required; owner may complete later)"
            : copy.status === "VERIFIED" ? "Verification insufficient" : human(copy.status);
          return `<span class="dgf-copy" data-ok="${verified}">${esc(copy.backend)} · ${esc(status)}</span>`;
        }).join("") : `<span class="dgf-copy">No verified copies</span>`}
        <div class="dgf-artifact-review">${reviewControl}</div>
      </article>`;
    }).join("")}</div>`;
  }

  function qualityMarkup(game) {
    const tests = game.tests || [], releases = game.releases || [], approvals = game.approvals || [];
    const activeBuildId = game.activeBuild?.id || "";
    const currentTests = new Map();
    for (const test of tests) {
      const sourceMatches = !game.activeBuild?.sourceCommit || test.sourceHash === game.activeBuild.sourceCommit;
      if (activeBuildId && test.buildId === activeBuildId && !currentTests.has(test.suite)) currentTests.set(test.suite, { id: test.id, sourceMatches });
    }
    const currentReleases = new Map();
    for (const release of releases) if (activeBuildId && release.buildId === activeBuildId && !currentReleases.has(release.platform)) currentReleases.set(release.platform, release.id);
    const testRows = tests.length ? tests.map((test) => {
      const latest = currentTests.get(test.suite);
      const current = latest?.id === test.id && latest.sourceMatches;
      const label = current ? human(test.status) : `${human(test.status)} · stale`;
      const tone = current && test.status === "PASSED" ? "done" : current && ["FAILED", "BLOCKED"].includes(test.status) ? "hold" : "";
      const finding = String(test.evidence?.summary || test.evidence?.message || test.evidence?.error || "").trim().slice(0, 220);
      const context = `${test.target || "All targets"}${finding ? ` · ${finding}` : ""}`;
      return `<article class="dgf-row"><b>${esc(test.suite)}</b><small>${esc(context)}</small><span class="dgf-chip" data-tone="${tone}">${esc(label)}</span><small>${esc(shortDate(test.createdAt))}</small></article>`;
    }).join("") : `<div class="dgf-empty">No test evidence recorded.</div>`;
    const releaseRows = releases.length ? releases.map((release) => {
      const current = currentReleases.get(release.platform) === release.id;
      const label = current ? human(release.status) : `${human(release.status)} · stale`;
      const tone = current && release.status === "RELEASED" ? "done" : current && ["FAILED", "BLOCKED"].includes(release.status) ? "hold" : "";
      return `<article class="dgf-row"><b>${esc(human(release.platform))}</b><small>${esc(release.versionName || release.packageId || "Version pending")}</small><span class="dgf-chip" data-tone="${tone}">${esc(label)}</span><small>${esc(shortDate(release.updatedAt))}</small></article>`;
    }).join("") : `<div class="dgf-empty">No store release record exists.</div>`;
    const approvalRows = approvals.length ? approvals.map((approval) => {
      const subject = game.approvalSubjects?.[approval.gate];
      const current = !approval.invalidatedAt && subject?.ready === true && subject.hash === approval.subjectHash;
      const label = current ? human(approval.decision) : `${human(approval.decision)} · superseded`;
      const subjectLabel = approval.subjectHash ? `Evidence ${approval.subjectHash.slice(0, 12)}…` : "No evidence hash recorded";
      return `<article class="dgf-row"><b>${esc(human(approval.gate))}</b><small>${esc(subjectLabel)}</small><span class="dgf-chip" data-tone="${current && approval.decision === "APPROVED" ? "done" : current ? "hold" : ""}">${esc(label)}</span><small>${esc(shortDate(approval.createdAt))}</small></article>`;
    }).join("") : `<div class="dgf-empty">No approval decisions recorded.</div>`;
    return `<div class="dgf-section-head"><div><h2>Automated test evidence</h2><p>Evidence must match the active build.</p></div></div><div class="dgf-table">${testRows}</div>
      <div class="dgf-section-head" style="margin-top:20px"><div><h2>Owner approvals</h2><p>New builds invalidate stale approvals.</p></div></div><div class="dgf-table">${approvalRows}</div>
      <div class="dgf-section-head" style="margin-top:20px"><div><h2>Release readiness</h2><p>Final submission remains human-gated.</p></div></div><div class="dgf-table">${releaseRows}</div>
      <div class="dgf-section-head" style="margin-top:20px"><div><h2>Publisher checklist</h2><p>These accountable steps cannot be inferred or fabricated by the factory.</p></div></div>
      <ul class="dgf-checklist"><li>Confirm Apple and Google account ownership, agreements, tax, and banking directly with each store.</li><li>Review age rating, content rights, privacy/data safety, tracking, advertising, and encryption/export declarations for the exact release.</li><li>Keep signing keys in the approved runner keychain or credential vault; only their verified status belongs here.</li><li>Review the final store page, test-track result, rollout plan, and rollback criteria before store-submission and production-release approval.</li></ul>`;
  }

  function eventDescription(event) {
    const payload = event.payload || {};
    if (payload.from && payload.to) return `${human(payload.from)} → ${human(payload.to)}`;
    if (payload.title) return String(payload.title);
    if (payload.capability) return human(payload.capability);
    if (payload.gate) return human(payload.gate);
    if (payload.status) return human(payload.status);
    if (payload.reason) return String(payload.reason).slice(0, 220);
    return `Recorded by ${event.actor || "the factory"}.`;
  }

  function activityMarkup(game) {
    const events = [...(game.events || [])].sort((a, b) => Number(b.id) - Number(a.id));
    if (!events.length) return `<div class="dgf-empty">No lifecycle events recorded.</div>`;
    return events.map((event) => `<article class="dgf-event"><time datetime="${esc(event.createdAt)}">#${Number(event.id) || 0}<br>${esc(shortDate(event.createdAt))}</time><div><b>${esc(human(String(event.type).replaceAll(".", " ")))}</b><p>${esc(eventDescription(event))}</p></div></article>`).join("");
  }

  function panelMarkup(game) {
    if (currentTab === "work") return `<div class="dgf-section-head"><div><h2>Durable work queue</h2><p>One active writer per game; leases reconcile after interruption.</p></div></div>${taskRows(game)}`;
    if (currentTab === "artifacts") return `<div class="dgf-section-head"><div><h2>Required artifact ledger</h2><p>Immutable versions with independent copy verification.</p></div><span class="dgf-chip" data-tone="${game.complete ? "done" : "hold"}">${game.complete ? "Complete" : `${game.missing?.length || 0} missing`}</span></div>${artifactsMarkup(game)}`;
    if (currentTab === "quality") return qualityMarkup(game);
    if (currentTab === "activity") return `<div class="dgf-section-head"><div><h2>Event history</h2><p>Append-only lifecycle activity for this game.</p></div></div>${activityMarkup(game)}`;
    return overviewMarkup(game);
  }

  function renderDetail() {
    const node = $("[data-factory-detail]");
    if (!node) return;
    if (accessError) {
      node.innerHTML = `<div class="dgf-detail-empty"><div><span class="dgf-kicker">Factory unavailable</span><h2>${esc(accessError.status === 401 ? "Sign in required" : "Access is not enabled")}</h2><p>${esc(readable(accessError))}</p><button class="dgf-action" data-kind="primary" type="button" data-factory-close>Return to Dominion</button></div></div>`;
      return;
    }
    const game = detail;
    if (!game) {
      node.innerHTML = `<div class="dgf-detail-empty"><p>Select a game to inspect its durable record.</p></div>`;
      return;
    }
    node.innerHTML = `<header class="dgf-detail-head">
      <div class="dgf-title-row"><div><h2>${esc(game.name)}</h2><p>#${String(Number(game.order) || 0).padStart(2, "0")} · ${esc(game.slug)} · updated ${esc(shortDate(game.updatedAt))}</p></div><span class="dgf-chip" data-tone="${stateTone(game)}">${esc(human(game.operation || game.state))}</span></div>
      <div class="dgf-progress-row"><div class="dgf-progress" role="progressbar" aria-label="Lifecycle progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamp(game.progress, 0, 100)}"><i style="width:${clamp(game.progress, 0, 100)}%"></i></div><b>${clamp(game.progress, 0, 100)}%</b></div>
      ${operationNotice(game)}${actionMarkup(game)}
    </header>${tabsMarkup()}<section class="dgf-tab-panel" id="dgf-tab-panel" role="tabpanel">${panelMarkup(game)}</section>`;
  }

  function renderAll() {
    renderSummary();
    renderList();
    renderDetail();
    const refresh = $("[data-factory-refresh]");
    if (refresh) refresh.disabled = busy;
  }

  function showAccessError(error) {
    accessError = error;
    bootstrap = { games: [], summary: {} };
    renderAll();
    setStatus(readable(error), "error");
    setLive("retry", "Unavailable");
  }

  async function loadDetail(id, { restartStream = true } = {}) {
    if (!id || !root) return;
    const token = ++loadToken;
    const result = await request(`/games/${encodeURIComponent(id)}`);
    if (!root || token !== loadToken || selectedId !== id) return;
    detail = result.game;
    lastEventId = Math.max(lastEventId, ...(detail.events || []).map((event) => Number(event.id) || 0));
    renderList();
    renderDetail();
    if (restartStream) startEvents(id);
  }

  async function refresh({ quiet = false } = {}) {
    if (!root || busy) return;
    const epoch = openEpoch;
    busy = true;
    if (!quiet) setStatus("Refreshing durable factory state…");
    renderAll();
    try {
      const [nextBootstrap, nextConfig] = await Promise.all([request("/bootstrap"), config ? Promise.resolve(config) : request("/config")]);
      if (!root || epoch !== openEpoch) return;
      bootstrap = nextBootstrap;
      config = nextConfig;
      accessError = null;
      const available = bootstrap.games || [];
      if (!available.some((game) => game.id === selectedId)) selectedId = available[0]?.id || "";
      if (detail?.id !== selectedId) detail = null;
      renderSummary();
      renderList();
      if (selectedId) await loadDetail(selectedId, { restartStream: streamProject !== selectedId });
      else { detail = null; renderDetail(); stopEvents(); }
      if (!quiet) setStatus(`Portfolio synchronized at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`, "ok");
    } catch (error) {
      if (!root || epoch !== openEpoch) return;
      if ([401, 403].includes(Number(error.status))) { detail = null; showAccessError(error); }
      else setStatus(readable(error) + (bootstrap ? " The last loaded state remains visible; retrying safely." : " No durable state was loaded; retrying safely."), "error");
      setLive("retry", "Retrying");
    } finally {
      if (root && epoch === openEpoch) { busy = false; renderAll(); }
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; void refresh({ quiet: true }); }, 250);
  }

  function stopEvents() {
    eventSource?.close();
    eventSource = null;
    streamProject = "";
  }

  function startEvents(projectId) {
    if (!root || !projectId || typeof EventSource === "undefined") {
      setLive("retry", "Polling");
      return;
    }
    if (eventSource && streamProject === projectId) return;
    stopEvents();
    streamProject = projectId;
    const url = `${API}/events?projectId=${encodeURIComponent(projectId)}&after=${Math.max(0, lastEventId)}`;
    const source = new EventSource(url, { withCredentials: true });
    eventSource = source;
    source.onopen = () => { if (eventSource === source) setLive("live", "Live"); };
    source.onerror = () => { if (eventSource === source) setLive("retry", navigator.onLine ? "Reconnecting" : "Offline"); };
    const receive = (event) => {
      if (eventSource !== source) return;
      lastEventId = Math.max(lastEventId, Number(event.lastEventId) || 0);
      scheduleRefresh();
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, receive);
  }

  async function selectGame(id) {
    if (!id || id === selectedId) return;
    previewDialog?.close();
    artifactDialog?.close();
    selectedId = id;
    detail = null;
    lastEventId = 0;
    stopEvents();
    renderList();
    renderDetail();
    setStatus("Loading the selected game checkpoint…");
    try { await loadDetail(id); setStatus("Selected game synchronized.", "ok"); }
    catch (error) { setStatus(readable(error), "error"); }
  }

  async function stopWorkspacePreview() {
    if (!previewStarted) return;
    previewStarted = false;
    try {
      await fetch("/ide/preview/stop", {
        method: "POST", credentials: "include", cache: "no-store", keepalive: true,
        headers: { "content-type": "application/json", "X-Dominion-Action": "game-factory" }, body: "{}",
      });
    } catch {}
  }

  function openWorkspacePreview(action) {
    const attempt = previewQueue.then(() => startWorkspacePreview(action));
    previewQueue = attempt.catch(() => {});
    return attempt;
  }

  async function startWorkspacePreview(action) {
    if (previewDialog) { previewDialog.focus(); return; }
    const workspaceId = detail?.workspaceId || "";
    const buildId = detail?.activeBuild?.id || "";
    if (!workspaceId || !buildId || action?.clientAction !== "preview") {
      setStatus("A durable workspace and active build are required before preview can start.", "error");
      return;
    }
    const dialog = document.createElement("dialog");
    previewDialog = dialog;
    dialog.className = "dgf-input-dialog dgf-preview-dialog";
    dialog.setAttribute("aria-labelledby", "dgf-preview-title");
    dialog.setAttribute("aria-describedby", "dgf-preview-note");
    dialog.innerHTML = `<div class="dgf-preview-head"><div><span class="dgf-kicker">Workspace tryout</span><h2 id="dgf-preview-title">${esc(detail.name)} preview</h2><p id="dgf-preview-note">This runs the current workspace build. It is not QA, approval, store, or release evidence.</p></div><button class="dgf-icon-button" type="button" data-preview-close aria-label="Close game preview">×</button></div><div class="dgf-preview-status" role="status" aria-live="polite">Starting the verified workspace preview…</div><iframe hidden title="${esc(detail.name)} interactive workspace preview" sandbox="allow-scripts allow-forms allow-pointer-lock" referrerpolicy="no-referrer"></iframe>`;
    root.append(dialog);
    const frame = dialog.querySelector("iframe");
    const status = dialog.querySelector("[role='status']");
    dialog.querySelector("[data-preview-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", () => { dialog.returnValue = "cancel"; });
    dialog.addEventListener("close", () => {
      if (previewDialog === dialog) previewDialog = null;
      dialog.remove();
      previewQueue = previewQueue.then(() => stopWorkspacePreview()).catch(() => {});
    }, { once: true });
    dialog.showModal();
    dialog.querySelector("[data-preview-close]")?.focus();
    try {
      const response = await fetch("/ide/preview/start", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "content-type": "application/json", "X-Dominion-Action": "game-factory" },
        body: JSON.stringify({ workspaceId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error) throw new Error(result.error || `Preview returned ${response.status}.`);
      previewStarted = true;
      if (previewDialog !== dialog || !dialog.isConnected) { await stopWorkspacePreview(); return; }
      frame.addEventListener("load", () => { if (previewDialog === dialog) status.textContent = "Workspace preview is running. Closing this window stops it."; }, { once: true });
      frame.hidden = false;
      frame.src = `/ide/preview/p/?t=${encodeURIComponent(buildId)}`;
    } catch (error) {
      if (previewDialog === dialog) status.textContent = `Preview could not start: ${error?.message || "the build worker did not answer"}`;
    }
  }

  async function openArtifactViewer(artifactKey) {
    if (artifactDialog) { artifactDialog.focus(); return; }
    const key = String(artifactKey || "").trim().toUpperCase();
    const artifact = (detail?.artifacts || []).find((item) => item.artifactKey === key);
    const required = (detail?.required || config?.requiredArtifacts || []).includes(key);
    if (!required || !artifact?.viewer?.enabled) {
      setStatus(artifact?.viewer?.reason || "That required artifact is not available for safe review.", "error");
      return;
    }
    const projectId = detail.id;
    const projectName = detail.name;
    const dialog = document.createElement("dialog");
    const controller = new AbortController();
    artifactDialog = dialog;
    dialog.className = "dgf-input-dialog dgf-artifact-dialog";
    dialog.setAttribute("aria-labelledby", "dgf-artifact-title");
    dialog.setAttribute("aria-describedby", "dgf-artifact-note");
    dialog.innerHTML = `<div class="dgf-preview-head"><div><span class="dgf-kicker">Verified artifact snapshot</span><h2 id="dgf-artifact-title">${esc(key)}</h2><p id="dgf-artifact-note">${esc(projectName)} · Markdown is shown as plain text and is never executed.</p></div><button class="dgf-icon-button" type="button" data-artifact-close aria-label="Close artifact viewer">×</button></div><div class="dgf-preview-status" role="status" aria-live="polite">Loading integrity-checked text…</div><pre hidden tabindex="0" aria-label="${esc(key)} plain-text content"></pre>`;
    root.append(dialog);
    const status = dialog.querySelector("[role='status']"), pre = dialog.querySelector("pre");
    dialog.querySelector("[data-artifact-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", () => { dialog.returnValue = "cancel"; });
    dialog.addEventListener("close", () => {
      controller.abort();
      if (artifactDialog === dialog) artifactDialog = null;
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    dialog.querySelector("[data-artifact-close]")?.focus();
    try {
      const result = await request(`/games/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(key)}/content`, { signal: controller.signal });
      if (artifactDialog !== dialog || !dialog.isConnected) return;
      if (typeof result.content !== "string" || result.viewer?.renderMode !== "plain_text" || result.viewer?.markdownExecution !== false) {
        throw new Error("The server did not return a safe plain-text artifact view.");
      }
      pre.textContent = result.content;
      pre.hidden = false;
      const version = Number(result.artifact?.version) || 1;
      const fingerprint = String(result.artifact?.sha256 || "").slice(0, 12);
      status.textContent = result.artifact?.complete
        ? `Version ${version} · ${fingerprint}… · all required evidence is complete.`
        : `Version ${version} · ${fingerprint}… · local content verified; another required copy may still be pending.`;
    } catch (error) {
      if (artifactDialog === dialog && !controller.signal.aborted) status.textContent = `Artifact could not be opened: ${readable(error)}`;
    }
  }

  function askForExplanation(action) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      decisionDialog = dialog;
      dialog.className = "dgf-input-dialog";
      dialog.setAttribute("aria-labelledby", "dgf-input-title");
      dialog.innerHTML = `<form method="dialog"><span class="dgf-kicker">Owner instruction</span><h2 id="dgf-input-title">${esc(action.inputLabel || "Describe what should change")}</h2><p>This note becomes part of the durable decision record.</p><textarea name="explanation" rows="5" maxlength="2000" required aria-label="${esc(action.inputLabel || "Revision explanation")}"></textarea><div class="dgf-actions"><button class="dgf-action" type="submit" value="cancel">Cancel</button><button class="dgf-action" data-kind="primary" type="submit" value="submit">Save instruction</button></div><div class="dgf-status" role="status" aria-live="polite"></div></form>`;
      root.append(dialog);
      const form = dialog.querySelector("form"), field = dialog.querySelector("textarea"), status = dialog.querySelector("[role='status']");
      form.addEventListener("submit", (event) => {
        if (event.submitter?.value !== "submit") return;
        if (!field.value.trim()) { event.preventDefault(); status.textContent = "Write a short explanation before saving."; field.focus(); }
      });
      dialog.addEventListener("cancel", () => { dialog.returnValue = "cancel"; });
      dialog.addEventListener("close", () => {
        const value = dialog.returnValue === "submit" ? field.value.trim() : "";
        if (decisionDialog === dialog) decisionDialog = null;
        dialog.remove();
        resolve(value || null);
      }, { once: true });
      dialog.showModal();
      field.focus();
    });
  }

  function askForConfirmation(action) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      decisionDialog = dialog;
      dialog.className = "dgf-input-dialog";
      dialog.setAttribute("aria-labelledby", "dgf-confirm-title");
      const subject = action.subjectHash ? ` This decision is bound to ${esc(action.subjectLabel || "the current evidence")} (${esc(action.subjectHash.slice(0, 12))}…).` : "";
      dialog.innerHTML = `<form method="dialog"><span class="dgf-kicker">Confirm owner action</span><h2 id="dgf-confirm-title">${esc(action.label || human(action.id))}</h2><p>This changes the durable factory record.${subject} The resulting checkpoint and audit history will remain visible.</p><div class="dgf-actions"><button class="dgf-action" type="submit" value="cancel">Keep current state</button><button class="dgf-action" data-kind="${action.kind === "primary" ? "primary" : "danger"}" type="submit" value="confirm">${esc(action.label || human(action.id))}</button></div></form>`;
      root.append(dialog);
      dialog.addEventListener("cancel", () => { dialog.returnValue = "cancel"; });
      dialog.addEventListener("close", () => {
        const accepted = dialog.returnValue === "confirm";
        if (decisionDialog === dialog) decisionDialog = null;
        dialog.remove();
        resolve(accepted);
      }, { once: true });
      dialog.showModal();
      dialog.querySelector("button")?.focus();
    });
  }

  async function runAction(actionId) {
    if (busy || !detail) return;
    const action = (detail.allowedActions || []).find((item) => item.id === actionId);
    if (!action) return setStatus("That action is no longer allowed. Refreshing the current checkpoint.", "error");
    if (action.clientAction === "preview") return openWorkspacePreview(action);
    if (action.id === "attach_workspace" && !(action.payload || action.commandPayload)) return setStatus("Workspace assignment has no browser path control. The orchestrator must provide a verified workspace identity.", "error");
    let plainLanguage = "";
    if (action.requiresInput) {
      plainLanguage = await askForExplanation(action);
      if (!plainLanguage) return setStatus("No change was sent because the explanation was empty.", "error");
    } else if ((action.requiresConfirmation || action.kind === "danger" || action.id === "stop") && !await askForConfirmation(action)) {
      return setStatus("The current checkpoint was left unchanged.");
    }
    busy = true;
    renderAll();
    setStatus(`${action.label || human(action.id)} requested…`);
    try {
      const payload = { ...(action.commandPayload || action.payload || {}) };
      if (action.toState && !payload.toState) payload.toState = action.toState;
      if (action.gate && !payload.gate) payload.gate = action.gate;
      if (plainLanguage) {
        if (action.id === "reject") payload.rationale = plainLanguage;
        else payload.reason = plainLanguage;
      }
      const key = identifier();
      await request(`/games/${encodeURIComponent(detail.id)}/commands`, {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify({ command: action.command || action.id, expectedVersion: detail.version, idempotencyKey: key, payload }),
      });
      setStatus("Command committed. Reading the resulting checkpoint…", "ok");
    } catch (error) {
      setStatus(readable(error) + (error.status === 409 ? " The current state will be reloaded." : ""), "error");
    } finally {
      busy = false;
      await refresh({ quiet: true });
    }
  }

  function handleClick(event) {
    const closeButton = event.target.closest("[data-factory-close]");
    if (closeButton) { close(); return; }
    if (event.target.closest("[data-factory-refresh]")) { void refresh(); return; }
    const game = event.target.closest("[data-game-id]");
    if (game) { void selectGame(game.dataset.gameId); return; }
    const tab = event.target.closest("[data-tab]");
    if (tab && detail) { currentTab = tab.dataset.tab; renderDetail(); $("[data-tab][aria-selected='true']")?.focus(); return; }
    const artifact = event.target.closest("[data-artifact-key]");
    if (artifact) { void openArtifactViewer(artifact.dataset.artifactKey); return; }
    const command = event.target.closest("[data-command]");
    if (command) void runAction(command.dataset.command);
  }

  function handleInput(event) {
    if (!event.target.matches("[data-factory-search]")) return;
    filter = event.target.value;
    renderList();
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (root && document.visibilityState === "visible") void refresh({ quiet: true }); }, 20000);
  }

  function open({ route = true } = {}) {
    if (root) {
      if (route && location.pathname !== "/games") {
        history.pushState({ ...(history.state || {}), dominionSurface: "games" }, "", "/games");
        pushedRoute = true;
      }
      root.focus();
      return;
    }
    openEpoch++;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnRoute = location.pathname === "/games" ? "/" : `${location.pathname}${location.search}${location.hash}`;
    pushedRoute = location.pathname === "/games" && history.state?.dominionSurface === "games";
    if (route && location.pathname !== "/games") {
      history.pushState({ ...(history.state || {}), dominionSurface: "games" }, "", "/games");
      pushedRoute = true;
    }
    mount();
    startPolling();
    void refresh();
  }

  function close({ route = true } = {}) {
    if (!root) return;
    openEpoch++;
    loadToken++;
    clearTimeout(refreshTimer); refreshTimer = null;
    clearInterval(pollTimer); pollTimer = null;
    stopEvents();
    previewDialog?.close();
    artifactDialog?.close();
    decisionDialog?.close();
    const focus = returnFocus;
    const shouldBack = route && pushedRoute && location.pathname === "/games";
    const shouldReplace = route && !pushedRoute && location.pathname === "/games";
    root.remove();
    root = null;
    document.body.classList.remove("dgf-open");
    markNavigation(false);
    restoreBackground();
    bootstrap = null; detail = null; selectedId = ""; busy = false; accessError = null; pushedRoute = false;
    if (shouldBack) history.back();
    else if (shouldReplace) history.replaceState({ ...(history.state || {}), dominionSurface: undefined }, "", returnRoute || "/");
    focus?.focus?.();
    returnFocus = null;
  }

  function init() {
    addStylesheet();
    window.addEventListener("popstate", () => {
      if (location.pathname === "/games") open({ route: false });
      else if (root) close({ route: false });
    });
    window.addEventListener("online", () => { if (root) { setLive("retry", "Reconnecting"); void refresh({ quiet: true }); } });
    window.addEventListener("offline", () => { if (root) setLive("retry", "Offline"); });
    window.addEventListener("pagehide", () => { if (previewStarted) void stopWorkspacePreview(); });
    if (location.pathname === "/games") open({ route: false });
  }

  window.DominionGameFactory = {
    init, open, close,
    getState: () => ({ open: !!root, selectedId, tab: currentTab, games: bootstrap?.games?.length || 0, live: !!eventSource }),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
