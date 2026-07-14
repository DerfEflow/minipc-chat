(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const pane = document.getElementById("neural-glass");
  const reflection = pane?.querySelector(".glass-reflection");
  const commandbar = document.getElementById("commandbar");
  const send = document.getElementById("send");
  const speak = document.getElementById("speak");
  const mic = document.getElementById("mic");
  const model = document.getElementById("model");
  const mode = document.getElementById("mode");
  const wrap = document.getElementById("wrap");
  const activity = document.getElementById("activity-status");
  const connection = document.getElementById("connection-status");
  const context = document.getElementById("context-status");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

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
    if (existing && existing.querySelector("use")?.getAttribute("href") === "#i-" + name) return;
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
    if (activity) activity.textContent = busy ? "Processing directive" : "System ready";
  }

  let contextTimer = 0;
  function syncContext() {
    if (!context || !wrap) return;
    const visibleSignals = wrap.querySelectorAll(".msgmeta, .ctx, .tool").length;
    const label = context.querySelector("span");
    if (!label) return;
    if (visibleSignals) {
      label.textContent = "Context active";
      context.classList.add("is-live");
      clearTimeout(contextTimer);
      contextTimer = setTimeout(() => {
        if (!body.classList.contains("is-thinking")) {
          label.textContent = "Context ready";
          context.classList.remove("is-live");
        }
      }, 2600);
    } else {
      label.textContent = "Context ready";
      context.classList.remove("is-live");
    }
  }

  const actionMap = new Map([
    ["Edit", "edit"],
    ["Copy", "copy"],
    ["Save", "save"],
    ["Critique", "critique"],
    ["Continue", "continue"],
    ["Regenerate", "regenerate"],
    ["🔎", "inspect"],
    ["💡", "lesson"],
    ["🧪", "eval"],
    ["Delete", "delete"],
    ["Back", "continue"],
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
      if (!title) return;
      const name = title.includes("rename") ? "edit" : title.includes("delete") ? "delete" : null;
      if (!name || el.dataset.dominionIcon) return;
      el.dataset.dominionIcon = name;
      el.textContent = "";
      el.appendChild(icon(name));
    });
  }

  const emojiRules = [
    [/^🧠\s*/, "memory"],
    [/^📄\s*/, "artifact"],
    [/^💬\s*/, "context"],
    [/^🔧\s*/, "tools"],
    [/^🔒\s*/, "tools"],
    [/^⏸\s*/, "mode"],
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
    label.prepend(icon(node.classList.contains("gated") ? "settings" : "tools"));
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
    window.setTimeout(() => body.classList.remove("panel-transition"), 760);
  };

  commandbar?.querySelectorAll(".command-icon").forEach((button) => {
    button.addEventListener("click", pulseCommand);
  });
  model?.addEventListener("change", pulseCommand);
  mode?.addEventListener("change", pulseCommand);

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
      root.style.setProperty("--tilt-x", ((x - .5) * .42).toFixed(3) + "deg");
      root.style.setProperty("--tilt-y", ((.5 - y) * .34).toFixed(3) + "deg");
      root.style.setProperty("--signal-x", (x * 100).toFixed(2) + "%");
      if (reflection) reflection.style.transform = `translateX(${((x - .5) * 140).toFixed(1)}px) rotate(15deg)`;
    };
    window.addEventListener("pointermove", (event) => {
      pending = event;
      if (!frame) frame = requestAnimationFrame(renderPointer);
    }, { passive: true });
    pane.addEventListener("pointerleave", () => {
      root.style.setProperty("--tilt-x", "0deg");
      root.style.setProperty("--tilt-y", "0deg");
      if (reflection) reflection.style.transform = "translateX(0) rotate(15deg)";
    });
  }

  window.addEventListener("online", syncConnection);
  window.addEventListener("offline", syncConnection);

  if (send) {
    new MutationObserver(syncBusy).observe(send, { attributes: true, childList: true, subtree: true });
  }
  if (speak) {
    new MutationObserver(syncVoiceIcons).observe(speak, { attributes: true, childList: true, subtree: true });
  }

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

  if (reflection) reflection.style.transform = "translateX(0) rotate(15deg)";
  syncConnection();
  syncBusy();
  syncContext();
  decorate();
})();
