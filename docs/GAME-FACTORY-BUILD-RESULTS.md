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

## First production run (2026-09-04 01:16Z to 01:35Z) and the iteration it forced

Fred approved Vector Vault's Specification and Visual System by hand at 01:16Z. The supervisor moved
the game through Architecture (design on the free GX10 model), Asset Generation (icon and splash)
and into Implementation in four minutes. The implement task then failed after six rounds and the
game landed in FAILED with an honest blocker. What the rounds showed, measured in the container:

- Round 1, deepseek/deepseek-v4-pro: `Insufficient Balance` (HTTP 402). The DeepSeek account has
  no credit; the same 402 demotes the video director and the Simplify quick route hourly.
- Round 2, anthropic/claude-sonnet-5: `Anthropic timed out.` after nine minutes with no content.
- Rounds 3 to 6, openai/gpt-5.6-terra: four files each time, then every QA suite reported
  `the harness did not report this suite (exited 1 without writing a results file)`.

9. **The QA runner could not run on Linux.** `gamefactoryqa.mjs` built its permission globs as
   `--allow-fs-read=<bundleDir>\*`, measured only on Windows (rule 8.4 broken by me). Linux reads
   the backslash as part of the path, so the child could not read its own entry script. Proven in
   the production container with a two-line probe: `\*` exits 1 and writes nothing, `/*` exits 0.
   The runner now uses `path.join(dir, "*")`; `gamefactoryqa_test.mjs` asserts the spawn line.
10. **The owner could not tell working from dead.** The forge heartbeated the store only between
   model rounds, so a nine-minute round showed a nine-minute-old heartbeat and no words. The forge
   now pulses the store on a timer every 30 s while a task runs (independent of the model call) and
   publishes a plain-language phase (`asking <model> to write the game (round 2 of 4)`, `running the
   9 local QA suites`) through its health. The API stamps `serverNow` on bootstrap and detail. The
   owner surface shows a live activity strip (working / waiting / stalled, with started, heartbeat
   and lease clocks ticking on the server clock), stamps the lifecycle rail with the time each
   stage was reached, and the planning-gate banner now points at the Artifacts tab.

11. **The GX10 was fenced to 32k by a wrong note, and never asked to write code.** Fred: "I have a
   consumer supercomputer made for this; a 32k window is not reasonable." Measured on the box on
   2026-09-04: gpt-oss:120b at 131k (65 GB) and qwen3-coder:30b at 131k (39 GB) fit together with
   11 GB spare; the 2026-09-03 "evicts the coder" note behind commit dce6841 was false. Speeds:
   120B 43 tok/s, 30B 59 tok/s, the mini-PC's 8B 11.5 tok/s. Fixes: `OLLAMA_CONTEXT_LENGTH` on the
   GX10 raised to 131072 (unit file backed up), both catalog seats advertise 131072 so a request
   never triggers a ~150 s reload, and the code ladder now leads with the brain
   (`gx10/gpt-oss-120b`, then terra, Sonnet, DeepSeek). Trap recorded: a reload at a different
   num_ctx costs ~150 s per model; keep the server default equal to the catalog window.

12. **The GX10 hands node was evicted once a minute because its heartbeat never reached the app.**
   hands/5 (2026-09-03) added `POST /hands/beat` as the node's idle liveness ping, and the hub evicts a
   node with no inbound evidence for 60 s. The Cloudflare Access bypass app for the node channel
   listed only /hands/stream, /hands/result and /hands/chunk, so every beat got a 302 to the login
   page at the edge (measured from the GX10: beat 302, chunk 401). Fixed 2026-09-04 by adding
   `app.dominion.tools/hands/beat` to that Access app (snapshot under F:\Claude Sandbox\gf-rig-data\cf-snapshots).
   Rule for next time: every route a node calls must be in the bypass list, and the proof is a POST
   from the node's own machine, not from a logged-in browser.

13. **DeepSeek out, local models first (Fred, 2026-09-04: "I don't want to use DeepSeek. I want to
   make the local models work").** Design ladder: GX10 coder, GX10 brain, Sonnet. Code ladder: GX10
   brain, GX10 coder, terra, Sonnet. The chat failover targets for the two GX10 seats no longer
   point at DeepSeek (brain -> Sonnet, coder -> terra). Still naming DeepSeek elsewhere, for a
   follow-up iteration: the general chat failover graph (kimi, qwen3-coder, minimax rungs), the
   Simplify quick route, the video director's first rung, the Crucible "mechanical" assignment,
   and the catalog seats themselves.
