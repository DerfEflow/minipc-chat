#!/usr/bin/env node
/*
 * The live proof suite (Fred's order, 2026-07-30). Everything here drives the REAL server through
 * its real HTTP surface with real provider keys and a real hands node, and every claim it makes is
 * a file on disk or a server event, never a mock:
 *
 *   A. chat build      — a small app built from chat on a NON-flagship model, into Z:, run to a
 *                        real accepted completion (the thing that has never once happened).
 *   B. guest parity    — the same surfaces as a guest: models, budget wording, tools, workshop.
 *   C. crucible vibe   — new folder, directives to General/Captain/Sergeant, cross-window relay,
 *                        orchestrator tasks, WORST-CASE models per task, build, preview.
 *   D. beginner        — the beginner surface builds a small app and previews it.
 *
 * Usage: node ops/live-suite.mjs [stage] [basePort]      stage = a|b|c|d|all   (default all, 8230)
 * Results append to ops/live-results.json. The rig is booted by ops/live-rig.mjs separately so a
 * stage can be re-run against a warm rig: node ops/live-rig.mjs 8230
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE = (process.argv[2] || "all").toLowerCase();
const BASE = Number(process.argv[3]) || 8230;
const OWNER = "http://127.0.0.1:" + (BASE + 1);
const GUEST = "http://127.0.0.1:" + BASE;
const APP = "http://127.0.0.1:" + (BASE + 2);
const WORKSPACE = process.env.LIVE_RIG_WORKSPACE || "Z:\\dominion-livetest";
const OUT = join(HERE, "live-results.json");

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { stages: {} };
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 2));
const log = (...a) => console.log("[live]", ...a);

async function sse(url, body, { onEvent, maxMs = 900_000, base = OWNER } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("live-suite timeout")), maxMs);
  const seen = [];
  try {
    const res = await fetch(base + url, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) return { ok: false, error: "HTTP " + res.status, events: seen };
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
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
        seen.push(ev);
        if (onEvent) onEvent(ev);
      }
    }
    return { ok: true, events: seen };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), events: seen };
  } finally { clearTimeout(timer); }
}

const jget = async (path, base = OWNER) => {
  const r = await fetch(base + path, { headers: { "cache-control": "no-store" } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const jpost = async (path, body, base = OWNER) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/*
 * Watch a Crucible build to its real ending: the job list is the heartbeat (done/stopped/waiting
 * are the only trustworthy terminals), and the SSE journal is the transcript. Every event kind the
 * build engine emits is summarized so a silent failure cannot read as success.
 */
async function watchIdeJob(jobId, maxMs = 1_500_000) {
  const out = { jobId, events: {}, moves: [], files: [], runs: [], questions: [], errors: [], outcome: "", waited: 0 };
  const deadline = Date.now() + maxMs;
  const ac = new AbortController();
  const reader = (async () => {
    try {
      const res = await fetch(OWNER + "/ide/job/attach?job=" + encodeURIComponent(jobId) + "&from=0", { signal: ac.signal });
      if (!res.ok || !res.body) return;
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          out.events[ev.type] = (out.events[ev.type] || 0) + 1;
          if (ev.type === "move") out.moves.push(`${ev.state || ""}:${(ev.title || "").slice(0, 70)}${ev.model ? " [" + ev.model + "]" : ""}`);
          else if (ev.type === "file") out.files.push(`${ev.path} (${ev.bytes || 0}b)`);
          else if (ev.type === "run") out.runs.push(`${(ev.command || "").slice(0, 60)} -> ${ev.ok ? "ok" : (ev.skipped ? "skipped" : "FAILED")}: ${String(ev.output || ev.message || "").replace(/\s+/g, " ").slice(0, 160)}`);
          else if (ev.type === "need_input") out.questions.push(String(ev.question || "").slice(0, 200));
          else if (ev.type === "error" || ev.type === "failed") out.errors.push(String(ev.message || ev.error || "").slice(0, 240));
          else if (ev.type === "done" || ev.type === "ended") out.outcome = String(ev.outcome || ev.state || "done");
        }
      }
    } catch {}
  })();
  let row = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await jget("/ide/jobs");
    row = ((st.body || {}).jobs || []).find((j) => j.id === jobId) || row;
    if (row && (row.done || row.stopped)) break;
    if (row && row.waiting && row.needsInput) { out.questions.push("WAITING: " + JSON.stringify(row.needsInput).slice(0, 200)); break; }
  }
  out.waited = Math.round((maxMs - (deadline - Date.now())) / 1000);
  out.finalRow = row ? JSON.stringify(row).slice(0, 500) : "job vanished from the list";
  try { ac.abort(); } catch {}
  await reader.catch(() => {});
  return out;
}

