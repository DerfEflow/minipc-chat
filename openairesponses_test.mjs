/*
 * Native Responses adapter self-test. No provider credentials or network calls.
 * Run: node openairesponses_test.mjs
 */
import {
  buildResponsesPayload,
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  openAIResponsesStream,
  responsesEndpoint,
} from "./openairesponses.mjs";

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (error) { failed++; console.error("FAIL  " + name + "\n      " + error.stack); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function sseResponse(events, { status = 200, headers = {}, splits = [] } = {}) {
  const source = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
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
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

const completed = (output = [], usage = { input_tokens: 12, output_tokens: 7, total_tokens: 19 }) => ({
  type: "response.completed",
  response: { id: "resp_1", status: "completed", output, usage },
});

await t("message mapping preserves roles, images, attachments, calls, and results", async () => {
  const input = chatMessagesToResponsesInput([
    { role: "system", content: "govern safely" },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }, { type: "text", text: "inspect" }],
      attachments: [{ kind: "text", name: "notes.txt", text: "hello" }],
    },
    {
      role: "assistant",
      content: "I will inspect.",
      tool_calls: [{ id: "call_7", type: "function", function: { name: "forge_read", arguments: "{\"path\":\"a\"}" } }],
    },
    { role: "tool", tool_call_id: "call_7", content: "contents" },
  ]);
  assert(input[0].role === "system" && input[0].content === "govern safely", "system message changed");
  assert(Array.isArray(input[1].content), "multimodal content was flattened");
  assert(input[1].content.some((p) => p.type === "input_image" && p.image_url.includes("base64")), "image missing");
  assert(input[1].content.some((p) => p.type === "input_text" && p.text.includes("notes.txt") && p.text.includes("hello")), "text attachment missing");
  assert(input[2].role === "assistant" && input[2].content === "I will inspect.", "assistant text missing");
  assert(input[3].type === "function_call" && input[3].call_id === "call_7" && input[3].name === "forge_read", "tool call not translated");
  assert(input[4].type === "function_call_output" && input[4].call_id === "call_7" && input[4].output === "contents", "tool result not translated");
});

await t("non-vision mapping keeps an honest image marker", async () => {
  const input = chatMessagesToResponsesInput([{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }], { vision: false });
  assert(typeof input[0].content === "string" && /cannot inspect/i.test(input[0].content), "image marker missing");
});

