/*
 * MODEL PROBE — the instrument behind Phase A of docs/ASSISTANT-AND-BUILD-CORE-SOW.md.
 *
 * Fred's order, 2026-08-02: "we need to do the research for every single model, without fail and
 * not from memory, on how to form the calls and tools and language used and also token limitations
 * per turn that are imposed by it and not us."
 *
 * catalogaudit.mjs answers "does this id exist" by comparing lists. This answers "what does it
 * actually DO" by calling it. The two are different questions and a model can pass the first and
 * fail the second: gpt-oss-120b is on NVIDIA's list today and timed out when Wave 2 probed it.
 *
 * WHAT IT MEASURES, and why each one is here:
 *   answers        it responds at all
 *   tools          it emits a REAL tool call, not prose describing one. Pass/fail for the Crucible
 *   vision         it accepts an image
 *   reasoningTok   whether the provider reports hidden reasoning tokens
 *   budgetEater    whether reasoning tokens are spent from the OUTPUT budget. This is the
 *                  mechanism behind the recorded GPT-5.x starvation scar: give a reasoning model a
 *                  small output ceiling and it can burn the whole allowance thinking and return an
 *                  empty string. Altana is a reasoning model on short interactive turns, which is
 *                  precisely that combination, so this is measured rather than assumed
 *   maxOutAccepted the largest max_tokens the provider accepts without erroring, found by probe
 *   errShape       the provider's error text, kept verbatim so a future failure is recognisable
 *
 * EVIDENCE RULE (SOW Phase A): a live probe beats documentation, documentation beats recollection,
 * recollection does not count. Every record this writes carries the date it was taken. Anything it
 * could not establish stays null rather than being filled in with something plausible.
 *
 * Keys are passed in by the caller and never read, stored, or printed here.
 */

const UA = { "content-type": "application/json" };

/*
 * Endpoints. The OpenAI-compatible family covers five of seven providers, which is why the shape
 * below is the default path. VERIFIED LIVE 2026-08-03: nvidia and deepseek. The rest are the
 * documented endpoints and are marked as such per the evidence rule; a wrong base URL fails loudly
 * as a transport error rather than quietly as a model defect.
 */
export const ENDPOINTS = {
  nvidia:     { url: "https://integrate.api.nvidia.com/v1/chat/completions", family: "openai-chat", verified: "2026-08-03" },
  deepseek:   { url: "https://api.deepseek.com/v1/chat/completions",         family: "openai-chat", verified: "2026-08-03" },
  moonshot:   { url: "https://api.moonshot.ai/v1/chat/completions",          family: "openai-chat", verified: null },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions",        family: "openai-chat", verified: null },
  openai:     { url: "https://api.openai.com/v1/chat/completions",           family: "openai-chat", verified: null },
  anthropic:  { url: "https://api.anthropic.com/v1/messages",                family: "anthropic",   verified: null },
  google:     { url: "https://generativelanguage.googleapis.com/v1beta",     family: "google",      verified: null },
};

/*
 * An 8x8 solid RED png, 74 bytes.
 *
 * Deliberately NOT the 1x1 pixel fleet_probe uses. A 1x1 proves only that the provider accepted an
 * image payload without erroring, which a text-only model happily does by ignoring the image block
 * and answering anyway. That yields vision=true for models that cannot see, which is a false
 * finding, and this instrument exists to avoid producing those. A solid colour the model must
 * NAME is the difference between "did not reject the payload" and "actually looked at it", and the
 * two are recorded as separate fields below.
 */
const RED_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=";

