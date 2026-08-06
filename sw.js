// عزبة service worker — installable + fast, WITHOUT trapping players on a
// stale build:
//   • The cache name is tied to the deployed build. A new deploy ships a new
//     CACHE, so the new SW installs, wipes the old cache, and the page's
//     `controllerchange` handler reloads once onto the fresh build.
//   • Navigations (the game HTML) are CACHE-FIRST for an INSTANT launch, with a
//     background refresh that re-caches the newest shell every time — so even
//     without the reload, the next launch is already fresh. Fast AND self-healing.
//   • Same-origin static assets are cache-first with a background refresh.
//   • Cross-origin requests (Firebase SDK, fonts, R2 video) pass through
//     untouched so none of the cloud behavior changes.
// ⚠️ MUST equal "izzbah-" + IZZBAH_BUILD in game-mobile.html. This froze at
// .203 for four deploys, so phones kept launching the stale cached shell —
// tests/swsync.mjs now fails CI if the two ever drift again.
const CACHE = "izzbah-2026-08-06.260";

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
    // CACHE-FIRST: serve the cached shell instantly, then refresh it in the
    // background (with cache:"reload" so the browser's HTTP cache can't hand
    // back a stale copy). First-ever visit has no cache, so it waits on the
    // network. A brand-new deploy invalidates the cache above, so the very next
    // fetch here misses and pulls the fresh shell.
    event.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req, { cache: "reload" }).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => {
      const refresh = fetch(req).then(res => {
        // Clone SYNCHRONOUSLY, before `res` is returned and its body consumed —
        // cloning later (inside the async caches.open) races the body read and
        // throws "Response body is already used".
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
});
