# The session budget gate can be skipped by omitting one field

**Found:** 2026-08-03, by the lane D reviewer, while attacking an unrelated claim.
**Confirmed independently by the integrator** by reading every line cited below.
**Status: NOT FIXED. It needs Fred's decision, because every available fix changes how spend is capped.**
**Blast radius: HIGH.** Money, production, live tenants.

---

## 1. WHAT IS ACTUALLY TRUE

`server.mjs:7323` reads the chat id from client input and falls back to an empty string:

```js
const chatId = typeof input.chatId === "string" ? input.chatId.slice(0, 80) : "";
```

The entire session budget block at `server.mjs:7377` sits behind `if (chatId)`. An empty string is falsy, so a `/chat` POST that omits `chatId` leaves `SB` null and skips the block. Three further guards then disengage, each verified by reading the line:

| Line | Guard | Effect when `chatId` is absent |
|---|---|---|
| 7377 | `if (chatId)` | No session budget is created at all |
| 8277 | `if (!SB \|\| !chatId) return requested;` | The per-round output cap returns the raw request, so budget stops shrinking the ceiling |
| 8346, 8930 | `if (SB && chatId)` | The mid-run budget check never runs, so a long run cannot be stopped by its cap |
| 9102 | `if (SB && chatId)` | Session spend is never recorded, so the overage is invisible after the fact |

## 2. WHAT IS NOT TRUE, AND THIS CORRECTS THE FIRST REPORT

The reviewer called this a money leak. It is a **cap bypass**, and the difference decides how urgent it is.

`meterTurn(T, costUsd, lastUserText, answer)` at `server.mjs:9099` runs **unconditionally**, outside every `chatId` guard. That is the call that charges credits for non-owner tenants. So:

- **For a guest or credit tenant:** credits are still charged. They still pay for what they use. What breaks is the per-conversation cap they set, so a runaway turn can spend more of their balance than they told it to.
- **For the owner (Fred):** `meterTurn` is non-owner only. The session budget is therefore the ONLY spend guard on the owner path, and without a `chatId` there is no cap of any kind.

So the sharp edge points at Fred's own account rather than at his customers.

## 3. IS IT BEING HIT TODAY

`[unknown]`, and worth answering before choosing a fix. The shipped client appears to always send `chatId`, which would make this latent rather than actively bleeding. Anything that posts to `/chat` directly, including a script, a test rig, or a future integration, would skip the gate without any error. The honest position is that nobody has looked at real traffic for requests missing the field, and `usage-limits.mjs` from lane D is exactly the instrument that could answer it once wired.

## 4. WHY IT IS NOT FIXED IN THIS WAVE

Two of Fred's standing rules point the same direction. Abort condition 6 in the wave plan bars any lane from changing billing behavior without his explicit approval, and the FITS gate routes anything touching money to the full process rather than a quick patch.

Every candidate fix changes behavior for somebody:

1. **Require `chatId` on the chat path.** Cleanest and most honest. Any caller omitting it starts failing, which is correct if the only such callers are scripts, and an outage if something real depends on it.
2. **Fall back to a stable synthetic key per user.** The budget always engages. Turns that previously ran unbudgeted would start hitting a cap they never hit before, which reads as a regression to whoever is running them.
3. **Log and do not block.** Zero risk of breaking a caller, and it leaves the hole open. Useful only as a first step to answer section 3.

**Recommendation: 3 then 1.** Instrument first so the traffic question gets a real answer, then require the field once we know what would break. That order costs one deploy and removes the guessing.

## 5. WHAT TO DO ABOUT THE IDE LANE

The reviewer also reported that `server.mjs` has 11 `cloudChatStream` call sites and that the gate covers only `handleChat`, with several IDE callers passing no `budgetGuard`. The integrator confirmed that `ideChatOnce` and `ideChatWithWorkspaceTools` accept `budgetGuard = null` by default and that `ideBudgetGuard` is passed at `server.mjs:3732`. Whether every IDE entry point supplies one is `[unverified]` and deserves its own pass, because the IDE lane is where most of Dominion's output tokens are spent.

## 6. LEDGER

| # | Item | State |
|---|---|---|
| B1 | Does live traffic contain `/chat` posts with no `chatId` | `[unknown]`, answerable once lane D's instrumentation is wired |
| B2 | Which fix Fred wants | `[blocked on Fred]`, recommendation is 3 then 1 |
| B3 | Whether every IDE entry point passes a `budgetGuard` | `[unverified]`, own pass, likely the larger exposure |
