# Build Governance Audit — 2026-08-03

Fred's concerns from today's Agent Army build (the Jarvis/orb app), audited against the code that
is actually running: `iter/assistant-build-core`, served live by
`Z:\Apps\minipc-chat\assistant-build-core\server.mjs` (verified by process list). That branch
contains main plus every iteration branch (plan-fidelity, build-failure-banner, crucible-context,
progress-indicators all confirmed ancestors of HEAD).

Every claim below carries a file:line reference into this worktree. Nothing here is speculation
about what the code "probably" does.

---

## The headline verdict

**The wiring is real. The window into it lies.**

The dependency graph, the file-collision rule, the divider/referee, the ownership filter, and the
wave scheduler are all genuinely implemented and enforced server-side, with tests
(`idetasks.mjs`, `ideengine.mjs`, `idetasks` referenced from `server.mjs:4441-4495`). Fred's
suspicion that "much of the wiring is for show" is **wrong about the engine and right about the
display**. Three specific presentation defects — plus one real planning gap and one real
reliability gap — produced every symptom he saw. Each is itemized below.

---

## 1. "Why was the last step of quality control being done in the middle of the build?"

**It wasn't mid-build. The build was already over — the board just never said so.**

The "9 issues — fix or close" dialog is the **Furnace pass** (`server.mjs:4779-4859`,
`idelang.mjs:88-95`): the end-of-build honesty audit (placeholder sweep + vision-fidelity check)
whose findings "become a QUESTION, never a silent pass." It runs strictly after the task-graph
loop, the QC stage, and the look-at-it step.

What made it *appear* mid-build:

- When a task's model calls fail (the NVIDIA endpoint flakiness), the task is marked
  `hardFailed`, and every task depending on it is **silently skipped** — the scheduler emits only
  a log line ("Tasks N were skipped because a task they need did not finish",
  `server.mjs:4442-4447`). **No `move` event is ever emitted for skipped tasks, so their
  Blueprint rows stay "QUEUED (WAITING ITS TURN)" forever** (`public/dominion-lenses.js:54-77`
  only updates a row on a `move` event).
- So: tasks fail fast → dependents skipped → pipeline falls through to the Furnace in minutes →
  the user sees a final-QC dialog over a board that still claims most tasks are queued. The
  contradiction is a **display defect, not a sequencing defect**.

**Fix:** when a task is skipped or hard-failed, emit terminal `move` events (`state: "skipped"` /
`"failed"`) for its row and its dependents' rows, and raise the failure banner when
`hardFailed.size` crosses a threshold instead of proceeding to the Furnace as if wrapping up a
mostly-built app.

## 2. "Why would it ask if I want to fix it? Of course I do."

Two findings, one of them worse than the question implies.

- The ask is deliberate doctrine (2026-07-21, comment at `server.mjs:4780-4786`): findings become
  a question so the app never silently spends money or silently declares 60%-built apps done.
  That is defensible for the *accept-as-is* fork (it produces an honest `checkpoint`, not a fake
  `done`, `server.mjs:4850-4857`). But Fred is right that "fix" is the answer ~always. This
  should be a standing preference (auto-fix by default, ask only above a spend threshold), not a
  blocking modal on every build.
- **The bigger problem: the "Close them now" button cannot actually fix a failed build.** The fix
  is ONE combined move whose file list is capped at the first **12 already-written files**
  (`server.mjs:4788-4789`, `4838-4843`). After a mass task failure, the missing work is in files
  that were *never written* — the fix move cannot rebuild failed tasks, so saying "fix" after a
  failure like today's mostly burns a model call and reports "The Furnace findings remained after
  automatic repair." The dialog offers a remedy that is structurally too small for the situation
  that triggered it.
- Related gap: the task-graph path has **no per-task retry prompt** at all. The older AF-crew
  path asks "retry / skip / stop" per failed part (`server.mjs:4610-4626`); the task-graph
  runner, which is what runs now, accumulates failures and never offers retry. The right dialog
  after today's build was "9 tasks failed on a dead endpoint — retry them (on another model)?",
  and that dialog does not exist.

## 3. "I re-planned; I'm not confident it followed the tasks completed last time."

**Correct suspicion. The plan-panel replan is blind.**

