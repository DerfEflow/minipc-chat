import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateAssistantDeltaInPlace,
  applyProviderExecutionOptions,
  deepSeekExecutionOptions,
  extractProviderStreamError,
  isComplexExecutionPolicy,
  mergeAssistantDelta,
  normalizeProviderTerminal,
  openRouterExecutionOptions,
  projectAssistantToolTurn,
  projectProviderMessages,
  projectToolRound,
  shapeProviderExecutionRequest,
  stableProviderSessionId,
} from "./providerexecution.mjs";

const policy = (score, {
  taskKind = score > 1 ? "build" : "simple",
  workKind = taskKind,
  forgeTier = "ember",
  mode = taskKind === "simple" ? "finish-current-result" : "execute-verify-and-repair",
} = {}) => ({
  taskKind,
  workKind,
  forgeTier,
  effort: { score },
  persistence: { mode },
});

test("complex policy detection follows task, effort, and persistence rather than prompt guesses", () => {
  assert.equal(isComplexExecutionPolicy(policy(0)), false);
  assert.equal(isComplexExecutionPolicy(policy(2, { taskKind: "simple" })), true);
  assert.equal(isComplexExecutionPolicy(policy(0, { taskKind: "audit" })), true);
  assert.equal(isComplexExecutionPolicy(policy(0, {
    taskKind: "simple",
    mode: "checkpoint-resume-until-complete",
  })), true);
});

test("DeepSeek maps ordinary complex work to high and furnace/maximum work to max", () => {
  const build = deepSeekExecutionOptions({ policy: policy(3) });
  assert.deepEqual(build.request, {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert(build.omit.includes("tool_choice"));
  assert(build.omit.includes("temperature"));

  const furnace = deepSeekExecutionOptions({
    policy: policy(4, { forgeTier: "furnace" }),
  });
  assert.equal(furnace.request.reasoning_effort, "max");

  const longRun = deepSeekExecutionOptions({
    policy: policy(3, { taskKind: "long-run" }),
  });
  assert.equal(longRun.request.reasoning_effort, "max");
});

test("DeepSeek request shaping removes controls unsupported during thinking", () => {
  const payload = {
    model: "deepseek-v4-pro",
    temperature: 0.4,
    top_p: 0.9,
    presence_penalty: 0.2,
    frequency_penalty: 0.2,
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "forge_read" } }],
  };
  const shaped = shapeProviderExecutionRequest(payload, {
    provider: "deepseek",
    policy: policy(3),
  });
  assert.equal(shaped.thinking.type, "enabled");
  assert.equal(shaped.reasoning_effort, "high");
  for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty", "tool_choice"]) {
    assert.equal(key in shaped, false, `${key} leaked into thinking request`);
  }
  assert.deepEqual(shaped.tools, payload.tools);
  assert.equal(payload.tool_choice, "required", "source payload was mutated");
});

test("DeepSeek can be explicitly routed without thinking for a simple turn", () => {
  const options = deepSeekExecutionOptions({
    policy: policy(0),
    thinkingEnabled: false,
  });
  assert.deepEqual(options.request, { thinking: { type: "disabled" } });
  assert.deepEqual(options.omit, []);
});

test("stable OpenRouter session ids are deterministic, opaque, bounded, and session-specific", () => {
  const oneA = stableProviderSessionId("chat-123");
  const oneB = stableProviderSessionId("chat-123");
  const two = stableProviderSessionId("chat-124");
  assert.equal(oneA, oneB);
  assert.notEqual(oneA, two);
  assert.match(oneA, /^dominion-[a-f0-9]{32}$/);
  assert(!oneA.includes("chat-123"));
  assert(oneA.length <= 256);
  assert.equal(stableProviderSessionId(""), "");
});

test("OpenRouter emits no reasoning controls without a positive declaration", () => {
  const options = openRouterExecutionOptions({
    policy: policy(5, { taskKind: "long-run" }),
    capabilities: {},
    sessionKey: "chat-1",
  });
  assert.equal("reasoning" in options.request, false);
  assert.equal(options.request.provider.require_parameters, true);
  // Fallbacks stated out loud so one rate-limited host cannot make a live model look dead.
  assert.equal(options.request.provider.allow_fallbacks, true);
  // A caller may deliberately widen the pool (the 429 recovery path) and must win.
  const widened = openRouterExecutionOptions({
    policy: policy(0), sessionKey: "chat-widen",
    providerPreferences: { require_parameters: false, allow_fallbacks: true },
  });
  assert.equal(widened.request.provider.require_parameters, false);
  assert(options.request.session_id);
  assert.match(options.notes.join(" "), /declares no reasoning capability/i);
});

test("OpenRouter selects the nearest model-declared effort and never invents an unsupported one", () => {
  const options = openRouterExecutionOptions({
    policy: policy(5, { taskKind: "long-run" }),
    capabilities: {
      reasoning: {
        supported_efforts: ["high", "medium", "low", "minimal"],
        default_effort: "medium",
      },
    },
    sessionKey: "chat-2",
    providerPreferences: { sort: "throughput" },
  });
  assert.deepEqual(options.request.reasoning, { effort: "high" });
  assert.deepEqual(options.request.provider, {
    allow_fallbacks: true,
    sort: "throughput",
    require_parameters: true,
  });
});

