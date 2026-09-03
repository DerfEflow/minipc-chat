import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const railway = JSON.parse(readFileSync(new URL("./railway.json", import.meta.url), "utf8"));
const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const start = readFileSync(new URL("./start.sh", import.meta.url), "utf8");

test("deployment teardown preserves Trinity recovery and uses Cloudflare's supported drain ceiling", () => {
  assert.equal(typeof railway.deploy?.drainingSeconds, "number");
  assert.equal(railway.deploy.drainingSeconds, 330);
  assert.match(server, /openrouter:[\s\S]{0,800}timeoutMs:\s*300_000/);
  assert.match(server, /videoHttp\.drain\(\{\s*timeoutMs:\s*310_000\s*\}\)/);
  assert.match(start, /trap forward_shutdown TERM INT/);
  // Streams lane, 2026-09-03: --protocol http2 landed between --no-autoupdate and --grace-period
  // (QUIC's UDP-idle-timeout sensitivity was implicated in the ~15-minute tunnel churn cycle).
  // The teardown contract this test actually guards — --grace-period 180s, --token, and SIGTERM
  // reaching both processes together — is unchanged; only the transport flag moved in.
  assert.match(start, /cloudflared tunnel --no-autoupdate --protocol http2 --grace-period 180s run --token/);
  assert.match(start, /kill -TERM "\$cloudflared_pid"/);
  assert.match(start, /kill -TERM "\$node_pid"/);
  assert.doesNotMatch(start, /exec node server\.mjs/);
});
