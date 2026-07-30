/*
 * SPEECH PROBE round 2 (ARSENAL Wave 4) - the NVCF surface.
 * Lists functions visible to the account on api.nvcf.nvidia.com and tries HTTP invocation
 * of anything speech-shaped. Same key discipline as speech_probe.mjs.
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

// 1. list functions this key can see
const fl = await fetch("https://api.nvcf.nvidia.com/v2/nvcf/functions", {
  headers: { authorization: "Bearer " + KEY, accept: "application/json" }, signal: AbortSignal.timeout(30000) });
console.log("GET /v2/nvcf/functions -> " + fl.status);
if (fl.status === 200) {
  const j = await fl.json();
  const fns = j.functions || [];
  console.log("functions visible: " + fns.length);
  const speech = fns.filter((f) => /tts|asr|speech|voice|riva|magpie|parakeet|canary|whisper|audio/i.test((f.name || "") + " " + (f.id || "")));
  console.log("speech-shaped: " + speech.length);
  for (const f of speech.slice(0, 40)) console.log("  " + f.id + "  " + f.name + "  status=" + f.status);
} else {
  console.log((await fl.text()).slice(0, 200));
}
