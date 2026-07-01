// Minimal service worker: cache the app shell so the PWA installs + opens offline.
// The live model/agent APIs (/ollama/*, /chat) are NEVER cached.
const CACHE = "dominion-ai-v13";
const SHELL = ["/", "/index.html", "/app.js?v=13", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/circuit-bg.mp4"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// NETWORK-FIRST: always load fresh when online (so updates take immediately), fall back to the
// cached shell only when offline. The live APIs are never touched by the worker.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const dyn = ["/chat", "/memory", "/toolruns", "/tool-confirm", "/artifacts", "/mentor", "/ledger", "/evals", "/rules"];
  if (url.pathname.startsWith("/ollama") || dyn.some((b) => url.pathname === b || url.pathname.startsWith(b + "/"))) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // status===200 only: 206 partial (range) responses from the video can't be cache.put()'d
        if (res && res.status === 200 && e.request.method === "GET") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
