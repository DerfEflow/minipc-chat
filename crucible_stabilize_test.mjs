/*
 * Lane crucible, stabilization 2026-09-03 (DEFICIENCIES.md items 10, 12, 13; LANE-crucible.md
 * "Required behavior" 1-8). Run with: node crucible_stabilize_test.mjs
 *
 * Most of what this lane changed lives inside server.mjs's runIdeBuild - a single very large,
 * non-exported function with no dependency-injection seam (workspace, tenant, billing, and hands
 * plumbing all closed over it), the same reason crucible_execution_contract_test.mjs already
 * tests deeply-embedded build-runner behavior by reading the source and asserting the exact code
 * shape is present, rather than driving the whole function end to end. This file follows that
 * same established, precedented pattern for the pieces that live in server.mjs. Pieces that live
 * in importable modules (idejobs.mjs, ideengine.mjs) get real behavioral tests with mocked
 * chat()/hands() instead, because those DO have a seam.
 *
 * The genuine end-to-end proof for the server.mjs-embedded pieces is the rig run pasted in the
 * final report (AGENT-RULES.md: "Live proof is required in addition to tests"), not a substitute
 * for it: a green regex assertion here proves the code exists and is wired where it should be; it
 * does not prove a real model actually behaves as expected against it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIdeEngine, isEnvironmentFailure, ENVIRONMENT_FAILURE_RE } from "./ideengine.mjs";
import { createLessonStore } from "./idelessons.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Normalized to LF: the working tree is checked out CRLF on Windows, and a raw \n in a multi-line
// regex would otherwise silently never match a real line break in the file.
const SRC = readFileSync(new URL("./server.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

/* ---------------------------------------------------------------------------------------------
 * Required behavior #8: the 08-01 "mv is not defined" crash. 11 of 13 production build errors
 * since 07-24 were this one ReferenceError (DEFICIENCIES.md #10). The fix (main, before this
 * lane) replaced the stray `mv` reference with a real in-scope value; this pins it so it cannot
 * silently regress back to the old identifier.
 * ------------------------------------------------------------------------------------------- */

