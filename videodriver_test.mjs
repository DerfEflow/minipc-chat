/*
 * Video-on-the-driver self-test — run with: node videodriver_test.mjs
 *
 * The bug this closes: the entire generation pipeline (ask Runware, settle the charge, download,
 * verify) ran only inside GET /jobs/:id, so a browser tab was the engine. Close the tab and the
 * job stopped advancing. Runware finished the clip anyway and its download URL aged out, leaving a
 * user who had paid for something that then evaporated.
 *
 * These drive the registered "video" kind against a fake feature and a fake meter, so the sequence
 * and its money handling are asserted without touching a provider. What is NOT re-tested here is
 * exactly-once settlement itself: that lives in video-meter's own SQLite table and video-meter_test
 * already owns it. What matters here is that the driver settles BEFORE downloading and never
 * settles a job the provider has not finished.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskKernel } from "./taskkernel.mjs";
import { createTaskDriver } from "./taskdriver.mjs";

let passed = 0, failed = 0;
const dirs = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + "\n      " + ((e && e.message) || e)); }
}
function freshDir() { const d = mkdtempSync(join(tmpdir(), "videodriver-")); dirs.push(d); return d; }
function clockAt(start) { let t = start; return { now: () => t, advance: (ms) => (t += ms) }; }

/*
 * A stand-in for the registered kind. It mirrors server.mjs's poll() sequence exactly; keeping it
 * here rather than importing server.mjs is what lets this run without booting the whole app, at
 * the cost of a shape that must be kept in step. videodriver "sequence" test below is the guard
 * that catches drift, by asserting against server.mjs's real source.
 */
function videoKind({ feature, meter, calls }) {
  return {
    describe: (t2) => (t2.status === "done" ? "Your video clip is ready" : "A video generation did not finish"),
    href: (t2) => "/?video=1&project=" + encodeURIComponent(t2.anchor),
    maxAgeMs: 60 * 60000,
    poll: async (task) => {
      const tenantId = task.uid, projectId = task.anchor, jobId = task.externalId;
      if (!tenantId || !projectId || !jobId) return { failed: true, code: "incomplete_record", message: "missing details" };
      let job = await feature.pollJob(tenantId, projectId, jobId);
      if (!job) return { failed: true, code: "job_gone", message: "gone" };
      if (job.status === "failed") return { failed: true, code: "provider_failed", message: String((job.providerError || {}).message || "failed") };
      if (job.status !== "ready") return { retryInMs: Number((job.retry || {}).delayMs) || 0 };
      if (Number(job.cost) > 0 && !(job.settlement && job.settlement.status === "settled")) {
        const s = await meter.settle({}, Number(job.cost), { jobId, projectId });
        calls.push("settle");
        job = await feature.markJobSettled(tenantId, projectId, jobId, s || {});
      }
      if (job.output && !job.localOutput) {
        calls.push("download");
        job = await feature.downloadJobOutput(tenantId, projectId, jobId);
        if (!job.localOutput) return { retryInMs: 5000 };
      }
      return { done: true, resultRef: job.localOutput || "", meta: { projectId, jobId } };
    },
  };
}

// A provider that takes `readyAfter` polls, then reports a finished clip.
function fakeStack({ readyAfter = 2, cost = 0.42, downloadFailsFirst = 0 } = {}) {
  const calls = [];
  let polls = 0, settled = false, downloaded = false, downloadAttempts = 0;
  const feature = {
    pollJob: async () => {
      polls++; calls.push("poll");
      if (polls < readyAfter) return { status: "running", retry: { delayMs: 0 } };
      return { status: "ready", cost, output: "https://provider/clip.mp4",
               localOutput: downloaded ? "/data/video/clip.mp4" : null,
               settlement: settled ? { status: "settled" } : null };
    },
    markJobSettled: async () => { settled = true; return { status: "ready", cost, output: "https://provider/clip.mp4", localOutput: downloaded ? "/data/video/clip.mp4" : null, settlement: { status: "settled" } }; },
    downloadJobOutput: async () => {
      downloadAttempts++;
      if (downloadAttempts > downloadFailsFirst) downloaded = true;
      return { status: "ready", cost, output: "https://provider/clip.mp4", localOutput: downloaded ? "/data/video/clip.mp4" : null, settlement: { status: "settled" } };
    },
  };
  const meter = { settle: async (T, usd) => ({ status: "settled", costUsd: usd }) };
  return { feature, meter, calls, counts: () => ({ polls, downloadAttempts, settled, downloaded }) };
}

