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
| A3 | The service worker can fetch /ide/jobs through Cloudflare Access when woken by a push | `[assumed]` | UNVERIFIED and load-bearing: the payload-free design means a wake-up with no readable state produces NO notification at all. Probe on Fred's Pixel before guest exposure |
| A4 | Per-user Forge nodes stay connected long enough for multi-move builds | `[assumed]` | Phase 4.9 node-loss handling makes this survivable either way |
| A5 | Provider implicit caching will pay once prefixes are byte-stable | `[assumed]` | The prefix is now a frozen constant and a test asserts it is byte-identical across moves. Whether providers actually credit it is still UNMEASURED: compare cache hitPct in usage.jsonl once real builds run |
| A6 | Writing files one dispatch at a time is fast enough | `[assumed]` | The engine writes per file through the node rather than via scaffold_project, so the 200-file cap does not apply, but per-file latency is UNMEASURED against a real node. Time it during the wiring step |
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
| L-1 | VAPID keys | Blocks push in prod | HALF CLOSED: keypair generated at `F:\Claude Sandbox\dominion-ide-vapid-keys.txt`. STILL TO DO before deploy: put the three values in the wallet and on Railway (`DOMINION_IDE_VAPID_PUBLIC/PRIVATE/SUBJECT`). Without them push stays off and says so; nothing else degrades |
| L-2 | Billing races (autoRecharge mutex, addSponsoredSpend atomicity) predate this build | Guest parallel builds can double-charge | OPEN, due Phase 8.2 before guest flip |
| L-3 | Merge-to-main coordination | Integration risk | HALF CLOSED: main merged INTO this branch at b30fcb9 (2 conflicts, both kept-both-sides; catalog/route/carve-out integration points re-verified after). The final merge back to main is still pending |
| L-4 | Real-device push delivery never verified | Cannot confirm a notification actually lands | OPEN, needs Fred's phone. The send path is proven (VAPID JWT verifies against its own public key; a real signed request reached Google and the dead endpoint was pruned), but no notification has been delivered to a real device. iOS additionally needs the PWA installed to the home screen, which the client detects and states plainly |
| L-5 | Toggle state was per-device only | Low | CLOSED in Phase 2: prefs live in the per-account IDE store, `POST /ide/prefs` on every flip, and a device with no stored opinion adopts the account's. A device that HAS an opinion keeps it, so the phone in your hand outranks a decision some other machine made |
| L-8 | Vision judge not yet live-proven in one continuous run | The see-loop's last step | OPEN: every stage proven individually (real screenshot captured on the first bakery run; the multimodal data-URL wire is the attachments feature's, live in prod), and readiness-wait + retry landed for the local Chrome flake. Needs one clean run, likely on the mini-PC or in prod |
| L-7 | `governance_test.mjs` fails intermittently on an `rm` cleanup race | Noise only, no assertion involved | OPEN, pre-existing. Passes ~2 of 3 standalone and 37/37 in two consecutive full-suite loops. Windows file-handle contention on temp-dir teardown, not a code defect. Worth a retry-on-EBUSY in the test's cleanup |
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

## Ship record

**ITERATION 1 DEPLOYED 2026-07-21** (merge b3059e9 fast-forwarded to main, pushed to GitHub,
`railway up` from the main worktree, boot verified: all four providers keyed, mini-pc + laptop
hands nodes connected, all four Crucible assets serving 200 from the live container, SW cache
`dominion-ai-v82-crucible-ships`). IDE_MODE is unset in prod so the surface is OWNER-ONLY; guests
see nothing until Phase 9 flips it. VAPID keys live on Railway (DOMINION_IDE_VAPID_*), so push is
armed. Rollback: redeploy b8f4fb2 (git checkout + railway up), or the Railway dashboard's previous
deployment. Known pre-existing failure shipped WITH main: chatjobs_unit_test EPERM on temp cleanup
(fails identically on untouched main; ledgered, never an assertion).

## Phase log

