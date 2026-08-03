# Executive Assistant + Sequential Build Core SOW

**Date:** 2026-08-02. **Worktree:** `Z:\Apps\minipc-chat\assistant-build-core`, branch `iter/assistant-build-core`, based on `origin/main` @ 935062f.

**Fred's order (2026-08-02):** improve the stability and reliability of the IDE portion and the build/code/deep-thinking portion of chat. Five named items: prune the model roster and add NVIDIA + Google; put prompt caching on every API that supports it, with a tool drawer that is not part of every call; build an executive assistant with broad app awareness that can work the app's controls; add Google APIs as callable assistant tools; and replace the heavy Forge/Wolfe tiers with a sequential-thinking MCP as the primary framework for builds.

**Mission line:** Dominion builds finish and prove it, the reasoning core gets lighter without getting dumber, and one assistant that knows the whole app sits above every screen and can actually work the controls.

---

## 0. What already exists (audited 2026-08-02, do not rebuild)

The 08-01 lesson repeated itself. Most of this SOW's surface area is already in the tree.

| Asked for | Status in code |
|---|---|
| GPT-5.6 Luna as the assistant model | Already in `models.catalog.mjs`: `openai/gpt-5.6-luna`, direct to OpenAI, $0.20 in / $1.20 out per 1M, 1.05M ctx, vision, reasoning. No integration work needed |
| Local Qwen removed from the lineup | Already absent from the catalog. No local entry is offered to anyone. The Ollama transport remains in `server.mjs` (~60 refs) as dead weight to sweep |
| A tool drawer that is not part of every call | Already built. `toolbox.mjs` ships a focused per-turn bench plus one always-present `toolbox_open` tool that loads matching schemas for the next round only, then discards them |
| Prompt caching | Substantially built 07-28 under `docs/PROVIDER-CACHING-SOW.md`. Anthropic `cache_control` passthrough on text blocks and tool defs, OpenAI `prompt_cache_key`, DeepSeek `cacheHitCost`, cache-aware cost math, `cacheprobe.mjs` for live proof. See Phase 0 for the open wound |
| PDF to text before it reaches the model | Already built and better than the proposal that prompted this. `public/attach-extract.mjs` extracts PDF and DOCX on the device via vendored pdf.js 4.10.38 (self-hosted, no CDN, no CSP exposure), lazily loaded, riding the existing text attachment wire. Handles password-protected files, non-Latin scripts, the pdf.js buffer-detach trap, a readable-character ratio to catch garbage output, and an OCR path for scanned documents |
| NVIDIA lane | Partly wired. Several catalog entries carry "FREE via NVIDIA when keyed". `server.mjs` already zeroes cost for `__transport === "nvidia"` |
| Google Workspace | `google.mjs`, 25 KB, native over Google REST with per-account OAuth, AES-256-GCM at rest. Gmail, Calendar, Drive, Sheets, Docs live |
| MCP connector startup | Fixed and verified. `npxLauncher()` runs npm's own `npx-cli.js` through `process.execPath`, no shell, so a new MCP server can actually start |
| Sequential thinking MCP | Zero references anywhere. Genuinely net-new |

