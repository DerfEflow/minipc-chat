# BATTALION SOW (ARSENAL Wave 6): architecture draft
**Date:** 2026-07-28. **Fred's copy, verbatim, no quality qualifier:** BATTALION, "a handpicked swarm of AI models to do more work in less time- for free."
**Blast radius:** HIGH at ship time (a new execution mode on the main chat path, guest-reachable). Full FITS when the wave starts; this document is the architecture it starts from.

**Mission line:** Picking BATTALION in the chat dropdown puts a handpicked free swarm on the job: complex work gets split, worked in parallel, and synthesized into one finished answer, and the whole run bills $0.

## Where it lives
A `model` choice in the chat dropdown (beside the catalog models), rendered with Fred's line as its description. Server-side it is an EXECUTION MODE, not a model id: `model: "battalion"` routes to the swarm orchestrator instead of one engine. Owner and tenants alike (it spends nothing), still behind the normal walls.

## The swarm, drawn
1. **Assess (free, fast).** A light free model classifies the turn: simple (one engine answers), complex (split it), or long-form (relay it). The catalog's router heuristics feed it; "when appropriate" is this gate, so a two-line question never convenes a war council.
2. **Split.** For complex turns the orchestrator seat (a 200B+ free seat, e.g. Nemotron 3 Ultra via the free lane; the existing idetasks divider machinery does the splitting) writes a task roadmap with file/section collision safety, exactly the spine the Crucible already trusts.
3. **Swarm.** Parallel free seats work the parts: Nemotron Ultra/Super for reasoning, free Qwen/DeepSeek coder seats for code, long-context free seats for big documents. Each part runs under the supervised-continuation discipline that already governs chat turns (loop watch, budget gate, checkpoint honesty). Prompt caching keeps shared context nearly free on paid fallbacks, and the free lanes bill nothing regardless.
4. **Synthesize.** One strong free seat merges parts into a single voice, resolves overlaps, and writes the final answer. Long-form coding: parts are files/modules; the synthesizer assembles and reconciles interfaces.
5. **Report honestly.** The done event carries the battalion manifest: which models worked, how many parts, wall time, $0. The UI can show "6 models, 9 minutes, free" because that line IS the product.

## Handpicked means handpicked
A BATTALION_ROSTER in models.catalog.mjs (same discipline as the Wildfire roster): free seats only, each admitted by live probe (tools, context, output quality on a fixed bench), reviewed at the weekly audit. The roster is the "handpicked" in Fred's sentence; no model rides in because it is merely free.

## Fallbacks and honesty
- A free seat that fails mid-part is replaced from the roster, announced in the manifest (never silent).
- If NVIDIA's lane is down entirely, BATTALION says so and offers the user's normal model instead. It never quietly bills a paid swarm.
- Rate limits: parts queue rather than die; the manifest shows queue time. If Fred's "extremely generous" limits ever pinch, the assess gate narrows what convenes a swarm.

## What it reuses (nothing invented twice)
- idetasks: roadmap, collision map, reduction verdicts.
- Supervised continuation loop + budget guard (the guard sees $0 but still fences runaway rounds).
- Transport-aware cost math (1917d24): free lane = $0 on the meter, receipts stay true.
- The Agent Army UI patterns later, if BATTALION earns a visible staffing view; v1 is dropdown-simple.

## Dependencies
Wave 2 (Free Fleet) must land first: the roster is drawn from it. Wave 5 (Retriever) sharpens long-context splitting but does not block v1.

## Open questions (answered at wave start, not now)
1. Does BATTALION appear for credit tenants from day one, or owner-first for a shakedown week?
2. Manifest UI: one summary line in chat, or a full expandable crew panel?
3. Long-form ceiling: how large a deliverable before BATTALION checkpoints and continues (tie to session budget windows even at $0, for time honesty)?
