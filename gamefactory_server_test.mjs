/*
 * Focused wiring test for the real Dominion server. The domain/HTTP modules have their own deeper
 * suites; this proves server.mjs mounts them behind real tenancy, publishes the account entitlement
 * and deploy-safety count, and rewrites only the exact /games SPA route.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, ".devdata-gamefactory-server-test");
mkdirSync(DATA, { recursive: true });
const OWNER = "factory-owner@test.invalid";
let passed = 0;
let prepushPayload = null;

const mock = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/api/version" && prepushPayload) return res.end(JSON.stringify(prepushPayload));
  res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" } }) : "{}");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const MOCK_PORT = mock.address().port;
const reservation = http.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const PORT = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const env = {
  ...process.env,
  PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: DATA,
  MEMORY_DIR: join(DATA, "memory"), CHATLOG_DIR: join(DATA, "chatlog"),
  ARTIFACT_DIR: join(DATA, "artifacts"), PERSONA_DIR: join(DATA, "corpus"),
  PERSONA_STAGING: join(DATA, "staging"), FLYWHEEL_DIR: join(DATA, "flywheel"),
  LOG_DIR: join(DATA, "logs"), SANDBOX_DIR: join(DATA, "sandbox"),
  OLLAMA_URL: `http://127.0.0.1:${MOCK_PORT}`,
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER, ACCESS_JWT: "off",
  GAME_FACTORY_MODE: "owner", GAME_FACTORY_RECONCILER: "0",
  GAME_FACTORY_ARTIFACT_WRITES: "0", GAME_FACTORY_MIRROR_WRITES: "0", GAME_FACTORY_RELEASE_WRITES: "0",
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0",
  CLOUD_BACKUP_ENABLED: "0", BILLING_RETRY_ENABLED: "0", CATALOG_AUDIT: "0",
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "", NVIDIA_API_KEY: "", STRIPE_SECRET_KEY: "",
};
const child = spawn(process.execPath, [join(HERE, "server.mjs")], {
  cwd: HERE, env, stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (chunk) => { bootLog += chunk; });
child.stderr.on("data", (chunk) => { bootLog += chunk; });

function request(path, { method = "GET", email = "", body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const encoded = body == null ? "" : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: PORT, path, method,
      headers: {
        ...(email ? { "cf-access-authenticated-user-email": email } : {}),
        ...(encoded ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } : {}),
        ...headers,
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
    req.end(encoded);
  });
}

async function waitForBoot() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request("/api/version");
    if (response.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not boot:\n" + bootLog.slice(-3000));
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok - " + name);
}

function runPrepush(payload, args = []) {
  prepushPayload = payload;
  return new Promise((resolve) => {
    const processUnderTest = spawn(process.execPath, [join(HERE, "ops", "prepush-check.mjs"), ...args], {
      cwd: HERE,
      env: { ...process.env, DOMINION_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    processUnderTest.stdout.on("data", (chunk) => { stdout += chunk; });
    processUnderTest.stderr.on("data", (chunk) => { stderr += chunk; });
    processUnderTest.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  await waitForBoot();

  await test("public version reports the separate factory deploy-safety count", async () => {
    const response = await request("/api/version");
    assert.equal(response.status, 200);
    assert.equal(response.body.runningFactoryTasks, 0);
  });

  await test("account entitlement is strict owner-only when GAME_FACTORY_MODE=owner", async () => {
    const owner = await request("/account", { email: OWNER });
    const guest = await request("/account", { email: "guest@test.invalid" });
    assert.equal(owner.body.gameFactory, true);
    assert.equal(guest.body.gameFactory, false);
  });

  await test("real API mount enforces identity and feature entitlement", async () => {
    const anonymous = await request("/api/game-factory/config");
    const guest = await request("/api/game-factory/config", { email: "guest@test.invalid" });
    const owner = await request("/api/game-factory/config", { email: OWNER });
    assert.equal(anonymous.status, 401);
    assert.equal(guest.status, 403);
    assert.equal(owner.status, 200);
    assert.equal(owner.body.allowed, true);
    const bootstrap = await request("/api/game-factory/bootstrap", { email: OWNER });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.health.worker.enabled, false);
    assert.equal(bootstrap.body.health.worker.state, "disabled");
    const first = bootstrap.body.games[0];
    assert.equal(first.allowedActions.some((action) => action.id === "start"), true);
    const refusedStart = await request(`/api/game-factory/games/${encodeURIComponent(first.id)}/commands`, {
      method: "POST", email: OWNER,
      headers: { "x-dominion-action": "game-factory", "idempotency-key": "server-start-writes-off" },
      body: { command: "start", expectedVersion: first.version },
    });
    assert.equal(refusedStart.status, 503);
    assert.equal(refusedStart.body.code, "artifact_writes_disabled");
    const unchanged = await request(`/api/game-factory/games/${encodeURIComponent(first.id)}`, { email: OWNER });
    assert.equal(unchanged.body.game.state, "IDEA");
  });

  await test("only the exact GET /games path rewrites to the SPA shell", async () => {
    const games = await request("/games", { email: OWNER });
    const nested = await request("/games/not-a-route", { email: OWNER });
    const post = await request("/games", { method: "POST", email: OWNER });
    assert.equal(games.status, 200);
    assert.match(String(games.headers["content-type"]), /^text\/html/);
    assert.match(String(games.body), /dominion-game-factory\.js/);
    assert.equal(nested.status, 404);
    assert.equal(post.status, 404);
  });

  await test("pre-push guard refuses live or unreported factory work and pins one-time bootstrap", async () => {
    const safe = await runPrepush({ build: "test", runningChatJobs: 0, runningBuilds: 0, runningFactoryTasks: 0 });
    const busy = await runPrepush({ build: "test", runningChatJobs: 0, runningBuilds: 0, runningFactoryTasks: 2 });
    const unknown = await runPrepush({ build: "test", runningChatJobs: 0, runningBuilds: 0 });
    const bootstrap = await runPrepush({ build: "legacy-build", runningChatJobs: 0, runningBuilds: 0 }, ["--bootstrap-factory-from=legacy-build"]);
    const mismatch = await runPrepush({ build: "different-build", runningChatJobs: 0, runningBuilds: 0 }, ["--bootstrap-factory-from=legacy-build"]);
    const bootstrapBusy = await runPrepush({ build: "legacy-build", runningChatJobs: 1, runningBuilds: 0 }, ["--bootstrap-factory-from=legacy-build"]);
    assert.equal(safe.code, 0, safe.stderr || safe.stdout);
    assert.equal(busy.code, 1, busy.stderr || busy.stdout);
    assert.match(busy.stdout, /2 running Mobile Game Factory task/);
    assert.equal(unknown.code, 3, unknown.stderr || unknown.stdout);
    assert.match(unknown.stderr, /does not report runningFactoryTasks/);
    assert.equal(bootstrap.code, 0, bootstrap.stderr || bootstrap.stdout);
    assert.match(bootstrap.stdout, /one-time factory bootstrap is safe/);
    assert.equal(mismatch.code, 3, mismatch.stderr || mismatch.stdout);
    assert.match(mismatch.stderr, /bootstrap build mismatch/);
    assert.equal(bootstrapBusy.code, 1, bootstrapBusy.stderr || bootstrapBusy.stdout);
  });
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let killTimer;
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => { killTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000); }),
  ]).finally(() => clearTimeout(killTimer));
  await new Promise((resolve) => mock.close(resolve));
}

console.log(`\n${passed} game factory server wiring tests passed`);