- "Plan the tasks" posts only the goal text — `intake.messages[0].content` or the prompt box —
  to `/ide/tasks` (`public/dominion-ide.js:406-414`), which calls the orchestrator with
  `taskRoadmapMessages({ goal })` via `ideChatOnce(model, messages, {})` — **no workspace tools,
  no repository inventory, no ledger of the previous build** (`server.mjs:3592`,
  `idetasks.mjs:25-62`). For an adopted project the goal is the adoption brief, i.e. a snapshot
  of the repo **as of the adopt scan** — it knows nothing about what the failed build wrote
  afterward.
- The build itself is better: before building, a fresh deterministic repository inventory is
  scanned and injected into every planning/divider/review call (`server.mjs:4034-4061`,
  `3823-3831`). And an approved plan is never silently replaced (`server.mjs:4259-4288`).
- Net effect: **the roadmap you read, price, and approve is drawn without looking at the disk;
  the execution then faithfully runs that blind plan** (grounding reaches the divider and
  workers, but not the task list you approved). After a partial build, nothing feeds "tasks 1-2
  completed last run" into the new plan except whatever text happens to be in the brief.

**Fix:** ground `/ide/tasks` with the same `createAdoptScanner` inventory the build uses, and
append the previous job's ledger (done/failed/skipped task titles + written files) when the
workspace has a prior job journal. Both mechanisms already exist; they are just not wired to this
endpoint.

## 4. "I set 5 agents; it backed off to 2/1/3. After starting, the 3s became 2s."

**The backoff itself is honest and by design. The instability is real and has three causes.**

- Design: usable agents = number of **disjoint file-owning sub-parts** the divider+referee can
  find (`idetasks.mjs:176-203`, `server.mjs:3625-3652`). A 4-file task with interdependent files
  cannot host 5 agents under the cookie rule (no two concurrent units share a file). Forcing 5
  would either serialize them anyway or produce write collisions. The verdicts ("irreducible",
  "split into N pieces") are shown truthfully. This part is working as intended.
- Cause 1 — **every +/- click is a fresh paid, nondeterministic model call**
  (`public/dominion-ide.js:461-467, 505-522`). No debounce, no request cancellation: clicking
  2→5 fires overlapping `/ide/reduce` calls whose responses each mutate `p.agents` on arrival. A
  late response for an older click can overwrite a newer value. Walk away and responses keep
  landing.
- Cause 2 — **the preview verdict is not binding.** At build time each multi-agent task is
  re-divided from scratch by another fresh divider call (`server.mjs:4416-4435`). Same model,
  same prompt, different sample: a task previewed at 3 parts can legitimately come back 2. The
  Blueprint sub-rows (1.1, 1.2, 2.1, 2.2 = two parts per task) are the build-time verdict; the
  plan panel still shows the preview. Two dice rolls, two screens, no reconciliation.
- Cause 3 — group sync: tasks sharing a group tag mirror the first task's model+agents
  (`public/dominion-ide.js:427-432`), so one task's backoff propagates.

**Fix:** persist the accepted split (the actual parts, not just the count) into
`state.assignments.af` alongside `taskPlan`, and have the build **execute the previewed split**
instead of re-rolling — falling back to fresh division only when no stored split exists. This
also removes one paid divider call per multi-agent task per build. Debounce/abort the reduce
check.

## 5. "It started the last tasks first."

**It didn't. The board appended sub-tasks at the bottom and never touched the parents.**

Wave 1 was correctly tasks 1 and 2 (the only tasks with no NEEDS). Each was divided into 2 units
with **new ids** (`tg-1-1`, `tg-1-2`, `tg-2-1`, `tg-2-2`) and titles "1.1 …", "2.2 …"
(`server.mjs:4430-4435`). The Blueprint keys rows by move id and appends unknown ids in arrival
order (`public/dominion-lenses.js:66-77`) — so four new rows (13-16) appeared at the bottom
marked RUNNING while parent rows 1 and 2 **stayed QUEUED and will never leave that state**: no
event ever updates a divided task's parent row. Progress percent also divides by this inflated
row count (`dominion-lenses.js:320-333`), so the bar under-reports.

**Fix:** render sub-units nested under their parent row (the id prefix `tg-<n>-` makes the parent
derivable), and mark the parent "dividing → running → done" from its children's states.