console.log("video on the driver");

await t("a generation finishes with no browser attached", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  const stack = fakeStack({ readyAfter: 3 });
  k.register("video", videoKind(stack));
  const notes = [];
  const d = createTaskDriver({ kernel: k, now: c.now, onNotify: async (n) => notes.push(n) });
  k.createTask({ id: "vid-1", kind: "video", surface: "video", anchor: "proj-7", uid: "u1",
                 title: "Opening shot", status: "running", externalId: "job-7", pollAt: c.now() });

  for (let i = 0; i < 4; i++) { await d.tick(); c.advance(60000); }
  const row = k.get("vid-1");
  assert.equal(row.status, "done", "the clip should have landed with nobody watching");
  assert.equal(row.resultRef, "/data/video/clip.mp4", "the verified local file must be recorded");
  assert.equal(notes.length, 1, "the user must be told exactly once");
  assert.equal(notes[0].href, "/?video=1&project=proj-7", "and sent back to the right project");
});

await t("the charge is settled BEFORE the download is attempted", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  const stack = fakeStack({ readyAfter: 1 });
  k.register("video", videoKind(stack));
  const d = createTaskDriver({ kernel: k, now: c.now });
  k.createTask({ id: "vid-1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", externalId: "j1", pollAt: c.now() });
  await d.tick();
  const order = stack.calls.filter((x) => x === "settle" || x === "download");
  assert.deepEqual(order, ["settle", "download"],
    "a clip held but never charged is a smaller problem than a charge with no clip");
});

await t("a job the provider has not finished is never charged", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  const stack = fakeStack({ readyAfter: 99 });
  k.register("video", videoKind(stack));
  const d = createTaskDriver({ kernel: k, now: c.now });
  k.createTask({ id: "vid-1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", externalId: "j1", pollAt: c.now() });
  for (let i = 0; i < 3; i++) { await d.tick(); c.advance(60000); }
  assert.ok(!stack.calls.includes("settle"), "an unfinished generation must never be settled");
  assert.equal(k.get("vid-1").status, "running");
});

await t("settlement is attempted once, not once per poll", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  // The download fails twice, forcing extra polls AFTER the charge has already settled.
  const stack = fakeStack({ readyAfter: 1, downloadFailsFirst: 2 });
  k.register("video", videoKind(stack));
  const d = createTaskDriver({ kernel: k, now: c.now });
  k.createTask({ id: "vid-1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", externalId: "j1", pollAt: c.now() });
  for (let i = 0; i < 4; i++) { await d.tick(); c.advance(60000); }
  const settles = stack.calls.filter((x) => x === "settle").length;
  assert.equal(settles, 1, `retrying a download must not re-charge, saw ${settles} settlements`);
  assert.equal(k.get("vid-1").status, "done", "and the retried download should eventually land");
});

