(() => {
  "use strict";

  const state = {
    account: null,
    content: null,
    layer: null,
    guide: null,
    overlay: null,
    toastRack: null,
    sections: [],
    sectionIndex: 0,
    activeDialog: null,
    restoreFocus: null,
    previousOverflow: "",
    initPromise: null
  };

  async function api(path, options = {}) {
    const request = { method: options.method || "GET", headers: {} };
    if (Object.prototype.hasOwnProperty.call(options, "body")) {
      request.headers["content-type"] = "application/json";
      request.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, request);
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function ensureLayer() {
    if (state.layer?.isConnected) return;
    state.layer = node("div", "dt-tenant-layer");
    state.layer.dataset.dtTenantLayer = "";

    state.guide = node("button", "dt-guide-pill", "Guide");
    state.guide.type = "button";
    state.guide.hidden = true;
    state.guide.setAttribute("aria-label", "Open Dominion guide");
    state.guide.addEventListener("click", openGuide);

    state.overlay = node("div", "dt-overlay");
    state.overlay.hidden = true;
    state.overlay.addEventListener("mousedown", event => {
      if (event.target === state.overlay && state.activeDialog === "tutorial") closeTutorial();
    });

    state.toastRack = node("div", "dt-toast-rack");
    state.toastRack.setAttribute("aria-live", "polite");
    state.toastRack.setAttribute("aria-atomic", "true");

    // The Guide pill docks in the composer next to the paperclip (Fred, 2026-07-18) — a fixed
    // floater kept colliding with the send arrow / input corner. Fallback: the floating layer.
    const barLeft = document.getElementById("bar-left");
    if (barLeft) { state.guide.classList.add("dt-guide-docked"); barLeft.append(state.guide); state.layer.append(state.overlay, state.toastRack); }
    else state.layer.append(state.guide, state.overlay, state.toastRack);
    document.body.append(state.layer);
    document.addEventListener("keydown", handleKeydown);
  }

  function showToast(message, kind = "neutral") {
    ensureLayer();
    const toast = node("div", `dt-toast dt-toast-${kind}`, message);
    state.toastRack.append(toast);
    window.setTimeout(() => toast.remove(), 5200);
  }

  function beginDialog(kind, sheet) {
    state.activeDialog = kind;
    state.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    state.overlay.replaceChildren(sheet);
    state.overlay.hidden = false;
    state.guide.hidden = true;
    window.requestAnimationFrame(() => {
      const first = sheet.querySelector("button:not([disabled])");
      first?.focus();
    });
  }

  function endDialog(showGuide = true) {
    state.activeDialog = null;
    state.overlay.hidden = true;
    state.overlay.replaceChildren();
    document.documentElement.style.overflow = state.previousOverflow;
    if (showGuide && state.account?.multiTenant) state.guide.hidden = false;
    state.restoreFocus?.focus?.();
    state.restoreFocus = null;
  }

  function sheetHeader(kicker, title, closeHandler) {
    const header = node("div", "dt-sheet-head");
    const copy = node("div", "dt-sheet-title-wrap");
    copy.append(node("div", "dt-sheet-kicker", kicker), node("h2", "dt-sheet-title", title));
    header.append(copy);
    if (closeHandler) {
      const close = node("button", "dt-close-button", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Close guide");
      close.addEventListener("click", closeHandler);
      header.append(close);
    }
    return header;
  }

  async function getContent() {
    if (!state.content) state.content = await api("/content/tutorial");
    return state.content;
  }

  async function showConsent() {
    let content;
    try { content = await getContent(); }
    catch {
      showToast("Consent information could not be loaded.", "error");
      return;
    }
    const sheet = node("section", "dt-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Consent notice");
    sheet.append(sheetHeader("First access", "Consent notice"));
    const body = node("div", "dt-consent-body");
    body.append(node("p", "dt-consent-copy", content.consent || ""));
    const actions = node("div", "dt-consent-actions");
    const accept = node("button", "dt-primary-button", "Accept and continue");
    accept.type = "button";
    accept.addEventListener("click", async () => {
      accept.disabled = true;
      accept.textContent = "Saving";
      try {
        await api("/account/consent", { method: "POST", body: {} });
        state.account.consented = true;
        endDialog(false);
        if (!state.account.tutorialSeen) showTutorial();
        else state.guide.hidden = false;
      } catch (error) {
        accept.disabled = false;
        accept.textContent = "Accept and continue";
        showToast(error.message || "Consent could not be saved.", "error");
      }
    });
    actions.append(accept);
    sheet.append(body, actions);
    beginDialog("consent", sheet);
  }

  function normalizeSections(tutorial) {
    return Array.isArray(tutorial?.sections) ? tutorial.sections.filter(section => section && typeof section === "object") : [];
  }

  async function showTutorial() {
    let content;
    try { content = await getContent(); }
    catch {
      showToast("The guide could not be loaded.", "error");
      return;
    }
    const tutorial = content.tutorial || {};
    state.sections = normalizeSections(tutorial);
    state.sectionIndex = Math.min(state.sectionIndex, Math.max(0, state.sections.length - 1));

    const sheet = node("section", "dt-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tutorial.title || "Dominion guide");
    sheet.append(sheetHeader("Dominion guide", tutorial.title || "Guide", closeTutorial));

    const grid = node("div", "dt-tutorial-grid");
    const nav = node("div", "dt-tutorial-nav");
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Guide sections");
    const contentPanel = node("div", "dt-tutorial-content");
    contentPanel.setAttribute("role", "tabpanel");

    const actions = node("div", "dt-tutorial-actions");
    const progress = node("span", "dt-progress-label");
    const actionButtons = node("div", "dt-tutorial-actions-buttons");
    const previous = node("button", "dt-secondary-button", "Previous");
    previous.type = "button";
    const next = node("button", "dt-primary-button", "Next");
    next.type = "button";
    actionButtons.append(previous, next);
    actions.append(progress, actionButtons);

    function render() {
      nav.replaceChildren();
      state.sections.forEach((section, index) => {
        const tab = node("button", "dt-tab-button", section.title || section.heading || `Section ${index + 1}`);
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(index === state.sectionIndex));
        tab.tabIndex = index === state.sectionIndex ? 0 : -1;
        tab.addEventListener("click", () => { state.sectionIndex = index; render(); });
        nav.append(tab);
      });

      contentPanel.replaceChildren();
      const section = state.sections[state.sectionIndex];
      if (section) {
        const heading = section.title || section.heading;
        if (heading) contentPanel.append(node("h3", "dt-section-title", heading));
        if (section.body) contentPanel.append(node("p", "dt-section-body", section.body));
        for (const key of ["why", "what", "how"]) {
          if (section[key]) contentPanel.append(node("p", "dt-section-body", section[key]));
        }
        if (Array.isArray(section.points) && section.points.length) {
          const list = node("ul", "dt-point-list");
          section.points.forEach(point => list.append(node("li", "dt-point-item", typeof point === "string" ? point : point?.text || "")));
          contentPanel.append(list);
        }
        if (section.id === "forge-mode" && Array.isArray(section.tiers) && section.tiers.length) {
          const cards = node("div", "dt-tier-cards");
          section.tiers.forEach(tier => {
            const card = node("article", "dt-tier-card");
            card.append(node("strong", "", tier?.name || tier?.id || ""));
            if (tier?.desc) card.append(node("p", "", tier.desc));
            cards.append(card);
          });
          contentPanel.append(cards);
        }
      }
      contentPanel.scrollTop = 0;
      previous.disabled = state.sectionIndex === 0;
      next.textContent = state.sectionIndex >= state.sections.length - 1 ? "Done" : "Next";
      progress.textContent = state.sections.length ? `${state.sectionIndex + 1} of ${state.sections.length}` : "Guide";
    }

    previous.addEventListener("click", () => { if (state.sectionIndex > 0) { state.sectionIndex -= 1; render(); } });
    next.addEventListener("click", () => {
      if (state.sectionIndex < state.sections.length - 1) { state.sectionIndex += 1; render(); }
      else closeTutorial();
    });
    grid.append(nav, contentPanel);
    sheet.append(grid, actions);
    render();
    beginDialog("tutorial", sheet);
  }

  async function closeTutorial() {
    endDialog();
    if (!state.account?.tutorialSeen) {
      state.account.tutorialSeen = true;
      try { await api("/account/tutorial-seen", { method: "POST", body: {} }); }
      catch {
        state.account.tutorialSeen = false;
        showToast("Guide progress could not be saved.", "error");
      }
    }
    maybeShowInstall();   // the natural moment: they just finished the tour
  }

  async function openGuide() {
    state.sectionIndex = 0;
    await showTutorial();
  }

  function handleKeydown(event) {
    if (state.overlay?.hidden) return;
    if (event.key === "Escape" && state.activeDialog === "tutorial") {
      event.preventDefault();
      closeTutorial();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(state.overlay.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function handleTopupQuery() {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("topup");
    if (!result) return;
    url.searchParams.delete("topup");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (result === "done") {
      showToast("Credits added. Your balance has been refreshed.", "success");
      try { state.account = await api("/account"); }
      catch { showToast("The updated balance could not be loaded.", "error"); }
    } else if (result === "cancel") showToast("Checkout canceled. No charge was made.", "neutral");
  }

  // ---- What's new (Fred, 2026-07-19) ----------------------------------------------------------
  // The release notes, shown once per release on a user's next sign-in. Bump RELEASE.version to
  // announce the next one; the stored key is compared against it, so a new version shows again and
  // a user who has already seen this one is left alone.
  //
  // Deliberately NOT shown to a brand new account. Someone who just finished consent and the
  // tutorial has no "before" to compare against, so "what's new" is noise on day one. For them the
  // version is stamped as seen silently, and the next release is the first one they are told about.
  const RELEASE_LS = "dominion.releaseSeen.v1";
  const RELEASE = {
    version: "2026.07",
    kicker: "Product update",
    title: "What's new in Dominion",
    standfirst: "A broad update across the whole assistant: the services it can reach, the work it can carry out, how hard it thinks, what it can make, and how it sounds when it speaks back.",
    sections: [
      { h: "Connectors", items: [
        ["Zapier, Google Workspace, GitHub, Stripe", "Dominion can now work inside the accounts you already use, including a bridge to more than 6,000 apps through your own Zapier server."],
        ["Supabase, Postgres, Railway, Cloudflare", "Your projects, tables, deploys and DNS, reachable from the chat."],
        ["Your own connectors", "Any MCP server you have can be added by hand."],
        ["Credentials stay yours", "Every secret is encrypted at rest with per-account keys and is never shown back to anyone."],
      ] },
      { h: "Image generation", items: [
        ["A full image studio", "Generate on the current flagship image model at three quality settings, in square, portrait or landscape."],
        ["Reference plates and Refine", "Attach up to ten reference images, and turn a rough line into fuller art direction before you spend anything."],
        ["Batch Foundry at half rate", "Queue a batch for a fifty percent reduction, delivered within twenty-four hours, reconciled against real usage with overcharges returned as credits."],
        ["The gallery is yours", "Finished images live on your device. Dominion keeps no cloud gallery of your work."],
      ] },
      { h: "Voice, in both directions", items: [
        ["Talk to it", "Tap the microphone and speak. Your words reach the same model and the same tools as typing."],
        ["Thirteen voices", "Pick one in Settings and audition it before you commit."],
        ["It reads the whole answer", "Long replies used to stop partway with no explanation. They are now read from beginning to end, and speech starts on the first passage while the rest is still being made."],
        ["Play, pause and stop", "A transport bar shows progress and lets you stop at any point."],
      ] },
      { h: "Ember, Flame and Furnace", items: [
        ["A dial for how hard it thinks", "Ember is the everyday floor, Flame is for work with weight, Furnace applies the whole framework deliberately."],
        ["Forge Mode is its own control", "Reasoning depth and machine reach were separated, so you can think deeply without engaging your machine."],
      ] },
      { h: "Wolfe Logic", items: [
        ["The reasoning core, always on", "Every turn, on every model, is governed by the same discipline: truth before agreement, claims labelled and qualified, mechanism sought beneath the symptom."],
        ["It will push back", "When certainty outruns the evidence, or agreement would preserve harm, Dominion is built to say so."],
      ] },
      { h: "Everywhere else", items: [
        ["Fifty-five tools", "Word documents, PDFs and spreadsheets you can keep, working memory, live web reading, and your own private sandbox."],
        ["Attachments that are read", "Pictures, PDFs, Word files and spreadsheets, extracted on your device, with text recognition for scans and photographs."],
        ["A clearer interface", "Bigger type, more room, and panels that glide over a background that holds still."],
        ["Start on one device, continue on another", "Conversations follow you between phone and desktop."],
      ] },
    ],
    horizon: {
      h: "Coming next: a full stack development environment",
      body: "Editor, terminal, database, deployment and review in one place, with the assistant present at every step. It ships when it is genuinely good, so there is no date yet.",
    },
  };
  const releaseSeen = () => { try { return localStorage.getItem(RELEASE_LS) === RELEASE.version; } catch { return true; } };
  const releaseDone = () => { try { localStorage.setItem(RELEASE_LS, RELEASE.version); } catch {} };
  const forceRelease = new URLSearchParams(window.location.search).has("whats-new");

  function showReleaseNotes() {
    ensureLayer();
    const sheet = node("section", "dt-sheet dt-release");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "What's new in Dominion");
    const close = () => { releaseDone(); endDialog(); maybeShowInstall(); };
    sheet.append(sheetHeader(RELEASE.kicker + " · " + RELEASE.version, RELEASE.title, close));

    const body = node("div", "dt-release-body");
    body.append(node("p", "dt-release-standfirst", RELEASE.standfirst));
    for (const sec of RELEASE.sections) {
      body.append(node("h3", "dt-release-head", sec.h));
      const list = node("ul", "dt-release-list");
      for (const [lead, text] of sec.items) {
        const li = node("li", "");
        li.append(node("b", "", lead), node("span", "", text));
        list.append(li);
      }
      body.append(list);
    }
    const horizon = node("div", "dt-release-horizon");
    horizon.append(node("b", "", RELEASE.horizon.h), node("span", "", RELEASE.horizon.body));
    body.append(horizon);

    const actions = node("div", "dt-consent-actions");
    const ok = node("button", "dt-primary-button", "Got it");
    ok.type = "button";
    ok.addEventListener("click", close);
    actions.append(ok);

    sheet.append(body, actions);
    beginDialog("release", sheet);
  }

  // ---- One-time install prompt (shown after the tutorial, never while installed) ----
  const INSTALL_LS = "dominion.installNudge.v1";
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    maybeShowInstall();
  });
  const isInstalled = () => window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installDone = () => { try { localStorage.setItem(INSTALL_LS, "1"); } catch {} };
  const installSeen = () => { try { return localStorage.getItem(INSTALL_LS) === "1"; } catch { return false; } };
  // Debug hook: append ?install-nudge to force the card (visual verification without browser heuristics).
  const forceNudge = new URLSearchParams(window.location.search).has("install-nudge");

  function maybeShowInstall() {
    if (!state.account || isInstalled() || installSeen() && !forceNudge) return;
    if (state.account.multiTenant && (!state.account.consented || !state.account.tutorialSeen)) return;
    if (!installPrompt && !isIos() && !forceNudge) return;   // nothing actionable to offer this browser yet
    if (document.querySelector(".dt-install")) return;
    ensureLayer();
    const card = node("div", "dt-install");
    const copy = node("div", "dt-install-copy");
    copy.append(node("b", "", "Install Dominion AI"), node("span", "", "Keep it one tap away, full screen, like any app."));
    const actions = node("div", "dt-install-actions");
    const later = node("button", "dt-secondary-button", "Not now");
    later.type = "button";
    later.addEventListener("click", () => { installDone(); card.remove(); });
    const install = node("button", "dt-primary-button", "Install");
    install.type = "button";
    install.addEventListener("click", async () => {
      if (installPrompt) {
        const p = installPrompt; installPrompt = null;
        try { p.prompt(); await p.userChoice; } catch {}
        installDone(); card.remove();
      } else {
        copy.replaceChildren(node("b", "", "On iPhone:"), node("span", "", "Tap the Share button (the square with the arrow), then choose \"Add to Home Screen\"."));
        install.remove();
        later.textContent = "Got it";
      }
    });
    actions.append(later, install);
    card.append(copy, actions);
    state.layer.append(card);
  }

  async function runInit() {
    ensureLayer();
    let account;
    try { account = await api("/account"); }
    catch (error) {
      state.guide.hidden = true;
      if (error.status !== 401) showToast(error.message || "Account information is unavailable.", "error");
      return;
    }
    state.account = account;
    await handleTopupQuery();
    if (!state.account.multiTenant) {
      state.guide.hidden = true;
      if (maybeShowRelease()) return;      // owner/single-tenant sees it too
      maybeShowInstall();
      return;
    }
    if (!state.account.consented) {
      state.guide.hidden = true;
      releaseDone();                       // brand new account: nothing to catch up on
      await showConsent();
      return;
    }
    if (!state.account.tutorialSeen) {
      state.guide.hidden = true;
      releaseDone();                       // still onboarding, so the tutorial IS the news
      await showTutorial();
      return;
    }
    state.guide.hidden = false;
    if (maybeShowRelease()) return;         // one dialog at a time: install nudge waits its turn
    maybeShowInstall();
  }

  // Returns true when the release dialog was opened, so the caller can hold back anything else
  // that wants the screen. Stacking a install card behind a modal reads as a broken app.
  function maybeShowRelease() {
    if (releaseSeen() && !forceRelease) return false;
    if (state.activeDialog) return false;
    showReleaseNotes();
    return true;
  }

  function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = runInit().finally(() => { state.initPromise = null; });
    return state.initPromise;
  }

  // showRelease is exported so the notes can be reopened after they are dismissed (and so they can
  // be demonstrated on request). Appending ?whats-new to the URL forces them for the same reason.
  window.DominionTenant = Object.freeze({ init, showRelease: () => { ensureLayer(); showReleaseNotes(); } });
})();
