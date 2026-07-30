/*
 * Provider execution adapters for Dominion's shared execution policy.
 *
 * This module is deliberately pure and transport-neutral: it performs no I/O,
 * keeps no process state, and never guesses a provider capability.  Callers can
 * use providerExecutionOptions() to inspect the fields/omissions or
 * shapeProviderExecutionRequest() to apply them to a cloned request payload.
 *
 * Provider rules represented here:
 *   - DeepSeek V4 thinking accepts only high/max effort. Thinking tool turns
 *     must replay reasoning_content, and tool_choice is unsupported while
 *     thinking is enabled.
 *   - OpenRouter reasoning controls are emitted only when the caller supplies a
 *     positive capability declaration. session_id is derived from a durable
 *     application session key, and require_parameters prevents a routed
 *     provider from silently ignoring requested controls.
 */

import { createHash } from "node:crypto";

const OPENROUTER_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const OPENROUTER_EFFORT_RANK = new Map(OPENROUTER_EFFORTS.map((value, index) => [value, index]));
const DEEPSEEK_THINKING_OMISSIONS = Object.freeze([
  "tool_choice",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
]);
const OPENROUTER_CONTROL_OMISSIONS = Object.freeze([
  "reasoning",
  "reasoning_effort",
  "include_reasoning",
]);

