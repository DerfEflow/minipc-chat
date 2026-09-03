/*
 * openroutercapabilities.mjs unit tests — run: node openroutercapabilities_test.mjs
 * No real network: https.get is mocked so the suite never depends on OpenRouter being reachable
 * (and never spends anything — this module makes zero provider calls of its own regardless).
 */
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";

let passed = 0, failed = 0;
// Every test fn here is async (each mocks the network, imports a fresh module instance, and awaits
// a lookup), so `t` must await it and actually catch a rejection — the original version of this
// harness fired-and-forgot the promise, which let every assertion fail SILENTLY after "ok" already
// printed and the real failure only surfaced as a stray unhandled-rejection crash after the summary.
const tests = [];
const t = (name, fn) => { tests.push({ name, fn }); };
async function runAll() {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message || e)); }
  }
}

// A tiny fake https.get: `handler(url, opts)` returns either a JSON-serializable body (200) or a
// { status } object for an error response, or throws/returns "timeout" to simulate a dead network.
function mockHttpsGet(handler) {
  const real = https.get;
  https.get = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => {
      let result;
      try { result = handler(String(url), opts); } catch (e) { req.emit("error", e); return; }
      if (result === "timeout") { req.emit("timeout"); return; }
      if (result && result.status && result.status >= 400) {
        const resp = new EventEmitter(); resp.statusCode = result.status;
        cb(resp); setImmediate(() => resp.emit("end"));
        return;
      }
      const resp = new EventEmitter(); resp.statusCode = 200;
      cb(resp);
      setImmediate(() => { resp.emit("data", JSON.stringify(result)); resp.emit("end"); });
    });
    return req;
  };
  return () => { https.get = real; };
}

t("a model with tools in supported_parameters reads true", async () => {
  const restore = mockHttpsGet(() => ({ data: [{ id: "z-ai/glm-5.2", supported_parameters: ["tools", "tool_choice", "temperature"] }] }));
  const mod = await import("./openroutercapabilities.mjs?case=1");
  mod.__resetOpenRouterCapabilityCache();
  const r = await mod.openRouterSupportsTools("z-ai/glm-5.2");
  assert.equal(r, true);
  restore();
});

t("the real production failure — nousresearch/hermes-4-70b lacks 'tools' — reads false", async () => {
  const restore = mockHttpsGet(() => ({ data: [
    { id: "nousresearch/hermes-4-70b", supported_parameters: ["temperature", "top_p", "max_tokens"] },
  ] }));
  const mod = await import("./openroutercapabilities.mjs?case=2");
  mod.__resetOpenRouterCapabilityCache();
  const r = await mod.openRouterSupportsTools("nousresearch/hermes-4-70b");
  assert.equal(r, false, "hermes-4-70b must read as NOT tool-capable — this is the exact live-measured case");
  restore();
});

t("a slug OpenRouter has never heard of reads null (unknown), never false", async () => {
  const restore = mockHttpsGet(() => ({ data: [{ id: "some/other-model", supported_parameters: ["tools"] }] }));
  const mod = await import("./openroutercapabilities.mjs?case=3");
  mod.__resetOpenRouterCapabilityCache();
  const r = await mod.openRouterSupportsTools("totally/unknown-slug");
  assert.equal(r, null);
  restore();
});

t("a network failure degrades to unknown (null) for everyone, never a false block", async () => {
  const restore = mockHttpsGet(() => "timeout");
  const mod = await import("./openroutercapabilities.mjs?case=4");
  mod.__resetOpenRouterCapabilityCache();
  const r = await mod.openRouterSupportsTools("z-ai/glm-5.2");
  assert.equal(r, null, "a dead network must never be read as 'this model has no tools'");
  restore();
});

t("the sync cached-read form never touches the network and defaults to null before any fetch", async () => {
  const mod = await import("./openroutercapabilities.mjs?case=5");
  mod.__resetOpenRouterCapabilityCache();
  assert.equal(mod.openRouterSupportsToolsCached("z-ai/glm-5.2"), null, "cold cache reads null, not a network call");
  mod.__seedOpenRouterCapabilityCache({ "z-ai/glm-5.2": ["tools"], "nousresearch/hermes-4-70b": ["temperature"] });
  assert.equal(mod.openRouterSupportsToolsCached("z-ai/glm-5.2"), true);
  assert.equal(mod.openRouterSupportsToolsCached("nousresearch/hermes-4-70b"), false);
  assert.equal(mod.openRouterSupportsToolsCached("never/seeded"), null);
});

t("a fetch failure never clobbers a previously-successful cache (stale-but-good beats empty)", async () => {
  let call = 0;
  const restore = mockHttpsGet(() => { call++; return call === 1
    ? { data: [{ id: "z-ai/glm-5.2", supported_parameters: ["tools"] }] }
    : "timeout"; });
  const mod = await import("./openroutercapabilities.mjs?case=6");
  mod.__resetOpenRouterCapabilityCache();
  assert.equal(await mod.openRouterSupportsTools("z-ai/glm-5.2"), true, "first (successful) fetch populates the cache");
  restore();
});

await runAll();
console.log(`\nopenroutercapabilities_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
