/*
 * ALTANA: presence layer. Mounts the floating face, animates her states, rotates her look.
 *
 * Fred, 2026-08-03: "I have an icon that can pop up when she is interacting... It can rotate
 * through these faces so that she always has a bit of a fresh look for the user every few times
 * that they log in, maybe every 10 times."
 *
 * SHIPPED DARK ON PURPOSE. Altana's reasoning side is Phase 4 and does not exist yet, and this
 * app already learned what happens when an impressive control opens onto nothing: the Knowledge
 * Vault showed every guest three buttons that opened three empty rooms. So `enabled` defaults to
 * false and altanaMount() is a no-op until it is turned on. The same disable-but-keep pattern
 * Fred approved for the forge dial: one named flag, off, with the reason written next to it.
 *
 * MOUNT POINT IS LOAD-BEARING. The element is appended to <body> and nowhere else, because a
 * position:fixed child of ANY transformed/filtered ancestor silently anchors to that ancestor
 * instead of the viewport. See the long note at the top of altana.css.
 */

export const ALTANA_FACES = ["aether", "cosmic", "verdant", "solar", "lunar", "crystal"];

// Glow colour per face, sampled from the artwork so the halo agrees with the eyes rather than
// washing a warm face in cold light.
const FACE_GLOW = {
  aether:  "rgba(96, 200, 255, .55)",
  cosmic:  "rgba(168, 130, 255, .55)",
  verdant: "rgba(140, 230, 110, .50)",
  solar:   "rgba(255, 205,  90, .55)",
  lunar:   "rgba(210, 225, 245, .48)",
  crystal: "rgba(120, 215, 255, .55)",
};

const SIGNINS_PER_FACE = 10;   // Fred: "maybe every 10 times"
const KEY_COUNT = "altana.signins";
const KEY_POS = "altana.pos";

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/*
 * Which face this sign-in gets. Deterministic from a counter rather than random, so a user
 * actually SEES all six over time instead of being handed the same two by chance, and so the face
 * cannot change mid-session (which would read as a glitch, not a flourish).
 *
 * The counter lives in localStorage, which makes it per-device: a user on a phone and a laptop can
 * see different faces on the same day. Harmless for something purely cosmetic, and noted here so
 * nobody later reports it as a bug. Moving it onto the user record is a small server change if the
 * inconsistency ever bothers anyone.
 */
export function faceForSignIn(count, faces = ALTANA_FACES) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return faces[Math.floor(n / SIGNINS_PER_FACE) % faces.length];
}

export function recordSignIn() {
  const next = (Number(store.get(KEY_COUNT, 0)) || 0) + 1;
  store.set(KEY_COUNT, next);
  return next;
}

/*
 * Keep the dot on screen. A remembered position is only valid for the viewport it was chosen in:
 * drag it to the far right on a desktop, reopen on a phone, and a naive restore puts it off the
 * edge where it can never be recovered. Clamped on every restore and every resize.
 */
function clamp(pos, size, pad = 8) {
  const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
  const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
  const maxX = Math.max(pad, vw - size - pad);
  const maxY = Math.max(pad, vh - size - pad);
  return { x: Math.min(Math.max(pad, pos.x), maxX), y: Math.min(Math.max(pad, pos.y), maxY) };
}

/*
 * Read a CSS custom property with a hard fallback. Everything the browser gives us for free is
 * optional here on purpose: this module is imported by altana_test.mjs in plain Node, and it is
 * also the kind of file that ends up in a worker or an SSR pass someday. A presence widget must
 * never be the thing that throws on load and takes a page down with it.
 */
