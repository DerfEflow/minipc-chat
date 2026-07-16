#!/bin/sh
# Dominion AI — container entrypoint. Runs the Cloudflare Tunnel (when TUNNEL_TOKEN is set) so
# app.dominion.tools reaches the app WITHOUT a Railway public domain or cert, then the app itself.
# The tunnel is how the Access-gated hostname connects to the origin entirely cloud-side (no home PC).
set -e
if [ -n "$TUNNEL_TOKEN" ]; then
  echo "[start] launching cloudflared tunnel -> localhost:${PORT:-8088}"
  cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
else
  echo "[start] TUNNEL_TOKEN unset — running app without the tunnel (local/dev mode)"
fi
exec node server.mjs