await t("function schema mapping flattens Chat tools and preserves native tools", async () => {
  const tools = chatToolsToResponsesTools([
    { type: "function", function: { name: "forge_read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: true } },
    { type: "web_search_preview", search_context_size: "high" },
  ]);
  assert(tools[0].name === "forge_read" && !tools[0].function, "function was not flattened");
  assert(tools[0].strict === true && tools[0].parameters.properties.path, "function schema lost");
  assert(tools[1].type === "web_search_preview" && tools[1].search_context_size === "high", "native tool changed");
});

await t("payload uses Responses reasoning, output budget, verbosity, and tool choice", async () => {
  const payload = buildResponsesPayload("gpt-5.6-sol", [{ role: "user", content: "fix it" }], {
    num_predict: 32_000,
    reasoningEffort: "max",
    reasoningSummary: "auto",
    reasoningContext: "all_turns",
    verbosity: "high",
    tools: [{ type: "function", function: { name: "forge_write", parameters: { type: "object" } } }],
    toolChoice: { type: "function", function: { name: "forge_write" } },
    parallelToolCalls: false,
  });
  assert(payload.stream === true && payload.max_output_tokens === 32_000, "output budget missing");
  assert(payload.reasoning.effort === "max" && payload.reasoning.summary === "auto" && payload.reasoning.context === "all_turns", "reasoning shape wrong");
  assert(payload.text.verbosity === "high", "verbosity missing");
  assert(payload.tools[0].name === "forge_write", "tool missing");
  assert(payload.tool_choice.type === "function" && payload.tool_choice.name === "forge_write", "tool choice wrong");
  assert(!("reasoning_effort" in payload), "Chat reasoning field leaked");
});

await t("legacy Chat endpoint is safely converted to Responses", async () => {
  assert(responsesEndpoint("https://api.openai.com/v1/chat/completions") === "https://api.openai.com/v1/responses", "endpoint not converted");
  assert(responsesEndpoint("https://mock.invalid/custom/responses?x=1") === "https://mock.invalid/custom/responses?x=1", "custom endpoint changed");
});

await t("stream parser returns text, reasoning, function calls, usage, and status", async () => {
  const seen = [];
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return sseResponse([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.reasoning_summary_text.delta", delta: "Checked." },
      { type: "response.output_text.delta", delta: "Done " },
      { type: "response.output_text.delta", delta: "well." },
      { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "forge_run", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{\"cmd\":" },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: "{\"cmd\":\"npm test\"}" },
      { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "forge_run", arguments: "{\"cmd\":\"npm test\"}" } },
      completed([
        { type: "reasoning", summary: [{ type: "summary_text", text: "Checked." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done well.", annotations: [] }] },
        { id: "fc_1", type: "function_call", call_id: "call_1", name: "forge_run", arguments: "{\"cmd\":\"npm test\"}" },
      ]),
    ], { splits: [1, 2, 7, 13, 5, 29] });
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "test" }], {
    apiKey: "test-key",
    endpoint: "https://mock.invalid/v1/responses",
    fetchImpl,
    maxRetries: 0,
  }, (delta) => seen.push(delta));
  assert(sent.model === "gpt-5.6-sol" && sent.stream === true, "request wrong");
  assert(result.ok && result.content === "Done well." && result.reasoning === "Checked.", "text/reasoning parse failed: " + JSON.stringify(result));
  assert(seen.join("") === "Done well.", "delta callback wrong");
  assert(result.finishReason === "tool_calls" && result.status === "completed", "finish status wrong");
  assert(result.toolCalls.length === 1 && result.toolCalls[0].id === "call_1", "call id wrong");
  assert(result.toolCalls[0].function.arguments === "{\"cmd\":\"npm test\"}", "call arguments wrong");
  assert(result.usage.input_tokens === 12 && result.responseId === "resp_1", "usage/id missing");
});

await t("stateless tool rounds preserve and replay encrypted reasoning output", async () => {
  const reasoningItem = {
    id: "rs_1",
    type: "reasoning",
    encrypted_content: "opaque-provider-state",
    summary: [],
  };
  const callItem = {
    id: "fc_state",
    type: "function_call",
    call_id: "call_state",
    name: "forge_read",
    arguments: "{\"path\":\"src/app.mjs\"}",
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "inspect" }], {
    apiKey: "k",
    fetchImpl: async () => sseResponse([completed([reasoningItem, callItem])]),
    maxRetries: 0,
  });
  assert(result.ok && result.responseItems.length === 2, "native response output was not retained");
  assert(result.responseItems[0].encrypted_content === "opaque-provider-state", "encrypted reasoning state was lost");

  const payload = buildResponsesPayload("gpt-5.6-sol", [
    { role: "user", content: "inspect" },
    {
      role: "assistant",
      content: "",
      tool_calls: result.toolCalls,
      responsesOutput: result.responseItems,
    },
    { role: "tool", tool_call_id: "call_state", content: "file contents" },
  ], {
    store: false,
    include: ["reasoning.encrypted_content"],
  });
  assert(payload.store === false, "stateless provider mode changed");
  assert(payload.include[0] === "reasoning.encrypted_content", "encrypted reasoning was not requested");
  assert(payload.input[1].type === "reasoning" && payload.input[1].encrypted_content === "opaque-provider-state",
    "reasoning item was not replayed before the tool result");
  assert(payload.input[2].type === "function_call" && payload.input[2].call_id === "call_state",
    "provider function call was not replayed exactly");
  assert(payload.input[3].type === "function_call_output" && payload.input[3].call_id === "call_state",
    "tool result was not paired with the replayed provider call");
});

await t("completed output is used when a provider emits no deltas", async () => {
  const fetchImpl = async () => sseResponse([
    completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "final only", annotations: [] }] }]),
  ]);
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "hi" }], {
    apiKey: "k", fetchImpl, maxRetries: 0,
  });
  assert(result.ok && result.content === "final only" && result.finishReason === "stop", "final output fallback failed");
});

await t("bare DONE without a Responses terminal event is rejected", async () => {
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "hi" }], {
    apiKey: "k",
    fetchImpl: async () => sseResponse(["[DONE]"]),
    maxRetries: 0,
  });
  assert(!result.ok && !result.partial, "bare DONE was accepted as a complete response");
  assert(result.content === "" && /before a terminal event/i.test(result.error), "bare DONE returned the wrong stream error");
});

