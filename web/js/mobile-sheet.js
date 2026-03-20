/**
 * Mobile Bottom Sheet for Scratchy
 * Replaces binary chat/canvas toggle on mobile with a swipeable bottom sheet.
 */
(function () {
  'use strict';

  // --- Constants ---
  const COLLAPSED_HEIGHT = 64;
  const HEADER_HEIGHT = 60;
  const SNAP_VELOCITY_THRESHOLD = 0.5;
  const SPRING_TRANSITION = 'transform 400ms cubic-bezier(0.32, 0.72, 0, 1)';
  const MQ = window.matchMedia('(max-width: 640px)');

  const STATE = { COLLAPSED: 'collapsed', HALF: 'half', FULL: 'full' };

  // --- Inject styles once ---
  const styleId = 'mobile-sheet-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .mobile-sheet-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.3);
        z-index: 998;
        opacity: 0;
        pointer-events: none;
        transition: opacity 400ms cubic-bezier(0.32, 0.72, 0, 1);
      }
      .mobile-sheet-backdrop.visible {
        opacity: 1;
        pointer-events: auto;
      }
      .mobile-sheet {
        position: fixed;
        left: 0; right: 0;
        bottom: var(--sheet-bottom-offset, 0px);
        z-index: 999;
        background: var(--bg-secondary, #141414);
        border-top: 1px solid var(--border, rgba(255,255,255,0.08));
        border-radius: 16px 16px 0 0;
        will-change: transform;
        touch-action: pan-y;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .mobile-sheet__handle-area {
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        flex-shrink: 0;
        gap: 10px;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
      }
      /* Ensure input area stays above sheet peek but below sidebar */
      .mobile-sheet-active #input-area {
        position: relative;
        z-index: 150;
      }
      .mobile-sheet__handle {
        width: 40px;
        height: 4px;
        border-radius: 2px;
        background: rgba(255,255,255,0.2);
        flex-shrink: 0;
      }
      .mobile-sheet__label {
        color: var(--text-primary, #ededed);
        font-size: 13px;
        font-weight: 500;
        opacity: 0.7;
        white-space: nowrap;
      }
      .mobile-sheet__badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--accent, #6366f1);
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        min-width: 20px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        margin-left: 4px;
      }
      .mobile-sheet__content {
        flex: 1;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        padding: 0 12px 12px;
        display: none;
      }
      .mobile-sheet.expanded .mobile-sheet__content {
        display: block;
      }
      /* Hide toggle buttons on mobile when sheet is active */
      .mobile-sheet-active .view-toggle,
      .mobile-sheet-active [data-view-toggle] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  // --- State ---
  let currentState = STATE.COLLAPSED;
  let sheetEl = null;
  let backdropEl = null;
  let contentEl = null;
  let labelEl = null;
  let badgeEl = null;
  let canvasGridOriginalParent = null;
  let canvasGridNextSibling = null;
  let isActive = false;

  // Touch tracking
  let startY = 0;
  let startTranslateY = 0;
  let currentTranslateY = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let isDragging = false;

  function getVh() {
    return window.innerHeight;
  }

  function getHeightForState(state) {
    const vh = getVh();
    switch (state) {
      case STATE.COLLAPSED: return COLLAPSED_HEIGHT;
      case STATE.HALF: return Math.round(vh * 0.5);
      case STATE.FULL: return vh - HEADER_HEIGHT;
      default: return COLLAPSED_HEIGHT;
    }
  }

  function getTranslateYForState(state) {
    const vh = getVh();
    const sheetFullHeight = vh - HEADER_HEIGHT;
    const targetHeight = getHeightForState(state);
    return sheetFullHeight - targetHeight;
  }

  function getTileCount() {
    const tiles = document.querySelectorAll('.dash-tile');
    return tiles.length;
  }

  function updateLabel() {
    if (!labelEl || !badgeEl) return;
    const count = getTileCount();
    labelEl.textContent = 'Canvas';
    badgeEl.textContent = count;
  }

  function moveCanvasGridIntoSheet() {
    const grid = document.getElementById('canvas-grid');
    if (!grid || !contentEl) return;
    if (grid.parentElement === contentEl) return;
    canvasGridOriginalParent = grid.parentElement;
    canvasGridNextSibling = grid.nextSibling;
    contentEl.appendChild(grid);
  }

  function restoreCanvasGrid() {
    const grid = document.getElementById('canvas-grid');
    if (!grid || !canvasGridOriginalParent) return;
    if (grid.parentElement === canvasGridOriginalParent) return;
    if (canvasGridNextSibling) {
      canvasGridOriginalParent.insertBefore(grid, canvasGridNextSibling);
    } else {
      canvasGridOriginalParent.appendChild(grid);
    }
  }

  function setSheetTranslateY(y, animate) {
    if (!sheetEl) return;
    if (animate) {
      sheetEl.style.transition = SPRING_TRANSITION;
    } else {
      sheetEl.style.transition = 'none';
    }
    sheetEl.style.transform = `translateY(${y}px)`;
    currentTranslateY = y;
  }

  function setState(newState, animate) {
    if (animate === undefined) animate = true;
    currentState = newState;
    const ty = getTranslateYForState(newState);
    setSheetTranslateY(ty, animate);

    const expanded = newState !== STATE.COLLAPSED;
    sheetEl.classList.toggle('expanded', expanded);

    if (expanded) {
      moveCanvasGridIntoSheet();
      backdropEl.classList.add('visible');
      if (contentEl) contentEl.style.pointerEvents = '';
    } else {
      backdropEl.classList.remove('visible');
      // Clear inline styles that were set during dragging
      backdropEl.style.opacity = '';
      backdropEl.style.pointerEvents = '';
      // Disable pointer-events on content when collapsed (only handle interactive)
      if (contentEl) contentEl.style.pointerEvents = 'none';
      // Delay restoring grid until transition ends
      setTimeout(restoreCanvasGrid, 420);
    }

    updateLabel();
  }

  function snapToNearest(vel) {
    const vh = getVh();
    const sheetFullHeight = vh - HEADER_HEIGHT;
    const currentHeight = sheetFullHeight - currentTranslateY;

    const collapsedH = getHeightForState(STATE.COLLAPSED);
    const halfH = getHeightForState(STATE.HALF);
    const fullH = getHeightForState(STATE.FULL);

    // Use velocity to bias direction
    if (Math.abs(vel) > SNAP_VELOCITY_THRESHOLD) {
      if (vel < 0) {
        // Swiping up
        if (currentState === STATE.COLLAPSED) { setState(STATE.HALF); return; }
        if (currentState === STATE.HALF) { setState(STATE.FULL); return; }
        setState(STATE.FULL); return;
      } else {
        // Swiping down
        if (currentState === STATE.FULL) { setState(STATE.HALF); return; }
        if (currentState === STATE.HALF) { setState(STATE.COLLAPSED); return; }
        setState(STATE.COLLAPSED); return;
      }
    }

    // Snap to closest
    const dists = [
      { state: STATE.COLLAPSED, d: Math.abs(currentHeight - collapsedH) },
      { state: STATE.HALF, d: Math.abs(currentHeight - halfH) },
      { state: STATE.FULL, d: Math.abs(currentHeight - fullH) },
    ];
    dists.sort((a, b) => a.d - b.d);
    setState(dists[0].state);
  }

  // --- Touch handlers ---
  function onTouchStart(e) {
    isDragging = true;
    const touch = e.touches[0];
    startY = touch.clientY;
    startTranslateY = currentTranslateY;
    lastY = touch.clientY;
    lastTime = Date.now();
    velocity = 0;
    sheetEl.style.transition = 'none';
  }

  function onTouchMove(e) {
    if (!isDragging) return;
    // Always prevent default since this handler is only on the handle area
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - startY;
    const now = Date.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = (touch.clientY - lastY) / dt;
    }
    lastY = touch.clientY;
    lastTime = now;

    const minTY = getTranslateYForState(STATE.FULL);
    const maxTY = getTranslateYForState(STATE.COLLAPSED);
    let newTY = startTranslateY + dy;
    // Clamp with rubber-band feel at edges
    newTY = Math.max(minTY - 20, Math.min(maxTY + 20, newTY));
    sheetEl.style.transform = `translateY(${newTY}px)`;
    currentTranslateY = newTY;

    // Update backdrop opacity proportionally
    const sheetFullHeight = getVh() - HEADER_HEIGHT;
    const currentHeight = sheetFullHeight - currentTranslateY;
    const ratio = Math.max(0, Math.min(1, (currentHeight - COLLAPSED_HEIGHT) / (sheetFullHeight - COLLAPSED_HEIGHT)));
    backdropEl.style.opacity = ratio * 0.3;
    backdropEl.style.pointerEvents = ratio > 0.05 ? 'auto' : 'none';

    // Ensure content is visible while dragging up
    if (currentHeight > COLLAPSED_HEIGHT + 30) {
      if (!sheetEl.classList.contains('expanded')) {
        sheetEl.classList.add('expanded');
        moveCanvasGridIntoSheet();
      }
    }
  }

  function onTouchEnd() {
    if (!isDragging) return;
    isDragging = false;
    // velocity is px/ms, negative = swipe up
    snapToNearest(velocity * 1000); // convert to px/s for threshold
  }

  function onHandleTap(e) {
    // Only handle taps (not drags)
    if (currentState === STATE.COLLAPSED) {
      setState(STATE.HALF);
    }
  }

  function onBackdropTap() {
    setState(STATE.COLLAPSED);
  }

  // --- Build DOM ---
  function createSheet() {
    if (sheetEl) return;

    backdropEl = document.createElement('div');
    backdropEl.className = 'mobile-sheet-backdrop';
    backdropEl.addEventListener('click', onBackdropTap);

    sheetEl = document.createElement('div');
    sheetEl.className = 'mobile-sheet';
    const vh = getVh();
    sheetEl.style.height = (vh - HEADER_HEIGHT) + 'px';

    const handleArea = document.createElement('div');
    handleArea.className = 'mobile-sheet__handle-area';

    const handle = document.createElement('div');
    handle.className = 'mobile-sheet__handle';

    labelEl = document.createElement('span');
    labelEl.className = 'mobile-sheet__label';
    labelEl.textContent = 'Canvas';

    badgeEl = document.createElement('span');
    badgeEl.className = 'mobile-sheet__badge';
    badgeEl.textContent = getTileCount();

    handleArea.appendChild(handle);
    handleArea.appendChild(labelEl);
    handleArea.appendChild(badgeEl);

    contentEl = document.createElement('div');
    contentEl.className = 'mobile-sheet__content';

    sheetEl.appendChild(handleArea);
    sheetEl.appendChild(contentEl);

    // Touch events — drag only from handle area
    handleArea.addEventListener('touchstart', onTouchStart, { passive: true });
    handleArea.addEventListener('touchmove', onTouchMove, { passive: false });
    handleArea.addEventListener('touchend', onTouchEnd, { passive: true });
    handleArea.addEventListener('touchcancel', onTouchEnd, { passive: true });

    // Tap detection on handle area
    let tapStartY = 0;
    let tapStartTime = 0;
    handleArea.addEventListener('touchstart', function (e) {
      tapStartY = e.touches[0].clientY;
      tapStartTime = Date.now();
    }, { passive: true });
    handleArea.addEventListener('touchend', function (e) {
      const dy = Math.abs((e.changedTouches[0]?.clientY || tapStartY) - tapStartY);
      const dt = Date.now() - tapStartTime;
      if (dy < 10 && dt < 300) {
        onHandleTap(e);
      }
    }, { passive: true });

    document.body.appendChild(backdropEl);
    document.body.appendChild(sheetEl);
  }

  function updateSheetBottomOffset() {
    const inputArea = document.getElementById('input-area');
    const offset = inputArea ? inputArea.offsetHeight : 0;
    document.documentElement.style.setProperty('--sheet-bottom-offset', offset + 'px');
  }

  function activate() {
    if (isActive) return;
    isActive = true;
    createSheet();
    document.body.classList.add('mobile-sheet-active');
    // Ensure chat view is visible, hide canvas view (sheet shows canvas instead)
    const chatView = document.getElementById('chat-view');
    if (chatView) chatView.style.display = '';
    const canvasView = document.getElementById('canvas-view');
    if (canvasView) canvasView.style.display = 'none';

    // Position sheet above input area
    updateSheetBottomOffset();

    // Resize sheet height
    const vh = getVh();
    sheetEl.style.height = (vh - HEADER_HEIGHT) + 'px';
    sheetEl.style.display = 'flex';
    setState(STATE.COLLAPSED, false);
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;
    document.body.classList.remove('mobile-sheet-active');
    restoreCanvasGrid();
    if (sheetEl) sheetEl.style.display = 'none';
    if (backdropEl) {
      backdropEl.classList.remove('visible');
      backdropEl.style.opacity = '';
      backdropEl.style.pointerEvents = '';
    }
    currentState = STATE.COLLAPSED;
  }

  function onMediaChange(e) {
    if (e.matches) {
      activate();
    } else {
      deactivate();
    }
  }

  // Handle resize for sheet height
  window.addEventListener('resize', function () {
    if (!isActive || !sheetEl) return;
    updateSheetBottomOffset();
    const vh = getVh();
    sheetEl.style.height = (vh - HEADER_HEIGHT) + 'px';
    setState(currentState, false);
  });

  // Observe tile count changes
  const observer = new MutationObserver(function () {
    if (isActive) updateLabel();
  });

  // --- Init ---
  function init() {
    MQ.addEventListener('change', onMediaChange);
    if (MQ.matches) activate();

    // Start observing for tile count changes
    const grid = document.getElementById('canvas-grid');
    if (grid) {
      observer.observe(grid, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

