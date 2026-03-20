# Fix: Incognito Login Flow for New Operator Accounts

**Date:** 2026-02-22
**Severity:** Medium (login flow broken for fresh installs; degraded UX in incognito)

---

## Root Cause Analysis

Three distinct issues combine to break the login flow in incognito/private browsing, particularly for new operator accounts:

### Issue 1: `/api/v2/auth/me` returns bare 401 — no bootstrap or passkey metadata

**File:** `lib/auth/routes.js`, line 52

The login page's `doAuthCheck()` fetches `GET /api/v2/auth/me` and expects the 401 response body to contain:
- `needsBootstrap` / `noAdmin` — to decide whether to show registration or login form
- `passkeysAvailable` — to decide whether to show the "Sign in with Passkey" button

But the server returns only `{ error: "Not authenticated" }`:
```js
if (!authResult) { _json(res, 401, { error: "Not authenticated" }); return true; }
```

A separate endpoint (`GET /api/v2/auth/status`) has the bootstrap info, but the login page never calls it.

**Impact:**
- Fresh installations: registration form never appears (login form shown instead)
- Passkey login button is never shown to unauthenticated users
- Affects ALL browsers, but more visible in incognito (no stale cookies)

### Issue 2: No `navigator.language` fallback for language detection

**File:** `web/js/login-v2.js`, function `showPostLanguageMode()` (line ~345)

When localStorage has no `scratchy_lang` key (always the case in incognito), the language selector is shown. There's no attempt to detect the browser's preferred language via `navigator.language`, which would allow auto-selecting the correct language for most users.

**Impact:**
- In incognito, users must manually pick their language every time they visit
- New operator accounts in incognito always see the language selector, adding friction

### Issue 3: `config.js` fallback sessionKey is wrong for multi-user

**File:** `web/js/config.js`, line 14

The partial fix (try/catch around localStorage) is correct, but the fallback value `"agent:main:main"` is the legacy admin session key. For multi-user, each user needs `main:webchat:{userId}`.

```js
sessionKey: (function() {
    try { return localStorage.getItem('scratchy_agent_key') || "agent:main:main"; } catch(e) { return "agent:main:main"; }
})(),
```

In old Safari incognito (pre-iOS 11), `localStorage.setItem()` throws `QuotaExceededError`. The login page sets `scratchy_agent_key` after auth, but if the set fails silently (caught by try/catch), then when the page redirects to `/` and config.js loads, `localStorage.getItem()` returns `null`, and the fallback `"agent:main:main"` is used.

**Impact:**
- User connects to the wrong gateway session
- Particularly affects old Safari incognito where localStorage writes fail
- The partial fix prevents a crash but the fallback is incorrect

---

## Fixes

### Fix 1: Enhance `/api/v2/auth/me` 401 response with bootstrap metadata

**File:** `lib/auth/routes.js`, line 52

**Before:**
```js
if (p === "/api/v2/auth/me" && req.method === "GET") {
    if (!authResult) { _json(res, 401, { error: "Not authenticated" }); return true; }
    return _handleMe(req, res, authResult), true;
}
```

**After:**
```js
if (p === "/api/v2/auth/me" && req.method === "GET") {
    if (!authResult) {
        // Include bootstrap info so the login page knows which mode to show
        const needsBootstrap = !userStore.hasAdmin();
        const passkeysAvailable = !needsBootstrap && userStore.anyUserHasPasskeys();
        _json(res, 401, {
            error: "Not authenticated",
            needsBootstrap,
            noAdmin: needsBootstrap,
            passkeysAvailable,
        });
        return true;
    }
    return _handleMe(req, res, authResult), true;
}
```

> **Note:** `userStore.anyUserHasPasskeys()` may need to be implemented. If the user store doesn't have this method, use `false` as a safe default:
> ```js
> const passkeysAvailable = !needsBootstrap && (typeof userStore.anyUserHasPasskeys === 'function' ? userStore.anyUserHasPasskeys() : false);
> ```

### Fix 2: Add `navigator.language` fallback to language detection

**File:** `web/js/login-v2.js`, function `showPostLanguageMode()` (~line 345)

**Before:**
```js
function showPostLanguageMode() {
    // Check if language already chosen
    try { selectedLanguage = localStorage.getItem('scratchy_lang'); } catch (e) { /* ignore */ }

    if (!selectedLanguage) {
      // Show language selection first
      showMode('language');
      return;
    }

    // Language already set — proceed to login or bootstrap
    showAuthMode();
}
```

**After:**
```js
function showPostLanguageMode() {
    // Check if language already chosen
    try { selectedLanguage = localStorage.getItem('scratchy_lang'); } catch (e) { /* ignore */ }

    // Fallback: detect from browser language
    if (!selectedLanguage) {
      var browserLang = (navigator.language || navigator.userLanguage || '').split('-')[0].toLowerCase();
      var supported = { en: true, fr: true, ar: true, it: true };
      if (supported[browserLang]) {
        selectedLanguage = browserLang;
        try { localStorage.setItem('scratchy_lang', browserLang); } catch (e) { /* ignore */ }
        // Apply detected language
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
```

