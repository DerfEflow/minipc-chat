# Dominion AI stabilization: Step 1 deficiency list (2026-09-03)

Scope: app.dominion.tools (Fred says app.dominion.ai; that domain is not his). Features assessed:
Chat, Simplify Chat, The Crucible (IDE), Game Factory, Video Studio, The Foundry (images).
This is the discovery list only. No solutions here by Fred's order.

How each item was proven (kinds of proof, per standing rule 8.5):
- PROD DATA: read from the production volume (/data) over `railway ssh`, the Railway runtime log
  (585 lines, 09-02T15:15 to 09-03T12:20), the production hands hub node list, and the GX10 containers.
- RIG: the exact production commit (add03ad) run locally with the production key values, owner identity,
  a real hands node, and real provider calls. Same code, same keys, same providers.
- PROVIDER: direct calls to each provider with the production key values (statuses only).
- Deviation to say out loud: I have no owner-level automated login into production (Cloudflare Access
  only admits a browser email login or the sealed command-deck token), so feature behavior was
  exercised on the rig, and production was read, not driven. One code edit was made in the F: worktree
  (server-side logging of Video internal faults) to obtain a stack trace; nothing was committed or deployed.
  Spend for this discovery: about $0.15 (three images, thirty-one tiny chats, one tiny build).

## Simplify Chat

1. Simplify is dead for most questions, since 2026-08-26. The "quick" route points at
   nvidia/nemotron-nano-12b-v2-vl and the "empathetic" route at meta/llama-3.1-70b-instruct; NVIDIA
   retired both on 08-26 (HTTP 410 "end of life"). Four different test questions (roofing, photosynthesis,
   LLC vs S-corp, "I feel like giving up") all ended in the raw provider error being shown to the user and
   no answer. The Haiku fallback only fires for catalog-blocked seats, not for a provider failure. (RIG + PROVIDER)
2. Four of the nine Simplify routes point at models that no longer answer: quick (410), empathetic (410),
   business z-ai/glm-5.2 (retired 08-21, 410), safety nvidia/nemotron-3.5-content-safety (rejects the
   request: "roles must alternate"). (RIG + PROVIDER)
3. The route classifier sends almost everything to "quick": three unrelated question types were all
   classified quick, so the science/business/literary routes rarely engage even when their models work. (RIG)

## Chat

4. The model picker offers seats that cannot answer. Sweeping all 31 seats through the app's real chat path:
   26 answered; z-ai/glm-5.2, nvidia/nemotron-nano-12b-v2-vl, meta/llama-3.1-70b-instruct return HTTP 410,
   nvidia/nemotron-3.5-content-safety errors on request format, minimax/minimax-m3 hangs past 150 s with no
   answer. Picking any of them shows "Work checkpointed" plus an error. (RIG)
5. The boot-time catalog audit reports CLEAN while all of the above is broken, because it skips NVIDIA
   ("unchecked: no key") even though NVIDIA_API_KEY is set in production. Dead seats are invisible to it. (PROD DATA)
6. Turns die instead of recovering. Production usage log: 90 of 482 turns did not complete. Largest classes:
   "interrupted" long-context escalations on DeepSeek/Kimi (30+), provider errors surfaced raw (OpenRouter
   "stream ended before finish reason", Moonshot "overloaded", DeepSeek "Insufficient Balance", OpenAI
   "billing hard limit" and "no credits remaining", Anthropic "temperature is deprecated"), tool-schema
   rejections (Moonshot "not a valid schema", OpenAI "tools array too long, max 128", OpenRouter "no endpoints
   support tool use"), and one code crash ("Cannot access 'opts' before initialization" on the local
   qwen3:30b-a3b path). The privacy layer's "refuse, do not substitute" rule means each of these becomes a
   visible failure rather than a silent workaround. (PROD DATA)
