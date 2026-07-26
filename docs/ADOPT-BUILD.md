# Adopt Existing Project — build pack (FITS)

SOW: docs/ADOPT-EXISTING-SOW.md (c493b63). This pack is the working record for the build.

**SHIPPED 2026-07-26: commit cbc4d44 (13 files), pushed; production rolled to build
1785075831174 within ~2.5 min (push-linked service; origin tip verified cbc4d44 by ls-remote).
Full suite 67/67. Rollback: `git revert cbc4d44` and push.**

**Mission line:** A person with a half-finished app points the Crucible at its folder and gets an
honest state-of-the-app brief, then plans and finishes it through the machinery that already
exists, from the Vibe Coder and Engineer surfaces only.

## Blast radius call

- HIGH: POST /ide/adopt + the scan module (guest-reachable on the live container; reads user
  filesystems through the tenant hands wall; ships product prose). Full discipline here.
- MEDIUM: Vibe/Engineer UI wiring (customer-facing, reversible, no money moves).
- The build rides existing machinery unchanged, so the build path itself adds no new risk.

## Locked design decisions

1. **The scan is deterministic. No model call in v1.** The brief is composed from observed facts
   (manifests, entry points, TODO/stub counts, runnability via the existing runPlanFor rules).
   Reasons: a model cannot invent progress it never saw (honest-numbers doctrine); no file
   content leaves the user's machine at scan time (privacy); the scan costs the user nothing;
   fully unit-testable. A model-phrased brief stays a future option (ledger L-2).
2. **The brief prose is hard-capped at 3600 chars** so it rides the existing planchat/intake
   sanitizer (4000-char clamp) untouched. Structured facts travel beside the prose.
3. **Tenant wall is inherited, not reinvented:** ideHandsFor(T) binds guests to user:<uid> nodes;
   the node's own withinRoots + carve-outs refuse protected paths; validateRoot already refused
   them at workspace creation. Three layers, none new.
4. **Gates on /ide/adopt:** ide wall + invite required (multi-tenant non-owners) + heavy-tier
   rate limit (added to IDE_RL_HEAVY: it drives ~50 hands calls per scan) + mode must be vibe or
   engineer — beginner is refused server-side, matching the placement ruling.
5. **Scan ceilings (REVISED by Fred's ruling 2026-07-26: "never limit an app build").** The first
   numbers (28 dirs / 800 files) were sized like sanitizer limits and this very repo tripped
   them, which the ruling forbids: a legitimate app scans COMPLETELY. Ceilings are now disaster
   protection only, sized so no honest app meets them: depth 8, 500 directories, 12000 files,
   24KB per read, 1.2MB total reads, 24 source samples; junk dirs skipped as before. The walk
   runs six fs_list calls in parallel (hands correlation ids; reads only) so big apps scan in
   seconds. Only a drive-root-scale pick ever sees the "Scan limits" line, still honestly marked.
6. **Seeded planning:** the brief lands in the Vibe Main plan window as the Main AI's opening
   turn (from:"main") and in the Engineer intake chat as the assistant's opening turn; both
   surfaces then send adopt:true so intakeSystem/planchatMessages append the adopt voice: plan
   what EXISTS toward what it should BECOME, mark vision bullets [finish]/[fix]/[new], never
   claim something exists unless the brief says so.
7. **Build prompt composition:** goal + ADOPTED APP BRIEF + AGREED VISION; the engine, snapshots,
   metering, budgets all unchanged.
8. **Placement:** Vibe = prominent Adopt an App square beside New (the reserved TBD slot stays
   reserved — Fred has not assigned it). Engineer = Adopt existing app control in the Workspace
   drawer (classic page is engineer-only by construction). Beginner surface: nothing, anywhere.
9. **Cache-bust trio:** sw v114 -> v115-adopt; dominion-vibe.js v2->v3; dominion-vibe.css v3->v4;
   dominion-ide.js v28->v29; idehelp guide updated same commit (Furnace doctrine).

## Wargame (the moves most likely to fail)

| # | Failure | Defense | Check |
|---|---------|---------|-------|
| W1 | Scan escapes the workspace root or crosses tenants | paths composed only from fs_list names under root; node withinRoots refuses outside-roots; guests dispatch only to user:<uid> | unit test + code path verified |
| W2 | Huge/hostile tree stalls the server or floods hands | hard caps on depth/dirs/files/bytes/reads, sequential walk, first-throw aborts | unit tests hit every cap |
| W3 | Brief lies about progress | deterministic composer states only observed facts; unknowns stated as unknowns; "read, not run" line included | unit test asserts honesty lines |
| W4 | Beginner reaches the feature | server refuses mode=beginner; no beginner UI control exists | endpoint test + UI inspection |
| W5 | Brief truncated by sanitizer mid-flow | 3600-char cap with honest truncation note | unit test |
| W6 | Node offline mid-scan | first hands throw -> {offline:true} 200 body, same contract as /ide/workspace/auto | endpoint test via devboot (no node) |
| W7 | Stale client cache serves old UI | trio bump in the same commit | grep before ship |

## Ledger

- L-1 OPEN (medium): Engineer placement is the Workspace-drawer control for now; the full
  Engineer rebuild may want it elsewhere. Fred decides at the rebuild.
- L-2 OPEN (low): model-phrased brief (metered via ideChatOnce) deliberately not built in v1.
- L-3 OPEN (low): "broken" detection is static-only (stub/TODO/dep signals); the scan never
  executes anything, and the brief says so.
- L-4 OPEN (low): first real adoption on a live guest machine unwatched; unit + endpoint proof
  only until Fred's phone pass.
- L-5 CLOSED 2026-07-26: RAILWAY_ACCOUNT_TOKEN works; projects moved under the workspace scope.
  The working query is `me { workspaces { projects { edges { node ... } } } }` (personal
  workspaces carry projects directly, no team). RAILWAY_API_TOKEN is not dead: it is
  PROJECT-scoped to valiant-generosity (TruAgent) and uses the Project-Access-Token header, so
  Bearer "Not Authorized" is its normal answer. Used live to confirm IDE_MODE=all on dominion.

## Lessons learned (fed back into FITS, wargame template patched 2026-07-26)

1. A dependency fails in more than one SHAPE: the guest hands hub THROWS on no-machine while the
   owner hub RETURNS ok:false saying so. The offline flag was wrong live until the real shape was
   probed on devboot. Handle the shapes you have SEEN, then probe for the ones you have not.
2. Honesty logic tested only against fakes lies politely. The real-tree probe (this repo)
   caught three false claims in minutes: underscore-style test suites unrecognized ("no tests"
   over 67 suites), zero-dep manifests told "dependencies not installed", machinery dirs
   cluttering the layout line. One real messy target belongs in every truth-teller's test diet.
3. The furnace roll-call caught a guide phrase split across joined lines ("Adopt existing\n
   app") — the keep-up rule has teeth precisely because it checks the JOINED text.

## Success (ship line = grade 4)

- Scan module unit-tested against every cap and the honesty rules; full repo suite green.
- /ide/adopt refuses beginner, 404s unknown workspaces, reports offline honestly, rate-limits
  as heavy, and never writes anything anywhere.
- Vibe: Adopt an App beside New, wired to Save to:, folder browse for a new pointer, brief lands
  in Main, vision marks finish/fix/build-new, Begin Building carries brief + vision.
- Engineer: Workspace-drawer control seeds the intake chat the same way.
- Furnace: guide mentions the feature in the same commit; roll-call passes.
- Deployed via commit+push; /api/version confirms; rollback = git revert of the one commit.
