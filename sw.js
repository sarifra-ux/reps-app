// R.E.P.S Service Worker — mode hors-ligne
const CACHE_NAME = 'reps-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/pogo.mp3',
  '/pleinfeu.mp3',
  '/techno.mp3',
  '/house.mp3',
  '/hymne.mp3',
  '/brian-fr.mp3',
  '/brian-en.mp3',
  '/beep.mp3',
  '/tick.mp3'
];

// Installation : on précharge tous les fichiers
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activation : on supprime les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch : on sert depuis le cache en priorité (offline-first)
self.addEventListener('fetch', (event) => {
  // Seulement les requêtes GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      // Sinon on tente le réseau et on met en cache
      return fetch(event.request).then((response) => {
        // Ne pas mettre en cache les réponses non-OK
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        // Si offline et pas en cache, retourner index.html pour la navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
