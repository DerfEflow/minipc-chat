/*
 * Native Anthropic Messages API adapter.
 *
 * Dominion's agent loop uses the OpenAI Chat Completions message/tool dialect
 * internally. This module is the provider boundary for direct Anthropic calls:
 * it translates that dialect to Messages, streams native SSE events, and
 * returns both Dominion's normalized fields and the complete Anthropic
 * assistant content blocks needed for a lossless tool-use continuation.
 *
 * The transport is dependency injected (fetch, sleep, endpoint, signal), so no
 * server state or provider credentials live in this module.
 */

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const DEFAULT_MAX_TOKENS = 8_192;

function stringValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child);
  return out;
}

function textAttachmentBlock(attachment) {
  const text = attachment && (
    attachment.text
    ?? attachment.content
    ?? attachment.extractedText
    ?? attachment.extracted
  );
  if (typeof text !== "string" || !text) return "";
  const name = String(attachment.name || attachment.filename || "attachment");
  return `\n\n[Attached file: ${name}]\n\`\`\`\`\n${text}\n\`\`\`\``;
}

function imageUrl(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url;
  if (typeof part.url === "string") return part.url;
  return "";
}

function anthropicImageBlock(url) {
  const value = String(url || "");
  const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,([\s\S]+)$/i.exec(value);
  if (data) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: data[1].toLowerCase(),
        data: data[2],
      },
    };
  }
  if (/^https?:\/\//i.test(value)) {
    return { type: "image", source: { type: "url", url: value } };
  }
  return null;
}

function chatContentToAnthropicBlocks(message, { vision = true } = {}) {
  const blocks = [];
  const source = message && message.content;

  if (Array.isArray(source)) {
    for (const part of source) {
      if (typeof part === "string") {
        if (part) blocks.push({ type: "text", text: part });
        continue;
      }
      if (!part || typeof part !== "object") continue;

      if (["text", "input_text", "output_text", "summary_text"].includes(part.type)) {
        const text = stringValue(part.text);
        if (text) {
          const block = { type: "text", text };
          // Citations and cache-control are valid native text-block fields.
          if (part.citations != null) block.citations = cloneValue(part.citations);
          if (part.cache_control != null) block.cache_control = cloneValue(part.cache_control);
          blocks.push(block);
        }
        continue;
      }

      if (part.type === "image_url" || part.type === "input_image") {
        const url = imageUrl(part);
        const image = vision ? anthropicImageBlock(url) : null;
        if (image) blocks.push(image);
        else if (url) blocks.push({ type: "text", text: "[Image attached; this model cannot inspect it.]" });
        continue;
      }

      // Native Anthropic content blocks (images, documents, search results,
      // tool results, etc.) pass through without lossy normalization.
      if (part.type) blocks.push(cloneValue(part));
    }
  } else {
    const text = stringValue(source);
    if (text) blocks.push({ type: "text", text });
  }

  for (const attachment of Array.isArray(message && message.attachments) ? message.attachments : []) {
    if (!attachment || typeof attachment !== "object") continue;
    const kind = String(attachment.kind || attachment.type || "").toLowerCase();
    const url = attachment.dataUrl || attachment.data_url || attachment.url || "";
    if ((kind === "image" || String(url).startsWith("data:image/")) && url) {
      const image = vision ? anthropicImageBlock(url) : null;
      if (image) blocks.push(image);
      else blocks.push({ type: "text", text: `[Image attached: ${attachment.name || attachment.filename || "image"}; this model cannot inspect it.]` });
      continue;
    }
    const text = textAttachmentBlock(attachment);
    if (text) blocks.push({ type: "text", text });
    else if (attachment.name || attachment.filename) {
      blocks.push({ type: "text", text: `[Attachment: ${attachment.name || attachment.filename}]` });
    }
  }

  return blocks;
}

