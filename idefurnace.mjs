/*
 * The Furnace pass (Fred's ruling 2026-07-21): honesty before "done", on EVERY build.
 *
 * Born of the rival-IDE failure mode: "production ready" apps that were 60% built, placeholders
 * still in the code, variables mismatched, and "fixed" claims that fixed nothing. The Crucible
 * ends every build with two audits:
 *
 *   1. The placeholder sweep: deterministic, free, engine-side. Scans what was written for the
 *      marks of unfinished work and reports them plainly, never hides them.
 *   2. The vision fidelity check: one model call comparing the AGREED VISION bullets against
 *      what actually got written, answering per bullet: delivered, or a named gap.
 *
 * Pure module: no http, no fs, no providers. The server feeds it file text and a chat function.
 */

// The marks of unfinished work. Each rule names its kind so the report reads like a person wrote it.
const SWEEP_RULES = [
  { kind: "todo", re: /\b(TODO|FIXME|HACK|XXX)\b[:\s]/ },
  { kind: "placeholder", re: /\bPLACEHOLDER\b|\byour[-_ ](api[-_ ]?key|key|token|value)\b|<REPLACE|INSERT[-_ ](HERE|VALUE)/i },
  { kind: "lorem", re: /lorem ipsum/i },
  { kind: "coming_soon", re: /coming soon|not (yet )?implemented|to be implemented/i },
  { kind: "empty_function", re: /function\s+\w+\s*\([^)]*\)\s*\{\s*\}/ },
];

/*
 * Sweep the written files. Input: [{path, text}]. Output: findings [{path, line, kind, excerpt}],
 * capped so a disastrous build produces a readable report rather than a scroll of shame.
 */
export function sweepFindings(files, { maxFindings = 40 } = {}) {
  const findings = [];
  for (const f of Array.isArray(files) ? files : []) {
    const lines = String((f && f.text) || "").split(/\r?\n/);
    for (let i = 0; i < lines.length && findings.length < maxFindings; i++) {
      for (const rule of SWEEP_RULES) {
        if (rule.re.test(lines[i])) {
          findings.push({ path: f.path, line: i + 1, kind: rule.kind, excerpt: lines[i].trim().slice(0, 120) });
          break;
        }
      }
    }
    if (findings.length >= maxFindings) break;
  }
  return findings;
}

// The sweep report, phrased for humans. Empty findings get the honest all-clear.
export function sweepReport(findings) {
  if (!findings.length) return "Swept every written file for unfinished work: none found.";
  return "Unfinished work found and reported honestly (never hidden):\n"
    + findings.map((f) => f.path + ":" + f.line + "  [" + f.kind + "]  " + f.excerpt).join("\n");
}

/*
 * The fidelity audit prompt. The model sees the agreed bullets and what was written (paths plus
 * bounded excerpts) and must answer PER BULLET with a strict line protocol parseFidelity reads:
 *   OK: <bullet>
 *   GAP: <bullet> :: <what is missing, one plain sentence>
 */
export function fidelityMessages({ vision, files, register = "plain" } = {}) {
  const manifest = (Array.isArray(files) ? files : []).map((f) =>
    "FILE " + f.path + "\n" + String(f.text || "").split(/\r?\n/).slice(0, 60).join("\n").slice(0, 3000)
  ).join("\n\n").slice(0, 24000);
  const voice = register === "technical" ? "Terse and precise."
    : register === "hybrid" ? "Technical terms with a short plain gloss."
    : "Plain English a non-programmer follows, nothing above an 8th grade reading level.";
  return [
    { role: "system", content: [
      "You audit a finished build against the vision the user approved. For EVERY bullet in the",
      "vision, answer with exactly one line:",
      "OK: <the bullet>            when the written files genuinely deliver it",
      "GAP: <the bullet> :: <one sentence naming what is missing>",
      "Judge from the files shown. Be strict: a stub, a placeholder, or a mismatch is a GAP.",
      "No other lines, no preamble. Gap sentences: " + voice,
    ].join("\n") },
    { role: "user", content: "AGREED VISION:\n" + String(vision || "").slice(0, 2400) + "\n\nWHAT WAS WRITTEN:\n" + manifest },
  ];
}

export function parseFidelity(text) {
  const ok = [], gaps = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^OK:\s*/i.test(t)) ok.push(t.replace(/^OK:\s*/i, "").trim());
    else if (/^GAP:\s*/i.test(t)) {
      const rest = t.replace(/^GAP:\s*/i, "");
      const [bullet, why] = rest.split(/\s*::\s*/);
      gaps.push({ bullet: (bullet || "").trim(), why: (why || "").trim() });
    }
  }
  return { ok, gaps };
}

// Pull the agreed vision back out of a composed build prompt, if the intake produced one.
export function visionFromPrompt(prompt) {
  const m = String(prompt || "").match(/AGREED VISION[^:]*:\s*\n([\s\S]+)$/);
  return m ? m[1].trim() : "";
}
