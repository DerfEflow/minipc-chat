# The Crucible, Iteration 2: Three Modes

SOW drafted 2026-07-21 from Fred's ruling. Status: AWAITING RULINGS on the open questions at the
bottom, then build. Companion docs: IDE-MODE-ROADMAP.md (iteration 1 SOW), IDE-MODE-BUILD.md
(FITS pack; this iteration appends to it when the build starts).

## The critique this answers (Fred, verbatim intent)

- The model picker reads as random, disconnected from the flow of the user's thought.
- The build view repeats every action in its own container, fifteen identical boxes in a row.
  To a beginner it is literally a waste of time; they do not understand a word of it.
- Blueprint vs Workshop has no obvious purpose when the only visible difference is that one
  reveals code and the other does not.
- There is no way to guide aesthetics, and beginners care about aesthetics more than function.
- The AI needs a different job per audience: mentor and encourager for some, workhorse for
  others, and a cold robot with massive compute and no personality for the rest.
- The value of the design is the intuitive layout and the way it simplifies each step.

## The core idea

One switch, chosen by the user, changes everything downstream: **Beginner / Vibe Coder /
Software Engineer**. Mode drives layout, level of detail, default language register, step
descriptions, model handling, lens behavior, and the AI's persona. The register picker we
shipped in iteration 1 stays as the underlying machinery; mode sets its default and the user
can still override it in settings.

| | Beginner | Vibe Coder | Software Engineer |
| --- | --- | --- | --- |
| Layout | Chat window + folder picker. Almost nothing else visible. | Feature-rich but intentional; the essentials plus honest cost and complexity. | Everything available, but in CLOSED drawers named by function, ordered by dependency. |
| Language default | plain | hybrid | technical |
| Model handling | Invisible. Curated defaults, never mentioned. | One sentence: which brain is doing the work and what it costs, with a change link. | Full Assignment Board in its own drawer. |
| The AI is | A mentor and encourager. Celebrates progress, explains by result, never by mechanism. | A sharp collaborator. Intuits the nuance in the vision, is upfront about cost, connectors, databases, servers, domains. | A cold executor. Terse, precise, zero cheerleading, maximum information density. |
| Build view | Live preview of the app they can tap through and test. Code hidden (toggle exists). | Live preview first, code toggle one tap away. | Code and design preview side by side, chat docked at the bottom. Code reveal automatic. |
| After the build | Windows close, chat becomes prominent, walks them to putting it online. | Same closing flow plus the deploy cost/complexity talk. | A completion summary; the engineer knows what to do next. |

## Blueprint and Workshop, redefined

The names stay, the jobs finally differ:

- **Blueprint = the design and brainstorming suite.** Purpose, layout, function, aesthetics.
  It holds the intake conversation, the agreed vision bullets, the aesthetic direction (below),
  and the plan, PRESENTED AS A DESIGN, never as a checklist of model calls. The repetitive
  per-move containers die here for everyone: repeated actions collapse into grouped rows
  ("Wrote 15 files" as one row that expands), and each group speaks in the mode's voice.
- **Workshop = where the thing exists.** For Beginner and Vibe Coder it is a LIVE PREVIEW of
  the built app they can click through and test, feeding reactions back into the chat, which
  applies changes. For the Engineer it is code beside preview. The code view is automatic for
  engineers and a toggle for everyone else.

## Aesthetics first (the Beginner spine)

Beginners want the look before the plumbing, and today nothing guides that. The flow:

1. The intake chat (shipped in 1.1) starts with WHAT it is, then moves deliberately to what it
   should FEEL like: colors, mood, era, favorite apps or places, "show me things you love."
2. The AI produces visual design candidates as IMAGES: mockups of the app's main screen,
   generated through the existing Forge Images pipeline (gpt-image-2). They appear as preview
   cards the user taps through, reacting in the same chat: warmer, bigger buttons, less
   clutter. Iterate until they say "that one."
3. The chosen mockup plus the agreed vision bullets ride into the build prompt as the design
   contract. design_code moves receive the mockup as the target to match.
4. After the build, the Workshop live preview lets them compare what got built to what they
   chose, and the chat takes change requests.

Two ways to place the previewer (RULING NEEDED, question 2 below): inline cards inside the
Crucible chat with tap-to-expand, or porting the user to the Forge Images panel with the chat
following them there.

## Honesty about money and complexity (the Vibe Coder spine)

After the vision bullets and before Build this, Vibe Coders get a "what this involves" card:
an estimated cost band for the build (we have per-model pricing and a move-count estimate),
plus plain flags for each piece of real-world complexity the vision implies: needs a database,
needs user accounts, needs a paid hosting home, needs a domain name, talks to an outside
service. No surprises mid-build. Beginners get the same facts later, at the deploy talk, in
gentler words. Engineers get the numbers inline and nothing else.

