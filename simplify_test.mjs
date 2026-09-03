/*
 * Lane I self-test — run with: node simplify_test.mjs
 *
 * LADDER REWRITE (STABILIZE Step 1, 2026-09-03): every route used to resolve to exactly one model
 * (resolveRouteModel); it now resolves to a ladder of live rungs (resolveLadder) that the request
 * handler tries in order, skipping any rung that fails. Tests 1-2 below replace the old
 * "every route resolves to exactly one model" check with "every route resolves to >=1 live rungs,
 * from >=3 named candidates, none of them a dead id". No live network calls: rungs are proven live
 * by catalog membership, and the skip-on-failure MECHANISM is proven with a mocked local HTTP
 * server standing in for the provider (tests 8-11).
 *
 *   1. Every route's ladder has >= 3 named candidates, and resolveLadder resolves at least one of
 *      them to a live catalog id right now.
 *   2. A rung the live catalog audit has marked unavailable is dropped by resolveLadder, and the
 *      route still has a live rung left over (this is the "fallback seat substitution" proof: the
 *      route keeps answering through the NEXT rung, not through the dead one).
 *   3. Sample questions land on the expected route (subject-matter classification), including the
 *      four STABILIZE probe prompts (roofing, photosynthesis, LLC vs S-corp, giving up on a business).
 *   4. pickRoute/classifyTopic never throw on hostile input.
 *   5. The websearch route really uses the app's existing web_search tool (tools.mjs).
 *   6. dominion-simplify.js exposes no model picker to the user.
 *   7. dominion-simplify.css is structurally well-formed.
 *   8. The full handler: a rung that 410s is skipped and the NEXT rung serves the answer, with a
 *      `served` event naming it — no `error` event.
 *   9. Every rung failing in both ladder passes (a 3s pause between them) produces exactly one
 *      calm, plain `error` event — never a raw provider string.
 *  10. The safety route's system prompt is the care-first one, regardless of which rung answers.
 *  11. The websearch route: search context reaches rung 1's prompt when available; when search is
 *      unavailable, EVERY rung's prompt carries the honest "search was not available" disclosure.
 *  12. A gx10 rung with no GX10_LLM_URL configured fails instantly (no fetch, no timeout wait) and
 *      the ladder moves on immediately.
 *  13. No session budget (Fred, 2026-08-03) and every turn is metered per-tenant — unchanged by the
 *      rewrite, still pinned here because the route dispatch block in server.mjs did not move.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODEL_IDS, isCatalogModel, setUnavailableSeats } from "./models.catalog.mjs";
import { toolDefs } from "./tools.mjs";
import { SIMPLIFY_ROUTES, resolveLadder, classifyTopic, pickRoute, createSimplifyChatHandler } from "./simplify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

// ---- 1: every route's ladder has >= 3 candidates and resolves live right now --------------------

for (const routeKey of Object.keys(SIMPLIFY_ROUTES)) {
  await t(`SIMPLIFY_ROUTES.${routeKey}.ladder has at least 3 named candidates`, () => {
    const ladder = SIMPLIFY_ROUTES[routeKey].ladder;
    assert.ok(Array.isArray(ladder) && ladder.length >= 3, `"${routeKey}" ladder has ${ladder && ladder.length} rung(s), need >= 3`);
  });
  await t(`resolveLadder("${routeKey}") resolves at least one live catalog rung`, () => {
    const r = resolveLadder(routeKey);
    assert.ok(r.ok, r.error || "");
    assert.ok(r.rungs.length >= 1, `"${routeKey}" resolved zero live rungs: dropped=${JSON.stringify(r.dropped)}`);
    for (const id of r.rungs) {
      assert.ok(isCatalogModel(id), `rung "${id}" for route "${routeKey}" is not a live catalog id`);
      assert.ok(MODEL_IDS.has(id));
    }
  });
}

await t("unknown route key is reported, never silently invented", () => {
  const r = resolveLadder("not-a-real-route");
  assert.equal(r.ok, false);
  assert.deepEqual(r.rungs, []);
});

// ---- 2: a seat the live audit marks unavailable is dropped, and the route still has a live rung -

await t("a rung the catalog audit marked unavailable is dropped by resolveLadder (fallback seat substitution)", () => {
  const before = resolveLadder("business");
  assert.ok(before.rungs.includes("deepseek/deepseek-v4-pro"), "business's first rung should normally be deepseek-v4-pro");
  try {
    setUnavailableSeats({ "deepseek/deepseek-v4-pro": "live probe: HTTP 410 (test)" });
    const after = resolveLadder("business");
    assert.ok(!after.rungs.includes("deepseek/deepseek-v4-pro"), "the unavailable rung must be dropped");
    assert.ok(after.rungs.length >= 1, "the route must still have a live rung to fall back to");
    assert.ok(after.dropped.some((d) => d.resolved === "deepseek/deepseek-v4-pro" && /unavailable/.test(d.reason)));
  } finally {
    setUnavailableSeats({});   // never leak audit state into later tests in this file
  }
});

// ---- 3: sample questions land on the expected route ---------------------------------------------

const SAMPLES = [
  ["hi", "quick"],
  ["what's 2+2", "quick"],
  ["solve for x: 2x + 3 = 7", "science"],
  ["can you help me find the derivative of x^2 + 3x", "science"],
  ["should I raise my prices this quarter, my revenue has been flat", "business"],
  ["I want to kill myself", "safety"],
  ["I've been feeling really anxious and overwhelmed about my job lately", "empathetic"],
  ["write me a short story about a lighthouse keeper", "literary"],
  ["Write me a short poem about autumn leaves.", "literary"],
  ["write me a two line poem for a birthday card", "literary"],
  ["can you write us an epic haiku about roofing", "literary"],
  ["help me brainstorm a creative idea for a birthday party", "creative"],
  ["is there a god, and what is the meaning of life", "theological"],
  ["what's the weather in Denver right now", "websearch"],
  ["what's today's stock price for a company I follow", "websearch"],
  // The four STABILIZE probe prompts (docs/STABILIZE-2026-09-03-DEFICIENCIES.md #1, LANE-simplify.md
  // required behavior #2). "quick or business" for the roofing definition is spec-sanctioned either
  // way; the other three each need exactly one route.
  ["what is a roofing contractor", ["quick", "business"]],
  ["can you explain photosynthesis to me", "science"],
  ["LLC vs S-corp, which should I pick for my roofing company", "business"],
  ["I feel like giving up on my business", "empathetic"],
];

for (const [text, expected] of SAMPLES) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  await t(`pickRoute(${JSON.stringify(text)}) -> ${expectedList.join(" or ")}`, () => {
    const picked = pickRoute(text);
    assert.ok(expectedList.includes(picked.route), `got "${picked.route}" (topic="${picked.topic}", band="${picked.complexity && picked.complexity.band}")`);
  });
}

await t("a long, general question with no specialist topic lands on chat", () => {
  const picked = pickRoute("Could you walk me through the tradeoffs between renting and buying a home over the next ten years, considering interest rates and my own situation in detail");
  assert.equal(picked.route, "chat");
});

// ---- 4: never throws on hostile input -------------------------------------------------------------

const HOSTILE_INPUTS = [null, undefined, 0, 42, NaN, "", "🔥🔥🔥 emoji only 🔥🔥🔥", { nested: { junk: [1, 2, { a: "b" }] } }, ["array", "not", "string"], true, false];

for (const bad of HOSTILE_INPUTS) {
  await t(`classifyTopic(${JSON.stringify(bad)}) never throws`, () => {
    assert.doesNotThrow(() => classifyTopic(bad));
  });
  await t(`pickRoute(${JSON.stringify(bad)}) never throws and returns a route`, () => {
    let picked;
    assert.doesNotThrow(() => { picked = pickRoute(bad); });
    assert.ok(typeof picked.route === "string" && SIMPLIFY_ROUTES[picked.route], "must resolve to a real route key");
  });
}

// ---- 5: websearch really uses the app's existing tool, not an invented one -----------------------

await t("the websearch route names a tool that actually exists in tools.mjs", () => {
  const route = SIMPLIFY_ROUTES.websearch;
  assert.equal(route.tool, "web_search");
  const defs = toolDefs();
  const names = defs.map((d) => d.function && d.function.name);
  assert.ok(names.includes("web_search"), "tools.mjs no longer defines web_search — the websearch route would be faking it");
});

// ---- 6: the surface exposes no model picker --------------------------------------------------------

await t("dominion-simplify.js renders no model picker and no model name to the user", () => {
  const src = readFileSync(join(__dirname, "public", "dominion-simplify.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/<select[^>]*model/i.test(code), "found a <select> that looks like a model picker");
  assert.ok(!/createElement\(\s*["']select["']\s*\)/i.test(code), "found code building a <select> element");
  assert.ok(!/optgroup/i.test(code), "found optgroup markup (the main app's model picker uses this) — Simplify must not build one");
  assert.ok(!/\bmodelSel\b|\bmodel[-_]?id\b\s*[:=]/i.test(code), "found a model-selection variable — this surface must never expose one");
});

// ---- 7: the CSS is structurally well-formed ---------------------------------------------------------

await t("dominion-simplify.css has balanced braces and no dangling rule", () => {
  const src = readFileSync(join(__dirname, "public", "dominion-simplify.css"), "utf8");
  const opens = (src.match(/\{/g) || []).length;
  const closes = (src.match(/\}/g) || []).length;
  assert.equal(opens, closes, `unbalanced braces: ${opens} "{" vs ${closes} "}"`);
  assert.ok(opens > 0, "file has no rules at all");
  assert.ok(!/\/\*(?:(?!\*\/)[\s\S])*$/.test(src), "unterminated /* comment at end of file");
});

// ---- test harness: drive the real handler against a mocked provider, no real network -------------

/** A fake IncomingMessage carrying a JSON body; readCappedBody reads it via 'data'/'end'. */
function fakeReq(bodyObj) {
  const req = new EventEmitter();
  process.nextTick(() => { req.emit("data", Buffer.from(JSON.stringify(bodyObj))); req.emit("end"); });
  return req;
}
/** A fake ServerResponse that captures every SSE frame written. */
function fakeRes() {
  const chunks = [];
  let ended = false;
  return {
    writeHead() {}, write(s) { chunks.push(s); return true; }, end() { ended = true; },
    events() {
      return chunks.join("").split("\n\n").filter((f) => f.startsWith("data: "))
        .map((f) => { try { return JSON.parse(f.slice(6)); } catch { return null; } }).filter(Boolean);
    },
    isEnded() { return ended; },
  };
}
/** Minimal OpenAI-dialect SSE responder: streams `text` as one chunk, then [DONE]. */
function sseReply(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}
/** Minimal Anthropic Messages SSE responder (anthropicmessages.mjs's real event shapes). */
function anthropicSseReply(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  frame({ type: "message_start", message: { content: [] } });
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  frame({ type: "content_block_stop", index: 0 });
  frame({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  frame({ type: "message_stop" });
  res.end();
}

async function withMockProvider(handlerFn, testFn) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch {} seen.push(body); handlerFn(req, res, body); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try { return await testFn({ port, seen }); }
  finally { await new Promise((r) => srv.close(r)); }
}

// ---- 8: a 410 rung is skipped; the next rung serves; no error event -------------------------------

await t("a rung that 410s is skipped, the next rung serves, and a `served` event names it", async () => {
  await withMockProvider(
    (req, res, body) => {
      if (body.model === "deepseek-v4-pro") { res.writeHead(410, { "content-type": "application/json" }); res.end('{"error":"has reached its end of life"}'); return; }
      sseReply(res, "Raise prices carefully.");
    },
    async ({ port }) => {
      const env = {
        DEEPSEEK_URL: `http://127.0.0.1:${port}/chat/completions`, DEEPSEEK_API_KEY: "test-ds",
        NVIDIA_URL: `http://127.0.0.1:${port}/v1/chat/completions`, NVIDIA_API_KEY: "test-nv",
      };
      const handler = createSimplifyChatHandler({ env });
      const req = fakeReq({ message: "should I raise my prices this quarter, my revenue has been flat", history: [] });
      const res = fakeRes();
      await handler(req, res, {});
      const evs = res.events();
      assert.ok(!evs.some((e) => e.type === "error"), "no error event should fire when a later rung serves: " + JSON.stringify(evs));
      const served = evs.find((e) => e.type === "served");
      assert.ok(served, "no served event: " + JSON.stringify(evs));
      assert.equal(served.model, "nvidia/nemotron-3-super-120b-a12b:free", "business's rung 2 should have served after rung 1's 410");
      assert.equal(served.route, "business");
      const text = evs.filter((e) => e.type === "delta").map((e) => e.text).join("");
      assert.equal(text, "Raise prices carefully.");
    },
  );
});

// ---- 9: every rung of both ladder passes failing produces one calm error event --------------------

await t("every rung failing (both ladder passes) produces exactly one calm error event, never a raw provider string", async () => {
  await withMockProvider(
    (req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"upstream exploded, raw and ugly"}'); },
    async ({ port, seen }) => {
      /*
       * "hi" classifies to "quick": gx10/gpt-oss-120b -> deepseek/deepseek-v4-flash ->
       * anthropic/claude-haiku-4-5. No GX10_LLM_URL and no ANTHROPIC_API_KEY here, so those two
       * rungs fail INSTANTLY (no fetch, no timeout wait) on both passes; only the deepseek rung
       * ever reaches the mock, which always 500s. That makes the whole ladder fail end to end
       * without this test waiting out a real 20s/12s first-token timeout anywhere.
       */
      const handler = createSimplifyChatHandler({ env: { DEEPSEEK_URL: `http://127.0.0.1:${port}/chat/completions`, DEEPSEEK_API_KEY: "test-ds" } });
      const req = fakeReq({ message: "hi", history: [] });
      const res = fakeRes();
      const t0 = Date.now();
      await handler(req, res, {});
      const elapsedMs = Date.now() - t0;
      const evs = res.events();
      const errors = evs.filter((e) => e.type === "error");
      assert.equal(errors.length, 1, "exactly one error event: " + JSON.stringify(evs));
      assert.equal(errors[0].message, "I couldn't get an answer just now. Please try again in a moment.");
      assert.ok(!/upstream exploded|HTTP 500/.test(errors[0].message), "the raw provider string must never reach the user");
      // Proof the whole ladder was retried once after the 3s pause, not just tried once: the mock
      // saw the deepseek rung twice (gx10 has no URL so it's skipped both passes without a request).
      const dsHits = seen.filter((b) => b.model === "deepseek-v4-flash").length;
      assert.equal(dsHits, 2, "the deepseek rung should have been attempted once per ladder pass: " + dsHits);
      assert.ok(elapsedMs >= 2900, `the 3s pause between passes should be honored (took ${elapsedMs}ms)`);
    },
  );
});

// ---- 10: safety route uses the care-first system prompt regardless of which rung answers ----------

await t("the safety route's system prompt is care-first, whichever rung answers", async () => {
  // safety's ladder is haiku -> sonnet -> deepseek-flash; leaving ANTHROPIC_API_KEY unset makes
  // rungs 1-2 fail instantly ("no key"), so rung 3 (deepseek, mocked here) is the one that answers
  // and we can inspect exactly what system prompt reached it.
  await withMockProvider(
    (req, res, body) => sseReply(res, "I hear you."),
    async ({ port, seen }) => {
      const handler = createSimplifyChatHandler({ env: { DEEPSEEK_URL: `http://127.0.0.1:${port}/chat/completions`, DEEPSEEK_API_KEY: "test-ds" } });
      const req = fakeReq({ message: "I want to kill myself", history: [] });
      const res = fakeRes();
      await handler(req, res, {});
      assert.ok(seen.length >= 1, "the deepseek mock never received a request");
      const sys = seen[0].messages.find((m) => m.role === "system");
      assert.match(sys.content, /distress or crisis/i, "the safety route must use the care-first system prompt");
      assert.match(sys.content, /988/, "the care-first prompt should point toward a crisis line");
    },
  );
});

// ---- 11: websearch search context / honest disclosure ----------------------------------------------

await t("websearch: with no SERP key at all, every rung skips search and discloses it honestly", async () => {
  // No SERP_API_KEY: searchOk is false BEFORE any model is tried, so buildRungSpecs marks every
  // rung disclose:true (not just the last) — proven here by failing the first two rungs (haiku,
  // sonnet) with HTTP 500 and inspecting all three captured request bodies for the disclosure text,
  // not just the one that finally answers.
  let hits = 0;
  await withMockProvider(
    (req, res, body) => {
      hits++;
      if (hits < 3) { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"down"}'); return; }
      anthropicSseReply(res, "Here's what I know, though I could not check live search this time.");
    },
    async ({ port, seen }) => {
      const handler = createSimplifyChatHandler({ env: { ANTHROPIC_API_KEY: "test-anthropic", ANTHROPIC_URL: `http://127.0.0.1:${port}/v1/messages` } });
      const req = fakeReq({ message: "what's the weather in Denver right now", history: [] });
      const res = fakeRes();
      await handler(req, res, {});
      const evs = res.events();
      const served = evs.find((e) => e.type === "served");
      assert.ok(served, "no served event: " + JSON.stringify(evs));
      assert.equal(served.route, "websearch");
      assert.equal(seen.length, 3, "all three websearch rungs should have been attempted");
      for (const body of seen) {
        const systemText = (Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : String(body.system || ""));
        assert.match(systemText, /search was not available/i, "every rung must disclose the missing search honestly, not just the last");
        assert.doesNotMatch(systemText, /Live web search results/, "a rung with no search must not claim to carry results");
      }
    },
  );
});

// ---- 12: a gx10 rung with no GX10_LLM_URL fails instantly, no timeout wait ------------------------

await t("a gx10 rung with no GX10_LLM_URL configured is skipped instantly, not after a 12s wait", async () => {
  await withMockProvider(
    (req, res, body) => { sseReply(res, "Two plus two is four."); },
    async ({ port }) => {
      // "quick" ladder: gx10/gpt-oss-120b -> deepseek/deepseek-v4-flash -> haiku. GX10_LLM_URL is
      // unset, so the gx10 rung must fail without ever calling fetch (resolveTransport's
      // `unavailable: true` short-circuit in attemptRung), leaving time for deepseek to answer fast.
      const handler = createSimplifyChatHandler({ env: { DEEPSEEK_URL: `http://127.0.0.1:${port}/chat/completions`, DEEPSEEK_API_KEY: "test-ds" } });
      const req = fakeReq({ message: "what's 2+2", history: [] });
      const res = fakeRes();
      const t0 = Date.now();
      await handler(req, res, {});
      const elapsedMs = Date.now() - t0;
      const evs = res.events();
      const served = evs.find((e) => e.type === "served");
      assert.ok(served, "no served event: " + JSON.stringify(evs));
      assert.equal(served.model, "deepseek/deepseek-v4-flash");
      assert.ok(elapsedMs < 5000, `gx10's skip must be near-instant, took ${elapsedMs}ms`);
    },
  );
});

// ---- summary (part 1) -------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed (part 1)`);

/* ---- Simplify carries NO session budget, by Fred's decision ---------------------------------- */
await t("no session budget is ever created for Simplify (Fred, 2026-08-03)", () => {
  const src = readFileSync(new URL("./simplify.mjs", import.meta.url), "utf8");
  for (const forbidden of ["sessionBudgets", "sessionBudget", "ensure(", "recordSpend"]) {
    assert.ok(!src.includes(forbidden), `simplify.mjs must not touch budgets, found "${forbidden}"`);
  }
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const rawRoute = server.slice(server.indexOf('path === "/api/simplify/chat"'), server.indexOf('path === "/chat/stop"'));
  assert.ok(rawRoute.length > 200, "the Simplify route block was not found where expected");
  const route = rawRoute.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/sessionBudgets\.ensure/.test(route), "the Simplify route must never create a session budget");
  assert.match(route, /onTurnBilled:\s*simplifyBilling\(T\)/, "every Simplify turn must be metered, with the tenant captured per request");
  assert.match(route, /T\.role === "anon"/, "an anonymous caller must still be refused");
  assert.match(route, /needs_invite/, "an uninvited guest must still be refused");
});

