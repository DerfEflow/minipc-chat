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

/* ---- stub DOM -------------------------------------------------------------------------------- */
function stubEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, attrs: {},
    style: { setProperty() {}, backgroundImage: "", left: "", top: "", right: "", bottom: "" },
    className: "", id: "", type: "",
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "data-enter") this.dataset.enter = ""; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; if (k === "data-enter") delete this.dataset.enter; if (k === "data-state") delete this.dataset.state; },
    append(...kids) { this.children.push(...kids); },
    appendChild(k) { this.children.push(k); return k; },
    addEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 56, height: 56 }; },
    setPointerCapture() {}, releasePointerCapture() {},
  };
  return el;
}
function stubDoc() {
  const body = stubEl("body");
  return {
    body,
    documentElement: stubEl("html"),
    hidden: false,
    createElement: stubEl,
    getElementById(id) { return body.children.find((c) => c.id === id) || null; },
    addEventListener() {},
  };
}

console.log(`\n${passed}/11 checks passed - Altana mounts on body, rotates every ten sign-ins, guards her own anchoring, and ships dark`);
