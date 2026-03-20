// Minimal no-op service worker — replaces old caching SW
// Does nothing, caches nothing, just exists to take over the registration
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(n) { return caches.delete(n); }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});
// No fetch handler — all requests go straight to network
