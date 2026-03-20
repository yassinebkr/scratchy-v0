// Version check — polls /api/version, shows update toast, handles PWA-safe reload
(function() {
  "use strict";

  var currentHash = null;
  var currentVersion = null;
  var toastShown = false;

  function checkVersion() {
    fetch('/api/version', { cache: 'no-store' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.hash && !data.version) return;

        var serverKey = (data.hash || '') + ':' + (data.version || '');

        if (currentHash === null) {
          // First check — store baseline
          currentHash = serverKey;
          currentVersion = data.version || null;
          return;
        }

        if (serverKey !== currentHash && !toastShown) {
          toastShown = true;
          showUpdateToast(data);
        }
      })
      .catch(function() { /* silent */ });
  }

  function showUpdateToast(data) {
    var versionLabel = data.version ? ' (' + data.version + ')' : '';

    var toast = document.createElement('div');
    toast.className = 'version-toast';
    toast.innerHTML =
      '<div class="version-toast-content">' +
        '<span class="version-toast-icon">🔄</span>' +
        '<span class="version-toast-text">Update available' + versionLabel + '</span>' +
        '<button class="version-toast-btn" id="version-update-btn">Update</button>' +
        '<button class="version-toast-close" id="version-close-btn">✕</button>' +
      '</div>';
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(function() {
      toast.classList.add('version-toast-visible');
    });

    // Wire update button — hard reload that bypasses all caches
    document.getElementById('version-update-btn').addEventListener('click', function() {
      performUpdate();
    });

    // Wire close button
    document.getElementById('version-close-btn').addEventListener('click', function() {
      toast.classList.remove('version-toast-visible');
      setTimeout(function() { toast.remove(); }, 300);
    });
  }

  function performUpdate() {
    // 1. Clear any Cache API storage (Service Worker caches)
    if (typeof caches !== 'undefined' && caches.keys) {
      caches.keys().then(function(names) {
        return Promise.all(names.map(function(name) { return caches.delete(name); }));
      }).catch(function() {});
    }

    // 2. Clear cached message store (prevents stale HTML/component references)
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('scratchy-messages-') === 0) {
          localStorage.removeItem(keys[i]);
        }
      }
    } catch(e) {}

    // 3. Force reload — navigate to cache-busted URL to bypass all PWA/browser caches
    // This works in Android TWA, iOS Safari standalone, desktop PWA, and regular browser
    var url = new URL(window.location.href);
    url.searchParams.set('_update', Date.now());
    window.location.replace(url.toString());
  }

  // Expose for manual trigger (e.g. from settings panel)
  window._scratchyCheckUpdate = checkVersion;
  window._scratchyForceUpdate = performUpdate;

  // On load: strip the _update param from URL (left over from forced update)
  try {
    var loc = new URL(window.location.href);
    if (loc.searchParams.has('_update')) {
      loc.searchParams.delete('_update');
      window.history.replaceState(null, '', loc.pathname + loc.search + loc.hash);
    }
  } catch(e) {}

  // Start polling after 15s, then every 60s
  setTimeout(function() {
    checkVersion();
    setInterval(checkVersion, 60000);
  }, 15000);
})();
