// Лёгкий сервис-воркер: делает сайт устанавливаемым и ускоряет оболочку. Файлы и API не кэшируются.
const CACHE = 'zatsep-shell-v1';
const SHELL = ['/', '/css/app.css', '/js/main.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/') || url.pathname === '/share-target' || req.headers.has('range')) return;
  // сеть в приоритете, кэш — запасной вариант (оффлайн-оболочка)
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.pathname === '/' || /\.(css|js|svg|webmanifest|png)$/.test(url.pathname))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('/'))));
});
