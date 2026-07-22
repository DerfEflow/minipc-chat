/*
 * Environment-awareness test - run with: node environment_test.mjs
 *
 * WHY THIS EXISTS. Every tool-capable model was told, in the system prompt, "You run on his
 * always-on mini-PC". That sentence was written when there was one node and was never revised when
 * the laptop joined, so models denied that Fred's own F:\ drive existed and file work appeared to
 * be "not connected". Worse, when the user's message didn't literally contain the word "laptop",
 * dispatch fell back to whichever node had most recently heartbeat: a coin flip between his two
 * machines on every turn.
 *
 * The fix has two halves and this file proves both against REAL spawned nodes:
 *   A. the machine describes ITSELF on connect (drives, platform, elevation), so the prompt is
 *      generated from fact and cannot go stale again
 *   B. a drive letter routes itself - F:\ is an address for the laptop, E:\ for the mini-PC
 *
 * Checks:
 *   1. two real nodes connect and each reports its own roots over the wire
 *   2. a drive unique to one machine resolves to that machine
 *   3. a drive on BOTH machines resolves to nothing (ambiguous must not guess)
 *   4. a drive on NO machine resolves to nothing
 *   5. the profile carries platform + elevation, typed correctly
 *   6. JSON-escaped Windows paths still yield their drive letter (the pathNode scan's assumption)
 *   7. regression: the false "you run on the mini-PC" sentence is gone and the live block is wired
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHandsHub } from "./hands/hub.mjs";

const TOKEN = "test-token-env";
const WORK = mkdtempSync(join(tmpdir(), "envtest-"));
let passed = 0;
const ok = (n) => { console.log("  PASS  " + n); passed++; };

const hub = createHandsHub({ token: TOKEN, heartbeatMs: 1000 });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/hands/stream") return hub.handleStream(req, res, u);
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

// Two nodes with DIFFERENT drive maps, mirroring the real pair. Explicit HANDS_ROOTS is taken
// verbatim (no existence check), so this exercises the routing logic on any host OS.
const spawnNode = (name, roots) => spawn(process.execPath, ["hands/hands.mjs"], {
  env: { ...process.env, HANDS_URL: BASE, HANDS_TOKEN: TOKEN, HANDS_NODE: name,
         HANDS_ROOTS: roots, HANDS_MAX_ACCESS: "", HANDS_SNAP_DIR: join(WORK, ".snap-" + name) },
  stdio: "ignore",
});
const a = spawnNode("laptop", "C:\\,F:\\,G:\\,Z:\\");
const b = spawnNode("minipc", "C:\\,E:\\");
for (let i = 0; i < 80 && hub.stats().nodes < 2; i++) await new Promise((r) => setTimeout(r, 250));
assert.equal(hub.stats().nodes, 2, "both test nodes should connect");

// 1. each node described itself over the wire
{
  const info = hub.nodeInfo();
  assert.ok(info.laptop, "the laptop node should have reported a profile");
  assert.ok(info.minipc, "the minipc node should have reported a profile");
  assert.deepEqual(info.laptop.roots, ["C:\\", "F:\\", "G:\\", "Z:\\"], "laptop roots should arrive intact");
  assert.deepEqual(info.minipc.roots, ["C:\\", "E:\\"], "minipc roots should arrive intact");
  ok("both nodes report their own drive map on connect");
}

// 2. a unique drive letter IS an address
{
  assert.equal(hub.nodeForPath("F:\\"), "laptop", "F:\\ lives only on the laptop");
  assert.equal(hub.nodeForPath("G:\\"), "laptop", "G:\\ lives only on the laptop");
  assert.equal(hub.nodeForPath("Z:\\"), "laptop", "Z:\\ lives only on the laptop");
  assert.equal(hub.nodeForPath("E:\\"), "minipc", "E:\\ lives only on the mini-PC");
  assert.equal(hub.nodeForPath("f:\\claude sandbox\\projects"), "laptop", "matching is case-insensitive and path-deep");
  ok("a drive unique to one machine routes to that machine");
}

// 3. shared drives must NOT guess — this is the safety property
{
  assert.equal(hub.nodeForPath("C:\\"), "", "C:\\ is on both machines, so it can pin nothing");
  assert.equal(hub.nodeForPath("C:\\Users\\rjfla"), "", "a deep C:\\ path is still ambiguous");
  ok("a drive on both machines refuses to pick one");
}

// 4. an unknown drive resolves to nothing rather than the nearest node
{
  assert.equal(hub.nodeForPath("Q:\\somewhere"), "", "no machine claims Q:\\");
  assert.equal(hub.nodeForPath(""), "", "an empty path pins nothing");
  ok("an unclaimed drive routes nowhere");
}

// 5. the rest of the profile arrived and is typed
{
  const i = hub.nodeInfo().laptop;
  assert.equal(typeof i.elevated, "boolean", "elevation must be a real boolean, never a string");
  assert.equal(typeof i.platform, "string");
  assert.ok(i.platform.length, "platform should be populated");
  assert.equal(typeof i.host, "string");
  ok("the profile carries platform, host and a typed elevation flag");
}

// 6. the pathNode scan's load-bearing assumption: JSON escaping keeps the drive letter findable
{
  const blob = JSON.stringify({ path: "F:\\Claude Sandbox\\Projects\\x.txt", other: "E:/tmp" });
  const found = blob.match(/[a-zA-Z]:[\\/]/g) || [];
  const letters = [...new Set(found.map((h) => h.slice(0, 2)))];
  assert.deepEqual(letters, ["F:", "E:"], "both drive letters survive JSON escaping");
  ok("JSON-escaped Windows paths still yield their drive letter");
}

// 7. regression guard on the actual source: the lie is gone and the live block is wired in
{
  const src = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.ok(!/You run on his always-on mini-PC/.test(src), "the hardcoded mini-PC sentence must not come back");
  assert.ok(/function machinesBlock\(/.test(src), "machinesBlock must exist");
  assert.ok(/machines: attachTools \? machinesBlock\(T\)/.test(src), "the block must be passed into the system prompt");
  assert.ok(/preferred \|\| pathNode\(args\)/.test(src), "dispatch must consult path-based routing");
  const tools = readFileSync(new URL("./tools.mjs", import.meta.url), "utf8");
  assert.ok(!/on the mini-PC/.test(tools), "no tool description may still claim it runs on the mini-PC");
  ok("source regression guards hold (no stale machine claims anywhere)");
}

try { a.kill(); b.kill(); } catch {}
try { server.close(); } catch {}
try { rmSync(WORK, { recursive: true, force: true }); } catch {}
console.log(`\n${passed}/7 environment checks passed`);
process.exit(passed === 7 ? 0 : 1);
