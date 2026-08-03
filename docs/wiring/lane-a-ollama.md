# Lane A wiring spec: Ollama sweep

**Date:** 2026-08-03. **Lane:** A (Ollama sweep), Altana wave. **Owner of this doc:** Lane A.

## Headline finding: the mission premise does not hold for the chat transport

The brief assumed the local-Ollama chat path (`ollamaChat()`, `PROVIDERS.light`/`PROVIDERS.main`,
`LIGHT_MODEL`/`MAIN_MODEL`, `model:"local"`, the `/ollama` proxy, `hands.mjs`'s `ollama_chat` tool)
is dead weight left over from a removed local-Qwen lineup entry, citing `docs/ASSISTANT-AND-BUILD-
CORE-SOW.md` ("Local Qwen removed from the lineup... The Ollama transport remains in server.mjs
(~60 refs) as dead weight to sweep").

That characterization is **[verified] wrong for the chat side.** Three independent, dated sources
in the tree itself say otherwise, and running the tests proves it:

1. `privacy.mjs:12-16` (Private mode docstring): *"Private... (Repurposed 2026-07-30 when Local
   Qwen left the app's picker; it used to mean 'local only'. The local class is still permitted
   server-side in every mode because a non-catalog id never egresses at all.)"*
2. `server.mjs:7308-7316`: *"Explicit 'local' still runs local (Command Deck's lane only, since
   2026-07-30 when Local Qwen left the app's picker)."* This is the SAME 2026-07-30 change the SOW
   cites as the removal. The codebase's own account of that change is "left the picker," not
   "removed the execution path."
3. `GET /api/models` (server.mjs:9674) builds its payload from `catalogPayload()`
   (`models.catalog.mjs`) only. `PROVIDERS` (server.mjs:592-601, the local_light/local_main
   records) is never read by that handler and is not exposed to any client. There genuinely is no
   code path that offers local Qwen to a user as a lineup choice. That part of the mission is
   already satisfied and has been since 2026-07-30, before this wave started.

**[verified] by running, not just reading:**
```
node autoroute_test.mjs
  owner AUTO resolves to a CLOUD model and never touches the local Qwen (30.5601ms)
  explicit LOCAL still runs on the local Qwen and streams (21.4405ms)
tests 2, pass 2, fail 0

node chatjobs_test.mjs        -> 9 passed, 0 failed  (job persist/reattach/stop, all on model:"local")
node chatjobs_persist_test.mjs (imported by the above family; same model:"local" fixture)
node chat_smoke_test.mjs      -> 8 passed, 0 failed  (includes "local output limits preserve partial text")
node multitenant_e2e_test.mjs -> 12 passed, 0 failed (includes "SECURITY: the /ollama passthrough is OWNER-ONLY")
```

`model:"local"` is the load-bearing, deterministic, keyless test fixture that at least five test
files (`autoroute_test.mjs`, `attachments_e2e_test.mjs`, `chat_smoke_test.mjs`,
`chatjobs_test.mjs`, `chatjobs_persist_test.mjs`) use to exercise routing, job persistence, SSE
streaming, stop/reattach and length-continuation without a cloud key. It is also Fred's own
documented owner-only zero-egress lane (Command Deck / Private-mode adjacent work). Removing it
would violate the one rule this whole sweep exists to protect: **"Removing something still in use
is the failure mode to avoid."**

The embed side (`ollamaEmbedText`, `EMBED_MODEL`, `ollama_embed`) was never in question. server.mjs
says outright at line 239-241 that persona deliberately stays on the Ollama embedder because its
14,696-vector corpus already lives in that space.

## What this means for the integrator

**Do not remove, from server.mjs or anywhere else:**
- `ollamaChat()`, `buildOllamaPayload()`, `ollamaReq()`, `endpointForModel()`, `isHeavyModel()`
- `PROVIDERS` (`local_light`/`local_main`/`local_main_long_context` records) and `MODEL_FOR`/
  `PROVIDER_FOR_MODEL`
- `LIGHT_MODEL`, `MAIN_MODEL`, `OLLAMA_LIGHT_URL`, `OLLAMA_HEAVY_URL`, `OLLAMA_KEY`,
  `OLLAMA_VIA_HANDS`
- The `/ollama` and `/ollama/*` reverse-proxy route (owner-only, tested)
- `explicitLocal` / `model:"local"` handling in `handleChat`
- `hands/hands.mjs`'s `ollama_chat` and `ollama_embed` tools and their handlers (Lane A's own file;
  left untouched except for the doc comment below)
- `ollamaEmbedText`, `EMBED_MODEL`, the persona embed fallback
- `routing.mjs`'s `local_light`/`local_main`/`local_main_long_context` route-enum strings: these
  ride the live `{type:"route"}` SSE event to the client (server.mjs:5704, 7670, 7883, 7909); renaming
  them is a client-facing change outside a LOW-blast-radius lane and outside this sweep's mandate

**Safe to apply: one comment-only fix, zero behavior change.**

Anchor (exact, appears once, server.mjs ~line 606):
```
// The local Qwen path is the free default and is NEVER touched by this. When the user explicitly
```
Replace with:
```
// Local Qwen is no longer the default (that changed 2026-07-25 to the cloud engine; explicit
// model:"local" is Command Deck's owner-only lane since Local Qwen left the picker 2026-07-30).
// When the user explicitly
```
Reason: this is the one place `[verified]` the comment is stale. It asserts local Qwen is "the
free default," which contradicts the passing test titled "owner AUTO resolves to a CLOUD model and
never touches the local Qwen" and the 2026-07-25 changelog comment at server.mjs:7308 in the same
file. No import changes. No other line in this comment block needs to change; the rest of it
(OpenRouter routing behavior) is accurate.

**Checked and found accurate, left alone:** the four `"...Local Qwen still works."` / "switch back
to Local Qwen" user-facing error strings (server.mjs ~711, ~787, ~1062-1063, ~8570) and the
`"Local Qwen"` display label at ~5838. Local Qwen genuinely still works via `model:"local"`, so
these are correct, not stale. Do not remove them as part of any future "dead Qwen text" pass without
re-checking this doc first.

**Out of scope for Lane A, flagged for whoever owns it:** the on-demand heavy-GPU lifecycle hook
(`GPU_START_URL`/`GPU_STOP_URL`/`GPU_STATUS_URL`, server.mjs ~483-489) was built for the Thunder
Compute cloud-GPU plan that `docs/CLOUD-MIGRATION.md` §12 explicitly struck out ("~~Host: Thunder
Compute for inference now~~ -> no paid GPU; provider APIs + mini-PC Qwen"). This *may* be genuinely
dead, but it's server.mjs code Lane A cannot verify by running (no GPU env to test against) and it's
outside the Ollama-specific brief. `[unverified]`, a candidate for a future targeted pass, not this
one.

## Files touched by Lane A

- `hands/hands.mjs`: added an 8-line doc comment above the `ollama_chat`/`ollama_embed` cases
  recording this verification, so a future sweep does not re-attempt the same deletion. No logic
  changed.

## Files in Lane A's ownership checked and left unchanged (already accurate)

`memory.mjs`, `retriever.mjs`, `review.mjs`, `routing.mjs`, `watchdog.mjs`, `devboot.mjs`,
`devboot-images.mjs`, `ops/live-rig.mjs`, and all 18 `*_test.mjs` files that boot or mock Ollama.
Every Ollama-related comment in these files describes either (a) the still-live embed fallback or
(b) the still-live owner-only local-chat lane, and both were independently confirmed by running the
tests above. None of the 18 test files needed re-pointing: they were never testing dead behavior.
None was deleted.
