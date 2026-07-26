# Dominion Crucible: Public Release Plan (Draft 1)
**Date:** 2026-07-25. **Status:** LIVING DOCUMENT. Started tonight per Fred's order; will be added to and revised as the Engineer section is built out. Nothing here is scheduled until Fred assigns dates.

## Guiding shape
The release rides the existing Dominion SaaS spine (Wolfe tiers, billing, OTP, per-user Forge, app.dominion.tools on Railway where push = deploy). The Crucible is a feature of that product, so "release" means opening the Crucible to paying tenants, staged.

## Phase 0: Finish the product (current work)
- [ ] Engineer surface rebuild (Fred's changes, coming tomorrow). The gate for everything below.
- [ ] Fix the two defects from docs/CRUCIBLE-REVIEW-2026-07-25.md: Vibe mobile window overflow (one CSS line), and a level switch reachable from every surface so the Welcome Screen's "change it at any time" is true.
- [ ] Push 54f984d + fixes; verify /api/version flip and a phone pass by Fred.
- [ ] Fred's tweak pass on the Vibe surface.
- [ ] Decision point: one-click deploy (parked until Fred's MVP line settles; recommendation on file: static-first Cloudflare Pages lane, cost-warned Railway lane, moderation ruling needed before guests can publish).

## Phase 1: Hardening (before any stranger touches it)
NOTE 2026-07-25: the Engineer rebuild no longer blocks launch — ENGINEER_PUBLIC (default off) greys
Engineer as Coming Soon for guests server-side; the owner keeps it. Launch = IDE_MODE=all.
**LAUNCHED: IDE_MODE=all is LIVE (Fred flipped it 2026-07-25 night; confirmed read from the
Railway production environment 2026-07-26). The Crucible is open to every signed-in user;
ENGINEER_PUBLIC stays unset, so guests see Engineer as Coming Soon. The unticked items below are
now post-launch hardening, not launch blockers.**
- [ ] Hide or finish the TBD placeholder square behind an owner flag. (It is visibly inert with an
      honest hover note; decide whether that stands or it hides for guests.)
- [ ] Re-pull model prices (catalog snapshot 2026-07-18) and put the weekly re-pull into the health-check sweep alongside the tool-flag audit.
- [ ] Claude Opus 5 / Claude 5 family catalog upgrade pass.
- [x] Cost fuses for tenants: the long-run billing tranche fuse (3e9b5f0) covers builds; plan-chat,
      divider, tasks and reduce all route through ideChatOnce -> meterTurn (verified 2026-07-25);
      session budgets + earmarks (5d5f8f3) now gate chat spend per conversation as well.
- [x] Rate limits on /ide/* endpoints for non-owner tenants (2026-07-25: sliding 60s window,
      120/min overall, 20/min on model-calling endpoints, owner exempt, plain-sentence 429).
- [x] Security pass: VERIFIED 2026-07-25 — ideHandsFor routes every non-owner exclusively to their
      own hands node ("user:<uid>"); guests can never browse Fred's machines. /ide/browse owner
      drive enumeration is owner-gated; per-user Forge remains the guest path by design.
- [x] Abuse review DONE 2026-07-25: interviewer/plan-chat were already capped (4000 chars/msg, 40
      msgs, image size+count caps — ideintake.mjs). Fixed in the same pass: global 32MB JSON body
      ceiling (readJsonBody destroyed mid-stream past it — was unbounded), /ide/divide + /ide/tasks
      prompt caps (8000), /ide/reduce task title/files/detail caps, workspace node field (120),
      assignments/budget serialized-size ceilings (capObj 20k/4k, oversized patches change
      nothing), /ide/browse path+node caps. Display safety verified: user text renders via
      textContent everywhere; all innerHTML sites are static scaffolding.
- [ ] Full-suite green + furnace-doctrine check (idehelp guide matches every shipped control).

## Phase 2: Private beta
- [ ] Fred's brother as the Beginner-tier tester (he already sourced the plain-words wave). One or two Vibe-tier testers from Fred's circle.
- [ ] A feedback path inside the product (the beginner review chat already invites screenshots; wire the same invitation for Vibe).
- [ ] Watch: cost per build, completion rate, where people press HELP, which models beta users pick.
- [ ] Exit criteria: one full stranger-built app per tier without Fred intervening.

## Phase 3: Launch
- [ ] Pricing: map Crucible access onto existing Wolfe tiers (proposal to Fred: Beginner surface on the base paid tier, Vibe mid, Engineer top; the why-pay list per tier in the review report is the marketing copy seed).
- [ ] Landing page section on dominion.tools with the three-surface story (existing inquiries flow; note it still lacks notifications, fix rides along).
- [ ] A 2-minute demo video per surface (Beginner one first; it demos best).
- [ ] Docs: the in-app Guide already exists and is kept honest by tests; public docs can start as a copy of it.
- [ ] Status/health: weekly sweep cadence per standing rule, DB backups already nightly.
- [ ] Announcement channels: Fred's Substack (manual post; no write API), plus wherever Fred directs.

## Standing rules that govern the whole plan
- Push = deploy: nothing merges to main that is not ready for app.dominion.tools.
- Honest numbers doctrine everywhere public: estimates labelled, fallbacks announced, no invented progress.
- Every Crucible UI change updates the in-app guide in the same commit (furnace doctrine).
- Snapshot + rollback path before every deployment.

## Open questions for Fred
1. One-click deploy: in or out of the launch scope? (Parked by you until MVP.)
2. Tier mapping: does Beginner/Vibe/Engineer map to Wolfe tiers, or does every paid tenant get all three surfaces?
3. Guest publishing moderation ruling (blocks any public deploy lane).
4. Does the 3-day image sweep get built, or does the keep-your-pictures notice change? (Older open item; same honesty doctrine applies to Crucible promises.)
