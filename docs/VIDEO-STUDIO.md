# Dominion Video Studio

Verified for the August 2026 deployment. This document records the provider contracts that the
implementation enforces. Provider responses remain authoritative: a request is persisted before it
is sent, Runware is polled by task UUID, and only the returned `cost` is settled.

## Product invariants

- Desktop projects are tenant-scoped, durable until the user deletes them, and checkpoint every
  structural or progress-changing action. Undo, redo, project history, generated media, and exports
  survive a server restart.
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

Primary reference: [Nemotron 3 Ultra model card and API guidance](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard).

### Palmyra Creative 122B — screenwriter

The requested model identity remains `writer/palmyra-creative-122b`, with a hard 115,000-token
total request/project limit and no screenplay compaction. However, a live completion probe against the user's
NVIDIA free endpoint currently returns unavailable, and Writer deprecated its `palmyra-creative`
API model on July 13, 2026. Therefore the screenwriter control is explicitly unavailable by default
and no substitute is silently used. A provisioned compatible endpoint may be enabled with
`DOMINION_PALMYRA_ENABLED=1` after a successful entitlement test.

Primary references: [NVIDIA's Palmyra deployment listing](https://build.nvidia.com/writer/palmyra-creative-122b/deploy)
and [Writer's current model/deprecation table](https://dev.writer.com/home/models).

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

## Deployment variables

Required secret variable names are `RUNWARE_VIDEO_GEN_DOMINION_API_KEY`, `NVIDIA_API_KEY`, and
`ANTHROPIC_API_KEY`. Secret values must live in the deployment platform, never in the repository.
`DATA_DIR=/data` must point to the mounted Railway volume. `DOMINION_PALMYRA_ENABLED` remains `0`
until that exact model completes an entitlement probe. Optional `FFMPEG_PATH` and `FFPROBE_PATH`
may override discovery for non-Debian local validation.
