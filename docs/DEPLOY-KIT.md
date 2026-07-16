# Dominion AI — Phase 3 Deploy Kit

Everything the final Railway deploy needs, so it's one clean session once the two human
prerequisites are done. Written 2026-07-15. Companion to `CLOUD-MIGRATION.md` and
`ACCESS-AND-PRIVACY-DESIGN.md`.

## The two human prerequisites — BOTH DONE (2026-07-15)

1. **Cloudflare Zero Trust enabled.** ✅ Team `domi-ai`. Access apps then pre-built by API (below).
2. **Tailscale auth key minted.** ✅ In the wallet as `TAILSCALE_AUTH_KEY` (reusable, `tskey-au…`).

Subdomain chosen: **`app.dominion.tools`** (bare `dominion.tools` left for a landing page).

## Cloudflare Access — PRE-BUILT (2026-07-15), so auth guards the URL the instant the CNAME lands

Account `d78b53b020856d24423b39a5577c45f2`, zone `dominion.tools` (active). Two self-hosted apps:

| App | Domain | Policy |
|---|---|---|
| Dominion AI (`fe745dc5-4981-4be8-b310-77b70bd883d5`) | `app.dominion.tools` | **allow** email = `fredwolfe@gmail.com` only (one-time PIN) |
| Dominion healthcheck (`243f7cec-f64a-411e-8bf6-8ab1c47bc0af`) | `app.dominion.tools/api/version` | **bypass** (public, for Railway's healthcheck) |

**Ingress rule that must hold (abort-5 / L-017):** the ONLY public path to the app must be
`app.dominion.tools` (Access-gated). At deploy, REMOVE the auto-generated `*.up.railway.app` domain
(it is NOT behind Access) and use only the custom domain — otherwise the corpus sits on an
unauthenticated URL. Restore the corpus ONLY after the railway.app domain is gone and an
unauthenticated curl to `app.dominion.tools` returns 403.

## Railway resources already provisioned (2026-07-15, no billing yet)

| Thing | Value |
|---|---|
| Workspace | `derfeflow's Projects` (`b0b085ff-e241-4d4f-ade8-2348b9573401`) |
| Project | `dominion-ai` (`42e60c2b-26c9-4dda-8934-bff746e15896`) |
| Environment | `production` (`11bc5e32-a4fc-4054-859b-03ce7d78cec2`) |
| Service | `dominion` (`71f167bb-fc2c-4c74-9045-7da67df8cc6b`) — EMPTY, no source, not deployed |

Non-secret config vars already set on the service (12): `HOST`, `DATA_DIR`, `WATCHDOG_ENABLED`,
`LIGHT_MODEL`, `MAIN_MODEL`, `EMBED_MODEL`, `OPENROUTER_REFERER`, `CLOUD_BACKUP_ENABLED`,
`CLOUD_BACKUP_NODE`, `CLOUD_BACKUP_DIR`, `CLOUD_INGEST_NODE`, `CLOUD_INGEST_DIR`.

## Secrets still to set at deploy (held out of idle infra on purpose)

Read each value at runtime from `~/.app-secrets.env`; never inline. Set on the Railway service:

| Railway var | Wallet source | Note |
|---|---|---|
| `OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` | cloud provider |
| `OPEN_AI_DOMINION_UI_APIKEY` | same | OpenAI direct + voice |
| `DEEPSEEK_AI_DOMINION_UI_APIKEY` | same | DeepSeek direct |
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Anthropic direct (Trusted mode) |
| `SERP_API_KEY` | same | web_search |
| `GITHUB_TOKEN` | `DOMI_AI_MAX_ACCESS_GITHUB_API` | the app's max-access GitHub token |
| `HANDS_TOKEN` | generate at deploy | SAME value goes on every hands node (installer/compose) |
| `OLLAMA_URL` | the mini-PC tailnet address | needs the Tailscale key first (L-005) |
| `OLLAMA_KEY` | `DOMINION_OLLAMA_KEY` was Thunder-dead (pruned) | mint a new box-gateway bearer if Qwen is gated |

## Deploy steps (once the two prerequisites are done)

1. **Connect the source.** Point the `dominion` service at `DerfEflow/minipc-chat`, branch
   `claude/dominion-ai-ui-deployment-adit94` (or merge to `main` first), Dockerfile builder. The repo
   already has `Dockerfile` (node:24-slim) + `railway.json`.
2. **Attach a Volume** at `/data` (this is where billing for storage begins — a few GB, ~$1/mo).
3. **Set the secrets** from the table above. Generate `HANDS_TOKEN` and record it for the nodes.
4. **First deploy.** Confirm `/api/version` returns a build id and the boot log prints every secret
   as present/MISSING by name (the loud-secret check).
5. **Auth BEFORE the corpus (abort condition 5 / L-017).** Put Cloudflare Access in front FIRST:
   - CNAME `app.dominion.tools` → the Railway-assigned domain, proxied (orange).
   - Cloudflare Zero Trust → Access → Add self-hosted app on `app.dominion.tools`.
   - Policy: allow only `fredwolfe@gmail.com` (email OTP or Google).
   - Bypass policy for the health path `/api/version` so Railway's healthcheck isn't blocked.
   - Verify: unauthenticated curl → 403/redirect; authenticated → 200. (Both transcripts kept.)
   - I can do the CNAME + Access app + policy + bypass by API once Zero Trust is enabled.
6. **Restore the corpus** onto the volume (MOVE 6): binary transfer, verify SHA-256
   `981E9B08…C0E652` and 885 / 14,696 / 14,696 / 834 BEFORE opening the DB. Only after auth is live.
7. **Install the hands nodes** (Phase 1): `hands/install-windows.ps1` on the mini-PC (and laptop) with
   `HANDS_URL=https://app.dominion.tools`, the shared `HANDS_TOKEN`, `HANDS_MAX_ACCESS=1`. Prove the
   cloud → hands loop; prove the `D:\` carve-out denial from the cloud.
8. **Wire Qwen over tailnet** (needs the Tailscale key): container joins the tailnet, `OLLAMA_URL` →
   the box's tailnet address, Ollama bound to the tailnet interface (L-016).
9. **Cutover** (MOVE 8): repoint the phone PWA to `app.dominion.tools`, keep the mini-PC's chat task
   running until one clean week has passed. The cloud backup (L-003) and inbox ingest (L-009) now run
   through the hands nodes; verify `/persona/backup-now` pushes a snapshot off-box and
   `/persona/ingest-remote-inbox` drains the box inbox.

## Success gates (from success.md) — all must show evidence

zero `public/` diff vs the blessed baseline · corpus 885/14,696/14,696/834 + integrity ok on Railway ·
unauth request refused (transcript) · a real chat + tool call end to end · corpus backup off-box with
hash + location · mini-PC still running untouched · every carve-out enforced from the cloud (a `D:\`
call refused).
