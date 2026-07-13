# Dominion AI — Session Handoff

_State as of 2026-07-12. Update the date + HEAD when this changes materially._

## What it is
Dominion AI is Fred's self-hosted phone PWA assistant ("Dominion AI / by Frederick Wolfe"). As of
2026-07-12 it pivoted from a local-Qwen chat app to a **cloud-brain agent**: Fred picks any cloud
model, and tool-capable models drive his whole box (files, projects, web, code) with a voice
interface. The local Qwen path still exists as the free default/fallback and is untouched.

## Home / infrastructure
- **Repo:** `DerfEflow/minipc-chat` (private, branch `main`). HEAD = `5b1b866`.
- **Source working tree (laptop):** `F:\Claude Sandbox\Projects\minipc-chat`
- **Deployed** on the mini-PC "nucbox-k8-plus" at `C:\minipc-chat`, run by the scheduled task
  **"MiniPC Chat PWA"** (`node server.mjs`, binds localhost, fronted by Tailscale Serve).
  Live URL: https://nucbox-k8-plus.tailf9be8f.ts.net/
- Zero-dependency Node (`node:http`); no build step; no `npm install`.
- **Keys** live in the box's `C:\minipc-chat\.env` (backup `.env.bak-2026-07-12`):
  `OPENROUTER_API_KEY`, `OPEN_AI_DOMINION_UI_APIKEY`, `DEEPSEEK_AI_DOMINION_UI_APIKEY`,
  `SERP_API_KEY`. Same key NAMES are in the laptop wallet `~/.app-secrets.env`.

## Deploy recipe (SSH over Tailscale)
```
ssh -i ~/.ssh/id_ed25519 Fred@nucbox-k8-plus
git -C C:\minipc-chat pull origin main
Stop task "MiniPC Chat PWA" -> wait 2s (port race) -> Start it
Verify: port listener present, /api/version returns a new build id.
```
Remote PowerShell must be base64 UTF-16LE via `-EncodedCommand`. On "box offline", check the
phone/tailnet first and confirm power (the box auto-recovers after outages).

## What's new (the 2026-07-12 build, Phases A–D)

**A) Live catalog + provider router.** `models.catalog.mjs` is the single source of truth (38
models), served at `GET /api/models`; the picker builds from it. Each model carries `provider`
(`openrouter` | `openai` | `deepseek`), `directId` (native id), and `toolCapable` (true = "doing"
bench gets tools; false = "chatting" bench, chat-only).
- OpenAI DIRECT: gpt-5.6 Sol/Terra/Luna, gpt-5.5, gpt-4o.
- DeepSeek DIRECT: deepseek-v4-flash, deepseek-v4-pro (R1 stays on OpenRouter).
- Everything else via OpenRouter. Claude deliberately absent (Fred uses its own app).
  `venice/uncensored` removed (Fred: no Venice).
- Router = `PROVIDER_CFG` table in `server.mjs`; `cloudChatStream()` routes by provider (all
  OpenAI-compatible SSE), labels errors/usage per provider.

**B) Cloud tool loop.** Doing-bench cloud models run the SAME tool machinery as local (ironclad
carve-outs, mode gates, confirm gates, 9-state lifecycle, honest logs) with OpenAI `tool_call_id`
plumbing. `CLOUD_MAX_ROUNDS=8`; the last 2 are "conclusion rounds" (schemas stay attached with
`tool_choice:"none"`, nudge + retry as user-role messages) so agent models don't go mute;
reasoning-channel captured as a last resort. Chatting-bench models stream one plain turn.

**C) Web tools** in `tools.mjs`: `web_search` (SerpApi, `SERP_API_KEY`) + `web_read` (readable page
text). `read_only`, available to every tool-capable model.

**D) Voice.** `POST /api/voice/transcribe` (OpenAI STT, dependency-free multipart) and
`POST /api/voice/tts` (gpt-4o-mini-tts, streamed mp3). UI mic button = tap to talk, tap to send; the
transcript rides the normal `/chat` flow so the PICKED model answers with full tools. Speaker toggle
reads answers aloud. OpenAI is ears + mouth only; the brain stays Fred's chosen model.

**Plus TRUE FORGET.** Deleting a chat now calls `POST /chatlog/forget {chatId}`, which erases the
server-side transcript (`chatlog.mjs`) AND any episodic memory distilled from it. Before this,
sidebar delete only cleared phone localStorage, so cross-chat retrieval could resurrect "deleted"
chats.

## Durable provider gotchas (all live-verified 2026-07-12)
1. Native OpenAI rejects `max_tokens` → use `max_completion_tokens` (OpenRouter translates it;
   DeepSeek accepts `max_tokens`). Only `provider==="openai"` differs.
2. OpenAI gpt-5.x/o-series reject function tools on `/v1/chat/completions` unless
   `reasoning_effort:"none"` (applied only on tool turns). GPT-4o + DeepSeek unaffected. Proper fix
   later = the `/v1/responses` API.
3. DeepSeek native model ids drop the prefix (`deepseek-v4-flash`, not `deepseek/deepseek-v4-flash`).
4. Agent-tuned models go MUTE when tool schemas vanish mid-conversation. Fix: keep tools attached
   with `tool_choice:"none"` and instruct via a user-role message.

## Key files
`server.mjs` (routing + cloud agent loop + voice endpoints + provider router + `/api/*`),
`models.catalog.mjs` (catalog + provider/bench fields), `tools.mjs` (tools incl.
`web_search`/`web_read`), `chatlog.mjs` (transcript index + `remove`/forget), `public/app.js` +
`public/index.html` (dynamic picker, mic/speaker UI), `persona.mjs`, `memory.mjs`, `mentor.mjs`,
`flywheel.mjs`, `review.mjs`, `artifacts.mjs`, `routing.mjs`. Repo has test files (`*_test.mjs`)
run with plain `node`; keep them green before deploy.

## Behavior note (not a bug)
Dominion injects Fred's memory profile + cross-chat retrieval into EVERY turn, including cloud.
That's why models "know who Fred is"; they can't see their own context assembly and will confabulate
("lucky guess") if asked where it came from.

## Open / next
- Realtime duplex voice (OpenAI `gpt-realtime`) as an optional "natural voice" toggle (this build
  shipped the turn-based pipeline, option B).
- Bright Data as a `web_read` fallback if SerpApi/plain fetch hits bot walls (no BD token yet;
  SerpApi is live and sufficient for now).
- Field-test the phone mic UX (untested by Fred at handoff time).
- One As-Fred chat deleted BEFORE the true-forget fix may still sit in the server chatlog
  (`C:\minipc-chat\chatlog\chats.json`); Fred chose to leave it.

## Working with Fred
Full autonomy on this project (his standing directive). Reply format = essentials plus numbered next
steps with a recommendation; he replies with a number. No em dashes, no "not X but Y" constructions.
`F:\` + sandbox = full access; `C:\Documents` = read-only, never delete. Snapshot/branch before
risky changes.
