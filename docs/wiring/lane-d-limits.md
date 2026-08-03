# Lane D wiring spec: usage-limits.mjs into server.mjs

Lane D (this wave) owns `usage-limits.mjs`, `usage-limits_test.mjs`, and `idetelemetry.mjs`. Lane D
does **not** own `server.mjs`. This document is the exact, copy-pasteable wiring another pass (or
Fred) applies to `server.mjs` to turn the instrumentation on.

Every anchor string below was re-read directly out of the current `server.mjs` and re-checked for
uniqueness during the adversarial review on 2026-08-03. The uniqueness check matters: `server.mjs`
contains five other `bumpUsage(or && or.usage);` lines in the retry ladder, and the two anchors used
here are the only two that read exactly as written.

## What this wires

`usage-limits.mjs` records one structured entry per **settled** model round: the ceiling actually
sent to the provider, the model's own ceiling for that mode, the tokens actually used (or an
explicit "unmeasured" marker when the provider returned no usage row), the finish reason, an
explicit `hitCeiling` boolean, whether the visible output came back empty (the starvation
signature), and the reasoning floor that applied if any.

`usage-limits_test.mjs` covers the mandatory-fields requirement, the no-PII requirement, torn-write
recovery, rotation, and the summary math.

## 1. Import

**Anchor** (`server.mjs` line 36, exact text, unique in file):

```js
import { MODELS as CATALOG_MODELS, MODEL_IDS as CATALOG_IDS, modelById, providerOf, isToolCapable, isReasoning, isVisionCapable, visionModelNames, outLimitFor, defaultModelFor, catalogPayload, isBroadCapable, broadCapableNames, broadCapableIds, isOrchestratorApproved, ORCHESTRATOR_FALLBACKS, UTILITY_MODEL, BATTALION_COPY, BATTALION_ROSTER, resolveModelId } from "./models.catalog.mjs";
```

**Insert immediately after it:**

```js
import { createUsageLimits } from "./usage-limits.mjs";
```

**Also add `REASONING_FLOOR` to the line-36 `models.catalog.mjs` import list.** It was a private
`const` when this spec was first drafted and was exported by a concurrent pass at 02:44 on
2026-08-03 (verified by re-reading `models.catalog.mjs` line 445: `export const REASONING_FLOOR = {`).
If that export is ever reverted, drop `REASONING_FLOOR` from the import and pass
`reasoningFloor: null` at both insertion points below; the field is nullable by design and nothing
else depends on it.

No other import change is needed. `outLimitFor` is already imported, and the round loop already
holds its result in `outCap` (see section 3).

## 2. Instantiate the store

