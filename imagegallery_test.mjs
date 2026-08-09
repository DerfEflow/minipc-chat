/*
 * Image gallery self-test — run with: node imagegallery_test.mjs
 *
 * Fred's list, 2026-08-08, pinned so it cannot quietly regress:
 *   the gradient/rings placeholder is gone; the grid is fluid rather than a fixed column count;
 *   the viewer is fullscreen with an X; download and delete are reachable from the tile itself;
 *   delete clears the folder copy too; download routes through the folder picker; mobile centres.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
}
const js = readFileSync(new URL("./public/dominion-images.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/dominion-images.css", import.meta.url), "utf8");
const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("image gallery");

t("the rings placeholder is gone from the markup and the styles", () => {
  assert.ok(!/art-forge/.test(code), "the light-with-rings tile must not be rendered any more");
  assert.ok(!/#dfi-root \.art-forge/.test(css), "and its styles must not linger");
  assert.match(code, /art-waiting/, "a waiting tile must still exist, it just should not pretend to be art");
});

t("the grid is fluid, not a fixed column count", () => {
  assert.match(css, /repeat\(auto-fill, minmax\(var\(--tile/,
    "auto-fill fits the available width at every size, unlike hard-coded 1/2/3 column rules");
  assert.ok(!/#dfi-root \.gallery \{ grid-template-columns: 1fr;/.test(css),
    "the single-column mobile override was the reason a phone showed one enormous picture");
  assert.match(css, /#dfi-root \.gallery \{ --tile: 260px/, "desktop tiles must be bigger, not merely more numerous");
});

t("the gallery scrolls on its own", () => {
  const rule = css.slice(css.indexOf("#dfi-root .gallery { position: relative"));
  assert.match(rule.slice(0, 400), /overflow-y: auto/, "the grid must scroll rather than growing the page");
});

t("the viewer is fullscreen and has an X", () => {
  assert.match(css, /\.dfi-viewer:not\(\.dfi-keep\) \.dfi-viewer-card/, "the picture viewer must escape the 760px box");
  assert.match(css, /object-fit: contain/, "a full picture must fit the screen without cropping");
  assert.match(code, /dfi-viewer-x/, "there must be an X");
  assert.match(code, /aria-label", "Close image"/, "and it must be reachable to a screen reader");
  // It has to route through the same dismissal path or the pushed history entry dangles.
  // Search FORWARD from the X: there is an earlier scrim.addEventListener on the keep dialog, and
  // slicing to that one yields a backwards range that silently matches nothing.
  const xAt = code.indexOf('x.className = "dfi-viewer-x"');
  const xBlock = code.slice(xAt, code.indexOf("scrim.addEventListener", xAt));
  assert.ok(xBlock.length > 50, "failed to isolate the X wiring");
  assert.match(xBlock, /dismiss\(\)/, "the X must use the single dismissal path, not remove the node itself");
  assert.match(code, /if \(e\.target === scrim\) dismiss\(\)/, "clicking the backdrop should close it too");
});

t("the fullscreen card cannot overhang its container", () => {
  // 100vw includes the scroll gutter, which is exactly how a 'centred' overlay ends up shifted.
  const rule = css.slice(css.indexOf(".dfi-viewer:not(.dfi-keep) .dfi-viewer-card"));
  assert.ok(!/width: 100vw/.test(rule.slice(0, 300)), "vw units ignore the scrollbar and push content right");
});

t("download and delete are on the tile, not only inside the viewer", () => {
  assert.match(code, /tools\.className = "card-tools"/, "the tile needs its own action cluster");
  assert.match(code, /aria-label", "Download this image"/, "download must be reachable per image");
  assert.match(code, /aria-label", "Delete this image"/, "so must delete");
  // Without this the tile's own click handler fires underneath and opens the viewer.
  const tools = code.slice(code.indexOf('const tools = document.createElement("div")'), code.indexOf("card.addEventListener"));
  assert.equal((tools.match(/e\.stopPropagation\(\)/g) || []).length, 2,
    "both tile buttons must stop the click from reaching the tile");
});

t("tile controls are visible without hover, because phones do not hover", () => {
  assert.match(css, /@media \(hover: none\) \{ #dfi-root \.card-tools \{ opacity: 1; \} \}/,
    "a hover-reveal control does not exist on a touch device");
});

t("deleting removes the folder copy, not just the app copy", () => {
  const fn = code.slice(code.indexOf("async function deleteRecord"));
  const body = fn.slice(0, fn.indexOf("\n  function openViewer"));
  assert.match(body, /folderHandle\.removeEntry\(rec\.savedName\)/,
    "a delete that leaves the file in the folder is a filing error the user finds later");
  assert.match(body, /vaultDelete\(rec\.id\)/, "and the app copy must go too");
  // Best-effort on the folder: a moved file or a lapsed permission must not block clearing the app.
  const folderPart = body.slice(body.indexOf("removeEntry"));
  assert.match(folderPart, /catch/, "a folder failure must not refuse the delete outright");
});

t("the viewer's delete uses the same path as the tile's", () => {
  const viewerDel = code.slice(code.indexOf('del.textContent = "DELETE"'));
  assert.match(viewerDel.slice(0, 300), /deleteRecord\(rec\)/,
    "two delete implementations will drift; the viewer used to call vaultDelete directly");
});

t("download routes through the folder, and offers to pick one when none is set", () => {
  const fn = code.slice(code.indexOf("async function downloadRecord"));
  const body = fn.slice(0, fn.indexOf("async function deleteRecord"));
  assert.match(body, /if \(!folderHandle\) \{ await linkFolder\(\); \}/,
    "with no folder chosen, choosing one IS the download step");
  assert.match(body, /reconnectFolder\(\)/, "a lapsed permission should reconnect rather than fail");
  assert.match(body, /a\.download = fileNameFor\(rec\)/, "and there must be a fallback so the button is never a dead end");
});

t("mobile is centred and nothing may exceed the viewport", () => {
  assert.match(css, /#dfi-root \.app-shell \{ width: 100%; max-width: 100%; margin-inline: auto;/,
    "a child wider than the viewport is what drags the column sideways");
  assert.match(css, /env\(safe-area-inset-left\)/, "notch insets must be respected");
  assert.match(css, /#dfi-root \.gallery \{ --tile: 132px[^}]*justify-content: center/,
    "the grid itself must centre its tracks on a narrow screen");
});

t("the folder choice is asked to survive, and a lost one says so", () => {
  /*
   * Two things were conflated here and only one was a bug. The GRANT lapsing on every page load is
   * Chrome by design, and the bar already handles it with a one-click RECONNECT that reuses the
   * stored handle. What must never be lost is the HANDLE itself, and it had two ways to go:
   * eviction, because storage was never marked persistent, and a swallowed restore error that
   * presented identically to never having chosen a folder.
   */
  assert.match(code, /navigator\.storage\.persist/, "storage must be marked persistent or the vault can be evicted");
  assert.match(code, /await navigator\.storage\.persisted\(\)/, "and it must not re-ask when already granted");
  assert.match(code, /folderRestoreFailed/, "a failed restore must be distinguishable from a first run");
  assert.match(code, /nameEl\.textContent = folderRestoreFailed \? "LOST" : "NOT SET"/,
    "a lost folder and an unchosen one must not read identically");
  /*
   * Anchor on the state string, which appears once. The obvious anchor, the `folderPerm !==
   * "granted"` condition, also appears inside linkFolder earlier in the file, so indexOf finds
   * that one and the slice lands nowhere near the folder bar. That trap has now bitten this suite
   * five times: when slicing source, anchor on something unique or search forward from a known
   * position, never indexOf from zero on a phrase the file repeats.
   */
  const barAt = code.indexOf('bar.dataset.state = "needs-permission"');
  assert.ok(barAt > 0, "failed to find the needs-permission branch");
  assert.match(code.slice(barAt, barAt + 900), /mkBtn\("RECONNECT", \(\) => reconnectFolder\(\)/,
    "a lapsed grant must cost one click, not a fresh pick");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
