# Crucible stabilization, 2026-09-03 (lane crucible)

Scope: DEFICIENCIES.md items 10, 12, 13 (Dominion AI stabilization program, LANE-crucible.md).
Owner's overriding objective for this pass: "nothing may fail to produce a viable result" - every
failure path this lane touched now retries, escalates, or degrades to a viable result instead of
handing back a raw error or an "unaudited"/"not complete" label with nothing tried first.

## What was actually broken

Production journals (33 builds since 07-24): the last "Build complete" was 07-24. Since then, 13
builds were stopped by the user, 13 errored (11 of those the same `mv is not defined`
ReferenceError, one a 316-minute server-restart casualty), and 3 checkpoints landed "not complete"
with nothing attempted to fix what was missing. The counsel loop (a GX10 "brain" model diagnosing
failures, a Sonnet "frontier" reviewer, and a shared lessons store) had never once fired in
production, because the failure modes that actually happened - a missing planned file, a prose
plan, an unreadable audit - were never classified as failures in the first place.

## What changed, and why

1. **Missing planned file -> real repair, not a write-off.** A step that finished without
   producing a file it declared used to become a checkpoint bullet with nothing tried. Now: a
   re-ask with an explicit "return the complete contents" instruction, then up to two dedicated
   "write this file" moves carrying the build goal and the original step's own reasoning. Every
   attempt runs through `engine.runMove`, which is where the brain/frontier counsel ladder already
   lives - so a repair that itself fails is diagnosed and lessoned like any other failed move.
   Only after all three attempts still leave the file uncovered does the checkpoint name what was
   tried. `IDE_TEST_OMIT_FILE=<path>` reproduces the bug on demand (see below) for rig proof.

2. **Plan format never fails the build.** Up to three planning attempts, escalating to a stronger
   keyed model each time the strict move-list contract is violated (prose, an unparsable
   fragment). Every failed attempt gets a real brain diagnosis and can leave a lesson - previously
   this only happened once, after the SECOND failure, right before the build died. If all three
   attempts still produce nothing usable, the build falls back to a single self-planned move built
   straight from the raw prompt (the same honest degrade a trivial ask already uses) instead of
   ending on a format problem the counsel could not fix.

3. **"Unaudited" is not an acceptable end state.** A furnace audit reply with zero readable
   OK/GAP lines now gets one retry on the next counsel model. If that also comes back unreadable,
   the audit falls back to concrete checks that need no model at all: the discovered project
   checks (`engine.verify`, i.e. package.json scripts) plus a deterministic `node --check` syntax
   pass on every written `.js`/`.mjs` file. That combined result becomes the audit's answer,
   honestly labeled as a fallback rather than silently presented as a normal audit.

4. **Counsel triggers.** Required behavior #4 is mostly a consequence of 1-3: routing the missing-
   file repair and every planner retry through the same brain/frontier ladder `engine.runMove`
   already implements is what makes these failure modes classified failures the counsel actually
   sees, instead of dead ends nobody diagnosed.

5. **Never park on need_input; heartbeat while a model call is in flight.** A failed move already
   carried an unconditional auto-continue policy (retry, then skip, never stop and never wait
   forever); it now allows 3 auto-retries before auto-skipping, matching the "up to 3 attempts"
   language used everywhere else in this stabilization. A new `status` event fires every 30
   seconds for as long as any model call (bare or wrapped, including the dead-seat reroute call)
   is in flight, through one shared `withLiveness` wrapper, so the job stream shows life instead
   of going quiet for minutes at a time.

6. **No build is lost to a deploy.** `idejobs.mjs` gained a `resume()` hook: at boot, a job whose
   journal has no terminal event is now handed to `resume()` (with its original request, its full
   last plan, a ledger of what already finished, and whichever move was still "running" when the
   journal went cold) instead of being unconditionally sealed as "interrupted". `server.mjs` wires
   a real implementation (`resumeIdeBuild`): it probes the build machine first, and if it is
   offline, reports `paused` (idejobs retries automatically, every 30s by default, up to a
   generous attempt cap) rather than sealing anything. If it is reachable, `runIdeBuild` relaunches
   against the SAME job id, reuses the original plan verbatim (no re-planning spend), and skips
   every move the ledger already shows done - so the move that was actually in flight runs again
   naturally, without needing to be special-cased.
   Scope, said out loud: this drives the standard-crew (single move-list) pipeline. The AF-crew
   and task-graph relays do not yet carry enough journal state to resume mid-relay; a restart
   during one of those still seals honestly as interrupted. `TODO(fred):` extend the journal/resume
   contract to those pipelines once the standard-crew path has proven itself in production.

7. **Move-level timeouts.** A model call that produces no complete answer within 180 seconds is
   treated as a stall and turned into a transport-shaped failure ("no answer"), which the
   pre-existing dead-seat reroute logic already knows how to retry on another keyed model - no new
   reroute mechanism was needed, only feeding it the right failure shape. A whole move that burns
   its full 20-minute budget and still fails is re-planned into two smaller moves, once per move
   id, instead of being asked about (and possibly auto-retried) as one oversized unit again.
   Deviation said out loud: true byte-level "no bytes for 180s" stream-idle detection would need a
   hook inside `cloudChatStream`, which belongs to lane/chat, not this lane. The nearest honest
   equivalent observable from this layer - no COMPLETE answer within 180s - is what is implemented.

8. **The `mv is not defined` regression is pinned.** The 08-01 crash (11 of 13 production build
   errors since) was a free `mv` reference in the task-graph budget estimate; the fix (already on
   `main` before this lane) uses `filesPerTask`, derived from `tasks`, which is actually in scope.
   `crucible_stabilize_test.mjs` asserts the fixed line is present and that no free-standing
   `mv && mv.files` reference exists anywhere in real code (only inside the doc comment that
   explains the historical bug, which quotes it verbatim on purpose).

## Files touched

- `idejobs.mjs` - `status`/`paused` event types, `recordRequest`, the whole `resume()`/
  `attemptResume` machinery, `lastPlanEvent`/`lastInFlightMove` helpers.
- `server.mjs` - the counsel wiring block (`resumeIdeBuild`, the `ideJobs` construction), and the
  build runner (`runIdeBuild`): the missing-file repair loop, the planner retry/escalation loop,
  the furnace audit fallback, `withLiveness` (status heartbeat + 180s stall), the 20-minute move
  re-plan, `moveFailAuto`'s 3-attempt cap, and the resume-plan/resume-ledger wiring.
- `idejobs_test.mjs`, `crucible_stabilize_test.mjs` (new) - tests for all of the above.

## Env knobs added

- `IDE_TEST_OMIT_FILE=<path>` - test-only. The first time the named planned file would be marked
  covered, its coverage is silently dropped once, reproducing "a step finished without producing a
  file it declared" without needing a real model to misbehave on cue. No effect unless set.
- idejobs.mjs's `resume`/`resumeRetryMs`/`resumeMaxAttempts` are constructor options, not env vars;
  server.mjs wires sensible defaults (30s retry, generous attempt cap) and does not expose them as
  environment knobs in this pass.