test("OpenRouter accepts any effort only when supported_efforts is explicitly null", () => {
  const options = openRouterExecutionOptions({
    policy: policy(4, { forgeTier: "furnace" }),
    capabilities: { reasoning: { supported_efforts: null } },
    sessionKey: "chat-3",
  });
  assert.deepEqual(options.request.reasoning, { effort: "xhigh" });
});

test("OpenRouter uses max_tokens only when that exact capability is declared", () => {
  const supported = openRouterExecutionOptions({
    policy: policy(3),
    capabilities: { reasoning: { supports_max_tokens: true, supported_efforts: ["high"] } },
    reasoningMaxTokens: 8192,
    sessionKey: "chat-4",
  });
  assert.deepEqual(supported.request.reasoning, { max_tokens: 8192 });

  const notSupported = openRouterExecutionOptions({
    policy: policy(3),
    capabilities: { reasoning: { supported_efforts: ["high"] } },
    reasoningMaxTokens: 8192,
    sessionKey: "chat-4",
  });
  assert.deepEqual(notSupported.request.reasoning, { effort: "high" });
});

test("a boolean reasoning declaration enables provider defaults but does not guess effort", () => {
  const options = openRouterExecutionOptions({
    policy: policy(3),
    capabilities: { reasoning: true },
    sessionKey: "chat-5",
  });
  assert.deepEqual(options.request.reasoning, { enabled: true });
  assert.equal(options.desiredEffort, "");
});

test("mandatory OpenRouter reasoning is honored even on an otherwise simple turn", () => {
  const options = openRouterExecutionOptions({
    policy: policy(0),
    capabilities: {
      reasoning: {
        mandatory: true,
        supported_efforts: ["max"],
      },
    },
    sessionKey: "chat-mandatory",
  });
  assert.deepEqual(options.request.reasoning, { effort: "max" });
});

test("OpenRouter shaping deletes stale guessed controls before applying declared ones", () => {
  const original = {
    model: "some/model",
    reasoning_effort: "max",
    reasoning: { effort: "max" },
    include_reasoning: true,
    provider: { order: ["preferred"] },
  };
  const options = openRouterExecutionOptions({
    policy: policy(3),
    capabilities: {},
    sessionKey: "chat-6",
  });
  const shaped = applyProviderExecutionOptions(original, options);
  assert.equal("reasoning_effort" in shaped, false);
  assert.equal("reasoning" in shaped, false);
  assert.equal("include_reasoning" in shaped, false);
  assert.deepEqual(shaped.provider, {
    allow_fallbacks: true,
    order: ["preferred"],
    require_parameters: true,
  });
  assert.deepEqual(original.reasoning, { effort: "max" }, "source payload was mutated");
});

test("explicit OpenRouter session ids are preserved and overlong ids are safely bounded", () => {
  const direct = openRouterExecutionOptions({
    policy: policy(0),
    sessionId: "already-stable",
  });
  assert.equal(direct.request.session_id, "already-stable");

  const long = openRouterExecutionOptions({
    policy: policy(0),
    sessionId: "x".repeat(300),
  });
  assert.match(long.request.session_id, /^dominion-[a-f0-9]{64}$/);
  assert(long.request.session_id.length <= 256);
});

test("stream accumulation preserves DeepSeek reasoning, OpenRouter details, and tool fragments", () => {
  let assistant = mergeAssistantDelta(undefined, {
    reasoning_content: "inspect ",
    reasoning: "private ",
    reasoning_details: [{ type: "reasoning.text", text: "inspect ", index: 0 }],
    tool_calls: [{
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "forge_read", arguments: "{\"pa" },
    }],
  });
  assistant = mergeAssistantDelta(assistant, {
    reasoning_content: "file",
    reasoning: "trace",
    reasoning_details: [{ type: "reasoning.text", text: "file", index: 0 }],
    tool_calls: [{
      index: 0,
      function: { arguments: "th\":\"README.md\"}" },
    }],
  });
  assert.equal(assistant.reasoning_content, "inspect file");
  assert.equal(assistant.reasoning, "private trace");
  assert.equal(assistant.reasoning_details.length, 2);
  assert.equal(assistant.tool_calls[0].id, "call_1");
  assert.equal(assistant.tool_calls[0].function.name, "forge_read");
  assert.equal(assistant.tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
});

