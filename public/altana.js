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
  el.addEventListener("click", (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); } });

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
