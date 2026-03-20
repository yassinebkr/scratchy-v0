var AgUiHandler = (function() {
  var _listeners = {};
  var _statusEl = null;
  var _progressEl = null;
  var _activeRun = null;
  var _steps = [];
  var _bar = null;
  var _hideTimer = null;
  var _statusText = null;
  var _stepText = null;
  var _progressBar = null;

  function init(statusEl, progressEl) {
    _statusEl = statusEl;
    _progressEl = progressEl;
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    var t = ev.type;
    if (t === 'RUN_STARTED') {
      _activeRun = { runId: ev.runId, threadId: ev.threadId, startedAt: ev.timestamp };
      _steps = [];
      _showBar();
      _setStatus('Agent working\u2026');
      _setStep('');
      _setPulse(true);
    } else if (t === 'RUN_FINISHED') {
      _setPulse(false);
      _setStatus('\u2705 Done');
      _setStep('');
      _hideTimer = setTimeout(function() { _hideBar(); _activeRun = null; }, 2000);
    } else if (t === 'RUN_ERROR') {
      _setPulse(false);
      _setStatus('\u274c Error: ' + (ev.error || 'Unknown'));
      _setStep('');
      _hideTimer = setTimeout(function() { _hideBar(); _activeRun = null; }, 4000);
    } else if (t === 'STEP_STARTED') {
      _steps.push({ stepId: ev.stepId, stepName: ev.stepName, done: false });
      _setStep('\ud83d\udd27 ' + (ev.stepName || 'Working') + '\u2026');
    } else if (t === 'STEP_FINISHED') {
      for (var i = 0; i < _steps.length; i++) {
        if (_steps[i].stepId === ev.stepId) _steps[i].done = true;
      }
      _setStep('');
    } else if (t === 'TEXT_MESSAGE_START') {
      _setStep('Typing\u2026');
    } else if (t === 'TEXT_MESSAGE_CONTENT') {
      _setStep('Typing\u2026');
    } else if (t === 'TEXT_MESSAGE_END') {
      _setStep('');
    } else if (t === 'STATE_SNAPSHOT') {
      console.log('[AG-UI] State snapshot:', ev.state);
    } else if (t === 'STATE_DELTA') {
      console.log('[AG-UI] State delta:', ev.patches);
    }
    _emit(t, ev);
  }

  function on(event, callback) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(callback);
  }

  function _emit(event, data) {
    var cbs = _listeners[event] || [];
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](data); } catch(_) {}
    }
  }

  function createStatusBar() {
    _bar = document.createElement('div');
    _bar.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;background:rgba(15,23,42,0.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:8px 14px;font-size:0.75rem;color:#a1a1aa;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;gap:3px;opacity:0;transform:translateY(8px);transition:opacity 300ms,transform 300ms;pointer-events:none;max-width:280px;';

    _statusText = document.createElement('div');
    _statusText.style.cssText = 'font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    _bar.appendChild(_statusText);

    _stepText = document.createElement('div');
    _stepText.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1em;';
    _bar.appendChild(_stepText);

    _progressBar = document.createElement('div');
    _progressBar.style.cssText = 'height:2px;border-radius:1px;background:rgba(255,255,255,0.06);margin-top:2px;overflow:hidden;';
    var inner = document.createElement('div');
    inner.className = 'ag-ui-pulse';
    inner.style.cssText = 'height:100%;width:40%;background:linear-gradient(90deg,#6366f1,#818cf8);border-radius:1px;transform:translateX(-100%);';
    _progressBar.appendChild(inner);
    _bar.appendChild(_progressBar);

    var style = document.createElement('style');
    style.textContent = '@keyframes ag-ui-slide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}} .ag-ui-pulse{animation:ag-ui-slide 1.5s ease-in-out infinite}';
    _bar.appendChild(style);

    return _bar;
  }

  function _showBar() {
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    if (_bar) { _bar.style.opacity = '1'; _bar.style.transform = 'translateY(0)'; _bar.style.pointerEvents = 'auto'; }
  }

  function _hideBar() {
    if (_bar) { _bar.style.opacity = '0'; _bar.style.transform = 'translateY(8px)'; _bar.style.pointerEvents = 'none'; }
  }

  function _setStatus(t) { if (_statusText) _statusText.textContent = t; }
  function _setStep(t) { if (_stepText) _stepText.textContent = t; }
  function _setPulse(on) {
    if (!_progressBar) return;
    _progressBar.style.display = on ? 'block' : 'none';
  }

  function getActiveRun() { return _activeRun; }
  function getSteps() { return _steps.slice(); }

  return {
    init: init,
    handleEvent: handleEvent,
    on: on,
    createStatusBar: createStatusBar,
    getActiveRun: getActiveRun,
    getSteps: getSteps
  };
})();
