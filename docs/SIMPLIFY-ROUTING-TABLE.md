# Simplify My Chat: the routing table

**Date:** 2026-08-03. **Probed live against NVIDIA `integrate.api.nvidia.com` on the account key in the wallet.** Nothing here is from memory.

Fred named ten routes and the models he wanted on each. Four of his picks cannot serve. This document records what was measured, what replaced each failure, and why, so lane I builds against facts and Fred can overrule any substitution with one line.

---

## 1. WHAT WAS MEASURED

Probe: a short question, streamed, first-token latency recorded, 60 second timeout. First-token latency is the number that matters on a chatbot surface, because it is the whole wait a user sees.

| Fred's pick | Role | Verdict | Measurement |
|---|---|---|---|
| `writer/palmyra-creative-122b` | literary | **DEAD** | HTTP 404 `Function ... Not found for account` in 217ms |
| `nvidia/llama-3.1-nemotron-70b-instruct` | theological | **DEAD** | HTTP 404 `Not found for account` in 134ms |
| `meta/llama-3.3-70b-instruct` | empathetic | **TOO SLOW** | first token at **45,581ms**, total 47.5s |
| `meta/llama-3.1-405b-instruct` | creative | **NOT ON NVIDIA** | 404 page not found. It is absent from the 102-model list entirely |
| `nvidia/nemotron-3.5-content-safety` | safety | **ALIVE** | first token 167ms |
| `anthropic/claude-haiku-4-5` | chat | in roster | already a seat |
| `deepseek/deepseek-r1` | science and math | in roster | already a seat |
| `nvidia/nemotron-nano-12b-v2-vl` | quick and dirty | in roster | already a seat |
| `z-ai/glm-5.2` | business | in roster | already a seat |
| Perplexity | websearch | **NOT A SEAT** | Perplexity is not in the 25-model roster and is not an NVIDIA endpoint |

**The trap this re-confirms:** NVIDIA's `/v1/models` endpoint lists 102 models, and being on that list does NOT mean the account can invoke it. `palmyra-creative-122b` and `llama-3.1-nemotron-70b-instruct` are both listed and both refuse. So is `llama-3.1-nemotron-ultra-253b-v1` and `nemotron-4-340b-instruct`. The list is a catalog of what NVIDIA hosts, not a statement about this key.

## 2. SUBSTITUTES, ALSO MEASURED

| Candidate | Verdict | First token |
|---|---|---|
| `meta/llama-3.1-70b-instruct` | ALIVE | 238ms |
| `nvidia/nemotron-3-super-120b-a12b` | ALIVE | 365ms |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | ALIVE | 223ms |
| `nvidia/nemotron-3-nano-30b-a3b` | ALIVE | 256ms |
| `nvidia/llama-3.1-nemoguard-8b-content-safety` | ALIVE | 165ms |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | DEAD | not invokable on this account |
| `nvidia/nemotron-4-340b-instruct` | DEAD | not invokable on this account |

## 3. THE TABLE LANE I BUILDS

| Route | Model | Status | Why |
|---|---|---|---|
| chat | `anthropic/claude-haiku-4-5` | Fred's pick, stands | Fast, cheap, kept off training data |
| science and math | `deepseek/deepseek-r1` | Fred's pick, stands | Fred values how it reasons and wants it kept |
| quick and dirty | `nvidia/nemotron-nano-12b-v2-vl` | Fred's pick, stands | Small, fast, free |
| business | `z-ai/glm-5.2` | Fred's pick, stands | Long-horizon planning, free via NVIDIA |
| safety | `nvidia/nemotron-3.5-content-safety` | Fred's pick, stands | Measured alive at 167ms |
| **empathetic** | `meta/llama-3.1-70b-instruct` | **SUBSTITUTED** | Fred asked for "meta llama 70b". The 3.3 generation takes 45 seconds to say anything, which no chatbot surface can carry. The 3.1 generation of the same size answers in 238ms and keeps his intent |
| **literary** | `arcee-ai/trinity-large-thinking` | **SUBSTITUTED** | Palmyra is not invokable on this account. Trinity is already a roster seat labeled for expressive creative writing and is the model behind Fred's own Trinity work |
| **creative** | `arcee-ai/trinity-large-thinking` | **SUBSTITUTED** | Llama 3.1 405B does not exist on NVIDIA. Creative and literary collapse into one route rather than inventing a distinction the roster cannot serve |
| **theological and philosophical** | `nvidia/nemotron-3-super-120b-a12b:free` | **SUBSTITUTED** | Fred's Nemotron 70B pick is not invokable. This is the largest FREE seat in the roster, 1M context, measured alive at 365ms |
| **websearch** | roster model plus the existing search tool | **REDESIGNED** | Perplexity is not a seat and adding one is out of scope for this wave. Search is a TOOL rather than a model, so this route picks a fast roster model and turns the app's existing web search on. Lane I verifies what search machinery exists before building |

## 4. WHAT FRED MAY WANT TO OVERRULE

Each of these is a one-line change:

1. **Creative and literary share a seat.** If he wants them separate, the roster needs a second creative model, which means adding a seat rather than routing to one.
2. **The empathetic route drops a generation** to keep the same model family and size. The alternative is a Claude seat, which is better at emotional register and costs money on a route meant to be cheap.
3. **Search as a tool rather than a Perplexity seat.** Adding Perplexity is a provider integration, not a routing change, and it was never in the wave's scope.

## 5. LEDGER

| # | Item | State |
|---|---|---|
| S1 | Whether Fred accepts creative and literary sharing one seat | `[open]`, needs Fred |
| S2 | Whether the websearch route should become a real Perplexity integration later | `[open]`, deferred, out of wave scope |
| S3 | Four NVIDIA models are listed and not invokable on this account. Whether that is a tier limit or a per-model entitlement is unknown | `[unknown]`, does not block this wave |
