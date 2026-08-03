/*
 * altana_test: the presence layer's invariants, pinned.
 *
 * Two of these guard scars this repo already carries, and they are the reason this file exists at
 * all rather than the work being "obviously fine":
 *   - the dot must mount on <body> (a fixed element inside a transformed ancestor stops being
 *     fixed, silently, and there are ~50 fixed rules across 17 stylesheets to collide with);
 *   - it must clear the mobile dock at 1180px, the exact width where this app once shipped four
 *     days with no navigation because two breakpoints disagreed.
 *
 * The DOM here is a hand-rolled stub rather than a real browser: the module only ever touches
 * createElement/append/dataset/style/addEventListener, so a stub exercises the real code path
 * without dragging a headless browser into a suite that runs on every commit.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { faceForSignIn, altanaMount, altanaState, altanaCheckAnchoring, ALTANA_FACES } from "./public/altana.js";

let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };

/* ---- stub DOM -------------------------------------------------------------------------------- */
/*
 * A REAL EventTarget subclass, not a hand-rolled event bus: Node 18+ ships CustomEvent/Event/
 * EventTarget globally, so this stub exercises the exact addEventListener/dispatchEvent contract
 * a browser has, which is stronger evidence than a fake that merely resembles one. Everything
 * altana.js actually touches (classList is deliberately NOT used by altana.js, so it is not stubbed)
 * is implemented; nothing else is.
 */
class StubNode extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.style = { setProperty() {}, backgroundImage: "", left: "", top: "", right: "", bottom: "", animationPlayState: "" };
    this.className = ""; this.id = ""; this.type = ""; this.textContent = ""; this.value = "";
    this.hidden = false;
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "data-enter") this.dataset.enter = ""; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "data-enter") delete this.dataset.enter; if (k === "data-state") delete this.dataset.state; }
  append(...kids) { for (const k of kids) { this.children.push(k); k.parentNode = this; } }
  appendChild(k) { this.children.push(k); k.parentNode = this; return k; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  focus() { this.__focused = true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 56, height: 56 }; }
  setPointerCapture() {} releasePointerCapture() {}
}
function stubEl(tag) { return new StubNode(tag); }
class StubDocument extends EventTarget {
  constructor() {
    super();
    this.body = new StubNode("body");
    this.documentElement = new StubNode("html");
    this.hidden = false;
    this.title = "";
  }
  createElement(tag) { return new StubNode(tag); }
  getElementById(id) { return this.body.children.find((c) => c.id === id) || null; }
}
function stubDoc() { return new StubDocument(); }

