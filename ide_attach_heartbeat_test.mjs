/*
 * /ide/job/attach idle heartbeat self-test - run with: node ide_attach_heartbeat_test.mjs
 *
 * Deficiency #11: the attach stream wrote NOTHING between structural job events, and a tiny rig
 * build measured silent gaps up to 166s — comfortably past Cloudflare's ~100s idle-stream close.
 * Production's 09-02 build was cut 61 times in 41 minutes for exactly this reason.
 *
 * This boots a REAL server.mjs (no mocks needed — no model call, no key, no spend: idejobs.mjs's
 * own "probe" job kind exists precisely to prove the job spine end to end with zero cost) and
 * starts a Phase-2 probe job with `ask:true`, which freezes on a need_input event at ~1.5s and
 * then sits open INDEFINITELY with no further structural events — the exact idle condition the
 * heartbeat exists for. It then reads the raw SSE body of /ide/job/attach and asserts a `: hb`
 * comment frame arrives at least once within the 15s contract, with no structural event needed
 * to produce it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8973;
const dataDir = mkdtempSync(join(tmpdir(), "idehb-"));
let passed = 0;
const ok = (n) => { console.log("  ok  " + n); passed++; };

const env = {
  ...process.env,
  PORT: String(APP), HOST: "127.0.0.1",
  DATA_DIR: dataDir, MEMORY_DIR: join(dataDir, "memory"), CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"), PERSONA_DIR: join(dataDir, "corpus"),
  PERSONA_STAGING: join(dataDir, "staging"), FLYWHEEL_DIR: join(dataDir, "flywheel"),
  LOG_DIR: join(dataDir, "logs"), SANDBOX_DIR: join(dataDir, "sandbox"),
  CHATJOBS_DIR: join(dataDir, "chatjobs"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", BILLING_RETRY_ENABLED: "0",
  // Single-tenant (MULTI_TENANT unset -> "0"): every request resolves to the owner automatically,
  // no auth headers needed — this test is about the attach transport, not tenancy.
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "",
  DEEPSEEK_AI_DOMINION_UI_APIKEY: "", STRIPE_SECRET_KEY: "", HANDS_TOKEN: "",
};

const server = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
let serverExited = null;
server.on("exit", (code) => { serverExited = code; });

function cleanup() {
  try { server.kill(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

async function waitForBoot() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (serverExited !== null) throw new Error("server exited during boot (code " + serverExited + ")\n" + serverLog.slice(-3000));
    try {
      const r = await fetch("http://127.0.0.1:" + APP + "/api/version");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not come up in time\n" + serverLog.slice(-3000));
}

try {
  await waitForBoot();
  ok("server booted");

  // Start a zero-spend probe job frozen on a question — idejobs.mjs / server.mjs's own mechanism
  // for proving the job spine without a model call. ask:true freezes it on need_input at ~1.5s and
  // it then sits open with no further structural events, which is exactly the idle window under test.
  const startRes = await fetch("http://127.0.0.1:" + APP + "/ide/job", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ask: true }),
  });
  if (startRes.status !== 200) throw new Error("starting the probe job must succeed: HTTP " + startRes.status + " " + await startRes.text());
  const { jobId } = await startRes.json();
  assert.ok(jobId, "the probe job must return a jobId");
  ok("zero-spend probe job started, jobId=" + jobId);

  // Let the probe reach its frozen need_input state before attaching, so the attach connection
  // itself starts in the idle window (not mid-replay of the fast early events).
  await new Promise((r) => setTimeout(r, 2000));

  const attachRes = await fetch("http://127.0.0.1:" + APP + "/ide/job/attach?job=" + encodeURIComponent(jobId) + "&from=0");
  assert.equal(attachRes.status, 200);
  assert.match(String(attachRes.headers.get("content-type") || ""), /text\/event-stream/);
  ok("attach stream opened");

  // Read raw bytes for ~13s (one heartbeat interval + margin under the 15s contract) with NO
  // client interaction — the probe job is frozen, so the only thing that can arrive is heartbeats
  // (plus the replayed early events at the very start).
  const reader = attachRes.body.getReader();
  const dec = new TextDecoder();
  let raw = "";
  const readDeadline = Date.now() + 13000;
  while (Date.now() < readDeadline) {
    const remaining = readDeadline - Date.now();
    const chunkPromise = reader.read();
    const timeoutPromise = new Promise((r) => setTimeout(() => r({ done: false, value: null, __timeout: true }), Math.max(0, remaining)));
    const res = await Promise.race([chunkPromise, timeoutPromise]);
    if (res.__timeout) break;
    if (res.done) break;
    raw += dec.decode(res.value, { stream: true });
  }
  try { await reader.cancel(); } catch {}

  const hbCount = (raw.match(/: hb\n\n/g) || []).length;
  assert.ok(hbCount >= 1, "expected at least one ': hb' heartbeat frame during ~13s of idle attach, saw " + hbCount + ". Raw tail: " + JSON.stringify(raw.slice(-500)));
  ok("idle attach emitted " + hbCount + " heartbeat frame(s) within the 15s contract, with zero structural events after need_input");

  // A frozen probe job never spends, but tidy up the record anyway.
  await fetch("http://127.0.0.1:" + APP + "/ide/job/stop", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }),
  }).catch(() => {});

  console.log(`\nide_attach_heartbeat_test: ${passed} checks passed`);
  process.exit(0);
} catch (e) {
  console.error("FAIL: " + (e && e.stack || e));
  console.error("\n--- server log tail ---\n" + serverLog.slice(-3000));
  process.exit(1);
}
