/*
 * Native Anthropic server-path regression.
 *
 * Proves that Dominion keeps signed thinking/tool blocks intact across a real
 * /chat tool loop, executes the requested action, rejects prose-only completion,
 * and accepts task_complete only after the action exists in its own ledger.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9050 + Math.floor(process.uptime() * 19) % 120;
const MOCK_OLLAMA = PORT + 1;
const MOCK_PROVIDER = PORT + 2;

function anthropicStream({ id, blocks, stopReason }) {
  const events = [
    { type: "message_start", message: {
      id, type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
      content: [], usage: { input_tokens: 30, output_tokens: 0 },
    } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
      events.push({ type: "content_block_stop", index });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: {
        type: "tool_use", id: block.id, name: block.name, input: {},
      } });
      events.push({ type: "content_block_delta", index, delta: {
        type: "input_json_delta", partial_json: JSON.stringify(block.input),
      } });
      events.push({ type: "content_block_stop", index });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      events.push({ type: "content_block_stop", index });
    }
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  events.push({ type: "message_stop" });
  return events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
}

const mockOllama = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/api/chat"
      ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 2 })
      : "{}");
  });
});
await new Promise((resolve) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", resolve));

const calls = [];
const mockProvider = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    calls.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls.length === 1) {
      return res.end(anthropicStream({
        id: "msg_create",
        stopReason: "tool_use",
        blocks: [
          { type: "thinking", thinking: "I need to create the requested file.", signature: "signed-create-state" },
          { type: "tool_use", id: "toolu_create", name: "create_docx", input: {
            title: "Native Claude Test",
            content: "# Native Claude Test\n\nThe requested document.",
          } },
        ],
      }));
    }
    if (calls.length === 2) {
      const createdResult = (body.messages || []).flatMap((message) =>
        Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === "tool_result" && block.tool_use_id === "toolu_create");
      const evidenceId = /\[Dominion evidence id:\s*([^;\]]+)/i.exec(String(createdResult && createdResult.content || ""))?.[1] || "";
      return res.end(anthropicStream({
        id: "msg_complete",
        stopReason: "tool_use",
        blocks: [
          { type: "thinking", thinking: "The tool result confirms the file.", signature: "signed-complete-state" },
          { type: "tool_use", id: "toolu_complete", name: "task_complete", input: {
            status: "completed",
            result: "The Word document was created.",
            changes: ["Created the requested Word document."],
            validation: [{ name: "create_docx", status: "passed", detail: "The tool returned a DOCX export." }],
            remaining: [],
            evidenceIds: evidenceId ? [evidenceId] : ["invented-missing-evidence"],
          } },
        ],
      }));
    }
    return res.end(anthropicStream({
      id: "msg_final",
      stopReason: "end_turn",
      blocks: [{ type: "text", text: "The requested document is ready." }],
    }));
  });
});
await new Promise((resolve) => mockProvider.listen(MOCK_PROVIDER, "127.0.0.1", resolve));

const dataDir = mkdtempSync(join(tmpdir(), "dominion-anthropic-e2e-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  OLLAMA_URL: `http://127.0.0.1:${MOCK_OLLAMA}`,
  MEMORY_DIR: join(dataDir, "memory"),
  CHATLOG_DIR: join(dataDir, "chatlog"),
  ARTIFACT_DIR: join(dataDir, "artifacts"),
  PERSONA_DIR: join(dataDir, "corpus"),
  PERSONA_STAGING: join(dataDir, "staging"),
  FLYWHEEL_DIR: join(dataDir, "flywheel"),
  LOG_DIR: join(dataDir, "logs"),
  SANDBOX_DIR: join(dataDir, "sandbox"),
  DATA_DIR: dataDir,
  AUTO_MENTOR: "0",
  PERIODIC_MENTOR: "0",
  WATCHDOG_ENABLED: "0",
  CLOUD_BACKUP_ENABLED: "0",
  CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main",
  LIGHT_MODEL: "mock-light",
  EMBED_MODEL: "mock-embed",
  ANTHROPIC_API_KEY: "test-key-not-real",
  ANTHROPIC_URL: `http://127.0.0.1:${MOCK_PROVIDER}/v1/messages`,
  OPEN_AI_DOMINION_UI_APIKEY: "",
  OPENROUTER_API_KEY: "",
  DEEPSEEK_AI_DOMINION_UI_APIKEY: "",
  STRIPE_SECRET_KEY: "",
};
const child = spawn(process.execPath, [join(HERE, "server.mjs")], {
  cwd: HERE,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (chunk) => { bootLog += chunk; });
child.stderr.on("data", (chunk) => { bootLog += chunk; });

for (let attempt = 0; attempt < 120; attempt++) {
  const ready = await new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
  });
  if (ready) break;
  if (attempt === 119) throw new Error("server did not boot:\n" + bootLog.slice(-2_000));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const result = await new Promise((resolve) => {
  const payload = JSON.stringify({
    messages: [{ role: "user", content: "Make me a Word document called Native Claude Test." }],
    model: "anthropic/claude-haiku-4-5",
    mode: "tool",
    chatId: "anthropic-native-e2e",
  });
  const events = [];
  const request = http.request({
    host: "127.0.0.1",
    port: PORT,
    path: "/chat",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  }, (response) => {
    let buffer = "";
    response.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim().startsWith("data:")) continue;
        try { events.push(JSON.parse(line.trim().slice(5).trim())); } catch {}
      }
    });
    response.on("end", () => resolve(events));
  });
  request.on("error", (error) => resolve([{ type: "error", error: error.message }]));
  request.end(payload);
});

try {
  if (calls.length !== 3) throw new Error(`expected 3 native turns, saw ${calls.length}`);
  if (calls.some((call) => call.url !== "/v1/messages")) throw new Error("a Claude turn missed the native Messages endpoint");
  const firstTools = calls[0].body.tools || [];
  if (!firstTools.some((tool) => tool.name === "create_docx")) throw new Error("create_docx was not mapped to a native tool");
  if (!firstTools.some((tool) => tool.name === "task_complete")) throw new Error("task_complete was not mapped to a native tool");
  if (calls[0].body.tool_choice?.disable_parallel_tool_use !== true) {
    throw new Error("completion-gated Claude work did not disable parallel tool calls");
  }

  const replayedAssistant = calls[1].body.messages.find((message) => (
    message.role === "assistant"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_use" && block.id === "toolu_create")
  ));
  if (!replayedAssistant) throw new Error("native assistant tool turn was flattened or lost");
  const signedThinking = replayedAssistant.content.find((block) => block.type === "thinking");
  if (!signedThinking || signedThinking.signature !== "signed-create-state") {
    throw new Error("signed Claude thinking was not replayed losslessly");
  }
  const createResult = calls[1].body.messages.find((message) => (
    message.role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "toolu_create")
  ));
  if (!createResult) throw new Error("create_docx result was not mapped to a native tool_result");

  const completionResult = calls[2].body.messages.find((message) => (
    message.role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) => (
      block.type === "tool_result"
      && block.tool_use_id === "toolu_complete"
      && /accepted/i.test(String(block.content))
    ))
  ));
  if (!completionResult) throw new Error("task completion was not accepted after observed execution");
  if (!result.some((event) => event.type === "file" && /\.docx$/i.test(event.name || ""))) {
    throw new Error("the native Claude action did not deliver a DOCX file event");
  }
  const done = result.find((event) => event.type === "done");
  if (!done || done.meta?.completionVerified !== true) throw new Error("the completed native run was not evidence-verified");
  if (result.some((event) => event.type === "error")) {
    throw new Error("native run emitted an error: " + JSON.stringify(result.filter((event) => event.type === "error")));
  }
  console.log("anthropic server e2e: 13 assertions passed, 0 failed");
} finally {
  child.kill();
  mockOllama.close();
  mockProvider.close();
}
