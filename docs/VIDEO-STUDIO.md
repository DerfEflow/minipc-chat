# Dominion Video Studio

Verified for the August 2026 deployment. This document records the provider contracts that the
implementation enforces. Provider responses remain authoritative: a request is persisted before it
is sent, Runware is polled by task UUID, and provider charges use Runware's returned `cost` or
OpenRouter's returned `usage.cost` rather than a client estimate. A missing or malformed OpenRouter
usage cost is rejected without changing the screenplay or charging Dominion credits.

## Product invariants

- Desktop projects are tenant-scoped, durable until the user deletes them, and checkpoint every
  structural or progress-changing action. Undo, redo, project history, generated media, and exports
  survive a server restart.
- Every whole-project save, undo, redo, and restore carries the last authoritative project revision.
  A stale tab cannot overwrite a newer checkpoint. Its complete current local draft is held in
  memory, editing is paused, and the user must download a preservation JSON artifact before loading
  the newer server copy. A `beforeunload` guard warns while that artifact has not been downloaded.
  The artifact is for recovery/audit; it is not presently an in-app import format.
- A storyboard contains at most 100 scenes. Screenplay text contains at most 115,000 estimated
  tokens and is never compacted.
- The editor exposes three video tracks and four independently adjustable audio tracks. FFmpeg is
  the production renderer and media verifier. The deployment image installs Debian's maintained
  `ffmpeg` and `ffprobe` packages from the open-source [FFmpeg project](https://github.com/FFmpeg/FFmpeg).
- Non-owner paid generation requires a credit account, payment method, positive balance, and
  enabled auto top-up before a provider request is accepted. Final provider cost is serialized per
  account, fully funded before the exact debit, durably settled at most once, and only then may the
  verified generated file be released.
- Mobile without a live desktop session is intentionally limited to one temporary generation,
  download, and device save. It cannot create or mutate a durable project.
- Provider failures are returned with a visible code and message. The system never silently swaps
  one requested AI model for another.
- Normal privacy mode permits the configured cloud AI transports. Trusted and Private modes refuse
  OpenRouter and NVIDIA before content screening, billing, or network egress; no alternate model is
  substituted. Anthropic remains subject to the app-wide direct-provider allow-list.
- Storage is bounded per project and per tenant, project count and mutation rates are capped, and
  the worker preserves a low-disk reserve. Expired one-off mobile workspaces are cleaned hourly.

## Runware video generation

All four models use Runware's array request endpoint, `POST https://api.runware.ai/v1`, with
`taskType: "videoInference"`, a caller-generated `taskUUID`, `deliveryMethod: "async"`,
`includeCost: true`, one result, URL delivery, and MP4 output. Pending work is recovered with a
`getResponse` task using the same task UUID. The implementation distinguishes task-level errors
from transport errors, retries only transient failures with bounded backoff, downloads successful
media into the project, verifies the streams, then settles the returned cost.

Primary references: [task polling](https://runware.ai/docs/platform/task-polling),
[error responses](https://runware.ai/docs/platform/errors), and the model pages linked below.

| Model | Modes | Duration | Resolutions and ratios | Important request constraints |
|---|---|---:|---|---|
| [Gemini Omni Flash](https://runware.ai/docs/models/google-gemini-omni-flash) (`google:gemini@omni-flash`) | text, image, reference, edit, continue | 3–10 s | 720p; 16:9 or 9:16 | One frame image; up to seven references generally and five for edit/continue; edit and continuation inputs are mutually exclusive. |
| [Seedance 2.0](https://runware.ai/docs/models/bytedance-seedance-2-0) (`bytedance:seedance@2.0`) | text, image, reference | 4–15 s | 480p, 720p, 1080p, 4K; 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 | Up to two frame images, nine reference images, three reference videos, and three reference audios. Frame images cannot be combined with reference media. Native audio is configurable. |
| [Kling Video 3.0 Turbo](https://runware.ai/docs/models/klingai-video-3-0-turbo) (`klingai:kling-video@3.0-turbo`) | text, image | 3–15 s | 720p or 1080p; 16:9, 9:16, or 1:1 | Prompt length 3–3,072 characters; optional plan of at most six shots whose whole-second durations total the request duration. |
| [Grok Imagine Video 1.5](https://runware.ai/docs/models/xai-grok-imagine-video-1-5) (`xai:grok-imagine@video-1.5`) | image, reference | 1–15 s | 480p, 720p, 1080p; 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3 | No text-only mode; one frame image or up to seven reference images; at most one reference audio paired with reference images. |

The compiler follows each model and input mode rather than applying a generic dimension rule:
Gemini uses exact width/height; Seedance frame-image requests use `resolution` while text and
reference requests use exact width/height; Grok uses `resolution`; Kling uses exact width/height and
encodes multi-shot plans in its documented inline prompt template. Several sizes are not generic
aspect-ratio arithmetic, so the authoritative per-model maps live in `video.mjs`.

## Creative AI roles

### DeepSeek V4 Pro — creative director

Dominion calls NVIDIA's OpenAI-compatible `POST /v1/chat/completions` endpoint at
`https://integrate.api.nvidia.com/v1` with model `deepseek-ai/deepseek-v4-pro`. NVIDIA documents a
one-million-token context window and text-only input/output. Dominion asks for non-thinking output
for a clean directive and measures the final serialized request with output headroom. At 70 percent,
DeepSeek compacts eligible conversation into a faithful working brief, in bounded chunks when
needed; immutable screenplay/storyboard state is never silently removed. NVIDIA does not expose a
separate server-side conversation-compaction API.

Primary references: [DeepSeek V4 Pro model and request example](https://build.nvidia.com/deepseek-ai/deepseek-v4-pro)
and [NVIDIA NIM LLM API](https://docs.api.nvidia.com/nim/reference/llm-apis).

### Nemotron 3 Ultra — visual orchestrator

Dominion calls the same NVIDIA chat-completions endpoint with
`nvidia/nemotron-3-ultra-550b-a55b`. It receives the saved screenplay, conversation, director
directive, current storyboard, and project settings, and must return a validated ordered JSON plan
of no more than 100 scenes. Thinking is disabled for this strict structured-output step. The model
has a one-million-token context window; Dominion measures the final request with output headroom.
It has text-only hosted input in this workflow and orders image
and video prompts rather than claiming to render or inspect the final movie.

Each project admits one video-team chat turn at a time before provider egress. The complete turn has
a 240-second aggregate deadline, all non-idempotent provider POSTs run once, and deploy draining waits
for the atomic save. If another tab changes the project while the team is working, the director,
visual-plan, and liaison records remain in project history, but the visual plan is marked
`quarantined_stale` and cannot replace the newer storyboard. The UI says this explicitly and reloads
the authoritative project.

Primary reference: [Nemotron 3 Ultra model card and API guidance](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard).

### Trinity Large Thinking — screenwriter

Dominion calls OpenRouter's OpenAI-compatible `POST /api/v1/chat/completions` endpoint with the exact
model `arcee-ai/trinity-large-thinking`. Trinity is text-only, has a 262,144-token provider window,
and requires reasoning. Dominion deliberately keeps the stricter 115,000-token total screenwriter
budget requested for this product, including output headroom, and never compacts screenplay text.
For each section it enables mandatory thinking, stores the returned reasoning details as opaque
server-side continuation state, and never exposes that trace to the browser. The first textarea is
retained as the story brief; Trinity's first section replaces the brief in the editor, and every
later section is appended atomically to the existing screenplay. Each call allows up to 16,384
completion tokens when the remaining application budget permits. A `finish_reason` of `length`
is returned as an explicit resumable partial section and checkpointed without deleting earlier text.

The request uses the model's published sampling defaults (`temperature: 0.3`, `top_p: 0.8`) and
requires every routed provider to honor those parameters. OpenRouter may fail over between providers
serving the same exact Trinity model, but Dominion rejects a response that does not confirm the exact
model identity. OpenRouter's returned `usage.cost` is the billing authority, so mandatory reasoning
tokens and provider-specific routing are charged exactly once without relying on a drifting estimate.
Dominion never estimates a missing provider charge because Trinity routes can have different prices;
reasoning tokens are already included in OpenRouter's completion-token accounting.
A hashed project-scoped `session_id` keeps provider routing stable, but the currently listed Trinity
endpoints do not advertise implicit prompt caching, so Dominion assumes no cache discount unless the
returned usage object explicitly reports cached tokens and cost.

Each project permits only one in-flight screenwriter turn. The saved screenplay and prior Trinity
generation identity are compared again atomically before accepting the provider result, so another
tab or a user edit can never be overwritten by a stale paid response. Ambiguous network failures are
not automatically retried because OpenRouter does not expose a request-deduplication contract for
chat completions; an explicit retry starts only from the unchanged saved checkpoint.

The browser endpoint requires `Accept: text/event-stream`. Dominion sends an immediate progress
event and a 15-second heartbeat while the upstream OpenRouter request remains non-streaming, then a
single `result` or structured `error` event. This keeps long mandatory-reasoning turns visible across
the Cloudflare edge without exposing reasoning. The OpenRouter response body stays under the same
five-minute abort deadline after headers, is capped at 2 MB, and is never ambiguously retried.

OpenRouter's `X-Generation-Id` is durably recorded as soon as response headers arrive. The body must
contain the same generation `id`; a missing or conflicting identity is quarantined for reconciliation.
For a valid response, Dominion stores a bounded server-only recovery candidate before exact metering,
derives the settlement identity from provider, model, and generation ID, then atomically applies the
screenplay and clears the candidate. Attempt/settlement records survive creative undo and restore and
are never returned to the browser. If the event stream disconnects after the server saved a result,
the editor reloads the authoritative project before it permits another screenplay request.

Dominion requests OpenRouter router metadata on every Trinity call. A routed provider attempt or a
known generation identity is treated as potentially billable and is never retried. A raw router
attempt of zero on a definitive HTTP rejection can terminate unbilled. For a known generation,
reconciliation uses only `GET /api/v1/generation?id=…`; it requires the exact model, completions API
type, an explicit terminal finish/cancel signal, and authoritative total cost. It never fetches or
reconstructs provider content. An in-progress metadata row remains locked even when its temporary
cost is zero.

If OpenRouter returns no safe generation identity or returns conflicting identities, the user gets a
typed-confirmation recovery dialog. That action preserves the attempt and any bounded candidate in
history as `operator_quarantined`, records `not_billed`, never retries a provider, and unlocks the
project. If multiple linked attempts remain, status presents the next confirmation until every
blocking record is terminal.

A known generation remains on **Check generation** for nonterminal cost/finish metadata, network
errors, authentication errors, throttling, and provider outages; those conditions never age into a
user quarantine. Only three durable identity/contract failures (persistent 404, wrong generation,
wrong model, or wrong API type) over at least ten minutes expose the typed quarantine option. The
quarantine endpoint performs one final metadata GET: if the record has become valid it refuses the
quarantine and sends the user back through normal cost reconciliation.

Primary references: [Trinity Large Thinking model page](https://openrouter.ai/arcee-ai/trinity-large-thinking/api),
[OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request),
[reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), and
[usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
[router metadata](https://openrouter.ai/docs/guides/features/router-metadata), and
[generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation).

### Claude Sonnet 5 — user liaison

Dominion calls Anthropic's Messages API, `POST /v1/messages`, with exact model
`claude-sonnet-5`. Stable project context and the system instruction use ephemeral prompt-cache
breakpoints, and the final serialized request is checked with output headroom. The liaison receives the director directive and the visual-plan result, communicates
limitations plainly, and never claims an unsaved or failed operation succeeded. Sonnet accepts
images but not raw video; future review of rendered output must send selected frames/contact sheets
and a transcript instead of implying direct video perception.

Primary references: [Sonnet 5 changes](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5),
[Messages API](https://platform.claude.com/docs/en/api/messages/create),
[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[vision](https://platform.claude.com/docs/en/build-with-claude/vision), and
[pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## Settlement repair runbook

This is a financial break-glass path. It is owner-only, operates through the live application
process, and never invokes the charge callback itself. Do not run it from a second process or direct
SQLite session. First list held claims:

```http
GET /api/video/admin/settlements
```

Inspect one exact key when necessary:

```http
GET /api/video/admin/settlements?settlementKey=<settlementKey>
```

Compare that claim with the authoritative Dominion credit/Stripe ledger and provider record. Then
choose exactly one action by POSTing the shown JSON to `/api/video/admin/settlements`:

- If the ledger proves the charge already occurred, POST:

  ```json
  {
    "settlementKey": "<settlementKey>",
    "action": "mark_settled",
    "confirmation": "MARK_SETTLED <settlementKey> OPERATOR_VERIFIED_CHARGE_OCCURRED"
  }
  ```

- If the ledger proves no charge occurred, release the claim for one normal deterministic retry:

  ```json
  {
    "settlementKey": "<settlementKey>",
    "action": "retry_not_charged",
    "confirmation": "RETRY_NOT_CHARGED <settlementKey> OPERATOR_VERIFIED_NO_CHARGE"
  }
  ```

Never infer either answer from a timeout or error message. After the owner repair, have the affected
user press **Resolve saved Trinity turn**. The same deterministic billing identity then observes the
settled row or performs the one verified-safe retry, applies the saved candidate, and unlocks the
project. Before repair, the same button safely returns the held-repair error and does not charge
again. The screenwriter status response includes the exact bounded operator reference needed to
match the held row.

Generation-ID conflicts and missing IDs do not enter this meter runbook because Dominion cannot
safely correlate or bill them. The affected user instead presses **Review unrecoverable turn**, reads
the no-recovery/no-Dominion-billing warning, and types the exact server-provided confirmation. Repeat
if status exposes another linked attempt. No ad-hoc database edit is required.

## Deployment variables

Required secret variable names are `RUNWARE_VIDEO_GEN_DOMINION_API_KEY`, `OPENROUTER_API_KEY`,
`NVIDIA_API_KEY`, and `ANTHROPIC_API_KEY`. Secret values must live in the deployment platform, never
in the repository. `DATA_DIR=/data` must point to the mounted Railway volume. Optional `FFMPEG_PATH`
and `FFPROBE_PATH` may override discovery for non-Debian local validation.

Production requires `MULTI_TENANT=1`, one application replica, and an attached Railway volume at
`/data`. Railway does not mount one volume into multiple active deployments, which is part of the
single-writer settlement and project-lock contract. Do not add replicas or run a second repair
process until the meter/feature locks are replaced with a distributed transaction design.

Railway config grants the old deployment 330 seconds between SIGTERM and SIGKILL. The PID-1 entrypoint
forwards SIGTERM to both Node and `cloudflared`; the tunnel uses Cloudflare's maximum supported
180-second grace period, stops new edge requests, and drains active streams while Node allows up to
310 seconds for durable provider turns and then waits for HTTP response completion. Node and
Railway therefore outlive the video-team chat's 240-second aggregate deadline and OpenRouter
Trinity's 300-second request timeout. If Cloudflare closes an older edge stream at its 180-second
ceiling, the provider turn still reaches the durable ledger and the client resumes through status
and reconciliation on the replacement deployment. Railway retains a final forced-shutdown margin.
