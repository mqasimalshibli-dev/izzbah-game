// عزبة service worker — makes the game installable and launchable offline
// WITHOUT ever trapping players on a stale version:
//   • navigations (the game HTML) are NETWORK-FIRST — every launch fetches the
//     newest deployed build; the cache is only the offline fallback.
//   • same-origin static assets are cache-first with a background refresh.
//   • cross-origin requests (Firebase SDK, fonts, R2 video) pass through
//     untouched so none of the cloud behavior changes.
const CACHE = "izzbah-v1";

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cloud/CDN traffic untouched

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => {
      const refresh = fetch(req).then(res => {
        if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
});
