#!/usr/bin/env node
/*
 * Mini-PC Chat - tiny self-contained server.
 * Serves the minimalist PWA (./public) AND reverse-proxies /ollama/* to the local Ollama,
 * so the phone talks to ONE HTTPS origin (via Tailscale Serve) and Ollama never has to leave
 * localhost. Zero dependencies (node:http). Streams responses (SSE) untouched.
 *
 *   PORT        port to listen on (default 8088), bound to 127.0.0.1 only
 *   OLLAMA_URL  upstream Ollama (default http://127.0.0.1:11434)
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8088);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const ou = new URL(OLLAMA);
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Reverse-proxy to Ollama, streaming the response straight through.
function proxy(req, res, upstreamPath) {
  const headers = { ...req.headers, host: ou.host };
  delete headers["accept-encoding"]; // keep SSE/stream un-gzipped so it flows token-by-token
  const opts = {
    protocol: ou.protocol,
    hostname: ou.hostname,
    port: ou.port || (ou.protocol === "https:" ? 443 : 80),
    path: upstreamPath,
    method: req.method,
    headers,
  };
  const up = http.request(opts, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Can't reach Ollama on the mini-PC: " + e.message }));
  });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(u.pathname);

    if (path === "/ollama" || path.startsWith("/ollama/")) {
      const rest = path.slice("/ollama".length) || "/";
      return proxy(req, res, rest + (u.search || ""));
    }

    let rel = path === "/" ? "/index.html" : path;
    const safe = normalize(rel).replace(/\\/g, "/");
    const file = join(PUBLIC, safe);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
    let data;
    try { data = await readFile(file); }
    catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
    // App shell is revalidated each load; the service worker handles offline caching.
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[minipc-chat] http://127.0.0.1:${PORT}  ->  Ollama ${OLLAMA}`);
  console.log("[minipc-chat] front this with: tailscale serve --bg " + PORT);
});
