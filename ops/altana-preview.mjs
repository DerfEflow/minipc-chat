/*
 * Tiny static server for the Altana presence preview - run: node ops/altana-preview.mjs [port]
 *
 * The presence layer is pure front-end (altana.css, altana.js, six PNGs) and ships DARK inside the
 * app until Phase 4 gives Altana something to answer. That would leave the animation work
 * unviewable, so this serves public/ on its own port: no database, no keys, no model calls, no
 * risk of a preview turning into a real turn against a paid provider.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC = join(ROOT, "public");
/*
 * The preview PAGE lives in ops/, not public/, and that placement is deliberate. The real server
 * serves public/ as static, so a preview page left there would be reachable in production and
 * would show every visitor a floating assistant that cannot answer anything. That is the Knowledge
 * Vault mistake again, and this build removed that one rather than repeating it. Serving the page
 * from here keeps the shipped surface to exactly the three things Altana actually needs:
 * altana.css, altana.js, and the six faces.
 */
const PAGE = join(ROOT, "ops", "altana-preview.html");
const PORT = Number(process.argv[2]) || 8991;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
};

http.createServer(async (req, res) => {
  // Resolve inside PUBLIC only: normalize first, then refuse anything that escapes the root.
  const raw = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = normalize(raw).replace(/^([/\\])+/, "");
  const path = raw === "/" ? PAGE : join(PUBLIC, rel);
  if (path !== PAGE && !path.startsWith(PUBLIC)) { res.writeHead(403).end("no"); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + rel);
  }
}).listen(PORT, "127.0.0.1", () => console.log("altana preview: http://localhost:" + PORT));
