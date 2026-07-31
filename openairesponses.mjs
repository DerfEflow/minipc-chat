/*
 * Native OpenAI Responses API adapter.
 *
 * Dominion's agent loop historically speaks the Chat Completions message/tool
 * dialect.  This module is the narrow provider boundary that converts that
 * dialect to Responses input items without changing the rest of the loop.
 *
 * The adapter deliberately has no dependency on server state.  Endpoint, key,
 * fetch implementation, retry timing, and AbortSignal are supplied in `opts`,
 * which makes the transport testable without a real provider call.
 */

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
// Timeout policy (Fred, 2026-07-30). The old value here was a single 180s WALL-CLOCK kill per
// attempt, which executed actively-streaming reasoning rounds at exactly 3:00 and re-billed the
// whole prompt on every retry. Replaced by two timers with different jobs:
//   idle  — fires only after this much TOTAL SILENCE from the wire; any received byte re-arms it.
//           An actively streaming response is never killed by it.
//   hard  — a pathological-stream fuse (a wire trickling one byte a minute), sized for real work,
//           never a work limit. Round-level brakes (budget ledger, supervisor, loop watch) own
//           runaway protection; these timers only detect dead or wedged transport.
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_HARD_TIMEOUT_MS = 2_700_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

function stringValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function argumentString(value) {
  return typeof value === "string" ? value : stringValue(value || {});
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

function responseContentParts(message, { vision = true } = {}) {
  const source = message && message.content;
  const parts = [];

  if (Array.isArray(source)) {
    for (const part of source) {
      if (typeof part === "string") {
        if (part) parts.push({ type: "input_text", text: part });
        continue;
      }
      if (!part || typeof part !== "object") continue;
      if (["text", "input_text", "output_text", "summary_text"].includes(part.type)) {
        const text = stringValue(part.text);
        if (text) parts.push({ type: "input_text", text });
        continue;
      }
      if (part.type === "image_url" || part.type === "input_image") {
        const url = imageUrl(part);
        if (url && vision) parts.push({ type: "input_image", image_url: url, ...(part.detail ? { detail: part.detail } : {}) });
        else if (url) parts.push({ type: "input_text", text: "[Image attached; this model cannot inspect images.]" });
        continue;
      }
      if (part.type === "input_file") {
        const file = { type: "input_file" };
        for (const key of ["file_id", "file_data", "file_url", "filename"]) {
          if (part[key] != null) file[key] = part[key];
        }
        if (Object.keys(file).length > 1) parts.push(file);
      }
    }
  } else {
    const text = stringValue(source);
    if (text) parts.push({ type: "input_text", text });
  }

  for (const attachment of Array.isArray(message && message.attachments) ? message.attachments : []) {
    if (!attachment || typeof attachment !== "object") continue;
    const kind = String(attachment.kind || attachment.type || "").toLowerCase();
    const url = attachment.dataUrl || attachment.data_url || attachment.url || "";
    if ((kind === "image" || String(url).startsWith("data:image/")) && url) {
      if (vision) parts.push({ type: "input_image", image_url: String(url) });
      else parts.push({ type: "input_text", text: `[Image attached: ${attachment.name || attachment.filename || "image"}; this model cannot inspect images.]` });
      continue;
    }
    const block = textAttachmentBlock(attachment);
    if (block) parts.push({ type: "input_text", text: block });
    else if (attachment.name || attachment.filename) {
      parts.push({ type: "input_text", text: `[Attachment: ${attachment.name || attachment.filename}]` });
    }
  }

  if (!parts.length) return "";
  if (parts.length === 1 && parts[0].type === "input_text") return parts[0].text;
  return parts;
}

function normalizedRole(role) {
  return ["user", "assistant", "system", "developer"].includes(role) ? role : "user";
}

function normalizedFunctionCall(call, index) {
  if (!call || typeof call !== "object") return null;
  const fn = call.function && typeof call.function === "object" ? call.function : call;
  const name = String(fn.name || call.name || "");
  if (!name) return null;
  const callId = String(call.call_id || call.id || `call_${index}`);
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: argumentString(fn.arguments ?? call.arguments ?? {}),
  };
}

/**
 * Translate Chat Completions-style messages to Responses API input items.
 * Assistant tool calls and tool results become first-class function-call items.
 */
