# Lane E wiring: sequential thinking replaces Flame and Furnace

Written 2026-08-03. Branch `iter/assistant-build-core`. SOW Phase 3.

Lane E does not own `server.mjs`, `tools.mjs`, `toolschema.mjs`, `public/app.js`, `public/index.html`,
`models.catalog.mjs` or `contextwindow.mjs`. Everything below is an exact instruction for whoever does.
Every anchor was taken from the working tree today and verified to appear **exactly once** in the file.

---

## CONTRACT FOR LANE I

One classifier, one signal, two outputs. Simplify My Chat reads it to choose **who answers**. The
Phase 3 gate reads it to choose **how hard to think**. There is no second scoring function anywhere
in this repo, and there must not be, because two routers built separately disagree and the
disagreement shows up as a user getting a cheap model on hard work.

```js
import { classifyComplexity } from "./sequential.mjs";

classifyComplexity(input, options?) -> frozen object
```

**`input`** is a string, or an object:

| field | type | meaning |
|---|---|---|
| `text` | string | The **ask slice**, never the raw message. See the warning below. |
| `taskKind` | string, optional | Caller-declared class (`simple`/`research`/`build`/`audit`/`long-run`). Wins over inference, exactly as it does for `createTaskContract`. |
| `attachments` | number, optional | Count of attachments on the turn. |
| `historyTurns` | number, optional | Turns already in the conversation. |
| `toolsRequested` | boolean, optional | The turn is asking for machine work. |

**`options`** is `{ env }`, defaulting to `process.env`. Pass an explicit `env` in tests.

**Returns** a frozen record. It is total: every field is present for every input, including `null`,
`undefined`, a number, and the empty string. It never throws.

| field | type | for whom |
|---|---|---|
| `score` | 0..100 integer | both |
| `band` | `trivial` / `simple` / `moderate` / `complex` / `deep` | Lane I: map band to a seat |
| `threshold` | number | both: the gate this score was compared against |
| `needsSequential` | boolean | Phase 3 gate: escalate or stay light |
| `suggestedTier` | `ember` / `flame` / `furnace` | Phase 3 gate |
| `reasoning` | boolean | Lane I: this turn wants a reasoning-capable seat |
| `minContextTokens` | number | Lane I: smallest window that will not truncate |
| `taskKind` | string | the class from `classifyTaskIntent`, not a private copy |
| `workKind` | string | underlying class when `taskKind` is `long-run` |
| `signals` | frozen string[] | which rules fired, for logs and the "why" line |
| `rationale` | string | one sentence, safe to show a user |

**Lane I maps `band` to a model id. `sequential.mjs` deliberately contains no model list.** The routing
table is Lane I's and the catalog is `models.catalog.mjs`. A model list here would be a third place to
keep in sync, and this repo has already paid for that shape.

**Pass the ask slice, never the raw message.** Use `askSliceOf(message)` from `routing.mjs`. A pasted
article read as an instruction is a defect this repo has already paid for once: commit `5ebc25e`,
where a pasted piece of writing was classified as a build and the completion gate replaced a perfectly
good answer with "Work paused".

### The threshold

```js
import { SEQUENTIAL_THRESHOLD_DEFAULT, sequentialThreshold } from "./sequential.mjs";
```

Default `45`. Override at runtime with `DOMINION_SEQUENTIAL_THRESHOLD` (0..100; anything else falls
back to the default). It is exported, it rides inside every result next to the score, and it appears
in `rationale`. The SOW requires it to be observable and tunable rather than buried as a magic number,
and moving it must not move the score. `sequential_test.mjs` pins both halves.

### The other exports

```js
effectiveForgeTier({ requestedTier, mode, ask, taskKind, attachments, historyTurns,
                     toolsRequested, dialEnabled, env }) -> frozen
  // { tier, source, dialEnabled, requestedTier, honoredRequest, complexity }

sequentialPlan(task, { ask, mode, requestedTier, taskKind, attachments, historyTurns,
                       toolsRequested, think, maxSteps, thinker, env, signal }) -> Promise<frozen>

createSequentialThinker({ spawn, rpc, pkg, cacheDir, firstMs, callMs, log })
  -> { connect, plan, record, close, status }
```

---

## L1, closed: which server, and does it survive the npx launcher fix

**`@modelcontextprotocol/server-sequential-thinking`**, registry version `2026.7.4`, running server
version `0.2.0`. `[verified]` by launching it through this repo's own launcher on 2026-08-03.

```
LAUNCHER: {"cmd":"C:\\Program Files\\nodejs\\node.exe",
           "prefix":["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"]}
[stderr] Sequential Thinking MCP Server running on stdio
=== INITIALIZE (4626ms) ===
{ "result": { "protocolVersion": "2025-03-26",
              "capabilities": { "tools": { "listChanged": true } },
              "serverInfo": { "name": "sequential-thinking-server", "version": "0.2.0" } },
  "jsonrpc": "2.0", "id": 1 }
```

