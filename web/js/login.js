// ============================================
// Scratchy — Login Page Logic
// ============================================
// Handles token submission via POST /api/auth.
// Token never appears in URL — only sent in request body.
// ============================================

(function() {
  // Auto-login from localStorage (iOS PWA cookie restoration)
  // iOS PWA loses HttpOnly cookies on restart — restore session via saved key
  // Runs async — never blocks the login form from rendering
  try {
    var savedSession = localStorage.getItem("scratchy_session_key");
    if (savedSession) {
      setTimeout(function() {
        fetch("/api/restore-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey: savedSession }),
          credentials: "same-origin"
        }).then(function(res) {
          if (res.ok) {
            window.location.href = "/";
          } else {
            localStorage.removeItem("scratchy_session_key");
          }
        }).catch(function() {});
      }, 0);
    }
  } catch(e) {}

  var form = document.getElementById("login-form");
  var tokenInput = document.getElementById("token");
  var csrfInput = document.getElementById("csrf");
  var toggleBtn = document.getElementById("toggle-vis");
  var submitBtn = document.getElementById("submit-btn");
  var errorEl = document.getElementById("error");
  var lockoutEl = document.getElementById("lockout");

  // Read CSRF token from the meta tag injected by serve.js
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  if (csrfMeta) {
    csrfInput.value = csrfMeta.getAttribute("content");
  }

  // Show/hide token toggle
  toggleBtn.addEventListener("click", function() {
    var isPassword = tokenInput.type === "password";
    tokenInput.type = isPassword ? "text" : "password";
    toggleBtn.textContent = isPassword ? "🙈" : "👁";
    tokenInput.focus();
  });

  // Show error message
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add("visible");
    // Re-trigger shake animation
    errorEl.style.animation = "none";
    errorEl.offsetHeight; // force reflow
    errorEl.style.animation = "";
  }

  function hideError() {
    errorEl.classList.remove("visible");
  }

  function setLoading(loading) {
    if (loading) {
      submitBtn.classList.add("loading");
      submitBtn.disabled = true;
      tokenInput.disabled = true;
    } else {
      submitBtn.classList.remove("loading");
      submitBtn.disabled = false;
      tokenInput.disabled = false;
      tokenInput.focus();
    }
  }

  // Form submission
  form.addEventListener("submit", function(e) {
    e.preventDefault();
    hideError();

    var token = tokenInput.value.trim();
    if (!token) {
      showError("Please enter a token.");
      return;
    }

    setLoading(true);

    fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token,
        csrf: csrfInput.value
      })
    })
    .then(function(res) {
      return res.json().then(function(data) {
        return { status: res.status, data: data };
      });
    })
    .then(function(result) {
      setLoading(false);

      if (result.data.ok) {
        // Save session key to localStorage (iOS PWA loses cookies on restart)
        if (result.data.sessionKey) {
          try { localStorage.setItem("scratchy_session_key", result.data.sessionKey); } catch(e) {}
        }
        // Success — server set cookies, redirect to app
        window.location.href = "/";
        return;
      }

      // Handle errors
      if (result.data.lockout) {
        // Locked out
        form.style.display = "none";
        lockoutEl.textContent = result.data.error || "Too many failed attempts. Try again later.";
        lockoutEl.classList.add("visible");

        // Show countdown if retryAfter is provided
        if (result.data.retryAfter) {
          var remaining = Math.ceil(result.data.retryAfter / 1000);
          var interval = setInterval(function() {
            remaining--;
            if (remaining <= 0) {
              clearInterval(interval);
              lockoutEl.classList.remove("visible");
              form.style.display = "";
              tokenInput.value = "";
              tokenInput.focus();
            } else {
              lockoutEl.textContent = "Too many failed attempts. Try again in " + remaining + "s.";
            }
          }, 1000);
        }
      } else {
        showError(result.data.error || "Invalid token.");
        tokenInput.select();
      }
    })
    .catch(function(err) {
      setLoading(false);
      showError("Server unreachable. Check your connection.");
      console.error("[Scratchy] Auth error:", err);
    });
  });

  // Focus input on load
  tokenInput.focus();
})();