export function chatMessagesToResponsesInput(messages, opts = {}) {
  const input = [];
  for (const [messageIndex, message] of (Array.isArray(messages) ? messages : []).entries()) {
    if (!message || typeof message !== "object") continue;

    // Stateless reasoning/tool continuations must replay the provider's native
    // output items byte-for-byte. In particular, reasoning items can carry
    // `encrypted_content` that cannot be reconstructed from visible text, and
    // OpenAI requires that item before the corresponding function-call output.
    // The field is internal Dominion state populated only from a completed
    // Responses result; it is never accepted from the browser transcript.
    if (message.role === "assistant" && Array.isArray(message.responsesOutput) && message.responsesOutput.length) {
      for (const item of message.responsesOutput) {
        if (item && typeof item === "object") input.push(structuredClone(item));
      }
      continue;
    }

    if (message.role === "tool") {
      const callId = message.tool_call_id || message.call_id;
      if (callId) {
        input.push({
          type: "function_call_output",
          call_id: String(callId),
          output: stringValue(message.content),
        });
      } else {
        // A malformed legacy tool row cannot be associated with a Responses
        // function call. Preserve its information as user-visible context
        // instead of inventing a call id the API cannot match.
        input.push({ role: "user", content: `[Unassociated tool result]\n${stringValue(message.content)}` });
      }
      continue;
    }

    const content = responseContentParts(message, opts);
    if (content !== "" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      input.push({ role: normalizedRole(message.role), content });
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const normalized = normalizedFunctionCall(call, `${messageIndex}_${callIndex}`);
        if (normalized) input.push(normalized);
      }
    }
  }
  return input;
}

/**
 * Translate Chat Completions function schemas to the flat Responses tool shape.
 * Responses-native built-in tool declarations pass through unchanged.
 */
export function chatToolsToResponsesTools(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const fn = tool.function;
      if (!fn.name) continue;
      const flat = {
        type: "function",
        name: String(fn.name),
        parameters: fn.parameters || { type: "object", properties: {} },
      };
      if (fn.description != null) flat.description = String(fn.description);
      if (typeof fn.strict === "boolean") flat.strict = fn.strict;
      out.push(flat);
      continue;
    }
    if (tool.type === "function" && tool.name) {
      const flat = {
        type: "function",
        name: String(tool.name),
        parameters: tool.parameters || { type: "object", properties: {} },
      };
      if (tool.description != null) flat.description = String(tool.description);
      if (typeof tool.strict === "boolean") flat.strict = tool.strict;
      out.push(flat);
      continue;
    }
    // Web search, file search, computer use, MCP, and other Responses-native
    // tools already use a flat provider-defined shape.
    if (tool.type) out.push({ ...tool });
  }
  return out;
}

function responsesToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "function" && choice.function && choice.function.name) {
    return { type: "function", name: String(choice.function.name) };
  }
  if (choice.type === "function" && choice.name) {
    return { type: "function", name: String(choice.name) };
  }
  return choice;
}

/**
 * Build a native Responses request while retaining the option names Dominion's
 * current call sites already use (`num_predict`, `toolChoice`, and so on).
 */
