// sw.js — 溫點辦公室 PWA service worker
// 只做「可安裝 + app 殼快取」，API 一律走網路（不快取即時數據）
const CACHE = 'wp-office-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 只處理同源 GET
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // API / SSE / 動態資料一律走網路，不快取
  if (url.pathname.startsWith('/api/')) return;
  // 其餘（HTML/JS/CSS/圖）：網路優先，失敗回快取（離線也能開殼）
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('/')))
  );
});