function parsedArguments(value) {
  if (value && typeof value === "object") return cloneValue(value);
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedToolUse(call, fallbackId) {
  if (!call || typeof call !== "object") return null;
  const fn = call.function && typeof call.function === "object" ? call.function : call;
  const name = String(fn.name || call.name || "");
  if (!name) return null;
  return {
    type: "tool_use",
    id: String(call.id || call.call_id || fallbackId),
    name,
    input: parsedArguments(fn.arguments ?? call.arguments ?? fn.input ?? call.input),
  };
}

function opaqueAssistantContent(message) {
  const candidates = [
    message && message.anthropicContent,
    message && message.providerContent,
    message && message.contentBlocks,
    message && message.providerMessage && message.providerMessage.content,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(cloneValue);
  }

  const content = message && message.content;
  if (!Array.isArray(content)) return null;
  // A previous native turn may contain signed thinking, redacted thinking,
  // server-tool, citation, or other provider blocks. Once one appears, the
  // entire ordered array is opaque and must round-trip unchanged.
  if (content.some((block) => block && typeof block === "object" && ![
    "text", "input_text", "output_text", "summary_text", "image_url", "input_image",
  ].includes(block.type))) {
    return content.map(cloneValue);
  }
  return null;
}

function assistantBlocks(message, opts, messageIndex) {
  const blocks = opaqueAssistantContent(message)
    || chatContentToAnthropicBlocks(message, opts);
  const ids = new Set(blocks
    .filter((block) => block && block.type === "tool_use" && block.id)
    .map((block) => String(block.id)));

  for (const [callIndex, call] of (Array.isArray(message && message.tool_calls) ? message.tool_calls : []).entries()) {
    const block = normalizedToolUse(call, `toolu_${messageIndex}_${callIndex}`);
    if (block && !ids.has(block.id)) {
      blocks.push(block);
      ids.add(block.id);
    }
  }
  return blocks;
}

function toolResultContent(message) {
  const source = message && message.content;
  if (!Array.isArray(source)) return stringValue(source);
  const blocks = chatContentToAnthropicBlocks({ content: source }, { vision: true });
  return blocks.length ? blocks : "";
}

/**
 * Convert Dominion/Chat messages to Anthropic's top-level system prompt and
 * alternating user/assistant Messages. Tool results are native `tool_result`
 * blocks, while signed provider content from earlier assistant turns remains
 * byte-for-byte equivalent at the JSON value level.
 */
export function chatMessagesToAnthropic(messages, opts = {}) {
  const systemParts = [];
  const out = [];
  let activeToolResults = null;

  for (const [messageIndex, message] of (Array.isArray(messages) ? messages : []).entries()) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user");

    if (role === "system" || role === "developer") {
      const blocks = chatContentToAnthropicBlocks(message, { vision: false });
      const text = blocks
        .filter((block) => block && block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text) systemParts.push(role === "developer" ? `[Developer instruction]\n${text}` : text);
      activeToolResults = null;
      continue;
    }

    if (role === "tool") {
      const id = message.tool_call_id || message.tool_use_id || message.call_id;
      if (!id) {
        out.push({ role: "user", content: [{ type: "text", text: `[Unassociated tool result]\n${stringValue(message.content)}` }] });
        activeToolResults = null;
        continue;
      }
      const block = {
        type: "tool_result",
        tool_use_id: String(id),
        content: toolResultContent(message),
      };
      if (message.is_error === true || message.error === true) block.is_error = true;
      if (activeToolResults) activeToolResults.content.push(block);
      else {
        activeToolResults = { role: "user", content: [block] };
        out.push(activeToolResults);
      }
      continue;
    }

    activeToolResults = null;
    if (role === "assistant") {
      const blocks = assistantBlocks(message, opts, messageIndex);
      out.push({ role: "assistant", content: blocks.length ? blocks : "" });
      continue;
    }

    const blocks = chatContentToAnthropicBlocks(message, opts);
    out.push({ role: "user", content: blocks.length ? blocks : "" });
  }

  return {
    system: systemParts.join("\n\n"),
    messages: out,
  };
}

/**
 * Convert OpenAI function declarations to native Anthropic client tools.
 * Already-native Anthropic/server tool declarations pass through unchanged.
 */
export function chatToolsToAnthropicTools(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const fn = tool.function;
      if (!fn.name) continue;
      const mapped = {
        name: String(fn.name),
        input_schema: cloneValue(fn.parameters || { type: "object", properties: {} }),
      };
      if (fn.description != null) mapped.description = String(fn.description);
      if (typeof fn.strict === "boolean") mapped.strict = fn.strict;
      if (fn.cache_control != null) mapped.cache_control = cloneValue(fn.cache_control);
      if (fn.input_examples != null) mapped.input_examples = cloneValue(fn.input_examples);
      out.push(mapped);
      continue;
    }
    if (tool.name && (tool.input_schema || !tool.type || tool.type !== "function")) {
      out.push(cloneValue(tool));
      continue;
    }
    if (tool.type === "function" && tool.name) {
      const mapped = {
        name: String(tool.name),
        input_schema: cloneValue(tool.parameters || tool.input_schema || { type: "object", properties: {} }),
      };
      if (tool.description != null) mapped.description = String(tool.description);
      if (typeof tool.strict === "boolean") mapped.strict = tool.strict;
      out.push(mapped);
    }
  }
  return out;
}

function normalizedToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "required") return { type: "any" };
    if (["auto", "any", "none"].includes(choice)) return { type: choice };
    return { type: "tool", name: choice };
  }
  if (choice.type === "function" && choice.function && choice.function.name) {
    return { type: "tool", name: String(choice.function.name) };
  }
  if (choice.type === "function" && choice.name) {
    return { type: "tool", name: String(choice.name) };
  }
  if (choice.type === "required") return { type: "any" };
  if (["auto", "any", "none"].includes(choice.type)) {
    return {
      type: choice.type,
      ...(typeof choice.disable_parallel_tool_use === "boolean"
        ? { disable_parallel_tool_use: choice.disable_parallel_tool_use }
        : {}),
    };
  }
  if (choice.type === "tool" && choice.name) {
    return {
      type: "tool",
      name: String(choice.name),
      ...(typeof choice.disable_parallel_tool_use === "boolean"
        ? { disable_parallel_tool_use: choice.disable_parallel_tool_use }
        : {}),
    };
  }
  return cloneValue(choice);
}

/*
 * WHICH THINKING SURFACE A MODEL SPEAKS.
 *
 * "adaptive" is the modern surface: `thinking:{type:"adaptive"}` + output_config.effort, and NO
 * sampling parameters at all. Claude Opus 5 joined this list on 2026-08-08 when the learning loop
 * started calling it (feedback.mjs). Leaving it out was not a missing feature, it was a live 400:
 * an unrecognised id falls to "other", "other" never sets payload.thinking, and the temperature
 * branch below only fires when payload.thinking is absent. So the first caller that passed a
 * temperature would have had it forwarded to a model that rejects temperature, top_p and top_k
 * outright. The entry is the fix; the ordering inside the group matters too, since "opus-4-8" must
 * still match itself rather than being shadowed by the shorter "opus-5" alternative.
 */
function modelFamily(model) {
  const id = String(model || "").toLowerCase();
  if (/claude-(?:opus-5|opus-4-8|sonnet-5)(?:-|$)/.test(id)) return "adaptive";
  if (/claude-haiku-4-5(?:-|$)/.test(id)) return "manual";
  return "other";
}

function effortValue(opts) {
  const raw = opts.effort
    ?? opts.reasoningEffort
    ?? opts.reasoning_effort
    ?? (opts.outputConfig && opts.outputConfig.effort)
    ?? (opts.output_config && opts.output_config.effort)
    ?? "high";
  const value = String(raw).toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "none" || value === "minimal" || value === "light") return "low";
  if (value === "standard" || value === "balanced") return "medium";
  if (value === "deep") return "high";
  if (value === "very-deep" || value === "very-high") return "xhigh";
  if (value === "maximum") return "max";
  return ["low", "medium", "high", "xhigh", "max"].includes(value) ? value : "high";
}

function manualBudget(effort, maxTokens, requested) {
  const byEffort = { low: 1_024, medium: 2_048, high: 4_096, xhigh: 8_192, max: 16_384 };
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : byEffort[effort];
  return Math.max(1_024, Math.min(wanted, maxTokens - 1));
}

/**
 * Build a native Messages request. Opus 4.8 and Sonnet 5 use adaptive
 * thinking plus output_config.effort. Haiku 4.5 uses the only thinking mode it
 * supports: manual `budget_tokens`.
 */
