# Dominion AI — Cloud Migration Plan

Source-of-truth for moving Dominion off the mini-PC + Tailscale bridge and onto
cloud infrastructure. Written to survive session/environment moves — pick up here.

Status: **planning complete, Phase 1 not yet started.**

---

## 1. Goals & principles

- **Kill the bridge.** The mini-PC + `tailscale serve` bridge is unreliable. The app moves to
  an always-on public host.
- **Railway is the horse.** `server.mjs` + the PWA run on Railway with a public HTTPS URL. This is
  where the "brain" always lives: routing, tools, memory, artifacts, the agent loop.
- **Bring your own GPU model.** A cloud GPU runs models of Fred's choice, plugged into the existing
  `OLLAMA_URL` seam. No Tailscale anywhere in the AI project (Fred still uses Tailscale for his
  personal PCs — that stays separate).
- **Keep the logic identical.** No rewrite of `server.mjs` behavior. We only change *where things
  bind/connect* and *how state is persisted*.
- **Cost-aware from day one.** Heavy GPU is on-demand, never always-on. Light/router/memory traffic
  runs on a cheap always-on tier. Users see a cost estimate before sending.
- **Training-aware.** The ultimate goal is to train a model. Every decision keeps the conversation/
  memory/review corpus capturable and (eventually) queryable for dataset assembly.

---

## 2. Target architecture

```
                    ┌───────────────────── Railway (the horse) ──────────────────────┐
   Phone PWA        │  server.mjs · serves public/ · /chat agent loop · tools ·        │
  (installed) ─────▶│  memory / artifacts / persona / flywheel · router + model picker │
   public HTTPS     │        │                                    │                     │
                    │        │ picker → light/heavy (Ollama)      │ picker → cloud      │
                    │        ▼ OLLAMA_LIGHT_URL / OLLAMA_HEAVY_URL ▼ PROVIDER_CFG + keys │
                    │   (+ persistent Volume at /data for state)                        │
                    └────────┼────────────────────────────────────┼─────────────────────┘
                             │ HTTPS + bearer                      │ HTTPS
                 ┌───────────┴───────────────┐                     ▼
                 │  Cloud GPU (Thunder Comp.) │        OpenRouter / OpenAI / DeepSeek
                 │  Caddy (auto-TLS + token)  │
                 │   ├▶ LIGHT: gemma3 (always-on, cheap tier)
                 │   ├▶ HEAVY: deepseek-r1:32b (on-demand, spun up per batch)
                 │   └▶ EMBED: nomic-embed-text
                 └────────────────────────────┘
```

**Model picker semantics.** "Railway vs GPU" isn't two models — Railway is where the brain always
runs. The picker chooses the **inference backend**:
- **Your GPU** (self-hosted light/heavy Ollama models), or
- **Cloud providers** (OpenRouter / OpenAI / DeepSeek), billed from Railway.

Both paths already exist in the code. We repoint the seams; we don't invent routing.

---

## 3. The two seams we repoint

| Seam | Today | After |
|---|---|---|
| Local inference | `ollamaChat()` → `OLLAMA_URL` = `127.0.0.1:11434` (mini-PC Ollama) | → cloud GPU Ollama (light + heavy), HTTPS + bearer |
| Cloud inference | `PROVIDER_CFG` → OpenRouter/OpenAI/DeepSeek | unchanged (runs from Railway) |

Internal reasoning (route classifier, memory "convictions" pass, review engine, conversation
map-reduce) all go through `LIGHT_MODEL`/`MAIN_MODEL` via `ollamaChat()` — so those also land on the
GPU tier, not just user turns. This is why the light tier must be cheap-always-on.

---

## 4. Backends

### 4a. Railway — `server.mjs` + PWA
- Runs the exact same server. Serves the cinematic UI from `public/`.
- Public `*.up.railway.app` (or custom domain). **Bridge is gone.**
- **Persistent Volume** mounted at `/data` holds all server-side state (see §7).
- No npm dependencies — the app uses only Node built-ins + local `.mjs`. Packaging is trivial
  (add a tiny `package.json` + `Dockerfile`).

### 4b. Cloud GPU — Thunder Compute (inference now)
- **Heavy:** `deepseek-r1:32b` (Qwen-distilled). NOTE: full DeepSeek R1 is 671B and will **not**
  fit an 80 GB card — the 32B distill is the right target and fits comfortably.
- **Light:** `gemma3` (~8–12B) for the constant router/memory/internal traffic.
- **Embeddings:** `nomic-embed-text` (already the `EMBED_MODEL` default) so memory vector search
  keeps working.
