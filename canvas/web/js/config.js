// Canvas config — also sets SCRATCHY_CONFIG so symlinked connection.js works
var SCRATCHY_CANVAS_CONFIG = {
  serverUrl: "auto",
  gatewayPort: 28945,
  sessionKey: "agent:main:main",
  authToken: ""
};

// Auto-detect server URL
if (SCRATCHY_CANVAS_CONFIG.serverUrl === "auto") {
  SCRATCHY_CANVAS_CONFIG.serverUrl = window.location.origin;
}

// Read auth from cookie — try canvas cookie first, then chat cookie (same token)
(function() {
  var cookies = document.cookie.split(";");
  for (var i = 0; i < cookies.length; i++) {
    var c = cookies[i].trim();
    if (c.startsWith("scratchy_canvas_auth=")) {
      SCRATCHY_CANVAS_CONFIG.authToken = c.substring("scratchy_canvas_auth=".length);
      break;
    }
    if (c.startsWith("scratchy_auth=")) {
      SCRATCHY_CANVAS_CONFIG.authToken = c.substring("scratchy_auth=".length);
    }
  }
})();

// Bridge: connection.js and login.js reference SCRATCHY_CONFIG globally
var SCRATCHY_CONFIG = SCRATCHY_CANVAS_CONFIG;

var SCRATCHY_GENUI_ENABLED = true; // Always on in canvas mode
