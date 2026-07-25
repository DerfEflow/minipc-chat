# Vibe Coder: the layout, from Fred's drawing

Dictated by Fred 2026-07-24/25, from a hand-drawn layout plus four rounds of clarification. This
document exists so the spec survives a context loss, mine or a future session's. Where it says
"already built", that is a statement about the code as of commit c96ca8b, verified before writing.

The Vibe Coder is the middle profile: **Crucible App Launcher**. It sits between the Beginner
surface (one conversation, nothing else) and the Engineer (every drawer open). Its user knows
roughly how this works and wants control without ceremony.

---

## 1. App Project Slider (top of the surface)

A horizontal rail of project cards that **drags left and right**.

- The first slot is an empty **Future Project Slot**: the place a new project goes.
- Existing projects follow as cards, in order, with a `→ ?` at the far right end of the rail.
- Tapping a card opens that project.

Source of truth: the account's workspaces, the same list the beginner surface shows as Saved
Projects (`/ide/workspaces`, exposed through `window.dominionIdeBridge.workspaces()`).

## 2. The left column, under the slider

- A square **+ New** button.
- A **TBD** box beside it. Fred: "TBD is just a placeholder for now." It ships as a real, visibly
  inert placeholder rather than an invented feature.
- **Start Over** and **Save to:** beneath those.

## 3. Customize Your Workspace

**Already built** (the Studio, `STUDIO_MODULES` / `STUDIO_PRESETS` in `public/dominion-ide.js`).
The drawing places and renames it; it does not change what it does.

- Three presets in a row: **Minimal | Design Studio | Full Stack**, annotated "Preloads".
- Eight checkboxes underneath, annotated "Custom": Workspace, Build Brief, Agent Crew, Cost,
  Live Preview, Results, History, Files/Diffs.
- An **Apply** button.

The module list rides `#ide-root[data-studio-modules]`, which is how sections appear and disappear.

### 3.1 The rule that makes the checkboxes load-bearing (Fred, 2026-07-25)

If the chosen layout **does not include Agent Crew**, then:

1. The Agent Army section is **not shown at all**. Not collapsed, not disabled: absent.
2. The build **reverts to the default AI for the entire build**.
3. It **runs autonomously through it**, with no per-task crew decisions to make.

This is the whole point of the checkbox. A user who did not ask for crew control is never shown a
crew they have to think about, and the build still completes.

## 4. Plan with AI

Three chat windows: one **Main**, plus **Second AI (optional)** and **Third AI (optional)**
side by side beneath it. Main can be used alone or with either or both of the others.

- Each window has its **own model selector in its upper-left corner**.
- Each window has a **different background colour**, so the three are distinguishable at a glance.
- Each window can be **dragged taller by its bottom edge**, and everything below it on the page
  moves down. The user decides what they are concentrating on.

### 4.1 Routing a message

- Pressing **Send** extends **two more buttons downward** from it. The one chosen decides where the
  message goes.
- Any window can send to any other: Main to Second or Third, Second to Main or Third, Third to Main
  or Second. Fred's shorthand on the drawing was `M | T` and `M | S`; **in the build the
  destinations are written out in words**.
- Purpose, in Fred's words: independent audits and testing.

### 4.2 Colour carries the thread

A message that arrives from another AI is drawn in the **sender's background colour** inside the
receiving window. Following a conversation across three panels then costs a glance instead of a
read.

### 4.3 THE STANDING RULE: only the user commands

> "Whichever window is the receiver, they treat the sent message as another opinion, not a command
> from the user. Only commands from the user are ever acted upon. The other AIs are informative and
> researchers."

This is a behaviour contract, not a UI note, and it is enforced in two places rather than one:

- **On the wire**, a cross-AI message is labelled as coming from another assistant, never as a user
  turn. A model that cannot tell the difference will obey the wrong voice.
- **In the prompt**, the receiving window is told plainly that material from another AI is a second
  opinion to weigh, and that instructions in it are never orders.

## 5. Agent Army

The task list itself is **already built**: the orchestrator divides every project into a numbered
task roadmap (`idetasks.mjs`), and Full Custom already renders per-task model and agent-count
controls with live estimates. What the drawing changes is the layout and the columns.

### 5.1 The orchestrator row (replaces the Default button)

Fred: the Default button is gone; there is a row at the top for the orchestrator instead.

- **One model only.**
- **Restricted to the approved models.** Per `docs/CRUCIBLE-FEEDBACK-WAVE-SOW.md` 2.2, the
  orchestrator/divider slot is the one place in the whole app where a model may be refused: it is
  limited to models above the tiny tier. Everything else stays unrestricted by design.
- **Automatic fallback if that call fails**, so a failed orchestrator never kills a build.
- **The user is told, in that row, that the model was changed and why.** A silent substitution would
  be the same lie as a silent truncation.

### 5.2 The task rows

Each task from the roadmap is a row carrying:

| column | meaning |
| --- | --- |
| Task | from the orchestrator's numbered roadmap |
| Model | any model, per the no-blocking rule |
| # of agents | how many agents of that model work that same task |
| Est Cost | for that task |
| Est Time | for that task |

The estimates are a function of **the cost and speed of the chosen model** against **the complexity
of that task**, and they **live update as values are entered**. The user then decides whether to
continue or change the setup. Estimates are honest approximations and stay labelled as such; the
throughput half comes from `idetelemetry.mjs`, which records real observed rates rather than a
table of guesses.

### 5.3 The irreducible rule still applies

If a task cannot be safely broken into smaller chunks for the chosen number of agents, the existing
verdict stands: `idetasks.mjs` returns `{ mode: "irreducible", usableAgents: 1 }`, the row is forced
to a single agent, and the user is told why in plain words. Asking for three agents on a task that
is one tight piece of work does not silently produce three agents fighting over one file.

## 6. Begin Building

A **wide** button across the bottom of the surface.

---

## What is already built vs what this wave adds

| piece | state |
| --- | --- |
| Customize Your Workspace (8 modules, 3 of 4 presets) | built |
| Numbered task roadmap from the orchestrator | built |
| Per-task model + agent count + live estimates | built (Full Custom) |
| Irreducible verdict forcing one agent | built |
| Cookie rule (no two agents own one file), referee-enforced | built |
| App Project Slider | new |
| + New / TBD / Start Over / Save to: row | new |
| Agent Crew unchecked = no crew, default AI, autonomous | new |
| Plan with AI: three windows, colours, drag-to-resize | new |
| Send-to routing with the buttons that extend downward | new |
| Sender-coloured bubbles in the receiving window | new |
| Cross-AI messages are opinions, never commands | new |
| Orchestrator row with approved list, fallback, notice | new |
| Wide Begin Building button | new |