function treeOf(dir, depth = 0) {
  const out = [];
  if (depth > 4 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...treeOf(p, depth + 1));
    else out.push({ path: p, bytes: st.size });
  }
  return out;
}

// ---------------------------------------------------------------- A. chat build (non-flagship)
async function stageA() {
  const folder = join(WORKSPACE, "chat-build");
  mkdirSync(folder, { recursive: true });
  const model = process.env.LIVE_CHAT_MODEL || "deepseek/deepseek-v4-flash";
  const chatId = "live-chat-build-" + Date.now();
  const prompt = [
    "Build a tiny Node app in the folder " + folder + " on this machine, using your machine tools.",
    "It must contain exactly three files:",
    "  1. package.json  — name \"tally\", type module, a \"test\" script running \"node test.mjs\".",
    "  2. tally.mjs     — exports function tally(items) returning the sum of numeric values, ignoring non-numbers.",
    "  3. test.mjs      — imports tally, asserts tally([1,2,'x',3]) === 6 with node:assert, prints \"tally ok\".",
    "Then RUN the test with your shell tool and confirm it passes. Do not ask me questions; build it.",
  ].join("\n");

  const marks = { route: "", model: "", toolCalls: 0, toolOk: 0, completionAccepted: false, completionRejects: [],
                  supervisor: [], errors: [], machine: "", doneMeta: null, text: "" };
  log("A: chat build on", model, "->", folder);
  const r = await sse("/chat", { messages: [{ role: "user", content: prompt }], model, mode: "auto",
                                 privacyMode: "normal", temperature: 0.2, chatId }, {
    onEvent: (ev) => {
      if (ev.type === "route") { marks.route = ev.route || ""; marks.model = ev.model || ""; }
      else if (ev.type === "machine") marks.machine = ev.target || "";
      else if (ev.type === "tool") { if (ev.status === "run") marks.toolCalls++; else if (ev.status === "ok" || ev.status === "done") marks.toolOk++; }
      else if (ev.type === "supervisor") {
        marks.supervisor.push(`${ev.supervisor || ""}:${ev.decision || ev.completion || ""}`);
        if (ev.completion === "rejected" || ev.decision === "rejected") marks.completionRejects.push(String(ev.reason || ev.detail || "").slice(0, 200));
        if (ev.completion === "accepted" || ev.decision === "accepted") marks.completionAccepted = true;
      }
      else if (ev.type === "error") marks.errors.push(String(ev.message || ev.error || ev.code).slice(0, 240));
      else if (ev.type === "token") marks.text += ev.delta || "";
      else if (ev.type === "done") marks.doneMeta = ev.meta || null;
    },
  });
  const files = treeOf(folder);
  results.stages.A = { model, folder, transport: r.ok, error: r.error || "", marks: {
    ...marks, text: marks.text.slice(-1500), supervisor: marks.supervisor.slice(-40),
  }, files, filesFound: files.length,
    completionVerified: !!(marks.doneMeta && marks.doneMeta.completionVerified) };
  save();
  log("A done:", files.length, "files ·", marks.toolCalls, "tool calls · completionVerified=",
      !!(marks.doneMeta && marks.doneMeta.completionVerified), marks.errors.length ? "· errors: " + marks.errors[0] : "");
}

