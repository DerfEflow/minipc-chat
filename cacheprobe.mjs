/*
 * LIVE prompt-cache probe - run: node cacheprobe.mjs
 *
 * Boots the real server against a mock Ollama, then sends TWO real turns of one conversation to
 * DeepSeek V4 Flash (direct) and reports the provider's cache counters for each. Spends real
 * money: a few tenths of a cent. Proof target (SOW docs/PROVIDER-CACHING-SOW.md D4): turn two
 * must report prompt_cache_hit_tokens > 0, because its prompt shares the system-prompt prefix
 * with turn one. If it reports zero, our prompt assembly is breaking the provider's automatic
 * cache and the numbers here say where to dig.
 *
 * The DeepSeek key is read from the wallet AT RUNTIME (~/.app-secrets.env); no secret lives in
 * this file and nothing here prints one.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8975, MOCK = 8976;
const dataDir = mkdtempSync(join(tmpdir(), "cacheprobe-"));

// Wallet read: value goes into the child env only.
const wallet = readFileSync(join(homedir(), ".app-secrets.env"), "utf8");
const kv = Object.fromEntries(wallet.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const DS_KEY = kv.DEEPSEEK_AI_DOMINION_UI_APIKEY || "";
if (!DS_KEY) { console.error("no DeepSeek key in the wallet; probe cannot run"); process.exit(1); }

const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "mock" }, done_reason: "stop", eval_count: 1 }) : "{}"); });
});
await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));

const env = { ...process.env,
  PORT: String(APP), HOST: "127.0.0.1", OLLAMA_URL: "http://127.0.0.1:" + MOCK,
  DATA_DIR: dataDir, MEMORY_DIR: join(dataDir, "memory"), CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"), PERSONA_DIR: join(dataDir, "corpus"),
  PERSONA_STAGING: join(dataDir, "staging"), FLYWHEEL_DIR: join(dataDir, "flywheel"),
  LOG_DIR: join(dataDir, "logs"), SANDBOX_DIR: join(dataDir, "sandbox"), CHATJOBS_DIR: join(dataDir, "chatjobs"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0",
  DEEPSEEK_AI_DOMINION_UI_APIKEY: DS_KEY,
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "", HANDS_TOKEN: "",
};

const server = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const cleanup = () => { try { server.kill(); } catch {}; try { mock.close(); } catch {}; try { rmSync(dataDir, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${APP}/api/version`, { signal: AbortSignal.timeout(1500) }); if (r.ok) up = true; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error("server never came up:\n" + serverLog.slice(-1500)); process.exit(1); }

async function turn(messages) {
  const events = { done: null, error: null, answer: "" };
  const r = await fetch(`http://127.0.0.1:${APP}/chat`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, model: "deepseek/deepseek-v4-flash", mode: "fast", chatId: "cacheprobe-1" }) });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = "", t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try { const o = JSON.parse(line.slice(5));
        if (o.type === "token" && o.delta) events.answer += o.delta;
        if (o.type === "done") events.done = o;
        if (o.type === "error") events.error = o;
      } catch {}
    }
    if (events.done || events.error) break;
  }
  try { reader.cancel(); } catch {}
  return events;
}

const u1 = { role: "user", content: "Reply with exactly the word: alpha" };
const t1 = await turn([u1]);
if (t1.error) { console.error("turn 1 errored: " + JSON.stringify(t1.error)); cleanup(); process.exit(1); }
const a1 = { role: "assistant", content: t1.answer || "alpha" };
const t2 = await turn([u1, a1, { role: "user", content: "Now reply with exactly the word: beta" }]);
if (t2.error) { console.error("turn 2 errored: " + JSON.stringify(t2.error)); cleanup(); process.exit(1); }

console.log("TURN1 done:", JSON.stringify(t1.done).slice(0, 900));
console.log("TURN2 done:", JSON.stringify(t2.done).slice(0, 900));

// Ground truth: the usage log line per run; the cache object is the payload that matters.
let cacheRows = [];
const usagePath = join(dataDir, "logs", "usage.jsonl");
if (existsSync(usagePath)) {
  for (const line of readFileSync(usagePath, "utf8").trim().split("\n")) {
    try { const j = JSON.parse(line); cacheRows.push(j.cache || null);
      console.log("usage:", JSON.stringify({ promptTokens: j.promptTokens, outputTokens: j.outputTokens, costUsd: j.costUsd, cache: j.cache })); } catch {}
  }
}
const hit2 = Number(cacheRows[1] && (cacheRows[1].readTokens ?? cacheRows[1].read ?? cacheRows[1].hits)) || 0;
console.log(hit2 > 0 ? "CACHE PROOF: turn 2 read " + hit2 + " tokens from cache" : "NO CACHE HITS on turn 2 — assembly breaks the prefix (dig here)");
cleanup();
process.exit(0);
