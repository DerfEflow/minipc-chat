/*
 * Touch-device corrections. Run: node mobile_ui_test.mjs
 *
 * The original of this file was written 07-28 alongside a 323-line dominion-mobile.css and neither
 * was ever committed. Both were recovered on 2026-08-01 from the F: sandbox working tree (branch
 * salvage/f-sandbox-uncommitted-20260728) and audited before any of it was wired in.
 *
 * The audit found the stylesheet could not ship as written: it restated the phone shell including
 * `#sidebar { left: 0 }`, and loading last it would have beaten dominion-vault.css's
 * `#sidebar { left: -110% }` and pinned the drawer open on every phone. That vault rule is the
 * 07-30 Android repaint fix, two days NEWER than the draft and directly incompatible with it.
 *
 * So these assertions pin two things: the one correction that did ship, and the collision itself,
 * so nobody re-adds the shell rules to this file without meeting the drawer first.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/dominion-mobile.css", import.meta.url), "utf8");
const sw = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");
const vault = readFileSync(new URL("./public/dominion-vault.css", import.meta.url), "utf8");
const rendered = readFileSync(new URL("./public/dominion-rendered-v2.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

// The rules only. This file's own header discusses #sidebar at length, and a test that matches its
// own prose proves nothing (learned the hard way on connectors_test.mjs, 2026-08-01).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
};

t("the sheet is linked, precached, and loads LAST", () => {
  assert.match(html, /dominion-mobile\.css\?v=1/, "a stylesheet nobody links is a stylesheet nobody has");
  assert.match(sw, /dominion-mobile\.css\?v=1/, "the PWA serves from its own cache, so it has to precache it too");
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/([a-z0-9-]+\.css)/g)].map((m) => m[1]);
  assert.equal(links[links.length - 1], "dominion-mobile.css",
    "it settles arguments with the width-based sheets, so it cannot be settled by them");
});

t("the service worker version moved, or phones keep the old cache", () => {
  const v = (sw.match(/const CACHE = "dominion-ai-v(\d+)/) || [])[1];
  assert.ok(Number(v) >= 159, "the cache name must advance with every shipped asset change, got v" + v);
});

/*
 * The live bug this fixes: iOS zooms the visual viewport whenever a focused control is under 16px
 * and never zooms back. rendered-v2 sets #input to 14px at phone width, so the ID has to appear
 * here by name. An element selector alone would lose to it at any load order, and the fix would
 * silently do nothing on the one control it exists for.
 */
t("the controls are named at the specificity of the rules they lift", () => {
  const block = rules.slice(rules.indexOf("@media (hover: none) and (pointer: coarse)"));
  for (const sel of ["#input", "#bb-input", ".ide-start textarea", ".vb-row textarea", ".bg-row textarea"]) {
    assert.ok(block.includes(sel),
      sel + " must be named: a bare `textarea` is (0,0,1) and loses to it at any load order, which " +
      "would make this file look like a fix and do nothing");
  }
  assert.match(block, /font-size:\s*max\(16px,\s*1em\)/,
    "max() so a control the design made deliberately larger is not pulled down to the floor");
});

/*
 * The sheet the 07-28 draft was arguing with is dead. Nothing links dominion-rendered-v2.css; only
 * the service worker still remembers it. Pinned because the draft's whole cascade argument rested
 * on it, and anyone reading that argument later deserves to know it no longer applies.
 */
t("dominion-rendered-v2.css is still unlinked, so no rule of its can be cited as live", () => {
  assert.ok(!/rendered-v2/.test(html), "if this ever gets linked again, the cascade here must be re-measured");
});

t("it applies to touch devices only, so no desktop layout can change", () => {
  const queries = [...css.matchAll(/@media([^{]+)\{/g)].map((m) => m[1].trim());
  assert.ok(queries.length > 0, "the sheet must be scoped, never global");
  for (const q of queries) {
    assert.match(q, /hover: none/, "every block must require a touch device: " + q);
    assert.match(q, /pointer: coarse/, "every block must require a coarse pointer: " + q);
  }
  assert.ok(!/^\s*[.#a-z][^@]*\{/m.test(css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]+\{[\s\S]*/, "")),
    "nothing may sit outside a media block, where it would reach desktop");
});

/* ---- the collision, pinned so it cannot be reintroduced ------------------------------------- */

t("this sheet never touches the navigation drawer", () => {
  assert.ok(!/#sidebar/.test(rules),
    "dominion-vault.css owns the drawer. A #sidebar rule here loads later and wins, which is how " +
    "the 07-28 draft would have pinned it open on every phone.");
});

t("the drawer rules it would have overridden are still in place", () => {
  assert.match(vault, /#sidebar\s*\{[\s\S]{0,400}left:\s*-110%/, "closed by left, not by transform");
  assert.match(vault, /#sidebar\.open\s*\{\s*left:\s*0;\s*\}/, "and opened by left");
  assert.match(vault, /transform:\s*none\s*!important/,
    "the 07-30 Android repaint fix: the drawer must never ride a transform on a phone");
  assert.match(vault, /html body #sidebar\.open\s*\{\s*z-index:\s*1200;\s*\}/,
    "and it must outrank the blur scrim, which is the bug that made it look like an empty pane");
});

t("the phone shell it duplicated is still owned by the width-based sheets", () => {
  assert.ok(!/grid-template-rows/.test(rules), "the two-row composer already exists at 620px");
  assert.ok(!/translateX/.test(rules), "no shell transforms travel in this file");
  assert.ok(!/\.bar/.test(rules), "the composer layout is not this file's business");
});

t("the keyboard-resize guard the 07-28 work DID ship is still there", () => {
  assert.match(app, /modelLedgerViewportWidth\s*=\s*window\.innerWidth/,
    "opening a phone keyboard changes viewport height many times a second");
  assert.match(app, /Math\.abs\(nextWidth\s*-\s*modelLedgerViewportWidth\)\s*<\s*2\)\s*return/,
    "a height-only change must never rebuild the transcript");
});

console.log("\nmobile_ui: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