7. A paying customer's model was handed owner-only tools. Denial log: the credit-role user called forge_grep
   three times in a row and was refused each time ("non-owner called an owner-only tool"), so that turn could
   not do its work. (PROD DATA)
8. The GX10 has never served one production request. Zero gx10 entries in usage, tool runs, or any IDE
   journal. Causes measured: the hub locks the reconnecting gx10 node out with HTTP 409 for 17 to 18 minutes
   at a time (36 to 38 refusals per episode, five episodes in the last 24 h, because the hub counts writes to
   its own local socket as proof the node is alive); and Ollama on the GX10 unloads the 65 GB model after
   30 minutes idle (OLLAMA_KEEP_ALIVE=30m), so the first request after idle waits 80 to 90 s for a cold load
   (measured on the rig). The "free local" lane Fred is paying hardware for is effectively absent, and every
   step routed there waits or fails during a lockout. (PROD DATA + GX10 + RIG)
9. Three chats were blocked by the "minors" content wall on deepseek-v4-flash. Whether these were false
   positives cannot be told from the logs; if they were, ordinary requests are being refused. (PROD DATA)

## The Crucible (IDE)

10. Real builds do not finish. 33 production build journals: the last "Build complete" was 2026-07-24.
    Since then: 13 stopped by the user, 13 errors (11 were the runner crashing with "mv is not defined" on
    08-01; one was killed by a server restart after 316 minutes and $0.94), and 3 checkpoints marked "not
    complete". The most recent (09-02, Speak-Easy, 144 minutes, $0.89, 28 moves, 20 shell runs all "ok")
    ended because a planned file was never produced by its step and the honesty audit "returned nothing
    readable; treat the build as unaudited". A tiny 3-file build on the rig did complete in 6.7 minutes with a
    green test, so the failure mode is scale, not the basic pipeline. (PROD DATA + RIG)
11. The live build view drops every couple of minutes. The job stream sends no heartbeat; on the rig a tiny
    build had silent gaps of 95, 41, 166 and 76 seconds, and Cloudflare closes idle streams at about 100 s.
    In production the 09-02 build's stream was cut 61 times in 41 minutes. The browser's EventSource then
    clears the panel and replays the entire journal from record zero (331 KB by the end), so the user sees
    flicker and "reconnecting", and the reload gets heavier with every event. (PROD DATA + RIG)
12. The counsel learning loop (GX10 brain diagnoses, Sonnet frontier, lessons) has never run in production:
    zero brain or frontier runs in any journal, no lessons file, no reports directory. It only triggers on a
    "failed move", and the actual failure modes (planned file never returned, prose instead of a move list,
    incomplete checkpoints, audits that return nothing) are not classified as failed moves. The system meant
    to learn from failures has never been handed one. (PROD DATA + RIG)
13. The planner's first answer came back as prose instead of a move list and had to be re-asked (rig), and
    builds started without a Plan-first approved plan let the builder plan for itself. Each build begins with
    a coin flip on the plan. (RIG)
14. The IDE's phone-mockup image call sends no quality, so the Foundry defaults to medium ($0.053 per
    mockup) instead of low ($0.006): nine times the cost for a throwaway preview. (RIG)

## Game Factory

15. A game plan cannot complete by design. The mandatory artifact backends are chatgpt_project and
    google_drive; ChatGPT Projects have no API, and the only completion path is an offline operator command
    that requires stopping the production server after Fred hand-uploads every artifact file. Production DB:
    44 artifact copies verified (primary and Google Drive), zero chatgpt_project copies; both projects that
    reached SPECIFICATION (Bolt Bloom, Vector Vault) stalled on 503 mandatory_artifact_copies_incomplete;
    10 projects, 0 builds, 0 releases, ever. (PROD DATA)