export function buildAnthropicMessagesPayload(model, messages, opts = {}) {
  const converted = chatMessagesToAnthropic(messages, { vision: opts.vision !== false });
  const family = modelFamily(model);
  const requestedMax = opts.maxTokens ?? opts.max_tokens ?? opts.num_predict;
  let maxTokens = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.floor(requestedMax)
    : DEFAULT_MAX_TOKENS;
  // Manual thinking has a provider-enforced 1,024-token minimum and its budget
  // must be strictly below max_tokens.
  if (family === "manual" && opts.thinking !== false) maxTokens = Math.max(2_048, maxTokens);

  const payload = {
    model,
    max_tokens: maxTokens,
    messages: converted.messages,
    stream: true,
  };
  /*
   * THE CACHE BREAKPOINT (2026-08-03). Anthropic is the only provider in the catalog whose caching
   * is not automatic: cacheprobe.mjs measured Claude Haiku reading 6,304 of 6,317 prefix tokens
   * back WITH an explicit cache_control marker, and two byte-identical turns both billing full
   * freight WITHOUT one. Until this line, the only cache_control in the entire codebase was in
   * video-http.mjs, so every Anthropic chat turn paid full price for a prefix it had already sent.
   *
   * One breakpoint is enough and it belongs here, at the end of the system prompt. Anthropic
   * matches the prefix in a fixed order — tools, then system, then messages — so a marker at the
   * end of system covers the tool definitions as well, and the tool array is the larger half (up
   * to 128 schemas). Marking system therefore caches both with a single breakpoint of the four
   * allowed. Below the model's minimum (2,048 tokens on Haiku, 1,024 elsewhere) the marker is
   * ignored rather than rejected, so a short turn costs nothing extra for carrying it.
   *
   * The array form is required: `system` as a bare string has nowhere to hang cache_control.
   */
  if (converted.system) {
    payload.system = [{ type: "text", text: converted.system, cache_control: { type: "ephemeral" } }];
  }

  const effort = effortValue(opts);
  if (opts.thinking !== false && family === "adaptive") {
    payload.thinking = { type: "adaptive" };
    const display = opts.thinkingDisplay ?? (opts.thinking && opts.thinking.display);
    if (display) payload.thinking.display = String(display);
    payload.output_config = {
      ...(opts.output_config || opts.outputConfig || {}),
      effort,
    };
  } else if (opts.thinking !== false && family === "manual") {
    payload.thinking = {
      type: "enabled",
      budget_tokens: manualBudget(
        effort,
        maxTokens,
        opts.thinkingBudget ?? opts.thinking_budget ?? (opts.thinking && opts.thinking.budget_tokens),
      ),
    };
  } else if (opts.output_config || opts.outputConfig) {
    payload.output_config = cloneValue(opts.output_config || opts.outputConfig);
  }

  const tools = chatToolsToAnthropicTools(opts.tools);
  if (tools.length) payload.tools = tools;
  let toolChoice = normalizedToolChoice(opts.toolChoice ?? opts.tool_choice);
  // Manual extended thinking cannot be combined with forced tool selection.
  // Keep both thinking and tool access by degrading `any`/specific to `auto`.
  if (family === "manual" && payload.thinking && ["any", "tool"].includes(toolChoice && toolChoice.type)) {
    toolChoice = { type: "auto" };
  }
  const parallelToolCalls = opts.parallelToolCalls ?? opts.parallel_tool_calls;
  if (tools.length && parallelToolCalls === false) {
    if (!toolChoice) toolChoice = { type: "auto" };
    toolChoice.disable_parallel_tool_use = true;
  }
  if (tools.length && toolChoice) payload.tool_choice = toolChoice;

  // lane/chat required behavior #2, live-measured 2026-09-03 against the real Messages API
  // (production error: `temperature` is deprecated for this model, claude-opus-4-8). Two SEPARATE
  // rejection rules, both confirmed by probe, both must hold:
  //   (a) Anthropic's documented extended-thinking rule: temperature is incompatible with an
  //       ACTIVE thinking block on any family (payload.thinking truthy) — this is the original
  //       `!payload.thinking` guard and it is still correct for manual thinking (Haiku 4.5): with
  //       a thinking block, temperature is rejected; probed again here WITHOUT one, Haiku accepts
  //       it fine, so the manual family's restriction is thinking-conditional, not unconditional.
  //   (b) claude-opus-4-8 and claude-sonnet-5 (the "adaptive" family) reject temperature
  //       UNCONDITIONALLY — probed both WITH and WITHOUT a thinking block on the wire, both 400
  //       "temperature is deprecated for this model". The previous guard here only ever agreed
  //       with (b) by coincidence, because no caller in this codebase currently passes
  //       opts.thinking:false for an adaptive model, so payload.thinking was always truthy for
  //       them anyway. A future caller that disables thinking for a cheap/fast round (the same
  //       pattern the chat pipeline already uses for tool-less conclusion rounds) would have
  //       leaked temperature straight into this exact 400. The explicit `family !== "adaptive"`
  //       clause closes that gap for every current and future caller regardless of the thinking
  //       flag, data-driven from the probe above rather than from thinking-truthiness as a proxy.
  if (!payload.thinking && family !== "adaptive" && typeof opts.temperature === "number") {
    payload.temperature = Math.max(0, Math.min(1, opts.temperature));
  }
  if (typeof opts.topP === "number" || typeof opts.top_p === "number") payload.top_p = opts.topP ?? opts.top_p;
  if (typeof opts.topK === "number" || typeof opts.top_k === "number") payload.top_k = opts.topK ?? opts.top_k;
  if (Array.isArray(opts.stopSequences || opts.stop_sequences)) {
    payload.stop_sequences = cloneValue(opts.stopSequences || opts.stop_sequences);
  }
  if (opts.metadata && typeof opts.metadata === "object") payload.metadata = cloneValue(opts.metadata);
  if (opts.serviceTier || opts.service_tier) payload.service_tier = opts.serviceTier || opts.service_tier;
  if (opts.container) payload.container = cloneValue(opts.container);
  if (opts.contextManagement || opts.context_management) {
    payload.context_management = cloneValue(opts.contextManagement || opts.context_management);
  }
  return payload;
}

