/*
 * IDE phone-mockup image request (2026-09-03, foundry lane, DEFICIENCIES.md #14, LANE-foundry.md
 * item 3). renderMockup() in public/dominion-ide.js drives real spend on every beginner-flow
 * mockup: before this fix it sent no quality/aspect at all, which the Foundry defaults to
 * medium/square ($0.053) instead of low/portrait ($0.006) -- nine times the cost for a throwaway
 * preview a user never keeps. A static source check, same convention as mobile_ui_test.mjs: the
 * call lives inside an async client function with no seam this harness can invoke directly, so the
 * fetch body is asserted as text rather than driven end-to-end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./public/dominion-ide.js", import.meta.url), "utf8");
let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

t("renderMockup() requests the free/cheap lane: quality low, aspect portrait", () => {
  const m = /fetch\("\/api\/images\/generate"[\s\S]{0,400}?body:\s*JSON\.stringify\(\{([\s\S]{0,400}?)\}\)/.exec(src);
  assert.ok(m, "could not find the /api/images/generate fetch call in renderMockup()");
  assert.match(m[1], /quality:\s*"low"/, "mockup request must ask for quality:\"low\"");
  assert.match(m[1], /aspect:\s*"portrait"/, "mockup request must ask for aspect:\"portrait\" (it's a phone screen)");
});

console.log(`\nIDE mockup quality suite: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
