# Fred's Assistant — minimal PWA for your mini-PC AI

A tiny, installable phone app that chats with the LLMs running in Ollama on your mini-PC.
Minimal on purpose; built to grow.

## How it works

```
Phone (PWA)  --HTTPS (Tailscale)-->  mini-PC : server.mjs
                                         |-- serves the PWA (public/)
                                         '-- proxies /ollama/* -> 127.0.0.1:11434 (Ollama)
```

One origin, so there's no CORS or mixed-content trouble, and **Ollama never leaves localhost** —
only your tailnet can reach the app, and only your phone (signed into Tailscale) sees it.

## Set it up on the mini-PC (one time)

1. Get the code onto the mini-PC:
   ```
   git clone https://github.com/DerfEflow/minipc-chat.git C:\minipc-chat
   ```
2. In an **elevated** PowerShell:
   ```
   powershell -ExecutionPolicy Bypass -File C:\minipc-chat\setup-minipc-chat.ps1
   ```
   It runs the server as an always-on detached task and exposes it over Tailscale HTTPS, then
   prints your **phone URL** (e.g. `https://nucbox-k8-plus.<tailnet>.ts.net/`).

   > First time only: if it warns about HTTPS, open the Tailscale admin console and enable
   > **MagicDNS** + **HTTPS Certificates**, then re-run `tailscale serve --bg 8088`.

## Install on your phone

1. On your phone (signed into Tailscale), open the printed `https://…ts.net/` URL.
2. Browser menu → **Add to Home Screen** (iOS) / **Install app** (Android).
3. Launch it from your home screen. Pick a model up top, chat away.

## Run it locally (dev)

```
node gen-icons.mjs      # once, to (re)create the icons
node server.mjs         # http://127.0.0.1:8088  (needs Ollama on 11434)
```

## Durable long runs (server-owned turns)

Every `/chat` turn runs as a **job the server owns**, not work the browser tab holds. The tab is
just a viewer: it POSTs to `/chat`, gets a `job` id, and streams events — but the model call and the
whole agent loop run server-side with server-held keys. If the phone minimizes, switches chats, drops
wifi, or reloads, the run **keeps generating**; the client reattaches via `/chat/attach?job=&from=`
and catches up mid-stream or straight to the finished answer. Stop is a real server call
(`/chat/stop`), so a dead socket never cancels a run.

Jobs are persisted to SQLite (`chatjobs.mjs`, in `DATA_DIR/chatjobs`), which is what makes **very
long runs** (hours — an overnight job is fine) safe:

- **Survives a server restart / redeploy.** On reboot the server replays a finished run's full answer
  from disk, and turns a run that was still generating into an honest **orphaned** result — the
  partial output is preserved with a "server restarted mid-run" note and a one-tap **Continue**.
- **No 45-minute expiry for results.** A finished answer waits until the client collects it
  (`/chat/collect`), then a short retention window; uncollected results persist for weeks
  (`CHATJOBS_UNCOLLECTED_TTL_MS`, `0` = forever).
- **Concurrency.** Several chats can stream at once (a sidebar dot marks each running chat); switching
  chats never drops a run, and finished background runs are delivered into their chat on return, even
  if you never opened it (`/chat/jobs` + `/chat/result` reconcile on boot and on focus).

The same code serves both deployments — the **mini-PC** (always-on, so restarts are rare) and
**Railway** (redeploys exercise the orphan path). The durability work is exactly what makes them
equivalent for long runs; no external queue, worker, or third-party service is involved.

Tuning knobs (env): `CHATJOBS_MAX_RUNNING` (per-user in-flight cap, default 6),
`CHATJOBS_TAIL` (RAM replay window per job), `CHATJOBS_FLUSH_MS` (token-batch flush interval),
`CHATJOBS_COLLECTED_TTL_MS`, `CHATJOBS_UNCOLLECTED_TTL_MS`, `CHATJOBS_DIR`.
Tests: `node chatjobs_unit_test.mjs`, `node chatjobs_test.mjs`, `node chatjobs_persist_test.mjs`.

## Notes / next features

- Model list auto-loads from Ollama; conversation persists on the device; `New` clears it.
- `<think>…</think>` reasoning from qwen3 is hidden from the chat.
- Easy adds later: per-chat history list, system-prompt presets, voice input, image attach,
  a "send to Command Deck / Forge" action, streaming stop button.
