/*
 * gamefactoryqa_test.mjs -- tests for gamefactoryqa.mjs itself: createServerQaRunner's contract
 * shape, emptyResults(), health(), and the two honest-failure-reporting requirements from
 * LANE-gfkit.md section G #4 -- a timeout (a harness stub that sleeps) and a crash (missing
 * run.mjs) must both be reported HONESTLY (all 12 suites present, a clear reason, ok:false), never
 * silently, never as a fabricated pass. Every temp dir lives under os.tmpdir().
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServerQaRunner, emptyResults, QA_SUITE_NAMES } from "./gamefactoryqa.mjs";
import { assembleBundle, fallbackIconPng, referenceGame, themeFromVisual } from "./gamefactorykit/kit.mjs";

let n = 0;
async function test(name, fn) { await fn(); console.log("ok", ++n, "-", name); }

const dir = mkdtempSync(join(tmpdir(), "dominion-gfqa-"));

try {
  await test("emptyResults() reports all 12 suites FAILED with the given reason, in schema", () => {
    const r = emptyResults("something went wrong");
    assert.equal(r.schema, "gf-qa/1");
    assert.equal(r.runner, "server-qa");
    assert.equal(Object.keys(r.suites).length, 12);
    assert.equal(QA_SUITE_NAMES.length, 12);
    for (const name of QA_SUITE_NAMES) {
      assert.ok(r.suites[name], `missing suite ${name}`);
      assert.equal(r.suites[name].status, "FAILED");
      assert.ok(r.suites[name].summary.includes("something went wrong"));
      assert.deepEqual(r.suites[name].failures, []);
    }
  });

  await test("health() reports its own configuration", () => {
    const runner = createServerQaRunner({ timeoutMs: 12345, maxOldSpaceMb: 256 });
    const h = runner.health();
    assert.equal(h.ok, true);
    assert.equal(h.timeoutMs, 12345);
    assert.equal(h.maxOldSpaceMb, 256);
  });

  await test("a crash (missing qa/run.mjs) is reported honestly: all 12 suites present, ok:false, exitCode non-zero", async () => {
    const bundleDir = join(dir, "bundle-crash");
    mkdirSync(join(bundleDir, "qa"), { recursive: true }); // qa/ exists but run.mjs does not
    const resultsDir = join(dir, "results-crash");
    const runner = createServerQaRunner({ timeoutMs: 15000 });
    const outcome = await runner.run({ bundleDir, resultsDir });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, false);
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(Object.keys(outcome.results.suites).length, 12);
    for (const name of QA_SUITE_NAMES) assert.equal(outcome.results.suites[name].status, "FAILED");
    assert.ok(outcome.results.suites["core-loop"].summary.includes("without writing a results file") || outcome.results.suites["core-loop"].summary.includes("exited"));
  });

  await test("a timeout (a harness stub that spins forever) is reported honestly: killed, all 12 suites present, ok:false", async () => {
    const bundleDir = join(dir, "bundle-timeout");
    mkdirSync(join(bundleDir, "qa"), { recursive: true });
    writeFileSync(join(bundleDir, "qa", "run.mjs"), `
      // deliberately hangs well past any reasonable QA timeout, so the runner must kill it.
      const until = Date.now() + 120000;
      while (Date.now() < until) { /* spin */ }
    `);
    const resultsDir = join(dir, "results-timeout");
    const runner = createServerQaRunner({ timeoutMs: 1500 });
    const t0 = Date.now();
    const outcome = await runner.run({ bundleDir, resultsDir });
    const wallMs = Date.now() - t0;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true);
    assert.ok(wallMs < 15000, `runner took ${wallMs}ms to notice and kill a 1500ms-budget timeout -- the kill did not work`);
    assert.equal(Object.keys(outcome.results.suites).length, 12);
    for (const name of QA_SUITE_NAMES) {
      assert.equal(outcome.results.suites[name].status, "FAILED");
      assert.ok(outcome.results.suites[name].summary.includes("timed out"));
    }
  });

  await test("a normal bundle produces the full contract shape: ok, results, timedOut, exitCode, stdout, stderr, runner, durationMs", async () => {
    const outDir = join(dir, "bundle-shape");
    const generated = referenceGame("vector-vault");
    const theme = themeFromVisual({ palette: [["Vault Navy", "#0B1020"], ["Pulse Cyan", "#38E8FF"], ["Vector Gold", "#FFC857"], ["Lock Coral", "#FF5D73"], ["Paper White", "#F5F7FF"]] });
    const assets = {
      "assets/icon-512.png": fallbackIconPng({ size: 512, palette: theme.palette }),
      "assets/icon-192.png": fallbackIconPng({ size: 192, palette: theme.palette }),
      "assets/splash.png": fallbackIconPng({ size: 640, palette: theme.palette, glyph: "diamond" }),
      "assets/provenance.json": JSON.stringify([
        { path: "assets/icon-512.png", sha256: "x" }, { path: "assets/icon-192.png", sha256: "x" }, { path: "assets/splash.png", sha256: "x" },
      ]),
    };
    const meta = {
      name: "Vector Vault", slug: "vector-vault", palette: theme.palette,
      events: ["vault_start", "vector_adjust", "hint_used", "launch_result", "vault_complete", "session_end"],
      actions: [{ type: "launch", params: [] }],
    };
    await assembleBundle({ outDir, generated, meta, assets });
    const resultsDir = join(dir, "results-shape");
    const runner = createServerQaRunner({ timeoutMs: 30000 });
    const outcome = await runner.run({ bundleDir: outDir, resultsDir });
    for (const key of ["ok", "results", "timedOut", "exitCode", "stdout", "stderr", "runner", "durationMs"]) {
      assert.ok(key in outcome, `outcome is missing "${key}"`);
    }
    assert.equal(outcome.runner, "server-qa");
    assert.equal(typeof outcome.durationMs, "number");
    assert.ok(outcome.durationMs >= 0);
    assert.equal(outcome.results.schema, "gf-qa/1");
    assert.equal(outcome.ok, true);
  });

  await test("the permission globs use the host's path separator (the first production run failed on Linux with a literal '\\*')", async () => {
    const bundleDir = join(dir, "bundle-sep");
    mkdirSync(join(bundleDir, "qa"), { recursive: true }); // no run.mjs: the child exits fast, we only need the spawn line
    const resultsDir = join(dir, "results-sep");
    const lines = [];
    const runner = createServerQaRunner({ timeoutMs: 15000, log: (line) => lines.push(String(line)) });
    await runner.run({ bundleDir, resultsDir });
    const spawnLine = lines.find((line) => line.includes("spawning:"));
    assert.ok(spawnLine, "the runner logs its spawn command");
    assert.ok(spawnLine.includes(`--allow-fs-read=${join(bundleDir, "*")}`), spawnLine);
    assert.ok(spawnLine.includes(`--allow-fs-write=${join(resultsDir, "*")}`), spawnLine);
    if (sep === "/") assert.ok(!spawnLine.includes("\\*"), "a POSIX host must never see a backslash glob: " + spawnLine);
  });

  console.log(`\n${n} gamefactoryqa tests passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
