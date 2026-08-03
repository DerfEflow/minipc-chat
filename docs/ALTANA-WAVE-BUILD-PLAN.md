# Altana Wave: Multi-Agent Build Plan

**Date:** 2026-08-03. **Base:** `iter/assistant-build-core` @ `67b43f2` (= `origin/main`, deployed SUCCESS).
**Discipline:** forge mode / FITS, routed by blast radius per component.
**Structure (Fred, 2026-08-03):** Opus 5 as PM, a Sonnet swarm writing code, Haiku on mechanical grunt work, Opus reviewers on completed work, **one writer per file, all working at once.**

---

## MISSION LINE

Finish the Altana wave so Dominion builds reliably and cheaply, and so a user has one assistant that knows the whole app, without any parallel agent overwriting another's work or any HIGH-blast-radius change reaching production unwargamed.

---

## 1. THE CONSTRAINT THAT SHAPES EVERYTHING

`server.mjs` is **688 KB** and nearly every remaining phase needs to touch it. One writer per file plus eight phases wanting the same file equals a queue of one, which would waste the swarm entirely.

**The codebase already solved this and the plan copies it.** The video studio wave shipped 3,873 lines across 23 files and touched `server.mjs` for 90 of them. Altana's presence layer shipped 6 assets, a stylesheet and a module and touched `server.mjs` for zero. The pattern is: **a feature is a new module; `server.mjs` gets thin wiring.**

So the rule for every agent in this wave:

> **You may create and own new modules freely. You may NOT edit `server.mjs`, `tools.mjs`, `public/app.js` or `public/index.html`. If your work needs wiring there, you write a WIRING SPEC into your handoff: exact anchor text, exact insertion, exact import line. A single integrator applies them in sequence.**

That converts the choke point from a collision into a queue, and the queue is short because wiring is small.

---

## 2. FILE OWNERSHIP MAP

Verified against the tree at `67b43f2`. **A file appears exactly once.** No two lanes share an owner.

