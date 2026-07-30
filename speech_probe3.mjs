/*
 * SPEECH PROBE round 3 (ARSENAL Wave 4) - exact NVCF invocation shapes.
 * Invokes the speech functions found in round 2 over HTTP (pexec) with candidate payload
 * shapes until one answers, and prints the RESPONSE SHAPE (keys, content-type, sizes),
 * never the audio itself. Also generates a tiny spoken-ish WAV for ASR.
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

function makeWav() {
  const sr = 16000, secs = 1.0, n = Math.floor(sr * secs);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const s = Math.sin(2 * Math.PI * 440 * t) * (0.4 + 0.35 * Math.sin(2 * Math.PI * 3 * t));
    data.writeInt16LE(Math.round(s * 32767 * 0.6), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV_B64 = makeWav().toString("base64");

const FN = {
  magpieMulti: "877104f7-e885-42b9-8de8-f6e4c6303969",
  whisper: "b702f636-f60c-4a3d-a6f4-f3568c13bd7d",
  parakeet11b: "1598d209-5e27-4d3c-8079-4751568b1081",
};

function shapeOf(o, depth = 0) {
  if (o === null) return "null";
  if (Array.isArray(o)) return "[" + (o.length ? shapeOf(o[0], depth + 1) : "") + "] x" + o.length;
  if (typeof o === "string") return o.length > 80 ? "<string " + o.length + ">" : JSON.stringify(o);
  if (typeof o !== "object") return String(o);
  if (depth > 3) return "{...}";
  return "{" + Object.entries(o).map(([k, v]) => k + ": " + shapeOf(v, depth + 1)).join(", ") + "}";
}

async function invoke(fnId, body, label) {
  try {
    const r = await fetch("https://api.nvcf.nvidia.com/v2/nvcf/pexec/functions/" + fnId, {
      method: "POST",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json", accept: "application/json", "NVCF-POLL-SECONDS": "60" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
    const ct = r.headers.get("content-type") || "";
    if (/json/.test(ct)) {
      const j = await r.json().catch(() => ({}));
      console.log((r.status === 200 ? "ok  " : "XX  ") + label + "  status=" + r.status + "  shape=" + shapeOf(j).slice(0, 400));
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      console.log((r.status === 200 ? "ok  " : "XX  ") + label + "  status=" + r.status + "  ct=" + ct + "  " + buf.length + "b  head=" + buf.slice(0, 12).toString("hex"));
    }
  } catch (e) {
    console.log("XX  " + label + "  err=" + String(e.message || e).slice(0, 140));
  }
}

console.log("--- magpie-tts-multilingual shapes ---");
await invoke(FN.magpieMulti, { text: "The forge is hot and the work is ready." }, "magpie {text}");
await invoke(FN.magpieMulti, { input: "The forge is hot and the work is ready." }, "magpie {input}");
await invoke(FN.magpieMulti, { text: "The forge is hot.", voice_name: "Magpie-Multilingual.EN-US.Sofia", language_code: "en-US" }, "magpie riva-shape");

console.log("--- whisper-large-v3 shapes ---");
await invoke(FN.whisper, { audio: WAV_B64 }, "whisper {audio:b64}");
await invoke(FN.whisper, { input: WAV_B64 }, "whisper {input:b64}");
await invoke(FN.whisper, { audio: WAV_B64, encoding: "LINEAR_PCM", sample_rate_hz: 16000, language_code: "en-US" }, "whisper riva-shape");

console.log("--- parakeet-ctc-1.1b shapes ---");
await invoke(FN.parakeet11b, { audio: WAV_B64, encoding: "LINEAR_PCM", sample_rate_hz: 16000, language_code: "en-US" }, "parakeet riva-shape");
