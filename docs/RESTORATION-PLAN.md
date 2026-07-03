# Dominion AI — Full Spec Restoration Plan

*Source of truth: the audit at `F:\Claude Sandbox\Reference\DOMINION-AI-SPEC-AUDIT-2026-07-02.md`
(28 verified capability cuts) and the spec `C:\Users\rjfla\Documents\Dominion AI\Local AI Build.md`.
Fred's call 2026-07-03: FULL RESTORATION — build the spec'd machinery intact, ship at his LAX
defaults (cautious mode = a flag flip, never a rebuild).*

**Deploy gate: do NOT restart the mini-PC chat server while the overnight distill is running
(in-memory job — a restart kills it). Code + commit + push freely; deploy after the distill lands.**

## Groups (audit item numbers in parens)

### A — Flywheel / mentor core  ← START HERE
- [x] A1. NormalizedModelResponse quality block: confidence / hallucinationRisk / needsReview +
      citations/warnings/structured/metadata on every response; downstream consumers read it (13, 21)
- [x] A2. The 8 automatic mentor-review triggers (final output, executable code, export, hallucination
      risk, claim count, user ask, uncertainty, complex tool chain) — real detection wired into routing
      + post-answer; `needsMentorReview` computed, consumed (2)
- [x] A3. 10-category adaptive sampling: all 10 categories reachable (finalArtifact/executableCode/
      userMarkedImportant etc.), per-category rates, rates ADAPT on failure history (3)
- [x] A4. Tier system: Tier 0 content-level classification; Tier 1 sampled light check; Tier 2 auto
      full review on the spec'd cases; Tier 3 MULTI-MENTOR COUNCIL (multiple role mentors →
      reconciliation → council result stored as eval) (4)
- [x] A5. 10-step improvement pipeline: parse → validate → respond → classify (22-category enum,
      inferred rootCause, derived improvementActions) → generate improvement objects → queue →
      AUTO-APPLY (gated, LAX-default on for safe classes) → auto-eval → log → auto-retire (1, 16)
- [x] A6. Typed MentorReviewRequest package (metadata block, requestedOutputSchema,
      redactionsApplied) + structured Document Review Output Schema (10 fields) (14, 15)
- [x] A7. Fine-Tuning Candidate store + producer + queue + UI tab (19)

### B — Memory governance
- [x] B1. Three-tier per-category gating matrix (auto-save safest / approval for inferred, failure,
      mentor_suggested, sensitive) — machinery real, LAX default flips all to auto (6)
      → memory.mjs GATING_MATRIX/classifyGate; MEMORY_GATING=lax|spec; lax records gatedAs/gatedReasons
- [x] B2. scope enum validated AND used: retrieval/context filter by scope (18)
      → scope+scopeRef validated on write; retrieve/retrieveHybrid/alwaysLoaded take scopeCtx;
        buildContext + recall_memory/retrieve_context_pack pass the live {chatId, mode, model}
- [x] B3. Never-save list: raw reasoning, unverified mentor claims, sensitive detection (partial)
      → neverSaveCheck() blocks CoT/interrupted/secrets/unlabeled-hallucinations in BOTH modes;
        mentor_suggested stays PENDING+unverified even under LAX (approval = validation)

### C — Tools & permissions
- [x] C1. requires_confirmation class assigned to the spec'd cases (overwrite, external send,
      inferred-memory save); machinery on, LAX default answers "yes" automatically but LOGS it (17)
      → deck_* writes static; effectivePermission() escalates sandbox overwrite + inferred remember
- [x] C2. 9-state tool lifecycle persisted (proposed / awaiting_confirmation / ... ) in toolruns (22)
      → lifecycle()/passConfirmGate() in tools.mjs; states[] on every toolruns.jsonl entry; top-level
        status unchanged (UI/tail contracts hold)
- [x] C3. Tool Description Update: TOOL_DEFS dynamic — flywheel stores per-tool description
      overlays, applied at prompt time (10)
      → toolDefs(overlays) + flywheel toolOverlays store + /tool-overlays API; pipeline emits overlay
        candidates from mentor tool findings that name a real tool
- [x] C4. The 6 formatting tools (spec 858-865) implemented for real (20)
      → format_as_markdown/json/checklist/table/report/scope on the LIGHT model (json+think:false)
- [x] C5. In-flight tool abort on Stop where safe (partial)
      → AbortController per /chat; HTTP tools destroy in-flight, python SIGKILLed, bridge poll stops;
        un-abortable tools finish but the run logs status cancelled + discarded:true
      (all proven by governance_test.mjs — 19/19)

### D — Routing
- [ ] D1. routing confidence produced + surfaced (21, part of A1)
- [ ] D2. Long-context re-check AFTER retrieval (retrieved context overflow can trigger it) (12)
- [ ] D3. needs_retrieval / needs_tools / needs_mentor_review actually consumed by the pipeline
- [ ] D4. YaRN: document as hardware/runtime-bound (Ollama doesn't expose rope-scaling; 32GB box)
      — spec note, not code (11). DONE = honest note in code + spec-deviation ledger.

### E — Artifacts & documents
- [ ] E1. The 9 artifact mentor-review triggers detected server-side (long, technical, code, export,
      legal/financial, retrieval-sourced, uncertainty, drift, final) (8)
- [ ] E2. The 7 export safety checks, enforced server-side so the model-facing tool can't bypass (9)
- [ ] E3. Native DOCX export (zero-dep zip writer), minimal PDF export (zero-dep text PDF),
      spreadsheet (CSV/XLSX zip) — no Forge dependency for basic docs (7)
- [ ] E4. Per-version provenance; archived state reachable in UI (partial)

### F — UI completions
- [ ] F1. Per-message: Hallucination-check control, Save lesson, Convert to eval, Show tool log (23-26)
- [ ] F2. Reject critique = recorded rejection (feeds pipeline; removes ledger entry) (27)
- [ ] F3. Memory inbox: Convert to retrieval note (28)
- [ ] F4. Context chip expands to show which items loaded; interrupted answers visibly marked;
      artifact panel: model + source-chat link; ledger shows rootCause/actions (partials)

## Sequencing
A (core) → B+C (governance) → D → E → F. Commit per group; deploy all after distill completes.
Verify each group against the audit's spec refs before marking done.
