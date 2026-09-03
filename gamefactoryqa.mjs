/*
 * gamefactoryqa.mjs -- the server QA runner: spawns gamefactorykit/qa/run.mjs in a locked-down
 * child Node process against one assembled bundle. See LANE-gfkit.md section F and
 * GAME-FACTORY-BUILD.md D4/D9. This file lives in the Dominion server process (unrestricted); only
 * the CHILD process it spawns runs under --permission.
 *
 * MEASURED, not guessed (rule 8.6) -- probed with real `node --permission` child processes (argv
 * ARRAY form, no shell, exactly how this file spawns) on this machine, Node v24.14.1, Windows:
 *
 *   1. Bare `--permission` with no --allow-fs-read denies reading anything the entry script
 *      imports (a sibling .mjs), but the entry script FILE ITSELF needs no explicit read grant --
 *      only what it goes on to import/read does.
 *   2. `--allow-fs-read=<bundleDir>\*` grants RECURSIVE read of everything under bundleDir,
 *      including nested subdirectories (verified with a 2-level-deep import chain) -- so one flag
 *      covers game/rules.js importing ./content.js, and qa/run.mjs importing ../game/*.js and
 *      ../kit/ports.js.
 *   3. `--allow-fs-write=<resultsDir>\*` is required and sufficient for the results.json write;
 *      it does not need to overlap bundleDir.
 *   4. A fully scrubbed env (PATH, SYSTEMROOT/WINDIR, TMP/TEMP pointed at resultsDir, NODE_OPTIONS
 *      empty) does not interfere with the permission gate.
 *   5. `--max-old-space-size` composes cleanly with `--permission`.
 *   6. `child_process` is DENIED under `--permission` without an explicit `--allow-child-process`
 *      grant, which this runner deliberately never gives the QA child (generated game code must
 *      never be able to spawn anything) -- this is exactly why qa/run.mjs's own syntax check falls
 *      back to vm.Script instead of `node --check`.
 *   7. `vm.SourceTextModule` is not a constructor without `--experimental-vm-modules`, which this
 *      runner also does not add (an extra flag beyond what was asked for).
 *
 *   Final command line: node --permission --allow-fs-read=<bundleDir>\* --allow-fs-write=<resultsDir>\*
 *     --max-old-space-size=<N> <bundleDir>\qa\run.mjs --bundle <bundleDir> --out <resultsDir>\results.json
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

export const QA_SUITE_NAMES = Object.freeze([
  "core-loop", "launch-smoke", "crash-regression", "controls", "save-state",
  "viewport", "performance", "monetization", "offline", "analytics",
  "privacy-consent", "store-readiness",
]);

const TAIL_BYTES = 64 * 1024;

function tailBuffer(buf) {
  return buf.length > TAIL_BYTES ? buf.subarray(buf.length - TAIL_BYTES) : buf;
}

/** emptyResults(reason) -> a full gf-qa/1 results object where every suite is FAILED with `reason`. Used when the runner never produced (or could not read) a real results file. */
export function emptyResults(reason) {
  const suites = {};
  for (const name of QA_SUITE_NAMES) {
    suites[name] = { status: "FAILED", summary: `the harness did not report this suite (${reason})`, metrics: {}, failures: [] };
  }
  const nowIso = new Date().toISOString();
  return { schema: "gf-qa/1", bundleSha256: "", startedAt: nowIso, endedAt: nowIso, runner: "server-qa", suites };
}

function scrubbedEnv(resultsDir) {
  const env = { PATH: process.env.PATH || process.env.Path || "" };
  if (platform() === "win32") {
    env.SYSTEMROOT = process.env.SYSTEMROOT || process.env.SystemRoot || "C:\\Windows";
    env.WINDIR = process.env.WINDIR || process.env.windir || env.SYSTEMROOT;
  }
  env.TMP = resultsDir;
  env.TEMP = resultsDir;
  env.NODE_OPTIONS = "";
  return env;
}

function killTree(pid, log) {
  if (!pid) return;
  if (platform() === "win32") {
    try { spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }); }
    catch (e) { log("[gamefactoryqa] taskkill failed for pid " + pid + ": " + (e && e.message)); }
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch (e) { log("[gamefactoryqa] SIGKILL failed for pid " + pid + ": " + (e && e.message)); } }
  }
}

/**
 * createServerQaRunner({ nodePath, timeoutMs, maxOldSpaceMb, log }) -> { run({bundleDir, resultsDir}), health() }
 */
export function createServerQaRunner({ nodePath = process.execPath, timeoutMs = 180_000, maxOldSpaceMb = 512, log = () => {} } = {}) {
  async function run({ bundleDir, resultsDir }) {
    const startedAt = Date.now();
    mkdirSync(resultsDir, { recursive: true });
    const outFile = join(resultsDir, "results.json");
    const runnerScript = join(bundleDir, "qa", "run.mjs");
    const args = [
      "--permission",
      `--allow-fs-read=${bundleDir}\\*`,
      `--allow-fs-write=${resultsDir}\\*`,
      `--max-old-space-size=${maxOldSpaceMb}`,
      runnerScript,
      "--bundle", bundleDir,
      "--out", outFile,
    ];
    log(`[gamefactoryqa] spawning: ${nodePath} ${args.join(" ")}`);

    const env = scrubbedEnv(resultsDir);
    const child = spawn(nodePath, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });

    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    child.stdout.on("data", (d) => { stdout = tailBuffer(Buffer.concat([stdout, d])); });
    child.stderr.on("data", (d) => { stderr = tailBuffer(Buffer.concat([stderr, d])); });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid, log); }, timeoutMs);
    // Node's default max is unaffected by this timer being unref'd; keep it ref'd so a hung QA
    // child cannot silently keep the whole server process alive if the caller exits early either.

    const exitInfo = await new Promise((resolve) => {
      child.on("error", (err) => resolve({ exitCode: null, error: err }));
      child.on("close", (code) => resolve({ exitCode: code, error: null }));
    });
    clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    let rawResults = null;
    try { rawResults = JSON.parse(readFileSync(outFile, "utf8")); } catch { rawResults = null; }

    const ranCleanly = !timedOut && exitInfo.exitCode === 0 && rawResults !== null;
    let results = rawResults;
    if (!results) {
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : exitInfo.error
          ? `spawn error: ${exitInfo.error.message}`
          : `exited ${exitInfo.exitCode} without writing a results file`;
      results = emptyResults(reason);
    } else {
      results.suites = results.suites || {};
      for (const name of QA_SUITE_NAMES) {
        if (!results.suites[name]) {
          results.suites[name] = { status: "FAILED", summary: "the harness did not report this suite (missing from its own output)", metrics: {}, failures: [] };
        }
      }
    }

    // `ok` is about the RUNNER, not the GAME: did the child execute cleanly and hand back real
    // data. Whether the game itself passed QA lives entirely in results.suites[*].status -- a
    // legitimately failing game with a healthy runner is ok:true, results full of FAILED suites.
    return {
      ok: ranCleanly,
      results,
      timedOut,
      exitCode: exitInfo.exitCode,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      runner: "server-qa",
      durationMs,
    };
  }

  function health() {
    return { ok: true, nodePath, timeoutMs, maxOldSpaceMb };
  }

  return { run, health };
}
