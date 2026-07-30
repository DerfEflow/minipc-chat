/*
 * RERANK PROBE round 2 (ARSENAL Wave 5): find the CURRENT reranker surface.
 * Round 1 found the 2024-era rerank endpoints EOL'd (410 Gone). This lists NVCF functions
 * for rerank-shaped names and probes both the function-slug retrieval path and pexec.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const wallet = readFileSync(join(homedir(), ".app-secrets.env"), "utf8");
const kv = Object.fromEntries(wallet.split(/\r?\n/).filter((l) => /^[A-Za-z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const RW = kv.RAILWAY_ACCOUNT_TOKEN;
async function gql(query, variables = {}) {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + RW },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300)); return j.data;
}
const me = await gql(`query { me { workspaces { team { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } } }`);
const projects = [];
for (const ws of me.me.workspaces || []) { for (const e of ws.projects?.edges || []) projects.push(e.node); for (const e of ws.team?.projects?.edges || []) projects.push(e.node); }
const proj = projects.find((p) => /dominion/i.test(p.name));
const svc = (proj.services.edges || []).map((e) => e.node).find((s) => /dominion|minipc|app/i.test(s.name)) || proj.services.edges[0].node;
const env = (proj.environments.edges || []).map((e) => e.node).find((e) => /prod/i.test(e.name)) || proj.environments.edges[0].node;
const vars = await gql(`query($projectId:String!,$environmentId:String!,$serviceId:String!){ variables(projectId:$projectId, environmentId:$environmentId, serviceId:$serviceId) }`,
  { projectId: proj.id, environmentId: env.id, serviceId: svc.id });
const KEY = (vars.variables || {}).NVIDIA_API_KEY || "";
if (!KEY) { console.error("no key"); process.exit(1); }

const fl = await fetch("https://api.nvcf.nvidia.com/v2/nvcf/functions", {
  headers: { authorization: "Bearer " + KEY, accept: "application/json" }, signal: AbortSignal.timeout(30000) });
const j = await fl.json();
const fns = j.functions || [];
const rr = fns.filter((f) => /rerank|rank|retriev/i.test(f.name || ""));
console.log("rerank/retrieval-shaped NVCF functions: " + rr.length);
for (const f of rr) console.log("  " + f.id + "  " + f.name + "  status=" + f.status);

const PASSAGES = [
  "The forge runs at 1400 degrees when smelting bronze alloys.",
  "The cafeteria closes at 3pm on weekdays.",
  "Forge temperature control uses a copper thermocouple rated to 1600 degrees.",
];
const bodyOf = (model) => JSON.stringify({ model, query: { text: "what temperature does the forge run at" }, passages: PASSAGES.map((text) => ({ text })) });

for (const f of rr.filter((x) => x.status === "ACTIVE").slice(0, 8)) {
  // try pexec invocation
  try {
    const r = await fetch("https://api.nvcf.nvidia.com/v2/nvcf/pexec/functions/" + f.id, {
      method: "POST", headers: { authorization: "Bearer " + KEY, "content-type": "application/json", accept: "application/json" },
      body: bodyOf(f.name.replace(/^ai-/, "nvidia/")), signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    console.log((r.status === 200 ? "ok  " : "XX  ") + "pexec " + f.name + "  status=" + r.status + "  " + t.slice(0, 160));
  } catch (e) { console.log("XX  pexec " + f.name + "  err=" + String(e.message || e).slice(0, 100)); }
}

// also try modern slug guesses on the retrieval path
for (const slug of ["nvidia/nemotron-3-rerank-1b", "nvidia/llama-nemotron-rerank-1b-v2", "nvidia/llama-3_2-nemoretriever-500m-rerank-v2", "nvidia/llama-3.2-nemoretriever-500m-rerank-v2"]) {
  try {
    const r = await fetch("https://ai.api.nvidia.com/v1/retrieval/" + slug + "/reranking", {
      method: "POST", headers: { authorization: "Bearer " + KEY, "content-type": "application/json", accept: "application/json" },
      body: bodyOf(slug), signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    console.log((r.status === 200 ? "ok  " : "XX  ") + "retrieval " + slug + "  status=" + r.status + "  " + t.slice(0, 160));
  } catch (e) { console.log("XX  retrieval " + slug + "  err=" + String(e.message || e).slice(0, 100)); }
}
