/**
 * Spotify Widget — Scratchy GenUI
 * Standalone widget: OAuth2 flow, playback control, search, playlists
 * Prefix: spotify-
 *
 * Design principles:
 * - Clear before render: every view starts with { op: 'clear' }
 * - Minimal components: max 4-5 visible tiles per view
 * - No npm deps: uses node:https for API calls
 * - Never logs credentials
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const { getWidgetStatePath, migrateLegacyFile } = require('../../lib/widget-state');

const LEGACY_SESSION_PATH = process.env.SPOTIFY_SESSION_PATH || path.join(process.env.HOME || '.', '.spotify-session.json');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'streaming'
].join(' ');

const GREEN = '#1DB954';

class SpotifyWidget {
  constructor({ clientId, clientSecret, redirectUri, userId } = {}) {
    this._userId = userId || '_legacy';
    // Migrate legacy root-level session file on first access
    migrateLegacyFile(LEGACY_SESSION_PATH, this._userId, 'spotify-session.json');
    this._sessionPath = getWidgetStatePath(this._userId, 'spotify-session.json');
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
    this.redirectUri = redirectUri || 'https://scratchy.example.com/auth/spotify/callback';
    this.session = this._loadSession();
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context = {}) {
    try {
      // Auth-free actions
      if (action === 'spotify-auth-callback') return this._authCallback(context);

      // No credentials configured
      if (!this.clientId) return { ops: this._setupOps() };

      // Not connected yet
      if (!this._isConnected()) return { ops: this._authOps() };

      // Ensure token is fresh
      await this._refreshIfNeeded();

      switch (action) {
        case 'spotify-search':       return this._search(context);
        case 'spotify-playlists':    return this._playlists();
        case 'spotify-playlist':     return this._playlist(context);
        case 'spotify-now-playing':  return this._nowPlaying();
        case 'spotify-play':         return this._play(context);
        case 'spotify-pause':        return this._pause();
        case 'spotify-next':         return this._next();
        case 'spotify-prev':         return this._prev();
        case 'spotify-volume':       return this._volume(context);
        default:
          return { ops: [
            { op: 'clear' },
            { op: 'upsert', id: 'spotify-error', type: 'alert', data: {
              title: 'Unknown action', message: `"${action}" is not a valid Spotify action.`, severity: 'error'
            }}
          ]};
      }
    } catch (err) {
      return { ops: [
        { op: 'clear' },
        ...this._nav('error'),
        { op: 'upsert', id: 'spotify-error', type: 'alert', data: {
          title: 'Spotify Error', message: err.message || String(err), severity: 'error'
        }}
      ]};
    }
  }

  // ─── Navigation ───────────────────────────────────────

  _nav(active) {
    const btn = (label, action, key) => ({
      label, action, style: active === key ? 'primary' : 'ghost'
    });
    return [{ op: 'upsert', id: 'spotify-nav', type: 'buttons', data: { buttons: [
      btn('🎵 Now Playing', 'spotify-now-playing', 'now'),
      btn('🔍 Search', 'spotify-search', 'search'),
      btn('📂 Playlists', 'spotify-playlists', 'playlists')
    ]}}];
  }

  // ─── Auth ─────────────────────────────────────────────

  _isConnected() {
    return !!(this.session && this.session.accessToken);
  }

  _buildAuthUrl() {
    const params = querystring.stringify({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES,
      redirect_uri: this.redirectUri
    });
    return `${AUTH_URL}?${params}`;
  }

  _setupOps() {
    return [
      { op: 'clear' },
      { op: 'upsert', id: 'spotify-header', type: 'hero', data: {
        title: 'Spotify', subtitle: 'No credentials configured.', icon: '🎵'
      }},
      { op: 'upsert', id: 'spotify-instructions', type: 'card', data: {
        title: 'Setup Instructions',
        text: '1. Go to developer.spotify.com/dashboard\n2. Create an app\n3. Copy Client ID and Client Secret\n4. Set redirect URI to: ' + this.redirectUri + '\n5. Pass { clientId, clientSecret } to the SpotifyWidget constructor'
      }}
    ];
  }

  _authOps() {
    const url = this._buildAuthUrl();
    return [
      { op: 'clear' },
      { op: 'upsert', id: 'spotify-header', type: 'hero', data: {
        title: 'Spotify', subtitle: 'Connect your account to get started.', icon: '🎵'
      }},
      { op: 'upsert', id: 'spotify-auth-link', type: 'link-card', data: {
        title: 'Sign in with Spotify', description: 'Opens Spotify authorization', url, icon: '🔐', color: GREEN
      }},
      { op: 'upsert', id: 'spotify-code-form', type: 'form', data: {
        id: 'spotify-code-form', title: 'Or paste authorization code',
        fields: [{ name: 'code', type: 'text', label: 'Code', placeholder: 'Paste code here...' }],
        actions: [{ label: 'Connect', action: 'spotify-auth-callback', style: 'primary' }]
      }}
    ];
  }

  async _authCallback(context) {
    if (!context.code) {
      return { ops: [{ op: 'upsert', id: 'spotify-error', type: 'alert', data: {
        title: 'Error', message: 'No authorization code provided.', severity: 'error'
      }}]};
    }

    const body = querystring.stringify({
      grant_type: 'authorization_code',
      code: context.code.trim(),
      redirect_uri: this.redirectUri
    });

    const data = await this._tokenRequest(body);
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
      connectedAt: new Date().toISOString()
    };
    this._saveSession(this.session);

    return this._nowPlaying();
  }

  async _refreshIfNeeded() {
    if (!this.session || !this.session.refreshToken) return;
    // Refresh if token expires within 5 minutes
    if (this.session.expiresAt && (Date.now() + 300000) < this.session.expiresAt) return;

    const body = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: this.session.refreshToken
    });

    const data = await this._tokenRequest(body);
    this.session.accessToken = data.access_token;
    this.session.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) this.session.refreshToken = data.refresh_token;
    this._saveSession(this.session);
  }

  _tokenRequest(body) {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const options = {
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) reject(new Error(parsed.error_description || parsed.error));
            else resolve(parsed);
          } catch { reject(new Error('Invalid token response')); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ─── API Helper ───────────────────────────────────────

  _apiRequest(method, endpoint, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`);
      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.session.accessToken}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          // 204 No Content — success with no body
          if (res.statusCode === 204) return resolve(null);
          if (!raw) return resolve(null);
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              reject(new Error(parsed.error.message || parsed.error));
            } else {
              resolve(parsed);
            }
          } catch { reject(new Error(`API error (${res.statusCode})`)); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ─── Search ───────────────────────────────────────────

  async _search(context) {
    if (!context.query) {
      return { ops: [
        { op: 'clear' },
        ...this._nav('search'),
        { op: 'upsert', id: 'spotify-search-form', type: 'form', data: {
          id: 'spotify-search-form', title: '🔍 Search Spotify',
          fields: [{ name: 'query', type: 'text', label: 'Search', placeholder: 'Artist, track, or album...' }],
          actions: [{ label: 'Search', action: 'spotify-search', style: 'primary' }]
        }}
      ]};
    }

    const q = encodeURIComponent(context.query);
    const data = await this._apiRequest('GET', `/search?q=${q}&type=track,album,artist&limit=8`);

    const ops = [
      { op: 'clear' },
      ...this._nav('search'),
      { op: 'upsert', id: 'spotify-search-form', type: 'form', data: {
        id: 'spotify-search-form', title: '🔍 Search Spotify',
        fields: [{ name: 'query', type: 'text', label: 'Search', placeholder: 'Artist, track, or album...', value: context.query }],
        actions: [{ label: 'Search', action: 'spotify-search', style: 'primary' }]
      }}
    ];

    // Tracks
    const tracks = (data.tracks && data.tracks.items) || [];
    if (tracks.length > 0) {
      ops.push({ op: 'upsert', id: 'spotify-search-tracks', type: 'tags', data: {
        label: 'Tracks', items: [{ text: `${tracks.length} results`, color: GREEN }]
      }});
      for (const track of tracks.slice(0, 5)) {
        const artists = track.artists.map(a => a.name).join(', ');
        const albumArt = (track.album && track.album.images && track.album.images[0])
          ? track.album.images[0].url : null;
        const trackOp = {
          op: 'upsert', id: `spotify-track-${track.id}`, type: 'card', data: {
            title: `🎵 ${track.name}`,
            text: `${artists} · ${track.album ? track.album.name : 'Unknown Album'} · ${this._formatMs(track.duration_ms)}`
          }
        };
        ops.push(trackOp);
        ops.push({ op: 'upsert', id: `spotify-track-play-${track.id}`, type: 'buttons', data: {
          buttons: [{ label: '▶ Play', action: `spotify-play`, style: 'primary' }]
        }});
      }
    }

    // Artists
    const artists = (data.artists && data.artists.items) || [];
    if (artists.length > 0) {
      ops.push({ op: 'upsert', id: 'spotify-search-artists', type: 'tags', data: {
        label: 'Artists', items: artists.slice(0, 5).map(a => ({ text: a.name, color: GREEN }))
      }});
    }

    // Albums
    const albums = (data.albums && data.albums.items) || [];
    if (albums.length > 0) {
      ops.push({ op: 'upsert', id: 'spotify-search-albums', type: 'tags', data: {
        label: 'Albums', items: albums.slice(0, 5).map(a => ({
          text: `${a.name} — ${a.artists.map(ar => ar.name).join(', ')}`, color: '#1a1a2e'
        }))
      }});
    }

    if (tracks.length === 0 && artists.length === 0 && albums.length === 0) {
      ops.push({ op: 'upsert', id: 'spotify-no-results', type: 'card', data: {
        title: 'No results', text: `Nothing found for "${context.query}". Try a different search.`
      }});
    }

    return { ops };
  }

  // ─── Playlists ────────────────────────────────────────

  async _playlists() {
    const data = await this._apiRequest('GET', '/me/playlists?limit=20');
    const playlists = (data && data.items) || [];

    const ops = [
      { op: 'clear' },
      ...this._nav('playlists'),
      { op: 'upsert', id: 'spotify-playlists-header', type: 'hero', data: {
        title: 'Your Playlists', subtitle: `${playlists.length} playlist${playlists.length !== 1 ? 's' : ''}`, icon: '📂'
      }}
    ];

    if (playlists.length === 0) {
      ops.push({ op: 'upsert', id: 'spotify-no-playlists', type: 'card', data: {
        title: 'No playlists', text: 'You have no playlists yet.'
      }});
    } else {
      for (const pl of playlists) {
        const imgUrl = (pl.images && pl.images[0]) ? pl.images[0].url : null;
        if (imgUrl) {
          ops.push({ op: 'upsert', id: `spotify-pl-img-${pl.id}`, type: 'image', data: {
            title: pl.name, src: imgUrl, caption: `${pl.tracks.total} tracks · ${pl.owner.display_name}`
          }});
        } else {
          ops.push({ op: 'upsert', id: `spotify-pl-${pl.id}`, type: 'card', data: {
            title: `📂 ${pl.name}`,
            text: `${pl.tracks.total} tracks · ${pl.owner.display_name}`
          }});
        }
        ops.push({ op: 'upsert', id: `spotify-pl-btn-${pl.id}`, type: 'buttons', data: {
          buttons: [
            { label: '📋 View Tracks', action: 'spotify-playlist', style: 'ghost' },
            { label: '▶ Play', action: 'spotify-play', style: 'primary' }
          ]
        }});
      }
    }

    return { ops };
  }

  async _playlist(context) {
    if (!context.playlistId) {
      return { ops: [
        { op: 'clear' },
        ...this._nav('playlists'),
        { op: 'upsert', id: 'spotify-error', type: 'alert', data: {
          title: 'Error', message: 'No playlist ID provided.', severity: 'warning'
        }}
      ]};
    }

    const data = await this._apiRequest('GET', `/playlists/${context.playlistId}?fields=name,description,images,tracks.items(track(id,name,artists,album,duration_ms,uri)),tracks.total`);

    const ops = [
      { op: 'clear' },
      ...this._nav('playlists')
    ];

    const imgUrl = (data.images && data.images[0]) ? data.images[0].url : null;
    if (imgUrl) {
      ops.push({ op: 'upsert', id: 'spotify-pl-cover', type: 'image', data: {
        title: data.name, src: imgUrl, caption: data.description || `${data.tracks.total} tracks`
      }});
    } else {
      ops.push({ op: 'upsert', id: 'spotify-pl-header', type: 'hero', data: {
        title: data.name, subtitle: data.description || `${data.tracks.total} tracks`, icon: '📂'
      }});
    }

    ops.push({ op: 'upsert', id: 'spotify-pl-play', type: 'buttons', data: {
      buttons: [
        { label: '← Playlists', action: 'spotify-playlists', style: 'ghost' },
        { label: '▶ Play All', action: 'spotify-play', style: 'primary' }
      ]
    }});

    const trackItems = (data.tracks && data.tracks.items) || [];
    const kvItems = [];
    for (const item of trackItems.slice(0, 20)) {
      const t = item.track;
      if (!t) continue;
      const artists = t.artists.map(a => a.name).join(', ');
      kvItems.push({ key: t.name, value: `${artists} · ${this._formatMs(t.duration_ms)}` });
    }

    if (kvItems.length > 0) {
      ops.push({ op: 'upsert', id: 'spotify-pl-tracks', type: 'kv', data: {
        title: `Tracks (${data.tracks.total})`, items: kvItems
      }});
    }

    return { ops };
  }

  // ─── Now Playing ──────────────────────────────────────

  async _nowPlaying() {
    const data = await this._apiRequest('GET', '/me/player/currently-playing');

    const ops = [
      { op: 'clear' },
      ...this._nav('now')
    ];

    if (!data || !data.item) {
      ops.push({ op: 'upsert', id: 'spotify-nothing', type: 'card', data: {
        title: '🎵 Nothing Playing',
        text: 'No track is currently playing. Start playing something on Spotify!'
      }});
      ops.push({ op: 'upsert', id: 'spotify-controls', type: 'buttons', data: {
        buttons: [
          { label: '▶ Play', action: 'spotify-play', style: 'primary' },
          { label: '🔄 Refresh', action: 'spotify-now-playing', style: 'ghost' }
        ]
      }});
      return { ops };
    }

    const track = data.item;
    const artists = track.artists.map(a => a.name).join(', ');
    const albumName = track.album ? track.album.name : 'Unknown Album';
    const albumArt = (track.album && track.album.images && track.album.images[0])
      ? track.album.images[0].url : null;
    const isPlaying = data.is_playing;
    const progressMs = data.progress_ms || 0;
    const durationMs = track.duration_ms || 1;

    // Album art
    if (albumArt) {
      ops.push({ op: 'upsert', id: 'spotify-album-art', type: 'image', data: {
        title: track.name, src: albumArt, caption: `${artists} · ${albumName}`
      }});
    }

    // Track info
    ops.push({ op: 'upsert', id: 'spotify-track-info', type: 'kv', data: {
      title: isPlaying ? '▶ Now Playing' : '⏸ Paused',
      items: [
        { key: 'Track', value: track.name },
        { key: 'Artist', value: artists },
        { key: 'Album', value: albumName },
        { key: 'Time', value: `${this._formatMs(progressMs)} / ${this._formatMs(durationMs)}` }
      ]
    }});

    // Progress bar
    ops.push({ op: 'upsert', id: 'spotify-progress', type: 'progress', data: {
      label: `${this._formatMs(progressMs)} / ${this._formatMs(durationMs)}`,
      value: Math.round(progressMs / 1000),
      max: Math.round(durationMs / 1000),
      color: GREEN
    }});

    // Playback status tag
    ops.push({ op: 'upsert', id: 'spotify-status', type: 'tags', data: {
      label: 'Status',
      items: [
        { text: isPlaying ? 'Playing' : 'Paused', color: isPlaying ? GREEN : '#666' },
        { text: track.type === 'episode' ? 'Podcast' : 'Music', color: GREEN }
      ]
    }});

    // Controls
    ops.push({ op: 'upsert', id: 'spotify-controls', type: 'buttons', data: {
      buttons: [
        { label: '⏮', action: 'spotify-prev', style: 'ghost' },
        isPlaying
          ? { label: '⏸ Pause', action: 'spotify-pause', style: 'primary' }
          : { label: '▶ Play', action: 'spotify-play', style: 'primary' },
        { label: '⏭', action: 'spotify-next', style: 'ghost' },
        { label: '🔄', action: 'spotify-now-playing', style: 'ghost' }
      ]
    }});

    return { ops };
  }

  // ─── Playback Controls ────────────────────────────────

  async _play(context) {
    const body = context.uri ? { uris: [context.uri] } : undefined;
    // If it's a context URI (playlist, album, artist), use context_uri
    if (context.uri && (context.uri.includes(':playlist:') || context.uri.includes(':album:') || context.uri.includes(':artist:'))) {
      await this._apiRequest('PUT', '/me/player/play', { context_uri: context.uri });
    } else {
      await this._apiRequest('PUT', '/me/player/play', body || undefined);
    }
    // Brief delay to let Spotify update state
    await this._delay(300);
    return this._nowPlaying();
  }

  async _pause() {
    await this._apiRequest('PUT', '/me/player/pause');
    await this._delay(300);
    return this._nowPlaying();
  }

  async _next() {
    await this._apiRequest('POST', '/me/player/next');
    await this._delay(500);
    return this._nowPlaying();
  }

  async _prev() {
    await this._apiRequest('POST', '/me/player/previous');
    await this._delay(500);
    return this._nowPlaying();
  }

  async _volume(context) {
    const vol = Math.max(0, Math.min(100, parseInt(context.volume, 10) || 50));
    await this._apiRequest('PUT', `/me/player/volume?volume_percent=${vol}`);

    return { ops: [
      { op: 'clear' },
      ...this._nav('now'),
      { op: 'upsert', id: 'spotify-vol-set', type: 'gauge', data: {
        label: 'Volume', value: vol, max: 100, unit: '%', color: GREEN
      }},
      { op: 'upsert', id: 'spotify-vol-msg', type: 'alert', data: {
        title: 'Volume Updated', message: `Volume set to ${vol}%`, severity: 'success'
      }},
      { op: 'upsert', id: 'spotify-controls', type: 'buttons', data: {
        buttons: [
          { label: '🔇 Mute', action: 'spotify-volume', style: 'ghost' },
          { label: '🎵 Now Playing', action: 'spotify-now-playing', style: 'primary' }
        ]
      }}
    ]};
  }

  // ─── Helpers ──────────────────────────────────────────

  _formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Persistence ──────────────────────────────────────

  _saveSession(data) {
    try { fs.writeFileSync(this._sessionPath, JSON.stringify(data), { mode: 0o600 }); } catch {}
  }

  _loadSession() {
    try { return JSON.parse(fs.readFileSync(this._sessionPath, 'utf8')); } catch { return null; }
  }
}

module.exports = SpotifyWidget;
