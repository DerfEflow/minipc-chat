# Dominion AI stabilization: results (2026-09-03)

Companion to STABILIZE-2026-09-03-DEFICIENCIES.md (the 28 findings). This file records what shipped, how each
item was proven, and what remains. Kinds of proof: UNIT (mocked, in run-tests.mjs), RIG (exact production
code booted locally with production keys and real providers), PROD (measured against app.dominion.tools with
the owner-level Cloudflare Access service token after deploy).

## Deploys
- Deploy 1: main 67021d5 (all seven lanes + Codex design pass), Railway f221da2f, 15:39Z. Owner smoke 6/7
  (the one FAIL was the Game Factory human-owner gate answering a service identity as designed).
- Deploy 2: main 9f9e6ca, Railway 7e9e8eec, 16:34Z. Owner smoke 7/7.
- Deploy 3: the Video Studio production tool (characters, chat-driven screenwriting, one-button production),
  the Crucible workspace-root guard, the GX10 context clamp, and the Codex D7 design pass. SHA recorded below.
- dominion-site: version d5df09c6 (Studio cross-link banner); apex dominion.tools repointed from two stale
  dns-only A records to the dominion-site Worker custom domain (snapshot of the old records kept).

## Item by item
1-3 Simplify: every route is a three-rung ladder (free or cheapest first), provider errors skip a rung, a
  `served` event names the model, error only after two full passes. Classifier widened (business, science,
  empathetic, literary with adjectives). PROD: six probes across six routes answered, zero errors, twice.
4-5 Catalog: three retired NVIDIA seats removed, content-safety classifier removed as a chat seat, dead
  llama-70b removed, minimax id corrected; the audit now probes NVIDIA with a live chat request, hides a
  seat after two consecutive failures, re-probes hidden seats every 10 minutes, 60 s budget for reasoning
  seats; every seat has a fallback. PROD: 24 of 27 seats answered on the first sweep, the three GX10 seats
  hung behind a busy GX10 (see 8); after deploy 2 the GX10 seats answered and hang-time is capped at 10 s.
6 Chat resilience: pre-token and mid-stream cross-model fallback with `served`, one usage row per turn,
  OpenAI 128-tool cap by relevance, Moonshot schema stripping, OpenRouter tool-capability cache, Anthropic
  temperature omitted for the adaptive family, `opts` crash fixed. RIG: bogus Moonshot key still answered via
  OpenRouter with no error; gpt-4o with the full tool catalog answered. The remaining `interrupted` rows were
  deploy-drain interruptions (a real stop, honestly logged), not double logging; fewer deploys is the cure.
7 Role wall: owner-only tools are filtered out of non-owner tool lists. RIG: credit-role guest ran a tool
  turn with zero denials.
8 GX10: hub liveness now judged by inbound beats with instance tokens (no more 17-minute lockouts, legacy
  nodes exempt from eviction), new hands client rolled to both GX10 containers, planned 10-minute graceful
  re-dial, cloudflared on http2; Ollama pinned (keep_alive -1, two models resident, 32k context so both fit);
  a busy or absent GX10 falls back to DeepSeek in 10 s. PROD: GX10 served production chat for the first time
  ever (hub jobsDone advancing, inbound beats every 20 s).
9 Content wall: two matcher false-positive classes narrowed (construction "naked", `cum*`), ten benign
  prompts locked in as tests; true positives still block.
10, 12, 13 Crucible: missing planned files trigger automatic repair moves with model escalation, prose plans
  are re-asked with a strict contract, unreadable audits fall to concrete checks, brain/frontier now fire on
  the real failure modes and write lessons.json and reports, 30 s status heartbeats, 180 s stall reroute,
  20-minute re-plan, restart resume, `mv` regression pinned. RIG: 6-file API built with tests green; forced
  missing file still finished with brain and frontier runs and three lessons written. PROD: a verification
  build ran with the counsel loop visibly diagnosing (brain, frontier, escalation); it could not finish
  because its workspace root was outside the build node's roots, which is now refused up front (below).
11, 18, 25 Streams: every SSE emits a heartbeat comment every 10 s (Cloudflare idle kill eliminated); the
  lens reattaches incrementally from the last record with a quiet live/reconnecting state. RIG: 18 heartbeat
  frames in 3 minutes on an idle attach; a tiny build had a max silent gap of 10 s (was 166 s). PROD: the
  verification build's attach stream showed keepalive frames every 10 s.
14 IDE mockups now request low quality portrait (9x cheaper).
15-17 Game Factory: chatgpt_project is a DEFERRED backend (planning proceeds on primary + Google Drive, an
  owner reconciliation queue lists what can be synced by hand), worker proof loss on a transient disconnect
  suspends for a 10-minute grace window and resumes on a matching re-probe instead of latching, the outbox
  has a drainer, the broker hard-link EPERM falls back to an exclusive create; dispatch journal schema 1->2
  is additive and tested against a schema-1 fixture. RIG: a project transitioned past the old gate with
  DEFERRED copies listed. PROD: the human-owner gate stays; verification by a human owner session.
19-21 Video: every generation request 500'd on a structuredClone of the tenant object; fixed. Director,
  visual orchestrator, screenwriter and liaison are provider ladders with `servedBy`; the director's
  DeepSeek rung needed a reasoning-safe token budget; stale screenwriter prompts auto-checkpoint; Runware
  transport errors retry; a failed job is retried once. PROD: a real 3-second clip generated and verified in
  production (the first video ever produced there); director answered.
22 dominion.tools/studio carries a banner to the full Video Studio; the apex now serves the same build as www.
23 Foundry: paid engine -> safety rewrite -> free draft ladder with `servedBy`, refine and batch included.
  RIG: bogus OpenAI key still produced an image from the draft engine. PROD: low image served by gpt-image-2.
24 Provider fragility is now absorbed by the ladders above rather than shown; OpenRouter balance is the only
  account that still needs watching.
26 ops/prod-verify.mjs runs the owner smoke from this laptop with the new service token (7/7 after deploy 2).
27 Deploy hygiene: production, GitHub main, the Documents backup and the stabilize worktree are the same
  commit after each deploy; the live rig no longer points at Z:; the Windows IPC test picks an F: root;
  SESSION-HANDOFF.md rewritten; worktree archived to G:\My Drive\Claude Archives\Worktree Snapshots.
28 Usage: to be observed over the coming days.

## New scope shipped in deploy 3 (owner's request 2026-09-03)
Video Studio production tool: characters generated through the Foundry ladder and stored permanently per
account, attachable to projects and scenes, a CAST-aware screenwriter that the director chat can invoke,
and one Generate button that composes brand + scene + character blocks and attaches reference images
(reference mode) for consistent commercials. RIG: two generated characters, chat-written two-scene script with
both assigned, dry-run composed prompts, a real production with both clips on the timeline.

## Deviations and open items, said plainly
- The Game Factory chatgpt_project backend is deferred, not mandatory; the offline attestation flow is intact.
- Simplify's safety route answers on Claude rather than the NVIDIA safety classifier (which cannot chat).
- The GX10 20B seat was retired (forwarded to the 120B) because a third resident model evicted the two useful ones.
- Chat turns interrupted by a deploy are still logged as interrupted; batching deploys is the mitigation.
- The AF-crew and task-graph Crucible pipelines do not yet resume across a restart (standard crew does).
- The `nvidia/nemotron-3-super-120b-a12b:free` and Trinity seats are slow (reasoning); they are last rungs.
