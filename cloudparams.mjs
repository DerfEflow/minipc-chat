/*
 * Dominion AI — per-provider request shaping for the cloud chat path.
 *
 * Two jobs, both born from live user errors (Fred, 2026-07-19):
 *
 * 1. shapeCloudParams(): form every request the way THIS provider/model actually accepts it
 *    before it leaves the box. Known realities encoded here:
 *      - OpenAI's gpt-5.x / o-series run a FIXED sampling temperature; any explicit value except
 *        the default is rejected with 400 "Unsupported value: 'temperature'". The parameter is
 *        omitted for that family (their behavior is identical to sending the default).
 *      - Anthropic's API accepts temperature 0..1 only; Dominion's creativity slider reaches 1.2,
 *        so values are clamped into range rather than bounced by the provider.
 *      - Everyone else speaks the OpenAI dialect where 0..2 is the documented range — clamp.
 *      - Function-tool arrays are capped at 128 entries: OpenAI enforces exactly that
 *        ("maximum length 128"), and no catalog model benefits from more. Box tools are listed
 *        first at the call site, so the cap sheds tail-end connector tools, never core capability.
 *
 * 2. paramRetryAdjust(): the safety net for the quirks we have NOT met yet. When a provider
 *    rejects a request with a 400 that names a parameter, this builds a corrected payload for ONE
 *    resend: drop the named sampling knob, rename max_tokens <-> max_completion_tokens, or trim
 *    the tools array to the provider's stated maximum. A 400 bills nothing, so the retry is free;
 *    the adjustment is logged so the permanent rule can be added here later.
 */

export const TOOL_CAP = 128;

// OpenAI models whose sampling temperature is fixed (the parameter is rejected, only the
// default is served): the gpt-5 family and the o-series reasoning models.
const OPENAI_FIXED_TEMP = /^(gpt-5|o\d)/;

export function shapeCloudParams({ provider, directId, temperature, tools }) {
  const out = { temperature: undefined, tools: null, toolsDropped: 0 };

  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    if (provider === "openai" && OPENAI_FIXED_TEMP.test(String(directId || ""))) {
      out.temperature = undefined;                       // fixed-temp family: omit entirely
    } else if (provider === "anthropic") {
      out.temperature = Math.min(1, Math.max(0, temperature));
    } else {
      out.temperature = Math.min(2, Math.max(0, temperature));
    }
  }

  if (Array.isArray(tools) && tools.length) {
    if (tools.length > TOOL_CAP) {
      out.tools = tools.slice(0, TOOL_CAP);
      out.toolsDropped = tools.length - TOOL_CAP;
    } else {
      out.tools = tools;
    }
  }
  return out;
}

// Given a provider's 400 error message and the payload that earned it, produce a corrected
// payload for one retry, or null when the message names nothing we know how to fix.
// Never mutates the original payload.
export function paramRetryAdjust(payload, errorMessage) {
  const msg = String(errorMessage || "");
  if (!msg) return null;
  const p = { ...payload };
  const notes = [];

  if (/temperature/i.test(msg) && "temperature" in p) {
    delete p.temperature;
    notes.push("temperature removed");
  }
  if (/top_p/i.test(msg) && "top_p" in p) {
    delete p.top_p;
    notes.push("top_p removed");
  }
  if (/max_completion_tokens/i.test(msg) && "max_tokens" in p) {
    p.max_completion_tokens = p.max_tokens;
    delete p.max_tokens;
    notes.push("max_tokens renamed to max_completion_tokens");
  } else if (/max_completion_tokens/i.test(msg) && "max_completion_tokens" in p && /unsupported|unknown|unrecognized/i.test(msg)) {
    p.max_tokens = p.max_completion_tokens;
    delete p.max_completion_tokens;
    notes.push("max_completion_tokens renamed to max_tokens");
  }
  if (/reasoning_effort/i.test(msg) && "reasoning_effort" in p) {
    delete p.reasoning_effort;
    notes.push("reasoning_effort removed");
  }
  // "Invalid 'tools': array too long. Expected an array with maximum length 128, but got 198."
  const lenM = /maximum length (\d+)/i.exec(msg);
  if (lenM && Array.isArray(p.tools) && /tool|function/i.test(msg)) {
    const cap = Math.max(1, parseInt(lenM[1], 10));
    if (p.tools.length > cap) {
      p.tools = p.tools.slice(0, cap);
      notes.push("tools trimmed to " + cap);
    }
  }

  return notes.length ? { payload: p, note: notes.join(", ") } : null;
}
