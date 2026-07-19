// Local dev rig for Dominion Forge Images — run: node devboot-images.mjs
// Boots the real server single-tenant (owner path) on :8288 with throwaway state in .devdata/
// and a mock Ollama so the box's local models are not needed. If the wallet
// (~/.app-secrets.env) holds OPEN_AI_DOMINION_UI_APIKEY it is read AT RUNTIME (never inlined)
// so "Generate now" makes a REAL OpenAI call — keep probes on Low quality (~$0.01).
import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8288);
const MOCK_OLLAMA = PORT + 1;

const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}");
  });
});
await new Promise((r) => mock.listen(MOCK_OLLAMA, "127.0.0.1", r));

if (!process.env.OPEN_AI_DOMINION_UI_APIKEY) {
  try {
    const wallet = readFileSync(join(homedir(), ".app-secrets.env"), "utf8");
    const m = /^OPEN_AI_DOMINION_UI_APIKEY=(.+)$/m.exec(wallet);
    if (m) process.env.OPEN_AI_DOMINION_UI_APIKEY = m[1].trim();
  } catch {}
}
console.log("[devboot-images] OpenAI key " + (process.env.OPEN_AI_DOMINION_UI_APIKEY ? "loaded from wallet (live generation WILL spend)" : "absent (generation will 503)"));

const data = join(HERE, ".devdata", "images-dev");
mkdirSync(data, { recursive: true });
Object.assign(process.env, {
  PORT: String(PORT),
  OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  DATA_DIR: data,
  MEMORY_DIR: join(data, "memory"), CHATLOG_DIR: join(data, "chatlog"), ARTIFACT_DIR: join(data, "artifacts"),
  PERSONA_DIR: join(data, "corpus"), PERSONA_STAGING: join(data, "staging"), FLYWHEEL_DIR: join(data, "flywheel"),
  LOG_DIR: join(data, "logs"), SANDBOX_DIR: join(data, "sandbox"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
});
await import("./server.mjs");
