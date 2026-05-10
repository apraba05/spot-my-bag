// SpotMyBag service worker — network-first for HTML so updates propagate
// immediately, cache-first for icons/og.
const CACHE = "spotmybag-v11";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
  "./og.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        // Tell every controlled page to reload so the new shell is shown immediately.
        const clients = await self.clients.matchAll({ type: "window" });
        for (const c of clients) c.postMessage({ type: "SW_UPDATED", cache: CACHE });
      })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept the xAI API or our own /api/* — always go to network.
  if (url.hostname.endsWith("x.ai") || url.hostname.endsWith("api.x.ai")) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_vercel/")) return;

  // Same-origin only.
  if (url.origin !== self.location.origin) return;

  // HTML and the manifest must be fresh: network-first, fall back to cache when offline.
  const isHtml = req.mode === "navigate" ||
                 req.destination === "document" ||
                 url.pathname.endsWith(".html") ||
                 url.pathname === "/" ||
                 url.pathname.endsWith("manifest.json");

  if (isHtml) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Other static assets: cache-first, refresh in background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === "basic") cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