/* ---- test helpers for the panel/network behaviour -------------------------------------------- */
function fireClick(el) { el.dispatchEvent(new Event("click", { cancelable: true })); }
function firePointer(el, type, props) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}
function fakeRes(json) { return { ok: true, json: async () => json }; }
function flush() { return new Promise((r) => setTimeout(r, 0)); }
async function submit(panel, text) {
  const input = findByClass(panel, "altana-panel-input");
  const form = findByClass(panel, "altana-panel-form");
  input.value = text;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
}
function findByClass(node, cls) {
  if (!node) return null;
  const cur = String(node.className || "").split(/\s+/);
  if (cur.includes(cls)) return node;
  for (const c of node.children || []) {
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}
function collectText(node) {
  if (!node) return "";
  let s = node.textContent || "";
  for (const c of node.children || []) s += " " + collectText(c);
  return s;
}

/* ---- 1. face rotation ---------------------------------------------------------------------- */
{
  // Ten sign-ins per face, in order, wrapping after the sixth.
  assert.equal(faceForSignIn(0), "aether");
  assert.equal(faceForSignIn(9), "aether", "the tenth sign-in still shows the first face");
  assert.equal(faceForSignIn(10), "cosmic", "the eleventh rotates");
  assert.equal(faceForSignIn(59), "crystal");
  assert.equal(faceForSignIn(60), "aether", "six faces later it wraps to the start");
  ok("a face lasts exactly ten sign-ins, then advances, then wraps");
}
{
  // Deterministic, not random: the same count must always give the same face, or the face could
  // change mid-session and read as a glitch rather than a flourish.
  for (const n of [0, 7, 13, 41, 250]) assert.equal(faceForSignIn(n), faceForSignIn(n), "must be pure");
  assert.equal(faceForSignIn(-5), "aether", "a corrupt counter must not crash or blank the icon");
  assert.equal(faceForSignIn("nonsense"), "aether", "neither must a non-numeric one");
  ok("rotation is deterministic and survives a junk counter");
}
{
  const seen = new Set();
  for (let i = 0; i < ALTANA_FACES.length * 10; i += 10) seen.add(faceForSignIn(i));
  assert.equal(seen.size, ALTANA_FACES.length, "every face must appear in one full cycle");
  ok("all six faces are reachable, none is orphaned");
}

/* ---- 2. shipped dark ----------------------------------------------------------------------- */
{
  assert.equal(altanaMount({ doc: stubDoc() }), null, "must be a no-op until explicitly enabled");
  const d = stubDoc();
  altanaMount({ doc: d, enabled: false, signins: 0 });
  assert.equal(d.body.children.length, 0, "disabled means nothing is appended at all");
  ok("Altana ships dark: no element until the flag is on");
}

/* ---- 3. mount point and structure ----------------------------------------------------------- */
{
  const d = stubDoc();
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  assert.ok(el, "enabled mount returns the element");
  assert.equal(d.body.children.length, 1, "exactly one node is appended");
  assert.equal(d.body.children[0], el, "and it is appended to BODY, never into the app shell");
  assert.equal(el.id, "altana");
  assert.equal(el.getAttribute("aria-label"), "Altana, your assistant", "it is a real labelled control");
  assert.equal(el.dataset.face, "aether");
  ok("mounts exactly one labelled element, directly on body");
}
{
  const d = stubDoc();
  const el = altanaMount({ doc: d, enabled: true, signins: 30 });
  const skin = el.children.find((c) => c.className === "altana-face");
  assert.ok(skin, "a face layer exists");
  assert.match(skin.style.backgroundImage, /altana-solar\.png/, "sign-in 30 loads the fourth face");
  const others = ALTANA_FACES.filter((f) => f !== "solar");
  for (const f of others) {
    assert.ok(!skin.style.backgroundImage.includes(f), "only the CURRENT face is fetched, never the set");
  }
  ok("one face image is loaded, not all six (~750KB the user cannot see yet)");
}
{
  const d = stubDoc();
  altanaMount({ doc: d, enabled: true, signins: 0 });
  assert.equal(altanaMount({ doc: d, enabled: true, signins: 0 }).id, "altana");
  assert.equal(d.body.children.length, 1, "a second mount must not duplicate her");
  ok("mounting twice is idempotent");
}

/* ---- 4. state is an attribute, never an inline animation ------------------------------------ */
{
  const d = stubDoc();
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  altanaState("thinking", d);
  assert.equal(el.dataset.state, "thinking");
  altanaState("idle", d);
  assert.equal(el.dataset.state, undefined, "idle clears the attribute rather than setting a value");
  altanaState(null, d);
  assert.equal(el.dataset.state, undefined);
  ok("state rides a data attribute so CSS owns every visual decision");
}
{
  altanaState("thinking", stubDoc());   // no element mounted
  ok("setting state before she exists is a no-op, not a crash");
}

/* ---- 5. the runtime fixed-position-trap guard ------------------------------------------------ */
{
  // Nothing mounted yet: the guard must not throw, and must not falsely report a trap.
  assert.equal(altanaCheckAnchoring(stubDoc()), true, "no element mounted is not a trapped state");

  const d = stubDoc();
  altanaMount({ doc: d, enabled: true, signins: 0 });
  const el = d.getElementById("altana");
  el.offsetParent = null;             // a healthy fixed element: no ancestor is capturing it
  assert.equal(altanaCheckAnchoring(d), true, "offsetParent === null reads as correctly anchored");

  el.offsetParent = stubEl("div");    // simulate a later script wrapping <body> in a transform
  assert.equal(altanaCheckAnchoring(d), false, "a non-null offsetParent is reported as trapped");
  ok("the runtime guard detects the fixed-position trap via offsetParent, without throwing");
}

/* ---- 6. the CSS invariants that carry the scars --------------------------------------------- */
{
  const css = readFileSync(new URL("./public/altana.css", import.meta.url), "utf8");

  // Hazard: a transform on #altana ITSELF would re-anchor nothing (it is the fixed element), but
  // it WOULD create a containing block for anything inside and defeat the drag maths. Animations
  // belong on the inner layers, which is what the file claims; assert it rather than trust it.
  const own = css.slice(css.indexOf("#altana {"), css.indexOf("#altana[hidden]"));
  assert.ok(!/transform:/.test(own), "#altana itself must never carry a transform");
  assert.ok(/position:\s*fixed/.test(own), "#altana must be fixed to the viewport");

  assert.ok(/@media\s*\(max-width:\s*1180px\)/.test(css),
    "the dock clearance must key off 1180px, the width where the rail hands over");
  assert.ok(/--altana-dock-clearance/.test(css), "clearance is a named variable, not a magic number");

  assert.ok(/prefers-reduced-motion/.test(css), "motion must be a preference, not a decoration");
  const rm = css.slice(css.indexOf("prefers-reduced-motion"));
  assert.ok(/animation:\s*none/.test(rm), "reduced motion must actually stop the animations");

  // Only transform/opacity are animated: anything else repaints, and this element is on screen
  // for the entire session on every page.
  const keyframeBlocks = css.match(/@keyframes[\s\S]*?\n}/g) || [];
  assert.ok(keyframeBlocks.length >= 4, "expected the idle/think/nudge/arrive keyframes");
  for (const block of keyframeBlocks) {
    const props = (block.match(/^\s*([a-z-]+):/gm) || []).map((s) => s.trim().replace(":", ""));
    for (const p of props) {
      assert.ok(p === "transform" || p === "opacity",
        `keyframes may only animate transform/opacity for compositor-only work; found "${p}"`);
    }
  }
  ok("CSS pins the fixed-ancestor, 1180px, reduced-motion and compositor-only rules");
}