await t("bare DONE after deltas is a partial error and keeps visible output", async () => {
  const seen = [];
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "hi" }], {
    apiKey: "k",
    fetchImpl: async () => sseResponse([
      { type: "response.output_text.delta", delta: "still visible" },
      { type: "response.reasoning_summary_text.delta", delta: "partial reasoning" },
      "[DONE]",
    ]),
    maxRetries: 0,
  }, (delta) => seen.push(delta));
  assert(!result.ok && result.partial && result.finishReason === "error", "delta-only DONE stream was not marked partial");
  assert(result.content === "still visible" && seen.join("") === "still visible", "partial visible output was lost");
  assert(result.reasoning === "partial reasoning" && /before a terminal event/i.test(result.error), "partial reasoning or terminal error was lost");
});

await t("terminal-shaped event without a response object is rejected", async () => {
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "hi" }], {
    apiKey: "k",
    fetchImpl: async () => sseResponse([
      { type: "response.output_text.delta", delta: "unverified" },
      { type: "response.completed" },
      "[DONE]",
    ]),
    maxRetries: 0,
  });
  assert(!result.ok && result.partial && result.content === "unverified", "missing terminal response object was trusted or output was lost");
  assert(/before a terminal event/i.test(result.error), "missing response object returned the wrong error");
});

await t("valid terminal before DONE retains native response items", async () => {
  const nativeItem = {
    id: "rs_done",
    type: "reasoning",
    encrypted_content: "opaque-done-state",
    summary: [],
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "hi" }], {
    apiKey: "k",
    fetchImpl: async () => sseResponse([completed([nativeItem]), "[DONE]"]),
    maxRetries: 0,
  });
  assert(result.ok && result.status === "completed", "valid terminal event was invalidated by DONE");
  assert(result.responseItems.length === 1 && result.responseItems[0].encrypted_content === "opaque-done-state",
    "valid terminal response items were lost");
});

await t("streamed refusal stays visible exactly once", async () => {
  const seen = [];
  const refusal = "I can't help with that request.";
  const fetchImpl = async () => sseResponse([
    { type: "response.refusal.delta", delta: "I can't help " },
    { type: "response.refusal.delta", delta: "with that request." },
    { type: "response.refusal.done", refusal },
    completed([{
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal }],
    }]),
  ]);
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "request" }], {
    apiKey: "k", fetchImpl, maxRetries: 0,
  }, (delta) => seen.push(delta));
  assert(result.ok && result.content === refusal, "refusal content was lost or duplicated: " + JSON.stringify(result));
  assert(seen.join("") === refusal, "refusal events were not emitted visibly exactly once: " + JSON.stringify(seen));
  assert(result.finishReason === "stop", "a visible refusal was misclassified as a transport failure");
});

await t("final-only refusal content is preserved", async () => {
  const refusal = "I can't provide that.";
  const fetchImpl = async () => sseResponse([
    completed([{
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal }],
    }]),
  ]);
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "request" }], {
    apiKey: "k", fetchImpl, maxRetries: 0,
  });
  assert(result.ok && result.content === refusal, "final refusal fallback failed: " + JSON.stringify(result));
});

await t("incomplete max-output response normalizes to length", async () => {
  const fetchImpl = async () => sseResponse([{
    type: "response.incomplete",
    response: {
      id: "resp_short",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  }]);
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "long" }], {
    apiKey: "k", fetchImpl, maxRetries: 0,
  });
  assert(result.ok && result.content === "partial" && result.finishReason === "length", "incomplete response wrong");
});

await t("429 and 5xx retry with bounded backoff and never switch models", async () => {
  const bodies = [], retries = [], sleeps = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "retry-after": "999" } });
    if (calls === 2) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    return sseResponse([completed([{ type: "message", content: [{ type: "output_text", text: "recovered" }] }])]);
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "work" }], {
    apiKey: "k",
    fetchImpl,
    maxRetries: 2,
    retryBaseMs: 10,
    maxBackoffMs: 25,
    sleepImpl: async (ms) => sleeps.push(ms),
    onRetry: (info) => retries.push(info),
  });
  assert(result.ok && result.content === "recovered" && calls === 3, "did not recover");
  assert(bodies.every((body) => body.model === "gpt-5.6-sol"), "model switched");
  assert(sleeps[0] === 25 && sleeps[1] === 20, "backoff was not bounded/exponential: " + sleeps);
  assert(retries.length === 2 && retries.every((r) => r.reason === "http"), "retry telemetry wrong");
});

