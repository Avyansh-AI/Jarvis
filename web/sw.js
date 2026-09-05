/* Jarvis service worker — app-shell cache for the PWA/mobile companion.
   API + websockets always go to the network (never cached, never logged). */
const SHELL = 'jarvis-shell-v2';
const ASSETS = [
  'index.html', 'dashboard.html', 'settings.html', 'logs.html', 'systems.html', 'vision.html', 'meeting.html',
  'css/theme.css', 'js/common.js', 'js/wakeword.js', 'js/widgets.js', 'icon.svg', 'icon-maskable.svg', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return; // always network
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
