# FITS Pack: Long-Run Harness Item 5 (Budget Circuit Breakers, real billing)

Status: OPEN, build in progress 2026-07-23. Blast radius: HIGH (money, guest-facing policy,
push-deploys-to-prod). Full FITS per Fred's sequencing at the end of the 07-22 session.

## Mission line

A long-run job spends real money only inside tranches its owner approved, trips its fuse in
minutes when spend runs away, pauses honestly instead of dying, and resumes with one approval,
with every dollar traceable in the existing billing ledger.

## Four-layer read

1. Literal ask: wire the `budget` dep in longrun.mjs (today a stub returning Infinity) to real
   credit/sponsored billing, with D2 tranche policy.
2. Intent: Fred wants 36-hour jobs that cannot surprise anyone on cost: a guest can never wake
   up to a drained card, and a runaway loop burns cents before tripping.
3. System: rides billing.mjs (chargeTurn, autoRecharge, floor-at-zero) and users.addSponsoredSpend.
   Never invents a second money path. The billing sqlite ledger stays the money record; the job's
   budget file is job-scoped accounting only.
4. Future: the next phase (model glue + job creation endpoint + chat surface) consumes this as
   `makeRunDeps()`; nothing here should need rework when real callUnit arrives.

## Load-bearing facts

- [verified] longrun.runJob checks `budget.remaining() <= 0` BEFORE each unit and pauses with an
  honest reason (longrun.mjs:176). The fuse pauses, never kills.
- [verified] billing.chargeTurn(email, costUsd) deducts ceil(cost x 100) credits, min 1, floors
  the balance at zero, and writes the billing ledger (billing.mjs:134).
- [verified] Sponsored users draw Fred's cap via users.addSponsoredSpend(email, usd); the account
  pauses at the cap (meterTurn, server.mjs:1170).
- [verified] Owner turns are never metered (meterTurn returns early; same law applies here).
- [verified] /jobs rides the per-tenant resolver (T.longrun) on BOTH branches (tenantstores.mjs).
- [user-stated] D2 (SOW, locked): guest tranche default $1, hard ceiling $2, up to 10 tranches
  preapprovable; owner default $5, preapproval unlimited. The tranche is a fuse, never a job cap.
- [assumed] A unit is the billing analog of a turn, so chargeTurn's min-1-credit rounding applies
  per unit. On a 500-unit job this over-rounds by at most $5 total and usually far less; the
  batch-settle creditBack pattern exists if Fred ever wants exact settling. -> ledger item B-2.
- [assumed] Failed/invalid unit attempts still spent provider tokens, so their reported cost is
  charged and counted against the tranche at result time, before validation. Honesty rule: the
  fuse measures money actually gone, not money that produced keepable work.

## Success rubric (ship line = grade 4)

1. Policy: clamps exactly to D2 for guest and owner roles; defaults applied when unspecified.
2. Durability: budget state folds from an append-only budget.jsonl in the job dir; a process
   kill between spends loses nothing; a fresh instance reads the same remaining().
3. Integration: runJob with the real budget dep pauses at exhaustion with the existing honest
   message, and approve-tranche + resume completes the job. Proven by test, not inspection.
4. Money: credit users' unit costs land in the billing sqlite ledger via chargeTurn (visible in
   their existing ledger view); sponsored spend draws the cap; owner is never charged.
5. Gate: a zero-balance credit user cannot approve a tranche (402 at the endpoint).
6. Full existing suite green, run by me, not by a sub-agent's say-so.
7. No UI shell change, no sw.js bump, no billing.db schema change, no new env vars.

## Wargame (risky moves only)

- W1 Runaway spend between fuse checks: the fuse is checked per unit, so one unit's cost is the
  max overshoot. Unit costs are bounded by the per-call token caps already in the chat path; a
  $1 tranche trips within minutes of a runaway. Accepted per SOW ("sized so a runaway trips in
  minutes").
- W2 Double-charge on crash: charge happens once at result time; the budget spend line appends
  in the same tick. If the process dies between chargeTurn and the append, the tranche under-
  counts by one unit's cost while the billing ledger is correct: money is never double-taken,
  and the fuse errs toward tripping later by one unit at most. Chosen over the reverse order
  (append first) because the billing ledger is the record that must never overstate.
- W3 Guest overdraw via floor-at-zero: chargeTurn floors at zero, so spend past the balance is
  unbilled. Mitigation: approve-tranche requires balance covering the newly approved value for
  credit users; the turn-scale gate (canChat) still guards the chat path. Residual: within one
  approved tranche a balance can hit zero mid-job; overshoot is bounded by tranche size ($2 max
  for guests). Recorded as accepted risk B-1.
- W4 Concurrent approvals (two devices): approvals append; the guest outstanding-tranche cap is
  enforced at fold time, so double-submits clamp instead of stacking past 10.
- W5 Wrong-tenant charging: budget/meter helpers take T from the resolved tenant at request
  time, never from job meta, so a job can only ever charge the account whose directory it lives
  in (per-uid job dirs, tenantstores law).

## Abort conditions

- Any test in the existing suite goes red and the cause is not my new code: stop, snapshot,
  classify, report (two-strike rule).
- The change would require touching billing.db schema or Stripe flows: out of scope, stop.
- Deploy shows the Railway "no associated build" signature: platform-side, wait 20 min, one
  re-upload, check deployments list first (07-22 lesson).

## Ledger

- B-1 OPEN (accepted risk): mid-tranche zero-balance overshoot bounded by tranche size (W3).
- B-2 OPEN (accepted): min-1-credit rounding per unit; batch-settle exact refunds are a later
  nicety if Fred wants them.
- B-3 CLOSED 07-23: glue phase built (below).

## Addendum: the glue phase (same day, Fred's option 2)

Scope shipped: longrunglue.mjs (unitMessages fresh-context packs, makeCallUnit with the
meter-at-result law, sealInterrupted boot sweep), the runner registry + startLongRun in
server.mjs, /jobs ops create/start (+ resume now restarts the driver), cooperative pause at
the unit boundary in the spine, the long_job chat tool (both doors share longrunCreateFor so
the money gates cannot drift), SAFE_TOOLS entry, the feature-map entry for app_help, and push
wakeups on paused/halted/done.

Wargamed moves:
- W6 double-run: one driver per job per process (LONGRUN_ACTIVE map keyed by job dir); a second
  start answers "already running". The spine's sequential-append law stays unbroken.
- W7 spend without metering: impossible by construction: the ONLY callUnit the server ever
  builds wires deps.meter inside makeCallUnit; errored calls that reported cost still meter.
- W8 restart honesty: boot sweep seals "running" corpses to paused with the true reason, global
  store at boot, tenant stores at first touch; proven by a genuinely stranded runJob in test.
- W9 pause tearing a unit: pause lands at the next unit boundary; the in-flight unit completes
  and counts (bounded-step law). Proven in longrun_test.
- W10 chat-door drift: the tool and the endpoint call the same longrunCreateFor; there is no
  second copy of the gates to rot.

Found in passing, fixed ahead of this work (commit b0e8adf): sponsored spend NEVER drew Fred's
monthly cap in live prod: meterTurn, meterOcr, and the image creditBack all called an
undeclared `users`, and the ReferenceError died in silent catches. All three now call
usersStore. Lesson for the FITS system: a silent catch around money is a bug amplifier; the
catch must at least count.

Remaining rite (unchanged): a deliberately sabotaged 3-hour job, then one real overnight job,
watched. The short live probe (a two-unit real job on a cheap model, owner account) ships with
this phase to prove the glue against a real provider.