/** Convert a legacy Anthropic OpenAI-compatibility URL to native Messages. */
export function anthropicEndpoint(value = DEFAULT_ENDPOINT) {
  const url = new URL(value || DEFAULT_ENDPOINT);
  url.pathname = url.pathname
    .replace(/\/chat\/completions\/?$/, "/messages")
    .replace(/\/messages\/?$/, "/messages");
  return url.toString();
}

function emptyResult(overrides = {}) {
  return {
    ok: false,
    content: "",
    reasoning: "",
    usage: null,
    finishReason: "",
    stopReason: "",
    stopSequence: null,
    stopDetails: null,
    toolCalls: [],
    contentBlocks: [],
    assistantContent: [],
    providerMessage: null,
    error: "",
    ...overrides,
  };
}

function mapFinishReason(reason) {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "model_context_window_exceeded": return "context";
    case "pause_turn": return "pause_turn";
    case "refusal": return "refusal";
    case "stop_sequence": return "stop_sequence";
    default: return reason || "";
  }
}

function mergeObjects(base, next) {
  const out = cloneValue(base || {});
  for (const [key, value] of Object.entries(next || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeObjects(out[key], value);
    } else {
      out[key] = cloneValue(value);
    }
  }
  return out;
}

/*
 * Anthropic reports the three halves of input separately and its `input_tokens` EXCLUDES both
 * cached reads and cache writes. Every cost path downstream is written against the OpenAI shape,
 * where `prompt_tokens` is the whole input and `prompt_tokens_details.cached_tokens` is the
 * discounted slice of it. Left untranslated, a cached Anthropic turn reports a fraction of the
 * tokens it actually sent, so the cache read bills NOTHING and Dominion eats it. That is the
 * mirror image of the OpenAI overcharge and it appears the moment caching starts working, which
 * is why it is fixed in the same change as the breakpoint above.
 *
 * The native fields are preserved untouched: videoSonnetCost reads input_tokens,
 * cache_read_input_tokens and the cache_creation breakdown directly and must keep seeing them.
 */
function normalizedUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = cloneValue(usage);
  const num = (v) => Math.max(0, Number(v) || 0);
  if (typeof out.input_tokens === "number") {
    const read = num(out.cache_read_input_tokens);
    const written = num(out.cache_creation_input_tokens);
    out.prompt_tokens = num(out.input_tokens) + read + written;
    if (read) {
      out.prompt_tokens_details = { ...(out.prompt_tokens_details || {}), cached_tokens: read };
    }
  }
  if (typeof out.output_tokens === "number") out.completion_tokens = num(out.output_tokens);
  if (typeof out.prompt_tokens === "number" && typeof out.output_tokens === "number") {
    out.total_tokens = out.prompt_tokens + num(out.output_tokens);
  }
  return out;
}

