/*
 * Catalog audit self-test — run with: node catalogaudit_test.mjs
 *
 * NEW FILE (STABILIZE Step 1, 2026-09-03, deficiency #3-#5). Proves the two things this pass added:
 *   1. probeNvidiaChatLive catches every documented failure shape: an HTTP error, a timeout (the
 *      minimax-m3 150s+ hang), and the specific "200 OK but the content is a classifier's role-
 *      alternation complaint" shape nvidia/nemotron-3.5-content-safety exhibits — presence in
 *      NVIDIA's /v1/models list would miss every one of these except the first.
 *   2. runCatalogAudit wires that probe into the full per-seat pass and produces `result.unavailable`
 *      (id -> reason), which server.mjs feeds to models.catalog.mjs's setUnavailableSeats().
 * No live network calls: every provider is a local http.createServer standing in for NVIDIA, with
 * `keys.nvidiaUrl` pointed at it (added this pass specifically so this file never has to touch the
 * real integrate.api.nvidia.com). Timeouts use small explicit values, never the real 20s default —
 * this suite has to stay fast.
 *
 * Mocks serve SSE (stream:true) frames, matching probeNvidiaChatLive's real request shape — a
 * same-day fix after a non-streaming probe missed a streaming-only failure a live seat_sweep run
 * caught (see catalogaudit.mjs's probeNvidiaChatLive header for the measured story).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { probeNvidiaChatLive, runCatalogAudit } from "./catalogaudit.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

async function withMock(handlerFn, testFn) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch {} seen.push(body); handlerFn(req, res, body); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try { return await testFn({ port, seen, url: `http://127.0.0.1:${port}/v1/chat/completions` }); }
  finally { await new Promise((r) => srv.close(r)); }
}
// SSE stand-in for NVIDIA's stream:true response: one delta frame carrying the whole reply, then
// [DONE] — enough shape for probeNvidiaChatLive's frame parser, doesn't need real token-by-token.
const okReply = (res, text) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.end("data: [DONE]\n\n");
};

// ---- 1: probeNvidiaChatLive catches every documented failure shape --------------------------------

await t("probeNvidiaChatLive: a plain 'OK' reply is live", async () => {
  await withMock((req, res) => okReply(res, "OK"), async ({ url }) => {
    const r = await probeNvidiaChatLive("some/model", url, "test-key");
    assert.equal(r.ok, true);
  });
});

await t("probeNvidiaChatLive: no key at all is 'unchecked', not a false failure", async () => {
  const r = await probeNvidiaChatLive("some/model", "http://127.0.0.1:1/x", "");
  assert.equal(r.ok, false);
  assert.equal(r.unchecked, true);
});

await t("probeNvidiaChatLive: an HTTP error (the three EOL seats' actual symptom) is unavailable, reason names the status", async () => {
  await withMock((req, res) => { res.writeHead(410, { "content-type": "application/json" }); res.end('{"error":"has reached its end of life"}'); },
    async ({ url }) => {
      const r = await probeNvidiaChatLive("z-ai/glm-5.2", url, "test-key");
      assert.equal(r.ok, false);
      assert.match(r.reason, /HTTP 410/);
      assert.match(r.reason, /end of life/);
    });
});

await t("probeNvidiaChatLive: a 200 OK whose content is a role-alternation complaint (nemotron-3.5-content-safety's real symptom) is unavailable", async () => {
  await withMock((req, res) => okReply(res, "Conversation roles must alternate user/assistant/user/assistant/..."),
    async ({ url }) => {
      const r = await probeNvidiaChatLive("nvidia/nemotron-3.5-content-safety", url, "test-key");
      assert.equal(r.ok, false);
      assert.match(r.reason, /must alternate/);
    });
});

await t("probeNvidiaChatLive: empty content is unavailable", async () => {
  await withMock((req, res) => okReply(res, ""), async ({ url }) => {
    const r = await probeNvidiaChatLive("some/model", url, "test-key");
    assert.equal(r.ok, false);
    assert.match(r.reason, /empty/);
  });
});

await t("probeNvidiaChatLive: a hang past the timeout (minimax-m3's real symptom) is unavailable, fast, with a named timeout reason", async () => {
  await withMock((req, res) => { /* never respond */ }, async ({ url }) => {
    const t0 = Date.now();
    const r = await probeNvidiaChatLive("minimaxai/minimax-m3", url, "test-key", 300);   // 300ms, not the real 20s default
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.reason, /no response within 300ms/);
    assert.ok(elapsed < 2000, `probe should abort at its own timeout, not hang: took ${elapsed}ms`);
  });
});