await t("REGRESSION (mv is not defined): the task-graph budget estimate uses an in-scope value, never the free identifier `mv`", () => {
  assert.match(SRC, /const filesPerTask = Math\.max\(1, \.\.\.tasks\.map\(\(t\) => \(t\.files \|\| \[\]\)\.length\)\)/,
    "the fixed per-unit file-count estimate must still derive from `tasks`, not a nonexistent `mv`");
  assert.match(SRC, /const est = estimateMove\(\{ manifestBytes: 8000, files: filesPerTask,/,
    "the task-graph budget freeze must use filesPerTask");
  // The exact crash signature (a bare, free-standing `mv && mv.files` reference) must never
  // reappear in actual CODE. It legitimately still appears once, inside a `/* ... */` doc comment
  // a few lines above the fix that quotes the old bad line verbatim to explain what broke and
  // why - so comment lines (blank, `/*`, `*`, or `*/`-prefixed, once trimmed) are excluded here,
  // and the AF worker-move constructor's own correctly-scoped local `const mv = afWorkerMove(...)`
  // is a different, legitimate binding, not this bug.
  const offenders = SRC.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!/\bmv\s*&&\s*mv\.files\b/.test(trimmed)) return false;
    if (/^\*/.test(trimmed) || trimmed.startsWith("/*")) return false;   // inside the doc comment
    return true;
  });
  assert.equal(offenders.length, 0, "no free-standing `mv && mv.files` reference may exist in real code: " + offenders.join(" | "));
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #1: missing planned file gets a real repair, escalating up to 3 attempts,
 * before the checkpoint - and the checkpoint names what was tried. DEFICIENCIES.md #10: the
 * 09-02 Speak-Easy build ended solely on this, with NOTHING attempted first.
 * ------------------------------------------------------------------------------------------- */

await t("MISSING PLANNED FILE: an omitted file is repaired (re-ask, then dedicated write, escalating) before it can reach the checkpoint", () => {
  assert.match(SRC, /MISSING PLANNED FILE REPAIR \(required behavior #1/);
  assert.match(SRC, /Return the complete contents of " \+ file, *\n\s*why: \(originalWhy \? originalWhy \+ " " : ""\) \+ "This file was declared for this build but was never returned/);
  assert.match(SRC, /for \(let n = 2; n <= 3 && !isCovered\(file\); n\+\+\)/,
    "the dedicated-write fallback must try up to 3 total attempts");
  assert.match(SRC, /title: "Write " \+ file,/);
  assert.match(SRC, /r = await engine\.runMove\(job, \{ move: attempt1, workspace, assignments: resolved, goal: prompt, plannedFiles: \[\.\.\.expectedFiles\] \}\);/,
    "the repair must go through engine.runMove, which is where the counsel ladder (brain/frontier) already lives");
  assert.match(SRC, /if \(!isCovered\(file\)\) \{\s*\n\s*knownIncomplete\.push\("Planned file was never returned by its assigned implementation step: " \+ file\s*\n\s*\+ "\. Tried: " \+ tried\.join\("; "\) \+ "\."\);/,
    "only after every attempt fails must the checkpoint text name what was tried");
});

await t("MISSING PLANNED FILE: the coverage tracker is the single choke point every pipeline path already funnels through", () => {
  // markCovered is called by the standard-crew queue, the AF stage, the task-graph unit runner,
  // and the completion-repair loop already (pre-existing code); this proves the NEW repair path
  // reads the SAME coveredFiles set those paths write to, so it cannot go stale against them.
  assert.match(SRC, /const isCovered = \(file\) => coveredFiles\.has\(String\(file \|\| ""\)\.trim\(\)\.replace/);
});

await t("TEST HOOK for the rig: IDE_TEST_OMIT_FILE reproduces the observed bug (a step succeeds, one file's coverage never lands) without any model involved", () => {
  assert.match(SRC, /IDE_TEST_OMIT_FILE/);
  assert.match(SRC, /let testOmitPending = String\(process\.env\.IDE_TEST_OMIT_FILE \|\| ""\)/);
  assert.match(SRC, /if \(testOmitPending && normalized === testOmitPending\) \{ testOmitPending = ""; continue; \}/,
    "the hook must fire exactly once, then get out of the way");
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #2: plan format never fails the build. Up to 3 escalating attempts, then an
 * honest single-move fallback built from the raw prompt - never ideJobs.finish({type:"error"}).
 * ------------------------------------------------------------------------------------------- */

await t("PLAN FORMAT: prose (or any unparsable reply) escalates through 3 attempts before falling back, never hard-fails the build", () => {
  assert.match(SRC, /REQUIRED BEHAVIOR #2: "a build never fails on plan format\."/);
  assert.match(SRC, /for \(let attempt = 1; attempt <= 3 && !parsed\.ok; attempt\+\+\) \{/);
  assert.match(SRC, /if \(attempt > 1\) plannerModelUsed = escalateModel\(plannerModelUsed\) \|\| plannerModelUsed;/,
    "every attempt after the first must escalate to a stronger keyed model");
  assert.match(SRC, /if \(!parsed\.ok\) \{\s*\n\s*const said = String\(lastRawReply \|\| ""\)/,
    "exhausting all 3 attempts must degrade to a fallback plan, not an error");
  assert.match(SRC, /moves = \[\{ id: "m1", title: prompt\.slice\(0, 140\),\s*\n\s*why: "Fallback plan: the planner could not produce a usable move list after 3 escalating attempts/);
  assert.match(SRC, /ideJobs\.emit\(job\.id, \{ type: "plan", title: prompt\.slice\(0, 140\), moves, single: true, degraded: true \}\);/);
});

await t("PLAN FORMAT: every failed attempt is classified as a counsel failure (required behavior #4) - the brain is asked and can leave a lesson", () => {
  // The brain call must be INSIDE the per-attempt loop (fires on attempt 1's failure too, not
  // only after everything is already exhausted, which is what the pre-stabilization code did).
  const loopStart = SRC.indexOf("for (let attempt = 1; attempt <= 3 && !parsed.ok; attempt++) {");
  const nextSectionStart = SRC.indexOf("if (!parsed.ok) {\n        const said = String(lastRawReply", loopStart);
  assert.ok(loopStart > 0 && nextSectionStart > loopStart, "both anchors must be found in order");
  const loopBody = SRC.slice(loopStart, nextSectionStart);
  assert.match(loopBody, /if \(brainModel\) \{/);
  assert.match(loopBody, /parsedBrain\.report\.lesson/);
  assert.match(loopBody, /ideLessons\.record\(\{ text: parsedBrain\.report\.lesson, scope: "planner", source: "brain", model: plannerModelUsed/);
  assert.match(loopBody, /await reportCrucibleCounsel\(job, \{ source: "brain", model: plannerModelUsed, stage: "planner"/);
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #3: an unreadable furnace audit retries on the next counsel model, then
 * falls to concrete checks (declared scripts + node --check) rather than shipping "unaudited".
 * ------------------------------------------------------------------------------------------- */

await t("FURNACE AUDIT: nothing-readable retries on the next counsel model before falling back", () => {
  assert.match(SRC, /const nothingReadable = audited\.ok && !fid\.ok\.length && !fid\.gaps\.length;/);
  assert.match(SRC, /if \(nothingReadable\) \{\s*\n\s*const nextModel = escalateModel\(auditModel\) \|\| auditModel;/);
  assert.match(SRC, /audited = await askAudit\(nextModel\);/);
});

await t("FURNACE AUDIT: a still-unreadable verdict falls back to concrete checks (declared scripts + node --check), never 'unaudited'", () => {
  assert.match(SRC, /const stillUnreadable = !audited\.ok \|\| \(!fid\.ok\.length && !fid\.gaps\.length\);/);
  assert.match(SRC, /const cv = await engine\.verify\(job, workspace\);/);
  assert.match(SRC, /node --check "/);
  assert.match(SRC, /gaps = concreteFindings;/);
  assert.doesNotMatch(SRC, /\|\| "The audit returned nothing readable; treat the build as unaudited\."/,
    "the old bare 'unaudited' end state must be gone, not just supplemented");
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #5: never park on need_input; a move fails auto-retry up to 3 attempts then
 * auto-skips. A status heartbeat fires every 30s while a model call is in flight.
 * ------------------------------------------------------------------------------------------- */

await t("NEVER PARK: a failed move auto-retries up to 3 attempts, then auto-skips, and every failure still carries an auto policy", () => {
  assert.match(SRC, /const MOVE_AUTO_RETRY_LIMIT = 3;/);
  assert.match(SRC, /const retrying = soFar < MOVE_AUTO_RETRY_LIMIT;/);
  assert.match(SRC, /moveFailAuto\(move\.id\)\);/, "every move-failed ask() must still carry the auto policy unconditionally");
});

await t("STATUS HEARTBEAT: a model call in flight emits a status event every 30s via a shared wrapper used by every chat path", () => {
  assert.match(SRC, /const STATUS_HEARTBEAT_MS = 30_000;/);
  assert.match(SRC, /const STALL_MS = 180_000;/);
  assert.match(SRC, /ideJobs\.emit\(job\.id, \{ type: "status", label \}\);/);
  // bare, the primary call, and the dead-seat reroute call must ALL go through withLiveness -
  // a model call that only sometimes heartbeats is not "the stream shows life" on every path.
  assert.match(SRC, /return withLiveness\(\s*\n\s*ideChatOnce\(model,/);
  assert.match(SRC, /const first = await withLiveness\(ideChatWithWorkspaceTools\(model, managed, opts\), "waiting on " \+ model\);/);
  assert.match(SRC, /const second = await withLiveness\(ideChatWithWorkspaceTools\(alt, managed, opts\), "waiting on " \+ alt\);/);
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #7: a stalled model call (no answer within 180s) is retried on the next
 * rung; a move that burns the full 20-minute budget and still fails is re-planned into smaller
 * moves once.
 * ------------------------------------------------------------------------------------------- */

await t("MOVE TIMEOUT: a 180s stall is turned into a transport failure the existing dead-seat reroute already knows how to retry on another model", () => {
  assert.match(SRC, /error: "The model produced no answer within " \+ Math\.round\(STALL_MS \/ 1000\) \+ " seconds\.", stalled: true/);
  // The stall message must actually satisfy the pre-existing transport-failure detector so it
  // reroutes automatically, rather than needing a second, parallel reroute mechanism.
  assert.match(SRC, /\/unreachable\|did not finish\|no answer\|empty response\/i\.test\(String\(first\.error \|\| ""\)\)/);
});

await t("MOVE TIMEOUT: a move that runs past 20 minutes and fails is re-planned into smaller moves exactly once per move id", () => {
  assert.match(SRC, /const MOVE_TIME_BUDGET_MS = 20 \* 60 \* 1000;/);
  assert.match(SRC, /const replannedForTime = new Set\(\);/);
  assert.match(SRC, /if \(moveElapsedMs >= MOVE_TIME_BUDGET_MS && \(move\.files \|\| \[\]\)\.length > 1 && !replannedForTime\.has\(move\.id\)\) \{/);
  assert.match(SRC, /replannedForTime\.add\(move\.id\);/);
  assert.match(SRC, /queue\.splice\(i, 1, \.\.\.replacement\);/);
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #6: server restart resumes an in-progress job from its journal instead of
 * sealing it as an error; an unreachable workspace parks as paused and resumes on reconnect.
 * (idejobs.mjs's own resume machinery has full behavioral tests in idejobs_test.mjs; this proves
 * server.mjs actually wires a real resume() implementation into it, and that runIdeBuild honors
 * a resumed plan/ledger rather than silently re-planning and re-running everything from zero.)
 * ------------------------------------------------------------------------------------------- */

await t("RESTART RESUME: server.mjs wires a real resume() implementation into the job spine, probing the machine before relaunching", () => {
  assert.match(SRC, /async function resumeIdeBuild\(job, info\) \{/);
  assert.match(SRC, /createIdeJobs\(\{ dir: dataPath\("ide"\), log: \(m\) => console\.log\(m\), onEvent: ideEscalate, resume: resumeIdeBuild \}\);/);
  assert.match(SRC, /const probe = await ideHandsFor\(T, workspace\)\("node_info", \{\}\);/);
  assert.match(SRC, /return \{ ok: false, paused: true, reason: "The build machine is offline;/,
    "an unreachable workspace must park as paused, never seal as a hard error");
  assert.match(SRC, /runIdeBuild\(job, \{\s*\n\s*T, workspace, prompt: req\.prompt, assignments: req\.assignments \|\| \{\}, register: req\.register,/);
});

await t("RESTART RESUME: the build request is recorded once (never on a resume itself) so a later restart has something to resume from", () => {
  assert.match(SRC, /if \(!resumePlan && !resumeLedger\) \{\s*\n\s*try \{ ideJobs\.recordRequest\(job\.id, \{ prompt, workspaceId: workspace && workspace\.id, assignments, register, mode, forgeTier, forgeMode \}\); \} catch \{\}/);
});

await t("RESTART RESUME: a resumed plan is reused verbatim (no re-planning spend) and already-done moves are skipped from the re-queued work", () => {
  assert.match(SRC, /if \(resumePlan && Array\.isArray\(resumePlan\.moves\) && resumePlan\.moves\.length && !resumePlan\.af\) \{/);
  assert.match(SRC, /moves = resumePlan\.moves;/);
  assert.match(SRC, /if \(resumeLedger && !afRan\) \{/);
  assert.match(SRC, /standardQueue = standardQueue\.filter\(\(m\) => !alreadyDone\.has\(m\.title\) && !alreadyDone\.has\(m\.id\)\);/);
});

await t("RESTART RESUME: files already written before the restart count as covered, so the completion gate never re-flags a finished move's files as missing", () => {
  assert.match(SRC, /if \(resumeLedger && Array\.isArray\(resumeLedger\.files\)\) markCovered\(resumeLedger\.files\);/);
});

/* ---------------------------------------------------------------------------------------------
 * Required behavior #4: counsel triggers. The specific failure modes named in the spec must all
 * reach the brain/frontier ladder - proven above per-mode (missing file -> engine.runMove;
 * prose plan -> the per-attempt brain call; unreadable audit -> the concrete-check fallback
 * itself is deterministic and needs no model, but the audit CALL failure is what feeds it, and
 * that path is exercised live on the rig). This test confirms the shared, pre-existing ladder
 * (ideengine.mjs runMove) still does what required behavior #4 depends on every other required
 * behavior to reuse: a real diagnosis on a real failure, with a lesson recorded from it.
 * ------------------------------------------------------------------------------------------- */

await t("COUNSEL LADDER (reused by every required-behavior-#1 repair move): a failed move gets a brain diagnosis and a lesson is recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crucible-stabilize-lessons-"));
  try {
    const lessons = createLessonStore({ dir });
    const events = [];
    let calls = 0;
    const engine = createIdeEngine({
      jobs: { emit: (_id, ev) => events.push(ev) },
      chat: async (call) => {
        calls++;
        // First two calls: the worker attempt, then its format retry, both genuinely empty (no
        // file blocks at all) so runMoveOnce fails outright rather than needing real tool plumbing.
        if (calls <= 2) return { ok: true, content: "I could not find that file.", costUsd: 0.001 };
        // Third call: the brain, asked with a bare dossier. Must answer the strict brain-report
        // contract or parseBrainReport will (correctly) refuse it.
        return { ok: true, content: JSON.stringify({
          rootCause: "wrong_file_scope", confidence: 0.9,
          fix: "Read the manifest before claiming a file is missing.",
          lesson: "Always inspect the manifest before declaring a planned file cannot be found.",
        }), costUsd: 0.002 };
      },
      hands: async (tool) => {
        if (tool === "fs_read") return { ok: true, content: "" };
        if (tool === "shell_run") return { ok: true, code: 0, stdout: "" };
        return { ok: true };
      },
      router: () => ({ taskClass: "build_code", model: "openai/gpt-5.6-sol", why: "test" }),
      lessons,
      advisors: { brainModel: "gx10/gpt-oss-120b", frontierModel: "", minBrainConfidence: 0,
        frontierCallsLeft: () => 0, noteFrontierCall: () => {} },
    });

    const result = await engine.runMove({ id: "ide_stabilize" }, {
      move: { id: "m1", title: "Write the missing file", why: "test", files: ["src/missing.ts"] },
      workspace: { root: "C:/Projects/stabilize-test", name: "Stabilize Test" },
      assignments: {}, goal: "Write src/missing.ts.",
    });

    assert.equal(result.ok, false, "the move genuinely never returned a file, so it must stay failed");
    assert.ok(events.some((e) => e.type === "run" && e.command === "brain" && e.ok === true),
      "a failed move must produce a brain run event");
    const stats = lessons.stats();
    assert.ok(stats.active >= 1, "the brain's lesson must actually land in the lessons store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * ---------------------------------------------------------------------------------------------
 * Production incident follow-up, 2026-09-03: a workspace registered on a folder outside every
 * connected node's HANDS_ROOTS was accepted silently, the build landed on the wrong node, every
 * move failed identically with hands.mjs's "outside this node's allowed roots (...)" refusal, and
 * the counsel ladder burned about $1 diagnosing model output that was never the problem.
 * Required: (1) POST /ide/workspace validates the root against the chosen node's roots and
 * answers 400 naming the allowed roots; (2) a build-start re-check ends immediately as paused
 * with zero model spend when the root is outside the build node's roots; (3) a move/tool failure
 * whose output matches the hands node's own refusal text is classified as an ENVIRONMENT failure
 * (no brain/frontier/escalation) and pauses the build.
 * ------------------------------------------------------------------------------------------- */

await t("ENVIRONMENT #3: isEnvironmentFailure matches the EXACT string hands.mjs's withinRoots() actually produces", () => {
  // Probed directly from hands/hands.mjs, not guessed (rule 8.6): withinRoots() returns
  // `outside this node's allowed roots (${ROOTS.join(", ")})` on every fs_read/fs_write/fs_list/
  // shell_run refusal outside HANDS_ROOTS.
  const handsSrc = readFileSync(new URL("./hands/hands.mjs", import.meta.url), "utf8");
  assert.match(handsSrc, /outside this node's allowed roots \(\$\{ROOTS\.join\(", "\)\}\)/,
    "the probed string in hands.mjs must still match what ENVIRONMENT_FAILURE_RE looks for");
  const real = "outside this node's allowed roots (/work, /models)";
  assert.match(real, ENVIRONMENT_FAILURE_RE);
  assert.ok(isEnvironmentFailure({ checkOutput: "npm test failed:\n" + real }));
  assert.ok(isEnvironmentFailure({ lastReply: "The tool refused: " + real }));
  assert.ok(isEnvironmentFailure({ pipelineNotes: "format retry, " + real }));
  assert.ok(!isEnvironmentFailure({ checkOutput: "TypeError: cannot read property 'x' of undefined" }),
    "an ordinary failure must never be misclassified as an environment failure");
  assert.ok(!isEnvironmentFailure(null));
});

await t("ENVIRONMENT #3: a move failure carrying the roots-refusal text skips brain/frontier/escalation entirely and is tagged stage:environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crucible-env-lessons-"));
  try {
    const lessons = createLessonStore({ dir });
    const events = [];
    let chatCalls = 0;
    // Realistic incident shape: the MODEL behaves perfectly (a well-formed, atomic file-block
    // reply) - the failure is that the actual filesystem write is refused by the node, because
    // the workspace sits outside its HANDS_ROOTS. Nothing about this is a coding mistake.
    const engine = createIdeEngine({
      jobs: { emit: (_id, ev) => events.push(ev) },
      chat: async () => { chatCalls++; return { ok: true, content: "```path=server.mjs\nconsole.log('hi');\n```", costUsd: 0.001 }; },
      hands: async (tool, args) => {
        if (tool === "fs_read" && String((args && args.path) || "").endsWith("package.json")) return { ok: true, content: "{}" };
        if (tool === "fs_read") return { ok: false };   // a new file: nothing to read yet
        if (tool === "shell_run" && /rev-parse/.test((args && args.command) || "")) return { ok: true, code: 0, stdout: "true" };
        if (tool === "shell_run") return { ok: true, code: 0, stdout: "" };
        // hands.mjs's OWN refuse() shape for a path outside HANDS_ROOTS: { ok:false, refused:true, reason }.
        if (tool === "fs_write") return { ok: false, refused: true, reason: "outside this node's allowed roots (/work, /models)" };
        return { ok: true };
      },
      router: () => ({ taskClass: "build_code", model: "openai/gpt-5.6-sol", why: "test" }),
      lessons,
      advisors: { brainModel: "gx10/gpt-oss-120b", frontierModel: "anthropic/claude-sonnet-5", minBrainConfidence: 0,
        frontierCallsLeft: () => 3, noteFrontierCall: () => {} },
      escalate: () => "anthropic/claude-opus-4-8",
    });

    const result = await engine.runMove({ id: "ide_env_test" }, {
      move: { id: "m1", title: "Write the app entrypoint", why: "test", files: ["server.mjs"] },
      workspace: { root: "/work/some-project", name: "Env Test" },
      assignments: {}, goal: "Write server.mjs.",
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "environment", "an environment failure must be tagged so the caller can stop the build, not ask a human to retry");
    assert.equal(chatCalls, 1, "no model call of any kind beyond the one legitimate coding attempt may fire for an environment failure - that IS the $1 the incident wasted on brain/frontier/escalation");
    assert.ok(events.some((e) => e.type === "run" && e.command === "environment" && e.ok === false),
      "exactly one clear status line must be emitted");
    assert.equal(events.filter((e) => e.command === "brain" || e.command === "frontier" || e.command === "escalation").length, 0,
      "no counsel-ladder events of any kind may appear for this failure class");
    assert.equal(lessons.stats().active, 0, "an environment failure teaches nothing about code, so it must never become a lesson");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await t("WORKSPACE VALIDATION #1: POST /ide/workspace rejects a root outside every connected node's roots with 400, naming the allowed roots", () => {
  assert.match(SRC, /NODE-ROOTS VALIDATION \(production incident 2026-09-03/);
  assert.match(SRC, /const info = handsHub\.nodeInfo\(\);/);
  assert.match(SRC, /const candidates = T\.isOwner \? Object\.keys\(info\) : \(info\[uidKey\] \? \[uidKey\] : \[\]\);/);
  assert.match(SRC, /const fits = candidates\.filter\(\(n\) => rootWithinAny\(wantRoot, \(info\[n\] \|\| \{\}\)\.roots\)\);/);
  assert.match(SRC, /if \(!fits\.length\) \{[\s\S]{0,400}status: 400, body: \{[\s\S]{0,200}code: "root_outside_node_roots",/);
  assert.match(SRC, /Pick a folder under one of these allowed roots instead: " \+ allowed,/);
  // Skipped for the workshop lane, which has no real HANDS_ROOTS concept (its own root IS its
  // only "node" root by construction) - the check must not misfire there.
  assert.match(SRC, /if \(wantRoot && buildLane\(T, null\) !== "workshop"\) \{/);
});

await t("REGRESSION (rig-caught 2026-09-03): rootWithinAny normalizes EVERY separator, not only a trailing one, so a forward-slash workspace root still matches a backslash node root", () => {
  // Caught live: POST /ide/workspace with root "F:/a/b" (this app's own forward-slash
  // convention) was rejected as unreachable against a node root reported as "F:\a" (HANDS_ROOTS'
  // typical Windows form), purely because internal separator CHARACTERS differed — trimming only
  // a trailing slash before the comparison left every interior backslash mismatched against every
  // interior forward slash. Fixed by normalizing the whole string, not just its edge.
  const rootWithinAnyBody = SRC.slice(SRC.indexOf("function rootWithinAny("), SRC.indexOf("function rootWithinAny(") + 700);
  assert.ok(rootWithinAnyBody.includes('.replace(/\\\\/g, "/")'),
    "rootWithinAny's norm() must replace every backslash, not merely strip a trailing separator");
  assert.ok(!rootWithinAnyBody.includes('t.startsWith(n + "\\\\")'),
    "the old boundary check that only ever matched a literal trailing backslash must be gone");
});

await t("WORKSPACE VALIDATION #1: the resolved node is recorded on workspace.node, preferring several fits toward the account's usual default", () => {
  assert.match(SRC, /chosenNode = fits\.includes\(HANDS_DEFAULT_NODE\) \? HANDS_DEFAULT_NODE : fits\[0\];/);
  assert.match(SRC, /createWorkspace\(T, chosenNode \? \{ \.\.\.body, node: chosenNode \} : body\)/);
  // create() in ide.mjs already threads body.node through to storeFor(T).create({..., node, ...}),
  // so setting it here is what actually reaches the durable workspace record.
  const ideSrc = readFileSync(new URL("./ide.mjs", import.meta.url), "utf8");
  assert.match(ideSrc, /node: body && body\.node,/);
});

await t("BUILD-START RE-CHECK #2: a root outside the build node's roots pauses immediately, before the planner is ever called", () => {
  assert.match(SRC, /BUILD-START ROOTS RE-CHECK \(required behavior #2\)/);
  // The probe happens BEFORE cutBuildBranch()/the planner - the two must appear in this order in
  // the source so "no model was called; nothing was spent" is actually true, not just claimed.
  const probeAt = SRC.indexOf('const probe = await handsFor("node_info", { path: workspace.root });');
  const gateAt = SRC.indexOf("const forcedRootMismatch = ", probeAt);
  const branchAt = SRC.indexOf("await cutBuildBranch();", gateAt);
  assert.ok(probeAt > 0 && gateAt > probeAt && branchAt > gateAt,
    "the roots gate must sit strictly between the node probe and the first spend-capable step (cutBuildBranch/planning)");
  assert.match(SRC, /!rootWithinAny\(workspace\.root, probe\.roots\)/);
  assert.match(SRC, /return pauseForEnvironment\(\s*\n\s*"workspace outside node roots",/);
});

await t("BUILD-START RE-CHECK #2: pauseForEnvironment emits a non-terminal 'paused' marker followed by a real terminal checkpoint", () => {
  // paused must stay NON-terminal here (idejobs.mjs's EVENT_TYPES has it outside TERMINAL): the
  // restart-resume machinery (required behavior #6) reuses the exact same event type and depends
  // on it never sealing the job on its own.
  assert.match(SRC, /const pauseForEnvironment = \(reason, message, remaining\) => \{\s*\n\s*ideJobs\.emit\(job\.id, \{ type: "paused", reason \}\);\s*\n\s*return ideJobs\.finish\(job\.id, \{\s*\n\s*type: "checkpoint", complete: false, paused: true,/);
});

await t("TEST HOOK for the rig: IDE_TEST_FORCE_ROOT_MISMATCH proves the paused/zero-spend outcome without a real misconfigured node", () => {
  assert.match(SRC, /IDE_TEST_FORCE_ROOT_MISMATCH/);
  assert.match(SRC, /const forcedRootMismatch = \/\^\(\?:1\|true\|yes\)\$\/i\.test\(String\(process\.env\.IDE_TEST_FORCE_ROOT_MISMATCH \|\| ""\)\.trim\(\)\);/);
});

await t("ENVIRONMENT #3: the main build queue halts the whole build (not just the one move) the instant an environment failure is tagged", () => {
  assert.match(SRC, /if \(res && res\.stage === "environment"\) \{\s*\n\s*return pauseForEnvironment\(/);
  // This check must come BEFORE the normal ask/auto-retry fork, or an environment failure would
  // still burn an ask()/moveFailAuto() cycle before this ever fires.
  const stageCheckAt = SRC.indexOf('if (res && res.stage === "environment") {');
  const askForkAt = SRC.indexOf('const answer = await ask("move-" + move.id,', stageCheckAt);
  assert.ok(stageCheckAt > 0 && askForkAt > stageCheckAt, "the environment halt must precede the normal failed-move ask/retry fork");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
