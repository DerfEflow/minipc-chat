/*
 * Dominion AI — "Simplify My Chat" (LANE I).
 *
 * A stripped-down chat surface for people who use AI as a chatbot and a search engine: one input,
 * the conversation, and nothing else. No model picker, no mode switch, no Forge dial — the server
 * (simplify.mjs) picks the seat, and this file never shows which one it picked.
 *
 * Self-contained: builds its own full-screen overlay and appends it to document.body directly (not
 * nested under any existing wrapper), which sidesteps this app's known position:fixed trap —
 * transform/filter/will-change on an ancestor silently breaks fixed positioning, and a direct
 * document.body child has no such ancestor to worry about.
 *
 * Exposes window.DominionSimplify = { open, close, isOpen } as the ONLY integration point other
 * scripts need. See docs/wiring/lane-i-simplify.md for exactly where the hamburger-menu button
 * that calls DominionSimplify.open() gets added (a file this lane does not own).
 */
(() => {
  "use strict";

  if (window.DominionSimplify) return;   // idempotent if this script is ever included twice

  const LS_LINE = "dominion.simplify.lineColor";
  const LS_TEXT = "dominion.simplify.textColor";
  const LS_HISTORY = "dominion.simplify.history";
  const LS_TASK = "dominion.simplify.task";
  const DEFAULT_LINE = "#39ff14";
  const DEFAULT_TEXT = "#6bffc3";
  const ENDPOINT = "/api/simplify/chat";
  const MAX_HISTORY_TURNS = 20;

  let root = null, feed = null, input = null, sendBtn = null, form = null;
  let lineColorInput = null, textColorInput = null;
  let history = [];       // [{role: "user"|"assistant", content: string}]
  let sending = false;
  let currentAbort = null;
  let activeTaskId = null;
  let resumeTimer = null;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function loadColor(key, fallback) {
    try { const v = localStorage.getItem(key); return v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback; }
    catch { return fallback; }
  }
  function saveColor(key, value) { try { localStorage.setItem(key, value); } catch {} }

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_HISTORY) || "null");
      if (Array.isArray(raw)) return raw.filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string").slice(-MAX_HISTORY_TURNS);
    } catch {}
    return [];
  }
  function persistHistory() { try { localStorage.setItem(LS_HISTORY, JSON.stringify(history.slice(-MAX_HISTORY_TURNS))); } catch {} }

  function applyColors() {
    if (!root) return;
    root.style.setProperty("--simplify-line", lineColorInput.value || DEFAULT_LINE);
    root.style.setProperty("--simplify-text", textColorInput.value || DEFAULT_TEXT);
  }

  function scrollFeedToBottom() { feed.scrollTop = feed.scrollHeight; }

  function clearEmptyState() {
    const e = feed.querySelector(".simplify-empty");
    if (e) e.remove();
  }

  function addTurn(role, text) {
    clearEmptyState();
    const div = document.createElement("div");
    div.className = "simplify-turn simplify-" + role;
    div.textContent = text;
    feed.appendChild(div);
    scrollFeedToBottom();
    return div;
  }

  function addEmptyStateIfNeeded() {
    if (feed.children.length) return;
    const div = document.createElement("div");
    div.className = "simplify-empty";
    div.textContent = "Ask anything. No settings, no models to pick. Just answers.";
    feed.appendChild(div);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }

  async function send() {
    if (sending) return;
    const message = (input.value || "").trim();
    if (!message) return;
    sending = true;
    sendBtn.disabled = true;
    input.value = "";
    autosize();

    addTurn("user", message);
    history.push({ role: "user", content: message });
    persistHistory();

    const assistantEl = addTurn("assistant", "");
    const cursor = document.createElement("span");
    cursor.className = "simplify-cursor";
    assistantEl.appendChild(cursor);
    let assistantText = "";

    currentAbort = new AbortController();
    let sawError = false;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history: history.slice(0, -1) }),
        signal: currentAbort.signal,
      });
      if (!res.ok || !res.body) {
        assistantEl.classList.add("simplify-error");
        assistantEl.textContent = "Something went wrong reaching the server (HTTP " + res.status + ").";
        sawError = true;
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              const m = /^data:\s?(.*)$/.exec(line.trim());
              if (!m) continue;
              let evt;
              try { evt = JSON.parse(m[1]); } catch { continue; }
              if (evt.type === "task" && evt.id) {
                // The server opened a durable record for this turn. Remember it, so closing the
                // panel or reloading the page can rejoin the answer instead of losing it.
                activeTaskId = String(evt.id);
                try { localStorage.setItem(LS_TASK, activeTaskId); } catch {}
              } else if (evt.type === "delta" && typeof evt.text === "string") {
                assistantText += evt.text;
                assistantEl.textContent = assistantText;
                assistantEl.appendChild(cursor);
                scrollFeedToBottom();
              } else if (evt.type === "notice" && evt.text) {
                addTurn("notice", evt.text);
              } else if (evt.type === "error") {
                sawError = true;
                if (!assistantText) {
                  assistantEl.classList.add("simplify-error");
                  assistantEl.textContent = evt.message || "The model didn't answer that time. Try again.";
                }
              }
              // {type:"route",...} is diagnostic only and deliberately never rendered — the surface
              // never shows which model answered.
            }
          }
        }
      }
    } catch (e) {
      if (e && e.name !== "AbortError") {
        assistantEl.classList.add("simplify-error");
        assistantEl.textContent = "Connection lost. Try again.";
        sawError = true;
      }
    } finally {
      cursor.remove();
      sending = false;
      sendBtn.disabled = false;
      currentAbort = null;
      if (!sawError && assistantText) { history.push({ role: "assistant", content: assistantText }); persistHistory(); }
      input.focus();
    }
  }

  /*
   * ---- rejoining an answer that kept working without you ----------------------------------------
   *
   * A Simplify turn is a durable task server-side, so closing the panel, switching to the Crucible,
   * or reloading the page no longer ends it. These three functions are how the answer finds its way
   * back to the person who asked for it.
   *
   * Replay is always from zero and REPLACES the rendered text, rather than splicing from an offset.
   * The main chat does the harder incremental thing because an 18-hour run cannot be re-sent; a
   * Simplify answer is one capped Haiku reply, so replaying it whole costs nothing and removes the
   * entire class of bug where a cursor lands mid-token-run and the text silently corrupts.
   */
  async function readSse(url, onEvent) {
    const res = await fetch(url, { headers: { accept: "text/event-stream" } });
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          const m = /^data:\s?(.*)$/.exec(line.trim());
          if (!m) continue;
          let evt; try { evt = JSON.parse(m[1]); } catch { continue; }
          onEvent(evt);
        }
      }
    }
    return true;
  }

  // Widening backoff, then a steady beat. A turn that is still running after two minutes is either
  // a long answer or a stuck one, and either way there is nothing to gain from asking every second.
  const RESUME_DELAYS = [1200, 2500, 5000, 9000, 15000];
  const resumeDelay = (attempt) => RESUME_DELAYS[Math.min(attempt, RESUME_DELAYS.length - 1)];

  async function resumeTask(id, attempt = 0) {
    if (!id) return;
    let el = document.querySelector("#simplify-feed .simplify-resumed");
    if (!el) { el = addTurn("assistant", ""); el.classList.add("simplify-resumed"); }
    let text = "", terminal = false, gone = false, errored = "";
    try {
      const ok = await readSse(`/api/simplify/attach?task=${encodeURIComponent(id)}&from=0`, (evt) => {
        if (evt.type === "delta" && typeof evt.text === "string") text += evt.text;
        else if (evt.type === "gone") { gone = true; terminal = true; }
        else if (evt.type === "done") terminal = true;
        else if (evt.type === "error") errored = evt.message || "That answer did not finish.";
        else if (evt.type === "reset") text = "";
      });
      if (!ok) throw new Error("attach unavailable");
    } catch {
      // The network, not the task. Keep trying: the answer is safe on the server either way.
      resumeTimer = setTimeout(() => resumeTask(id, attempt + 1), resumeDelay(attempt));
      return;
    }

    if (gone) { clearActiveTask(); el.remove(); return; }
    if (text) { el.textContent = text; scrollFeedToBottom(); }

    if (!terminal) {
      resumeTimer = setTimeout(() => resumeTask(id, attempt + 1), resumeDelay(attempt));
      return;
    }
    el.classList.remove("simplify-resumed");
    if (errored && !text) { el.classList.add("simplify-error"); el.textContent = errored; }
    else if (text) { history.push({ role: "assistant", content: text }); persistHistory(); }
    clearActiveTask();
  }

  function clearActiveTask() {
    activeTaskId = null;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    try { localStorage.removeItem(LS_TASK); } catch {}
  }

  /*
   * On open, the SERVER is the authority on what is outstanding, not localStorage. A turn started
   * on the phone and finished while the laptop was closed is invisible to this device's storage,
   * and that is exactly the case worth handling. The stored id is only a fast path for the common
   * same-device reopen.
   */
  async function reconcileTasks() {
    if (sending) return;
    let stored = null;
    try { stored = localStorage.getItem(LS_TASK); } catch {}
    let live = [], unseen = [];
    try {
      const res = await fetch("/api/simplify/tasks", { headers: { accept: "application/json" } });
      if (res.ok) { const j = await res.json(); live = j.live || []; unseen = j.unseen || []; }
    } catch {}
    const pick = live[0] || unseen[0] || (stored ? { id: stored } : null);
    if (pick && pick.id) resumeTask(pick.id, 0);
    else if (stored) clearActiveTask();
  }

  function buildPanel() {
    root = document.createElement("div");
    root.id = "simplify-root";
    root.hidden = true;
    root.innerHTML = `
      <div class="simplify-scanlines" aria-hidden="true"></div>
      <div class="simplify-vignette" aria-hidden="true"></div>
      <header class="simplify-bar">
        <span class="simplify-title">SIMPLIFY</span>
        <div class="simplify-swatches">
          <label class="simplify-swatch" title="Outline color">
            <span>LINE</span><input type="color" id="simplify-line-color" />
          </label>
          <label class="simplify-swatch" title="Text color">
            <span>TEXT</span><input type="color" id="simplify-text-color" />
          </label>
        </div>
        <button type="button" class="simplify-close" id="simplify-close" aria-label="Close">×</button>
      </header>
      <div class="simplify-feed" id="simplify-feed" role="log" aria-live="polite"></div>
      <form class="simplify-composer" id="simplify-composer">
        <textarea id="simplify-input" rows="1" placeholder="Ask anything…" aria-label="Message" autocomplete="off"></textarea>
        <button type="submit" class="simplify-send" id="simplify-send">SEND</button>
      </form>`;
    document.body.appendChild(root);

    feed = root.querySelector("#simplify-feed");
    input = root.querySelector("#simplify-input");
    sendBtn = root.querySelector("#simplify-send");
    form = root.querySelector("#simplify-composer");
    lineColorInput = root.querySelector("#simplify-line-color");
    textColorInput = root.querySelector("#simplify-text-color");

    lineColorInput.value = loadColor(LS_LINE, DEFAULT_LINE);
    textColorInput.value = loadColor(LS_TEXT, DEFAULT_TEXT);
    applyColors();
    lineColorInput.addEventListener("input", () => { applyColors(); saveColor(LS_LINE, lineColorInput.value); });
    textColorInput.addEventListener("input", () => { applyColors(); saveColor(LS_TEXT, textColorInput.value); });

    root.querySelector("#simplify-close").addEventListener("click", close);
    form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
    // Desktop (mouse) sends on Enter, same convention as the main composer; touch keeps Enter as
    // a newline and relies on the SEND button.
    const enterSends = !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && enterSends) { e.preventDefault(); send(); }
      if (e.key === "Escape") close();
    });
    input.addEventListener("input", autosize);

    history = loadHistory();
    for (const h of history) addTurn(h.role, h.content);
    addEmptyStateIfNeeded();
  }

  function open() {
    if (!root) buildPanel();
    root.hidden = false;
    // Two rAFs so the browser paints `hidden -> visible` before the opacity/transform transition
    // starts (the same reveal trick dominion-images.js uses for its own panel).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.add("simplify-open");
      input.focus();
    }));
    // Anything still running, or finished while this panel was shut, comes home now.
    void reconcileTasks();
  }

  function close() {
    if (!root) return;
    root.classList.remove("simplify-open");
    /*
     * Closing the panel used to abort the in-flight turn, which was the client half of the same
     * bug the server had: the answer died, the partial text went with it, and the turn was never
     * billed. The turn now runs to completion server-side and this just stops watching it. The
     * task id stays in localStorage, so reopening (or reloading, or another device) picks the
     * answer back up. See handleSimplifyAttach in server.mjs.
     */
    if (currentAbort) { try { currentAbort.abort("detach"); } catch {} }
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    const done = () => { root.hidden = true; };
    let fired = false;
    const onEnd = () => { if (fired) return; fired = true; root.removeEventListener("transitionend", onEnd); done(); };
    root.addEventListener("transitionend", onEnd);
    setTimeout(onEnd, 260);   // fallback if a transition is skipped (e.g. prefers-reduced-motion)
  }

  window.DominionSimplify = { open, close, isOpen: () => !!(root && !root.hidden) };
})();
