# Dominion Works (IDE Mode): FITS Build Pack

Opened 2026-07-19. Companion to docs/IDE-MODE-ROADMAP.md (the SOW). Blast radius **HIGH**, so the
full FITS apparatus applies: this branch ends in the live multi-tenant revenue container, touches
billing and tenancy walls, and ships a new service worker.

## Mission line

A toggle in the hamburger menu turns Dominion AI into a build surface where a beginner ships a
working app and a career engineer never feels talked down to, where design work goes to OpenAI and
everything else goes where the user assigned it, and where a started build keeps running while the
user closes the app and walks away, reaching back out only when it genuinely needs a human.

## Blast radius ledger (per component)

| Component | Tier | Why |
| --- | --- | --- |
| Billing/metering for IDE jobs | HIGH | Real money, real cards, existing races (autoRecharge, sponsoredSpend) |
| Tenancy/tool grants for guests | HIGH | Owner secrets and other users' machines sit behind these walls |
| Service worker + push | HIGH | A bad SW ships a broken or stale app to every device, hard to undo remotely |
| Hands-node writes (scaffold/verify) | HIGH | Writes real files on Fred's and users' own machines |
| Job spine / durability | MEDIUM | Server-side only, reversible, but silent failure loses work |
| Router + Assignment Board | MEDIUM | Wrong model = wasted money, recoverable |
| Reveal shell, lenses, CSS | LOW | Visual, reversible, no money, no data |

Process follows the highest tier a move touches, per move.

## Assumptions register (attack these in final review)

| # | Assumption | Tag | Verification plan |
| --- | --- | --- | --- |
| A1 | Catalog prices for gpt-5.6-terra are current enough to bill against | `[assumed]` | Terra confirmed still present after the parallel worker's catalog edits (models.catalog.mjs:90, $2.50/$15). Weekly catalogaudit remains the standing check |
| A2 | A third reveal can transform the same four shell elements without fighting the existing two | `[assumed]` | Build Phase 1, verify in real Chrome over CDP (preview pane cannot judge motion) |
| A3 | Web Push works through Cloudflare Access for an authenticated PWA | `[assumed]` | Live probe on Fred's Pixel in Phase 4 before any guest exposure |
| A4 | Per-user Forge nodes stay connected long enough for multi-move builds | `[assumed]` | Phase 4.9 node-loss handling makes this survivable either way |
| A5 | Provider implicit caching will actually pay once prefixes are byte-stable | `[assumed]` | Measure cache hitPct in usage.jsonl before and after Phase 5.2 |
| A6 | 200-file scaffold cap and 60s per-file dispatch are adequate for real app scaffolds | `[assumed]` | Time a real scaffold in Phase 5.3; batch if it drags |
| A7 | Owner has exactly one node connected during IDE work | `[guessed]` | Phase 8.4 pins the node per workspace, removing the guess |

## Abort conditions (stop and escalate to Fred)

1. Any change would charge a real card in a way the user did not see coming.
2. A tenancy wall would have to be weakened to make a feature work.
3. The carve-outs (D:\, backups, pg_dump) would have to be loosened. Never negotiate these.
4. A service-worker change risks bricking installed PWAs with no remote rollback.
5. Two consecutive failed attempts at the same subgoal (two-strike rule). Snapshot, classify
   environment vs understanding vs specification, escalate.
6. Merging to main would collide with a concurrent session's work in a way git cannot resolve
   cleanly.

## Success criteria (ship line = grade 4 of 5)

1. Toggle in the hamburger opens Dominion Works with the platform-lift motion; both existing
   reveals still work and never stack transforms.
2. A beginner prompt produces a numbered plain-English blueprint and, on approve, real files on
   the user's own machine with a snapshot taken first.
3. Design work routes to OpenAI and everything else to the assigned model, visibly, with the
   reason shown.
4. Start a build, close the app, come back: it is still running, still visible, and its history
   replays intact.
5. A build that needs an answer freezes at zero spend and reaches the user's phone; answering from
   the phone releases it.
