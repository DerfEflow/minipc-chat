/*
 * Kept-promise guard self-test — run: node intentguard_test.mjs
 *
 * Part 1: the detector, where false positives are the real danger (a wrong fire wastes a round and
 * confuses the model), so most of these tests are things that must NOT trip it.
 * Part 2: END-TO-END against the real server with a mock provider that behaves exactly like
 * DeepSeek did for Fred: it answers "let me familiarize myself with the project" and stops. The
 * turn must not end there.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { unkeptIntent, intentNudge } from "./intentguard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };
const fires = (s) => unkeptIntent(s).unkept;

// ---------------- Part 1: detection ----------------
await t("Fred's actual case: a promise to familiarize, then silence", async () => {
  if (!fires("Before I answer, let me familiarize myself with the project so I don't guess.")) throw new Error("missed the reported failure");
});

await t("the common shapes of an unkept promise all fire", async () => {
  const cases = [
    "I'll check the repository structure first.",
    "I'm going to read the build spec before answering.",
    "Let me search the codebase for that function.",
    "First, I will review the migration files.",
    "Give me a moment while I pull the latest usage log.",
    "I need to look at the current configuration.",
    "Sure. Let me examine what you have so far.",
    "Understood. I'll start by listing the files in that folder.",
  ];
  for (const c of cases) if (!fires(c)) throw new Error("missed: " + c);
});

await t("a promise buried mid-answer does NOT fire when work follows it", async () => {
  const delivered = "I'll check the config. I checked it: the timeout is 30s and the retry count is 3. That explains the failures you saw.";
  if (fires(delivered)) throw new Error("fired on an answer that delivered after the promise");
});

await t("questions back to the user do NOT fire", async () => {
  for (const c of ["Should I go ahead and read the spec first?", "Do you want me to check the logs?", "Let me know: should I review it?"]) {
    if (fires(c)) throw new Error("fired on a question: " + c);
  }
});

await t("honest refusals do NOT fire", async () => {
  for (const c of ["I can't read that file because it is outside my allowed folders.", "I don't have access to that system, so I cannot check it."]) {
    if (fires(c)) throw new Error("fired on a refusal: " + c);
  }
});

await t("intentions that promise no retrievable action do NOT fire", async () => {
  for (const c of ["I'll keep that in mind for the next revision.", "I will remember that you prefer short answers.", "I'll be careful with that going forward."]) {
    if (fires(c)) throw new Error("fired on a non-action intention: " + c);
  }
});

await t("a finished answer that merely mentions future work does NOT fire", async () => {
  const done = "Here is the summary you asked for: the roof needs two coats and the gutters need replacing. Next week I will send the final quote.";
  if (fires(done)) throw new Error("fired on a completed answer");
});

await t("no tools attached means nothing could have been kept", async () => {
  if (unkeptIntent("Let me check the logs.", { toolsAvailable: false }).unkept) throw new Error("fired with no tools available");
});

await t("empty and whitespace answers do not fire (the empty-retry guard owns those)", async () => {
  for (const c of ["", "   ", null, undefined]) if (unkeptIntent(c).unkept) throw new Error("fired on empty");
});

await t("the promise text is captured for the nudge and the log", async () => {
  const r = unkeptIntent("Let me familiarize myself with the project first.");
  if (!r.promise.includes("familiarize")) throw new Error("promise not captured: " + r.promise);
  if (!intentNudge(r.promise).includes("familiarize")) throw new Error("nudge does not quote the promise");
});

await t("a trailing bullet is read as the tail", async () => {
  const s = "Here is my plan:\n- Review the schema\n- Let me start by reading the migration files";
  if (!fires(s)) throw new Error("missed a promise on the final bullet");
});

// ---------------- Part 2: e2e ----------------
const PORT = 8600 + Math.floor(process.uptime() * 13) % 200;
const MOCK_OLLAMA = PORT + 1;
const MOCK_PROVIDER = PORT + 2;

const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

// The provider behaves like DeepSeek did: promise, stop. Only after being told to act does it
// deliver. The second round's payload is captured so we can prove the nudge rode as a user turn.
let round = 0;
const seen = [];
const mockProvider = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    const body = JSON.parse(b);
    seen.push(body);
    round++;
    const say = round === 1
      ? "Before I answer, let me familiarize myself with the project so I don't guess."
      : "I read the project files. It is a Node service with a chat loop and a tool registry.";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: {"choices":[{"delta":{"content":${JSON.stringify(say)}}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => mockProvider.listen(MOCK_PROVIDER, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "dominion-intent-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  OPEN_AI_DOMINION_UI_APIKEY: "test-key-not-real",
  OPENAI_URL: "http://127.0.0.1:" + MOCK_PROVIDER + "/v1/chat/completions",
  OPENROUTER_API_KEY: "", DEEPSEEK_AI_DOMINION_UI_APIKEY: "", ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY: "" };
const child = spawn(process.execPath, [join(HERE, "server.mjs")], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = ""; child.stdout.on("data", (d) => bootLog += d); child.stderr.on("data", (d) => bootLog += d);

async function waitForBoot() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => { const rq = http.get({ host: "127.0.0.1", port: PORT, path: "/api/version" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }); rq.on("error", () => r(false)); });
    if (ok) return; await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never came up:\n" + bootLog.slice(-2000));
}
await waitForBoot();

function chat(model, mode) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ messages: [{ role: "user", content: "What does this project do?" }], model, mode: mode || "tool" });
    let answer = "", done = false;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => {
          buf += d;
          const ls = buf.split("\n"); buf = ls.pop() || "";
          for (const l of ls) {
            const s = l.trim();
            if (!s.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
            if (ev.type === "token" && ev.delta) answer += ev.delta;
          }
        });
        res.on("end", () => { done = true; resolve(answer); });
      });
    r.on("error", () => resolve(answer));
    r.write(data); r.end();
    setTimeout(() => { if (!done) { try { r.destroy(); } catch {} resolve(answer); } }, 20000);
  });
}

await t("e2e: the turn does NOT end on the promise; the model is made to deliver", async () => {
  const answer = await chat("openai/gpt-4o", "tool");
  if (seen.length < 2) throw new Error("the loop accepted the promise and stopped (" + seen.length + " provider call)");
  if (!/Node service with a chat loop/.test(answer)) throw new Error("the delivered answer never reached the user: " + JSON.stringify(answer).slice(0, 200));
});

await t("e2e: the nudge rides as a USER turn (agent models ignore trailing system messages)", async () => {
  const second = seen[1];
  const last = second.messages[second.messages.length - 1];
  if (last.role !== "user") throw new Error("nudge role was " + last.role);
  if (!/Dominion system notice/.test(last.content) || !/familiarize/.test(last.content)) throw new Error("nudge did not quote the promise: " + String(last.content).slice(0, 160));
});

console.log(`\nintentguard: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
mockProvider.close();
process.exit(failed ? 1 : 0);