| Phase | State | Notes |
| --- | --- | --- |
| 0 Groundwork | DONE | Worktree `minipc-chat-ide` on `feat/ide-mode` from e7aae5d; 6 rulings locked; FITS pack open; `ide.mjs` gate + `IDE_MODE` env + `/account.ideMode`; ide_test 7/7; all 28 existing suites green; verified live on devboot (owner true / guest false) |
| 1 Toggle + reveal | DONE | Drawer toggle + `#ide-root` third reveal, stage-lift motion (shell -112vh out the top, works rise from 104vh), mutual exclusion wired both ways, Escape, composer trigger, SW v61 + `?v=1` trio. Verified live in-browser: lift geometry numerically correct, server authoritative over localStorage, guest walled, zero console errors, 29/29 suites |
| 2 Workspace + job spine | DONE | `idejobs.mjs` disk-journalled durable spine (replay, reattach, restart recovery, per-user multi-job registry) + `ide.mjs` workspace registry/prefs/gate stack + `/ide/*` routes + `isProtectedPath` carve-out on roots. 31/31 suites. Verified live: a job COMPLETED with zero clients attached then replayed 8 events; a container killed mid-job came back sealed `interrupted`, never "running" |
| 3 Router + Assignment Board | DONE | `iderouter.mjs` deterministic table (extension + folder + keyword, confidence bands, cheap tiebreaker only when ambiguous, degrades to the free answer on failure) + Assignment Board UI + live route preview + `POST /ide/route/preview`. Verified live: design work reaches gpt-5.6-terra, images reach Dominion Forge, grunt work reaches the cheap tier, each with its reason |
| 4 Background persistence + callback | DONE | `idepush.mjs` (VAPID ES256, payload-free wake-ups, escalation policy, per-device subs) + sw push/notificationclick + status rail visible on the CHAT surface + reattach triad + pause-and-ask with structured one-tap answers + node/account-aware escalation. 36/36 suites. Verified live: a build asked, sat frozen spending nothing with nobody attached, was answered from another client, and finished itself; a real VAPID-signed push went to Google and the dead device was auto-pruned |
| 6 The two lenses | DONE | `dominion-lenses.js/.css`: Blueprint (numbered plain-English cards, state, rationale, model chip whose tooltip carries the router's reason, restore-point note, outcome) and Workshop (folded file tree, coloured diffs, check console). Both reduce the SAME journal, so they cannot disagree. Lens choice persists. Verified live: renders while running, replays byte-identically after reload, Workshop keeps content across a lens switch |
| 8 Speak-plainly + run-and-see | DONE | Three registers (plain/technical/hybrid) at EVERY level: idelang.mjs (server sentences incl. runner questions + planner voice) + dominion-lexicon.js (client chrome); picked at the front door, persisted both sides; first-open intro card explains built vs running vs online; publish invitation on done. Run-and-see: idesee.mjs installs deps, launches preview detached, screenshots via the machine's Chrome, vision-judges vs the goal (pickVisionModel by key presence), ONE polish round, honest skip at every gap. Image-classed moves reroute to design_code with placeholder art (live bug: dominion-forge fed to the text pipeline looped a beginner through retry). DEVBOOT_ALLOW_PAID knob added |
| 7 Quality pass | DONE | Nine defects hunted and fixed after the wiring: unreleasable build pauses (waitForAnswer, race-safe), failure fork (retry/skip/stop + free-text steers the retry), language-fence files, repair false-success, missing diffs (lineDiff + events), lens freeze on transient drop, reconnect flicker on normal close, rAF debounce blank in hidden tabs (timer now), update() silently dropping flat patches incl. budget. Plus the FRONT DOOR: folder + sentence + Start, push permission asked at first build. Live-proven: UI-started build froze at a one-cent cap, one tap released it, farewell.js written and working, Workshop shows the real +5/-0 diff |
| 5 Build engine | DONE (wired + live-proven) | `ideengine.mjs`: smallness check, blueprint parsing, manifest context, frozen cacheable prefix, snapshot-before-write, carve-out pre-scan with a readable refusal, discovered verify command, one repair round, budget stop-before-overspend, meter-once-on-finally. 18 engine tests, 37 suites total, all with injected fakes. REMAINING: wire a real `build` job kind to cloudChatStream + a live hands node and run it against a real project |
| 6 Two lenses | not started | |
| 7 Scale tier | not started | |
| 8 Hardening + guest rollout | not started | |

## Iteration 1.1 ship record (2026-07-21 evening, main 2c3b737, cache v86-crucible-intake)

Four Fred rulings landed in one wave after iteration 1 went live, all verified against the live
container (`railway ssh` sw.js probe returned v86-crucible-intake):

1. **Folder picker.** POST `/ide/browse` dispatches `fs_browse` on the tenant's hands node via the
   shared `ideHandsFor(T)` (owner node vs guest uid-bound node, never both). No path = drive list;
   carve-outs refused at the node. Client tree walker in the front door: Browse, tap through,
   "Build in this folder" registers the workspace in one motion. Confirmed the mini-PC node already
   carries fs_browse (shipped de96963 on 07-17; node file dated 07-20).
2. **Quoted paths parse.** validateRoot and the client field strip wrapping straight and smart
   quotes (Windows "Copy as path", phone clipboards). idestore_test covers both shapes.
3. **Assignment Board is opt-in.** Hidden behind "Use all the default tools (recommended)" /
   "Customize" (per-device `dominion.crucible.tools.v1`). Choosing defaults DELETES stored keys
   rather than blanking them: an empty-string assignment counts as a choice in resolveAssignments
   and routes to the main model instead of the curated default.
4. **Intake interview.** `ideintake.mjs` + POST `/ide/intake`: the workspace's build_code model
   (resolved exactly as the build resolves it) interviews one question at a time with a
   three-question floor, judges experience level from the user's own words (results-talk for
   beginners and vibe coders, precision for engineers), calls out contradictions, then emits a
   VISION READY marker plus bullets. parseIntake honours the marker only on its own line; a bare
   marker is noise. The approved vision rides into the build prompt as AGREED VISION; a skip link
   keeps the fast path; the chat minimizes to its head bar. Live-proven in dev on kimi-k3: three
   real clarifying questions to an approved bullet vision, then Build this / Keep talking.
