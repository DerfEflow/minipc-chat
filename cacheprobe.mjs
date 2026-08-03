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

// Wallet read: values go into the child env (or a direct provider call) only, never to stdout.
const wallet = readFileSync(join(homedir(), ".app-secrets.env"), "utf8");
const kv = Object.fromEntries(wallet.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

/*
 * ==== MODE: node cacheprobe.mjs providers [filter...] ====
 *
 * Wargame C4: caching on Moonshot and NVIDIA was ASSUMED. This measures it. Two turns per model
 * sharing one large stable prefix, sent straight at each provider's native endpoint with no server
 * in the way, reading the provider's OWN cache counters. Roughly a cent per full sweep.
 *
 * Measured 2026-08-03 (provider-reported turn-two cache reads):
 *   deepseek-v4-flash   18,048 / 18,109   automatic, nothing required
 *   gpt-5.6-luna         4,521 /  4,535   automatic above ~1,024 tokens
 *   gpt-4o               4,352 /  4,536   automatic above ~1,024 tokens
 *   kimi-k3              4,608 /  4,621   automatic; reporting is per-node and intermittent
 *   kimi-k2.6            4,096 observed on one turn, absent on a byte-identical repeat
 *   claude-haiku-4-5     6,304 /  6,317   ONLY with an explicit cache_control breakpoint;
 *                                          without it, two identical turns both billed full freight
 *   gemini 3.6 / 3.5     0 at 5.9k AND at 27.3k tokens, on the native endpoint as well as the
 *                        OpenAI-compat one the server calls (which reports no cache field at all)
 *   nvidia (3 models)    no cache counters returned at all; two identical turns billed identically
 *   openrouter (2)       cached_tokens present in the shape and 0 in fact
 */
if (process.argv[2] === "providers") {
  const filters = process.argv.slice(3);
  const words = (n) => { const w = ["ledger", "invariant", "prefix", "byte", "stable", "retrieval", "history", "directive", "token", "provider", "counter", "evidence", "assembly", "window", "budget", "anchor"]; const o = []; for (let i = 0; i < n; i++) o.push(w[(i * 7 + (i % 13)) % w.length] + "-" + (i % 97)); return o.join(" "); };
  // ~4,500 tokens clears every published floor (Anthropic 2,048 on Haiku, OpenAI ~1,024,
  // Google ~1,024, Moonshot 256, DeepSeek 64-token blocks) without buying a large prompt per lane.
  const PREFIX = "You are a billing-invariant test fixture. Reference corpus follows; do not summarize it.\n" + words(1500);
  const OA = kv.OPEN_AI_DOMINION_UI_APIKEY || kv.OPENAI_API_KEY;
  const LANES = [
    { lane: "openai", model: "gpt-5.6-luna", url: "https://api.openai.com/v1/chat/completions", key: OA, newOai: true, maxOut: 1024 },
    { lane: "openai", model: "gpt-4o", url: "https://api.openai.com/v1/chat/completions", key: OA },
    { lane: "deepseek", model: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions", key: kv.DEEPSEEK_AI_DOMINION_UI_APIKEY },
    { lane: "moonshot", model: "kimi-k3", url: "https://api.moonshot.ai/v1/chat/completions", key: kv.MOONSHOT_API_KEY },
    { lane: "moonshot", model: "kimi-k2.6", url: "https://api.moonshot.ai/v1/chat/completions", key: kv.MOONSHOT_API_KEY },
    { lane: "google", model: "gemini-3.6-flash", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: kv.GOOGLE_AI_STUDIO_API_KEY },
    { lane: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", url: "https://integrate.api.nvidia.com/v1/chat/completions", key: kv.NVIDIA_API_KEY, maxOut: 64 },
    { lane: "nvidia", model: "openai/gpt-oss-20b", url: "https://integrate.api.nvidia.com/v1/chat/completions", key: kv.NVIDIA_API_KEY, maxOut: 1024 },
    { lane: "openrouter", model: "qwen/qwen3-coder", url: "https://openrouter.ai/api/v1/chat/completions", key: kv.OPENROUTER_API_KEY },
    { lane: "anthropic", model: "claude-haiku-4-5-20251001", url: "https://api.anthropic.com/v1/messages", key: kv.ANTHROPIC_API_KEY, anthropic: true, cc: false },
    { lane: "anthropic", model: "claude-haiku-4-5-20251001", url: "https://api.anthropic.com/v1/messages", key: kv.ANTHROPIC_API_KEY, anthropic: true, cc: true },
  ];
  const readOf = (u) => {
    if (!u) return null;
    const v = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
      ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens;
    return v == null ? null : Number(v);
  };
  const send = async (e, text) => {
    if (e.anthropic) {
      const sys = [{ type: "text", text: PREFIX }];
      if (e.cc) sys[0].cache_control = { type: "ephemeral" };
      const r = await fetch(e.url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": e.key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: e.model, max_tokens: e.maxOut || 16, system: sys, messages: [{ role: "user", content: text }] }), signal: AbortSignal.timeout(180000) });
      const t = await r.text();
      if (!r.ok) return { err: r.status + " " + t.slice(0, 200) };
      return { usage: JSON.parse(t).usage };
    }
    const body = { model: e.model, messages: [{ role: "system", content: PREFIX }, { role: "user", content: text }], stream: false };
    if (e.newOai) body.max_completion_tokens = e.maxOut || 16;
    else { body.max_tokens = e.maxOut || 16; if (e.lane !== "moonshot") body.temperature = 0; }   // Kimi allows temperature 1 only
    if (e.lane === "openrouter") body.usage = { include: true };
    const r = await fetch(e.url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + e.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const t = await r.text();
    if (!r.ok) return { err: r.status + " " + t.slice(0, 200) };
    const j = JSON.parse(t);
    return j.error ? { err: JSON.stringify(j.error).slice(0, 200) } : { usage: j.usage };
  };
  for (const e of LANES) {
    const label = e.lane + "/" + e.model + (e.anthropic ? (e.cc ? " [cache_control]" : " [no cache_control]") : "");
    if (filters.length && !filters.some((f) => label.includes(f))) continue;
    if (!e.key) { console.log(label.padEnd(56) + "SKIP (no key in wallet)"); continue; }
    const a = await send(e, "Reply with the single word: alpha");
    if (a.err) { console.log(label.padEnd(56) + "ERROR turn1 " + a.err); continue; }
    await new Promise((r) => setTimeout(r, 6000));   // let the provider-side cache write land
    const b = await send(e, "Reply with the single word: beta");
    if (b.err) { console.log(label.padEnd(56) + "ERROR turn2 " + b.err); continue; }
    // Anthropic's input_tokens EXCLUDES cached and freshly-written tokens; the OpenAI-shaped lanes
    // include them, so the denominator has to be rebuilt per shape or the percentage lies.
    const u = b.usage || {};
    const total = e.anthropic
      ? (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
      : (Number(u.prompt_tokens) || 0);
    const read = readOf(u);
    console.log(label.padEnd(56) + (read == null ? "no cache counter returned" : "turn2 read " + read + " / " + total + " = " + Math.round((read / total) * 100) + "%"));
    console.log("      turn2 usage: " + JSON.stringify(u));
  }
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "cacheprobe-"));
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

/*
 * Optional gap between the two turns: node cacheprobe.mjs [delaySeconds]
 *
 * Added 2026-08-03 as step one of the Phase 0 cache work, and it exists to disprove THIS PROBE
 * before anyone goes hunting through prompt assembly. Turn two normally fires seconds after turn
 * one, so a zero-hit result could mean our prefix churns, or simply that the provider's cache
 * write had not landed yet. Those two explanations cost very different amounts to chase. If hits
 * appear with a delay, the prompt is fine and the probe was too fast. If hits stay at zero with a
 * comfortable gap, the defect is ours and the bisect is justified.
 */
const delaySec = Math.max(0, Number(process.argv[2]) || 0);
if (delaySec) {
  console.log("waiting " + delaySec + "s before turn two, to let any provider-side cache write land");
  await new Promise((r) => setTimeout(r, delaySec * 1000));
}

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
