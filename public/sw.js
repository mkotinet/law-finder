// PWA Service Worker (Network-First with Real Cache Fallback, GET Same-Origin Only)
const CACHE_NAME = 'law-finder-v2.0.0';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css?v=2.0.0',
  '/app.js?v=2.0.0',
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
  // GET 요청 및 동일 출처 HTTP(S)만 처리 (POST / 외부 확장 프로그램 무시)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // API 및 버전/매니페스트는 항상 네트워크 전용
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

  // 정적 자산: Network-First + 성공 응답 캐시 갱신 + 오프라인 폴백
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
