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
- [x] D1. routing confidence produced + surfaced (21, part of A1)
      → routeDecision returns the full spec decision {route, mode, needs_*, privacy_risk,
        confidence, reason} (route enum via routing.mjs routeOf); surfaced in the route SSE event
        AND logged as `route:{...}` on every usage.jsonl entry (all statuses)
- [x] D2. Long-context re-check AFTER retrieval (retrieved context overflow can trigger it) (12)
      → routing.mjs escalateForContext(): handleChat estimates the FULLY ASSEMBLED prompt after
        buildContext and escalates num_ctx (4096-aligned, capped at the honest 40960) + the mode
        label + the long-context frag when it would overflow; second route SSE with escalated:true
- [x] D3. needs_retrieval / needs_tools / needs_mentor_review actually consumed by the pipeline
      → consumeNeeds(): needs_retrieval=false (or a self-contained transform ask) skips retrieval;
        needs_tools gates whether tool defs are attached to the model call (conservative: only
        fast-mode turns with no tool language drop them — opts.noTools); needs_mentor_review flows
        as routeNeedsReview → reviewEngine.schedule → detectTriggers "user_ask" → hard Tier 2
        (verified end-to-end; explicit-mode picks now produce a needs block too)
- [x] D4. YaRN: document as hardware/runtime-bound (Ollama doesn't expose rope-scaling; 32GB box)
      — spec note, not code (11). DONE = honest comment at PROVIDERS in server.mjs + the
      Spec-deviations ledger below. No pretend implementation.

### E — Artifacts & documents
- [x] E1. The 9 artifact mentor-review triggers detected server-side (long, technical, code, export,
      legal/financial, retrieval-sourced, uncertainty, drift, final) (8)
      → review.mjs detectArtifactTriggers() — ONE detector; server evalArtifactTriggers() sweeps on
        create / revise / mark-final / export, REST and tool paths alike; firing = artifact marked
        reviewRecommended (additive field, small UI hint) + background documentReview scheduled
        (skipped when the current version is already reviewed); drift uses the LCS-diff changeRatio
        vs the last reviewed version
- [x] E2. The 7 export safety checks, enforced server-side so the model-facing tool can't bypass (9)
      → review.mjs exportSafetyGate() + server exportGated() — the ONE path for the REST endpoint
        AND export_artifact/create_docx/create_pdf/create_spreadsheet (tools go through
        CTX.exportGated; the raw-store bypass is closed — no gate wired = tool refuses). Structured
        title/format/destination echo; review-skipped + unsupported-claims (from the stored
        structured lastReview) warnings; sensitive-data (redact() detection) BLOCKS without an
        explicit override in BOTH modes; source always preserved. EXPORT_SAFETY=spec = warnings
        require confirmed:true (cautious flip, no rebuild)
- [x] E3. Native DOCX export (zero-dep zip writer), minimal PDF export (zero-dep text PDF),
      spreadsheet (CSV/XLSX zip) — no Forge dependency for basic docs (7)
      → docwriters.mjs: table-based crc32 + zip writer (DEFLATE/STORED + central directory),
        markdown→OOXML docx (headings/bold/italic/lists/code), multi-page text PDF (Helvetica +
        bold, Tj ops, real xref), markdown-table/CSV → xlsx (inline strings) with csv fallback;
        wired into artifacts.exportArtifact (Forge = docx/pdf fallback ONLY when the native writer
        throws); create_docx/create_pdf/create_spreadsheet registered as model tools (spec 809-821).
        Verified: docx round-trips persona.mjs docxToText; pdf passes %PDF/Tj/xref checks; xlsx zip
        lists correct OOXML entries + cell data (artifacts_test.mjs)
- [x] E4. Per-version provenance; archived state reachable in UI (partial)
      → addVersion (and v1) records sourceChatId/sourceContextRefs/sourceToolRunIds/promptSummary
        per version; tools stamp the live turn's provenance via reqCtx.provenance(); Archive/
        Unarchive action added to the artifact panel (app.js v22)
      (D+E proven by routing_test.mjs 11/11 + artifacts_test.mjs 36/36; review_test 13/13 and
       governance_test 19/19 still pass)

### F — UI completions
- [x] F1. Per-message: Hallucination-check control, Save lesson, Convert to eval, Show tool log (23-26)
      → 🔎/💡/🧪 glyph actions in the .acts row (wraps at 375px); 🔎 = /mentor/review with
        taskType hallucination_check (factual-specialist lens), same critique card; 💡 = kind
        chooser → ledger (lesson lands in correctedOutput) / eval / candidate rule; 🧪 = preceding
        user prompt as eval input + prompted expectedBehavior → /evals; 🔧 n chip is tappable →
        tool panel filtered to the message's runIds (done-meta now carries them; older messages
        fall back to chatId — honest empty-state when neither matches)
