# Crucible Review Report
**Date:** 2026-07-25 (overnight session, Fred's order: test, review, report. No building.)
**Scope:** All three Crucible surfaces as they stand locally at commit 54f984d (UNPUSHED). Beginner (App Builder), Vibe Coder (App Launcher), Engineer (Full Stack Platform, pre-rebuild), plus the Welcome Screen and navigation.
**Method:** Live browser testing on the dev server at desktop (1280px) and phone (375px) widths, with all model endpoints mocked so the sweep spent $0. Contrast ratios computed from real rendered pixels. Market comparison from July 2026 sources.

---

## 1. Verification of the Vibe build (finishing what compaction interrupted)

All interactive flows PASS except one mobile layout defect (see 2.1).

| Flow | Result |
|---|---|
| Send stack: press Send, three destinations extend downward in words | PASS ("Send here" / "To Second AI" / "To Third AI") |
| "Send here" = user command to own window | PASS |
| Cross-window send wears the sender's colour + "Main AI · opinion" tag | PASS (Main blue lands in Second's copper window, clearly distinct) |
| Empty composer cross-send forwards the last AI reply | PASS |
| Agent Army: plan produces task rows with Model / # agents / Est Cost / Est Time | PASS, live totals line included |
| Irreducible rule: 2 agents on an unsplittable task forced back to 1, with the reason shown | PASS |
| Orchestrator fallback notice: "Big Model could not do it (the call failed), so Claude Sonnet 5 stepped in." | PASS, amber, persistent, pick reset |
| Crew module unchecked: Agent Army section absent, crew assignment cleared | PASS |
| Drag window taller by the bottom bar | PASS (300px to 450px in test) |
| Return to chat | PASS (Crucible fully stands down, main chat owns the screen) |
| Welcome Screen once per session, three levels with (Newbie)/(Intermediate)/(Professional) framing | PASS |
| Per-mode headers: App Builder / App Launcher / Full Stack Platform | PASS through the real entry path |
| Beginner greeting verbatim, HELP I'M STUCK square, "None Saved", Domine at +30% | PASS |

## 2. Defects found (in priority order)

