# Dominion AI — Session Handoff

_State as of 2026-09-03. Update the date + HEAD when this changes materially. This file described a
mini-PC deployment until this date; that description was stale by nearly two months (the app moved
to Railway well before this rewrite) and is corrected below (foundry lane, DEFICIENCIES.md #27
tooling half)._

## What it is

Dominion AI is Fred's self-hosted phone PWA assistant ("Dominion AI / by Frederick Wolfe"): a
cloud-brain agent (any cloud model, tool-capable models drive his whole box) with a local-Qwen
free/fallback lane, Simplify Chat (a picker-free chatbot surface), The Crucible (an in-app IDE that
builds real projects), Game Factory, Video Studio, and The Foundry (image generation).

## Home / infrastructure

- **Repo:** `DerfEflow/minipc-chat` (private). Deploy branch: `main`.
- **Production:** Railway project `dominion-ai`, service `dominion`. Docker build (`Dockerfile` at
  repo root); `cloudflared` runs INSIDE the container and opens an outbound tunnel, so the
  container holds no public Railway domain and cannot be reached except through that tunnel.
- **Ingress/auth:** Cloudflare Access sits in front of the tunnel in `enforce` mode — every request
  needs a verified Cloudflare identity (browser email login, or a Cloudflare Access service token
  for machine callers) before it reaches the app. Public host: `https://app.dominion.tools`.
- **Deploy = push to `main`.** Railway builds and redeploys on every push; there is no separate
  deploy step and no manual promotion.
- **Source working tree (laptop):** `F:\Claude Sandbox\Projects\minipc-chat` for direct work;
  during the 2026-09-03 stabilization program each writer lane works in its own git worktree under
  `F:\Claude Sandbox\Projects\minipc-chat-lanes\<lane>` (branch `lane/<lane>`), merged back by the
  program lead. See `specs/AGENT-RULES.md` in that tree for the lane rules.
- Zero-dependency Node 24 (`node:http`), ESM, no build step, no `npm install` for the app itself.
  Tests: `node run-tests.mjs` runs every `*_test.mjs` in the repo root.
- **Keys** live in Railway's service environment variables in production, and in the laptop wallet
  `C:\Users\rjfla\.app-secrets.env` for local/rig work: `OPENROUTER_API_KEY`,
  `OPEN_AI_DOMINION_UI_APIKEY`, `DEEPSEEK_AI_DOMINION_UI_APIKEY`, `ANTHROPIC_API_KEY`,
  `NVIDIA_API_KEY`, `SERP_API_KEY`, plus per-feature keys (Stripe, Google, Runware). Never printed,
  never committed; `server.mjs`'s `cfgGet()` reads env, then a local `.env`, then a shared bridge
  `.env`, in that order.

## Verifying production

There is no owner-level automated login into production from outside (Cloudflare Access admits
only a browser email login, or a service token — see `ops/prod-verify.mjs`, added 2026-09-03,
which drives an owner-level smoke test from the laptop using a Cloudflare Access service token
stashed at `C:\Users\rjfla\.dominion-verify-token`). `ops/health-check.mjs` runs its deeper checks
over `railway ssh` (`railway.exe ssh "sh -c ..."`), executing snippets inside the running
container rather than calling it over HTTPS — this sidesteps Access entirely for checks that need
to read the container's own filesystem or environment.

## Current architecture notes (durable, live-verified)

1. Native OpenAI rejects `max_tokens` on newer models → use `max_completion_tokens`; DeepSeek and
   OpenRouter both accept `max_tokens`. Only `provider==="openai"` differs.
2. DeepSeek native model ids drop the `deepseek/` catalog prefix (`deepseek-v4-flash`, not
   `deepseek/deepseek-v4-flash`); its chat endpoint has no `/v1` prefix
   (`api.deepseek.com/chat/completions`).
3. Anthropic direct calls use `x-api-key` + `anthropic-version: 2023-06-01` headers, never a Bearer
   token; model ids carry a dated suffix (`claude-haiku-4-5-20251001`).
