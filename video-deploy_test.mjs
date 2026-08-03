import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const railway = JSON.parse(readFileSync(new URL("./railway.json", import.meta.url), "utf8"));
const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const start = readFileSync(new URL("./start.sh", import.meta.url), "utf8");

test("deployment teardown preserves the full Trinity request and drains both processes", () => {
  assert.equal(typeof railway.deploy?.drainingSeconds, "number");
  assert.equal(railway.deploy.drainingSeconds, 330);
  assert.match(server, /openrouter:[\s\S]{0,800}timeoutMs:\s*300_000/);
  assert.match(server, /videoHttp\.drain\(\{\s*timeoutMs:\s*310_000\s*\}\)/);
  assert.match(start, /trap forward_shutdown TERM INT/);
  assert.match(start, /cloudflared tunnel --no-autoupdate --grace-period 320s run --token/);
  assert.match(start, /kill -TERM "\$cloudflared_pid"/);
  assert.match(start, /kill -TERM "\$node_pid"/);
  assert.doesNotMatch(start, /exec node server\.mjs/);
});
