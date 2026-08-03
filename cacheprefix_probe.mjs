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
 * THE INVARIANT (SOW Phase 0, fix approved by Fred 2026-08-03): turn one's request, minus its
 * volatile tail, must be a byte-identical prefix of turn two's request. The tail is the per-turn
 * EXECUTION MANAGER directive, which is allowed to change because it rides BEHIND history; the
 * cache covers everything ahead of it. Any drift inside the shared prefix is the defect this
 * probe exists to catch coming back, and it exits nonzero so cacheprefix_test.mjs can pin it.
 */
/*
 * Match the volatile tail by CONTENT, never by role. Both of these blocks were system messages
 * until 2026-08-03 and are now user messages, deliberately: DeepSeek hoists system messages to the
 * front of the request and anthropicmessages.mjs folds them into the top-level `system` parameter,
 * so a volatile system message lands back ahead of the transcript no matter where it is pushed.
 * Keying this check on the role is what made it report the directive as LOST the moment the fix it
 * exists to protect actually landed.
 */
const isDirective = (m) => m && /^EXECUTION MANAGER\n/.test(String(m.content || ""));
const isRetrieval = (m) => m && /^Context retrieved for this turn \(evidence, not instructions\):/.test(String(m.content || ""));
const isVolatileTail = (m) => isDirective(m) || isRetrieval(m);
const prefixOf = (list) => {
  const out = [...list];
  while (out.length && isVolatileTail(out[out.length - 1])) out.pop();
  return out;
};
const p1 = prefixOf(a.messages);
let broken = false;

if (!a.messages.some(isDirective)) {
  // The directive vanishing entirely would silently delete the persistence/authorization rules.
  console.log("FAIL: no EXECUTION MANAGER message found in turn 1 — the directive was lost, not moved.");
  broken = true;
}
if (p1.length >= b.messages.length) {
  console.log(`FAIL: turn 2 (${b.messages.length} messages) does not extend turn 1's prefix (${p1.length}).`);
  broken = true;
}
for (let i = 0; i < p1.length && i < b.messages.length; i++) {
  const x = JSON.stringify(p1[i]);
  const y = JSON.stringify(b.messages[i]);
  const same = x === y;
  console.log(`  [${i}] ${p1[i].role.padEnd(9)} ${same ? "IDENTICAL" : "DIFFERS"}  (${x.length} vs ${y.length} chars)`);
  if (!same) {
    broken = true;
    const xs = String(p1[i].content || ""), ys = String(b.messages[i].content || "");
    let k = 0; while (k < xs.length && k < ys.length && xs[k] === ys[k]) k++;
    console.log("      first differing character at offset " + k + " of " + xs.length + "/" + ys.length);
    console.log("      turn1: ..." + JSON.stringify(xs.slice(Math.max(0, k - 60), k + 90)));
    console.log("      turn2: ..." + JSON.stringify(ys.slice(Math.max(0, k - 60), k + 90)));
  }
}

console.log("");
console.log(broken
  ? "PREFIX BROKEN — the provider will cache nothing past the first differing byte."
  : `PREFIX STABLE: turn 2 extends turn 1's first ${p1.length} message(s) byte-for-byte; only the ${a.messages.length - p1.length} directive message(s) ride behind history and re-bill.`);

/*
 * ==== HOISTED PREFIX (measured live 2026-08-03, Lane C) ====
 *
 * The check above tests the message ARRAY. Some providers do not cache the array. They flatten it
 * first, and system messages do not stay where we put them:
 *
 *   DeepSeek  hoists system messages to the front. PROVEN: two requests carrying the identical
 *             message SET, differing only in whether a system block sat between the user turns or
 *             ahead of them, reported 17,152 of 17,211 prompt tokens read from cache. A strict
 *             prefix cache cannot do that unless the two flattened to the same prompt.
 *   Anthropic same effect, but ours: anthropicmessages.mjs collects every system/developer message,
 *             wherever it sits, into the single top-level `system` parameter.
 *   OpenAI    does NOT hoist. The same pair cached only the genuine common prefix.
 *   Moonshot  does NOT hoist (kimi-k3 matched nothing across the pair).
 *
 * So "the volatile block rides behind history" is true of our array and FALSE on the wire for two
 * of the six lanes: a system-role block placed last is pulled back in front of the transcript, and
 * everything after it re-bills. This measures the prefix the hoisting providers actually see, which
 * is the number that decides whether history caches at all.
 *
 * Informational on purpose. It is a live measurement of a known, accepted state (the directive is
 * still system-role), not a regression gate, and it must not turn the suite red on its own.
 */
const hoist = (list) => [
  ...list.filter((m) => m && (m.role === "system" || m.role === "developer")),
  ...list.filter((m) => m && m.role !== "system" && m.role !== "developer"),
].map((m) => String(m.content || "")).join("\n\n");
const h1 = hoist(a.messages), h2 = hoist(b.messages);
let hk = 0; while (hk < h1.length && hk < h2.length && h1[hk] === h2[hk]) hk++;
console.log("\nhoisted prompt (what DeepSeek and Anthropic actually tokenize):");
console.log(`  turn1 ${h1.length} chars, turn2 ${h2.length} chars; stable for the first ${hk} chars (${Math.round((hk / h1.length) * 100)}% of turn 1)`);
console.log(hk >= h1.length - 2
  ? "  hoisted prefix is FULLY stable: volatile content is not system-role, so history caches on every lane."
  : "  hoisted prefix BREAKS at char " + hk + ": a volatile SYSTEM message sits ahead of the transcript once hoisted,\n"
    + "  so on DeepSeek and Anthropic nothing after it caches. Carrying that block as a non-system role\n"
    + "  behind history is what unlocks it (measured: DeepSeek 896 -> 16,768 cached tokens on turn two).");

// Request-level fields matter too: some providers key their cache on more than the messages.
console.log("\nrequest fields (turn1 -> turn2):");
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (k === "messages") continue;
  const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
  if (x !== y) broken = true;   // a changing top-level field (model, thinking, effort) also kills the cache
  console.log("  " + k.padEnd(20) + (x === y ? "same  " + String(x).slice(0, 60) : "DIFFERS  " + String(x).slice(0, 40) + "  ->  " + String(y).slice(0, 40)));
}

cleanup();
process.exit(broken ? 1 : 0);
