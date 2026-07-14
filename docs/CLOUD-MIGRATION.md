# Dominion AI — Cloud Migration Plan

Source-of-truth for moving Dominion off the mini-PC + Tailscale bridge and onto
cloud infrastructure. Written to survive session/environment moves — pick up here.

Status: **code complete for Phases 1, 3 & 4. The Thunder Compute GPU was stood up, verified, then
REJECTED ON COST and deleted (2026-07-14): no start/stop API means paying to idle. The brain is
provider APIs for Normal/Trusted plus the mini-PC Qwen for Private mode. §4b/§5 and the GPU parts
of §14 are kept as a rebuild recipe only. Superseding decisions (Fred, 2026-07-14): Tailscale IS
allowed in the AI project, scoped narrowly to reaching the mini-PC Qwen and to update/deploy access;
hands move via dial-out MCP tool servers per `ACCESS-AND-PRIVACY-DESIGN.md`; the dominion-cinematic
UI is the blessed baseline. See §14 build log.**

---

## 1. Goals & principles

- **Kill the bridge.** The mini-PC + `tailscale serve` bridge is unreliable. The app moves to
  an always-on public host.
- **Railway is the horse.** `server.mjs` + the PWA run on Railway with a public HTTPS URL. This is
  where the "brain" always lives: routing, tools, memory, artifacts, the agent loop.
- **Bring your own GPU model.** *(SUPERSEDED 2026-07-14: the paid cloud GPU was rejected on cost.
  The `OLLAMA_URL` seam survives and points at the mini-PC Qwen over the tailnet instead. Tailscale
  is allowed in the AI project for exactly two things: reaching the mini-PC Qwen, and update/deploy
  access. Nothing else rides the tailnet; the hands use dial-out MCP tool servers.)*
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
  Ollama stays private behind it. *(SUPERSEDED 2026-07-14: no cloud GPU. Railway reaches the
  mini-PC Qwen over the tailnet — the container joins with an auth key, Ollama binds the tailnet
  interface, per ledger L-016. Tailscale is scoped to Qwen access + updates only.)*
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

*(Entries struck below were superseded on 2026-07-14; the replacements are in
`ACCESS-AND-PRIVACY-DESIGN.md` and `BUILD-HANDOFF.md`.)*

- ~~Host: **Thunder Compute** for inference now~~ → **no paid GPU; provider APIs + mini-PC Qwen.**
- ~~Transport: **HTTPS + bearer**; Tailscale stays out of the AI project~~ → **Tailscale allowed,
  scoped to Qwen access + updates only; hands via dial-out MCP tool servers.**
- ~~Models: `deepseek-r1:32b` (heavy) + `gemma3` (light)~~ → **provider APIs for Normal/Trusted;
  `qwen3:8b`/`qwen3:30b-a3b` on the mini-PC for Private.**
- Storage: **Railway Volume now → Supabase when training-data assembly starts.**
- Cost UX: **pre-send `/estimate` chip + running spend.**
- Hands: **MCP tool server per machine, dial-out, carve-outs verbatim (Phase 1 of the build plan).**
- UI: **the dominion-cinematic version is the blessed baseline (Fred, 2026-07-14).** The frozen-UI
  rule now reads: frozen at this baseline; any further `public/` diff needs Fred's explicit call.
- Ultimate goal: **train a model** — keep the corpus capturable + queryable.

---

## 13. Open items to confirm before/while building

- Exact heavy-tier idle window before auto-stop (cost vs latency trade). **Default shipped:** 5 min
  (`GPU_IDLE_MS=300000`), env-tunable.
- Whether internal `MAIN_MODEL` JSON passes use R1 or a non-reasoning 32B (§10 tuning note). **Still
  open** — decide during Phase 3 tuning; wire via `MAIN_MODEL` env once the box is up.
- Thunder Compute start/stop API shape for the lifecycle hook. **Resolved structurally:** the hook is
  provider-agnostic and env-driven (`GPU_START_URL`/`GPU_STOP_URL`/`GPU_STATUS_URL`/`GPU_API_KEY`), so
  Thunder's exact endpoints plug in with zero code. Confirm the URLs/token once the CLI + API key are
  in hand.
- Custom domain choice for the final cutover. **Still open.**

---

## 14. Build log

### 2026-07-14 — Phases 1, 3, 4 code complete (branch `claude/dominion-ai-ui-deployment-adit94`)

