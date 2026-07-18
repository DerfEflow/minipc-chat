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

    state.layer.append(state.guide, state.overlay, state.toastRack);
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
      maybeShowInstall();
      return;
    }
    if (!state.account.consented) {
      state.guide.hidden = true;
      await showConsent();
      return;
    }
    if (!state.account.tutorialSeen) {
      state.guide.hidden = true;
      await showTutorial();
      return;
    }
    state.guide.hidden = false;
    maybeShowInstall();
  }

  function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = runInit().finally(() => { state.initPromise = null; });
    return state.initPromise;
  }

  window.DominionTenant = Object.freeze({ init });
})();
