/*
 * PREFIX PROBE - run: node cacheprefix_probe.mjs
 *
 * Phase 0 of docs/ASSISTANT-AND-BUILD-CORE-SOW.md. cacheprobe.mjs proves the SYMPTOM (DeepSeek
 * reports zero cache hits on a second turn that shares a 1169-token prefix, still true with a 25
 * second gap, so it is not provider write latency). This finds the CAUSE by reading the bytes.
 *
 * It boots the real server with DEEPSEEK_URL pointed at a local capture endpoint, sends two turns
 * of one conversation, and diffs the two request bodies message by message. Nothing is sent to a
 * real provider and nothing is billed.
 *
 * WHY BYTES AND NOT READING THE CODE. buildSystemPrompt assembles from a dozen sources, several of
 * which are dynamic (the feature index, flywheel prompt overlays, mode fragments). Reading it can
 * tell you what MIGHT vary. Only the payload tells you what DID. Prompt caching is byte-exact:
 * one character of drift anywhere in the prefix and the provider caches nothing.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 8985, MOCK_OLLAMA = 8986, CAPTURE = 8987;
const dataDir = mkdtempSync(join(tmpdir(), "prefixprobe-"));
const captured = [];

// Capture endpoint: records the body verbatim, answers in the OpenAI streaming shape the server
// expects. Usage is reported so the done-event math has something real to chew on.
const capture = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    captured.push(b);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1169,"completion_tokens":1,"prompt_cache_hit_tokens":0}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
const mockOllama = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "mock" }, done_reason: "stop", eval_count: 1 }) : "{}"); });
});
await new Promise((r) => capture.listen(CAPTURE, "127.0.0.1", r));
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

const env = { ...process.env,
  PORT: String(APP), HOST: "127.0.0.1", OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  DEEPSEEK_URL: "http://127.0.0.1:" + CAPTURE + "/chat/completions",
  DEEPSEEK_AI_DOMINION_UI_APIKEY: "probe-not-a-real-key",
  DATA_DIR: dataDir, MEMORY_DIR: join(dataDir, "memory"), CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"), PERSONA_DIR: join(dataDir, "corpus"),
  PERSONA_STAGING: join(dataDir, "staging"), FLYWHEEL_DIR: join(dataDir, "flywheel"),
  LOG_DIR: join(dataDir, "logs"), SANDBOX_DIR: join(dataDir, "sandbox"), CHATJOBS_DIR: join(dataDir, "chatjobs"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0",
  OPENROUTER_API_KEY: "", OPEN_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "", HANDS_TOKEN: "",
};

const server = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const cleanup = () => { try { server.kill(); } catch {}; try { capture.close(); } catch {}; try { mockOllama.close(); } catch {}; try { rmSync(dataDir, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${APP}/api/version`, { signal: AbortSignal.timeout(1500) }); if (r.ok) up = true; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { console.error("server never came up:\n" + log.slice(-1500)); process.exit(1); }

async function turn(messages) {
  const r = await fetch(`http://127.0.0.1:${APP}/chat`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, model: "deepseek/deepseek-v4-flash", mode: "fast", chatId: "prefixprobe-1" }) });
  const reader = r.body.getReader();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const { value, done } = await reader.read();
    if (done) break;
    if (String(new TextDecoder().decode(value)).includes('"type":"done"')) break;
  }
  try { reader.cancel(); } catch {}
}

const u1 = { role: "user", content: "Reply with exactly the word: alpha" };
await turn([u1]);
await turn([u1, { role: "assistant", content: "alpha" }, { role: "user", content: "Now reply with exactly the word: beta" }]);

if (captured.length < 2) { console.error("captured " + captured.length + " request(s); expected 2\n" + log.slice(-1200)); cleanup(); process.exit(1); }

const a = JSON.parse(captured[0]);
const b = JSON.parse(captured[1]);
writeFileSync(join(dataDir, "..", "prefixprobe-turn1.json"), JSON.stringify(a, null, 2));

console.log("turn 1 messages: " + a.messages.length + "   turn 2 messages: " + b.messages.length);
console.log("");

/*
 * A cacheable second turn is a byte-stable EXTENSION of the first: message i must be identical for
 * every i the two share. The first index where they differ is where the cache dies, and everything
 * after it is billed fresh no matter how much of it was really the same.
 */
let firstDiff = -1;
const shared = Math.min(a.messages.length, b.messages.length);
for (let i = 0; i < shared; i++) {
  const x = JSON.stringify(a.messages[i]);
  const y = JSON.stringify(b.messages[i]);
  const same = x === y;
  const role = a.messages[i].role;
  console.log(`  [${i}] ${role.padEnd(9)} ${same ? "IDENTICAL" : "DIFFERS"}  (${x.length} vs ${y.length} chars)`);
  if (!same && firstDiff < 0) firstDiff = i;
}

if (firstDiff < 0) {
  console.log("\nPREFIX IS STABLE across the shared messages. The cache miss is NOT prompt drift;");
  console.log("look at request-level fields next (below) and at how the provider is being called.");
} else {
  console.log(`\nPREFIX BREAKS AT MESSAGE ${firstDiff} (role=${a.messages[firstDiff].role}).`);
  const x = String(a.messages[firstDiff].content || "");
  const y = String(b.messages[firstDiff].content || "");
  let k = 0; while (k < x.length && k < y.length && x[k] === y[k]) k++;
  console.log("first differing character at offset " + k + " of " + x.length + "/" + y.length);
  console.log("  turn1: ..." + JSON.stringify(x.slice(Math.max(0, k - 60), k + 90)));
  console.log("  turn2: ..." + JSON.stringify(y.slice(Math.max(0, k - 60), k + 90)));
}

// Request-level fields matter too: some providers key their cache on more than the messages.
console.log("\nrequest fields (turn1 -> turn2):");
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (k === "messages") continue;
  const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
  console.log("  " + k.padEnd(20) + (x === y ? "same  " + String(x).slice(0, 60) : "DIFFERS  " + String(x).slice(0, 40) + "  ->  " + String(y).slice(0, 40)));
}

cleanup();
process.exit(0);