4. The model catalog (`models.catalog.mjs`) is the single source of truth, served at
   `GET /api/models`. A live catalog audit (`catalogaudit.mjs`) cross-checks every catalog entry
   against each provider's real model list; providers with no key configured are reported
   `unchecked`, not failing — which means a dead model on an unchecked provider is invisible to the
   audit (see DEFICIENCIES.md #5 for a measured case of this).
5. The Foundry (`images.mjs`) generates through a paid engine (OpenAI `gpt-image-2`) with a free
   draft fallback (NVIDIA-hosted `black-forest-labs/flux.1-dev`), and, as of 2026-09-03, a
   resilience ladder: a billing/quota/5xx/timeout failure on the paid engine falls straight to the
   free draft engine; a safety rejection gets one prompt rewrite (`deepseek-v4-flash`, then Haiku)
   and one paid retry before falling to draft. See LANE-foundry.md and images_test.mjs.

## Key files

`server.mjs` (routing, cloud agent loop, provider router, `/api/*`), `models.catalog.mjs`
(catalog + provider/bench fields), `images.mjs` (Foundry image generation + ladder), `simplify.mjs`
(Simplify Chat), `ide.mjs` + `idefurnace.mjs` (The Crucible), `gamefactory*.mjs` (Game Factory),
`video*.mjs` (Video Studio), `tools.mjs`, `chatlog.mjs`, `persona.mjs`, `memory.mjs`, `mentor.mjs`,
`flywheel.mjs`, `review.mjs`, `artifacts.mjs`, `routing.mjs`, `public/` (PWA client). Every
`*_test.mjs` in the repo root runs via plain `node <file>_test.mjs` or the full `run-tests.mjs`
gate; keep the suite green before deploy.

## Behavior note (not a bug)

Dominion injects Fred's memory profile + cross-chat retrieval into EVERY turn, including cloud.
That's why models "know who Fred is"; they can't see their own context assembly and will confabulate
("lucky guess") if asked where it came from.

## Working with Fred

Full autonomy on this project (his standing directive). Reply format = essentials plus numbered next
steps with a recommendation; he replies with a number. No em dashes, no "not X but Y" constructions.
`F:\` + sandbox = full access; `C:\Documents` = read-only except an app's own backup folder, never
delete without permission. Snapshot/branch before risky changes.

## Game Factory build (2026-09-03 evening): the factory now produces games

Owner order: "build it so that it works and produces games that can be previewed natively and then iterated."
Design: docs/GAME-FACTORY-BUILD.md. Results ledger: docs/GAME-FACTORY-BUILD-RESULTS.md.
New modules: gamefactorykit/ (kit, 12-suite QA harness, reference game), gamefactoryqa.mjs (permission-sandboxed
server QA runner), gamefactoryforge.mjs (server worker: design, assets, code generation with model ladders),
gamefactorysupervisor.mjs (stage supervisor: approvals and evidence become transitions), gamefactorybuilds.mjs
(bundle view for the play route). Flags: GAME_FACTORY_SUPERVISOR=1, GAME_FACTORY_FORGE=1, GAME_FACTORY_QA_RUNNER=server.
Owner flow: Run to playtest (one tap) -> plan + planning approvals -> design -> assets -> build -> 12 QA suites ->
PLAYTEST_READY -> Play current build (served by the server at /api/game-factory/games/:id/builds/:buildId/play/) ->
Approve playtest or Request changes (revise loop, new build, QA, PLAYTEST_READY again).
Traps: projects are keyed by the owner's TENANT uid (tenancy userIdFor(email)), never "owner"; the factory admits
only a verified human owner session, so scripts cannot drive it in production (rig uses a locally signed CF JWT).

## 2026-09-04 Game Factory: first production run, two fixes (main 9bc7fce)

Fred ran Vector Vault at 01:16Z. Design and assets took four minutes; the implement task failed after
six rounds because the server QA runner built its `--allow-fs-read` glob with a Windows backslash and
Linux could not read the harness script (every suite "exited 1 without writing a results file").
Fixed with `path.join(dir, "*")`, proven in the container before and after. Same deploy: the forge
heartbeats on a timer and publishes its phase; the API stamps `serverNow`; the owner surface has a
live activity strip with a working / waiting / stalled verdict and ticking clocks; the lifecycle rail
carries the time each stage was reached; the planning-gate banner links to the Artifacts tab.
Rollback: tag `prod-2026-09-04-before-gfprogress` (1e76a89) and `/data/backups/pre-gfprogress-2026-09-04.tgz`.
Open: DeepSeek direct is out of credit (402 on every call, first rung of the code ladder falls
through instantly); Anthropic timed out once after nine minutes on a 32k-token implement round;
GPT-5.6-terra produced files on every round. Vector Vault sits in FAILED until the owner taps Retry.
