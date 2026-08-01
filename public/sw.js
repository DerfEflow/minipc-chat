// Dominion AI app shell: network-first, offline-capable, live APIs never cached.
const CACHE = "dominion-ai-v159-ios-focus-zoom";
const SHELL = [
  "/",
  "/index.html",
  "/setup.html",
  "/dominion-tenant.css?v=17",
  "/dominion-tenant.js?v=5",
  "/dominion-orders.js?v=1",
  "/dominion-vault.css?v=5",
  "/dominion-mobile.css?v=1",
  "/dominion-images.css?v=9",
  "/dominion-images.js?v=14",
  "/dominion-lexicon.js?v=14",
  "/dominion-lenses.css?v=7",
  "/dominion-beginner.css?v=5",
  "/dominion-vibe.css?v=19",
  "/dominion-tour.css?v=3",
  "/dominion-lenses.js?v=15",
  "/dominion-beginner.js?v=4",
  "/dominion-vibe.js?v=22",
  "/dominion-ide.css?v=26",
  "/dominion-ide.js?v=42",
  "/dominion-tour.js?v=6",
  "/app.js?v=73",
  "/dominion-markdown.css?v=1",
  "/dominion-markdown.js?v=1",
  "/dominion-ui.css?v=43",
  "/dominion-ui.js?v=39",
  "/dominion-cinematic.js?v=42",
  "/dominion-cinematic-01.css?v=30",
  "/dominion-cinematic-02.css?v=30",
  "/dominion-cinematic-03.css?v=31",
  "/dominion-cinematic-04.css?v=32",
  "/dominion-cinematic-05.css?v=30",
  "/dominion-cinematic-06.css?v=30",
  "/dominion-rendered-v2.css?v=41",
  "/dominion-forge.css?v=6",
  "/dominion-forge.js?v=6",
  "/dominion-money.js?v=2",
  "/assets/dominion-neural-chassis-desktop-4k-v3.webp",
  "/assets/dominion-neural-chassis-mobile-4k-v3.webp",
  "/assets/fonts/domine-latin-var.woff2",
  "/assets/fonts/domine-latin-ext-var.woff2",
  "/assets/forge-dial/forge-dial-ember-v2.jpg",
  "/assets/forge-dial/forge-dial-flame-v2.jpg",
  "/assets/forge-dial/forge-dial-furnace-v2.jpg",
  "/manifest.webmanifest",
  "/icons/dominion-core-180-v1.png",
  "/icons/dominion-core-192-v1.png",
  "/icons/dominion-core-512-v1.png",
  "/icons/dominion-core-maskable-512-v1.png",
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
    "/account", "/billing", "/admin", "/forge", "/guide", "/content", "/setup", "/connectors", "/api/images",
    // Dominion Works: live state, workspaces, and the job SSE stream. Caching any of these would
    // show a stale build or replay a finished job as if it were running.
    "/ide",
    // "/chats" and "/chatlog" are NOT covered by "/chat": the match is exact-or-prefix-with-slash,
    // so /chats/sync would otherwise be cached and served stale to the device that just synced.
    "/chats", "/chatlog",
    // The build id is the update watcher's ground truth: a cached copy served on a flaky network
    // would mask a deploy and the app would never learn it is stale (Fred's force-update ruling).
    "/api/version"];
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

/* ---- Dominion Works: reaching the user when a build needs them --------------------------
 * The push carries NO payload on purpose. It is a wake-up; we fetch the live job list and write
 * the notification from that. A question answered on the laptop therefore cannot buzz the phone
 * thirty seconds later as though it were still open, because by then the server no longer
 * reports it as pending.
 */
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let jobs = [];
    try {
      const r = await fetch("/ide/jobs", { headers: { accept: "application/json" }, credentials: "include" });
      if (r.ok) jobs = (await r.json()).jobs || [];
    } catch {}

    const asking = jobs.find((j) => j.needsInput && !j.done);
    const failed = jobs.find((j) => j.outcome === "error" && !j.interrupted);
    const done = jobs.find((j) => j.outcome === "done");

    let title, body, tag, url = "/?ide=1";
    if (asking) {
      title = "Your build has a question";
      body = asking.needsInput.question || "It needs an answer to continue.";
      tag = "ide-question";
      url = "/?ide=1&job=" + encodeURIComponent(asking.id);
    } else if (failed) {
      title = "Build stopped"; body = "It could not finish on its own."; tag = "ide-error";
      url = "/?ide=1&job=" + encodeURIComponent(failed.id);
    } else if (done) {
      title = "Build finished"; body = "The work is done."; tag = "ide-done";
      url = "/?ide=1&job=" + encodeURIComponent(done.id);
    } else {
      // Nothing actionable is outstanding, so say nothing. A notification with no news is worse
      // than silence: it teaches people to ignore the ones that matter.
      return;
    }
    await self.registration.showNotification(title, {
      body, tag, renotify: false, icon: "/icons/dominion-core-192-v1.png",
      badge: "/icons/dominion-core-192-v1.png", data: { url },
      requireInteraction: tag === "ide-question",
    });
  })());
});

/* Focus the tab the user already has open rather than piling up new ones, and deep-link it to the
 * exact job. Only if nothing is open do we launch a window. */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/?ide=1";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        try { c.postMessage({ type: "ide-open", url }); } catch {}
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
