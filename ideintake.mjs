/*
 * The Crucible's intake interviewer (Fred's ruling 2026-07-21).
 *
 * The front door used to assume almost everything, which is fast and can build an app that looks
 * or acts like nothing the user intended, on their money. This module is the fix: before a build
 * starts, the model interviews the user in a chat window, one question at a time, until it can
 * state the vision back as bullets. The user approves the bullets; THAT is what gets built.
 *
 * Contract with the model (parsed by parseIntake):
 *   - While interviewing, the reply is ordinary prose ending in exactly one question.
 *   - When the vision is clear, the reply contains a line that is exactly VISION READY, followed
 *     by the bullet list. Anything before the marker is shown as a lead-in sentence.
 *
 * Everything here is pure (no http, no providers), so it tests with plain strings.
 */

import { personaVoice, aestheticsVoice } from "./idemodes.mjs";
import { helpVoice } from "./idehelp.mjs";

export const VISION_MARKER = "VISION READY";
const MOCKUP_RE = /^\s*MOCKUP:\s*(.+)\s*$/;

const REGISTER_VOICE = {
  plain:
    "Speak plain English. No jargon at all: never say deploy, repo, commit, framework, backend, API or schema. " +
    "Talk about what the person will SEE and what the app will DO, never about how it is made.",
  technical:
    "Use proper technical terminology freely; the user speaks it.",
  hybrid:
    "Use the technical term and explain it in the same breath, briefly, in parentheses.",
};

/*
 * For beginner mode: once the vision is approved, guide them to say "build it" when ready.
 * No menus, just warm invitation to start.
 */
function beginnerBuildVoice() {
  return [
    "AFTER VISION READY: Once you have listed the vision bullets and the user approves them,",
    "present no menus or options. Instead, give one warm sentence inviting them to say 'build it'",
    "when they are ready. Keep answering their questions until they do. When they say they are",
    "ready to build, that is when the build starts. Do not offer choices or next steps.",
  ].join("\n");
}

export function intakeSystem(register = "plain", mode = "beginner") {
  const voice = REGISTER_VOICE[register] || REGISTER_VOICE.plain;
  const aesthetics = aestheticsVoice(mode);
  const isBeginner = mode === "beginner" || (mode && String(mode).toLowerCase() === "beginner");
  const buildVoice = isBeginner ? beginnerBuildVoice() : "";
  return [
    "You are the intake interviewer for The Crucible, Dominion's build surface. A person has just",
    "described an app they want built. Your job is to reach a CLEAR, SHARED vision before any",
    "money is spent building the wrong thing.",
    "",
    "RULES:",
    "1. Ask exactly ONE question per reply. Keep each reply under 80 words.",
    "2. Ask at least three clarifying questions before declaring the vision ready, unless the user",
    "   explicitly tells you to stop asking and build.",
    "3. Read the user's language to judge their experience level, and keep re-judging as the",
    "   conversation goes:",
    "   - A beginner or vibe coder talks about outcomes. Focus your questions on RESULTS: what",
    "     they will see, who uses it, what happens when. Never ask them to make a technical choice.",
    "   - A software engineer reveals it fast (they will name stacks, data models, constraints).",
    "     With them, ask precise technical questions and skip the hand-holding.",
    "4. If the user contradicts something they said earlier, point it out plainly, explain why the",
    "   two things cannot both be true, and help them pick. Never silently keep both.",
    "5. Prefer questions whose answers change what gets built (audience, the one core action, what",
    "   'done' looks like, must-keep constraints). Never ask filler.",
    "",
    "WHEN THE VISION IS CLEAR (your judgement, after the questions), reply with an optional single",
    "lead-in sentence, then a line that is exactly:",
    VISION_MARKER,
    "followed by a bullet list (lines starting with \"- \") stating exactly what will be built, in",
    "the user's own vocabulary. Cover: what it is, who it is for, the main things it does, what it",
    "looks like, and anything you were told to avoid. No question in that reply.",
    "",
    "VOICE: " + voice,
    "",
    personaVoice(mode),
    ...(aesthetics ? ["", aesthetics] : []),
    ...(buildVoice ? ["", buildVoice] : []),
    // Furnace doctrine: the interviewer knows the surface it lives in, so "what is this section
    // for" always gets a true answer instead of an amnesiac introduction.
    "",
    helpVoice(),
  ].join("\n");
}

/*
 * Split a model reply into the visible chat text and (if present) the agreed vision. The marker
 * must sit on its own line; a passing mention mid-sentence does not end the interview.
 */
export function parseIntake(text) {
  const raw = String(text == null ? "" : text).trim();
  // MOCKUP directives come out first, from anywhere in the reply: each becomes a rendered image
  // in the chat rather than a line of text the user has to read past.
  const mockups = [];
  const lines = raw.split(/\r?\n/).filter((l) => {
    const m = l.match(MOCKUP_RE);
    if (m && mockups.length < 2) { mockups.push(m[1].slice(0, 900)); return false; }
    return true;
  });
  const at = lines.findIndex((l) => l.trim().toUpperCase() === VISION_MARKER);
  if (at === -1) return { reply: lines.join("\n").trim(), vision: null, mockups };
  const lead = lines.slice(0, at).join("\n").trim();
  const vision = lines.slice(at + 1).join("\n").trim();
  if (!vision) return { reply: lines.join("\n").trim(), vision: null, mockups };   // bare marker = noise
  return { reply: lead, vision, mockups };
}

/*
 * Sanitize a client-supplied history into something safe to hand a provider: roles clamped to
 * user/assistant, content clamped in size, the whole thing capped. The system prompt is always
 * ours, never the client's.
 */
export function intakeMessages({ register = "plain", mode = "beginner", history = [] } = {}) {
  const msgs = [];
  for (const m of Array.isArray(history) ? history.slice(-40) : []) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 4000);
    if (content) msgs.push({ role, content });
  }
  return [{ role: "system", content: intakeSystem(register, mode) }, ...msgs];
}