export function buildResponsesPayload(model, messages, opts = {}) {
  const payload = {
    model,
    input: chatMessagesToResponsesInput(messages, { vision: opts.vision !== false }),
    stream: true,
  };

  const maxOutputTokens = opts.maxOutputTokens ?? opts.max_output_tokens ?? opts.num_predict;
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) payload.max_output_tokens = Math.floor(maxOutputTokens);

  const effort = opts.reasoningEffort ?? opts.reasoning_effort ?? (opts.reasoning && opts.reasoning.effort);
  const summary = opts.reasoningSummary ?? (opts.reasoning && opts.reasoning.summary);
  const context = opts.reasoningContext ?? (opts.reasoning && opts.reasoning.context);
  if (effort != null || summary != null || context != null) {
    payload.reasoning = {};
    if (effort != null) payload.reasoning.effort = String(effort);
    if (summary != null) payload.reasoning.summary = String(summary);
    if (context != null) payload.reasoning.context = String(context);
  }

  const verbosity = opts.verbosity ?? opts.textVerbosity ?? (opts.text && opts.text.verbosity);
  if (verbosity != null) payload.text = { ...(opts.text || {}), verbosity: String(verbosity) };
  else if (opts.text && typeof opts.text === "object") payload.text = { ...opts.text };

  const tools = chatToolsToResponsesTools(opts.tools);
  if (tools.length) payload.tools = tools;
  const toolChoice = responsesToolChoice(opts.toolChoice ?? opts.tool_choice);
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  if (typeof opts.parallelToolCalls === "boolean") payload.parallel_tool_calls = opts.parallelToolCalls;
  else if (typeof opts.parallel_tool_calls === "boolean") payload.parallel_tool_calls = opts.parallel_tool_calls;

  if (opts.instructions != null) payload.instructions = String(opts.instructions);
  if (opts.previousResponseId || opts.previous_response_id) payload.previous_response_id = String(opts.previousResponseId || opts.previous_response_id);
  if (typeof opts.store === "boolean") payload.store = opts.store;
  if (typeof opts.temperature === "number") payload.temperature = opts.temperature;
  if (opts.serviceTier || opts.service_tier) payload.service_tier = opts.serviceTier || opts.service_tier;
  if (opts.truncation) payload.truncation = opts.truncation;
  if (opts.promptCacheKey || opts.prompt_cache_key) payload.prompt_cache_key = opts.promptCacheKey || opts.prompt_cache_key;
  if (opts.safetyIdentifier || opts.safety_identifier) payload.safety_identifier = opts.safetyIdentifier || opts.safety_identifier;
  if (opts.metadata && typeof opts.metadata === "object") payload.metadata = opts.metadata;
  if (Array.isArray(opts.include) && opts.include.length) payload.include = opts.include;

  return payload;
}

/** Convert a configured legacy Chat Completions URL to the sibling Responses URL. */
export function responsesEndpoint(value = DEFAULT_ENDPOINT) {
  const url = new URL(value || DEFAULT_ENDPOINT);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/responses");
  return url.toString();
}

function emptyResult(overrides = {}) {
  return {
    ok: false,
    content: "",
    reasoning: "",
    usage: null,
    finishReason: "",
    toolCalls: [],
    error: "",
    ...overrides,
  };
}

function apiErrorMessage(body, fallback) {
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
  try { return apiErrorMessage(JSON.parse(raw), raw || `HTTP ${response.status}`); }
  catch { return raw || `HTTP ${response.status}`; }
}

function retryAfterMs(response, fallback, max) {
  const raw = response && response.headers && response.headers.get("retry-after");
  if (!raw) return Math.min(fallback, max);
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), max);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), max);
  return Math.min(fallback, max);
}

