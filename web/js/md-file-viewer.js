// ============================================
// Scratchy — Markdown File Viewer
// ============================================
// Opens workspace .md files in a viewer panel.
// Fetches file content from /api/workspace-file and
// delegates rendering to showMarkdownViewer (provided
// by the UI component layer).

window.openWorkspaceFile = function(filepath) {
  if (!filepath) return;

  var url = '/api/workspace-file?path=' + encodeURIComponent(filepath);

  fetch(url, { credentials: 'same-origin' })
    .then(function(res) {
      if (!res.ok) {
        return res.json().then(function(data) {
          throw new Error(data.error || ('HTTP ' + res.status));
        }).catch(function(e) {
          if (e.message) throw e;
          throw new Error('HTTP ' + res.status);
        });
      }
      return res.json();
    })
    .then(function(data) {
      if (typeof window.showMarkdownViewer === 'function') {
        window.showMarkdownViewer(data.path, data.content);
      } else {
        console.log('[md-file-viewer] showMarkdownViewer not yet available. path:', data.path, 'content length:', data.content.length);
      }
    })
    .catch(function(err) {
      var msg = 'Could not open file: ' + err.message;
      if (typeof showToast === 'function') {
        showToast(msg, 'error');
      } else {
        alert(msg);
      }
    });
};

// Stub — will be replaced by the UI component
if (typeof window.showMarkdownViewer !== 'function') {
  window.showMarkdownViewer = function(path, content) {
    console.log('[md-file-viewer] stub showMarkdownViewer called for:', path, '(' + content.length + ' chars)');
  };
}
