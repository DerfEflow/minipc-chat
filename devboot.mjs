/*
 * Local visual-test rig (dev only; never deployed, never imported by the app).
 * Boots the real server with MULTI_TENANT=1 against a throwaway data dir + a mock Ollama, then runs
 * two tiny proxies that stamp the Cloudflare Access identity header, since a local browser cannot:
 *   http://127.0.0.1:8095  -> you are the OWNER   (owner@dev.local)
 *   http://127.0.0.1:8094  -> you are a NEW GUEST (guest@dev.local)
 * Run: node devboot.mjs   (Ctrl+C stops everything; data lives in .devdata/, safe to delete)
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8096, OWNER_PORT = 8095, GUEST_PORT = 8094, MOCK = 8097;
const dataDir = join(HERE, ".devdata");
mkdirSync(dataDir, { recursive: true });

// mock Ollama so boot + light-model calls are harmless
http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "local mock reply" }, eval_count: 5 }) : "{}");
}); }).listen(MOCK, "127.0.0.1");

const env = { ...process.env, PORT: String(APP), OLLAMA_URL: "http://127.0.0.1:" + MOCK,
  DATA_DIR: dataDir, MEMORY_DIR: join(dataDir, "memory"), CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"), PERSONA_DIR: join(dataDir, "corpus"), PERSONA_STAGING: join(dataDir, "staging"),
  FLYWHEEL_DIR: join(dataDir, "flywheel"), LOG_DIR: join(dataDir, "logs"), SANDBOX_DIR: join(dataDir, "sandbox"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0",
  MULTI_TENANT: "1", OWNER_EMAIL: "owner@dev.local",
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: "inherit" });
process.on("exit", () => { try { child.kill(); } catch {} });

// identity-stamping proxies (the ONLY thing they add is the Access email header)
function proxy(port, email) {
  http.createServer((req, res) => {
    const opts = { host: "127.0.0.1", port: APP, path: req.url, method: req.method,
      headers: { ...req.headers, "cf-access-authenticated-user-email": email, host: "127.0.0.1:" + APP } };
    const up = http.request(opts, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end("app not up yet, refresh"); });
    req.pipe(up);
  }).listen(port, "127.0.0.1", () => console.log(`[devboot] http://127.0.0.1:${port}  as  ${email}`));
}
proxy(OWNER_PORT, "owner@dev.local");
proxy(GUEST_PORT, "guest@dev.local");
