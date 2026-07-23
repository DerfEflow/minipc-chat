/*
 * Dominion AI - Long-Run Harness: the model glue (SOW items 2+5 wiring, the phase after the
 * billing fuse; FITS addendum in docs/LONGRUN-BILLING-FITS.md).
 *
 * The spine (longrun.mjs) owns the loop and never calls a model; the fuse (longrunbilling.mjs)
 * owns the money. This module is the thin seam between them and a real model call:
 *
 *   - unitMessages(pack, opts) builds ONE unit's fresh context: the mission line, the ledger
 *     tail (compressed to outcomes, never raw model output), the unit itself, and the retry
 *     reason when a validator sent the unit back. Segments never share a conversation: this
 *     pack is the whole context, by design (state lives on disk, not in the model's head).
 *
 *   - makeCallUnit({ chatOnce, model, meter }) returns the callUnit dep runJob wants. LAW:
 *     meter(result, unit) is called at result time, BEFORE validation, because the tokens are
 *     spent whether or not the unit counts. A model-call failure returns { error } so the
 *     runner's own retry/two-strike machinery decides, and an errored call that reported cost
 *     is still metered (the provider charged for it).
 *
 * Pure module: chatOnce is injected (the server passes ideChatOnce), so every path tests
 * without a provider and the e2e rig can run keyless.
 */

const TAIL_LINES = 12;   // how many ledger outcomes a fresh segment context describes

export function unitMessages(pack, { register = "plain" } = {}) {
  const unit = pack.unit || {};
  const tail = (pack.ledgerTail || []).slice(-TAIL_LINES);
  const doneLine = tail.length
    ? tail.map((e) => "unit " + e.unit + " " + (e.outcome || "?") + (e.note ? " (" + String(e.note).slice(0, 120) + ")" : "")).join("; ")
    : "nothing yet; this is the first unit";
  const voice = register === "technical"
    ? "Be concise and technical. Lead with the artifact."
    : register === "hybrid"
      ? "Be plain and clear, with technical terms explained in parentheses."
      : "Be plain and clear.";
  const system =
    "You are one worker in a long-running job. You are given exactly ONE unit of work. " +
    "Do that unit completely and return ONLY its result. Do not summarize the whole job, do " +
    "not do other units, do not ask questions (there is nobody to answer; if something is " +
    "genuinely unknowable, state the assumption you made inline and continue). " + voice + "\n\n" +
    "THE JOB'S MISSION: " + String(pack.mission || "") + "\n" +
    "LEDGER SO FAR: " + doneLine;
  let user = "YOUR UNIT (#" + (unit.unit ?? "?") + "): " + String(unit.title || "work unit");
  if (unit.detail) user += "\n\nDETAIL: " + String(unit.detail);
  if (pack.retryReason) {
    user += "\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: " + String(pack.retryReason) +
      "\nFix exactly that and return the corrected result in full.";
  }
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function makeCallUnit({ chatOnce, model, meter, register = "plain", signal } = {}) {
  if (typeof chatOnce !== "function") throw new Error("makeCallUnit needs chatOnce");
  if (!model) throw new Error("makeCallUnit needs a model");
  return async (unit, pack) => {
    const r = await chatOnce(model, unitMessages(pack, { register }), { signal });
    const costUsd = Math.max(0, Number(r && r.costUsd) || 0);
    // Money law: metered at result time, success or not; the provider charged either way.
    if (typeof meter === "function" && costUsd > 0) meter({ costUsd }, unit);
    if (!r || !r.ok) return { error: (r && r.error) || "the model call failed with no detail" };
    return { text: String(r.content || ""), costUsd, tokens: 0 };
  };
}

/*
 * Boot sweep (item 6's honesty half): a job whose meta still says "running" is being driven by
 * a process that no longer exists (this one just booted). Seal it paused with the truth; the
 * ledger already holds every completed unit, so resume loses at most one segment. Mirrors the
 * ide-jobs "sealed as interrupted" precedent.
 */
export function sealInterrupted(store) {
  let sealed = 0;
  for (const m of store.listJobs()) {
    if (m.state === "running") {
      store.pauseJob(m.id, "the server restarted mid-run; every finished unit is safe in the ledger; resume to continue");
      sealed++;
    }
  }
  return sealed;
}
