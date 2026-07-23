/*
 * git lane self-test - run: node idegit_test.mjs
 * Branch naming, the start/salvage/merge/push command plans, and the security invariant that
 * MATTERS: a GitHub token never appears in the masked command the caller logs or snapshots.
 */
import assert from "node:assert/strict";
import { buildBranch, startBranchPlan, salvageCommitPlan, mergePlan, githubPushPlan } from "./idegit.mjs";

let passed = 0, failed = 0;
const t = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { failed++; console.error("FAIL  " + n + "\n      " + (e && e.stack || e)); } };

t("build branch is stable, ref-safe, and job-scoped", () => {
  assert.equal(buildBranch("job-abc123"), "build/job-abc123");
  assert.equal(buildBranch("job/../evil"), "build/jobevil");
  assert.equal(buildBranch(""), "build/job");
});

t("start plan: an existing repo just cuts the branch; a non-repo needs consent to init", () => {
  const repo = startBranchPlan({ root: "C:/p", jobId: "j1", isRepo: true });
  assert.equal(repo.branch, "build/j1");
  assert.ok(repo.cmds.some((c) => /checkout -B build\/j1/.test(c)));
  assert.ok(!repo.cmds.some((c) => /init/.test(c)), "an existing repo is never re-init'd");

  const noInit = startBranchPlan({ root: "C:/p", jobId: "j1", isRepo: false, doInit: false });
  assert.equal(noInit.branch, null, "no init without consent");
  assert.match(noInit.skipped, /not a git repo/);

  const withInit = startBranchPlan({ root: "C:/p", jobId: "j1", isRepo: false, doInit: true });
  assert.ok(withInit.cmds.some((c) => /git -C "C:\/p" init/.test(c)));
  assert.ok(withInit.cmds.some((c) => /checkout -B build\/j1/.test(c)));
});

t("salvage commits on the build branch with an honest outcome message", () => {
  const s = salvageCommitPlan({ root: "C:/p", jobId: "j2", outcome: "failed build", note: "part 3 hung" });
  assert.equal(s.branch, "build/j2");
  assert.ok(s.cmds.some((c) => /add -A/.test(c)));
  assert.ok(s.cmds.some((c) => /commit -m .*failed build.*part 3 hung.*build\/j2/.test(c)));
});

t("merge plan checks out the target and no-ff merges the build branch", () => {
  const m = mergePlan({ root: "C:/p", jobId: "j3", into: "main" });
  assert.ok(m.cmds[0].includes("checkout main"));
  assert.ok(m.cmds[1].includes("merge --no-ff build/j3"));
  // A dirty target name is sanitized.
  assert.ok(mergePlan({ root: "C:/p", jobId: "j3", into: "main; rm -rf /" }).cmds[0].includes("checkout mainrm-rf"));
});

t("SECURITY: the GitHub token is in the real command but NEVER in the masked one", () => {
  const p = githubPushPlan({ root: "C:/p", jobId: "j4", owner: "fred", repo: "my-app", token: "ghs_SUPERSECRET123" });
  assert.equal(p.branch, "build/j4");
  assert.ok(p.cmds[0].includes("ghs_SUPERSECRET123"), "the real push carries the token");
  assert.ok(!p.maskedCmds[0].includes("ghs_SUPERSECRET123"), "the masked push must not");
  assert.ok(p.maskedCmds[0].includes("***"), "the masked push shows the redaction");
  assert.ok(p.cmds[0].includes("github.com/fred/my-app.git"));
});

t("push plan refuses without an owner and repo", () => {
  assert.ok(githubPushPlan({ root: "C:/p", jobId: "j5", owner: "", repo: "x", token: "t" }).error);
});

console.log("\nidegit: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
