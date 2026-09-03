# Dominion AI Field Guide: The Crucible and the Game Factory

Written 2026-09-03 against production commit 1e76a89 at app.dominion.tools (the Crucible stabilization of the afternoon plus the Game Factory build of the evening). This guide covers only features that exist in that build and describes each one the way the screen actually shows it. Where a feature was proven, the guide says how:

- **Production**: measured against app.dominion.tools after deploy.
- **Rig**: the exact production code booted locally with production keys and real providers.
- **Unit**: covered by the automated suite (proves wiring, not real-world function).

Where something is deliberately not built yet, the guide says so instead of implying it works.

---

## Part I. The Crucible

The Crucible is Dominion's app builder. You describe an app in plain language, it interviews you until the picture is clear, plans the work as numbered steps, and then writes real files into a real folder, either on your own computer or in Dominion's cloud workshop. Every build takes a restore point first, runs on its own branch, and ends with an honesty check against the vision you agreed to.

### 1. Before you start

1. Sign in at app.dominion.tools. The Crucible is open to every signed-in account (the production flag `IDE_MODE` is `all`).
2. Decide where builds should run. There are two lanes:
   - **On my computer**: a small Dominion node runs on the machine that holds the project. The node installer is a zip containing `Connect Me To Dominion.bat`, a README, and the node script. It needs no admin rights and installs no background service; it works only while its window is open.
   - **In Dominion's cloud workshop**: a machine that exists only while a command runs. Files there are real and yours to download. The Engineer workspace drawer offers this as a choice under **Where new builds run**.
3. The Engineer level runs long, real builds, so a customer account must have **Automatic Top-Off** enabled before it opens. The screen says so and offers **Enable Automatic Top-Off**. Beginner and Vibe Coder have no such requirement.

> **Proof.** Lane chooser and top-off gate: Unit. Node installer zip: documented in the guest node build of 2026-07-31; not exercised in this session.

### 2. Opening the Crucible

1. On a computer, use the navigation rail on the right edge of the screen. It lists The Foundry (Image Generator), Forge Dial, **The Crucible (App Builder)**, Video Generation, and, for the owner only, Game Factory. On a phone the same rail runs along the bottom.
2. The **welcome screen** appears once per session with three buttons: **Beginner**, **Vibe Coder**, **Engineer**. A **Return to chat** button under them leaves without choosing. Your choice is remembered per account; the device you are holding keeps the last word.
3. The header names the surface by level: Crucible App Builder (Beginner), Crucible App Launcher (Vibe Coder), Crucible Full Stack Platform (Engineer). **Change level** in the header reopens the welcome screen at any time. **Return to chat** at the top left is the way out.
4. The **?** button replays the guided tour: the screen dims except a spotlight around the control being described.

**Another door: Send to Crucible.** In the main chat, once a conversation is actually about something (two exchanges, or one substantial message), a **Send to Crucible** button appears. It reads the chat into a project brief, makes the folder, and hands off to the Crucible with the level picker showing.

**A third door: Start from a plan.** A plan made in the main chat (a roadmap, phases, a task list, an MVP) can be saved and then loaded or pasted from the **Start from a plan** drawer. Picking one names the project and fills the brief.

> **Proof.** Rail, welcome layer, level names, tour: Unit (the in-app guide is enforced by a feature roll-call test). Send to Crucible and Start from a plan: Unit.

### 3. The Beginner path, step by step

The Beginner screen holds four things and nothing else: a large chat, a row of **Saved Projects** buttons under it (**None Saved** when empty), a red **HELP, I'M STUCK** button, and a **BUILD IT** button that appears above the chat once the plan is agreed.

1. **Say what you want** in the chat. Dominion first checks that the thing is actually an app and points you elsewhere if it is not.
2. **Answer the interview**, one question at a time. It covers seven things: what it should look like, what it is for, who will use it, whether something like it exists, what kind of app it is, how much time you have, and any budget. It stops after seven replies and states the vision with its assumptions named. No model spend happens during the interview.
3. **Send a picture when asked.** The chat footer has a paperclip and a camera. A sketch on paper photographed with the camera counts.
4. **Choose a look.** Dominion can paint mockup images of the app for you to pick from (mockups are requested at low quality, portrait, which made them nine times cheaper in the September fix).
5. **Read the vision** back as bullets and correct anything wrong. Those bullets are what the final honesty check measures the finished app against.
6. **Press BUILD IT**, or just say "build it", "ok go ahead", "yes", or "ship it". A home folder for the app is created automatically on your computer inside **Dominion Apps**; you never handle folders.
7. **If your computer is not connected**, the chat says: "Your computer is not connected yet, so there is nowhere to build this. Open app.dominion.tools on the computer you want the app built on, then come back here and press BUILD IT again. Nothing you have told me is lost."
8. **While it builds**, the chat is replaced by a game of Pong against the machine, with a welding robot underneath showing the percentage done, the current step, and a best-guess time remaining. A link switches to watching the real build.
9. **When it finishes**, one button fills the screen: **SEE MY APP**. It opens the running app with a conversation under it asking what you think. A change request is stated back as bullets, and **MAKE THAT CHANGE** starts a real follow-up build.
10. **HELP, I'M STUCK** opens a separate small conversation ("Hey, heard you were having trouble. What's up?") with its own paperclip and camera. It never builds anything and never disturbs the main conversation.

