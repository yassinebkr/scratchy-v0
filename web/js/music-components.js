/**
 * Music Components Extension for LiveComponents
 * Adds: player, media-list, carousel
 * Loaded AFTER live-components.js — monkey-patches create/has
 */
(function() {
  /* ── Helpers (redeclared locally — no access to IIFE internals) ── */
  function el(tag, opts) {
    var e = document.createElement(tag);
    if (opts) {
      if (opts.cls) e.className = opts.cls;
      if (opts.style) e.style.cssText = opts.style;
      if (opts.text) e.textContent = opts.text;
    }
    return e;
  }
  function setText(n, t) { if (n && n.textContent !== t) n.textContent = t; }
  function fireAction(action, context) {
    if (window._scratchyWidgetAction) {
      window._scratchyWidgetAction(action, context || {});
    }
  }

  var _musicFactories = {};

  /* ═══════════════════════════════════════════════════════════════════
   *  Component 1: player
   *  Unified music player (Spotify/Apple Music full-screen style)
   * ═══════════════════════════════════════════════════════════════════ */
  _musicFactories.player = function(d) {
    var state = {
      title: d.title || '',
      subtitle: d.subtitle || '',
      cover: d.cover || '',
      status: d.status || 'stopped',
      progress: d.progress || { value: 0, max: 1, label: '0:00 / 0:00' },
      controls: d.controls || [],
      options: d.options || []
    };

    // Root container
    var root = el('div', {style:
      'display:flex;flex-direction:column;align-items:center;padding:24px 16px 18px;' +
      'background:linear-gradient(180deg,rgba(30,20,50,0.9) 0%,rgba(13,13,26,0.95) 100%);' +
      'border-radius:14px;max-width:360px;margin:0 auto;'
    });

    // ── Cover art ──
    var coverWrap = el('div', {style:
      'width:280px;height:280px;border-radius:14px;overflow:hidden;margin-bottom:20px;' +
      'flex-shrink:0;position:relative;'
    });
    var coverImg = el('img', {style:
      'width:100%;height:100%;object-fit:cover;display:block;'
    });
    coverImg.alt = '';
    coverImg.loading = 'lazy';
    var coverPlaceholder = el('div', {style:
      'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
      'background:linear-gradient(135deg,#2d1b69,#1a1a2e);font-size:4rem;'
    });
    coverPlaceholder.textContent = '🎵';

    function renderCover(src) {
      coverWrap.innerHTML = '';
      if (src) {
        coverImg.src = src;
        coverImg.onerror = function() {
          coverWrap.innerHTML = '';
          coverWrap.appendChild(coverPlaceholder);
        };
        coverWrap.appendChild(coverImg);
      } else {
        coverWrap.appendChild(coverPlaceholder);
      }
    }
    renderCover(state.cover);
    root.appendChild(coverWrap);

    // ── Title ──
    var titleEl = el('div', {text: state.title, style:
      'font-size:1.2rem;font-weight:700;color:#fff;text-align:center;' +
      'max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px;'
    });
    root.appendChild(titleEl);

    // ── Subtitle ──
    var subtitleEl = el('div', {text: state.subtitle, style:
      'font-size:0.82rem;color:rgba(255,255,255,0.55);text-align:center;' +
      'max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:16px;'
    });
    root.appendChild(subtitleEl);

    // ── Progress bar ──
    var progressWrap = el('div', {style:'width:100%;max-width:280px;margin-bottom:16px;'});

    var progressBar = el('div', {style:
      'width:100%;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;cursor:pointer;'
    });
    var progressFill = el('div', {style:
      'height:100%;border-radius:2px;' +
      'background:var(--accent, #8b5cf6);transition:width 0.3s linear;'
    });
    var pct = state.progress.max > 0 ? (state.progress.value / state.progress.max) * 100 : 0;
    progressFill.style.width = pct + '%';
    progressBar.appendChild(progressFill);
    progressWrap.appendChild(progressBar);

    var progressLabel = el('div', {style:
      'display:flex;justify-content:space-between;margin-top:4px;font-size:0.7rem;color:rgba(255,255,255,0.45);'
    });
    var progressParts = (state.progress.label || '').split('/');
    var progressLeft = el('span', {text: (progressParts[0] || '').trim()});
    var progressRight = el('span', {text: (progressParts[1] || '').trim()});
    progressLabel.appendChild(progressLeft);
    progressLabel.appendChild(progressRight);
    progressWrap.appendChild(progressLabel);
    root.appendChild(progressWrap);

    // ── Controls ──
    var controlsRow = el('div', {style:
      'display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;'
    });
    var controlBtns = {};

    function buildControls(controls) {
      controlsRow.innerHTML = '';
      controlBtns = {};
      (controls || []).forEach(function(c) {
        var isLg = c.size === 'lg';
        var isPrimary = c.style === 'primary';
        var btn = el('button', {text: c.icon || '', style:
          'border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
          'border-radius:50%;transition:background 0.15s,transform 0.1s;' +
          (isLg
            ? 'width:52px;height:52px;font-size:1.5rem;' +
              (isPrimary
                ? 'background:var(--accent, #8b5cf6);color:#fff;'
                : 'background:rgba(255,255,255,0.1);color:#fff;')
            : 'width:40px;height:40px;font-size:1.1rem;background:transparent;color:rgba(255,255,255,0.7);')
        });
        btn.onmouseenter = function() {
          if (isLg && isPrimary) btn.style.background = '#7c3aed';
          else if (!isLg) btn.style.color = '#fff';
          btn.style.transform = 'scale(1.08)';
        };
        btn.onmouseleave = function() {
          if (isLg && isPrimary) btn.style.background = 'var(--accent, #8b5cf6)';
          else if (!isLg) btn.style.color = 'rgba(255,255,255,0.7)';
          btn.style.transform = 'scale(1)';
        };
        btn.onclick = function(e) { e.stopPropagation(); fireAction(c.action, c.context); };
        controlsRow.appendChild(btn);
        if (c.id) controlBtns[c.id] = { el: btn, data: c };
      });
    }
    buildControls(state.controls);
    root.appendChild(controlsRow);

    // ── Options row ──
    var optionsRow = el('div', {style:
      'display:flex;align-items:center;justify-content:center;gap:16px;'
    });

    function buildOptions(options) {
      optionsRow.innerHTML = '';
      (options || []).forEach(function(opt) {
        var btn = el('button', {text: opt.icon || '', style:
          'border:none;background:transparent;cursor:pointer;font-size:1rem;' +
          'padding:4px 8px;border-radius:6px;transition:color 0.15s,background 0.15s;' +
          'color:' + (opt.active ? 'var(--accent, #8b5cf6)' : 'rgba(255,255,255,0.4)') + ';'
        });
        btn.onmouseenter = function() {
          btn.style.background = 'rgba(255,255,255,0.06)';
        };
        btn.onmouseleave = function() {
          btn.style.background = 'transparent';
        };
        btn.onclick = function(e) { e.stopPropagation(); fireAction(opt.action, opt.context); };
        optionsRow.appendChild(btn);
      });
    }
    buildOptions(state.options);
    root.appendChild(optionsRow);

    // ── Update handler (partial updates) ──
    return {el: root, update: function(nd) {
      // Title
      if (nd.title != null && nd.title !== state.title) {
        state.title = nd.title;
        setText(titleEl, state.title);
      }
      // Subtitle
      if (nd.subtitle != null && nd.subtitle !== state.subtitle) {
        state.subtitle = nd.subtitle;
        setText(subtitleEl, state.subtitle);
      }
      // Cover
      if (nd.cover != null && nd.cover !== state.cover) {
        state.cover = nd.cover;
        renderCover(state.cover);
      }
      // Progress (lightweight patch — no re-render)
      if (nd.progress) {
        if (nd.progress.max != null) state.progress.max = nd.progress.max;
        if (nd.progress.value != null) state.progress.value = nd.progress.value;
        if (nd.progress.label != null) state.progress.label = nd.progress.label;
        var p = state.progress.max > 0 ? (state.progress.value / state.progress.max) * 100 : 0;
        progressFill.style.width = p + '%';
        var parts = (state.progress.label || '').split('/');
        setText(progressLeft, (parts[0] || '').trim());
        setText(progressRight, (parts[1] || '').trim());
      }
      // Status + controls: if status changed, try to swap play/pause icon only
      if (nd.status != null && nd.status !== state.status) {
        state.status = nd.status;
        // If controls also provided, rebuild them; otherwise try smart swap
        if (!nd.controls) {
          // Find the primary/play-pause button and swap its icon
          var playBtn = controlBtns.play || controlBtns.playpause;
          if (playBtn) {
            var newIcon = state.status === 'playing' ? '⏸' : '▶';
            var newAction = state.status === 'playing' ? playBtn.data.action.replace('play', 'pause') : playBtn.data.action.replace('pause', 'play');
            setText(playBtn.el, newIcon);
            playBtn.data.icon = newIcon;
            playBtn.data.action = newAction;
            playBtn.el.onclick = function(e) { e.stopPropagation(); fireAction(newAction); };
          }
        }
      }
      // Controls (full rebuild)
      if (nd.controls) {
        state.controls = nd.controls;
        buildControls(state.controls);
      }
      // Options (full rebuild)
      if (nd.options) {
        state.options = nd.options;
        buildOptions(state.options);
      }
    }};
  };

  /* ═══════════════════════════════════════════════════════════════════
   *  Component 2: media-list
   *  Dense track/video list (Spotify song list style)
   * ═══════════════════════════════════════════════════════════════════ */
  _musicFactories['media-list'] = function(d) {
    var root = el('div', {style:'padding:0;'});

    // ── Title header ──
    var headerEl = null;
    if (d.title) {
      headerEl = el('div', {text: d.title, style:
        'font-size:0.82rem;font-weight:600;color:#ddd;padding:12px 14px 8px;'
      });
      root.appendChild(headerEl);
    }

    // ── List container ──
    var listEl = el('div', {style:'padding:0 4px 8px;'});
    root.appendChild(listEl);

    var _expanded = false;
    var _items = d.items || [];

    function buildList(items) {
      listEl.innerHTML = '';
      _items = items || [];
      var showCount = _expanded ? _items.length : Math.min(_items.length, 20);

      for (var i = 0; i < showCount; i++) {
        (function(item, idx) {
          var isActive = !!item.active;
          var row = el('div', {style:
            'display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px;' +
            'cursor:pointer;transition:background 0.15s;position:relative;min-height:48px;' +
            (isActive
              ? 'background:rgba(139,92,246,0.08);border-left:3px solid var(--accent, #8b5cf6);'
              : 'border-left:3px solid transparent;')
          });
          row.onmouseenter = function() {
            if (!isActive) row.style.background = 'rgba(255,255,255,0.04)';
          };
          row.onmouseleave = function() {
            row.style.background = isActive ? 'rgba(139,92,246,0.08)' : 'transparent';
          };
          row.onclick = function() { fireAction(item.action, item.context); };

          // Thumbnail
          if (item.image) {
            var thumb = el('img', {style:
              'width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;'
            });
            thumb.src = item.image;
            thumb.alt = '';
            thumb.loading = 'lazy';
            thumb.onerror = function() {
              var ph = el('div', {text: '🎵', style:
                'width:40px;height:40px;border-radius:6px;background:rgba(139,92,246,0.15);' +
                'display:flex;align-items:center;justify-content:center;font-size:0.9rem;flex-shrink:0;'
              });
              thumb.parentNode.replaceChild(ph, thumb);
            };
            row.appendChild(thumb);
          } else {
            var ph = el('div', {text: '🎵', style:
              'width:40px;height:40px;border-radius:6px;background:rgba(139,92,246,0.15);' +
              'display:flex;align-items:center;justify-content:center;font-size:0.9rem;flex-shrink:0;'
            });
            row.appendChild(ph);
          }

          // Text column
          var textCol = el('div', {style:'flex:1;min-width:0;'});
          var titleRow = el('div', {text: item.title || '', style:
            'font-size:0.82rem;font-weight:500;' +
            'color:' + (isActive ? 'var(--accent, #8b5cf6)' : '#ddd') + ';' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
          });
          textCol.appendChild(titleRow);
          if (item.subtitle) {
            var subRow = el('div', {text: item.subtitle, style:
              'font-size:0.72rem;color:rgba(255,255,255,0.4);' +
              'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;'
            });
            textCol.appendChild(subRow);
          }
          row.appendChild(textCol);

          // Duration
          if (item.duration) {
            var dur = el('div', {text: item.duration, style:
              'font-size:0.72rem;color:rgba(255,255,255,0.35);flex-shrink:0;margin-left:4px;'
            });
            row.appendChild(dur);
          }

          // Overflow menu
          var dots = el('button', {text: '⋯', style:
            'border:none;background:transparent;color:rgba(255,255,255,0.25);cursor:pointer;' +
            'font-size:0.9rem;padding:4px 6px;border-radius:4px;flex-shrink:0;' +
            'transition:color 0.15s;'
          });
          dots.onmouseenter = function() { dots.style.color = 'rgba(255,255,255,0.6)'; };
          dots.onmouseleave = function() { dots.style.color = 'rgba(255,255,255,0.25)'; };
          dots.onclick = function(e) { e.stopPropagation(); };
          row.appendChild(dots);

          listEl.appendChild(row);
        })(_items[i], i);
      }

      // "Show more" button
      if (!_expanded && _items.length > 20) {
        var showMore = el('button', {text: 'Show all ' + _items.length + ' items', style:
          'display:block;width:100%;padding:10px;margin-top:4px;' +
          'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);' +
          'border-radius:8px;color:var(--accent, #8b5cf6);font-size:0.78rem;cursor:pointer;' +
          'transition:background 0.15s;'
        });
        showMore.onmouseenter = function() { showMore.style.background = 'rgba(139,92,246,0.1)'; };
        showMore.onmouseleave = function() { showMore.style.background = 'rgba(255,255,255,0.04)'; };
        showMore.onclick = function() { _expanded = true; buildList(_items); };
        listEl.appendChild(showMore);
      }
    }
    buildList(_items);

    return {el: root, update: function(nd) {
      if (nd.title != null) {
        if (headerEl) {
          setText(headerEl, nd.title);
        } else if (nd.title) {
          headerEl = el('div', {text: nd.title, style:
            'font-size:0.82rem;font-weight:600;color:#ddd;padding:12px 14px 8px;'
          });
          root.insertBefore(headerEl, listEl);
        }
      }
      if (nd.items) {
        _expanded = false;
        buildList(nd.items);
      }
    }};
  };

  /* ═══════════════════════════════════════════════════════════════════
   *  Component 3: carousel
   *  Horizontal scrolling card container (browse/discovery)
   * ═══════════════════════════════════════════════════════════════════ */
  _musicFactories.carousel = function(d) {
    var root = el('div', {style:'padding:0;'});

    // ── Title header ──
    var headerEl = null;
    if (d.title) {
      headerEl = el('div', {text: d.title, style:
        'font-size:0.82rem;font-weight:600;color:#ddd;padding:12px 14px 8px;'
      });
      root.appendChild(headerEl);
    }

    // ── Scroll container ──
    var scrollWrap = el('div', {style:
      'overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;' +
      'scrollbar-width:none;padding:4px 14px 12px;scroll-snap-type:x mandatory;'
    });
    // Hide scrollbar for webkit
    var scrollStyle = document.createElement('style');
    var scrollId = 'mc-carousel-' + Math.random().toString(36).substr(2, 6);
    scrollWrap.id = scrollId;
    scrollStyle.textContent = '#' + scrollId + '::-webkit-scrollbar{display:none;}';
    root.appendChild(scrollStyle);

    var track = el('div', {style:
      'display:flex;gap:12px;'
    });
    scrollWrap.appendChild(track);
    root.appendChild(scrollWrap);

    function buildCards(items) {
      track.innerHTML = '';
      (items || []).forEach(function(item) {
        var card = el('div', {style:
          'flex:0 0 150px;width:150px;cursor:pointer;scroll-snap-align:start;' +
          'transition:transform 0.15s;'
        });
        card.onmouseenter = function() { card.style.transform = 'scale(1.03)'; };
        card.onmouseleave = function() { card.style.transform = 'scale(1)'; };
        card.onclick = function() { fireAction(item.action, item.context); };

        // Image container
        var imgWrap = el('div', {style:
          'width:150px;height:150px;border-radius:8px;overflow:hidden;position:relative;margin-bottom:8px;'
        });
        if (item.image) {
          var img = el('img', {style:
            'width:100%;height:100%;object-fit:cover;display:block;'
          });
          img.src = item.image;
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = function() {
            var gpd = el('div', {text: '🎵', style:
              'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
              'background:linear-gradient(135deg,#2d1b69,#1a1a2e);font-size:2.5rem;'
            });
            img.parentNode.replaceChild(gpd, img);
          };
          imgWrap.appendChild(img);
        } else {
          var gpd = el('div', {text: '🎵', style:
            'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
            'background:linear-gradient(135deg,#2d1b69,#1a1a2e);font-size:2.5rem;'
          });
          imgWrap.appendChild(gpd);
        }

        // Tag badge
        if (item.tag) {
          var tag = el('div', {text: item.tag, style:
            'position:absolute;top:6px;right:6px;padding:2px 8px;border-radius:4px;' +
            'background:rgba(0,0,0,0.65);color:rgba(255,255,255,0.85);font-size:0.62rem;' +
            'font-weight:600;letter-spacing:0.3px;backdrop-filter:blur(4px);'
          });
          imgWrap.appendChild(tag);
        }

        card.appendChild(imgWrap);

        // Title
        var cardTitle = el('div', {text: item.title || '', style:
          'font-size:0.78rem;font-weight:600;color:#ddd;' +
          'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;' +
          'line-height:1.3;max-height:2.6em;'
        });
        card.appendChild(cardTitle);

        // Subtitle
        if (item.subtitle) {
          var cardSub = el('div', {text: item.subtitle, style:
            'font-size:0.7rem;color:rgba(255,255,255,0.4);margin-top:2px;' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
          });
          card.appendChild(cardSub);
        }

        track.appendChild(card);
      });
    }
    buildCards(d.items);

    return {el: root, update: function(nd) {
      if (nd.title != null) {
        if (headerEl) {
          setText(headerEl, nd.title);
        } else if (nd.title) {
          headerEl = el('div', {text: nd.title, style:
            'font-size:0.82rem;font-weight:600;color:#ddd;padding:12px 14px 8px;'
          });
          root.insertBefore(headerEl, scrollWrap);
        }
      }
      if (nd.items) {
        buildCards(nd.items);
      }
    }};
  };

  /* ═══════════════════════════════════════════════════════════════════
   *  Monkey-patch LiveComponents.create and LiveComponents.has
   * ═══════════════════════════════════════════════════════════════════ */
  if (typeof LiveComponents !== 'undefined') {
    var _origCreate = LiveComponents.create;
    var _origHas = LiveComponents.has;

    LiveComponents.create = function(type, data) {
      if (_musicFactories[type]) return _musicFactories[type](data);
      return _origCreate(type, data);
    };
    LiveComponents.has = function(type) {
      if (_musicFactories[type]) return true;
      return _origHas(type);
    };
  }
})();
