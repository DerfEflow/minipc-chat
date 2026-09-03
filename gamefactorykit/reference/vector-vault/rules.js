/*
 * gamefactorykit/reference/vector-vault/rules.js -- Vector Vault, the hand-written reference game
 * for the Game Kit contract (GAME-FACTORY-BUILD.md section 2). Pure deterministic game logic: no
 * DOM, no Date.now()/Math.random() in gameplay math, no imports except ./content.js. `seed` is
 * accepted (per the kit contract) and stored on state for API fidelity, but this game does not
 * need randomness -- every level is a fixed vector-sum puzzle, so seed is unused past createState.
 *
 * THE MECHANIC: each level has a `start` point and N vectors (angle in 5-degree steps, magnitude
 * 1..5). The player edits vectors, then `launch` walks the path start -> start+v0 -> +v1 -> ...
 * segment by segment. If any segment crosses a wall (an axis-aligned rectangle), the launch is
 * blocked. Otherwise, if the final point lands within the vault's tolerance radius, it's a win.
 *
 * ACTION MODEL: applyAction is a single pure dispatcher (see computeAction below) wrapped by one
 * piece of bookkeeping every legal action shares: an undo history stack, and a one-time
 * "vault_start" analytics event fired on the first legal action taken against a freshly created
 * state (tracked via state.started). See the History design note above computeAction for exactly
 * how undo reconstructs the prior state (this is the part that makes "undo after one action
 * restores the prior serialized state" true by construction, not by luck).
 */
import content from "./content.js";

export const meta = {
  slug: "vector-vault",
  name: "Vector Vault",
  schemaVersion: 1,
  actions: [
    { type: "select_vector", params: ["index"] },
    { type: "rotate", params: ["delta"] },
    { type: "magnitude", params: ["delta"] },
    { type: "launch", params: [] },
    { type: "undo", params: [] },
    { type: "restart", params: [] },
    { type: "hint", params: [] },
    { type: "next", params: [] },
    { type: "select_level", params: ["index"] },
  ],
  // "gesture" classes are the ones a real touch UI needs an on-screen step-control alternative
  // for (drag-to-rotate, pinch-to-scale, tap-to-select, tap-to-launch, plus the three utility
  // buttons); `next` and `select_level` are contextual/menu actions, not continuous gameplay
  // gestures, so the controls suite does not require a permanent bottom-bar button for them (see
  // qa/run.mjs's "controls" suite and NON_GESTURE_ACTIONS below -- both lists must agree).
  events: ["vault_start", "vector_adjust", "hint_used", "launch_result", "vault_complete", "session_end"],
};

const HISTORY_CAP = 20;
const ANGLE_STEP = 5;
const MAG_MIN = 1, MAG_MAX = 5;

// -- geometry -----------------------------------------------------------------------------------

function computePath(start, vectors) {
  const pts = [{ x: start.x, y: start.y }];
  let cur = { x: start.x, y: start.y };
  for (const v of vectors) {
    const rad = (v.angle * Math.PI) / 180;
    cur = { x: cur.x + v.magnitude * Math.cos(rad), y: cur.y + v.magnitude * Math.sin(rad) };
    pts.push({ x: cur.x, y: cur.y });
  }
  return pts;
}

// Liang-Barsky segment-vs-axis-aligned-rectangle intersection: parametrize the segment as
// P(t) = P0 + t*(P1-P0), t in [0,1], and clip against the rectangle's four half-planes. If a
// non-empty t-range survives every clip, the segment touches, crosses, or starts/ends inside the
// (filled) rectangle. Standard, robust, no special-casing needed for axis-aligned rects.
function segmentIntersectsRect(x0, y0, x1, y1, rx, ry, rw, rh) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rx, rx + rw - x0, y0 - ry, ry + rh - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; else if (r > t0) t0 = r; }
      else { if (r < t0) return false; else if (r < t1) t1 = r; }
    }
  }
  return true;
}

function pathBlocked(path, walls) {
  for (let i = 0; i < path.length - 1; i++) {
    for (const w of walls) {
      if (segmentIntersectsRect(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y, w.x, w.y, w.w, w.h)) return true;
    }
  }
  return false;
}

