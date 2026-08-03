/*
 * Model dropdown display record + stylesheet self-test (Lane B / RELAUNCH, 2026-08-03).
 * Run: node models_dropdown_test.mjs
 *
 * Fred's complaint was the picker's TEXT: one run-on string of params/context/price with no
 * plain-language purpose. The fix is data the catalog already computes (specialty, priceTier,
 * speedTier, see models.catalog.mjs's finalize()) rendered on separate lines by
 * public/dominion-models.css. This test asserts the DATA side of that contract without booting a
 * server: every catalog seat must produce a complete display record, no two seats may collide on
 * the name a user reads, price formatting must stay stable (a tier, never a raw multi-decimal
 * float), and the stylesheet itself must parse and must never hard-code a grid column count
 * (Fred's standing rule, restated in docs/wiring/lane-b-dropdown.md).
 *
 * Imports models.catalog.mjs directly. No server, no fetch, no /api/models round trip.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODELS, CATEGORIES, fmtCtx, fmtPrice, REASONING_FLOOR, OUT_MODE_CEIL } from "./models.catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(HERE, "public", "dominion-models.css");

let passed = 0;
const t = (name, fn) => { fn(); console.log("  PASS  " + name); passed++; };

/*
 * The display record a dropdown row actually needs: everything modelRowHtml() in app.js reads to
 * build one row (see docs/wiring/lane-b-dropdown.md for the exact replacement code). Built here
 * straight from the catalog's own normalized fields, the same ones /api/models serves, so this
 * test exercises exactly what ships, not a reimplementation of it.
 */
function toDisplayRecord(m) {
  return {
    id: m.id,
    name: m.name,
    specialty: m.specialty,
    ctxLabel: fmtCtx(m.ctx),
    priceTier: m.priceTier,
    speedTier: m.speedTier,
    price: fmtPrice(m),
  };
}

t("REASONING_FLOOR and OUT_MODE_CEIL are exported (Lane D's unblock)", () => {
  assert.equal(typeof REASONING_FLOOR, "object", "REASONING_FLOOR must be an exported object");
  assert.ok(REASONING_FLOOR && Object.keys(REASONING_FLOOR).length > 0, "REASONING_FLOOR must not be empty");
  assert.equal(typeof OUT_MODE_CEIL, "object", "OUT_MODE_CEIL must be an exported object");
  assert.equal(OUT_MODE_CEIL.fast, 2048, "OUT_MODE_CEIL.fast must be unchanged at 2048");
});

t("the catalog is non-empty and CATEGORIES covers every model's category", () => {
  assert.ok(MODELS.length > 0, "catalog must not be empty");
  for (const m of MODELS) {
    assert.ok(CATEGORIES.includes(m.category), m.id + " has category " + m.category + " which is not in CATEGORIES");
  }
});

t("every catalog seat produces a complete display record: no undefined, no empty field", () => {
  for (const m of MODELS) {
    const r = toDisplayRecord(m);
    for (const [field, value] of Object.entries(r)) {
      assert.notEqual(value, undefined, m.id + "." + field + " is undefined");
      assert.notEqual(value, null, m.id + "." + field + " is null");
      assert.notEqual(String(value).trim(), "", m.id + "." + field + " is empty");
    }
    // fmtCtx returns the literal "?" for a falsy/zero ctx, which is a formatter failure state, not
    // a legitimate display value, and every catalog model declares a real context window.
    assert.notEqual(r.ctxLabel, "?", m.id + " has no usable context window for the picker");
    assert.ok(["Free", "Budget", "Standard", "Premium"].includes(r.priceTier), m.id + " has an unrecognized priceTier: " + r.priceTier);
    assert.ok(["Reasons first", "Replies fast"].includes(r.speedTier), m.id + " has an unrecognized speedTier: " + r.speedTier);
  }
});

t("no two seats collide on the display name a user actually reads", () => {
  const names = MODELS.map((m) => m.name);
  const seen = new Set();
  const dupes = [];
  for (const n of names) { if (seen.has(n)) dupes.push(n); seen.add(n); }
  assert.deepEqual(dupes, [], "duplicate display names in the picker: " + dupes.join(", "));
  assert.equal(seen.size, MODELS.length, "every model must have a unique name");
});

