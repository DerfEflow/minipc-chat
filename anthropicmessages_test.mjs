/*
 * Native Anthropic Messages adapter self-test. No credentials or network.
 * Run: node anthropicmessages_test.mjs
 */
import {
  anthropicEndpoint,
  anthropicMessagesStream,
  buildAnthropicMessagesPayload,
  chatMessagesToAnthropic,
  chatToolsToAnthropicTools,
} from "./anthropicmessages.mjs";

let passed = 0;
let failed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ok  " + name);
  } catch (error) {
    failed++;
    console.error("FAIL  " + name + "\n      " + error.stack);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (actual, expected, message) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nactual:   ${a}\nexpected: ${e}`);
};

function sseResponse(events, { status = 200, headers = {}, splits = [] } = {}) {
  const source = events.map((event) =>
    `event: ${event.type || "message"}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const chunks = [];
  if (!splits.length) chunks.push(source);
  else {
    let offset = 0;
    for (const size of splits) {
      chunks.push(source.slice(offset, offset + size));
      offset += size;
    }
    if (offset < source.length) chunks.push(source.slice(offset));
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function finishedEvents(stopReason = "end_turn", blocks = [
  { type: "text", text: "done" },
]) {
  const events = [{
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }];
  for (const [index, block] of blocks.entries()) {
    const empty = block.type === "text"
      ? { ...block, text: "" }
      : block.type === "tool_use"
        ? { ...block, input: {} }
        : clone(block);
    events.push({ type: "content_block_start", index, content_block: empty });
    if (block.type === "text" && block.text) {
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  events.push({ type: "message_stop" });
  return events;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

await t("message mapping separates system, images, tool calls, and grouped results", async () => {
  const mapped = chatMessagesToAnthropic([
    { role: "system", content: "govern safely" },
    { role: "developer", content: "finish the work" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        { type: "text", text: "inspect" },
      ],
      attachments: [{ kind: "text", name: "notes.txt", text: "hello" }],
    },
    {
      role: "assistant",
      content: "I will inspect.",
      tool_calls: [{
        id: "call_7",
        type: "function",
        function: { name: "forge_read", arguments: "{\"path\":\"a\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call_7", content: "contents" },
    { role: "tool", tool_call_id: "call_8", content: "failed", is_error: true },
  ]);

  assert(mapped.system.includes("govern safely"), "system prompt missing");
  assert(mapped.system.includes("[Developer instruction]\nfinish the work"), "developer prompt missing");
  assert(mapped.messages[0].role === "user" && Array.isArray(mapped.messages[0].content), "user message shape wrong");
  const image = mapped.messages[0].content.find((block) => block.type === "image");
  assert(image.source.type === "base64" && image.source.media_type === "image/png" && image.source.data === "abc", "image conversion failed");
  assert(mapped.messages[0].content.some((block) => block.type === "text" && /notes\.txt/.test(block.text) && /hello/.test(block.text)), "text attachment missing");
  const assistant = mapped.messages[1].content;
  assert(assistant[0].type === "text" && assistant[0].text === "I will inspect.", "assistant text missing");
  assert(assistant[1].type === "tool_use" && assistant[1].id === "call_7", "tool use missing");
  same(assistant[1].input, { path: "a" }, "tool arguments changed");
  assert(mapped.messages[2].role === "user" && mapped.messages[2].content.length === 2, "tool results were not grouped");
  assert(mapped.messages[2].content[0].type === "tool_result" && mapped.messages[2].content[0].tool_use_id === "call_7", "tool result mapping wrong");
  assert(mapped.messages[2].content[1].is_error === true, "tool error flag missing");
});

await t("non-vision mapping retains an honest image marker", async () => {
  const mapped = chatMessagesToAnthropic([{
    role: "user",
    content: [{ type: "image_url", image_url: { url: "https://example.test/x.png" } }],
  }], { vision: false });
  assert(mapped.messages[0].content[0].type === "text" && /cannot inspect/i.test(mapped.messages[0].content[0].text), "image marker missing");
});

await t("opaque signed and redacted assistant blocks round-trip exactly", async () => {
  const opaque = [
    { type: "thinking", thinking: "summary", signature: "opaque-signature" },
    { type: "redacted_thinking", data: "opaque-redacted-data" },
    { type: "text", text: "Using a tool.", citations: [{ type: "char_location", start_char_index: 0 }] },
    { type: "tool_use", id: "toolu_native", name: "forge_read", input: { path: "a" } },
  ];
  const mapped = chatMessagesToAnthropic([
    { role: "assistant", content: "flattened text must not replace blocks", anthropicContent: opaque },
    { role: "tool", tool_call_id: "toolu_native", content: "file" },
  ]);
  same(mapped.messages[0].content, opaque, "opaque assistant content changed");
  assert(mapped.messages[1].content[0].type === "tool_result", "following tool result was not native");
});

await t("function schemas become Anthropic tools while native tools pass through", async () => {
  const tools = chatToolsToAnthropicTools([
    {
      type: "function",
      function: {
        name: "forge_write",
        description: "Write a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        strict: true,
      },
    },
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  ]);
  assert(tools[0].name === "forge_write" && tools[0].input_schema.properties.path, "function schema mapping failed");
  assert(tools[0].strict === true && !("function" in tools[0]), "strict/native shape wrong");
  same(tools[1], { type: "web_search_20250305", name: "web_search", max_uses: 5 }, "native tool changed");
});

await t("Opus 4.8 and Sonnet 5 use adaptive thinking and output_config effort", async () => {
  for (const model of ["claude-opus-4-8", "claude-sonnet-5"]) {
    const payload = buildAnthropicMessagesPayload(model, [{ role: "user", content: "fix it" }], {
      num_predict: 32_000,
      reasoningEffort: "xhigh",
      thinkingDisplay: "summarized",
      outputConfig: { format: { type: "json_schema", schema: { type: "object" } } },
      temperature: 0.2,
    });
    assert(payload.stream === true && payload.max_tokens === 32_000, "output budget missing");
    same(payload.thinking, { type: "adaptive", display: "summarized" }, "adaptive thinking shape wrong");
    assert(payload.output_config.effort === "xhigh" && payload.output_config.format, "effort/output config missing");
    assert(!("temperature" in payload), "thinking request leaked temperature");
  }
  const neutralPolicyPayload = buildAnthropicMessagesPayload(
    "claude-sonnet-5",
    [{ role: "user", content: "finish the full build" }],
    { reasoningEffort: "maximum" },
  );
  assert(neutralPolicyPayload.output_config.effort === "max", "shared-policy effort was not translated");
});

await t("Haiku 4.5 uses valid manual thinking and compatible tool choice", async () => {
  const payload = buildAnthropicMessagesPayload("claude-haiku-4-5-20251001", [{ role: "user", content: "work" }], {
    maxTokens: 1_000,
    reasoningEffort: "max",
    temperature: 0.3,
    tools: [{ type: "function", function: { name: "forge_run", parameters: { type: "object" } } }],
    toolChoice: { type: "function", function: { name: "forge_run" } },
  });
  assert(payload.max_tokens === 2_048, "manual-thinking minimum max_tokens not repaired");
  same(payload.thinking, { type: "enabled", budget_tokens: 2_047 }, "manual budget is not valid");
  same(payload.tool_choice, { type: "auto" }, "incompatible forced tool choice was retained");
  assert(!("output_config" in payload) && !("temperature" in payload), "unsupported Haiku controls leaked");
});

await t("parallelToolCalls false disables parallel native tool use", async () => {
  const payload = buildAnthropicMessagesPayload("claude-opus-4-8", [{ role: "user", content: "finish" }], {
    tools: [
      { type: "function", function: { name: "task_complete", parameters: { type: "object" } } },
      { type: "function", function: { name: "forge_read", parameters: { type: "object" } } },
    ],
    parallelToolCalls: false,
  });
  same(payload.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  }, "parallel tool use was not disabled inside tool_choice");
  assert(!("disable_parallel_tool_use" in payload), "parallel flag leaked to the payload top level");
});

await t("tool choice is omitted when no tools are attached", async () => {
  const payload = buildAnthropicMessagesPayload(
    "claude-opus-4-8",
    [{ role: "user", content: "continue writing" }],
    { tools: null, toolChoice: "none" },
  );
  assert(!("tool_choice" in payload), "tool_choice without tools would be an invalid native request");
});

await t("non-thinking calls keep supported sampling controls", async () => {
  const payload = buildAnthropicMessagesPayload("claude-other", [{ role: "user", content: "hello" }], {
    thinking: false,
    temperature: 1.7,
    topP: 0.8,
    stopSequences: ["END"],
  });
  assert(payload.temperature === 1 && payload.top_p === 0.8, "sampling controls wrong");
  same(payload.stop_sequences, ["END"], "stop sequences missing");
  assert(!payload.thinking, "thinking was not disabled");
});

await t("legacy compatibility endpoint converts to native Messages", async () => {
  assert(
    anthropicEndpoint("https://api.anthropic.com/v1/chat/completions") === "https://api.anthropic.com/v1/messages",
    "legacy endpoint did not convert",
  );
  assert(
    anthropicEndpoint("https://mock.invalid/custom/messages?x=1") === "https://mock.invalid/custom/messages?x=1",
    "custom native endpoint changed",
  );
});

await t("stream parser preserves text, thinking, redaction, tools, usage, and signatures", async () => {
  let sent;
  let headers;
  const textDeltas = [];
  const reasoningDeltas = [];
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_native",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 31, output_tokens: 1, cache_read_input_tokens: 12 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checked carefully." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-opaque" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "redacted-opaque" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Done " } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "well." } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_1", name: "forge_run", input: {} } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"cmd\":" } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "\"npm test\"}" } },
    { type: "content_block_stop", index: 3 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 27, output_tokens_details: { thinking_tokens: 9 } },
    },
    { type: "message_stop" },
  ];
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    headers = init.headers;
    return sseResponse(events, { splits: [1, 2, 7, 13, 5, 29] });
  };
  const result = await anthropicMessagesStream("claude-opus-4-8", [{ role: "user", content: "test" }], {
    apiKey: "test-key",
    endpoint: "https://mock.invalid/v1/messages",
    fetchImpl,
    maxRetries: 0,
    onReasoningDelta: (delta) => reasoningDeltas.push(delta),
  }, (delta) => textDeltas.push(delta));

  assert(sent.model === "claude-opus-4-8" && sent.stream === true && sent.thinking.type === "adaptive", "request wrong");
  assert(headers["x-api-key"] === "test-key" && headers["anthropic-version"] === "2023-06-01", "native auth/version headers wrong");
  assert(result.ok && result.content === "Done well." && result.reasoning === "Checked carefully.", "text/reasoning parse failed");
  assert(textDeltas.join("") === "Done well." && reasoningDeltas.join("") === "Checked carefully.", "delta callbacks wrong");
  assert(result.finishReason === "tool_calls" && result.stopReason === "tool_use", "stop reason mapping wrong");
  assert(result.contentBlocks[0].signature === "signed-opaque", "thinking signature lost");
  assert(result.contentBlocks[1].data === "redacted-opaque", "redacted thinking lost");
  assert(result.toolCalls.length === 1 && result.toolCalls[0].id === "toolu_1", "tool call missing");
  assert(result.toolCalls[0].function.arguments === "{\"cmd\":\"npm test\"}", "tool arguments wrong");
  /*
   * total_tokens moved from 58 to 70 on 2026-08-03, and the old number was wrong. This fixture
   * reports cache_read_input_tokens: 12, and Anthropic's input_tokens EXCLUDES cached reads, so
   * the turn really sent 31 + 12 = 43 input tokens. The previous assertion added only the 31 and
   * therefore pinned the defect: twelve tokens that were sent, counted by the provider, and
   * invisible to every total and every cost path downstream. The native fields must survive
   * untouched beside the OpenAI-shaped ones, because videoSonnetCost reads them directly.
   */
  assert(result.usage.input_tokens === 31 && result.usage.output_tokens === 27, "native usage fields must survive");
  assert(result.usage.cache_read_input_tokens === 12, "the native cache counter must not be rewritten");
  assert(result.usage.prompt_tokens === 43, "prompt_tokens must be the WHOLE input: uncached + cache reads + cache writes");
  assert(result.usage.prompt_tokens_details && result.usage.prompt_tokens_details.cached_tokens === 12,
    "the cached slice must be visible in the OpenAI shape or it bills at zero");
  assert(result.usage.total_tokens === 70, "usage wrong");
  assert(result.messageId === "msg_native" && result.providerMessage.content === result.contentBlocks, "provider continuation fields missing");

  const next = chatMessagesToAnthropic([
    result.providerMessage,
    { role: "tool", tool_call_id: "toolu_1", content: "tests pass" },
  ]);
  same(next.messages[0].content, result.contentBlocks, "streamed provider blocks did not round-trip");
  assert(next.messages[1].content[0].tool_use_id === "toolu_1", "round-trip tool result missing");
});