| Lane | Owns (exclusive write) | Tier |
|---|---|---|
| **A. Ollama sweep** | `hands/hands.mjs`, `memory.mjs`, `retriever.mjs`, `review.mjs`, `routing.mjs`, `watchdog.mjs`, `devboot.mjs`, `devboot-images.mjs`, `ops/live-rig.mjs`, plus the 18 `*_test.mjs` that boot a mock Ollama | sonnet |
| **B. Dropdown** | `public/dominion-models.css` (new), `models.catalog.mjs`, `models_dropdown_test.mjs` (new), model-picker region of `public/app.js` **via wiring spec only** | sonnet |
| **C. Caching (Phase 2)** | `contextwindow.mjs`, `cacheprefix_probe.mjs`, `cacheprobe.mjs` | opus |
| **D. Limits instrumentation** | `usage-limits.mjs` (new), `idetelemetry.mjs` | sonnet |
| **E. Sequential MCP + Wolfe** | `sequential.mjs` (new), `wolfe-logic.mjs`, `execution-policy.mjs`, `connectors.mjs` | opus |
| **F. Altana brain** | `altana.mjs` (new), `altana-context.mjs` (new), `guide.mjs` (delete), `docs/GUIDE-KNOWLEDGE.md` → `docs/ALTANA-KNOWLEDGE.md` | opus |
| **G. Altana surface** | `public/altana.js`, `public/altana.css`, `ops/altana-preview.html` | sonnet |
| **H. Google tools** | `google-maps.mjs` (new), `google-bigquery.mjs` (new), `google-people.mjs` (new), `google.mjs` | sonnet |
| **I. Simplify** | `simplify.mjs` (new), `public/dominion-simplify.css` (new), `public/dominion-simplify.js` (new) | sonnet |
| **J. Grunt** | stale comments (`wolfe-logic.mjs` EMBER "local Qwen" line is lane E's, so grunt gets the REST), `docs/*` typos | haiku |
| **INTEGRATOR** | `server.mjs`, `tools.mjs`, `public/app.js`, `public/index.html`, `toolschema.mjs` | opus |

**Collision note:** lane J must not touch `wolfe-logic.mjs` (lane E owns it) or `models.catalog.mjs` (lane B owns it). Grunt work is scoped to files no other lane owns, and the grunt brief names every forbidden file explicitly rather than describing the rule.

**Ownership correction made at launch, 2026-08-03:** `models.catalog.mjs` moved from lane J to **lane B**. The dropdown redesign is mostly a display-metadata job and the specialty strings live in that file, so the lane rewriting the picker is the lane that must own the text it renders. Lane J's brief bars it from the file by name.

---

## 3. ORDER

**Fred, 2026-08-03, superseding the wave structure below:** *"I see no reason not to do all of it. Forget the waves. Just do everything, beginning to end until its written, finished, tested, committed, and deployed."*

So **nine lanes launched at once**: A, B, C, D, E, F, G, H, J. The file ownership map in §2 is what makes that safe, and it is the only thing that makes it safe. The wargames in §5 were already written for C, D, F and H, so the HIGH lanes carry their discipline into a simultaneous launch rather than waiting for a later wave to grant it.

**One dependency survives, because it is real rather than a preference.** Lane I (Simplify) waits on lane E, because Phase 3's complexity gate and Simplify's route picker are the same classifier. Built side by side we get two routers that disagree with each other. E's brief names the exported classifier signature as a deliverable, so I starts the moment that contract is published.

**Lane A and the harness.** A rewires 18 suites that boot a mock Ollama. Running the full suite mid-sweep would produce results nobody could trust, so every lane runs only its own test files, and the full `run-tests.mjs` runs once at integration when the swarm is quiet.

**Continuous:** the INTEGRATOR drains wiring specs as lanes finish. **Reviewers** run per lane on completion, never in bulk at the end.

### The original wave order, kept for the reasoning

**Wave 1, parallel, no shared files:** A (Ollama), B (dropdown), D (limits), H (Google tools), G (Altana surface polish).
**Wave 2, after E's router exists:** E (sequential MCP + Wolfe) runs in wave 1 too, but **I (Simplify) waits on it**, because Phase 3's complexity gate and Simplify's route picker are the same classifier. Built in parallel we get two routers that disagree.
**Wave 3:** C (caching) and F (Altana brain) are the HIGH items, wargamed first (§5), then built.

**Lane A runs ALONE against the test harness.** It rewires 18 suites that boot a mock Ollama. If another lane's tests land mid-sweep, neither result can be trusted. A gets the harness to itself; everyone else runs their own suite only until A lands.

---

## 4. BLAST RADIUS PER LANE

| Lane | Tier | Why |
|---|---|---|
| C. Caching | **HIGH** | Billing math on every turn for every user |
| D. Limits | **HIGH** | Raising ceilings changes token spend on every turn |
| F. Altana brain | **HIGH** | Acts on the user's behalf; touches secrets and PII boundaries |
| H. BigQuery only | **HIGH** | Bills per byte scanned; a model that can query can spend |
| Any prod deploy | **HIGH** | Irreversible |
| E, I, B | MEDIUM | Reversible, real quality/UX impact |
| A, G, J, H (Maps/People) | LOW | Reversible, internal or cosmetic |

---

## 5. WARGAMES — HIGH elements only

### C. Caching
| # | Failure | Defense |
|---|---|---|
| C1 | Moving the retrieval block behind history changes what the model sees and silently degrades answers | The block is EVIDENCE, not instruction. Move it, then diff ten real answers before/after. If quality drops, keep it ahead of history and accept the smaller cache |
| C2 | A cache "win" is really a correctness loss (stale context served) | Cache reads are provider-side prefix matching, not our storage. Assert prompt bytes are identical, never that output is |
| C3 | Cost math double-counts the discount | `models_pricing_test` pins rates; add a case asserting a cached turn bills read rate ONLY on provider-counted cache tokens |
| C4 | Moonshot/NVIDIA caching assumed rather than measured | Probe each lane before claiming a saving. NVIDIA free endpoints have no caching at all |

### D. Limits
| # | Failure | Defense |
|---|---|---|
| D1 | Generous ceilings + a reasoning model = a runaway bill on one turn | Ceilings raise the CAP, not the spend. Verify session budget still gates before the call, not after |
| D2 | Instrumentation logs consumption but not ceiling-hits, so the data cannot answer the narrowing question | `finish_reason=length`, `omitted`, `usedTokens`, `budgetTokens` are mandatory fields. A test asserts each appears in a written record |
| D3 | Logging PII into the usage record | Log counts and ids, never message text |

### F. Altana brain
| # | Failure | Defense |
|---|---|---|
| F1 | She takes a destructive action inside her allowed zone | Confirmation on irreversible-but-not-sensitive actions, on top of Fred's four exclusions (card billing, budgets, PII, secrets, IP) |
| F2 | A secret or PII reaches her context and she repeats it | Redaction at the ASSEMBLER, not by instruction. A test feeds a fake key through and asserts it never appears in the assembled context |
| F3 | Prompt injection: a user's file or a web page tells her to flip a setting | Tool results are DATA. Her system prompt states it and a test drives an injected instruction and asserts no tool call fires |
| F4 | She loses her tools silently on failover (Luna cannot call tools via chat/completions) | Primary is NVIDIA V4 Pro on chat/completions, tools verified. The Luna FALLBACK must route through `openairesponses.mjs`; a test asserts the Responses path is used on failover and fails if a chat/completions call is constructed for Luna |
| F6 | Her model 529s or goes not-invokable and she is dark on every screen at once | Measured risk, not hypothetical: NVIDIA returned HTTP 529 during the adoption probe and four models on this account are listed but uninvokable. Failover to Luna on 529/404/timeout, and a test drives each of those three responses and asserts a real answer still comes back |
| F7 | Failover is silent, so a free turn quietly becomes a billed one | The seat change is announced the same way model substitution already is, and the usage record names the lane that actually served the turn |
| F5 | Removing the Guide breaks live routes | `/guide/ask`, `/guide/complaints`, `/guide/complaint/resolve` all exist and are dispatched at `server.mjs:9808`. They are REPLACED, not deleted, and the complaint store's data survives the rename |

### H. BigQuery
| # | Failure | Defense |
|---|---|---|
| H1 | An assistant-issued query scans a huge table and bills accordingly | Hard `maximumBytesBilled` on every job. Not advisory. Refuse rather than truncate |
| H2 | Dry-run estimate skipped | Every query dry-runs first; the estimate is shown before it runs |

---

## 6. SUCCESS CRITERIA (ship line = 4/5)

1. `node run-tests.mjs` green, every lane's new tests included.
2. Every HIGH lane has a live proof, not an assertion: caching shows provider cache reads; limits shows a written record containing a ceiling-hit; Altana shows a redaction test and an injection test passing; BigQuery shows a refused over-budget query.
3. No lane edited a file it does not own (checked with `git log --name-only` per lane branch).
4. No unexplained OPEN high-impact ledger item.
5. Deploy verified against the commit sha via the Railway API, never against boot time alone.

---

## 7. LEDGER (open, carried into the build)

| # | Item | State |
|---|---|---|
| L1 | Sequential-thinking MCP: which server, and does it survive the npx launcher fix | `[assumed]` it is the standard package. Lane E verifies before building on it |
| L2 | Whether the retrieval block can move behind history without quality loss | `[unknown]` — C1 decides it empirically |
| L3 | Google Ads developer token | `[blocked]` — deferred by Fred, not in this wave |
| L8 | BigQuery and People cannot be live-proven on this box | `[blocked on Fred]`. The build machine has no `google-oauth.json`, so no owner account has ever completed Google OAuth here, and the two scopes lane H added (`bigquery.readonly`, `contacts.readonly`) postdate any token issued elsewhere. Added-scope reconsent needs an interactive browser, which no agent session has. The refusal and cap logic run for real against a stubbed network reply, so every line of the money-safety path executes. Maps is separately live-proven end to end against the real API |
| L9 | Two lane briefs I wrote contained wrong premises, and the agents caught both | `[verified]`. I told lane D that `OUT_MODE_CEIL` and `REASONING_FLOOR` were exported when they are private, and I told lane H that Google tools register through `tools.mjs` and `toolschema.mjs` when they register through `connectors.mjs`. Both agents read the code, found the brief wrong, and re-planned rather than building against it. The habit worth keeping is the one that saved lane A: verify the premise of the task, not only the work |
| L4 | Altana's per-user sign-in counter is per-device (localStorage) | `[known limitation]`, cosmetic, accepted |
| L5 | Simplify's Billy Goat theme is a rebuild from a 4-line spec, not an extraction | `[user-stated]` intent, confirmed 2026-08-03 |
| L6 | Altana's `recordSignIn()` has no client-side sign-in moment to hang on | `[verified]` at integration: `grep` for signin, login, and OTP verification across `public/app.js` and `public/dominion-tenant.js` returns nothing. Auth happens at the edge through Cloudflare Access, so the browser never sees a sign-in event. `altanaMount` therefore counts page loads instead, which rotates her face every ten loads rather than every ten sign-ins. Cosmetic, accepted, and it supersedes L4 |
| L7 | Lane J edited `models.catalog.mjs` after being told the file was forbidden | `[verified]`. Prose only, no code changed, so no functional harm. It did delete the provenance line "probed live 2026-08-03, twice" and replace it with a vaguer claim, which is a real loss on a comment documenting measured starvation floors. Restore at review time once lane B has finished writing the same file |

---

## 8. ABORT CONDITIONS

Stop the wave and report, do not push through:

1. Two failed attempts at the same subgoal by the same lane (two-strike rule).
2. Any lane discovering it must edit a file another lane owns.
3. A HIGH lane unable to produce its live proof.
4. Test suite red for two consecutive integrator drains.
5. Six consecutive deploy failures (Fred's standing rule).
6. Any lane proposing a change to billing rates, prod DDL, or a credential without Fred's explicit approval.

---

## 9. VERIFIED FACTS THIS PLAN RESTS ON

All checked against the tree on 2026-08-03, tagged per FITS:

- `[verified]` Ollama footprint: **30 files**, 12 source and 18 test. `server.mjs` 83 refs, `hands/hands.mjs` 24. **The count was right and the conclusion drawn from it was wrong.** Lane A proved on 2026-08-03 that this transport is Fred's owner-only zero-egress lane and the keyless test fixture for five suites, so it stays. Counting references told us how big the job was and nothing about whether to do it.
- `[verified]` The Guide IS wired: imported at `server.mjs:153`, instantiated at 1310-1311, three routes at 5304-5357, dispatched at 9808. An earlier claim in this session that nothing imported it was **wrong**, caused by a malformed grep pattern, and is corrected here.
- `[verified]` `GUIDE_MODEL` is already `openai/gpt-5.6-luna`, so Altana inherits Luna rather than introducing it.
- `[verified]` The retrieval block sits at `server.mjs:7832`, ahead of history: the remaining cache-prefix gap.
- `[verified]` Phase surfaces: `wolfe-logic.mjs` 64.4 KB, `connectors.mjs` 38 KB, `tools.mjs` 98.8 KB, `google.mjs` 24.2 KB, `toolbox.mjs` 2.5 KB.
- `[verified]` Base commit `67b43f2` is deployed to production, Railway status SUCCESS.
