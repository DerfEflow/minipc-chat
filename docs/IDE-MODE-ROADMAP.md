# Dominion IDE Mode: Roadmap and Task List

Written 2026-07-19. Grounded in a four-agent recon of the live codebase (UI shell, model routing,
build machinery, billing/tenancy), file:line anchors verified against the tree at commit fe7edac.
This is the SOW seed. When the build starts, it runs under Forge Mode with full FITS (HIGH blast
radius: this app is live, multi-tenant, and takes real money).

## Mission line

A toggle in the hamburger menu flips Dominion AI into IDE mode: a build surface organized for
making applications and design elements. Design work routes automatically to OpenAI models;
everything else goes to the model or models the user assigns (per task class, or one model for
everything). Lean, fast, cheap to run. A beginner can ship something in five minutes; a seasoned
engineer should call it refreshingly straightforward, intuitive, and infinitely scalable without
effort. The kind of IDE we all should have started with.

## The design thesis (the complaints this solves)

Every gripe below is a real, common complaint about existing IDEs and app builders. The design
answers each one directly, without inventing new machinery where Dominion already has it.

1. **"I drown in panels before I write a line."** IDE mode opens as ONE surface: a prompt and a
   plan. Panels (file tree, diffs, run console) appear only when the project earns them.
   Progressive disclosure is the whole UI philosophy.
2. **"Why am I picking a model per message?"** You assign models once, by task class, on an
   Assignment Board. Design work defaults to OpenAI. Mechanical work defaults to a cheap model.
   The router does the rest. An All-In-One switch collapses everything to a single model for
   people who never want to think about it.
3. **"Cloud IDEs are bloated and expensive."** Replit runs a VM per user. Dominion runs NOTHING
   per user: the hands node already on the user's own machine does all file writes, shell runs,
   and dev servers. The Railway container only orchestrates and streams. Zero per-user hosting
   cost, native disk speed, and the user owns every byte. This is the card that makes Replit look
   like a bloated dinosaur.
4. **"Beginner tools patronize me; pro tools lose my mom."** Two lenses on the same state:
   Blueprint (plain-English numbered move cards, Approve / Skip / Explain) and Workshop (file
   tree, diffs, console). One toggle. Nobody is downgraded, nobody is buried.
5. **"Small edits and big apps need different tools."** They need different plan sizes, and that
   is a router decision, never a user decision. A tweak becomes one move executed immediately. An
   app becomes a phased, numbered blueprint that runs move by move with snapshots, verification,
   and a budget envelope. Same surface, it just grows.

## What we already own (why this is a bolt-on, with anchors)

