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
  { kind: "placeholder", re: /\bPLACEHOLDER\b|\byour[-_ ](api[-_ ]?key|key|token|value)\b|<REPLACE|INSERT[-_ ](HERE|VALUE)/i, scrub: true },
  { kind: "lorem", re: /lorem ipsum/i },
  { kind: "coming_soon", re: /coming soon|not (yet )?implemented|to be implemented/i },
  { kind: "empty_function", re: /function\s+\w+\s*\([^)]*\)\s*\{\s*\}/ },
];

/*
 * The web platform's OWN word for finished work (live catch 2026-07-30). A form that says
 * placeholder="e.g. Groceries" and a stylesheet with input::placeholder are complete, correct
 * code — but the case-insensitive PLACEHOLDER rule flagged all three, so a finished three-file
 * page ended its build asking the user to "close 3 unfinished items" that did not exist. Nothing
 * erodes trust in an honesty pass faster than crying wolf, so these forms are removed from the
 * line before the placeholder rule reads it. Every other rule still sees the raw line.
 */
const scrubPlatformPlaceholders = (line) => String(line)
  .replace(/placeholder\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+)/gi, "")   // HTML attr, JSX prop
  .replace(/::?placeholder(?:-shown)?/gi, "")                                  // CSS pseudo-element/class
  .replace(/\.placeholder\b/gi, "")                                            // el.placeholder in JS
  // {placeholder: "..."} option key — lowercase and in key position ONLY, so an all-caps
  // "PLACEHOLDER: fill this in" comment is never scrubbed away with it.
  .replace(/([{,]\s*)placeholder(\s*:)/g, "$1$2");

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
        if (rule.re.test(rule.scrub ? scrubPlatformPlaceholders(lines[i]) : lines[i])) {
          findings.push({ path: f.path, line: i + 1, kind: rule.kind, excerpt: lines[i].trim().slice(0, 120) });
          break;
        }
      }
    }
    if (findings.length >= maxFindings) break;
  }
  return findings;
}

/*
 * BROKEN LOCAL REFERENCES (live catch 2026-07-30). The Crucible built a three-file page whose
 * index.html loaded "app.js" while the build had written "script.js": every file existed, every
 * move said done, the sweep was clean, the page rendered — and nothing worked, because the only
 * JavaScript never loaded. This is the exact "looks built, does nothing" failure the Furnace
 * exists to prevent, and no text pattern can catch it: it needs the file LIST.
 *
 * So: read every local src/href out of the written HTML and confirm the target was actually
 * written. Absolute URLs, protocol-relative URLs, data: URIs, and bare #anchors are somebody
 * else's business and are skipped. `known` may name files the build did not write this round
 * (the caller passes the workspace listing when it has one), so a reference to a pre-existing
 * file is never called broken.
 */
const REF_RE = /(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const normalizeRef = (value) => String(value || "").split(/[?#]/)[0].replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
const isExternalRef = (value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(value || "").trim()) || String(value || "").trim().startsWith("#");

export function brokenReferenceFindings(files, { known = [] } = {}) {
  const list = Array.isArray(files) ? files : [];
  const present = new Set([
    ...list.map((f) => normalizeRef(f && f.path)),
    ...(Array.isArray(known) ? known : []).map((p) => normalizeRef(p)),
  ].filter(Boolean));
  // A reference may be written relative to its own folder, so index the basenames too and accept
  // a match on either form. Over-accepting here is deliberate: a false "broken" claim is worse
  // than a missed one, because it would send a finished build back for imaginary repairs.
  for (const p of [...present]) present.add(p.split("/").pop());
  const findings = [];
  for (const f of list) {
    if (!/\.(?:html?|htm)$/i.test(String((f && f.path) || ""))) continue;
    const lines = String((f && f.text) || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      REF_RE.lastIndex = 0;
      let m;
      while ((m = REF_RE.exec(lines[i]))) {
        const raw = m[1] || m[2] || m[3] || "";
        if (!raw || isExternalRef(raw)) continue;
        const target = normalizeRef(raw);
        if (!target || present.has(target) || present.has(target.split("/").pop())) continue;
        findings.push({ path: f.path, line: i + 1, kind: "broken_reference",
          excerpt: `references "${raw}", which no file in this build provides` });
      }
    }
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