await t("recognized Responses parameter 400 gets one repaired resend", async () => {
  const bodies = [], retries = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'reasoning.context' is not supported with this model." },
      }), { status: 400 });
    }
    return sseResponse([completed([{ type: "message", content: [{ type: "output_text", text: "repaired" }] }])]);
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "work" }], {
    apiKey: "k",
    fetchImpl,
    maxRetries: 0,
    reasoningEffort: "high",
    reasoningContext: "all_turns",
    onRetry: (info) => retries.push(info),
  });
  assert(result.ok && result.content === "repaired" && bodies.length === 2, "recognized parameter was not repaired");
  assert(bodies[0].reasoning.context === "all_turns", "first request did not exercise the rejected field");
  assert(!("context" in bodies[1].reasoning) && bodies[1].reasoning.effort === "high", "repair removed more than the rejected parameter");
  assert(retries.length === 1 && retries[0].reason === "parameter" && /reasoning\.context removed/.test(retries[0].note), "repair telemetry missing");
});

await t("recognized parameter repair is attempted at most once", async () => {
  let calls = 0;
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "work" }], {
    apiKey: "k",
    maxRetries: 3,
    reasoningContext: "all_turns",
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'reasoning.context' is not supported with this model." },
      }), { status: 400 });
    },
  });
  assert(!result.ok && result.status === 400 && calls === 2, "parameter-related 400 was retried more than once");
});

await t("network failure retries, while an ordinary 400 does not", async () => {
  let networkCalls = 0;
  const recovered = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "work" }], {
    apiKey: "k",
    maxRetries: 1,
    retryBaseMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      networkCalls++;
      if (networkCalls === 1) throw new TypeError("socket closed");
      return sseResponse([completed([{ type: "message", content: [{ type: "output_text", text: "ok" }] }])]);
    },
  });
  assert(recovered.ok && networkCalls === 2, "network retry failed");

  let badCalls = 0;
  const rejected = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "work" }], {
    apiKey: "k",
    maxRetries: 3,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      badCalls++;
      return new Response(JSON.stringify({ error: { message: "invalid field" } }), { status: 400 });
    },
  });
  assert(!rejected.ok && rejected.status === 400 && /invalid field/.test(rejected.error) && badCalls === 1, "400 retried or hidden");
});

await t("an already-aborted call never reaches the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await openAIResponsesStream("gpt-5.6-sol", [], {
    apiKey: "k",
    signal: controller.signal,
    fetchImpl: async () => { calls++; return sseResponse([]); },
  });
  assert(!result.ok && result.aborted && result.error === "stopped" && calls === 0, "abort semantics broken");
});

await t("abort during transport stops without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    calls++;
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  const pending = openAIResponsesStream("gpt-5.6-sol", [], {
    apiKey: "k", signal: controller.signal, fetchImpl, maxRetries: 3, retryBaseMs: 0,
  });
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert(!result.ok && result.aborted && result.error === "stopped" && calls === 1, "mid-call abort retried");
});

await t("timeout retries are bounded and stay on the same model", async () => {
  let calls = 0;
  const models = [];
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    calls++;
    models.push(JSON.parse(init.body).model);
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })), { once: true });
  });
  const result = await openAIResponsesStream("gpt-5.6-sol", [], {
    apiKey: "k",
    fetchImpl,
    timeoutMs: 5,
    maxRetries: 1,
    retryBaseMs: 0,
    sleepImpl: async () => {},
  });
  assert(!result.ok && /timed out/i.test(result.error) && calls === 2, "timeout retries were not bounded");
  assert(models.every((model) => model === "gpt-5.6-sol"), "timeout retry switched models");
});

