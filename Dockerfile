# Dominion AI — cloud image (docs/CLOUD-MIGRATION.md §8.3).
# Node 24 is REQUIRED: persona.mjs uses the built-in node:sqlite (DatabaseSync), stable in Node 24.
# There are zero npm dependencies (only Node built-ins + local .mjs), so there is nothing to install.
FROM node:24-slim

WORKDIR /app

# Stable server-side editing/export. Debian's maintained FFmpeg build includes ffprobe and the
# software H.264/AAC encoders used as the deterministic production path; hardware codecs remain
# optional accelerators rather than a launch dependency.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# cloudflared: connects app.dominion.tools to this container via the Cloudflare Tunnel (Access in
# front) with no Railway public domain/cert. Static binary fetched at build time (no apt needed).
ADD https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 /usr/local/bin/cloudflared
RUN chmod +x /usr/local/bin/cloudflared

# Copy the app (no `npm install` step — pure built-ins).
COPY . .
RUN chmod +x /app/start.sh

ENV NODE_ENV=production
# Fixed internal port so the tunnel ingress (localhost:8088) always matches. Set PORT=8088 on Railway too.
ENV PORT=8088
ENV HOST=0.0.0.0
# Server-side state (memory, chatlog, artifacts, corpus, flywheel, logs) lives here.
# Mount a persistent Volume at /data on Railway so it survives redeploys (§7).
ENV DATA_DIR=/data

EXPOSE 8088

# Entrypoint runs the tunnel (if TUNNEL_TOKEN set) + the app.
CMD ["sh", "/app/start.sh"]
