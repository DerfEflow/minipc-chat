import { readFileSync } from "node:fs";

const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const html = read("./public/index.html");
const js = read("./public/dominion-video.js");
const css = read("./public/dominion-video.css");
const sw = read("./public/sw.js");
let passed = 0;

function test(name, check) {
  try { check(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
function includes(source, value, label = value) {
  if (!source.includes(value)) throw new Error(`missing ${label}`);
}

test("versioned video assets match the offline shell", () => {
  for (const asset of ["/dominion-video.css?v=5", "/dominion-video.js?v=7"]) {
    includes(html, asset, `${asset} in index`);
    includes(sw, `"${asset}"`, `${asset} in service worker`);
  }
  includes(js, "l.href='/dominion-video.css?v=5'", "dynamic stylesheet fallback version");
});

test("the editor exposes the promised models and seven media layers", () => {
  for (const label of ["Gemini Omni Flash", "Seedance 2.0", "Kling 3.0 Turbo", "Grok Imagine 1.5"]) includes(js, label);
  for (const layer of ["Video 1", "Video 2", "Video 3", "Audio 1", "Audio 2", "Audio 3", "Audio 4"]) includes(js, layer);
  includes(js, "115,000 tokens", "screenwriter token ceiling");
});

test("desktop authority and saved history stay server-backed", () => {
  includes(js, "X-Dominion-Desktop-Capability", "desktop capability header");
  includes(js, "/history", "history endpoint");
  includes(js, "historyCommand('undo')", "durable undo");
  includes(js, "historyCommand('redo')", "durable redo");
  const classifier = js.match(/const device = \(\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  if (!classifier || /innerWidth|matchMedia/.test(classifier)) throw new Error("device authority regressed to a viewport heuristic");
});

test("paid generation retries and mobile reloads keep their durable identity", () => {
  includes(js, "generationIntent", "retained generation intent");
  includes(js, "prepareGenerationBody", "generation request normalization");
  includes(js, "delete body.referenceImages", "inactive reference-media omission");
  includes(js, "/jobs/recover-mobile", "mobile job discovery");
  includes(js, "resumeMobileJob", "mobile job resume loop");
  includes(js, "/delivered", "mobile delivery acknowledgement");
  includes(js, "job.hasLocalOutput", "settled output recovery guard");
});

test("panel, focus, and narrow editor states cannot overlap", () => {
  for (const rule of [
    ".dv-panel.regular{position:relative",
    ".dv-panel.expanded{position:fixed",
    ".dv-two-expanded .dv-panel.expanded",
    ".dv-no-regular:not(.dv-focus-mode)",
    ".dv-focus-mode .dv-top-actions #dv-focus{display:block!important",
    ".dv-workspace{overflow-x:hidden;overflow-y:auto}",
    ".dv-stage{height:300px;flex:0 0 300px;overflow:hidden}",
  ]) includes(css, rule);
  includes(js, "dv-timeline-detail", "compact timeline label");
});

if (!process.exitCode) console.log(`\nvideo UI: ${passed} passed, 0 failed`);
