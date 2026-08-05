# LEDGER: guest-trust
Mission line: *Stop Dominion charging guests for work it cannot deliver: every model a guest can pick is proven working, every build runs its tools correctly, and the build view survives a dropped connection.*

Branch: `iter/guest-trust` (worktree `Z:\Apps\minipc-chat\guest-trust`, off `origin/main` @ `946c14e` = deployed)
Opened: 2026-08-05

| ID | Date | Type | Item | Impact if unresolved | Owner | Status |
|----|------|------|------|----------------------|-------|--------|
| L-001 | 2026-08-05 | MUST-VERIFY | "forge_run path quoting is broken" — the premise of work item 1 | Would have built a fix for a bug that does not exist | EXECUTOR | RESOLVED(disproved — see L-002) |
| L-002 | 2026-08-05 | RISK-DECISION | Real defect is a pathological task split, not quoting. Job `ide_5184628f-a67` split 5 sequential tasks onto one file `src/main.js`; tg-2 wrote the complete 10,807-byte file; tg-3 then failed the "did an owned file change?" gate twice with "No owned file changed." | The guest paid $0.235 across 4 model calls and received an incomplete build | EXECUTOR | OPEN |
| L-003 | 2026-08-05 | HUMAN-JUDGMENT | Should a guest be billed for a task that fails the owned-file-changed gate, and for its retry? Currently they are (tg-3 billed $0.097 then $0.024). | Money. Guests pay for provably zero output. | USER | OPEN — asked 2026-08-05 |
| L-004 | 2026-08-05 | ASSUMPTION | `runShell` on the hands node is quoting-safe on Windows (uses PowerShell `-EncodedCommand` with UTF-16LE base64) and on Linux (`sh -c` with the string as a single argv). Falsifiable: pass a path containing spaces and a `$`. | If wrong, item 1 has a second real cause I dismissed | EXECUTOR | OPEN — verify by test |
| L-005 | 2026-08-05 | ASSUMPTION | `withinRoots`/`underAny`/`norm` handle spaces correctly (`resolve()` + `sep`-boundary containment). Read, not run. | If wrong, guest builds under `C:\App Builds\...` fail at the root gate | EXECUTOR | OPEN — verify by test |
| L-006 | 2026-08-05 | ASSUMPTION | The 28 `/ide/job/attach` stream cancellations in a 4-hour window are Cloudflare tunnel drops, not server-side EOF. Falsifiable: a resumable attach should reduce replayed bytes even if the drop count is unchanged. | Item 2 may fix a symptom whose cause lies in the tunnel config | EXECUTOR | OPEN |
| L-007 | 2026-08-05 | MUST-VERIFY | NVIDIA seat latency measured from this laptop, not from Railway (sfo). Network path differs. | Seats judged dead may be healthy from the deployed region | EXECUTOR | OPEN — re-probe from the container before pruning |
| L-008 | 2026-08-05 | AMBIGUITY | "100% working and tested" needs an operational definition before it can gate a picker. Proposed: a seat is guest-eligible only with a recorded probe within N days showing (a) it answers, (b) time-to-first-token under a bar, (c) a real tool call if the seat is tool-facing. N and the bar are unset. | Without a number this is unenforceable and drifts back to vibes | USER | OPEN — proposal below, needs Fred's numbers |
| L-009 | 2026-08-05 | ACCESS-NEEDED | Deploy is a push to GitHub → Railway. Standing rule says never push without Fred's say-so, and `ops/prepush-check.mjs` refuses a deploy that would seal a live build. | Work sits unshipped | USER | OPEN |

## Measured evidence (2026-08-05)

NVIDIA free-lane time-to-first-token, streaming, 4 samples each, from this laptop:

| Seat | ttft samples | Verdict |
|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | 0.4 / 0.4 / 0.7 / 0.8s | healthy |
| `nvidia/nemotron-nano-12b-v2-vl` | 0.3 / 0.4 / 0.4 / 0.5s | healthy |
| `nvidia/nemotron-3.5-content-safety` | 0.3 / 0.3 / 0.5 / 0.8s | healthy |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 0.4 / 0.5 / 0.6 / 1.1s | healthy |
| `openai/gpt-oss-20b` | 0.5 / 0.8 / 3.1 / 3.9s | marginal |
| `nvidia/nemotron-3-ultra-550b-a55b` | 0.8 / 7.5 / 8.7 / 11.8s | erratic — and it is the Battalion orchestrator + synthesizer + Video visual orchestrator |
| `minimaxai/minimax-m3` | 3.0 / 8.5 / 15.1 / 15.5s | bad — guest-visible as "best free option for images and video" |
| `meta/llama-3.1-70b-instruct` | 0.9 / 10.8 / 23.8 / 42.6s | bad — seated on the Simplify empathetic route at a recorded 238ms on 2026-08-03 |
| `z-ai/glm-5.2` | 37.5 / 40.2 / 41.9 / 43.2s | dead for interactive use — seated Frontier/Flagship |

Endpoint itself is healthy: `GET /v1/models` → 200, still exactly 102 ids, every seated id present, real tool calls verified on Ultra and Super, embedder `nemotron-3-embed-1b` 200 / 2048 dims / 343ms.

## The guest incident, from the journal

`/data/ide/jobs/ide_5184628f-a67.jsonl`, 173 events, `isOwner: false`, uid `6610102ea32a9452`, project `C:\App Builds\Game Ideas\Code Black`:

- tg-1 → done, 2 files, $0.073445
- tg-2 → done, `src/main.js` 10,807 bytes, $0.040878
- tg-3 → **failed, "No owned file changed."**, $0.096692
- guest chose Retry
- tg-3 → **failed again, identical message**, $0.023703
- guest stopped the build

tg-3, tg-4, tg-5 and tg-6 all own the same file `src/main.js` that tg-2 had already written in full. The completion gate asks "did an owned file change?" — a question tg-3 cannot pass once tg-2 wrote the whole implementation. Total charged: **$0.235 for an unfinished build.**
