// Dominion AI app shell: network-first, offline-capable, live APIs never cached.
const CACHE = "dominion-ai-v30";
const SHELL = [
  "/",
  "/index.html",
  "/app.js?v=30",
  "/dominion-ui.css?v=30",
  "/dominion-ui.js?v=30",
  "/dominion-cinematic.js?v=30",
  "/dominion-cinematic-01.css?v=30",
  "/dominion-cinematic-02.css?v=30",
  "/dominion-cinematic-03.css?v=30",
  "/dominion-cinematic-04.css?v=30",
  "/dominion-cinematic-05.css?v=30",
  "/dominion-cinematic-06.css?v=30",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/circuit-bg.mp4",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const dyn = ["/chat", "/memory", "/toolruns", "/tool-confirm", "/artifacts", "/mentor", "/ledger", "/evals", "/rules", "/prompts", "/persona", "/finetune", "/reviews", "/pipeline", "/tool-overlays"];
  if (url.pathname.startsWith("/ollama") || dyn.some((b) => url.pathname === b || url.pathname.startsWith(b + "/"))) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && e.request.method === "GET") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
