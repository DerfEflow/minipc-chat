/*
 * Focused wiring test for the real Dominion server. The domain/HTTP modules have their own deeper
 * suites; this proves server.mjs mounts them behind real tenancy, publishes the account entitlement
 * and deploy-safety count, and rewrites only the exact /games SPA route.
 */
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, ".devdata-gamefactory-server-test");
mkdirSync(DATA, { recursive: true });
const OWNER = "factory-owner@test.invalid";
const ACCESS_TEAM = "factory-test.cloudflareaccess.com";
const ACCESS_AUD = "factory-test-audience";
const SERVICE_OWNER_CN = "factory-test-service-owner";
const { publicKey: accessPublicKey, privateKey: accessPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const accessJwk = { ...accessPublicKey.export({ format: "jwk" }), kid: "factory-test-key", alg: "RS256", use: "sig" };
const accessFetchPreload = `
const originalFetch = globalThis.fetch;
const keys = ${JSON.stringify({ keys: [accessJwk] })};
globalThis.fetch = async (input, init) => String(input).includes("/cdn-cgi/access/certs")
  ? new Response(JSON.stringify(keys), { status: 200, headers: { "content-type": "application/json" } })
  : originalFetch(input, init);
`;

function accessToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: accessJwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: `https://${ACCESS_TEAM}`, aud: ACCESS_AUD, iat: now - 5, exp: now + 3600, ...claims,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input); signer.end();
  return `${input}.${signer.sign(accessPrivateKey).toString("base64url")}`;
}

