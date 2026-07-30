/*
 * EMBED/RERANK PROBE (ARSENAL Wave 5) - run: node embed_rerank_probe.mjs
 * Pulls the NVIDIA key from the Railway env AT RUNTIME (never stored, never printed), lists
 * embedding/rerank-shaped ids, and live-probes: the OpenAI-compatible /v1/embeddings surface
 * (with the nv-embedqa input_type requirement) and the retrieval reranking surface. Prints
 * dimensions and score shapes — the facts the wiring must not guess.
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
console.log("nvidia key: " + (KEY ? "present" : "MISSING"));
if (!KEY) process.exit(1);

/* ---------- 1. embedding/rerank-shaped ids on the OpenAI-compatible list -------------------- */
const list = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(30000) }).then((r) => r.json());
const served = (list.data || []).map((m) => m.id).sort();
const embedIds = served.filter((id) => /embed|rerank|retriev/i.test(id));
console.log("embedding/rerank-shaped ids in /v1/models: " + embedIds.length);
embedIds.forEach((id) => console.log("  " + id));

/* ---------- 2. embeddings probes ------------------------------------------------------------- */
const EMBED_CANDIDATES = [...new Set([...embedIds.filter((id) => /embed/i.test(id)),
  "nvidia/llama-3.2-nv-embedqa-1b-v2", "nvidia/nv-embedqa-e5-v5", "nvidia/nv-embedqa-mistral-7b-v2", "baai/bge-m3"])];
for (const model of EMBED_CANDIDATES) {
  for (const shape of [
    { label: "input_type=query", body: { model, input: ["what temperature does the forge run at"], input_type: "query" } },
    { label: "plain", body: { model, input: ["what temperature does the forge run at"] } },
  ]) {
    try {
      const r = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
        method: "POST", headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
        body: JSON.stringify(shape.body), signal: AbortSignal.timeout(45000) });
      const j = await r.json().catch(() => ({}));
      const vec = j.data && j.data[0] && j.data[0].embedding;
      if (r.status === 200 && Array.isArray(vec)) {
        console.log("ok  embed " + model + " (" + shape.label + ")  dims=" + vec.length);
        break; // shape found for this model
      }
      console.log("XX  embed " + model + " (" + shape.label + ")  status=" + r.status + "  " + JSON.stringify(j).slice(0, 120));
    } catch (e) { console.log("XX  embed " + model + " (" + shape.label + ")  err=" + String(e.message || e).slice(0, 100)); }
  }
}

/* ---------- 3. rerank probes ------------------------------------------------------------------ */
const PASSAGES = [
  "The forge runs at 1400 degrees when smelting bronze alloys.",
  "The cafeteria closes at 3pm on weekdays.",
  "Forge temperature control uses a copper thermocouple rated to 1600 degrees.",
];
const RERANK_CANDIDATES = [...new Set([...embedIds.filter((id) => /rerank/i.test(id)),
  "nvidia/llama-3.2-nv-rerankqa-1b-v2", "nv-rerank-qa-mistral-4b:1"])];
for (const model of RERANK_CANDIDATES) {
  const slug = model.replace(/\./g, "_").replace(/:.*/, "");
  for (const target of [
    { label: "ai.api retrieval", url: "https://ai.api.nvidia.com/v1/retrieval/" + slug + "/reranking" },
    { label: "ai.api retrieval (raw id)", url: "https://ai.api.nvidia.com/v1/retrieval/" + model + "/reranking" },
    { label: "integrate /v1/ranking", url: "https://integrate.api.nvidia.com/v1/ranking" },
  ]) {
    try {
      const r = await fetch(target.url, {
        method: "POST", headers: { authorization: "Bearer " + KEY, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model, query: { text: "what temperature does the forge run at" }, passages: PASSAGES.map((text) => ({ text })) }),
        signal: AbortSignal.timeout(45000) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && Array.isArray(j.rankings)) {
        console.log("ok  rerank " + model + " via " + target.label + "  rankings=" + JSON.stringify(j.rankings).slice(0, 160));
        break;
      }
      console.log("XX  rerank " + model + " via " + target.label + "  status=" + r.status + "  " + JSON.stringify(j).slice(0, 120));
    } catch (e) { console.log("XX  rerank " + model + " via " + target.label + "  err=" + String(e.message || e).slice(0, 100)); }
  }
}
