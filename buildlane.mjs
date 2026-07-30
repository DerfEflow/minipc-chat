/*
 * WHERE A BUILD RUNS (Fred, 2026-07-30, answering "will the user still be able to choose to compute
 * on their own computer if they choose to?").
 *
 * Three lanes exist:
 *   "owner"    — Fred's own machines, through the local hands module
 *   "node"     — a guest's own computer, through the hands hub, if they installed the helper
 *   "workshop" — Dominion's server-side sandbox, whose commands run in a throwaway cloud machine
 *
 * THE RULE IS ONE SENTENCE: the account preference decides where NEW work goes, and existing work
 * always runs where its files already are.
 *
 * The second half is the entire safety of the feature and the reason this is a module rather than
 * three lines inline. A project built in the workshop exists ONLY inside that sandbox; a project on
 * someone's own drive exists only there. If a preference could redirect an EXISTING project, then
 * flipping a toggle would silently point it at a folder that does not exist, and the app would
 * report an empty repository rather than a misrouted one — a frightening failure that nobody would
 * ever connect back to a setting. So a workspace decides its own lane, and the preference is
 * consulted only when there is no workspace to ask.
 *
 * Everything here is a pure function of four facts, which is why it can be tested honestly without
 * a server, a node, or a Fly token.
 */

export const LANES = ["owner", "node", "workshop"];

/*
 * facts:
 *   isOwner    — this account is Fred
 *   nodeLive   — a hands node for this account is connected RIGHT NOW (checked per call, so someone
 *                who installs the helper mid-session is promoted on their next move)
 *   cloudPref  — the account chose the cloud workshop for new work
 * ws: the workspace in scope, or null when the call belongs to no project yet (browsing folders,
 *     probing the machine, creating the first workspace).
 */
export function laneFor({ isOwner = false, nodeLive = false, cloudPref = false } = {}, ws = null) {
  if (ws) {
    // A workspace made in the workshop carries node:"workshop" forever. Anything else was made
    // against a real machine, whoever owns it.
    return String((ws && ws.node) || "") === "workshop" ? "workshop" : (isOwner ? "owner" : "node");
  }
  // No machine attached means there is no choice to make, whatever the stored preference says. A
  // guest who once chose "mine" and then uninstalled the helper must not be routed into a void.
  if (!isOwner && !nodeLive) return "workshop";
  if (cloudPref) return "workshop";
  return isOwner ? "owner" : "node";
}

/*
 * Whether to SHOW the lane control. Only when both lanes genuinely exist for this account: with no
 * machine attached the workshop is not a preference, it is the only thing there is, and a toggle
 * that cannot be moved is worse than no toggle at all.
 */
export function canChooseLane({ isOwner = false, nodeLive = false } = {}) {
  return isOwner ? true : nodeLive === true;
}

// Normalizer for the stored value. Only two lanes are choosable, so anything else is a typo and
// must land on the safe default rather than quietly becoming a third state.
export function normalizeBuildWhere(v) {
  return v === "cloud" ? "cloud" : "mine";
}
