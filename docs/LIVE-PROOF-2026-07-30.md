# Live proof run, 2026-07-30 evening

Historical record from before the 2026-08-03 prune that reduced the catalog from 44 to 25 models.
Everything below was produced by driving the REAL server over its real HTTP surface with real
provider keys and a real hands node. No mocks. Rig: `ops/live-rig.mjs` (devboot + hands node rooted
at `Z:\dominion-livetest`, `IDE_MODE=all` to mirror production). Raw data: `ops/sweep-results.json`,
`ops/live-results.json`.

## 1. Every model the app offers (`ops/model_sweep.mjs`)

45 catalog entries called through the app's own `/chat` pipeline, one tiny prompt each.

**42 answered. 3 failed, each for a different real reason, each now fixed or ruled on:**

| Model | What happened | Ruling |
|---|---|---|
| `allenai/olmo-3-32b-think` | HTTP 404 "No endpoints found" from OpenRouter, on the sweep and on three direct probes. Listed in their catalog; no host serves it. | REMOVED from the catalog. Offering a model nobody can run is worse than a shorter list. |
| `thedrummer/cydonia-24b-v4.1` | HTTP 429, upstream shared-pool rate limit. Answered normally once routing was widened. | `allow_fallbacks: true` now stated explicitly, plus a once-per-turn widen-the-pool retry. |
| `sao10k/l3.3-euryale-70b` | "Provider returned error" three times in 15s; answered fine minutes later on every routing config. | Transient host flake. The new patient retry schedule covers this window. |

Also caught live: `google/gemma-4-31b-it:free` failed twice and SUCCEEDED on the third attempt — the
old policy (2 retries inside 1.5s) would have called it dead. Moonshot `kimi-k2.6` rejected
`temperature` exactly once, and the remembered repair carried it for the rest of the session.

**Image lanes:** free draft lane and default paid lane both returned images. 2/2.

**BATTALION:** text ask convened the swarm ($0, 1 model, manifest returned). Build ask took the new
honesty detour to `deepseek/deepseek-v4-pro` with 25 tools offered, instead of pretending to build.

## 2. Chat build on a NON-flagship model — the thing that had never once worked

`deepseek/deepseek-v4-flash`, one message, folder `Z:\dominion-livetest\chat-build`.

- 3 tool calls on machine `livetest`; **3 real files written**: `package.json`, `tally.mjs`, `test.mjs`
- The model hit a real obstacle mid-run (PowerShell rejecting `&&`), corrected itself, and continued
- **Completion evidence ACCEPTED** (`completionVerified: true`), zero false rejections, zero errors
- Independent check afterwards: `node test.mjs` -> `tally ok`, exit 0

## 3. Guest parity

Walked the real front door: a brand-new guest is refused with `needs_invite`, the owner mints a free
code, the guest redeems it (`role: sponsored`), and everything opens.

| | Owner | Guest |
|---|---|---|
| Models offered | 45 | 45 (identical set; Wildfire star stripped by design) |
| Default model | deepseek-v4-pro | deepseek-v4-flash (tenant default, by design) |
| Money wording | dollars | **credits** (1000 -> 999 after one turn) |
| Chat turn | ok | ok |
| Workshop / Crucible | own machine | own server-side workshop folder, `node: "workshop"` |

## 4. Crucible Vibe — three ranks, relay, orchestrator, worst-case models

- **General** asked a real scoping question; **Captain** named the pitfall (unhappy paths);
  **Sergeant** named the one proving test. Three distinct voices, all 200.
- **Cross-window relay worked**: the Captain's opinion forwarded to the General changed the
  General's reply ("The Captain's caution is spot-on...").
- **Orchestrator** planned 3 tasks on `deepseek/deepseek-v4-pro`, no fallback needed.
- Build ran with the cheapest eligible seat requested; the engine assigned `openai/gpt-5.6-terra`
  and `deepseek/deepseek-v4-pro` per task class, took snapshots, emitted diffs, and wrote
  `index.html`, `styles.css`, `script.js`.
- Preview relay served the page.

**Three real defects were caught here, all fixed:**

1. **The furnace pass cried wolf.** HTML `placeholder="e.g. Groceries"` and CSS `input::placeholder`
   were reported as unfinished work, so a finished build ended by asking the user to close three
   items that did not exist. The web platform's own word for finished work is now scrubbed before
   the placeholder rule reads a line; an ALL-CAPS `PLACEHOLDER` marker is still caught.