await t("all native stop reasons normalize without being hidden", async () => {
  const cases = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop_sequence",
    tool_use: "tool_calls",
    pause_turn: "pause_turn",
    refusal: "refusal",
    model_context_window_exceeded: "context",
  };
  for (const [native, normalized] of Object.entries(cases)) {
    const result = await anthropicMessagesStream("claude-opus-4-8", [], {
      apiKey: "k",
      maxRetries: 0,
      fetchImpl: async () => sseResponse(finishedEvents(native)),
    });
    assert(result.ok && result.stopReason === native && result.finishReason === normalized,
      `${native} normalized as ${result.finishReason}`);
  }
});

await t("refusal details are retained on successful HTTP 200 responses", async () => {
  const events = finishedEvents("refusal", [{ type: "text", text: "I cannot help." }]);
  const delta = events.find((event) => event.type === "message_delta");
  delta.delta.stop_details = { type: "refusal", category: "general_harms", explanation: "policy" };
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    maxRetries: 0,
    fetchImpl: async () => sseResponse(events),
  });
  assert(result.ok && result.finishReason === "refusal" && result.content === "I cannot help.", "refusal was treated as transport failure");
  assert(result.stopDetails.category === "general_harms", "refusal details lost");
});

await t("429/5xx retries are bounded, honor retry headers, and never switch model", async () => {
  const bodies = [];
  const sleeps = [];
  const retries = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
        headers: { "retry-after-ms": "999" },
      });
    }
    if (calls === 2) {
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), {
        status: 529,
      });
    }
    return sseResponse(finishedEvents());
  };
  const result = await anthropicMessagesStream("claude-opus-4-8", [{ role: "user", content: "work" }], {
    apiKey: "k",
    fetchImpl,
    maxRetries: 2,
    retryBaseMs: 10,
    maxBackoffMs: 25,
    sleepImpl: async (ms) => sleeps.push(ms),
    onRetry: (info) => retries.push(info),
  });
  assert(result.ok && calls === 3, "transient HTTP errors did not recover");
  assert(bodies.every((body) => body.model === "claude-opus-4-8"), "retry switched models");
  same(sleeps, [25, 20], "backoff was not bounded/exponential");
  assert(retries.length === 2 && retries.every((entry) => entry.reason === "http"), "retry telemetry wrong");
});

