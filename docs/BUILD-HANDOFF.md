# Dominion AI — Cloud Migration + Access/Privacy: Build Handoff

**For a new session starting the build.** Read this first, then `CLOUD-MIGRATION.md` and
`ACCESS-AND-PRIVACY-DESIGN.md` (both in this `docs/` folder). Last updated 2026-07-14.

---

## 1. The one-paragraph story

Dominion AI runs today on the **mini-PC** (`server.mjs` at `C:\minipc-chat`, fronted by a fragile
`tailscale serve` bridge). We are moving the brain/orchestrator to **Railway** (reliable, always-on,
kills the bridge), keeping the local models path, and adding a robust way to preserve Dominion's
near-total access to Fred's machines and online projects. A paid always-on cloud GPU was explored
(Thunder Compute A100) and **rejected on cost** (no start/stop, ~$560/mo to idle). The brain will run
on **cloud provider APIs** (already the primary brain) with a **local model for Private turns**, and
the hands (tools) will move to **MCP tool servers on Fred's machines** with the same carve-out rules.

## 2. Decisions locked (do not re-litigate)

1. **No paid always-on GPU.** Provider APIs are the brain for Normal/Trusted; the free mini-PC Qwen is
   the Private brain. A local GPU is only ever an on-demand, spin-up-and-delete tool for training or
   heavy batch, guarded by a hard max-runtime kill-switch. (Thunder A100 was deleted; rebuild recipe
   is in `CLOUD-MIGRATION.md` §14 if ever needed.)
2. **Three privacy modes, user-controlled** (`ACCESS-AND-PRIVACY-DESIGN.md` §3):
   - **Normal** (DEFAULT) = all providers + local.
   - **Trusted** = OpenAI direct (optionally Anthropic direct) + local only. No OpenRouter, no DeepSeek.
   - **Private** = local model only. Zero cloud calls.
   - **No auto-detection. No re-routing or override.** The mode is a hard allow-list; a disallowed
     pick is **refused, never substituted**. Fred's pick within the allowed set is honored exactly.
3. **Access = MCP hands.** Near-total local access (with the existing carve-outs) is preserved by an
   MCP tool server per machine, NOT by where the brain runs. Mini-PC is **not** retired; it becomes
   the always-on hands node.