// ---------------------------------------------------------------- B. guest parity
async function stageB() {
  const out = { models: {}, account: {}, chat: {}, workshop: {}, notes: [], onboarding: {} };
  // A brand-new guest is correctly refused until they redeem a code, so parity starts by walking
  // the real front door: the owner mints a free (sponsored) code, the guest redeems it.
  const preChat = await sse("/chat", { messages: [{ role: "user", content: "hello" }], mode: "fast", chatId: "live-guest-pre" },
    { base: GUEST, maxMs: 60_000 });
  out.onboarding.beforeCode = (preChat.events.find((e) => e.type === "error") || {}).code || "none";
  const mint = await jpost("/admin/codes/mint", { type: "free", capUsd: 5, count: 1, note: "live-suite guest parity" });
  const code = (((mint.body || {}).codes || [])[0] || {}).code || "";
  const redeem = code ? await jpost("/account/redeem", { code }, GUEST) : { status: 0, body: { error: "no code minted" } };
  out.onboarding.mint = { status: mint.status, gotCode: !!code };
  out.onboarding.redeem = { status: redeem.status, body: JSON.stringify(redeem.body).slice(0, 240) };
  const gm = await jget("/api/models", GUEST); const om = await jget("/api/models", OWNER);
  const countIds = (p) => {
    const b = p.body || {}; const ids = new Set();
    for (const g of b.groups || []) for (const m of g.models || []) ids.add(m.id);
    for (const m of b.models || []) ids.add(m.id);
    return ids;
  };
  const gIds = countIds(gm), oIds = countIds(om);
  out.models = { guestCount: gIds.size, ownerCount: oIds.size, guestDefault: (gm.body || {}).default,
                 ownerDefault: (om.body || {}).default,
                 ownerOnly: [...oIds].filter((i) => !gIds.has(i)).slice(0, 12),
                 guestOnly: [...gIds].filter((i) => !oIds.has(i)).slice(0, 12) };
  out.account = { guest: (await jget("/account", GUEST)).body, owner: (await jget("/account", OWNER)).body };
  const ws = await jpost("/ide/workspace/new", { name: "guest-probe" }, GUEST);
  out.workshop = { status: ws.status, body: JSON.stringify(ws.body).slice(0, 400) };
  const gChat = await sse("/chat", { messages: [{ role: "user", content: "Reply with the single word: guest" }],
    model: (gm.body || {}).default || "", mode: "fast", privacyMode: "normal", chatId: "live-guest-" + Date.now() },
    { base: GUEST, maxMs: 120_000 });
  const gDone = gChat.events.find((e) => e.type === "done");
  const gErr = gChat.events.filter((e) => e.type === "error").map((e) => String(e.message || e.code).slice(0, 200));
  out.chat = { ok: !!gDone, errors: gErr, unitNoun: JSON.stringify(gChat.events.filter((e) => e.type === "budget")).slice(0, 300) };
  results.stages.B = out; save();
  log("B done: guest models", out.models.guestCount, "vs owner", out.models.ownerCount, "· guest chat ok:", out.chat.ok, gErr[0] || "");
}

// ---------------------------------------------------------------- C. crucible vibe (worst case)
async function stageC() {
  const folder = join(WORKSPACE, "crucible-build");
  mkdirSync(folder, { recursive: true });
  const out = { folder, windows: {}, relay: {}, tasks: null, build: {}, preview: {}, notes: [], errors: [] };

  const wsRes = await jpost("/ide/workspace", { name: "LiveVibe", root: folder, node: "livetest" });
  out.workspace = { status: wsRes.status, id: ((wsRes.body || {}).workspace || {}).id || "", body: JSON.stringify(wsRes.body).slice(0, 300) };
  const wsId = ((wsRes.body || {}).workspace || {}).id || "";

  // 1. Directives to all three ranks.
  const say = async (window, text, history = []) => {
    const r = await jpost("/ide/planchat", { window, mode: "vibe", register: "plain",
      messages: [...history, { role: "user", content: text }] });
    return { status: r.status, reply: String((r.body || {}).reply || (r.body || {}).error || "").slice(0, 900),
             model: (r.body || {}).model || "", error: (r.body || {}).error || "" };
  };
  const brief = "I want a tiny web page app called Ledger Lamp: one HTML page, one CSS file, one JS file, no frameworks, no build step. It shows a list of expenses I type in and a running total. Keep it to three files.";
  out.windows.general = await say("main", brief);
  out.windows.captain = await say("second", "The General is scoping a three-file expense page called Ledger Lamp. What is the single biggest thing that usually goes wrong with a build this small?");
  out.windows.sergeant = await say("third", "For a three-file no-framework expense page, name the one test that proves it actually works.");

  // 2. Cross-window relay: the Captain's opinion, forwarded to the General.
  const relayText = "FORWARD FROM CAPTAIN: " + (out.windows.captain.reply || "").slice(0, 400);
  out.relay.generalOnCaptain = await say("main", relayText, [{ role: "user", content: brief },
    { role: "assistant", content: out.windows.general.reply || "" }]);

  // 3. Orchestrator builds the tasks.
  const tasks = await jpost("/ide/tasks", { prompt: brief + " Build it in " + folder + ".", mode: "vibe", register: "plain", maxTasks: 5 });
  out.tasks = { status: tasks.status, count: ((tasks.body || {}).tasks || []).length,
                orchestrator: (tasks.body || {}).model || "", fellBackTo: (tasks.body || {}).fallbackModel || "",
                titles: ((tasks.body || {}).tasks || []).map((t) => t.title || t.name || "").slice(0, 8),
                error: (tasks.body || {}).error || "" };

  // 4. Worst-case model assignment: the smallest/cheapest model this catalog can put on a task.
  const cat = (await jget("/api/models")).body || {};
  const all = [];
  for (const g of cat.groups || []) for (const m of g.models || []) all.push(m);
  for (const m of cat.models || []) if (!all.find((x) => x.id === m.id)) all.push(m);
  const callable = all.filter((m) => m.available !== false && m.id !== "battalion");
  const cheapest = [...callable].sort((a, b) => ((a.outCost ?? 999) - (b.outCost ?? 999)) || ((a.paramsB ?? 0) - (b.paramsB ?? 0)))[0];
  const worst = (process.env.LIVE_WORST_MODEL || (cheapest && cheapest.id) || "");
  out.worstModel = worst;

  const jobBody = { kind: "build", workspaceId: wsId, mode: "vibe",
    prompt: brief + " Build it in " + folder + ". Create the three files and verify the page loads.",
    tasks: (tasks.body || {}).tasks || [],
    assignments: worst ? { build_code: worst, review: worst, plan: (tasks.body || {}).model || worst } : undefined };
  const job = await jpost("/ide/job", jobBody);
  const jobId = String((job.body || {}).jobId || ((job.body || {}).job || {}).id || "");
  out.build.start = { status: job.status, id: jobId, body: JSON.stringify(job.body).slice(0, 300) };
  if (jobId) out.build = { ...out.build, ...(await watchIdeJob(jobId)) };
  out.files = treeOf(folder);
  const prev = await jpost("/ide/preview/start", { workspaceId: wsId });
  out.preview = { status: prev.status, body: JSON.stringify(prev.body).slice(0, 400) };
  results.stages.C = out; save();
  log("C done: tasks", out.tasks && out.tasks.count, "· files", out.files.length, "· worst model", worst);
}