5. **Guided tour** (`public/dominion-tour.js`). Numbered popups hover beside the section they
   explain (fixed-position card, arrow slides along its edge via --ax), Next moves the view, Skip
   offered at the start, a small ? in the rail recalls it forever. Begin flips to guide mode: an
   arrowed prompt points at the ONE control to touch now and advances by watching real state
   (folder picked, brief written), ending when the first build starts. `dominion.crucible.tour.v1`
   prevents re-shows; the tour waits for the intro card's OK so the two never stack.

Tests: ideintake_test 8/8 new, idestore quoted-path cases, full suite green in isolation
(chatjobs_unit EPERM pre-existing; images_test red only under parallel port contention, passes
alone). Width honesty held at 412 and 320 with the new furniture. New DOM events for the tour:
dominion-crucible-open, dominion-ide-vision, dominion-ide-workspace, dominion-ide-build-started.

Dev lesson: devboot inherits its environment, so the wallet must be sourced in the SAME shell
(`set -a; . ~/.app-secrets.env; set +a; DEVBOOT_ALLOW_PAID=1 node devboot.mjs`) or ALLOW_PAID has
no keys to keep. defaultModelFor in dev resolves to DeepSeek direct which has no dev key; assign
kimi-k3 on the workspace to exercise intake locally.

Open after 1.1: Fred's phone pass on the new furniture; guided deploy (the publish card still says
upcoming); L-8 vision judge in one continuous run; L-4 real-device push; guest flip.

## Iteration 2 ship record (2026-07-21 night, "no phases: all things as decided, commit each")

Fred's rulings: 1a (user picks mode, stable switch), 2a (simpler intentional layout), 3a (real
tunnel), 4a (mode sets register silently). Commits 975caad, 174550f, e8f0510, 9d335e5; cache
v88-live-preview.

**Three modes.** idemodes.mjs: normalizeMode fails safe to beginner; MODE_DEFAULTS carry register/
tour/board/code-lens; personaVoice (mentor / sharp collaborator / cold executor) reaches the
intake interviewer AND the planner; aestheticsVoice teaches the beginner interviewer the MOCKUP
protocol; visionExtras flags database/accounts/payments/messaging/external deterministically and
prices a cost BAND from move count and model rates. prefs.mode stores "" as never-chosen so the
three-cards picker appears exactly once; a segmented switch in the starter head changes mode any
time; the account remembers mode, the device keeps the last word.

