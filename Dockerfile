# Dominion AI — cloud image (docs/CLOUD-MIGRATION.md §8.3).
# Node 24 is REQUIRED: persona.mjs uses the built-in node:sqlite (DatabaseSync), stable in Node 24.
# There are zero npm dependencies (only Node built-ins + local .mjs), so there is nothing to install.
FROM node:24-slim

WORKDIR /app

# Copy the app (no `npm install` step — pure built-ins).
COPY . .

ENV NODE_ENV=production
# Railway injects PORT and HOST; these are only defaults for a bare `docker run`.
ENV PORT=8088
ENV HOST=0.0.0.0
# Server-side state (memory, chatlog, artifacts, corpus, flywheel, logs) lives here.
# Mount a persistent Volume at /data on Railway so it survives redeploys (§7).
ENV DATA_DIR=/data

EXPOSE 8088

CMD ["node", "server.mjs"]