/* ---- 7. the panel does not exist until the dot is clicked ----------------------------------- */
{
  const d = stubDoc();
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  assert.equal(d.getElementById("altana-panel"), null, "no panel node exists before any click");

  fireClick(el);
  const panel = d.getElementById("altana-panel");
  assert.ok(panel, "a click that is not the end of a drag creates and opens the panel");
  assert.equal(panel.hidden, false, "the panel is visible once opened");
  const input = findByClass(panel, "altana-panel-input");
  assert.ok(input, "an input exists inside the panel");
  assert.equal(input.__focused, true, "focus moves into the input on open");
  ok("the panel does not exist until the dot is clicked, then it does, and takes focus");
}

/* ---- 8. a click after a drag does NOT open it ------------------------------------------------ */
{
  const d = stubDoc();
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });

  firePointer(el, "pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
  firePointer(el, "pointermove", { clientX: 40, clientY: 40, movementX: 40, movementY: 40 });
  firePointer(el, "pointerup", { pointerId: 1 });
  fireClick(el);

  assert.equal(d.getElementById("altana-panel"), null, "a click ending a drag must not open the panel");
  ok("a click after a drag does not open the panel");
}

/* ---- 9. Escape and the close control both close the panel ----------------------------------- */
{
  const d = stubDoc();
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");
  assert.equal(panel.hidden, false);

  const esc = new Event("keydown"); esc.key = "Escape";
  d.dispatchEvent(esc);
  assert.equal(panel.hidden, true, "Escape closes the panel");

  fireClick(el);
  assert.equal(panel.hidden, false, "clicking the dot again reopens it");
  fireClick(findByClass(panel, "altana-panel-close"));
  assert.equal(panel.hidden, true, "the close control closes it too");
  ok("Escape and the close control both close the panel, keyboard reachable");
}

