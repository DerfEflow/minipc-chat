# Success criteria: Altana as a fully functioning assistant

## Mission line

Altana becomes an assistant a Dominion customer can actually rely on: she can reach every capability
that is not explicitly forbidden, she can answer roughly five hundred real questions about every
feature in the app and then DO the thing being asked about, she runs a real customer-service workflow
that ends in a reported issue and a follow-up, she can add credits and switch auto top-off on or off
when the user types the confirmation herself, and she never once shows a customer a line of code, a
file path or a technical excuse.

## Fred's amendment to the 2026-08-03 boundary, verbatim (2026-08-12)

> "altana should have access to anything that is not strictly forbidden"

> "I want altana to be able to add credits to the users account with explicit authorization from the
> user, and a 'please type the amount of credits you would like to purchase' field that it follows,
> as well as turn on and off the top-off feature for a user with their explicit instruction, with a
> 'type #####' to confirm field."

> "it should not respond with it actual technical actions, code, etc. It should ALWAYS respond in
> plain english, assuring the user it will be proactively working on the issue. and follow up when
> it is done."

This NARROWS the billing exclusion rather than deleting it. Two verbs cross the old wall, each
behind a value the user typed with their own hands. Everything else in the billing, budgets, PII,
secrets and IP zones stays shut.

## The rubric. Ship line is 4.

| # | Criterion | 1 (fail) | 4 (ship) | 5 |
|---|-----------|----------|----------|---|
| 1 | Breadth of access | Still the 8-tool allow-list | Deny-list model: she reaches app capability unless a named forbidden zone blocks it, and the forbidden list is enforced structurally, not by prompt | Every new tool added anywhere is reachable by her by default with no second registration |
| 2 | Question coverage | Under 500 entries, or gaps in a named surface | 500+ entries, every surface Fred named covered (image, video, app simplified, regular chat), no entry describing a feature that does not exist | Every entry retrievable by the real scorer at the real corpus size |
| 3 | Answers that act | Answers are prose only | An entry can carry an action, and asking the question offers to DO it | The action runs and reports the real outcome, never a claimed one |
| 4 | Customer service | log_complaint and nothing else | Ticket with a lifecycle, a library of canned responses mapped to issue types, escalation to Fred with the detail he needs, and a follow-up delivered to the user after resolution | Follow-up survives a restart and cannot double-send |
| 5 | Credits purchase | She cannot, or she can without a typed amount | User types the dollar amount, minimum enforced, she never sees a card, the charge runs through the app's existing payment path, and she reports the real result | A failed charge is explained in plain English with a recovery path |
| 6 | Top-off toggle | She cannot, or she flips it on her own judgement | User types a numeric confirmation code shown to them, and only that exact code lets the flip through | State reported back from the real setting, never assumed |
| 7 | Plain English | Code, paths, SQL or stack traces can reach the user | A structural filter strips technical content from every reply before it is sent, and she states she is working the issue and will follow up | Filter is measured against real technical strings and the test proves each class is caught |
| 8 | Honesty of outcome | She claims success she cannot see | Every claim of completion traces to a real result from the real subsystem | A failure is reported as a failure, in plain words, with what happens next |

## Abort conditions

- The payment path cannot be driven server-side for an existing customer without a card being
  entered again. Then the typed-amount field hands off to the app's own checkout and Altana reports
  the handoff. She never collects card details. This is a design change, not a failure, and it gets
  written into the ledger rather than worked around.
- Auto top-off turns out to be structurally required rather than optional. Then "turn it off" is
  refused in plain words with the reason, and Fred is asked, because a user told "done" about a
  thing that is still on is the exact class of defect this build exists to remove.
- `assertToolsetSafe` cannot be widened without deleting the wall. Then stop: the exception must be
  a named, auditable carve-out, never a removed check.

## What "done" is not

Done is not "the code is written". Done is: the test suite is green, the deploy is verified by
commit SHA rather than by boot time, and Altana has been asked live to buy credits, to toggle
top-off, to answer a question from each surface, and to file an issue, with the escalation and the
follow-up observed.