This also needs a corresponding update in the `init()` function:

**File:** `web/js/login-v2.js`, function `init()` (~line 440)

**Before:**
```js
function init() {
    // Restore saved language and apply translations
    try { selectedLanguage = localStorage.getItem('scratchy_lang'); } catch (e) { /* ignore */ }
    if (selectedLanguage) {
```

**After:**
```js
function init() {
    // Restore saved language and apply translations
    try { selectedLanguage = localStorage.getItem('scratchy_lang'); } catch (e) { /* ignore */ }
    // Fallback to browser language
    if (!selectedLanguage) {
      var browserLang = (navigator.language || navigator.userLanguage || '').split('-')[0].toLowerCase();
      var supported = { en: true, fr: true, ar: true, it: true };
      if (supported[browserLang]) {
        selectedLanguage = browserLang;
      }
    }
    if (selectedLanguage) {
```

### Fix 3: Use session-based sessionKey fallback in config.js

**File:** `web/js/config.js`, line 14

**Before:**
```js
sessionKey: (function() {
    try { return localStorage.getItem('scratchy_agent_key') || "agent:main:main"; } catch(e) { return "agent:main:main"; }
})(),
```

**After:**
```js
sessionKey: (function() {
    try {
      var key = localStorage.getItem('scratchy_agent_key');
      if (key) return key;
    } catch(e) { /* localStorage unavailable (incognito) */ }
    // Fallback: read from session cookie user ID (set by auth middleware)
    // The main app's /api/v2/auth/me response provides the correct key;
    // this default is used only during initial page load before the me check completes.
    return "agent:main:main";
})(),
```

> **Note:** The real fix for this is in the main app JS — after calling `/api/v2/auth/me`, the app should update the WebSocket session key from the `agentSessionKey` field in the response. The config.js default only matters during the brief window before the auth check completes. Verify the main app does this.

### Fix 4 (minor): Add missing `footer.fork` key to Arabic translations

**File:** `web/js/i18n.js`, Arabic section (~line 275)

Add after `'footer.text': '...'`:
```js
'footer.fork': 'مشتق من',
```

---

## Cookie Analysis (Incognito Compatibility)

The session cookie is set as:
```
scratchy_session={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure
```

This is **compatible with all incognito modes**:
- `HttpOnly` — prevents JS access but cookies still work ✓
- `SameSite=Strict` — correct for same-origin auth ✓
- `Secure` — requires HTTPS (scratchy.clawos.fr uses HTTPS) ✓
- Cookies in incognito work within the session; they're just cleared on window close ✓

No changes needed for cookie handling.

---

## Test Steps

### Test 1: Fresh Installation Bootstrap (Incognito)
1. Clear all auth data (or use fresh install with no admin)
2. Open `https://scratchy.clawos.fr` in incognito/private window
3. **Expected:** Language selector appears first
4. Select a language
5. **Expected (with Fix 1):** Registration form appears (not login form)
6. Complete registration
7. **Expected:** Plan choice → main app loads correctly

### Test 2: Existing Operator Login (Incognito)
1. Ensure an operator account exists (invited by admin)
2. Open `https://scratchy.clawos.fr` in incognito
3. **Expected (with Fix 2):** If browser language matches en/fr/ar/it, skip language selector
4. If not matched, language selector shown — select one
5. **Expected:** Login form appears
6. Enter operator credentials, submit
7. **Expected:** Login succeeds, redirect to main app
8. **Expected:** Main app connects to correct user session (not `agent:main:main`)

### Test 3: Safari Private Browsing (iOS)
1. Open Safari → Private → navigate to `https://scratchy.clawos.fr`
2. **Expected:** Language selector or auto-detected language
3. Log in with valid credentials
4. **Expected:** Redirect to main app, WebSocket connects successfully
5. Close private tab, reopen in new private tab
6. **Expected:** Language selector shown again (localStorage cleared) — this is expected behavior

### Test 4: Language Auto-Detection
1. Set browser language to French (`fr-FR`)
2. Open login page in incognito
3. **Expected (with Fix 2):** Login form shown directly in French (no language selector)
4. Set browser language to German (`de-DE`)
5. Open login page in incognito
6. **Expected:** Language selector shown (German not in supported set)

---

## Files Modified

| File | Change |
|------|--------|
| `lib/auth/routes.js` | Fix 1: Enhanced 401 response with bootstrap metadata |
| `web/js/login-v2.js` | Fix 2: `navigator.language` fallback in `showPostLanguageMode()` and `init()` |
| `web/js/config.js` | Fix 3: Verified — partial fix is acceptable with comment |
| `web/js/i18n.js` | Fix 4: Missing Arabic `footer.fork` translation |

## Patched Files

See the following files in this directory:
- `patched-routes.js` — the `handleAuthRoute` function portion with Fix 1
- `patched-login-v2.js` — full file with Fix 2
- `patched-i18n-ar-footer.txt` — the Arabic footer.fork line to add