/* ---- 10. every clientActions shape dispatches altana:action with the detail intact ----------- */
{
  const d = stubDoc();
  const seen = [];
  d.addEventListener("altana:action", (e) => seen.push(e.detail));
  global.fetch = async () => fakeRes({
    reply: "Done.", logged: null,
    clientActions: [
      { type: "set_setting", setting: "theme", value: "dark" },
      { type: "open_screen", screen: "billing" },
      { type: "echo_settings" },
      { type: "help", text: "Here is how that works." },
      { type: "work_list", items: [{ id: "1", title: "Roof estimate" }] },
    ],
    model: "x", lane: "free", billed: false, fallback: null, confirm: [], blocked: [],
  });
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");
  await submit(panel, "switch to dark mode");

  assert.equal(seen.length, 5, "one event per action, in order");
  assert.deepEqual(seen[0], { type: "set_setting", setting: "theme", value: "dark" });
  assert.deepEqual(seen[1], { type: "open_screen", screen: "billing" });
  assert.deepEqual(seen[2], { type: "echo_settings" });
  assert.deepEqual(seen[3], { type: "help", text: "Here is how that works." });
  assert.deepEqual(seen[4], { type: "work_list", items: [{ id: "1", title: "Roof estimate" }] });

  const text = collectText(panel);
  assert.ok(text.includes("Here is how that works."), "help text is rendered in the panel, not just dispatched");
  assert.ok(text.includes("Roof estimate"), "work_list items are rendered in the panel");
  ok("every clientActions shape dispatches altana:action with the detail intact, and reads back honestly");
}

/* ---- 11. confirm performs NO action until yes, then resends the IDENTICAL question ----------- */
{
  const d = stubDoc();
  const seen = [];
  d.addEventListener("altana:action", (e) => seen.push(e.detail));
  let calls = 0, firstBody = null;
  global.fetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (!body.confirm) {
      firstBody = body;
      return fakeRes({
        reply: "I need your OK first.", logged: null, clientActions: [],
        model: "x", lane: "free", billed: false, fallback: null,
        confirm: [{ token: "tok-1", tool: "send_email", question: "Send this email to the customer?" }],
        blocked: [],
      });
    }
    assert.deepEqual(body.confirm, ["tok-1"], "only the token the user clicked is ever sent");
    const { confirm, ...rest } = body;
    assert.deepEqual(rest, firstBody, "the resend is IDENTICAL to the original ask, with only confirm added");
    return fakeRes({
      reply: "Sent.", logged: null, clientActions: [{ type: "open_screen", screen: "inbox" }],
      model: "x", lane: "free", billed: false, fallback: null, confirm: [], blocked: [],
    });
  };
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");
  await submit(panel, "email the customer");

  assert.equal(calls, 1, "the first round only asked; nothing ran yet");
  assert.equal(seen.length, 0, "no action is dispatched while a confirmation is pending");
  const yesBtn = findByClass(panel, "altana-confirm-yes");
  assert.ok(yesBtn, "a yes control exists for the pending confirmation");
  const noBtn = findByClass(panel, "altana-confirm-no");
  assert.ok(noBtn, "a no control exists too");

  fireClick(yesBtn);
  await flush();

  assert.equal(calls, 2, "yes re-sends once, with the token");
  assert.equal(seen.length, 1, "the action arrives only after confirmation");
  assert.deepEqual(seen[0], { type: "open_screen", screen: "inbox" });
  ok("confirm does nothing until yes, then re-sends the identical question with the token");
}

