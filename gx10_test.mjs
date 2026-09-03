/*
 * GX10 local lane + context-window fitting (2026-09-01).
 *
 * Locks four contracts:
 *   1. gx10.mjs translates OpenAI-dialect requests/responses to and from Ollama's native shapes
 *      exactly as the live GX10 probe showed them (object tool arguments, prompt_eval_count usage).
 *   2. The catalog's GX10 seats exist, are $0, tool-capable, and allowed in every privacy mode.
 *   3. fitManifestToBudget bounds a move's manifest to the routed model's window, largest file
 *      first, disclosing every cut and never dropping a file.
 *   4. squeezeOversizeMessages shrinks a single over-window message and marks the cut; the
 *      overflow detector recognizes real provider refusal strings.
 */
import assert from "node:assert/strict";
import { ollamaPayloadFromOpenAI, openAIResultFromOllama, parseToolArguments, gx10Failure } from "./gx10.mjs";
import { modelById, providerOf, isToolCapable, MODELS } from "./models.catalog.mjs";
import { modeAllows } from "./privacy.mjs";
import { fitManifestToBudget, manifestBudgetBytes, MANIFEST_WINDOW_FRACTION } from "./ideengine.mjs";
import { squeezeOversizeMessages, isContextOverflowError } from "./contextwindow.mjs";

