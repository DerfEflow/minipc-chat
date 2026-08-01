/*
 * Mobile layout regression test. iPhone Safari can expose a 980px CSS viewport, so "phone" cannot
 * mean only <=620px. These assertions pin the bridge that keeps the shell and composer stable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/dominion-mobile.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const sw = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");

assert.match(html, /dominion-mobile\.css\?v=1/, "the mobile stability layer must load after the feature styles");
assert.match(sw, /dominion-mobile\.css\?v=1/, "the PWA must precache the mobile stability layer");
assert.match(css, /max-width:\s*1180px[\s\S]*orientation:\s*portrait/,
  "desktop-advertising portrait phones must enter the compact shell");
assert.match(css, /#sidebar\s*\{[\s\S]*transform:\s*translateX\(-105%\)/,
  "the desktop sidebar must start off-canvas in the compact shell");
assert.match(css, /\.bar\s*\{[\s\S]*grid-template-rows:\s*auto auto/,
  "composer text and controls must occupy separate stable rows");
assert.match(css, /#input\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1[\s\S]*font-size:\s*16px/,
  "the composer must span its row and avoid iOS focus zoom");
assert.match(app, /modelLedgerViewportWidth\s*=\s*window\.innerWidth/,
  "transcript resize handling must remember width independently of keyboard height");
assert.match(app, /Math\.abs\(nextWidth\s*-\s*modelLedgerViewportWidth\)\s*<\s*2\)\s*return/,
  "keyboard-only viewport resizes must not rebuild the transcript");

console.log("mobile_ui_test: desktop-mobile viewport and keyboard stability are pinned");
