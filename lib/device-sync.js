'use strict';

/**
 * DeviceSync — Cross-device real-time synchronisation for Scratchy.
 *
 * Maintains a registry of userId → Set<session> so that gateway responses,
 * canvas operations, user messages and activity indicators can be broadcast
 * to every device a user has open simultaneously.
 *
 * Safety contract:
 *   • Every public method is wrapped in try/catch — a misbehaving session
 *     must never crash the server.
 *   • WebSocket sends are guarded by readyState === OPEN.
 *   • Empty user entries are pruned automatically.
 */

const WS_OPEN = 1; // WebSocket.OPEN

const MAX_BUFFER = 200; // Max buffered frames per session

class DeviceSync {
  constructor() {
    /** @type {Map<string, Set<object>>}  userId → Set<session> */
    this._registry = new Map();
  }

  // ---------------------------------------------------------------------------
  //  Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a session (device) under a user.
   * Sets `session._syncUserId` for reverse-lookup during cleanup.
   *
   * @param {string} userId
   * @param {object} session  — a Scratchy WS session object
   */
  register(userId, session) {
    try {
      if (!userId || !session) return;

      let sessions = this._registry.get(userId);
      if (!sessions) {
        sessions = new Set();
        this._registry.set(userId, sessions);
      }

      sessions.add(session);
      session._syncUserId = userId;

      console.log(
        `[DeviceSync] register  userId=${userId} clientId=${session.clientId || '?'} ` +
        `devices=${sessions.size}`
      );
    } catch (err) {
      console.error('[DeviceSync] register error:', err);
    }
  }

  /**
   * Unregister a specific session for a known user.
   * Removes the userId entry from the map when the Set becomes empty.
   *
   * @param {string} userId
   * @param {object} session
   */
  unregister(userId, session) {
    try {
      if (!userId || !session) return;

      const sessions = this._registry.get(userId);
      if (!sessions) return;

      sessions.delete(session);
      delete session._syncUserId;

      console.log(
        `[DeviceSync] unregister  userId=${userId} clientId=${session.clientId || '?'} ` +
        `remaining=${sessions.size}`
      );

      // Auto-cleanup: prune empty entries
      if (sessions.size === 0) {
        this._registry.delete(userId);
      }
    } catch (err) {
      console.error('[DeviceSync] unregister error:', err);
    }
  }