/* ---- 11b. no drops the confirmation without ever sending the token -------------------------- */
{
  const d = stubDoc();
  let calls = 0;
  global.fetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (!body.confirm) {
      return fakeRes({
        reply: "OK?", logged: null, clientActions: [], model: "x", lane: "free", billed: false, fallback: null,
        confirm: [{ token: "tok-2", tool: "delete_thing", question: "Delete it?" }], blocked: [],
      });
    }
    throw new Error("must never be reached: the user said no");
  };
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");
  await submit(panel, "delete the thing");
  fireClick(findByClass(panel, "altana-confirm-no"));
  await flush();
  assert.equal(calls, 1, "declining never sends the token");
  assert.ok(collectText(panel).includes("Cancelled."), "declining is acknowledged honestly");
  ok("no drops the confirmation, the token is never sent");
}

/* ---- 12. fallback.text and blocked are rendered, never swallowed ----------------------------- */
{
  const d = stubDoc();
  global.fetch = async () => fakeRes({
    reply: "Here is what I found.", logged: null, clientActions: [],
    model: "luna", lane: "fallback", billed: true,
    fallback: { type: "model_fallback", from: "nvidia", to: "luna", text: "Her usual seat did not answer, so this turn may be slower or may cost a little." },
    confirm: [], blocked: [{ tool: "send_email", reason: "email tools are refused while impersonating a guest" }],
  });
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");
  await submit(panel, "email support");

  const text = collectText(panel);
  assert.ok(text.includes("Her usual seat did not answer"), "the fallback explanation is shown, not swallowed");
  assert.ok(text.includes("send_email") && text.includes("email tools are refused"), "the block and its reason are both shown");
  ok("fallback and blocked are surfaced in the panel, never swallowed");
}

/* ---- 13. a rejected fetch leaves the DOM intact and throws nothing --------------------------- */
{
  const d = stubDoc();
  global.fetch = async () => { throw new Error("network down"); };
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");

  let threw = false;
  try { await submit(panel, "are you there"); } catch { threw = true; }

  assert.equal(threw, false, "a rejected fetch must not throw out of the panel");
  assert.ok(d.getElementById("altana"), "the dot survives a failed turn");
  assert.ok(d.getElementById("altana-panel"), "the panel survives a failed turn");
  assert.ok(findByClass(panel, "altana-msg-error"), "an honest, short error message is shown");
  ok("a rejected fetch leaves the DOM intact and throws nothing");
}

/* ---- 14. a non-JSON / malformed response is treated as a failure, not a crash ---------------- */
{
  const d = stubDoc();
  global.fetch = async () => ({ ok: true, json: async () => { throw new Error("not json"); } });
  const el = altanaMount({ doc: d, enabled: true, signins: 0 });
  fireClick(el);
  const panel = d.getElementById("altana-panel");
  await submit(panel, "hello");
  assert.ok(findByClass(panel, "altana-msg-error"), "a bad response body reads as an honest error, not a hang");
  ok("a non-JSON response is handled the same honest way as a network failure");
}

/* ---- 15. she is actually TURNED ON, and the whole loop she needs is wired ------------------- */
{
  /*
   * Every check above proves the machinery works when someone calls it. This one proves someone
   * calls it. She shipped dark on purpose while her brain and her panel were built, and the last
   * step of launching her was a single word in index.html. A suite that never reads that word
   * would stay green with her switched off, which is the precise shape of the bug this codebase
   * keeps producing: built, tested, and never actually invoked.
   */
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /altanaMount\(\s*\{\s*enabled:\s*true/, "Altana must be mounted ENABLED, or none of the above ships");
  assert.match(html, /<script[^>]+src="\/altana\.js/, "her module has to be loaded");
  assert.match(html, /<link[^>]+href="\/altana\.css/, "her stylesheet has to be loaded");
  const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  assert.match(app, /addEventListener\(\s*["']altana:action["']/, "app.js must listen, or her actions land nowhere");
  assert.match(app, /window\.dominionAltanaContext/, "app.js must supply her context, or she knows only the page title");
  ok("she is switched ON and the full loop is wired: module, stylesheet, listener, context hook");
}

console.log(`\n${passed}/21 checks passed - Altana mounts on body, rotates every ten sign-ins, guards her own anchoring, opens into a conversation that never claims more than clientActions actually dispatched, and is switched ON.`);
