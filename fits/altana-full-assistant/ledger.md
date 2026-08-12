# Ledger: Altana full assistant, 2026-08-12

Placeholders, assumptions and things found on the way that are not mine to decide. An OPEN
high-impact item left unexplained is fake completion, so everything below is either closed or
addressed to Fred by name.

## OPEN, needs Fred's decision

### L1. The purchase ceiling is my number, not yours. [assumed]

`MAX_PURCHASE_USD = 500` in `altana-money.mjs`. Nothing in the app had a ceiling before: the existing
`POST /billing/topup` accepts any amount at all, which was defensible when the only way to reach it
was a person clicking a tier on a page, and is not once a conversational assistant is near the path.
The failure it guards is a slipped zero in a chat box, not a customer deliberately buying big.

$500 is five times the largest tier you actually sell ($100). Above it she refuses in plain words and
offers the payment screen, which still has no ceiling, so nothing becomes impossible. Say a number
and I will move it.

### L2. Auto top-off is load-bearing for two features, and she can now switch it off.

Turning it off is real and it breaks things: video generation refuses to run without it
(`video-http.mjs`, 402 `Enable auto top-up before generating video`) and Engineer mode is gated on it
(`ide.mjs` `engineerGate`). She states both consequences in the confirmation, before the user types,
and repeats them in the result. `billing.grantSession` also force-enables it on every paid session,
so a user who switches it off and then buys credits will find it back on. That is existing behaviour
and I have not touched it, but it means "off" is not permanent and she does not currently say so.

Decide which you want: leave it (a purchase re-arms top-off), or make a deliberate switch-off stick.
The second is a change to `billing.mjs` and I would want your word before touching the money engine.

## FOUND, pre-existing, not fixed in this wave

### L3. The auto-recharge retry schedule does not exist. [verified]

`billing.mjs` documents "it retries every few days for about a week, then stops trying", and
`nextRetryAt` is written and never read anywhere in the codebase. There is no cron, no boot sweep, no
timer. Recovery only happens opportunistically on the user's next metered turn, and a locked account
cannot chat, so after three failures the retry path is unreachable. The account stays locked until a
manual top-up, which is the safe direction, and the documented behaviour is fiction.

Worth its own small job. Not this one, because it is the money engine and unrelated to what you asked
for.

### L4. `credits.mjs` is dead code that contradicts the live money engine. [verified]

Imported by nothing but its own test. It keys accounts by uid where `billing.mjs` keys by email, uses
integer balances where the live one uses reals, disagrees on the retry count, and still contains the
`Math.ceil` minimum-spend rounding you explicitly overruled. Anyone reading it for the money model
learns the wrong model. It should be deleted or clearly marked, and deleting a file is your call.

### L5. Two shipped strings are stale and will make the app lie to a customer. [verified]

`idehelp.mjs` tells the builder AI that Video Generation is "Coming Soon; it is a promise, not a wired
feature yet", while the rail launches a complete Video Studio. Ask the builder about video and it will
say the wrong thing. Separately `features.mjs` says "30 of the 43 models carry the grant" and the
roster is 23 seats after the 2026-08-03 prune. Both are one-line fixes in someone else's file.

### L6. No bulk data export and no self-service account deletion. [verified]

`handleAccount` serves only get, redeem, consent and tutorial-seen. Altana now fields privacy and data
questions properly, including "delete my data", and the honest answer she gives is that it goes to you
personally. If those requests become frequent that answer stops scaling.

## CLOSED during the build

- **The carve-out modelled the wrong zone.** `buy_credits` was declared as crossing "billing"; the
  exclusion rules actually place it in "budgets" (`credits` is budget vocabulary). The load-time
  assertion caught it and the grant now names every zone a verb reaches. A single-zone grant would
  have been a real hole.
- **An amount-shaped argument passed the main wall.** `usd` is in no exclusion zone, correctly, so
  only the money module refused it. The check now also lives in `assertToolsetSafe`, keyed on the
  carve-out rather than the zone, so it cannot be lost by deleting one file.
- **The plain-English filter ate eight real answers.** Its guard for bare technical nouns tested for
  the same words the rule matched, so it always passed, and the word list contained the app's own
  interface vocabulary (`table`, `log`, `deploy`, `endpoint`). Narrowed to nouns with no user-facing
  meaning, guard removed, and the corpus sweep is now a permanent test over all 559 answers.
- **The filter also rewrote your price copy.** It softened "top-up" to "top-off", which changed
  "$12.50 is the smallest top-up" in shipped text. Only the identifier forms are softened now.
- **Softening ran before narration removal** and disarmed it: rewriting a tool's name destroyed the
  evidence that a tool was being narrated, so "I called the log_complaint tool and it returned ok"
  sailed through. Order reversed.
- **A data-loss report classified as `unknown`.** "all my work is gone" matched no cue, which demoted
  the most serious entry in the table to normal severity and a daily round-up instead of an immediate
  escalation. Cue list widened to the short panicked phrasings.
- **A disliked picture paged the owner.** "the image came out completely wrong" scored higher on
  `images-failing` (high severity, escalates) than on `image-wrong`, because the cue "no image came
  out" shares three words with it. Backwards in both directions and now fixed.
- **`severityOverride` accepted prototype keys.** `SEVERITY["constructor"]` is truthy, so a plan could
  be built with no escalation rule and no chase clock, silently. Now `Object.hasOwn`.
- **`escalationEmail(null)` threw**, taking down the one path that is supposed to reach you.

## Assumptions a reader should challenge

- `[assumed]` $500 ceiling (L1).
- `[verified]` The registry Altana receives is `filterToolDefs(toolDefs(), T.role, null)`, the same
  list this user's own chat gets. Measured: an owner is offered 60 and keeps 39, a credit user is
  offered 33 and keeps 28. Machine tools are deliberately excluded.
- `[verified]` 559 FAQ entries across 10 files, counted off disk by the test suite.
- `[verified]` Escalation mails only `OWNER_EMAIL`, and `escalationEmail` has no recipient parameter
  at all, so this is structural rather than a habit.
- `[assumed]` Google stays connected for the owner. If it is not, a ticket is still filed and still
  appears on the tickets screen; only the email is skipped, with a log line saying so.