function own(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

function clone(value, depth = 0) {
  if (value == null || typeof value !== "object") return value;
  if (depth > 30) throw new TypeError("provider execution values are nested too deeply");
  if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clone(item, depth + 1);
  return out;
}

function freeze(value) {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
  return value;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedEffort(value) {
  const effort = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (effort === "very-deep" || effort === "very-high") return "xhigh";
  if (effort === "maximum") return "max";
  if (effort === "standard" || effort === "balanced") return "medium";
  if (effort === "light") return "low";
  return OPENROUTER_EFFORT_RANK.has(effort) ? effort : "";
}

function policyEffortScore(policy) {
  if (policy && policy.effort && Number.isFinite(Number(policy.effort.score))) {
    return Math.max(0, Math.min(5, Number(policy.effort.score)));
  }
  const level = normalizedEffort(policy && policy.effort && policy.effort.level);
  return {
    none: 0,
    minimal: 0,
    low: 1,
    medium: 2,
    high: 3,
    xhigh: 4,
    max: 5,
  }[level] ?? 0;
}

function policyDesiredEffort(policy) {
  const score = policyEffortScore(policy);
  if (score <= 0) return "minimal";
  if (score === 1) return "low";
  if (score === 2) return "medium";
  if (score === 3) return "high";
  if (score === 4) return "xhigh";
  return "max";
}

export function isComplexExecutionPolicy(policy) {
  if (!policy || typeof policy !== "object") return false;
  if (String(policy.taskKind || "").toLowerCase() !== "simple") return true;
  if (String(policy.workKind || "").toLowerCase() !== "simple") return true;
  if (policyEffortScore(policy) >= 2) return true;
  const mode = String(policy.persistence && policy.persistence.mode || "").toLowerCase();
  return !!mode && mode !== "finish-current-result";
}

function deepSeekEffort(policy) {
  const score = policyEffortScore(policy);
  const taskKind = String(policy && policy.taskKind || "").toLowerCase();
  const forgeTier = String(policy && policy.forgeTier || "").toLowerCase();
  return score >= 4 || taskKind === "long-run" || forgeTier === "furnace" ? "max" : "high";
}

/*
 * DeepSeek V4 defaults to thinking enabled. We make that state explicit for
 * complex work so retries and continuation calls cannot accidentally downgrade
 * the model. A caller may explicitly pass thinkingEnabled:false for a simple
 * non-thinking route.
 */
export function deepSeekExecutionOptions({
  policy,
  thinkingEnabled,
} = {}) {
  const complex = isComplexExecutionPolicy(policy);
  const thinking = thinkingEnabled == null ? true : thinkingEnabled === true;
  const request = {};
  const omit = [];
  const notes = [];

  if (thinking) {
    request.thinking = { type: "enabled" };
    request.reasoning_effort = deepSeekEffort(policy);
    omit.push(...DEEPSEEK_THINKING_OMISSIONS);
    if (complex) {
      notes.push(`DeepSeek thinking is enabled at ${request.reasoning_effort} effort for complex work.`);
    } else {
      notes.push("DeepSeek's native thinking default is preserved for this simple turn.");
    }
  } else {
    request.thinking = { type: "disabled" };
    notes.push("DeepSeek thinking was explicitly disabled by the caller.");
  }

  return freeze({
    provider: "deepseek",
    request,
    omit,
    reasoningEnabled: thinking,
    desiredEffort: thinking ? request.reasoning_effort : "none",
    notes,
  });
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function openRouterReasoningDeclaration(capabilities) {
  const caps = capabilities && typeof capabilities === "object" ? capabilities : {};
  const nested = caps.openrouter && typeof caps.openrouter === "object" ? caps.openrouter : {};
  const raw = own(nested, "reasoning") ? nested.reasoning : caps.reasoning;
  const params = new Set(asStringArray(
    caps.supported_parameters
    || caps.supportedParameters
    || nested.supported_parameters
    || nested.supportedParameters,
  ));
  const rawObject = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const booleanDeclared = raw === true
    || caps.supportsReasoning === true
    || caps.reasoningSupported === true
    || nested.supportsReasoning === true;
  const declared = !!rawObject
    || booleanDeclared
    || params.has("reasoning")
    || params.has("reasoning_effort");

  const effortKeys = [
    [rawObject, "supported_efforts"],
    [rawObject, "supportedEfforts"],
    [rawObject, "efforts"],
    [caps, "reasoningEfforts"],
    [nested, "reasoningEfforts"],
  ];
  let effortsDeclared = false;
  let supportedEfforts = [];
  let acceptsAllEfforts = false;
  for (const [holder, key] of effortKeys) {
    if (!holder || !own(holder, key)) continue;
    effortsDeclared = true;
    const value = holder[key];
    if (value == null) acceptsAllEfforts = true;
    else supportedEfforts = asStringArray(value).filter((item) => OPENROUTER_EFFORT_RANK.has(item));
    break;
  }

  const maxTokens = rawObject && (rawObject.supports_max_tokens === true || rawObject.supportsMaxTokens === true)
    || caps.supportsReasoningMaxTokens === true
    || nested.supportsReasoningMaxTokens === true;
  const mandatory = !!(rawObject && rawObject.mandatory === true);

  return {
    declared,
    effortsDeclared,
    acceptsAllEfforts,
    supportedEfforts,
    maxTokens,
    mandatory,
  };
}

function closestDeclaredEffort(desired, supported) {
  if (!supported.length) return "";
  const target = OPENROUTER_EFFORT_RANK.get(desired);
  let best = supported[0];
  let bestDistance = Infinity;
  let bestRank = -Infinity;
  for (const candidate of supported) {
    const rank = OPENROUTER_EFFORT_RANK.get(candidate);
    const distance = Math.abs(rank - target);
    // Prefer the more capable effort when two declared choices are equally close.
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      best = candidate;
      bestDistance = distance;
      bestRank = rank;
    }
  }
  return best;
}

/*
 * Turn a durable Dominion chat/session key into OpenRouter's opaque routing key.
 * Hashing keeps user-authored titles or other identifying strings out of the
 * provider field and guarantees a bounded, repeatable value.
 */
export function stableProviderSessionId(sessionKey, {
  namespace = "dominion",
  length = 32,
} = {}) {
  const key = String(sessionKey ?? "").trim();
  if (!key) return "";
  const prefix = String(namespace || "dominion").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48) || "dominion";
  const chars = Math.max(16, Math.min(64, Math.floor(finiteNumber(length, 32))));
  const digest = createHash("sha256").update(prefix).update("\0").update(key).digest("hex").slice(0, chars);
  return `${prefix}-${digest}`;
}

function normalizeExplicitSessionId(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= 256) return text;
  const digest = createHash("sha256").update(text).digest("hex");
  return `dominion-${digest}`;
}