test("large-stream accumulator updates in place without cloning prior output", () => {
  const assistant = { role: "assistant", content: "" };
  const same = accumulateAssistantDeltaInPlace(assistant, {
    content: "first",
    reasoning_content: "think ",
    reasoning_details: [{ type: "reasoning.text", text: "think ", index: 0 }],
    tool_calls: [{
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "forge_", arguments: "{\"pa" },
    }],
  });
  assert.equal(same, assistant, "the streaming helper replaced its accumulator");
  accumulateAssistantDeltaInPlace(assistant, {
    content: " second",
    reasoning_content: "again",
    reasoning_details: [{ type: "reasoning.text", text: "again", index: 0 }],
    tool_calls: [{
      index: 0,
      function: { name: "read", arguments: "th\":\"README.md\"}" },
    }],
  });
  assert.equal(assistant.content, "first second");
  assert.equal(assistant.reasoning_content, "think again");
  assert.equal(assistant.reasoning_details.length, 2);
  assert.equal(assistant.tool_calls[0].function.name, "forge_read");
  assert.equal(assistant.tool_calls[0].function.arguments, "{\"path\":\"README.md\"}");
});

test("assistant tool projection replays reasoning fields without mutation or loss", () => {
  const assistant = {
    role: "assistant",
    content: "",
    reasoning_content: "DeepSeek trace",
    reasoning: "OpenRouter trace",
    reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }],
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "forge_read", arguments: "{}" },
    }],
    finish_reason: "tool_calls",
  };
  const projected = projectAssistantToolTurn(assistant);
  assert.deepEqual(projected, {
    role: "assistant",
    content: "",
    reasoning_content: "DeepSeek trace",
    reasoning: "OpenRouter trace",
    reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }],
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "forge_read", arguments: "{}" },
    }],
  });
  projected.reasoning_details[0].data = "changed";
  assert.equal(assistant.reasoning_details[0].data, "opaque");
});

test("provider message and tool-round helpers retain reasoning on replay", () => {
  const messages = [
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "need file",
      reasoning_details: [{ type: "reasoning.summary", summary: "need file" }],
      tool_calls: [{ id: "call_1", type: "function", function: { name: "forge_read", arguments: "{}" } }],
      unrelated: "drop from assistant tool turn",
    },
    { role: "tool", tool_call_id: "call_1", content: "contents" },
  ];
  const projected = projectProviderMessages(messages);
  assert.equal(projected[1].reasoning_content, "need file");
  assert.deepEqual(projected[1].reasoning_details, messages[1].reasoning_details);
  assert.equal("unrelated" in projected[1], false);
  const round = projectToolRound(messages[1], messages[2]);
  assert.equal(round[0].reasoning_content, "need file");
  assert.equal(round[1].tool_call_id, "call_1");
});

test("finish reasons distinguish task completion, continuation, tools, blocks, and retryable capacity", () => {
  assert.deepEqual(
    normalizeProviderTerminal("stop"),
    {
      raw: "stop",
      reason: "stop",
      state: "stopped",
      providerCallComplete: true,
      taskComplete: false,
      candidateFinal: true,
      shouldContinue: false,
      shouldRetry: false,
      recoverable: false,
      blocked: false,
      needsToolExecution: false,
    },
  );

  const length = normalizeProviderTerminal({ finish_reason: "length" });
  assert.equal(length.state, "checkpoint");
  assert.equal(length.taskComplete, false);
  assert.equal(length.candidateFinal, false);
  assert.equal(length.shouldContinue, true);

  const tools = normalizeProviderTerminal({ finish_reason: "stop", toolCalls: [{}] });
  assert.equal(tools.reason, "tool_calls");
  assert.equal(tools.needsToolExecution, true);
  assert.equal(tools.shouldContinue, true);

  const filtered = normalizeProviderTerminal("content_filter");
  assert.equal(filtered.state, "blocked");
  assert.equal(filtered.blocked, true);
  assert.equal(filtered.taskComplete, false);

  const capacity = normalizeProviderTerminal("insufficient_system_resource");
  assert.equal(capacity.state, "error");
  assert.equal(capacity.shouldRetry, true);
  assert.equal(capacity.recoverable, true);
});

test("error and unknown terminal states never masquerade as task completion", () => {
  const retryable = normalizeProviderTerminal({
    finishReason: "error",
    error: { type: "server_error" },
  });
  assert.equal(retryable.taskComplete, false);
  assert.equal(retryable.shouldRetry, true);

  const fatal = normalizeProviderTerminal({
    finishReason: "error",
    error: { type: "invalid_request_error" },
  });
  assert.equal(fatal.shouldRetry, false);

  const unknown = normalizeProviderTerminal("provider_new_reason");
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.taskComplete, false);
});

test("top-level HTTP-200 SSE errors are detected and classified without transport guesses", () => {
  assert.equal(extractProviderStreamError({ choices: [] }), null);

  const overloaded = extractProviderStreamError({
    error: {
      code: "insufficient_system_resource",
      message: "The model has insufficient system resources.",
    },
  });
  assert.equal(overloaded.code, "insufficient_system_resource");
  assert.equal(overloaded.status, 0);
  assert.equal(overloaded.retryable, true);

  const filtered = extractProviderStreamError({
    error: {
      code: 400,
      type: "content_filter",
      message: "Response blocked by content filter",
    },
  });
  assert.equal(filtered.status, 400);
  assert.equal(filtered.retryable, false);
});