> **Proof.** Beginner surface and copy: Unit. The intake interview, mockups, and auto-folder: Rig (earlier iterations). Builds that finish with tests green: Rig, 2026-09-03 (a six-file API).

### 4. The Vibe Coder path, step by step

The Vibe Coder screen runs top to bottom:

1. **App Project Slider**: a rail of project cards you drag left and right, led by an empty **Future Project Slot**. Tap a card to open that project.
2. **Control row**: a square **New** button, a copper-lit **Adopt an App** square (see section 6), a reserved **TBD** slot (does nothing yet, by design), **Start Over**, and **Save to:** which picks the project folder.
3. **Customize Your Workspace**: three presets (**Minimal**, **Design Studio**, **Full Stack**) and eight checkboxes with an **Apply** button. Applying shows a tile for every module you picked and the status line names them. Modules change what is shown, never what the build does.
4. **Plan with AI**: three chat windows ranked like an army. **The General** (main planner, blue, four stars) is where you talk about what you want built. **The Captain** (copper, twin bars) and **The Sergeant** (green, three chevrons) are optional second and third opinions; each starts folded behind an **Open chat** button and carries a **Fresh start** button to wipe its own thread. Every window offers the full model catalog from a picker in its corner.
5. **Sending between ranks** (never required): pressing **Send** extends the destinations (Send here, or to another rank). While they are open, a tick box appears on every message with the last exchange already ticked; the ticked messages cross as a labelled transcript wearing the sender's colour. The receiving AI treats it as another opinion, never a command. Anything you type in the composer crosses as your own note.
6. **Assign Your Troops for the Build**: the banner that separates planning from crew setup.
7. **The Agent Army** appears only when the **Agent Crew** checkbox is on. At its top is the **Orchestrator** row: the one seat limited to bigger models (at least 200 billion parameters; a deliberate small pick is refused by name, an inherited small default is promoted and you are told). Leaving it empty means **Same as the General**.
8. **Plan the tasks** fills a table: each task row has a **Model** pick, a **# of agents** stepper (1 to 6), and live **Est Cost** and **Est Time** that update as you change picks. Time is a range from the parallel case to the one-at-a-time case. A task that cannot be split safely is marked **irreducible** and forced back to one agent, with the reason. In the Engineer table, tasks sharing a group tag mirror the first one's picks.
9. **Stop this project at**: the spend ceiling for this build. With a value set, the build pauses and asks before passing it; the note says so. Left blank, the screen says "No limit set: the build will not stop itself."
10. **BEGIN BUILDING** starts the build.

> **Proof.** Layout, ranks, Agent Army, estimates, irreducible splits: Unit. Cross-rank sends: Unit. Budget stop-before-overspend: Unit and Rig (a build froze at a one-cent cap and one tap released it).

### 5. The Engineer path

The Engineer keeps the classic page: labelled drawers first, the conversation under them. The mode sets a technical register.