export function openRouterExecutionOptions({
  policy,
  capabilities = {},
  sessionKey,
  sessionId,
  providerPreferences = {},
  reasoningMaxTokens,
} = {}) {
  /*
   * allow_fallbacks (live-proven 2026-07-30): require_parameters narrows routing to hosts that
   * accept every declared control, which can leave exactly ONE host — and when that host is
   * rate-limited the model reads as dead to the user (thedrummer/cydonia-24b-v4.1 answered 429
   * under the pinned block and answered normally once fallbacks were explicit). Stating fallbacks
   * out loud keeps the pool as wide as the parameters allow. Callers may still override both via
   * providerPreferences (the widen-the-pool recovery does exactly that).
   */
  const request = {
    provider: {
      allow_fallbacks: true,
      require_parameters: true,
      ...clone(providerPreferences || {}),
    },
  };
  const omit = [...OPENROUTER_CONTROL_OMISSIONS];
  const notes = [];
  const stableSession = sessionId
    ? normalizeExplicitSessionId(sessionId)
    : stableProviderSessionId(sessionKey);
  if (stableSession) request.session_id = stableSession;
  else notes.push("No OpenRouter session_id was emitted because no durable session key was supplied.");

  const declaration = openRouterReasoningDeclaration(capabilities);
  const complex = isComplexExecutionPolicy(policy);
  if ((complex || declaration.mandatory) && declaration.declared) {
    const maxTokens = Math.floor(finiteNumber(reasoningMaxTokens, 0));
    if (maxTokens > 0 && declaration.maxTokens) {
      request.reasoning = { max_tokens: Math.max(1, maxTokens) };
    } else if (declaration.effortsDeclared) {
      const desired = policyDesiredEffort(policy);
      const selected = declaration.acceptsAllEfforts
        ? desired
        : closestDeclaredEffort(desired, declaration.supportedEfforts);
      if (selected) request.reasoning = { effort: selected };
      else if (declaration.mandatory) request.reasoning = { enabled: true };
    } else {
      // A positive reasoning declaration without declared effort controls allows
      // the provider-default toggle, but never an invented effort level.
      request.reasoning = { enabled: true };
    }
  } else if (complex) {
    notes.push("OpenRouter reasoning controls were omitted because the model declares no reasoning capability.");
  }

  if (request.reasoning) {
    notes.push("OpenRouter reasoning uses only model-declared controls; routed providers must honor them.");
  }

  return freeze({
    provider: "openrouter",
    request,
    omit,
    reasoningEnabled: !!request.reasoning || declaration.mandatory,
    desiredEffort: request.reasoning && request.reasoning.effort || "",
    sessionId: stableSession,
    notes,
  });
}

export function providerExecutionOptions({
  provider,
  ...options
} = {}) {
  const name = normalizedProvider(provider);
  if (name === "deepseek") return deepSeekExecutionOptions(options);
  if (name === "openrouter") return openRouterExecutionOptions(options);
  return freeze({
    provider: name,
    request: {},
    omit: [],
    reasoningEnabled: false,
    desiredEffort: "",
    notes: ["No provider-specific execution controls are defined for this provider."],
  });
}

/*
 * Apply an adapter to a cloned payload. Nested provider preferences are merged;
 * all other adapter request fields replace their payload counterpart.
 */