await t("pre-output overloaded stream error retries on the same model", async () => {
  let calls = 0;
  const models = [];
  const result = await anthropicMessagesStream("claude-sonnet-5", [], {
    apiKey: "k",
    maxRetries: 1,
    retryBaseMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      calls++;
      models.push(JSON.parse(init.body).model);
      if (calls === 1) {
        return sseResponse([{ type: "error", error: { type: "overloaded_error", message: "busy" } }]);
      }
      return sseResponse(finishedEvents());
    },
  });
  assert(result.ok && calls === 2, "stream error did not recover");
  assert(models.every((model) => model === "claude-sonnet-5"), "stream retry switched models");
});

await t("empty premature stream retries before any provider output", async () => {
  let calls = 0;
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    maxRetries: 1,
    retryBaseMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? sseResponse([{ type: "ping" }]) : sseResponse(finishedEvents());
    },
  });
  assert(result.ok && calls === 2, "premature empty stream did not recover");
});

await t("ordinary 400 is returned once without retry", async () => {
  let calls = 0;
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "bad field" },
      }), { status: 400 });
    },
  });
  assert(!result.ok && result.status === 400 && /bad field/.test(result.error) && calls === 1, "400 was retried or hidden");
});

await t("network failure retries only before output", async () => {
  let calls = 0;
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    maxRetries: 1,
    retryBaseMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError("socket closed");
      return sseResponse(finishedEvents());
    },
  });
  assert(result.ok && calls === 2, "pre-output network failure did not recover");
});