function createStreamState(onDelta, onReasoningDelta) {
  const blocks = new Map();
  let message = {};
  let usage = {};
  let stopReason = "";
  let stopSequence = null;
  let stopDetails = null;
  let terminal = false;
  let eventError = null;
  let providerOutput = false;

  function ensure(index) {
    if (!blocks.has(index)) {
      blocks.set(index, { block: { type: "text", text: "" }, inputJson: "" });
    }
    return blocks.get(index);
  }

  function markInitialOutput(block) {
    if (!block || typeof block !== "object") return;
    if (block.type === "tool_use" && (block.id || block.name)) providerOutput = true;
    else if (block.type === "redacted_thinking" && block.data) providerOutput = true;
    else if (block.type === "text" && block.text) providerOutput = true;
    else if (block.type === "thinking" && block.thinking) providerOutput = true;
  }

  function appendText(acc, key, delta, callback) {
    const value = String(delta || "");
    if (!value) return;
    acc.block[key] = String(acc.block[key] || "") + value;
    providerOutput = true;
    try { if (callback) callback(value); } catch {}
  }

  function applyUnknownDelta(acc, delta) {
    for (const [key, value] of Object.entries(delta || {})) {
      if (key === "type") continue;
      if (typeof value === "string") acc.block[key] = String(acc.block[key] || "") + value;
      else if (Array.isArray(value)) acc.block[key] = [...(Array.isArray(acc.block[key]) ? acc.block[key] : []), ...cloneValue(value)];
      else if (value && typeof value === "object") acc.block[key] = mergeObjects(acc.block[key], value);
      else acc.block[key] = value;
    }
    if (Object.keys(delta || {}).some((key) => key !== "type")) providerOutput = true;
  }

  function finalize(index) {
    const acc = ensure(index);
    if (acc.block.type === "tool_use" && acc.inputJson) {
      try { acc.block.input = JSON.parse(acc.inputJson); }
      catch { acc.invalidInputJson = true; }
    }
  }

  function orderedBlocks() {
    for (const index of blocks.keys()) finalize(index);
    return [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => cloneValue(acc.block));
  }

  return {
    event(event) {
      if (!event || typeof event !== "object") return;
      const type = String(event.type || "");
      if (type === "message_start") {
        message = mergeObjects(message, event.message || {});
        usage = mergeObjects(usage, event.message && event.message.usage);
        for (const [index, block] of (Array.isArray(event.message && event.message.content)
          ? event.message.content : []).entries()) {
          blocks.set(index, { block: cloneValue(block), inputJson: "" });
          markInitialOutput(block);
        }
      } else if (type === "content_block_start") {
        const index = Number.isInteger(event.index) ? event.index : blocks.size;
        const block = cloneValue(event.content_block || { type: "text", text: "" });
        blocks.set(index, { block, inputJson: "" });
        markInitialOutput(block);
      } else if (type === "content_block_delta") {
        const index = Number.isInteger(event.index) ? event.index : blocks.size;
        const acc = ensure(index);
        const delta = event.delta || {};
        if (delta.type === "text_delta") appendText(acc, "text", delta.text, onDelta);
        else if (delta.type === "thinking_delta") appendText(acc, "thinking", delta.thinking, onReasoningDelta);
        else if (delta.type === "signature_delta") appendText(acc, "signature", delta.signature);
        else if (delta.type === "input_json_delta") {
          const value = String(delta.partial_json || "");
          acc.inputJson += value;
          if (value) providerOutput = true;
        } else if (delta.type === "citations_delta" && delta.citation) {
          if (!Array.isArray(acc.block.citations)) acc.block.citations = [];
          acc.block.citations.push(cloneValue(delta.citation));
          providerOutput = true;
        } else {
          applyUnknownDelta(acc, delta);
        }
      } else if (type === "content_block_stop") {
        finalize(Number.isInteger(event.index) ? event.index : blocks.size - 1);
      } else if (type === "message_delta") {
        const delta = event.delta || {};
        if (delta.stop_reason != null) stopReason = String(delta.stop_reason);
        if (Object.prototype.hasOwnProperty.call(delta, "stop_sequence")) stopSequence = delta.stop_sequence;
        if (Object.prototype.hasOwnProperty.call(delta, "stop_details")) stopDetails = cloneValue(delta.stop_details);
        usage = mergeObjects(usage, event.usage);
      } else if (type === "message_stop") {
        terminal = true;
      } else if (type === "error") {
        eventError = cloneValue(event.error || { type: "api_error", message: "Anthropic stream error" });
      }
      // ping and future event types are intentionally ignored.
    },
    result() {
      const contentBlocks = orderedBlocks();
      const content = contentBlocks
        .filter((block) => block && block.type === "text")
        .map((block) => String(block.text || ""))
        .join("");
      const reasoning = contentBlocks
        .filter((block) => block && block.type === "thinking")
        .map((block) => String(block.thinking || ""))
        .join("");
      const toolCalls = contentBlocks
        .filter((block) => block && block.type === "tool_use" && block.name)
        .map((block, index) => ({
          id: String(block.id || `toolu_${index}`),
          type: "function",
          function: {
            name: String(block.name),
            arguments: stringValue(block.input || {}),
          },
        }));
      const nativeReason = stopReason || String(message.stop_reason || "");
      const providerMessage = { role: "assistant", content: contentBlocks };
      return emptyResult({
        ok: terminal && !eventError,
        content,
        reasoning,
        usage: normalizedUsage(usage),
        finishReason: mapFinishReason(nativeReason),
        stopReason: nativeReason,
        stopSequence,
        stopDetails,
        toolCalls,
        contentBlocks,
        assistantContent: contentBlocks,
        providerMessage,
        messageId: String(message.id || ""),
        responseId: String(message.id || ""),
        model: String(message.model || ""),
        status: terminal ? "completed" : "incomplete",
        partial: providerOutput && (!terminal || !!eventError),
        error: eventError ? String(eventError.message || eventError.type || "Anthropic stream error") : "",
        errorType: eventError ? String(eventError.type || "") : "",
      });
    },
    hasProviderOutput() { return providerOutput; },
    isTerminal() { return terminal; },
    eventError() { return eventError; },
  };
}

