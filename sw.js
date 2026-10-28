// Offline support: keeps the app shell and libraries on the phone.
// Database / file traffic (supabase.co) is never cached.
const CACHE = "mp-v1.5.0";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./queue.js", "./scan.js",
  "./manifest.webmanifest", "./icon-192.png", "./apple-touch-icon.png"];
const LIBS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.all(LIBS.map((u) => c.add(u).catch(() => {})));
  }));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("supabase.in")) return;

  if (url.origin === location.origin) {
    // app files: network first (get updates), fall back to cache when offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))));
    return;
  }
  if (url.hostname === "cdn.jsdelivr.net") {
    // libraries (and the modules they import): cache first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
