# Execution Hardening (2026-07-30 evening) — FITS packet

**Mission line:** A build asked for in Dominion chat or Crucible finishes, says "done" honestly, and survives providers, timeouts, and deploys; Fred watches one live proof of each surface before this is called fixed.

**Blast tier:** HIGH on server execution path + prod deploy (live tenants, budget-adjacent code, push=deploy). MEDIUM on live model sweep (real spend, capped). LOW on rail UI removal and throwaway test apps.

## Fix list (each ships with a test)
1. Fire Alarm removed from the command rail (composer strip); POST /chat/fire-alarm endpoint retained as API escape hatch. [DONE]
2. Completion gate: status aliases normalize (complete/done/finished/success/succeeded → completed); invalid status produces a REAL contradiction message; task_complete schema description warns about exact spelling; rejection text tells the model it is internal feedback. Ported from stranded F: work. [DONE]
3. Markdown rendering port (stranded F: work, has test). dominion-mobile.css NOT ported — predates the shipped dock/composer mobile fixes; see ledger.
4. OpenAI Responses: 120s idle watchdog (resets on every stream event) + 45min hard fuse replace the 180s wall-clock kill; reasoning summaries requested and streamed as visible thinking; timeout-with-partial resumes instead of restarting from zero.
5. Outer loop: patient backoff for retryable provider failures; Moonshot/NVIDIA overload+repeat-timeout reroute to OpenRouter out loud; param repairs stick for the whole turn; permanent cloudparams rule for Moonshot temperature rejection.
6. Battalion: build/machine-intent asks run on a real tool-capable model with an honest note instead of a text-only swarm pretending.
7. Deploys: SIGTERM checkpoints running chat jobs; boot auto-resumes recently interrupted contracts; /chat/attach reports sealed jobs as dead; client renders dead runs as dead with Resume; pre-push running-jobs check.

## Wargamed moves
- **Deploy cutover while Fred's runs are live:** the 14:18 and 15:43 cutovers today executed his builds. Mitigation: fix 7 + operational rule (check running jobs before push; deploy only my own runs live).
- **Watchdog semantics wrong → runaway spend:** idle timer MUST reset only on real stream activity; hard fuse stays; budget ledger remains the money brake. Tests simulate slow-but-alive and dead-silent streams.
- **Auto-resume loop (resume → crash → resume):** resume only jobs younger than 30 min, once per job (resume attempt recorded on the job row).
- **Markdown/mobile port regressing shipped phone fixes:** mobile.css skipped entirely; markdown is additive with its own test.

## Success criteria (ship line)
- Full suite green (baseline 87/87 before changes).
- Live: every catalog model + image lane + builder model answers a real call or fails with a named, fixable reason. Fixes applied.
- Live: a chat build on a non-flagship model ends with accepted completion evidence and real files on Z: that run.
- Live: Crucible Vibe run (ranks converse, orchestrator tasks, worst-case models, preview) and Beginner run both produce runnable apps.
- Deployed sha verified via /api/version; no orphaned Fred-runs at cutover.

## Ledger
- [user-stated] "Command rail" = the composer strip (Fred's quoted words in dominion-tenant.css Option 1 block).
- [assumed] dominion-mobile.css (F:, 07-28 01:12) is stale vs later shipped mobile hotfixes → NOT ported; revisit if Fred wants the keyboard/mobile polish it contained beyond the resize fix (which WAS ported into app.js).
- [verified] sw.js SHELL listed /app.js?v=57 while index.html served v64 (stale precache entry, network-first hid it); fixed to v65 this pass.
- [assumed] OpenAI Responses streams emit an event at least every 120s while healthy when reasoning summaries are requested. Watchdog threshold configurable via env if wrong.
- OPEN: dominion-mobile.css + mobile_ui_test.mjs remain stranded on F: (untracked) alongside docs/ADOPT-AUTONOMY-SOW.md.

## Abort conditions
- Two failed attempts at the same subgoal → stop, snapshot, reclassify.
- 6 consecutive deploy failures → stop and alert Fred.
- Any test app build spending > $3 on a single turn without progress → stop that lane, log, continue others.
