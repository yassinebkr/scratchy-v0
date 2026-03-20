/**
 * Spotify Widget v2 — Scratchy GenUI
 * Refactored to use player, media-list, and carousel components.
 * Standalone widget: OAuth2 flow, playback control, search, playlists
 * Prefix: spotify-
 *
 * Design principles:
 * - Clear before render: every view starts with { op: 'clear' }
 * - Uses player component for Now Playing (1 op vs 5-6 ops)
 * - Uses media-list for track lists
 * - Uses carousel for playlist browsing
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
        case 'spotify-shuffle':      return this._shuffle(context);
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

    // Tracks → media-list (single op)
    const tracks = (data.tracks && data.tracks.items) || [];
    if (tracks.length > 0) {
      const listItems = tracks.slice(0, 8).map(track => {
        const artists = track.artists.map(a => a.name).join(', ');
        const albumArt = (track.album && track.album.images && track.album.images[0])
          ? track.album.images[0].url : null;
        return {
          id: track.id,
          title: track.name,
          subtitle: `${artists} · ${track.album ? track.album.name : 'Unknown Album'}`,
          image: albumArt,
          duration: this._formatMs(track.duration_ms),
          action: 'spotify-play',
          context: { uri: track.uri }
        };
      });
      ops.push({
        op: 'upsert', id: 'spotify-search-tracks', type: 'media-list', data: {
          title: `🎵 Tracks (${tracks.length})`,
          items: listItems
        }
      });
    }

    // Artists → tags (kept compact — already efficient)
    const artists = (data.artists && data.artists.items) || [];
    if (artists.length > 0) {
      ops.push({ op: 'upsert', id: 'spotify-search-artists', type: 'tags', data: {
        label: 'Artists', items: artists.slice(0, 5).map(a => ({ text: a.name, color: GREEN }))
      }});
    }

    // Albums → carousel (single op)
    const albums = (data.albums && data.albums.items) || [];
    if (albums.length > 0) {
      const carouselItems = albums.slice(0, 8).map(album => {
        const albumArt = (album.images && album.images[0]) ? album.images[0].url : null;
        const albumArtists = album.artists.map(a => a.name).join(', ');
        return {
          title: album.name,
          subtitle: albumArtists,
          image: albumArt,
          action: 'spotify-play',
          context: { uri: album.uri },
          tag: album.album_type === 'single' ? 'Single' : ''
        };
      });
      ops.push({
        op: 'upsert', id: 'spotify-search-albums', type: 'carousel', data: {
          title: `💿 Albums (${albums.length})`,
          items: carouselItems
        }
      });
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
      // Carousel for visual browsing
      const carouselItems = playlists.map(pl => {
        const imgUrl = (pl.images && pl.images[0]) ? pl.images[0].url : null;
        return {
          title: pl.name,
          subtitle: `${pl.tracks.total} tracks · ${pl.owner.display_name}`,
          image: imgUrl,
          action: 'spotify-playlist',
          context: { playlistId: pl.id }
        };
      });
      ops.push({
        op: 'upsert', id: 'spotify-playlists-carousel', type: 'carousel', data: {
          title: 'Browse',
          items: carouselItems
        }
      });

      // Media-list for full browsing with play action
      const listItems = playlists.map(pl => {
        const imgUrl = (pl.images && pl.images[0]) ? pl.images[0].url : null;
        return {
          id: pl.id,
          title: pl.name,
          subtitle: `${pl.tracks.total} tracks · ${pl.owner.display_name}`,
          image: imgUrl,
          action: 'spotify-playlist',
          context: { playlistId: pl.id }
        };
      });
      ops.push({
        op: 'upsert', id: 'spotify-playlists-list', type: 'media-list', data: {
          title: 'All Playlists',
          items: listItems
        }
      });
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

    const data = await this._apiRequest('GET', `/playlists/${context.playlistId}?fields=name,description,images,uri,tracks.items(track(id,name,artists,album,duration_ms,uri)),tracks.total`);

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
        { label: '▶ Play All', action: 'spotify-play', style: 'primary', context: { uri: data.uri } }
      ]
    }});

    // Track list as media-list (single op instead of N ops)
    const trackItems = (data.tracks && data.tracks.items) || [];
    const validTracks = trackItems.filter(item => item.track);
    if (validTracks.length > 0) {
      const listItems = validTracks.map(item => {
        const t = item.track;
        const artists = t.artists.map(a => a.name).join(', ');
        const albumArt = (t.album && t.album.images && t.album.images[0])
          ? t.album.images[0].url : null;
        return {
          id: t.id,
          title: t.name,
          subtitle: `${artists} · ${t.album ? t.album.name : ''}`,
          image: albumArt,
          duration: this._formatMs(t.duration_ms),
          action: 'spotify-play',
          context: { uri: t.uri }
        };
      });
      ops.push({
        op: 'upsert', id: 'spotify-pl-tracks', type: 'media-list', data: {
          title: `Tracks (${data.tracks.total})`,
          items: listItems
        }
      });
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

    // Single player component replaces: image + kv + progress + tags + buttons (5 ops → 1)
    ops.push({ op: 'upsert', id: 'spotify-player', type: 'player', data: {
      title: track.name,
      subtitle: `${artists} · ${albumName}`,
      cover: albumArt,
      status: isPlaying ? 'playing' : 'paused',
      progress: {
        value: Math.round(progressMs / 1000),
        max: Math.round(durationMs / 1000),
        label: `${this._formatMs(progressMs)} / ${this._formatMs(durationMs)}`
      },
      controls: [
        { id: 'prev', icon: '⏮', action: 'spotify-prev' },
        { id: 'playpause', icon: isPlaying ? '⏸' : '▶', action: isPlaying ? 'spotify-pause' : 'spotify-play', style: 'primary', size: 'lg' },
        { id: 'next', icon: '⏭', action: 'spotify-next' }
      ],
      options: [
        { icon: '🔀', action: 'spotify-shuffle' },
        { icon: '🔄', action: 'spotify-now-playing' }
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
          { label: '🔇 Mute', action: 'spotify-volume', style: 'ghost', context: { volume: 0 } },
          { label: '🎵 Now Playing', action: 'spotify-now-playing', style: 'primary' }
        ]
      }}
    ]};
  }

  async _shuffle(context) {
    // Toggle shuffle — Spotify API requires explicit state
    const playerData = await this._apiRequest('GET', '/me/player');
    const currentShuffle = playerData && playerData.shuffle_state;
    const newState = currentShuffle ? 'false' : 'true';
    await this._apiRequest('PUT', `/me/player/shuffle?state=${newState}`);
    await this._delay(300);
    return this._nowPlaying();
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