2. **The built page was broken and everything said it was fine.** `index.html` loaded `app.js`
   while the build wrote `script.js`. Every move said done, the sweep was clean, the page rendered,
   and the app did nothing (browser proof: 404 on `app.js`, the form fell back to a GET, the total
   stayed $0.00). New `brokenReferenceFindings()` reads every local `src`/`href` out of the written
   HTML and confirms a file provides it; broken references now block the completion contract.
   Verified against the real built files: the checker finds exactly the one bad reference.
3. **A second preview silently showed the first project.** `/ide/preview/start` returned `ok: true`
   while the relay kept serving the earlier workspace, because `Start-Process` reports the
   LAUNCHER's pid, that launcher exits immediately in static mode, and `taskkill` therefore hit a
   corpse while the real server kept port 37311. The readiness poll was then satisfied by the STALE
   app. Now: the stop frees the PORT (kill by owner) as well as the pid, and the start compares the
   served `<title>` against the workspace's own `index.html` and refuses rather than show the wrong
   project. Proven live: after the fix, the beginner workspace's preview served the beginner app.

## 5. Beginner surface

- Intake asked one plain question; 4 tasks planned; 2 moves, both done; outcome **done**
- One self-contained `index.html` (9,061 bytes), **furnace sweep clean** (no false positives)
- Browser proof: clicking "Inspire Me" changed the quote and attribution
  (Arthur Ashe -> Nelson Mandela)

## 6. The repair loop, and both apps running

The Ledger Lamp app was left broken on purpose (the `app.js` reference) so the fix path could be
tested rather than assumed. The Crucible repaired it: `index.html` now loads `script.js`.

Both apps verified working in a real browser through the preview relay:

- **Ledger Lamp** (`crucible-build`): entering "Coffee / 5.25" and submitting produces
  `Expenses  Coffee $5.25  Remove` and `TOTAL SPENT $5.25`. Before the repair the same interaction
  did nothing at all.
- **Daily Encouragement** (`beginner-build`): clicking "Inspire Me" changes the quote and the
  attribution (Arthur Ashe -> Nelson Mandela).

## 7. The rejection death-loop, and the measured proof it is gone

Repairing the broken page through CHAT exposed the worst defect of the night, and it is Fred's
complaint in its purest form: **the work was done and the app refused to admit it.**

The completion gate rejected its own worker 100+ times across **172 tool calls** and died with the
file already fixed. Two independent causes, both now fixed:

1. **Word sense.** The folder was named `crucible-build`. The gate's validation test read the whole
   objective string, so the word "build" INSIDE A PATH made it demand a validation step — and a
   static HTML page has no test command to run. The demand was unsatisfiable from the first round.
   Paths, drive letters and filenames are now stripped before any intent word is read. (The test
   written for that scrub then caught a second, older bug: the word list matched "test" but not
   "tests", so the most natural phrasing of all silently skipped the requirement. Fixed too.)
2. **Path sense.** The request named `index.html`; the tool reported
   `Z:\dominion-livetest\crucible-build\index.html`. Containment alone could not relate them, so the
   gate said "the cited mutation does not touch any file named in the request" about an edit to
   exactly that file. Suffix and whole-segment matching now count; two unrelated folders both
   called `src` still do not.

And the structural fix that makes this class of failure survivable forever: **the unsatisfiable
demand breaker.** Three identical rejections in a row release the work as completed WITH THE UNMET
CONDITION NAMED, in the final report and in the done-event. A demand nobody can satisfy now ends
the turn honestly instead of spending the budget proving it cannot be satisfied.

Measured on the identical prompt, three times:

| Run | Tool calls | Gate outcome | Result |
|---|---|---|---|
| Before the fixes | **172** | 100+ rejections | never finished, work already done |
| With the breaker only | **15** | released with limitation | finished, limitation stated plainly |
| With word + path sense | **4** | verified on the first check | finished clean |

## Rig-only limitations (not product defects)

- The vision fidelity audit could not photograph the page: the test hands node runs with
  `HANDS_DESKTOP=0`, so no browser is available to it. The sweep and the reference check both ran.
- `/hands/nodes` answered `unauthorized` to the suite (it needs the bearer token; the suite does not
  hold one). Node health was confirmed from the server log line `hands: node "livetest" connected`
  and by the builds actually writing files.