- Runs **Ollama** in Docker (native API match — see §5), behind **Caddy** for automatic HTTPS +
  a bearer token. Ollama has no auth of its own; never expose it raw.
- Thunder Compute's cheap virtualized GPU (~$1.90/hr for an 80 GB card) is great for inference.
  Revisit host choice for **training** later (dedicated GPUs + fast local NVMe + multi-GPU) — likely
  a different provider; don't over-buy for training now.

### 4c. Cloud providers — unchanged
- OpenRouter / OpenAI / DeepSeek keep serving the paid picker options, now billed from Railway.

### Why Ollama on the GPU (not vLLM)
`ollamaChat()` and the `/ollama` proxy speak Ollama's **native API** (`/api/chat`, `/api/embed`,
`keep_alive`, `format`, `think`, `num_predict`). Running Ollama makes the GPU a drop-in for the
existing seam — chat, embeddings, and the picker's auto-populated model list (`/ollama/api/tags`)
all just work. vLLM is faster but OpenAI-shaped and chat-only (embeddings would break). Recommend
Ollama to honor "keep the logic the same."

---

## 5. Heavy/Light split + on-demand GPU lifecycle (the cost strategy)

Goal: **never pay for an always-on 80 GB GPU.** An always-on 80 GB box at $1.90/hr ≈ **$1,370/mo**.

Design:
- **Light tier** (`gemma3` + `nomic-embed-text`): small, cheap, **always on**. Handles the router
  call that fires on ~every message, plus memory embeddings. Baseline cost is pennies/hr.
- **Heavy tier** (`deepseek-r1:32b`): **on-demand**. Spun up when a heavy-tier turn arrives (the
  router already decides tier *before* generating), kept warm for a short idle window, then stopped.
- **Batching:** heavy tasks can pool and run together on **one warm window** instead of paying a
  cold start per task (see §6 cost math).

### Required code change for the split
`LIGHT_MODEL` and `MAIN_MODEL` currently share **one** `OLLAMA_URL` (`ollamaChat` uses a single
`ou` URL for every model). To put light and heavy on **separate hosts/endpoints**, route by model:

- Add `OLLAMA_LIGHT_URL` (always-on tier) and `OLLAMA_HEAVY_URL` (on-demand tier). Keep `OLLAMA_URL`
  as a fallback/alias for light.
- In `ollamaChat()` (`server.mjs:543`) and `proxy()` (`server.mjs:163`), pick the endpoint by model:
  heavy tag / `=== MAIN_MODEL` → heavy URL, else light URL.
- Heavy path: before the request, ensure the heavy box is **warm** (call Thunder Compute
  start API, poll readiness); on idle, auto-stop.

Alternative: one gateway (Caddy) behind a single `OLLAMA_URL` that fans out by model name and owns
spin-up. Simpler `server.mjs`, but the gateway then owns lifecycle. **Recommended: route in
`ollamaChat` (server is already tier-aware pre-generation), so the on-demand logic lives where the
routing decision already happens.**

---

## 6. Cost visibility — know the cost *before* you send

You already compute exact cost **after** each turn: `models.catalog.mjs` carries per-1M
input/output prices; `server.mjs:440` has `estTokens()`; every turn logs
`promptTokens/outputTokens/costUsd` to `usage.jsonl` (`:400`, `:437`, `:1742`) and ships `costUsd` in
the `done` SSE event, deriving it from catalog prices for direct providers and OpenRouter's reported
cost otherwise. A pre-send estimate is the **same math run forward**.

### Cloud models — real dollar estimate
```
est = estTokens(prompt + retrieved context) × price_in
    + est_output_tokens                     × price_out    (from models.catalog)
```
Only fuzzy variable is output length → key an output band off the router mode
(`fast`→~150 tok, `normal`→~600, `deep_think`/`draft`→~1.5–3k) and show a **range**.

### GPU — it's a *time* estimate, not a token price
```
seconds ≈ est_output_tokens ÷ throughput      (R1-32B on 80 GB ≈ 30–50 tok/s)
$        ≈ seconds × ($1.90 / 3600) ≈ $0.00053/s
```
Worked example — a heavy turn, ~3k output tokens on R1-32B:
- warm generation ≈ 3000 ÷ 40 ≈ **75 s ≈ $0.04**
- cold start (boot + load ~20 GB model) ≈ 60–120 s ≈ +$0.03–0.06
- idle-before-auto-stop (~5 min) ≈ +$0.16

