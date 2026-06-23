// R.E.P.S Service Worker — mode hors-ligne
const CACHE_NAME = 'reps-v15';
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
  '/censured.mp3','/cartier.mp3','/crime.mp3','/cyrilgane.mp3','/introduction.mp3','/vibes.mp3',
  '/brian-fr.mp3',
  '/brian-en.mp3',
  '/beep.mp3',
  '/tick.mp3',
  '/fr-1.mp3','/fr-2.mp3','/fr-3.mp3','/fr-4.mp3','/fr-5.mp3',
  '/en-1.mp3','/en-2.mp3','/en-3.mp3','/en-4.mp3','/en-5.mp3',
  '/round-2.mp3','/round-3.mp3','/round-4.mp3','/round-5.mp3','/round-6.mp3',
  '/round-7.mp3','/round-8.mp3','/round-9.mp3','/round-10.mp3',
  '/rest.mp3',
  '/time.mp3','/last-minute.mp3','/ten-sec.mp3','/thirty-sec.mp3',
  '/three-min.mp3','/two-min.mp3','/halfway.mp3',
    '/count-en-10.mp3','/count-en-9.mp3','/count-en-8.mp3','/count-en-7.mp3','/count-en-6.mp3',
    '/count-en-5.mp3','/count-en-4.mp3','/count-en-3.mp3','/count-en-2.mp3','/count-en-1.mp3','/count-en-go.mp3',
    '/time-fr.mp3','/last-minute-fr.mp3','/ten-sec-fr.mp3','/thirty-sec-fr.mp3',
    '/three-min-fr.mp3','/two-min-fr.mp3','/halfway-fr.mp3','/rest-fr.mp3',
    '/round-2-fr.mp3','/round-3-fr.mp3','/round-4-fr.mp3','/round-5-fr.mp3','/round-6-fr.mp3',
    '/round-7-fr.mp3','/round-8-fr.mp3','/round-9-fr.mp3','/round-10-fr.mp3',
    '/count-fr-10.mp3','/count-fr-9.mp3','/count-fr-8.mp3','/count-fr-7.mp3','/count-fr-6.mp3',
    '/count-fr-5.mp3','/count-fr-4.mp3','/count-fr-3.mp3','/count-fr-2.mp3','/count-fr-1.mp3','/count-fr-go.mp3'
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
