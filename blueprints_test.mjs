/*
 * Crucible project blueprints: the catalog loads, the seeds are usable, and the gate promise
 * survives the trip from data into what a user is shown.
 *
 * The load-bearing case is the last one. A blueprint marked gate:"in_flow" acts on the outside world
 * - posts a PR comment, files a ticket, issues an alert - and the whole reason that field exists is
 * so a project seeded from it carries the approval requirement into its plan. If that promise is
 * dropped somewhere between the JSON and the text the user reads, Dominion has offered a
 * decomposition whose stated human review never happens, which is worse than offering no blueprint.
 */
import assert from "node:assert/strict";
import { BLUEPRINTS, blueprintById, blueprintCatalog, blueprintSeed, blueprintVision, BLUEPRINT_CATEGORIES } from "./blueprints.mjs";
import { parseIntake, VISION_MARKER } from "./ideintake.mjs";

let passed = 0;
const t = (name, fn) => { fn(); console.log("  ok  " + name); passed++; };

t("the vendored catalog loads and every entry carries what the picker and seeder need", () => {
  assert.equal(BLUEPRINTS.length, 49);
  for (const b of BLUEPRINTS) {
    assert.ok(b.id && b.title && b.summary, b.id + " is missing identity fields");
    assert.ok(Array.isArray(b.steps) && b.steps.length, b.id + " has no steps");
    assert.ok(["in_flow", "downstream", "none"].includes(b.gate), b.id + " has gate " + b.gate);
    assert.ok(BLUEPRINT_CATEGORIES.includes(b.category), b.id + " is in unlisted category " + b.category);
  }
});

t("every blueprint appears in exactly one category group", () => {
  const c = blueprintCatalog();
  assert.equal(c.count, 49);
  const seen = c.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(seen.length, 49, "an entry is missing from or duplicated across the groups");
  assert.equal(new Set(seen).size, 49);
});

t("the picker payload stays small — it must not ship steps, inputs or metrics", () => {
  const c = blueprintCatalog();
  const item = c.groups[0].items[0];
  assert.equal(typeof item.steps, "number", "steps must be a COUNT in the picker, not the array");
  assert.equal(item.inputs, undefined);
  assert.equal(item.success_metrics, undefined);
  // The full catalog is ~96KB; the picker draws none of that detail. Guard the gap, not a byte count.
  assert.ok(JSON.stringify(c).length < 40_000, "picker payload has grown past 40KB: " + JSON.stringify(c).length);
});

t("an unknown id returns null rather than throwing", () => {
  assert.equal(blueprintById("no-such-thing"), null);
  assert.equal(blueprintSeed("no-such-thing"), null);
  assert.equal(blueprintVision("no-such-thing"), null);
});

t("every vision round-trips through the real intake parser", () => {
  for (const b of BLUEPRINTS) {
    const parsed = parseIntake(blueprintVision(b.id), { marker: VISION_MARKER });
    assert.ok(parsed.vision, b.id + " produced a vision the intake parser could not read");
    assert.ok(parsed.vision.split("\n").every((l) => !l.trim() || l.startsWith("- ") || /Press BEGIN|That is the plan/.test(l)),
      b.id + " emitted a vision line that is neither a bullet nor the closing sentence");
  }
});

t("every seed names the goal and walks the steps", () => {
  for (const b of BLUEPRINTS) {
    const seed = blueprintSeed(b.id);
    assert.ok(seed.includes(b.title), b.id + " seed does not name its own title");
    // Step names arrive underscore-free, because the seed is read by a person, not a parser.
    for (const s of b.steps) {
      assert.ok(seed.includes(s.name.replace(/_/g, " ")), b.id + " seed drops step " + s.name);
    }
    assert.ok(!/_/.test(seed.split("\n").find((l) => /^1\./.test(l)) || ""), b.id + " leaked a snake_case step name");
  }
});

t("the approval promise survives into BOTH surfaces, for every acting blueprint", () => {
  const acting = BLUEPRINTS.filter((b) => b.gate === "in_flow");
  assert.ok(acting.length >= 20, "expected the acting set to be substantial, got " + acting.length);
  for (const b of acting) {
    assert.match(blueprintSeed(b.id), /stop and ask me before it acts/,
      b.id + " acts on the world but its seed never says so");
    assert.match(blueprintVision(b.id), /must pause for a person before it acts/,
      b.id + " acts on the world but its vision never says so");
  }
});

t("a downstream-review blueprint does NOT claim an in-flow pause", () => {
  const downstream = BLUEPRINTS.filter((b) => b.gate === "downstream");
  assert.ok(downstream.length, "expected some downstream-review blueprints");
  for (const b of downstream) {
    assert.doesNotMatch(blueprintSeed(b.id), /stop and ask me before it acts/,
      b.id + " promises a pause its steps never take");
    assert.doesNotMatch(blueprintVision(b.id), /must pause for a person before it acts/,
      b.id + " promises a pause its steps never take");
  }
});

console.log(`\nblueprints: ${passed} passed, 0 failed`);