### 2.1 BLOCKER for pushing: Vibe windows overflow the screen on phones
At 375px width the Second and Third AI windows render 415px wide and get cut off 57px past the right edge. The media query that stacks the windows fires correctly; the fault is one level down: each window is its own grid, and its single column grows to the content's natural width because grid children keep their default `min-width: auto`. This is the same min-width refusal already on our books from the beginner build.
**Fix when building resumes:** give `.vb-win` children `min-width: 0` (or make the window's column `minmax(0, 1fr)`) in dominion-vibe.css. One line. Because of this, 54f984d stays unpushed tonight: pushing deploys, and half of your users are on phones.

### 2.2 The Welcome Screen makes a promise only Engineers can keep
The card says "You can change it at any time." The mode switch lives inside the classic starter page, and both the Beginner and Vibe surfaces hide that page entirely. So a Beginner or Vibe Coder has no way to change levels until the next session. Either the promise comes off the card or (better) a small level control joins the rail next to "Return to chat" on every surface.

### 2.3 The TBD square
It does its placeholder job honestly for you. For paying customers it reads as an unfinished product. It should be hidden behind an owner flag before any public release. Noted in the release plan.

### 2.4 Catalog snapshot age
Model prices were last pulled 2026-07-18. Prices drift weekly on OpenRouter, and the cost estimates in the Agent Army inherit whatever staleness the catalog carries. A weekly re-pull belongs in the health-check sweep.

No overlapping elements were found on any surface at either width. No horizontal overflow anywhere except 2.1. Nothing intentionally layered (welcome screen, help overlay) misbehaved.

## 3. Text against its backdrop
Measured contrast ratios from rendered pixels (WCAG wants 4.5:1 for body text, 3:1 for large text):

- Beginner: greeting 18.7:1, HELP square 18.6:1, rail title 19.1:1, secondary labels 5.4:1. Excellent.
- Vibe: section heads 13:1, opinion tags 13.8:1, orchestrator note 13.2:1, secondary notes and army headers 5.5:1, user bubbles and BEGIN BUILDING are dark ink on bright green gradients at roughly 5.5:1 against the darkest stop and 14:1 against the lightest. All pass.
- Engineer: inherits the established ide theme, spot checks passed.

Verdict: nothing is hard to read anywhere. The weakest text on any surface still clears the accessibility bar with room to spare.

## 4. Economy of words
Overall: good, and better than the market norm. Specific observations:

- The Welcome Screen is exemplary: one sentence per level, each earning its place.
- Beginner copy obeys the no-technical-words rule throughout the flows tested.
- Vibe: "Custom picks make it yours; Apply makes it so." is one flourish in an otherwise tight surface; harmless. The estimates line "(estimates; * = little data yet)" is honesty done cheaply. The orchestrator note explains the seat in two short sentences.
- Engineer starter carries the most text per screen, which suits its audience, though the "Assignment Board" intro paragraph ("Set these once. Every job is sorted...") could lose a third without losing meaning. Fold that into the Engineer rebuild rather than touching it now.
- One duplication: the Engineer starter still contains its own three-way level switch ("New to this / Vibe coder / Engineer") which now overlaps the Welcome Screen's job. It is ALSO currently the only mode switch in the app (see defect 2.2), so it earns its keep until the rail control exists.

## 5. Is the flow intuitive?
- **Entry:** compass dial names the surfaces, Welcome Screen forces one clear choice, each mode lands on a purpose-built page with its own header. Clean.
- **Beginner:** conversation first, one big obvious escape hatch (HELP), one moment of commitment (BUILD IT), a game while waiting, one button at the end. This is the strongest flow in the product.
- **Vibe:** top-to-bottom reads as a plan assembly line: pick project, shape workspace, talk it through, staff it, press go. The one seam: the send stack's "second press sends here" behaviour is undiscoverable until tried, though it does nothing destructive. The cross-window opinion tags make the multi-AI rule legible without explanation.
- **Engineer:** functional and dense, awaiting your rebuild. Drawers in dependency order still read logically.
- **Cross-cutting:** "Return to chat" works from everywhere tested, and returns cleanly.

## 6. Missing features vs the cutting edge (July 2026 market)
Measured against Lovable, Bolt.new, Replit Agent 3, v0, and Cursor:

**Gaps that matter:**
1. **One-click deploy/hosting.** Every major competitor has it; it is their conversion moment. Ours is parked by your decision until the MVP line settles, and the beginner flow already promises "put it online" steps, so the flow ends warmly regardless. This is the number-one gap for public release.
2. **Visible version history / undo a build.** Competitors expose rollback as a user-facing feature. We snapshot internally; nothing shows the user.
3. **Template / starter gallery.** Every rival opens with "or start from a template." We always start from a blank conversation.
4. **Visual click-to-edit** (Lovable's signature): click an element in preview, describe the change. Our preview lens shows; it does not receive.
5. **Collaboration** (share a project with a second person). Replit's stronghold.
6. **Integration wiring** (auth, payments, database as one-click add-ons). Lovable wires Supabase for you. Our builds go to the user's machine, which changes the shape of this feature rather than excusing it.

**Where we are AHEAD of the market:**
- 25+ models across 3 direct providers plus OpenRouter, with per-model honest pricing shown. Competitors hide the model entirely.
- The three-window multi-AI planning bench with the opinions-never-commands rule. Nobody on the market has an equivalent.
- Per-task agent staffing with live cost/time estimates and the irreducible-task guard. Orchestrator seat with an enforced size floor and a never-silent fallback.
- Builds land on the user's own machine: their code, their folder, no platform lock-in, no hosting bill.
- Three genuinely distinct skill surfaces over one engine. Rivals ship one interface with a difficulty slider at best.
- The Free-Thinking model tier and privacy-tiered routing (Trusted mode on direct no-train providers).

## 7. Why someone at each level pays for THIS over other AI interfaces
**Beginner:** They talk, it builds, and nothing ever requires a technical word. A live human-shaped interview instead of a prompt box. The app ends up on THEIR computer instead of trapped on a platform tier. HELP button that never judges. Competitors' beginner story still ends at "now learn about deployments."
**Vibe Coder:** Model choice with real prices instead of a hidden model and a token meter. Second and third AI opinions on tap before spending a dollar. Cost and time estimates per task BEFORE the build starts, and a crew they can actually staff. No other tool lets an intermediate user see and steer this much without demanding an engineer's vocabulary.
**Engineer:** The whole stack in labelled drawers: models, budgets, diffs, task graphs, telemetry. Direct-provider routing they can audit (the catalog is one readable file). An orchestrator they pick, agents they assign, files-collision scheduling they can inspect. Plus everything below their level when they want speed instead of control.
**Everyone:** honest numbers doctrine (no invented ETAs, estimates labelled as estimates, fallbacks announced, refusals named). That is a brand position no major competitor occupies.

## 8. Are the model choices smart, and where do we get access?
**Access paths:** OpenAI direct, Anthropic direct (Trusted mode, strictest retention), DeepSeek direct, everything else via OpenRouter with a hard allow-list (an id outside the catalog can never be called). This is a sound architecture: the three providers that matter most for quality or privacy are first-party, the long tail rides one aggregator.

**Smart calls already made:** DeepSeek V4 Pro as owner default (near-frontier at roughly 1/30th flagship price) [verified in catalog]. V4 Flash as tenant default (cheapest strong tool-capable engine). Kimi K3 present with its mandatory max-reasoning quirk handled. The orchestrator 200B floor. The Wildfire roster separating "accepts tools" from "trusted with broad authority". Tool capability live-probed instead of trusted from provider metadata (the UnslopNemo lesson is written into the file).

**Gaps to consider:**
1. Claude Opus 4.8 is in the catalog; Opus 5 and the Claude 5 family are now current. Worth an upgrade pass.
2. Prices are a week stale (see 2.4); re-pull before any public pricing page is built from them.
3. Perplexity Sonar Pro at $3/$15 is the only web-research seat; a cheaper second option would suit Vibe-tier budgets.
4. Gemini stays out by your standing rule; noted as deliberate, no change recommended.

## 9. Bottom line
The product is in strong shape. Two real defects (one CSS line for mobile Vibe, one missing mode-switch control), one placeholder to gate before launch, one stale-price chore. The flows hold, the words are lean, the contrast is excellent, and the differentiated features are genuinely differentiated. The one strategic gap between this and the 2026 market is deployment, which is already parked for a post-MVP decision on your orders.
