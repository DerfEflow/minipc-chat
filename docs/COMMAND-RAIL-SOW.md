# Command Rail SOW (ARSENAL Wave 1): DRAFT pending Fred's layout ruling
**Date:** 2026-07-28. **Blast radius:** MEDIUM (app-level chrome, customer-facing, fully reversible, no money paths).

**Mission line:** The right rail becomes the app's map: every surface named and one tap away, the decorative telemetry cut to the instruments that earn their space.

## Current DOM (grounded 2026-07-28, dominion-cinematic.js `buildCinematicShell`)
`.telemetry-rail` holds three cards:
1. `.efficiency-card`: "System Telemetry" title, `.efficiency-gauge` (the dial), `.telemetry-list` (UI Load / Device Memory / Threads / Session / Link rows).
2. `.context-card`: "Context Window" title, `.context-cube` (the diamond), `#context-count` + "Available tokens".
3. `.security-card`: "Security Status", two static rows (AES transport, Integrity Verified).

## The changes (Fred's cuts, verbatim intent)
- DELETE `.telemetry-list` (all text under the efficiency dial). The dial and its percent stay.
- Context counter: DELETE `.context-cube`; render text only ("96K / 128K available"); position immediately below the efficiency dial inside the same card; the separate context card dissolves.
- DELETE `.security-card` entirely (it asserts two static strings; nothing a user acts on).
- The freed space becomes the NAV STACK, top to bottom:
  - **THE FOUNDRY** (subheading: image generator)
  - **FORGE DIAL** (subheading: model heat)
  - **THE CRUCIBLE** (subheading: app builder)
  - **VIDEO GENERATION** (Coming Soon badge, inert button, visibly a promise; Fred builds it later)
  Each entry: name + one-line subheading, brass-and-glass button treatment consistent with the house aesthetic, wired to the same open calls the compass fires today.

## The compass ruling (Fred leans delete; decision blocks this wave)
Today the compass dot opens the surface dial (Image forge / Forge dial / The Crucible) and is the ONLY navigation on phones. If it dies with no mobile answer, phones lose navigation entirely.
- **Option A (recommended): delete compass + give the rail a mobile life.** On phone widths the nav stack docks as a bottom strip (four labeled buttons); telemetry pieces stay desktop-only. One navigation system everywhere, nothing redundant.
- **Option B: delete compass on desktop, keep it on phones** until a designed mobile nav exists. Two systems, but zero mobile risk this wave.
- **Option C: keep both.** Rejected by default: redundant chrome is what this wave exists to remove.

## Ripples this wave must sweep (furnace + features honesty)
- features.mjs locations that point at the compass (the plain-words wave moved controls INTO the compass handle; tests enforce those strings).
- idehelp.mjs guide lines describing compass entry to the Crucible.
- The welcome/tour copy that references the dial, if any.
- Cache-bust trio + guide update in the same commit.

## Wargame
| # | Failure | Defense |
|---|---------|---------|
| W1 | Phones lose all navigation | the ruling above is decided BEFORE code; Option A ships the bottom strip in the same commit |
| W2 | Rail edits break the cinematic layer's assumptions (ids it animates) | efficiency gauge + context-count ids preserved; only removed nodes' animation code deleted with them |
| W3 | Guide/features drift | furnace roll-call updated same commit; features tests re-pointed |
| W4 | Coming Soon button reads as broken | explicit badge + one-line tooltip ("Fred is building this; it is not wired yet") |

## Success (ship line)
Rail shows dial + text counter + four nav entries; security card gone; compass per ruling; mobile navigation intact per ruling; suite green; guide honest; deployed and verified.
