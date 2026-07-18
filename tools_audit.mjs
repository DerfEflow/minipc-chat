/*
 * Tool-capability audit CLI — run: node tools_audit.mjs
 * Thin wrapper over catalogaudit.mjs (the same module the deployed server runs weekly and on boot).
 * Reads provider keys from the wallet when present; missing keys just skip that provider's check.
 * Exit code 1 when any launch-day problem (mislabel / dead id) is found.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runCatalogAudit } from "./catalogaudit.mjs";

const wallet = {};
try {
  for (const l of readFileSync(join(homedir(), ".app-secrets.env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) wallet[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch {}

const r = await runCatalogAudit({
  openrouter: wallet.OPENROUTER_API_KEY,
  openai: wallet.OPEN_AI_DOMINION_UI_APIKEY || wallet.OPENAI_API_KEY,
  anthropic: wallet.ANTHROPIC_API_KEY || wallet.CLAUDE_ANTHROPIC_KEY,
  deepseek: wallet.DEEPSEEK_AI_DOMINION_UI_APIKEY || wallet.DEEPSEEK_API_KEY,
});

console.log("checked:", r.checkedAt);
for (const [p, s] of Object.entries(r.providers)) console.log("  " + p.padEnd(11), s);
console.log("");
for (const x of r.problems) console.log("PROBLEM ", x.kind.padEnd(9), x.id.padEnd(52), x.note);
for (const x of r.notes) console.log("note    ", x.kind.padEnd(9), x.id.padEnd(52), x.note);
console.log(`\n${r.ok ? "CLEAN — no launch-day problems" : r.problems.length + " PROBLEM(S) — fix the catalog before launch"}`);
process.exitCode = r.ok ? 0 : 1;
