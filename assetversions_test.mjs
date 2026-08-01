/*
 * The page and the service worker have to agree on which build of a file they mean.
 * Run: node --test assetversions_test.mjs
 *
 * Every asset is cache-busted with ?v=N, and sw.js precaches a SHELL list of those same URLs. When
 * a change bumps the page but not the SHELL, the service worker keeps serving the OLD file from
 * precache and the deploy lands with no visible effect. That drift appeared three separate times in
 * a single day (2026-08-01: dominion-vibe.css v18 against v19, app.js v71 against v73, and a trio
 * at v18/v39/v70 against v20/v40/v71), each time on a fix that then read as "nothing happened".
 *
 * It is a mechanical check, so a machine should do it instead of somebody remembering to.
 *
 * The CACHE name is the other half. A new SHELL under an old CACHE name is never installed, because
 * the worker has no reason to think anything changed. Two sessions writing to this repo makes that
 * the likelier mistake of the two: the name is already bumped, so it looks done.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const setup = readFileSync(new URL("./public/setup.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");

/*
 * The two documents are not the whole request list, and the part they leave out is the navigation.
 * dominion-ui.css @imports the six cinematic sheets and dominion-rendered-v2.css; the seven-line
 * dominion-ui.js injects dominion-cinematic.js, which BUILDS the rail and the dock. index.html
 * names none of them. Checking only the documents missed a live drift (SHELL precached
 * cinematic.js v42 while the loader asked for v41) and, worse, made those files look unreferenced
 * to anyone grepping the HTML — which is how they got called dead on 2026-08-01, one commit before
 * a breakpoint in one of them removed the app's navigation between 721px and 1180px.
 */
const uiCss = readFileSync(new URL("./public/dominion-ui.css", import.meta.url), "utf8");
const uiJs = readFileSync(new URL("./public/dominion-ui.js", import.meta.url), "utf8");
const requested = html + "\n" + setup + "\n" + uiCss + "\n" + uiJs;

// file -> version, for every "name.js?v=N" / "name.css?v=N" in a document.
const versions = (text) => {
  const found = new Map();
  for (const m of text.matchAll(/([A-Za-z0-9._\-/]+\.(?:js|css))\?v=(\d+)/g)) {
    found.set(m[1].replace(/^\//, ""), m[2]);
  }
  return found;
};

const shellList = sw.slice(sw.indexOf("const SHELL = ["), sw.indexOf("]", sw.indexOf("const SHELL = [")));

test("the service worker precaches the same versions the pages ask for", () => {
  const precached = versions(shellList);
  const drift = [];
  for (const [file, v] of versions(requested)) {
    const got = precached.get(file);
    if (got && got !== v) drift.push(`${file}: page asks v${v}, sw precaches v${got}`);
  }
  assert.deepEqual(drift, [], "a precached old copy wins over the page, so the deploy does nothing");
});

test("nothing in the shell is a version the pages never ask for", () => {
  const asked = versions(requested);
  const orphans = [];
  for (const [file, v] of versions(shellList)) {
    const want = asked.get(file);
    if (want && want !== v) orphans.push(`${file}: sw precaches v${v}, nothing asks for it`);
  }
  assert.deepEqual(orphans, [], "precaching a version no page requests wastes the install and hides the real one");
});

test("the cache name is present and looks deliberate", () => {
  const m = sw.match(/const CACHE = "([^"]+)"/);
  assert.ok(m, "sw.js declares a CACHE name");
  assert.match(m[1], /^dominion-ai-v\d+-[a-z0-9-]+$/,
    "dominion-ai-v<N>-<what-changed>, so a rebase can see at a glance whether the name moved");
});

/*
 * The shell is only worth checking if the files in it actually exist. A renamed asset left in SHELL
 * fails the whole install, which takes the precache down silently and offline with it.
 */
test("every versioned file in the shell exists on disk", async () => {
  const { existsSync } = await import("node:fs");
  const missing = [];
  for (const file of versions(shellList).keys()) {
    if (!existsSync(new URL("./public/" + file, import.meta.url))) missing.push(file);
  }
  assert.deepEqual(missing, [], "one missing entry rejects addAll() and installs nothing at all");
});
