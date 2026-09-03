#!/usr/bin/env node
/*
 * Full live rig (Fred, 2026-07-30): the dev server with REAL provider keys AND a REAL hands node
 * attached, so a chat build, a Crucible run, and a Beginner run all reach actual files on Z: —
 * end to end, without touching production or any customer data.
 *
 *   node ops/live-rig.mjs [basePort]     (default 8230)
 *
 * Ports: guest = base, owner = base+1, app = base+2, mock-ollama = base+3.
 * The hands node runs in-process (hands/hands.mjs as a child) dialing THIS rig, rooted at the
 * test workspace only, so nothing outside it can be written by a test build.
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASE = Number(process.argv[2]) || 8230;
const APP = BASE + 2;
// F: is the standing sandbox drive (Fred, 2026-08-03: Z: died at the hardware level and is
// permanently retired -- never plan a restore-to-Z: step). This default pointed at the dead drive
// until 2026-09-03 (foundry lane, DEFICIENCIES.md #27 tooling half), so every rig boot that forgot
// to set LIVE_RIG_WORKSPACE explicitly failed at mkdirSync below instead of just working.
const WORKSPACE = process.env.LIVE_RIG_WORKSPACE || "F:\\Claude Sandbox\\dominion-livetest";
const HANDS_TOKEN = "live-rig-" + BASE + "-token";

mkdirSync(WORKSPACE, { recursive: true });

function walletEnv() {
  const env = {};
  try {
    const raw = readFileSync(join(process.env.USERPROFILE || "", ".app-secrets.env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
      if (m) env[m[1]] = m[2];
    }
  } catch (e) { console.error("[live-rig] wallet read failed: " + (e && e.message)); }
  return env;
}

const wallet = walletEnv();
console.log("[live-rig] booting rig on base " + BASE + ", workspace " + WORKSPACE);
/*
 * Merge order fix (2026-09-03, foundry lane): this used to be
 * `{ ...process.env, ...wallet, ... }`, which means the WALLET always won over an explicit
 * override the caller set before invoking this script -- every key the wallet carries (which is
 * most of them, including OPEN_AI_DOMINION_UI_APIKEY) silently discarded whatever the shell had
 * exported. That defeats a deliberately broken-key proof like
 * `OPEN_AI_DOMINION_UI_APIKEY=bogus node ops/live-rig.mjs 8380` (used to prove the Foundry's
 * paid-engine-fails-over-to-draft ladder on a real rig, not just against a mock): the rig would
 * boot with the REAL key regardless, and the fall-through path would never actually fire. Wallet
 * now supplies DEFAULTS ONLY, filling in anything the invoking shell did not already set;
 * process.env (this process's own environment, which includes whatever the caller exported) wins.
 */
const server = spawn(process.execPath, [join(ROOT, "devboot.mjs"), String(BASE)], {
  cwd: ROOT,
  // IDE_MODE / ENGINEER_PUBLIC mirror PRODUCTION (Railway has IDE_MODE=all), so guest parity is
  // measured against the configuration guests actually meet, not a stricter dev default.
  env: { ...wallet, ...process.env, DEVBOOT_ALLOW_PAID: "1", HANDS_TOKEN, HANDS_DEFAULT_NODE: "livetest",
         IDE_MODE: "all", ENGINEER_PUBLIC: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

let node = null;
process.on("exit", () => { try { server.kill(); } catch {} try { node && node.kill(); } catch {} });
process.on("SIGINT", () => process.exit(0));

// wait for the app, then attach the hands node
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const r = await fetch("http://127.0.0.1:" + APP + "/api/version"); if (r.ok) break; } catch {}
}
console.log("[live-rig] app up; starting hands node rooted at " + WORKSPACE);
node = spawn(process.execPath, [join(ROOT, "hands", "hands.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    HANDS_URL: "http://127.0.0.1:" + APP,
    HANDS_TOKEN,
    HANDS_NODE: "livetest",
    HANDS_ROOTS: WORKSPACE,
    HANDS_MAX_ACCESS: "0",
    HANDS_DESKTOP: "0",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

console.log("[live-rig] ready:");
console.log("  owner  http://127.0.0.1:" + (BASE + 1));
console.log("  guest  http://127.0.0.1:" + BASE);
console.log("  app    http://127.0.0.1:" + APP);
