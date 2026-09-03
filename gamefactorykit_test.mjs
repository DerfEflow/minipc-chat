/*
 * gamefactorykit_test.mjs -- tests for gamefactorykit/kit.mjs and the assembled bundle it
 * produces: the reference game passing all 12 QA suites through the REAL server QA runner (proof
 * the kit contract and the QA harness agree with each other), tampering detection, verifyBundle,
 * and the small pure helpers (fallbackIconPng, ports). Every temp dir lives under os.tmpdir() --
 * this file never touches C:\minipc-chat or a DATA_DIR default (see AGENT-RULES.md / LANE-gfkit.md).
 *
 * The tampering + full-pass tests spawn the REAL permission-restricted child process (via
 * gamefactoryqa.mjs's createServerQaRunner), the same code path production uses -- an in-process
 * shortcut would only prove the harness's logic is self-consistent, not that it actually survives
 * the --permission sandbox it really runs under (rule 8.5: a green suite proves wiring, not
 * function, unless it exercises the real thing).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngSize } from "./gamefactorykit/png.mjs";
import {
  KIT_VERSION, KIT_CONTRACT_TEXT, QA_SUITES, kitFiles, assembleBundle, verifyBundle,
  fallbackIconPng, referenceGame, themeFromVisual,
} from "./gamefactorykit/kit.mjs";
import { createPorts } from "./gamefactorykit/ports.js";
import { createServerQaRunner } from "./gamefactoryqa.mjs";

let n = 0;
async function test(name, fn) { await fn(); console.log("ok", ++n, "-", name); }

const dir = mkdtempSync(join(tmpdir(), "dominion-gfkit-"));

const VECTOR_VAULT_PALETTE = [["Vault Navy", "#0B1020"], ["Pulse Cyan", "#38E8FF"], ["Vector Gold", "#FFC857"], ["Lock Coral", "#FF5D73"], ["Paper White", "#F5F7FF"]];

function buildAssembleInputs() {
  const generated = referenceGame("vector-vault");
  const theme = themeFromVisual({ palette: VECTOR_VAULT_PALETTE });
  const icon512 = fallbackIconPng({ size: 512, palette: theme.palette, glyph: "circle" });
  const icon192 = fallbackIconPng({ size: 192, palette: theme.palette, glyph: "circle" });
  const splash = fallbackIconPng({ size: 640, palette: theme.palette, glyph: "diamond" });
  const provenance = JSON.stringify([
    { path: "assets/icon-512.png", sha256: "test-fixture", engine: "kit-fallback" },
    { path: "assets/icon-192.png", sha256: "test-fixture", engine: "kit-fallback" },
    { path: "assets/splash.png", sha256: "test-fixture", engine: "kit-fallback" },
  ]);
  const meta = {
    name: "Vector Vault", slug: "vector-vault", versionName: "0.1.0", buildId: "build_test",
    subtitle: "Make every arrow add up", keywords: "spatial logic,vector puzzle",
    palette: theme.palette,
    events: ["vault_start", "vector_adjust", "hint_used", "launch_result", "vault_complete", "session_end"],
    actions: [
      { type: "select_vector", params: ["index"] }, { type: "rotate", params: ["delta"] },
      { type: "magnitude", params: ["delta"] }, { type: "launch", params: [] },
      { type: "undo", params: [] }, { type: "restart", params: [] }, { type: "hint", params: [] },
      { type: "next", params: [] }, { type: "select_level", params: ["index"] },
    ],
  };
  const assets = { "assets/icon-512.png": icon512, "assets/icon-192.png": icon192, "assets/splash.png": splash, "assets/provenance.json": provenance };
  return { generated, meta, assets };
}

let seq = 0;
async function assembleFresh(label) {
  seq += 1;
  const outDir = join(dir, `bundle-${seq}-${label}`);
  const inputs = buildAssembleInputs();
  const build = await assembleBundle({ outDir, ...inputs });
  return { outDir, build };
}

async function runQa(outDir, label) {
  const resultsDir = join(dir, `results-${seq}-${label}`);
  mkdirSync(resultsDir, { recursive: true });
  const runner = createServerQaRunner({ timeoutMs: 30000 });
  return runner.run({ bundleDir: outDir, resultsDir });
}

try {
  await test("kit.mjs exports the documented surface", () => {
    assert.equal(KIT_VERSION, "1");
    assert.ok(typeof KIT_CONTRACT_TEXT === "string" && KIT_CONTRACT_TEXT.length > 100);
    assert.deepEqual(QA_SUITES, [
      "core-loop", "launch-smoke", "crash-regression", "controls", "save-state",
      "viewport", "performance", "monetization", "offline", "analytics",
      "privacy-consent", "store-readiness",
    ]);
    const files = kitFiles();
    assert.deepEqual(Object.keys(files).sort(), ["kit/ports.js", "kit/runtime.js", "qa/run.mjs"]);
    for (const v of Object.values(files)) assert.ok(v.length > 50);
  });

  await test("reference game assembles and passes all 12 suites through the real server QA runner", async () => {
    const { outDir, build } = await assembleFresh("full-pass");
    assert.ok(build.bundleSha256.length === 64);
    assert.equal(build.files.length, 15);
    const verify = verifyBundle(outDir);
    assert.equal(verify.ok, true, "verifyBundle: " + JSON.stringify(verify.problems));

    const outcome = await runQa(outDir, "full-pass");
    console.log("    runner: ok=" + outcome.ok + " exitCode=" + outcome.exitCode + " durationMs=" + outcome.durationMs);
    for (const [suite, r] of Object.entries(outcome.results.suites)) {
      console.log("    " + suite.padEnd(20) + r.status + " - " + r.summary);
      assert.equal(r.status, "PASSED", `suite ${suite} failed: ${r.summary} :: ${JSON.stringify(r.failures)}`);
    }
    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.timedOut, false);
    assert.equal(Object.keys(outcome.results.suites).length, 12);
  });

  await test("tampering: rules.js mentioning a network fetch call fails the offline suite", async () => {
    const { outDir } = await assembleFresh("tamper-offline");
    const rulesPath = join(outDir, "game", "rules.js");
    appendFileSync(rulesPath, "\n// tamper-probe: fetch(\"https://example.invalid\")\n");
    const outcome = await runQa(outDir, "tamper-offline");
    assert.equal(outcome.results.suites.offline.status, "FAILED");
    assert.ok(outcome.results.suites.offline.failures.some((f) => /forbidden network pattern/.test(f)));
  });

  await test("tampering: a fixture whose win path cannot win fails core-loop", async () => {
    const { outDir } = await assembleFresh("tamper-core-loop");
    const fixturesPath = join(outDir, "qa", "fixtures.json");
    const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
    // v1's own "fail" sequence is guaranteed to miss (that is what makes it a fail fixture); reuse
    // it as the "win" sequence so it can never reach "won".
    fixtures.levels.v1.win = fixtures.levels.v1.fail;
    writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2));
    const outcome = await runQa(outDir, "tamper-core-loop");
    assert.equal(outcome.results.suites["core-loop"].status, "FAILED");
    assert.ok(outcome.results.suites["core-loop"].failures.some((f) => f.includes("v1") && f.includes("win fixture")));
  });

  await test("tampering: a missing icon-192 asset fails store-readiness", async () => {
    const { outDir } = await assembleFresh("tamper-store-readiness");
    unlinkSync(join(outDir, "assets", "icon-192.png"));
    const outcome = await runQa(outDir, "tamper-store-readiness");
    assert.equal(outcome.results.suites["store-readiness"].status, "FAILED");
    assert.ok(outcome.results.suites["store-readiness"].failures.some((f) => /icon-192|192x192/.test(f)));
  });

  await test("tampering: a layout() with a sub-44px control fails viewport", async () => {
    const { outDir } = await assembleFresh("tamper-viewport");
    const stubRules = `export const meta = { slug: "stub", name: "Stub", actions: [], events: [], schemaVersion: 1 };
export function layout(width, height) {
  return {
    board: { x: 0, y: 0, w: width, h: Math.max(0, height - 40) },
    controls: [{ id: "too_small", label: "Bad", x: 10, y: Math.max(0, height - 35), w: 30, h: 30, action: { type: "launch" } }],
  };
}
`;
    writeFileSync(join(outDir, "game", "rules.js"), stubRules);
    const outcome = await runQa(outDir, "tamper-viewport");
    assert.equal(outcome.results.suites.viewport.status, "FAILED");
    assert.ok(outcome.results.suites.viewport.failures.some((f) => /under 44px/.test(f)));
  });

  await test("tampering: a draw() that calls drawImage fails launch-smoke", async () => {
    const { outDir } = await assembleFresh("tamper-launch-smoke");
    writeFileSync(join(outDir, "game", "render.js"), `export function draw(ctx) { ctx.drawImage(); }\n`);
    const outcome = await runQa(outDir, "tamper-launch-smoke");
    assert.equal(outcome.results.suites["launch-smoke"].status, "FAILED");
    assert.ok(outcome.results.suites["launch-smoke"].failures.some((f) => /render\.draw threw/.test(f) && /drawImage/.test(f)));
  });

  await test("verifyBundle detects a modified file and a wrong precache", async () => {
    const { outDir: cleanDir } = await assembleFresh("verify-clean");
    assert.equal(verifyBundle(cleanDir).ok, true);

    const { outDir: modifiedDir } = await assembleFresh("verify-modified");
    appendFileSync(join(modifiedDir, "game", "rules.js"), "\n// modified after assembly\n");
    const modifiedResult = verifyBundle(modifiedDir);
    assert.equal(modifiedResult.ok, false);
    assert.ok(modifiedResult.problems.some((p) => /sha256 mismatch/.test(p) && p.includes("game/rules.js")));

    const { outDir: precacheDir } = await assembleFresh("verify-precache");
    const swPath = join(precacheDir, "sw.js");
    const swText = readFileSync(swPath, "utf8");
    const tamperedSw = swText.replace(/^const PRECACHE = \[.*\];$/m, 'const PRECACHE = ["index.html"];');
    writeFileSync(swPath, tamperedSw);
    const precacheResult = verifyBundle(precacheDir);
    assert.equal(precacheResult.ok, false);
    assert.ok(precacheResult.problems.some((p) => /precache/.test(p)));
  });

  await test("fallbackIconPng round-trips through pngSize", () => {
    for (const size of [64, 192, 512]) {
      for (const glyph of ["circle", "diamond", "square", "triangle"]) {
        const buf = fallbackIconPng({ size, palette: ["#0B1020", "#38E8FF"], glyph });
        const dims = pngSize(buf);
        assert.deepEqual(dims, { width: size, height: size });
      }
    }
    // deterministic: same inputs, same bytes
    const a = fallbackIconPng({ size: 128, palette: ["#111111", "#eeeeee"], glyph: "diamond" });
    const b = fallbackIconPng({ size: 128, palette: ["#111111", "#eeeeee"], glyph: "diamond" });
    assert.ok(a.equals(b));
  });

  await test("ports.js fake adapters transition correctly", () => {
    const p = createPorts();
    assert.equal(p.consent.state(), "denied");
    p.analytics.track("a", {});
    assert.equal(p.analytics.sink.length, 0);
    p.consent.grant();
    assert.equal(p.analytics.sink.length, 1);
    assert.equal(p.monetization.state(), "disabled");
    p.monetization.enable();
    const purchase = p.monetization.purchase("sku1");
    assert.equal(purchase.ok, true);
    assert.equal(p.monetization.state(), "entitled");
    p.haptics.pulse("tick");
    assert.equal(p.haptics.history().length, 1);
  });

  await test("themeFromVisual converts [name, hex] pairs to a flat hex palette", () => {
    const theme = themeFromVisual({ palette: VECTOR_VAULT_PALETTE, type: "blueprint" });
    assert.deepEqual(theme.palette, ["#0B1020", "#38E8FF", "#FFC857", "#FF5D73", "#F5F7FF"]);
    assert.deepEqual(theme.names, ["Vault Navy", "Pulse Cyan", "Vector Gold", "Lock Coral", "Paper White"]);
    assert.equal(theme.type, "blueprint");
    assert.equal(theme.reducedMotion, false);
  });

  console.log(`\n${n} gamefactorykit tests passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
