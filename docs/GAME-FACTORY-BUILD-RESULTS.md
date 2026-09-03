# Game Factory build: results ledger (2026-09-03)

Companion to GAME-FACTORY-BUILD.md (the design). Kinds of proof: UNIT (mocked, in run-tests.mjs), RIG (the
exact production code booted locally with production keys, the owner's real Google Drive connection, and a
verified human-owner identity), PROD (measured against app.dominion.tools after deploy).

## What shipped

- `gamefactorykit/` (kit runtime, ports, templates, PNG encoder, assembler, 12-suite QA harness, reference
  game Vector Vault) and `gamefactoryqa.mjs` (server QA runner: permission-sandboxed child process).
- `gamefactoryforge.mjs`: the server forge, a second worker on the durable task queue for product_planning,
  visual_design and gameplay_engineering, with model ladders, a local QA validation loop and honest failure.
- `gamefactorysupervisor.mjs`: the stage supervisor applying the section-3 rules table through the store's
  own commands with deterministic idempotency keys; autopilot sidecar; Run to playtest.
- `gamefactorybuilds.mjs`: server-side view of build bundles (exists / resolveFile / summary).
- `gamefactoryhttp.mjs` + owner surface: Run to playtest, server-served play route with CSP, Build and QA
  cards, five health cards, autopilot badge (Codex design pass D8 on top).
- `server.mjs` wiring behind GAME_FACTORY_SUPERVISOR=1 / GAME_FACTORY_FORGE=1; /api/version reports
  factorySupervisor and factoryForge; ops/prod-verify.mjs asserts both.

## Proof so far

- UNIT: full suite on the integrated branch 187 suites passed, 0 failed (Windows, GAME_FACTORY_TEST_ROOT on F:).
- UNIT: the reference game passes all 12 suites through the real `node --permission` child runner in about
  200 ms wall time; five tampering tests flip the right suite; runner timeouts and crashes report honestly.
- RIG: Run to playtest as a verified human owner: IDEA -> SPECIFICATION with 11 artifacts, every one
  VERIFIED on the owner's real Google Drive; SPECIFICATION and VISUAL_SYSTEM approvals recorded with the
  Run-to-playtest rationale; design (gx10/qwen3-coder-30b, free), assets (gpt-image-2 icon and splash,
  kit-drawn 192 icon, provenance recorded), then the implement task.
- RIG: the first implement attempt failed honestly (see fixes 3 to 5 below); the owner's Retry re-queued
  work on the same build; DeepSeek v4 pro produced a passing game in three rounds (truncated answer,
  QA-failed round with 4 suites, then pass). Build 0.1.1: INTEGRATION verified, 11 of 12 suites (the
  bundle still carried the pre-fix harness), supervisor routed the failure into repair build 0.1.2 which
  passed 12 of 12 and reached PLAYTEST_READY at 21:28Z with a playable bundle served under CSP.
- RIG: iteration: Request changes with a plain-language note ("make level 1 a pure tutorial ... rename
  the Launch control to LAUNCH PULSE") -> REVISION -> revise build 0.1.3 -> 12 of 12 -> PLAYTEST_READY
  at 21:34Z (five minutes end to end), new bundle served, old build's approvals invalidated.
- RIG: the kit runtime boots the generated bundle through a fake DOM (controls drawn, input dispatched).

- PROD: main 1e76a89 deployed 2026-09-03 21:43Z (Railway 4c7b2848); the app serves 1e76a89;
  `ops/prod-verify.mjs` ALL 8 CHECKS PASSED, including "game-factory supervisor and forge running".
  Railway flags staged before the deploy: GAME_FACTORY_SUPERVISOR=1, GAME_FACTORY_FORGE=1,
  GAME_FACTORY_QA_RUNNER=server, GAME_FACTORY_LEVELS=12, GAME_FACTORY_MAX_REPAIRS=3. Rollback: tag
  prod-2026-09-03-before-gamefactory (d366e37) and /data/backups/pre-gamefactory-build-2026-09-03.tgz.
  The first production game run needs the owner's own tap (Run to playtest), because the factory
  refuses every non-human identity by design.

## Fixes found by integration (not by the lanes)

1. Supervisor stall after a non-retryable forge failure and an owner Retry: the build existed, its only
   gameplay task was FAILED, nothing was queued. Now re-queues gameplay work on the same build (test 20).
2. Owner uid: the factory keys projects by tenancy `userIdFor(OWNER_EMAIL)` (16-hex digest), not the literal
   "owner" that OWNER_T carries; the supervisor iterated zero projects until wired with the right uid.
3. QA controls suite hardcoded the reference game's action names, so every generated game failed the key
   test; it now recognizes the game's own `meta.actions` plus the reserved types.
4. The forge discarded every round's output; it now keeps files and verdicts under
   `forge/<slug>/attempts/<taskId>/round-N/`, names causes in the final error, and teaches the model the
   exact harness rules. A repair queued with no prior source is implemented from the design.
5. The kit's `assembleBundle` is async and the forge did not await it (its unit test used a synchronous
   fake), so a completed task carried no bundle fingerprint and the supervisor stalled at IMPLEMENTATION.
   Fixed on both call sites; the fake is async now; the supervisor also reads the fingerprint from the
   bundle's build.json as a second source.
6. QA analytics rule flagged gameplay props like `vaultId` as identifiers; it now flags personal
   identifiers (email, name, phone, address, opaque id strings) only. Store-readiness accepts an icon
   larger than the slot (the Foundry returns 1024x1024 for the 512 slot).
7. Build card read build.json beside the bundle; the kit writes it inside the bundle.
8. The kit runtime (browser shim) had never executed anywhere: it read `state.status` and `level.name`
   (the contract exposes `rules.status(state)` and `level.title`, so the status line read "undefined"),
   drew no controls at all (neither the reference nor the generated render.js draws them, so every
   button was an invisible tap target), and dispatched only pointer-down. It now draws every control
   with a label from the palette, reads status through the contract, dispatches move/up, and survives a
   render error. A fake-DOM boot smoke (`gamefactorykit_runtime_test.mjs`) boots the reference game and
   a real generated bundle through it.

## Deviations, said plainly

- Web-canvas lane instead of the Godot candidate the templates name (D1). Godot capability untouched.
- QA runs on the server runner (`target: "server-qa"`), not the GX10 broker lane (D2); the GX10 QA rung is a
  follow-up (TODO(fred) in the spec).
- icon-192 and the splash fallback are kit-drawn (no bitmap resize primitive); provenance says so.
- Playtest approval is never automatic; Run to playtest pre-approves only the two planning gates.
