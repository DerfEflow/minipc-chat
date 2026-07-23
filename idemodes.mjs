/*
 * The Crucible's three modes (Fred's ruling 2026-07-21 night, SOW docs/CRUCIBLE-MODES-ROADMAP.md).
 *
 * One switch, chosen by the user, changes everything downstream: layout, level of detail, default
 * language register, step descriptions, model handling, and the AI's persona. The register system
 * (idelang.mjs) stays as the machinery underneath; mode sets its default.
 *
 *   beginner   A mentor and encourager. Chat window and a folder picker, almost nothing else.
 *              Aesthetics before plumbing. Models are never mentioned.
 *   vibe       A kind, current designer-developer collaborator: adaptive technical depth,
 *              feature-rich but intentional, upfront about cost and real-world complexity.
 *   engineer   A calm staff engineer: technical, measurable, fast, and non-patronizing.
 *              Everything is available, with working evidence instead of performance theater.
 *
 * Pure module: no http, no fs, no providers. Tests run it with plain values.
 */

export const MODES = ["beginner", "vibe", "engineer"];
export const DEFAULT_MODE = "beginner";

export const normalizeMode = (v) =>
  (MODES.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : DEFAULT_MODE);

// What each mode means for the rest of the surface. The client mirrors these choices in layout;
// the server uses register + persona. A user can still override the register afterward.
export const MODE_DEFAULTS = {
  beginner: { register: "plain", tour: true, board: "hidden", codeLens: "hidden" },
  vibe: { register: "hybrid", tour: true, board: "sentence", codeLens: "toggle" },
  engineer: { register: "technical", tour: false, board: "drawer", codeLens: "open" },
};

/*
 * The AI's job description per mode, injected into the intake interviewer and the planner voice.
 * Each voice changes communication and default controls without changing the underlying truth.
 */
export function personaVoice(mode) {
  const m = normalizeMode(mode);
  if (m === "engineer") {
    return "PERSONA: a calm staff software engineer. Be concise, technical, and professional. " +
      "Optimize for speed, correctness, and measurable results. Lead with the result, then name " +
      "assumptions, risks, exact commands or diffs, tests run, and remaining uncertainty. Never " +
      "patronize and never use praise or cheerleading. Ask a precise question only when its answer " +
      "would materially change the implementation.";
  }
  if (m === "vibe") {
    return "PERSONA: a kind, current product designer and software developer; a real collaborator " +
      "who sounds like a thoughtful person in their mid-twenties. " +
      "Assume the user has a nuanced vision and real taste; help them articulate it. Match their " +
      "depth: keep it light when they do, and explain the technical details fully when they ask. " +
      "Be direct, warm, and aware of current design and development patterns without forcing slang. " +
      "Be upfront about cost and complexity the moment a choice implies a database, accounts, " +
      "hosting, a domain, or an outside service. No surprises later.";
  }
  return "PERSONA: a mentor and an encourager. Celebrate progress genuinely and briefly. Explain " +
    "everything by its RESULT, never by its mechanism. One idea per sentence. The user's " +
    "confidence is part of the product: they should end every exchange feeling capable. " +
    "Use a little gentle humor when it fits, but never make the user the joke. " +
    "BEGINNER RULES: Keep every sentence under an 8th grade reading level. Take the lead and " +
    "be proactive because they will not know what to do next. Every reply ends with either " +
    "the one next step or the one question you are asking. Early in the conversation, ask " +
    "what is motivating the app, who it is for, and why it matters to them. Use that answer " +
    "to guide your choices. When the user asks for something complicated, tell them plainly " +
    "it is impressive and ambitious. Then explain in simple words two or three reasons why " +
    "it is complicated. Finally, offer a smaller first version that can grow.";
}

/*
 * Beginners care how it looks before how it works, and nothing used to guide that. This block
 * teaches the interviewer the aesthetics stage and the MOCKUP protocol: the model may emit
 * mockup directives; the app renders them as images the user reacts to in the same chat.
 */
export function aestheticsVoice(mode) {
  if (normalizeMode(mode) !== "beginner") return "";
  return [
    "AESTHETICS STAGE: once you understand WHAT they want and WHO it is for, spend the rest of",
    "the interview on how it should LOOK and FEEL: colors, mood, playful or calm, favorite apps",
    "or places, 'show me things you love'. When a visual would say it better than words, add a",
    "line that is exactly:",
    "MOCKUP: <one vivid sentence describing a phone-screen mockup of the app in that style>",
    "at the END of your reply (at most two per reply). The app turns each into a picture the",
    "user can react to. When they pick a direction, fold it into the vision as a 'What it looks",
    "like' bullet, in their own words.",
  ].join("\n");
}

/*
 * Honesty about money and complexity, computed HERE rather than trusted to the model. The flags
 * scan the agreed vision for real-world commitments; the estimate prices the build from move
 * count and the engineering model's token rates. Bands, never false precision.
 */
const FLAG_RULES = [
  { key: "database", test: /\b(database|saves?d?\b|store[sd]?\b|records?|history|remember|keep track)\b/i,
    label: "Keeps information between visits, so it needs a database." },
  { key: "accounts", test: /\b(accounts?|logs? ?in|signs? ?(in|up)|password|profiles?|per[- ]user|members?)\b/i,
    label: "Different people sign in, so it needs user accounts." },
  { key: "payments", test: /\b(pay|payments?|checkout|subscriptions?|billing|charge|stripe|price)\b/i,
    label: "Money changes hands, so it needs a payment service and their rules." },
  { key: "messaging", test: /\b(emails?|notifications?|text message|sms|reminds?|alerts?)\b/i,
    label: "It reaches out to people, so it needs an email or messaging service." },
  { key: "external", test: /\b(weather|maps?|calendar sync|imports? from|connects? to|api|instagram|google|spotify)\b/i,
    label: "It talks to an outside service, which means an account there and occasional breakage." },
];

export function visionExtras(vision, { moves = 6, inCost = 0, outCost = 0 } = {}) {
  const text = String(vision || "");
  const flags = FLAG_RULES.filter((r) => r.test.test(text)).map((r) => ({ key: r.key, label: r.label }));
  // Every real move reads a manifest and writes code. The band is deliberately wide: builds that
  // repair or wander cost more, small clean ones cost less.
  const perMoveUsd = ((9000 * (inCost || 0)) + (3500 * (outCost || 0))) / 1e6;
  const mid = perMoveUsd * Math.max(1, moves);
  const est = { lowUsd: +(mid * 0.6).toFixed(4), highUsd: +(mid * 2.2).toFixed(4) };
  return { flags, est };
}

// A human-readable cost band. Under a cent stays honest words, matching the runner's money().
export function costBand({ lowUsd = 0, highUsd = 0 } = {}) {
  const f = (n) => (n < 0.01 ? "less than a cent" : "$" + n.toFixed(2));
  if (highUsd < 0.01) return "less than a cent";
  return "between " + f(lowUsd) + " and " + f(highUsd);
}
