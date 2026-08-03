/*
 * Dominion AI. Altana's context assembler.
 *
 * Altana is the executive assistant. She knows the state of the app and what the user is trying to
 * do, and she works the app's levers on request. That means her context window sits directly next
 * to the user's credentials, their billing details, their personal information and Dominion's own
 * source. Fred's boundary, verbatim, 2026-08-03:
 *
 *   "limit the executive assistant authority to change things to exclude all billing with the
 *    users credit card or budgets, all of the users personally identifiable information, all app
 *    secrets, all app intellectual property."
 *
 * WHY REDACTION LIVES HERE AND NOWHERE ELSE (wargame F2). A model that has been told "never repeat
 * a secret" has been given a preference, not a boundary. The only durable version of that promise
 * is that the secret never enters the context in the first place. So this module is the single
 * gate: everything Altana is ever shown is built here, and nothing reaches her that did not pass
 * through it.
 *
 * TWO WALLS, IN THIS ORDER, because either one alone has a known failure mode:
 *   1. STRUCTURAL. A field allow-list. Only named fields are copied into the view at all. An
 *      unknown field that appears later (a new column, a new state key, a connector's response
 *      growing an `access_token`) is dropped by default rather than admitted by default. This
 *      catches the secret nobody thought to pattern-match.
 *   2. CONTENT. Redaction of the values that survive wall 1. This catches the secret that a user
 *      pasted into a field that legitimately holds free text, where structure cannot help.
 *
 * The assembled view is also deliberately SMALL. It rides on every one of her turns, so a fat
 * context is a bill and a latency cost paid per message, forever.
 */

/* ---------- content wall: redaction ---------------------------------------------------------- */

/*
 * Ordered on purpose. The specific, high-signal shapes run first so a generic pattern cannot eat
 * half of a credential and leave the other half legible. Each rule replaces with a labelled marker
 * so the model can still reason about "there is a key here" without ever holding the key.
 */
