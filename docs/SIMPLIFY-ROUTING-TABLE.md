# Simplify My Chat: the routing table

**Date:** 2026-08-03, superseded in part 2026-09-03 (STABILIZE Step 1 — see section 6 below for what
changed and why; sections 1-5 are the original 2026-08-03 record, kept verbatim because it is still
the honest history of what was measured that day).

**2026-08-03 probe: live against NVIDIA `integrate.api.nvidia.com` on the account key in the wallet.** Nothing here is from memory.

Fred named ten routes and the models he wanted on each. Four of his picks cannot serve. This document records what was measured, what replaced each failure, and why, so lane I builds against facts and Fred can overrule any substitution with one line.

---

## 1. WHAT WAS MEASURED

Probe: a short question, streamed, first-token latency recorded, 60 second timeout. First-token latency is the number that matters on a chatbot surface, because it is the whole wait a user sees.

| Fred's pick | Role | Verdict | Measurement |
|---|---|---|---|
| `writer/palmyra-creative-122b` | literary | **DEAD** | HTTP 404 `Function ... Not found for account` in 217ms |
| `nvidia/llama-3.1-nemotron-70b-instruct` | theological | **DEAD** | HTTP 404 `Not found for account` in 134ms |
| `meta/llama-3.3-70b-instruct` | empathetic | **TOO SLOW** | first token at **45,581ms**, total 47.5s |
| `meta/llama-3.1-405b-instruct` | creative | **NOT ON NVIDIA** | 404 page not found. It is absent from the 102-model list entirely |
| `nvidia/nemotron-3.5-content-safety` | safety | **ALIVE** | first token 167ms |
| `anthropic/claude-haiku-4-5` | chat | in roster | already a seat |
| `deepseek/deepseek-r1` | science and math | in roster | already a seat |
| `nvidia/nemotron-nano-12b-v2-vl` | quick and dirty | in roster | already a seat |
| `z-ai/glm-5.2` | business | in roster | already a seat |
| Perplexity | websearch | **NOT A SEAT** | Perplexity is not in the 25-model roster and is not an NVIDIA endpoint |

**The trap this re-confirms:** NVIDIA's `/v1/models` endpoint lists 102 models, and being on that list does NOT mean the account can invoke it. `palmyra-creative-122b` and `llama-3.1-nemotron-70b-instruct` are both listed and both refuse. So is `llama-3.1-nemotron-ultra-253b-v1` and `nemotron-4-340b-instruct`. The list is a catalog of what NVIDIA hosts, not a statement about this key.

## 2. SUBSTITUTES, ALSO MEASURED

| Candidate | Verdict | First token |
|---|---|---|
| `meta/llama-3.1-70b-instruct` | ALIVE | 238ms |
| `nvidia/nemotron-3-super-120b-a12b` | ALIVE | 365ms |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | ALIVE | 223ms |
| `nvidia/nemotron-3-nano-30b-a3b` | ALIVE | 256ms |
| `nvidia/llama-3.1-nemoguard-8b-content-safety` | ALIVE | 165ms |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | DEAD | not invokable on this account |
| `nvidia/nemotron-4-340b-instruct` | DEAD | not invokable on this account |

## 3. THE TABLE LANE I BUILT ON 2026-08-03 (SUPERSEDED — see section 6)

This table named exactly ONE model per route. NVIDIA retired three of them between 2026-08-21 and
2026-08-26 (confirmed HTTP 410 "has reached its end of life") with no way for a single-model route
to notice or recover, which is exactly what happened: Simplify went dark for two weeks, every turn
on the affected routes returning the raw provider error to the user. Kept below as the historical
record of what was live that day; section 6 has what actually ships now.