// ---- 1. shape translation ---------------------------------------------------------------------
{
  const payload = ollamaPayloadFromOpenAI({
    model: "gpt-oss:20b",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "part one" }, { type: "image_url", image_url: { url: "data:x" } }, { type: "text", text: "part two" }] },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    num_predict: 4096,
    num_ctx: 32768,
    temperature: 0.2,
  });
  assert.equal(payload.model, "gpt-oss:20b");
  assert.equal(payload.stream, true);
  assert.equal(payload.messages[1].content, "part one\npart two", "content parts flatten to text");
  assert.deepEqual(payload.messages[2].tool_calls[0].function.arguments, { path: "a.ts" }, "assistant tool args become objects for Ollama");
  assert.equal(payload.messages[3].role, "tool");
  assert.equal(payload.options.num_predict, 4096);
  assert.equal(payload.options.num_ctx, 32768, "the catalog window bounds the KV allocation");
  assert.equal(payload.options.temperature, 0.2);
  assert.equal(payload.tools.length, 1);
}
{
  // The exact terminal shape the hands node returns (assembled /api/chat stream:false form),
  // tool arguments as an OBJECT per the live probe.
  const r = openAIResultFromOllama({
    model: "gpt-oss:20b", done: true, done_reason: "stop",
    prompt_eval_count: 131, eval_count: 48,
    message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Raleigh" } } }] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.finishReason, "tool_calls", "tool calls outrank done_reason stop");
  assert.equal(r.toolCalls[0].function.name, "get_weather");
  assert.equal(typeof r.toolCalls[0].function.arguments, "string", "OpenAI callers expect stringified arguments");
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { city: "Raleigh" });
  assert.equal(r.usage.prompt_tokens, 131);
  assert.equal(r.usage.completion_tokens, 48);
  assert.equal(r.usage.__transport, "gx10", "cost math must see the free transport");
  assert.ok(Array.isArray(r.assistantTurn.tool_calls), "the replay turn carries the calls");
}
{
  const r = openAIResultFromOllama({ done_reason: "length", eval_count: 10, message: { role: "assistant", content: "partial" } });
  assert.equal(r.finishReason, "length", "a length stop must reach the auto-continue path");
  assert.equal(r.content, "partial");
  assert.equal(parseToolArguments('{"a":1}').a, 1);
  assert.deepEqual(parseToolArguments("not json"), {});
  const f = gx10Failure("read ETIMEDOUT");
  assert.equal(f.ok, false);
  assert.equal(f.retryable, true, "a dead box must ride the retry/reroute ladder");
  assert.match(f.error, /GX10/);
}

// ---- 2. catalog seats -------------------------------------------------------------------------
{
  const seats = MODELS.filter((m) => m.provider === "gx10");
  assert.ok(seats.length >= 2, "the GX10 category has its two seats (120B and the coder; the 20B was retired 2026-09-03 to stop eviction thrash)");
  for (const seat of seats) {
    assert.equal(seat.inCost, 0, seat.id + " must be free");
    assert.equal(seat.outCost, 0, seat.id + " must be free");
    assert.equal(isToolCapable(seat.id), true, seat.id + " was tool-probed live and must stay marked");
    assert.equal(providerOf(seat.id), "gx10");
    assert.ok(seat.ctx >= 32_000, seat.id + " carries its resident-safe window (32k; 131k evicted the coder, 2026-09-03)");
    for (const mode of ["normal", "trusted", "private"]) {
      assert.equal(modeAllows(mode, seat.id).allowed, true, seat.id + " must be allowed in " + mode + " mode (it never leaves the house)");
    }
  }
  assert.equal(modelById("gx10/gpt-oss-120b").directId, "gpt-oss:120b");
  assert.equal(modelById("gx10/qwen3-coder-30b").directId, "qwen3-coder:30b");
}

// ---- 3. manifest fitting ----------------------------------------------------------------------
{
  const budget = manifestBudgetBytes(128_000);
  assert.ok(budget > 150_000 && budget < 128_000 * 3.6, "budget is a fraction of the window");
  assert.equal(manifestBudgetBytes(0), manifestBudgetBytes(128_000), "no ctx means the 128k default");
  assert.ok(Math.abs(budget - Math.floor(128_000 * MANIFEST_WINDOW_FRACTION * 3.6)) <= 1);

  const manifest = [
    { path: "small.ts", content: "x".repeat(5_000) },
    { path: "huge.ts", content: "y".repeat(400_000) },
    { path: "missing.ts", missing: true },
    { path: "mid.ts", content: "z".repeat(60_000) },
  ];
  const { manifest: fitted, trimmed, totalBytes } = fitManifestToBudget(manifest, 120_000);
  assert.ok(totalBytes <= 121_000, "the fitted manifest respects the budget (got " + totalBytes + ")");
  assert.equal(fitted.length, 4, "no file is dropped");
  assert.equal(fitted[0].content, manifest[0].content, "small files stay complete");
  assert.equal(fitted[2].missing, true);
  assert.ok(trimmed.some((t) => t.path === "huge.ts"), "the largest file is what gets trimmed");
  const huge = fitted.find((f) => f.path === "huge.ts");
  assert.match(huge.content, /manifest window/, "every cut is disclosed to the model");
  assert.equal(huge.truncated, true);

  const untouched = fitManifestToBudget(manifest.slice(0, 1), 120_000);
  assert.equal(untouched.trimmed.length, 0);
  assert.equal(untouched.manifest[0].content, manifest[0].content);
}

// ---- 4. squeeze + overflow detection ----------------------------------------------------------
{
  const msgs = [
    { role: "system", content: "rules" },
    { role: "user", content: "a".repeat(900_000) },
    { role: "assistant", content: "short" },
  ];
  const { messages: out, squeezed } = squeezeOversizeMessages(msgs, { contextTokens: 64_000 });
  assert.equal(squeezed, 1, "only the oversize message is touched");
  assert.equal(out[0].content, "rules");
  assert.equal(out[2].content, "short");
  assert.ok(out[1].content.length < msgs[1].content.length / 3, "the oversize message actually shrank");
  assert.match(out[1].content, /CONTEXT SQUEEZE/, "the cut is disclosed");
  assert.ok(out[1].content.startsWith("aaa"), "the head survives");
  assert.ok(out[1].content.endsWith("aaa"), "the tail survives");

  for (const s of [
    "This model's maximum context length is 64000 tokens",
    "Anthropic: prompt is too long: 210000 tokens > 200000 maximum",
    "the input is too long for requested model",
    "context_length_exceeded",
    "Request too large for gpt-4o",
  ]) assert.equal(isContextOverflowError(s), true, "must recognize: " + s);
  for (const s of ["rate limit exceeded", "read ETIMEDOUT", "insufficient_quota", ""]) {
    assert.equal(isContextOverflowError(s), false, "must not misfire on: " + s);
  }
}

console.log("gx10_test: all contracts hold");
