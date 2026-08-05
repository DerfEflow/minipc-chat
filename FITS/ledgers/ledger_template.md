# LEDGER: {{project}}

Mission line: {{verbatim}}

> One law: the executor writes to the ledger INSTEAD OF pretending it knows.
> A placeholder plus a ledger entry is correct behavior. A silent guess is a
> failure. Reviewed at every advisor call, every final review, and before every
> "done" claim. A "done" claim with unexplained OPEN high-impact entries is
> fake completion by definition.

## MANDATORY-WRITE RULES — create an entry when you:
1. Invent any value (price, rate, name, path, limit) → GUESSED; mark the value PLACEHOLDER in the artifact.
2. Rely on a fact you cannot cite to the handover, the user, or a verified observation → MUST-VERIFY.
3. Narrow, reorder, or defer anything the task asked for → RISK-DECISION.
4. Skip a verification you couldn't perform → MUST-VERIFY, with user-runnable steps.
5. Hit attempt #2 failing on the same subgoal → BLOCKER, with state snapshot.
6. Find two requirements in conflict → AMBIGUITY; pick nothing silently.
7. Need credentials, access, or an external system → ACCESS-NEEDED / EXTERNAL-SYSTEM.
8. Make a call a reasonable owner might reverse → HUMAN-JUDGMENT.
9. Catch yourself writing "should work," "probably," or "standard practice" near anything load-bearing → entry, then rewrite the sentence.

Types: MISSING-INPUT · ASSUMPTION · BLOCKER · AMBIGUITY · RISK-DECISION ·
DEPENDENCY · EXTERNAL-SYSTEM · ACCESS-NEEDED · QUESTION-USER · QUESTION-FABLE ·
QUESTION-EXECUTOR · MUST-VERIFY · GUESSED · HUMAN-JUDGMENT
Owners: USER · FABLE · EXECUTOR   Status: OPEN · RESOLVED(<how>) · ACCEPTED-RISK · SUPERSEDED

## OPEN (ranked by impact)
| ID | Date | Type | Item | Impact if unresolved | Owner | Status |
|----|------|------|------|----------------------|-------|--------|
| L-001 | {{date}} | {{TYPE}} | {{item}} | {{impact}} | {{owner}} | OPEN |

## RESOLVED / ACCEPTED
| ID | Date | Type | Item | Resolution |
|----|------|------|------|------------|
