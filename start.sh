#!/bin/sh
# Dominion AI — container entrypoint and PID-1 shutdown supervisor. The named tunnel and Node
# must receive SIGTERM together: cloudflared stops accepting new edge traffic while its long-lived
# request drains, and Node finishes the matching durable provider checkpoint before Railway's
# 330-second SIGKILL deadline.
set -eu

cloudflared_pid=""
node_pid=""
shutdown_started=0

forward_shutdown() {
  if [ "$shutdown_started" -eq 1 ]; then
    return
  fi
  shutdown_started=1
  echo "[start] graceful shutdown: draining tunnel and application"
  if [ -n "$cloudflared_pid" ] && kill -0 "$cloudflared_pid" 2>/dev/null; then
    kill -TERM "$cloudflared_pid" 2>/dev/null || true
  fi
  if [ -n "$node_pid" ] && kill -0 "$node_pid" 2>/dev/null; then
    kill -TERM "$node_pid" 2>/dev/null || true
  fi
}

wait_for_pid() {
  waited_pid="$1"
  while :; do
    if wait "$waited_pid"; then waited_status=0; else waited_status=$?; fi
    if ! kill -0 "$waited_pid" 2>/dev/null; then
      return "$waited_status"
    fi
  done
}

trap forward_shutdown TERM INT

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  echo "[start] launching cloudflared tunnel -> localhost:${PORT:-8088}"
  cloudflared tunnel --no-autoupdate --grace-period 320s run --token "$TUNNEL_TOKEN" &
  cloudflared_pid=$!
else
  echo "[start] TUNNEL_TOKEN unset — running app without the tunnel (local/dev mode)"
fi

node server.mjs &
node_pid=$!
node_status=0
wait_for_pid "$node_pid" || node_status=$?

# A crash or ordinary Node exit must not leave a named-tunnel connector pointing at a dead origin.
if [ -n "$cloudflared_pid" ] && kill -0 "$cloudflared_pid" 2>/dev/null; then
  kill -TERM "$cloudflared_pid" 2>/dev/null || true
  wait_for_pid "$cloudflared_pid" || true
fi

exit "$node_status"