## The live preview tunnel (the hard engineering)

The click-through preview requires the phone to reach an app running on the build machine
(run-and-see already launches it on port 37311, hands-node side). Customers' machines are not
on our network, so the path is a proxy through the existing hands channel: the server relays
HTTP requests to the node, the node fetches localhost:37311, responses stream back chunked
(the fs_append chunk transfer already proves the channel carries bounded pieces). Scope
honestly: static pages, forms, and fetch calls will work; websockets will not, and that is
fine for iteration 2. Fallback if the tunnel slips: interactive screenshot walkthrough
(tap a hotspot, node clicks, new screenshot), which is uglier but shippable.

## Phases

| Phase | What ships | Acceptance |
| --- | --- | --- |
| 1. Mode framework | Mode picker at first open (three cards, one tap, changeable any time in a settings drawer), per-mode defaults wired: register, tour, board visibility, persona lines in idelang + intake prompts. Account-remembered, device-overridable, same split as engaged/allowed. | Switching modes visibly re-skins the front door with zero reload. |
| 2. Blueprint rework | Grouped compact timeline (kills the 15-containers problem for every mode), design-suite framing, vision + aesthetic direction shown as the plan's head. | A 20-move build reads as a handful of grouped rows in plain mode. |
| 3. Beginner aesthetics | Aesthetic interview stage in intake, mockup generation through Forge pipeline, preview cards + pick, design contract into the build. | A beginner reaches "that one" without seeing a single technical word. |
| 4. Live preview | Hands HTTP proxy route, Workshop preview iframe for Beginner/Vibe, click-through + feedback-to-chat loop, post-build closing flow (windows close, chat prominent, hosting walkthrough). | Fred taps through a built app on his phone while the build machine sits in another room. |
| 5. Vibe Coder honesty | Cost band + complexity flags card between vision and Build this. | The card's estimate lands within the budget freeze's real numbers. |
| 6. Engineer surface | Drawer layout (closed by default, named by function, dependency-ordered), side-by-side code + preview, docked chat, terse persona. | The full board, budget, journal and diffs all reachable in two taps, nothing open by default. |

Each phase lands with tests, register coverage, width honesty at 412/320, and a live verify,
per the iteration 1 discipline. Blast radius HIGH, full FITS.

## Open questions for Fred

1. Mode choice: user picks from three cards at first open (AI may suggest switching if the
   chat reveals a mismatch), or the AI silently infers mode from the conversation.
   RECOMMENDATION: user picks; being told "you seem like a beginner" by a robot is a bad first
   date, and a wrong silent guess poisons everything downstream.
2. Beginner design previews: inline cards in the Crucible chat with tap-to-expand, or port the
   user to the Forge Images panel with the chat following. RECOMMENDATION: inline cards. Same
   Forge engine underneath, but the user never changes rooms, and the chat never has to chase
   them.
3. Live preview: build the real proxy tunnel in iteration 2 (the killer feature, roughly a
   phase of work on its own), or ship the screenshot walkthrough first and tunnel later.
   RECOMMENDATION: build the tunnel; the beginner loop is hollow without real tapping.
4. The language question at the front door: keep asking it, or let mode set it silently with a
   change control in settings. RECOMMENDATION: mode sets it silently; one question fewer at
   the door, and the register machinery stays for anyone who wants to override.

## The Furnace doctrine (Fred's ruling 2026-07-21, standing, every build, no exceptions)

Why this exists, in the owner's framing: Replit would claim a fix that was not fixed, break other
things silently, know nothing about its own interface when asked what a section was for, and
declare production-ready apps that were 60% built with placeholders and mismatched variables.
The Crucible's differentiator is therefore:

1. SITUATIONAL AND ENVIRONMENTAL AWARENESS. The AI that talks to the user KNOWS the surface it
   lives in: what Blueprint and Workshop are, what the compass does, what the modes mean, where
   the folder picker is, what the preview does, what publish means. Implementation: a single
   self-knowledge module (idehelp.mjs, CRUCIBLE_GUIDE) injected into the intake interviewer and
   the build runner so "what is this section for" always gets a true, current answer.
   STANDING RULE: any change to the Crucible's UI updates idehelp.mjs IN THE SAME COMMIT, the
   way the SW cache trio moves together. A test enumerates the surface's features and fails if
   the guide stops mentioning one.