await t("an already-aborted request never reaches Anthropic", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return sseResponse([]);
    },
  });
  assert(!result.ok && result.aborted && result.error === "stopped" && calls === 0, "pre-abort semantics broken");
});

await t("abort during transport stops without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    calls++;
    init.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  const pending = anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    signal: controller.signal,
    fetchImpl,
    maxRetries: 3,
    retryBaseMs: 0,
  });
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert(!result.ok && result.aborted && result.error === "stopped" && calls === 1, "mid-call abort retried");
});

await t("timeout retry is bounded and stays on the same model", async () => {
  let calls = 0;
  const models = [];
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    calls++;
    models.push(JSON.parse(init.body).model);
    init.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("timed out"), { name: "AbortError" }));
    }, { once: true });
  });
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    fetchImpl,
    timeoutMs: 5,
    maxRetries: 1,
    retryBaseMs: 0,
    sleepImpl: async () => {},
  });
  assert(!result.ok && /timed out/i.test(result.error) && calls === 2, "timeout retries were not bounded");
  assert(models.every((model) => model === "claude-opus-4-8"), "timeout retry switched models");
});

await t("stream failure after provider output is partial and never retried", async () => {
  let calls = 0;
  const encoder = new TextEncoder();
  const fetchImpl = async () => {
    calls++;
    const body = new ReadableStream({
      start(controller) {
        const frames = [
          {
            type: "message_start",
            message: { id: "msg_partial", content: [], usage: { input_tokens: 2, output_tokens: 1 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "visible" } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
        controller.enqueue(encoder.encode(frames));
        setTimeout(() => controller.error(new Error("connection reset")), 0);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    fetchImpl,
    maxRetries: 3,
    retryBaseMs: 0,
    sleepImpl: async () => {},
  });
  assert(!result.ok && result.partial && result.content === "visible" && calls === 1, "partial stream was retried or lost");
});

await t("stream error after a tool block is not retried or duplicated", async () => {
  let calls = 0;
  const events = [
    {
      type: "message_start",
      message: { id: "msg_tool_partial", content: [], usage: { input_tokens: 2, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_partial", name: "forge_run", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"x\"}" } },
    { type: "content_block_stop", index: 0 },
    { type: "error", error: { type: "overloaded_error", message: "failed after output" } },
  ];
  const result = await anthropicMessagesStream("claude-opus-4-8", [], {
    apiKey: "k",
    maxRetries: 3,
    retryBaseMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      return sseResponse(events);
    },
  });
  assert(!result.ok && result.partial && calls === 1, "tool-producing partial stream was retried");
  assert(result.toolCalls[0].id === "toolu_partial", "partial tool block was lost");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
