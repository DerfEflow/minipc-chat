# Dominion AI — hands node container.
#
# For LINUX hosts and testing. On the WINDOWS mini-PC the node runs natively (a container is
# jailed away from the host it is supposed to hand for) — see ledger L-019.
#
#   docker build -t dominion-hands -f hands/Dockerfile .
#   docker run -d --restart unless-stopped \
#     -e HANDS_URL=https://<orchestrator> -e HANDS_TOKEN=<secret> \
#     -e HANDS_NODE=<name> -e HANDS_ROOTS=/work -v /path/to/expose:/work \
#     dominion-hands
#
# No npm install: the node uses Node 24 built-ins only, same as the rest of the app.
FROM node:24-slim
WORKDIR /app
COPY hands/hands.mjs ./hands.mjs
USER node
CMD ["node", "hands.mjs"]
