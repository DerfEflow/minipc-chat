# Adopt Analyst v3: Full Autonomy SOW (DRAFT for Fred's approval)
**Date:** 2026-07-28. **Status:** DESIGN ONLY, nothing built. Written in response to Fred's ruling that the current adoption analysis "is a worthless waste of time": it quits at basics, loses its knowledge of the app between turns, and told the user to their face that it cannot re-read files.

## What exists today (verified in code, 2026-07-28)
- `/ide/adopt`: deterministic scan (caps: 12k files walked, 48 samples kept, 1.2MB read, 180KB retained) then ONE inline Opus 4.8 analysis call inside the HTTP request, output capped at 24,000 chars.
- `ideChatWithWorkspaceTools`: a real tool loop with workspace_list, workspace_read (12KB pages), web_search, web_read. Rides every planchat turn that carries adopt:true, in every window. Caps: 24 rounds, 72 calls, ~600KB reads per TURN, nothing carried between turns.
- The client does send adopt + workspaceId on every window's every turn.

## Why it still fails (the five real defects)
1. **Silent tool loss.** `ideChatWithWorkspaceTools` line ~2254: a model that is not toolCapable silently degrades to a plain chat call. The model then truthfully tells the user "I have no file handle, the scan was a one-shot injection." The machinery was there; that model never had it, and nobody said so. Violates the honesty doctrine.
2. **Knowledge does not persist.** Nothing the analyst learns is stored anywhere. Every turn starts a fresh tool loop; the only carried context is chat history, clamped to 40 messages x 4000 chars by the sanitizer, which TRUNCATES the 24k analysis on the very next turn. By turn three the app knowledge is mostly gone. This is Fred's "it does not have a knowledge of most of the app by the time it comes back."
3. **The analysis is an HTTP request, not a job.** It must finish before the request times out, so it is structurally biased toward quitting early with a summary. Dominion already owns the cure: the idejobs spine (detached, journaled, reattachable, budget-fused) that builds already run on.
4. **Fixed ceilings, whatever the app's size.** 48 samples + 600KB of follow-up reads is a rounding error against a real app (this repo's server.mjs alone is ~250KB). The report then generalizes from a fraction and reads shallow because it IS shallow.
5. **No coverage truth.** The analyst decides for itself when it is done. Nothing measures what fraction of the app was actually read, so "done" arrives when the model feels done, and the report cannot honestly state its own blind spots.

## The design (what we need to enable)

### D1. The App Dossier: persistent, queryable app knowledge
A stored artifact per workspace (server-side, keyed by workspace id, updated incrementally):
- file map with per-file status: unread / skimmed / fully read / summarized
- per-area summaries (subsystem level), architecture notes, entry-point graph
- open questions and verified facts, each tagged with the file(s) that ground it
- a coverage ledger: bytes and files visited vs total, by architecture-score band

Every later turn, in every window and every mode, gets: the dossier digest injected server-side (NOT through the 4000-char chat sanitizer), a `dossier_query` tool, and the live workspace tools. Re-analysis updates the dossier instead of starting over. This is "it needs to be able to return and access again."

### D2. The analyst becomes a JOB on the idejobs spine
"Analyze my app" starts a detached job with progress events (the same UI spine builds use): survives the phone locking, reattaches, journals every tool call, pauses on budget. Termination is COVERAGE-DRIVEN, not vibe-driven: the loop continues until every high-architecture-score file is fully read and a target share of source bytes is visited, or the budget fuse trips; either way the report must name what was not read. Ceilings scale with app size; the persistent-tier budgets (24x4 rounds, 256 calls) apply, raised as needed.

### D3. Tool parity with chat
Add to the read loop: `workspace_grep` (server-side search through hands; finds where things live without reading everything, the single biggest efficiency lever), git history read, dependency introspection. Keep web_search/web_read. v3-later, behind execution-policy gates: run the test suite / start the app in the sandboxed lane so "works" claims are proven, not inferred (execution-policy.mjs now exists to gate exactly this).
**And the honesty fix:** when a window's model cannot use tools, the reply must SAY so and name tool-capable alternatives. Silent degradation is deleted.

### D4. The report is a document, not a bubble
Composed from the dossier across as many model calls as it needs, sectioned per subsystem, no 24k cap; delivered as a saved document (vault/artifact) plus a chat digest. Every report carries its own coverage statement: "Read N of M source files (X%), all entry points; unread: <named>." Fred's bar: better than any adoption scan on the market, and honest about its edges.

### D5. Cost honesty
Pre-flight estimate from the deterministic scan ("~2.1MB across 230 files with Opus 4.8, roughly $X to read it all") with Fred-style tranche fuses; metered per job as builds are.

## Blast radius call (for the build, when approved)
HIGH: guest-reachable endpoint driving unbounded-ish reads + spend on the user's machine and wallet (full FITS). MEDIUM: dossier storage (new persistent state per workspace). The job spine, budget guard, execution policy, and tenant walls already exist and are inherited unchanged.

## Open questions for Fred
1. Dossier storage location: server-side per workspace (survives devices, my recommendation) vs a `.dominion/` folder inside the app itself (visible to the user, travels with the code)?
2. Default analyst spend ceiling per adoption before it pauses and asks (e.g. $5)?
3. Does v3 include the run-the-tests execution lane at launch, or read-only first and execution as the follow-up wave?