**Also true and previously mis-recorded:** the Google OAuth consent screen is **In production** (verified from Fred's console, 2026-08-02, User type External). The 7-day refresh-token expiry does not apply. The stale owner-setup comment in `google.mjs` saying "users added as test users until verified" is what has misled multiple sessions into re-deriving Testing status. **Fix that comment in Phase 5.** What still applies is the OAuth user cap on unverified sensitive/restricted scopes, which is a growth ceiling rather than an expiry.

---

## Phase A. Model wiring, researched per model, before anything else

**Fred's order, 2026-08-02:** "we need to do the research for every single model, without fail and not from memory, on how to form the calls and tools and language used and also token limitations per turn that are imposed by it and not us. we can avoid a bunch of disappointed people right off the bat by making 100% sure we have that part correct before we even begin everything else."

**This phase runs first and gates the rest.** It is upstream of four other pieces of this SOW, not merely ahead of them in the queue:
- Phase 1 is the roster itself.
- Phase 2 cannot be finished without each provider's actual caching contract, because the mechanism, the minimum cacheable prefix, the lifetime and the reporting field all differ per provider.
- The standing limits constraint depends on knowing which ceilings are the provider's and which are Dominion's. Right now those are conflated.
- Phase 4's Luna starvation question is a reasoning-token-budget question, which is a per-model fact.

### The evidence rule

**A live probe beats provider documentation. Provider documentation beats anyone's recollection. Recollection does not count, and that includes the assistant writing this SOW.** Model APIs drift, training data has a cutoff, and a confidently remembered parameter name is exactly how a guest gets an error in the face. Every field below carries its source and the date it was checked. Any field that could not be verified leaves the model in a **cold lane**: present in the code, not offered to users, exactly as the 07-28 SOW already handles unverified `directId`s.

### What already exists (extend, do not rebuild)

- `catalogaudit.mjs` verifies against live provider model lists that an id exists, that the `toolCapable` label is true, and that context has not drifted. Covers OpenRouter, OpenAI, Anthropic, DeepSeek. Runs as a CLI (`tools_audit.mjs`) and as a weekly server self-check.
- `fleet_probe.mjs` live-probes three facts the catalog must never guess: does it answer, does it emit a real tool call, does it accept an image. Scoped to NVIDIA and Moonshot.
- `models_pricing_test.mjs` pins every customer-facing price so an edit cannot drift one silently.

**Gaps:** no Google provider in the audit at all; no coverage of provider-imposed output ceilings or rate limits; no coverage of the caching contract; no coverage of reasoning-token behavior; no coverage of how the system prompt is passed or how tools are shaped; `fleet_probe` covers two providers rather than the whole fleet.

### The per-model record

Every model in the shipped roster gets all of the following, sourced and dated. No blanks, no inference from a sibling model.

**Identity and transport**
- Exact model id string as the provider expects it, character for character
- Endpoint URL and API family (chat completions, responses, messages, generateContent, other)
- Auth header form

**Call shape and language**
- How the system prompt is passed: a top-level parameter, or a message with a system role. This differs across providers and is a classic silent breakage
- Message role vocabulary, and any role the provider rejects
- Streaming event format and terminal signal
- Required parameters, and parameters that cause a hard error if sent

**Tools**
- Tool and function schema shape
- How tool results are returned to the model
- Whether parallel tool calls are supported
- Whether strict or structured output is supported, and its constraints

**Reasoning models**
- Whether it emits reasoning tokens
- **Whether reasoning tokens consume the output budget.** This is the mechanism behind the recorded GPT-5.x starvation scar
- Whether reasoning state must be replayed across tool rounds. `contextwindow.mjs` already knows DeepSeek requires `reasoning_content` replay and OpenRouter requires `reasoning_details`; that knowledge needs to live in the catalog rather than one module's comments

**Limits imposed by the provider, not by Dominion** (Fred's explicit ask)
- Published context window
- Maximum output tokens per request
- Rate limits: requests per minute, tokens per minute, and which account tier they apply to
- Any per-turn cap distinct from maximum output

**Caching contract**
- Mechanism: automatic, explicit breakpoints, or stored context
- Minimum cacheable prefix length
- Lifetime
- Write and read pricing
- The exact response field that reports hits

**Commercial and capability**
- Input, output and cached-read price
- Vision support and how images are passed

**Deviations**
- Everything this provider does that breaks the OpenAI-compatible assumption. This category is where the disappointed users come from

### NVIDIA lane: which endpoints, decided from the live list

**Fred's constraint, 2026-08-02:** no endpoint that duplicates a provider Dominion already has direct. Interesting models only, and only where they are free or very cheap.

**Fred's standing note on quota, recorded at his request:** he is in the NVIDIA developer program, and the utilization limits there are "extremely generous and far beyond what I could use right now even with every user utilizing it all day." This materially softens the 07-28 research finding that the dev tier's rate limits made it unsuitable, and that earlier note should be read as superseded. **Phase A still records the actual published numbers**, because "generous" is a judgment and the record wants a figure.

The live endpoint served **102 models** on 2026-08-02. Full id list captured during the audit.

**Excluded as duplicating a direct provider:** `moonshotai/kimi-k2.6` (Moonshot key held), `deepseek-ai/deepseek-v4-pro` and `deepseek-ai/deepseek-v4-flash` (already direct, and they are the owner and tenant defaults).

**Excluded as legacy shelf** (adding them degrades the picker): Llama 2 and CodeLlama, Yi, DBRX, Mixtral 8x22B, the Phi 3 family, Granite, the Nemotron 4 340B generation, older Gemma and CodeGemma, Kosmos, Fuyu, NeVA, VILA, SEA-LION, Zamba, StarCoder2, the Llama 3.1 and 3.2 small instruct models.

**Probe shortlist, user-facing.** First tier: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `openai/gpt-oss-120b`, `google/gemma-4-31b-it`, `z-ai/glm-5.2`, `mistralai/mistral-medium-3.5-128b`. Second tier: `ai21labs/jamba-1.5-large-instruct`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `writer/palmyra-creative-122b`, `stepfun-ai/step-3.7-flash`, `thinkingmachines/inkling`, `nvidia/cosmos-reason2-8b`, `nvidia/nemotron-nano-12b-v2-vl`.

`minimaxai/minimax-m3` is available and is probed with prior history in mind: a live MiniMax failure on 2026-07-12 produced a model that reasoned without ever speaking.

**Two catalog consequences of pruning OpenRouter.** `z-ai/glm-5.2` survives at zero cost by moving to the NVIDIA lane. `x-ai/grok-4.20` is **not** on NVIDIA, so pruning OpenRouter drops Grok unless it is kept deliberately. Fred's call.

**Non-picker lanes, higher value than the picker itself.** These are wired as infrastructure rather than offered as user model choices:
- **Document parsing:** `nvidia/nemotron-parse`, `nvidia/nemoretriever-parse`, and `google/deplot` for charts. This lands on a real gap: on-device extraction in `attach-extract.mjs` flattens table structure into a single run of text and cannot read a scanned PDF at all. Free parsing closes exactly that, and the OCR path already anticipated in that module gets a real engine.
- **Embeddings:** `baai/bge-m3`, `nvidia/nv-embedqa-e5-v5`, and `nvidia/nv-embedcode-7b-v1` for code, feeding the existing `retriever.mjs` and the two rerank probes. Removes a recurring cost.
- **Safety classifiers:** `meta/llama-guard-4-12b`, `nvidia/nemotron-3.5-content-safety`, for the guest-facing surface.

**Nothing above ships on the strength of the model list.** `/v1/models` returns ids and no capability data. Tool capability, real context window, actual free-versus-paid status on the developer tier, and whether the model emits a genuine tool call rather than describing one are all decided by probe.

### Deliverables

1. A filled record per shipped model, with provenance and check date, living beside the catalog rather than in a session transcript.
2. `catalogaudit.mjs` extended to cover Google and to check output ceilings and tool shape, not just id existence and context.
3. `fleet_probe.mjs` extended to the whole roster, adding a real two-round tool call and a reasoning-budget check to its existing three facts.
4. Dominion-imposed limits separated from provider-imposed limits in the code, so the standing limits work can raise ours without colliding with theirs.
5. Anything unverified ships cold.

### Exit criterion

Every model offered to a user has a complete, dated record and has answered a live probe. A model without both is not offered.

---

## Phase 0. The prompt-cache prefix defect (RUN, RESULT IN)

`docs/PROVIDER-CACHING-SOW.md` (07-28) recorded DeepSeek returning zero cache hits on 07-19 and named finding the cause "the highest-value item in this build." It was never closed.

**Probe run 2026-08-02 against `origin/main` @ 935062f. It reproduces.**

```
TURN1  inputTokens 1169  cache {readTokens:0, writeTokens:0, hitPct:0}
TURN2  inputTokens 1183  cache {readTokens:0, writeTokens:0, hitPct:0}
NO CACHE HITS on turn 2
```

Turn two shares roughly 1169 tokens of prefix with turn one and reads none of it.

**This is not a reporting bug.** `server.mjs` sets `sawCache` only when the provider actually returns a cache field, and the turn emitted a cache object rather than null. DeepSeek reported zero.

**It is also not the date stamp.** The system prompt's date is already day-resolution (`new Date().toISOString().slice(0, 10)`), which the 07-28 doctrine explicitly permits.

**Why this outranks everything else on the list:** Wolfe EMBER wraps every turn, on every model, for every user. A churning prefix means the app pays full freight on a ~600 word preamble plus the whole feature index, house style block, kept-promise block and operating standards, on every single call it serves.

**Work, in order:**
1. **Rule out the probe first.** The probe fires turn two seconds after turn one. Re-run with a delay inserted to confirm DeepSeek's cache write has landed. Cheapest possible way to avoid hunting a defect that is not there.
2. If it still misses, bisect the assembled system prompt across two consecutive rounds and diff them byte for byte. Prime suspects in assembly order: `featureIndex()`, `flywheel.activePrompts("global")` and `activePrompts("mode")` (ordering is not obviously deterministic), `machinesBlock()`, and the versioned prompt overlays appended at the tail.
3. Freeze the canonical prefix order and pin it with a test that asserts round N+1's assembled messages are a byte-stable extension of round N.
4. Promote `cacheprobe.mjs` from a manual script into something that runs and proves itself.

**Exit criterion:** a two-round call reports `readTokens > 0` on round two, and a test fails if the prefix churns again.

---

## Phase 1. Model roster

Independent of everything else, low risk, runs early and in parallel.

### The provider preference rule (Fred, 2026-08-02, standing)

Applies to every model Dominion keeps, now and later:

1. **If a model can be obtained direct from its own vendor, take the direct route.** Direct is cheaper, gives real cache counters, and removes a middleman that can silently change a model id.
2. **If it is available free through NVIDIA, that is a discussion rather than an automatic win.** Free is not free of tradeoffs: the NVIDIA lane carries no prompt caching, and the developer tier is a different service level from a vendor's production API.
3. **OpenRouter is the last resort,** kept only for a model with no direct route, no free NVIDIA route, and a reason to survive.

**Bound on this rule, so it does not become four new integrations.** Applied maximally it would justify wiring Mistral, Alibaba, MiniMax and Arcee as direct providers. It applies to models being KEPT, and a new provider integration is a decision rather than an automatic consequence.

### Verified against live provider lists, 2026-08-02

**DeepSeek direct serves exactly two models:** `deepseek-v4-flash` and `deepseek-v4-pro`. **DeepSeek R1 is not available direct**, and it is not on the NVIDIA endpoint either. By the rule above it therefore survives on OpenRouter, since there is no other route to it. Fred wants it kept: it remains highly rated for science and math and he values how it reasons.

### The cut: 25 of 44, all OpenRouter

| Category | Removed |
|---|---|
| Free-Thinking | Dolphin Mistral 24B, WizardLM-2 8x22B, Hermes 4 405B, Hermes 4 70B, Cydonia 24B v4.1 |
| Creative & Writing | Magnum v4 72B, Euryale 70B, Rocinante 12B, Skyfall 36B v2, UnslopNemo 12B, Tencent Hy3 |
| Frontier | Grok 4.20, MiniMax M2.5, Qwen3 235B |
| Coding | Codestral 25.08 |
| Reasoning | Qwen3 8B |
| Open & Trainable | Gemma 4 31B, Llama 4 Maverick, Mistral Nemo |
| Science & Technical | Mistral Small 3, Mistral Small 3.2 |
| Vision | Qwen3-VL 8B |
| Web / Research | Perplexity Sonar Pro |

**12 of the 26 OpenRouter models cannot call a tool at all**, so a large share of this cut removes models that were never usable in the Crucible.

### OpenRouter survivors (3)

`arcee-ai/trinity-large-thinking`, `qwen/qwen3-coder`, `deepseek/deepseek-r1`. **Fred kept all three on 2026-08-03**, including Qwen3 Coder after the live audit showed its context is 262,144 rather than the 1,000,000 the catalog claims and the 1M window had been the argument for it.

Fix the catalog's context figure as part of this phase. A number that is wrong by a factor of four drives real decisions: the context selector takes 58% of whatever the catalog says the window is, so a model claiming 1M gets handed roughly 564,000 tokens of history against a real ceiling of 262,144.

### Catalog id check: NO defects. An earlier claim in this document was wrong.

**Retracted 2026-08-03.** An earlier draft of this SOW, and the commit message on 0baeeab, claimed three NVIDIA catalog ids did not match the live endpoint and would throw at whoever selected them. **That was wrong**, and it was reached by comparing the catalog's `id` field against the endpoint's list without first checking whether a mapping layer existed. It does. Every NVIDIA entry carries a `directId` that is what actually goes on the wire:

| Catalog `id` | `directId` sent to NVIDIA | Live? |
|---|---|---|
| `minimax/minimax-m3` | `minimaxai/minimax-m3` | yes |
| `nvidia/nemotron-3-nano-omni-30b-a3b` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | yes |
| `nvidia/nemotron-3-super-120b-a12b:free` | `nvidia/nemotron-3-super-120b-a12b` | yes |

The internal `id` is deliberately the OpenRouter slug so a model falls back to OpenRouter unchanged when the NVIDIA key is absent, which is the resolve-at-call-time design from the 07-28 SOW working as intended. All three map correctly.

**The lesson is the one this document already preaches, applied to its own author:** the rule is not "check the list," it is "check the whole path." A comparison that skips a layer produces a confident wrong answer, which is exactly the failure Phase A exists to prevent.

**Genuine drift found by `tools_audit.mjs` against live provider lists (2026-08-03):**
- `qwen/qwen3-coder`: catalog says 1,000,000 context, live says **262,144**. This weakens the case for keeping it, since the 1M window was the argument (see survivors above).
- `qwen/qwen3-vl-8b-instruct`: catalog 128,000 vs live 262,144. Being cut anyway.
- `anthracite-org/magnum-v4-72b`, `thedrummer/unslopnemo-12b`: drift plus a tool-support undersell. Both being cut.

No dead ids across OpenRouter (337 live), OpenAI (131), Anthropic (11), or DeepSeek (2). **`anthropic/claude-opus-4-8` is real**, which resolves a doubt raised earlier in this session.

**The audit does not cover NVIDIA or Google at all.** That remains Phase A's job, and it is why the three ids above had to be checked by hand.

Pricing still needs verification: the catalog prices `nemotron-3-ultra-550b-a55b` and GLM 5.2 while marking other NVIDIA entries free. On the developer tier those figures may be wrong in Fred's favor.

### The model dropdown, redesigned

**Fred's complaint, 2026-08-02:** the text formatting "made it look really messy and amateur. It should be just as neat and professional as if we were creating a document."

Current state, one function builds every option:

```
optionLabel(m) -> "★ 🔧 DeepSeek V4 Pro · $0.43/$0.87 · 1M"
```

Four causes, all fixable:
1. **Emoji used as data columns.** The wrench, speech bubble and star render at different widths on every platform and are the first thing the eye lands on.
2. **Interpunct-separated values in a proportional font.** Nothing aligns vertically, so every row breaks in a different place. This is the main source of the mess.
3. **The label is assembled in two places.** `applyPrivacyFilter()` appends "key needed" and "blocked in x" afterward, so some rows run far longer than others.
4. **A native `<select>` cannot be made into a table** no matter what string is put in it.

**The fix.** Stop asking one string to be a table. The custom panel is where the design goes: the model name on its own line in a strong weight, then a quiet second line carrying provider, context, price and capability in aligned columns with tabular numerals so figures stack vertically. Capability becomes one of the SVG glyphs the app already ships rather than an emoji. Availability stops being appended text and becomes row state: dimmed, with a small tag. The native `<select>` keeps the name plus one qualifier only, because it is a keyboard and mobile fallback and does not need to carry everything.

### Remaining Phase 1 work
1. Sweep the dead Ollama transport out of `server.mjs`. Local Qwen is already gone from the catalog; this removes the machinery behind it. Note `wolfe-logic.mjs`'s EMBER comment still says "including local Qwen" and needs the same correction.
2. Add the NVIDIA lane properly. Per the 07-28 research, `integrate.api.nvidia.com` is an OpenAI-compatible rate-limited dev tier with no first-party production per-token API, so label it honestly and keep the cost-zeroing that already exists. Caching does not apply to these endpoints and the SOW should stop implying it might.
3. Add Google models via **AI Studio** (API key), decided by Fred 2026-08-02, "for now". Vertex stays available as a later migration if enterprise billing or higher quotas are ever needed; nothing in this build should hard-wire assumptions that make that migration expensive.
4. **Fallback map, non-optional.** Every saved preference pointing at a removed model must resolve at read time to a surviving model. Without it, users hit a dead reference on their next message. Free thinking models fall back to a surviving free model (the NVIDIA free endpoints).
5. **Redefine Auto.** It previously ran local Qwen. It needs an explicit new definition now that the local lane is gone.

**Wargame:** a removed model still referenced by an in-flight build job, not just a chat. The fallback map must be applied on the job resume path as well as the chat path.

---

## Phase 2. Finish caching

Sized by Phase 0's outcome. The provider plumbing is already in; what is missing is the discipline and the proof.

1. Apply the prefix stability doctrine for real across the supervised and tool loops, not just as written intent.
2. Evaluate Google's explicit context caching for the tool drawer specifically. It is the only provider mechanism that lets you deliberately store a block, set its lifetime, and pay storage to keep it warm, which is the closest thing to what Fred pictured. Verify current minimums and pricing live before designing around it.
3. Correct the record in-app and in docs: prompt caching is ephemeral everywhere. Nothing is permanent. OpenAI's `prompt_cache_key` (already sent) improves hit rate by steering repeats to the same machine and does not extend lifetime.
4. Guest economics: cache entries expire on a timer, so a one-message guest pays any write and never reads. Measure real guest session length before assuming caching helps that population.

---

## Phase 3. Sequential-thinking MCP, and paring Wolfe

The largest piece and the reason the rest of this exists. Fred, verbatim: Forge mode "does not work well on Dominion AI and after dozens of attempts to get it to work and fixes that you have made it still does not work well." No further retooling of the current design.

**Current state:** `wolfe-logic.mjs` is 66 KB in three tiers named for the forge. EMBER is a ~600 word always-on distillation wrapping every turn. FLAME loads the full axioms, reasoning protocol, cognitive engines, modes and guardrails. FURNACE loads the entire framework plus the Semantic Sphere. The dial is the tier selector, wired through `forgeFrameworkPrompt(wolfeTier)` at the system-prompt tail.

**Target state:**
1. Stand up the sequential-thinking MCP and make it the primary framework for app builds, heavy chat tasks, and IDE work. The connector launcher fix is live, so it can actually start, which was the prerequisite.
2. **EMBER stays as the always-on floor, unchanged.** It is the reason Dominion reasons like Fred rather than like a generic assistant, and it is cheap.
3. **FLAME and FURNACE are replaced,** not trimmed. Their job moves to the MCP.
4. **The forge dial is disabled, not removed** (Fred, 2026-08-02). The control comes out of the interface and stops affecting any call. The code stays in the tree, because Fred has not yet decided whether users should be able to override the automated setting, and re-enabling a dial that still exists is cheap while rebuilding a deleted one is not.

   **How it gets disabled matters.** Today's session lost time twice to code that described a state the system had left behind: the `google.mjs` comment about test users, and a leading hypothesis in the notes that outlived its own answer. Dormant code rots the same way. So: one named flag, off, in one place. A comment at that flag stating it is off by design, that the pending decision is user-override, and the date. A test asserting the dial has no effect on the assembled prompt while the flag is off, so nobody re-enables it by accident and nobody re-derives that it is live.
5. **Order is load-bearing:** the replacement must work before the removal, or depth is lost with nothing standing in for it.

**Named tension, resolved:** sequential thinking is slower and costs more per task by design. "Lighter and faster" and "sequential thinking" only coexist behind a gate, where simple work stays light and complexity above a threshold escalates. **The router decides by complexity** (Fred, 2026-08-02). The user does not pick, which is consistent with the dial being disabled: escalation is the system's judgment for now. The complexity signal, its threshold, and what the user is told when a task escalates are Phase 3 design work, and the threshold must be observable and tunable rather than buried as a magic number.

**Salvage from Fred's Wolfe-Builder document:** keep the build-discipline ideas (plan the full file list first with full paths, write one file at a time, verify each write with a tool call before counting it, run the build every few files, capture exact error text rather than a summary, report numeric progress, never say done without a verified check). Drop `pdf-to-text.js`, `FileUpload.jsx` and `wolfe-core.md` as redundant: the first two are already shipped better, and EMBER already is the lightweight Wolfe core that third file describes.

**The layer that discipline alone cannot reach.** Dominion's worst build failures were server-side, not prompt-side: `mv is not defined` killed every task-split build for roughly 30 hours, `verify()` never ran `npm install`, and the failure banner sourced from the newest job in the whole account so a fresh project inherited a stranger's verdict. Those are fixed. The lesson stands: this phase must verify the executor still does what the protocol claims, rather than assuming a better prompt covers it.

---

## Phase 4. Altana, the executive assistant (replaces the Guide)

**Name, set by Fred 2026-08-02: Altana.** That is the name in the app, in the interface, and in every user-facing string. Use it in code identifiers and CSS class names too, rather than a generic `assistant` prefix, so a future session cannot mistake it for scaffolding.

**The Guide is removed, not extended.** Fred, 2026-08-02: the interface was never implemented, nobody ever used it, and as designed it is not worth keeping. Its design was deliberately powerless (no tools, no code access, no secrets, answers only from `docs/GUIDE-KNOWLEDGE.md`, forbidden from acting) which is the exact opposite of what is wanted. One entity, not two.

**Model:** GPT-5.6 Luna, already in the catalog, no new integration.

**Hard constraint found by probe, 2026-08-03.** Luna cannot call tools through OpenAI's chat/completions endpoint. The provider's own words:

> Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to none.

Altana is defined by having hands, and its hands are the `toolbox.mjs` drawer, so this is load-bearing rather than a detail. **Two consequences.** First, Altana must route through `openairesponses.mjs`, which Dominion already uses for OpenAI, so the path exists and simply must not be bypassed. Second, there is a real tradeoff hiding in that error message: tools work either through the Responses API, or by setting `reasoning_effort` to none, which would strip the reasoning that makes Luna worth choosing. Take the Responses API, and pin it with a test, because "Altana silently lost its tools" is a failure that looks like the model being unhelpful rather than like a bug.

**Capabilities:**
- Broad awareness of app state, the user's work, their intent, available tools and settings.
- Advisory: where a control is, which model to pick and why, how the Crucible works.
- Agentive: can work the app's levers on the user's behalf.
- Hands: built on the existing `toolbox.mjs` drawer rather than beside it.

**Authority boundary (Fred's rule, 2026-08-02).** The assistant may change anything EXCEPT:
- Billing tied to the user's credit card, and budgets
- The user's personally identifiable information
- App secrets
- Dominion intellectual property

Everything else the user could flip on or off, the assistant may flip for them. One addition on top of Fred's rule: actions that are irreversible without being sensitive (deleting a project, discarding a build) get a confirmation step, because "not billing and not PII" is not the same as "safe to do twice."

**Context boundary.** Secrets and PII are kept out of the assistant's context at the assembly layer rather than by instructing the model to stay quiet about them. Anything in context is reachable. This is cheap now and an expensive retrofit later. All users are test users at present, so the leak stakes are low, but PII belongs to the user it describes rather than to Fred, so the boundary goes in from the start.

**Knowledge freshness.** Fred's requirement: every commit updates what the assistant can draw from. `GUIDE-KNOWLEDGE.md` already carries the same rule as human discipline ("update this file in the SAME commit"), which can rot silently. This phase makes it mechanical: a commit-time step regenerates the assistant's knowledge from the features index and doc set, and a check fails the build when a shipped change alters a guarantee without touching it.

**The floating dot.**
- Hovers above the screen, lightly visible, follows the user to every screen with no exceptions.
- **User-movable.** That is the point of floating; a default position that is wrong for one person is theirs to fix.
- Default position stays out of the way and is checked on every commit against what it might cover.
- **Known hazard:** there are roughly 50 `position: fixed` declarations across 17 stylesheets. A fixed element also stops floating the moment any ancestor carries a transform, filter or will-change, so the dot mounts at the document root outside every app container.
- **Known scar:** the app shipped with no navigation at all between 721px and 1180px for four days because two breakpoints disagreed. The dot's default position gets explicit checks at those widths.

---

## Phase 5. Google APIs as callable assistant tools

Callable on demand through the toolbox, never always-on, which is also what keeps them cacheable as a stable block.

**This build:**
- **Maps.** API key only, never touches the consent screen.
- **BigQuery.** Service account, never touches the consent screen. **Hard spend guard required,** not a soft one: an assistant that can issue queries bills per byte scanned and can spend real money fast.
- **People.** Rides the existing production consent screen. Being unverified costs cap headroom, which does not bind at current size. Note the collision with the assistant's PII boundary: People returns contacts, so its results are exactly the class of data Phase 4 keeps out of context. Rule: People results may be used to answer the turn and are excluded from any persisted assistant context.
- **Fix the stale `google.mjs` comment** that has cost multiple sessions.

**Deferred to a later build:** Google Ads and the wider marketing APIs. The blocker was never the consent screen; Ads needs a developer token with its own application and approval wait.

---

## Phase 6. Simplify My Chat

**Fred's order, 2026-08-02, from user feedback:** "There is an entire swath of the population that really only uses AI as a chatbot and search engine." They want a chat with no selections, no options, no long thought chains, and no decisions about tools or connectors.

### What it replaces, and why that is an upgrade

The Knowledge Vault comes out of the guest surface and a single **SIMPLIFY MY CHAT** button takes its place, in the hamburger menu on both desktop and mobile.

**Verified 2026-08-02, and the case is stronger than assumed.** The vault is injected into the sidebar by `dominion-cinematic.js` with **no role check at all**, so guests do see it. It is also not unwired: the code describes the three rail entries as opening "live, tenant-scoped data terminals." Tenant-scoped means a guest tapping Corporate Intelligence, Technology Archive, or Personal Playbook opens a real panel containing their own data, of which they have none. Today a guest is shown three impressive buttons that open three empty rooms.

### The interface

A separate chat experience, not a settings toggle on the existing one. No model picker, no mode selector, no tool or connector surface.

**Aesthetic: the Billy Goat Images look.** Black background, bright neon green container outlines and green text, CRT terminal feel, deliberately retro and simple. **The user picks the line and text color**, which exists only in this interface and is its one indulgence.

The abandoned project is at `F:\Claude Sandbox\Projects\BillyGoatImage`, and what survives there is a built Vite bundle rather than clean source. **Take the palette and the color-picker idea; rebuild the theme properly.** Extracting CSS from a bundle of an abandoned app is worse than writing it fresh against a four-line spec.

### Routing

The model is chosen per query. The user never sees a choice.

| Query class | Model | Lane |
|---|---|---|
| General chat (the default path) | `openai/gpt-oss-20b` | NVIDIA, free. **Needs `max_tokens` >= 1024, see below.** |
| Science and math | `deepseek/deepseek-r1` | OpenRouter, kept for this |
| Literary | `writer/palmyra-creative-122b` | NVIDIA, free |
| Creative | `deepseek/deepseek-v4-flash` | DeepSeek direct |
| Quick and dirty | `nvidia/nemotron-nano-12b-v2-vl` | NVIDIA |
| Personal, empathetic, high EQ | `meta/llama-3.3-70b-instruct` | NVIDIA |
| Theological and philosophical | `nvidia/llama-3.1-nemotron-70b-instruct` | NVIDIA |
| Business | `z-ai/glm-5.2` | NVIDIA |

### General chat: 20B, decided on the evidence

**Fred, 2026-08-03: "For chat, lets just wire the 20b version. It will be faster and better for that task."** That sidesteps the 120B timeout below entirely, and the 20B is already in the catalog with tools live-verified.

**It carries one hard requirement.** Probed 2026-08-03: `gpt-oss-20b` is a reasoning model that spends its output budget on hidden thinking before it says anything. At a 64-token ceiling it returns an empty string. It recovered at 512 in one run and 1024 in another, spending 351 and 387 tokens respectively and finishing cleanly both times.

**So the floor is not a preference, and it is not a fixed number either.** Two runs of the same probe gave two different recovery ceilings, which means the safe setting is a margin above the worst observed, not the observed value. **Set Simplify's general chat route to at least 1024 output tokens.** Dominion's fast mode caps output at 2,048, which clears it, so the danger is only if Simplify introduces a tighter cap for speed. It must not.

### Warning on the 120B, found in the catalog 2026-08-03

`models.catalog.mjs` carries this note from the Wave 2 free-fleet probe, verbatim:

> gpt-oss-120b timed out on the free tier; re-probe at the weekly audit.

**The model Fred chose to carry the highest-volume path in the app has already failed a live probe once.** The 20B sibling is in the catalog and marked tools-verified; the 120B is not in the catalog because it did not answer. Two possibilities: the free tier could not serve it then and the developer-program quota changes that, or it is simply slow. **Phase A re-probes it before Simplify commits to it**, and Phase 6 carries a named fallback for the default route rather than discovering the problem in front of users.

The same probe note also records that **`stepfun-ai/step-3.7-flash` was already probed and deliberately excluded**: it answered with tools, but undisclosed size and unclear specialty meant it brought nothing an existing seat lacked. It appears on the Phase A shortlist in this document and in the NVIDIA audit artifact. **Remove it.** It was rejected on evidence a week ago and I re-proposed it from the model list without checking the catalog's own history.

**The catalog already has a curation doctrine, and it is the one to follow:** a seat joins only by beating or matching an existing seat on some axis. That predates the picker-hygiene variable proposed in the NVIDIA audit document, and the audit's shortlist should be re-scored against it rather than against a parallel standard invented alongside it.

**Web search is not a route.** `web_search` already exists via SerpApi with `web_read` to pull a page in full, and the comment above it records Fred's original ask: search wired in so ANY model can look things up. Whichever model is answering calls the tool. No Perplexity integration, no new key, no new bill.

**Safety is not a route either.** `nvidia/nemotron-3.5-content-safety` is a classifier that labels and scores content. Sent a user's question it returns a category rather than an answer. It runs as a filter alongside every route.

**On the two 70B Llamas.** Fred's position, that they are separately fine tuned for their specialities, holds up on inspection: `meta/llama-3.3-70b-instruct` is Meta's own current release, and `nvidia/llama-3.1-nemotron-70b-instruct` is NVIDIA's tuned variant of the older 3.1 base. Different base version and a different tuner, so genuinely different animals. Phase A confirms they actually diverge on these two categories rather than assuming it from the naming.

### The two design risks

**1. Classification costs a call.** Eight buckets means something decides before anything answers, which adds latency and cost to every turn in the interface whose entire pitch is speed and simplicity. Solve with a cheap fast classifier or a heuristic pre-pass, never a full frontier model call.

**2. Tonal whiplash, which is the larger risk.** Switching models query by query changes the voice mid-conversation. For an audience that thinks of this as "the chatbot," an assistant whose personality shifts every message reads as broken rather than clever, and this interface gives them no controls to understand why.

**The answer already exists.** Wolfe EMBER wraps every turn on every model and the code describes it as what makes Dominion different from a generic assistant. In Simplify mode, EMBER plus a fixed persona fragment is what makes eight models sound like one assistant. This is existing machinery doing exactly the job the feature needs.

**Minimum escape hatch.** A quiet line naming what answered, and a one-tap "try this a different way" that never uses the word model.

### Sequencing, and why it cannot go early

**The Simplify auto-picker and the Phase 3 complexity gate are the same router.** One decides how hard to think, the other decides who should answer: same classifier, same signal, two outputs. Built twice they will disagree. So Simplify lands after Phase A supplies real model facts and alongside or just after Phase 3. Building it earlier means building the router twice.

### Open item: creative versus literary

Fred assigned Palmyra to literary on the strength of a one-line description in the NVIDIA audit doc calling it "a creative-writing specialist," and DeepSeek V4 Flash to creative on a recommendation from Gemini Pro. **Both are model assertions rather than measurements**, including the one in the audit doc, which was a guess from the model's name and its vendor's positioning and was flagged as such in that document's own caveats. Note also that V4 Flash is not free in Dominion: it is billed at $0.05 and $0.24 and is already the tenant default.

**Resolution: a head-to-head.** Give both models the same creative prompt and the same literary prompt, and let Fred pick. Creative work is a taste judgment, his taste is the one that matters, and this costs a few cents and settles it with evidence instead of two AIs asserting at each other.

---

## Standing constraint: limits stay generous, instrumentation ships first

**Fred's order, 2026-08-02:** leave context and per-turn token limits very generous for now, monitor real usage, and narrow later once several hundred turns from different users show how different tasks actually behave. This is cross-cutting rather than sequential, and its instrumentation ships in the first wave alongside Phases 0 and 1, because data not captured from day one cannot be recovered later.

**What the limits actually are today** (audited, so we are tuning real numbers rather than imagined ones):

| Limit | Current value | Where |
|---|---|---|
| History window as a share of the model's context | `fraction: 0.58` | `contextwindow.mjs` |
| Reserved headroom | `reservedTokens: 16_000` | `contextwindow.mjs` |
| Compaction share | `fraction: 0.52` | `contextwindow.mjs` |
| Message count ceiling | `maxMessages: 400` | `contextwindow.mjs` |
| Output cap, normal and tool modes | the model's native `maxOut`, no Dominion ceiling | `outLimitFor` |
| Output cap, fast mode | **2,048 tokens** | `outLimitFor` |

Output limits are already in decent shape and someone has fought this battle before: `model_execution_limits_test.mjs` asserts in so many words that "Normal mode must not impose a hidden Dominion output ceiling." Leave that test standing. The generosity work is on the context side, where roughly 42% of a selected model's window is currently never offered to history.

**The trap that makes "monitor and narrow later" fail.** If limits are raised and usage is logged, but the moment a turn *hits* a limit is not logged, the collected distribution is censored by the very caps being tuned. Several hundred turns later the data says nobody exceeded 400 messages, which is indistinguishable from turns having been silently clipped at 400. A naturally short turn and a starved turn look identical in a usage log that only records what got through.

So the instrumentation records the ceiling events, not just the consumption:

- `usedTokens`, `budgetTokens` and `omitted` per turn. **`selectHistoryWindow` already computes all three and appears to discard them.** Logging them is close to free.
- Whether compaction fired, and how many times in a job.
- `finish_reason === "length"`, meaning the model was cut off mid-answer. The wire already captures and normalizes `finishReason`; it needs to reach the usage record.
- Model, mode, role or tier, and task class (chat, build, IDE), so the narrowing can be per task rather than one global number.
- Whether the router escalated the turn to sequential thinking, once Phase 3 lands.

**Why this is not academic, and how it touches Phase 4.** Dominion has a recorded scar around GPT-5.x token starvation. The likely mechanism is that reasoning models spend the output budget on hidden reasoning before emitting any visible text, so a low output ceiling produces a turn that burns its whole allowance thinking and returns nothing. Fast mode's 2,048 token output cap is exactly the shape that causes it. **The executive assistant runs on GPT-5.6 Luna, a reasoning model, on short interactive turns**, which is the precise combination that scar describes. Phase 4 must not inherit fast mode's cap by default, and the starvation hypothesis should be tested against Luna directly before the assistant ships.

**Exit criterion for this section:** limits raised, every ceiling event recorded, and a usage record rich enough that a future session can answer "what does a build turn actually consume, versus a chat turn" without guessing. No narrowing happens in this build.

## Wargame

| # | Failure | Defense |
|---|---|---|
| W1 | Model prune breaks a user mid-build | Fallback map applied on both the chat path and the job-resume path; Auto explicitly redefined |
| W2 | Phase 0 turns out to be a probe artifact and time is spent hunting a defect that is not there | Delay-and-rerun control is step 1, before any code is read |
| W3 | FLAME/FURNACE removed before the MCP works, and reasoning depth is lost with nothing in its place | Replacement proven running before removal; EMBER untouched throughout |
| W4 | The assistant acts destructively inside its allowed zone | Confirmation step on irreversible-but-not-sensitive actions, on top of Fred's four exclusions |
| W5 | The assistant leaks a secret or PII | Redaction at context assembly, not by instruction. Nothing sensitive enters context to be leaked |
| W6 | The dot covers something important, or stops floating inside a transformed ancestor | Mounted at document root; default position checked per commit; explicit checks at 721px and 1180px; user can move it |
| W7 | Assistant knowledge silently rots as features ship | Commit-time regeneration plus a failing check, replacing the current human-discipline rule |
| W8 | BigQuery spend runs away through an assistant-issued query | Hard cost guard with a ceiling, not an advisory warning |
| W9 | Sequential thinking becomes the default for trivial work and the app gets heavier, the opposite of the goal | Router-side complexity gate with an observable, tunable threshold; measured against real runs before it ships |
| W11 | The disabled forge dial is later mistaken for live, or silently re-enabled | Single named flag, comment stating why it is off and what decision is pending, and a test asserting it has no effect while off |
| W12 | Several hundred turns are collected and the data cannot answer the narrowing question, because ceiling events were never recorded | Log `usedTokens`, `budgetTokens`, `omitted`, compaction count and `finish_reason: length` from the first wave, not just consumed tokens |
| W13 | Raising context generosity pushes long tasks past a provider's real window and turns a working build into a hard failure | Raise the share, keep reserved headroom proportional, and treat the model's published `ctx` as the hard wall rather than a target |
| W14 | The Luna assistant inherits fast mode's 2,048 output cap and burns its whole allowance on hidden reasoning, returning nothing | Phase 4 sets the assistant's output budget explicitly; the GPT-5.x starvation hypothesis is tested against Luna before ship |
| W15 | A model fact is written from recollection, reads plausibly, and is wrong. This is the failure mode Phase A exists to prevent | Live probe beats docs, docs beat recollection, recollection does not count. Every field sourced and dated; unverified means the model ships cold |
| W16 | A model passes the audit on id and context, then errors in a guest's face on system-prompt shape, tool format, or an output ceiling nobody checked | The per-model record covers call shape, tool shape and provider-imposed limits, and `fleet_probe` is extended to exercise a real two-round tool call rather than a single answer |
| W17 | Provider-imposed and Dominion-imposed limits stay conflated, so raising ours silently collides with theirs | Phase A separates the two in code before the limits instrumentation raises anything |
| W18 | A user in Simplify gets a bad route, cannot see why, and has no control to fix it | A quiet line naming what answered, plus one-tap "try this a different way" that never says the word model |
| W19 | Eight models in one conversation produce eight voices and the assistant reads as broken | EMBER plus a fixed persona fragment carries continuity across every route; verified by reading a multi-route transcript end to end before ship |
| W20 | The Simplify router and the Phase 3 complexity gate are built separately and disagree | One classifier, one signal, two outputs. Simplify cannot start before Phase 3's router exists |
| W21 | Removing the Knowledge Vault from guests also removes it from the owner and paid tiers | The vault is currently injected with no role check at all; the change is to ADD a role gate, not to delete the module |
| W10 | A concurrent session writes the same tree | One writer per worktree, standing rule. Re-check `origin/main` before every push |

---

## Lifecycle

Build in `Z:\Apps\minipc-chat\assistant-build-core` and its sibling worktrees, one per phase, one writer each. Merge to main when green, mirror to `C:\Users\rjfla\Documents\minipc-chat`, push to GitHub, verify the deploy actually happened. Six consecutive deploy failures means stop and alert Fred. Work stays on Z: after push; zip a copy to `G:\My Drive\Claude Archives\Worktree Snapshots`.

**Sequencing (revised 2026-08-02 on Fred's order):** **Phase A first and alone.** Nothing else starts until every shipped model has a complete dated record and has answered a live probe, because Phases 1, 2, 4 and the limits work all consume its output. Phase 0's fix and Phase 1 follow together, and the limits instrumentation rides with them. Phase 3 and Phase 4 come next in separate worktrees, in parallel. Phase 2 slots behind Phase 0's result. Phase 5 slots behind Phase 4, since the assistant is what calls those tools. **Phase 6 lands last**, because it consumes Phase A's model facts and shares Phase 3's router, and building it earlier means building that router twice.

---

## Decisions closed (Fred, 2026-08-02)

1. **Google model auth:** AI Studio, API key, "for now". Vertex remains a later option; do not hard-wire against it.
2. **Sequential-thinking trigger:** the router decides by complexity. The user does not pick.
3. **Forge dial:** disabled, code retained. Fred has not decided whether users may override the automated setting, so the option to re-enable stays open.

No open items block the build. The one item still pending Fred's judgment (user override of the automated setting) is deliberately deferred and does not gate any phase.

## Housekeeping found during the audit

- `iter/hard-rules` carries one unpushed commit, 51cffb8 ("A build that fixed nothing said it was done, then vanished"). It is ahead of `origin/main` and not on any remote. Not touched by this build; Fred's call whether it ships.
- Local `main` sits at 03bbc5e, well behind `origin/main` at 935062f. Cosmetic, but it makes `git log main` misleading.
