/**
 * YouTube + YouTube Music Widget v3 — Scratchy GenUI
 * OAuth2 rewrite: shares Google OAuth tokens from Calendar/Gmail.
 * Uses googleapis npm package for all API calls.
 * Prefix: yt- / ytm-
 *
 * Auth-free actions:
 *   yt-search       — search videos/channels/playlists
 *   yt-trending     — trending videos by region
 *   ytm-search      — search music (videoCategoryId=10)
 *
 * Auth-required actions:
 *   ytm-home        — home: recently played + liked music + subscriptions
 *   ytm-library     — user's music library: liked videos, saved playlists
 *   ytm-playlists   — user's own playlists (mine=true)
 *   ytm-playlist    — tracks inside a specific playlist
 *   yt-subscriptions — subscribed channels
 *   yt-liked        — liked videos
 *   yt-video        — video details
 *   yt-channel      — channel info + recent uploads
 *   yt-play         — video player card
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getWidgetStatePath, migrateLegacyFile } = require('../../lib/widget-state');

const CREDS_PATH = process.env.GCAL_CREDS_PATH || path.join(process.env.HOME || '.', '.gcal-creds.json');
const LEGACY_SESSION_PATH = process.env.GCAL_SESSION_PATH || path.join(process.env.HOME || '.', '.gcal-session.json');
const ACCENT = '#FF0000';

class YouTubeWidget {
  /**
   * @param {string} userId — per-user session isolation (same as CalendarWidget)
   */
  constructor(userId) {
    this._userId = userId || '_legacy';
    migrateLegacyFile(LEGACY_SESSION_PATH, this._userId, 'gcal-session.json');
    this._sessionPath = getWidgetStatePath(this._userId, 'gcal-session.json');
    this.creds = this._loadCreds();
    this.session = this._loadSession();
    this.oauth2Client = null;
    if (this.creds) this._initOAuth();
  }

  // ─── OAuth (shared with Calendar / Gmail) ─────────────

  _initOAuth() {
    this.oauth2Client = new google.auth.OAuth2(
      this.creds.clientId,
      this.creds.clientSecret,
      this.creds.redirectUri || 'https://scratchy.example.com/auth/google/callback'
    );
    if (this.session && this.session.tokens) {
      this.oauth2Client.setCredentials(this.session.tokens);
    }
  }

  _isConnected() {
    return !!(this.oauth2Client && this.session && this.session.tokens);
  }

  /** Check if we have YouTube-scoped OAuth. Returns false if token exists but lacks YouTube scope. */
  _hasYouTubeAuth() {
    if (!this._isConnected()) return false;
    // Check token scopes if available
    const tokens = this.session.tokens;
    if (tokens.scope && typeof tokens.scope === 'string') {
      return tokens.scope.includes('youtube');
    }
    // If scope unknown, optimistically try (will fail gracefully)
    return true;
  }

  _loadCreds() {
    try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch { return null; }
  }

  _loadSession() {
    try { return JSON.parse(fs.readFileSync(this._sessionPath, 'utf8')); } catch { return null; }
  }

  /** Lazy-init the youtube v3 client. */
  _yt() {
    return google.youtube({ version: 'v3', auth: this.oauth2Client });
  }

  /** Silently refresh the access token before each auth-required call. */
  async _ensureFreshToken() {
    try {
      const { credentials } = await this.oauth2Client.getAccessToken();
      if (credentials) this.oauth2Client.setCredentials(credentials);
    } catch { /* token may still be valid */ }
  }

  /**
   * Execute a YouTube API call with graceful fallback:
   * 1. Try with OAuth (if connected + has YouTube scope)
   * 2. Catch scope errors → try with API key
   * 3. No API key → show connect screen
   * Works for public data (search, trending) that doesn't need user auth.
   */
  async _publicApiCall(fn) {
    // Try OAuth first (higher quota)
    if (this._isConnected() && this._hasYouTubeAuth()) {
      try {
        await this._ensureFreshToken();
        return await fn(this._yt());
      } catch (e) {
        const msg = e.message || '';
        // Scope error or auth error — fall through to API key
        if (!msg.includes('scope') && !msg.includes('auth') && !msg.includes('403') && !msg.includes('401')) {
          throw e; // Re-throw non-auth errors
        }
        console.log('[YouTubeWidget] OAuth failed for public call, trying API key fallback:', msg.slice(0, 80));
      }
    }

    // Try API key
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (apiKey) {
      return await fn(google.youtube({ version: 'v3', auth: apiKey }));
    }

    // No auth at all — need to connect
    return null;
  }

  /**
   * Execute a YouTube API call that REQUIRES user OAuth (private data).
   * On scope error, shows re-consent screen.
   */
  async _authApiCall(fn) {
    if (!this._isConnected()) return null;
    await this._ensureFreshToken();
    try {
      return await fn(this._yt());
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('scope') || msg.includes('insufficient')) {
        return '__needs_reconsent__';
      }
      throw e;
    }
  }

  _needsReConsentScreen() {
    // Generate OAuth URL directly with all scopes including YouTube
    let authUrl = null;
    if (this.oauth2Client) {
      authUrl = this.oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Force re-consent to add YouTube scope
        scope: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/tasks',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/youtube.readonly'
        ]
      });
    }

    const ops = [
      { op: 'clear' },
      ...this.nav('home'),
      { op: 'upsert', id: 'yt-reconsent', type: 'alert', data: {
        title: '🔐 YouTube Access Needed',
        message: 'Your Google account is connected but YouTube access wasn\'t included. Click below to add YouTube permissions — your Calendar and Gmail stay connected.',
        severity: 'warning'
      }}
    ];

    if (authUrl) {
      ops.push({ op: 'upsert', id: 'yt-reconsent-link', type: 'link-card', data: {
        title: '🔗 Add YouTube Access',
        description: 'Opens Google consent screen to add YouTube permissions',
        url: authUrl,
        icon: '🔐',
        color: '#FF0000',
        target: '_self'
      }});
    }

    ops.push({ op: 'upsert', id: 'yt-reconsent-alt', type: 'buttons', data: {
      buttons: [
        { label: '🔍 Search (no login needed)', action: 'yt-search', style: 'ghost' },
        { label: '🔥 Trending', action: 'yt-trending', style: 'ghost' }
      ]
    }});

    ops.push({ op: 'upsert', id: 'yt-reconsent-info', type: 'card', data: {
      title: 'What happens?',
      text: 'Google will ask you to approve YouTube read access. This is added to your existing Calendar + Gmail permissions. After approval, you\'ll be redirected back and can browse your playlists, liked videos, and subscriptions.'
    }});

    return { ops };
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context = {}) {
    try {
      // Auth-free actions (work without OAuth, use unauthenticated quota)
      switch (action) {
        case 'yt-search':   return this.search(context);
        case 'yt-trending':  return this.trending(context);
        case 'ytm-search':   return this.musicSearch(context);
      }

      // Everything below requires OAuth with YouTube scope
      if (!this._isConnected()) return this._notConnectedScreen(action);
      if (!this._hasYouTubeAuth()) return this._needsReConsentScreen();

      await this._ensureFreshToken();

      // Wrap auth-required calls to catch scope errors at runtime
      let result;
      switch (action) {
        case 'ytm-home':         result = await this.musicHome(); break;
        case 'ytm-library':      result = await this.musicLibrary(); break;
        case 'ytm-playlists':    result = await this.myPlaylists(); break;
        case 'ytm-playlist':     result = await this.playlistTracks(context); break;
        case 'yt-subscriptions': result = await this.subscriptions(); break;
        case 'yt-liked':         result = await this.likedVideos(); break;
        case 'yt-video':         result = await this.videoDetails(context); break;
        case 'yt-channel':       result = await this.channelInfo(context); break;
        case 'yt-play':          result = await this.play(context); break;
        default:
          return { ops: [
            { op: 'clear' },
            ...this.nav('home'),
            { op: 'upsert', id: 'yt-error', type: 'alert', data: {
              title: 'Unknown action',
              message: `Action "${action}" is not supported.`,
              severity: 'error'
            }}
          ]};
      }
      return result;
    } catch (err) {
      const errMsg = err.message || '';
      // Catch scope errors at runtime and redirect to re-consent
      if (errMsg.includes('scope') || errMsg.includes('insufficient') || errMsg.includes('403')) {
        console.log('[YouTubeWidget] Scope error caught, showing re-consent:', errMsg.slice(0, 80));
        return this._needsReConsentScreen();
      }
      console.error('[YouTubeWidget]', errMsg);
      return { ops: [
        { op: 'clear' },
        ...this.nav('home'),
        { op: 'upsert', id: 'yt-error', type: 'alert', data: {
          title: 'Error', message: err.message, severity: 'error'
        }}
      ]};
    }
  }

  // ─── Navigation ───────────────────────────────────────

  nav(active) {
    const tabs = [
      { label: '🏠 Home',    action: 'ytm-home',     style: active === 'home'     ? 'primary' : 'ghost' },
      { label: '🔍 Search',  action: 'yt-search',    style: active === 'search'   ? 'primary' : 'ghost' },
      { label: '📚 Library', action: 'ytm-library',   style: active === 'library'  ? 'primary' : 'ghost' },
      { label: '🔥 Trending', action: 'yt-trending',  style: active === 'trending' ? 'primary' : 'ghost' }
    ];
    return [{ op: 'upsert', id: 'yt-nav', type: 'buttons', data: { buttons: tabs } }];
  }

  // ─── Not Connected Screen ─────────────────────────────

  _notConnectedScreen() {
    return { ops: [
      { op: 'clear' },
      ...this.nav('home'),
      { op: 'upsert', id: 'yt-needs-auth', type: 'card', data: {
        title: '🔐 Connect Your Google Account',
        text: 'To access your playlists, liked videos, and subscriptions, connect via Google OAuth in Calendar or Gmail settings. The same login covers YouTube.'
      }},
      { op: 'upsert', id: 'yt-connect-btn', type: 'buttons', data: {
        buttons: [
          { label: '📅 Open Calendar (Connect)', action: 'cal-auto-connect', style: 'primary' },
          { label: '🔍 Search Instead', action: 'yt-search', style: 'ghost' }
        ]
      }}
    ]};
  }

  // ─── Auth-Free: Search ────────────────────────────────

  async search(context) {
    const { query, type } = context;

    if (!query) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'yt-search-form', type: 'form', data: {
          id: 'yt-search-form', title: '🔍 Search YouTube',
          fields: [
            { name: 'query', type: 'text', label: 'Search', required: true, placeholder: 'What are you looking for?' },
            { name: 'type', type: 'select', label: 'Type', value: 'video', options: ['video', 'channel', 'playlist'] }
          ],
          actions: [{ label: 'Search', action: 'yt-search', style: 'primary' }]
        }}
      ]};
    }

    const searchType = type || 'video';
    const params = { part: 'snippet', q: query, type: searchType, maxResults: 10 };

    let data;
    data = await this._publicApiCall(async (yt) => {
      return (await yt.search.list(params)).data;
    });

    if (!data) return this._needsReConsentScreen();
    const items = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-search-header', type: 'hero', data: {
        title: `🔍 "${query}"`, subtitle: `${items.length} ${searchType} results`, icon: '▶️'
      }}
    ];

    if (items.length === 0) {
      ops.push({ op: 'upsert', id: 'yt-no-results', type: 'card', data: {
        title: 'No results', text: `Nothing found for "${query}". Try a different search.`
      }});
      return { ops };
    }

    if (searchType === 'video') {
      ops.push({
        op: 'upsert', id: 'yt-search-results', type: 'media-list', data: {
          items: items.map(item => {
            const s = item.snippet;
            const videoId = item.id.videoId;
            return {
              id: videoId,
              title: s.title,
              subtitle: `${s.channelTitle} · ${this._relativeDate(s.publishedAt)}`,
              image: this._thumb(videoId),
              action: 'yt-play',
              context: { videoId }
            };
          })
        }
      });
    } else if (searchType === 'channel') {
      ops.push({
        op: 'upsert', id: 'yt-search-channels', type: 'carousel', data: {
          title: 'Channels',
          items: items.map(item => {
            const s = item.snippet;
            const channelId = item.id.channelId;
            const thumb = s.thumbnails && s.thumbnails.medium ? s.thumbnails.medium.url : null;
            return {
              title: s.title,
              subtitle: s.description ? s.description.substring(0, 80) : 'YouTube Channel',
              image: thumb,
              action: 'yt-channel',
              context: { channelId },
              tag: '📺'
            };
          })
        }
      });
    } else if (searchType === 'playlist') {
      ops.push({
        op: 'upsert', id: 'yt-search-playlists', type: 'carousel', data: {
          title: 'Playlists',
          items: items.map(item => {
            const s = item.snippet;
            const playlistId = item.id.playlistId;
            const thumb = s.thumbnails && s.thumbnails.medium ? s.thumbnails.medium.url : null;
            return {
              title: s.title,
              subtitle: s.channelTitle,
              image: thumb,
              action: 'ytm-playlist',
              context: { playlistId },
              tag: '🎶'
            };
          })
        }
      });
    }

    return { ops };
  }

  // ─── Auth-Free: Trending ──────────────────────────────

  async trending(context) {
    const regionCode = (context && context.regionCode) || 'FR';

    let data;
    const params = {
      part: 'snippet,statistics',
      chart: 'mostPopular',
      regionCode,
      maxResults: 10
    };

    data = await this._publicApiCall(async (yt) => {
      return (await yt.videos.list(params)).data;
    });
    if (!data) return this._needsReConsentScreen();

    const items = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('trending'),
      { op: 'upsert', id: 'yt-trending-header', type: 'hero', data: {
        title: '🔥 Trending', subtitle: `Top ${items.length} videos in ${regionCode}`, icon: '📈'
      }}
    ];

    if (items.length > 0) {
      // Top 5 as carousel
      ops.push({
        op: 'upsert', id: 'yt-trending-carousel', type: 'carousel', data: {
          title: 'Top Picks',
          items: items.slice(0, 5).map((v, i) => ({
            title: `#${i + 1} ${v.snippet.title}`,
            subtitle: `${v.snippet.channelTitle} · ${this._fmtCount(v.statistics.viewCount)} views`,
            image: this._thumb(v.id),
            action: 'yt-play',
            context: { videoId: v.id },
            tag: `#${i + 1}`
          }))
        }
      });

      // Full list as media-list
      ops.push({
        op: 'upsert', id: 'yt-trending-list', type: 'media-list', data: {
          title: 'All Trending',
          items: items.map((v, i) => ({
            id: v.id,
            title: `#${i + 1} ${v.snippet.title}`,
            subtitle: `${v.snippet.channelTitle} · ${this._fmtCount(v.statistics.viewCount)} views`,
            image: this._thumb(v.id),
            action: 'yt-play',
            context: { videoId: v.id }
          }))
        }
      });
    }

    return { ops };
  }

  // ─── Auth-Free: Music Search ──────────────────────────

  async musicSearch(context) {
    const { query } = context || {};

    if (!query) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'ytm-search-form', type: 'form', data: {
          id: 'ytm-search-form', title: '🎵 Search Music',
          fields: [
            { name: 'query', type: 'text', label: 'Search', required: true, placeholder: 'Artist, song, album...' }
          ],
          actions: [{ label: 'Search', action: 'ytm-search', style: 'primary' }]
        }}
      ]};
    }

    const params = {
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      maxResults: 10
    };

    let data = await this._publicApiCall(async (yt) => {
      return (await yt.search.list(params)).data;
    });
    if (!data) return this._needsReConsentScreen();

    const items = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'ytm-header', type: 'hero', data: {
        title: `🎵 "${query}"`, subtitle: `${items.length} music results`, icon: '🎶'
      }}
    ];

    if (items.length > 0) {
      ops.push({
        op: 'upsert', id: 'ytm-results', type: 'media-list', data: {
          items: items.map(item => {
            const s = item.snippet;
            const videoId = item.id.videoId;
            return {
              id: videoId,
              title: s.title,
              subtitle: `🎵 ${s.channelTitle} · ${this._relativeDate(s.publishedAt)}`,
              image: this._thumb(videoId),
              action: 'yt-play',
              context: { videoId }
            };
          })
        }
      });
    } else {
      ops.push({ op: 'upsert', id: 'ytm-no-results', type: 'card', data: {
        title: 'No results', text: `No music found for "${query}". Try a different search.`
      }});
    }

    return { ops };
  }

  // ─── Auth-Required: Music Home ────────────────────────

  async musicHome() {
    const yt = this._yt();

    // Parallel fetch: liked music, playlists, subscriptions
    const [likedRes, playlistsRes, subsRes] = await Promise.allSettled([
      yt.playlistItems.list({ part: 'snippet', playlistId: 'LL', maxResults: 10 }),
      yt.playlists.list({ part: 'snippet,contentDetails', mine: true, maxResults: 10 }),
      yt.subscriptions.list({ part: 'snippet', mine: true, maxResults: 10, order: 'relevance' })
    ]);

    const ops = [
      { op: 'clear' },
      ...this.nav('home'),
      { op: 'upsert', id: 'yt-home-hero', type: 'hero', data: {
        title: '🏠 YouTube Music', subtitle: 'Your music at a glance', icon: '🎶'
      }}
    ];

    // Liked music carousel
    if (likedRes.status === 'fulfilled') {
      const liked = (likedRes.value.data.items || []).filter(i => i.snippet && i.snippet.title !== 'Deleted video');
      if (liked.length > 0) {
        ops.push({
          op: 'upsert', id: 'yt-home-liked', type: 'carousel', data: {
            title: '❤️ Liked Music',
            items: liked.map(item => {
              const s = item.snippet;
              const videoId = s.resourceId && s.resourceId.videoId;
              return {
                title: s.title,
                subtitle: s.videoOwnerChannelTitle || '',
                image: videoId ? this._thumb(videoId) : this._snippetThumb(s),
                action: 'yt-play',
                context: { videoId },
                tag: '❤️'
              };
            })
          }
        });
      }
    }

    // Playlists carousel
    if (playlistsRes.status === 'fulfilled') {
      const playlists = playlistsRes.value.data.items || [];
      if (playlists.length > 0) {
        ops.push({
          op: 'upsert', id: 'yt-home-playlists', type: 'carousel', data: {
            title: '📋 Your Playlists',
            items: playlists.map(pl => {
              const s = pl.snippet;
              const count = pl.contentDetails ? pl.contentDetails.itemCount : 0;
              return {
                title: s.title,
                subtitle: `${count} tracks`,
                image: this._snippetThumb(s),
                action: 'ytm-playlist',
                context: { playlistId: pl.id },
                tag: `${count}`
              };
            })
          }
        });
      }
    }

    // Subscriptions carousel
    if (subsRes.status === 'fulfilled') {
      const subs = subsRes.value.data.items || [];
      if (subs.length > 0) {
        ops.push({
          op: 'upsert', id: 'yt-home-subs', type: 'carousel', data: {
            title: '📺 Subscriptions',
            items: subs.map(sub => {
              const s = sub.snippet;
              const channelId = s.resourceId && s.resourceId.channelId;
              return {
                title: s.title,
                subtitle: s.description ? s.description.substring(0, 60) : '',
                image: this._snippetThumb(s),
                action: 'yt-channel',
                context: { channelId },
                tag: '📺'
              };
            })
          }
        });
      }
    }

    // Quick actions
    ops.push({
      op: 'upsert', id: 'yt-home-actions', type: 'buttons', data: {
        buttons: [
          { label: '❤️ Liked Videos', action: 'yt-liked', style: 'ghost' },
          { label: '📋 My Playlists', action: 'ytm-playlists', style: 'ghost' },
          { label: '📺 Subscriptions', action: 'yt-subscriptions', style: 'ghost' }
        ]
      }
    });

    return { ops };
  }

  // ─── Auth-Required: Music Library ─────────────────────

  async musicLibrary() {
    const yt = this._yt();

    const [likedRes, playlistsRes] = await Promise.allSettled([
      yt.playlistItems.list({ part: 'snippet', playlistId: 'LL', maxResults: 25 }),
      yt.playlists.list({ part: 'snippet,contentDetails', mine: true, maxResults: 25 })
    ]);

    const ops = [
      { op: 'clear' },
      ...this.nav('library'),
      { op: 'upsert', id: 'yt-lib-hero', type: 'hero', data: {
        title: '📚 Your Library', subtitle: 'Liked videos and playlists', icon: '📚'
      }}
    ];

    // Playlists section
    if (playlistsRes.status === 'fulfilled') {
      const playlists = playlistsRes.value.data.items || [];
      if (playlists.length > 0) {
        ops.push({
          op: 'upsert', id: 'yt-lib-playlists', type: 'media-list', data: {
            title: `📋 Playlists (${playlists.length})`,
            items: playlists.map(pl => {
              const s = pl.snippet;
              const count = pl.contentDetails ? pl.contentDetails.itemCount : 0;
              return {
                id: pl.id,
                title: s.title,
                subtitle: `${count} tracks · ${this._relativeDate(s.publishedAt)}`,
                image: this._snippetThumb(s),
                action: 'ytm-playlist',
                context: { playlistId: pl.id }
              };
            })
          }
        });
      }
    }

    // Liked videos section
    if (likedRes.status === 'fulfilled') {
      const liked = (likedRes.value.data.items || []).filter(i => i.snippet && i.snippet.title !== 'Deleted video');
      if (liked.length > 0) {
        ops.push({
          op: 'upsert', id: 'yt-lib-liked', type: 'media-list', data: {
            title: `❤️ Liked Videos (${liked.length})`,
            items: liked.map(item => {
              const s = item.snippet;
              const videoId = s.resourceId && s.resourceId.videoId;
              return {
                id: videoId,
                title: s.title,
                subtitle: s.videoOwnerChannelTitle || this._relativeDate(s.publishedAt),
                image: videoId ? this._thumb(videoId) : this._snippetThumb(s),
                action: 'yt-play',
                context: { videoId }
              };
            })
          }
        });
      }
    }

    ops.push({
      op: 'upsert', id: 'yt-lib-actions', type: 'buttons', data: {
        buttons: [
          { label: '❤️ All Liked', action: 'yt-liked', style: 'ghost' },
          { label: '📋 All Playlists', action: 'ytm-playlists', style: 'ghost' }
        ]
      }
    });

    return { ops };
  }

  // ─── Auth-Required: My Playlists ──────────────────────

  async myPlaylists() {
    const yt = this._yt();
    const { data } = await yt.playlists.list({
      part: 'snippet,contentDetails',
      mine: true,
      maxResults: 25
    });

    const playlists = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('library'),
      { op: 'upsert', id: 'yt-pl-hero', type: 'hero', data: {
        title: '📋 My Playlists',
        subtitle: `${playlists.length} playlist${playlists.length !== 1 ? 's' : ''}`,
        icon: '📋'
      }}
    ];

    if (playlists.length === 0) {
      ops.push({ op: 'upsert', id: 'yt-pl-empty', type: 'card', data: {
        title: 'No playlists', text: 'You have no playlists yet. Create one on YouTube!'
      }});
    } else {
      ops.push({
        op: 'upsert', id: 'yt-pl-list', type: 'media-list', data: {
          title: 'Your Playlists',
          items: playlists.map(pl => {
            const s = pl.snippet;
            const count = pl.contentDetails ? pl.contentDetails.itemCount : 0;
            return {
              id: pl.id,
              title: s.title,
              subtitle: `${count} tracks · ${s.description ? s.description.substring(0, 60) : 'No description'}`,
              image: this._snippetThumb(s),
              action: 'ytm-playlist',
              context: { playlistId: pl.id }
            };
          })
        }
      });
    }

    return { ops };
  }

  // ─── Auth-Required: Playlist Tracks ───────────────────

  async playlistTracks(context) {
    const { playlistId } = context;
    if (!playlistId) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('library'),
        { op: 'upsert', id: 'yt-error', type: 'alert', data: {
          title: 'Missing playlist', message: 'No playlistId provided.', severity: 'warning'
        }}
      ]};
    }

    const yt = this._yt();

    // Fetch playlist metadata + items in parallel
    const [metaRes, itemsRes] = await Promise.all([
      yt.playlists.list({ part: 'snippet,contentDetails', id: playlistId }).catch(() => null),
      yt.playlistItems.list({ part: 'snippet,contentDetails', playlistId, maxResults: 50 })
    ]);

    const meta = metaRes && metaRes.data.items && metaRes.data.items[0];
    const items = (itemsRes.data.items || []).filter(i => i.snippet && i.snippet.title !== 'Deleted video' && i.snippet.title !== 'Private video');
    const plTitle = meta ? meta.snippet.title : 'Playlist';
    const plCount = meta && meta.contentDetails ? meta.contentDetails.itemCount : items.length;

    const ops = [
      { op: 'clear' },
      ...this.nav('library'),
      { op: 'upsert', id: 'yt-plt-hero', type: 'hero', data: {
        title: `🎶 ${plTitle}`,
        subtitle: `${plCount} tracks`,
        icon: '📋'
      }}
    ];

    if (items.length === 0) {
      ops.push({ op: 'upsert', id: 'yt-plt-empty', type: 'card', data: {
        title: 'Empty playlist', text: 'This playlist has no tracks.'
      }});
    } else {
      ops.push({
        op: 'upsert', id: 'yt-plt-tracks', type: 'media-list', data: {
          title: plTitle,
          items: items.map((item, idx) => {
            const s = item.snippet;
            const videoId = s.resourceId && s.resourceId.videoId;
            return {
              id: videoId || `track-${idx}`,
              title: s.title,
              subtitle: s.videoOwnerChannelTitle || s.channelTitle || '',
              image: videoId ? this._thumb(videoId) : this._snippetThumb(s),
              action: 'yt-play',
              context: { videoId }
            };
          })
        }
      });
    }

    ops.push({
      op: 'upsert', id: 'yt-plt-actions', type: 'buttons', data: {
        buttons: [
          { label: '← Back', action: 'ytm-playlists', style: 'ghost' },
          { label: '🔗 Open on YouTube', action: 'yt-open-playlist', style: 'ghost', context: { playlistId } }
        ]
      }
    });

    if (playlistId !== 'LL') {
      ops.push({
        op: 'upsert', id: 'yt-plt-link', type: 'link-card', data: {
          title: 'Open on YouTube',
          description: plTitle,
          url: `https://www.youtube.com/playlist?list=${playlistId}`,
          icon: '▶️', color: ACCENT
        }
      });
    }

    return { ops };
  }

  // ─── Auth-Required: Subscriptions ─────────────────────

  async subscriptions() {
    const yt = this._yt();
    const { data } = await yt.subscriptions.list({
      part: 'snippet',
      mine: true,
      maxResults: 20,
      order: 'relevance'
    });

    const subs = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('home'),
      { op: 'upsert', id: 'yt-subs-hero', type: 'hero', data: {
        title: '📺 Subscriptions',
        subtitle: `${subs.length} channels`,
        icon: '📺'
      }}
    ];

    if (subs.length === 0) {
      ops.push({ op: 'upsert', id: 'yt-subs-empty', type: 'card', data: {
        title: 'No subscriptions', text: 'You are not subscribed to any channels.'
      }});
    } else {
      ops.push({
        op: 'upsert', id: 'yt-subs-carousel', type: 'carousel', data: {
          title: 'Your Channels',
          items: subs.map(sub => {
            const s = sub.snippet;
            const channelId = s.resourceId && s.resourceId.channelId;
            return {
              title: s.title,
              subtitle: s.description ? s.description.substring(0, 60) : '',
              image: this._snippetThumb(s),
              action: 'yt-channel',
              context: { channelId },
              tag: '📺'
            };
          })
        }
      });

      // Also as media-list for full view
      ops.push({
        op: 'upsert', id: 'yt-subs-list', type: 'media-list', data: {
          title: 'All Subscriptions',
          items: subs.map(sub => {
            const s = sub.snippet;
            const channelId = s.resourceId && s.resourceId.channelId;
            return {
              id: channelId,
              title: s.title,
              subtitle: s.description ? s.description.substring(0, 80) : 'YouTube Channel',
              image: this._snippetThumb(s),
              action: 'yt-channel',
              context: { channelId }
            };
          })
        }
      });
    }

    return { ops };
  }

  // ─── Auth-Required: Liked Videos ──────────────────────

  async likedVideos() {
    const yt = this._yt();
    const { data } = await yt.playlistItems.list({
      part: 'snippet',
      playlistId: 'LL',
      maxResults: 25
    });

    const items = (data.items || []).filter(i => i.snippet && i.snippet.title !== 'Deleted video');
    const ops = [
      { op: 'clear' },
      ...this.nav('library'),
      { op: 'upsert', id: 'yt-liked-hero', type: 'hero', data: {
        title: '❤️ Liked Videos',
        subtitle: `${items.length} videos`,
        icon: '❤️'
      }}
    ];

    if (items.length === 0) {
      ops.push({ op: 'upsert', id: 'yt-liked-empty', type: 'card', data: {
        title: 'No liked videos', text: 'Like some videos on YouTube to see them here!'
      }});
    } else {
      ops.push({
        op: 'upsert', id: 'yt-liked-list', type: 'media-list', data: {
          title: 'Liked Videos',
          items: items.map(item => {
            const s = item.snippet;
            const videoId = s.resourceId && s.resourceId.videoId;
            return {
              id: videoId,
              title: s.title,
              subtitle: `${s.videoOwnerChannelTitle || ''} · ${this._relativeDate(s.publishedAt)}`,
              image: videoId ? this._thumb(videoId) : this._snippetThumb(s),
              action: 'yt-play',
              context: { videoId }
            };
          })
        }
      });
    }

    return { ops };
  }

  // ─── Auth-Required: Video Details ─────────────────────

  async videoDetails(context) {
    const { videoId } = context;
    if (!videoId) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'yt-error', type: 'alert', data: {
          title: 'Missing videoId', message: 'Provide a videoId to view details.', severity: 'warning'
        }}
      ]};
    }

    const yt = this._yt();
    const { data } = await yt.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: videoId
    });

    const v = (data.items || [])[0];
    if (!v) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'yt-not-found', type: 'alert', data: {
          title: 'Not found', message: `Video "${videoId}" does not exist.`, severity: 'error'
        }}
      ]};
    }

    const s = v.snippet;
    const st = v.statistics;
    const cd = v.contentDetails;

    return { ops: [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-vid-thumb', type: 'image', data: {
        title: s.title,
        src: this._thumb(videoId),
        caption: s.channelTitle,
        alt: s.title
      }},
      { op: 'upsert', id: 'yt-vid-stats', type: 'stats', data: {
        title: '📊 Stats',
        items: [
          { label: 'Views', value: this._fmtCount(st.viewCount) },
          { label: 'Likes', value: this._fmtCount(st.likeCount) },
          { label: 'Comments', value: this._fmtCount(st.commentCount) }
        ]
      }},
      { op: 'upsert', id: 'yt-vid-info', type: 'kv', data: {
        title: s.title,
        items: [
          { key: 'Channel', value: s.channelTitle },
          { key: 'Published', value: this._relativeDate(s.publishedAt) },
          { key: 'Duration', value: this._parseDuration(cd.duration) },
          { key: 'Definition', value: (cd.definition || 'sd').toUpperCase() }
        ]
      }},
      { op: 'upsert', id: 'yt-vid-tags', type: 'tags', data: {
        label: 'Tags',
        items: (s.tags || []).slice(0, 8).map(t => ({ text: t, color: ACCENT }))
      }},
      { op: 'upsert', id: 'yt-vid-actions', type: 'buttons', data: {
        buttons: [
          { label: '▶️ Play', action: 'yt-play', style: 'primary', context: { videoId } },
          { label: '📺 Channel', action: 'yt-channel', style: 'ghost', context: { channelId: s.channelId } }
        ]
      }},
      { op: 'upsert', id: 'yt-vid-link', type: 'link-card', data: {
        title: 'Watch on YouTube',
        description: s.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        icon: '▶️', color: ACCENT
      }}
    ]};
  }

  // ─── Auth-Required: Channel Info ──────────────────────

  async channelInfo(context) {
    const { channelId } = context;
    if (!channelId) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'yt-error', type: 'alert', data: {
          title: 'Missing channelId', message: 'Provide a channelId to view channel info.', severity: 'warning'
        }}
      ]};
    }

    const yt = this._yt();
    const [chRes, uploadsRes] = await Promise.all([
      yt.channels.list({ part: 'snippet,statistics,contentDetails', id: channelId }),
      yt.search.list({ part: 'snippet', channelId, order: 'date', type: 'video', maxResults: 8 })
    ]);

    const ch = (chRes.data.items || [])[0];
    if (!ch) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'yt-not-found', type: 'alert', data: {
          title: 'Not found', message: `Channel "${channelId}" does not exist.`, severity: 'error'
        }}
      ]};
    }

    const s = ch.snippet;
    const st = ch.statistics;
    const uploads = uploadsRes.data.items || [];

    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-ch-hero', type: 'hero', data: {
        title: `📺 ${s.title}`,
        subtitle: s.customUrl || (s.description ? s.description.substring(0, 100) : 'YouTube Channel'),
        icon: '📺'
      }},
      { op: 'upsert', id: 'yt-ch-stats', type: 'stats', data: {
        title: 'Channel Stats',
        items: [
          { label: 'Subscribers', value: st.hiddenSubscriberCount ? 'Hidden' : this._fmtCount(st.subscriberCount) },
          { label: 'Videos', value: this._fmtCount(st.videoCount) },
          { label: 'Views', value: this._fmtCount(st.viewCount) }
        ]
      }}
    ];

    if (uploads.length > 0) {
      ops.push({
        op: 'upsert', id: 'yt-ch-uploads', type: 'media-list', data: {
          title: `🎬 Recent Uploads (${uploads.length})`,
          items: uploads.map(item => {
            const videoId = item.id.videoId;
            const vs = item.snippet;
            return {
              id: videoId,
              title: vs.title,
              subtitle: `${this._relativeDate(vs.publishedAt)}`,
              image: this._thumb(videoId),
              action: 'yt-play',
              context: { videoId }
            };
          })
        }
      });
    }

    ops.push({ op: 'upsert', id: 'yt-ch-link', type: 'link-card', data: {
      title: 'View on YouTube',
      description: s.title,
      url: `https://www.youtube.com/channel/${channelId}`,
      icon: '📺', color: ACCENT
    }});

    return { ops };
  }

  // ─── Auth-Required: Play ──────────────────────────────

  async play(context) {
    const { videoId } = context;
    if (!videoId) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('search'),
        { op: 'upsert', id: 'yt-error', type: 'alert', data: {
          title: 'Missing videoId', message: 'Provide a videoId to play.', severity: 'warning'
        }}
      ]};
    }

    // Fetch video info — use authenticated if possible, else fallback
    let v = null;
    const params = { part: 'snippet,contentDetails,statistics', id: videoId };

    if (this._isConnected()) {
      const { data } = await this._yt().videos.list(params);
      v = (data.items || [])[0];
    } else {
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        const { data } = await google.youtube({ version: 'v3', auth: apiKey }).videos.list(params);
        v = (data.items || [])[0];
      } else if (this.oauth2Client) {
        try {
          const { data } = await google.youtube({ version: 'v3', auth: this.oauth2Client }).videos.list(params);
          v = (data.items || [])[0];
        } catch { /* fall through to basic player */ }
      }
    }

    const title = v ? v.snippet.title : 'YouTube Video';
    const channel = v ? v.snippet.channelTitle : '';
    const duration = v && v.contentDetails ? this._parseDuration(v.contentDetails.duration) : '';
    const durationSecs = v && v.contentDetails ? this._parseDurationSeconds(v.contentDetails.duration) : 0;
    const thumb = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    const channelId = v ? v.snippet.channelId : '';

    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-player', type: 'player', data: {
        title,
        subtitle: channel + (duration ? ` · ${duration}` : ''),
        cover: thumb,
        status: 'playing',
        progress: { value: 0, max: durationSecs, label: `0:00 / ${duration || '?'}` },
        controls: [
          { id: 'details', icon: 'ℹ️', action: 'yt-video', context: { videoId } },
          { id: 'play', icon: '▶️', action: 'yt-play', style: 'primary', size: 'lg', context: { videoId } },
          { id: 'channel', icon: '📺', action: 'yt-channel', context: { channelId } }
        ],
        options: [
          { icon: '🔍', action: 'yt-search' },
          { icon: '🔥', action: 'yt-trending' }
        ]
      }}
    ];

    // Stats if available
    if (v && v.statistics) {
      ops.push({ op: 'upsert', id: 'yt-player-stats', type: 'stats', data: {
        title: '📊',
        items: [
          { label: 'Views', value: this._fmtCount(v.statistics.viewCount) },
          { label: 'Likes', value: this._fmtCount(v.statistics.likeCount) }
        ]
      }});
    }

    ops.push({ op: 'upsert', id: 'yt-player-link', type: 'link-card', data: {
      title: 'Watch on YouTube',
      description: title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      icon: '▶️', color: ACCENT
    }});

    return { ops };
  }

  // ─── Formatting Helpers ───────────────────────────────

  _thumb(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  }

  _snippetThumb(snippet) {
    if (!snippet || !snippet.thumbnails) return null;
    const t = snippet.thumbnails;
    return (t.medium && t.medium.url) || (t.default && t.default.url) || (t.high && t.high.url) || null;
  }

  _fmtCount(n) {
    if (n == null) return '—';
    const num = Number(n);
    if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return String(num);
  }

  _parseDuration(iso) {
    if (!iso) return '—';
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return iso;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${min}:${String(s).padStart(2, '0')}`;
  }

  _parseDurationSeconds(iso) {
    if (!iso) return 0;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || '0', 10) * 3600) +
           (parseInt(m[2] || '0', 10) * 60) +
           parseInt(m[3] || '0', 10);
  }

  _relativeDate(isoDate) {
    if (!isoDate) return '';
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }
}

module.exports = YouTubeWidget;