**Anchor** (`server.mjs` line 312, exact text, unique in file: the existing build-telemetry
instantiation Lane D's storage pattern was copied from):

```js
const buildTelemetry = createTelemetry({ dir: dataPath("telemetry") });
```

**Insert immediately after it:**

```js
// Lane D, 2026-08-03: token-ceiling instrumentation. Generous ceilings stay generous
// (models.catalog.mjs owns them); this only records what actually happened per round, so the
// narrowing decision after several hundred turns is made from measurements. Writes are batched
// and asynchronous, so no chat turn pays for a disk syscall inline.
const usageLimits = createUsageLimits({ dir: dataPath("usage-limits") });
```

This follows the exact `createXxx({ dir: dataPath("...") })` factory pattern already used for
`buildTelemetry`, `chatlog`, `jobStore`, `billing`, and `sessionBudgets` in this same file, so the
storage location and lifecycle need no new explanation.

## 3. Record the main round

**Anchor** (`server.mjs` line 8579, exact text, unique in file: the line right after the settled
response's usage is folded in; it sits below the `if (!or.ok) { ... return endStream(); }` block at
8557-8578, so `or` is guaranteed settled here, with `or.finishReason` and `or.content` populated):

```js
        bumpUsage(or.usage);
```

**Insert immediately after it:**

```js
        usageLimits.record({
          model: cloudModel,
          mode,
          ceiling: roundOutputCap,
          modelCeiling: outCap,
          // Pass the raw value, NOT `... || 0`. A provider that returns no usage row must be
          // recorded as unmeasured; folding it to 0 would read a transport gap as a cheap round
          // and drag every percentile down.
          usedTokens: (or.usage && (or.usage.completion_tokens ?? or.usage.output_tokens)) ?? null,
          finishReason: or.finishReason || "",
          emptyOutput: !(String(or.content || "").trim().length > 0),
          reasoningFloor: REASONING_FLOOR[cloudModel] || null,
        });
```

Scope check, done by reading the surrounding block:

| identifier | where it is bound | in scope at 8579 |
| --- | --- | --- |
| `cloudModel` | the turn's resolved model id, bound above the round loop | yes (used at 8553, 8556, 8576) |
| `mode` | the turn's routing mode, bound above the round loop | yes (used at 8553, 8576) |
| `roundOutputCap` | `const` at 8424, same `for` body | yes (used at 8452, 8486, 8507) |
| `outCap` | `const outCap = outLimitFor(cloudModel, mode);` at 8249, enclosing scope | yes (used at 8424, 8887) |
| `or` | `let or` at 8451, same block | yes |

`roundOutputCap` is the per-round ceiling computed at 8424
(`affordableWorkerOutput(outCap, messages, ...)`) and is the exact number passed to the provider as
`num_predict` for this round. `outCap` is `outLimitFor(cloudModel, mode)` from 8249, which is the
model's own ceiling after `OUT_MODE_CEIL` and `REASONING_FLOOR` are applied.

**Both numbers are required.** `roundOutputCap` alone cannot answer Fred's question. A round that
truncated at a budget-squeezed 300 when the model's ceiling is 32768 is evidence about the session
budget, and reading it as evidence that 32768 is too low would push the ceiling the wrong way. With
both present, `usage-limits.mjs` marks the round `budgetConstrained` and leaves it out of the
ceiling-evidence figures. A regression test covers exactly this
(`ATTACK: a budget-squeezed cap is not counted as evidence the model ceiling is too low`).

## 4. Record the auto-continuation round

A round that hits `finish_reason: "length"` triggers an automatic continuation loop (the
"no-truncation" behavior). Each continuation is its own provider call with its own usage and finish
reason, and is exactly the kind of round the narrowing question needs visibility into: a model that
keeps re-hitting the ceiling on continuation is a stronger signal than one that hits it once.

**Anchor** (`server.mjs` line 8918, exact text, unique in file):

```js
            bumpUsage(cont && cont.usage);
```

**Insert immediately after it:**

```js
            if (cont && cont.ok) usageLimits.record({
              model: cloudModel,
              mode,
              ceiling: continuationOutputCap,
              modelCeiling: outCap,
              usedTokens: (cont.usage && (cont.usage.completion_tokens ?? cont.usage.output_tokens)) ?? null,
              finishReason: cont.finishReason || "",
              emptyOutput: !(String(cont.content || "").trim().length > 0),
              reasoningFloor: REASONING_FLOOR[cloudModel] || null,
            });
```

**The `if (cont && cont.ok)` guard is load-bearing, and the first draft of this spec did not have
it.** The anchor at 8918 sits ABOVE the `if (!cont.ok) { ... break; }` block at 8919-8928, so an
unguarded insertion records every dead transport as a completed round: no usage, no finish reason,
`hitCeiling: false`. Reproduced during review: five real rounds all pinned at a 2048 cap plus five
failed transports reported `hitCeilingFraction 0.5` where the truth was `1.0`, and `p50UsedTokens 0`
where the truth was `2048`. That is the exact shape of error that would tell Fred a binding ceiling
was comfortable. `usage-limits.mjs` also accepts `ok: false` and excludes such rounds from every
statistic, so either form is safe, but the guard is simpler and writes less noise to disk.

Scope check: `continuationOutputCap` is `const` at 8887 inside the same `while` body and is the
exact `num_predict` this continuation call was given. `cont` is `const` at 8900 in the same body.
`cloudModel`, `mode`, and `outCap` are the same enclosing bindings listed in section 3.

## Scope note: what is NOT recorded, and why that matters

### Inside the chat turn

`server.mjs` calls `cloudChatStream` at eleven sites. This spec instruments two of them. The rest,
and the reason each is left out:

| line | site | recorded | reason |
| --- | --- | --- | --- |
| 8451 | main round, first attempt | yes, at 8579 | the settled round |
| 8485, 8506, 8528, 8548 | provider retry, widen-pool, reroute, tools-fallback | no | an attempt that failed and was retried did not settle. Recording it would double-count one turn across several attempts and understate the per-turn hit rate. Their usage is already folded into the turn's cost by the existing `bumpUsage(or && or.usage)` calls. |
| 8900 | auto-continuation | yes, at 8918 | its own settled round |
| 8360 | supervisor verdict on `UTILITY_MODEL` | no | a fixed-size internal utility call, not a user-visible answer whose ceiling is under review |
| 7173 | BATTALION seat (`callSeat`) | no | free-lane seats only, `$0` by construction; the ceiling question is about billed lanes |

If Fred later wants attempt-level rather than turn-level data, the same `usageLimits.record()` call
can be added at each retry site with `ok: false` on the ones that did not settle. The summary
already excludes `ok: false` rounds from every statistic, so that data would be additive and
harmless.

### Outside the chat turn (flagged, not wired)

These paths reach a provider without ever entering `handleChat`, so they are outside both this
instrumentation and the session budget gate discussed below:

- `ideChatOnce` (2923) and `ideChatWithWorkspaceTools` (3148), the Crucible/IDE build lane. Several
  of its callers (2142, 2223, 2320, 3394, 3476, 3528, 5318) pass no `budgetGuard` at all.
- the OCR route (6088), a per-page `cloudChatStream` with a hardcoded `num_predict: 2600`.

The Crucible build lane is a heavy token consumer, so a ceiling decision drawn only from chat-turn
data does not describe where most of Dominion's output tokens go. Wiring it is a separate piece of
work and needs the owner of the IDE lane, because the "ceiling that applied" there is
`permit.maxOutputTokens || requestedOutputTokens`, computed per attempt inside a retry loop.

### The session budget gate is conditional

The gate at `server.mjs` 7361-7419 does run before the first provider call of a chat turn, and it
can `return endStream()` on `budget_exhausted` at 7412. Two qualifications, both verified by
reading the code during review:

1. The whole gate is wrapped in `if (chatId)` at 7377, and `chatId` comes from client input at 7323
   (`typeof input.chatId === "string" ? ... : ""`). A `/chat` POST that omits `chatId` skips the
   entire block: `SB` stays `null`, no earmark is taken, and the round loop proceeds. The only
   in-flight limiter left on that path is the running-jobs cap at 7356, which is itself waived for
   the owner.
2. It gates `handleChat` only. The Crucible/IDE, guide, and OCR paths listed above never reach it.

Neither is Lane D's to fix, and neither is caused by this instrumentation. Both are recorded here
because a reader of this document could otherwise conclude that every provider call in Dominion is
budget-gated, and it is not.

## Known limitation: upstream finish-reason canonicalization

`providerexecution.mjs`'s `canonicalTerminalReason()` maps `length`, `max_tokens`,
`max_output_tokens`, `token_limit`, `context_length`, `context_length_exceeded`, and `incomplete`
all onto the single value `"length"`, and `cloudChatStream` returns `terminal.reason || finishReason`
(server.mjs 1032). So by the time this instrumentation sees `or.finishReason`, an INPUT context
overflow is already indistinguishable from an OUTPUT ceiling hit.

`usage-limits.mjs` deliberately excludes `context_length*` from its own ceiling-hit set for the
lanes that pass a raw provider string through, but it cannot undo the upstream merge. The practical
effect is that `hitCeiling` can over-count on turns whose prompt overflowed the context window.
Dominion trims context before the call (`contextwindow.mjs`), so this should be rare; if the
recorded `hitCeilingFraction` ever looks implausibly high for a model with a large `maxOut`, this is
the first thing to check. Fixing it properly means having `normalizeProviderTerminal` keep the
pre-canonical spelling on the terminal object, which is `providerexecution.mjs`'s call to make.

## Reading the output

`usageLimits.summary()` returns one row per model, each with a `byMode` breakdown. Act on the
per-mode rows, because `OUT_MODE_CEIL` gives `fast` a 2048 cap while other modes get the model's
full `maxOut`; a percentile blended across both describes neither.

Per row:

- `n` / `nSettled` / `nMeasured` are the three denominators. `nMeasured` counts rounds that settled,
  were not budget-constrained, and carried a real usage row. Every percentile below uses it.
- `hitCeilingFraction` is the fraction of settled rounds that truncated at whatever cap they were
  given.
- `ceilingEvidenceFraction` is the number that answers Fred's question: the fraction that truncated
  at the model's own ceiling, budget-squeezed rounds removed.
- `budgetConstrainedFraction` says how much of the traffic was squeezed by the session budget rather
  than by the model ceiling.
- `starvedFraction` is empty output plus a ceiling hit together, which is the reasoning-starvation
  signature `REASONING_FLOOR` exists to prevent.
- `p50UsedTokens` / `p95UsedTokens` / `maxUsedTokens` describe the measured token distribution.
- `verdict` is `insufficient_data` (under 30 measured rounds), `raise` (the cap truncated 5% or more
  of rounds, so the observed distribution is censored and no honest narrowing figure exists), or
  `narrow`, in which case `suggestedCeiling` carries p95 plus 25% headroom rounded up to a
  256-token step.

The `censored` flag is the guard against the trap in this whole exercise: fitting a new cap to
truncated samples recommends capping at roughly the cap you already have, forever. When it is set,
the sample cannot answer the question and the module says so instead of producing a number.

## Verifying the wiring after it lands

1. `node usage-limits_test.mjs` should show `usage-limits: 28 passed, 0 failed` (this spec changes
   only `server.mjs`, never the owned files).
2. Start the server, send one normal chat turn, then check
   `<data dir>/usage-limits/usage-limits.jsonl` for a new line carrying `finish_reason`,
   `usedTokens`, `budgetTokens`, and `hitCeiling`. Writes are batched, so allow a moment or stop the
   server, which flushes on exit.
3. Confirm `modelCeiling` is a number on that line, never `null`. A `null` there means the insertion
   dropped the `modelCeiling: outCap` line, and every budget-squeezed round will then be misread as
   evidence the model ceiling is too low.
4. To reproduce the forced ceiling-hit proof from this spec's authoring session: pick a cheap
   free-lane model (`z-ai/glm-5.2` was used), send a turn in `fast` mode (a 2048 `OUT_MODE_CEIL`),
   and confirm a record with `"hitCeiling": true` and `"finish_reason": "length"` appears.