⇒ one **cold** heavy task all-in ≈ **~$0.25**; ten heavy tasks in one **warm** session ≈ **~$0.04
each** + one ~$0.16 window. **The task is pennies; the up-time window is the real cost → batch heavy
work.**

### The feature: `/estimate` preflight + composer chip
Add a preflight endpoint that runs only the deterministic bits (no model call):
`heuristicRoute` + `estTokens` + catalog price + "is the heavy GPU warm right now?". Returns e.g.:
```json
{ "backend": "gpu-heavy", "tier": "deep_think",
  "tokensIn": 3180, "outRange": [1500, 3000],
  "warm": false, "estCost": "≈ $0.20–0.28 (incl. cold start)",
  "estLatency": "~2 min (spinning up GPU)" }
```
Surface as a live chip under the composer; for heavy turns, turn Send into a confirm:
> ⚡ Heavy task → needs the R1 box (cold). **≈ $0.24, ~2 min.** **[Run now] · [Queue for batch]**

`[Queue for batch]` pools heavy tasks so they run on one warm window. `usage.jsonl` provides
ground-truth per-turn tokens+cost to **self-calibrate** the estimator and show **running spend**
(today / this session) in the telemetry rail that already exists.

---

## 7. State & persistence

- **Live chats** are in the browser's `localStorage` (`dominion.chats.v1`) — they ride on the phone,
  nothing to migrate.
- **Server-side state** is file-based and already env-driven (proven in `chatjobs_test.mjs`). Point
  each dir at the Railway Volume:

| Env | Default (Windows) | Railway |
|---|---|---|
| `MEMORY_DIR` | `C:\minipc-chat\memory` | `/data/memory` |
| `CHATLOG_DIR` | `C:\minipc-chat\chatlog` | `/data/chatlog` |
| `ARTIFACT_DIR` | `C:\minipc-chat\artifacts` | `/data/artifacts` |
| `PERSONA_DIR` | `C:\minipc-chat\corpus` | `/data/corpus` |
| `PERSONA_STAGING` | (staging) | `/data/staging` |
| `FLYWHEEL_DIR` | `C:\minipc-chat\flywheel` | `/data/flywheel` |
| `LOG_DIR` | `logs` | `/data/logs` |
| `SANDBOX_DIR` | `C:\minipc-chat\sandbox` | `/data/sandbox` |

### Volume vs Supabase — decision
**Start on the Railway Volume; move the corpus to Supabase when training-data assembly begins.**

| | Railway Volume | Supabase |
|---|---|---|
| What | Block disk at `/data`; plain files | Managed Postgres (+ S3-style storage) |
| Code changes | **None** (already file-based) | Rewrite stores → SQL/Storage |
| Cost (a few GB) | ~$1/mo on top of compute | Free tier auto-pauses when idle → realistically Pro **$25/mo** |
| Queryable | No (opaque files) | **Yes** |
| Multi-service | Single-writer, one region | Any service (app + future training jobs) |

Rationale: the training corpus is already captured server-side (`chatlog.mjs` transcripts,
`memory.json`, persona corpus, review/flywheel ledger). On a Volume that's a pile of JSON; in
Supabase it's **queryable Postgres** → filtering/labeling/dedup/export for fine-tuning sets becomes
trivial, and a training job can read it without touching the app. Supabase's value is *making data
trainable*, not storage cost. Pay the $25 when data collection becomes the point; until then the
Volume ships faster for ~$1.

---

## 8. Required code changes (surgical — no logic rewrite)

1. **Bind `0.0.0.0`** — `server.mjs:2027` does `server.listen(PORT, "127.0.0.1")`. Railway needs
   `0.0.0.0` and its injected `PORT`. (1 line: `process.env.HOST || "0.0.0.0"`.)
2. **HTTPS + auth + per-model routing on the Ollama seam** — `ollamaChat()` (`:543`) and `proxy()`
   (`:163`) hardcode the `http` module and `port || 80`, no auth. Add: choose `https` vs `http`
   from the URL protocol, default 443, inject `Authorization: Bearer $OLLAMA_KEY` when set, and
   pick light-vs-heavy endpoint by model (§5).
3. **Packaging** — add a minimal `package.json` (`"start": "node server.mjs"`, Node version pin) +
   a small `Dockerfile`. No dependency install needed.
4. **State dirs → Volume** — set the §7 env vars on Railway. No code change.
5. **Cosmetic / guards** — set `OPENROUTER_REFERER` to the Railway URL; the mini-PC-only bits
   (watchdog Windows tasks, `/bridge/poke`, forge SSH tools in `machines.mjs`) are `try/catch`-guarded
   and no-op on Linux — ship them inert (see §11 MCP phase to restore "hands" in the cloud).
