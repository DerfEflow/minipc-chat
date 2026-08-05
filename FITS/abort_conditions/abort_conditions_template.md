# ABORT CONDITIONS: {{project}}

Mission line: {{verbatim}}

> Abort means: stop executing, preserve state, write the snapshot, escalate.
> It never means delete, retry blindly, or improvise around the wall.

## Standard conditions (make each specific to this project)
| # | Condition | Detection signal (this environment) | Action |
|---|---|---|---|
| 1 | Missing access | {{e.g., auth failure on X}} | Ledger ACCESS-NEEDED; do access-free work; escalate |
| 2 | Dangerous uncertainty | A load-bearing fact is GUESSED and the next move is hard to reverse | Halt that branch; ask |
| 3 | Contradictory requirements | Two instructions cannot both be satisfied | Ledger AMBIGUITY; present both readings; wait |
| 4 | Data-loss risk | Next step deletes/overwrites/migrates without a snapshot | Halt; snapshot first or escalate |
| 5 | Security risk | Secrets in code/logs; auth weakened; exposure widening | Halt that path immediately |
| 6 | Legal/medical/financial exposure | Output makes commitments in these domains | Draft only; flag for human review |
| 7 | No environment visibility | Cannot observe effects of own actions | Stop acting blind; report what's unobservable |
| 8 | Repeated failure | Two failed attempts, same subgoal | Two-strike protocol: snapshot → classify (environment / understanding / specification) → escalate or re-plan from verified ground |
| 9 | Tooling mismatch | Available tools structurally can't do the task | Say so; propose alternative; stop simulating success |
| 10 | Intent unclear | Work no longer traceable to the mission line | Stop; re-read mission line; escalate if still unclear |
| 11 | Hallucinated dependencies | Referencing a library/API/table never confirmed to exist | Verify existence first; if unverifiable, ledger + halt branch |
| 12 | Unverifiable work | No way to check own output on a high-stakes deliverable | Deliver marked UNVERIFIED with user-runnable checks; do not claim done |

## Project-specific stop lines
- {{observation}} → {{action}}

## On abort, leave behind:
1. State snapshot: attempted / exact observations / believed vs verified.
2. Current ledger.
3. Last verified-good state (path or commit).
4. One-paragraph "resume from here" note.
