// ============================================
// Scratchy — Login v2 (Multi-user Auth)
// ============================================
// Handles: passkey login, email+password login, bootstrap registration.
// Uses raw navigator.credentials API — no external dependencies.
// ============================================

(function () {
  'use strict';

  // ─── State ───
  var currentMode = 'loading';
  var lockoutTimer = null;
  var csrfToken = '';
  var passkeyAvailable = false;
  var sessionData = null; // set after successful auth
  var selectedLanguage = null; // set by language chooser or localStorage

  // ─── DOM Refs ───
  var card = document.getElementById('login-card');
  var subtitle = document.getElementById('subtitle');
  var errorMsg = document.getElementById('error-msg');
  var successMsg = document.getElementById('success-msg');
  var lockoutMsg = document.getElementById('lockout-msg');

  // Mode panels
  var modeLanguage = document.getElementById('mode-language');
  var modeLoading = document.getElementById('mode-loading');
  var modeLogin = document.getElementById('mode-login');
  var modeBootstrap = document.getElementById('mode-bootstrap');
  var modePlanChoice = document.getElementById('mode-plan-choice');
  var modeProviderKey = document.getElementById('mode-provider-key');
  var modePasskeySetup = document.getElementById('mode-passkey-setup');

  // Login form elements
  var passkeySection = document.getElementById('passkey-section');
  var btnPasskeyLogin = document.getElementById('btn-passkey-login');
  var loginForm = document.getElementById('login-form');
  var loginEmail = document.getElementById('login-email');
  var loginPassword = document.getElementById('login-password');
  var btnLogin = document.getElementById('btn-login');

  // Registration form elements
  var registerForm = document.getElementById('register-form');
  var regName = document.getElementById('reg-name');
  var regEmail = document.getElementById('reg-email');
  var regPassword = document.getElementById('reg-password');
  var regPasswordConfirm = document.getElementById('reg-password-confirm');
  var btnRegister = document.getElementById('btn-register');

  // Plan choice elements
  var btnPlanOwnKey = document.getElementById('plan-own-key');
  var btnPlanHosted = document.getElementById('plan-hosted');

  // Provider key elements
  var providerSelect = document.getElementById('provider-select');
  var providerKeyInput = document.getElementById('provider-key-input');
  var providerSelectedLabel = document.getElementById('provider-selected-label');
  var providerSelectedIcon = document.getElementById('provider-selected-icon');
  var providerSelectedName = document.getElementById('provider-selected-name');
  var providerApiKey = document.getElementById('provider-api-key');
  var providerKeyHint = document.getElementById('provider-key-hint');
  var btnValidateKey = document.getElementById('btn-validate-key');
  var btnBackProvider = document.getElementById('btn-back-provider');
  var btnSkipProvider = document.getElementById('btn-skip-provider');
  var selectedProvider = null;

  // Passkey setup elements
  var btnAddPasskey = document.getElementById('btn-add-passkey');
  var btnSkipPasskey = document.getElementById('btn-skip-passkey');

  // ─── Base64url Helpers ───

  function arrayBufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function base64urlToArrayBuffer(base64url) {
    // Restore standard base64
    var base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // ─── CSRF ───

  function getCsrf() {
    if (csrfToken) return csrfToken;
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) csrfToken = meta.getAttribute('content') || '';
    return csrfToken;
  }

  // ─── API Helper ───

  function api(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    };

    var csrf = getCsrf();
    if (csrf) {
      opts.headers['X-CSRF-Token'] = csrf;
    }

    if (body) {
      opts.body = JSON.stringify(body);
    }

    return fetch(path, opts).then(function (res) {
      // Handle 429 specially
      if (res.status === 429) {
        return res.json().then(function (data) {
          return { status: 429, data: data };
        }).catch(function () {
          return { status: 429, data: { error: 'Too many requests. Please wait.' } };
        });
      }
      return res.json().then(function (data) {
        return { status: res.status, data: data, headers: res.headers };
      }).catch(function () {
        return { status: res.status, data: {}, headers: res.headers };
      });
    });
  }

  // ─── UI Helpers ───

  function showError(msg) {
    successMsg.classList.remove('visible');
    errorMsg.textContent = msg;
    errorMsg.classList.add('visible');
    // Retrigger shake
    errorMsg.classList.remove('shake');
    void errorMsg.offsetHeight; // force reflow
    errorMsg.classList.add('shake');
  }

  function hideError() {
    errorMsg.classList.remove('visible', 'shake');
  }

  function showSuccess(msg) {
    hideError();
    successMsg.textContent = msg;
    successMsg.classList.add('visible');
  }

  function hideSuccess() {
    successMsg.classList.remove('visible');
  }

  function showLockout(retryAfterMs) {
    var remaining = Math.ceil((retryAfterMs || 60000) / 1000);
    lockoutMsg.classList.add('visible');
    hideError();

    function updateTimer() {
      if (remaining <= 0) {
        lockoutMsg.classList.remove('visible');
        clearInterval(lockoutTimer);
        lockoutTimer = null;
        setFormEnabled(true);
        return;
      }
      lockoutMsg.innerHTML = 'Too many attempts. Try again in <span class="lockout-timer">' + remaining + 's</span>';
      remaining--;
    }

    updateTimer();
    if (lockoutTimer) clearInterval(lockoutTimer);
    lockoutTimer = setInterval(updateTimer, 1000);
    setFormEnabled(false);
  }

  function hideLockout() {
    lockoutMsg.classList.remove('visible');
    if (lockoutTimer) {
      clearInterval(lockoutTimer);
      lockoutTimer = null;
    }
  }

  function setFormEnabled(enabled) {
    var inputs = card.querySelectorAll('input, button[type="submit"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].disabled = !enabled;
    }
    if (btnPasskeyLogin) btnPasskeyLogin.disabled = !enabled;
  }

  function setBtnLoading(btn, loading) {
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // ─── Mode Switching ───

  function showMode(mode) {
    var panels = {
      language: modeLanguage,
      loading: modeLoading,
      login: modeLogin,
      bootstrap: modeBootstrap,
      'plan-choice': modePlanChoice,
      'provider-key': modeProviderKey,
      'passkey-setup': modePasskeySetup
    };

    // Hide all, show requested
    var keys = Object.keys(panels);
    for (var i = 0; i < keys.length; i++) {
      var panel = panels[keys[i]];
      if (keys[i] === mode) {
        panel.classList.remove('exiting');
        panel.classList.add('active');
      } else {
        panel.classList.remove('active', 'exiting');
      }
    }

    hideError();
    hideSuccess();
    hideLockout();
    currentMode = mode;

    // Update subtitle
    // Subtitle uses i18n system
    var subtitleKeys = {
      language: 'sub.language',
      loading: 'sub.loading',
      login: 'sub.login',
      bootstrap: 'sub.bootstrap',
      'plan-choice': 'sub.plan',
      'provider-key': 'sub.provider',
      'passkey-setup': 'sub.passkey'
    };
    var subKey = subtitleKeys[mode];
    if (subKey && window.I18N) {
      subtitle.textContent = window.I18N.t(subKey);
    }

    // Auto-focus first input
    var activePanel = panels[mode];
    if (activePanel) {
      var firstInput = activePanel.querySelector('input:not([type="hidden"])');
      if (firstInput) {
        setTimeout(function () { firstInput.focus(); }, 100);
      }
    }
  }

  // ─── Feature Detection ───

  function checkPasskeySupport() {
    if (!window.PublicKeyCredential) return false;
    // Check if conditional mediation or platform authenticator is available
    passkeyAvailable = true;
    return true;
  }

  // ─── Auth State Check ───

  function checkAuthState() {
    showMode('loading');

    // Try restoring iOS PWA session first
    var savedSession = null;
    try {
      savedSession = localStorage.getItem('scratchy_session_id');
    } catch (e) { /* ignore */ }

    if (savedSession) {
      // Attempt session restoration
      api('POST', '/api/restore-session', { sessionKey: savedSession })
        .then(function (res) {
          if (res.status === 200 && res.data.ok) {
            window.location.href = '/';
            return;
          }
          // Session invalid, clear it
          try { localStorage.removeItem('scratchy_session_id'); } catch (e) { /* ignore */ }
          doAuthCheck();
        })
        .catch(function () {
          doAuthCheck();
        });
    } else {
      doAuthCheck();
    }
  }

  // Stash auth check result so language selection can proceed
  var _pendingAuthMode = null;
  var _pendingPasskeysAvailable = false;

  function doAuthCheck() {
    // Check both auth state and bootstrap status in parallel
    var mePromise = fetch('/api/v2/auth/me', { credentials: 'same-origin' });
    var statusPromise = fetch('/api/v2/auth/status', { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .catch(function () { return { hasAdmin: true, multiUser: true }; });

    Promise.all([mePromise, statusPromise])
      .then(function (results) {
        var meRes = results[0];
        var statusData = results[1];

        if (meRes.ok) {
          // Already authenticated — redirect to app
          window.location.href = '/';
          return null; // Signal: don't proceed to language/login
        }

        // Check if bootstrap (no admin) is needed
        if (!statusData.hasAdmin) {
          _pendingAuthMode = 'bootstrap';
        } else {
          _pendingAuthMode = 'login';
        }

        // Try to get passkey availability from me response
        return meRes.json().then(function (data) {
          if (data.passkeysAvailable) {
            _pendingPasskeysAvailable = true;
          }
          return 'proceed';
        }).catch(function () {
          // JSON parse failed — that's fine, defaults are set
          return 'proceed';
        });
      })
      .then(function (action) {
        if (action === null) return; // Redirecting, skip
        showPostLanguageMode();
      })
      .catch(function () {
        _pendingAuthMode = 'login';
        showPostLanguageMode();
        var _tc = window.I18N ? window.I18N.t : function(k) { return k; };
        showError(_tc('err.connection'));
      });
  }

  function showPostLanguageMode() {
    // Check if language already chosen
    try { selectedLanguage = localStorage.getItem('scratchy_lang'); } catch (e) { /* ignore */ }

    // Fallback: detect from browser language (helps in incognito where localStorage is empty)
    if (!selectedLanguage) {
      var browserLang = (navigator.language || navigator.userLanguage || '').split('-')[0].toLowerCase();
      var supported = { en: true, fr: true, ar: true, it: true };
      if (supported[browserLang]) {
        selectedLanguage = browserLang;
        try { localStorage.setItem('scratchy_lang', browserLang); } catch (e) { /* ignore */ }
        if (browserLang === 'ar') {
          document.documentElement.setAttribute('dir', 'rtl');
        }
        if (window.I18N) {
          window.I18N.applyI18n(browserLang);
        }
      }
    }

    if (!selectedLanguage) {
      // Show language selection first
      showMode('language');
      return;
    }

    // Language already set — proceed to login or bootstrap
    showAuthMode();
  }

  function showAuthMode() {
    if (_pendingAuthMode === 'bootstrap') {
      showMode('bootstrap');
    } else {
      if (checkPasskeySupport() && _pendingPasskeysAvailable) {
        passkeySection.style.display = '';
      } else {
        passkeySection.style.display = 'none';
      }
      showMode('login');
    }
  }

  // ─── Handle Password Login ───

  function handlePasswordLogin(email, password) {
    hideError();
    setBtnLoading(btnLogin, true);

    api('POST', '/api/v2/auth/login', { email: email, password: password })
      .then(function (res) {
        setBtnLoading(btnLogin, false);

        if (res.status === 429) {
          var retryMs = (res.data.retryAfter) || 60000;
          showLockout(retryMs);
          return;
        }

        if (res.data.ok) {
          if (res.data.sessionId) {
            try { localStorage.setItem('scratchy_session_id', res.data.sessionId); } catch (e) { /* ignore */ }
          }
          if (res.data.agentSessionKey) {
            try { localStorage.setItem('scratchy_agent_key', res.data.agentSessionKey); } catch (e) { /* ignore */ }
          }
          // Save language pref to server now that we're authenticated
          if (selectedLanguage) {
            api('POST', '/api/v2/auth/language', { language: selectedLanguage }).catch(function(){});
          }
          sessionData = res.data;
          proceedAfterPlan();
          return;
        }

        var _t = window.I18N ? window.I18N.t : function(k) { return k; };
        showError(res.data.error || _t('err.login.fail'));
        loginPassword.select();
      })
      .catch(function (err) {
        setBtnLoading(btnLogin, false);
        var _t = window.I18N ? window.I18N.t : function(k) { return k; };
        showError(_t('err.retry'));
        console.error('[Scratchy] Login error:', err);
      });
  }

  // ─── Handle Passkey Login ───

  function handlePasskeyLogin() {
    hideError();
    setBtnLoading(btnPasskeyLogin, true);

    // Step 1: Get authentication options from server
    var emailHint = loginEmail.value.trim() || undefined;
    api('POST', '/api/v2/auth/passkey/login/options', { email: emailHint })
      .then(function (res) {
        if (res.status === 429) {
          setBtnLoading(btnPasskeyLogin, false);
          var retryMs = (res.data.retryAfter) || 60000;
          showLockout(retryMs);
          return;
        }

        if (!res.data.options) {
          setBtnLoading(btnPasskeyLogin, false);
          showError(res.data.error || 'Passkey login not available.');
          return;
        }

        var options = res.data.options;
        var challengeToken = res.data.challengeToken;

        // Convert base64url fields to ArrayBuffer for the browser API
        var publicKeyOptions = {
          challenge: base64urlToArrayBuffer(options.challenge),
          timeout: options.timeout || 60000,
          rpId: options.rpId || window.location.hostname,
          userVerification: options.userVerification || 'preferred'
        };

        // Convert allowCredentials if present
        if (options.allowCredentials && options.allowCredentials.length > 0) {
          publicKeyOptions.allowCredentials = options.allowCredentials.map(function (cred) {
            return {
              type: cred.type || 'public-key',
              id: base64urlToArrayBuffer(cred.id),
              transports: cred.transports
            };
          });
        }

        // Step 2: Call navigator.credentials.get()
        return navigator.credentials.get({ publicKey: publicKeyOptions })
          .then(function (credential) {
            // Step 3: Serialize and send to server
            var response = {
              id: credential.id,
              rawId: arrayBufferToBase64url(credential.rawId),
              type: credential.type,
              response: {
                authenticatorData: arrayBufferToBase64url(credential.response.authenticatorData),
                clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
                signature: arrayBufferToBase64url(credential.response.signature)
              }
            };

            if (credential.response.userHandle) {
              response.response.userHandle = arrayBufferToBase64url(credential.response.userHandle);
            }

            return api('POST', '/api/v2/auth/passkey/login/verify', {
              response: response,
              challengeToken: challengeToken
            });
          })
          .then(function (verifyRes) {
            setBtnLoading(btnPasskeyLogin, false);

            if (!verifyRes) return; // was handled above (429)

            if (verifyRes.data.ok) {
              // Save session
              if (verifyRes.data.sessionId) {
                try { localStorage.setItem('scratchy_session_id', verifyRes.data.sessionId); } catch (e) { /* ignore */ }
              }
              redirectToApp();
            } else {
              showError(verifyRes.data.error || 'Passkey verification failed.');
            }
          });
      })
      .catch(function (err) {
        setBtnLoading(btnPasskeyLogin, false);

        if (err.name === 'NotAllowedError') {
          // User cancelled — don't show error, just reset
          return;
        }
        if (err.name === 'SecurityError') {
          var _t2 = window.I18N ? window.I18N.t : function(k) { return k; };
          showError(_t2('err.passkey.https'));
          return;
        }
        if (err.name === 'AbortError') {
          return; // User cancelled or timed out
        }

        var _t = window.I18N ? window.I18N.t : function(k) { return k; };
        showError(_t('err.passkey.fail'));
        console.error('[Scratchy] Passkey error:', err);
      });
  }

  // ─── Handle Registration ───

  function handleRegistration(email, password, displayName) {
    hideError();
    setBtnLoading(btnRegister, true);

    api('POST', '/api/v2/auth/register', {
      email: email,
      password: password,
      displayName: displayName
    })
      .then(function (res) {
        setBtnLoading(btnRegister, false);

        if (res.status === 429) {
          var retryMs = (res.data.retryAfter) || 60000;
          showLockout(retryMs);
          return;
        }

        if (res.data.ok) {
          // Save session for iOS PWA
          if (res.data.sessionId) {
            try { localStorage.setItem('scratchy_session_id', res.data.sessionId); } catch (e) { /* ignore */ }
          }

          sessionData = res.data;
          var _t = window.I18N ? window.I18N.t : function(k) { return k; };
          showSuccess(_t('ok.created'));
          // Save language pref to server
          if (selectedLanguage) {
            api('POST', '/api/v2/auth/language', { language: selectedLanguage }).catch(function(){});
          }

          // Show plan choice before passkey setup
          setTimeout(function () {
            showMode('plan-choice');
          }, 600);
          return;
        }

        showError(res.data.error || 'Registration failed. Please try again.');
      })
      .catch(function (err) {
        setBtnLoading(btnRegister, false);
        showError('Connection failed. Please try again.');
        console.error('[Scratchy] Registration error:', err);
      });
  }

  // ─── Handle Passkey Registration (add passkey to account) ───

  function handlePasskeyRegistration() {
    hideError();
    setBtnLoading(btnAddPasskey, true);

    // Step 1: Get registration options
    api('POST', '/api/v2/auth/passkey/register/options', {})
      .then(function (res) {
        if (!res.data.options) {
          setBtnLoading(btnAddPasskey, false);
          showError(res.data.error || 'Could not set up passkey.');
          return;
        }

        var options = res.data.options;
        var challengeToken = res.data.challengeToken;

        // Build PublicKeyCredentialCreationOptions
        var createOptions = {
          challenge: base64urlToArrayBuffer(options.challenge),
          rp: {
            name: options.rp.name || 'Scratchy',
            id: options.rp.id || window.location.hostname
          },
          user: {
            id: base64urlToArrayBuffer(options.user.id),
            name: options.user.name,
            displayName: options.user.displayName
          },
          pubKeyCredParams: options.pubKeyCredParams || [
            { alg: -7, type: 'public-key' },   // ES256
            { alg: -257, type: 'public-key' }   // RS256
          ],
          timeout: options.timeout || 60000,
          attestation: options.attestation || 'none',
          authenticatorSelection: options.authenticatorSelection || {
            authenticatorAttachment: 'platform',
            residentKey: 'preferred',
            userVerification: 'preferred'
          }
        };

        // Exclude existing credentials
        if (options.excludeCredentials && options.excludeCredentials.length > 0) {
          createOptions.excludeCredentials = options.excludeCredentials.map(function (cred) {
            return {
              type: cred.type || 'public-key',
              id: base64urlToArrayBuffer(cred.id),
              transports: cred.transports
            };
          });
        }

        // Step 2: Create credential
        return navigator.credentials.create({ publicKey: createOptions })
          .then(function (credential) {
            // Step 3: Send to server
            var attestationResponse = {
              id: credential.id,
              rawId: arrayBufferToBase64url(credential.rawId),
              type: credential.type,
              response: {
                attestationObject: arrayBufferToBase64url(credential.response.attestationObject),
                clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON)
              }
            };

            // Include transports if available
            if (typeof credential.response.getTransports === 'function') {
              attestationResponse.response.transports = credential.response.getTransports();
            }

            return api('POST', '/api/v2/auth/passkey/register/verify', {
              response: attestationResponse,
              challengeToken: challengeToken
            });
          })
          .then(function (verifyRes) {
            setBtnLoading(btnAddPasskey, false);

            if (verifyRes && verifyRes.data.ok) {
              var _t3 = window.I18N ? window.I18N.t : function(k) { return k; };
              showSuccess(_t3('ok.passkey'));
              setTimeout(redirectToApp, 800);
            } else {
              showError((verifyRes && verifyRes.data.error) || 'Could not save passkey.');
            }
          });
      })
      .catch(function (err) {
        setBtnLoading(btnAddPasskey, false);

        if (err.name === 'NotAllowedError') {
          // User cancelled
          return;
        }
        if (err.name === 'InvalidStateError') {
          var _tp2 = window.I18N ? window.I18N.t : function(k) { return k; };
          showSuccess(_tp2('ok.passkey.exists'));
          setTimeout(redirectToApp, 800);
          return;
        }

        var _tp = window.I18N ? window.I18N.t : function(k) { return k; };
        showError(_tp('err.passkey.setup'));
        console.error('[Scratchy] Passkey registration error:', err);
      });
  }

  // ─── Handle Language Selection ───

  function handleLanguageChoice(lang) {
    selectedLanguage = lang;
    try { localStorage.setItem('scratchy_lang', lang); } catch (e) { /* ignore */ }

    // Set dir=rtl for Arabic
    if (lang === 'ar') {
      document.documentElement.setAttribute('dir', 'rtl');
    } else {
      document.documentElement.removeAttribute('dir');
    }

    // Apply translations to all UI elements
    if (window.I18N) {
      window.I18N.applyI18n(lang);
    }

    // Proceed to login or bootstrap
    showAuthMode();
  }

  // ─── Provider Key Flow ───

  var PROVIDER_META = {
    openai: { icon: '\u25c8', name: 'OpenAI', color: '#10a37f', hintKey: 'prov.hint.openai', placeholder: 'sk-...' },
    anthropic: { icon: '\u25c6', name: 'Anthropic', color: '#d4a574', hintKey: 'prov.hint.anthropic', placeholder: 'sk-ant-...' },
    google: { icon: '\u25c9', name: 'Google', color: '#4285f4', hintKey: 'prov.hint.google', placeholder: 'AI...' }
  };

  function selectProvider(provider) {
    selectedProvider = provider;
    var meta = PROVIDER_META[provider];
    if (!meta) return;

    providerSelectedIcon.textContent = meta.icon;
    providerSelectedIcon.style.color = meta.color;
    providerSelectedName.textContent = meta.name;
    providerApiKey.placeholder = meta.placeholder;
    var _t = window.I18N ? window.I18N.t : function(k) { return k; };
    providerKeyHint.textContent = _t(meta.hintKey);
    providerApiKey.value = '';

    providerSelect.style.display = 'none';
    providerKeyInput.style.display = '';
    hideError();

    setTimeout(function () { providerApiKey.focus(); }, 100);
  }

  function handleProviderKeyValidation() {
    var _t = window.I18N ? window.I18N.t : function(k) { return k; };
    var key = providerApiKey.value.trim();
    if (!key) {
      showError(_t('err.key.empty'));
      providerApiKey.focus();
      return;
    }
    if (key.length < 10) {
      showError(_t('err.key.short'));
      providerApiKey.focus();
      return;
    }

    hideError();
    setBtnLoading(btnValidateKey, true);

    api('POST', '/api/v2/auth/provider-key', { provider: selectedProvider, apiKey: key })
      .then(function (res) {
        setBtnLoading(btnValidateKey, false);

        if (res.data && res.data.ok && res.data.valid) {
          showSuccess(_t('ok.key'));
          setTimeout(proceedAfterPlan, 800);
        } else {
          showError(res.data.error || _t('err.key.fail'));
          providerApiKey.select();
        }
      })
      .catch(function () {
        setBtnLoading(btnValidateKey, false);
        showError(_t('err.retry'));
      });
  }

  // ─── Handle Plan Choice ───

  function handlePlanChoice(plan) {
    hideError();

    // Visual feedback
    var card = plan === 'own-key' ? btnPlanOwnKey : btnPlanHosted;
    card.style.borderColor = 'var(--accent)';
    card.style.boxShadow = '0 0 0 2px var(--accent-glow)';

    // Save plan to server
    api('POST', '/api/v2/auth/plan', { plan: plan })
      .then(function (res) {
        if (res.data && res.data.ok) {
          try { localStorage.setItem('scratchy_plan', plan); } catch (e) { /* ignore */ }
        }
        if (plan === 'own-key') {
          // Show provider key entry
          showMode('provider-key');
        } else {
          proceedAfterPlan();
        }
      })
      .catch(function () {
        try { localStorage.setItem('scratchy_plan', plan); } catch (e) { /* ignore */ }
        if (plan === 'own-key') {
          showMode('provider-key');
        } else {
          proceedAfterPlan();
        }
      });
  }

  function proceedAfterPlan() {
    if (checkPasskeySupport() && window.PublicKeyCredential) {
      if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
          .then(function (available) {
            if (available) {
              showMode('passkey-setup');
            } else {
              redirectToApp();
            }
          })
          .catch(function () {
            redirectToApp();
          });
      } else {
        redirectToApp();
      }
    } else {
      redirectToApp();
    }
  }

  // ─── Redirect ───

  function redirectToApp() {
    window.location.href = '/';
  }

  // ─── Password Visibility Toggles ───

  function setupVisibilityToggles() {
    var toggles = document.querySelectorAll('.toggle-vis');
    for (var i = 0; i < toggles.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var targetId = btn.getAttribute('data-target');
          var input = document.getElementById(targetId);
          if (!input) return;
          var isPassword = input.type === 'password';
          input.type = isPassword ? 'text' : 'password';
          btn.querySelector('.eye-icon').textContent = isPassword ? '🙈' : '👁';
          input.focus();
        });
      })(toggles[i]);
    }
  }

  // ─── Event Listeners ───

  function setupEventListeners() {
    // Login form submission
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = loginEmail.value.trim();
      var password = loginPassword.value;
      var _t = window.I18N ? window.I18N.t : function(k) { return k; };

      if (!email) {
        showError(_t('err.email'));
        loginEmail.focus();
        return;
      }
      if (!password) {
        showError(_t('err.password'));
        loginPassword.focus();
        return;
      }

      handlePasswordLogin(email, password);
    });

    // Passkey login button
    btnPasskeyLogin.addEventListener('click', function () {
      handlePasskeyLogin();
    });

    // Registration form submission
    registerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = regName.value.trim();
      var email = regEmail.value.trim();
      var password = regPassword.value;
      var passwordConfirm = regPasswordConfirm.value;
      var _t = window.I18N ? window.I18N.t : function(k) { return k; };

      if (!name) {
        showError(_t('err.name'));
        regName.focus();
        return;
      }
      if (!email) {
        showError(_t('err.email.reg'));
        regEmail.focus();
        return;
      }
      if (!password) {
        showError(_t('err.password.choose'));
        regPassword.focus();
        return;
      }
      if (password.length < 8) {
        showError(_t('err.password.short'));
        regPassword.focus();
        return;
      }
      if (password !== passwordConfirm) {
        showError(_t('err.password.match'));
        regPasswordConfirm.focus();
        return;
      }

      handleRegistration(email, password, name);
    });

    // Language cards
    var langCards = document.querySelectorAll('.lang-card');
    for (var lc = 0; lc < langCards.length; lc++) {
      (function (card) {
        card.addEventListener('click', function () {
          handleLanguageChoice(card.getAttribute('data-lang'));
        });
      })(langCards[lc]);
    }

    // Plan choice buttons
    btnPlanOwnKey.addEventListener('click', function () {
      handlePlanChoice('own-key');
    });

    btnPlanHosted.addEventListener('click', function () {
      handlePlanChoice('hosted');
    });

    // Provider selection cards
    var providerCards = document.querySelectorAll('.provider-card');
    for (var pc = 0; pc < providerCards.length; pc++) {
      (function (card) {
        card.addEventListener('click', function () {
          selectProvider(card.getAttribute('data-provider'));
        });
      })(providerCards[pc]);
    }

    // Provider key buttons
    btnValidateKey.addEventListener('click', function () {
      handleProviderKeyValidation();
    });

    btnBackProvider.addEventListener('click', function () {
      providerKeyInput.style.display = 'none';
      providerSelect.style.display = '';
      providerApiKey.value = '';
      selectedProvider = null;
      hideError();
    });

    btnSkipProvider.addEventListener('click', function () {
      proceedAfterPlan();
    });

    // Enter key on API key input
    providerApiKey.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleProviderKeyValidation();
      }
    });

    // Passkey setup buttons
    btnAddPasskey.addEventListener('click', function () {
      handlePasskeyRegistration();
    });

    btnSkipPasskey.addEventListener('click', function () {
      redirectToApp();
    });
  }

  // ─── Initialize ───

  function init() {
    // Restore saved language and apply translations
    try { selectedLanguage = localStorage.getItem('scratchy_lang'); } catch (e) { /* ignore */ }
    // Fallback to browser language for initial translations
    if (!selectedLanguage) {
      var browserLang = (navigator.language || navigator.userLanguage || '').split('-')[0].toLowerCase();
      var supported = { en: true, fr: true, ar: true, it: true };
      if (supported[browserLang]) {
        selectedLanguage = browserLang;
      }
    }
    if (selectedLanguage) {
      if (selectedLanguage === 'ar') {
        document.documentElement.setAttribute('dir', 'rtl');
      }
      if (window.I18N) {
        window.I18N.applyI18n(selectedLanguage);
      }
    }

    setupVisibilityToggles();
    setupEventListeners();
    checkPasskeySupport();
    checkAuthState();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
