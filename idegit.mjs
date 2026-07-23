/*
 * Dominion Works - git lane (Phase 2, Fred's ruling): a build runs on its OWN branch so real work
 * is never mixed into main, a failed build leaves that branch behind as salvage, and a connected
 * GitHub account can init/create/push. Fred's rules, verbatim:
 *   - Every build in a git workspace runs on branch build/<jobid>.
 *   - Real completed work from a failed build stays on that branch, not main.
 *   - A fresh workspace can be git init'd.
 *   - With the GitHub connector linked, create the remote and push with the USER'S OWN token.
 *
 * This module is PURE COMMAND PLANNING: it returns the shell/git command strings and the branch
 * names; the engine runs them through the hands node (which owns carve-out enforcement). No fs, no
 * network, no secrets here. The connector token is fetched by the caller and passed in for the
 * push URL only; it never lands in a snapshot or a log (the caller masks it).
 */

// A branch name that is always valid and unique to the job. Slashes are legal in git refs.
export function buildBranch(jobId) {
  const id = String(jobId || "job").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "job";
  return "build/" + id;
}

// Quote a path for git -C on Windows PowerShell / cmd (double quotes; the path never contains one).
const q = (p) => '"' + String(p || "").replace(/"/g, "") + '"';
const gitC = (root) => "git -C " + q(root) + " ";

/*
 * Is this workspace a git repo, and what is its current branch? The engine runs these and passes
 * the parsed answers back in; this module only builds the command strings and interprets output.
 */
export const isRepoCmd = (root) => gitC(root) + "rev-parse --is-inside-work-tree";
export const currentBranchCmd = (root) => gitC(root) + "rev-parse --abbrev-ref HEAD";

/*
 * Start a build branch. If the workspace is not a repo yet, offer to init (the caller decides
 * whether the user consented). Returns an ORDERED list of commands; a failed one is non-fatal in
 * PS 5.1 (";" chaining) unless noted. checkoutFrom is the branch to branch off (usually current).
 */
export function startBranchPlan({ root, jobId, isRepo, doInit = false }) {
  const branch = buildBranch(jobId);
  const cmds = [];
  if (!isRepo) {
    if (!doInit) return { branch: null, cmds: [], skipped: "not a git repo (init not chosen)" };
    cmds.push(gitC(root) + "init");
    cmds.push(gitC(root) + "add -A");
    cmds.push(gitC(root) + 'commit -m "Initial commit (Dominion Works)" --allow-empty');
  }
  // Create and switch to the build branch. -B resets it if a stale one from a prior attempt exists.
  cmds.push(gitC(root) + "checkout -B " + branch);
  return { branch, cmds };
}

/*
 * Salvage a build onto its branch (Fred: real work saved in a worktree, not main). Commits
 * whatever is present with an honest message naming the outcome. Runs on the build branch, so
 * main is never touched. For a FAILED build this is what keeps the work.
 */
export function salvageCommitPlan({ root, jobId, outcome = "salvage", note = "" }) {
  const branch = buildBranch(jobId);
  const msg = "Dominion Works " + outcome + (note ? ": " + note.slice(0, 120) : "") + " [" + branch + "]";
  return {
    branch,
    cmds: [
      gitC(root) + "add -A",
      gitC(root) + "commit -m " + q(msg) + " --allow-empty",
    ],
  };
}

/*
 * A successful build offers to merge its branch into the branch it came from. The engine only
 * runs this on explicit user consent (a merge into main is a real action).
 */
export function mergePlan({ root, jobId, into }) {
  const branch = buildBranch(jobId);
  const target = String(into || "main").replace(/[^a-zA-Z0-9_/.-]/g, "") || "main";
  return {
    branch,
    cmds: [
      gitC(root) + "checkout " + target,
      gitC(root) + "merge --no-ff " + branch + " -m " + q("Merge " + branch + " (Dominion Works build)"),
    ],
  };
}

/*
 * GitHub push. token is the user's OWN connector token (fetched by the caller). The remote URL
 * embeds it for a one-shot authenticated push; the caller MASKS it in any echoed command and
 * never snapshots it. owner/repo name the remote repository (created via the connector's API by
 * the caller before this runs). Returns { cmds, maskedCmds } so logs show the masked form.
 */
export function githubPushPlan({ root, jobId, owner, repo, token, setUpstream = true }) {
  const branch = buildBranch(jobId);
  const safeOwner = String(owner || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const safeRepo = String(repo || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safeOwner || !safeRepo) return { error: "a GitHub owner and repo are required" };
  const authUrl = "https://x-access-token:" + token + "@github.com/" + safeOwner + "/" + safeRepo + ".git";
  const maskUrl = "https://x-access-token:***@github.com/" + safeOwner + "/" + safeRepo + ".git";
  const push = "push " + (setUpstream ? "-u " : "") + authUrl + " " + branch;
  const maskPush = "push " + (setUpstream ? "-u " : "") + maskUrl + " " + branch;
  return {
    branch, owner: safeOwner, repo: safeRepo,
    cmds: [gitC(root) + push],
    maskedCmds: [gitC(root) + maskPush],
  };
}
