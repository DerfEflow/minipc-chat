# Game Factory build: from approved plan to playable, iterable web games

Owner order (Fred, 2026-09-03): "build it so that it works and produces games that can be previewed
natively and then iterated." Author of this spec: Fable 5.1 (lead). Writers: Sonnet 5 lanes. Base:
main d366e37 (production). Repo: DerfEflow/minipc-chat (Dominion AI). Zero-dependency Node 24.

## 0. What exists and what is missing (read before touching anything)

Exists and stays authoritative:
- `gamefactory.mjs` lifecycle rules (12 happy-path states, REVISION loop, holds, gates).
- `gamefactorystore.mjs` SQLite control plane: projects, tasks (durable queue with leases), builds,
  artifacts+copies, approvals, tests, releases, events, idempotent commands.
- `gamefactoryplanner.mjs` Start saga (IDEA -> SPECIFICATION, renders 11 spec artifacts, mirrors to Drive).
- `gamefactoryorchestrator.mjs` dispatches QUEUED tasks with capability quality_assurance/godot to the
  GX10 broker lane (node `gx10-gamefactory`) and converts terminal truth into completeTask/failTask.
- `gamefactoryhttp.mjs` owner HTTP surface + `public/dominion-game-factory.js` owner UI.
- Production flags: GAME_FACTORY_MODE=owner, RECONCILER=1, NODE=gx10-gamefactory, CAPABILITIES=
  quality_assurance,godot, ARTIFACT_WRITES=1, MIRROR_WRITES=1, RELEASE_WRITES=0.

Missing (the whole point of this build):
1. Nothing turns an approval into work. After SPECIFICATION is approved the game sits forever.
2. Nothing produces a game. No executor exists for product_planning, visual_design or
   gameplay_engineering; the GX10 lane can only run node/godot steps against files that are already
   in its workspace, and no file ever gets there.
3. Nothing runs the 12 required QA suites, so PLAYTEST_READY is unreachable.
4. The preview button depends on an IDE workspace on a hands node; the factory has no workspace.
5. No revision loop: "Request changes" moves to REVISION and stops.

## 1. Decisions (final; deviations from the artifact templates said out loud)

D1. **Admitted toolchain: the web-canvas lane.** Games are dependency-free HTML5 canvas games (ES
modules, one `index.html`), previewable inside the factory's sandboxed iframe on any phone, testable
deterministically in Node. The 04_GAME_ARCHITECTURE template calls Godot 4.x a "candidate, admitted
only after the factory toolchain probe pins a supported version"; this build admits the web-canvas
lane instead and leaves the `godot` capability untouched for later. The build notes and the
architecture design doc state this in plain words.

D2. **Work runs in the Dominion server process** for planning, design assets and code generation
(`gamefactoryforge.mjs`), as a second durable-queue worker beside the GX10 orchestrator, using the
same store (`claimNextTask` by capability, heartbeats, `completeTask`/`failTask`). Capabilities owned
by the server forge: `product_planning`, `visual_design`, `gameplay_engineering`. The GX10 lane keeps
`quality_assurance`/`godot` for the synthetic canary and a future device rung; QA for this build runs on
the server QA runner (D4) because the GX10 broker cannot receive files (its node steps may only run a
script that already exists in `/workspace/<slug>`, and `node -e` is refused by the reviewed flag policy).
Deviation said out loud: the "QA capability runs on the explicitly configured worker" sentence in
03_BUILD_WORKFLOW is not honored in this build; the evidence records `target: "server-qa"` so nobody can
mistake it for device-lane evidence. TODO(fred): provision a bootstrap script in each broker subtree
and add the GX10 QA rung.

D3. **A stage supervisor** (`gamefactorysupervisor.mjs`) runs every 10 s in the server and moves each
game forward exactly as far as durable evidence allows: queues the one task the current stage needs,
creates builds, records QA results, transitions states through the store's own `transition` command
(every gate in `transitionDecision` still applies), and blocks with a plain reason after the retry
budget. It never bypasses a gate and never fabricates evidence.

D4. **A server QA runner** (`gamefactoryqa.mjs`) executes the kit's `qa/run.mjs` against a build bundle
in a child Node process with `--permission --allow-fs-read=<bundle> --allow-fs-write=<results>`, a
scrubbed environment (no secrets), a memory cap and a hard timeout, and records one test run per
required suite with an honest `evidence.summary`. Generated code never runs in the server process
itself.

D5. **Native preview is served by the server.** `GET /api/game-factory/games/:id/builds/:buildId/play/*`
serves the immutable bundle of a build (owner human session only, same wall as everything else). The
preview dialog loads that URL in the existing sandboxed iframe. The hands-node tunnel path stays in the
client for compatibility but the factory never needs it. Sandboxed iframes have no persistent storage,
so the kit's storage adapter falls back to memory and the preview note says saves persist only in the
installed app.