function normalizeAngle(a) {
  const wrapped = ((a % 360) + 360) % 360;
  const snapped = Math.round(wrapped / ANGLE_STEP) * ANGLE_STEP;
  return snapped >= 360 ? 0 : snapped;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function levelAt(index) { return content.levels[index]; }

// -- state ----------------------------------------------------------------------------------------

export function createState({ levelIndex = 0, seed = 1 } = {}) {
  const count = content.levels.length;
  let idx = Math.trunc(levelIndex);
  if (!Number.isFinite(idx)) idx = 0;
  idx = clamp(idx, 0, count - 1);
  const level = levelAt(idx);
  return {
    schemaVersion: 1,
    levelIndex: idx,
    levelId: level.id,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : 1,
    vectors: level.vectors.map((v) => ({ angle: v.angle, magnitude: v.magnitude })),
    selected: 0,
    launchesUsed: 0,
    status: "playing",
    lastResult: null,
    started: false,
    history: [],
  };
}

export function status(state) { return state.status; }
export function levelCount() { return content.levels.length; }

// serialize/deserialize: full save fidelity, including the undo history (bounded to HISTORY_CAP
// entries so this never grows unbounded -- see the performance suite's 64KB budget).
export function serialize(state) { return JSON.stringify(state); }

export function deserialize(text) {
  const obj = JSON.parse(text); // throws SyntaxError on truncated/empty/garbage input -- that IS the corruption signal the kit's storage adapter catches
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("deserialize: not a state object");
  // A v0 save (pre-dating schemaVersion) is treated as corruption rather than migrated: the kit
  // contract allows either choice, and there is no v0 shape in this game's history to migrate
  // from, so throwing (letting the kit fall back to a fresh state) is the honest option.
  if (typeof obj.schemaVersion !== "number") throw new Error("deserialize: missing schemaVersion (unmigrated v0 save)");
  if (obj.schemaVersion !== 1) throw new Error("deserialize: unsupported schemaVersion " + obj.schemaVersion);
  const problem = validate(obj);
  if (problem !== true) throw new Error("deserialize: invalid state (" + problem + ")");
  return obj;
}

export function validate(state) {
  if (!state || typeof state !== "object") return "not an object";
  if (!Number.isInteger(state.levelIndex) || state.levelIndex < 0 || state.levelIndex >= content.levels.length) return "bad levelIndex";
  const level = levelAt(state.levelIndex);
  if (state.levelId !== level.id) return "levelId does not match levelIndex";
  if (!Array.isArray(state.vectors) || state.vectors.length !== level.vectors.length) return "bad vectors length";
  for (const v of state.vectors) {
    if (!v || typeof v.angle !== "number" || v.angle < 0 || v.angle >= 360 || v.angle % ANGLE_STEP !== 0) return "bad vector angle";
    if (!Number.isInteger(v.magnitude) || v.magnitude < MAG_MIN || v.magnitude > MAG_MAX) return "bad vector magnitude";
  }
  if (!Number.isInteger(state.selected) || state.selected < 0 || state.selected >= state.vectors.length) return "bad selected index";
  if (!["playing", "won", "lost"].includes(state.status)) return "bad status";
  if (!Number.isInteger(state.launchesUsed) || state.launchesUsed < 0) return "bad launchesUsed";
  if (typeof state.started !== "boolean") return "bad started flag";
  if (!Array.isArray(state.history) || state.history.some((h) => typeof h !== "string")) return "bad history";
  if (state.history.length > HISTORY_CAP) return "history exceeds cap";
  return true;
}

// -- layout / input --------------------------------------------------------------------------------

// Fixed control set, independent of the current level or state (layout's signature is (w,h) only,
// per the kit contract, so it cannot know how many vectors the CURRENT level has). "prev_vector"
// and "next_vector" use select_vector's index field as a relative-step sentinel: -1 = cycle to the
// next vector, -2 = cycle to the previous one (real indices are always >= 0, so these two negative
// values are unambiguous and never collide with a legitimate direct index).
const CONTROL_DEFS = [
  { id: "prev_vector", label: "< Vec", action: { type: "select_vector", index: -2 } },
  { id: "next_vector", label: "Vec >", action: { type: "select_vector", index: -1 } },
  { id: "rotate_ccw", label: "Rot -", action: { type: "rotate", delta: -ANGLE_STEP } },
  { id: "rotate_cw", label: "Rot +", action: { type: "rotate", delta: ANGLE_STEP } },
  { id: "mag_down", label: "Mag -", action: { type: "magnitude", delta: -1 } },
  { id: "mag_up", label: "Mag +", action: { type: "magnitude", delta: 1 } },
  { id: "launch", label: "Launch", action: { type: "launch" } },
  { id: "undo", label: "Undo", action: { type: "undo" } },
  { id: "restart", label: "Restart", action: { type: "restart" } },
  { id: "hint", label: "Hint", action: { type: "hint" } },
];
// Every gesture-class action type declared in meta.actions must have a control here (checked by
// the QA "controls" suite); next/select_level are the two deliberate, documented exceptions.
export const NON_GESTURE_ACTIONS = ["next", "select_level"];

export function layout(width, height) {
  const pad = 8;
  const cols = 5, rows = 2, btnH = 48;
  const barH = rows * btnH + (rows + 1) * pad;
  const boardH = Math.max(0, height - barH);
  const boardSide = Math.max(0, Math.min(width, boardH) - pad * 2);
  const board = { x: (width - boardSide) / 2, y: pad, w: boardSide, h: boardSide };
  const btnW = (width - pad * (cols + 1)) / cols;
  const controls = CONTROL_DEFS.map((c, i) => {
    const row = Math.floor(i / cols), col = i % cols;
    return { id: c.id, label: c.label, action: c.action, x: pad + col * (btnW + pad), y: boardH + pad + row * (btnH + pad), w: btnW, h: btnH };
  });
  return { board, controls };
}

export function actionForPointer(state, layoutInfo, pointer) {
  if (!pointer || pointer.type !== "down") return null; // only the initial touch/click fires an action, not move/up (avoids repeat-fire during a drag)
  const { x, y } = pointer;
  for (const c of layoutInfo.controls) {
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return { ...c.action };
  }
  return null;
}

const KEY_MAP = {
  ArrowLeft: { type: "rotate", delta: -ANGLE_STEP },
  ArrowRight: { type: "rotate", delta: ANGLE_STEP },
  ArrowUp: { type: "magnitude", delta: 1 },
  ArrowDown: { type: "magnitude", delta: -1 },
  " ": { type: "launch" },
  Enter: { type: "launch" },
  // Escape maps to undo (the "back out of my last move" reading), distinct from 'r' (full restart).
  Escape: { type: "undo" },
  u: { type: "undo" }, U: { type: "undo" },
  r: { type: "restart" }, R: { type: "restart" },
  h: { type: "hint" }, H: { type: "hint" },
  Tab: { type: "select_vector", index: -1 },
};

export function actionForKey(state, key) {
  const action = KEY_MAP[key];
  return action ? { ...action } : null;
}

// -- hint -------------------------------------------------------------------------------------------

// Deterministic: walks the level's precomputed `solution` array against the current vectors, finds
// the first vector that does not yet match, and returns the single step needed to move toward it
// (select it if it is not the current selection, else nudge its angle or magnitude one step closer
// -- angle first, then magnitude, using the shortest circular direction for angle). Once every
// vector matches the solution, suggests `launch`. Returns null only when there is nothing to
// suggest (status is not "playing").
export function hint(state) {
  if (state.status !== "playing") return null;
  const level = levelAt(state.levelIndex);
  const sol = level.solution;
  for (let i = 0; i < sol.length; i++) {
    const cur = state.vectors[i], target = sol[i];
    if (cur.angle === target.angle && cur.magnitude === target.magnitude) continue;
    if (state.selected !== i) return { type: "select_vector", index: i };
    if (cur.angle !== target.angle) {
      // shortest signed direction around the circle, in (-180, 180]
      const diff = ((target.angle - cur.angle + 540) % 360) - 180;
      return { type: "rotate", delta: diff > 0 ? ANGLE_STEP : -ANGLE_STEP };
    }
    return { type: "magnitude", delta: target.magnitude > cur.magnitude ? 1 : -1 };
  }
  return { type: "launch" };
}

// -- action dispatch ----------------------------------------------------------------------------------

// History design: `snapshotForHistory` strips the `history` field itself before stringifying, so
// the stack never nests copies of itself. On every LEGAL action, applyAction pushes a snapshot of
// the state exactly as it was BEFORE this action (not after any bookkeeping), so `undo` restores
// that literal prior state (including whatever `started`/`history` it actually had) -- see the
// worked proof in the lane report / gamefactorykit_test.mjs for why this makes two consecutive
// undos exactly invert two consecutive actions.
function snapshotForHistory(state) {
  const { history, ...rest } = state;
  return JSON.stringify(rest);
}

// computeAction returns null for an illegal/no-op action, or { patch } | { replacement } plus
// `events` for a legal one. It never touches started/history bookkeeping -- applyAction (the
// exported function) owns that, uniformly, for every legal action.
function computeAction(state, action) {
  switch (action.type) {
    case "select_vector": {
      const n = state.vectors.length;
      let idx = action.index;
      if (idx === -1) idx = (state.selected + 1) % n;
      else if (idx === -2) idx = (state.selected - 1 + n) % n;
      else if (!Number.isInteger(idx) || idx < 0 || idx >= n) return null;
      if (idx === state.selected) return null;
      return { patch: { selected: idx }, events: [] };
    }
    case "rotate": {
      if (state.status !== "playing") return null;
      const delta = Number(action.delta);
      if (!Number.isFinite(delta) || delta === 0) return null;
      const cur = state.vectors[state.selected];
      const newAngle = normalizeAngle(cur.angle + delta);
      if (newAngle === cur.angle) return null;
      const vectors = state.vectors.slice();
      vectors[state.selected] = { ...cur, angle: newAngle };
      return { patch: { vectors }, events: [{ name: "vector_adjust", props: { vector_index: state.selected, kind: "rotate", value: newAngle } }] };
    }
    case "magnitude": {
      if (state.status !== "playing") return null;
      const delta = Number(action.delta);
      if (!Number.isFinite(delta) || delta === 0) return null;
      const cur = state.vectors[state.selected];
      const newMag = clamp(cur.magnitude + Math.trunc(delta), MAG_MIN, MAG_MAX);
      if (newMag === cur.magnitude) return null;
      const vectors = state.vectors.slice();
      vectors[state.selected] = { ...cur, magnitude: newMag };
      return { patch: { vectors }, events: [{ name: "vector_adjust", props: { vector_index: state.selected, kind: "magnitude", value: newMag } }] };
    }
    case "launch": {
      if (state.status !== "playing") return null;
      const level = levelAt(state.levelIndex);
      const path = computePath(level.start, state.vectors);
      const blocked = pathBlocked(path, level.walls);
      const end = path[path.length - 1];
      const dist = Math.hypot(end.x - level.vault.x, end.y - level.vault.y);
      const hitVault = !blocked && dist <= level.vault.tolerance;
      const launchesUsed = state.launchesUsed + 1;
      let newStatus = "playing", result;
      if (hitVault) { newStatus = "won"; result = "hit"; }
      else {
        result = blocked ? "blocked" : "miss";
        newStatus = launchesUsed >= level.maxLaunches ? "lost" : "playing";
      }
      const events = [{ name: "launch_result", props: { result, launches_used: launchesUsed } }];
      if (newStatus === "won") events.push({ name: "vault_complete", props: { level_id: level.id, launches_used: launchesUsed } });
      return { patch: { launchesUsed, status: newStatus, lastResult: result }, events };
    }
    case "restart": {
      const fresh = createState({ levelIndex: state.levelIndex, seed: state.seed });
      return { replacement: fresh, events: [] };
    }
    case "next": {
      if (state.status !== "won") return null;
      const nextIndex = state.levelIndex + 1;
      if (nextIndex >= content.levels.length) return null; // capped: no wraparound past the last level
      return { replacement: createState({ levelIndex: nextIndex, seed: state.seed }), events: [] };
    }
    case "select_level": {
      const idx = action.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= content.levels.length) return null;
      return { replacement: createState({ levelIndex: idx, seed: state.seed }), events: [] };
    }
    case "hint": {
      const suggestion = hint(state);
      if (!suggestion) return null;
      const inner = computeAction(state, suggestion);
      if (!inner) return null; // hint suggested something that turned out to be illegal (should not happen, but stay honest)
      const hintEvent = { name: "hint_used", props: { step: suggestion.type } };
      return { ...inner, events: [...inner.events, hintEvent] };
    }
    case "undo":
      // handled entirely in applyAction (it pops history rather than pushing to it)
      return null;
    default:
      return null;
  }
}

export function applyAction(state, action) {
  if (!state || typeof state !== "object" || !action || typeof action.type !== "string") return { state, events: [] };

  if (action.type === "undo") {
    if (!Array.isArray(state.history) || state.history.length === 0) return { state, events: [] };
    const hist = state.history.slice();
    const snap = hist.pop();
    let restored;
    try { restored = JSON.parse(snap); } catch { return { state, events: [] }; } // defensive; snap was produced by our own serializer, should never actually throw
    restored.history = hist;
    return { state: restored, events: [] };
  }

  const result = computeAction(state, action);
  if (!result) return { state, events: [] };

  const events = [];
  const startingLevelId = result.replacement ? result.replacement.levelId : state.levelId;
  if (!state.started) events.push({ name: "vault_start", props: { level_id: startingLevelId } });

  const preSnapshot = snapshotForHistory(state);
  const history = [...(state.history || []), preSnapshot].slice(-HISTORY_CAP);

  const nextState = result.replacement ? { ...result.replacement } : { ...state, ...result.patch };
  nextState.started = true;
  nextState.history = history;

  events.push(...result.events);
  return { state: nextState, events };
}