function abortableDelay(ms, signal, sleepImpl) {
  if (signal && signal.aborted) return Promise.reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
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

function attemptAbort(parentSignal, idleMs, hardMs) {
  const controller = new AbortController();
  let timedOut = "";   // "" | "idle" | "hard"
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const fire = (kind, message) => {
    timedOut = kind;
    controller.abort(new DOMException(message, "TimeoutError"));
  };
  const armIdle = () => setTimeout(
    () => fire("idle", `No stream activity for ${Math.round(idleMs / 1000)}s`), idleMs);
  let idleTimer = armIdle();
  const hardTimer = setTimeout(
    () => fire("hard", `Request exceeded the ${Math.round(hardMs / 60000)}-minute attempt fuse`), hardMs);
  return {
    signal: controller.signal,
    // Any bytes from the provider re-arm the idle window. An actively streaming response is
    // NEVER killed by the watchdog; only the hard fuse and the caller's own signal remain.
    touch() {
      if (controller.signal.aborted) return;
      clearTimeout(idleTimer);
      idleTimer = armIdle();
    },
    timedOut: () => !!timedOut,
    timedOutKind: () => timedOut,
    cleanup() {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

function callAccumulator() {
  const byIndex = new Map();
  const keyToIndex = new Map();
  let nextIndex = 0;

  function locate(event, item) {
    const declared = Number.isInteger(event && event.output_index) ? event.output_index : null;
    const itemKey = (event && event.item_id) || (item && (item.id || item.call_id));
    if (itemKey && keyToIndex.has(itemKey)) return keyToIndex.get(itemKey);
    const index = declared == null ? nextIndex++ : declared;
    if (index >= nextIndex) nextIndex = index + 1;
    if (itemKey) keyToIndex.set(itemKey, index);
    return index;
  }

  function ensure(index) {
    if (!byIndex.has(index)) byIndex.set(index, { index, callId: "", itemId: "", name: "", arguments: "" });
    return byIndex.get(index);
  }

  return {
    item(event, item) {
      if (!item || item.type !== "function_call") return;
      const acc = ensure(locate(event, item));
      if (item.id) {
        acc.itemId = String(item.id);
        keyToIndex.set(String(item.id), acc.index);
      }
      if (item.call_id) {
        acc.callId = String(item.call_id);
        keyToIndex.set(String(item.call_id), acc.index);
      }
      if (item.name) acc.name = String(item.name);
      if (item.arguments != null && String(item.arguments)) acc.arguments = String(item.arguments);
    },
    argumentsDelta(event, delta) {
      const acc = ensure(locate(event));
      acc.arguments += String(delta || "");
    },
    argumentsDone(event, args) {
      const acc = ensure(locate(event));
      acc.arguments = String(args || "");
    },
    values() {
      return [...byIndex.values()]
        .sort((a, b) => a.index - b.index)
        .filter((call) => call.name)
        .map((call, index) => ({
          id: call.callId || call.itemId || `call_${index}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "" },
        }));
    },
  };
}

function outputText(response) {
  let text = "";
  for (const item of Array.isArray(response && response.output) ? response.output : []) {
    if (item && item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") text += part.text;
        // Refusals are visible assistant output in the Responses API. They are
        // not transport errors and must not disappear merely because they use
        // a different content-part shape than ordinary output text.
        if (part && part.type === "refusal") {
          if (typeof part.refusal === "string") text += part.refusal;
          else if (typeof part.text === "string") text += part.text;
        }
      }
    }
  }
  return text;
}

function outputReasoning(response) {
  let text = "";
  for (const item of Array.isArray(response && response.output) ? response.output : []) {
    if (!item || item.type !== "reasoning") continue;
    for (const part of Array.isArray(item.summary) ? item.summary : []) {
      if (part && typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

function statusFinishReason(status, response, hasToolCalls) {
  if (status === "incomplete") {
    const reason = response && response.incomplete_details && response.incomplete_details.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
    return reason || "incomplete";
  }
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "error";
  return hasToolCalls ? "tool_calls" : "stop";
}

function createStreamState(onDelta, handlers = {}) {
  const calls = callAccumulator();
  let content = "";
  let refusal = "";
  let reasoning = "";
  let response = null;
  let status = "";
  let eventError = "";
  let terminal = false;
  let meaningfulOutput = false;

  function appendVisible(delta) {
    const value = String(delta || "");
    if (!value) return;
    content += value;
    meaningfulOutput = true;
    try { if (onDelta) onDelta(value); } catch {}
  }

  function finishRefusal(value) {
    const finalValue = String(value || "");
    if (!finalValue) return;
    if (!refusal) {
      refusal = finalValue;
      appendVisible(finalValue);
      return;
    }
    // The `.done` event normally repeats the complete refusal after the delta
    // events. Emit only a missing suffix so the user never sees it twice.
    if (finalValue.startsWith(refusal)) appendVisible(finalValue.slice(refusal.length));
    else if (!content.endsWith(finalValue)) appendVisible(finalValue);
    refusal = finalValue;
  }

  function absorbResponse(next) {
    if (!next || typeof next !== "object") return;
    response = next;
    status = String(next.status || status || "");
    if (outputText(next)) meaningfulOutput = true;
    for (const [outputIndex, item] of (Array.isArray(next.output) ? next.output : []).entries()) {
      calls.item({ output_index: outputIndex }, item);
    }
  }

  return {
    event(event) {
      if (!event || typeof event !== "object") return;
      const type = String(event.type || "");
      if (type === "response.output_text.delta") {
        appendVisible(event.delta);
      } else if (type === "response.refusal.delta") {
        const delta = String(event.delta || "");
        refusal += delta;
        appendVisible(delta);
      } else if (type === "response.refusal.done") {
        finishRefusal(event.refusal ?? event.text);
      } else if (type === "response.reasoning_summary_text.delta") {
        const delta = String(event.delta || "");
        reasoning += delta;
        meaningfulOutput = true;
        try { if (delta && handlers.onReasoning) handlers.onReasoning(delta); } catch {}
      } else if (type === "response.function_call_arguments.delta") {
        calls.argumentsDelta(event, event.delta);
        meaningfulOutput = true;
      } else if (type === "response.function_call_arguments.done") {
        calls.argumentsDone(event, event.arguments);
        meaningfulOutput = true;
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        calls.item(event, event.item);
        if (event.item && event.item.type === "function_call") meaningfulOutput = true;
        // Some compatible Responses providers omit text/refusal deltas and put
        // the only visible content on the completed message item.
        if (type === "response.output_item.done" && !content && event.item && event.item.type === "message") {
          appendVisible(outputText({ output: [event.item] }));
        }
      } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        // A terminal event is authoritative only when it carries the final
        // Responses object. In particular, neither a bare terminal-shaped event
        // nor the optional transport-level [DONE] marker proves completion.
        if (!event.response || typeof event.response !== "object" || Array.isArray(event.response)) return;
        absorbResponse(event.response);
        terminal = true;
        if (type === "response.completed") status = status || "completed";
        if (type === "response.incomplete") status = "incomplete";
        if (type === "response.failed") {
          status = "failed";
          eventError = apiErrorMessage(event.response, "The OpenAI response failed.");
        }
      } else if (type === "error") {
        eventError = apiErrorMessage(event, "OpenAI returned a streaming error.");
        terminal = true;
      } else if (event.response) {
        absorbResponse(event.response);
      }
    },
    hasMeaningfulOutput() { return meaningfulOutput; },
    // Deliverable = visible text a resumed round can continue FROM. Reasoning summaries and
    // half-streamed tool calls are progress signals, never resumable output.
    hasDeliverableContent() { return content.length > 0; },
    result() {
      const finalContent = outputText(response) || content;
      const finalReasoning = outputReasoning(response) || reasoning;
      const toolCalls = calls.values();
      const finalStatus = status || (terminal ? "completed" : "");
      const responseItems = terminal && Array.isArray(response && response.output)
        ? response.output.map((item) => structuredClone(item))
        : [];
      const providerError = eventError || (finalStatus === "failed"
        ? apiErrorMessage(response, "The OpenAI response failed.")
        : "");
      if (providerError) {
        return emptyResult({
          content: finalContent,
          reasoning: finalReasoning,
          usage: response && response.usage || null,
          finishReason: "error",
          toolCalls,
          error: providerError,
          partial: meaningfulOutput,
          responseId: terminal && response && response.id || "",
          responseItems,
          status: finalStatus,
        });
      }
      if (!terminal) {
        return emptyResult({
          content: finalContent,
          reasoning: finalReasoning,
          usage: response && response.usage || null,
          finishReason: meaningfulOutput ? "error" : "",
          toolCalls,
          error: "OpenAI's response stream ended before a terminal event.",
          partial: meaningfulOutput,
        });
      }
      return {
        ok: true,
        content: finalContent,
        reasoning: finalReasoning,
        usage: response && response.usage || null,
        // The tier OpenAI ACTUALLY served this on, echoed back. Fast bills at double, so the
        // billing path has to price what happened rather than what was asked for.
        serviceTier: (response && (response.service_tier || response.serviceTier)) || "",
        finishReason: statusFinishReason(finalStatus, response, toolCalls.length > 0),
        toolCalls,
        error: "",
        responseId: response && response.id || "",
        responseItems,
        status: finalStatus,
      };
    },
  };
}

function consumeSseChunk(buffer, chunk, onFrame) {
  buffer += chunk;
  while (true) {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match) break;
    const frame = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    onFrame(frame);
  }
  return buffer;
}

function frameData(frame) {
  const rows = String(frame || "").split(/\r?\n/);
  const data = [];
  for (const row of rows) {
    if (row.startsWith("data:")) data.push(row.slice(5).trimStart());
  }
  return data.join("\n");
}

async function consumeResponsesSse(response, state, signal, touch) {
  if (!response.body) throw new Error("OpenAI returned an empty response stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  const onFrame = (frame) => {
    const data = frameData(frame);
    if (!data) return;
    if (data.trim() === "[DONE]") {
      // [DONE] only closes the SSE transport. Success requires a preceding
      // response.completed/incomplete/failed event with its response object.
      return;
    }
    try { state.event(JSON.parse(data)); } catch {}
  };

  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal.aborted) throw signal.reason || Object.assign(new Error("stopped"), { name: "AbortError" });
        const { value, done } = await reader.read();
        if (done) break;
        if (touch) touch();   // any bytes at all re-arm the idle watchdog, comments included
        buffer = consumeSseChunk(buffer, decoder.decode(value, { stream: true }), onFrame);
      }
      buffer = consumeSseChunk(buffer, decoder.decode(), onFrame);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  } else {
    for await (const value of response.body) {
      if (signal.aborted) throw signal.reason || Object.assign(new Error("stopped"), { name: "AbortError" });
      if (touch) touch();   // any bytes at all re-arm the idle watchdog, comments included
      buffer = consumeSseChunk(buffer, decoder.decode(value, { stream: true }), onFrame);
    }
    buffer = consumeSseChunk(buffer, decoder.decode(), onFrame);
  }
  if (buffer.trim()) onFrame(buffer);
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function responseParamRetryAdjust(payload, errorMessage) {
  const message = String(errorMessage || "");
  // A plain 400 is never enough. The provider must explicitly reject a
  // parameter/value, and the named optional parameter must exist in our body.
  if (!/\b(?:unsupported|unknown|unrecognized|invalid)\b|not supported|does not support|extra inputs are not permitted/i.test(message)) {
    return null;
  }

  const adjusted = {
    ...payload,
    ...(payload.reasoning && typeof payload.reasoning === "object" ? { reasoning: { ...payload.reasoning } } : {}),
    ...(payload.text && typeof payload.text === "object" ? { text: { ...payload.text } } : {}),
  };
  const notes = [];
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const mentions = (...names) => names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:['"\`]${escaped}['"\`]|\\b${escaped}\\b)`, "i").test(message);
  });

  if (hasOwn(adjusted, "temperature") && mentions("temperature")) {
    delete adjusted.temperature;
    notes.push("temperature removed");
  }
  if (hasOwn(adjusted, "top_p") && mentions("top_p")) {
    delete adjusted.top_p;
    notes.push("top_p removed");
  }

  const nestedReasoning = [
    ["context", ["reasoning.context", "reasoning_context"]],
    ["summary", ["reasoning.summary", "reasoning_summary"]],
    ["effort", ["reasoning.effort", "reasoning_effort"]],
  ];
  for (const [key, names] of nestedReasoning) {
    if (hasOwn(adjusted.reasoning, key) && mentions(...names)) {
      delete adjusted.reasoning[key];
      notes.push(`reasoning.${key} removed`);
    }
  }
  if (adjusted.reasoning && !Object.keys(adjusted.reasoning).length) delete adjusted.reasoning;

  if (hasOwn(adjusted.text, "verbosity") && mentions("text.verbosity", "text_verbosity", "verbosity")) {
    delete adjusted.text.verbosity;
    notes.push("text.verbosity removed");
  }
  if (adjusted.text && !Object.keys(adjusted.text).length) delete adjusted.text;

  const optionalTopLevel = [
    "parallel_tool_calls",
    "tool_choice",
    "service_tier",
    "truncation",
    "prompt_cache_key",
    "safety_identifier",
    "include",
  ];
  for (const key of optionalTopLevel) {
    if (hasOwn(adjusted, key) && mentions(key)) {
      delete adjusted[key];
      notes.push(`${key} removed`);
    }
  }

  // Preserve the old adapter's useful provider-cap repair without treating
  // unrelated tool-schema errors as retryable.
  const lengthMatch = /maximum (?:array )?length(?:\s+(?:of|is))?\s*(\d+)/i.exec(message);
  if (lengthMatch && Array.isArray(adjusted.tools) && /tool|function/i.test(message)) {
    const cap = Math.max(1, Number.parseInt(lengthMatch[1], 10));
    if (adjusted.tools.length > cap) {
      adjusted.tools = adjusted.tools.slice(0, cap);
      notes.push(`tools trimmed to ${cap}`);
    }
  }

  return notes.length ? { payload: adjusted, note: notes.join(", ") } : null;
}

function notifyRetry(opts, detail) {
  try { if (typeof opts.onRetry === "function") opts.onRetry(detail); } catch {}
}

/**
 * Call OpenAI's native Responses API and normalize its streaming result to the
 * shape already consumed by Dominion's cloud agent loop.
 *
 * Signature intentionally mirrors the existing cloud streamer:
 *   openAIResponsesStream(model, messages, opts, onDelta)
 */
export async function openAIResponsesStream(model, messages, opts = {}, onDelta) {
  const apiKey = opts.apiKey ?? opts.key;
  const label = String(opts.label || "OpenAI (direct)");
  if (!apiKey) return emptyResult({ error: `No ${label} key configured on the server.` });
  if (opts.signal && opts.signal.aborted) return emptyResult({ aborted: true, error: "stopped" });

  let endpoint;
  try { endpoint = responsesEndpoint(opts.endpoint || opts.url || DEFAULT_ENDPOINT); }
  catch { return emptyResult({ error: `${label} endpoint is misconfigured.` }); }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return emptyResult({ error: `${label} transport is unavailable.` });
  let payload = buildResponsesPayload(model, messages, opts);
  const maxRetries = Math.max(0, Math.min(5, Number.isFinite(opts.maxRetries) ? Math.floor(opts.maxRetries) : DEFAULT_MAX_RETRIES));
  // opts.timeoutMs kept for callers/tests: it now means the IDLE window (silence budget), since
  // wall-clock kills of active streams are exactly the defect this rewrite removes.
  const idleMs = Math.max(1, Number.isFinite(opts.idleTimeoutMs) ? Math.floor(opts.idleTimeoutMs)
    : Number.isFinite(opts.timeoutMs) ? Math.floor(opts.timeoutMs) : DEFAULT_IDLE_TIMEOUT_MS);
  const hardMs = Math.max(idleMs, Number.isFinite(opts.hardTimeoutMs) ? Math.floor(opts.hardTimeoutMs) : DEFAULT_HARD_TIMEOUT_MS);
  const retryBaseMs = Math.max(0, Number.isFinite(opts.retryBaseMs) ? opts.retryBaseMs : DEFAULT_RETRY_BASE_MS);
  const maxBackoffMs = Math.max(retryBaseMs, Number.isFinite(opts.maxBackoffMs) ? opts.maxBackoffMs : DEFAULT_MAX_BACKOFF_MS);
  let transientRetries = 0;
  let parameterRepairUsed = false;
  // Reasoning made visible (Fred, 2026-07-30): with emitReasoningAsThink, summary deltas ride the
  // SAME onDelta wire wrapped in <think> tags, exactly the local models' convention, so the client
  // shows live thinking with zero new event types and the SSE connection carries steady traffic.
  const emitThink = opts.emitReasoningAsThink === true && typeof onDelta === "function";
  let thinkOpen = false;
  const closeThink = () => { if (thinkOpen) { thinkOpen = false; try { onDelta("</think>"); } catch {} } };
  const visibleDelta = emitThink
    ? (delta) => { closeThink(); onDelta(delta); }
    : onDelta;
  const reasoningDelta = (delta) => {
    if (typeof opts.onReasoningDelta === "function") { try { opts.onReasoningDelta(delta); } catch {} }
    if (!emitThink) return;
    if (!thinkOpen) { thinkOpen = true; try { onDelta("<think>"); } catch {} }
    try { onDelta(delta); } catch {}
  };

  while (true) {
    if (opts.signal && opts.signal.aborted) return emptyResult({ aborted: true, error: "stopped" });
    const attemptSignal = attemptAbort(opts.signal, idleMs, hardMs);
    const state = createStreamState(visibleDelta, { onReasoning: reasoningDelta });
    let response = null;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(opts.headers || {}),
        },
        body: JSON.stringify(payload),
        signal: attemptSignal.signal,
      });

      if (!response || typeof response.ok !== "boolean") throw new Error("The OpenAI transport returned an invalid response.");
      if (!response.ok) {
        const providerMessage = await readErrorResponse(response);
        if (response.status === 400 && !parameterRepairUsed) {
          const repair = responseParamRetryAdjust(payload, providerMessage);
          if (repair) {
            payload = repair.payload;
            parameterRepairUsed = true;
            notifyRetry(opts, {
              attempt: transientRetries + 1,
              status: 400,
              delayMs: 0,
              reason: "parameter",
              note: repair.note,
            });
            attemptSignal.cleanup();
            continue;
          }
        }
        const canRetry = retryableStatus(response.status) && transientRetries < maxRetries;
        if (!canRetry) {
          return emptyResult({ status: response.status, error: `${label}: ${providerMessage}` });
        }
        const fallback = retryBaseMs * (2 ** transientRetries);
        const delayMs = retryAfterMs(response, fallback, maxBackoffMs);
        notifyRetry(opts, { attempt: transientRetries + 1, status: response.status, delayMs, reason: "http" });
        transientRetries++;
        attemptSignal.cleanup();
        try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
        catch {
          return emptyResult({ aborted: true, error: "stopped" });
        }
        continue;
      }

      await consumeResponsesSse(response, state, attemptSignal.signal, attemptSignal.touch);
      closeThink();
      const result = state.result();
      if (!result.ok && !result.partial && transientRetries < maxRetries && /stream ended|empty response stream/i.test(result.error)) {
        const delayMs = Math.min(retryBaseMs * (2 ** transientRetries), maxBackoffMs);
        notifyRetry(opts, { attempt: transientRetries + 1, delayMs, reason: "stream" });
        transientRetries++;
        attemptSignal.cleanup();
        try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
        catch {
          return emptyResult({ aborted: true, error: "stopped" });
        }
        continue;
      }
      return result;
    } catch (error) {
      closeThink();
      if (opts.signal && opts.signal.aborted) return emptyResult({ aborted: true, error: "stopped" });
      const timedOut = attemptSignal.timedOut();
      const partialResult = state.result();
      const deliverable = state.hasDeliverableContent();
      /*
       * Timeout with delivered text: return it as a resumable checkpoint (finishReason "length"),
       * so the caller's existing continuation machinery resumes from the exact cut instead of
       * re-buying the whole attempt. Tool calls are DROPPED here on purpose: without the terminal
       * event there are no native response items, and replaying a tool result without its
       * encrypted reasoning item is a provider error. The model re-issues the call after resume.
       */
      if (timedOut && deliverable) {
        return {
          ok: true,
          content: partialResult.content,
          reasoning: partialResult.reasoning,
          usage: partialResult.usage,
          finishReason: "length",
          toolCalls: [],
          error: "",
          partial: true,
          timedOutPartial: attemptSignal.timedOutKind() || "idle",
          responseId: "",
          responseItems: [],
        };
      }
      // Nothing resumable arrived. Retry only for genuine silence/network death; each retry is a
      // fresh bill, so the idle watchdog (not a stopwatch) is what makes this rare.
      if (!deliverable && transientRetries < maxRetries) {
        const delayMs = Math.min(retryBaseMs * (2 ** transientRetries), maxBackoffMs);
        notifyRetry(opts, { attempt: transientRetries + 1, delayMs, reason: timedOut ? "timeout" : "network" });
        transientRetries++;
        attemptSignal.cleanup();
        try { await abortableDelay(delayMs, opts.signal, opts.sleepImpl); }
        catch {
          return emptyResult({ aborted: true, error: "stopped" });
        }
        continue;
      }
      const suffix = timedOut
        ? `timed out (${attemptSignal.timedOutKind() === "hard" ? "attempt fuse" : "no stream activity"}).`
        : `couldn't be reached: ${String(error && error.message || error)}.`;
      return emptyResult({
        content: partialResult.content,
        reasoning: partialResult.reasoning,
        usage: partialResult.usage,
        finishReason: state.hasMeaningfulOutput() ? "error" : "",
        toolCalls: partialResult.toolCalls,
        partial: state.hasMeaningfulOutput(),
        error: `${label} ${suffix}`,
      });
    } finally {
      attemptSignal.cleanup();
    }
  }

  return emptyResult({ error: `${label} request failed after retries.` });
}

export default openAIResponsesStream;
