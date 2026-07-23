# Long-Run Harness SOW

Status: rev B, LOCKED 2026-07-22 (Fred answered Q1-Q4; decisions recorded at the bottom).
Build state (2026-07-23): items 1-3 + resume(6) + prose screens(4) LIVE as the spine
(longrun.mjs, 785ebc4). Item 5 built this session under full FITS (longrunbilling.mjs +
/jobs approve-tranche; pack at docs/LONGRUN-BILLING-FITS.md). Companion floor already
shipped: forge_read honest paging. NEXT per Fred's sequence: real callUnit glue, item 7
chat surface, job creation endpoint, then the acceptance rite below.

## Mission

Dominion can run a single task for 36 hours straight, on any model in the catalog, without
producing gibberish, without looping forever, and without losing work to a crash, while every
read and write stays honest at every level.

## The problem in one paragraph

Long work fails three ways: the model's context degrades over hours until output drifts or
repeats (gibberish); the model gets stuck retrying the same step with no one watching (endless
loop); or the run dies at hour 20 and everything evaporates (fragility). Time limits and size
caps fix none of these. A loop wastes the whole window before a 36-hour timeout trips, and size
caps kill legitimate work while loops stay under them. The cure is measuring progress, keeping
each step small and verified, and keeping all real state outside the model's head.

## Design principles (carved over the door)

- Bounded step, unbounded total. No cap on how much work a job does; hard bounds on each step.
- State lives on disk, never in the model's context. Any worker can die and be replaced.
- Progress is measured by code, never self-reported by the model.
- Every guard fails loud and honest, in the user's register. No silent anything.
- One conversation never runs for hours. Segments with fresh contexts, always.

## Scope items

### 1. Job Ledger
An append-only file per job (`/data/<tenant>/jobs/<id>/ledger.jsonl`). One line per completed
work unit: what was attempted, what was produced (paths, sizes, checksums), tokens spent,
outcome. The ledger IS the job's memory: segments read it to know where they are; nothing else
is trusted. Owner-visible in the UI as a plain progress log.

### 2. Segment Runner
Code (no model) owns the outer loop. It cuts the job into work units, hands each unit to a
fresh model context carrying only: the mission line, the relevant ledger tail, and the files it
needs (paged). Collects the result, validates (item 4), appends to the ledger, moves on.
Foundation exists: the AF crew pipeline already does divider/worker/referee with contracts and
sequential writes. This generalizes that engine to arbitrary long jobs and lets it run for
hours.

### 3. No-Progress Watchdog
Deterministic checks between steps:
- Fingerprint repetition: same tool + same args + same result N times in a row = loop. Halt the
  segment, report which step wedged.
- Stall clock: no new ledger line in 20 minutes (Fred's number, configurable per job) = stalled.
- Same-error repetition: two failures of the same subgoal = stop and classify (Fred's own
  two-strike rule, enforced in code).
The kept-promise guard proved this pattern at turn level; this is the same idea at job level.

### 4. Output Validators
Nothing enters the ledger as done on the model's say-so:
- Code: parses, and the project's own check command reruns green (Furnace rule, automated).
- Data: schema-checks.
- Prose: degeneration screens; n-gram repetition ratio, length sanity, encoding sanity. Looping
  models repeat phrases at rates humans never hit; that is measurable in code for free.
- Optional cheap-judge: every Nth unit, a small model answers one question: coherent and
  on-task, yes or no. Off by default; per-job flag.
A failed validation retries once with the failure shown. Second failure pauses the segment and
flags the ledger honestly.

### 5. Budget Circuit Breakers
Each segment carries a token/dollar fuse sized so a runaway trips in minutes. Tripping pauses
and reports; it never kills the job. Resume = approve the next tranche (owner can preapprove N
tranches up front for genuinely long jobs). Rides the existing per-turn metering and billing.

### 6. Checkpoint and Resume
Every segment boundary is a durable checkpoint (ledger flush + snapshot id from the hands
node's existing beforeMutation machinery). A crash, a Railway redeploy, or a power blip costs
one segment, never the job. `job resume <id>` rebuilds the runner's state purely from the
ledger. Provider 429s/timeouts inside a segment retry with backoff instead of dying.

### 7. Honest Surfacing
Progress beats into the chat in the user's register (the v93 conversation-surface manners):
what segment, what got done, what it cost so far. Completion runs the Furnace pass: delivered
vs gap against the mission, no fake done. A paused/tripped job says exactly why and what
resuming takes.

## Already on the shelf (reused, never rebuilt)

- AF crew pipeline: segmenting, contracts, referee, sequential writes (item 2's engine).
- Kept-promise guard: the fire-on-meaning pattern (item 3's ancestor).
- Hands-node snapshots + forge_rollback: item 6's substrate.
- Billing/metering: item 5's meter.
- Furnace doctrine + idehelp: item 7's voice and honesty rules.
- forge_read paging (shipped with this SOW): bounded honest reads at any file size.

## Out of scope (this SOW)

- The racing variant (N agents same step, judge picks) stays a later addition.
- L-8 vision judge continuous run: separate ledger item, unchanged.
- Multi-machine segment scheduling (all segments run through the job's chosen hands node).

## Decisions (locked 2026-07-22, Fred's answers to rev A's questions)

- D1. Stall clock default: **20 minutes** (Fred's call), configurable per job.
- D2. Budget tranches: guest default **$1 per tranche, hard ceiling $2**; a guest can
  preapprove up to 10 tranches at job submit. Owner default $5 per tranche, preapproval
  unlimited. The tranche is a fuse, never a job cap: cheap models burning $1 slowly is the
  system working, and a paused job resumes with one approval. Amounts are Claude's suggestion
  inside Fred's "never exceed ~$2 for guests" rule; changing them later is a one-line edit.
- D3. Cheap-judge model: **qwen3-vl** (already the OCR workhorse; same wallet, known pricing).
  Stays off by default, per-job flag.
- D4. Scope: **Crucible builds AND long chat tasks.** A plain chat ask ("review this whole
  app") can be promoted to a job and gets the same ledger, watchdog, validators, and fuses.
  The chat is the surface either way, per the v93 ruling.

## Acceptance (ship line)

A deliberately sabotaged 3-hour test job (a worker forced to loop at unit 7, a validator fed
repeated text, a mid-run process kill) survives all three: loop halted within the stall window
with an honest report, gibberish caught at the unit level, resume completes from the ledger
with zero lost units. Then one real overnight job, watched.
