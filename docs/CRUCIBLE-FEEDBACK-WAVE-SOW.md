# Crucible Feedback Wave SOW (Fred's phone pass + Kimi K3 audit)

Status: rev B, LOCKED 2026-07-23 (Fred picked option 1): order 1 -> 3 -> 2 -> 4, GitHub lane
folded into 2.7, FULL AUTONOMOUS to the finish line (interested parties waiting on a demo).
D-1 accepted as recommended (non-git salvage = timestamped sibling folder), D-2 accepted
(placeholder throughput table, tuned from telemetry later). Sources: Fred's live phone pass
(dot nav, stuck build, AF spec miss) and the Kimi K3 partial audit (spot-verified 2026-07-23:
traversal, non-atomic registry write, fixed preview port, strict divider parser all CONFIRMED
in code).

2.7 addendum (Fred's GitHub question, locked with option 1): every Crucible build in a git
workspace runs on its own branch build/<jobid>; failed builds leave the branch as salvage;
success offers merge. A fresh workspace offers git init. With the GitHub connector linked in
Setup, the app creates the remote repo via the user's own token, sets origin, and pushes the
branch (their token, their machine, their repo). No connector: local branch flow only, push
offered with an honest pointer to Setup.

## Phase 1: Unstick and navigate (Fred's daily pain, small, ships first)

1.1 Abandon build. A visible "Start fresh" affordance whenever a prior build's conversation
    or fields are restored: wipes the draft, the restored chat, and the stuck state for that
    workspace, snapshots nothing (it is abandonment, and the journal already holds history).
    The chat input must never load disabled from a dead build.
1.2 Dot navigation becomes TAP-first. Every compass dot is a direct tap target: tap the dot,
    go to that surface (chat, dial, images, Crucible). Swipe stays as the gesture for those
    who like it, but taps are the reliable path. Dots get bigger touch areas (44px min) and
    a label on press. No more swipe roulette on Fred's own app.

## Phase 2: AF Full Custom (the spec miss; HIGH: money + engine surgery, FITS)

2.1 Per-SECTION crew. After the divider proposes parts, each part renders as a row the user
    owns: model dropdown (FULL catalog, every non-beginner user), agent-count stepper, and a
    live counter beside it: estimated time and tokens, recomputed as picks change. The math
    is honest approximation (part size estimate x model throughput/context), labelled as such.
2.2 Any model allowed. No blocking, ever, except the orchestrator/divider slot, which is
    limited to models above the tiny tier. An inadequate pick gets RED warning text naming
    the exact expected failure ("context window smaller than this part; expect truncation")
    and the words that it is theirs to experiment with.
2.3 Orchestrator chunks per context window. The divider is told each part's assigned model
    and its context size, and must cut parts so no part exceeds its model's window; the
    referee still enforces no-two-agents-same-file (the cookie rule already in code).
2.4 Unicorn sections must not crash. Tolerant divider parsing (case-insensitive, markdown
    emphasis stripped: Kimi #4), one corrective re-ask on garbled plans, and the honest
    af_refused path when division genuinely fails: never a silent zero-part dead build.
2.5 Nothing fails silently. Crash, hang, stall, or quiet stop pops a communication with the
    WHY (reuse the long-run stall-clock pattern at part level + the ask/notification spine).
2.6 Hot swap. The failure popup offers swapping that section's model and resuming from the
    last good state.
2.7 Salvage to a worktree. Real completed work from a failed AF build lands on a branch or
    sibling snapshot, never in the workspace main line. (Git workspaces: branch; non-git:
    timestamped sibling folder. DECISION D-1 below.)

## Phase 2A: The Plan Pipeline (Fred's interjection, locked 2026-07-23)

Chat is where plans are born; the Crucible is where they become apps. The bridge:

2A.1 Plan artifacts. A plan built in the main chat (roadmap, phases, task list, MVP
     definition) saves as a versioned artifact tagged "plan". Artifacts already give the
     rest free: revisit, copy, download, history preserved for undo, delete when done.
2A.2 The offer. When a conversation contains a fully built plan, the AI ASKS whether to save
     it (feature map + system prompt teach the shape; create_artifact does the saving). Never
     auto-saves, never nags twice about the same plan.
2A.3 Reload to edit. A saved plan can be pulled back into the chat for revision; each save is
     a new version on the same artifact, so any addition or subtraction can be undone.
2A.4 Send to Crucible. A button on plan artifacts (and on a freshly saved plan in chat) sends
     it to the Crucible, which opens with the plan loaded into the dedicated PLAN field. The
     same field accepts paste for people who carry plans in by hand.
2A.5 Project initiator. A plan arriving in the Crucible starts a new project: named from the
     plan title, renameable, workspace created the normal way. From there the user discusses
     it further in the Crucible or starts the build, which follows the normal procedure.
2A.6 Feeds Full Custom. In Phase 2 the divider receives the plan's phases/tasks as its
     starting structure instead of inventing one, so a planned build divides the way the plan
     says. An unplanned build still divides as today.

## Phase 3: Kimi hardening wave 1 (verified defects, mechanical, LOW-MED)

3.1 Preview traversal: require fp === root or startsWith(root + sep). (CONFIRMED)
32. Atomic registry writes: tmp + rename. (CONFIRMED)
3.3 Per-build preview port + canary token verified by waitUp; adaptive wait beyond 7s.
3.4 Nested-fence truncation in parseFileBlocks (column-zero closing fence rule).
3.5 Boot assertion: every model id referenced in iderouter/presets exists in the catalog.
3.6 Repair loop: zero-file or garbled model output gets ONE automatic corrective reprompt
    before surfacing, and every surfaced error carries a next action.
3.7 "Build it" detection verified by hand for loose phrasings ("ok go ahead").

## Phase 4: Kimi ops wave (deploy/runtime hygiene)

4.1 Rolling-deploy phantom kills: instance-id heartbeat in the job journal so a live job is
    never sealed by the NEW container while the old one still drives it.
4.2 Test gate: the deploy build runs the suite; red blocks.
4.3 VAPID subject env-required before guests; journal archive instead of unlink at GC;
    per-uid job accounting before guests arrive.
4.4 isSmallAsk tightening (immediate path only when one file); intake soft cap (8 turns then
    best-vision + correct-me).
4.5 Per-build dollar ceiling chosen by the user at start, freezing to need_input when hit
    (the long-run tranche fuse pattern applied to Crucible builds).

## Build status (2026-07-23, full autonomous run)

- Phase 1 SHIPPED (v99-fresh-fan): Start Fresh + compass navigation fan.
- Phase 3 SHIPPED (v100-hardening): all verified Kimi defects + the sponsored-cap money bug.
- Phase 2 backend SHIPPED (fdf8d05): idetelemetry + AF Full Custom rules.
- Phase 2 SHIPPED (v101-af-custom): divide-preview + per-section model/agents + live estimates +
  warnings + branch salvage + git lane.
- Phase 2A SHIPPED (v102-plan-pipe): save_plan + Crucible "Start from a plan" drawer.
- Phase 4 IN PROGRESS: rolling-deploy grace (idejobs), journal archive, intake soft cap, VAPID
  guest guard, `npm test` gate (run-tests.mjs).

## Decisions needed (Fred)

- D-1 (2.7): salvage form for non-git workspaces: timestamped sibling folder OK?
- D-2 (2.1): time estimates need a throughput table per model tier (tokens/sec guesses).
  Placeholder numbers to start, tuned from real build telemetry later. OK?
- D-3: phase order. Recommended 1 → 3 → 2 → 4 (unstick Fred today, kill verified bugs, then
  the big AF rebuild on a hardened base, then ops).