**Per-mode surface.** Beginner: chat + folder picker, no register question, no tools, no board,
tour auto. Vibe: one honest model sentence (never contradicts the board: saveAssignments repaints
it) + Customize; involves card (cost band + commitment flags) lands before Build this. Engineer:
four labelled drawers in dependency order (Workspace, Brief, Assignments, Register), closed by
default, board inside Assignments; technical register; no auto-tour (marked done on sight).
Non-engineers see zero drawer chrome (summary hidden, details forced open by applyMode).

**Lenses.** Blueprint: ONE container of compact rows replaces the fifteen-boxes stack; tap a row
for detail (engineers inline); a finished build folds to one sentence for non-engineers
(reopenable) so the publish card leads. Workshop: Try-your-app live preview section for all;
code automatic for engineers, Show-the-code toggle otherwise; checks visible to everyone;
side-by-side code + sticky preview for engineers at >=900px. dominion-build-done fires once per
completed job.

**The tunnel (ruling 3a).** hands/2 preview_fetch: reaches ONLY 127.0.0.1:37311, GET/POST/HEAD,
bounded bodies (2MB up / 6MB down), no websockets. /ide/preview/p/* relays iframe requests over
the hands channel (raw-body POST handled before JSON parse); HTML gets <base> + absolute-path
rewrite (href/src/action="/..." and url(/...)); redirects re-prefixed. /ide/preview/start runs
deps + detached launch + port poll via createRunAndSee's exported internals; stop kills the tree;
one preview per account, 20-minute hard lifetime. Mini-PC node UPDATED to hands/2 over SSH
(backup at C:\dominion-hands\hands.mjs.bak-v1) and confirmed running.

**BUG THAT MATTERED (and closed half of L-8):** PS 5.1 Start-Process joins ArgumentList elements
UNQUOTED, so the static server's -e one-liner (contains spaces) arrived at node as dozens of
arguments and the preview NEVER listened; run-and-see's static path could never have served a
page. Elements now carry their own double quotes; a guard keeps the one-liner double-quote-free;
proven live by hand and through the whole tunnel.

**Verified live (devboot + local hands node):** picker (three cards, everything else hidden),
all three mode skins incl. register flips, drawers closed/open per mode with board inside,
tunnel end-to-end (base injected, relative kept, absolute rewritten, 404 honest, stop kills),
width honest at 412 throughout. Suite: 47/49 with the two known non-regressions (chatjobs_unit
EPERM pre-existing; images_test parallel-only port collision, passes alone).

**OPEN (ledgered):**
- L-9: engineer's docked-at-bottom chat in the Workshop (the intake chat lives on the front
  door; moving it per-lens is a state refactor, not done tonight).
- L-10: beginner closing flow is publish-card-led; the "chat becomes prominent and walks through
  hosting" moment still speaks through the publish explainer, not a live chat turn.
- L-11: SPA absolute-path fetches inside the relay can 404 (honest scope; engine products fine).
- L-12: guided tour steps not yet re-pointed at the drawer layout for engineer mode (tour is
  beginner-facing, engineer auto-marks done, so exposure is low).
- Mockup loop and per-mode intake verified at the parse/prompt level and by earlier live intake;
  a full beginner mockup round on the phone is Fred's first-run item.

## Iteration 2.1 ship record (2026-07-22 early, Fred's first phone pass answered)

Process, per Fred's directive: Fable 5 chunked the work and wrote specs, five Haiku agents wrote
five disjoint-file chunks in parallel (told: never git, only your files), an Opus 4.8 agent
reviewed and corrected each as it landed, Fable did the final fidelity pass. Verdict on the
process: Haiku shipped real defects in four of five chunks (a position:fixed override, a veil
that dimmed its own target through a stacking-context miss, an inverted publish gate that
suppressed the modal permanently, a draft cleared on build start); Opus caught and fixed all of
them; Fable's pass then caught a drawer-grid width regression (the lone-auto-column trap, third
occurrence in this project) and the missing lock tick on the compact picker. The layered crew
earned its keep.

Fixes shipped (cache v89-furnace, commits 2dd9282 + caa3696 + d34b376):
- Compass: commit 0.18 of screen + flick-velocity commit (0.35 px/ms / 80ms window), 650ms
  cubic-bezier travel, solid copper divider bar (#ide-divider-bar) with orange bleed, App
  Builder label during drag/travel that fades at rest.
- Tour: blurred veil INSIDE #ide-root (body-level would paint over the whole panel), target
  lifted above it, 19px/800 titles, viewport clamping, per-mode steps (language step deleted),
  auto-advance past done steps, hard halt with a closing card on dominion-ide-build-started.
- Front door: mode cards under the header, don't-show-again tick on BOTH picker forms (tick =
  dismissal; header switch remains the stable control), drafts saved 400ms-debounced and
  restored under 48h, cleared only on completion; Start resumes an active interview; beginner
  has no button cluster and says "build it" in chat; flame indicator with timer on every work
  order; friendly timeout/network failures; needs-you card glows and scrolls into view.
- Lenses: bold Blueprint/Workshop header, publish is a live-completion-only modal (replayed
  done jobs auto-marked seen), sync never follows corpses, Past-builds log panel.
- Server: beginner mentor at an 8th grade ceiling, proactive, motivation question, ambitious-
  app encouragement, say-build-it invitation; EVERY mode's interviewer carries idehelp's
  CRUCIBLE_GUIDE (environmental awareness).
- THE FURNACE PASS (standing doctrine, d34b376): every build ends with a deterministic
  placeholder sweep + a vision fidelity audit (per-bullet Delivered/Missing on the review
  model) that becomes a Close-them-now / Finish-as-is question. idehelp must be updated in the
  same commit as any UI change; idefurnace_test enforces the guide's feature roll-call.

Verified in dev browser at 412: width clean, drafts round-trip, compact picker + lock, no
stale publish, per-mode tour with veil, log panel rows, flame API. Motion feel and the full
beginner mockup round remain Fred's phone items. Suite 48/50 (two known pre-existing).

## Overnight run 2026-07-22 (three waves, all crew-built: Haiku writers, Opus reviewers, Fable engine work + final pass)

Shipped v93-conversation-surface (commits f873f54 + 5c5f790, live, byte-verified):
- Iteration 2.3 beginner door: POST /ide/workspace/auto (home = $env:USERPROFILE, "Dominion
  Apps\<Title Cased Name>", reuse on collision, register-dictionary failures, offline flag),
  autoWorkspaceName pure + tested, chat revealed on first AI reply, plain-English relabels.
- Iteration 3, the conversation IS the surface: chat always visible, canned Howdy in register,
  dream typed in the chat; beginner sees NO drawers (chat fills, 58vh); vibe chat above the
  full drawer set; engineer drawers first, chat under; /ide/intake works with no workspace so
  the interview runs before a computer is connected; GET /ide/node; offline install script
  (canned, app.dominion.tools), 20s poll for as long as the panel is open, celebration line,
  never re-asks the dream; workspace auto-creates silently for beginner+vibe; Continue button
  retired everywhere; tour points beginners at the conversation.

Shipped v94-af-window (commit 0879359, live):
- AF window (vibe+engineer): rows Task/Model/Number, plus sign, default template (divide w/
  contracts, 5 workers, reviewer, QC), persists at assignments.af per workspace.
- ideaf.mjs (classification, divider format, parser with path guards, referee reporting every
  colliding pair, afAssignFor) + ideafrun.mjs (relay plan moves, write-time cookie rule).
- Engine relay in runIdeBuild: parallel worker MODEL CALLS, sequential writes (one snapshot,
  staged verifies), referee refuses overlaps with one redo then finishes honest (af_refused),
  reviewer per part vs contract, QC on the seams, budget freeze before the batch, failed parts
  fork to the user, Furnace still ends every AF build. Small asks skip the crew (af_small).
- Crew defects caught this run: divider CONTRACT lines overwrote instead of accumulating
  (Fable), triple-claim overlap missed the (2,3) pair (Opus), AF card grid mis-tracked (Opus),
  1s/60-poll node watch instead of 20s/unbounded (Fable), engineer pointed at Continue (Fable).

Ledger adds:
- L-13: post-build arc beats (asks if happy, conversational deploy explainer) still live in the
  publish modal, never in the chat; Fred's arc wants them conversational after the build too.
- L-14: AF pipeline has no live end-to-end run yet (unit + round-trip proven; first real AF
  build should be watched).
- Fred phone pass pending on ALL of tonight: beginner Howdy flow, vibe/engineer layouts, AF
  window, at 412/320.