  /**
   * Unregister by session reference when the userId is not readily available.
   * Uses `session._syncUserId` for the reverse lookup.
   *
   * @param {object} session
   */
  unregisterSession(session) {
    try {
      if (!session) return;
      const userId = session._syncUserId;
      if (userId) {
        this.unregister(userId, session);
      }
    } catch (err) {
      console.error('[DeviceSync] unregisterSession error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  //  Queries
  // ---------------------------------------------------------------------------

  /**
   * Get every active session for a user.
   *
   * @param  {string} userId
   * @return {Set<object>}  — never null; returns an empty Set when unknown
   */
  getSessions(userId) {
    return this._registry.get(userId) || new Set();
  }

  /**
   * How many devices does this user have connected?
   *
   * @param  {string} userId
   * @return {number}
   */
  getDeviceCount(userId) {
    const sessions = this._registry.get(userId);
    return sessions ? sessions.size : 0;
  }

  // ---------------------------------------------------------------------------
  //  Broadcasting helpers (low-level)
  // ---------------------------------------------------------------------------

  /**
   * Safely send a payload over a WebSocket.
   * Returns true if the send was attempted, false otherwise.
   *
   * @param  {object} ws   — a WebSocket instance
   * @param  {string} data — the serialised payload
   * @return {boolean}
   */
  _safeSend(ws, data) {
    try {
      if (ws && ws.readyState === WS_OPEN) {
        ws.send(data);
        return true;
      }
    } catch (err) {
      console.error('[DeviceSync] _safeSend error:', err);
    }
    return false;
  }

  /**
   * Serialise data to a JSON string if it isn't one already.
   *
   * @param  {string|object} data
   * @return {string}
   */
  _serialise(data) {
    return typeof data === 'string' ? data : JSON.stringify(data);
  }

  // ---------------------------------------------------------------------------
  //  Canvas state helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply a single canvas operation to a session's _canvasState map.
   * Mirrors the logic used in the main Scratchy relay so that every
   * device's local canvas state stays consistent.
   *
   * @param {object} session
   * @param {object} op  — { op, id, type, data, layout }
   */
  _applyCanvasOp(session, op) {
    try {
      if (!session._canvasState) {
        session._canvasState = new Map();
      }

      switch (op.op) {
        case 'clear':
          session._canvasState.clear();
          break;

        case 'upsert':
          if (op.id) {
            session._canvasState.set(op.id, {
              op: 'upsert',
              id: op.id,
              type: op.type,
              data: op.data,
              layout: op.layout,
            });
          }
          break;

        case 'patch':
          if (op.id && session._canvasState.has(op.id)) {
            const existing = session._canvasState.get(op.id);
            existing.data = { ...existing.data, ...op.data };
            if (op.layout) {
              existing.layout = { ...existing.layout, ...op.layout };
            }
          }
          break;

        case 'remove':
          if (op.id) {
            session._canvasState.delete(op.id);
          }
          break;

        default:
          // Unknown op — ignore silently (forward-compat)
          break;
      }
    } catch (err) {
      console.error('[DeviceSync] _applyCanvasOp error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  //  Public broadcast methods
  // ---------------------------------------------------------------------------

  /**
   * Broadcast a raw WS message to every device of a user.
   *
   * @param {string}      userId
   * @param {string|object} data           — JSON string or object to send
   * @param {object|null} [excludeSession] — session to skip (the sender)
   */
  broadcast(userId, data, excludeSession = null) {
    try {
      const sessions = this._registry.get(userId);
      if (!sessions || sessions.size === 0) return;

      const payload = this._serialise(data);

      for (const session of sessions) {
        if (session === excludeSession) continue;
        this._safeSend(session.clientWs, payload);
      }
    } catch (err) {
      console.error('[DeviceSync] broadcast error:', err);
    }
  }

  /**
   * Broadcast a sequenced frame to every device of a user.
   *
   * Each recipient session gets its own incremented `seq` and the frame is
   * pushed into the session's replay buffer so that reconnecting clients
   * can catch up.
   *
   * @param {string}      userId
   * @param {string}      frame           — the raw frame payload (JSON string)
   * @param {object|null} [excludeSession]
   */
  broadcastFrame(userId, frame, excludeSession = null) {
    try {
      const sessions = this._registry.get(userId);
      if (!sessions || sessions.size === 0) return;

      for (const session of sessions) {
        if (session === excludeSession) continue;

        // Increment sequence counter
        session.seq = (session.seq || 0) + 1;

        const entry = { seq: session.seq, frame };

        // Ensure buffer exists
        if (!Array.isArray(session.buffer)) {
          session.buffer = [];
        }

        session.buffer.push(entry);

        // Trim to last MAX_BUFFER entries
        if (session.buffer.length > MAX_BUFFER) {
          session.buffer = session.buffer.slice(-MAX_BUFFER);
        }

        // Send the frame over the wire (wrapped in seq envelope, serialized)
        this._safeSend(session.clientWs, JSON.stringify({ seq: session.seq, frame }));
      }
    } catch (err) {
      console.error('[DeviceSync] broadcastFrame error:', err);
    }
  }

  /**
   * Broadcast canvas operations to every device of a user.
   *
   * Each op is applied to the recipient's `_canvasState` map (for state
   * consistency) and then forwarded over the WebSocket.
   *
   * @param {string}        userId
   * @param {object|object[]} ops            — single op or array of ops
   * @param {object|null}   [excludeSession]
   */
  broadcastCanvas(userId, ops, excludeSession = null) {
    try {
      const sessions = this._registry.get(userId);
      if (!sessions || sessions.size === 0) return;

      // Normalise to array
      const opList = Array.isArray(ops) ? ops : [ops];
      if (opList.length === 0) return;

      for (const session of sessions) {
        if (session === excludeSession) continue;

        // Apply each op to the session's local canvas state
        for (const op of opList) {
          this._applyCanvasOp(session, op);
        }

        // Send each op as an individual WS message (matches Scratchy's
        // existing per-op streaming behaviour)
        for (const op of opList) {
          this._safeSend(session.clientWs, this._serialise(op));
        }
      }
    } catch (err) {
      console.error('[DeviceSync] broadcastCanvas error:', err);
    }
  }

  /**
   * Broadcast that a user sent a message from one device so that all other
   * devices can render it in their chat view.
   *
   * Wire format:
   *   { type: "sync", event: "user-message", payload: { text, attachments, ts, deviceId } }
   *
   * @param {string}        userId
   * @param {string}        messageText
   * @param {*}             attachments      — forwarded as-is
   * @param {object|null}   [excludeSession]
   */
  broadcastUserMessage(userId, messageText, attachments, excludeSession = null) {
    try {
      const sessions = this._registry.get(userId);
      if (!sessions || sessions.size === 0) return;

      const deviceId = excludeSession ? excludeSession.clientId : undefined;

      const frame = this._serialise({
        type: 'sync',
        event: 'user-message',
        payload: {
          text: messageText,
          attachments: attachments || null,
          ts: Date.now(),
          deviceId,
        },
      });

      for (const session of sessions) {
        if (session === excludeSession) continue;
        this._safeSend(session.clientWs, frame);
      }
    } catch (err) {
      console.error('[DeviceSync] broadcastUserMessage error:', err);
    }
  }

  /**
   * Broadcast an activity indicator (typing, tool-use, etc.) to all
   * devices of a user.
   *
   * Wire format:
   *   { type: "sync", event: "activity", payload: <activity> }
   *
   * @param {string}      userId
   * @param {*}           activity         — arbitrary payload
   * @param {object|null} [excludeSession]
   */
  broadcastActivity(userId, activity, excludeSession = null) {
    try {
      const sessions = this._registry.get(userId);
      if (!sessions || sessions.size === 0) return;

      const frame = this._serialise({
        type: 'sync',
        event: 'activity',
        payload: activity,
      });

      for (const session of sessions) {
        if (session === excludeSession) continue;
        this._safeSend(session.clientWs, frame);
      }
    } catch (err) {
      console.error('[DeviceSync] broadcastActivity error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  //  Admin / diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Return a snapshot of the registry for the admin dashboard.
   *
   * @return {{ totalUsers: number, totalDevices: number, perUser: Object<string, number> }}
   */
  getStats() {
    try {
      let totalDevices = 0;
      const perUser = {};

      for (const [userId, sessions] of this._registry) {
        const count = sessions.size;
        totalDevices += count;
        perUser[userId] = count;
      }

      return {
        totalUsers: this._registry.size,
        totalDevices,
        perUser,
      };
    } catch (err) {
      console.error('[DeviceSync] getStats error:', err);
      return { totalUsers: 0, totalDevices: 0, perUser: {} };
    }
  }
}

module.exports = DeviceSync;