export const REDACTION_RULES = [
  // Private key blocks, whole. Anything between the guards goes, including the guards.
  { kind: "private-key", re: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g },
  // JSON Web Tokens: three base64url segments. Identity and secrets both ride these.
  { kind: "token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  // Named vendor key prefixes. This list is additive: a prefix that is not here is still caught by
  // the entropy rule at the bottom, this one just gives a better label.
  { kind: "api-key", re: /\b(?:sk-ant-|sk-proj-|sk-live-|sk_live_|pk_live_|sk-|rk-|nvapi-|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[baprs]-|hf_|r8_|whsec_|rnd_|dop_v1_|shpat_|SG\.|AKIA|ASIA)[A-Za-z0-9_\-.]{8,}/g },
  // Google API keys have no separator to anchor on, only a fixed prefix and a length.
  { kind: "api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  // Authorization headers, however they were spelled.
  { kind: "token", re: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9_\-.=+/]{12,}/gi },
  // Credential-shaped assignments: KEY=value, "api_key": "value", apiKey: value.
  { kind: "secret", re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE|DSN|SALT|SIGNATURE)[A-Za-z0-9_]*)\b(\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{4,})/gi, keep: 2 },
  // Connection strings carrying a password in the authority.
  { kind: "credential-url", re: /\b[a-z][a-z0-9+.-]{2,}:\/\/[^\s:/@]+:[^\s@/]+@[^\s/]+/gi },
  // Payment instruments. Run before the phone rule, which would otherwise take a bite out of one.
  { kind: "card", re: /\b(?:\d[ -]?){13,19}\b/g, guard: luhnish },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Phone numbers, North American and loosely international.
  { kind: "phone", re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/g },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Absolute paths on either platform. A path is a map of the deployment and of the source tree.
  { kind: "path", re: /\b[A-Za-z]:\\(?:[^\s\\"'<>|]+\\)*[^\s\\"'<>|]*/g },
  { kind: "path", re: /(?:^|[\s"'(=])(\/(?:home|root|Users|var|etc|opt|srv|mnt|proc|app|data)\/[^\s"'),;]*)/g, keep: 0, group: 1 },
  // Private-range and loopback addresses: the shape of the internal network.
  { kind: "host", re: /\b(?:10|127|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?::\d{2,5})?\b/g },
  /*
   * Last resort: a long, mixed-case, digit-bearing run with no spaces is a credential far more
   * often than it is prose. Deliberately last so a labelled rule above wins the naming, and
   * deliberately strict (>= 32 chars AND all three character classes) so it cannot eat a sentence,
   * a hash the user is legitimately discussing, or a base64 image the app already handles.
   */
  { kind: "secret", re: /\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/g },
];

// A card-shaped run is only a card if it passes Luhn. Without this, order numbers, build ids and
// long timestamps all read as payment instruments and the context turns into confetti.
function luhnish(s) {
  const d = String(s).replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Redact one string. Returns { text, hits: { kind: count } }.
 * Pure and idempotent: running it twice changes nothing, because a marker matches no rule.
 */
export function redact(value) {
  let text = typeof value === "string" ? value : String(value == null ? "" : value);
  const hits = Object.create(null);
  for (const rule of REDACTION_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    text = text.replace(re, (...args) => {
      const whole = args[0];
      const groups = args.slice(1, -2);
      const target = rule.group ? groups[rule.group - 1] : whole;
      if (rule.guard && !rule.guard(target)) return whole;
      hits[rule.kind] = (hits[rule.kind] || 0) + 1;
      const marker = "[redacted:" + rule.kind + "]";
      // `keep` preserves a leading capture (the label in KEY=value, the delimiter before a path)
      // so the sentence still reads and the model knows WHAT was withheld.
      if (rule.group) return whole.replace(target, marker);
      if (rule.keep) return groups.slice(0, rule.keep).join("") + marker;
      return marker;
    });
  }
  return { text, hits };
}

// Key names that must never survive into the view even if their value looks innocent today.
const SECRET_KEY_NAME = /(key|token|secret|password|passwd|credential|auth|cookie|session|signature|salt|card|cvv|iban|ssn|dob|birth|passport|licen[cs]e)/i;

/**
 * Walk a value and redact every string in it, dropping any property whose NAME reads as a
 * credential. Depth- and breadth-bounded so a cyclic or enormous object cannot hang the assembler.
 */
export function redactDeep(value, { depth = 0, hits = Object.create(null), maxDepth = 6, maxItems = 60 } = {}) {
  if (depth > maxDepth) return { value: "[redacted:depth]", hits };
  if (value == null) return { value: null, hits };
  if (typeof value === "number" || typeof value === "boolean") return { value, hits };
  if (typeof value === "string") {
    const r = redact(value);
    for (const [k, n] of Object.entries(r.hits)) hits[k] = (hits[k] || 0) + n;
    return { value: r.text, hits };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, maxItems)) out.push(redactDeep(item, { depth: depth + 1, hits, maxDepth, maxItems }).value);
    return { value: out, hits };
  }
  if (typeof value === "object") {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= maxItems) break;
      if (SECRET_KEY_NAME.test(k)) { hits.field = (hits.field || 0) + 1; out[k] = "[redacted:field]"; continue; }
      out[k] = redactDeep(v, { depth: depth + 1, hits, maxDepth, maxItems }).value;
    }
    return { value: out, hits };
  }
  return { value: "[redacted:type]", hits };
}

/* ---------- structural wall: the field allow-list --------------------------------------------- */

/*
 * Exactly the fields Altana may be shown. Anything not named here is invisible to her, whatever it
 * is called and whenever it was added. This is the wall that holds against fields that do not
 * exist yet.
 */
export const CONTEXT_FIELDS = {
  app: ["name", "version", "tier", "interfaceMode", "privacyMode", "online"],
  screen: ["id", "title", "section"],
  activity: ["at", "what"],
  project: ["id", "name", "state"],
};

const short = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);

function pick(source, allowed, cap = 120) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const field of allowed) {
    if (!(field in source)) continue;
    const raw = source[field];
    if (raw == null || raw === "") continue;
    out[field] = typeof raw === "boolean" ? raw : short(raw, cap);
  }
  return out;
}

/* ---------- assembly -------------------------------------------------------------------------- */

