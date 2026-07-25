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
- [ ] Hide or finish the TBD placeholder square behind an owner flag.
- [ ] Re-pull model prices (catalog snapshot 2026-07-18) and put the weekly re-pull into the health-check sweep alongside the tool-flag audit.
- [ ] Claude Opus 5 / Claude 5 family catalog upgrade pass.
- [ ] Cost fuses for tenants: the long-run billing tranche fuse (3e9b5f0) covers builds; confirm plan-chat, estimates, and reduce checks are metered per tenant too.
- [ ] Rate limits on /ide/* endpoints for non-owner tenants.
- [ ] Security pass: the folder/workspace browser must stay owner-only or sandboxed per tenant; guests must never browse a host filesystem.
- [ ] Abuse review: interviewer and plan-chat are open text to models; confirm sanitizer coverage (images, size caps) matches guest exposure.
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
