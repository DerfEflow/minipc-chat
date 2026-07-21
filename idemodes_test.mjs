/*
 * Three-modes core self-test. Run with: node idemodes_test.mjs
 * Proves:
 *   1. mode normalization fails SAFE to beginner (the mode that excludes nobody)
 *   2. each persona matches Fred's ruling: mentor / sharp collaborator / cold executor
 *   3. the aesthetics stage exists ONLY for beginners, with the MOCKUP protocol
 *   4. visionExtras flags real-world commitments deterministically and prices a BAND
 *   5. costBand speaks honest words under a cent
 */
import assert from "node:assert/strict";
import { MODES, normalizeMode, MODE_DEFAULTS, personaVoice, aestheticsVoice, visionExtras, costBand } from "./idemodes.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

await t("normalization fails safe to beginner", () => {
  assert.equal(normalizeMode("engineer"), "engineer");
  assert.equal(normalizeMode("VIBE"), "vibe");
  assert.equal(normalizeMode("hacker"), "beginner");
  assert.equal(normalizeMode(""), "beginner");
  assert.equal(normalizeMode(null), "beginner");
});

await t("mode defaults carry the register and layout decisions", () => {
  assert.equal(MODE_DEFAULTS.beginner.register, "plain");
  assert.equal(MODE_DEFAULTS.vibe.register, "hybrid");
  assert.equal(MODE_DEFAULTS.engineer.register, "technical");
  assert.equal(MODE_DEFAULTS.beginner.board, "hidden");
  assert.equal(MODE_DEFAULTS.engineer.codeLens, "open");
  assert.equal(MODES.length, 3);
});

await t("personas match the ruling: mentor, collaborator, cold executor", () => {
  assert.ok(/mentor/i.test(personaVoice("beginner")), "beginner gets the mentor");
  assert.ok(/RESULT/.test(personaVoice("beginner")), "beginner hears results, never mechanisms");
  assert.ok(/collaborator/i.test(personaVoice("vibe")), "vibe gets the collaborator");
  assert.ok(/upfront about cost/i.test(personaVoice("vibe")), "vibe hears cost early");
  assert.ok(/cold/i.test(personaVoice("engineer")), "engineer gets the cold executor");
  assert.ok(/zero\s*cheerleading/i.test(personaVoice("engineer")));
});

await t("beginner persona has the sharpened rules: 8th grade, proactive, next-step, motivation, ambitious", () => {
  const b = personaVoice("beginner");
  assert.ok(/8th grade reading level/i.test(b), "beginner must mention 8th grade ceiling");
  assert.ok(/proactive/i.test(b), "beginner must be proactive");
  assert.ok(/next step|one question/i.test(b), "beginner must end with next step or question");
  assert.ok(/motivat/i.test(b), "beginner must ask about motivation");
  assert.ok(/ambitious/i.test(b), "beginner must acknowledge ambitious apps");
  assert.ok(/complicated/i.test(b), "beginner must explain why it is complicated");
  assert.ok(/smaller first version|smaller.*grow/i.test(b), "beginner must offer smaller first version");
});

await t("aesthetics stage is beginner-only and teaches the MOCKUP protocol", () => {
  const b = aestheticsVoice("beginner");
  assert.ok(/MOCKUP:/.test(b));
  assert.ok(/LOOK and FEEL/.test(b));
  assert.equal(aestheticsVoice("vibe"), "");
  assert.equal(aestheticsVoice("engineer"), "");
});

await t("visionExtras flags commitments deterministically", () => {
  const v = "- A page where each customer logs in and sees their saved invoices\n- Sends an email reminder when one is overdue\n- Takes card payments";
  const x = visionExtras(v, { moves: 5, inCost: 1, outCost: 3 });
  const keys = x.flags.map((f) => f.key);
  assert.ok(keys.includes("accounts"), "logs in -> accounts");
  assert.ok(keys.includes("database"), "saved -> database");
  assert.ok(keys.includes("messaging"), "email -> messaging");
  assert.ok(keys.includes("payments"), "card payments -> payments");
  assert.ok(x.est.highUsd > x.est.lowUsd && x.est.lowUsd > 0, "a band, both ends real");
});

await t("a chore chart flags nothing scary", () => {
  const x = visionExtras("- Three chore lists side by side\n- A gold star with an animation when all are checked");
  assert.equal(x.flags.length, 0);
});

await t("costBand speaks honest words under a cent", () => {
  assert.equal(costBand({ lowUsd: 0.0001, highUsd: 0.002 }), "less than a cent");
  assert.ok(/between .* and \$/.test(costBand({ lowUsd: 0.02, highUsd: 0.4 })));
});

console.log("\nidemodes: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