await t("probeNvidiaChatLive: a body with no parseable SSE frames is unavailable, not a throw", async () => {
  await withMock((req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("not an sse frame{{{"); }, async ({ url }) => {
    const r = await probeNvidiaChatLive("some/model", url, "test-key");
    assert.equal(r.ok, false);
    assert.match(r.reason, /empty/);
  });
});

await t("probeNvidiaChatLive: a garbled individual data: frame is skipped, not thrown, while later good frames still count", async () => {
  await withMock((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: not json{{{\n\n");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  }, async ({ url }) => {
    const r = await probeNvidiaChatLive("some/model", url, "test-key");
    assert.equal(r.ok, true);
  });
});

// ---- 2: runCatalogAudit wires the probe into the full pass, producing result.unavailable ----------

await t("runCatalogAudit: a healthy NVIDIA mock reports ok:true, nothing unavailable", async () => {
  await withMock((req, res) => okReply(res, "OK"), async ({ url }) => {
    const r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unavailable, {});
  });
});

await t("runCatalogAudit: the content-safety and minimax symptoms both land in result.unavailable with their real reasons", async () => {
  await withMock(
    (req, res, body) => {
      if (body.model === "nvidia/nemotron-3.5-content-safety") return okReply(res, "Conversation roles must alternate user/assistant/...");
      if (body.model === "minimaxai/minimax-m3") return;   // hang -> caught by the audit's own probe timeout
      okReply(res, "OK");
    },
    async ({ url }) => {
      // nvidiaProbeTimeoutMs kept small so the deliberately-hanging minimax mock above doesn't
      // make this suite wait out the real 20s default.
      const r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { nvidiaProbeTimeoutMs: 300 });
      assert.equal(r.ok, false);
      assert.ok(r.unavailable["nvidia/nemotron-3.5-content-safety"], "content-safety should be marked unavailable");
      assert.match(r.unavailable["nvidia/nemotron-3.5-content-safety"], /must alternate/);
      assert.ok(r.problems.some((p) => p.kind === "unavailable" && p.id === "nvidia/nemotron-3.5-content-safety"));
      assert.ok(r.unavailable["minimax/minimax-m3"], "minimax should be marked unavailable after the probe times out");
      assert.match(r.unavailable["minimax/minimax-m3"], /no response within 300ms/);
    },
  );
});

await t("runCatalogAudit: no NVIDIA key means the live probe is skipped entirely (provider stays 'unchecked', nothing false-flagged)", async () => {
  const r = await runCatalogAudit({});
  assert.equal(r.providers.nvidia, "unchecked: no key");
  const nvidiaProblems = r.problems.filter((p) => p.id && p.id.startsWith("nvidia/"));
  assert.deepEqual(nvidiaProblems, [], "with no key, nothing about NVIDIA seats can be claimed dead");
});

await t("runCatalogAudit: opts.skipLiveProbe runs the list-only checks and never calls the mock", async () => {
  let hit = false;
  await withMock((req, res) => { hit = true; okReply(res, "OK"); }, async ({ url }) => {
    const r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { skipLiveProbe: true });
    assert.equal(hit, false, "the live probe must not fire when skipLiveProbe is set");
    assert.deepEqual(r.unavailable, {});
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
