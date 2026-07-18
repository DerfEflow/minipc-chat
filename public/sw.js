// Dominion AI app shell: network-first, offline-capable, live APIs never cached.
const CACHE = "dominion-ai-v41-scrollfollow";
const SHELL = [
  "/",
  "/index.html",
  "/setup.html",
  "/dominion-tenant.css?v=1",
  "/dominion-tenant.js?v=1",
  "/dominion-vault.css?v=1",
  "/app.js?v=33",
  "/dominion-ui.css?v=38",
  "/dominion-ui.js?v=39",
  "/dominion-cinematic.js?v=39",
  "/dominion-cinematic-01.css?v=30",
  "/dominion-cinematic-02.css?v=30",
  "/dominion-cinematic-03.css?v=30",
  "/dominion-cinematic-04.css?v=30",
  "/dominion-cinematic-05.css?v=30",
  "/dominion-cinematic-06.css?v=30",
  "/dominion-rendered-v2.css?v=38",
  "/assets/dominion-neural-chassis-desktop-4k-v3.webp",
  "/assets/dominion-neural-chassis-mobile-4k-v3.webp",
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
  const dyn = ["/chat", "/memory", "/toolruns", "/tool-confirm", "/artifacts", "/mentor", "/ledger", "/evals", "/rules", "/prompts", "/persona", "/finetune", "/reviews", "/pipeline", "/tool-overlays",
    "/account", "/billing", "/admin", "/forge", "/content", "/setup"];
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
