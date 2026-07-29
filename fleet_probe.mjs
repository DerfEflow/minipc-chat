/*
 * FLEET PROBE (ARSENAL Wave 2) - run: node fleet_probe.mjs [pattern]
 *
 * Ground truth for the Free Fleet: pulls the NVIDIA + Moonshot keys from the Railway service
 * environment AT RUNTIME (never stored, never printed), lists every model the NVIDIA endpoint
 * actually serves, and live-probes candidates for the three facts the catalog must never guess:
 * does it answer, does it emit a real tool call, does it accept an image. Prints a results table
 * and nothing secret.
 *
 * Also verifies the directIds shipped blind in 1917d24 (nemotron ultra/super, kimi k2.6).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const wallet = readFileSync(join(homedir(), ".app-secrets.env"), "utf8");
const kv = Object.fromEntries(wallet.split(/\r?\n/).filter((l) => /^[A-Za-z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const RW = kv.RAILWAY_ACCOUNT_TOKEN;
if (!RW) { console.error("no Railway account token in wallet"); process.exit(1); }

async function gql(query, variables = {}) {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + RW },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.errors) throw new Error("railway: " + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

// Find the dominion service (the app at app.dominion.tools) and read its env.
const me = await gql(`query { me { workspaces { team { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } } }`).catch(async () => {
  return gql(`query { me { workspaces { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } } }`);
});
const projects = [];
for (const ws of me.me.workspaces || []) {
  for (const e of ws.projects?.edges || []) projects.push(e.node);
  for (const e of ws.team?.projects?.edges || []) projects.push(e.node);
}
const proj = projects.find((p) => /dominion/i.test(p.name)) || projects.find((p) => (p.services.edges || []).some((s) => /dominion|minipc/i.test(s.node.name)));
if (!proj) { console.error("no dominion project found; projects: " + projects.map((p) => p.name).join(", ")); process.exit(1); }
const svc = (proj.services.edges || []).map((e) => e.node).find((s) => /dominion|minipc|app/i.test(s.name)) || proj.services.edges[0].node;
const env = (proj.environments.edges || []).map((e) => e.node).find((e) => /prod/i.test(e.name)) || proj.environments.edges[0].node;
console.log("railway: project=" + proj.name + " service=" + svc.name + " env=" + env.name);

const vars = await gql(`query($projectId:String!,$environmentId:String!,$serviceId:String!){ variables(projectId:$projectId, environmentId:$environmentId, serviceId:$serviceId) }`,
  { projectId: proj.id, environmentId: env.id, serviceId: svc.id });
const V = vars.variables || {};
const NVIDIA_KEY = V.NVIDIA_API_KEY || V.NVIDIA_KEY || "";
const MOONSHOT_KEY = V.MOONSHOT_API_KEY || V.MOONSHOT_KEY || "";
console.log("keys: nvidia=" + (NVIDIA_KEY ? "present" : "MISSING") + " moonshot=" + (MOONSHOT_KEY ? "present" : "MISSING"));
if (!NVIDIA_KEY) process.exit(1);

/* ---------- 1. what does NVIDIA actually serve? -------------------------------------------- */
const list = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { authorization: "Bearer " + NVIDIA_KEY }, signal: AbortSignal.timeout(30000) }).then((r) => r.json());
const served = (list.data || []).map((m) => m.id).sort();
console.log("\nNVIDIA serves " + served.length + " model ids");
const pattern = process.argv[2] ? new RegExp(process.argv[2], "i") : null;
if (pattern) { for (const id of served.filter((i) => pattern.test(i))) console.log("  " + id); }

/* ---------- 2. live probes ------------------------------------------------------------------ */
const TOOL_DEF = [{ type: "function", function: { name: "write_note", description: "Write a short note to the user's notebook.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } }];
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function probe(id) {
  const out = { id, answers: false, tools: false, vision: false, err: "" };
  const call = async (body) => {
    // 75s per call: reasoning models think before one word, and the free tier can queue. A model
    // that cannot answer a one-word prompt inside 75s fails the probe honestly.
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + NVIDIA_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: id, max_tokens: 60, ...body }), signal: AbortSignal.timeout(75000) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  try {
    const a = await call({ messages: [{ role: "user", content: "Reply with the word: ready" }] });
    out.answers = a.status === 200 && !!(a.j.choices && a.j.choices[0]);
    if (!out.answers) { out.err = String(a.j.error && a.j.error.message || a.status).slice(0, 90); return out; }
    const t = await call({ messages: [{ role: "user", content: "Write the note HELLO using the tool." }], tools: TOOL_DEF, tool_choice: "auto" });
    const calls = t.status === 200 && t.j.choices && t.j.choices[0].message && t.j.choices[0].message.tool_calls;
    out.tools = !!(calls && calls.length && calls[0].function && /write_note/.test(calls[0].function.name));
    const v = await call({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: PIXEL } }, { type: "text", text: "One word: what color?" }] }] });
    out.vision = v.status === 200 && !!(v.j.choices && v.j.choices[0]);
  } catch (e) { out.err = String(e.message || e).slice(0, 90); }
  return out;
}

// Candidates: the ids we shipped blind, plus the fleet candidates that exist in the served list.
const CANDIDATES = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3-super-120b-a12b",
].concat(served.filter((id) => /nemotron-3-nano|llama-4|deepseek|qwen3|kimi|glm|minimax|gpt-oss|step|ernie|solar/i.test(id)).slice(0, 24));
const seen = new Set();
const results = [];
for (const id of CANDIDATES) {
  if (seen.has(id)) continue; seen.add(id);
  const inServed = served.includes(id);
  if (!inServed) { results.push({ id, answers: false, tools: false, vision: false, err: "NOT SERVED (id wrong or retired)" }); continue; }
  const r = await probe(id);
  results.push(r);
  console.log((r.answers ? "ok " : "XX ") + id + "  tools=" + r.tools + " vision=" + r.vision + (r.err ? "  err=" + r.err : ""));
}

/* ---------- 3. Moonshot directId verification ----------------------------------------------- */
if (MOONSHOT_KEY) {
  for (const id of ["kimi-k3", "kimi-k2.6"]) {
    try {
      const r = await fetch("https://api.moonshot.ai/v1/chat/completions", { method: "POST",
        headers: { authorization: "Bearer " + MOONSHOT_KEY, "content-type": "application/json" },
        body: JSON.stringify({ model: id, max_tokens: 8, messages: [{ role: "user", content: "Say: ok" }] }) });
      const j = await r.json().catch(() => ({}));
      console.log("moonshot " + id + ": " + (r.status === 200 ? "VERIFIED" : "HTTP " + r.status + " " + String(j.error && j.error.message || "").slice(0, 90)));
    } catch (e) { console.log("moonshot " + id + ": " + String(e.message || e).slice(0, 90)); }
  }
}

console.log("\nSUMMARY (candidates that answered):");
for (const r of results.filter((x) => x.answers)) console.log("  " + r.id + "  tools=" + r.tools + " vision=" + r.vision);
console.log("REFUSED/ABSENT:");
for (const r of results.filter((x) => !x.answers)) console.log("  " + r.id + "  " + r.err);
