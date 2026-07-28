# ARSENAL: the free-power program (architecture + roadmap)
**Date:** 2026-07-28. **Status:** ARCHITECTURE, approved scope, build waves run ONE AT A TIME on Fred's go.
**Fred's order:** go all out on the NVIDIA developer program (voice, embeddings, free images, free endpoints), rebuild right-rail navigation (compass likely retired), add the Video Generation placeholder, and add BATTALION to the chat dropdown. Both provider keys (MOONSHOT_API_KEY, NVIDIA_API_KEY) are live in Railway as of tonight.
(Working name ARSENAL; Fred renames at will.)

## Program shape
Six waves, six worktrees under `Z:\Apps\minipc-chat\` (the iteration drive, per the App Lifecycle Order). Each wave: rebase onto main at start, build, full suite, merge, Documents backup, push (= deploy), verify. One writer per tree, one wave in flight at a time.

| # | Wave | Worktree | Ships |
|---|------|----------|-------|
| 1 | Command Rail | `command-rail` | Right-rail nav redesign, video placeholder, compass ruling executed |
| 2 | Free Fleet | `nvidia-free-fleet` | Every valuable NVIDIA free endpoint in the catalog + select non-NVIDIA additions |
| 3 | Foundry Drafts | `foundry-free-drafts` | Free draft-image lane in the Foundry, same features as paid |
| 4 | Voice | `voice-free-primary` | NVIDIA speech primary, OpenAI backup, both directions |
| 5 | Retriever | `retriever` | Free embeddings + reranking across memory, chat recall, vault, dossier |
| 6 | BATTALION | `battalion` | The free swarm in the chat dropdown (docs/BATTALION-SOW.md) |

Order rationale: the rail (1) is where later features surface, so it goes first and needs Fred's layout sign-off. The fleet (2) is the foundation every later wave draws models from. Drafts (3) and Voice (4) are user-visible wins that ride the fleet. Retriever (5) is infrastructure that makes everything faster and feeds BATTALION's long-context work. BATTALION (6) composes all of it.

## Wave 1: Command Rail (spec: docs/COMMAND-RAIL-SOW.md)
Grounded in the live DOM (dominion-cinematic.js builds `.telemetry-rail`):
- KEEP the efficiency gauge (the dial itself).
- DELETE the `.telemetry-list` text under it (UI Load, Device Memory, Threads, Session, Link). Fred: "No one uses it."
- Context Window: DELETE the `.context-cube` glyph; the count and label move to text-only, sitting just below the efficiency gauge.
- DELETE `.security-card` entirely.
- The freed rail becomes NAVIGATION: The Foundry (subheading: image generator), Forge Dial (subheading: model heat), The Crucible (subheading: app builder), each a real destination button. Plus VIDEO GENERATION with a Coming Soon badge (inert, announced, honest).
- COMPASS RULING (Fred leans delete): once the rail carries all destinations, the compass dial is redundant on desktop. Open question: mobile, where the rail may be hidden. Options in the SOW; Fred decides before the wave builds.

## Wave 2: Free Fleet
- Catalog rows for every NVIDIA free endpoint that adds value: the Nemotron line, NVIDIA-hosted DeepSeek, Qwen, Kimi, GLM, Llama 4, MiniMax variants, vision and long-context specialists. Each: `provider: "nvidia"`, honest $0 pricing via the transport-aware cost math (already live from 1917d24), tool/vision flags audited by live probe, not by model card (the UnslopNemo rule).
- Selection filter: a free endpoint joins only if it beats or matches an existing seat on some axis (price is automatic; quality, context, speed, or modality must hold its own). No shovelware rows.
- "A few others if they bring value": candidates audited the same way, from any catalog provider.
- Weekly tools/price audit extends to the NVIDIA lane.

## Wave 3: Foundry Free Drafts
- A Draft (free) option beside the paid engines in the Foundry: same sizes, same styles, same gallery, same keep-path flow, powered by NVIDIA free image endpoints. The paid lane (fal) stays the finals lane.
- Honest labeling: drafts say which engine made them; no quality qualifier anywhere (Fred's rule for free surfaces).

## Wave 4: Voice
- NVIDIA speech endpoints become the PRIMARY call for the voice stack (both directions where the free catalog serves them: speech-to-text and text-to-speech), OpenAI becomes the BACKUP, switched automatically on failure and said out loud in the UI when the fallback fires (never silent).
- Kills the standing failure mode "voice dies when OpenAI quota dries up."

## Wave 5: Retriever
- NVIDIA free embedding + reranking models wired as the vector engine for: memory recall, chatlog retrieval, knowledge vault, persona/truth-core search, and the Crucible adoption dossier (docs/ADOPT-AUTONOMY-SOW.md, designed 2026-07-28).
- Reranking is the new capability: retrieve wide with embeddings, rerank precisely, feed fewer better tokens to the model. Faster answers, smaller prompts, better recall, at $0.
- Local Ollama embedding path stays as offline fallback.

## Wave 6: BATTALION (spec: docs/BATTALION-SOW.md)
- New chat dropdown entry, Fred's copy verbatim: BATTALION, "a handpicked swarm of AI models to do more work in less time- for free."
- A swarm orchestrator over the free fleet for complex work and long-form coding/responses when appropriate; single free model for simple turns. Full spec in the SOW.

## How the user's experience changes (the feature list, in their words)
1. **One glance navigation.** The right rail stops being decorative telemetry and becomes the map: Foundry, Forge Dial, Crucible, each named with what it does. No hunting, no compass ceremony.
2. **A promise on the wall.** Video Generation sits in the rail with Coming Soon on it: the product tells you where it is going.
3. **Cleaner instruments.** The efficiency dial stays; the fake-precision text under it goes; the context counter reads as plain words; the security card (which said nothing actionable) is gone.
4. **Free drafts in the Foundry.** Iterate on images all day at $0, spend money only on finals.
5. **Voice that stays up.** Speech in and out rides a free lane first; a quota problem at OpenAI no longer silences the app, and if the backup engages, the UI says so.
6. **Faster, sharper recall.** Memory and knowledge answers come back quicker and more on-point (wide retrieval + reranking), and the machinery behind them costs nothing to run.
7. **BATTALION in the model picker.** Pick it and a handpicked swarm splits the work and returns more, sooner, for free. Big jobs feel like a crew showed up.
8. **Bills keep shrinking.** Free transports bill $0 and cached tokens bill at hit price on every call (already live); the fleet multiplies where "free" applies.

## Standing disciplines that govern every wave
- SOW before code; blast radius called per wave; full suite + live verification before push; push = deploy; Documents backup after merge; six-failure deploy stop.
- Honest numbers everywhere: free lanes labeled, fallbacks announced, estimates marked as estimates, no invented telemetry.
- Furnace doctrine: any Crucible-visible change updates the in-app guide in the same commit. The rail is app-level chrome; its guide entry updates in Wave 1.
- Privacy walls unchanged: NVIDIA lanes are Normal-mode transports; Trusted mode still refuses everything outside OpenAI/Anthropic direct.

## Open decisions for Fred (block only Wave 1)
1. Compass: delete outright, or keep as the mobile-only navigator until the rail has a mobile answer? (SOW carries both designs.)
2. Rail on phones: bottom nav strip, hamburger section, or defer mobile nav to a later pass?
3. Program name: ARSENAL stands until you rename it.