/**
 * Build the whole of what Altana sees, in one place.
 *
 * Returns { text, hits, bytes, dropped } where `text` is the block that goes into her system
 * prompt, `hits` counts what redaction caught (so a spike is visible in a log), and `dropped`
 * names the top-level inputs the allow-list refused.
 */
export function assembleContext({
  app = {},
  screen = {},
  activity = [],
  projects = [],
  settings = {},
  settableKeys = [],
  tools = [],
  knowledge = [],
  maxBytes = 4200,
} = {}) {
  const hits = Object.create(null);
  const dropped = [];
  const bump = (h) => { for (const [k, n] of Object.entries(h || {})) hits[k] = (hits[k] || 0) + n; };

  const clean = (obj, allowed, cap) => {
    const picked = pick(obj, allowed, cap);
    const r = redactDeep(picked, {});
    bump(r.hits);
    return r.value;
  };

  for (const key of Object.keys(app || {})) if (!CONTEXT_FIELDS.app.includes(key)) dropped.push("app." + key);
  for (const key of Object.keys(screen || {})) if (!CONTEXT_FIELDS.screen.includes(key)) dropped.push("screen." + key);

  const A = clean(app, CONTEXT_FIELDS.app, 60);
  const S = clean(screen, CONTEXT_FIELDS.screen, 60);

  const acts = (Array.isArray(activity) ? activity : []).slice(-6).map((a) => clean(a, CONTEXT_FIELDS.activity, 100));
  const projs = (Array.isArray(projects) ? projects : []).slice(0, 8).map((p) => clean(p, CONTEXT_FIELDS.project, 60));

  /*
   * Settings are the sharpest edge in this function. A settings object is exactly where a token,
   * an email address or a spend cap lives, so Altana is shown the value of a setting ONLY if that
   * setting is one she is allowed to change. Everything else is not summarised, not counted, not
   * mentioned. She cannot leak a value she was never handed.
   */
  const allow = new Set((Array.isArray(settableKeys) ? settableKeys : []).map(String));
  const shownSettings = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (!allow.has(k)) { dropped.push("settings." + k); continue; }
    const r = redact(typeof v === "boolean" ? String(v) : short(v, 60));
    bump(r.hits);
    shownSettings[k] = r.text;
  }

  const toolLines = (Array.isArray(tools) ? tools : []).map((t) => {
    const name = short(t && (t.name || (t.function && t.function.name)), 48);
    const desc = short(t && (t.summary || t.description || (t.function && t.function.description)), 90);
    return name ? "  " + name + (desc ? ": " + desc : "") : "";
  }).filter(Boolean);

  const knowledgeText = (Array.isArray(knowledge) ? knowledge : [])
    .map((k) => short(typeof k === "string" ? k : (k && k.body) || "", 1400).replace(/\s+/g, " "))
    .filter(Boolean);

  const lines = [];
  const kv = (obj) => Object.entries(obj).map(([k, v]) => k + "=" + v).join(", ");
  if (Object.keys(A).length) lines.push("APP: " + kv(A));
  if (Object.keys(S).length) lines.push("SCREEN: " + kv(S));
  if (projs.length) lines.push("PROJECTS: " + projs.map((p) => p.name || p.id).filter(Boolean).join(", "));
  if (acts.length) lines.push("RECENTLY: " + acts.map((a) => a.what).filter(Boolean).join(" | "));
  if (Object.keys(shownSettings).length) lines.push("SETTINGS YOU MAY CHANGE: " + kv(shownSettings));
  if (toolLines.length) lines.push("YOUR LEVERS:\n" + toolLines.join("\n"));
  if (knowledgeText.length) lines.push("WHAT YOU KNOW ABOUT THIS APP:\n" + knowledgeText.join("\n\n"));

  let text = lines.join("\n\n");
  /*
   * The cap is enforced on the assembled bytes, not estimated ahead of it, because the knowledge
   * chunks are the only variable-length input and truncating them is the correct sacrifice: state
   * and levers are what make her useful, background reading is what makes her verbose.
   */
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "") + "\n[context trimmed to fit]";
  }

  return { text, hits, bytes: Buffer.byteLength(text, "utf8"), dropped };
}

export default assembleContext;