const TOOL_DEF = [{
  type: "function",
  function: {
    name: "write_note",
    description: "Write a short note to the user's notebook.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
}];

// The same tool in Anthropic's shape. The difference is exactly the kind of "language used"
// divergence Phase A exists to record: OpenAI nests under function{}, Anthropic is flat.
const TOOL_DEF_ANTHROPIC = [{
  name: "write_note",
  description: "Write a short note to the user's notebook.",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}];

/*
 * A prompt that CANNOT be answered without some working out. A reasoning model will think before
 * it speaks; if that thinking is billed to the output budget, a small ceiling leaves nothing for
 * the answer and the content comes back empty. That empty string is the measurement.
 */
const REASON_PROMPT = "A rope burns unevenly in exactly 60 minutes. Using two such ropes, how do you measure 45 minutes? Answer in one sentence.";

const TIMEOUT_MS = 75000;   // reasoning models think before one word, and a free tier can queue

function headersFor(provider, key) {
  if (provider === "anthropic") return { ...UA, "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (provider === "google") return { ...UA };
  return { ...UA, authorization: "Bearer " + key };
}

async function post(url, headers, body, signal) {
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

// Pull the provider's error message out of whichever envelope it used.
function errText(status, j) {
  const e = j && (j.error || j.detail || j.message);
  const msg = typeof e === "string" ? e : (e && (e.message || e.detail)) || "";
  return (msg || ("HTTP " + status)).slice(0, 160);
}

/* ---- per-family calls -------------------------------------------------------------------- */

async function callOpenAiChat({ url, headers, id, messages, maxOut, tools, signal }) {
  const body = { model: id, messages, max_tokens: maxOut };
  if (tools) { body.tools = TOOL_DEF; body.tool_choice = "auto"; }
  const { status, j } = await post(url, headers, body, signal);
  const choice = j.choices && j.choices[0];
  const msg = choice && choice.message;
  const u = j.usage || {};
  return {
    status,
    ok: status === 200 && !!choice,
    text: String((msg && msg.content) || ""),
    toolCalls: (msg && msg.tool_calls) || [],
    finish: (choice && choice.finish_reason) || "",
    outTokens: Number(u.completion_tokens ?? u.output_tokens) || 0,
    // OpenAI nests reasoning under completion_tokens_details; DeepSeek surfaces reasoning_content
    // on the message instead. Both are checked because both are shapes Dominion already handles.
    reasonTokens: Number((u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0)
      || (msg && typeof msg.reasoning_content === "string" ? -1 : 0),
    err: status === 200 ? "" : errText(status, j),
  };
}

async function callAnthropic({ url, headers, id, messages, maxOut, tools, signal }) {
  const body = { model: id, max_tokens: maxOut, messages };
  if (tools) body.tools = TOOL_DEF_ANTHROPIC;
  const { status, j } = await post(url, headers, body, signal);
  const blocks = Array.isArray(j.content) ? j.content : [];
  const u = j.usage || {};
  return {
    status,
    ok: status === 200 && blocks.length > 0,
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
    toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ function: { name: b.name } })),
    finish: j.stop_reason || "",
    outTokens: Number(u.output_tokens) || 0,
    reasonTokens: blocks.some((b) => b.type === "thinking") ? -1 : 0,
    err: status === 200 ? "" : errText(status, j),
  };
}

/* ---- the probe --------------------------------------------------------------------------- */

/*
 * Returns a record for one model. Never throws: a provider that refuses, times out, or answers in
 * a shape we do not recognise produces a record saying so, because "we could not establish this"
 * is a finding and a crash is not.
 */
export async function probeModel({ provider, id, wireId, key, label = "" }) {
  const ep = ENDPOINTS[provider];
  const rec = {
    catalogId: id,
    wireId: wireId || id,
    provider,
    label,
    probedAt: new Date().toISOString(),
    endpoint: ep ? ep.url : null,
    family: ep ? ep.family : null,
    endpointVerified: ep ? ep.verified : null,
    answers: false,
    tools: null,
    acceptsImage: null,   // the payload was not rejected
    seesImage: null,      // the model named the colour, so it actually looked
    vision: null,         // alias of seesImage: the one the catalog's flag should match
    reasoningReported: null,
    budgetEater: null,
    recoversAt: null,     // smallest max_tokens that still yields visible text, when it starves
    outTokensAtCeiling: null,
    finishAtCeiling: null,
    err: "",
    notes: [],
  };
  if (!ep) { rec.err = "no endpoint mapping for provider '" + provider + "'"; return rec; }
  if (!key) { rec.err = "no key for provider '" + provider + "'"; return rec; }
  if (ep.family === "google") { rec.err = "google probe not implemented: no AI Studio key existed to verify the shape against"; return rec; }

  const headers = headersFor(provider, key);
  const call = ep.family === "anthropic" ? callAnthropic : callOpenAiChat;
  const run = (opts) => call({ url: ep.url, headers, id: rec.wireId, signal: AbortSignal.timeout(TIMEOUT_MS), ...opts });

  try {
    // 1. Does it answer at all?
    const a = await run({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxOut: 64 });
    rec.answers = a.ok && a.text.trim().length > 0;
    if (!a.ok) { rec.err = a.err; return rec; }
    if (!rec.answers) rec.notes.push("HTTP 200 with empty content on a trivial prompt");

    // 2. Does it emit a REAL tool call? Prose describing the tool is a failure, not a pass.
    const t = await run({ messages: [{ role: "user", content: "Write the note HELLO using the tool." }], maxOut: 128, tools: true });
    rec.tools = !!(t.toolCalls.length && t.toolCalls[0].function && /write_note/.test(t.toolCalls[0].function.name));
    if (t.status !== 200) rec.notes.push("tool probe: " + t.err);

    /*
     * 3. Reasoning budget. A deliberately tight ceiling on a prompt that needs working out.
     * Empty text plus output tokens at the ceiling means the thinking consumed the answer's
     * allowance. That is the starvation mechanism, measured rather than assumed.
     */
    const r = await run({ messages: [{ role: "user", content: REASON_PROMPT }], maxOut: 64 });
    rec.reasoningReported = r.reasonTokens !== 0;
    rec.outTokensAtCeiling = r.outTokens || null;
    rec.finishAtCeiling = r.finish || null;
    if (r.status === 200) {
      const starved = r.text.trim().length === 0 && r.outTokens >= 48;
      rec.budgetEater = starved;
      if (starved) {
        rec.notes.push("STARVATION: spent " + r.outTokens + " output tokens and returned no text at a 64-token ceiling");
        /*
         * The actionable number. Knowing a model starves is only half an answer; what a builder
         * needs is the ceiling at which it stops starving, because that is the floor to set for it.
         * Fred's ask, 2026-08-02: "token limitations per turn that are imposed by it and not us."
         * Climb until text appears. If it never does, the model is unusable for short turns and
         * that is a finding too.
         */
        for (const ceiling of [256, 512, 1024, 2048]) {
          const c = await run({ messages: [{ role: "user", content: REASON_PROMPT }], maxOut: ceiling });
          if (c.status === 200 && c.text.trim().length > 0) {
            rec.recoversAt = ceiling;
            rec.notes.push("recovers at max_tokens=" + ceiling + " (spent " + c.outTokens + ", finish=" + (c.finish || "?") + ")");
            break;
          }
        }
        if (!rec.recoversAt) rec.notes.push("produced no text at any ceiling up to 2048: unusable for short interactive turns");
      }
    } else {
      rec.notes.push("reasoning probe: " + r.err);
    }

    /*
     * 4. Vision, measured in two parts because they are two different facts.
     * acceptsImage: the payload was not rejected. seesImage: the model NAMED the colour, which is
     * the only evidence it actually looked. A text-only model commonly scores true on the first
     * and false on the second, and reporting that as "vision" would be a false finding.
     * Last in the sequence because a 400 here must not cost us the three findings above.
     */
    const v = await run({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: RED_PNG } }, { type: "text", text: "What colour is this image? Answer with one word." }] }], maxOut: 32 });
    rec.acceptsImage = v.ok;
    rec.seesImage = v.ok ? /\bred\b|crimson|scarlet/i.test(v.text) : false;
    rec.vision = rec.seesImage;
    if (v.ok && !rec.seesImage) rec.notes.push("accepted the image payload but did not name the colour; answered: " + JSON.stringify(v.text.trim().slice(0, 60)));
    if (!v.ok && v.err) rec.notes.push("image probe: " + v.err);
  } catch (e) {
    rec.err = String((e && e.message) || e).slice(0, 160);
    if (/abort|timeout/i.test(rec.err)) rec.notes.push("timed out at " + TIMEOUT_MS + "ms");
  }
  return rec;
}