- **Reveal system.** Two full-screen slide reveals exist with a proven protocol: the Forge dial
  (slides shell LEFT, dominion-forge.js:126-267, dominion-forge.css:574-600) and Forge Images
  (slides shell RIGHT, dominion-images.js:752-771, dominion-images.css:23-48). Choreography: add
  `<x>-anim` body class, force reflow, add `<x>-open`; both transform exactly four shell
  elements (#sidebar, #commandbar, #neural-glass, #overlay) and call each other's close on open.
  The IDE joins this as the third reveal.
- **Hamburger drawer.** `#sidebar` at index.html:105-121, open/close at app.js:151-152. The IDE
  toggle is one new row here.
- **Hands node.** fs_read / fs_write / fs_append / fs_list / fs_tree / shell_run / fs_browse with
  roots, carve-outs, and self-protect enforced on-node (hands/hands.mjs:159-273). Per-user nodes
  are uid-bound with hashed tokens (hub.mjs:50-73). This IS the IDE's filesystem and terminal.
- **scaffold_project.** Writes a file tree through the node, 200 files/call, per-file issue
  collection, ASCII tree render (tools.mjs:149-171).
- **Durable jobs.** Chat turns are server-side jobs with SSE replay and reattach
  (server.mjs:2481-2497, /chat/attach). The IDE job spine reuses this pattern.
- **Cloud spine.** cloudChatStream (server.mjs:441) speaks to OpenAI, Anthropic, DeepSeek, and
  OpenRouter through one streamer; models.catalog.mjs is the allow-list and price book;
  cloudparams.mjs holds every provider quirk. images.mjs already reaches gpt-image-2 with
  metering, refunds, and batch billing.
- **Billing rails.** bumpUsage accumulate + meterTurn once (server.mjs:2836-2851, 985-996),
  estimatePreflight deterministic estimates (1474), creditBack refunds (1596-1602), usage.jsonl
  ground truth.
- **Tenancy walls.** filterToolDefs role wall + per-turn extra grants (tenantstores.mjs:42-53),
  per-user stores under /data/users/<uid>/, Cloudflare Access JWT identity (accessjwt.mjs).

## Locked design decisions (proposed; Fred confirms or overrides)

- **Menu label is "IDE Mode"** so anyone can find it; the reveal's internal title carries the
  Dominion theming. (Open question 1 covers the themed name.)
- **The IDE is a reveal, never a separate page.** Same PWA, same identity, same billing, same
  service worker. Toggle ON makes the mode available and opens it; the shell keeps a clear
  return-to-chat control.
- **User's machine does the compute.** All file writes, shell runs, and dev servers happen on the
  hands node (owner: existing nodes; guests: their per-user Forge node). The server never holds a
  workspace copy. No per-user containers, ever.
- **Routing is a table, then a tiny model, never a big model.** Deterministic keyword and
  file-extension rules classify most moves free (same philosophy as heuristicRoute,
  server.mjs:1347-1372). Only genuinely ambiguous moves get one cheap classifier call.
- **Design work goes to OpenAI**: visual assets (logos, heroes, textures) through the existing
  images.mjs gpt-image-2 path; design-and-layout code (HTML/CSS/components/UX copy) to an OpenAI
  code model. Both overridable on the Assignment Board.
- **One metered charge per move, never per model call** (the 1-credit minimum at billing.mjs:41
  makes per-call metering an overcharge). Metering runs on a finally path so aborted jobs still
  settle (closing the free-abort leak at server.mjs:2901-2906/3043).
- **Snapshots before every write batch.** Git commit when the workspace is a repo, file copies to
  the workspace snapshot dir otherwise. Standing rollback rule, no exceptions.
- **Honest refusals everywhere**, matching house style: privacy gates, vision gates, carve-outs,
  and budget stops name the reason and never silently substitute.

## Roadmap

### Phase 0: Groundwork

- 0.1 Branch + snapshot the repo state; open the FITS pack at docs/IDE-MODE-BUILD.md; carry this
  roadmap in as the SOW; record any Fred rulings from the open-questions list below.
- 0.2 Naming ruling from Fred (open question 1) so CSS prefixes and storage keys are final from
  day one. Internal namespace: `ide-` body classes, `#ide-root`, localStorage `dominion.ide.*`,
  usage mode string `ide`.
- 0.3 Feature flag `IDE_MODE` env (default ON for owner, OFF for guests) so every phase ships
  dark to guests until Phase 7 flips it.

### Phase 1: The toggle and the third reveal

- 1.1 Drawer row: add the IDE Mode toggle to #sidebar (index.html:105-121) above #sb-setup, with
  an on/off state pill. Persist to localStorage `dominion.ide.enabled.v1` AND a per-user server
  flag (additive `ideMode` column via the sanctioned ALTER TABLE pattern, tenancy.mjs:42-44),
  surfaced in GET /account (server.mjs:1006-1013).
- 1.2 Reveal root `#ide-root`, persistent-DOM lifecycle like Forge Images (kept, `display:none`
  guard, dominion-images.css:24), body classes `ide-anim` / `ide-open`, transitions on exactly
  #sidebar / #commandbar / #neural-glass / #overlay with the shared motion constants (0.45s
  cubic-bezier(0.32,0.72,0.28,1), 108vw/104vw parking).
- 1.3 Motion: the shell sinks DOWN and the IDE platform rises from BELOW (both horizontal
  directions are taken by the dial and Forge Images; a vertical platform lift reads as machinery
  and avoids fighting the existing choreography). prefers-reduced-motion kills transitions, same
  as the other reveals.
- 1.4 Mutual exclusion, symmetrical: openIde() calls window.closeForgeDial() and
  window.closeForgeImages(); export window.closeIdeMode and add the call into openDial
  (dominion-forge.js:128) and openPanel (dominion-images.js:753).