/* ---- every turn is metered, and the tenant cannot be crossed --------------------------------- */
await t("Simplify meters each turn, skips failed ones, and cannot bill the wrong tenant", async () => {
  const src = readFileSync(new URL("./simplify.mjs", import.meta.url), "utf8");
  assert.match(src, /function handleSimplifyChat\(req, res, \{ onTurnBilled = null \} = \{\}\)/,
    "the billing callback must arrive per request, never at construction");
  assert.match(src, /if \(outcome\.ok && typeof onTurnBilled === "function"\)/,
    "a turn the ladder never answered must not be charged");

  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /function simplifyBilling\(T\)/, "billing math belongs beside meterTurn, not in simplify.mjs");
  assert.ok(!/let simplifyBillingTenant/.test(server), "a module-scoped tenant is the cross-billing bug this shape prevents");

  const billed = [];
  const make = (email) => async ({ modelId }) => { await new Promise((r) => setTimeout(r, 15)); billed.push({ email, modelId }); };
  const alice = make("alice@test.com"), bob = make("bob@test.com");
  await Promise.all([alice({ modelId: "for-alice" }), bob({ modelId: "for-bob" }), alice({ modelId: "for-alice-2" })]);
  for (const b of billed) assert.ok(b.modelId.includes(b.email.split("@")[0]), `${b.email} was billed for ${b.modelId}`);
  assert.equal(billed.length, 3);
});

console.log(`\n${passed} passed, ${failed} failed (total)`);
if (failed > 0) process.exit(1);
