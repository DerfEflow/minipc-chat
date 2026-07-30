/*
 * Dominion voice lane self-test (ARSENAL Wave 4) — run: node voice_test.mjs
 * Boots the REAL server with a MOCK OpenAI voice API (OPENAI_VOICE_BASE), then drives
 * /api/voice/* over HTTP: TTS success streams audio; TTS/STT failures return the STRUCTURED
 * fallback contract ({code, reason, fallback:"device"}) the client's device-voice lane keys on;
 * quota errors are classified by name (the standing diagnosis rule). No real OpenAI calls.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8720 + (process.pid * 3) % 260;
const MOCK_OLLAMA = PORT + 1;
const MOCK_OPENAI = PORT + 2;
const OWNER = "owner@test.com";

let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// ---- mock Ollama (harmless boot target)
const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

// ---- mock OpenAI voice API: /v1/audio/speech + /v1/audio/transcriptions, failure mode switchable
const MP3 = Buffer.from("4944330300000000", "hex"); // "ID3" header bytes, enough to be "audio"
let mode = "ok"; // ok | quota | keybad | ratelimit | boom
const seen = { speech: [], transcriptions: 0 };
const mockOpenAI = http.createServer((req, res) => {
  let chunks = []; req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const b = Buffer.concat(chunks);
    const fail = (status, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message } })); };
    if (req.url === "/v1/audio/speech" && req.method === "POST") {
      seen.speech.push(JSON.parse(b.toString("utf8")));
      if (mode === "quota") return fail(429, "You exceeded your current quota, please check your plan and billing details.");
      if (mode === "keybad") return fail(401, "Incorrect API key provided.");
      if (mode === "ratelimit") return fail(429, "Rate limit reached for requests.");
      if (mode === "boom") return fail(500, "The server had an error.");
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(MP3);
    }
    if (req.url === "/v1/audio/transcriptions" && req.method === "POST") {
      seen.transcriptions++;
      if (mode !== "ok") return fail(429, "You exceeded your current quota, please check your plan and billing details.");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: "the forge is hot" }));
    }
    fail(500, "unexpected mock call " + req.method + " " + req.url);
  });
});
await new Promise((r) => mockOpenAI.listen(MOCK_OPENAI, "127.0.0.1", r));

// ---- boot the real server
const dir = mkdtempSync(join(tmpdir(), "dominion-voice-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  MULTI_TENANT: "1", OWNER_EMAIL: OWNER,
  OPEN_AI_DOMINION_UI_APIKEY: "test-key-not-real",
  OPENAI_VOICE_BASE: "http://127.0.0.1:" + MOCK_OPENAI,
  OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

function req(method, path, { headers = {}, body = null, raw = false } = {}) {
  return new Promise((resolve) => {
    const data = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method,
      headers: { "cf-access-authenticated-user-email": OWNER, ...(data ? { "content-length": data.length, "content-type": headers["content-type"] || "application/json" } : {}), ...headers } },
      (res) => {
        const chunks = []; res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let j = null; if (!raw) { try { j = JSON.parse(buf.toString("utf8")); } catch {} }
          resolve({ status: res.statusCode, headers: res.headers, buf, body: j });
        });
      });
    r.on("error", () => resolve({ status: 0, buf: Buffer.alloc(0), body: null }));
    if (data) r.write(data); r.end();
  });
}
async function waitForBoot() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}
await waitForBoot();

await t("voice config lists the voices and the default", async () => {
  const r = await req("GET", "/api/voice/config");
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  if (!Array.isArray(r.body.voices) || !r.body.voices.includes("cedar")) throw new Error("voices wrong");
  if (!r.body.ready) throw new Error("not ready with key set");
});

await t("TTS success streams audio and carries the per-request voice", async () => {
  const r = await req("POST", "/api/voice/tts", { body: { text: "The forge is hot.", voice: "marin" }, raw: true });
  if (r.status !== 200) throw new Error("HTTP " + r.status + " " + r.buf.toString("utf8").slice(0, 120));
  if (!/audio\/mpeg/.test(r.headers["content-type"] || "")) throw new Error("content-type: " + r.headers["content-type"]);
  if (!r.buf.length) throw new Error("no audio bytes");
  const call = seen.speech.at(-1);
  if (call.voice !== "marin" || !call.instructions) throw new Error("payload wrong: " + JSON.stringify({ v: call.voice, i: !!call.instructions }));
});

await t("TTS quota failure returns the device-fallback contract with the reason NAMED", async () => {
  mode = "quota";
  const r = await req("POST", "/api/voice/tts", { body: { text: "Say this." } });
  if (r.status !== 502) throw new Error("HTTP " + r.status);
  if (r.body.code !== "tts_down" || r.body.fallback !== "device") throw new Error("contract wrong: " + JSON.stringify(r.body));
  if (!/quota/i.test(r.body.reason)) throw new Error("reason not classified as quota: " + r.body.reason);
});

await t("TTS bad-key failure classifies the reason as a key problem", async () => {
  mode = "keybad";
  const r = await req("POST", "/api/voice/tts", { body: { text: "Say this." } });
  if (r.status !== 502 || r.body.code !== "tts_down") throw new Error(JSON.stringify(r.body));
  if (!/key/i.test(r.body.reason)) throw new Error("reason: " + r.body.reason);
});

await t("TTS rate-limit failure classifies the reason as rate limit", async () => {
  mode = "ratelimit";
  const r = await req("POST", "/api/voice/tts", { body: { text: "Say this." } });
  if (!/rate limit/i.test(r.body.reason)) throw new Error("reason: " + r.body.reason);
});

await t("STT success returns the transcript", async () => {
  mode = "ok";
  const fakeAudio = Buffer.alloc(4000, 7);
  const r = await req("POST", "/api/voice/transcribe", { body: fakeAudio, headers: { "content-type": "audio/webm" } });
  if (r.status !== 200 || r.body.text !== "the forge is hot") throw new Error(r.status + " " + JSON.stringify(r.body));
});

await t("STT failure returns the device-fallback contract with the reason NAMED", async () => {
  mode = "quota";
  const fakeAudio = Buffer.alloc(4000, 7);
  const r = await req("POST", "/api/voice/transcribe", { body: fakeAudio, headers: { "content-type": "audio/webm" } });
  if (r.status !== 502) throw new Error("HTTP " + r.status);
  if (r.body.code !== "stt_down" || r.body.fallback !== "device") throw new Error("contract wrong: " + JSON.stringify(r.body));
  if (!/quota/i.test(r.body.reason)) throw new Error("reason: " + r.body.reason);
});

console.log(`\nvoice e2e: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
mockOpenAI.close();
process.exit(failed ? 1 : 0);
