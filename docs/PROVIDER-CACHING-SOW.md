# Direct Providers + Active Prompt Caching SOW
**Date:** 2026-07-28. **Fred's order:** "wire in an Nvidia API and a kimi and deepseek API, so I can take advantage of prompt caching actively on every call." Triggered by a single Nemotron research turn costing $2.79 (supervised loop re-billing full context every round, zero cache hits).

**Mission line:** Every Dominion call runs on the cheapest correct wire: direct NVIDIA, Moonshot, and DeepSeek APIs with prompt caching actually hitting on multi-round work, proven by cache counters.

## Research, locked 2026-07-28
- **Moonshot (Kimi):** api.moonshot.ai/v1, OpenAI-compatible. Caching is AUTOMATIC (Mooncake architecture): unchanged prefixes over 256 tokens hit at $0.30/M vs $3.00/M fresh (K3); no cache IDs, no TTL management, no write fee. Reported hit rates 90%+ on agent workloads. Direct ids: kimi-k3 (verified in docs); k2.6 id to verify at key time.
- **NVIDIA:** no first-party production per-token API found; integrate.api.nvidia.com is an OpenAI-compatible DEV tier (rate-limited). Nemotron production serving is third-party (DeepInfra/Baseten/etc. behind OpenRouter). Wire the lane behind NVIDIA_KEY with honest labeling; verify pricing/caching live when Fred mints a key. Until then Nemotron stays on OpenRouter.
- **DeepSeek:** ALREADY direct in production; caching is automatic server-side with hit tokens reported as prompt_cache_hit_tokens. Observed zero hits on 2026-07-19 means OUR prompt assembly breaks the prefix. Finding that defect is the highest-value item in this build: it pays on DeepSeek today and on Moonshot the moment its key lands.

## Design decisions
1. **Resolve-at-call-time provider routing.** A model whose direct provider key is ABSENT routes through OpenRouter exactly as today. Key lands in Railway env -> calls flip to direct automatically. Production never breaks while keys are pending; no model shows "needs a provider key" for a model that used to work.
2. **Prefix stability doctrine (all providers).** Within a supervised/tool loop, every round's request must be a byte-stable prefix extension of the previous round: system prompt frozen at round 0 (no timestamps finer than the day, no per-round ids), tool definitions in stable order, history append-only between compactions. Compaction resets the cache once per epoch, which is the accepted cost.
3. **Cache-aware cost math.** Catalog gains cacheHitCost per model (real provider numbers). The catalog-derived cost path bills cached tokens at hit price; provider-reported dollar costs still win when present. Cache totals already counted in bumpUsage ride usage.jsonl and the done-event.
4. **Live proof before ship.** A real two-round call against deepseek-v4-flash (key in wallet) must show prompt_cache_hit_tokens > 0 on round two. No proof, no merge.

## Wargame
| # | Failure | Defense |
|---|---------|---------|
| W1 | Direct wiring breaks a model that worked via OpenRouter | key-present resolution; absent key = old path, byte-identical |
| W2 | Moonshot/NVIDIA direct ids differ from OpenRouter slugs | directId per model, verified live at key time; until verified, lane stays cold |
| W3 | Prefix fix regresses prompt content | tests assert assembled messages byte-equal across rounds except appended tail |
| W4 | Cache math undercharges credit users when provider omits hit counts | hit pricing applies ONLY to counted cache tokens; uncounted = full freight (conservative) |
| W5 | Merge conflict with the parallel session's uncommitted server.mjs work | worktree branches from clean 03bbc5e; merge is a human-reviewed step at ship time |

## Lifecycle (Fred's standing order, 2026-07-28)
Build in Z:\Apps\minipc-chat\provider-caching (this worktree). Merge to main when green, mirror to C:\Users\rjfla\Documents\minipc-chat (local repo backup, authorized exception), push to GitHub, verify deployment; six consecutive deploy failures = stop and alert Fred.

## Open items for Fred
1. Mint a Moonshot API key (platform.moonshot.ai) -> Railway env MOONSHOT_KEY.
2. Decide on NVIDIA: dev-tier key now (rate limits) or wait for a production story.