**It is a thought LOG, not a reasoner.** One tool, `sequentialthinking`. It accepts a thought the
caller already produced and answers with bookkeeping only:

```
tools/call -> { "thoughtNumber": 1, "totalThoughts": 3, "nextThoughtNeeded": true,
                "branches": [], "thoughtHistoryLength": 1 }
```

That fact decides the design. `plan()` requires a `think` callback that produces each thought; the
server supplies step numbering, a live total that moves up or down, revision and branch tracking, and
the explicit "another step is needed" signal that stops a model declaring victory at step two.
Anything claiming this server does the reasoning has not run it.

---

## Insertion 1. The import block

**Anchor** (`server.mjs`, appears once, currently at line 120):

```js
import {
  classifyTaskIntent, createTaskContract, mapExecutionPolicy,
  executionManagerPrompt, forgeFrameworkPrompt, normalizeForgeTier, evaluateCompletionEvidence,
} from "./execution-policy.mjs";
```

**Replace with:**

```js
import {
  classifyTaskIntent, createTaskContract, mapExecutionPolicy,
  executionManagerPrompt, forgeFrameworkPrompt, normalizeForgeTier, evaluateCompletionEvidence,
  FORGE_DIAL_ENABLED,
} from "./execution-policy.mjs";
import { effectiveForgeTier, classifyComplexity, sequentialPlan } from "./sequential.mjs";
```

`sequential.mjs` imports `spawnMcpStdio` and `stdioRpc` from `connectors.mjs`, and `connectors.mjs`
imports only `toolschema.mjs` plus node builtins. No cycle, and importing the module spawns nothing:
the shared thinker is created lazily on first use.

---

## Insertion 2. The tier decision (this is the whole behavior change)

**Anchor** (`server.mjs`, appears once, currently at lines 7677 to 7682):

```js
  const legacyForgeTier = typeof input.forgeMode === "string" ? input.forgeMode : "";
  const explicitWolfeTier = input.wolfeTier || legacyForgeTier;
  let wolfeTier = "ember";
  try { wolfeTier = explicitWolfeTier ? normalizeForgeTier(explicitWolfeTier) : (mode === "as_fred" ? "furnace" : "ember"); }
  catch { wolfeTier = "ember"; }
  const forgeEnabled = input.forgeMode === true || (!!legacyForgeTier && wolfeTier !== "ember");
```

**Replace with:**

```js
  const legacyForgeTier = typeof input.forgeMode === "string" ? input.forgeMode : "";
  const explicitWolfeTier = input.wolfeTier || legacyForgeTier;
  /*
   * THE FORGE DIAL IS OFF (execution-policy.mjs FORGE_DIAL_ENABLED, 2026-08-02). The client's tier
   * is recorded and ignored, and depth is decided by the complexity router. As Fred still reaches
   * furnace because it is a mode rather than the dial. Flipping the flag restores the old behavior
   * with no other edit here.
   */
  const forgeDecision = effectiveForgeTier({
    requestedTier: explicitWolfeTier,
    mode,
    ask: askText,
    taskKind: taskIntent.kind,
    attachments: Array.isArray(input.attachments) ? input.attachments.length : 0,
    historyTurns: history.length,
    toolsRequested: attachTools,
  });
  const wolfeTier = forgeDecision.tier;
  const forgeEnabled = input.forgeMode === true || (!!legacyForgeTier && wolfeTier !== "ember");
```

`askText`, `taskIntent`, `history`, `attachTools` and `mode` are all already in scope at that point
(`askText` and `taskIntent` are defined at lines 7528 and 7529). `normalizeForgeTier` stays imported
because line 3546 still calls it.

**`effectiveForgeTier` never throws**, so the surrounding `try/catch` goes away with it. A malformed
tier from an old client resolves to the router's judgment rather than an exception.

### Surfacing the decision

The SOW asks that a user be told when a task escalates, and that the threshold be observable. The
route SSE frame already exists. Add to the existing `sse({ type: "route", ... })` payload:

```js
        depth: { tier: wolfeTier, source: forgeDecision.source,
                 score: forgeDecision.complexity.score,
                 threshold: forgeDecision.complexity.threshold,
                 band: forgeDecision.complexity.band },
```

Telemetry: log `forgeDecision.complexity.score`, `.threshold` and `.band` per turn. The SOW names
"whether the router escalated the turn to sequential thinking" as a metric to capture from day one,
and data not captured from day one cannot be recovered later.

---

## Insertion 3. Nothing to do at the system prompt