function frameEnd(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf < 0 ? null : { at: crlf, length: 4 };
  if (crlf < 0) return { at: lf, length: 2 };
  return lf < crlf ? { at: lf, length: 2 } : { at: crlf, length: 4 };
}

function parseSseFrame(frame) {
  const data = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  try { return JSON.parse(raw); } catch { return null; }
}

async function consumeSse(body, state) {
  if (!body || typeof body.getReader !== "function") throw new Error("Anthropic returned no readable event stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = frameEnd(buffer))) {
        const frame = buffer.slice(0, end.at);
        buffer = buffer.slice(end.at + end.length);
        const event = parseSseFrame(frame);
        if (event) state.event(event);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseFrame(buffer);
      if (event) state.event(event);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function errorMessage(body, fallback) {
  if (body && typeof body === "object") {
    if (body.error && typeof body.error.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
  }
  return fallback;
}

async function readErrorResponse(response) {
  let raw = "";
  try { raw = await response.text(); } catch {}
  if (raw.length > 32_000) raw = raw.slice(0, 32_000);
  try { return errorMessage(JSON.parse(raw), raw || `HTTP ${response.status}`); }
  catch { return raw || `HTTP ${response.status}`; }
}

function transientStatus(status) {
  return [408, 409, 429, 500, 502, 503, 504, 529].includes(Number(status));
}

function transientEventType(type) {
  return ["api_error", "overloaded_error", "rate_limit_error", "timeout_error"].includes(String(type || ""));
}

function retryAfterMs(response, fallback, max) {
  const msRaw = response && response.headers && response.headers.get("retry-after-ms");
  if (msRaw && Number.isFinite(Number(msRaw))) {
    return Math.min(Math.max(0, Number(msRaw)), max);
  }
  const raw = response && response.headers && response.headers.get("retry-after");
  if (!raw) return Math.min(fallback, max);
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), max);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), max);
  return Math.min(fallback, max);
}

