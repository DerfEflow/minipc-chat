/*
 * Tool-capability audit — run: node tools_audit.mjs
 * Compares every OpenRouter model in models.catalog.mjs against OpenRouter's LIVE model list:
 *   - does the id exist at all (dead ids 404 at chat time)?
 *   - does supported_parameters include "tools" (else any tools-attached request dies with
 *     "No endpoints found that support tool use")?
 *   - context length drift (catalog ctx vs live ctx).
 * Direct-provider models (openai/anthropic/deepseek) are listed for manual eyes; their chat models
 * all support tools, so the risk there is dead ids, which this prints for checking against each
 * provider's model list. Reads OPENROUTER_API_KEY from the wallet when present (better rate limits);
 * works without it. Exit code 1 when any mislabel or dead id is found.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MODELS, modelById, TENANT_DEFAULT_MODEL, DEFAULT_MODEL, UTILITY_MODEL } from "./models.catalog.mjs";

let KEY = "";
try {
  for (const l of readFileSync(join(homedir(), ".app-secrets.env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$/);
    if (m) KEY = m[1].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}

const res = await fetch("https://openrouter.ai/api/v1/models", {
  headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ...(KEY ? { authorization: "Bearer " + KEY } : {}) },
});
if (!res.ok) { console.error("OpenRouter model list failed: HTTP " + res.status); process.exit(2); }
const live = new Map(((await res.json()).data || []).map((m) => [m.id, m]));
console.log("live OpenRouter catalog: " + live.size + " models\n");

let bad = 0;
const rows = [];
for (const raw of MODELS) {
  const m = modelById(raw.id);   // finalized: category defaults resolved into the real runtime flag
  const special = [m.id === TENANT_DEFAULT_MODEL ? "GUEST-DEFAULT" : "", m.id === DEFAULT_MODEL ? "OWNER-DEFAULT" : "", m.id === UTILITY_MODEL ? "UTILITY" : ""].filter(Boolean).join("+");
  if (m.provider !== "openrouter") { rows.push(["DIRECT", m.id, `provider=${m.provider} · toolCapable=${m.toolCapable}${special ? " · " + special : ""}`]); continue; }
  const l = live.get(m.id);
  if (!l) { bad++; rows.push(["DEAD-ID", m.id, `NOT on OpenRouter — every call 404s${special ? " · " + special : ""}`]); continue; }
  const supportsTools = (l.supported_parameters || []).includes("tools");
  if (m.toolCapable && !supportsTools) { bad++; rows.push(["MISLABEL", m.id, `runtime sends tools, OpenRouter has no tool endpoints — the exact launch error${special ? " · " + special : ""}`]); }
  else if (!m.toolCapable && supportsTools) { rows.push(["UNDERSELL", m.id, "supports tools but flagged chat-only (works, just underpowered)"]); }
  else rows.push([supportsTools ? "OK-TOOLS" : "OK-CHAT", m.id, `tools=${supportsTools}${special ? " · " + special : ""}`]);
  const liveCtx = l.context_length || 0;
  if (m.ctx && liveCtx && Math.abs(m.ctx - liveCtx) / liveCtx > 0.5) rows.push(["CTX-DRIFT", m.id, `catalog ${m.ctx} vs live ${liveCtx}`]);
}

for (const [tag, id, note] of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(tag.padEnd(10), id.padEnd(52), note);
}
console.log(`\n${bad ? "PROBLEMS: " + bad : "no fatal mislabels"} (MISLABEL + DEAD-ID are launch-day errors)`);
process.exitCode = bad ? 1 : 0;
