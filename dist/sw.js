/* Offline assets only; progress always remains in the page's localStorage. */
const CACHE = 'word42-static-2fe87d406e70';
const BASE = new URL('./', self.location).pathname;
const ASSETS = ['index.html','styles.css','app.js','speech.js','engine.js','data/vocabulary.js','data/meta.js','data/learning.js','data/essays.js','icon.svg','icon-192.png','icon-512.png','manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path => BASE+path))).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('word42-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => response.ok ? response : caches.match(BASE+'index.html').then(cached => cached || response)).catch(() => caches.match(BASE+'index.html')));
    return;
  }
  if (!ASSETS.some(path => new URL(event.request.url).pathname === BASE+path)) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