- [x] F2. Reject critique = recorded rejection (feeds pipeline; removes ledger entry) (27)
      → new /mentor/reject: marks the stored review record rejected (or stores a standalone
        user-rejection record for SSE-only mentor-mode cards), REMOVES the critique's auto-created
        ledger entry (rejected critiques must not inflate adaptive sampling), pipeline-logs the
        rejection; the card ✕ posts it before removing the DOM node
- [x] F3. Memory inbox: Convert to retrieval note (28)
      → "→ Retrieval note" on every memory item (POST /rules scope:"retrieval", mirroring → Rule);
        the inbox now has all 8 spec'd actions
- [x] F4. Context chip expands to show which items loaded; interrupted answers visibly marked;
      artifact panel: model + source-chat link; ledger shows rootCause/actions (partials)
      → context SSE now also sends artifactItems/chatItems; the client keeps all per-item detail
        on message meta and the 🧠/📄/💬 chip toggles the list on tap; ⏸ interrupted badge renders
        from the saved flag; artifact detail shows model as the friendly tier label ONLY
        (never a model name), a "reviewed"/"review suggested" badge (reviewed = current version),
        and a tappable "from chat ↗" link (honest alert when the chat is gone from this device);
        ledger items render rootCause/improvementActions/samplingCategory/lesson + linked counts.
        BONUS (A7 gap): the Finetune tab (list + approve/reject/delete + add) actually exists now —
        the store/endpoints landed in Group A but the tab itself had never been built.
      (verified live: panels/REST/render paths exercised at 375px with zero console errors;
       review/governance/routing/artifacts self-tests all still pass; app.js+sw bumped to v23)

## Spec deviations (honest ledger)

- **YaRN rope-scaling (spec 19 / 428 / 1841, audit item 11): NOT implementable on this stack —
  deliberately not faked.** The spec claims "YaRN enabled for thinking or long-context jobs" as
  baseline and tells deep-think to "use YaRN when required by context size". Two hard blockers:
  (1) Ollama's /api/chat exposes no rope-scaling parameters — enabling YaRN would mean re-serving
  the model from a modified Modelfile, not a per-request toggle; (2) qwen3's YaRN window
  (~131-262k tokens) needs KV-cache RAM far beyond this 32GB mini-PC. **Long context in this build
  = num_ctx escalation up to the provider cap (40960), which is what the runtime actually
  serves.** The escalation machinery (D2) is real and spec-shaped — if the box or runtime ever
  gains YaRN, only the PROVIDERS cap and the Modelfile change. Code note lives at the PROVIDERS
  block in server.mjs.
- **Route enum edge:** the auto-router only emits the three local routes; `external_mentor` never
  appears as a routing destination because the mentor bridge defaults local and mentor review is a
  post-answer concern (carried by needs_mentor_review). Explicit mentor mode maps to
  `multi_model_review` (answer + independent critique pass).

## Sequencing
A (core) → B+C (governance) → D → E → F. Commit per group; deploy all after distill completes.
Verify each group against the audit's spec refs before marking done.
