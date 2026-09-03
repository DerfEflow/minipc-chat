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
- Provider failures are returned with a visible code and message. The user-requested Runware video
  generation model/settings are never silently substituted. The four creative roles (director,
  visual orchestrator, screenwriter, liaison) each call a fixed, disclosed provider ladder (see
  Creative AI roles below); a fallback rung's provenance always rides back as `servedBy` metadata,
  never hidden and never presented as an error while any rung in the ladder could still answer.
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

A transport-level submit/poll outage (network error, timeout) is never terminal by itself: it keeps
the job `retrying` on the same durable job ID, and a later poll simply recovers without ever
resubmitting the paid task (`video.mjs`'s `retry_safe`/poll-catch paths). A task Runware itself
accepted and RAN, then reported **failed** — a definitive task-level result, not a transport error —
is resubmitted exactly once with the *identical* request (same `taskUUID`) before the job is ever
shown to the user as failed; only a second definitive failure surfaces, and always as a fixed
plain-language message, never Runware's raw error text (stabilize 2026-09-03, required behavior #4).

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

### Provider ladders (stabilize 2026-09-03, deficiency 20)

Every creative role — director, visual orchestrator, screenwriter, liaison — calls a fixed, ordered
ladder of provider/model rungs instead of one hard-coded model. A rung is skipped automatically on
any 4xx/5xx status, timeout, or network error (and, for the visual orchestrator, on a response whose
JSON scene plan fails validation — a rung that answers with unusable structure is exactly as
unhelpful as one that answers with an HTTP error). Whichever rung actually answers rides back to the
client as ordinary `servedBy: {agent, provider, model}` metadata, never as an error or a degraded
state; the client only ever sees an error when a role's entire ladder is exhausted, and then it is
the last rung's own honest error, never a fabricated generic code.

This replaced the single-named-model design after `deepseek-ai/deepseek-v4-pro` (the director's only
model) was retired by NVIDIA and began returning HTTP 410 on 2026-08-07, silently killing the
director — and by extension the whole video-team chat, since the director routes every turn — with
no fallback. Deficiency 19 (a `structuredClone(tenant)` crash on the live `memory.propose()` handle
carried by the signed-in tenant, fixed by projecting onto a plain, cloneable subset of fields before
`submitGeneration`) and deficiency 21 (the screenwriter auto-checkpoints a prompt that differs from
the persisted screenplay instead of refusing it, as long as no provider work is genuinely
unresolved — see below) were fixed in the same stabilization pass.

- **Director** — `deepseek-v4-pro` (DeepSeek direct) → `deepseek-ai/deepseek-v4-pro-0813` (NVIDIA,
  NVIDIA's own live replacement for the retired id) → `nvidia/nemotron-3-super-120b-a12b` (NVIDIA) →
  `claude-sonnet-5` (Anthropic direct). Conversation compaction at 70 percent stays a single,
  unladdered call to `nvidia/nemotron-3-super-120b-a12b` — bookkeeping ahead of the real, laddered
  director turn, not the turn itself, and a disclosed scope decision to keep compaction on one
  currently-alive model rather than growing its own ladder.
- **Visual orchestrator** — `nvidia/nemotron-3-super-120b-a12b` → `deepseek-v4-pro` (DeepSeek direct)
  → `nvidia/nemotron-3-ultra-550b-a55b` (last resort; NVIDIA's own card measures 50–57 s for this
  model, which is why it is not the default rung).
- **Screenwriter** — `arcee-ai/trinity-large-thinking` (OpenRouter) remains primary and keeps every
  behavior described under Trinity below unchanged, including its billing-safety-first reconciliation
  path. Falling through to `deepseek-v4-pro` (DeepSeek direct) then `claude-sonnet-5` (Anthropic
  direct) is scoped narrowly and deliberately: it fires only when Trinity's submission never got off
  the ground at all this turn (not configured, or the durable placeholder write itself failed before
  any provider egress) — never for a definitive HTTP rejection Trinity's own transport actually
  returned (a clean 401, or a router-metadata attempt-zero 503). Those stay exactly on Trinity's
  existing corrected-retry/reconciliation path; the ladder must never quietly answer from a different
  provider when the honest fix is "correct the OpenRouter key and retry", and must never risk the
  async OpenRouter billing ledger to buy availability.
- **Liaison** — `claude-sonnet-5` (Anthropic, ephemeral prompt-cache breakpoints) →
  `claude-haiku-4-5-20251001` (Anthropic) → `deepseek-v4-flash` (DeepSeek direct, flattened
  plain-string messages; no prompt-cache breakpoints on this rung).

`GET /api/video/config` reports each role as `{model, ladder: [...], configured}`, where `model`
names the first (primary) rung for backward compatibility, `ladder` lists every rung in try order,
and `configured` is true as soon as *any* rung has a credential — a single missing key no longer
makes a role appear entirely dead in the UI.

At startup, each role's first rung is probed in the background with a single 1-token request; a rung
that answers 4xx is demoted (skipped, without blocking boot on the probe) until the next hourly
sweep retries it. A slow or unreachable provider (timeout/network error) is never demoted from a
boot probe alone — only a definitive 4xx does, since a cold or momentarily-unreachable provider is
not evidence the model is gone.

### Director

Rung 1 (DeepSeek direct) and rung 2 (NVIDIA) both document a one-million-token context window and
text-only input/output; Dominion asks for non-thinking output for a clean directive and measures the
final serialized request with output headroom. At 70 percent, the director's conversation compacts
into a faithful working brief on `nvidia/nemotron-3-super-120b-a12b`, in bounded chunks when needed;
immutable screenplay/storyboard state is never silently removed. NVIDIA does not expose a separate
server-side conversation-compaction API.

Primary references: [DeepSeek V4 Pro model and request example](https://build.nvidia.com/deepseek-ai/deepseek-v4-pro)
and [NVIDIA NIM LLM API](https://docs.api.nvidia.com/nim/reference/llm-apis).

### Visual orchestrator

Each rung receives the saved screenplay, conversation, director directive, current storyboard, and
project settings, and must return a validated ordered JSON plan of no more than 100 scenes. Thinking
is disabled for this strict structured-output step on every NVIDIA rung. The primary and last-resort
rungs share NVIDIA's one-million-token context window; Dominion measures the final request with
output headroom against whichever rung is about to be called. Hosted input is text-only in this
workflow throughout the ladder; it orders image and video prompts rather than claiming to render or
inspect the final movie.

Each project admits one video-team chat turn at a time before provider egress. The complete turn has
a 240-second aggregate deadline, all non-idempotent provider POSTs run once per rung, and deploy
draining waits for the atomic save. If another tab changes the project while the team is working, the
director, visual-plan, and liaison records remain in project history, but the visual plan is marked
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

A prompt that differs from the persisted screenplay is no longer refused outright as stale
(deficiency 21, stabilize 2026-09-03). Dominion first checks for genuinely unresolved provider work
(an attempt still awaiting a provider response or reconciliation); only that condition still blocks
the turn with `screenwriter_reconciliation_required`. Absent any unresolved work, the differing prompt
*is* what the user wants written from — the client's own checkpoint save may simply not have landed
yet — so it is auto-checkpointed as a new revision (a real `screenplay.set` command, new sha) and the
turn proceeds normally. The rare case of a genuine concurrent race during that very auto-checkpoint
(the screenplay changed a second time while it was being written) still surfaces as
`screenwriter_stale_prompt` 409, asking the user to refresh; no provider call is made in that case.

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

Dominion calls Anthropic's Messages API, `POST /v1/messages`. The primary rung uses exact model
`claude-sonnet-5`; stable project context and the system instruction use ephemeral prompt-cache
breakpoints on this and the Haiku fallback rung, and the final serialized request is checked with
output headroom against whichever rung is about to be called. If Sonnet's rung is exhausted, Dominion
falls through to `claude-haiku-4-5-20251001` (same Anthropic transport and cache breakpoints), then to
`deepseek-v4-flash` (DeepSeek direct; flattened plain-string messages, no prompt-cache breakpoints on
this rung). The liaison receives the director directive and the visual-plan result, communicates
limitations plainly, and never claims an unsaved or failed operation succeeded. Every rung accepts
images but not raw video; future review of rendered output must send selected frames/contact sheets
and a transcript instead of implying direct video perception.

Primary references: [Sonnet 5 changes](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5),
[Messages API](https://platform.claude.com/docs/en/api/messages/create),
[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[vision](https://platform.claude.com/docs/en/build-with-claude/vision), and
[pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## Characters and productions

Video Studio is a hybrid of InVideo-style character consistency and Veo3-style single-button
production (Fred, 2026-09-03). A **character** is a permanent, account-level record — no project
scoping, no expiry, survives project deletion — created once through the exact same Foundry image
ladder (`images.mjs`: paid `gpt-image-2` → one safety-rewrite retry → free draft engine) the
Foundry itself uses, via a programmatic entry point (`generateImagesInternal`) rather than a second
implementation. An image is produced whenever either engine is configured; total unavailability
(neither OpenAI nor NVIDIA configured) still creates the character record with a plain-language
note rather than refusing the whole request, consistent with the house rule that nothing may fail
to produce a viable result while an alternative — here, "the character exists and can be given an
image later" — remains available.

Storage: `DATA_DIR/video/users/<tenantId>/characters/index.json` plus
`characters/<id>/ref-<n>.png`, where `n` is a stable per-character sequence number (not an array
position), so deleting one image never renumbers another out from under a client holding its URL.
A character is `{ id, name, description, style, voiceNotes, images: [{ n, file, engine, model,
quality, prompt, createdAt }], createdAt, updatedAt }`.

### Routes

All character routes are tenant-scoped, available to owners and credit users alike, and gated by
the same desktop-capability rule as every other Video Studio write.

| Route | Behavior |
|---|---|
| `GET /api/video/characters` | List, with each image's servable URL. |
| `POST /api/video/characters` | `{ name, description, style?, voiceNotes?, quality?: "low"\|"medium", count?: 1-3 }`. Builds the prompt as `name. description. style. character reference sheet, neutral background, full body and face clearly visible.` and generates `count` reference images through the Foundry ladder. |
| `POST /api/video/characters/:id/images` | `{ prompt }` generates one more image the same way, or `{ b64 }` stores an uploaded PNG directly (no provider call, no charge). |
| `DELETE /api/video/characters/:id/images/:n` | Removes one image by its stable sequence number. |
| `PATCH /api/video/characters/:id` | Updates name/description/style/voiceNotes. |
| `DELETE /api/video/characters/:id` | Refuses with 409 `character_attached` if the character is attached to any project's `characters` list or any scene's `characterIds`, unless `{ force: true }`, which detaches it everywhere (every project, every scene) before deleting. |
| `GET /api/video/characters/:id/images/:n` | Serves the PNG, tenant-checked, `cache-control: private, max-age=31536000, immutable` (a new image always gets a new `n`, so the URL is content-stable). |

### Project and scene attachment

`POST /api/video/projects/:id/characters { characterIds, expectedProjectRevision }` sets the
project's `characters` field (an ordered list of `{ id, role }`, role optional free text) after
verifying every id resolves to a real character for that tenant. `GET /projects/:id` always returns
a hydrated `cast` array (`{ id, name, description, voiceNotes, role, image, imageN }`) alongside the
raw `characters` attachment list, so the storyboard renders its chips and the producer's prompts
have names/descriptions/voice notes without a second round trip. A character deleted out from under
a project attachment is silently skipped in `cast`, never an error.

Scenes carry their own `characterIds: []`, editable through the existing checkpoint path exactly
like every other scene field. Deleting an attached character is refused (409) unless forced, per the
routes table above; forcing detaches it from every project's `characters` list and every scene's
`characterIds` in one pass (`video.mjs` `removeCharacterFromAllProjects`).

### Screenwriter and visual-orchestrator CAST awareness

When a project has an attached cast, both the screenwriter (Trinity and its fallback rungs) and the
visual orchestrator receive a `CAST` block (name, description, voice notes) ahead of the rest of
their prompt, and are instructed to use each character's exact listed name. The visual orchestrator
is additionally asked to return `"characterNames": []` per scene (the cast members that scene
uses); the server resolves those names to character ids by exact case-insensitive match
(`mapCharacterNamesToScenes`) and writes `scene.characterIds`. An unmatched name is never dropped
from wherever the model already wrote it (the scene's own prose fields) — it simply is not added to
`characterIds`, so a typo or a character outside the project's roster degrades to plain text rather
than vanishing.

### Chat-triggered scriptwriting

From the director chat, three tiers of intent detection decide whether to run the screenwriter
immediately, in order: (1) the client's own explicit `action: "screenwrite"` (a UI affordance
sending it), (2) a small deterministic phrase matcher on the message text ("write the script",
"screenplay", "storyboard this", "scenes for"), (3) the creative director's own classification —
its existing routing JSON block now carries an optional top-level `"action":"screenwrite"`,
sibling to `"routing"`, which the director sets only when the user is explicitly asking for the
script *right now*, not merely describing a story that could use one.

Any of the three routes to the same path: the chat message, with the last twelve turns of prior
conversation folded in as context, becomes the brief for `executeScreenwriterTurn` — the exact same
durable, reconciliation-safe function `POST /screenwrite` uses, so a chat-triggered write gets the
same crash-safety and billing-exactness guarantees as the dedicated screenwriter panel. The freshly
saved screenplay is then handed to the CAST-aware visual orchestrator to produce the storyboard, and
both are persisted through the normal `updateAiState` checkpoint (the same path plain chat uses for
its own visual plan). The chat reply is a deterministic summary of what was actually saved (word
count, scene count) rather than a further paid liaison call — a disclosed scope narrowing: running
director-classification tier (3) already costs one provider call, and adding a liaison call on top
of the screenwriter and visual-orchestrator calls already made would be a third and fourth paid
round trip for a turn whose content is already fully described by what was just written and saved.

### Produce: one button, one consistent production

`POST /api/video/produce { projectId, expectedProjectRevision, model?, quality?, dryRun? }` composes,
for every storyboard scene, one production prompt:

```
Purpose: <project purpose> for <project platform>.  <scene prompt>
CHARACTERS: <Name>: <description>; keep face, hair, wardrobe and proportions identical to the
  reference images. <repeated per attached character, most-used across the whole production first>
Style: <project style>
```

A missing or out-of-range scene duration is filled from the model's range rather than refused. When
the selected model supports `mode: "reference"` and at least one attached character has a generated
image, the scene submits in reference mode with that model's `maxReferenceImages` most-used
characters' images (read straight off disk and sent as base64 data URIs — the character-image route
is tenant-authenticated, so Runware cannot fetch it as a URL); otherwise the scene submits in text
mode, relying on the CHARACTERS block alone. `dryRun: true` returns the composed prompts and a
`referencePlan` (which characters, never raw image bytes) without creating any job or production
record. A real run submits scene jobs in storyboard order at most 2 in flight, each with idempotency
key `produce-<productionId>-<sceneId>`, and records a bounded production ledger entry
(`video.mjs` `createProduction`) carrying each scene's exact composed prompt/duration/ratio/
resolution so a later retry never has to re-derive them from a storyboard the user may have since
edited.

`GET /api/video/produce/:id?projectId=` reports live per-scene status by reusing the exact same
settle-and-download path `GET /jobs/:id` uses (`settleAndDescribeJob`), so a scene that reaches
`ready` is already a playable timeline clip by the time the client sees that status. A scene whose
job Runware itself reports `failed` — after that job's own existing built-in one-time
provider-failure retry has already been exhausted — is resubmitted exactly once more in text mode
(dropping reference images, keeping the same CHARACTERS-block prompt) before ever being reported as
`needs attention`; while that retry is outstanding the status reads `retrying: consistency
degraded`, never a bare error. For credit (non-owner) accounts, the standard video billing gate is
pre-checked once before the whole production starts and again before each individual scene submits;
a mid-production shortfall pauses the remaining, not-yet-submitted scenes with status `paused: add
credits` and leaves already-submitted scenes to finish normally — never a failure toast.

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
`NVIDIA_API_KEY`, `ANTHROPIC_API_KEY`, and `DEEPSEEK_AI_DOMINION_UI_APIKEY` (falls back to
`DEEPSEEK_API_KEY` if unset — both already used elsewhere in Dominion, not new to this deployment).
DeepSeek direct is a fallback rung on three of the four creative ladders (director, visual
orchestrator, liaison) and the screenwriter's own not-configured/unavailable fallback; it is optional
in the sense that its absence only narrows those ladders, never breaks boot, but every ladder rung it
backs is materially less resilient without it. Secret values must live in the deployment platform,
never in the repository. `DATA_DIR=/data` must point to the mounted Railway volume. Optional
`FFMPEG_PATH` and `FFPROBE_PATH` may override discovery for non-Debian local validation.

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