function cssNumber(doc, name, fallback) {
  try {
    if (typeof getComputedStyle !== "function" || !doc.documentElement) return fallback;
    const v = parseInt(getComputedStyle(doc.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch { return fallback; }
}
const on = (target, ev, fn) => { try { if (target && typeof target.addEventListener === "function") target.addEventListener(ev, fn); } catch {} };

export function altanaMount(opts = {}) {
  const { enabled = false, doc = document, faces = ALTANA_FACES, assetBase = "/altana" } = opts;
  if (!enabled) return null;                       // dark until Phase 4 gives her something to do
  if (doc.getElementById("altana")) return doc.getElementById("altana");

  const signins = opts.signins != null ? opts.signins : recordSignIn();
  const face = faceForSignIn(signins, faces);

  const el = doc.createElement("button");
  el.id = "altana";
  el.type = "button";
  el.setAttribute("aria-label", "Altana, your assistant");
  el.dataset.face = face;
  el.style.setProperty("--altana-glow", FACE_GLOW[face] || FACE_GLOW.aether);
  el.setAttribute("data-enter", "");

  const halo = doc.createElement("span");
  halo.className = "altana-halo";
  const skin = doc.createElement("span");
  skin.className = "altana-face";
  // ONE face is fetched, never all six: preloading the set would cost ~750KB for five images the
  // user will not see for another ten sign-ins.
  skin.style.backgroundImage = `url("${assetBase}/altana-${face}.png")`;
  el.append(halo, skin);

  // Restore a dragged position, clamped. Absent one, the CSS resting corner applies untouched.
  const size = cssNumber(doc, "--altana-size", 56);
  const saved = store.get(KEY_POS, null);
  const place = (p) => { el.style.left = p.x + "px"; el.style.top = p.y + "px"; el.style.right = "auto"; el.style.bottom = "auto"; };
  if (saved && typeof saved.x === "number") place(clamp(saved, size));

  // ---- drag ---------------------------------------------------------------------------------
  // Fred's reason for a floating dot: "the user can then move it if they want to." A drag must
  // not also fire the click that opens her, so movement past a small threshold suppresses it.
  let dragging = false, moved = false, dx = 0, dy = 0;
  el.addEventListener("pointerdown", (e) => {
    dragging = true; moved = false;
    const r = el.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = clamp({ x: e.clientX - dx, y: e.clientY - dy }, size);
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) moved = true;
    place(p);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    if (moved) {
      const r = el.getBoundingClientRect();
      store.set(KEY_POS, { x: Math.round(r.left), y: Math.round(r.top) });
    }
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  // A click that follows a drag is the user parking the dot, not asking to talk to her. `moved`
  // already exists above for exactly this distinction; a click WITHOUT it opens the panel.
  el.addEventListener("click", (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); return; }
    try { togglePanel(doc); } catch {}
  });
  // The rescue hatch: double-click sends her home to the resting corner and forgets the saved
  // position. If a drag ever strands her somewhere unhelpful, this is the way back that needs
  // no settings screen and no reload.
  el.addEventListener("dblclick", (e) => {
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    try { altanaHome(doc); } catch {}
  });

  on(typeof window !== "undefined" ? window : null, "resize", () => {
    const r = el.getBoundingClientRect();
    if (el.style.left) place(clamp({ x: r.left, y: r.top }, size));
    altanaCheckAnchoring(doc);
  });

  /*
   * Stop animating in a tab nobody is looking at. Six-second breathing loops are cheap, but this
   * element exists on every screen for the whole session and a background tab should cost nothing.
   */
  on(doc, "visibilitychange", () => {
    el.style.animationPlayState = doc.hidden ? "paused" : "";
    for (const child of el.children) child.style.animationPlayState = doc.hidden ? "paused" : "";
  });

  // MOUNT ON BODY. Not into the app shell, not into a panel. See the header note.
  doc.body.appendChild(el);
  setTimeout(() => el.removeAttribute("data-enter"), 700);
  altanaCheckAnchoring(doc);

  /*
   * THE REMOUNT WATCHDOG. She mounts once, on body, and is supposed to exist on every screen
   * for the whole session - but any script that rebuilds body's children (a surface swap, a
   * future theme change, an overzealous cleanup) would silently delete her and nothing would
   * ever put her back ("not really showing up except once", Fred, 2026-08-04). If she leaves
   * the DOM without altanaMount asking, she is re-appended - same element, same face, same
   * position, so nothing visually restarts. MutationObserver only fires on real childList
   * changes; this costs nothing in the steady state.
   */
  try {
    if (typeof MutationObserver === "function") {
      const watchdog = new MutationObserver(() => {
        try {
          if (!doc.getElementById("altana") && doc.body) doc.body.appendChild(el);
          const panel = panels.get(doc);
          if (panel && !doc.getElementById("altana-panel") && doc.body) doc.body.appendChild(panel.root);
        } catch {}
      });
      watchdog.observe(doc.body, { childList: true });
    }
  } catch {}
  return el;
}

/*
 * Send the dot home: forget the remembered drag position and fall back to the CSS resting
 * corner. Exported for the double-click handler above and for anything else (a settings screen,
 * a help action) that wants a "bring her back" control.
 */
export function altanaHome(doc = document) {
  try { localStorage.removeItem(KEY_POS); } catch {}
  const el = doc.getElementById("altana");
  if (!el) return;
  el.style.left = ""; el.style.top = ""; el.style.right = ""; el.style.bottom = "";
}

/*
 * Runtime guard for the fixed-position trap (see header note). The CSS test pins the STATIC risk
 * (no transform on #altana itself); this catches the DYNAMIC risk: some other script wrapping
 * <body>, or a later stylesheet adding transform/filter/perspective/will-change/contain to an
 * ancestor after mount. `offsetParent` is null for a correctly-anchored `position: fixed` element
 * in every major engine; per spec it returns the trapping ancestor instead of null the moment one
 * exists, which is exactly the failure this guard is built to catch before Altana silently drifts
 * off her own dot.
 */
export function altanaCheckAnchoring(doc = document) {
  try {
    const el = doc.getElementById("altana");
    if (!el || typeof el.offsetParent === "undefined") return true; // nothing mounted, or a non-layout test stub
    const trapped = el.offsetParent !== null;
    if (trapped && typeof console !== "undefined" && console.warn) {
      console.warn(
        "[altana] position:fixed trap: #altana.offsetParent is",
        el.offsetParent,
        "instead of null. An ancestor now carries transform/filter/perspective/will-change/contain " +
        "and the dot will anchor to that ancestor instead of the viewport."
      );
    }
    return !trapped;
  } catch { return true; }
}

/*
 * State is a plain attribute so CSS owns every visual decision and this file never animates.
 * "attention" is deliberately self-clearing: a badge that pulses forever gets ignored, and then it
 * is worth nothing on the day it matters.
 */
export function altanaState(state, doc = document) {
  const el = doc.getElementById("altana");
  if (!el) return;
  if (!state || state === "idle") { el.removeAttribute("data-state"); return; }
  el.dataset.state = state;
  if (state === "attention") setTimeout(() => { if (el.dataset.state === "attention") el.removeAttribute("data-state"); }, 2900);
}

/*
 * ============================================================================================
 * THE PANEL: the conversation Altana opens into. Everything below is dark exactly as long as the
 * dot itself is dark, because none of it runs until a click reaches the handler above, and that
 * handler only exists on a mounted dot. Turning `enabled` on is still the only switch.
 *
 * THE ONE RULE THAT MATTERS MOST HERE: this file never marks a settings change, a screen change,
 * or anything else as done on its own say-so. The reply text is Altana's, but every side effect
 * she actually performed arrives as a `clientActions` entry, and this file's only job with those
 * is to dispatch `altana:action` on `document` (public/app.js listens and applies it) and, for the
 * three read-only kinds that carry their own payload, show that payload here too. Skipping the
 * dispatch would let her SAY a setting changed while nothing changed, which is the one outcome
 * this build is built to avoid.
 * ============================================================================================
 */

const ALTANA_ASK_URL = "/altana/ask";

/*
 * Optional integration point. This file does not own app state and does not reach into app.js
 * internals (a separate agent owns that file). If some other module wants to hand Altana real
 * surface/settings/activity, it can set `window.dominionAltanaContext = () => ({...})` any time
 * before a question is sent. Nothing here assumes it exists: as of this build no such hook is
 * wired up anywhere, so every field it would supply is simply absent, and absent is correct.
 * `screenTitle` still gets a real value from `document.title` even with no hook at all.
 */
function gatherContext(doc) {
  const out = {};
  try {
    const win = typeof window !== "undefined" ? window : null;
    if (win && typeof win.dominionAltanaContext === "function") {
      const c = win.dominionAltanaContext() || {};
      if (c.mode != null) out.mode = c.mode;
      if (c.privacyMode != null) out.privacyMode = c.privacyMode;
      if (c.surface != null) out.surface = c.surface;
      if (c.screenTitle != null) out.screenTitle = c.screenTitle;
      if (c.settings && typeof c.settings === "object") out.settings = c.settings;
      if (Array.isArray(c.activity)) out.activity = c.activity;
    }
  } catch {}
  try {
    if (out.screenTitle == null && doc && typeof doc.title === "string" && doc.title) out.screenTitle = doc.title;
  } catch {}
  try {
    if (out.surface == null && doc && doc.body && doc.body.dataset && doc.body.dataset.surface) out.surface = doc.body.dataset.surface;
  } catch {}
  return out;
}

/*
 * ALTANA HAD NO MEMORY BECAUSE NOBODY EVER SENT HER ANY (Fred, 2026-08-09: "It cant remember the
 * context of a conversation two responses before").
 *
 * The server has accepted `history` since the module was written — altana.messagesFor takes the
 * last 10 user/assistant turns and puts them ahead of the question. This function never sent the
 * field. Not truncated, not capped: absent. So every question arrived as the first thing she had
 * ever been asked, and the transcript on screen was a record only the human could read.
 *
 * That also silently disabled the complaint book, which is the second half of the same report ("it
 * says it will report issues to me, but it does not"). Her instructions say to offer to log a
 * problem and ASK BEFORE LOGGING, which is a two-turn handshake by construction: she asks, the user
 * says yes, she files it. With no history the second turn is the word "yes" attached to nothing, so
 * there was never anything to file. The complaints table has been empty since it was created.
 *
 * The history sent is what the user can already see in the panel, nothing more: her words and
 * theirs. System notices, errors and blocked-tool lines stay out, being the app talking about
 * itself rather than the conversation. Ten turns matches the server's own slice, so nothing is sent
 * that would only be thrown away.
 */
function buildAskBody(question, doc) {
  const body = Object.assign({ question }, gatherContext(doc));
  const state = panels.get(doc);
  const turns = state && Array.isArray(state.turns) ? state.turns.slice(-10) : [];
  if (turns.length) body.history = turns;
  return body;
}

/*
 * The only place a network call is made. Always POST, always JSON, never assumes the server
 * answered anything but 200 + JSON per the contract, and treats anything else (a thrown fetch, a
 * non-JSON body, a JSON body that is not an object) as one failure the caller handles the same way.
 */
async function postAsk(body) {
  const res = await fetch(ALTANA_ASK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data || typeof data !== "object") throw new Error("altana: malformed response");
  return data;
}

/*
 * Client-owned preferences and screens: the server does not hold them, so the only correct move
 * here is to relay the intent, verbatim, once per action, in order. public/app.js is the other
 * half of this contract and decides what each type means; this file does not interpret them.
 */
function dispatchAction(action, doc) {
  try { doc.dispatchEvent(new CustomEvent("altana:action", { detail: action })); } catch {}
}

/*
 * Hand a lookup's result back to her and let HER answer it.
 *
 * Without this, the raw tool output is what the user reads: a question about who built Dominion
 * returned two verbatim sections of the knowledge file, because the model asked for a document and
 * the panel handed the document to the human instead of to the model.
 *
 * Deliberately fire-and-forget. The first answer is already on screen, so if this second call
 * fails the user keeps what they had and loses only the polish. Failing loudly here would turn a
 * cosmetic problem into a broken turn.
 */
function answerFromLookup(doc, requestBody, lookups) {
  showThinking(doc);
  postAsk({ ...requestBody, toolResults: lookups })
    .then((data) => {
      hideThinking(doc);
      /*
       * THIS ROUND IS THE LAST ONE, SO IT HAS TO END IN WORDS (Fred, 2026-08-04, with a
       * screenshot: he asked how to connect GitHub and got "Looking that up in what I know."
       * twice and then nothing at all).
       *
       * The guard in handleAskResult deliberately refuses a third round, which is right: a
       * lookup loop that can re-arm itself is how a turn burns money forever. What was missing
       * is that the refusal was SILENT. If she comes back still asking to look something up,
       * the honest reading is that her notes do not cover it, and saying so is worth more than
       * a second copy of a placeholder followed by silence.
       */
      const stillLooking = Array.isArray(data && data.clientActions)
        && data.clientActions.some((a) => a && a.type === "help");
      const spoke = data && typeof data.reply === "string" && data.reply.trim();
      if (spoke && !stillLooking) appendMessage(doc, "altana", data.reply);
      else appendMessage(doc, "altana",
        "I looked, and I do not have anything solid on that in my notes yet, so I will not guess at it. "
        + "Ask me another way and I will try again, or tell me to pass it to Fred and I will log it for him.");
      if (data && data.fallback && data.fallback.text) appendMessage(doc, "system", data.fallback.text);
    })
    .catch(() => {
      hideThinking(doc);
      appendMessage(doc, "error", "I found the reference but could not finish reading it back. Ask me again?");
    })
    .finally(() => { hideThinking(doc); altanaState("idle", doc); });
}

const panels = new WeakMap();

function ensurePanel(doc) {
  let state = panels.get(doc);
  if (state) return state;

  const root = doc.createElement("div");
  root.id = "altana-panel";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Altana");

  const inner = doc.createElement("div");
  inner.className = "altana-panel-inner";

  const head = doc.createElement("div");
  head.className = "altana-panel-head";
  const title = doc.createElement("span");
  title.className = "altana-panel-title";
  title.textContent = "Altana";
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "altana-panel-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  head.append(title, closeBtn);

  const log = doc.createElement("div");
  log.className = "altana-panel-log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  const form = doc.createElement("form");
  form.className = "altana-panel-form";
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "altana-panel-input";
  input.setAttribute("aria-label", "Ask Altana");
  input.setAttribute("placeholder", "Ask Altana");
  const sendBtn = doc.createElement("button");
  sendBtn.type = "submit";
  sendBtn.className = "altana-panel-send";
  sendBtn.textContent = "Send";
  form.append(input, sendBtn);

  inner.append(head, log, form);
  root.append(inner);
  doc.body.appendChild(root);

  /*
   * `turns` is the conversation. Its absence was the whole of Fred's "it cant remember the context
   * of a conversation two responses before" (2026-08-09) — see buildAskBody.
   */
  state = { root, log, input, form, closeBtn, sending: false, turns: [] };
  panels.set(doc, state);

  closeBtn.addEventListener("click", () => { try { closePanel(doc); } catch {} });
  doc.addEventListener("keydown", (e) => {
    if (e && e.key === "Escape" && state.root.hidden === false) { try { closePanel(doc); } catch {} }
  });
  form.addEventListener("submit", (e) => {
    try { e.preventDefault(); } catch {}
    if (state.sending) return;
    const q = String(input.value || "").trim();
    if (!q) return;
    input.value = "";
    submitQuestion(doc, q);
  });

  return state;
}

function openPanel(doc) {
  const state = ensurePanel(doc);
  state.root.hidden = false;
  state.root.setAttribute("data-enter", "");
  setTimeout(() => { try { state.root.removeAttribute("data-enter"); } catch {} }, 320);
  try { state.input.focus(); } catch {}
  return state;
}
function closePanel(doc) {
  const state = panels.get(doc);
  if (!state) return;
  state.root.hidden = true;
}
function togglePanel(doc) {
  const state = panels.get(doc);
  if (state && state.root.hidden === false) closePanel(doc);
  else openPanel(doc);
}

// Keep the newest message in view. The log is a chat transcript, so a reply that lands below the
// fold reads as no reply at all. Guarded: the test DOM has no layout and no scroll properties.
function scrollLogToEnd(state) {
  try { if (state && state.log) state.log.scrollTop = state.log.scrollHeight; } catch {}
}

function appendMessage(doc, kind, text) {
  const state = panels.get(doc);
  if (!state || !text) return null;
  const row = doc.createElement("div");
  row.className = "altana-msg altana-msg-" + kind;
  row.textContent = String(text);
  state.log.append(row);
  /*
   * The transcript records itself here rather than at each call site, so a message that reaches the
   * screen by any path is a message she will remember, and one that never rendered can never be
   * claimed as said. Only the two conversational roles: "system", "error" and the blocked-tool
   * notices are the app narrating itself, and feeding those back would teach her to discuss her own
   * plumbing. Bounded at 20 so a long session cannot grow without limit; the send slices 10.
   */
  if (kind === "user" || kind === "altana") {
    state.turns.push({ role: kind === "user" ? "user" : "assistant", content: String(text).slice(0, 3000) });
    if (state.turns.length > 20) state.turns.splice(0, state.turns.length - 20);
  }
  scrollLogToEnd(state);
  // Anything SHE says lands with light. Her own words are the only thing worth flashing for:
  // a system note or an error already carries its own colour.
  if (kind === "altana") flashAnswer(doc);
  return row;
}

/*
 * THINKING IS SHOWN WHERE THE PERSON IS LOOKING (Fred, 2026-08-04: "there is also no progress
 * indicator about altana thinking about the query").
 *
 * The dot has always animated while she works, but on a phone the panel is a bottom sheet that
 * covers most of the screen and the dot sits behind or below it, so the one indicator that
 * existed was the one nobody could see. The transcript itself now carries the state: a row that
 * appears the moment a question is sent and is removed the moment anything real lands.
 *
 * It is a single row that is MOVED to the end rather than re-created, so a second round (the
 * knowledge lookup) does not stack two of them, and it can never be orphaned by an early return:
 * every send path clears it in a finally.
 */
function showThinking(doc) {
  const state = panels.get(doc);
  if (!state) return;
  if (!state.thinkingRow) {
    const row = doc.createElement("div");
    row.className = "altana-msg altana-msg-altana altana-thinking";
    row.setAttribute("data-testid", "altana-thinking");
    row.setAttribute("aria-live", "polite");
    row.textContent = "Thinking";
    const dots = doc.createElement("span");
    dots.className = "altana-thinking-dots";
    dots.setAttribute("aria-hidden", "true");
    row.append(dots);
    state.thinkingRow = row;
  }
  state.log.append(state.thinkingRow);   // append moves an existing node to the end
  scrollLogToEnd(state);
  altanaState("thinking", doc);
}

function hideThinking(doc) {
  const state = panels.get(doc);
  if (!state || !state.thinkingRow) return;
  try { state.thinkingRow.remove(); } catch {}
  state.thinkingRow = null;
}

// The arrival flash: the whole card catches light for a moment when an answer lands, so an answer
// that arrives while the person is looking elsewhere still announces itself.
function flashAnswer(doc) {
  const state = panels.get(doc);
  if (!state) return;
  try {
    state.root.setAttribute("data-answered", "");
    setTimeout(() => { try { state.root.removeAttribute("data-answered"); } catch {} }, 900);
  } catch {}
}

function appendWorkList(doc, items) {
  const state = panels.get(doc);
  if (!state) return;
  const list = Array.isArray(items) ? items : [];
  const row = doc.createElement("div");
  row.className = "altana-msg altana-msg-altana altana-worklist";
  const label = doc.createElement("div");
  label.className = "altana-worklist-label";
  label.textContent = list.length ? "Open items" : "No open items.";
  row.append(label);
  if (list.length) {
    const ul = doc.createElement("ul");
    ul.className = "altana-worklist-items";
    for (const it of list) {
      const li = doc.createElement("li");
      li.textContent = String((it && it.title) || "(untitled)");
      ul.append(li);
    }
    row.append(ul);
  }
  state.log.append(row);
}

/*
 * The confirmation round-trip. `entry.token` is never sent anywhere except from inside this Yes
 * handler, and only once, and only for the exact entry the user clicked. `originalBody` is the
 * whole request object from the ask that produced this confirmation, captured by closure at the
 * moment it arrived; resending it with `confirm` added is what makes the resend IDENTICAL rather
 * than a fresh guess at what the user meant.
 */
function appendConfirm(doc, entry, originalBody) {
  const state = panels.get(doc);
  if (!state || !entry) return;
  const row = doc.createElement("div");
  row.className = "altana-msg altana-msg-confirm";
  const q = doc.createElement("div");
  q.className = "altana-confirm-q";
  q.textContent = String(entry.question || "Confirm this action?");
  const actions = doc.createElement("div");
  actions.className = "altana-confirm-actions";
  const yes = doc.createElement("button");
  yes.type = "button"; yes.className = "altana-confirm-yes"; yes.textContent = "Yes";
  const no = doc.createElement("button");
  no.type = "button"; no.className = "altana-confirm-no"; no.textContent = "No";
  yes.addEventListener("click", () => {
    yes.disabled = true; no.disabled = true;
    row.className += " altana-confirm-done";
    confirmAction(doc, originalBody, entry.token);
  });
  no.addEventListener("click", () => {
    yes.disabled = true; no.disabled = true;
    row.className += " altana-confirm-done";
    appendMessage(doc, "system", "Cancelled.");
  });
  actions.append(yes, no);
  row.append(q, actions);
  state.log.append(row);
}

/*
 * THE TYPED CONFIRMATION FIELD (Fred, 2026-08-12: "a 'please type the amount of credits you would
 * like to purchase' field that it follows", and "a 'type #####' to confirm field").
 *
 * This is deliberately NOT the Yes/No row above, and the difference is the entire safety argument for
 * letting an assistant near money. A Yes button authorises whatever sentence is next to it, so the
 * number would still be the model's number and the click would only be agreement. A text box cannot
 * be satisfied by agreement: the value has to come from the user's own hands, so the model never
 * chooses the figure and no fetched page or uploaded document can supply it either.
 *
 * The server has already written a single-use row for this nonce. Nothing has been charged and
 * nothing has been switched; all that exists at this moment is a question and an empty box.
 */
function appendTypedConfirm(doc, request, originalBody) {
  const state = panels.get(doc);
  if (!state || !request || !request.nonce) return;

  const row = doc.createElement("div");
  row.className = "altana-msg altana-msg-typed";

  const q = doc.createElement("div");
  q.className = "altana-typed-q";
  q.textContent = String(request.prompt || "Type the value to confirm.");
  row.append(q);

  /*
   * The five digit number, shown big enough to read and copy by eye. It is not a secret and does not
   * need to be: it is proof that a human read this specific sentence on this specific screen.
   */
  if (request.kind === "code" && request.code) {
    const code = doc.createElement("div");
    code.className = "altana-typed-code";
    code.textContent = String(request.code);
    row.append(code);
  }

  // What this actually costs them, stated before they type rather than discovered afterwards.
  if (request.context) {
    const note = doc.createElement("div");
    note.className = "altana-typed-note";
    note.textContent = String(request.context);
    row.append(note);
  }
  if (request.hint) {
    const hint = doc.createElement("div");
    hint.className = "altana-typed-hint";
    hint.textContent = String(request.hint);
    row.append(hint);
  }

  const form = doc.createElement("form");
  form.className = "altana-typed-form";
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "altana-typed-input";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-label", String(request.prompt || "Type to confirm"));
  input.placeholder = String(request.placeholder || "");
  if (request.kind === "code") {
    // A numeric keypad on a phone, and only digits, because the answer is only ever digits.
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("maxlength", "5");
  } else {
    input.setAttribute("inputmode", "decimal");
    input.setAttribute("maxlength", "12");
  }
  const go = doc.createElement("button");
  go.type = "submit";
  go.className = "altana-typed-go";
  go.textContent = request.kind === "code" ? "Confirm" : "Add credits";
  const no = doc.createElement("button");
  no.type = "button";
  no.className = "altana-typed-no";
  no.textContent = "Cancel";

  const done = (msg) => {
    input.disabled = true; go.disabled = true; no.disabled = true;
    row.className += " altana-typed-done";
    if (msg) appendMessage(doc, "system", msg);
  };

  form.addEventListener("submit", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const value = String(input.value || "").trim();
    if (!value) { input.focus(); return; }
    /*
     * The row is disabled the moment it is submitted. The server refuses a replay anyway, on a stored
     * single-use flag stamped before the money moves, so this is politeness rather than protection:
     * the user should not be able to sit there clicking a button that can only ever work once.
     */
    input.disabled = true; go.disabled = true; no.disabled = true;
    row.className += " altana-typed-sent";
    submitTyped(doc, request, value, originalBody, row);
  });
  no.addEventListener("click", () => done("Cancelled. Nothing was charged and nothing was changed."));

  form.append(input, go, no);
  row.append(form);
  state.log.append(row);
  scrollLogToEnd(state);
  try { input.focus(); } catch {}
}

/*
 * Send the typed value back. The nonce identifies the stored authorisation, so this carries no
 * amount-bearing state of its own that could be edited on the way past: the server decides against
 * its own row, and a value that fails validation leaves that row unspent so the user gets another go.
 */
async function submitTyped(doc, request, value, originalBody, row) {
  const state = panels.get(doc);
  if (!state) return;
  state.sending = true;
  altanaState("thinking", doc);
  try {
    const body = Object.assign({}, originalBody, { typed: { nonce: request.nonce, value } });
    const data = await postAsk(body);
    if (data && data.reply) appendMessage(doc, "altana", data.reply);
    /*
     * A RETRYABLE REFUSAL puts the field back rather than making them start the conversation over. A
     * mistyped code and an amount under the floor are both ordinary human misses, and a dead end
     * there is the difference between a helpful assistant and an obstacle.
     */
    if (data && data.retry) {
      appendTypedConfirm(doc, request, originalBody);
    } else if (data && data.checkoutUrl) {
      // First purchase, no card on file. The card is entered on the app's own payment page, never here.
      appendMessage(doc, "system", "Opening the secure payment page.");
      try { window.location.href = data.checkoutUrl; } catch {}
    }
    for (const a of (Array.isArray(data && data.clientActions) ? data.clientActions : [])) dispatchAction(a, doc);
  } catch {
    appendMessage(doc, "error", "I could not finish that just now. Nothing was charged. Please try again.");
  } finally {
    state.sending = false;
    altanaState("idle", doc);
    if (row) row.className += " altana-typed-done";
  }
}

/*
 * One place applies a server response, whether it came from the first ask or from a confirmed
 * resend, so the two paths cannot drift apart. `requestBody` is threaded through purely so a NEW
 * confirmation (rare, but the contract allows it) can still resend the right thing.
 */
function handleAskResult(doc, data, requestBody) {
  if (data.reply) appendMessage(doc, "altana", data.reply);

  /*
   * A PROMISE BEING KEPT. Fred resolved a ticket, and the sentence written when it was filed is
   * delivered here, on the user's next turn, which is the only moment we know they are present to
   * read it. The server marked it sent before handing it over, so a reload cannot repeat it.
   */
  for (const f of (Array.isArray(data.followUps) ? data.followUps : [])) {
    if (f && f.text) appendMessage(doc, "altana", f.text);
  }

  /*
   * AN ACTION IS NOT A LOOKUP, AND THEY MUST NOT BE SHOWN THE SAME WAY.
   *
   * "Switch to dark mode" produces an ACTION. Nothing to read; the sentence the server wrote
   * already says what happened, and rendering the action too would just repeat it.
   *
   * "Who made Dominion?" produces a LOOKUP. Its result is a slab of the knowledge file, and this
   * used to be appended to the transcript verbatim. Fred asked her who made Dominion and got two
   * raw markdown sections about reliability and complaints, because the model never saw what the
   * tool found. It called search_help, the server answered with the document, and the panel
   * printed it.
   *
   * The server already accepts `toolResults` and folds them back through wrapToolResult. The loop
   * existed and nothing closed it. So a lookup now goes BACK to her: same question, tool result
   * attached, and her answer replaces the raw text. One extra second on Luna, and she speaks in
   * her own words instead of handing over a document.
   */
  const actions = Array.isArray(data.clientActions) ? data.clientActions : [];
  const lookups = [];
  for (const action of actions) {
    if (!action || !action.type) continue;
    dispatchAction(action, doc);
    // A DOCUMENT goes back to her. A LIST is drawn, because the user's own saved work is something
    // to look at rather than something for a model to summarise back at them.
    // A lookup that found nothing is not worth a second round trip: the server has already said
    // so in words, and feeding a model an empty document only buys latency and a repeat.
    if (action.type === "help" && action.found !== false && String(action.text || "").trim()) {
      lookups.push({ name: "search_help", result: action.text });
    }
    else if (action.type === "work_list") appendWorkList(doc, action.items);
    else if (action.type === "echo_settings") appendMessage(doc, "system", "Checked your current settings.");
    /*
     * A REGISTRY TOOL'S RESULT GOES BACK TO HER, the same round trip a knowledge lookup already
     * takes. She now holds the app's own verbs, and their results are raw data written for a machine,
     * so printing one into the panel would be exactly the technical spill Fred asked her never to
     * produce. Sending it back means she reads it and answers in her own words.
     */
    else if (action.type === "tool_result" && String(action.result || "").trim()) {
      lookups.push({ name: String(action.name || "tool"), result: String(action.result) });
    }
    else if (action.type === "ticket_list") appendTicketList(doc, action.items);
    else if (action.type === "open_url" && action.url) {
      try { window.location.href = String(action.url); } catch {}
    }
  }
  if (lookups.length && requestBody && !requestBody.toolResults) {
    // Guard on toolResults so a follow-up can never trigger another follow-up.
    answerFromLookup(doc, requestBody, lookups);
  }

  if (data.fallback && data.fallback.text) appendMessage(doc, "system", data.fallback.text);

  const blocked = Array.isArray(data.blocked) ? data.blocked : [];
  for (const b of blocked) {
    if (!b) continue;
    appendMessage(doc, "system", "Blocked: " + (b.tool || "a tool") + ". " + (b.reason || "no reason given") + ".");
  }

  const confirm = Array.isArray(data.confirm) ? data.confirm : [];
  for (const c of confirm) appendConfirm(doc, c, requestBody);

  // A field for the user to type into. Drawn last so it is the thing under their cursor.
  const typed = Array.isArray(data.typedConfirm) ? data.typedConfirm : [];
  for (const tc of typed) appendTypedConfirm(doc, tc, requestBody);
}

/* The problems this user has reported, and where each one has got to. */
function appendTicketList(doc, items) {
  const state = panels.get(doc);
  if (!state) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const wrap = doc.createElement("div");
  wrap.className = "altana-msg altana-msg-tickets";
  for (const t of list.slice(0, 10)) {
    const row = doc.createElement("div");
    row.className = "altana-ticket-row";
    const what = doc.createElement("span");
    what.className = "altana-ticket-what";
    what.textContent = String((t && t.what) || "Something you reported");
    const status = doc.createElement("span");
    status.className = "altana-ticket-status altana-ticket-" + String((t && t.status) || "open");
    // Plain words, never the internal state name. "escalated" means nothing to a customer.
    status.textContent = t && t.status === "resolved" ? "Sorted"
      : t && t.status === "escalated" ? "With Fred now"
        : "Being looked at";
    row.append(what, status);
    wrap.append(row);
  }
  state.log.append(wrap);
  scrollLogToEnd(state);
}

async function submitQuestion(doc, question) {
  const state = panels.get(doc);
  if (!state) return;
  /*
   * BUILT BEFORE THE QUESTION IS APPENDED, and the order is load-bearing. appendMessage is what
   * records a turn now, and the server puts `question` after `history` itself — building the body
   * afterwards would send this question twice and have her answer her own echo.
   */
  const body = buildAskBody(question, doc);
  appendMessage(doc, "user", question);
  state.sending = true;
  showThinking(doc);
  try {
    const data = await postAsk(body);
    hideThinking(doc);
    handleAskResult(doc, data, body);
  } catch {
    hideThinking(doc);
    appendMessage(doc, "error", "I could not reach Altana just now. Please try again.");
  } finally {
    hideThinking(doc);   // belt and braces: the row can never outlive the turn
    state.sending = false;
    altanaState("idle", doc);
  }
}

async function confirmAction(doc, originalBody, token) {
  const state = panels.get(doc);
  if (!state) return;
  state.sending = true;
  altanaState("thinking", doc);
  try {
    const body = Object.assign({}, originalBody, { confirm: [token] });
    const data = await postAsk(body);
    handleAskResult(doc, data, originalBody);
  } catch {
    appendMessage(doc, "error", "I could not confirm that action. Please try again.");
  } finally {
    state.sending = false;
    altanaState("idle", doc);
  }
}