| Route | Model | Status | Why |
|---|---|---|---|
| chat | `anthropic/claude-haiku-4-5` | Fred's pick, stands | Fast, cheap, kept off training data |
| science and math | `deepseek/deepseek-r1` | Fred's pick, stands | Fred values how it reasons and wants it kept |
| quick and dirty | `nvidia/nemotron-nano-12b-v2-vl` | Fred's pick, stands | Small, fast, free |
| business | `z-ai/glm-5.2` | Fred's pick, stands | Long-horizon planning, free via NVIDIA |
| safety | `nvidia/nemotron-3.5-content-safety` | Fred's pick, stands | Measured alive at 167ms |
| **empathetic** | `meta/llama-3.1-70b-instruct` | **SUBSTITUTED** | Fred asked for "meta llama 70b". The 3.3 generation takes 45 seconds to say anything, which no chatbot surface can carry. The 3.1 generation of the same size answers in 238ms and keeps his intent |
| **literary** | `arcee-ai/trinity-large-thinking` | **SUBSTITUTED** | Palmyra is not invokable on this account. Trinity is already a roster seat labeled for expressive creative writing and is the model behind Fred's own Trinity work |
| **creative** | `arcee-ai/trinity-large-thinking` | **SUBSTITUTED** | Llama 3.1 405B does not exist on NVIDIA. Creative and literary collapse into one route rather than inventing a distinction the roster cannot serve |
| **theological and philosophical** | `nvidia/nemotron-3-super-120b-a12b:free` | **SUBSTITUTED** | Fred's Nemotron 70B pick is not invokable. This is the largest FREE seat in the roster, 1M context, measured alive at 365ms |
| **websearch** | roster model plus the existing search tool | **REDESIGNED** | Perplexity is not a seat and adding one is out of scope for this wave. Search is a TOOL rather than a model, so this route picks a fast roster model and turns the app's existing web search on. Lane I verifies what search machinery exists before building |

## 4. WHAT FRED MAY WANT TO OVERRULE

Each of these is a one-line change:

1. **Creative and literary share a seat.** If he wants them separate, the roster needs a second creative model, which means adding a seat rather than routing to one.
2. **The empathetic route drops a generation** to keep the same model family and size. The alternative is a Claude seat, which is better at emotional register and costs money on a route meant to be cheap.
3. **Search as a tool rather than a Perplexity seat.** Adding Perplexity is a provider integration, not a routing change, and it was never in the wave's scope.

## 5. LEDGER (2026-08-03; see section 6 for what STABILIZE Step 1 resolved or left open)

