/*
 * Produced-document delivery self-test — run: node exports_e2e_test.mjs
 *
 * Fred, 2026-07-19: he asked several times for a downloadable document and never got one. The
 * server had been building the file correctly the whole time and handing back an artifact id and
 * an internal path, leaving the actual delivery to whatever the model happened to say. These tests
 * hold the delivery itself: when a turn produces a document, a `file` event carrying a real
 * download URL reaches the client, and that URL serves the bytes as an attachment.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const t = async (n, f) => { try { await f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + e.message); } };

const PORT = 8750 + Math.floor(process.uptime() * 17) % 150;
const MOCK_OLLAMA = PORT + 1;
const MOCK_PROVIDER = PORT + 2;

const mockOllama = http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/chat" ? JSON.stringify({ message: { role: "assistant", content: "ok" }, eval_count: 5 }) : "{}"); }); });
await new Promise((r) => mockOllama.listen(MOCK_OLLAMA, "127.0.0.1", r));

function responseFunction(id, callId, name, args) {
  const item = {
    id: "fc_" + id,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  return [
    `data: ${JSON.stringify({ type: "response.output_item.added", response_id: id, output_index: 0, item })}`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      },
    })}`,
    "data: [DONE]",
    "",
    "",
  ].join("\n\n");
}

function responseText(id, text) {
  return [
    `data: ${JSON.stringify({ type: "response.output_text.delta", response_id: id, output_index: 0, content_index: 0, delta: text })}`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [{ id: "msg_" + id, type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    })}`,
    "data: [DONE]",
    "",
    "",
  ].join("\n\n");
}

// Round 1: the model tries to claim completion before doing anything; Dominion must reject it
// because no successful action exists in the execution ledger. Round 2 creates the DOCX. Round 3
// crosses the completion gate with observed action evidence. Round 4 answers WITHOUT mentioning
// any link, which is exactly the case that used to leave the user with nothing.
let round = 0;
const seen = [];
const mockProvider = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => b += d);
  req.on("end", () => {
    const body = JSON.parse(b);
    seen.push({ url: req.url, body });
    round++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (round === 1) {
      return res.end(responseFunction("resp_premature", "call_premature", "task_complete", {
        status: "completed",
        result: "The document was created.",
        changes: ["Created the requested document."],
        validation: [{ name: "create_docx", status: "passed" }],
        remaining: [],
      }));
    }
    if (round === 2) {
      return res.end(responseFunction("resp_create", "call_1", "create_docx", {
        title: "Roof Scope",
        content: "# Roof Scope\n\nTear-off, primer, two coats.",
      }));
    }
    if (round === 3) {
      const created = (body.input || []).find((item) =>
        item.type === "function_call_output" && item.call_id === "call_1");
      const evidenceId = /\[Dominion evidence id:\s*([^;\]]+)/i.exec(String(created && created.output || ""))?.[1] || "";
      return res.end(responseFunction("resp_complete", "call_complete", "task_complete", {
        status: "completed",
        result: "The Roof Scope Word document was created and delivered.",
        changes: ["Created the requested Roof Scope Word document."],
        validation: [{ name: "create_docx", status: "passed", detail: "The tool returned a DOCX artifact." }],
        remaining: [],
        evidenceIds: evidenceId ? [evidenceId] : ["invented-missing-evidence"],
      }));
    }
    res.end(responseText("resp_final", "The document is ready."));
  });
});
await new Promise((r) => mockProvider.listen(MOCK_PROVIDER, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "dominion-exports-e2e-"));
const env = { ...process.env, PORT: String(PORT), OLLAMA_URL: "http://127.0.0.1:" + MOCK_OLLAMA,
  MEMORY_DIR: join(dir, "memory"), CHATLOG_DIR: join(dir, "chatlog"), ARTIFACT_DIR: join(dir, "artifacts"),
  PERSONA_DIR: join(dir, "corpus"), PERSONA_STAGING: join(dir, "staging"), FLYWHEEL_DIR: join(dir, "flywheel"),
  LOG_DIR: join(dir, "logs"), SANDBOX_DIR: join(dir, "sandbox"), DATA_DIR: dir,
  AUTO_MENTOR: "0", PERIODIC_MENTOR: "0", WATCHDOG_ENABLED: "0", CLOUD_BACKUP_ENABLED: "0", BILLING_RETRY_ENABLED: "0", CATALOG_AUDIT: "0",
  MAIN_MODEL: "mock-main", LIGHT_MODEL: "mock-light", EMBED_MODEL: "mock-embed",
  OPEN_AI_DOMINION_UI_APIKEY: "test-key-not-real",
  OPENAI_URL: "http://127.0.0.1:" + MOCK_PROVIDER + "/v1/responses",
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

function chat() {
  return new Promise((resolve) => {
    const data = JSON.stringify({ messages: [{ role: "user", content: "Make me a Word document of the roof scope." }], model: "openai/gpt-4o", mode: "tool" });
    const events = []; let answer = "", done = false;
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
            events.push(ev);
            if (ev.type === "token" && ev.delta) answer += ev.delta;
          }
        });
        res.on("end", () => { done = true; resolve({ events, answer }); });
      });
    r.on("error", () => resolve({ events, answer }));
    r.write(data); r.end();
    setTimeout(() => { if (!done) { try { r.destroy(); } catch {} resolve({ events, answer }); } }, 25000);
  });
}
function get(path) {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
  });
}

let fileEvent = null;
await t("a turn that produces a document emits a file event with a download URL", async () => {
  const { events, answer } = await chat();
  fileEvent = events.find((e) => e.type === "file");
  if (!fileEvent) throw new Error("no file event: " + JSON.stringify(events.map((e) => e.type)));
  if (!/^\/exports\//.test(fileEvent.url)) throw new Error("bad url: " + fileEvent.url);
  if (!/\.docx$/i.test(fileEvent.name)) throw new Error("bad name: " + fileEvent.name);
  // The point of the whole change: the model never said a word about a link.
  if (/exports|download/i.test(answer)) throw new Error("this test is meant to run with a silent model; adjust it");
});

await t("the complex export crosses the native Responses completion-evidence gate", async () => {
  if (seen.length !== 4) throw new Error("expected rejected completion, create, accepted completion, and final Responses calls; saw " + seen.length);
  for (const call of seen) {
    if (call.url !== "/v1/responses") throw new Error("wrong OpenAI path: " + call.url);
    if (!Array.isArray(call.body.input) || !call.body.input.length) throw new Error("Responses input missing");
    if ("messages" in call.body) throw new Error("legacy messages leaked into Responses payload");
    if (!("max_output_tokens" in call.body)) throw new Error("max_output_tokens missing");
  }
  const completionDef = seen[0].body.tools?.find((tool) => tool.name === "task_complete");
  if (!completionDef || completionDef.type !== "function") {
    throw new Error("task_complete was not offered as a native Responses function tool; saw " +
      JSON.stringify((seen[0].body.tools || []).map((tool) => tool.name || tool.function?.name).filter(Boolean).slice(0, 20)));
  }
  const prematureOutput = seen[1].body.input.find((item) => item.type === "function_call_output" && item.call_id === "call_premature");
  if (!prematureOutput || !/execution ledger|state-changing action/i.test(String(prematureOutput.output))) {
    throw new Error("fabricated completion evidence was not rejected against observed actions");
  }
  const createOutput = seen[2].body.input.find((item) => item.type === "function_call_output" && item.call_id === "call_1");
  if (!createOutput) throw new Error("create_docx result was not returned as a Responses function_call_output");
  if (!/Dominion evidence id:/i.test(String(createOutput.output))) throw new Error("successful action did not issue a citable evidence id");
  const completionOutput = seen[3].body.input.find((item) => item.type === "function_call_output" && item.call_id === "call_complete");
  if (!completionOutput || !/accepted/i.test(String(completionOutput.output))) throw new Error("completion evidence was not accepted before the final answer");
});

await t("the download URL serves the real file as an attachment", async () => {
  const r = await get(fileEvent.url);
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  if (!/attachment/.test(String(r.headers["content-disposition"] || ""))) throw new Error("not served as an attachment");
  if (!/wordprocessingml/.test(String(r.headers["content-type"] || ""))) throw new Error("wrong content-type: " + r.headers["content-type"]);
  if (r.body.length < 500) throw new Error("suspiciously small file: " + r.body.length + " bytes");
  if (r.body.slice(0, 2).toString() !== "PK") throw new Error("not a real docx (no zip signature)");
});

await t("the export route refuses path traversal and unknown extensions", async () => {
  for (const bad of ["/exports/..%2f..%2fserver.mjs", "/exports/notes.exe", "/exports/"]) {
    const r = await get(bad);
    if (r.status === 200) throw new Error("served " + bad);
  }
});

await t("a missing export answers 404 rather than leaking anything", async () => {
  const r = await get("/exports/nope-does-not-exist.pdf");
  if (r.status !== 404) throw new Error("HTTP " + r.status);
});

console.log(`\nexports e2e: ${passed} passed, ${failed} failed`);
child.kill();
mockOllama.close();
mockProvider.close();
process.exit(failed ? 1 : 0);