6. Costs shown before the job, metered once per move, and reconciled in usage.jsonl.
7. Every existing test suite still green; new ide_test.mjs green.
8. Guests see nothing until Phase 8 flips the flag.

## Open ledger

| # | Item | Impact | Status |
| --- | --- | --- | --- |
| L-1 | VAPID keys not yet generated or stored in wallet + Railway env | Blocks Phase 4.6 push | OPEN, due Phase 4 |
| L-2 | Billing races (autoRecharge mutex, addSponsoredSpend atomicity) predate this build | Guest parallel builds can double-charge | OPEN, due Phase 8.2 before guest flip |
| L-3 | Merge-to-main coordination | Integration risk | HALF CLOSED: main merged INTO this branch at b30fcb9 (2 conflicts, both kept-both-sides; catalog/route/carve-out integration points re-verified after). The final merge back to main is still pending |
| L-4 | Real-device push verification on iOS (home-screen install requirement) | Guest UX honesty | OPEN, due Phase 4.8 |
| L-5 | Toggle state was per-device only | Low | CLOSED in Phase 2: prefs live in the per-account IDE store, `POST /ide/prefs` on every flip, and a device with no stored opinion adopts the account's. A device that HAS an opinion keeps it, so the phone in your hand outranks a decision some other machine made |
| L-6 | Phase 1 motion never visually confirmed by me | Aesthetic risk only | OPEN, needs Fred's eyes. The preview pane times out on screenshot with the animated chassis (known environment breakage), so geometry was verified numerically instead: shell settles at -112vh, works at 0, z-index 70, 0.45s shared curve |

Mandatory-write rule: an item goes in this ledger the moment it is discovered, with a placeholder,
rather than being guessed silently. Done is not declared with OPEN high-impact items unexplained.

## Verification discipline

- The desktop preview pane cannot judge motion or rasterize some renders. Real Chrome over CDP is
  the verification path for anything visual (standing lesson from the attachments build).
- Deploy is `railway up` ONLY, never `railway domain` (it CREATES a public domain; that is how the
  identity incident happened).
- Every UI asset change needs the cache-bust trio: SW SHELL entry, CACHE version bump, and the
  index.html `?v=` query.
- Snapshot before every write batch; rollback path recorded before any deploy.

## Phase log

| Phase | State | Notes |
| --- | --- | --- |
| 0 Groundwork | DONE | Worktree `minipc-chat-ide` on `feat/ide-mode` from e7aae5d; 6 rulings locked; FITS pack open; `ide.mjs` gate + `IDE_MODE` env + `/account.ideMode`; ide_test 7/7; all 28 existing suites green; verified live on devboot (owner true / guest false) |
| 1 Toggle + reveal | DONE | Drawer toggle + `#ide-root` third reveal, stage-lift motion (shell -112vh out the top, works rise from 104vh), mutual exclusion wired both ways, Escape, composer trigger, SW v61 + `?v=1` trio. Verified live in-browser: lift geometry numerically correct, server authoritative over localStorage, guest walled, zero console errors, 29/29 suites |
| 2 Workspace + job spine | DONE | `idejobs.mjs` disk-journalled durable spine (replay, reattach, restart recovery, per-user multi-job registry) + `ide.mjs` workspace registry/prefs/gate stack + `/ide/*` routes + `isProtectedPath` carve-out on roots. 31/31 suites. Verified live: a job COMPLETED with zero clients attached then replayed 8 events; a container killed mid-job came back sealed `interrupted`, never "running" |
| 3 Router + Assignment Board | DONE | `iderouter.mjs` deterministic table (extension + folder + keyword, confidence bands, cheap tiebreaker only when ambiguous, degrades to the free answer on failure) + Assignment Board UI + live route preview + `POST /ide/route/preview`. Verified live: design work reaches gpt-5.6-terra, images reach Dominion Forge, grunt work reaches the cheap tier, each with its reason |
| 4 Background persistence + callback | not started | |
| 5 Build engine | not started | |
| 6 Two lenses | not started | |
| 7 Scale tier | not started | |
| 8 Hardening + guest rollout | not started | |
