/*
 * Owner-auto routing regression — run with: node --test autoroute_test.mjs
 *
 * Locks the fix from 2026-07-25: owner "Auto" (model:"auto" or no pick) must resolve to the owner
 * DEFAULT cloud engine (DeepSeek V4 Pro), NOT the local Qwen. For years it silently fell through to
 * local, which starved every long turn of the cloud path's finish-the-job machinery (auto-continue,
 * kept-promise guard, wide context) and produced the "it truncates and I have to nudge it" bug.
 *
 * Boots the REAL server.mjs (single-tenant = owner) against a MOCK Ollama, with all cloud keys
 * BLANKED so a cloud turn fails fast and offline. Two proofs:
 *   1. model:"auto"  -> route reason names a CLOUD model; the local Ollama /api/chat is NOT called.
 *   2. model:"local" -> stays local: the local Ollama IS called and tokens stream.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 18820, MOCK_PORT = 18821;

// ---- mock Ollama: count /api/chat hits so we can prove which path ran ----
const mock = { chatHits: 0, answer: "hello from the local model" };
const mockSrv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    if (req.url === "/api/chat") {
      mock.chatHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { role: "assistant", content: mock.answer }, prompt_eval_count: 12, eval_count: 40, total_duration: 1e9 }));
      return;
    }
    // /api/embed and anything else: harmless empty JSON (retrieval degrades to lexical).
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => mockSrv.listen(MOCK_PORT, "127.0.0.1", r));

// ---- boot the real server against the mock, cloud keys BLANKED, temp data dirs ----
const dir = mkdtempSync(join(tmpdir(), "dominion-autoroute-test-"));
const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR: join(dir, "data"), // isolate: without this the server opens the shared default data dir (a sibling worktree left a newer Game Factory journal there)
  OLLAMA_URL: "http://127.0.0.1:" + MOCK_PORT,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"),
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  SYNC_SECRET: "test", RUN_PASSWORD: "",
  // No cloud egress possible: an owner-auto turn resolves to the cloud default and then fails fast.
  DEEPSEEK_KEY: "", OPENROUTER_KEY: "", OPENAI_KEY: "", ANTHROPIC_KEY: "",
};
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = "";
child.stdout.on("data", (d) => (bootLog += d));
child.stderr.on("data", (d) => (bootLog += d));

async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/toolruns" }, (rs) => { rs.resume(); r(rs.statusCode === 200); });
      rq.on("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}

function sseRequest(path, { method = "GET", body = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        let buf = ""; const events = [];
        res.on("data", (d) => {
          buf += d.toString();
          const lines = buf.split("\n"); buf = lines.pop() || "";
          for (const line of lines) {
            const s = line.trim(); if (!s.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
            events.push(ev);
          }
        });
        res.on("end", () => finish({ events }));
        res.on("error", () => finish({ events }));
      }
    );
    req.on("error", () => finish({ events: [] }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

await waitForBoot();

test("owner AUTO resolves to a CLOUD model and never touches the local Qwen", async () => {
  mock.chatHits = 0;   // ignore any boot-time alive/warmup ping
  const r = await sseRequest("/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "route me" }], mode: "normal", model: "auto", chatId: "auto1" },
  });
  const route = r.events.find((e) => e.type === "route");
  assert.ok(route, "a route event must be emitted");
  assert.match(String(route.reason || ""), /cloud model/i, "owner auto must route to a cloud model, not local");
  assert.equal(mock.chatHits, 0, "owner auto must NOT call the local Ollama /api/chat");
});

test("explicit LOCAL still runs on the local Qwen and streams", async () => {
  mock.chatHits = 0;
  const r = await sseRequest("/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "stay local" }], mode: "normal", model: "local", chatId: "local1" },
  });
  const route = r.events.find((e) => e.type === "route");
  assert.ok(route, "a route event must be emitted");
  assert.doesNotMatch(String(route.reason || ""), /cloud model/i, "explicit local must not be a cloud route");
  assert.ok(mock.chatHits >= 1, "explicit local must call the local Ollama /api/chat");
  assert.ok(r.events.some((e) => e.type === "token"), "explicit local must stream tokens");
});

test.after(() => {
  try { child.kill("SIGKILL"); } catch {}
  try { mockSrv.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});