const OWNER_JWT = accessToken({ email: OWNER, sub: "factory-owner" });
const GUEST_JWT = accessToken({ email: "guest@test.invalid", sub: "factory-guest" });
const SERVICE_OWNER_JWT = accessToken({ common_name: SERVICE_OWNER_CN });
const SERVICE_JWT = accessToken({ common_name: "factory-test-unmapped-service" });
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
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER, ACCESS_JWT: "enforce",
  CF_ACCESS_TEAM_DOMAIN: ACCESS_TEAM, CF_ACCESS_AUD: ACCESS_AUD, SERVICE_OWNER_CNS: SERVICE_OWNER_CN,
  GAME_FACTORY_MODE: "owner", GAME_FACTORY_RECONCILER: "0", GAME_FACTORY_NODE: "gx10-gamefactory",
  GAME_FACTORY_SYNTHETIC_CANARY: "1",
  GAME_FACTORY_ARTIFACT_WRITES: "0", GAME_FACTORY_MIRROR_WRITES: "0", GAME_FACTORY_RELEASE_WRITES: "0",
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0",
  CLOUD_BACKUP_ENABLED: "0", BILLING_RETRY_ENABLED: "0", CATALOG_AUDIT: "0",
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "", NVIDIA_API_KEY: "", STRIPE_SECRET_KEY: "",
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=data:text/javascript,${encodeURIComponent(accessFetchPreload)}`].filter(Boolean).join(" "),
};
const child = spawn(process.execPath, [join(HERE, "server.mjs")], {
  cwd: HERE, env, stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (chunk) => { bootLog += chunk; });
child.stderr.on("data", (chunk) => { bootLog += chunk; });

function request(path, { method = "GET", email = "", jwt = "", body = null, headers = {}, port = PORT } = {}) {
  return new Promise((resolve) => {
    const encoded = body == null ? "" : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path, method,
      headers: {
        ...(email ? { "cf-access-authenticated-user-email": email } : {}),
        ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
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

async function stopChild(processUnderTest) {
  const exited = new Promise((resolve) => processUnderTest.once("exit", resolve));
  let killTimer;
  processUnderTest.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => { killTimer = setTimeout(() => { processUnderTest.kill("SIGKILL"); resolve(); }, 10_000); }),
  ]).finally(() => clearTimeout(killTimer));
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
    const owner = await request("/account", { jwt: OWNER_JWT });
    const guest = await request("/account", { jwt: GUEST_JWT });
    assert.equal(owner.body.gameFactory, true);
    assert.equal(guest.body.gameFactory, false);
  });

  await test("factory rejects an owner-mapped service principal without changing its non-factory owner identity", async () => {
    const account = await request("/account", { jwt: SERVICE_OWNER_JWT });
    assert.equal(account.status, 200);
    assert.equal(account.body.isOwner, true);
    assert.equal(account.body.email, OWNER);
    const factory = await request("/api/game-factory/config", { jwt: SERVICE_OWNER_JWT });
    assert.equal(factory.status, 403);
    assert.equal(factory.body.code, "human_owner_required");
    const canary = await request("/api/game-factory/admin/synthetic-canary", {
      method: "POST", jwt: SERVICE_OWNER_JWT,
      headers: { "x-dominion-action": "game-factory-synthetic-canary", "idempotency-key": "service-canary-denied-0001" },
      body: { projectId: "gf_owner_test" },
    });
    assert.equal(canary.status, 403);
    assert.equal(canary.body.code, "human_owner_required");
  });

  await test("real API mount enforces identity and feature entitlement", async () => {
    const anonymous = await request("/api/game-factory/config");
    const forgedOwnerHeader = await request("/api/game-factory/config", { email: OWNER });
    const guest = await request("/api/game-factory/config", { jwt: GUEST_JWT });
    const owner = await request("/api/game-factory/config", { jwt: OWNER_JWT });
    assert.equal(anonymous.status, 401);
    assert.equal(forgedOwnerHeader.status, 401);
    assert.equal(guest.status, 403);
    assert.equal(owner.status, 200);
    assert.equal(owner.body.allowed, true);
    const bootstrap = await request("/api/game-factory/bootstrap", { jwt: OWNER_JWT });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.health.worker.enabled, false);
    assert.equal(bootstrap.body.health.worker.state, "disabled");
    const first = bootstrap.body.games[0];
    assert.equal(first.allowedActions.some((action) => action.id === "start"), true);
    const refusedStart = await request(`/api/game-factory/games/${encodeURIComponent(first.id)}/commands`, {
      method: "POST", jwt: OWNER_JWT,
      headers: { "x-dominion-action": "game-factory", "idempotency-key": "server-start-writes-off" },
      body: { command: "start", expectedVersion: first.version },
    });
    assert.equal(refusedStart.status, 503);
    assert.equal(refusedStart.body.code, "artifact_writes_disabled");
    const unchanged = await request(`/api/game-factory/games/${encodeURIComponent(first.id)}`, { jwt: OWNER_JWT });
    assert.equal(unchanged.body.game.state, "IDEA");

    const canary = await request("/api/game-factory/admin/synthetic-canary", {
      method: "POST", jwt: OWNER_JWT,
      headers: { "x-dominion-action": "game-factory-synthetic-canary", "idempotency-key": "server-canary-runtime-off-0001" },
      body: { projectId: first.id },
    });
    assert.equal(canary.status, 503);
    assert.equal(canary.body.code, "synthetic_canary_runtime_disabled");
    const injected = await request("/api/game-factory/admin/synthetic-canary", {
      method: "POST", jwt: OWNER_JWT,
      headers: { "x-dominion-action": "game-factory-synthetic-canary", "idempotency-key": "server-canary-injection-0001" },
      body: { projectId: first.id, argv: ["--eval", "process.exit()"] },
    });
    assert.equal(injected.status, 400);
    assert.equal(injected.body.code, "bad_canary_schema");
  });

  await test("single-tenant owner mode still requires the exact verified owner JWT for GET and POST", async () => {
    const singleReservation = http.createServer();
    await new Promise((resolve) => singleReservation.listen(0, "127.0.0.1", resolve));
    const singlePort = singleReservation.address().port;
    await new Promise((resolve) => singleReservation.close(resolve));
    const singleData = join(HERE, ".devdata-gamefactory-server-single-tenant-auth-test");
    mkdirSync(singleData, { recursive: true });
    const singleEnv = {
      ...env,
      PORT: String(singlePort), MULTI_TENANT: "0", DATA_DIR: singleData,
      MEMORY_DIR: join(singleData, "memory"), CHATLOG_DIR: join(singleData, "chatlog"),
      ARTIFACT_DIR: join(singleData, "artifacts"), PERSONA_DIR: join(singleData, "corpus"),
      PERSONA_STAGING: join(singleData, "staging"), FLYWHEEL_DIR: join(singleData, "flywheel"),
      LOG_DIR: join(singleData, "logs"), SANDBOX_DIR: join(singleData, "sandbox"),
    };
    const singleChild = spawn(process.execPath, [join(HERE, "server.mjs")], {
      cwd: HERE, env: singleEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let singleLog = "";
    singleChild.stdout.on("data", (chunk) => { singleLog += chunk; });
    singleChild.stderr.on("data", (chunk) => { singleLog += chunk; });
    const singleRequest = (path, options = {}) => request(path, { ...options, port: singlePort });
    try {
      let booted = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await singleRequest("/api/version");
        if (response.status === 200) { booted = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(booted, true, singleLog.slice(-3000));

      const postPath = "/api/game-factory/games/gf_owner_vector-vault/commands";
      const post = (identity = {}) => singleRequest(postPath, {
        method: "POST", ...identity,
        headers: { "x-dominion-action": "game-factory", "idempotency-key": "single-tenant-owner-auth-test" },
        body: { command: "start", expectedVersion: 1 },
      });
      const deniedIdentities = [
        { label: "no identity", request: {}, status: 401 },
        { label: "rejected JWT", request: { jwt: "not-a-valid-jwt" }, status: 401 },
        { label: "header only", request: { email: OWNER }, status: 401 },
        { label: "wrong verified email", request: { jwt: GUEST_JWT }, status: 403 },
        { label: "service", request: { jwt: SERVICE_JWT }, status: 403 },
        { label: "owner-mapped service", request: { jwt: SERVICE_OWNER_JWT }, status: 403 },
      ];
      for (const identity of deniedIdentities) {
        const getResponse = await singleRequest("/api/game-factory/config", identity.request);
        const postResponse = await post(identity.request);
        assert.equal(getResponse.status, identity.status, `${identity.label} GET`);
        assert.equal(postResponse.status, identity.status, `${identity.label} POST`);
        assert.equal(getResponse.body.code, "human_owner_required", `${identity.label} GET code`);
        assert.equal(postResponse.body.code, "human_owner_required", `${identity.label} POST code`);
      }

      const ownerConfig = await singleRequest("/api/game-factory/config", { jwt: OWNER_JWT });
      assert.equal(ownerConfig.status, 200);
      await singleRequest("/api/game-factory/bootstrap", { jwt: OWNER_JWT });
      const ownerPost = await post({ jwt: OWNER_JWT });
      assert.equal(ownerPost.status, 503);
      assert.equal(ownerPost.body.code, "artifact_writes_disabled");
    } finally {
      await stopChild(singleChild);
    }
  });

  await test("single-tenant all mode still requires a verified human JWT for GET and POST", async () => {
    const allReservation = http.createServer();
    await new Promise((resolve) => allReservation.listen(0, "127.0.0.1", resolve));
    const allPort = allReservation.address().port;
    await new Promise((resolve) => allReservation.close(resolve));
    const allData = join(HERE, ".devdata-gamefactory-server-single-tenant-all-auth-test");
    mkdirSync(allData, { recursive: true });
    const allEnv = {
      ...env,
      PORT: String(allPort), MULTI_TENANT: "0", GAME_FACTORY_MODE: "all", DATA_DIR: allData,
      MEMORY_DIR: join(allData, "memory"), CHATLOG_DIR: join(allData, "chatlog"),
      ARTIFACT_DIR: join(allData, "artifacts"), PERSONA_DIR: join(allData, "corpus"),
      PERSONA_STAGING: join(allData, "staging"), FLYWHEEL_DIR: join(allData, "flywheel"),
      LOG_DIR: join(allData, "logs"), SANDBOX_DIR: join(allData, "sandbox"),
    };
    const allChild = spawn(process.execPath, [join(HERE, "server.mjs")], {
      cwd: HERE, env: allEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let allLog = "";
    allChild.stdout.on("data", (chunk) => { allLog += chunk; });
    allChild.stderr.on("data", (chunk) => { allLog += chunk; });
    const allRequest = (path, options = {}) => request(path, { ...options, port: allPort });
    try {
      let booted = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await allRequest("/api/version");
        if (response.status === 200) { booted = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(booted, true, allLog.slice(-3000));

      const postPath = "/api/game-factory/games/gf_owner_vector-vault/commands";
      const post = (identity = {}) => allRequest(postPath, {
        method: "POST", ...identity,
        headers: { "x-dominion-action": "game-factory", "idempotency-key": "single-tenant-all-auth-test" },
        body: { command: "start", expectedVersion: 1 },
      });
      const deniedIdentities = [
        { label: "no identity", request: {}, status: 401 },
        { label: "rejected JWT", request: { jwt: "not-a-valid-jwt" }, status: 401 },
        { label: "header only", request: { email: OWNER }, status: 401 },
        { label: "service", request: { jwt: SERVICE_JWT }, status: 403 },
        { label: "owner-mapped service", request: { jwt: SERVICE_OWNER_JWT }, status: 403 },
      ];
      for (const identity of deniedIdentities) {
        const getResponse = await allRequest("/api/game-factory/config", identity.request);
        const postResponse = await post(identity.request);
        assert.equal(getResponse.status, identity.status, `${identity.label} GET`);
        assert.equal(postResponse.status, identity.status, `${identity.label} POST`);
        assert.equal(getResponse.body.code, "human_identity_required", `${identity.label} GET code`);
        assert.equal(postResponse.body.code, "human_identity_required", `${identity.label} POST code`);
      }

      const guestConfig = await allRequest("/api/game-factory/config", { jwt: GUEST_JWT });
      assert.equal(guestConfig.status, 200);
      await allRequest("/api/game-factory/bootstrap", { jwt: GUEST_JWT });
      const guestPost = await post({ jwt: GUEST_JWT });
      assert.equal(guestPost.status, 503);
      assert.equal(guestPost.body.code, "artifact_writes_disabled");
    } finally {
      await stopChild(allChild);
    }
  });

  await test("only the exact GET /games path rewrites to the SPA shell", async () => {
    const games = await request("/games", { jwt: OWNER_JWT });
    const nested = await request("/games/not-a-route", { jwt: OWNER_JWT });
    const post = await request("/games", { method: "POST", jwt: OWNER_JWT });
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
  await stopChild(child);
  await new Promise((resolve) => mock.close(resolve));
}

console.log(`\n${passed} game factory server wiring tests passed`);
