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
import { sweepFindings, sweepReport, brokenReferenceFindings, fidelityMessages, parseFidelity, visionFromPrompt } from "./idefurnace.mjs";
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

// LIVE CATCH 2026-07-30: a finished three-file page ended its build asking Fred to close three
// "unfinished" items that were ordinary HTML/CSS. The platform's own word for finished work must
// never read as a stub, while a real ALL-CAPS marker still must.
await t("the web platform's own placeholder forms are not unfinished work", () => {
  const f = sweepFindings([
    { path: "index.html", text: '<input placeholder="e.g. Groceries">\n<input placeholder=\'0.00\'>\n' },
    { path: "styles.css", text: "input::placeholder { color: #888; }\ninput:placeholder-shown { opacity: .8; }\n" },
    { path: "script.js", text: "el.placeholder = 'Amount';\nconst opts = { placeholder: 'Amount' };\n" },
    { path: "Form.jsx", text: "<input placeholder={label} />\n" },
  ]);
  assert.equal(f.length, 0, "false positives: " + JSON.stringify(f));

  const real = sweepFindings([
    { path: "api.js", text: "const key = 'PLACEHOLDER';\n" },
    { path: "form.html", text: '<input placeholder="Name"> <!-- PLACEHOLDER: validate this -->\n' },
  ]);
  assert.equal(real.length, 2, "real placeholder markers must still be caught: " + JSON.stringify(real));
  assert.ok(real.every((x) => x.kind === "placeholder"));
});

/*
 * LIVE CATCH 2026-07-30: the Crucible built index.html + styles.css + script.js, every move said
 * done, the sweep was clean — and the page did nothing, because the HTML loaded "app.js". The
 * browser proved it (404 on app.js, form fell back to a GET, total stayed $0.00). No text pattern
 * can see this; only the file list can.
 */
await t("a page that loads a file nobody wrote is reported as broken", () => {
  const f = brokenReferenceFindings([
    { path: "index.html", text: '<link rel="stylesheet" href="styles.css">\n<script src="app.js"></script>\n' },
    { path: "styles.css", text: "body{}" },
    { path: "script.js", text: "console.log(1)" },
  ]);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].kind, "broken_reference");
  assert.equal(f[0].line, 2);
  assert.ok(/app\.js/.test(f[0].excerpt));
});

await t("real, external, and pre-existing references are never called broken", () => {
  const f = brokenReferenceFindings([
    { path: "index.html", text: [
      '<link rel="stylesheet" href="styles.css">',
      '<script src="./script.js"></script>',
      '<script src="https://cdn.example.com/x.js"></script>',
      '<script src="//cdn.example.com/y.js"></script>',
      '<img src="data:image/png;base64,AAA">',
      '<a href="#top">top</a>',
      '<img src="assets/logo.png">',
      '<link rel="icon" href="/favicon.ico">',
    ].join("\n") },
    { path: "styles.css", text: "body{}" },
    { path: "script.js", text: "1" },
  ], { known: ["assets/logo.png", "favicon.ico"] });
  assert.equal(f.length, 0, "false positives: " + JSON.stringify(f));
});

await t("findings are capped so a disaster stays readable", () => {
  const text = Array.from({ length: 200 }, (_, i) => "// TODO: item " + i).join("\n");
  const f = sweepFindings([{ path: "big.js", text }]);
  assert.equal(f.length, 40);
});

await t("the sweep inspects files beyond the first 24", () => {
  const files = Array.from({ length: 30 }, (_, index) => ({
    path: "src/file-" + (index + 1) + ".js",
    text: index === 29 ? "// TODO: the thirtieth file is unfinished" : "export const ready = true;",
  }));
  const findings = sweepFindings(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "src/file-30.js");
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