D6. **One tap to a playable build.** A new owner action at IDEA, **Run to playtest**, starts the plan
and records the owner's approval of the two planning gates (specification, visual system) in advance,
with the rationale "owner chose Run to playtest" in the durable record. The manual path (Start game
plan, then approve each gate) keeps working. Playtest approval is never automatic: the owner previews
the exact build and approves it or requests changes.

D7. **Iteration is the REVISION loop.** "Request changes" (playtest reject) or "Request revision" with a
reason queues a `gameplay_engineering` task of kind `revise` carrying the owner's words; the forge edits
the game, a new build is created (which invalidates prior evidence by design), QA re-runs, and the game
returns to PLAYTEST_READY with the new build. Failed QA suites queue a `repair` task (up to 3 per build
lineage) before the game blocks with the failing summary.

D8. **Model ladder, free first where it is safe.** Design JSON: gx10/qwen3-coder-30b (free) first,
then deepseek/deepseek-v4-pro, anthropic/claude-sonnet-5. Code generation and repairs (revised
2026-09-04 on Fred's ruling "the coder is the grunt; the brain could do that job"): gx10/gpt-oss-120b
(the GX10 brain, free, 131k window, measured 43 tok/s) first, then openai/gpt-5.6-terra,
anthropic/claude-sonnet-5, deepseek/deepseek-v4-pro (the paid rungs in the order that produced files
in the first production run). `GAME_FACTORY_FORGE_FREE_FIRST=1` additionally puts the 30B coder in
front. Configurable via `GAME_FACTORY_FORGE_MODELS` and `GAME_FACTORY_DESIGN_MODELS` (comma-separated
catalog ids). Every result carries `servedBy`.
Art: Foundry `generateImagesInternal` (paid -> safety rewrite -> free draft, already a ladder), and a
deterministic kit-drawn PNG icon as the last rung so ASSET_GENERATION can never fail for lack of art.

D9. **Env knobs (all fail closed, all logged at boot):** `GAME_FACTORY_SUPERVISOR=1`,
`GAME_FACTORY_FORGE=1`, `GAME_FACTORY_QA_RUNNER=server` (only value this build implements),
`GAME_FACTORY_FORGE_MODELS`, `GAME_FACTORY_DESIGN_MODELS`, `GAME_FACTORY_FORGE_FREE_FIRST`,
`GAME_FACTORY_QA_TIMEOUT_MS` (default 180000), `GAME_FACTORY_MAX_REPAIRS` (default 3),
`GAME_FACTORY_LEVELS` (default 12 levels per pilot build). The supervisor and forge start only when
GAME_FACTORY_MODE allows the owner (same exposure rule as the orchestrator).

## 2. The Game Kit contract (every lane depends on this; it is frozen)

Bundle layout (`DATA_DIR/game-factory/builds/<buildId>/bundle/`):

```
index.html                 kit template, filled with game meta
manifest.webmanifest       kit template
sw.js                      kit template (precache list generated at assembly)
kit/runtime.js             kit: boot, canvas, input, layout, storage, ports wiring, reduced motion
kit/ports.js               kit: AnalyticsPort, ConsentPort, MonetizationPort, HapticsPort (fakes, default off)
game/rules.js              GENERATED: pure deterministic game logic (contract below)
game/render.js             GENERATED: draw(ctx, state, layout, theme, t) using Canvas 2D only
game/content.js            GENERATED: `export default { schemaVersion, levels:[...], tutorial:[...] }`
game/meta.json             assembled: name, slug, version, palette, analytics schema, actions
assets/icon-512.png        visual_design (Foundry or kit fallback)
assets/icon-192.png        visual_design
assets/splash.png          visual_design
assets/provenance.json     visual_design: engine, model, prompt, sha256 per asset
qa/fixtures.json           GENERATED: { levels: { [levelId]: { win: [actions], fail: [actions] } } }
qa/run.mjs                 kit: the 12-suite harness (runs in node, imports game/rules.js)
build.json                 supervisor: buildId, versionName, bundleSha256, files[{path,sha256,size}], toolchain
```

`game/rules.js` (ES module, no imports except `./content.js`, no DOM, no Date/Math.random for logic;
the kit passes `seed`):

```js
export const meta = { slug, name, actions: [{ type, params: [names] }], events: [names], schemaVersion: 1 };
export function createState({ levelIndex = 0, seed = 1 }) -> state        // plain JSON object, never throws for a valid index
export function applyAction(state, action) -> { state, events: [{ name, props }] } // pure; unknown/illegal action returns same state and []
export function status(state) -> "playing" | "won" | "lost"
export function levelCount() -> number
export function serialize(state) -> string
export function deserialize(text) -> state          // throws on corruption; kit catches
export function validate(state) -> true | string    // invariants; used by fuzz
export function layout(width, height) -> { board: {x,y,w,h}, controls: [{ id, label, x, y, w, h, action }] } // pure, all controls >= 44 px, none overlapping
export function actionForPointer(state, layout, pointer) -> action | null   // pointer: { type: "down"|"move"|"up", x, y, dx, dy }
export function actionForKey(state, key) -> action | null                    // arrow keys, Enter, Space, Escape, u (undo), r (restart), h (hint)
export function hint(state) -> action | null                                 // deterministic
```
Reserved action types handled by every game: `{type:"undo"}`, `{type:"restart"}`, `{type:"hint"}`,
`{type:"next"}` (after won), `{type:"select_level", index}`. `applyAction` must emit
`level_start`-style events named from `meta.events` only, with props limited to numbers, booleans and
short enum strings (no free text).

`game/render.js`: `export function draw(ctx, state, layout, theme, t)`; may call only Canvas 2D methods
(fillRect, strokeRect, beginPath, moveTo, lineTo, arc, closePath, fill, stroke, fillText, save,
restore, translate, rotate, scale, setLineDash, clearRect, measureText, roundRect if present, and the
fillStyle/strokeStyle/lineWidth/font/textAlign/textBaseline/globalAlpha properties). `theme` carries
the palette from the visual system. Reduced-motion is `theme.reducedMotion === true`.

`qa/run.mjs` output (`qa/results.json`): 
```
{ schema: "gf-qa/1", bundleSha256, startedAt, endedAt, runner: "server-qa",
  suites: { "<suite>": { status: "PASSED"|"FAILED", summary: "one sentence", metrics: {...}, failures: [strings] } } }
```
All 12 `QA_REQUIRED_SUITES` keys always present. Suite semantics (real checks, honest scope):
- launch-smoke: every bundle file present; `node --check` passes on every .js/.mjs; index.html references
  resolve to bundle files; rules/content import; createState works for every level; render draws frame 0
  of every level on a recording context without throwing.
- core-loop: for every level the `win` fixture ends in "won"; every `fail` fixture ends in "lost" and
  restart returns to "playing"; undo after one action restores the prior serialized state.
- crash-regression: 2,000 seeded random actions per level (pointer, key, reserved) never throw; `validate`
  holds after each.
- controls: for every control in `layout()`, a pointer tap at its centre yields the control's `action`;
  each key in `actionForKey` maps to an action that `applyAction` accepts; step controls exist for every
  gesture action class the game declares.
- save-state: serialize/deserialize round trip equals; deserialize of truncated, empty and random bytes
  throws (kit treats as corruption -> fresh state); a v0 save shape without `schemaVersion` either
  migrates or throws (never returns an invalid state); validate passes after restore.
- viewport: layout at 390x844, 768x1024, 1024x768 and 360x640: no control under 44 px, no two controls
  overlapping, every control and the board inside the viewport.
- performance: 20,000 applyAction calls under 2,000 ms; 120 draw calls on the recording context under
  1,000 ms; serialized state under 64 KB.
- monetization: MonetizationPort fake adapter: default disabled; purchase -> entitled; cancel and fail
  leave unentitled; duplicate callback idempotent; restore returns entitlement; revoke clears it; the game
  never emits a purchase prompt event during "playing".
- offline: static scan of every bundle .js for fetch(, XMLHttpRequest, WebSocket, importScripts(,
  navigator.sendBeacon, http:// or https:// string literals (allowed only inside assets/provenance.json);
  sw.js precache list equals the bundle file list.
- analytics: every event emitted during the fixtures is in `meta.events`; props contain no strings
  longer than 32 chars and no keys matching /email|name|phone|address|id$/i except `level_id`.
- privacy-consent: ConsentPort default denied; AnalyticsPort queue empty until consent granted; no
  identifier fields anywhere in meta.json; consent grant then revoke empties the queue.
- store-readiness: manifest has name, short_name, start_url, display, icons 192 and 512 present as files;
  meta.json has version, slug, name, subtitle, keywords; provenance.json lists every asset with sha256.

## 3. Lifecycle automation (supervisor rules, applied per game per tick, in this order)

Skip a game entirely when: state in PAUSED/BLOCKED/FAILED/DEPLOYED, `operation` non-empty, or any task
for the game is QUEUED or RUNNING. Never queue a second task for the same purpose and build.

| State | Condition | Action |
|---|---|---|
| IDEA | autopilot sidecar present and no artifacts | (Run to playtest already started the plan; nothing) |
| SPECIFICATION | `evidence.specificationApproved` | `transition ARCHITECTURE` |
| ARCHITECTURE | autopilot and VISUAL_SYSTEM subject ready and not approved | `approve VISUAL_SYSTEM` (actor owner, rationale from D6) |
| ARCHITECTURE | no completed `product_planning` task for this game's design version | queue `product_planning` {kind:"design"} |
| ARCHITECTURE | design task COMPLETED and `visualSystemApproved` | `transition ASSET_GENERATION` |
| ASSET_GENERATION | no completed `visual_design` task for the design version | queue `visual_design` {kind:"assets"} |
| ASSET_GENERATION | assets task COMPLETED | `transition IMPLEMENTATION` |
| IMPLEMENTATION | no active build or active build has no `gameplay_engineering` task | `createBuild` (versionName 0.1.N, toolchain {lane:"web-canvas", node}) then queue `gameplay_engineering` {kind:"implement"|"repair"|"revise", buildId, reason, failures} |
| IMPLEMENTATION | build task COMPLETED with `result.bundleSha256` | `transition INTEGRATION` |
| INTEGRATION | bundle verifies (every file sha matches build.json, sw precache = file list) | write build status "BUILT"; `transition AUTOMATED_TESTING` |
| INTEGRATION | bundle fails verification | mark repair needed; `transition REVISION` with reason |
| AUTOMATED_TESTING | no QA run recorded for the active build | run server QA (D4); record 12 test runs with sourceHash = build.sourceCommit |
| AUTOMATED_TESTING | all 12 PASSED (`evidence.qaReady`) | `transition PLAYTEST_READY` |
| AUTOMATED_TESTING | any FAILED and repairs < max | `transition REVISION` (reason: failing suites) |
| AUTOMATED_TESTING | any FAILED and repairs >= max | `block` with the failing summary (owner Retry re-enters) |
| REVISION | pending revision reason exists (reject rationale, revise reason, or QA failures) | `transition IMPLEMENTATION` (the IMPLEMENTATION row then creates the new build and queues revise/repair) |
| PLAYTEST_READY | `evidence.playtestApproved` | `transition RELEASE_CANDIDATE` |
| RELEASE_CANDIDATE | `releaseCandidateApproved && qaReady` | `transition APPROVED` |
| APPROVED and later | (human-gated by design; store release writes are off) | nothing |

Retry from BLOCKED/FAILED returns to `resumeState`; the rules above are idempotent from any state, so
the supervisor simply continues. `sourceCommit` of a build is the bundle sha256 (no git).

## 4. Lanes (disjoint files; one writer per worktree)

- **Lane gfkit** (new dir `gamefactorykit/` + `gamefactoryqa.mjs` + tests): the kit files, the QA
  harness, the server QA runner, a hand-written reference game (`gamefactorykit/reference/vector-vault/`)
  that passes all 12 suites, PNG encoder for the fallback icon, bundle assembler (`assembleBundle`).
- **Lane gfforge** (new `gamefactoryforge.mjs` + tests): server worker claiming product_planning,
  visual_design, gameplay_engineering; model ladder via injected `chat`; prompts; file-block parser;
  local validation loop (syntax, import, fixtures) before completing; heartbeat; honest failTask.
- **Lane gfsupervisor** (new `gamefactorysupervisor.mjs` + tests; additive store functions in
  `gamefactorystore.mjs`: `updateBuildStatus`, `listBuilds`, `sidecar`-free): the rules in section 3,
  the autopilot sidecar, the QA recording, blocking.
- **Lane gfhttp** (`gamefactoryhttp.mjs`, `public/dominion-game-factory.js|.css`, `gamefactory_ui_test.mjs`,
  `gamefactoryhttp_test.mjs`, `public/index.html`, `public/sw.js` version trio): Run to playtest action,
  play route, previewUrl preview, build/QA summary card, health cards for supervisor and forge.
- **Integration (Fable)**: `server.mjs` wiring (chat wrapper, forge+supervisor start/stop, env knobs, boot
  line), merge, rig proof as a human owner (mock CF certs like `gamefactory_server_test.mjs`), deploy,
  production verification, docs, memory.

Interfaces between lanes are exactly the exports named in each LANE-*.md. Do not invent others; if a
needed export is missing, write a TODO(fable) in code and a note in the lane report.

## 5. Proof required before "done"

- Unit: every new module has a `_test.mjs`; `node run-tests.mjs` green on Windows (set `DATA_DIR` to a
  temp dir in every boot test; the Windows default DATA_DIR is the shared `C:\minipc-chat`).
- Rig: the real server booted with production keys, GAME_FACTORY_MODE=owner, mock human-owner JWT:
  Run to playtest on vector-vault reaches PLAYTEST_READY with 12 PASSED suites and a playable bundle
  served at the play URL; Request changes with a plain-language note produces a second build that
  reaches PLAYTEST_READY again; Pause during a task pauses at a safe boundary and Resume continues.
- Production: deploy, owner smoke 7/7, then the owner's own tap on Run to playtest observed to completion
  through Railway logs and a read-only look at the store (railway ssh + node:sqlite).
