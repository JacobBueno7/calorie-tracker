// Offline support: cache the app shell. Data lives on the device (IndexedDB/localStorage), API calls go to the network.
const CACHE = "ct-__BUILD__";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png"];
// The big food list has a content-hashed name, so it can be cached until the data changes.
const FOODS_CACHE = "ct-foods";
const FOODS_FILE = "__FOODS_DB__";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && k !== FOODS_CACHE).map((k) => caches.delete(k)));
      // Drop older versions of the food list.
      const foods = await caches.open(FOODS_CACHE);
      for (const req of await foods.keys()) if (!req.url.endsWith("/" + FOODS_FILE)) await foods.delete(req);
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (/\/foods-[0-9a-f]+\.json$/.test(url.pathname)) {
    // Cache first: the name changes whenever the content does.
    e.respondWith(
      caches.open(FOODS_CACHE).then((c) =>
        c.match(e.request).then(
          (hit) =>
            hit ||
            fetch(e.request).then((res) => {
              if (res.ok) c.put(e.request, res.clone());
              return res;
            })
        )
      )
    );
    return;
  }
  // Network first (so updates arrive), fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