2. DISCIPLINED WORKFLOW LOGIC (the Furnace pass). Every build ends with an honesty audit before
   "done" may be said:
   a. Placeholder sweep (deterministic, engine-side, free): scan every written file for TODO,
      FIXME, PLACEHOLDER, XXX, lorem ipsum, coming soon, and empty function bodies; anything
      found is reported plainly, never hidden.
   b. Vision fidelity check (one model call): compare the AGREED VISION bullets against what was
      actually written; report each bullet as delivered or as a named gap, in the user's
      register; offer to close gaps rather than declaring victory.
   c. "Fixed" claims must be verified claims: a repair is only reported fixed after the
      project's own check has rerun green.
3. REAL-TIME ORCHESTRATION: the deterministic router, budget stops, pause-and-ask, and the
   journal remain the spine; no move is fire-and-forget.
4. TEACHING COMMUNICATION: every stage explains what just happened and what happens next, at
   the mode's register and level; the app should leave the user more capable than it found them.

## AF: the Agentic Workflow window (Fred's design 2026-07-22, APPROVED to build after the v89 phone pass)

An AF button beside the model line (vibe) and in the Assignments drawer (engineer), never for
beginners. Opens a glass panel of rows, plus sign beneath to add more, three headed columns:
Task (free text, no dropdown) / Model / Number. Default template prefills Fred's pipeline:

| Task | Model | Number |
| --- | --- | --- |
| Divide the work and write the contracts | A | 1 |
| Build the parts, one agent per part | B | 5 |
| Review and fix each finished part | C | 1 |
| Final quality check of the whole | A | 1 |

LAWS (Fred's rulings, non-negotiable):
1. The cookie rule: no two agents ever touch the same chunk. The divider grants each worker
   EXCLUSIVE ownership of named files, and the orchestrator verifies disjointness in CODE and
   refuses overlaps before any worker starts. The guardrail is a referee, never a promise.
2. One model per line item in the task list: cohesion of voice within each piece.
3. The divider writes CONTRACTS (each part's promises to the others), so workers build to
   contract and the unify/QC stages verify seams instead of rebuilding them. Quality holds
   while speed multiplies.
4. Scale = whatever the user pays for (1 to 25+ workers); cost multiplies only on worker rows;
   the budget freeze remains the seatbelt. Honest wall-clock: divide + slowest part + unify +
   review (3-4x on five workers, never 5x).
5. Task wording is classified by the existing router (divide/split -> divider, review/fix ->
   reviewer, check/QC -> qc, else worker). Rows persist per workspace (assignments.af).
6. Blueprint shows the relay honestly: who owned what, what the referee refused, what the
   reviewer fixed. The Furnace pass still ends every AF build.
Racing variant (N agents attempt the same step, judge picks the winner) is a later addition on
the same panel, distinguished by wording; v1 is the partition pipeline above.

Proven in anger before it was a feature: iteration 2.1 itself was built exactly this way
(Fable divided into 5 disjoint-file chunks with specs, 5 Haiku wrote in parallel, Opus 4.8
reviewed each, Fable did final QC). The defects each layer caught are logged in the build pack.

## The conversation IS the surface (Fred's ruling 2026-07-22, supersedes earlier front-door layouts)

BEGINNER: a large chat window and nothing else. The AI opens unprompted: "Howdy, what can I
help you build?" The whole journey is conversational:
- User answers with their dream. If no computer is connected, the AI itself explains, folksy
  and plain: it needs somewhere to store the work, this app uses YOUR computer for that; if
  you are on your phone, turn your computer on, open a web browser, type app.dominion.tools,
  and install this same app there; then the two talk to each other and you can build from
  anywhere. "Let me know when it is set up, and if you get stuck, just ask me for help."
  (Canned client-side beats in Fred's voice, zero model spend; the app polls for the node and
  fires the next beat when it connects.)
- On connection: "I see you got my buddy all set up on the computer... we have already had a
  conversation and we have decided we like you." Then it resumes with the dream they already
  told it (never make them repeat), or offers suggestions if they have none.
- The interview arc, in order: the dream; personal use or making money with it (motivation);
  colors and style ("I can make it look like nearly anything. Take your time."); then the AI
  suggests giving it a FIRST SHOT (the MVP) and they tweak from there through conversation,
  iterations and refinement.
- The AI asks if they are happy, because it never gets tired of helping. When they say yes, it
  explains in rudimentary language how an app is put online and what that requires, promises
  step-by-step directions, and reassures: everything is saved on the computer it is talking
  to, safe to refine later or put on the internet for the world to admire.

VIBE CODER: the same chat window, plus all the options BELOW it in the clean closed-drawer
organization (the engineer's discipline with plain-English drawer names). They can get as
technical as they want or just talk; the AI guides either way.

ENGINEER: drawers first, chat UNDER them: secondary, but a useful helper.

Context for the ruling: Fred toured all three profiles and found the engineer page (closed
labelled drawers) cleaner and more sensible than the pages meant to be easier. The fix is
subtraction for beginners (chat only) and the drawer discipline for everyone else.