await t("a provider failure fails the task loudly rather than retrying forever", async () => {
  const c = clockAt(1_000_000);
  const k = createTaskKernel({ dir: freshDir(), now: c.now });
  k.register("video", {
    describe: () => "A video generation did not finish", href: () => "/?video=1",
    poll: async () => ({ status: "failed" }).status === "failed"
      ? { failed: true, code: "provider_failed", message: "content policy" } : {},
  });
  const notes = [];
  const d = createTaskDriver({ kernel: k, now: c.now, onNotify: async (n) => notes.push(n) });
  k.createTask({ id: "vid-1", kind: "video", surface: "video", anchor: "p1", uid: "u1", status: "running", externalId: "j1", pollAt: c.now() });
  await d.tick();
  const res = k.resultFor("vid-1");
  assert.equal(res.status, "failed");
  assert.ok(res.errors.some((e) => /content policy/.test(e)), "the reason must reach the user: " + res.errors);
  assert.equal(notes.length, 1, "a failure notifies too, or it just disappears");
});

/* ---- the real registration, checked against this file's stand-in ------------------------------ */
await t("server.mjs registers the video kind and hands jobs to it at submit", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /tasks\.register\("video"/, "the video kind must be registered or nothing drives it");
  const reg = server.slice(server.indexOf('tasks.register("video"'));
  const body = reg.slice(0, reg.indexOf("\nconst videoHttp"));
  // Same order this file asserts above, in the code that actually ships.
  assert.ok(body.indexOf("videoMeter.settle") < body.indexOf("downloadJobOutput"),
    "the shipped poll() must settle before downloading, like the stand-in above");
  assert.match(body, /status !== "ready"/, "an unfinished job must short-circuit before any charge");
  assert.match(server, /onJobQueued: \(\{/, "submitting a generation must create the task that drives it");
  assert.match(server, /kind: "video"/, "and it must be created as the video kind");

  const http = readFileSync(new URL("./video-http.mjs", import.meta.url), "utf8");
  assert.match(http, /typeof onJobQueued === "function"/, "the hook must be optional so the module stands alone");
  const hook = http.slice(http.indexOf("if (typeof onJobQueued"), http.indexOf("if (typeof onJobQueued") + 400);
  assert.match(hook, /catch/, "a kernel hiccup must not turn a paid, submitted generation into an error");
});

/* ---- the walls come down once the server is the engine --------------------------------------- */
await t("Video Studio no longer holds you hostage to a generation", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./public/dominion-video.js", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const closeFn = code.slice(code.indexOf("async function close()"), code.indexOf("function init()"));
  assert.ok(closeFn.length > 200, "failed to isolate close()");

  // Isolate the REFUSAL CONDITION only. Slicing to `closing=true` would also swallow the advisory
  // toast that now tells the user their generation keeps running, and that toast legitimately
  // mentions generation — a looser slice would pass while the wall was still standing.
  const refusalStart = closeFn.indexOf("if(projectSwitching");
  const refusal = closeFn.slice(refusalStart, closeFn.indexOf("return toast", refusalStart));
  assert.ok(!/state\.inflight\.generation/.test(refusal),
    "a running generation must not block leaving — the server finishes it now");
  assert.ok(!/activeJobs\.size/.test(refusal), "nor may an active job entry block leaving");

  /*
   * The remaining blockers are deliberate and the distinction is the point: an unsaved draft, an
   * import, an export and a project switch all hold state that lives in the TAB and would be
   * destroyed by leaving. A generation's state lives on the server. Waiting is only justified
   * when leaving would lose something.
   */
  for (const kept of ["state.inflight.chat", "state.inflight.import", "state.inflight.export", "projectSwitching"]) {
    assert.ok(refusal.includes(kept), `${kept} must STILL block closing — leaving would lose tab-local work`);
  }
  assert.match(closeFn, /keeps running/, "leaving mid-generation should say so, not go silent");
});

await t("opening one panel does not read as cancelling another's work", async () => {
  const { readFileSync } = await import("node:fs");
  const images = readFileSync(new URL("./public/dominion-images.js", import.meta.url), "utf8");
  // The panels may still hide each other; what must not survive is the claim that this is a
  // lifecycle event. Nothing stops when a reveal closes.
  assert.ok(!/one reveal at a time[\s\S]{0,80}including Dominion Works/.test(images),
    "the old comment implied opening Images cancelled a build, which was never true");
});

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
