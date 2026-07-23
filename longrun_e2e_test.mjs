/*
 * Long-run /jobs endpoint e2e — run: node longrun_e2e_test.mjs
 * Boots the REAL server (chatsync_test's rig) and proves: identity is required, the owner sees
 * their ledger over the wire, pause/resume round-trips, and a guest gets their OWN empty store
 * rather than a 503 (the chatsync lesson: both resolver branches wired) or the owner's jobs.
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLongRun } from "./longrun.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8830 + Math.floor(process.uptime() * 7) % 120;
const MOCK_OLLAMA = PORT + 1;
const OWNER = "owner@test.com", GUEST = "guest@test.com";
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "longrun-e2e-"));

// Seed the owner's job store on disk BEFORE boot; the server store reads the same dir.
const seed = createLongRun({ dir: join(dir, "jobs") });
const seeded = seed.createJob({ mission: "review the whole app without lying about it", plan: [{ title: "read" }, { title: "report" }] });
seed.appendLedger(seeded.id, { unit: 0, action: "read", outcome: "done", fp: "aa" });

const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

const H = (email) => (email ? { "cf-access-authenticated-user-email": email } : {});
function req(method, path, { email = "", body = null } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...H(email) } },
      (res) => { let b = ""; res.on("data", (d) => b += d); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j }); }); });
    r.on("error", () => resolve({ status: 0, body: null }));
    if (data) r.write(data); r.end();
  });
}
for (let i = 0; i < 120; i++) {
  const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
  if (ok) break;
  if (i === 119) { console.error("server never came up:\n" + bootLog.slice(-2000)); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}

await t("no identity = 401, never a silent empty list", async () => {
  const r = await req("GET", "/jobs");
  assert(r.status === 401, "expected 401, got " + r.status);
});

await t("owner sees the seeded job over the wire", async () => {
  const r = await req("GET", "/jobs", { email: OWNER });
  assert(r.status === 200, "status " + r.status);
  assert(r.body.jobs.length === 1 && r.body.jobs[0].mission.includes("review the whole app"), "missing seeded job: " + JSON.stringify(r.body));
});

await t("job detail carries meta, progress counts, and the ledger tail", async () => {
  const r = await req("GET", "/jobs?id=" + seeded.id, { email: OWNER });
  assert(r.status === 200, "status " + r.status);
  assert(r.body.done === 1 && r.body.remaining === 1, "progress wrong: " + JSON.stringify(r.body));
  assert(r.body.ledgerTail.length === 1 && r.body.ledgerTail[0].action === "read", "tail wrong");
});

await t("pause and resume round-trip over the wire", async () => {
  const p = await req("POST", "/jobs", { email: OWNER, body: { op: "pause", id: seeded.id } });
  assert(p.status === 200 && p.body.meta.state === "paused", "pause failed: " + JSON.stringify(p.body));
  const r = await req("POST", "/jobs", { email: OWNER, body: { op: "resume", id: seeded.id } });
  assert(r.status === 200 && r.body.meta.state === "ready", "resume failed");
});

await t("owner approves a tranche over the wire; the detail view carries the budget honestly", async () => {
  const a = await req("POST", "/jobs", { email: OWNER, body: { op: "approve-tranche", id: seeded.id } });
  assert(a.status === 200 && a.body.approved === 1, "approve failed: " + JSON.stringify(a.body));
  assert(a.body.budget.approvedUsd === 5, "owner default tranche must be $5, got " + JSON.stringify(a.body.budget));
  const d = await req("GET", "/jobs?id=" + seeded.id, { email: OWNER });
  assert(d.body.budget && d.body.budget.remainingUsd === 5 && d.body.budget.spentUsd === 0, "detail budget wrong: " + JSON.stringify(d.body.budget));
});

await t("create over the wire (keyless rig): job starts, fails honestly, pauses, spends nothing", async () => {
  const c = await req("POST", "/jobs", { email: OWNER, body: { op: "create", mission: "prove the wire",
    plan: [{ title: "one unit" }], model: "openai/gpt-5.6-luna", tranches: 1 } });
  assert(c.status === 200, "create failed: " + JSON.stringify(c.body));
  assert(c.body.started === true, "runner did not start: " + JSON.stringify(c.body));
  assert(c.body.budget.approvedUsd === 5, "owner tranche must be $5");
  const id = c.body.meta.id;
  // The rig has no provider keys, so the unit fails fast twice and the job pauses honestly.
  let d = null;
  for (let i = 0; i < 50; i++) {
    d = await req("GET", "/jobs?id=" + id, { email: OWNER });
    if (d.body.meta && d.body.meta.state === "paused") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(d.body.meta.state === "paused", "expected paused, got " + JSON.stringify(d.body.meta));
  assert(/key configured/i.test(d.body.meta.reason), "reason must name the missing key: " + d.body.meta.reason);
  assert(d.body.done === 0 && d.body.budget.spentUsd === 0, "a keyless failure must spend nothing");
});

await t("create refuses a model the catalog does not know", async () => {
  const r = await req("POST", "/jobs", { email: OWNER, body: { op: "create", mission: "m", plan: [{ title: "u" }], model: "made/up-model" } });
  assert(r.status === 400 && r.body.code === "bad_model", JSON.stringify(r.body));
});

await t("guest creation without credits is refused with the pay-before-access wall", async () => {
  const r = await req("POST", "/jobs", { email: GUEST, body: { op: "create", mission: "m", plan: [{ title: "u" }], model: "openai/gpt-5.6-luna" } });
  assert(r.status === 402 && r.body.code === "needs_credits", "expected the credits wall, got " + r.status + " " + JSON.stringify(r.body));
});

await t("guest gets their OWN empty store, never a 503 (both resolver branches wired)", async () => {
  const r = await req("GET", "/jobs", { email: GUEST });
  assert(r.status === 200, "expected 200, got " + r.status + " " + JSON.stringify(r.body));
  assert(r.body.jobs.length === 0, "guest must not see the owner's jobs");
});

await t("guest cannot reach the owner's job by id (tenant wall)", async () => {
  const r = await req("GET", "/jobs?id=" + seeded.id, { email: GUEST });
  assert(r.status === 404, "expected 404, got " + r.status);
  const p = await req("POST", "/jobs", { email: GUEST, body: { op: "pause", id: seeded.id } });
  assert(p.status === 404, "guest pause of owner job must 404, got " + p.status);
});

// Windows: the child must actually EXIT before its open handles let the temp dir delete.
const gone = new Promise((r) => child.once("exit", r));
child.kill();
await gone;
mockOllama.close();
try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, OS sweeps it */ }
console.log(`\nlongrun_e2e: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
