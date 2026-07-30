#!/usr/bin/env node
/*
 * Live model sweep (Fred, 2026-07-30): "send a call to every single model that my app offers.
 * The imagery, the drop down from the chat, and app builder. every one. listen for what happens."
 *
 * Boots the REAL server via devboot (dev rig, MULTI_TENANT, throwaway data dir) with the wallet's
 * provider keys, then drives the app's own /chat pipeline for every catalog model — the same
 * shaping, params, retries, and metering production uses — plus the image lanes and one BATTALION
 * turn each way (text ask = swarm; build ask = honesty detour). Nothing here talks to production.
 *
 *   node ops/model_sweep.mjs [basePort]        (default 8210; results -> ops/sweep-results.json)
 *
 * Cost control: one tiny prompt per model, mode "fast", low temperature; image lanes one small
 * image each. The point is transport truth (does the call form correctly and answer), never depth.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASE = Number(process.argv[2]) || 8210;
const OWNER = "http://127.0.0.1:" + (BASE + 1);
const APP = "http://127.0.0.1:" + (BASE + 2);
const OUT = join(HERE, "sweep-results.json");
const PER_MODEL_TIMEOUT_MS = 120_000;

// ---- wallet -> env (values never printed) ------------------------------------------------------
function walletEnv() {
  const env = {};
  try {
    const raw = readFileSync(join(process.env.USERPROFILE || "", ".app-secrets.env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
    }
  } catch (e) { console.error("wallet read failed: " + (e && e.message)); }
  return env;
}

// ---- tiny SSE chat driver over the dev rig -----------------------------------------------------
async function chatOnce({ model, prompt, mode = "fast", stopAfterEvent = "", maxMs = PER_MODEL_TIMEOUT_MS }) {
  const started = Date.now();
  const rec = { model, ok: false, ms: 0, transport: "", route: "", tokensOut: 0, costUsd: null,
                events: [], errors: [], notes: [], text: "", jobId: "" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("sweep timeout")), maxMs);
  try {
    const res = await fetch(OWNER + "/chat", {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], model, mode,
                             privacyMode: "normal", temperature: 0.2, chatId: "sweep-" + model.replace(/[^a-z0-9]/gi, "-") }),
    });
    if (!res.ok || !res.body) { rec.errors.push("HTTP " + res.status); return rec; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === "job") rec.jobId = ev.id || "";
        else if (ev.type === "route") { rec.route = (ev.route || "") + " · " + (ev.reason || ""); rec.events.push("route"); }
        else if (ev.type === "token") rec.text += ev.delta || "";
        else if (ev.type === "error") rec.errors.push(String(ev.message || ev.error || ev.code || "error").slice(0, 300));
        else if (ev.type === "supervisor" && ev.supervisor === "provider recovery") rec.notes.push(`recovery:${ev.decision}·${String(ev.reason || "").slice(0, 120)}`);
        else if (ev.type === "tools_capped") rec.notes.push("tools_capped:" + ev.dropped);
        else if (ev.type === "tools_unavailable") rec.notes.push("tools_unavailable");
        else if (ev.type === "battalion_detour") rec.notes.push("battalion_detour->" + (ev.model || ""));
        else if (ev.type === "checkpoint") rec.notes.push("checkpoint:" + (ev.state || ""));
        else if (ev.type === "done") {
          rec.ok = true;
          const m = ev.meta || {};
          rec.transport = m.provider || "";
          rec.tokensOut = m.outputTokens || 0;
          rec.costUsd = typeof m.costUsd === "number" ? m.costUsd : null;
          if (m.battalion) rec.notes.push(`battalion:${m.battalion.mode}·${m.battalion.parts}part·${(m.battalion.models || []).length}models`);
        }
        if (stopAfterEvent && rec.notes.some((n) => n.startsWith(stopAfterEvent))) {
          if (rec.jobId) { try { await fetch(OWNER + "/chat/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: rec.jobId }) }); } catch {} }
          rec.ok = true; rec.notes.push("stopped-early-by-sweep");
          try { ac.abort(new Error("stop-after-event")); } catch {}
        }
      }
    }
  } catch (e) {
    if (!rec.notes.includes("stopped-early-by-sweep")) rec.errors.push("transport: " + String(e && e.message || e).slice(0, 200));
  } finally { clearTimeout(timer); rec.ms = Date.now() - started; }
  if (!rec.ok && !rec.errors.length && !rec.text) rec.errors.push("stream ended with no done event and no text");
  if (rec.text && !rec.ok && !rec.errors.length) rec.notes.push("text-without-done");
  return rec;
}

async function imageOnce(body, label) {
  const started = Date.now();
  const rec = { model: label, ok: false, ms: 0, errors: [], notes: [] };
  try {
    const res = await fetch(OWNER + "/api/images/generate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && (j.ok || (Array.isArray(j.images) && j.images.length) || j.image || j.b64 || (Array.isArray(j.results) && j.results.length))) {
      rec.ok = true;
      rec.notes.push("keys:" + Object.keys(j).slice(0, 8).join(","));
    } else {
      rec.errors.push("HTTP " + res.status + " " + JSON.stringify(j).slice(0, 300));
    }
  } catch (e) { rec.errors.push(String(e && e.message || e).slice(0, 200)); }
  rec.ms = Date.now() - started;
  return rec;
}

// ---- main ---------------------------------------------------------------------------------------
console.log("[sweep] booting dev rig on base " + BASE + " (paid keys ON for this session)");
const child = spawn(process.execPath, [join(ROOT, "devboot.mjs"), String(BASE)], {
  cwd: ROOT,
  env: { ...process.env, ...walletEnv(), DEVBOOT_ALLOW_PAID: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
const logSink = (d) => { const s = String(d); serverLog.push(s); if (/param retry|pre-applied|reroute|escalation|battalion|focused toolbox/.test(s)) process.stdout.write("[server] " + s); };
child.stdout.on("data", logSink);
child.stderr.on("data", logSink);
process.on("exit", () => { try { child.kill(); } catch {} });

// wait for the rig
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const r = await fetch(APP + "/api/version"); up = r.ok; } catch {}
}
if (!up) { console.error("[sweep] dev rig never came up"); process.exit(2); }
console.log("[sweep] rig is up; pulling /api/models");

const modelsRes = await fetch(OWNER + "/api/models");
const catalog = await modelsRes.json();
const ids = [];
for (const g of catalog.groups || []) for (const m of g.models || []) if (m.id && m.id !== "battalion") ids.push(m.id);
const flat = Array.isArray(catalog.models) ? catalog.models.map((m) => m.id) : [];
for (const id of flat) if (id && !ids.includes(id) && id !== "battalion") ids.push(id);
console.log("[sweep] " + ids.length + " catalog models to call, one tiny prompt each");

const results = { startedAt: new Date().toISOString(), chat: [], images: [], battalion: [], serverNotes: [] };
const PROMPT = "Reply with exactly the single word: ready";
const QUEUE = [...ids];
const WORKERS = 3;
async function worker(n) {
  while (QUEUE.length) {
    const id = QUEUE.shift();
    const rec = await chatOnce({ model: id, prompt: PROMPT });
    results.chat.push(rec);
    console.log(`[sweep] ${rec.ok ? " ok " : "FAIL"} ${id} · ${rec.ms}ms · ${rec.transport || "-"}${rec.errors.length ? " · " + rec.errors[0] : ""}${rec.notes.length ? " · " + rec.notes.join("|") : ""}`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));

// BATTALION both ways
console.log("[sweep] battalion: text ask (swarm) then build ask (honesty detour)");
results.battalion.push(await chatOnce({ model: "battalion", prompt: "In two sentences, why do metals conduct heat well?", mode: "auto", maxMs: 300_000 }));
results.battalion.push(await chatOnce({ model: "battalion", prompt: "Build a small app called SweepProbe in a new folder on drive Z.", mode: "auto", stopAfterEvent: "battalion_detour", maxMs: 60_000 }));

// image lanes: free draft (NVIDIA) + default paid lane
console.log("[sweep] image lanes");
results.images.push(await imageOnce({ prompt: "a copper gear on black velvet, studio photo", draft: true }, "image:free-draft"));
results.images.push(await imageOnce({ prompt: "a copper gear on black velvet, studio photo", n: 1 }, "image:default-paid"));

results.serverNotes = serverLog.filter((s) => /param retry|pre-applied|reroute|post-retrieval escalation|tool defs|focused toolbox|battalion/.test(s)).slice(-200);
writeFileSync(OUT, JSON.stringify(results, null, 2));
const okChat = results.chat.filter((r) => r.ok).length;
console.log(`[sweep] DONE: chat ${okChat}/${results.chat.length} ok · battalion ${results.battalion.filter((r) => r.ok).length}/2 · images ${results.images.filter((r) => r.ok).length}/2 · results -> ${OUT}`);
child.kill();
process.exit(0);
