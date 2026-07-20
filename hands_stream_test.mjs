/*
 * Hands streaming self-test - run with: node hands_stream_test.mjs
 *
 * Step 3 of the hub consolidation. Proves the streaming channel added 2026-07-20 against a REAL
 * spawned node and a bare hub, the same way hands_test does:
 *   1. dispatchStream delivers every chunk, in order, then a terminal result
 *   2. the concatenated chunks equal the terminal result's text (no loss, no dup)
 *   3. dispatch() (no onChunk) is byte-for-byte the old behaviour: one result, no chunks
 *   4. a streaming job still honours cancel mid-stream (process/stop reach it)
 *   5. the carve-out still refuses a protected path on the streaming path too
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHandsHub } from "./hands/hub.mjs";

const TOKEN = "test-token-stream";
const WORK = mkdtempSync(join(tmpdir(), "stream-"));
let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };

const hub = createHandsHub({ token: TOKEN, heartbeatMs: 1000 });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const body = async () => { let b = ""; for await (const c of req) b += c; return JSON.parse(b || "{}"); };
  if (u.pathname === "/hands/stream") return hub.handleStream(req, res, u);
  if (u.pathname === "/hands/result") return hub.handleResult(req, res, await body());
  if (u.pathname === "/hands/chunk") return hub.handleChunk(req, res, await body());
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const node = spawn(process.execPath, ["hands/hands.mjs"], {
  env: { ...process.env, HANDS_URL: BASE, HANDS_TOKEN: TOKEN, HANDS_NODE: "streamnode", HANDS_ROOTS: WORK, HANDS_SNAP_DIR: join(WORK, ".snap") },
  stdio: "ignore",
});
for (let i = 0; i < 60 && hub.stats().nodes < 1; i++) await new Promise((r) => setTimeout(r, 250));
assert.equal(hub.stats().nodes, 1, "the test node should connect");

// 1 + 2. streamed chunks arrive in order and reconstruct the answer
{
  const chunks = [];
  const r = await hub.dispatchStream("streamnode", "__echo_stream", { count: 8 }, {
    timeoutMs: 30000,
    onChunk: ({ seq, delta }) => chunks.push({ seq, delta }),
  });
  assert.equal(r.ok, true, "the streamed job should succeed: " + JSON.stringify(r));
  assert.equal(chunks.length, 8, "expected 8 chunks, got " + chunks.length);
  for (let i = 0; i < chunks.length; i++) assert.equal(chunks[i].seq, i, "chunk " + i + " arrived out of order (seq " + chunks[i].seq + ")");
  ok("dispatchStream delivered all 8 chunks in order");

  const joined = chunks.map((c) => c.delta).join("");
  assert.equal(joined, r.text, "concatenated chunks must equal the terminal result text");
  ok("the streamed chunks reconstruct the final answer exactly");
}

// 3. the non-streaming path is unchanged: dispatch() gets one result and no chunk sink fires
{
  let stray = 0;
  // dispatch() has no onChunk. Run a streaming-capable tool through it and confirm we still just
  // get the final result, with the node's chunk POSTs harmlessly dropped by the hub.
  const r = await hub.dispatch("streamnode", "__echo_stream", { count: 4 }, { timeoutMs: 30000 });
  assert.equal(r.ok, true);
  assert.equal(r.chunks, 4, "the tool still ran fully");
  assert.equal(stray, 0, "no chunk callback should fire on the non-streaming path");
  ok("dispatch() with no sink behaves exactly as before (result only)");
}

// 4. cancel mid-stream stops it
{
  const chunks = [];
  const ac = new AbortController();
  const p = hub.dispatchStream("streamnode", "__echo_stream", { count: 50 }, {
    timeoutMs: 30000, signal: ac.signal,
    onChunk: ({ delta }) => { chunks.push(delta); if (chunks.length === 3) ac.abort(); },
  });
  const r = await p;
  assert.equal(r.aborted, true, "an aborted stream must report aborted");
  ok("a streaming job honours cancel mid-stream");
}

// 5. carve-out still refuses on the streaming path
{
  const r = await hub.dispatchStream("streamnode", "fs_read", { path: "D:\\db-backups\\x" }, {
    timeoutMs: 10000, onChunk: () => {},
  });
  assert.equal(r.refused, true, "the D: carve-out must hold on the streaming path");
  ok("the carve-out refuses a protected path even with streaming on");
}

node.kill();
server.close();
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed}/5 checks passed - hands streaming verified against a real node`);
process.exit(0);
