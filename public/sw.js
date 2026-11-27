// PWA Service Worker (Network-First with Real Cache Fallback, GET Same-Origin Only)
const CACHE_NAME = 'law-finder-v2.1.0';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css?v=2.1.0',
  '/app.js?v=2.1.0',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/version.json' ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(
            JSON.stringify({ success: false, error: '현재 오프라인 상태입니다. 네트워크 연결을 확인해 주세요.' }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
          )
      )
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
  );
});
