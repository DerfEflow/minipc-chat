/*
 * Cloud request-shaping self-test — run: node cloudparams_test.mjs
 * Part 1: unit tests on cloudparams.mjs (temperature rules, tool cap, 400-retry adjustments).
 * Part 2: END-TO-END — boots the REAL server with mock OpenAI Responses + Anthropic
 * Chat Completions endpoints (OPENAI_URL / ANTHROPIC_URL) and proves over the wire that:
 * direct OpenAI turns use the native Responses request/stream dialect, gpt-5.x turns carry
 * NO temperature, Anthropic turns carry temperature clamped to 1, and a 400 naming a
 * parameter is retried once with the corrected payload. No real provider calls, no spend.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { shapeCloudParams, paramRetryAdjust, TOOL_CAP } from "./cloudparams.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

// ---------------- Part 1: unit ----------------
await t("gpt-5.x / o-series: temperature omitted entirely", async () => {
  for (const id of ["gpt-5.6-terra", "gpt-5.5", "o3-mini"]) {
    const s = shapeCloudParams({ provider: "openai", directId: id, temperature: 0.7 });
    if (s.temperature !== undefined) throw new Error(id + " kept temperature " + s.temperature);
  }
});
await t("gpt-4o keeps temperature (0..2 clamp)", async () => {
  if (shapeCloudParams({ provider: "openai", directId: "gpt-4o", temperature: 0.7 }).temperature !== 0.7) throw new Error("0.7 lost");
  if (shapeCloudParams({ provider: "openai", directId: "gpt-4o", temperature: 3 }).temperature !== 2) throw new Error("3 not clamped to 2");
});
await t("anthropic clamps to 0..1 (the 1.2 slider bug)", async () => {
  if (shapeCloudParams({ provider: "anthropic", directId: "claude-haiku-4-5", temperature: 1.2 }).temperature !== 1) throw new Error("1.2 not clamped");
  if (shapeCloudParams({ provider: "anthropic", directId: "claude-haiku-4-5", temperature: 0.5 }).temperature !== 0.5) throw new Error("0.5 changed");
  if (shapeCloudParams({ provider: "anthropic", directId: "claude-haiku-4-5", temperature: -1 }).temperature !== 0) throw new Error("-1 not floored");
});
await t("openrouter/deepseek keep 0..2 range", async () => {
  if (shapeCloudParams({ provider: "openrouter", directId: "x", temperature: 1.2 }).temperature !== 1.2) throw new Error("1.2 changed");
  if (shapeCloudParams({ provider: "deepseek", directId: "x", temperature: 2.5 }).temperature !== 2) throw new Error("2.5 not clamped");
});
await t("no temperature in = none out", async () => {
  if (shapeCloudParams({ provider: "openrouter", directId: "x" }).temperature !== undefined) throw new Error("invented a temperature");
});
await t("tool cap: 198 defs -> 128 kept, 70 dropped, order preserved", async () => {
  const defs = Array.from({ length: 198 }, (_, i) => ({ type: "function", function: { name: "tool_" + i } }));
  const s = shapeCloudParams({ provider: "openai", directId: "gpt-4o", tools: defs });
  if (s.tools.length !== TOOL_CAP || s.toolsDropped !== 70) throw new Error(s.tools.length + "/" + s.toolsDropped);
  if (s.tools[0].function.name !== "tool_0" || s.tools[127].function.name !== "tool_127") throw new Error("order broken");
});
await t("tool cap: 55 defs pass untouched", async () => {
  const defs = Array.from({ length: 55 }, (_, i) => ({ type: "function", function: { name: "tool_" + i } }));
  const s = shapeCloudParams({ provider: "openai", directId: "gpt-4o", tools: defs });
  if (s.tools.length !== 55 || s.toolsDropped !== 0) throw new Error("cap fired early");
});
await t("retry-adjust: temperature complaint removes temperature", async () => {
  const a = paramRetryAdjust({ model: "m", temperature: 0.7 }, "Unsupported value: 'temperature' does not support 0.7 with this model.");
  if (!a || "temperature" in a.payload) throw new Error("not removed");
});
await t("retry-adjust: max_tokens -> max_completion_tokens rename", async () => {
  const a = paramRetryAdjust({ model: "m", max_tokens: 900 }, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  if (!a || a.payload.max_completion_tokens !== 900 || "max_tokens" in a.payload) throw new Error("rename failed");
});
await t("retry-adjust: tools trimmed to the provider's stated maximum", async () => {
  const tools = Array.from({ length: 198 }, (_, i) => ({ type: "function", function: { name: "t" + i } }));
  const a = paramRetryAdjust({ model: "m", tools }, "Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 198 instead.");
  if (!a || a.payload.tools.length !== 128) throw new Error("not trimmed: " + (a && a.payload.tools.length));
});
await t("retry-adjust: unknown complaints return null (no blind retries)", async () => {
  if (paramRetryAdjust({ model: "m", temperature: 0.7 }, "The model is overloaded.") !== null) throw new Error("retried an overload");
  if (paramRetryAdjust({ model: "m" }, "Unsupported value: 'temperature'") !== null) throw new Error("changed nothing yet retried");
});

// ---------------- Part 2: e2e over the wire ----------------
const PORT = 8900 + Math.floor(process.uptime() * 7) % 90;
const MOCK_OLLAMA = PORT + 1;
const MOCK_PROVIDER = PORT + 2;

const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

// One mock speaks for BOTH providers (OPENAI_URL and ANTHROPIC_URL point here). It records every
// payload and, for gpt-4o, rejects the FIRST request with a parameter-naming 400 to exercise the net.
const calls = [];
let gpt4oRejects = 1;
const responsesText = (id, value) => [
  `data: ${JSON.stringify({ type: "response.output_text.delta", response_id: id, output_index: 0, content_index: 0, delta: value })}`,
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [{ id: "msg_" + id, type: "message", role: "assistant", content: [{ type: "output_text", text: value }] }],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    },
  })}`,
  "data: [DONE]",
  "",
  "",
].join("\n\n");
const anthropicText = (id, value) => [
  `data: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [], usage: { input_tokens: 12, output_tokens: 0 } } })}`,
  `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } })}`,
  `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}`,
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  "",
  "",
].join("\n\n");
const mockProvider = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    const body = JSON.parse(b);
    calls.push({ url: req.url, body });
    if (body.model === "gpt-4o" && gpt4oRejects > 0) {
      gpt4oRejects--;
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.4 with this model. Only the default (1) value is supported." } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (req.url === "/v1/responses") return res.end(responsesText("resp_" + calls.length, "shaped ok"));
    if (req.url === "/v1/messages") return res.end(anthropicText("msg_" + calls.length, "shaped ok"));
    res.end('data: {"choices":[{"delta":{"content":"shaped ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
});
await new Promise((r) => mockProvider.listen(MOCK_PROVIDER, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "dominion-params-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  OPEN_AI_DOMINION_UI_APIKEY: "test-key-not-real", ANTHROPIC_API_KEY: "test-key-not-real",
  OPENAI_URL: "http://127.0.0.1:" + MOCK_PROVIDER + "/v1/responses",
  ANTHROPIC_URL: "http://127.0.0.1:" + MOCK_PROVIDER + "/v1/chat/completions",
  OPENROUTER_API_KEY: "", DEEPSEEK_AI_DOMINION_UI_APIKEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

async function waitForBoot() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}
await waitForBoot();

// Drive one /chat turn on a forced model; resolve with the concatenated answer + error codes.
function chat(model, temperature) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ messages: [{ role: "user", content: "ping" }], model, mode: "fast", temperature });
    let answer = "", errors = [], done = false;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => {
          buf += d;
          const ls = buf.split("\n"); buf = ls.pop() || "";
          for (const l of ls) {
            const s = l.trim();
            if (!s.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
            if (ev.type === "token" && ev.delta) answer += ev.delta;
            if (ev.type === "error") errors.push(ev.message || ev.code || "error");
          }
        });
        res.on("end", () => { done = true; resolve({ answer, errors }); });
      });
    r.on("error", () => resolve({ answer, errors: ["conn"] }));
    r.write(data); r.end();
    setTimeout(() => { if (!done) { try { r.destroy(); } catch {} resolve({ answer, errors: errors.concat("timeout") }); } }, 15000);
  });
}
const callsFor = (m) => calls.filter((c) => c.body.model === m);

await t("e2e: gpt-5.6 uses native Responses input/max_output_tokens and NO temperature", async () => {
  const r = await chat("openai/gpt-5.6-luna", 0.9);
  const sent = callsFor("gpt-5.6-luna");
  if (!sent.length) throw new Error("no call reached the mock: " + JSON.stringify(r.errors));
  for (const call of sent) {
    const c = call.body;
    if (call.url !== "/v1/responses") throw new Error("wrong OpenAI path: " + call.url);
    if (!Array.isArray(c.input) || !c.input.length) throw new Error("Responses input missing");
    if ("messages" in c) throw new Error("legacy messages leaked into Responses payload");
    if ("temperature" in c) throw new Error("temperature leaked: " + c.temperature);
    if (!("max_output_tokens" in c)) throw new Error("max_output_tokens missing");
    if ("max_completion_tokens" in c || "max_tokens" in c) throw new Error("legacy token field leaked");
  }
  if (!r.answer.includes("shaped ok")) throw new Error("Responses stream did not reach the client: " + JSON.stringify(r));
});

await t("e2e: Anthropic turn uses native Messages thinking without sampling controls", async () => {
  const r = await chat("anthropic/claude-haiku-4-5", 1.2);
  const sent = callsFor("claude-haiku-4-5-20251001");   // the catalog's dated directId
  if (!sent.length) throw new Error("no call reached the mock");
  for (const call of sent) {
    if (call.url !== "/v1/messages") throw new Error("wrong Anthropic path: " + call.url);
    if (!Array.isArray(call.body.messages) || !call.body.messages.length) throw new Error("native messages missing");
    if (!call.body.thinking || call.body.thinking.type !== "enabled") throw new Error("native thinking missing");
    if ("temperature" in call.body) throw new Error("temperature leaked into a thinking request");
  }
  if (!r.answer.includes("shaped ok")) throw new Error("Messages stream did not reach the client: " + JSON.stringify(r));
});

await t("e2e: a 400 naming 'temperature' is retried ONCE without it and the turn succeeds", async () => {
  const r = await chat("openai/gpt-4o", 0.4);
  const sent = callsFor("gpt-4o");
  if (sent.length !== 2) throw new Error("expected 2 attempts, saw " + sent.length);
  if (!("temperature" in sent[0].body)) throw new Error("first attempt should carry temperature");
  if ("temperature" in sent[1].body) throw new Error("retry still carried temperature");
  for (const call of sent) if (call.url !== "/v1/responses") throw new Error("wrong retry path: " + call.url);
  if (!r.answer.includes("shaped ok")) throw new Error("turn did not complete: " + JSON.stringify(r));
});

await t("kimi-k3 sheds temperature at the shaping layer, permanently", async () => {
  const { shapeCloudParams } = await import("./cloudparams.mjs");
  const shaped = shapeCloudParams({ provider: "moonshot", directId: "kimi-k3", temperature: 0.7, tools: null });
  if (shaped.temperature !== undefined) throw new Error("kimi-k3 temperature must be omitted");
  const k26 = shapeCloudParams({ provider: "moonshot", directId: "kimi-k2.6", temperature: 0.7, tools: null });
  if (k26.temperature !== 0.7) throw new Error("kimi-k2.6 must keep its temperature");
});

console.log(`\ncloudparams: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
mockProvider.close();
process.exit(failed ? 1 : 0);
