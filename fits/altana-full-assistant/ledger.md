# Ledger: Altana full assistant, 2026-08-12

Placeholders, assumptions and things found on the way that are not mine to decide. An OPEN
high-impact item left unexplained is fake completion, so everything below is either closed or
addressed to Fred by name.

## CLOSED BY FRED, 2026-08-12

### L1. The purchase ceiling. [user-stated] RESOLVED at $200

I proposed $500; Fred chose $200, which is the tighter and better answer. It is twice the largest
tier the app sells, so every real purchase fits with room over, and a slipped zero on any tier from
$25 up now lands outside and is refused in plain words.

Stated honestly and pinned in a test so nobody later believes otherwise: a ceiling only catches a slip
that lands ABOVE it. $12.50 typed as $125 is a tenfold error and still an ordinary purchase, so
nothing can refuse it without also refusing a real customer buying $125 of credits. That case is
caught by the user reading the confirmation, which states the dollars and the credits before anything
is charged.

### L3 (was open). The auto-recharge retry. RESOLVED, and it was worse than I reported

Reading it properly before touching it turned up a second defect the first report missed, and the
second one is the one that was hurting customers.

**Reported:** `nextRetryAt` written on every failure and read by nothing, so nothing ever retried.

**Also true, and worse:** `meterTurn` calls `autoRecharge` on EVERY low turn, and `autoRecharge` had
no idea a retry was already scheduled. A customer whose card was declining was therefore charged three
times inside a couple of minutes and locked almost immediately, instead of over the documented week.
Three declines in quick succession is also exactly what card issuers penalise, so the app was hammering
a card it had already been told no by, and burning the customer's whole retry allowance before they
could react.

Both halves landed together, because the backoff alone means nothing ever retries and the sweep alone
leaves the hammering in place. `autoRecharge` now honours its own retry time, and an hourly sweep acts
only on accounts whose retry time has passed. Bounded per run so a backlog cannot stampede the
provider; off on Windows and in every e2e suite so no test or dev box can charge a card; and it
refuses anyone who switched auto-recharge off, has no saved card, or is already locked.

`billing_test.mjs` had a test pinning the old rapid-fire behaviour. Updated rather than deleted, with
a new test asserting the burst cannot happen.

### L5 (was open). The two stale strings. RESOLVED

`idehelp.mjs` told the builder AI that Video Generation was "Coming Soon; a promise, not a wired
feature yet" while the Video Studio shipped complete, so the app was telling paying customers that a
feature they can open does not exist. Worth noting HOW it survived: `GUIDE_MUST_MENTION`, the keep-up
rule that exists to stop the guide drifting, listed "Coming Soon" and was holding the stale sentence
in place. The roll-call now pins "Video Studio" instead.

`features.mjs` said "30 of the 43 models carry the grant" against a 27-seat catalog of which 16 are
grant holders, wrong in both halves for nine days. It is now counted from the catalog it describes, so
the next prune corrects it without anyone noticing it needed correcting.

### L2 (was open). A deliberate switch-off now sticks. RESOLVED

Fred: "yes it should". `billing.grantSession` used to re-arm auto top-off on every paid session,
unconditionally, and the comment called it mandatory. So a user could ask Altana to switch it off, be
told plainly it was off, buy credits an hour later, and have it silently back on with nothing said.
The app reported one state and held another, which is the shape of defect this whole project keeps
finding.

A purchase still ARMS it for anyone who has never touched the switch, because a long job dying at the
balance floor is a worse experience than a top-up nobody minded. It no longer overrides an explicit
no. The opt-out is a separate column from `autorecharge` on purpose: "not running right now" is also
true of an account that has never bought anything, and only "a human turned this off deliberately"
should outrank a purchase. It defaults to off, so no existing account changes behaviour until its
owner next uses the switch.

Turning it off still costs the user video generation and the full Engineer view, because both gate on
it, and she states that before they type and again in the result. She now also says "and it stays
off", which is a promise the app can finally keep. A test in `billing_test.mjs` was pinning the old
contract and is updated rather than deleted.

### L4 (was open). `credits.mjs` is deleted. RESOLVED

Fred: "delete it". Removed along with `credits_test.mjs`, its only importer anywhere in the codebase.
It disagreed with the live ledger about the account key, the balance type and the retry count, and
still carried the `Math.ceil` minimum-spend rounding Fred had explicitly overruled. Anyone reading it
for the money model learned the wrong one. `billing.mjs` is now the only money engine in the app.

## MEASURED, no decision needed

### L2b. What the breadth costs, measured. [verified]

Her fixed input per turn is now about 6,500 tokens: roughly 1,470 for the system prompt and 5,040 for
43 tool schemas, up from about 810 when she held eight verbs. On Luna at $0.20 per million that is
$1.30 per thousand turns, and the widening itself accounts for $0.85 of it.

Worth knowing rather than worth acting on. It is also now a stable prefix well over the 1,024-token
threshold where OpenAI's automatic prompt caching applies, so the real billed figure should be lower
than the arithmetic above. I have not measured the actual cached fraction on the live seat, and
`cacheprobe.mjs` is the tool that would settle it if you want the true number.

## FOUND, pre-existing, not fixed in this wave

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
