# TASK: {{short_name}}

Mission line (verbatim from handoff): {{one_sentence}}
Status: OPEN | IN-PROGRESS | BLOCKED | DONE
Risk rank: {{1 = highest — run highest first}}
Executor class: {{strong-reasoner / fast-coder / drafter / local / critic}}
Companion files: handoff: {{path}} | wargame: {{path}} | ledger: {{path}}

## Objective
{{What this task produces, stated as the artifact + its verifiable endpoint.
Bad: "set up the backend." Good: "POST /estimate returns priced line-item JSON
for tests/sample_input.json, totals hand-reconciled."}}

## Inputs
- {{input}} — source: {{where}} — tag: [verified]/[user-stated]/[assumed]/[guessed]

## Steps (to first verifiable checkpoint only — outline beyond)
1. {{step ending in a checkable state}}
2. {{...}}
Outline beyond checkpoint: {{bullets}}

## VERIFY (gates the DONE claim — run these, record actual observations)
- [ ] {{exact check / command / reconciliation}} → expected: {{obs}} → actual: ______
- [ ] {{edge case check}} → expected: {{obs}} → actual: ______

## Scope guard
Explicitly IN: {{...}}
Explicitly OUT (pre-agreed): {{...}}
Anything else dropped must be disclosed in the final report + ledgered.

## Stop lines specific to this task
- {{condition}} → {{action}}

## Completion note (fill at DONE)
Outcome: {{what exists, where}}
Evidence: {{paths to proof}}
Ledger entries opened/resolved: {{IDs}}