| # | Item | State |
|---|---|---|
| S1 | Whether Fred accepts creative and literary sharing one seat | `[open]`, still needs Fred — unchanged by the 2026-09-03 rewrite (both routes now share the same THREE-rung ladder instead of one seat, same doctrine) |
| S2 | Whether the websearch route should become a real Perplexity integration later | `[open]`, deferred, out of wave scope |
| S3 | Four NVIDIA models are listed and not invokable on this account. Whether that is a tier limit or a per-model entitlement is unknown | `[unknown]`, does not block this wave. **Partially answered 2026-09-03**: presence on `/v1/models` was never proof of invocability — see section 6, this is now a permanent, monitored assumption (catalogaudit.mjs's live probe) rather than a one-time surprise. |

---

## 6. THE LADDER REWRITE (2026-09-03, STABILIZE Step 1, docs/STABILIZE-2026-09-03-DEFICIENCIES.md #1-#5)

**What changed and why.** A single named model per route was the actual defect, not any one model
pick. NVIDIA can and does retire an id with no notice this app receives; the fix is structural, not
another substitution. Every route below is now a **ladder** of at least three model ids
(`simplify.mjs`'s `SIMPLIFY_ROUTES[route].ladder`): the request handler tries the first rung, and on
ANY provider failure (4xx/5xx/network/timeout/empty) moves to the next, with a first-token timeout
per rung (20s; 12s for a `gx10` rung) and a 120s total budget for the whole ladder. If every rung in
one pass fails, the handler waits 3s and tries the entire ladder once more before finally telling the
user, in one calm sentence, that nothing came back this time — never the provider's raw string. A
`served` event names whichever rung actually answered.

A second, independent layer backs this up: `catalogaudit.mjs` now runs an HOURLY LIVE CHAT PROBE (not
just a `/v1/models` presence check) against every NVIDIA-provider seat, because presence on that list
is not proof of invocability — see section 1's own "trap" callout, now enforced by code instead of
read as a warning. A seat the probe cannot verify is marked `unavailable` with a reason;
`models.catalog.mjs` hides it from `/api/models` and every seat's `fallback` field (added this pass,
one per catalog id) is what a request-time caller substitutes with. `resolveLadder()` in
`simplify.mjs` consults this BEFORE spending a live attempt, so a rung the audit already knows is dead
is skipped rather than retried into failure every turn.

**The ladder table** (all three rungs verified as live catalog ids; a rig proof of each route's first
rung actually answering is in the STABILIZE build report, not duplicated here — this file is the
source of the ROUTING, the report is the source of the PROOF):

| Route | Ladder (rung 1 -> 2 -> 3) | Notes |
|---|---|---|
| chat | `anthropic/claude-haiku-4-5` -> `deepseek/deepseek-v4-flash` -> `gx10/gpt-oss-120b` | Fred's pick still rung 1 |
| science | `deepseek/deepseek-r1` -> `deepseek/deepseek-v4-pro` -> `nvidia/nemotron-3-super-120b-a12b:free` | Fred's pick still rung 1 |
| quick | `gx10/gpt-oss-120b` -> `deepseek/deepseek-v4-flash` -> `anthropic/claude-haiku-4-5` | free/local first, since "quick" turns are the highest volume |
| business | `deepseek/deepseek-v4-pro` -> `nvidia/nemotron-3-super-120b-a12b:free` -> `anthropic/claude-haiku-4-5` | `z-ai/glm-5.2` (Fred's original pick) removed from the catalog entirely 2026-09-03: confirmed HTTP 410, will never come back on this id |
| safety | `anthropic/claude-haiku-4-5` -> `anthropic/claude-sonnet-5` -> `deepseek/deepseek-v4-flash` | care-first system prompt on every rung; `nvidia/nemotron-3.5-content-safety` (Fred's original pick) is a moderation classifier, not an answerer — measured 2026-09-03: HTTP 200 but the content is "Conversation roles must alternate...". It never answered a chat turn on this route, and was REMOVED FROM THE CATALOG ENTIRELY the same day (lead review follow-up) once it was confirmed nothing else calls it as a classifier either |
| empathetic | `anthropic/claude-haiku-4-5` -> `nvidia/nemotron-3-super-120b-a12b:free` -> `deepseek/deepseek-v4-flash` | rung 2 history: `meta/llama-3.1-70b-instruct` (410) -> `nvidia/llama-3.1-nemotron-70b-instruct` (looked live, then measured HTTP 404 "Not found for account" on lead review's own rig sweep) -> the suggested next pick `nvidia/llama-3.1-nemotron-ultra-253b-v1` (live-probed before adding, ALSO 404 on this account, never added) -> settled on the free NVIDIA seat already proven live elsewhere in this catalog. Three names for one job in one day; see models.catalog.mjs's removal comment for the measurements |
| literary | `arcee-ai/trinity-large-thinking` -> `anthropic/claude-sonnet-5` -> `deepseek/deepseek-v4-pro` | ledger S1 still open |
| creative | `arcee-ai/trinity-large-thinking` -> `anthropic/claude-sonnet-5` -> `deepseek/deepseek-v4-pro` | shares literary's ladder, ledger S1 still open |
| theological | `nvidia/nemotron-3-super-120b-a12b:free` -> `deepseek/deepseek-v4-pro` -> `anthropic/claude-haiku-4-5` | Fred's substitute pick still rung 1 |
| websearch | `anthropic/claude-haiku-4-5` + search -> `anthropic/claude-sonnet-5` + search -> `anthropic/claude-haiku-4-5`, no search, discloses | when the SERP tool is unavailable for the whole turn, EVERY rung skips search and discloses it in the answer — not just the last one |

**Catalog changes made alongside the ladder** (models.catalog.mjs, all deficiency #3-#5):
- Removed for good (confirmed HTTP 410, absent from `specs/nvidia_models.txt`'s current live list):
  `z-ai/glm-5.2`, `nvidia/nemotron-nano-12b-v2-vl`, `meta/llama-3.1-70b-instruct`.
- Added, then REMOVED THE SAME DAY (lead review follow-up on the first rig sweep): `nvidia/
  llama-3.1-nemotron-70b-instruct` — HTTP 404 "Not found for account" on this NVIDIA account, and
  chasing its OpenRouter fallback answered "No endpoints found" too. The suggested replacement,
  `nvidia/llama-3.1-nemotron-ultra-253b-v1`, was live-probed before being added and is ALSO 404 on
  this account (245ms) — never added to the catalog at all. Empathetic rung 2 now goes straight to
  `nvidia/nemotron-3-super-120b-a12b:free`.
- Removed the same day: `nvidia/nemotron-3.5-content-safety` — a moderation classifier, not a chat
  model (every ordinary turn gets "Conversation roles must alternate..." back), never wired as an
  answering seat anywhere in this app, and nothing in this codebase calls it as a classifier either,
  so there was no reason to keep the id in the catalog once it was confirmed unused.
- BATTALION_ROSTER's worker slot and BATTALION_FAILOVER entry for the removed nemotron-70b-instruct
  seat were repointed to `nvidia/nemotron-3-nano-omni-30b-a3b` (a real, free, already-cataloged
  NVIDIA-lane seat) — battalion_test.mjs/battalion_failover_test.mjs are dynamic against these
  tables and needed no direct edits, only re-verified green.
- `minimax/minimax-m3`'s `directId` was already `minimaxai/minimax-m3` (the live NVIDIA id) when this
  pass started — re-verified live rather than re-fixed; see the STABILIZE build report for whether it
  answered within 60s on the rig, since deficiency #4 measured it hanging past 150s in production.
- Every remaining catalog seat (26 of them, after both rounds of removal) gained a `fallback` id
  (`models.catalog.mjs`'s `MODEL_FALLBACKS`), and `catalogPayload()` (the `/api/models` payload) now
  hides any seat the hourly audit marks unavailable — this is deficiency #4's fix for the general
  Chat picker's model list, not only Simplify's own routes.

**What did NOT change:** no session budget on Simplify (section 4 of `simplify.mjs`'s own header,
Fred 2026-08-03, unaffected); the websearch route is still a tool turned on for the chat seat, not a
Perplexity integration (ledger S2, still deferred); creative and literary still share one ladder
(ledger S1, still open, needs Fred).

**Two measured limitations found while proving this live, disclosed rather than hidden:**
- `catalogaudit.mjs`'s NVIDIA live probe now sends `stream:true, temperature:0` (was `stream:false`,
  changed same day) because a non-streaming probe of `nvidia/nemotron-3.5-content-safety` came back
  clean nine times in direct testing while `specs/seat_sweep.mjs`, run against the real streaming
  `/chat` pipeline minutes earlier, caught the documented role-alternation failure once. The
  streaming probe request now matches production traffic shape. Even so, five more direct streaming
  probes right after the fix all came back clean too — the failure did not reproduce on demand
  through either request shape. Working conclusion: this specific seat's failure is intermittent on
  NVIDIA's side, not a probe-shape bug; the hourly re-probe (not a one-time boot check) is the
  intended mitigation for exactly this class of behavior, and this seat is not in any Simplify ladder
  so it cannot dead-end a Simplify answer either way.
- The `literary` classifier pattern (`write (me |us )?a (poem|short story|screenplay|novel chapter|
  sonnet)`) requires "a" and the noun to sit next to each other. "write me a **short** poem" or
  "write me a **two line** poem" fall through to `quick` because of the adjective in between; "write
  me a poem" matches. `TODO(fred):` loosen this regex (e.g. allow 0-2 words between "a" and the noun)
  if this undershoot matters in practice — left as-is this pass since widening a keyword regex without
  a wider prompt sample risks new false positives more than it's worth guessing at.

## 7. LEAD REVIEW FOLLOW-UP (2026-09-03, same day as section 6): DEBOUNCE + THE TWO EMPATHETIC/SAFETY REMOVALS

Merged into `stabilize` as-is on the first pass; two things came back from a rig sweep on the merged
branch. Both fixed the same day, second commit on `lane/simplify`.

**(1) The live probe was hiding seats it shouldn't.** Two live-measured false positives:
`nvidia/nemotron-3-nano-omni-30b-a3b` hidden on one transient HTTP 503 "ResourceExhausted", and
`nvidia/nemotron-3-ultra-550b-a55b` (a 550B reasoning model that legitimately answers in 50-57s)
timed out at the flat 20s budget. Fixed in `catalogaudit.mjs` (see its header comment for the full
account): a seat now needs 2 CONSECUTIVE failed probes to hide (one failure, including a 5xx
"resource exhausted" — deliberately not special-cased — lands as a `probe-warn` note, not
`result.unavailable`); one success restores it immediately, no debounce on the way up; the
consecutive-failure count persists in `catalog-audit.json` (server.mjs) so a restart doesn't reset
it; the probe budget is 60s for a catalog seat flagged `slow: true` (added to
`nvidia/nemotron-3-ultra-550b-a55b`, `deepseek/deepseek-r1`, `arcee-ai/trinity-large-thinking` in
`models.catalog.mjs`) and 20s otherwise; and a hidden seat no longer waits out the full hourly cycle
to be re-checked — `server.mjs` runs a second interval every 10 minutes that reprobes only the
currently-unavailable NVIDIA seats (`catalogaudit.mjs`'s `opts.onlyIds`), leaving every id it does
not visit exactly as it found it.

**(2) Two rig-sweep facts, asked to confirm from the log, no code change unless the log showed a
bug.** `runLadder` (simplify.mjs) had no per-rung logging at all before this — the honest answer to
"why did rung X get skipped" was "there is no log line for that," so a `[simplify] ladder
served/skip route=... model=... elapsed=...ms budget=...ms reason=...` line was added around every
rung attempt (additive only, no behavior change) and a fresh rig was booted to capture real evidence
rather than reconstruct what an old run's line "would have said":

- **quick route served DeepSeek instead of gx10, with GX10_LLM_URL pointed at the real endpoint.**
  Confirmed the lead's own hypothesis — the 12s first-token budget tripped:
  `[simplify] ladder skip route=quick model=gx10/gpt-oss-120b elapsed=12008ms budget=12000ms
  reason=Couldn't reach the model provider: This operation was aborted`. Reproduced identically on
  two more probes in the same rig session (12010ms, 12006ms) — GX10 was consistently unreachable
  within budget for the whole session, consistent with the shared dev box's GX10 being saturated by
  another lane at that moment, not a Simplify-side bug.
- **business served the free NVIDIA seat instead of rung 1 (deepseek/deepseek-v4-pro).** Could NOT
  reproduce this on a fresh rig boot: rung 1 answered cleanly on every attempt this session (three
  business-route probes, all served by `deepseek/deepseek-v4-pro` — one in 20.7s, one in 9.7s, no
  skip at all). No historical log line exists to paste for the original event, because the logging
  that would have captured it did not exist yet at the time — said plainly rather than invented. The
  most likely explanation, consistent with the ladder's own "any provider failure" philosophy, is a
  transient DeepSeek-side hiccup during that specific rig session that has since cleared; the new
  logging means any recurrence is now captured automatically, live, without needing to ask again.
