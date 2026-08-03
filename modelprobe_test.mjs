/*
 * modelprobe_test — drives the REAL probe with only globalThis.fetch stubbed, the same discipline
 * google_connect_test.mjs uses, so the assertions exercise the shipped decision logic rather than
 * a paraphrase of it.
 *
 * The case that matters most is the vision false-positive. The first version of this probe used a
 * 1x1 pixel and scored vision=true for gpt-oss-20b, a text-only model that simply ignored the
 * image block and answered anyway. An instrument built to prevent false findings had manufactured
 * one. That behaviour is pinned below so it cannot come back.
 */
import assert from "node:assert/strict";
import { probeModel, ENDPOINTS } from "./modelprobe.mjs";
import { MODELS } from "./models.catalog.mjs";

const realFetch = globalThis.fetch;

// Build an OpenAI-shaped chat completion response.
function chat({ text = "", toolCall = false, outTokens = 0, reasoningTokens = 0, finish = "stop" }) {
  const message = { role: "assistant", content: text };
  if (toolCall) message.tool_calls = [{ id: "c1", type: "function", function: { name: "write_note", arguments: '{"text":"HELLO"}' } }];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message, finish_reason: finish }],
      usage: { completion_tokens: outTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } },
    }),
  };
}

// Classify which of the probe's four questions a request is, from its body.
function stage(body) {
  if (body.tools) return "tools";
  const c = body.messages[0].content;
  if (Array.isArray(c)) return "image";
  if (/single word: ready/.test(c)) return "answers";
  return "reason";
}

async function withStub(handler, fn) {
  globalThis.fetch = async (_url, init) => handler(JSON.parse(init.body));
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

/* ---- 1. every provider in the catalog can actually be probed ------------------------------- */
const providers = [...new Set(MODELS.map((m) => m.provider || "openrouter"))];
for (const p of providers) {
  assert.ok(ENDPOINTS[p], `catalog provider '${p}' has no endpoint mapping, so its models can never be probed`);
}

/* ---- 2. the vision false positive stays dead ----------------------------------------------- */
const textOnly = await withStub(
  (body) => {
    const s = stage(body);
    // A text-only model does NOT reject the image. It answers around it. That HTTP 200 is exactly
    // what the 1x1 probe mistook for vision support.
    if (s === "image") return chat({ text: "I cannot determine that.", outTokens: 6 });
    if (s === "tools") return chat({ text: "", toolCall: true, outTokens: 8 });
    return chat({ text: "ready", outTokens: 2 });
  },
  () => probeModel({ provider: "nvidia", id: "test/text-only", key: "k" }),
);
assert.equal(textOnly.acceptsImage, true, "the payload was accepted, and the record should say so");
assert.equal(textOnly.seesImage, false, "a model that never names the colour did not look at the image");
assert.equal(textOnly.vision, false, "vision must track seesImage, not mere payload acceptance");
assert.ok(textOnly.notes.some((n) => /did not name the colour/.test(n)), "the near-miss must be explained in the record");

/* ---- 3. a real vision model is not punished for it ------------------------------------------ */
const sighted = await withStub(
  (body) => (stage(body) === "image" ? chat({ text: "Red", outTokens: 2 }) : chat({ text: "ready", outTokens: 2 })),
  () => probeModel({ provider: "nvidia", id: "test/sighted", key: "k" }),
);
assert.equal(sighted.seesImage, true, "naming the colour is the evidence that it looked");
assert.equal(sighted.vision, true, "vision must be true when the model actually sees");

/* ---- 4. starvation is detected, and the recovery ceiling is found --------------------------- */
const starver = await withStub(
  (body) => {
    const s = stage(body);
    if (s !== "reason") return chat({ text: "ready", outTokens: 2 });
    // Burns the whole allowance thinking until the ceiling is large enough to leave room to speak.
    if (body.max_tokens < 512) return chat({ text: "", outTokens: body.max_tokens, reasoningTokens: body.max_tokens, finish: "length" });
    return chat({ text: "Light both ends of one rope.", outTokens: 351, reasoningTokens: 300 });
  },
  () => probeModel({ provider: "nvidia", id: "test/starver", key: "k" }),
);
assert.equal(starver.budgetEater, true, "empty text with the output budget fully spent is starvation");
assert.equal(starver.recoversAt, 512, "the probe must report the smallest ceiling that yields text, since that is the floor to set");
assert.ok(starver.notes.some((n) => /recovers at max_tokens=512/.test(n)), "the recovery ceiling belongs in the record");

/* ---- 5. a healthy model is not accused ------------------------------------------------------ */
const healthy = await withStub(
  (body) => (stage(body) === "reason" ? chat({ text: "Light both ends.", outTokens: 40 }) : chat({ text: "ready", outTokens: 2 })),
  () => probeModel({ provider: "nvidia", id: "test/healthy", key: "k" }),
);
assert.equal(healthy.budgetEater, false, "a model that answers inside the ceiling is not starving");
assert.equal(healthy.recoversAt, null, "no recovery ceiling is reported when nothing starved");

/* ---- 6. prose about a tool is not a tool call ----------------------------------------------- */
const talker = await withStub(
  (body) => (stage(body) === "tools" ? chat({ text: "I would call write_note with HELLO.", outTokens: 12 }) : chat({ text: "ready", outTokens: 2 })),
  () => probeModel({ provider: "nvidia", id: "test/talker", key: "k" }),
);
assert.equal(talker.tools, false, "describing the tool in prose is a failure, not a pass; the Crucible needs a real call");

/* ---- 7. missing keys and unknown providers produce records, never throws --------------------- */
const noKey = await probeModel({ provider: "nvidia", id: "test/x", key: "" });
assert.equal(noKey.answers, false);
assert.match(noKey.err, /no key/, "a key gap must be recorded as a key gap, not as a model failure");

const unknown = await probeModel({ provider: "not-a-provider", id: "test/x", key: "k" });
assert.match(unknown.err, /no endpoint mapping/, "an unmapped provider must say so rather than crash the run");

/* ---- 8. a provider error is recorded verbatim and does not lose earlier findings -------------- */
const refuses = await withStub(
  (body) => {
    if (stage(body) === "image") return { ok: false, status: 400, json: async () => ({ error: { message: "ValueError: multimodal processing is not enabled" } }) };
    if (stage(body) === "tools") return chat({ text: "", toolCall: true, outTokens: 8 });
    return chat({ text: "ready", outTokens: 2 });
  },
  () => probeModel({ provider: "nvidia", id: "test/refuses-images", key: "k" }),
);
assert.equal(refuses.tools, true, "a 400 on the last question must not cost us the findings before it");
assert.equal(refuses.vision, false);
assert.ok(refuses.notes.some((n) => /multimodal processing is not enabled/.test(n)), "the provider's own words are the useful record");

console.log("modelprobe_test: 8 checks passed; the 1x1 vision false positive stays dead and starvation reports its recovery ceiling");
