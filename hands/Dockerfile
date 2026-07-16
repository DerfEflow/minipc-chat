# Dominion AI — hands node container.
#
# END GOAL (Fred, 2026-07-14): max access to the host, minus the ironclad carve-outs.
#
# Topology:
#   - Windows mini-PC / laptop  -> run the node NATIVELY (scheduled task). A container is jailed away
#     from the host it is meant to hand for, so on Windows native is the only way to reach the whole
#     machine. See hands/install-windows.ps1.
#   - Any LINUX host            -> run THIS container with the host root bind-mounted so the node
#     reaches the whole machine (max access), while the carve-out guard (D:\, backups, customer DBs,
#     pg_dump/restore) still hard-blocks inside the node regardless of what is mounted.
#
# Build (from the repo root):
#   docker build -t dominion-hands -f hands/Dockerfile .
#
# Run with MAX ACCESS on a Linux host (mounts the host at /host, node roots = /host):
#   docker run -d --name dominion-hands --restart unless-stopped \
#     -e HANDS_URL=https://<orchestrator> -e HANDS_TOKEN=<secret> -e HANDS_NODE=<name> \
#     -e HANDS_ROOTS=/host \
#     -v /:/host:rw \
#     dominion-hands
#   (HANDS_MAX_ACCESS=1 also works and resolves to "/" — pair it with -v /:/ only if you accept
#    mounting the host at its real paths; the /host convention keeps container and host paths distinct.)
#
# Scoped run (safer default for a shared box — expose only what you mount):
#   docker run -d --restart unless-stopped \
#     -e HANDS_URL=... -e HANDS_TOKEN=... -e HANDS_NODE=... -e HANDS_ROOTS=/work \
#     -v /srv/project:/work:rw dominion-hands
#
# No npm install: the node uses Node 24 built-ins only, same as the rest of the app.
FROM node:24-slim
WORKDIR /app
COPY hands/hands.mjs ./hands.mjs
# The node runs as root inside the container ON PURPOSE for the max-access end goal: to read/write
# across a bind-mounted host it must not be blocked by host-uid ownership. The carve-out guard, not
# the container uid, is the security boundary Fred specified. For a scoped deployment, drop this and
# run as an unprivileged user matched to the mounted volume's owner.
CMD ["node", "hands.mjs"]
