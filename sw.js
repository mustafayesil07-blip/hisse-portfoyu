const CACHE = 'portfoy-v5';

// Scope-relative — GitHub Pages /hisse-portfoyu/ veya root'ta doğru çalışır
const CORE = ['./'];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      // ./  → scope'un kök index.html'ini çeker; hata olursa yoksay (offline kurulumda)
      return c.addAll(CORE).catch(function(){});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(
      keys.filter(function(k){ return k !== CACHE; })
          .map(function(k){ return caches.delete(k); })
    );
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);

  // Dış hostname isteklerini geç — proxy'ye bırak
  if (url.hostname !== self.location.hostname) return;
  // /api/ isteklerini asla cache'leme
  if (url.pathname.startsWith('/api/')) return;

  // ── Navigasyon (HTML sayfa) → Network-first ──────────────────────────
  // Online: her zaman en güncel index.html çekilir ve cache güncellenir
  // Offline: önceki başarılı ziyarette kaydedilmiş cache döner
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function(r) {
        if (r && r.status === 200) {
          var cl = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, cl); });
        }
        return r;
      }).catch(function() {
        // Önce tam URL'yi dene, bulamazsan scope root'unu dene
        return caches.match(e.request).then(function(cached) {
          if (cached) return cached;
          return caches.match(self.registration.scope)
              || caches.match(self.registration.scope + 'index.html');
        });
      })
    );
    return;
  }

  // ── Diğer statik dosyalar → Cache-first ──────────────────────────────
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(r) {
        if (r && r.status === 200) {
          var cl = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, cl); });
        }
        return r;
      }).catch(function() {});
    })
  );
});