// ---------------------------------------------------------------- D. beginner
async function stageD() {
  const folder = join(WORKSPACE, "beginner-build");
  mkdirSync(folder, { recursive: true });
  const out = { folder, errors: [] };
  const wsRes = await jpost("/ide/workspace", { name: "LiveBeginner", root: folder, node: "livetest" });
  const wsId = ((wsRes.body || {}).workspace || {}).id || "";
  out.workspace = { status: wsRes.status, id: wsId };
  const intake = await jpost("/ide/intake", { mode: "beginner",
    messages: [{ role: "user", content: "I want a single web page that shows a random encouraging quote when I click a button. Three files at most." }] });
  out.intake = { status: intake.status, reply: String((intake.body || {}).reply || (intake.body || {}).error || "").slice(0, 600),
                 hasVision: !!(intake.body || {}).vision };
  const tasks = await jpost("/ide/tasks", { prompt: "A single web page that shows a random encouraging quote when I click a button. Build it in " + folder + ".", mode: "beginner", maxTasks: 4 });
  out.tasks = { status: tasks.status, count: ((tasks.body || {}).tasks || []).length, error: (tasks.body || {}).error || "" };
  const job = await jpost("/ide/job", { kind: "build", workspaceId: wsId, mode: "beginner",
    prompt: "A single web page that shows a random encouraging quote when I click a button. Build it in " + folder + ".",
    tasks: (tasks.body || {}).tasks || [] });
  const jobId = String((job.body || {}).jobId || ((job.body || {}).job || {}).id || "");
  out.build = { status: job.status, id: jobId };
  if (jobId) out.build = { ...out.build, ...(await watchIdeJob(jobId)) };
  out.files = treeOf(folder);
  const prev = await jpost("/ide/preview/start", { workspaceId: wsId });
  out.preview = { status: prev.status, body: JSON.stringify(prev.body).slice(0, 400) };
  results.stages.D = out; save();
  log("D done: files", out.files.length);
}

// ---------------------------------------------------------------- run
const up = await fetch(APP + "/api/version").then((r) => r.ok).catch(() => false);
if (!up) { console.error("[live] rig is not up on " + APP + " — start it with: node ops/live-rig.mjs " + BASE); process.exit(2); }
const nodes = await jget("/hands/nodes").catch(() => ({ body: {} }));
log("hands nodes:", JSON.stringify(nodes.body).slice(0, 200));
results.hands = JSON.stringify(nodes.body).slice(0, 300); save();

if (STAGE === "a" || STAGE === "all") await stageA();
if (STAGE === "b" || STAGE === "all") await stageB();
if (STAGE === "c" || STAGE === "all") await stageC();
if (STAGE === "d" || STAGE === "all") await stageD();
log("results ->", OUT);
