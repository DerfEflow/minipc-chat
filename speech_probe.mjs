/*
 * SPEECH PROBE (ARSENAL Wave 4) - run: node speech_probe.mjs
 *
 * Ground truth for the voice rewire: pulls the NVIDIA key from the Railway service
 * environment AT RUNTIME (never stored, never printed) and probes every plausible
 * HTTP speech surface NVIDIA serves — OpenAI-compatible audio endpoints on
 * integrate.api.nvidia.com, genai-shaped NIM paths on ai.api.nvidia.com — for both
 * directions (TTS and ASR). ASR probes carry a real synthesized WAV (440Hz tone +
 * amplitude-modulated snippet), not silence, so "no speech found" is an honest miss
 * and an HTTP 200 with text is an honest hit. Prints a results table, nothing secret.
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

const me = await gql(`query { me { workspaces { team { projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } projects { edges { node { id name services { edges { node { id name } } } environments { edges { node { id name } } } } } } } } }`);
const projects = [];
for (const ws of me.me.workspaces || []) {
  for (const e of ws.projects?.edges || []) projects.push(e.node);
  for (const e of ws.team?.projects?.edges || []) projects.push(e.node);
}
const proj = projects.find((p) => /dominion/i.test(p.name));
const svc = (proj.services.edges || []).map((e) => e.node).find((s) => /dominion|minipc|app/i.test(s.name)) || proj.services.edges[0].node;
const env = (proj.environments.edges || []).map((e) => e.node).find((e) => /prod/i.test(e.name)) || proj.environments.edges[0].node;
const vars = await gql(`query($projectId:String!,$environmentId:String!,$serviceId:String!){ variables(projectId:$projectId, environmentId:$environmentId, serviceId:$serviceId) }`,
  { projectId: proj.id, environmentId: env.id, serviceId: svc.id });
const NVIDIA_KEY = (vars.variables || {}).NVIDIA_API_KEY || (vars.variables || {}).NVIDIA_KEY || "";
console.log("railway: project=" + proj.name + "  keys: nvidia=" + (NVIDIA_KEY ? "present" : "MISSING"));
if (!NVIDIA_KEY) process.exit(1);

/* ---------- 0. a real WAV to feed ASR probes (1s, 16kHz mono PCM16, modulated tone) ---------- */
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
const WAV = makeWav();

/* ---------- 1. what speech-shaped ids does the OpenAI-compatible list serve? ---------------- */
const list = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { authorization: "Bearer " + NVIDIA_KEY }, signal: AbortSignal.timeout(30000) }).then((r) => r.json());
const served = (list.data || []).map((m) => m.id).sort();
const speechPattern = /tts|asr|speech|audio|voice|riva|magpie|parakeet|canary|whisper|fastpitch|hifigan|transcri/i;
const speechIds = served.filter((id) => speechPattern.test(id));
console.log("\nintegrate /v1/models serves " + served.length + " ids; speech-shaped: " + speechIds.length);
speechIds.forEach((id) => console.log("  " + id));

/* ---------- 2. probe matrix ------------------------------------------------------------------ */
const results = [];
async function probe(label, fn) {
  try {
    const r = await fn();
    results.push({ label, ...r });
    console.log((r.ok ? "ok  " : "XX  ") + label + "  status=" + r.status + (r.note ? "  " + r.note : "") + (r.err ? "  err=" + r.err : ""));
  } catch (e) {
    results.push({ label, ok: false, status: 0, err: String(e.message || e).slice(0, 120) });
    console.log("XX  " + label + "  err=" + String(e.message || e).slice(0, 120));
  }
}

// 2a. OpenAI-compatible TTS on integrate: POST /v1/audio/speech
const TTS_CANDIDATES = [...new Set([...speechIds.filter((id) => /tts|magpie|fastpitch/i.test(id)),
  "nvidia/magpie-tts-multilingual", "nvidia/magpie-tts-flow", "nvidia/fastpitch-hifigan-tts"])];
for (const model of TTS_CANDIDATES) {
  await probe("integrate /v1/audio/speech  " + model, async () => {
    const r = await fetch("https://integrate.api.nvidia.com/v1/audio/speech", {
      method: "POST", headers: { authorization: "Bearer " + NVIDIA_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model, input: "The forge is hot and the work is ready.", voice: "default", response_format: "mp3" }),
      signal: AbortSignal.timeout(60000),
    });
    const ct = r.headers.get("content-type") || "";
    if (r.status === 200 && /audio|octet/.test(ct)) {
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, status: 200, note: "AUDIO " + ct + " " + buf.length + "b" };
    }
    const t = (await r.text()).slice(0, 140);
    return { ok: false, status: r.status, err: t };
  });
}

// 2b. genai-shaped TTS on ai.api.nvidia.com
for (const slug of ["nvidia/magpie-tts-multilingual", "nvidia/magpie-tts-flow", "nvidia/fastpitch-hifigan-tts"]) {
  await probe("ai.api genai  " + slug, async () => {
    const r = await fetch("https://ai.api.nvidia.com/v1/genai/" + slug, {
      method: "POST", headers: { authorization: "Bearer " + NVIDIA_KEY, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "The forge is hot.", input: "The forge is hot.", voice: "default" }),
      signal: AbortSignal.timeout(60000),
    });
    const ct = r.headers.get("content-type") || "";
    if (r.status === 200) {
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, status: 200, note: ct + " " + buf.length + "b" };
    }
    const t = (await r.text()).slice(0, 140);
    return { ok: false, status: r.status, err: t };
  });
}

// 2c. OpenAI-compatible ASR on integrate: POST /v1/audio/transcriptions (multipart)
const ASR_CANDIDATES = [...new Set([...speechIds.filter((id) => /asr|whisper|canary|parakeet|transcri/i.test(id)),
  "nvidia/canary-1b-asr", "nvidia/parakeet-ctc-1.1b-asr", "openai/whisper-large-v3", "nvidia/whisper-large-v3"])];
for (const model of ASR_CANDIDATES) {
  await probe("integrate /v1/audio/transcriptions  " + model, async () => {
    const boundary = "----dominionprobe" + Math.random().toString(36).slice(2);
    const part = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const head = Buffer.from(part("model", model) + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
    const body = Buffer.concat([head, WAV, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = await fetch("https://integrate.api.nvidia.com/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: "Bearer " + NVIDIA_KEY, "content-type": "multipart/form-data; boundary=" + boundary },
      body, signal: AbortSignal.timeout(60000),
    });
    const t = (await r.text()).slice(0, 140);
    return { ok: r.status === 200, status: r.status, note: r.status === 200 ? "RESP " + t : "", err: r.status === 200 ? "" : t };
  });
}

/* ---------- 3. summary ----------------------------------------------------------------------- */
console.log("\nSUMMARY (usable surfaces):");
for (const r of results.filter((x) => x.ok)) console.log("  " + r.label + "  " + (r.note || ""));
console.log("REFUSED/ABSENT: " + results.filter((x) => !x.ok).length + " probes (detail above)");