**Anchor** (`server.mjs`, appears once, currently at line 5543):

```js
  s += "\n\n" + forgeFrameworkPrompt(wolfeTier);
```

**Leave this line exactly as it is.** `forgeFrameworkPrompt` keeps its signature and stays a pure
function of the tier. Its `flame` and `furnace` output now carries the sequential-thinking directive
and the build discipline. `ember` is byte-identical to before.

Likewise leave line 7729 alone:

```js
  const executionDirective = executionManagerPrompt(taskContract, executionPolicy);
```

That directive still rides its own message **after** history. Do not move it back into the system
prompt. See the prefix-stability section.

---

## Insertion 4 (optional, Phase 3 completion). Running an actual sequence

Nothing above runs the MCP. Insertions 1 to 3 give every heavy turn the sequential *directive* while
the model does the stepping itself, which is the low-risk half. To drive the server for real, call
`sequentialPlan` before the model loop on turns where `forgeDecision.complexity.needsSequential` is
true, passing a `think` callback that asks the selected model for one thought at a time:

```js
  if (forgeDecision.complexity.needsSequential && !opts.noTools) {
    const seq = await sequentialPlan(workGoalText, {
      ask: askText, mode, requestedTier: explicitWolfeTier,
      taskKind: taskIntent.kind, historyTurns: history.length, signal: ac.signal,
      think: async ({ stepNumber, totalThoughts, previous }) => { /* one model round */ },
    });
    if (!seq.degraded) sse({ type: "sequential", steps: seq.steps.length, total: seq.totalThoughts });
    // seq.directive is present on BOTH paths; append it wherever the plan should be visible.
  }
```

`seq` has the same shape whether the server answered or not, so there is no `if (available)` branch
to get wrong. On any failure `seq.degraded` is true, `seq.reason` names the real cause, and
`seq.directive` is `forgeFrameworkPrompt(tier)`, which is the behavior the app has today.

**Do not add per-turn text to the system message from this.** Anything derived from the goal belongs
behind history, next to `executionDirective`.

---

## Disabling the user-facing dial in the interface

Lane E cannot edit `public/app.js` or `public/index.html`.

> **THE DIAL IS STILL LIVE IN THE SHIPPED PATH.** Verified during review, 2026-08-03. Insertion 2
> below has **not** been applied. `server.mjs` line 7678 still reads `input.wolfeTier ||
> legacyForgeTier` straight from the request body and hands it to `forgeFrameworkPrompt`, and
> `server.mjs` never imports `FORGE_DIAL_ENABLED`. A client that posts `wolfeTier: "furnace"` today
> gets furnace prompt bytes, sequential directive included. Fred asked for the dial to be disabled
> and left in place; the "left in place" half is done and the "disabled" half is not. Until
> Insertion 2 lands, `FORGE_DIAL_ENABLED` is a constant that only `sequential.mjs` and its test
> read, and `sequential_test.mjs` proves inertness of `effectiveForgeTier`, which is a function the
> live request path does not call.

Once Insertion 2 lands, the server side is inert and the interface work is cosmetic:

1. Hide the Forge tier control. **Do not delete it.** Fred has not decided whether users may override
   the automated depth, and re-enabling a control that still exists is cheap.
2. Keep sending `wolfeTier` / `forgeMode` in the request body. The server records and ignores them,
   and `chatsync.mjs` still persists `forgeTier` / `forgeMode` per chat. Removing the fields would
   break session merge for no gain.
3. Optionally show `depth.band` from the route frame as a quiet line, so escalation is visible.

The single source of truth for whether the dial is live is `FORGE_DIAL_ENABLED` in
`execution-policy.mjs`. Nothing else re-derives it. `sequential_test.mjs` asserts that every possible
client tier value produces identical prompt bytes while the flag is off, **for
`effectiveForgeTier`**. That assertion says nothing about `/chat` until Insertion 2 is applied, and
no test in this repo currently covers the shipped tier decision in `server.mjs`. Whoever applies
Insertion 2 should add one.

---

## Prefix stability

**Lane E changed nothing that affects the cache prefix.**

- `forgeFrameworkPrompt` is still a pure function of the tier, with no interpolation of the goal, the
  request, the time, or anything else per-turn. Only its `flame` and `furnace` literals changed.
  `forgeFrameworkPrompt("ember")` is byte-identical. Verified by running `cacheprefix_test.mjs` and
  `execution-policy_test.mjs` during review, both green.