6. **GPU lifecycle hook** — heavy-tier turns call Thunder Compute start/stop; gate on warm; auto-stop
   on idle (§5).
7. **`/estimate` preflight endpoint + composer cost chip** (§6).

---

## 9. Security & transport

- **HTTPS + bearer token** between Railway ↔ GPU. Caddy terminates TLS and checks the token;
  Ollama stays private behind it. **No Tailscale in the AI project.**
- All secrets are Railway env vars (the config reads `process.env` first, so no `.env` file needed;
  the Windows `.env`/bridge `.env` reads simply no-op).

---

## 10. Environment variable matrix (Railway)

| Var | Value / note |
|---|---|
| `PORT` | injected by Railway |
| `HOST` | `0.0.0.0` (or code default) |
| `OLLAMA_LIGHT_URL` | `https://<gpu-light>/` (always-on tier) — new |
| `OLLAMA_HEAVY_URL` | `https://<gpu-heavy>/` (on-demand tier) — new |
| `OLLAMA_KEY` | bearer token for the Ollama gateway — new |
| `LIGHT_MODEL` | `gemma3` (was `qwen3:8b`) |
| `MAIN_MODEL` | `deepseek-r1:32b` (was `qwen3:30b-a3b`) |
| `EMBED_MODEL` | `nomic-embed-text` (already default) |
| `OPENROUTER_API_KEY` | cloud provider |
| `OPEN_AI_DOMINION_UI_APIKEY` | OpenAI direct + voice |
| `DEEPSEEK_AI_DOMINION_UI_APIKEY` | DeepSeek direct |
| `OPENROUTER_REFERER` | Railway URL |
| `SERP_API_KEY` | web_search tool |
| `MEMORY_DIR` … `SANDBOX_DIR` | `/data/...` per §7 |

Tuning note: `MAIN_MODEL` is used for many strict-JSON internal passes (convictions,
conversation map-reduce). R1 is a *reasoning* model and fights rigid JSON. Consider wiring R1 as a
user-pickable "heavy" while keeping a non-reasoning 32B as the internal `MAIN_MODEL` workhorse.
Decide during Phase 3 tuning.

---

## 11. Rollout phases

1. **Railway up, cloud-models-only.** Deploy `server.mjs` (0.0.0.0 bind, `package.json`+`Dockerfile`,
   Volume-pathed state), provider keys set, `OLLAMA_*` unset. Proves the interface + tools + memory
   in the cloud with the bridge gone. **← start here; needs no GPU.**
2. **Stand up the GPU.** Thunder Compute + Ollama + Caddy + token; `ollama pull deepseek-r1:32b`,
   `gemma3`, `nomic-embed-text`. Light tier always-on; heavy tier start/stop API wired.
3. **Wire the seam + tuning.** Set `OLLAMA_LIGHT_URL`/`OLLAMA_HEAVY_URL`/`OLLAMA_KEY`; per-model
   routing + HTTPS/bearer patch; tune LIGHT/MAIN model choices.
4. **Cost UX.** `/estimate` endpoint + composer chip + batch-queue + running spend.
5. **Cutover.** Custom domain; reopen the PWA (network-first SW pulls fresh); retire the mini-PC.
6. **MCP phase (later).** Restore forge/deck "hands" in the cloud via an MCP tool server (replaces
   the Tailscale/SSH tool transport).
7. **Training era (future).** Dedicated training host; corpus → Supabase/object storage; dataset
   export + checkpoint storage.

---

## 12. Settled decisions (log)

- Host: **Thunder Compute** for inference now; revisit for training.
- Transport: **HTTPS + bearer**; Tailscale stays out of the AI project.
- Models: **`deepseek-r1:32b`** (heavy) + **`gemma3`** (light) + **`nomic-embed-text`** (embed).
- Storage: **Railway Volume now → Supabase when training-data assembly starts.**
- GPU: **heavy on-demand, light cheap-always-on; batch heavy work.**
- Cost UX: **pre-send `/estimate` chip + running spend.**
- MCP / forge tools: **ship inert now; MCP phase later.**
- Ultimate goal: **train a model** — keep the corpus capturable + queryable.

---

## 13. Open items to confirm before/while building

- Exact heavy-tier idle window before auto-stop (cost vs latency trade).
- Whether internal `MAIN_MODEL` JSON passes use R1 or a non-reasoning 32B (§10 tuning note).
- Thunder Compute start/stop API shape for the lifecycle hook.
- Custom domain choice for the final cutover.