4. **Carve-outs unchanged.** `assertNotProtected` still hard-blocks `D:\`, `app-backups`/`db-backups`,
   customer DBs, `pg_dump`/`pg_restore`; specific-first root ordering protects Dominion's own host.
5. **Online projects** (GitHub/Railway/Vercel/Supabase) are reached **directly from the cloud** by
   API token (better than the current bridge hop).

## 3. What is already built + pushed

Branch **`claude/dominion-ai-ui-deployment-adit94`** in `DerfEflow/minipc-chat` (working tree at
`F:\Claude Sandbox\Projects\minipc-chat`). NOT merged to main, NOT deployed. Pre-work backup:
`F:\Claude Sandbox\backups\minipc-chat-premigration-20260714`.

- **Phase 1 (Railway packaging):** `HOST`/`0.0.0.0` + injected `PORT`; `package.json` (ESM, node>=24),
  `Dockerfile` (**node:24-slim** required for `node:sqlite`), `.dockerignore`, `railway.json`; one
  `DATA_DIR` base for all state (Windows `C:\minipc-chat`, Linux `/data`); watchdog off on Linux.
- **Phase 3 (Ollama seam):** `OLLAMA_LIGHT_URL`/`OLLAMA_HEAVY_URL`/`OLLAMA_KEY`, http/https + bearer,
  per-model routing. Falls back to single-box when unset.
- **Phase 2 hook + `/estimate` + cost chip (Phase 4):** on-demand GPU lifecycle hook (inert unless
  `GPU_*` set); `POST /estimate` preflight + composer cost chip; `GPU_ALWAYS_ON` flag. All verified
  in-browser on a local Node 24 boot.
- **Design docs:** `CLOUD-MIGRATION.md` (Railway + models), `ACCESS-AND-PRIVACY-DESIGN.md` (MCP hands
  + three privacy modes). This handoff.

Everything is backward-compatible with the running mini-PC; nothing here changes its behavior until
cutover.

## 4. The build plan (phases; run under the build discipline — high blast radius)

This touches credentials + near-total machine access + production, so build it with a numbered SOW,
per-phase verification, and snapshots/rollback (Fred's build protocol).

1. **MCP tool server (mini-PC).** A Dockerized MCP server exposing the `tools.mjs` capability set
   (filesystem/shell/git/deploy/sandbox/deck/forge) with the carve-outs ported verbatim. It dials OUT
   to the cloud orchestrator over an authenticated channel (recommended over cloud-reaches-in). Prove
   the cloud-brain -> local-hands loop end to end.
2. **Privacy modes.** Add the Normal/Trusted/Private switch (UI beside Model/Mode, persisted; default
   Normal) + server-side allow-list enforcement (refuse-not-substitute). Trusted = provider in
   {openai (+ optional anthropic)} + local; Private = local only. No auto-detection, no reroute.
3. **Railway orchestrator.** Deploy `server.mjs` + PWA to Railway (Docker build, Volume at `/data`,
   env matrix in `CLOUD-MIGRATION.md` §14 but **models = provider APIs, no GPU**). Take the phone off
   `tailscale serve`.
4. **Laptop MCP server.** Adds `F:\` + `C:\Users\rjfla` reach when the laptop is on.
5. **Optional later:** on-demand local GPU for a stronger Private brain (spin-up/delete + kill-switch).

## 5. What a new session should do FIRST

1. Read this file, then `ACCESS-AND-PRIVACY-DESIGN.md` and `CLOUD-MIGRATION.md`.
2. `cd F:\Claude Sandbox\Projects\minipc-chat`; `git checkout claude/dominion-ai-ui-deployment-adit94`;
   `git pull`. Confirm `git log` shows the commits in §3 (tip was `ac65297` at handoff time, plus the
   three-mode design update).
3. Confirm with Fred: **which phase to start** (recommend Phase 1, the mini-PC MCP server), and the
   **Trusted-mode roster** open question (add Anthropic direct?).
4. Blast radius is HIGH (credentials, near-total access, production). Run the full build discipline:
   numbered SOW split Fred/Claude + fidelity check, per-phase verification, snapshot before deploy.

## 6. Environment + creds (pointers, values read at runtime — never inline)

- Wallet `~/.app-secrets.env`: `OPENROUTER_API_KEY`, `OPEN_AI_DOMINION_UI_APIKEY`,
  `DEEPSEEK_AI_DOMINION_UI_APIKEY`, `SERP_API_KEY`; `GITHUB_TOKEN` (read-only; use `gh` for push).
  Left over from the GPU experiment (delete if not reused): `DOMINION_OLLAMA_URL`,
  `DOMINION_OLLAMA_KEY`, `THUHNDER_COMPUTE_A100_API_KEY`.
- Mini-PC: `ssh -i C:\Users\rjfla\.ssh\id_ed25519 Fred@nucbox-k8-plus` (Tailscale). Dominion host =
  `C:\minipc-chat`, task "MiniPC Chat PWA". Bridge = "CommandDeck Bridge" task.
- Railway: needs a service created (Fred) or an account token; the existing project token is
  TruAgent-scoped only.
- GitHub: `gh auth setup-git` then `git push` (wallet `GITHUB_TOKEN` is 403 for push).

## 7. Open questions — RESOLVED by Fred 2026-07-14 (see ACCESS-AND-PRIVACY-DESIGN §7)

- Trusted-mode roster: **Anthropic direct added.** Trusted = OpenAI direct + Anthropic direct + local.
- MCP transport: **dial-out.** Tailscale survives for exactly two uses: Railway reaches the mini-PC
  Qwen over the tailnet, and update/deploy access. The hands do not ride the tailnet.
- Private brain: **mini-PC Qwen for now**; on-demand local GPU stays an optional later upgrade.
- UI: **the dominion-cinematic baseline is blessed**, including this branch's `public/` diffs
  (paint fix + cost chip). Frozen from this baseline forward.
- Still open: ZDR agreement with Anthropic/OpenAI to close the short retention window.
- GitHub tokens, wallet PAT replacement, and the Railway service: Fred is working these (L-004,
  L-010); they gate Phase 3, never Phase 1.
