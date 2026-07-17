/*
 * Dominion AI — hardcoded content wall (Fred 2026-07-17).
 *
 * A deterministic, always-on input screen that REFUSES prohibited requests before any model is
 * called or any token is billed. Two tiers:
 *
 *   ABSOLUTE   — applies to EVERYONE, owner included, never overridable:
 *                  • sexual content involving minors
 *                  • how-to for mass-harm weapons (explosive / chemical / biological / nuclear)
 *   RESTRICTED — applies to NON-OWNERS only:
 *                  • graphic / pornographic sexual content
 *                  • illicit how-to (drug manufacture or trafficking, hacking-for-harm, fraud,
 *                    illegal-weapon acquisition, trafficking, murder-for-hire)
 *
 * Owner scope (Fred's ruling): the owner is exempt from RESTRICTED so it never interferes with his
 * novel or theology work, but is NOT exempt from ABSOLUTE. Method: regex-only by Fred's choice —
 * fast, private, no dependency. Blatant cases are caught; a cleverly-worded query may slip. On
 * minors the screen is deliberately conservative (co-occurrence of a minor term + a sexual term
 * blocks); false positives there are accepted as the safe side of the line.
 *
 * This is an INPUT screen (the latest user turn). It complements, and never replaces, the model's
 * own refusals.
 */

// --- minor indicators (clearly-minor terms only; "teen" is intentionally excluded because it is
// ambiguous with adults, and "baby" is excluded to spare adult terms of endearment). ---
const MINOR = /\b(child|children|kid|kids|minor|minors|underage|under[-\s]?age|pre[-\s]?teen|pre[-\s]?pubescent|toddler|infant|schoolgirl|schoolboy|jailbait|(?:1[0-7]|[1-9])\s?(?:yo|y\/o|years?[-\s]?old))\b/i;

// --- sexual terms, broad — used ONLY for the minor co-occurrence test (broad is correct there). ---
const SEXUAL_ANY = /\b(sex|sexual|sexually|porn\w*|nsfw|erotic\w*|nude|nudes|naked|blow\s?job|hand\s?job|cum\w*|masturbat\w*|orgasm\w*|ejaculat\w*|anal|oral\s*sex|intercourse|fellatio|cunniling\w*|penetrat\w*|hentai|xxx|molest\w*|\brape\b|raping|fondl\w*|aroused?)\b/i;

// --- blatant CSAM slang — blocks on its own, no co-occurrence needed. ---
const CSAM_DIRECT = /\b(child\s*porn\w*|childporn|child\s*sex\w*|lolicon|\bloli\b|\bshota\b|cp\s*(?:porn|video|pics?|content)|pedophil\w*|paedophil\w*|minor\s*(?:porn|nudes?|sex\w*))\b/i;

// --- mass-harm weapon how-to (ABSOLUTE). Requires an ACTION verb near the weapon noun so a bare
// mention in fiction/news doesn't trip it — the verb is the how-to signal. Kept narrow so authorized
// security and ordinary business work is untouched. ---
const MASS_HARM = /\b(?:how\s+to\s+)?(?:make|makes|making|build|building|construct\w*|synthesi[sz]\w*|manufactur\w*|assembl\w*|produce|producing|create|creating|detonat\w*|weaponi[sz]\w*)\b[\s\S]{0,60}\b(bombs?|explosives?|\bied\b|pipe\s*bombs?|grenades?|napalm|nerve\s*agents?|sarin|\bvx\b|mustard\s*gas|chemical\s*weapons?|bio\s*weapons?|biological\s*weapons?|dirty\s*bombs?|nuclear\s*(?:bombs?|weapons?|devices?)|ricin|anthrax)\b/i;

