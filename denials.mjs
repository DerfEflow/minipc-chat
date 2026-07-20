/*
 * denials.mjs - the forbidden-access log.
 *
 * Fred's requirement (2026-07-19): "I want a log of every attempt to access a drive or file that I
 * have forbidden, EVEN IF IT FAILED, reported at the weekly security check."
 *
 * The point is the word "even". A refusal that leaves no trace tells you nothing about whether a
 * model is probing the wall once by accident or a hundred times on purpose. This records every
 * refusal with enough identity to answer that, and nothing sensitive enough to become a liability.
 *
 * TWO LAYERS feed this, deliberately:
 *   app/node layer   the carve-out regex refuses and calls record() here. Catches the obvious.
 *   OS layer         D: carries a Deny ACE for the node's account plus a failure-audit SACL, so
 *                    Windows itself logs event 4656/4663 for attempts the regex never saw (a
 *                    UNC path, a subst'd letter, a junction). readOsDenials() reads those.
 *
 * The second layer is the one that matters. The regex only catches spellings we anticipated.
 * Windows catches the ones we did not.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let LOG_PATH = "";

export function initDenials(opts = {}) {
  const dir = String(opts.dir || "");
  if (!dir) return { path: "" };
  try { mkdirSync(dir, { recursive: true }); } catch { /* caller surfaces */ }
  LOG_PATH = join(dir, "denials.jsonl");
  return { path: LOG_PATH };
}

/*
 * Arguments can carry anything a model typed, including a pasted secret. We keep the SHAPE of the
 * attempt (which paths, which tool) and drop the payload. A denial log that leaks credentials is a
 * worse problem than the one it was built to solve.
 */
const SECRETISH = /(?:pass(?:word|phrase)?|secret|token|key|authorization|cookie)\s*[=:]\s*\S+/gi;
function redact(args) {
  let blob;
  try { blob = JSON.stringify(args ?? {}); } catch { return "(unserializable)"; }
  if (blob.length > 600) blob = blob.slice(0, 600) + "...(truncated)";
  return blob.replace(SECRETISH, (m) => m.split(/[=:]/)[0] + "=[redacted]");
}

export function recordDenial(entry = {}) {
  const row = {
    at: new Date().toISOString(),
    source: entry.source || "app",          // app | node | hub | connector | os
    tool: entry.tool || null,
    reason: entry.reason || null,
    user: entry.user || null,               // uid or "owner"
    role: entry.role || null,
    model: entry.model || null,
    node: entry.node || null,
    args: redact(entry.args),
  };
  if (LOG_PATH) {
    try { appendFileSync(LOG_PATH, JSON.stringify(row) + "\n"); } catch { /* never break a turn over logging */ }
  }
  // Always console-log too: on Railway this lands in the deployment log even if the volume is lost.
  console.warn(`[dominion-ai] DENIED ${row.source}/${row.tool} user=${row.user || "?"} model=${row.model || "?"} :: ${row.reason}`);
  return row;
}

export function readDenials({ sinceMs = 0, limit = 500 } = {}) {
  if (!LOG_PATH || !existsSync(LOG_PATH)) return [];
  let lines = [];
  try { lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (sinceMs && Date.parse(row.at) < sinceMs) break;
      out.push(row);
    } catch { /* skip a torn line */ }
  }
  return out.reverse();
}

/*
 * The weekly security check calls this. Counts matter more than individual lines: one refusal is a
 * model bumping into a wall, forty in an hour is something to look at.
 */
export function denialSummary({ days = 7 } = {}) {
  const since = Date.now() - days * 86400000;
  const rows = readDenials({ sinceMs: since, limit: 5000 });
  const byTool = {}, bySource = {}, byUser = {}, byModel = {};
  for (const r of rows) {
    byTool[r.tool || "?"] = (byTool[r.tool || "?"] || 0) + 1;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    byUser[r.user || "?"] = (byUser[r.user || "?"] || 0) + 1;
    if (r.model) byModel[r.model] = (byModel[r.model] || 0) + 1;
  }
  return {
    days, total: rows.length,
    byTool, bySource, byUser, byModel,
    firstAt: rows.length ? rows[0].at : null,
    lastAt: rows.length ? rows[rows.length - 1].at : null,
    recent: rows.slice(-25),
  };
}

/*
 * Layer two: ask Windows what it refused. Requires the failure-audit SACL applied to D: on
 * 2026-07-19. Returns [] on Linux (the Railway container has no D: and no Security log), which is
 * correct rather than an error: the cloud app is not where the backups live.
 */
export async function readOsDenials({ hours = 168, runShell = null, node = null } = {}) {
  if (!runShell) return { available: false, reason: "no shell available to query the Security log", events: [] };
  const ps = `Get-WinEvent -FilterHashtable @{LogName='Security';Id=4656,4663;StartTime=(Get-Date).AddHours(-${Number(hours) || 168})} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'D:' } | Select-Object -First 100 TimeCreated,Id,@{n='Msg';e={$_.Message.Split([Environment]::NewLine)[0]}} | ConvertTo-Json -Compress`;
  try {
    const r = await runShell(ps, 30000);
    if (!r || !r.ok) return { available: false, reason: (r && (r.error || r.stderr)) || "query failed", events: [], node };
    const txt = String(r.stdout || "").trim();
    if (!txt) return { available: true, events: [], node };
    const parsed = JSON.parse(txt);
    return { available: true, events: Array.isArray(parsed) ? parsed : [parsed], node };
  } catch (e) {
    return { available: false, reason: String(e && e.message || e), events: [], node };
  }
}
