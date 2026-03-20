// Scratchy — Tauri Bridge
//
// Detects Tauri environment and wires Rust backend commands.
// In browser mode: does nothing (serve.js handles everything).
// In Tauri mode: enables Rust command panel + gateway bridge.

(function() {
  var isTauri = window.__TAURI__ !== undefined;

  if (!isTauri) {
    console.log("[Scratchy] Browser mode");
    return;
  }

  console.log("[Scratchy] Tauri mode — Rust backend active");

  // Rust command panel
  var toggleBtn = document.getElementById("rust-toggle");
  var panel = document.getElementById("rust-panel");
  var closeBtn = document.getElementById("rust-panel-close");
  var resultEl = document.getElementById("rust-result");

  if (toggleBtn) toggleBtn.style.display = "";
  
  toggleBtn.addEventListener("click", function() {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  closeBtn.addEventListener("click", function() {
    panel.style.display = "none";
  });

  // Wire command buttons
  var cmdButtons = document.querySelectorAll(".rust-cmd");
  for (var i = 0; i < cmdButtons.length; i++) {
    cmdButtons[i].addEventListener("click", function() {
      var cmd = this.getAttribute("data-cmd");
      var args = JSON.parse(this.getAttribute("data-args"));

      resultEl.textContent = "Calling " + cmd + "...";
      resultEl.className = "rust-result loading";

      window.__TAURI__.core.invoke(cmd, args)
        .then(function(result) {
          resultEl.textContent = "✅ " + result;
          resultEl.className = "rust-result success";
        })
        .catch(function(error) {
          resultEl.textContent = "❌ " + error;
          resultEl.className = "rust-result error";
        });
    });
  }

  // Gateway event listener — receives messages from Rust backend
  var listen = window.__TAURI__.event.listen;
  listen("gateway-message", function(event) {
    console.log("[Tauri] Gateway:", event.payload);
    var frame = JSON.parse(event.payload);
    // TODO: wire into existing message rendering pipeline
  });
})();