function abortableDelay(ms, signal, sleepImpl) {
  if (signal && signal.aborted) {
    return Promise.reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
  }
  if (sleepImpl) return sleepImpl(ms, signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (signal) signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    if (!signal) return;
    function stop() {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

function attemptAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error("Request timed out"), { name: "TimeoutError" }));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

function notifyRetry(opts, info) {
  try { if (typeof opts.onRetry === "function") opts.onRetry(info); } catch {}
}

/**
 * Stream a native Anthropic Messages response.
 *
 * Retries are bounded and always use the same model/request. A retry is only
 * allowed before any provider output has arrived, preventing duplicate text or
 * duplicate tool execution after a partial stream.
 */
export async function anthropicMessagesStream(model, messages, opts = {}, onDelta) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return emptyResult({ error: "Anthropic transport is unavailable." });
  if (!opts.apiKey) return emptyResult({ error: "No Anthropic API key configured." });
  if (opts.signal && opts.signal.aborted) return emptyResult({ aborted: true, error: "stopped" });

  let endpoint;
  try { endpoint = anthropicEndpoint(opts.endpoint || DEFAULT_ENDPOINT); }
  catch { return emptyResult({ error: "Anthropic endpoint is misconfigured." }); }

  const payload = buildAnthropicMessagesPayload(model, messages, opts);
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? DEFAULT_MAX_RETRIES));
  const retryBaseMs = Math.max(0, Number(opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS));
  const maxBackoffMs = Math.max(0, Number(opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS));
  const timeoutMs = Math.max(1, Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let retries = 0;

  while (retries <= maxRetries) {
    if (opts.signal && opts.signal.aborted) return emptyResult({ aborted: true, error: "stopped" });
    const attempt = attemptAbort(opts.signal, timeoutMs);
    const state = createStreamState(onDelta, opts.onReasoningDelta);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": opts.anthropicVersion || DEFAULT_VERSION,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(opts.beta ? { "anthropic-beta": Array.isArray(opts.beta) ? opts.beta.join(",") : String(opts.beta) } : {}),
          ...(opts.extraHeaders || {}),
        },
        body: JSON.stringify(payload),
        signal: attempt.signal,
      });

      if (!response.ok) {
        const error = await readErrorResponse(response);
        if (transientStatus(response.status) && retries < maxRetries) {
          const delayMs = retryAfterMs(response, retryBaseMs * (2 ** retries), maxBackoffMs);
          notifyRetry(opts, { attempt: retries + 1, delayMs, reason: "http", status: response.status });
          retries++;
          attempt.cleanup();
          try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
          catch { return emptyResult({ aborted: true, error: "stopped" }); }
          continue;
        }
        return emptyResult({ status: response.status, error: `Anthropic: ${error}` });
      }

      await consumeSse(response.body, state);
      const result = state.result();
      if (result.ok) return result;

      const streamError = state.eventError();
      if (!state.hasProviderOutput() && streamError && transientEventType(streamError.type) && retries < maxRetries) {
        const delayMs = Math.min(retryBaseMs * (2 ** retries), maxBackoffMs);
        notifyRetry(opts, { attempt: retries + 1, delayMs, reason: "stream", errorType: streamError.type });
        retries++;
        attempt.cleanup();
        try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
        catch { return emptyResult({ aborted: true, error: "stopped" }); }
        continue;
      }
      if (!state.hasProviderOutput() && !state.isTerminal() && !streamError && retries < maxRetries) {
        const delayMs = Math.min(retryBaseMs * (2 ** retries), maxBackoffMs);
        notifyRetry(opts, { attempt: retries + 1, delayMs, reason: "stream_eof" });
        retries++;
        attempt.cleanup();
        try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
        catch { return emptyResult({ aborted: true, error: "stopped" }); }
        continue;
      }
      if (!result.error) result.error = "Anthropic stream ended before message_stop.";
      return result;
    } catch (error) {
      if (opts.signal && opts.signal.aborted) return emptyResult({ aborted: true, error: "stopped" });
      const timedOut = attempt.timedOut();
      const partial = state.hasProviderOutput();
      if (!partial && retries < maxRetries) {
        const delayMs = Math.min(retryBaseMs * (2 ** retries), maxBackoffMs);
        notifyRetry(opts, { attempt: retries + 1, delayMs, reason: timedOut ? "timeout" : "network" });
        retries++;
        attempt.cleanup();
        try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
        catch { return emptyResult({ aborted: true, error: "stopped" }); }
        continue;
      }
      const previous = state.result();
      return emptyResult({
        content: previous.content,
        reasoning: previous.reasoning,
        usage: previous.usage,
        finishReason: partial ? "error" : "",
        stopReason: previous.stopReason,
        toolCalls: previous.toolCalls,
        contentBlocks: previous.contentBlocks,
        assistantContent: previous.assistantContent,
        providerMessage: previous.providerMessage,
        partial,
        error: timedOut
          ? "Anthropic timed out."
          : `Anthropic couldn't be reached: ${String(error && error.message || error)}.`,
      });
    } finally {
      attempt.cleanup();
    }
  }
  return emptyResult({ error: "Anthropic request failed after retries." });
}

export default anthropicMessagesStream;
