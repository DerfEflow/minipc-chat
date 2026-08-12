/*
 * The cache-bust trio, for EVERY asset. Run: node cachebust_test.mjs
 *
 * This app versions its own front-end by hand: index.html asks for "/app.js?v=74", and sw.js
 * precaches the identical string so an installed phone can serve the shell offline. Two hand-written
 * lists that have to agree, forever, which is a promise nobody keeps.
 *
 * It has already been broken twice in one day, both times silently:
 *   - altana.js and altana.css were rewritten and shipped at the old "?v=2", so an entire feature
 *     deployed correctly and was invisible to every returning browser;
 *   - app.js was about to ship a customer-facing wording fix at the old "?v=74" for the same reason.
 *
 * A test cannot know whether someone REMEMBERED to bump a version. It can know whether the two lists
 * agree, and disagreement is the worse half of the mistake: index.html asking for v75 while the
 * service worker confidently answers with the v74 it cached is a stale asset that survives a reload.
 *
 * The Altana-specific version of this check lives in altana_test.mjs with the scar that produced it.
 * This one covers everything, because app.js proved the trap was never Altana-specific.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.message)); } };

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");

// Every local .js/.css the shell asks for, with whatever version token it carries.
function assetsIn(text, label) {
  const found = new Map();
  for (const m of text.matchAll(/["'(](\/[\w./-]+\.(?:js|css))(\?v=[\w.]+)?/g)) {
    const [, path, ver = ""] = m;
    if (found.has(path) && found.get(path) !== ver) {
      assert.fail(`${label} asks for ${path} at both "${found.get(path)}" and "${ver}". ` +
        "One page would load two different builds of the same file.");
    }
    found.set(path, ver);
  }
  return found;
}

const inHtml = assetsIn(html, "index.html");
const inSw = assetsIn(sw, "sw.js");

t("the shell actually lists assets, so this suite is not passing on an empty set", () => {
  assert.ok(inHtml.size >= 8, "index.html yielded only " + inHtml.size + " assets; the matcher has drifted");
  assert.ok(inSw.size >= 8, "sw.js yielded only " + inSw.size + " assets; the matcher has drifted");
});

t("every asset in one file carries the same version in the other", () => {
  const wrong = [];
  for (const [path, ver] of inHtml) {
    if (!inSw.has(path)) continue;   // not precached is a choice, not a bug
    if (inSw.get(path) !== ver) wrong.push(`${path}: index.html "${ver}" vs sw.js "${inSw.get(path)}"`);
  }
  assert.deepEqual(wrong, [], "an installed phone would serve the stale copy of:\n      " + wrong.join("\n      "));
});

t("a precached asset is never versioned in one file and bare in the other", () => {
  const bare = [];
  for (const [path, ver] of inHtml) {
    if (!inSw.has(path)) continue;
    const other = inSw.get(path);
    if ((ver && !other) || (!ver && other)) bare.push(path + " (html:\"" + ver + "\" sw:\"" + other + "\")");
  }
  assert.deepEqual(bare, [], "these would be cached under one key and requested under another: " + bare.join(", "));
});

t("the service worker cache name is versioned, or nothing it holds is ever evicted", () => {
  const m = /const CACHE = "([^"]+)"/.exec(sw);
  assert.ok(m, "sw.js has no CACHE constant");
  assert.match(m[1], /v\d+/, "the cache name carries no version, so a shell change cannot invalidate it: " + m[1]);
});

t("every precached file still exists on disk", () => {
  /*
   * REWRITTEN AFTER THIS TEST WAS WRONG, and the mistake is worth recording because this repo has
   * made it before. The first version asserted that anything sw.js precaches must be named in
   * index.html, and it flagged seven cinematic stylesheets as orphans. They are not orphans:
   * dominion-ui.css pulls them in with @import, so index.html never mentions them and neither does a
   * naive grep. A previous session concluded they were dead code for exactly this reason and was
   * wrong (6c055b7).
   *
   * Reachability through an @import chain is genuinely awkward to prove from a test. Existence on
   * disk is not, and it catches the mistake actually worth catching: a file renamed or deleted in one
   * place only, which leaves the service worker fetching a 404 and failing its whole install, taking
   * offline support down silently for every installed user.
   */
  const missing = [];
  for (const path of inSw.keys()) {
    const rel = path.replace(/^\//, "").split("?")[0];
    if (!existsSync(new URL("./public/" + rel, import.meta.url))) missing.push(path);
  }
  assert.deepEqual(missing, [],
    "sw.js precaches files that do not exist, so its install will fail and offline support dies: " + missing.join(", "));
});

console.log(`\ncachebust_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