- **One shipped prompt string did change, in `execution-policy.mjs`:** the Cost line of
  `executionManagerPrompt` lost its em dash ("paused—not complete" became "paused and not
  complete"). That is the integrator's fix and it is correct, and it does not touch the prefix
  because `executionManagerPrompt` rides behind history. Named here so nobody later reads "Lane E
  changed nothing" and concludes the bytes are identical.
- **`wolfe-logic.mjs` EMBER is NOT verbatim.** Its heading em dash became a comma. That string is
  the head of a cached prefix wherever it is used, so it is a one-time cache invalidation. It is
  moot today because nothing imports `wolfe-logic.mjs`.
- `executionManagerPrompt` was **not touched**. The `Goal: ${compactText(contract.objective, 900)}`
  interpolation stays exactly where it is, in the directive that rides after history.
- No new text was added to the system message, and nothing was moved into it.
- Both new modules add file-level comments stating the invariant, so the next session does not have
  to rediscover it.

`cacheprefix_test.mjs` is Lane C's and was not run here, per the lane rules.

**One second-order effect, in the right direction.** With the dial off, `wolfeTier` no longer follows
a control the user can flip mid-conversation. It now follows the ask. A conversation whose asks stay
in one complexity band holds one tier and therefore one prefix. A conversation that swings from
trivial to heavy will change tier between turns and break the prefix at that turn, which is the same
thing that happened before whenever a user moved the dial. If that churn shows up in real traffic,
the fix is to latch the tier per chat at its high-water mark rather than to reintroduce per-turn text
into the system prompt.

---

## Files Lane E changed

| file | what |
|---|---|
| `sequential.mjs` | new. MCP client, `classifyComplexity`, `effectiveForgeTier`, degradation. |
| `sequential_test.mjs` | new. 21 tests, including the live server behind `DOMINION_SEQUENTIAL_LIVE=1`. |
| `execution-policy.mjs` | added `FORGE_DIAL_ENABLED` (the one named flag). `forgeFrameworkPrompt` flame/furnace now carry the sequential directive and the build discipline. |
| `wolfe-logic.mjs` | 66 KB to 11 KB. The 55 KB removed was two string constants (`FLAME`, `FURNACE`) and nothing else; no logic left the file and `WOLFE_RUBRIC` is untouched. EMBER kept except for one heading em dash. Stale local-Qwen comment corrected. |
| `connectors.mjs` | exported `npxLauncher`, `stdioRpc`, the timeout budgets, and a new `spawnMcpStdio`. `stdioSpawn` now delegates to it, so the npx launcher fix has exactly one implementation. 27/27 still green, and all five registry connectors verified launching through the refactored path during review. |

## Open, for whoever owns those files

- ~~`execution-policy_test.mjs` pins an em dash inside a shipped prompt.~~ **Done.** The integrator
  changed the string and the pin together and removed the exemption in `sequential_test.mjs`. All
  three verified during review; zero em dashes across every Lane E file.
- **Insertion 2 is unapplied, so the dial is still live.** See the box above. This is the one item
  that makes Lane E fail Fred's actual instruction, and it is a two-line edit in a file Lane E does
  not own.
- Insertion 4 is unwritten in `server.mjs`. Until it lands, heavy turns get the sequential
  *directive* and the MCP is never actually driven. Nothing outside `sequential_test.mjs` and
  `wolfe-logic.mjs` imports `sequential.mjs` today.
- `wolfe-logic.mjs` is imported by nothing, so the EMBER floor it describes reaches no model on any
  turn. Either wire `wolfeLogic` into `systemPrompt` or fold EMBER into `forgeFrameworkPrompt`.

## Found during review, 2026-08-03, and fixed in `sequential.mjs`

- **A blank `DOMINION_SEQUENTIAL_THRESHOLD` produced a threshold of ZERO.** `Number("")` is 0 and it
  passed the `>= 0` guard, so a Railway or Docker variable that is declared and left empty sent
  every turn, including a one-word greeting, through sequential thinking. Blank now falls back to
  45; an explicit `"0"` is still honored. Pinned by a new test.
- **A rejected `tools/call` read as a successful one-step plan.** The live server answers bad
  arguments with `{ isError: true }` and a non-JSON body. The old `record()` swallowed the parse
  failure and returned `{}`, and `plan()` then returned `via: "mcp", degraded: false`. A body that
  is not step bookkeeping did the same. Both now degrade honestly and keep the fallback directive.
  Two new tests, built from the real server's captured error body.

## Pre-existing, outside Lane E, worth someone's attention

`@stripe/mcp` is now a thin proxy to Stripe's hosted HTTP MCP. With a bad key it launches fine,
logs a 401 to stderr, and then never answers `initialize` at all, so it burns the full 180 second
first-call budget and reports a timeout. Reproduced identically against the pre-refactor spawn body,
so this is not a Lane E regression. `connectors.mjs` could watch stderr for an auth failure during
`initialize` and fail fast, the same way the missing-npm case was fixed.
