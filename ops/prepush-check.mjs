#!/usr/bin/env node
/*
 * Pre-push guard (Fred, 2026-07-30): a push is a deploy, and a deploy executes every running
 * turn on the old container. Nineteen same-day deploys killed two of Fred's live builds today.
 * This script asks production how many chat jobs are running RIGHT NOW and exits nonzero when a
 * push would interrupt someone, so "check before you push" is one command instead of a promise:
 *
 *   node ops/prepush-check.mjs            # human-readable verdict, exit 0 = safe to push
 *   node ops/prepush-check.mjs --wait     # poll every 20s until the coast is clear (max 30 min)
 *
 * Auth: the public /api/version needs nothing; the running-jobs probe rides the boot banner's
 * counters exposed on /api/version (added 2026-07-30) so NO owner cookie is required and nothing
 * sensitive is revealed beyond a count.
 */
const BASE = process.env.DOMINION_BASE_URL || "https://app.dominion.tools";
const WAIT = process.argv.includes("--wait");
const DEADLINE = Date.now() + 30 * 60 * 1000;

async function probe() {
  const r = await fetch(BASE + "/api/version", { headers: { "cache-control": "no-store" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + BASE + "/api/version");
  return r.json();
}

/*
 * Verdict via process.exitCode + return, never process.exit() from inside the async loop: on
 * Windows that aborts the process with a libuv assertion instead of exiting, and a guard whose
 * exit status is garbage is worse than no guard at all (caught on its first real use).
 */
async function verdict() {
  for (;;) {
    let v;
    try { v = await probe(); }
    catch (e) {
      console.error("prepush-check: cannot reach production (" + (e && e.message) + ") — treat as UNSAFE.");
      return 2;
    }
    const running = Number(v.runningChatJobs);
    if (!Number.isFinite(running)) {
      console.error("prepush-check: production does not report runningChatJobs yet (build " + (v.build || v.sha || "unknown") + "). Deploy this build once, then the guard works. Treat as UNKNOWN.");
      return 3;
    }
    if (running === 0) {
      console.log("prepush-check: 0 running chat jobs on " + BASE + " — safe to push.");
      return 0;
    }
    console.log("prepush-check: " + running + " running chat job(s) on " + BASE + " — a push now would execute them.");
    if (!WAIT || Date.now() > DEADLINE) return 1;
    await new Promise((res) => setTimeout(res, 20000));
  }
}

process.exitCode = await verdict();
