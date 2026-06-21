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

## Notes / next features

- Model list auto-loads from Ollama; conversation persists on the device; `New` clears it.
- `<think>…</think>` reasoning from qwen3 is hidden from the chat.
- Easy adds later: per-chat history list, system-prompt presets, voice input, image attach,
  a "send to Command Deck / Forge" action, streaming stop button.
