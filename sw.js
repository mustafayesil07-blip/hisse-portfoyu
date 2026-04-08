const CACHE = 'portfoy-v4';
const CORE = ['/', '/index.html'];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(CORE); }));
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if(e.request.method !== 'GET') return;
  var url = new URL(e.request.url);

  // API isteklerini asla cache'leme — her zaman network'ten al
  if(url.hostname !== self.location.hostname) return;
  if(url.pathname.startsWith('/api/')) return;

  // index.html için network-first: güncel versiyonu her zaman al
  var isNav = e.request.mode === 'navigate' ||
              url.pathname === '/' ||
              url.pathname === '/index.html';

  if(isNav) {
    e.respondWith(
      fetch(e.request).then(function(r) {
        if(r && r.status === 200) {
          var cl = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, cl); });
        }
        return r;
      }).catch(function() {
        return caches.match('/index.html');
      })
    );
    return;
  }

  // Diğer statik dosyalar için cache-first
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if(cached) return cached;
      return fetch(e.request).then(function(r) {
        if(r && r.status === 200) {
          var cl = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, cl); });
        }
        return r;
      }).catch(function() {});
    })
  );
});