await t("mid-stream failure after visible output is not retried", async () => {
  let calls = 0;
  const encoder = new TextEncoder();
  const fetchImpl = async () => {
    calls++;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "visible" })}\n\n`));
        setTimeout(() => controller.error(new Error("connection reset")), 0);
      },
    });
    return new Response(body, { status: 200 });
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [], {
    apiKey: "k", fetchImpl, maxRetries: 3, retryBaseMs: 0, sleepImpl: async () => {},
  });
  assert(!result.ok && result.partial && result.content === "visible" && calls === 1, "partial stream was retried or lost");
});

// ---- Watchdog rewrite (2026-07-30): activity re-arms the idle window; stopwatch kills are gone.
const encoderW = new TextEncoder();
const sseLine = (event) => encoderW.encode(`data: ${JSON.stringify(event)}\n\n`);
// A body that stays open and silent until the fetch signal aborts it, like real fetch does.
function stallingBody(signal, prelude = []) {
  return new ReadableStream({
    start(controller) {
      for (const event of prelude) controller.enqueue(sseLine(event));
      if (signal) signal.addEventListener("abort", () => {
        try { controller.error(Object.assign(new DOMException("aborted", "AbortError"))); } catch {}
      }, { once: true });
    },
  });
}

await t("an actively streaming response outlives the idle window many times over", async () => {
  const fetchImpl = async () => {
    let sent = 0;
    const body = new ReadableStream({
      start(controller) {
        const timer = setInterval(() => {
          sent++;
          if (sent <= 10) controller.enqueue(sseLine({ type: "response.output_text.delta", delta: "t" + sent + " " }));
          else {
            clearInterval(timer);
            controller.enqueue(sseLine(completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 ", annotations: [] }] }])));
            controller.close();
          }
        }, 40);
      },
    });
    return new Response(body, { status: 200 });
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "go" }], {
    apiKey: "k", fetchImpl, maxRetries: 0, timeoutMs: 150,   // wall clock here is ~480ms, 3x the idle window
  });
  assert(result.ok && /t10/.test(result.content), "a healthy slow stream was killed by the watchdog: " + JSON.stringify({ ok: result.ok, error: result.error }));
});

await t("dead silence trips the idle watchdog with a named reason", async () => {
  const fetchImpl = async (_url, init) => new Response(stallingBody(init && init.signal), { status: 200 });
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "go" }], {
    apiKey: "k", fetchImpl, maxRetries: 0, timeoutMs: 120,
  });
  assert(!result.ok && /timed out/i.test(result.error) && /no stream activity/i.test(result.error),
    "silent stream did not report an idle timeout: " + result.error);
});

await t("timeout after delivered text returns a resumable length checkpoint, not a retry", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    return new Response(stallingBody(init && init.signal, [
      { type: "response.output_text.delta", delta: "Half of the answer" },
    ]), { status: 200 });
  };
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "go" }], {
    apiKey: "k", fetchImpl, maxRetries: 3, retryBaseMs: 0, sleepImpl: async () => {}, timeoutMs: 130,
  });
  assert(calls === 1, "delivered text was thrown away and re-bought: calls=" + calls);
  assert(result.ok && result.finishReason === "length" && result.partial === true, "timeout-partial is not a resumable checkpoint: " + JSON.stringify({ ok: result.ok, fr: result.finishReason }));
  assert(result.timedOutPartial === "idle" && result.content === "Half of the answer", "partial content lost");
  assert(Array.isArray(result.toolCalls) && result.toolCalls.length === 0, "half-streamed tool calls must be dropped");
});

await t("reasoning summaries stream as think-wrapped deltas while content stays clean", async () => {
  const seen = [];
  const fetchImpl = async () => sseResponse([
    { type: "response.created", response: { id: "resp_t", status: "in_progress" } },
    { type: "response.reasoning_summary_text.delta", delta: "Weighing options." },
    { type: "response.output_text.delta", delta: "Final " },
    { type: "response.output_text.delta", delta: "answer." },
    completed([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Weighing options." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Final answer.", annotations: [] }] },
    ]),
  ]);
  const result = await openAIResponsesStream("gpt-5.6-sol", [{ role: "user", content: "go" }], {
    apiKey: "k", fetchImpl, maxRetries: 0, emitReasoningAsThink: true,
  }, (delta) => seen.push(delta));
  assert(seen.join("") === "<think>Weighing options.</think>Final answer.", "think wrapping wrong: " + JSON.stringify(seen.join("")));
  assert(result.ok && result.content === "Final answer." && result.reasoning === "Weighing options.", "content polluted by think stream");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
