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
import { probeNvidiaChatLive, runCatalogAudit, NVIDIA_PROBE_TIMEOUT_MS, NVIDIA_PROBE_TIMEOUT_MS_SLOW, NVIDIA_UNAVAILABLE_STRIKES } from "./catalogaudit.mjs";

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

await t("probeNvidiaChatLive: a 200 OK whose content is a role-alternation complaint (nemotron-3.5-content-safety's real symptom, before it was removed from the catalog entirely) is unavailable", async () => {
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

await t("runCatalogAudit: a role-alternation-shaped reply and a hanging seat both need 2 CONSECUTIVE failed passes before landing in result.unavailable (debounce, see section 3)", async () => {
  // nvidia/nemotron-3.5-content-safety is no longer a catalog seat (removed the same day, lead
  // review follow-up) -- nvidia/nemotron-3-nano-omni-30b-a3b stands in as a live catalog id to
  // prove the SAME failure-content shape still drives the debounce correctly for whatever seat
  // exhibits it.
  await withMock(
    (req, res, body) => {
      if (body.model === "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning") return okReply(res, "Conversation roles must alternate user/assistant/...");
      if (body.model === "minimaxai/minimax-m3") return;   // hang -> caught by the audit's own probe timeout
      okReply(res, "OK");
    },
    async ({ url }) => {
      // nvidiaProbeTimeoutMs kept small so the deliberately-hanging minimax mock above doesn't
      // make this suite wait out the real 20s default.
      const pass1 = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { nvidiaProbeTimeoutMs: 300 });
      assert.deepEqual(pass1.unavailable, {}, "a single failing pass must not hide anything yet");
      assert.equal(pass1.failCounts["nvidia/nemotron-3-nano-omni-30b-a3b"], 1);
      assert.equal(pass1.failCounts["minimax/minimax-m3"], 1);
      assert.ok(pass1.notes.some((n) => n.kind === "probe-warn" && n.id === "nvidia/nemotron-3-nano-omni-30b-a3b"));

      const pass2 = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { nvidiaProbeTimeoutMs: 300, priorUnavailable: pass1.unavailable, priorFailCounts: pass1.failCounts });
      assert.equal(pass2.ok, false);
      assert.ok(pass2.unavailable["nvidia/nemotron-3-nano-omni-30b-a3b"], "should be marked unavailable after 2 consecutive failures");
      assert.match(pass2.unavailable["nvidia/nemotron-3-nano-omni-30b-a3b"], /must alternate/);
      assert.ok(pass2.problems.some((p) => p.kind === "unavailable" && p.id === "nvidia/nemotron-3-nano-omni-30b-a3b"));
      assert.ok(pass2.unavailable["minimax/minimax-m3"], "minimax should be marked unavailable after 2 consecutive timeouts");
      assert.match(pass2.unavailable["minimax/minimax-m3"], /no response within 300ms/);
      assert.equal(pass2.failCounts["nvidia/nemotron-3-nano-omni-30b-a3b"], 2);
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

// ---- 3: DEBOUNCE (lead review follow-up, 2026-09-03) -----------------------------------------------
// Live rig sweep caught the first version of this file hiding a seat on one transient 503 and
// timing out a legitimate 50-57s reasoning model at the flat 20s budget. These tests pin the fix:
// 2 consecutive failures to hide, 1 success to restore, a non-consecutive failure never accumulates.

await t("debounce: a single failed probe lands in notes as a warning, NOT result.unavailable", async () => {
  await withMock((req, res) => okReply(res, "must alternate roles, invalid conversation"), async ({ url }) => {
    const r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: ["nvidia/nemotron-3-super-120b-a12b:free"] });
    assert.deepEqual(r.unavailable, {});
    assert.equal(r.failCounts["nvidia/nemotron-3-super-120b-a12b:free"], 1);
    const warn = r.notes.find((n) => n.id === "nvidia/nemotron-3-super-120b-a12b:free" && n.kind === "probe-warn");
    assert.ok(warn, "expected a probe-warn note for the first failure");
    assert.match(warn.note, /1\/2 consecutive/);
  });
});

await t("debounce: 2 CONSECUTIVE failed probes (state threaded via priorFailCounts/priorUnavailable) hides the seat", async () => {
  await withMock((req, res) => okReply(res, "must alternate roles"), async ({ url }) => {
    const id = "nvidia/nemotron-3-super-120b-a12b:free";
    const pass1 = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id] });
    assert.ok(!pass1.unavailable[id]);
    const pass2 = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id], priorUnavailable: pass1.unavailable, priorFailCounts: pass1.failCounts });
    assert.ok(pass2.unavailable[id], "2 consecutive failures must hide the seat");
    assert.equal(pass2.failCounts[id], 2);
  });
});

await t("debounce: ONE success immediately restores a hidden seat and zeroes its counter (no debounce on the way up)", async () => {
  await withMock((req, res) => okReply(res, "OK"), async ({ url }) => {
    const id = "nvidia/nemotron-3-super-120b-a12b:free";
    const r = await runCatalogAudit(
      { nvidia: "test-key", nvidiaUrl: url },
      { onlyIds: [id], priorUnavailable: { [id]: "stale failure from a prior run" }, priorFailCounts: { [id]: 2 } },
    );
    assert.ok(!r.unavailable[id], "one success must restore the seat immediately");
    assert.equal(r.failCounts[id], 0);
    assert.ok(r.notes.some((n) => n.kind === "restored" && n.id === id));
  });
});