## 6. "Why can't all tasks run at the same time and be wired at the end?"

Three real constraints, one real inefficiency, and one legitimate open design question:

- **The NEEDS graph.** The orchestrator model authors the dependencies (task 3 "after 1", task 12
  "after 3,4,5,7,8,9,10,11"), and the scheduler obeys them (`idetasks.mjs:131-140`). Today's plan
  hung almost everything off task 1 (types/config), so waves were roughly {1,2} → {3,4,6,9} →
  {5,7,8,10,11} → {12}. Note **nothing audits whether a declared dependency is real** — an
  over-cautious orchestrator silently serializes the build. "Wired at the end" is literally what
  task 12 is; the question is whether tasks 3-11 truly needed task 1 *finished* or just needed
  its type contracts, which could be stubbed first and satisfied in parallel. That is a genuine
  design frontier (contract-first parallelism), not something the current code pretends to do.
- **The cookie rule.** Two tasks sharing a file may not run together (`idetasks.mjs:110-124`),
  and workers' outputs are filtered to their owned files (`server.mjs:4471-4483`). This is real
  and is what makes parallel agents safe at all.
- **The wave barrier — the real inefficiency.** The runner executes discrete waves with a full
  join: `readyTasks(...)` is called with `running: []` and the loop `Promise.all`s the entire
  wave (`server.mjs:4441-4458`). The scheduler function already supports rolling starts (it
  accepts a `running` list and checks collisions against it, `idetasks.mjs:131-140`) — the
  runner just doesn't use it. One slow unit holds every satisfied-and-disjoint task out of the
  next wave. This is the cheapest large win available: convert the wave loop to a rolling pool.
- Within a wave there is **no concurrency cap** — all unit model calls fire at once
  (`server.mjs:4458`), which with flaky endpoints amplifies simultaneous failures.

## 7. The reliability root cause: no failover for worker calls

The build's model wrapper fails over **only on "out of funds"** — one hop, reported out loud
(`server.mjs:3852-3872`). A worker unit whose endpoint times out or 5xxes gets **3 same-model
retries** inside `runUnit` (`server.mjs:4358-4385`) and then the task hard-fails and takes its
dependents with it. The orchestrator seat has proper substitute-on-failure
(`server.mjs:3584-3616`); the workers — the seats that do 95% of the calls — do not. With NVIDIA
endpoints unreliable, this is exactly the mass-failure Fred watched.

**Fix:** extend the out-of-funds hop to transport failures (timeout / 5xx / empty response):
after N same-model failures, retry the unit once on `altKeyedModelFor(model)` or the strongest
same-tier model with a live key, with the same out-loud run-log line. Keep the user's pick for
the first attempts; never substitute silently.

## 8. Smaller honesty items found on the way

- **The whole-plan time estimate assumes zero parallelism** — `estimatePlan` sums every part's
  seconds ("wall seconds ADD", `idetelemetry.mjs:146-162`) even though model calls run in
  parallel waves and only writes serialize. The "18 min to 40 min" figure was a sequential
  worst-case shown without saying so. Either compute per-wave wall time from the NEEDS graph or
  label the number "if run one at a time."
- **Per-row EST TIME/COST ignores dependencies entirely** — fine for a per-task figure, but the
  column implies schedule information it doesn't have.
- The reduce preview spends real money per click with no visual accounting in the plan totals.

---

## Priority order (if Fred says go)

1. **Worker-call failover on transport failure** (§7) — converts endpoint flakiness from
   build-killing to a logged substitution. Small, contained in the `chat` wrapper.
2. **Truthful Blueprint states** (§1, §5) — skipped/failed rows go terminal; sub-units nest under
   parents; failure banner on mass hard-fail before any end-of-build audit.
3. **Ground `/ide/tasks` + feed the prior ledger** (§3) — replans stop being blind.
4. **Bind the previewed split; debounce reduce** (§4) — plan screen and build agree on agents.
5. **Rolling scheduler + concurrency cap** (§6) — more true parallelism, fewer thundering herds.
6. **Furnace auto-fix preference + post-failure retry dialog** (§2).

No code was changed in this audit. This worktree (`iter/build-governance-audit`) exists so any of
the fixes above can be built here without touching the running branch.
