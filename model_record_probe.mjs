/*
 * MODEL RECORD PROBE — run: node model_record_probe.mjs [id-pattern]
 *
 * Phase A deliverable 1 of docs/ASSISTANT-AND-BUILD-CORE-SOW.md: "a filled record per shipped
 * model, with provenance and check date, living beside the catalog rather than in a session
 * transcript." This produces that artifact.
 *
 * Walks the catalog, probes each model live through modelprobe.mjs, prints a table, and writes
 * docs/MODEL-RECORDS.json. Spends real money on paid providers: four small calls per model, each
 * capped at 128 output tokens, so the whole roster costs a few cents. The estimate is printed
 * before anything is charged.
 *
 * Keys are read from the wallet at runtime. Nothing here stores or prints one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { MODELS, modelById } from "./models.catalog.mjs";
import { probeModel } from "./modelprobe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const wallet = {};
try {
  for (const l of readFileSync(join(homedir(), ".app-secrets.env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) wallet[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch { console.error("no wallet at ~/.app-secrets.env"); process.exit(1); }

const KEYS = {
  nvidia: wallet.NVIDIA_API_KEY || wallet.NVIDIA_API_KEY_6_MONTHS,
  deepseek: wallet.DEEPSEEK_AI_DOMINION_UI_APIKEY || wallet.DEEPSEEK_API_KEY,
  openai: wallet.OPEN_AI_DOMINION_UI_APIKEY || wallet.OPENAI_API_KEY,
  anthropic: wallet.ANTHROPIC_API_KEY || wallet.CLAUDE_ANTHROPIC_KEY,
  moonshot: wallet.MOONSHOT_API_KEY || wallet.MOONSHOT_KEY,
  openrouter: wallet.OPENROUTER_API_KEY,
  // Deliberately not falling back to another app's Gemini key: borrowing one crosses quota and
  // billing between products and hides which app spent what.
  google: wallet.GOOGLE_AI_STUDIO_KEY || wallet.DOMINION_AI_GOOGLE_AI_STUDIO_KEY,
};

const pattern = process.argv[2] ? new RegExp(process.argv[2], "i") : null;
const targets = MODELS.filter((m) => !pattern || pattern.test(m.id));
if (!targets.length) { console.error("no catalog models matched " + process.argv[2]); process.exit(1); }

// Rough ceiling: 4 calls, at most ~1000 in + ~350 out per model at the ceilings this probe uses.
const estimate = targets.reduce((n, m) => n + ((1000 * (m.inCost || 0)) + (350 * (m.outCost || 0))) / 1e6, 0);
console.log(`probing ${targets.length} model(s); rough ceiling $${estimate.toFixed(4)}`);
const missing = [...new Set(targets.map((m) => m.provider || "openrouter"))].filter((p) => !KEYS[p]);
if (missing.length) console.log("no key for: " + missing.join(", ") + " (those models will record a key gap, not a failure)");
console.log("");

const records = [];
for (const m of targets) {
  const provider = m.provider || "openrouter";
  const r = await probeModel({
    provider,
    id: m.id,
    wireId: m.directId || m.id,
    key: KEYS[provider],
    label: m.name,
  });
  // Carry the catalog's own claims into the record so drift is visible in one place.
  r.catalogClaims = { ctx: m.ctx ?? null, maxOut: m.maxOut ?? null, reasoning: !!m.reasoning, vision: !!m.vision, inCost: m.inCost ?? null, outCost: m.outCost ?? null };
  records.push(r);

  const mark = r.answers ? "ok " : (r.err ? "XX " : "?? ");
  const bits = [
    "tools=" + (r.tools === null ? "-" : r.tools),
    "vision=" + (r.vision === null ? "-" : r.vision),
    r.reasoningReported ? "reasons" : "",
    r.budgetEater === true ? ("STARVES<" + (r.recoversAt || ">2048")) : "",
  ].filter(Boolean).join(" ");
  console.log(mark + m.id.padEnd(46) + bits + (r.err ? "  err=" + r.err : ""));
  for (const n of r.notes) console.log("      note: " + n);
}

/* ---- drift and contradiction, computed rather than eyeballed ------------------------------- */
const problems = [];
for (const r of records) {
  const c = r.catalogClaims;
  if (r.answers && r.tools === false && modelById(r.catalogId) && modelById(r.catalogId).toolCapable) {
    problems.push({ id: r.catalogId, kind: "tool-mislabel", note: "catalog says tool-capable; probe got no tool call" });
  }
  if (r.answers && r.vision === false && c.vision) {
    problems.push({ id: r.catalogId, kind: "vision-mislabel", note: "catalog says vision; probe was refused an image" });
  }
  if (r.budgetEater === true) {
    problems.push({
      id: r.catalogId,
      kind: "budget-eater",
      note: r.recoversAt
        ? "reasoning eats the output budget; needs max_tokens >= " + r.recoversAt + " to return any text"
        : "reasoning eats the output budget and produced nothing at any ceiling up to 2048",
    });
  }
  if (!r.answers && !r.err) {
    problems.push({ id: r.catalogId, kind: "silent", note: "answered HTTP 200 with no text" });
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  note: "Phase A per-model record. Live probe results only. A null field means the probe could not establish it, never an assumption.",
  probed: records.length,
  problems,
  records,
};
const path = join(HERE, "docs", "MODEL-RECORDS.json");
writeFileSync(path, JSON.stringify(out, null, 2));

console.log("\n" + "-".repeat(70));
console.log("answered: " + records.filter((r) => r.answers).length + " / " + records.length);
console.log("real tool calls: " + records.filter((r) => r.tools === true).length);
console.log("starve on a tight ceiling: " + records.filter((r) => r.budgetEater === true).length);
if (problems.length) {
  console.log("\nCONTRADICTIONS WITH THE CATALOG:");
  for (const p of problems) console.log("  " + p.kind.padEnd(16) + p.id.padEnd(44) + p.note);
} else {
  console.log("\nno contradictions with the catalog");
}
console.log("\nwritten: docs/MODEL-RECORDS.json");
