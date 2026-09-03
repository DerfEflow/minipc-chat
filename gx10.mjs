/*
 * Dominion AI — GX10 local-model lane (Fred's DGX Spark, 2026-09-01).
 *
 * The GX10 serves Ollama on the home LAN behind CGNAT; the cloud app cannot dial it directly.
 * Two wires exist, chosen at call time by server.mjs:
 *
 *   HANDS RELAY (default): the dominion-hands-gx10 container keeps a persistent outbound stream
 *   to the app, and its ollama_chat op calls the box's own Ollama and streams tokens back. Zero
 *   new public surface; works the moment the node is connected.
 *
 *   DIRECT URL (optional): set GX10_LLM_URL (+ GX10_LLM_KEY for the bearer gate installed as
 *   ollama-gate.service on the box) and calls ride HTTPS through the generic OpenAI-dialect
 *   streamer instead. Faster per token; requires the public hostname to exist.
 *
 * This module holds the PURE translation between the OpenAI-dialect shapes the rest of the app
 * speaks and Ollama's native /api/chat shapes, so both directions are unit-testable without a
 * server, a hub, or a GPU. Verified against a live GX10 probe 2026-09-01: streaming SSE, streamed
 * tool_calls, and usage in the final chunk all work on Ollama 0.32's OpenAI lane, and /api/chat
 * returns tool_calls with OBJECT arguments (not the JSON string OpenAI uses) — both handled below.
 */

// OpenAI-dialect messages -> Ollama /api/chat payload. Content parts flatten to text (the GX10
// seats are not vision-flagged, so image parts arrive only by defect; flattening is honest).
export function ollamaPayloadFromOpenAI({ model, messages, tools = null, num_predict = 0, num_ctx = 0, temperature, keepAlive = "30m" } = {}) {
  const msgs = (Array.isArray(messages) ? messages : []).map((m) => {
    const role = m && m.role === "developer" ? "system" : String((m && m.role) || "user");
    let content = m ? m.content : "";
    if (Array.isArray(content)) {
      content = content.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).filter(Boolean).join("\n");
    }
    const out = { role, content: typeof content === "string" ? content : String(content ?? "") };
    if (m && role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((c) => ({
        function: {
          name: String((c && c.function && c.function.name) || ""),
          arguments: parseToolArguments(c && c.function && c.function.arguments),
        },
      }));
    }
    // Ollama has no tool_call_id field; role:"tool" content alone carries the result.
    return out;
  });
  const payload = { model: String(model || ""), messages: msgs, stream: true, keep_alive: keepAlive };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  const options = {};
  if (typeof temperature === "number") options.temperature = temperature;
  if (Number(num_predict) > 0) options.num_predict = Math.floor(Number(num_predict));
  // Bound the KV allocation to the catalog's promised window. Without this Ollama allocates the
  // model's FULL native context per load (262k on the coder = ~13GB of KV) and two big models can
  // no longer share the box. The catalog ctx is the contract; the box allocates exactly that.
  if (Number(num_ctx) > 0) options.num_ctx = Math.floor(Number(num_ctx));
  if (Object.keys(options).length) payload.options = options;
  return payload;
}

// Ollama tool arguments arrive as an OBJECT on /api/chat; OpenAI callers expect a JSON string.
export function parseToolArguments(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string" && args.trim()) { try { return JSON.parse(args); } catch { return {}; } }
  return {};
}

function stringToolArguments(args) {
  if (typeof args === "string") return args;
  try { return JSON.stringify(args ?? {}); } catch { return "{}"; }
}

/*
 * Ollama /api/chat terminal response (the hands node returns the assembled stream:false shape)
 * -> the cloudChatStream result contract: { ok, content, toolCalls, usage, finishReason,
 * assistantTurn }. Reasoning text (message.thinking on native chat) is deliberately NOT folded
 * into content: it is the model's scratchpad, and the file-block parser downstream must never
 * see it.
 */
export function openAIResultFromOllama(response, { transport = "gx10" } = {}) {
  const r = response && typeof response === "object" ? response : {};
  const message = r.message && typeof r.message === "object" ? r.message : {};
  const content = String(message.content || "");
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawCalls
    .filter((c) => c && c.function && c.function.name)
    .map((c, i) => ({
      id: String(c.id || "call_gx10_" + i),
      type: "function",
      function: { name: String(c.function.name), arguments: stringToolArguments(c.function.arguments) },
    }));
  const usage = {
    prompt_tokens: Number(r.prompt_eval_count) || 0,
    completion_tokens: Number(r.eval_count) || 0,
    total_tokens: (Number(r.prompt_eval_count) || 0) + (Number(r.eval_count) || 0),
    __transport: transport,
  };
  const doneReason = String(r.done_reason || "").toLowerCase();
  const finishReason = toolCalls.length ? "tool_calls" : doneReason === "length" ? "length" : "stop";
  const assistantTurn = { role: "assistant", content };
  if (toolCalls.length) assistantTurn.tool_calls = toolCalls;
  return { ok: true, content, toolCalls, usage, finishReason, assistantTurn, transport };
}

// One user-safe failure shape for the lane, so ideRetryableFailure and the reroute ladder can
// classify it exactly like any other provider transport death.
//
// lane/chat follow-up (2026-09-03, production evidence: a busy GX10 produced no first token for
// 150s while the client waited, because the relay's own dispatch deadline is up to 10 minutes and
// carries no interim "queued" signal). Two additions, both opt-in so every existing caller and the
// gx10_test.mjs default-call contract (retryable:true) is unchanged:
//   - content/toolCalls: when the node streamed SOME text before the relay ultimately failed (a
//     genuine mid-stream death, not the queued case), that text rides the failure exactly like the
//     generic cloud lane's `or.partial`/`or.content`, so the round loop folds it into the fallback
//     model's transcript as a continuation instead of silently dropping already-shown text.
//   - retryable defaults to true (an ordinary transport hiccup still deserves the same-seat retry
//     schedule), but the two callers that KNOW retrying the same seat is pointless — the node was
//     never connected, or nothing arrived within the first-token watchdow — pass retryable:false so
//     the round loop skips straight to the rung-3 cross-model fallback instead of re-queuing behind
//     whatever the box is already busy with.
export function gx10Failure(detail, { retryable = true, content = "", toolCalls = [] } = {}) {
  const hasPartial = !!(content || (Array.isArray(toolCalls) && toolCalls.length));
  return {
    ok: false,
    retryable,
    error: "GX10 (local): " + String(detail || "the box did not answer").slice(0, 300),
    ...(hasPartial ? { partial: true, content, toolCalls } : {}),
  };
}