// --- illicit how-to (RESTRICTED — non-owners only). ---
const DRUGS = /\b(?:how\s+to\s+)?(?:make|makes|making|synthesi[sz]\w*|cook|cooking|produce|producing|manufactur\w*|buy|buying|acquire|acquiring|obtain\w*|purchase|purchasing|sell|selling|traffic\w*)\b[\s\S]{0,40}\b(meth|methamphetamine|crystal\s*meth|cocaine|crack\s*cocaine|heroin|fentanyl|carfentanil|\blsd\b|\bmdma\b|ecstasy\s*pills?|illegal\s*drugs?)\b/i;
const FRAUD_HACK = /\b(?:how\s+to\s+)?(hack|hacking|ddos|steal|stealing|phish\w*|skim\w*|clone|cloning|forge|forging|counterfeit\w*|launder\w*)\b[\s\S]{0,50}\b(account|accounts|credit\s*card|debit\s*card|password|passwords|identity|ssn|social\s*security|bank\s*account|crypto\s*wallet)\b/i;
const ILLICIT_DIRECT = /\b(child\s*trafficking|human\s*trafficking|money\s*laundering|carding\b|credit\s*card\s*(?:dumps?|generator|numbers?)|ghost\s*guns?|untraceable\s*(?:guns?|firearms?)|buy\s*(?:an?\s*)?(?:illegal|stolen|untraceable)\s*(?:guns?|firearms?|weapons?)|hire\s*(?:an?\s*)?hit\s*man|contract\s*killing|murder\s*for\s*hire)\b/i;

// --- graphic sexual content (RESTRICTED). Deliberately NOT the broad set: bare anatomy words and the
// word "sex" alone are excluded so medical questions and sex-education stay allowed. Blocks porn, the
// named graphic acts, and explicit-generation requests ("write me a sex scene"). ---
const SEXUAL_GRAPHIC = /\b(porn\w*|pornography|nsfw|blow\s?jobs?|hand\s?jobs?|cum(?:shot|ming|s)?|masturbat\w*|orgasm\w*|ejaculat\w*|hentai|xxx|erotica|sex\s*scene|sexually\s*explicit|hardcore\s*sex|anal\s*sex|oral\s*sex|fellatio|cunniling\w*|deep\s*throat|gang\s?bang|threesome|bukkake)\b/i;
const SEXUAL_GEN_REQUEST = /\b(write|writes|writing|describe|describing|generate|generating|compose|composing|create|creating|narrate|narrating|roleplay|role[-\s]?play|\brp\b|continue)\b[\s\S]{0,40}\b(sex\s*scene|sexual\s*(?:scene|encounter|act|acts)|explicit\s*(?:scene|content)|erotic\w*|making\s*love|intimate\s*scene|porn\w*|nude\s*scene)\b/i;

// Screen the latest user turn. Returns { blocked, tier, category, reason }; blocked=false = allowed.
export function screenContent(text, { isOwner = false } = {}) {
  const t = String(text || "");
  if (!t.trim()) return { blocked: false };

  // ---- ABSOLUTE (everyone, owner included, never overridable) ----
  if (CSAM_DIRECT.test(t) || (MINOR.test(t) && SEXUAL_ANY.test(t))) {
    return { blocked: true, tier: "absolute", category: "minors",
      reason: "This request appears to involve sexual content with a minor. That is never permitted, for anyone. It has been refused and logged." };
  }
  if (MASS_HARM.test(t)) {
    return { blocked: true, tier: "absolute", category: "mass_harm",
      reason: "This request appears to seek instructions for a weapon capable of mass harm. That is never permitted. It has been refused and logged." };
  }

  if (isOwner) return { blocked: false };   // owner is exempt from the RESTRICTED tier below

  // ---- RESTRICTED (non-owners only) ----
  if (SEXUAL_GRAPHIC.test(t) || SEXUAL_GEN_REQUEST.test(t)) {
    return { blocked: true, tier: "restricted", category: "sexual",
      reason: "Sexually explicit content isn't available on this assistant. Please keep requests non-explicit." };
  }
  if (DRUGS.test(t) || FRAUD_HACK.test(t) || ILLICIT_DIRECT.test(t)) {
    return { blocked: true, tier: "restricted", category: "illicit",
      reason: "This assistant won't help with illegal or illicit activity. If you believe this was flagged in error, rephrase your request." };
  }
  return { blocked: false };
}
