// ============================================
// Scratchy — Streaming TTS Playback
// ============================================
// Provides playStreamingTTS(text) for low-latency audio playback
// from the /api/tts endpoint using streaming fetch + MediaSource.
// Falls back to blob-based playback when MediaSource is not supported.
//
// Global API:
//   playStreamingTTS(text)  — returns a Promise, resolves when done/cancelled
//   stopStreamingTTS()      — cancel current playback
//   isStreamingTTSPlaying() — check if currently playing

(function() {
  "use strict";

  var _currentSession = null; // { audio, mediaSource, reader, cancelled }

  // ── Stop any current TTS playback ──
  function stopStreamingTTS() {
    if (!_currentSession) return;
    _currentSession.cancelled = true;
    if (_currentSession.reader) {
      try { _currentSession.reader.cancel(); } catch(e) {}
    }
    if (_currentSession.audio) {
      try {
        _currentSession.audio.pause();
        _currentSession.audio.currentTime = 0;
      } catch(e) {}
    }
    if (_currentSession.mediaSource && _currentSession.mediaSource.readyState === "open") {
      try { _currentSession.mediaSource.endOfStream(); } catch(e) {}
    }
    _hideSpeakerIcon();
    _currentSession = null;
  }

  function isStreamingTTSPlaying() {
    return _currentSession !== null && !_currentSession.cancelled;
  }

  // ── Speaker icon overlay ──
  var _speakerEl = null;

  function _showSpeakerIcon() {
    if (_speakerEl) return;
    _speakerEl = document.createElement("div");
    _speakerEl.id = "tts-speaker-indicator";
    _speakerEl.innerHTML = '<span class="tts-speaker-icon">🔊</span>';
    _speakerEl.title = "Click to stop";
    _speakerEl.addEventListener("click", function() {
      stopStreamingTTS();
    });
    document.body.appendChild(_speakerEl);
    // Animate in
    requestAnimationFrame(function() {
      if (_speakerEl) _speakerEl.classList.add("visible");
    });
  }

  function _hideSpeakerIcon() {
    if (!_speakerEl) return;
    _speakerEl.classList.remove("visible");
    var el = _speakerEl;
    _speakerEl = null;
    setTimeout(function() {
      if (el.parentNode) el.remove();
    }, 300);
  }

  // ── Check if MediaSource supports MP3 ──
  function _canUseMediaSource() {
    if (typeof MediaSource === "undefined") return false;
    // Check for MP3 support in MediaSource
    try {
      return MediaSource.isTypeSupported('audio/mpeg');
    } catch(e) {
      return false;
    }
  }

  // ── Streaming playback via MediaSource ──
  function _playWithMediaSource(response, session) {
    return new Promise(function(resolve) {
      var mediaSource = new MediaSource();
      session.mediaSource = mediaSource;
      var audio = new Audio();
      session.audio = audio;
      audio.src = URL.createObjectURL(mediaSource);

      var sourceBuffer = null;
      var queue = [];       // chunks waiting to be appended
      var streamDone = false;
      var hasStartedPlaying = false;

      function appendNext() {
        if (session.cancelled) return;
        if (!sourceBuffer || sourceBuffer.updating) return;
        if (queue.length === 0) {
          if (streamDone && mediaSource.readyState === "open") {
            try { mediaSource.endOfStream(); } catch(e) {}
          }
          return;
        }
        var chunk = queue.shift();
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch(e) {
          console.warn("[TTS-Stream] appendBuffer error:", e.message);
          // Try to recover by ending stream
          if (mediaSource.readyState === "open") {
            try { mediaSource.endOfStream(); } catch(e2) {}
          }
        }
      }

      mediaSource.addEventListener("sourceopen", function() {
        if (session.cancelled) return;
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        } catch(e) {
          console.warn("[TTS-Stream] addSourceBuffer failed:", e.message);
          // Fall back to blob method
          _fallbackToBlob(response, session).then(resolve);
          return;
        }

        sourceBuffer.addEventListener("updateend", function() {
          appendNext();
          // Start playback as soon as we have some buffered data
          if (!hasStartedPlaying && audio.buffered.length > 0 && audio.buffered.end(0) > 0.1) {
            hasStartedPlaying = true;
            audio.play().catch(function(e) {
              console.warn("[TTS-Stream] Autoplay blocked:", e.message);
            });
          }
        });

        // Start reading the stream
        var reader = response.body.getReader();
        session.reader = reader;

        function pump() {
          reader.read().then(function(result) {
            if (session.cancelled) return;
            if (result.done) {
              streamDone = true;
              appendNext(); // trigger endOfStream if queue empty
              return;
            }
            queue.push(result.value);
            appendNext();
            pump();
          }).catch(function(err) {
            if (session.cancelled) return;
            console.warn("[TTS-Stream] Read error:", err.message);
            streamDone = true;
            appendNext();
          });
        }
        pump();
      });

      audio.addEventListener("ended", function() {
        _hideSpeakerIcon();
        _currentSession = null;
        resolve();
      });

      audio.addEventListener("error", function(e) {
        console.warn("[TTS-Stream] Audio error:", e);
        _hideSpeakerIcon();
        _currentSession = null;
        resolve();
      });
    });
  }

  // ── Fallback: download full blob then play ──
  function _fallbackToBlob(response, session) {
    return new Promise(function(resolve) {
      // If response.body was already partially consumed, we can't re-read
      // But this fallback is called when MediaSource fails, so response is fresh
      // or we need to collect remaining chunks
      var chunks = [];

      if (response.body && response.body.getReader) {
        var reader = response.body.getReader();
        session.reader = reader;

        function collect() {
          reader.read().then(function(result) {
            if (session.cancelled) { resolve(); return; }
            if (result.done) {
              var blob = new Blob(chunks, { type: "audio/mpeg" });
              _playBlob(blob, session, resolve);
              return;
            }
            chunks.push(result.value);
            collect();
          }).catch(function() {
            if (chunks.length > 0) {
              var blob = new Blob(chunks, { type: "audio/mpeg" });
              _playBlob(blob, session, resolve);
            } else {
              resolve();
            }
          });
        }
        collect();
      } else {
        // Very old browser — use response.blob()
        response.blob().then(function(blob) {
          if (session.cancelled) { resolve(); return; }
          _playBlob(blob, session, resolve);
        }).catch(function() { resolve(); });
      }
    });
  }

  function _playBlob(blob, session, resolve) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    session.audio = audio;

    audio.addEventListener("ended", function() {
      URL.revokeObjectURL(url);
      _hideSpeakerIcon();
      _currentSession = null;
      resolve();
    });

    audio.addEventListener("error", function() {
      URL.revokeObjectURL(url);
      _hideSpeakerIcon();
      _currentSession = null;
      resolve();
    });

    audio.play().catch(function(e) {
      console.warn("[TTS-Stream] Blob autoplay blocked:", e.message);
      URL.revokeObjectURL(url);
      _hideSpeakerIcon();
      _currentSession = null;
      resolve();
    });
  }

  // ── Main entry: playStreamingTTS(text) ──
  function playStreamingTTS(text) {
    // Stop any currently playing TTS
    stopStreamingTTS();

    if (!text || !text.trim()) return Promise.resolve();

    var session = { audio: null, mediaSource: null, reader: null, cancelled: false };
    _currentSession = session;
    _showSpeakerIcon();

    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ text: text })
    }).then(function(res) {
      if (session.cancelled) return;
      if (!res.ok) {
        console.warn("[TTS-Stream] Server error:", res.status);
        _hideSpeakerIcon();
        _currentSession = null;
        return;
      }

      // Use MediaSource streaming if supported, otherwise blob fallback
      if (_canUseMediaSource() && res.body && res.body.getReader) {
        return _playWithMediaSource(res, session);
      } else {
        return _fallbackToBlob(res, session);
      }
    }).catch(function(err) {
      if (session.cancelled) return;
      console.warn("[TTS-Stream] Fetch error:", err.message);
      _hideSpeakerIcon();
      _currentSession = null;
    });
  }

  // ── Expose globals ──
  window.playStreamingTTS = playStreamingTTS;
  window.stopStreamingTTS = stopStreamingTTS;
  window.isStreamingTTSPlaying = isStreamingTTSPlaying;
})();
