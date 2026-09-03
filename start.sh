#!/bin/sh
# Dominion AI — container entrypoint and PID-1 shutdown supervisor. The named tunnel and Node
# must receive SIGTERM together: cloudflared stops accepting new edge traffic and drains for its
# platform maximum of 180 seconds, while Node keeps finishing the matching durable provider
# checkpoint before Railway's 330-second SIGKILL deadline. A longer provider turn is recovered from
# the durable ledger after the browser reconnects to the replacement deployment.
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
  # --protocol http2 (streams lane, stabilization 2026-09-03, deficiency #25): cloudflared's
  # default transport is QUIC over UDP, and the production log shows QUIC resets ("timeout: no
  # recent network activity") on the order of 100 times a day, tracking closely with the
  # gx10-gamefactory node's own measured ~15-minute reconnect cycle. QUIC's idle timeout is
  # sensitive to UDP path liveness in a way plain TCP is not — a NAT/firewall UDP mapping expiring
  # on the path (a very common consumer-router/cloud-NAT default is in the 10-20 minute range) can
  # silently drop a QUIC session's datagrams with no TCP-style RST to notice quickly. HTTP/2 rides
  # a normal long-lived TCP connection, which does not depend on a UDP mapping staying open and
  # gets ordinary TCP keepalive/RST behavior on a real drop. This does not change what SIGTERM
  # does below: the tunnel still drains for its platform grace period on shutdown either way.
  cloudflared tunnel --no-autoupdate --protocol http2 --grace-period 180s run --token "$TUNNEL_TOKEN" &
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