export function applyProviderExecutionOptions(payload, options) {
  const out = clone(payload || {});
  const adapter = options || {};
  for (const key of adapter.omit || []) delete out[key];
  for (const [key, value] of Object.entries(adapter.request || {})) {
    if (key === "provider" && value && typeof value === "object" && !Array.isArray(value)) {
      out.provider = {
        ...(out.provider && typeof out.provider === "object" && !Array.isArray(out.provider) ? out.provider : {}),
        ...clone(value),
      };
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

export function shapeProviderExecutionRequest(payload, options = {}) {
  return applyProviderExecutionOptions(payload, providerExecutionOptions(options));
}

function normalizeToolCallDelta(existing, delta, fallbackIndex) {
  const out = existing ? clone(existing) : {};
  for (const [key, value] of Object.entries(delta || {})) {
    if (key === "function" && value && typeof value === "object") {
      const previous = out.function && typeof out.function === "object" ? out.function : {};
      out.function = { ...previous };
      if (own(value, "name") && value.name) {
        const incoming = String(value.name);
        const prior = String(previous.name || "");
        out.function.name = !prior || incoming === prior || prior.endsWith(incoming)
          ? (prior || incoming)
          : incoming.startsWith(prior)
            ? incoming
            : prior + incoming;
      }
      if (own(value, "arguments")) {
        const incoming = value.arguments == null ? "" : String(value.arguments);
        out.function.arguments = String(previous.arguments || "") + incoming;
      }
    } else if (key !== "index") {
      out[key] = clone(value);
    }
  }
  if (!own(out, "index") && Number.isInteger(delta && delta.index)) out.index = delta.index;
  if (!own(out, "index")) out.index = fallbackIndex;
  return out;
}

/*
 * Accumulate an OpenAI-compatible streaming delta without losing either
 * DeepSeek reasoning_content or OpenRouter reasoning_details. Reasoning detail
 * chunks are concatenated in provider order, as required for replay.
 */
export function mergeAssistantDelta(current, delta) {
  const out = clone(current || { role: "assistant" });
  const part = delta && typeof delta === "object" ? delta : {};
  out.role = "assistant";

  for (const key of ["content", "reasoning", "reasoning_content"]) {
    if (!own(part, key) || part[key] == null) continue;
    if (typeof part[key] === "string") out[key] = String(out[key] || "") + part[key];
    else if (Array.isArray(part[key])) out[key] = [...(Array.isArray(out[key]) ? out[key] : []), ...clone(part[key])];
    else out[key] = clone(part[key]);
  }

  if (Array.isArray(part.reasoning_details)) {
    out.reasoning_details = [
      ...(Array.isArray(out.reasoning_details) ? out.reasoning_details : []),
      ...clone(part.reasoning_details),
    ];
  }

  if (Array.isArray(part.tool_calls)) {
    const calls = Array.isArray(out.tool_calls) ? out.tool_calls.map((call) => clone(call)) : [];
    for (let position = 0; position < part.tool_calls.length; position++) {
      const call = part.tool_calls[position] || {};
      const index = Number.isInteger(call.index) ? call.index : position;
      calls[index] = normalizeToolCallDelta(calls[index], call, index);
    }
    out.tool_calls = calls.filter((call) => call != null);
  }

  // Preserve provider fields that are part of the assistant turn but do not
  // require concatenation.
  for (const key of ["name", "refusal", "audio"]) {
    if (own(part, key)) out[key] = clone(part[key]);
  }
  return out;
}

/*
 * Streaming-oriented sibling of mergeAssistantDelta(). It mutates a dedicated
 * per-request accumulator and clones only the incoming chunk, never the full
 * accumulated transcript. This keeps very large native output windows linear
 * instead of repeatedly copying all prior content on every token.
 */
export function accumulateAssistantDeltaInPlace(accumulator, delta) {
  const out = accumulator && typeof accumulator === "object"
    ? accumulator
    : { role: "assistant", content: "" };
  const part = delta && typeof delta === "object" ? delta : {};
  out.role = "assistant";

  for (const key of ["content", "reasoning", "reasoning_content"]) {
    if (!own(part, key) || part[key] == null) continue;
    if (typeof part[key] === "string") {
      out[key] = String(out[key] || "") + part[key];
    } else if (Array.isArray(part[key])) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(...clone(part[key]));
    } else {
      out[key] = clone(part[key]);
    }
  }

  if (Array.isArray(part.reasoning_details)) {
    if (!Array.isArray(out.reasoning_details)) out.reasoning_details = [];
    out.reasoning_details.push(...clone(part.reasoning_details));
  }

  if (Array.isArray(part.tool_calls)) {
    if (!Array.isArray(out.tool_calls)) out.tool_calls = [];
    for (let position = 0; position < part.tool_calls.length; position++) {
      const call = part.tool_calls[position] || {};
      const index = Number.isInteger(call.index) ? call.index : position;
      let target = out.tool_calls[index];
      if (!target || typeof target !== "object") {
        target = { index };
        out.tool_calls[index] = target;
      }
      for (const [key, value] of Object.entries(call)) {
        if (key === "index") continue;
        if (key !== "function" || !value || typeof value !== "object") {
          target[key] = clone(value);
          continue;
        }
        if (!target.function || typeof target.function !== "object") target.function = {};
        if (value.name) {
          const incoming = String(value.name);
          const prior = String(target.function.name || "");
          target.function.name = !prior || incoming === prior || prior.endsWith(incoming)
            ? (prior || incoming)
            : incoming.startsWith(prior)
              ? incoming
              : prior + incoming;
        }
        if (own(value, "arguments")) {
          target.function.arguments = String(target.function.arguments || "") + String(value.arguments ?? "");
        }
        for (const [functionKey, functionValue] of Object.entries(value)) {
          if (functionKey !== "name" && functionKey !== "arguments") {
            target.function[functionKey] = clone(functionValue);
          }
        }
      }
    }
  }

  for (const key of ["name", "refusal", "audio"]) {
    if (own(part, key)) out[key] = clone(part[key]);
  }
  return out;
}

/*
 * Project the exact assistant message that must precede tool results on the
 * next request. Both providers require tool_calls; DeepSeek additionally
 * requires reasoning_content, while OpenRouter may require reasoning_details.
 */
export function projectAssistantToolTurn(message) {
  const source = message && typeof message === "object" ? message : {};
  const out = { role: "assistant" };
  for (const key of [
    "content",
    "tool_calls",
    "reasoning_content",
    "reasoning",
    "reasoning_details",
    "name",
    "refusal",
    "audio",
  ]) {
    if (own(source, key)) out[key] = clone(source[key]);
  }
  return out;
}

export function projectProviderMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (message && message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      return projectAssistantToolTurn(message);
    }
    return clone(message);
  });
}

export function projectToolRound(assistant, toolResults = []) {
  const results = Array.isArray(toolResults) ? toolResults : [toolResults];
  return [projectAssistantToolTurn(assistant), ...results.map((result) => clone(result))];
}

