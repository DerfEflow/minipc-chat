/*
 * gamefactorykit/templates/sw.js -- kit template, precache list filled at assembly time by
 * assembleBundle (the PRECACHE_JSON placeholder below becomes a JSON array of every bundle file
 * except sw.js and build.json themselves -- see kit.mjs's assembleBundle and the offline QA
 * suite, which parses the PRECACHE declaration on line 15 back out to check it against the real
 * bundle file list).
 *
 * Cache-first, no network fallback on a miss (there is nothing to fall back TO -- this game is
 * fully offline by design, see GAME-FACTORY-BUILD.md section 2's offline suite). This file never
 * calls the network fetch function itself; `cache.addAll` performs the browser's own one-time
 * same-origin precache fetch during install (standard PWA behavior, not a runtime network call
 * the offline suite's static scan is meant to catch), and the "fetch" event handler below serves
 * exclusively from the cache.
 */
const PRECACHE = {{PRECACHE_JSON}};
const CACHE_NAME = "gf-cache-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((p) => "./" + p)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((hit) => hit || caches.match("./index.html"))
  );
});