16. The worker "isolation proof" flaps. The orchestrator probes the gx10-gamefactory hands node; that node
    disconnects and reconnects every 15 minutes and is caught in the same 409 lockouts, so the proof is
    "lost" roughly hourly (97 proof-loss events, 472 latch events in the dispatch DB). The one real task run
    under it was SECURITY_INTERRUPTED (canary FAILED with EPERM linking a broker request file). A real build
    task would be killed the same way about once an hour. (PROD DATA + GX10)
17. The outbox never drains: 132 events PENDING since creation, 0 attempts, and no consumer code exists for
    the table. Whatever those events were meant to trigger downstream never happens. (PROD DATA + code)
18. The factory's live event stream is also cut by the idle timeout (14 cancels in the log window), so the
    Game Factory screen loses its feed the same way the Crucible does. (PROD DATA)

## Video Studio

19. Video generation is impossible. Every POST /api/video/jobs returns HTTP 500 "internal fault" before the
    provider is ever contacted: the handler clones the signed-in tenant object with structuredClone and that
    object carries a function (memory.propose), which structuredClone refuses (DataCloneError). Reproduced
    on both the desktop-project path and the mobile single-generation path, deterministic. Production shows
    zero video jobs and zero settlements across both projects that were ever created (08-03, 08-05). The
    server logs nothing for it; the user gets only a request id. (RIG, stack trace obtained + PROD DATA)
20. The director agent points at deepseek-ai/deepseek-v4-pro on NVIDIA, retired 08-07. Every director chat
    turn fails with "nvidia_director_http_410". The visual orchestrator (Nemotron Ultra 550B) takes 50 to 57 s
    to answer a five-token prompt. (RIG + PROVIDER)
21. The screenwriter only runs when the prompt exactly equals the saved screenplay text; a brief that is not
    checkpointed first is refused as "stale". The UI performs that save-then-ask dance, so any failure in the
    save step blocks Trinity entirely. (RIG, lower confidence as a user-facing symptom)
22. A second, separate video product lives at dominion.tools/studio ("Dominion Studio") with its own login and
    API (/api/studio/session, /api/studio/generations), unrelated to Dominion AI's Video Studio. Two video
    generators, two billings, two things to keep alive. (PROD probe)

## The Foundry (images)

23. Generation works today (rig: paid low quality in 17 s for $0.006; free draft engine in 4.3 s), but the
    production history shows 10 of 39 image turns erroring: six "OpenAI billing hard limit has been reached"
    (07-31) and four "rejected by the safety system" (08-09), each surfaced raw with no fall-through to the
    free draft engine or another engine. (RIG + PROD DATA)

## Cross-cutting

24. Reliability is capped by the weakest paid account. Production history already contains OpenAI hard-limit
    and no-credit errors, DeepSeek insufficient balance, Moonshot overload; OpenRouter has $22.45 left. One
    account running dry turns into user-visible errors across every feature that routes there. (PROD DATA + PROVIDER)
25. Tunnel churn: cloudflared QUIC "no recent network activity" resets, about 100 origin stream cancellations
    a day, gx10-gamefactory reconnecting every 15 minutes, a duplicate "laptop" node refused hourly. Every
    one of those is somebody's live stream going dark. (PROD DATA)
26. No owner-level automated way to verify production. Only a browser email login or the command-deck token
    (sealed in Vercel) can act as owner; health checks lean on `railway ssh`. Fixes cannot be proven in the
    place they run without a human clicking. (infra)
27. Deploy hygiene: production (add03ad) is ahead of the Documents backup (7718056) and every F: worktree;
    Codex committed straight to main on 09-01/02 (about ten deploys on 09-02, each a 3 to 6 minute HTTP 530
    outage). The live-rig tooling still defaults to the dead Z: drive; the Game Factory IPC test is red on
    Windows by default; SESSION-HANDOFF.md still describes a mini-PC deployment. (PROD DATA + repo)
28. The effect of all of the above, measured: real usage collapsed on 08-13. Since then the only daily traffic
    is the 18:00 UTC Substack-note cron job. Nobody has been getting work out of the app. (PROD DATA)
