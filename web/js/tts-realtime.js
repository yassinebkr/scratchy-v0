// ============================================
// Scratchy — Real-time Streaming TTS
// ============================================
// Sentence-buffered real-time TTS that speaks as text streams in.
// Sits on top of tts-stream.js (uses playStreamingTTS for actual audio).
//
// KEY DESIGN: Only speaks during the "final answer" phase.
// The agent lifecycle is: thinking → tool calls → final answer.
// We track activity events to know when tools are done and the final
// answer starts streaming. Text before that is NOT spoken.
//
// Flow:
//   1. resetRealtimeTTS() — called at run start (thinking phase)
//   2. signalToolsSeen() — called when tool events are detected
//   3. signalAnswerPhase() — called when text deltas arrive after tools
//   4. feedRealtimeTTS(fullText) — only queues sentences when in answer phase
//   5. finalizeRealtimeTTS(fullText) — speaks remaining text

(function() {
  "use strict";

  var _phase = "idle";     // idle | thinking | tools | answering | draining | waiting-reset
  var _sentenceOffset = 0; // chars of cumulative text already queued for TTS
  var _audioQueue = [];    // queue of { text } waiting to be spoken
  var _speaking = false;   // currently playing audio
  var _cancelled = false;
  var _toolsSeen = false;  // have we seen any tool events this turn?
  var _answerStartOffset = -1; // char offset where the final answer begins
  var _pendingReset = false; // a new turn wants to reset, but we're still playing

  var SENTENCE_RE = /[.!?]\s+|\n\n/;
  var _directAnswerTimer = null; // timer to detect no-tool direct answers
  var _firstTextAt = 0;          // timestamp of first text delta

  // Called at the start of a new agent turn (thinking begins)
  // If audio is still playing from the previous turn, let it finish naturally
  function resetRealtimeTTS() {
    if (_speaking || _audioQueue.length > 0) {
      // Previous turn's audio is still playing — let it drain, then reset
      _pendingReset = true;
      _phase = "draining";
      // Don't cancel, don't stop audio — just mark that we need to reset after drain
      return;
    }
    _doReset();
  }

  function _doReset() {
    _pendingReset = false;
    if (_directAnswerTimer) { clearTimeout(_directAnswerTimer); _directAnswerTimer = null; }
    if (typeof stopStreamingTTS === "function") stopStreamingTTS();
    _phase = "thinking";
    _sentenceOffset = 0;
    _audioQueue = [];
    _speaking = false;
    _cancelled = false;
    _toolsSeen = false;
    _answerStartOffset = -1;
    _firstTextAt = 0;
  }

  // Called when tool events are detected (tool start/end)
  function signalToolsSeen() {
    if (_pendingReset) return; // still draining previous turn
    _toolsSeen = true;
    if (_phase === "thinking") _phase = "tools";
  }

  // Called when text deltas arrive — decides if we're in the answer phase
  // textLength: current cumulative text length from the delta
  function signalTextDelta(textLength) {
    if (_pendingReset) return; // still draining previous turn
    if (_phase === "tools" || (_phase === "thinking" && _toolsSeen)) {
      // Text arriving after tools = final answer
      if (_directAnswerTimer) { clearTimeout(_directAnswerTimer); _directAnswerTimer = null; }
      _phase = "answering";
      _answerStartOffset = _sentenceOffset; // mark where answer text starts
      return;
    }
    // No tools seen yet, still in thinking phase.
    // Start a short timer: if no tools arrive within 1.5s of first text,
    // this is a direct answer (no tool calls) — start speaking.
    if (_phase === "thinking" && !_toolsSeen && !_directAnswerTimer) {
      _firstTextAt = Date.now();
      _directAnswerTimer = setTimeout(function() {
        _directAnswerTimer = null;
        if (_phase === "thinking" && !_toolsSeen && !_pendingReset && !_cancelled) {
          _phase = "answering";
          _answerStartOffset = 0;
          console.log("[RealtimeTTS] Direct answer detected (no tools) — starting speech");
          // Next text delta will call feedRealtimeTTS with full text — catches up naturally
        }
      }, 1500);
    }
  }

  // Feed cumulative text — only processes when in answering phase
  function feedRealtimeTTS(fullText) {
    if (_cancelled || _phase !== "answering" || _pendingReset) return;

    var speakable = _stripCanvasBlocks(fullText);
    if (!speakable || speakable.length <= _sentenceOffset) return;

    var newText = speakable.slice(_sentenceOffset);

    var remaining = newText;
    while (true) {
      var match = remaining.match(SENTENCE_RE);
      if (!match) break;

      var sentenceEnd = match.index + match[0].length;
      var sentence = remaining.slice(0, sentenceEnd).trim();

      if (sentence.length > 5) {
        _audioQueue.push({ text: sentence });
        _processQueue();
      }

      _sentenceOffset += sentenceEnd;
      remaining = remaining.slice(sentenceEnd);
    }
  }

  // Called when message finalizes — speak any remaining text
  function finalizeRealtimeTTS(fullText) {
    if (_cancelled) { _cleanup(); return; }
    if (_directAnswerTimer) { clearTimeout(_directAnswerTimer); _directAnswerTimer = null; }

    // If we never entered answering phase:
    // - If tools were seen but no answer text: skip (pure tool-only turn)
    // - If no tools and still thinking: this is a direct answer — speak the whole thing
    if (_phase !== "answering") {
      if (_phase === "thinking" && !_toolsSeen && fullText && fullText.trim().length > 5) {
        // Short direct answer that completed before the 1.5s timer — speak it all
        _phase = "answering";
        _answerStartOffset = 0;
        console.log("[RealtimeTTS] Finalize: short direct answer — speaking full text");
      } else {
        _cleanup();
        return;
      }
    }

    var speakable = _stripCanvasBlocks(fullText);
    if (speakable && speakable.length > _sentenceOffset) {
      var remaining = speakable.slice(_sentenceOffset).trim();
      if (remaining.length > 2) {
        _audioQueue.push({ text: remaining });
        _processQueue();
      }
    }

    _phase = "draining"; // queue will drain, then cleanup
  }

  function stopRealtimeTTS() {
    _cancelled = true;
    _pendingReset = false;
    if (_directAnswerTimer) { clearTimeout(_directAnswerTimer); _directAnswerTimer = null; }
    _phase = "idle";
    _audioQueue = [];
    _stopCurrentAudio();
    if (typeof stopStreamingTTS === "function") stopStreamingTTS();
    // Direct cleanup without going through _cleanup (which checks _pendingReset)
    _sentenceOffset = 0;
    _speaking = false;
    _cancelled = false;
    _toolsSeen = false;
    _answerStartOffset = -1;
    _firstTextAt = 0;
  }

  function _cleanup() {
    if (_pendingReset) {
      _doReset();
      return;
    }
    _phase = "idle";
    _sentenceOffset = 0;
    _audioQueue = [];
    _speaking = false;
    _cancelled = false;
    _toolsSeen = false;
    _answerStartOffset = -1;
  }

  // Dedicated audio pipeline — avoids global TTS state conflicts
  var _currentAudio = null;
  var INTER_SENTENCE_PAUSE_MS = 1500; // pause between sentences for natural cadence

  function _stopCurrentAudio() {
    if (_currentAudio) {
      try { _currentAudio.pause(); _currentAudio.src = ""; } catch(e) {}
      _currentAudio = null;
    }
  }

  function _processQueue() {
    if (_speaking || _cancelled || _audioQueue.length === 0) return;

    _speaking = true;
    var item = _audioQueue.shift();

    // Stop any global/fallback TTS that might be playing
    if (typeof stopStreamingTTS === "function") stopStreamingTTS();
    _stopCurrentAudio();

    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ text: item.text })
    }).then(function(res) {
      if (_cancelled || !res.ok) {
        _speaking = false;
        if (!_cancelled) _processQueue();
        return;
      }
      return res.blob();
    }).then(function(blob) {
      if (_cancelled || !blob) return;

      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      _currentAudio = audio;

      audio.addEventListener("ended", function() {
        URL.revokeObjectURL(url);
        _currentAudio = null;
        _speaking = false;
        // If a new turn is waiting to reset and queue is empty, do the reset now
        if (_pendingReset && _audioQueue.length === 0) {
          _doReset();
          return;
        }
        // If queue is empty, we're done — cleanup
        if (_audioQueue.length === 0 && (_phase === "idle" || _phase === "draining")) {
          _cleanup();
          return;
        }
        // Pause between sentences for natural cadence, then play next
        if (!_cancelled && _audioQueue.length > 0) {
          setTimeout(function() {
            if (!_cancelled) _processQueue();
          }, INTER_SENTENCE_PAUSE_MS);
        } else if (!_cancelled) {
          _processQueue();
        }
      });

      audio.addEventListener("error", function() {
        URL.revokeObjectURL(url);
        _currentAudio = null;
        _speaking = false;
        if (_pendingReset && _audioQueue.length === 0) { _doReset(); return; }
        if (!_cancelled) _processQueue();
      });

      audio.play().catch(function() {
        URL.revokeObjectURL(url);
        _currentAudio = null;
        _speaking = false;
        if (_pendingReset && _audioQueue.length === 0) { _doReset(); return; }
        if (!_cancelled) _processQueue();
      });
    }).catch(function() {
      _speaking = false;
      if (!_cancelled) _processQueue();
    });
  }

  // Strip canvas/toon blocks (not speakable) — but NOT thinking (handled by phase tracking)
  function _stripCanvasBlocks(text) {
    if (!text) return "";
    return text.replace(/```scratchy-(canvas|toon|ui|tpl)[\s\S]*?```/g, "").trim();
  }

  function isRealtimeTTSActive() {
    // Also active during the direct-answer detection window (timer pending)
    // so fallback TTS doesn't overlap
    return _phase === "answering" || _phase === "draining" || _speaking
      || _audioQueue.length > 0 || _directAnswerTimer !== null;
  }

  function getRealtimeTTSPhase() {
    return _phase;
  }

  // Expose globals
  window.resetRealtimeTTS = resetRealtimeTTS;
  window.signalRealtimeTTSToolsSeen = signalToolsSeen;
  window.signalRealtimeTTSTextDelta = signalTextDelta;
  window.feedRealtimeTTS = feedRealtimeTTS;
  window.finalizeRealtimeTTS = finalizeRealtimeTTS;
  window.stopRealtimeTTS = stopRealtimeTTS;
  window.isRealtimeTTSActive = isRealtimeTTSActive;
  window.getRealtimeTTSPhase = getRealtimeTTSPhase;
})();
