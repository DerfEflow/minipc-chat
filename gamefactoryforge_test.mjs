/*
 * Tests for gamefactoryforge.mjs (LANE-gfforge.md). Uses the REAL gamefactorystore.mjs against a
 * temp DATA_DIR under os.tmpdir() (per AGENT-RULES.md), plus small in-file fakes for chat,
 * generateImages, readArtifact, and the kit/qaRunner (the kit lane, gfkit, has not landed yet — this
 * file codes to the exact export names LANE-gfkit.md documents).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createGameFactoryStore } from "./gamefactorystore.mjs";
import { QA_REQUIRED_SUITES } from "./gamefactory.mjs";
import { createGameFactoryForge, parseFileBlocks } from "./gamefactoryforge.mjs";
import { portfolioGame, portfolioGames } from "./gamefactorytemplates.mjs";

const owner = "owner-uid";
const sha256 = (data) => createHash("sha256").update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")).digest("hex");

function freshStore() {
  const d = mkdtempSync(join(tmpdir(), "dominion-gamefactory-forge-"));
  return { store: createGameFactoryStore({ dir: d }), d };
}
function writeDesignJson(dataDir, slug, design) {
  const dir = join(dataDir, "game-factory", "forge", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "design.json"), JSON.stringify(design, null, 2));
}
function validDesign(catalogGame, levels) {
  return {
    schemaVersion: 1, slug: catalogGame.slug, name: catalogGame.name, toolchain: "web-canvas",
    summary: "A tidy one-paragraph summary of the design.",
    coreLoop: ["read the puzzle", "act", "check the result"],
    entities: [{ name: "Token", fields: ["x", "y"] }],
    actions: [{ type: "select_vector", params: ["index"], gesture: "tap", stepControl: "buttons" }],
    rules: { win: "reach the target", fail: "hit a wall", scoring: "stars", undo: true },
    levelPlan: Array.from({ length: levels }, (_, i) => ({ id: `L${i + 1}`, title: `Level ${i + 1}`, teaches: "basics", difficulty: 1, par: 3 })),
    theme: { palette: ["#0B1020", "#38E8FF"], paletteNames: ["Navy", "Cyan"], type: "sans", motion: "snap", accessibility: "shape-coded" },
    analytics: { events: ["level_start", "level_complete"], propsAllowed: ["level_id"] },
    qaFocus: ["determinism"], notes: ["none"],
  };
}
function fourFilesResponse(overrides = {}) {
  const content = [
    "===== FILE: game/rules.js =====",
    "export const meta = { slug: 'x', name: 'x', actions: [], events: [], schemaVersion: 1 };",
    "export function createState(){ return { level: 0 }; }",
    "export function applyAction(state){ return { state, events: [] }; }",
    "export function status(){ return 'playing'; }",
    "export function levelCount(){ return 1; }",
    "export function serialize(state){ return JSON.stringify(state); }",
    "export function deserialize(text){ return JSON.parse(text); }",
    "export function validate(){ return true; }",
    "export function layout(){ return { board: { x: 0, y: 0, w: 1, h: 1 }, controls: [] }; }",
    "export function actionForPointer(){ return null; }",
    "export function actionForKey(){ return null; }",
    "export function hint(){ return null; }",
    "===== END FILE =====",
    "===== FILE: game/render.js =====",
    "export function draw(){}",
    "===== END FILE =====",
    "===== FILE: game/content.js =====",
    "export default { schemaVersion: 1, levels: [], tutorial: [] };",
    "===== END FILE =====",
    "===== FILE: qa/fixtures.json =====",
    "{\"levels\":{}}",
    "===== END FILE =====",
  ].join("\n");
  return { ok: true, content, servedBy: { model: overrides.model || "test-model" }, costUsd: 0.01, ...overrides };
}
function makeScriptedChat(script) {
  let i = 0;
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return typeof step === "function" ? await step(args) : step;
  };
  fn.calls = calls;
  return fn;
}
function makeFakeQaRunner(scriptFn) {
  let calls = 0;
  return {
    async run() {
      calls++;
      const overrides = scriptFn({ calls }) || {};
      const suites = {};
      for (const name of QA_REQUIRED_SUITES) suites[name] = overrides[name] || { status: "PASSED", summary: "ok", metrics: {}, failures: [] };
      return { ok: true, results: { schema: "gf-qa/1", bundleSha256: "", startedAt: "", endedAt: "", runner: "server-qa", suites }, timedOut: false, exitCode: 0, stdout: "", stderr: "", runner: "server-qa", durationMs: 3 };
    },
  };
}
function makeFakeKit() {
  return {
    KIT_CONTRACT_TEXT: "FAKE CONTRACT: rules.js/render.js/content.js/fixtures.json contract text.",
    referenceGame(slug) { return { "game/rules.js": `export const meta = { slug: "${slug}" }; // reference rules.js` }; },
    themeFromVisual(visual) {
      const pairs = (visual && visual.palette) || [];
      const palette = pairs.map((p) => p[1]);
      const names = pairs.map((p) => p[0]);
      return { palette: palette.length ? palette : ["#111318", "#F5F7FF"], names: names.length ? names : ["Ink", "Paper"], type: (visual && visual.type) || "sans", reducedMotion: false };
    },
    fallbackIconPng({ size = 64, palette = ["#000000", "#ffffff"], glyph = "G" } = {}) {
      return Buffer.from(`FAKEPNG:${size}:${palette.join(",")}:${glyph}`);
    },
    assembleBundle({ outDir, generated, meta, assets }) {
      if (existsSync(outDir) && readdirSync(outDir).length) throw new Error("assembleBundle: outDir is not empty");
      mkdirSync(outDir, { recursive: true });
      const files = [];
      const write = (path, content) => {
        const full = join(outDir, path);
        mkdirSync(dirname(full), { recursive: true });
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
        writeFileSync(full, buf);
        files.push({ path, sha256: sha256(buf), size: buf.length });
      };
      for (const [path, content] of Object.entries(generated)) write(path, content);
      for (const [path, content] of Object.entries(assets)) write(path, content);
      const indexHtml = `<!doctype html><title>${meta.name}</title>`;
      write("index.html", indexHtml);
      files.sort((a, b) => a.path.localeCompare(b.path));
      const bundleSha256 = sha256(files.map((f) => `${f.path}\n${f.sha256}\n`).join(""));
      const buildDoc = { buildId: meta.buildId, versionName: meta.versionName, bundleSha256, files, toolchain: { lane: "web-canvas", kit: "1", node: process.version }, createdAt: new Date().toISOString() };
      writeFileSync(join(outDir, "build.json"), JSON.stringify(buildDoc, null, 2));
      return buildDoc;
    },
    verifyBundle() { return { ok: true, bundleSha256: "", problems: [] }; },
  };
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log("ok", n, "-", name); }

await test("design task: valid JSON on rung 2 after an invalid rung 1; design.json written; servedBy names rung 2", async () => {
  const { store, d } = freshStore();
  try {
    store.seedPortfolio({ uid: owner, email: "owner@example.com" });
    const projectId = store.listProjects(owner).find((p) => p.slug === "vector-vault").id;
    const catalogGame = portfolioGame("vector-vault");
    assert.ok(catalogGame, "portfolioGame must resolve the seeded catalog entry");
    assert.equal(catalogGame.slug, "vector-vault");
    assert.equal(portfolioGames().length, 10);

    const chatFn = makeScriptedChat([
      { ok: true, content: "not valid json at all", servedBy: { model: "model-a" }, costUsd: 0.001 },
      { ok: true, content: "still not valid json", servedBy: { model: "model-a" }, costUsd: 0.001 },
      { ok: true, content: JSON.stringify(validDesign(catalogGame, 12)), servedBy: { model: "model-b" }, costUsd: 0.002 },
    ]);
    const forge = createGameFactoryForge({
      store, chat: chatFn,
      generateImages: async () => ({ error: "not used in this test" }),
      readArtifact: async ({ artifactKey }) => (artifactKey === "00_GAME_BRIEF" ? { content: "brief text" } : { error: "not available" }),
      kit: makeFakeKit(), qaRunner: makeFakeQaRunner(() => ({})), dataDir: d,
      models: { design: ["model-a", "model-b"], code: ["c"] }, levels: 12,
    });

    const queued = store.queueTask({ uid: owner, projectId, capability: "product_planning", payload: { kind: "design" } });
    assert.equal(queued.status, 201, JSON.stringify(queued.body));

    const report = await forge.tick();
    assert.equal(report.claimed, true);
    assert.equal(report.capability, "product_planning");
    assert.equal(chatFn.calls.length, 3);

    const project = store.getProject(owner, projectId);
    const task = project.tasks.find((t) => t.capability === "product_planning");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.result.kind, "design");
    assert.equal(task.result.servedBy.model, "model-b");
    assert.equal(task.result.rounds, 3);

    const designPath = join(d, "game-factory", "forge", "vector-vault", "design.json");
    assert.ok(existsSync(designPath));
    const design = JSON.parse(readFileSync(designPath, "utf8"));
    assert.equal(design.slug, "vector-vault");
    assert.equal(design.levelPlan.length, 12);

    const h = forge.health();
    assert.equal(h.completed, 1);
    assert.equal(h.failed, 0);
  } finally { store.close(); rmSync(d, { recursive: true, force: true }); }
});

await test("assets task: generateImages fails -> kit-drawn fallback icons used; provenance lists three assets; task COMPLETED", async () => {
  const { store, d } = freshStore();
  try {
    store.seedPortfolio({ uid: owner, email: "owner@example.com" });
    const projectId = store.listProjects(owner).find((p) => p.slug === "bolt-bloom").id;
    const forge = createGameFactoryForge({
      store,
      chat: async () => ({ ok: false, error: "chat is not used by the assets task" }),
      generateImages: async () => ({ error: "engine down for maintenance" }),
      readArtifact: async () => ({ error: "not configured" }),
      kit: makeFakeKit(), qaRunner: makeFakeQaRunner(() => ({})), dataDir: d, ownerTenant: "owner-tenant",
    });

    const queued = store.queueTask({ uid: owner, projectId, capability: "visual_design", payload: { kind: "assets" } });
    assert.equal(queued.status, 201, JSON.stringify(queued.body));

    const report = await forge.tick();
    assert.equal(report.claimed, true);
    assert.equal(report.capability, "visual_design");

    const project = store.getProject(owner, projectId);
    const task = project.tasks.find((t) => t.capability === "visual_design");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.result.kind, "assets");
    assert.equal(task.result.assets.length, 3);
    assert.ok(task.result.assets.every((a) => a.engine === "kit"), "every asset must fall back to the kit-drawn engine when generateImages fails");

    const assetsDir = join(d, "game-factory", "forge", "bolt-bloom", "assets");
    for (const name of ["icon-512.png", "icon-192.png", "splash.png", "provenance.json"]) {
      assert.ok(existsSync(join(assetsDir, name)), `${name} must be written`);
    }
    const provenance = JSON.parse(readFileSync(join(assetsDir, "provenance.json"), "utf8"));
    assert.equal(provenance.assets.length, 3);
  } finally { store.close(); rmSync(d, { recursive: true, force: true }); }
});

await test("implement task: round 1 FAILED core-loop, round 2 PASSED; second prompt carries the failure text; bundle assembled", async () => {
  const { store, d } = freshStore();
  try {
    store.seedPortfolio({ uid: owner, email: "owner@example.com" });
    const projectId = store.listProjects(owner).find((p) => p.slug === "vector-vault").id;
    const buildRes = store.createBuild({ uid: owner, projectId, versionName: "0.1.1", toolchain: { lane: "web-canvas" } });
    assert.equal(buildRes.status, 201, JSON.stringify(buildRes.body));
    const buildId = buildRes.body.buildId;
    writeDesignJson(d, "vector-vault", validDesign(portfolioGame("vector-vault"), 12));

    const chatFn = makeScriptedChat([fourFilesResponse({ model: "model-only" }), fourFilesResponse({ model: "model-only" })]);
    const qa = makeFakeQaRunner(({ calls }) => (calls === 1
      ? { "core-loop": { status: "FAILED", summary: "undo did not restore the prior state", failures: ["level 1: undo mismatch"] } }
      : {}));
    const forge = createGameFactoryForge({
      store, chat: chatFn,
      generateImages: async () => ({ error: "not used in this test" }),
      readArtifact: async () => ({ error: "not used in this test" }),
      kit: makeFakeKit(), qaRunner: qa, dataDir: d, ownerTenant: "owner-tenant",
      models: { design: ["design-model"], code: ["model-only"] }, maxRounds: 2,
    });

    const queued = store.queueTask({ uid: owner, projectId, buildId, capability: "gameplay_engineering", payload: { kind: "implement", buildId } });
    assert.equal(queued.status, 201, JSON.stringify(queued.body));

    const report = await forge.tick();
    assert.equal(report.claimed, true);
    assert.equal(chatFn.calls.length, 2, "one round should fail QA and trigger exactly one retry round");

    const secondPromptText = chatFn.calls[1].messages.map((m) => m.content).join("\n");
    assert.ok(secondPromptText.includes("core-loop"), "the retry prompt must name the failing suite");
    assert.ok(secondPromptText.includes("undo did not restore the prior state"), "the retry prompt must carry the failure summary");

    const project = store.getProject(owner, projectId);
    const task = project.tasks.find((t) => t.capability === "gameplay_engineering");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.result.kind, "implement");
    assert.equal(task.result.buildId, buildId);
    assert.match(task.result.bundleSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(task.result.localQa.failed, []);
    assert.ok(task.result.localQa.passed.includes("core-loop"));
    assert.equal(task.result.rounds, 2);

    const finalBuildJson = join(d, "game-factory", "builds", buildId, "bundle", "build.json");
    assert.ok(existsSync(finalBuildJson));
    const finalDoc = JSON.parse(readFileSync(finalBuildJson, "utf8"));
    assert.equal(finalDoc.bundleSha256, task.result.bundleSha256);

    const sourceRulesPath = join(d, "game-factory", "forge", "vector-vault", "source", "game", "rules.js");
    assert.ok(existsSync(sourceRulesPath), "the winning source must be persisted for a future repair/revise");
  } finally { store.close(); rmSync(d, { recursive: true, force: true }); }
});

await test("exhaustion: qaRunner always fails -> failTask non-retryable with an honest sentence", async () => {
  const { store, d } = freshStore();
  try {
    store.seedPortfolio({ uid: owner, email: "owner@example.com" });
    const projectId = store.listProjects(owner).find((p) => p.slug === "vector-vault").id;
    const buildId = store.createBuild({ uid: owner, projectId, versionName: "0.1.1" }).body.buildId;
    writeDesignJson(d, "vector-vault", validDesign(portfolioGame("vector-vault"), 12));

    const chatFn = makeScriptedChat([fourFilesResponse(), fourFilesResponse()]);
    const qa = makeFakeQaRunner(() => ({ "core-loop": { status: "FAILED", summary: "deterministic test failure", failures: ["always fails in this test"] } }));
    const forge = createGameFactoryForge({
      store, chat: chatFn,
      generateImages: async () => ({ error: "not used in this test" }),
      readArtifact: async () => ({ error: "not used in this test" }),
      kit: makeFakeKit(), qaRunner: qa, dataDir: d,
      models: { design: ["design-model"], code: ["model-only"] }, maxRounds: 2,
    });

    store.queueTask({ uid: owner, projectId, buildId, capability: "gameplay_engineering", payload: { kind: "implement", buildId } });
    await forge.tick();
    assert.equal(chatFn.calls.length, 2, "both rounds on the single model in the ladder must be exhausted");

    const project = store.getProject(owner, projectId);
    const task = project.tasks.find((t) => t.capability === "gameplay_engineering");
    assert.equal(task.status, "FAILED");
    assert.ok(task.result.error.includes("No model produced a game"), task.result.error);
    assert.equal(project.state, "FAILED");

    const h = forge.health();
    assert.equal(h.failed, 1);
  } finally { store.close(); rmSync(d, { recursive: true, force: true }); }
});

await test("pause: heartbeat detects stopRequested -> task completes PAUSED with a checkpoint", async () => {
  const { store, d } = freshStore();
  try {
    store.seedPortfolio({ uid: owner, email: "owner@example.com" });
    const projectId = store.listProjects(owner).find((p) => p.slug === "vector-vault").id;
    const buildId = store.createBuild({ uid: owner, projectId, versionName: "0.1.1" }).body.buildId;
    writeDesignJson(d, "vector-vault", validDesign(portfolioGame("vector-vault"), 12));

    let pauseRequested = false;
    const calls = [];
    const chat = async (args) => {
      calls.push(args);
      if (!pauseRequested) {
        pauseRequested = true;
        // Simulates the owner clicking Pause while the forge's first model call for this task is in
        // flight: this is the real store.executeCommand pause path, not a fake of the store itself.
        const r = store.executeCommand({ uid: owner, projectId, key: "pause-test-key-0001", type: "pause", payload: {}, actor: "test-owner" });
        assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
      }
      return fourFilesResponse({ model: args.model });
    };

    const qa = makeFakeQaRunner(() => ({ "core-loop": { status: "FAILED", summary: "forces a rung change so a second heartbeat checkpoint is reached", failures: [] } }));
    const forge = createGameFactoryForge({
      store, chat,
      generateImages: async () => ({ error: "not used in this test" }),
      readArtifact: async () => ({ error: "not used in this test" }),
      kit: makeFakeKit(), qaRunner: qa, dataDir: d,
      models: { design: ["design-model"], code: ["model-a", "model-b"] }, maxRounds: 1, heartbeatMs: 0,
    });

    store.queueTask({ uid: owner, projectId, buildId, capability: "gameplay_engineering", payload: { kind: "implement", buildId } });
    await forge.tick();

    assert.equal(calls.length, 1, "the second rung must never start a model call once a pause is detected");

    const project = store.getProject(owner, projectId);
    const task = project.tasks.find((t) => t.capability === "gameplay_engineering");
    assert.equal(task.status, "PAUSED");
    assert.equal(task.result.status, "PAUSED");
    assert.equal(project.state, "PAUSED");

    const eventTypes = store.events(owner, projectId, 0, 200).map((e) => e.type);
    assert.ok(eventTypes.includes("task.paused"), eventTypes.join(","));
  } finally { store.close(); rmSync(d, { recursive: true, force: true }); }
});

await test("parser: prose around blocks, fenced code blocks, and a missing file are all handled correctly", async () => {
  const good = [
    "Sure, here are the four files you asked for:",
    "===== FILE: game/rules.js =====",
    "```js",
    "export const meta = {};",
    "```",
    "===== END FILE =====",
    "===== FILE: game/render.js =====",
    "export function draw(){}",
    "===== END FILE =====",
    "===== FILE: game/content.js =====",
    "export default { levels: [] };",
    "===== END FILE =====",
    "===== FILE: qa/fixtures.json =====",
    "{}",
    "===== END FILE =====",
    "Hope that helps!",
  ].join("\n");
  const parsedGood = parseFileBlocks(good);
  assert.ok(!parsedGood.error, JSON.stringify(parsedGood));
  assert.equal(parsedGood.files["game/rules.js"].trim(), "export const meta = {};");
  assert.equal(parsedGood.files["game/render.js"].trim(), "export function draw(){}");
  assert.equal(parsedGood.files["game/content.js"].trim(), "export default { levels: [] };");
  assert.equal(parsedGood.files["qa/fixtures.json"].trim(), "{}");

  const missingOne = [
    "===== FILE: game/rules.js =====",
    "export const meta = {};",
    "===== END FILE =====",
    "===== FILE: game/render.js =====",
    "export function draw(){}",
    "===== END FILE =====",
    "===== FILE: game/content.js =====",
    "export default { levels: [] };",
    "===== END FILE =====",
  ].join("\n");
  const parsedMissing = parseFileBlocks(missingOne);
  assert.ok(parsedMissing.error);
  assert.deepEqual(parsedMissing.missing, ["qa/fixtures.json"]);

  const emptyOne = [
    "===== FILE: game/rules.js =====",
    "export const meta = {};",
    "===== END FILE =====",
    "===== FILE: game/render.js =====",
    "",
    "===== END FILE =====",
    "===== FILE: game/content.js =====",
    "export default { levels: [] };",
    "===== END FILE =====",
    "===== FILE: qa/fixtures.json =====",
    "{}",
    "===== END FILE =====",
  ].join("\n");
  const parsedEmpty = parseFileBlocks(emptyOne);
  assert.ok(parsedEmpty.error);
  assert.deepEqual(parsedEmpty.missing, ["game/render.js"]);
});

console.log(`\n${n} game factory forge tests passed`);
