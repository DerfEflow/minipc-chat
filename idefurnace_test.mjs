/*
 * Furnace pass self-test. Run with: node idefurnace_test.mjs
 * Proves:
 *   1. the sweep catches every mark of unfinished work (TODO, placeholders, lorem, stubs)
 *   2. clean files produce the honest all-clear, never a false alarm
 *   3. the fidelity protocol round-trips: OK and GAP lines parse, junk is ignored
 *   4. the agreed vision extracts from a composed build prompt
 *   5. the guide mentions every feature on the surface (the keep-up rule with teeth)
 */
import assert from "node:assert/strict";
import { sweepFindings, sweepReport, fidelityMessages, parseFidelity, visionFromPrompt } from "./idefurnace.mjs";
import { CRUCIBLE_GUIDE, helpVoice, GUIDE_MUST_MENTION } from "./idehelp.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

await t("the sweep catches the marks of unfinished work", () => {
  const files = [
    { path: "app.js", text: "const a = 1;\n// TODO: wire this up\nfunction save() {}\n" },
    { path: "index.html", text: "<p>lorem ipsum dolor</p>\n<span>coming soon</span>\n" },
    { path: "config.js", text: "const key = 'YOUR_API_KEY';\n" },
  ];
  const f = sweepFindings(files);
  const kinds = f.map((x) => x.kind);
  assert.ok(kinds.includes("todo"));
  assert.ok(kinds.includes("empty_function"));
  assert.ok(kinds.includes("lorem"));
  assert.ok(kinds.includes("coming_soon"));
  assert.ok(kinds.includes("placeholder"));
  assert.ok(f.every((x) => x.path && x.line > 0 && x.excerpt));
  assert.ok(/reported honestly/.test(sweepReport(f)));
});

await t("clean files produce the honest all-clear", () => {
  const f = sweepFindings([{ path: "app.js", text: "function save(x) { return x + 1; }\nconst done = true;\n" }]);
  assert.equal(f.length, 0);
  assert.ok(/none found/.test(sweepReport(f)));
});

await t("findings are capped so a disaster stays readable", () => {
  const text = Array.from({ length: 200 }, (_, i) => "// TODO: item " + i).join("\n");
  const f = sweepFindings([{ path: "big.js", text }]);
  assert.equal(f.length, 40);
});

await t("the fidelity protocol round-trips", () => {
  const out = parseFidelity([
    "OK: A page that lists chores",
    "GAP: A gold star animation :: The star appears with no animation or sound.",
    "some stray line the model should not have written",
    "ok: lowercase works too",
  ].join("\n"));
  assert.equal(out.ok.length, 2);
  assert.equal(out.gaps.length, 1);
  assert.ok(out.gaps[0].bullet.includes("gold star"));
  assert.ok(out.gaps[0].why.includes("no animation"));
});

await t("the audit prompt is bounded and register-aware", () => {
  const msgs = fidelityMessages({ vision: "- big", files: [{ path: "a.js", text: "x".repeat(90000) }], register: "plain" });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.length < 30000, "excerpts must stay bounded");
  assert.ok(/8th grade/.test(msgs[0].content));
  const tech = fidelityMessages({ vision: "- x", files: [], register: "technical" });
  assert.ok(/Terse/.test(tech[0].content));
});

await t("the agreed vision extracts from a composed build prompt", () => {
  const prompt = "make a chore chart\n\nAGREED VISION (approved by the user; build exactly this):\n- three lists\n- a gold star";
  assert.ok(visionFromPrompt(prompt).startsWith("- three lists"));
  assert.equal(visionFromPrompt("no vision here"), "");
});

await t("the guide mentions every feature on the surface (keep-up rule with teeth)", () => {
  for (const feature of GUIDE_MUST_MENTION) {
    assert.ok(CRUCIBLE_GUIDE.toLowerCase().includes(feature.toLowerCase()),
      "guide must mention: " + feature);
  }
  assert.ok(/never say you cannot see the interface/i.test(helpVoice()));
});

console.log("\nidefurnace: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
