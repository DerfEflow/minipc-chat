/*
 * The AF pipeline's runtime helpers (Fred's design 2026-07-22, SOW section "AF: the Agentic
 * Workflow window"). ideaf.mjs holds the front half (row classification, the divider's format,
 * the referee); this module holds the back half: turning verified parts into engine moves and
 * enforcing the cookie rule at write time. Pure functions only, so it tests with plain data.
 *
 * The cookie rule is a referee, never a promise: even after the divider's plan passes the
 * disjointness check, a worker can still RETURN a file it was never granted. ownershipFilter is
 * the second whistle: files outside the grant are dropped and reported, never silently written.
 */

import { MAX_FILES_PER_MOVE } from "./ideengine.mjs";

const norm = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/* Split a worker's returned files into the ones it owns and the ones it grabbed. */
export function ownershipFilter(files, grant) {
  const allowed = new Set((grant || []).map(norm));
  const kept = [], dropped = [];
  for (const f of files || []) (allowed.has(norm(f && f.path)) ? kept : dropped).push(f);
  return { kept, dropped };
}

/*
 * The plan the Blueprint shows: one row per relay stage, honest about ownership. Emitted BEFORE
 * anything runs, so the user watches the same rows the pipeline executes.
 */
export function afPlanMoves({ dividerTask, parts = [], reviewerTask = "", qcTask = "" } = {}) {
  const moves = [{ id: "af-divide", title: dividerTask || "Divide the work and write the contracts", files: [], why: "" }];
  parts.forEach((p, i) => moves.push(afWorkerMove(p, i + 1)));
  if (reviewerTask) parts.forEach((p, i) => moves.push({
    id: "af-review-" + (i + 1), title: reviewerTask + " (part " + (i + 1) + ")", files: p.files || [],
    why: "Checks part " + (i + 1) + " against its contract.",
  }));
  if (qcTask) moves.push(afQcMove(parts, qcTask));
  return moves;
}

export function afWorkerMove(part, k) {
  return {
    id: "af-p" + k,
    title: "Part " + k + ": " + (part.title || "unnamed"),
    files: part.files || [],
    why: "You own these files EXCLUSIVELY; no other agent touches them, and you touch nothing else. "
      + "CONTRACT (your promises to the other parts): " + (part.contract || "none stated")
      + " Build to the contract; the seams are verified later, never rebuilt.",
  };
}

export function afReviewMove(part, k, { reviewerTask = "Review and fix", checkOutput = "" } = {}) {
  return {
    id: "af-review-" + k,
    title: reviewerTask + " (part " + k + ")",
    files: part.files || [],
    why: "Review this part against its contract and fix what breaks it. CONTRACT: "
      + (part.contract || "none stated")
      + (checkOutput ? " The project check reported:\n" + String(checkOutput).slice(-3000) : "")
      + " Return corrected complete files, or no files at all when the part already holds.",
  };
}

export function afQcMove(parts = [], qcTask = "Final quality check") {
  const union = [];
  for (const p of parts) {
    for (const f of p.files || []) {
      if (union.length >= MAX_FILES_PER_MOVE) break;
      if (!union.some((u) => norm(u) === norm(f))) union.push(f);
    }
    if (union.length >= MAX_FILES_PER_MOVE) break;
  }
  return {
    id: "af-qc",
    title: qcTask,
    files: union,
    why: "The whole, after the relay. Every part's contract:\n"
      + parts.map((p, i) => "Part " + (i + 1) + " (" + (p.title || "unnamed") + "): " + (p.contract || "none stated")).join("\n")
      + "\nVerify the seams between parts and fix what breaks them. Return corrected complete files, or no files at all when the build already holds.",
  };
}