All changes are surgical and **backward-compatible with single-box mode** (every new `OLLAMA_*` /
`GPU_*` / `DATA_DIR` var falls back to today's behavior when unset), so the mini-PC keeps running
byte-for-byte until cutover.

**Phase 1 — cloud-ready packaging & bind:**
- `server.mjs`: bind `HOST` (`0.0.0.0` default) + injected `PORT` (§8.1).
- `package.json` (ESM, `engines.node >=24`, `start`), `Dockerfile` (**node:24-slim** — persona.mjs
  needs the built-in `node:sqlite`, stable in Node 24), `.dockerignore`, `railway.json`
  (Dockerfile builder + `/api/version` healthcheck) (§8.3).
- One `DATA_DIR` base for all server-side state (memory/chatlog/artifacts/corpus/flywheel/logs):
  Windows → `C:\minipc-chat`, Linux/Railway → `/data` (the Volume). Each specific `*_DIR` env still
  wins. Collapses §7's 8-var matrix to one var (§7, §8.4). Watchdog auto-off on Linux (§8.5).

**Phase 3 — the two seams repointed (code; inert until the GPU exists):**
- Per-model Ollama endpoint: `OLLAMA_LIGHT_URL` / `OLLAMA_HEAVY_URL` / `OLLAMA_KEY`. `ollamaChat()`,
  `embedText()`, and the `/ollama` `proxy()` now pick `http`/`https` by URL protocol, use the right
  default port, inject `Authorization: Bearer $OLLAMA_KEY`, and route by model (MAIN_MODEL / heavy
  tags → heavy tier; everything else → always-on light tier) (§5, §8.2).

**Phase 2 hook — on-demand heavy GPU lifecycle (provider-agnostic):**
- `ensureHeavyWarm()` + idle auto-stop, env-driven (`GPU_START_URL` / `GPU_STOP_URL` /
  `GPU_STATUS_URL` / `GPU_API_KEY` / `GPU_IDLE_MS` / `GPU_WARMUP_MS`). No-op when unconfigured. Wired
  into the local generation path: heavy turns warm the box (with a "spinning up the reasoning engine"
  heartbeat) before the first token (§5, §8.6). **Needs Fred's Thunder API key/URLs to go live.**

**Phase 4 — cost visibility:**
- `POST /estimate` preflight (deterministic: heuristic route + `estTokens` + catalog price for cloud,
  GPU-seconds for the heavy box; no model call). Live composer cost chip in the PWA (green =
  free/always-on, brass = paid cloud, amber-pulse = cold on-demand GPU). Verified in-browser: cloud
  `GPT-4o · ≈ $0.01–0.03`, heavy-cold `≈ $0.06–0.25 incl. cold start · ~165s`, light = free, empty →
  hidden (§6).

### 2026-07-14 (final) — Thunder GPU DELETED; decisions locked; Phase 1 (MCP hands) begun

Fred consolidated all sessions into one Claude Code session and locked the following:

1. **No paid GPU.** The Thunder A100 was deleted the same day it went live (no start/stop API,
   ~$1,370/mo to idle at $1.90/hr). The section below survives as a rebuild recipe only. Wallet
   leftovers `DOMINION_OLLAMA_URL` / `DOMINION_OLLAMA_KEY` / `THUHNDER_COMPUTE_A100_API_KEY` are
   dead and can be removed.
2. **Tailscale is allowed, narrowly.** Exactly two uses: the Railway container reaches the mini-PC
   Qwen over the tailnet (Ollama binds the tailnet interface, ledger L-016 RESOLVED), and
   update/deploy access to the boxes. The hands do NOT ride the tailnet.
3. **Hands = MCP tool server per machine, dial-out** (`ACCESS-AND-PRIVACY-DESIGN.md` §2). Phase 1
   builds the mini-PC node; the laptop node is Phase 4.
4. **Anthropic direct joins the catalog** and the Trusted-mode roster (Fred, 2026-07-14).
5. **UI baseline blessed.** The dominion-cinematic version, including this branch's `public/`
   changes (the paint fix and the cost chip), is the UI Fred chose. Frozen from here.

### 2026-07-14 (later) — Phase 2 GPU node LIVE on Thunder Compute *(historical; deleted same day, kept as rebuild recipe)*

Fred created a Thunder Compute **A100-SXM4-80GB** instance (id `0`, uuid `00ypb2gl`, IP
`198.145.126.210:31656`, 64GB RAM, 100GB disk). Stood it up and verified end-to-end:

- **Ollama** installed + running on the A100 (models dir `~/.ollama` = on the persistent disk).
  Pulled all four: `deepseek-r1:32b` (heavy, verified **35 tok/s** on the A100), `qwen3:30b-a3b`,
  `qwen3:8b` (light), `nomic-embed-text` (embed). GPU confirmed: `library=CUDA … A100-SXM4-80GB`.
- **Caddy** bearer-auth gateway on `:8080` → reverse-proxies `127.0.0.1:11434`, rewriting the
  upstream `Host` to `127.0.0.1:11434` (Ollama 403s a non-localhost Host — the cross-origin guard).
- **Public HTTPS** via `tnr ports forward` (API `PATCH /instances/0/ports {"add_ports":[8080]}`):
  **`https://00ypb2gl-8080.thundercompute.net`** (Thunder terminates TLS via Cloudflare). Verified:
  unauth → 401, `Bearer <token>` → 200 (`/api/version`, `/api/tags`, real `/api/chat` generation).
- Secrets in the wallet: `DOMINION_OLLAMA_URL`, `DOMINION_OLLAMA_KEY` (the gateway bearer),
  `THUHNDER_COMPUTE_A100_API_KEY` (Thunder REST at `https://api.thundercompute.com:8443`).

**Thunder realities that revise the plan:**
- **No start/stop API (resolves the §13 open item honestly).** Thunder bills per-minute while
  RUNNING; the only "off" is DELETE + snapshot-restore (restore is slow and may hand back a new
  uuid → new public URL). So **true per-turn on-demand (§5) is NOT viable on Thunder** — the
  `ensureHeavyWarm` lifecycle hook stays inert (`GPU_*` start/stop URLs unset). Cost control =
  keep it running while in use, **delete when done for long stretches**, restore from a snapshot.
- **One A100 serves BOTH tiers.** 80GB holds qwen3:30b-a3b + qwen3:8b + nomic and can load
  deepseek-r1:32b too, so `OLLAMA_LIGHT_URL == OLLAMA_HEAVY_URL` (single endpoint, `SPLIT_TIERS`
  off). New `GPU_ALWAYS_ON=1` flag makes the cost chip read "included" (a flat-hourly box has ~zero
  marginal per-turn cost) instead of a misleading GPU-seconds price.
- **No systemd, no cron** on the k8s container. Ollama + Caddy run as detached (`setsid`) processes
  via `~/start-dominion.sh`; they do NOT survive a box restart automatically. After any
  restart/snapshot-restore, re-run `~/start-dominion.sh` over SSH. **Snapshot the instance** to
  preserve the installed models + binaries + scripts.

**Remaining to finish the migration:**
1. **Phase 1 deploy (needs Fred / a Railway account token):** create the Railway service (Docker
   build), attach a Volume at `/data`, set the env matrix below, deploy. This proves the interface
   with the bridge gone AND wires the GPU in one shot (the node is already live).
2. **Railway env matrix for this deployment:**
   - `OLLAMA_URL` = `https://00ypb2gl-8080.thundercompute.net`  (both tiers on the one A100)
   - `OLLAMA_KEY` = `DOMINION_OLLAMA_KEY` (wallet)
   - `LIGHT_MODEL` = `qwen3:8b` · `MAIN_MODEL` = `qwen3:30b-a3b`  (parity, zero regression;
     `deepseek-r1:32b` is pulled and ready — flip `MAIN_MODEL` to it to trial R1 as the brain, with
     the §10 caveat that R1 fights the strict-JSON internal passes)
   - `EMBED_MODEL` = `nomic-embed-text` · `GPU_ALWAYS_ON` = `1`
   - `DATA_DIR` = `/data` (Volume) · provider keys (`OPENROUTER_API_KEY`,
     `OPEN_AI_DOMINION_UI_APIKEY`, `DEEPSEEK_AI_DOMINION_UI_APIKEY`, `SERP_API_KEY`) ·
     `OPENROUTER_REFERER` = the Railway URL · `WATCHDOG_ENABLED=0`
3. **Phase 5 cutover:** custom domain, retire the mini-PC.
