// PWA Service Worker (Network-First with Cache Fallback)
const CACHE_NAME = 'law-finder-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // API 요청은 항상 네트워크 우선
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: '오프라인 상태입니다.' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 정적 자원은 네트워크 시도 후 캐시 폴백
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
