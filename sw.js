// 版本號改了就會更新快取
const VERSION = 'v16';
const SHELL = `shell-${VERSION}`;
const VENDOR = 'vendor-v1'; // 辨識引擎與字庫很大，版本獨立，避免每次更新重新下載
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'parser.js', 'ai.js', 'enhance.js', 'manifest.webmanifest',
  'vendor/tesseract.min.js', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 引擎與字庫：快取優先
  if (url.pathname.includes('/vendor/core/') || url.pathname.includes('/vendor/lang/') || url.pathname.endsWith('/vendor/worker.min.js')) {
    e.respondWith(
      caches.open(VENDOR).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // 其他：網路優先，離線時用快取
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