- 1.5 Escape ordering: join the capture-phase Escape stack deliberately (dial
  dominion-forge.js:254-255, askText 79-83, model panel app.js:452) so Escape closes the topmost
  layer only.
- 1.6 Ship discipline: new files (dominion-ide.css, dominion-ide.js) added to the SW SHELL list
  with ?v= queries, CACHE string bumped (sw.js:2-36), index.html tags bumped, /ide API paths
  added to the never-cache list.
- 1.7 Trigger continuity: while IDE mode is ON, the composer gains a state-lit entry (same
  pattern as #dfi-trigger injection into #bar-left, dominion-images.js:783-794) and the drawer
  row reads Engaged.

### Phase 2: Workspace and job spine (server)

- 2.1 New module `ide.mjs` exporting createIdeFeature(deps), dependency-injected exactly like
  images.mjs (deps: hands dispatch, meter, isMetered, creditBack, artifacts, dataPath, catalog,
  cloudChatStream, estimator). No new npm dependencies, house rule.
- 2.2 Workspace registry per user at dataPath('users/<uid>/ide/workspaces.json') (owner at the
  global dataPath): {id, name, root, createdAt, lastMoveAt, snapshotDir, assignments, budget}.
  Roots validated through the same withinRoots discipline the node enforces; guests limited to
  their Forge roots (forge.mjs:57-63). Extend the tenant store bundle (tenantstores.mjs:55-63).
- 2.3 Durable IDE jobs: reuse the chat-job pattern (createChatJob/jobEmit server.mjs:2481-2483,
  attach/stop endpoints) under /ide/job, /ide/job/attach, /ide/job/stop with an IDE event
  vocabulary: plan, move, file, diff, run, cost, need_input, snapshot, done, error. Client
  reattach after reload is mandatory (the /api/version watcher reloads the page after every
  deploy, app.js:1645-1656).
- 2.4 Metering: bumpUsage-shaped accumulator per model call; ONE meterTurn per completed move on
  a finally path; canChat re-check between moves (closing the 1-credit-runs-8-rounds undercharge,
  server.mjs:2549 + billing.mjs:106); usage.jsonl entries with mode:'ide' and the workspace id.
- 2.5 Gate stack copied from the OCR template (server.mjs:1615-1620): anon 401, paused/locked
  403, invite 403, credit-without-balance 402, pay-before-access front door honored. The IDE
  surface must never become a bypass around the subscribe wall (server.mjs:3449-3454).
- 2.6 MULTI_TENANT guard identical to chat: owner and single-tenant mode are never charged.

### Phase 3: The router and the Assignment Board

- 3.1 Task classes: `design_visual` (imagery: logos, heroes, icons, textures) routed into the
  existing images.mjs handlers; `design_code` (layout, CSS, components, UX copy) default OpenAI
  code model; `build_code` (logic, server, data, integrations) default = user's chosen model;
  `mechanical` (renames, config, boilerplate, lockfiles, formatting) default = cheap model
  (TENANT_DEFAULT_MODEL or UTILITY_MODEL tier); `review` (verification passes) default = the
  build_code model, overridable to a second opinion.
- 3.2 Deterministic router first: file-extension and keyword table (css/html/tsx/component paths
  and visual vocabulary to design classes; migrations/server/api to build_code; version bumps and
  renames to mechanical). Confidence rule like heuristicRoute; only ambiguous moves get one
  classifier call (owner: local qwen3:8b free; guests: one cheap cloud call). Router decisions
  logged in the job stream so users see WHY a model got picked.
- 3.3 Assignment Board UI: one card per task class showing the assigned model and live price from
  GET /api/models; an All-In-One master switch collapses every class to one model. Persist per
  workspace (2.2 assignments). Honor applyPrivacyFilter semantics: unavailable picks are shown
  disabled with the honest reason, never hidden, never substituted (app.js:38-57).
- 3.4 Server-side resolution: IDE moves call cloudChatStream directly with the assigned catalog
  id; the chat surface's hidden <select id="model"> is left completely alone. MODEL_IDS remains
  the egress allow-list; any new OpenAI id (design_code default) is added to models.catalog.mjs
  and audited with catalogaudit BEFORE trust (standing rule; the audit exists because category
  guessing caused launch-blocking errors).
- 3.5 Brand locks respected in every IDE string: raw local model names never surface
  (app.js:154-155), in-progress UI never names models mid-generation (app.js:703), display names
  come from the catalog name field.

### Phase 4: The build engine

- 4.1 Blueprint generator: one planning call returns numbered moves as JSON: {id, title, why,
  files, taskClass, estTokens, verify}. Plan size scales with the ask. QUICK path: a
  deterministic smallness check (single file, transform verb, no new dependencies) skips planning
  entirely and executes one move immediately. Beginners see plain-English cards; the JSON is the
  same object the runner executes, so the two lenses can never disagree.
- 4.2 Move runner with context slicing: each move's prompt contains ONLY its manifest files
  (fetched via direct hands fs_read dispatch, avoiding the chat loop's 8000-char tool
  truncation, tools.mjs:210), plus a byte-stable system prefix. Prefix stability is a hard rule:
  the recon measured the current cache hit rate at ZERO (server.mjs:2827-2834 comment); the IDE
  keeps its system block and tool defs byte-identical across calls so provider implicit caching
  finally pays. Cache hitPct from usage.jsonl is the KPI.
- 4.3 Writes: batches through scaffold_project under the 200-file cap with per-file issue
  collection; snapshot BEFORE each write batch (git commit when .git exists, else copies into the
  workspace snapshot dir); every batch reports the ASCII tree delta into the job stream.
- 4.4 Verify step per move: run the project's check command (typecheck, tests, build) via
  shell_run; one automatic repair round on failure, then surface the raw output honestly and
  offer the choice. Never loop silently on a red build.
- 4.5 Carve-out honesty: pre-scan write payloads against PROTECTED_RE (tools.mjs:411-426) and,
  when a file's CONTENTS trip it (a backup script containing "pg_dump" will), tell the user
  exactly which string and which layer refused, with the workaround (rename/rephrase), instead of
  a mystery refusal. The carve-outs themselves are never weakened.
- 4.6 Cost envelope: deterministic pre-job estimate in the estimatePreflight shape (catalog
  prices, no model call) shown BEFORE run; per-job budget cap (guest default from open question
  5); the runner pauses with a need_input event at the cap. Estimates self-calibrate against
  usage.jsonl.
- 4.7 Design bay wiring: design_visual moves call the images.mjs handlers (generate/refine, refs
  supported) and fs_write the results into the workspace assets dir; image billing rides the
  existing meter/creditBack rails untouched.

### Phase 5: The two lenses (UI)

- 5.1 Blueprint lens (default, beginner-first): numbered move cards with title, why, files
  touched, model chip, live cost; Approve / Skip / Explain per card; a single Run control for
  approve-all. Plain English throughout; no jargon on this lens, ever.
- 5.2 Workshop lens (pro): file tree from fs_tree with tap-to-view via fs_read; per-move unified
  diffs; run console tailing shell output; toolruns audit tail (GET /toolruns). One toggle
  switches lenses; both render the same job state.
- 5.3 Live cost meter: per-move and job-total, credits for credit users and dollars for the
  owner, fed by job `cost` SSE events; matches the dropdown pricing convention (credits per
  million for guests).
- 5.4 Aesthetic per docs/DOMINION-VISUAL-NORTH-STAR.md: machined assembly, dark titanium, smoked
  glass, copper conductors, localized green energy; dimensional icons; motion as mechanical
  behavior. No generic gradients, no cartoonish anything. The Blueprint cards are command
  records, never messenger bubbles.
- 5.5 State storage: IndexedDB for anything sizable (the dominion-forge-images vault pattern);
  localStorage only for small flags. The chat history quota fallback (app.js:106-109) must never
  be threatened by IDE state.
- 5.6 Mobile: Blueprint lens fully usable on the phone PWA (approve builds from anywhere);
  Workshop is desktop-first and may collapse to read-only summaries on small screens.

### Phase 6: Scale tier (team-size builds)

- 6.1 FOUNDRY tier: when the plan exceeds a threshold, the blueprint auto-groups moves into
  phases with named deliverables (the same shape as the house build protocol: numbered SOW,
  per-phase execution, QA, smoke). The user experience does not change; the plan just gets
  chapters.
- 6.2 Concurrency rule: ONE writer per tree, always (standing rule; the hands node is serial per
  node anyway). Parallelism is allowed only for read-only calls: planning, review passes, and
  research fan-out. No worktree juggling in v1.
- 6.3 Resumability: the job journal per workspace survives reload, deploy, and days-later
  reopening; reattach shows exactly where the build stood and what the next move is.
- 6.4 Phase-boundary checkpoints: snapshot + verify + a short plain-English completion summary
  (CEO-report style) before the next phase starts; budget envelope spans the whole build with
  per-phase subtotals.
- 6.5 Optional second-model review: the review class can be assigned a different model, and a
  phase can require its pass before advancing.

### Phase 7: Hardening and guest rollout

- 7.1 Guest gating: new IDE tool grants ride the established per-turn extra mechanism
  (filterToolDefs extra set, tenantstores.mjs:50-53), bound to the user's own node
  (user:<uid> dispatch, server.mjs:2682), available only when ideMode AND their Forge is enabled.
  browser_control and desktop_control remain owner-only, unchanged.
- 7.2 Billing races fixed before guest parallelism: mutex the autoRecharge path (currently
  fire-and-forget, double-charge risk at server.mjs:990 / billing.mjs:154-177) and make
  addSponsoredSpend atomic (read-modify-write loses updates, tenancy.mjs:94-97).
- 7.3 Tool-cap ordering: IDE tool defs register on the core side of the sorted def list so they
  are never shed by the 128-def cap (server.mjs:2817-2825); connector shedding behavior verified
  with IDE tools present.
- 7.4 Owner dual-node safety: each workspace pins its target node explicitly (the Command Deck
  per-job target lesson); untargeted owner dispatch picking the wrong machine is unacceptable in
  a file-writing mode.
- 7.5 Test suite ide_test.mjs (job spine, router table, metering-on-finally, budget pause,
  carve-out honesty, guest walls) + devboot DOM drive on 8095/8094 for both lenses + the full
  existing suites green.
- 7.6 Docs + deploy: FITS pack docs/IDE-MODE-BUILD.md complete; deploy via `railway up` ONLY;
  SW CACHE + ?v= bumps; verify the live bundle serves the new build; snapshot + rollback path
  recorded.
- 7.7 Flip IDE_MODE on for guests; announce in the tutorial content (onboarding.mjs) with a
  beginner walk-through.

## Standing efficiency rules (apply to every phase)

1. No per-user infrastructure. The user's machine computes; the container orchestrates.
2. One metered charge per move. Accumulate, then meter once, on a finally path.
3. Byte-stable prompt prefixes. Cache hitPct in usage.jsonl is a tracked KPI; it is currently
   zero and the IDE is the feature that fixes that.
4. Context by manifest. A move sees only its files. Whole-repo dumps are a bug.
5. Cheap models for mechanical work by default. The router exists so expensive models only see
   problems worthy of them.
6. Deterministic before model-driven: routing, estimates, and smallness checks are tables and
   arithmetic first, classifier calls last.
7. SSE and durable jobs, no polling.
8. Honest refusals and honest costs, always, on every lens.

## Open questions for Fred (money and taste)

1. **Themed name** inside the reveal (menu row stays "IDE Mode"). Note "Foundry" already names
   the image batch feature (Batch Foundry), so reusing it would collide. Candidates: The Works /
   Dominion Works / Machine Shop. Recommendation: **Dominion Works**.
2. **Reveal motion**: vertical platform lift (recommended, 1.3) or a third horizontal slide.
3. **Guest availability**: owner-only until Phase 7 (recommended), or dark-launch a guest
   earlier.
4. **Design code model**: which OpenAI id anchors design_code (audited before trust);
   gpt-image-2 stays for design_visual.
5. **Budget defaults** (money numbers, need your call): proposed guest per-job soft cap $2.00
   with pause-and-ask, owner uncapped.

## Blast radius note

This document changes nothing. The build it describes is HIGH blast radius end to end: it touches
the live revenue container, billing, tenancy walls, and the service worker. Every phase lands
under Forge Mode discipline: snapshot first, tests green, `railway up`, live-bundle verify,
rollback recorded.