await t("debounce: a non-consecutive failure never accumulates -- fail, succeed, fail leaves the seat live", async () => {
  const id = "nvidia/nemotron-3-super-120b-a12b:free";
  let mode = "fail";
  await withMock((req, res) => okReply(res, mode === "fail" ? "must alternate roles" : "OK"), async ({ url }) => {
    let state = { priorUnavailable: {}, priorFailCounts: {} };
    mode = "fail";
    let r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id], ...state });
    assert.equal(r.failCounts[id], 1);
    state = { priorUnavailable: r.unavailable, priorFailCounts: r.failCounts };

    mode = "ok";
    r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id], ...state });
    assert.equal(r.failCounts[id], 0, "a success must reset the streak, not just tolerate it");
    state = { priorUnavailable: r.unavailable, priorFailCounts: r.failCounts };

    mode = "fail";
    r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id], ...state });
    assert.equal(r.failCounts[id], 1, "this is strike ONE of a new streak, not strike two of the old one");
    assert.ok(!r.unavailable[id], "a non-consecutive failure must never hide the seat");
  });
});

await t("debounce: a 5xx 'resource exhausted' response (the live nano-omni symptom) is an ORDINARY failure -- still needs 2 consecutive, not special-cased to hide on one", async () => {
  await withMock((req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "ResourceExhausted: Worker local total request limit reached (2168/16)", code: 503 } })); },
    async ({ url }) => {
      const id = "nvidia/nemotron-3-super-120b-a12b:free";
      const pass1 = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id] });
      assert.ok(!pass1.unavailable[id], "a single transient 503 must not hide the seat");
      assert.equal(pass1.failCounts[id], 1, "counts as exactly one ordinary strike, not zero and not two");
      const pass2 = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: [id], priorUnavailable: pass1.unavailable, priorFailCounts: pass1.failCounts });
      assert.ok(pass2.unavailable[id], "a second consecutive 503 completes the ordinary 2-strike debounce");
      assert.match(pass2.unavailable[id], /ResourceExhausted/);
    });
});

// ---- 4: opts.onlyIds restricts the pass; a seat not visited keeps its prior status untouched -------

await t("onlyIds: the 10-minute reprobe only touches the listed ids -- an excluded seat's prior unavailable/failCounts state survives the pass unchanged, and its mock is never hit", async () => {
  const hitModels = [];
  await withMock(
    (req, res, body) => { hitModels.push(body.model); okReply(res, "OK"); },
    async ({ url }) => {
      const reprobed = "nvidia/nemotron-3-super-120b-a12b:free";
      const excluded = "nvidia/nemotron-3-nano-omni-30b-a3b";
      const r = await runCatalogAudit(
        { nvidia: "test-key", nvidiaUrl: url },
        { onlyIds: [reprobed], priorUnavailable: { [excluded]: "stale reason from an earlier hourly run" }, priorFailCounts: { [excluded]: 2 } },
      );
      assert.equal(r.unavailable[excluded], "stale reason from an earlier hourly run", "an id excluded by onlyIds must keep its prior status verbatim");
      assert.equal(r.failCounts[excluded], 2);
      assert.ok(!r.unavailable[reprobed], "the id IN onlyIds was freshly probed and succeeded, so it must be live");
      assert.ok(!hitModels.includes("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"), "the excluded seat's directId must never reach the mock");
    },
  );
});

// ---- 5: probe budget -- 60s for a catalog-flagged slow/reasoning seat, 20s otherwise ----------------
// Real timing, not a stub: proves the wiring actually reaches the seat's `slow` catalog flag, using
// the two live NVIDIA ids the bug was reported against. Each test takes ~20-22s of real wall time --
// that is the whole point, there is no faster way to prove a timeout boundary without faking timers,
// and Node built-ins only (AGENT-RULES) rules out a fake-timer library.

await t(`slow-flagged seat (nvidia/nemotron-3-ultra-550b-a55b, catalog slow:true) gets the ${NVIDIA_PROBE_TIMEOUT_MS_SLOW}ms budget, not ${NVIDIA_PROBE_TIMEOUT_MS}ms -- a mock that answers at ~22s still counts as live`, async () => {
  await withMock(
    (req, res) => { setTimeout(() => okReply(res, "OK"), 22000); },
    async ({ url }) => {
      const r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: ["nvidia/nemotron-3-ultra-550b-a55b"] });
      assert.ok(!r.unavailable["nvidia/nemotron-3-ultra-550b-a55b"], "a slow reasoning model answering at 22s must not be treated as dead");
    },
  );
});

await t(`a NON-slow seat (nvidia/nemotron-3-super-120b-a12b:free) still gets the plain ${NVIDIA_PROBE_TIMEOUT_MS}ms budget -- the same ~22s-delayed mock times out instead of waiting it out`, async () => {
  await withMock(
    (req, res) => { setTimeout(() => okReply(res, "OK"), 22000); },
    async ({ url }) => {
      const t0 = Date.now();
      const r = await runCatalogAudit({ nvidia: "test-key", nvidiaUrl: url }, { onlyIds: ["nvidia/nemotron-3-super-120b-a12b:free"] });
      const elapsed = Date.now() - t0;
      assert.equal(r.failCounts["nvidia/nemotron-3-super-120b-a12b:free"], 1, "should have timed out (one strike), not answered");
      assert.ok(elapsed < 21500, `should abort near ${NVIDIA_PROBE_TIMEOUT_MS}ms, not wait out the full 22s mock delay: took ${elapsed}ms`);
    },
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
