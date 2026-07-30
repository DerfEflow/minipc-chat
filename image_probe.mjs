/*
 * IMAGE PROBE (ARSENAL Wave 3) - run: node image_probe.mjs
 *
 * Ground truth for the Foundry's free draft lane: pulls the NVIDIA key from the Railway
 * service environment AT RUNTIME (never stored, never printed), lists every model NVIDIA
 * serves, filters for image-generation candidates, and live-probes each against NVIDIA's
 * actual invocation shape to confirm it returns a real image. Prints a results table and
 * nothing secret. Same key-pull pattern as fleet_probe.mjs (Wave 2).
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

const me = await gql(`query { me { workspaces { team { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } } }`).catch(async () => {
  return gql(`query { me { workspaces { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } } } }`);
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
console.log("keys: nvidia=" + (NVIDIA_KEY ? "present" : "MISSING"));
if (!NVIDIA_KEY) process.exit(1);

/* ---------- 1. what does NVIDIA actually serve, filtered for image models ------------------ */
const list = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { authorization: "Bearer " + NVIDIA_KEY }, signal: AbortSignal.timeout(30000) }).then((r) => r.json());
const served = (list.data || []).map((m) => m.id).sort();
console.log("\nNVIDIA serves " + served.length + " model ids total");
const imgPattern = /stable-diffusion|stability|flux|sdxl|sd3|sd-|kolors|dreamshaper|playground|deepfloyd|kandinsky|sana|hidream|photoreal|imagegen|image-gen|genai.*image|text-to-image/i;
const imgCandidates = served.filter((id) => imgPattern.test(id));
console.log("image-shaped candidates in /v1/models: " + imgCandidates.length);
imgCandidates.forEach((id) => console.log("  " + id));

// Known NVIDIA build.nvidia.com image model slugs worth trying even if absent from /v1/models
// (NVIDIA's image NIMs often live outside the chat-completions model list entirely).
const KNOWN_IMAGE_SLUGS = [
  "stabilityai/stable-diffusion-3-medium",
  "stabilityai/stable-diffusion-3_5-large",
  "stabilityai/sdxl-turbo",
  "stabilityai/stable-diffusion-xl",
  "black-forest-labs/flux.1-dev",
  "black-forest-labs/flux.1-schnell",
];

/* ---------- 2. live probes against NVIDIA's genai image invocation shape ------------------- */
async function probeImage(slug) {
  const out = { slug, ok: false, status: 0, hasImage: false, err: "" };
  try {
    const r = await fetch("https://ai.api.nvidia.com/v1/genai/" + slug, {
      method: "POST",
      headers: { authorization: "Bearer " + NVIDIA_KEY, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text_prompts: [{ text: "a single red apple on a white background, product photo" }], cfg_scale: 5, seed: 0, steps: 20, samples: 1 }),
      signal: AbortSignal.timeout(90000),
    });
    out.status = r.status;
    const j = await r.json().catch(() => ({}));
    out.ok = r.status === 200;
    out.hasImage = !!(j.image || j.artifacts?.[0]?.base64 || j.images?.[0] || j.data?.[0]?.b64_json);
    if (!out.ok) out.err = String(j.error || j.detail || JSON.stringify(j)).slice(0, 150);
  } catch (e) { out.err = String(e.message || e).slice(0, 150); }
  return out;
}

const candidates = [...new Set([...imgCandidates, ...KNOWN_IMAGE_SLUGS])];
console.log("\nprobing " + candidates.length + " candidate(s) against the genai image invocation shape...");
const results = [];
for (const slug of candidates) {
  const r = await probeImage(slug);
  results.push(r);
  console.log((r.ok && r.hasImage ? "ok  " : "XX  ") + slug + "  status=" + r.status + " hasImage=" + r.hasImage + (r.err ? "  err=" + r.err : ""));
}

console.log("\nSUMMARY (usable — returned an image):");
for (const r of results.filter((x) => x.ok && x.hasImage)) console.log("  " + r.slug);
console.log("REFUSED/ABSENT:");
for (const r of results.filter((x) => !(x.ok && x.hasImage))) console.log("  " + r.slug + "  status=" + r.status + "  " + r.err);