function terminalRaw(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return input.finishReason
    || input.finish_reason
    || input.stopReason
    || input.stop_reason
    || input.incompleteReason
    || input.incomplete_reason
    || input.status
    || input.error && (input.error.code || input.error.type)
    || "";
}

/*
 * OpenRouter and other OpenAI-compatible providers can report an error inside
 * an HTTP-200 SSE stream. Transport status alone therefore cannot establish
 * success. Return a normalized, user-safe record for a top-level SSE error.
 */
export function extractProviderStreamError(event) {
  if (!event || typeof event !== "object" || !event.error) return null;
  const raw = event.error;
  const detail = raw && typeof raw === "object" ? raw : { message: String(raw) };
  const code = detail.code ?? detail.type ?? event.error_type ?? "stream_error";
  const message = String(detail.message || detail.error || code || "Provider stream error");
  const statusCandidate = Number(detail.status || detail.status_code || detail.code);
  const status = Number.isInteger(statusCandidate) && statusCandidate >= 400 && statusCandidate <= 599
    ? statusCandidate
    : 0;
  const combined = `${code} ${message}`.toLowerCase();
  const insufficient = /insufficient[_\s-]*system[_\s-]*resource|overload|capacity|unavailable/.test(combined);
  const retryable = insufficient
    || status === 408
    || status === 409
    || status === 429
    || status >= 500
    || /timeout|temporar|rate[_\s-]*limit|server[_\s-]*error|internal[_\s-]*error|network/.test(combined);
  return freeze({
    code: String(code || "stream_error"),
    message,
    status,
    retryable,
  });
}

function canonicalTerminalReason(value) {
  const reason = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!reason) return "";
  if (["stop", "end_turn", "completed", "complete", "success", "done"].includes(reason)) return "stop";
  if (["tool_calls", "tool_call", "function_call", "function_calls"].includes(reason)) return "tool_calls";
  if ([
    "length",
    "max_tokens",
    "max_output_tokens",
    "token_limit",
    "context_length",
    "context_length_exceeded",
    "incomplete",
  ].includes(reason)) return "length";
  if (["content_filter", "content_filtered", "safety", "blocked"].includes(reason)) return "content_filter";
  if ([
    "insufficient_system_resource",
    "insufficient_system_resources",
    "overloaded",
    "server_overloaded",
    "capacity",
  ].includes(reason)) return "insufficient_system_resource";
  if (["cancelled", "canceled", "aborted"].includes(reason)) return "cancelled";
  if (["error", "failed", "failure", "server_error", "internal_error"].includes(reason)) return "error";
  return reason;
}

/*
 * Normalize a provider generation boundary without mistaking "the request
 * ended" for "the user's task is complete".
 */
export function normalizeProviderTerminal(input = {}) {
  const source = typeof input === "object" && input != null ? input : {};
  const hasToolCalls = source.hasToolCalls === true
    || Array.isArray(source.toolCalls) && source.toolCalls.length > 0
    || Array.isArray(source.tool_calls) && source.tool_calls.length > 0;
  let reason = canonicalTerminalReason(terminalRaw(input));
  if (hasToolCalls && (!reason || reason === "stop")) reason = "tool_calls";

  let state = "unknown";
  let shouldContinue = false;
  let shouldRetry = false;
  let recoverable = false;
  let blocked = false;

  if (reason === "stop") {
    // A provider-level stop only says this generation ended. Dominion's
    // evidence gate, not a transport finish reason, decides task completion.
    state = "stopped";
  } else if (reason === "tool_calls") {
    state = "tool_calls";
    shouldContinue = true;
    recoverable = true;
  } else if (reason === "length") {
    state = "checkpoint";
    shouldContinue = true;
    recoverable = true;
  } else if (reason === "content_filter") {
    state = "blocked";
    blocked = true;
  } else if (reason === "insufficient_system_resource") {
    state = "error";
    shouldRetry = true;
    recoverable = true;
  } else if (reason === "cancelled") {
    state = "cancelled";
  } else if (reason === "error") {
    state = "error";
    const detail = String(
      source.error && (source.error.code || source.error.type || source.error.message)
      || source.errorType
      || "",
    ).toLowerCase();
    shouldRetry = /timeout|temporar|overload|capacity|rate|server|internal|unavailable|network/.test(detail);
    recoverable = shouldRetry;
  }

  return freeze({
    raw: String(terminalRaw(input) || ""),
    reason,
    state,
    providerCallComplete: !!reason,
    taskComplete: false,
    candidateFinal: reason === "stop",
    shouldContinue,
    shouldRetry,
    recoverable,
    blocked,
    needsToolExecution: reason === "tool_calls",
  });
}
