# The learning loop (2026-08-08)

One tap under any answer teaches Dominion something durable. Fred reviews what it learned before it
reaches anyone.

## The shape

```
guest presses 👍 / 👎
        │
        ├─ daily gate (10 positive + 10 negative, per guest, per day) ── over? stop here, no model call
        │
        ├─ Claude Opus 5 distils ONE standing lesson from that turn   ── billed to Fred's key
        │
        └─ queued, scope "user" ──► Fred: Approve / Deny / Decide later
                                          │
                                          └─ approved ──► that account's system prompt

Fred presses 👍 / 👎        ──► distilled, applied to his account immediately (no queue)
Fred presses Critique      ──► adversarial COMMUNICATION review + lesson, queued scope "global"
Fred presses Inspect       ──► adversarial TECHNICAL review + proposed fix + lesson, queued "global"
                                          │
                                          └─ approved ──► his account AND every guest
Inspect ▸ "Fix & deploy"   ──► confirm dialog ──► Claude Code work order (Command Deck bridge)
```

## The three rules the code exists to enforce

1. **The review queue carries no identity.** Fred: "I dont need to know any identifiable info about
   the user, just the distillation and why the distillation makes a difference." Enforced in three
   places, because one is a typo away from a leak:
   - `feedback.pending()` reads a SQL projection with **no `uid` column in it at all**;
   - `deidentify()` scrubs emails, phone numbers, Windows paths and URLs out of whatever the model
     wrote, before it is stored;
   - every distillation prompt is told to write lessons that make sense to someone who never saw the
     conversation.

   `feedback_test.mjs` asserts the queue payload contains no uid and no `@`.

2. **The guest never pays for the judge.** The distillation is a plain server-internal call on
   `ANTHROPIC_API_KEY`. It never enters the chat pipeline, so it never reaches `meterTurn()` and
   cannot bill a guest. The gate is checked **before** the model call, so a rate-limited tap costs
   nothing either.

3. **Nothing reaches a prompt without a decision.** A guest's lesson applies to that guest only.
   Fred's critique/inspect lessons apply globally — his ruling — but only after he approves them.

## Where things live

| Thing | Where |
|---|---|
| Store, rules, prompts, distiller | `feedback.mjs` |
| Tests (18) | `feedback_test.mjs` |
| Routes | `server.mjs` → `handleFeedback()` |
| Prompt injection | `server.mjs`, beside the `flywheel.activeRules` system message |
| Buttons + review panel | `public/app.js` (`teachFromMessage`, `critiqueMessage`, `openFeedbackReview`) |
| Styles | `public/dominion-feedback.css` |
| Data | `<data>/feedback/feedback.db` + `distillations.md` |

## Routes

| Route | Who | What |
|---|---|---|
| `POST /feedback/react` | anyone signed in | a thumb; gated, distilled, queued (or applied, for Fred) |
| `POST /feedback/report` | owner | critique / inspect adversarial review |
| `GET /feedback/pending` | owner | the anonymous queue + recent decisions |
| `POST /feedback/decide` | owner | approve / deny / later |
| `POST /feedback/dispatch-fix` | owner | queue a Claude Code work order; **requires `confirm: true`** |
| `GET /feedback/file` | owner | the compiled `distillations.md` |

## Config

| Env | Default | Notes |
|---|---|---|
| `FEEDBACK_MODEL` | `claude-opus-5` | the distiller |
| `FEEDBACK_EFFORT` | `medium` | Opus 5 is strong at this task at medium; raising it spends more for little gain |
| `FEEDBACK_DAILY_LIMIT` | `10` | per guest, per kind, per day |

## Opus 5 notes that are load-bearing

`anthropicmessages.mjs` had to learn `claude-opus-5` as an **adaptive-thinking** model. Without that
entry it fell through to the "other" branch, which is the only branch that forwards `temperature` —
and Opus 5 rejects `temperature`, `top_p` and `top_k` outright with a 400. Thinking is on by default
on Opus 5 and `max_tokens` caps thinking *and* text together, so the distiller asks for 8,000. A
safety classifier can decline with a normal HTTP 200 and `stop_reason: "refusal"`, so the distiller
checks that **before** reading content.

## What was removed

The per-message **Save lesson** (💡) and **Create evaluation** (🧪) buttons. Both asked the reader to
do the distilling by hand; the thumbs do it with Opus 5 instead. Their server routes (`/ledger`,
`/evals`, `/rules`) are untouched and still drive the Mentor & Improvement panel.

## The one control that ships code

`Fix & deploy` on an Inspect card queues a real work order on the existing Command Deck bridge — the
same rail as the `claude_work_order` tool, which snapshots before it changes anything and is
rollback-able from the Forge. It is owner-only, it refuses without `confirm: true` (so a mis-click
cannot dispatch a deploy), and with no `SYNC_SECRET` configured it says so rather than reporting a
success that never left the building. The work order tells Claude Code to **verify the finding
against the real code first** — the review read one answer, not the repository, so the proposed fix
is a hypothesis rather than an instruction.