1. **Workspace**: **Where new builds run** (**On my computer** or **In Dominion's cloud workshop**), **New project folder**, **Browse** the build machine's drives (every folder row has a **This one** button), and **Adopt existing app** for a folder that already holds a project. Quoted paths pasted from Windows "Copy as path" are accepted.
2. **Brief**: the agreed vision and the build prompt.
3. **Assignments**: the **Assignment Board**, opt-in behind "Use all the default tools (recommended)" or **Customize**. **One model for everything** is the simple choice; "Pictures still come from Dominion Forge" regardless. A greyed model marked "needs a provider key" cannot be selected until that provider has a key on the server.
4. **Register**: how the surface talks to you (plain, technical, or hybrid).
5. **AF** (near the model line) opens the **Agentic workflow** window: rows of Task, Model and Number. The default relay is one agent that divides the work and writes contracts, several that build the parts at the same time, one that reviews and fixes, one that does the final check. The **cookie rule** is enforced in code: no two agents ever own the same file, and a referee refuses overlaps before work starts. **Full Custom** in the same window: **Plan the tasks** lays the build out as a numbered task roadmap where you pick any model and any number of helpers per task, with live estimates.

> **Proof.** Drawers, board, register: Unit and Rig. AF relay: Unit plus one live round trip; the referee's overlap detection is unit-tested including the triple-claim case.

### 6. Adopt an App (Vibe Coder and Engineer)

For an app you already started, even half-finished, in a folder on your computer.

1. In Vibe, press the **Adopt an App** square. Pick the project that holds it, or **Browse this computer**; **This one** chooses a folder directly and **This folder holds it** picks the folder currently open. A chosen folder is confirmed in green and **Analyze my app** pulses.
2. In Engineer, use **Adopt existing app** in the Workspace drawer.
3. Dominion reads the actual files through your build machine. Nothing is run and nothing is changed; the scan has bounded depth and size.
4. You get two layers: an honest **STATE OF THE APP** brief (what is built, half-built, missing, what runs), then a **DEEP ANALYSIS** by a fixed analyst, Claude Opus 4.8, which is not changeable because every plan builds on this one reading. If the deep read cannot run, the brief still lands with the reason stated.
5. After the analysis The General defaults to that same model; you can change it and the new model inherits the whole conversation. The agreed vision tags every bullet **[finish]**, **[fix]** or **[new]**, and the build rides the normal machinery (snapshots, budgets, rollback) in that same folder. If the brief says something is absent, it is absent.

> **Proof.** Unit (scan bounds, brief parsing, tags). Live adoption runs were part of the 2026-07 iterations.

### 7. Watching a build

1. **Blueprint** and **Workshop** are two views of the same running build, switched by the bold header tabs. Blueprint is the plan: compact numbered rows, one per step, tap for detail (what, why, which files). Workshop is where the thing exists: **Try your app** (a live preview you can tap through), the **Checks** that ran, and the code behind **Show me the code** (engineers see code automatically, beside the preview on wide screens). The view lands on the Workshop by itself the moment a build finishes.
2. **Row states**: queued (waiting its turn), running, done, failed, skipped (a task it depended on did not finish; the row names which).
3. **Tasks overlap.** Any task whose dependencies are met and whose files collide with nothing running starts immediately. A task waits only for an earlier task or for a file something running also touches.
4. **The stream stays alive.** Every long-lived stream sends a keepalive every 10 seconds, so the two-minute silent drops are gone. If the connection does drop, the lens reattaches from the last record it saw and shows a quiet live or reconnecting state instead of a blank.
5. **The flame card with a timer** means work is in flight. A **status** line appears every 30 seconds while a model call is running, so the log never goes quiet for minutes.
6. **Builds run on the server** and keep going if you close the app. A notification calls you back when a build needs an answer, finishes, or fails (on iPhone the app must be installed to the home screen; the client says so). A paused build spends nothing.
7. **When a step fails**, you are asked: **Try again**, **Skip this step**, or **Stop the build**. Free-text advice steers the retry. Retries are capped so a broken task cannot burn the budget in a loop.
8. **Budget**: a warning once you pass about three quarters of the cap, and a stop before the step that would exceed it, never after.
9. **Start fresh** in the conversation header abandons a restored draft or a stuck interview in one tap. Jobs already running on the server are not touched.
10. **Build log** in the header lists past builds; following an old one replays its whole story.

> **Proof.** Heartbeats and incremental reattach: Rig (18 keepalive frames in three idle minutes; the longest silent gap on a small build fell from 166 s to 10 s) and Production (the verification build's stream showed keepalives every 10 s). Failure fork, budget, background jobs: Unit and Rig.

### 8. What works for you behind the scenes

These are the September stabilization changes. You will rarely see them, which is the point.

- **A counsel on every build.** When a step fails, a brain model reads what went wrong and hands back a diagnosis and a fix before the step ever surfaces as failed. If the brain is unsure, a frontier reviewer looks once more. A step that still cannot pass moves to a stronger engine for one guided attempt. Whatever generalizes is kept as a lesson that follows every future build. The owner can see and prune the lessons at `/ide/lessons`.
- **A missing planned file is repaired, not written off.** A re-ask with an explicit "return the complete contents" instruction, then up to two dedicated write-this-file moves. Only after all three does the checkpoint say what was tried.
- **A plan that comes back as prose never fails the build.** Up to three planning attempts on escalating models, then an honest single-move fallback.
- **An unreadable audit is never the end state.** One retry, then concrete checks (the project's own scripts plus a syntax pass over every written file), labelled as a fallback.
- **A stalled model call is rerouted.** No complete answer in 180 seconds becomes a transport failure that moves to another keyed model. A move that burns its full 20-minute budget is re-planned into two smaller moves, once.
- **A server restart does not lose the build.** At boot, an unfinished standard-crew build is resumed against the same job with its original plan; finished moves are skipped. If the build machine is offline, the job reports paused and retries every 30 seconds.
- **The wrong build machine is refused up front.** A workspace root outside the build node's allowed folders is rejected when the workspace is made, and again at build start with zero spend, instead of failing every step.
- **Provider outages are absorbed.** A step whose provider is down retries on a backup engine of similar capability and says so in the log.

> **Proof.** Rig: a forced missing file still finished with brain and frontier runs and three lessons written. Production: the 2026-09-03 verification build showed the counsel loop diagnosing live (brain, frontier, escalation), and the production lessons store now holds lessons written by both. Root guard: Unit plus the live rig case for a folder inside the roots.

### 9. Finishing a build

1. **The Furnace pass** ends every build: a sweep for unfinished markers, a check for broken local references, and an audit of the finished app against each bullet of your agreed vision (Delivered or Missing per bullet). Its findings become one question: **Close them now** or **Finish as is**. By default it closes them and tells you it is doing so; a setting asks first instead.
2. **Checkpoint saved** means an honest pause: unfinished but sealed and safe, with the evidence kept.
3. **Your code is safe.** A restore point is taken before anything is written, every time: a commit in a git project, a real copy of the tree in a plain folder. Each build runs on its own branch named after the job. A failed or stopped build is salvaged onto that branch, never thrown away. Protected places (backups, databases) are refused outright before anything is snapshotted.
4. **Try your app**, **Checks**, and **Show me the code** in the Workshop show the result. All of it also sits in your own folder.
5. **Putting it online**: when a build finishes you are invited to deploy. The guided version of that step is not built yet, and the card says so honestly rather than pretending. Deployment is still something you do yourself.

> **Proof.** Furnace, snapshot, branch, salvage: Unit and Rig. The deploy card's honesty: Unit.

### 10. Models and where they run

- Every planning window offers the full Dominion model catalog; only the Orchestrator seat is restricted to bigger models.
- The catalog includes **Your GX10 (local)**: models running on the owner's own machine at home. They cost nothing per token, never send a byte to a third-party provider, and are allowed in every privacy mode. If the GX10 is off or busy, a step on one of its models falls back to another available model within 10 seconds instead of stopping the build.
- The catalog is audited live. A seat is hidden only after two consecutive failed probes and re-probed every ten minutes, so a dead seat does not sit in the picker and a recovered one comes back on its own.

> **Proof.** Production, 2026-09-03: the GX10 served production chat for the first time; a seat sweep answered 24 of 27 seats, and the GX10 seats answered after the relay fix. Fallback within 10 s: Unit and Production.

### Crucible boundaries, said plainly

- The **AF crew** and **task-graph** pipelines do not yet resume across a server restart; the standard crew does. A restart during one of those seals it honestly as interrupted.
- **Guided deployment** is not built. The card says "upcoming".
- **Run-and-see on iOS** needs the app installed to the home screen for notifications; the client states this.
- A chat turn or build interrupted by a **production deploy** is logged as interrupted. Batching deploys is the mitigation.

---

## Part II. The Game Factory (owner only)

The **SD Tech Mobile Game Factory** builds a fixed ten-game portfolio: Vector Vault, Bolt Bloom, Pocket Gravity, Chromalock, Tiny Foundry, Letter Loom, Pulse Path, Shelf Shift, Wobble Works, and Signal Grid. It is durable (every decision is a versioned, append-only record), evidence-gated (no stage advances without the evidence the stage requires), and human-gated at every release step. Since the build of 2026-09-03 it also does the work: a stage supervisor turns your approvals into tasks, a server forge designs, draws and codes each game as a dependency-free HTML5 canvas game, a QA runner executes the twelve required suites, and the finished build is played inside the factory itself.

It is owner-only in production (`GAME_FACTORY_MODE` is `owner`), and it requires a real signed-in human owner browser session. A service token or script is refused with "The Mobile Game Factory requires a verified human owner session." That refusal is by design and is why the September stabilization could verify the gate but not drive the factory from a script.

### 1. Production configuration (as of 2026-09-03)

| Setting | Value | Meaning |
|---|---|---|
| Access | owner | Only the owner account can open it. |
| Reconciler | on | The dispatch loop runs, polling every 10 seconds, one task at a time. |
| Build worker node | gx10-gamefactory | The only machine tasks may be dispatched to; the adapter never follows another node. |
| Worker capabilities | quality_assurance, godot | The one reviewed Web/Godot lane. Android, iOS, signing and store writes are outside it. |
| Artifact writes | on | Immutable local artifact objects are written. |
| Google Drive mirroring | on | Every artifact gets a byte-verified Drive copy. |
| Store release writes | off | Release readiness is recorded; nothing is uploaded to a store. |
| Synthetic canary | on | An operator-only check that queues one canary task on the GX10 lane. |
| Supervisor | on | Every 10 seconds, moves each game exactly as far as its evidence allows. |
| Forge | on | Designs, draws and codes games (product planning, visual design, gameplay engineering). |
| QA runner | server | Runs the twelve suites in a permission-sandboxed Node child on the server. |
| Levels per pilot build | 12 | The pilot build carries twelve authored levels; the MVP's full count comes later. |
| Repair budget | 3 | Failed QA gets up to three automatic repair builds before the game blocks. |

### 2. Opening and closing

1. Use the navigation rail: **Game Factory** (Mobile release portfolio). It also lives at `/games` and appears in the rail only for an account with the capability.
2. The factory opens as a full-screen surface over the app. The background is inert while it is open. **Escape** or the **×** at the top right closes it; **Return to Dominion** appears if access is refused.
3. The **live indicator** in the top bar reads **Connecting**, **Live** (event stream attached), **Reconnecting**, **Polling** (no event stream available), **Offline**, or **Retrying**. The screen also refreshes itself every 20 seconds while visible, and **↻** refreshes on demand.
4. If a refresh fails, the status line says so and keeps the last loaded state visible ("retrying safely") rather than blanking the screen.

### 3. Reading the screen

- **Summary tiles**: Games, Active, Approvals (needs attention), Blocked, Running.
- **Portfolio** (left): one numbered card per game with its stage, a mini progress bar, and a count badge when anything needs attention (an approval waiting, a blocked gate, missing artifacts, failed tests, or a hold state). The search box filters by name or stage.
- **Game detail** (right): the name, slug, last update, a stage chip (and an **Autopilot** badge when Run to playtest is driving the game), a progress bar, then a notice and the action buttons, then five tabs:
  - **Overview**: Current checkpoint cards (Active work, Next work, Active build, Required artifacts N of 11), a **Build** card (version, status, file count, bundle fingerprint, QA passed out of 12 with the failing suites named, and a **Play current build** button when a bundle exists), five health cards (Build worker, Artifact mirrors, Store release, Game forge, Supervisor), and the lifecycle milestones with the current stage lit.
  - **Work queue**: durable tasks with capability, status, and attempt count. One active writer per game; leases reconcile after interruption.
  - **Artifacts**: the eleven required artifacts, each Complete or Incomplete, with every copy and its verification status, and a **Read artifact** button.
  - **Quality & release**: automated test evidence for the active build, owner approvals, release readiness, and the publisher checklist.
  - **Activity**: the append-only event history, newest first.

**Notices you will see above the buttons:**

- **Owner gate**: an approval is waiting for you, bound to a named piece of evidence and its fingerprint.
- **Evidence gate**: the approval cannot be offered yet, and the text says exactly what is missing.
- **Blocked**: the recorded blocker.
- **Pause requested** / **Stop requested**: the active task is finishing at a safe boundary first; the stage is never falsified.
- **No owner decision is pending.** The supervisor is doing the work for this stage (a task is running or about to be queued); nothing is asked of you until the next gate.
- At **Playtest Ready**: "Play the build, then approve it or request changes."

### 4. The lifecycle

The happy path has twelve stages: Idea, Specification, Architecture, Asset Generation, Implementation, Integration, Automated Testing, Playtest Ready, Release Candidate, Approved, Store Prep, Deployed. **Revision** is a loop any working stage can enter and return from. **Paused**, **Blocked**, and **Failed** are holds that remember where to resume.

Every stage boundary is a fact check, not a suggestion:

| Moving to | Requires |
|---|---|
| Architecture | Owner approval of the specification (brief, market case, release roadmap, build workflow). |
| Asset Generation | Owner approval of the visual system (architecture and visual system artifacts). |
| Playtest Ready | Every one of the 12 required QA suites passing for this exact build. |
| Release Candidate | Owner playtest approval for this exact build. |
| Approved | Release candidate approval plus all QA suites passing. |
| Store Prep | Every artifact with a verified Drive copy, plus legal and privacy approval. |
| Deployed | Human store-submission approval, human production-release approval, and a ready platform release record. |

The 12 required QA suites: core-loop, launch-smoke, crash-regression, controls, save-state, viewport, performance, monetization, offline, analytics, privacy-consent, store-readiness.

### 5. Step by step: one tap to a playable build

1. Select a game that is at **Idea**. Two buttons appear: **Run to playtest** (primary) and **Start game plan**.
2. **Run to playtest** starts the plan and records your approval of the two planning gates (specification and visual system) in advance, with the rationale "owner chose Run to playtest" in the durable record. From there the factory runs on its own until a playable build is waiting for you. Playtest approval is never automatic.
3. **Start game plan** is the manual path: the plan is produced, then you approve each planning gate yourself (section 7) and the factory proceeds after each approval.

What the factory then does, stage by stage, with no further taps:

| Stage | Who acts | What happens |
|---|---|---|
| Specification | planner | The eleven planning artifacts are rendered, stored immutably, and byte-verified on Google Drive (section 6 below). |
| Architecture | forge, product planning | A machine-readable design (actions, rules, 12-level plan, palette, analytics events) is written from the spec, free local model first. |
| Asset Generation | forge, visual design | Icon and splash from the Foundry image pipeline with provenance (engine, model, prompt, fingerprint); a kit-drawn icon if the engine is unavailable. |
| Implementation | forge, gameplay engineering | The game's rules, renderer, content and QA fixtures are generated against the kit contract, validated locally through the same twelve-suite harness, repaired with the model up to four rounds, then assembled into an immutable bundle for a new build (0.1.N). |
| Integration | supervisor | Every file in the bundle is re-hashed against build.json and the offline precache list is checked. |
| Automated Testing | QA runner | The twelve suites run in a sandboxed child process and each result is recorded against the exact build. All twelve pass: the game is Playtest Ready. Any failure: a repair build (up to three), then a block naming the failing suites. |

> **Proof.** Rig, 2026-09-03: Vector Vault went from Idea to Playtest Ready with 12 of 12 suites on build 0.1.2 (the first implementation attempt failed honestly and Retry re-queued it; one repair build fixed the failing suite). Production: deployed the same day; the first production run is the owner's tap, observed from the server side.

### 5a. The old step by step: starting a game plan manually

1. Select a game that is at **Idea** and press **Start game plan**.
2. The server first checks that immutable artifact writes and Google Drive mirroring are both enabled; if either is off it refuses with a plain reason before changing anything.
3. The game moves to **Specification** and the factory renders the eleven required artifacts from the portfolio templates: 00_GAME_BRIEF, 01_MARKET_CASE, 02_RELEASE_ROADMAP, 03_BUILD_WORKFLOW, 04_GAME_ARCHITECTURE, 05_VISUAL_SYSTEM, 06_MONETIZATION, 07_QA_AND_TESTING, 08_STORE_RELEASE, 09_HANDOFF_PROMPT, 10_COMPLETENESS_REVIEW. Each becomes an immutable version with a SHA-256 fingerprint, a verified local primary copy, and a byte-verified Google Drive copy.
4. The ChatGPT Project copy of each artifact is recorded as **Deferred (not required; owner may complete later)**. It is informational, never a blocker, and never reads as an error.
5. Pressing Start again with the same request is safe: the same idempotency key replays the committed transition and repairs any missing artifact object without creating new versions.
6. The Overview's **Required artifacts** card should read **11 of 11 complete**, and the Artifacts tab chip should read **Complete**.

> **Proof.** Unit (the start saga, idempotent replay, deferred backend, schema migration against a schema-1 fixture). Rig: a project transitioned past the old gate with DEFERRED copies listed. Production: the human-owner gate was verified; no production Start has been run by a script because a script cannot pass the gate. The first production Start is yours to press, and the 11 of 11 reading is the confirmation.

### 6. Reviewing artifacts

1. Open the **Artifacts** tab. Each card shows the version, size in bytes, and its copies: `primary · Verified`, `google_drive · Verified`, `chatgpt_project · Deferred`.
2. Press **Read artifact**. The content opens as integrity-checked plain text; Markdown is shown as text and never executed. The status line shows the version and fingerprint and whether all required evidence is complete.
3. Only required, plain-text artifacts under the size cap with a verified local copy can be opened; anything else explains why in place of the button.

### 7. Step by step: the specification approval

1. Once the four specification artifacts are complete, the notice reads **Owner gate: Specification approval is required for ...** with the evidence fingerprint, and two buttons appear: **Approve specification** and **Request changes**.
2. **Approve specification** opens a confirmation. The decision is bound to the exact evidence fingerprint shown; if the evidence changed since you loaded the page the server answers "The approval evidence changed. Reload the current checkpoint before deciding." Confirm with the button, or **Keep current state**.
3. **Request changes** asks you to **Explain what must change**. The note becomes part of the durable decision record. The game moves to **Revision** with the blocker "SPECIFICATION was rejected."
4. Approvals are listed on the **Quality & release** tab under **Owner approvals**. A new build or new evidence marks earlier approvals **superseded**; approvals never carry forward silently.

> **Proof.** Unit (gate evaluation, hash binding, rejection to Revision, supersession).

### 8. Pause, Resume, Stop, Retry, Request revision

- **Pause** is available on any working stage. The active task finishes at a safe checkpoint first (**Pause requested**), then the game shows **Paused** with **Resume** and **Stop**.
- **Stop** always asks for confirmation. Dominion waits for the active writer to leave a safe boundary (**Stop requested**) before stopping.
- **Retry** appears on **Blocked** and **Failed** games and returns them to the stage they were at.
- **Request revision** (or **Create revision** on a deployed game) asks you to describe the change you want, records it, and enters the Revision loop.
- Every command carries the game's current version. If the record changed underneath you, the server refuses with a 409 and the screen reloads the current checkpoint instead of applying a stale decision. Every command also carries an idempotency key, so a double press cannot apply twice.
- **Attach workspace** shows as **Workspace managed by orchestrator** and is disabled in the browser: no file or path control is exposed there by design.

### 9. Work queue and the two workers

- Tasks are durable rows with a capability (product planning, gameplay engineering, visual design, quality assurance, release coordination, godot, android, ios, artifact mirroring), a status, and attempt N of M. The **Work queue** tab shows them by title: design, assets, implement, repair, revise.
- Two workers drain the same queue. The **server forge** claims product planning, visual design and gameplay engineering tasks and works one at a time with a ten-minute lease and heartbeats every thirty seconds. The **GX10 orchestrator** claims quality assurance and godot tasks for the device lane (today only the synthetic canary uses it).
- Exactly one writer may own a game at a time. A lease expires without a heartbeat and is reclaimed on the next tick.
- Dispatch to the GX10 controller goes through a durable journal with a deterministic run id per attempt; success is read from the remote's terminal status, never inferred from a timeout.
- **A transient worker disconnect no longer kills work.** Proof loss suspends dispatch for a 10-minute grace window and resumes on a matching re-probe instead of latching into failure. The outbox has a drainer.
- The **Build worker** health card reads **Configured and reachable**, **Unavailable or unverified**, or **Not configured**. **Artifact mirrors** reads **Verified** when both copy paths are healthy. **Store release** reads **Readiness only** while store writes are off.

> **Proof.** Unit (journal schema 1 to 2 additive, grace window, lease reclaim, outbox drainer). Production: the GX10 hands node beats inbound every 20 seconds and the controller image is present on the machine; the worker health card is the live reading.

### 10. Play current build

When a build has a bundle (from Implementation onward, and always at Playtest Ready), a **Play current build** button appears on the Build card and in the action row. It opens the exact immutable bundle of the active build, served by Dominion's own server at a play URL under the game, inside a sandboxed frame in the factory. You play it the way a phone user would: tap the step controls, use the arrows, space, enter, u for undo, r for restart, h for hint. The dialog says which version you are playing and that saves inside the preview do not persist (they do in the installed app). It is a tryout, not QA, approval, store, or release evidence. At Playtest Ready the decision row under it offers **Approve playtest** or **Request changes**.

> **Proof.** Rig: the play URL answered 200 with the game's HTML, scripts, manifest and icon under a content security policy, for both builds 0.1.2 and 0.1.3. The kit runtime was booted through a fake browser document against a real generated bundle (controls drawn, input dispatched); a real-browser pass is the owner's first tap.

### 10a. Step by step: iterating a build

1. Play the build. Decide.
2. **Request changes**: write what should change in plain words (for example "make level 1 a pure tutorial with one vector and a visible hint"). The game moves to Revision with your note as the reason.
3. The supervisor queues a **revise** task carrying your words and the current source. The forge edits the game, a new build is created (which invalidates the earlier build's evidence and approvals by design), Integration and the twelve suites run again, and the game returns to **Playtest Ready** with the new build.
4. Play it again. Approve, or request changes again. There is no limit on owner-initiated revisions; only automatic repairs are budgeted.
5. **Approve playtest** moves the game to Release Candidate; **Approve release candidate** moves it to Approved. From there the release stages stay human-gated and store writes stay off (section 11).

> **Proof.** Rig: Request changes with the tutorial note produced build 0.1.3 with the requested control label and hint text, 12 of 12 suites, Playtest Ready again five minutes after the rejection.

### 11. Quality & release

- **Automated test evidence** must match the active build; a row from an older build reads **stale**.
- **Release readiness** lists platform records (Android, iOS) with **stale** marking on old builds. Final submission remains human-gated.
- **Publisher checklist**: the accountable steps the factory cannot infer or fabricate: store account ownership, agreements, tax and banking; age rating, content rights, privacy and data safety, tracking, advertising, encryption declarations; signing keys kept in the approved vault; final store page, test-track result, rollout and rollback criteria reviewed before the two release approvals.

### 12. The deferred ChatGPT Project copies

Deferred copies are listed for the owner at `/api/game-factory/admin/chatgpt-reconciliation` (owner-only). Completing one is an offline, single-writer operator action after you visibly confirm the browser upload in the locked Project: the documented `node ops/record-native-chatgpt-project-attestation.mjs attest` command with a manifest file, run with the server stopped. It records an owner attestation; it does not upload anything, and it never gates progress. The full procedure is in `docs/NATIVE_CHATGPT_PROJECT_OWNER_ATTESTATION.md`.

### Game Factory boundaries, said plainly

- **The games are HTML5 canvas games, not Godot builds.** The architecture template names Godot 4.x as a "candidate, admitted only after the factory toolchain probe pins a supported version"; the build admitted the web-canvas lane instead because it is previewable on any phone inside the factory and testable deterministically. The Godot capability on the GX10 lane is untouched for later.
- **QA runs on the server, not on the GX10 device lane.** The GX10 broker can only run scripts that already sit in its workspace and refuses inline code, so the twelve suites execute in a permission-sandboxed Node child on the server. Every test record says `target: server-qa` so nobody mistakes it for device evidence. A GX10 QA rung is a follow-up.
- **A pilot build carries twelve levels**, not the MVP's sixty; the build notes say so.
- **The forge can fail honestly.** If no model produces a game that passes the local checks after its rounds, the task fails with the causes named, the game shows Failed with that sentence, and **Retry** puts work back on the same build. Each round's files and verdict are kept on the server under the game's forge folder for diagnosis.
- **Store release writes are off.** Readiness is recorded; nothing is uploaded anywhere. Stages after Approved remain human-gated exactly as before.
- The **synthetic canary** is an operator seam, not a screen: an owner-session POST to `/api/game-factory/admin/synthetic-canary` with a project id and an idempotency key queues one canary task on the GX10 lane to prove the worker path is alive.
- A **service identity cannot enter** the factory. Verification of anything past the gate needs your own browser session.

---

## Where to look when something seems wrong

| Symptom | What it means | What to do |
|---|---|---|
| Crucible: "Your computer is not connected" | No build node is reachable for your account. | Open app.dominion.tools on the build machine (or start the node there), then press the build button again. Nothing typed is lost. |
| Crucible: a step shows Try again / Skip this step / Stop the build | The step failed after the counsel's own attempts. | Add a sentence of advice and choose Try again, or skip it; the build continues honestly either way. |
| Crucible: "Checkpoint saved" instead of "Build complete" | The build stopped short but sealed everything safely. | Read the checkpoint bullets; a follow-up build picks up from there. |
| Crucible: a model in the picker is greyed "needs a provider key" | That provider has no key on the server. | Pick another model; adding the key restores it everywhere. |
| Game Factory: "requires a verified human owner session" | You are not in a signed-in owner browser session. | Sign in as the owner in the browser; scripts cannot pass this gate by design. |
| Game Factory: "The approval evidence changed. Reload..." | The artifacts changed since the page loaded. | Refresh, re-read the evidence, decide again. |
| Game Factory: Build worker "Unavailable or unverified" | The GX10 lane is not answering probes. | Check the GX10 node; the reconciler holds for a 10-minute grace window before recording failure. It does not stop game builds, which run on the server forge. |
| Game Factory: Failed with "No model produced a game that passes the local checks" | Every model rung was tried and the game still failed the harness; the causes are listed in the sentence. | Press Retry. Work goes back on the same build; if it fails again, the round files under the game's forge folder show exactly what the models produced. |
| Game Factory: Blocked with "QA failed after 3 repair builds" | The automatic repair budget ran out on the same failing suites. | Play the last build if it exists, Request revision with a specific instruction, or Retry to spend another repair cycle. |
| Game Factory: Game forge or Supervisor card "Not configured" | The server flags are off or the process failed to start. | The version endpoint reports factorySupervisor and factoryForge; a deploy verifier checks both. |
