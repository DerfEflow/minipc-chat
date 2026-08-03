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
  return el;
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

function buildAskBody(question, doc) {
  return Object.assign({ question }, gatherContext(doc));
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

  state = { root, log, input, form, closeBtn, sending: false };
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

function appendMessage(doc, kind, text) {
  const state = panels.get(doc);
  if (!state || !text) return null;
  const row = doc.createElement("div");
  row.className = "altana-msg altana-msg-" + kind;
  row.textContent = String(text);
  state.log.append(row);
  return row;
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
 * One place applies a server response, whether it came from the first ask or from a confirmed
 * resend, so the two paths cannot drift apart. `requestBody` is threaded through purely so a NEW
 * confirmation (rare, but the contract allows it) can still resend the right thing.
 */
function handleAskResult(doc, data, requestBody) {
  if (data.reply) appendMessage(doc, "altana", data.reply);

  const actions = Array.isArray(data.clientActions) ? data.clientActions : [];
  for (const action of actions) {
    if (!action || !action.type) continue;
    dispatchAction(action, doc);
    if (action.type === "help") appendMessage(doc, "altana", action.text);
    else if (action.type === "work_list") appendWorkList(doc, action.items);
    else if (action.type === "echo_settings") appendMessage(doc, "system", "Checked your current settings.");
  }

  if (data.fallback && data.fallback.text) appendMessage(doc, "system", data.fallback.text);

  const blocked = Array.isArray(data.blocked) ? data.blocked : [];
  for (const b of blocked) {
    if (!b) continue;
    appendMessage(doc, "system", "Blocked: " + (b.tool || "a tool") + ". " + (b.reason || "no reason given") + ".");
  }

  const confirm = Array.isArray(data.confirm) ? data.confirm : [];
  for (const c of confirm) appendConfirm(doc, c, requestBody);
}

async function submitQuestion(doc, question) {
  const state = panels.get(doc);
  if (!state) return;
  appendMessage(doc, "user", question);
  state.sending = true;
  altanaState("thinking", doc);
  try {
    const body = buildAskBody(question, doc);
    const data = await postAsk(body);
    handleAskResult(doc, data, body);
  } catch {
    appendMessage(doc, "error", "I could not reach Altana just now. Please try again.");
  } finally {
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