t("no two seats collide on catalog id (the value the row actually selects)", () => {
  const ids = MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalog ids would make two rows select the same seat");
});

t("price formatting is stable: fmtPrice is always \"Free\" or \"$in / $out\" with at most 2 decimals", () => {
  const shape = /^Free$|^\$\d+(\.\d{1,2})? \/ \$\d+(\.\d{1,2})?$/;
  for (const m of MODELS) {
    const p = fmtPrice(m);
    assert.match(p, shape, m.id + " price string does not match the expected shape: " + JSON.stringify(p));
    // The specific defect Fred flagged: a raw float with six decimals in the picker. inCost/outCost
    // are the numbers fmtPrice prints, so pin their own decimal precision too, not just the string.
    for (const cost of [m.inCost, m.outCost]) {
      const dec = String(cost).split(".")[1];
      assert.ok(!dec || dec.length <= 2, m.id + " cost " + cost + " carries more than 2 decimal places");
    }
  }
});

t("fmtCtx never returns a raw byte-count string (K/M suffix, not a 6-7 digit number)", () => {
  for (const m of MODELS) {
    const c = fmtCtx(m.ctx);
    assert.match(c, /^\d+(\.\d)?[KM]$/, m.id + " context label is not tiered: " + JSON.stringify(c));
  }
});

t("priceTier is consistent with the model's own inCost/outCost (no drift between the two)", () => {
  for (const m of MODELS) {
    if (!m.inCost && !m.outCost) { assert.equal(m.priceTier, "Free", m.id + " has $0 cost but priceTier is not Free"); continue; }
    if (m.outCost <= 3) { assert.equal(m.priceTier, "Budget", m.id); }
    else if (m.outCost <= 15) { assert.equal(m.priceTier, "Standard", m.id); }
    else { assert.equal(m.priceTier, "Premium", m.id); }
  }
});

/* ---- stylesheet checks: parses, and never hard-codes a grid column count -------------------- */
const css = readFileSync(CSS_PATH, "utf8");

t("public/dominion-models.css exists and is non-trivial", () => {
  assert.ok(css.length > 200, "dominion-models.css looks empty or truncated");
});

t("public/dominion-models.css has balanced braces (a cheap but real parse check)", () => {
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.equal(opens, closes, `unbalanced braces: ${opens} "{" vs ${closes} "}"`);
  assert.ok(opens > 0, "no rules found at all");
});

t("public/dominion-models.css declares no hard-coded grid column count", () => {
  // Fred's standing rule: no repeat(N, ...) and no fixed multi-track column list. This sheet is
  // flex-based on purpose (flex-wrap adapts to width; a fixed column count does not), so neither
  // pattern should appear anywhere in the file.
  assert.doesNotMatch(css, /grid-template-columns\s*:\s*repeat\(\s*\d/i, "found a repeat(N, ...) column count");
  assert.doesNotMatch(css, /grid-template-columns\s*:\s*(\S+\s+){2,}\S+/i, "found a fixed multi-track grid-template-columns list");
});

t("public/dominion-models.css never transitions a layout-shifting property", () => {
  // The real assertion: transform/opacity are present (the interactive affordance exists) and no
  // layout property (top, left, width, height, margin, padding) is ever transitioned or animated.
  assert.doesNotMatch(css, /transition\s*:[^;]*\b(top|left|right|bottom|width|height|margin|padding)\s+[\d.]/i, "a layout property is being transitioned instead of transform/opacity");
  assert.match(css, /transition\s*:[^;]*transform/i, "expected at least one transform transition for the interactive price badge");
});

t("public/dominion-models.css never uses position:fixed (avoids the transform/filter ancestor trap)", () => {
  assert.doesNotMatch(css, /position\s*:\s*fixed/i, "this sheet must not introduce position:fixed; the panel's own fixed rule lives in dominion-cinematic-06.css");
});

console.log(`\n${passed} checks passed - the picker's data contract and stylesheet are sound`);
