/**
 * YouTube + YouTube Music Widget v2 — Scratchy GenUI
 * Refactored to use player, media-list, and carousel components.
 * Standalone widget: YouTube Data API v3 (API key auth)
 * Prefix: yt- / ytm-
 *
 * Actions:
 *   yt-search      — search videos/channels/playlists
 *   yt-trending     — trending videos
 *   yt-video        — video details
 *   yt-channel      — channel info + recent uploads
 *   ytm-search      — search music (videoCategoryId=10)
 *   ytm-playlists   — popular music playlists
 *   yt-play         — video player card
 */

const https = require('node:https');

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const ACCENT = '#FF0000';

class YouTubeWidget {
  constructor({ apiKey } = {}) {
    this.apiKey = apiKey || null;
  }

  // ─── Entry Point ──────────────────────────────────────

  async handleAction(action, context = {}) {
    try {
      if (action === 'yt-setup') return this.setup(context);

      if (!this.apiKey) return { ops: this.needsSetupOps() };

      switch (action) {
        case 'yt-search':       return this.search(context);
        case 'yt-trending':     return this.trending(context);
        case 'yt-video':        return this.videoDetails(context);
        case 'yt-channel':      return this.channelInfo(context);
        case 'ytm-search':      return this.musicSearch(context);
        case 'ytm-playlists':   return this.musicPlaylists(context);
        case 'yt-play':         return this.play(context);
        default:
          return { ops: [
            { op: 'clear' },
            { op: 'upsert', id: 'yt-error', type: 'alert', data: {
              title: 'Unknown action', message: `Action "${action}" is not supported.`, severity: 'error'
            }}
          ]};
      }
    } catch (err) {
      console.error('[YouTubeWidget]', err.message);
      return { ops: [
        { op: 'clear' },
        ...this.nav('error'),
        { op: 'upsert', id: 'yt-error', type: 'alert', data: {
          title: 'Error', message: err.message, severity: 'error'
        }}
      ]};
    }
  }

  // ─── Setup ────────────────────────────────────────────

  needsSetupOps() {
    return [
      { op: 'clear' },
      { op: 'upsert', id: 'yt-header', type: 'card', data: {
        title: '▶️ YouTube', text: 'An API key is required to use this widget.'
      }},
      { op: 'upsert', id: 'yt-setup-info', type: 'kv', data: {
        title: 'How to get an API key',
        items: [
          { key: '1', value: 'Go to console.cloud.google.com' },
          { key: '2', value: 'Create or select a project' },
          { key: '3', value: 'Enable "YouTube Data API v3"' },
          { key: '4', value: 'Go to Credentials → Create API Key' },
          { key: '5', value: 'Paste the key below' }
        ]
      }},
      { op: 'upsert', id: 'yt-setup-form', type: 'form', data: {
        id: 'yt-setup-form', title: 'YouTube API Key',
        fields: [
          { name: 'apiKey', type: 'text', label: 'API Key', required: true, placeholder: 'AIzaSy...' }
        ],
        actions: [{ label: 'Connect', action: 'yt-setup', style: 'primary' }]
      }}
    ];
  }

  setup(context) {
    const { apiKey } = context;
    if (!apiKey || !apiKey.trim()) {
      return { ops: [{ op: 'upsert', id: 'yt-error', type: 'alert', data: {
        title: 'Missing API Key', message: 'Please provide a valid YouTube API key.', severity: 'warning'
      }}]};
    }
    this.apiKey = apiKey.trim();
    return { ops: [
      { op: 'clear' },
      ...this.nav('home'),
      { op: 'upsert', id: 'yt-connected', type: 'alert', data: {
        title: 'Connected', message: 'YouTube API key set. You are ready to go!', severity: 'success'
      }},
      { op: 'upsert', id: 'yt-welcome', type: 'hero', data: {
        title: '▶️ YouTube', subtitle: 'Search videos, browse trending, explore music', icon: '🎬'
      }}
    ]};
  }

  // ─── Navigation ───────────────────────────────────────

  nav(active) {
    const tabs = [
      { label: '🔍 Search', action: 'yt-search', style: active === 'search' ? 'primary' : 'ghost' },
      { label: '🔥 Trending', action: 'yt-trending', style: active === 'trending' ? 'primary' : 'ghost' },
      { label: '🎵 Music', action: 'ytm-search', style: active === 'music' ? 'primary' : 'ghost' },
      { label: '🎶 Playlists', action: 'ytm-playlists', style: active === 'playlists' ? 'primary' : 'ghost' }
    ];
    return [{ op: 'upsert', id: 'yt-nav', type: 'buttons', data: { buttons: tabs } }];
  }

  // ─── Search ───────────────────────────────────────────

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
    const params = {
      part: 'snippet',
      q: query,
      type: searchType,
      maxResults: 8
    };

    const data = await this.apiGet('/search', params);
    const items = data.items || [];

    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-search-header', type: 'hero', data: {
        title: `🔍 "${query}"`, subtitle: `${items.length} ${searchType} results`, icon: '▶️'
      }}
    ];

    if (searchType === 'video') {
      // Use media-list for video results — single op
      const listItems = items.map(item => {
        const s = item.snippet;
        const videoId = item.id.videoId;
        return {
          id: videoId,
          title: s.title,
          subtitle: `${s.channelTitle} · ${this.relativeDate(s.publishedAt)}`,
          image: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
          action: 'yt-play',
          context: { videoId }
        };
      });
      ops.push({
        op: 'upsert', id: 'yt-search-results', type: 'media-list', data: {
          items: listItems
        }
      });
    } else if (searchType === 'channel') {
      for (const item of items) {
        const channelId = item.id.channelId;
        const s = item.snippet;
        ops.push({
          op: 'upsert', id: `yt-ch-${channelId}`, type: 'link-card', data: {
            title: s.title,
            description: s.description || 'YouTube Channel',
            url: `https://www.youtube.com/channel/${channelId}`,
            icon: '📺', color: ACCENT
          }
        });
        ops.push({
          op: 'upsert', id: `yt-ch-btn-${channelId}`, type: 'buttons', data: {
            buttons: [{ label: '📺 View Channel', action: 'yt-channel', style: 'ghost', context: { channelId } }]
          }
        });
      }
    } else if (searchType === 'playlist') {
      // Use carousel for playlist results
      const carouselItems = items.map(item => {
        const s = item.snippet;
        const playlistId = item.id.playlistId;
        const thumb = (s.thumbnails && s.thumbnails.medium) ? s.thumbnails.medium.url : null;
        return {
          title: s.title,
          subtitle: s.channelTitle,
          image: thumb,
          action: 'yt-open-playlist',
          context: { playlistId },
          tag: 'Playlist'
        };
      });
      ops.push({
        op: 'upsert', id: 'yt-search-playlists', type: 'carousel', data: {
          items: carouselItems
        }
      });
    }

    if (items.length === 0) {
      ops.push({ op: 'upsert', id: 'yt-no-results', type: 'card', data: {
        title: 'No results', text: `Nothing found for "${query}". Try a different search.`
      }});
    }

    return { ops };
  }

  // ─── Trending ─────────────────────────────────────────

  async trending(context) {
    const regionCode = (context && context.regionCode) || 'FR';

    const data = await this.apiGet('/videos', {
      part: 'snippet,statistics',
      chart: 'mostPopular',
      regionCode,
      maxResults: 10
    });

    const items = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('trending'),
      { op: 'upsert', id: 'yt-trending-header', type: 'hero', data: {
        title: '🔥 Trending', subtitle: `Top ${items.length} videos in ${regionCode}`, icon: '📈'
      }}
    ];

    // Top 5 as carousel
    if (items.length > 0) {
      const carouselItems = items.slice(0, 5).map((v, i) => {
        const s = v.snippet;
        const st = v.statistics;
        return {
          title: `#${i + 1} ${s.title}`,
          subtitle: `${s.channelTitle} · ${this.formatCount(st.viewCount)} views`,
          image: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          action: 'yt-play',
          context: { videoId: v.id },
          tag: `#${i + 1}`
        };
      });
      ops.push({
        op: 'upsert', id: 'yt-trending-carousel', type: 'carousel', data: {
          title: 'Top Picks',
          items: carouselItems
        }
      });
    }

    // Full list as media-list
    if (items.length > 0) {
      const listItems = items.map((v, i) => {
        const s = v.snippet;
        const st = v.statistics;
        return {
          id: v.id,
          title: `#${i + 1} ${s.title}`,
          subtitle: `${s.channelTitle} · ${this.formatCount(st.viewCount)} views`,
          image: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          action: 'yt-play',
          context: { videoId: v.id }
        };
      });
      ops.push({
        op: 'upsert', id: 'yt-trending-list', type: 'media-list', data: {
          title: 'All Trending',
          items: listItems
        }
      });
    }

    return { ops };
  }

  // ─── Video Details ────────────────────────────────────

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

    const data = await this.apiGet('/videos', {
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

    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-vid-thumb', type: 'image', data: {
        title: s.title,
        src: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        caption: s.channelTitle,
        alt: s.title
      }},
      { op: 'upsert', id: 'yt-vid-stats', type: 'stats', data: {
        title: '📊 Stats',
        items: [
          { label: 'Views', value: this.formatCount(st.viewCount) },
          { label: 'Likes', value: this.formatCount(st.likeCount) },
          { label: 'Comments', value: this.formatCount(st.commentCount) }
        ]
      }},
      { op: 'upsert', id: 'yt-vid-info', type: 'kv', data: {
        title: 'Details',
        items: [
          { key: 'Channel', value: s.channelTitle },
          { key: 'Published', value: this.relativeDate(s.publishedAt) },
          { key: 'Duration', value: this.parseDuration(cd.duration) },
          { key: 'Definition', value: (cd.definition || 'sd').toUpperCase() }
        ]
      }},
      { op: 'upsert', id: 'yt-vid-tags', type: 'tags', data: {
        label: 'Tags',
        items: (s.tags || []).slice(0, 8).map(t => ({ text: t, color: ACCENT }))
      }},
      { op: 'upsert', id: 'yt-vid-desc', type: 'card', data: {
        title: 'Description',
        text: (s.description || 'No description').substring(0, 500)
      }},
      { op: 'upsert', id: 'yt-vid-actions', type: 'buttons', data: {
        buttons: [
          { label: '▶️ Play', action: 'yt-play', style: 'primary', context: { videoId } },
          { label: '📺 Channel', action: 'yt-channel', style: 'ghost', context: { channelId: s.channelId } },
          { label: '🔗 Open', action: 'yt-open', style: 'ghost', context: { videoId } }
        ]
      }},
      { op: 'upsert', id: 'yt-vid-link', type: 'link-card', data: {
        title: 'Watch on YouTube',
        description: s.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        icon: '▶️', color: ACCENT
      }}
    ];

    return { ops };
  }

  // ─── Channel Info ─────────────────────────────────────

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

    // Fetch channel info and recent uploads in parallel
    const [chData, searchData] = await Promise.all([
      this.apiGet('/channels', {
        part: 'snippet,statistics,contentDetails',
        id: channelId
      }),
      this.apiGet('/search', {
        part: 'snippet',
        channelId,
        order: 'date',
        type: 'video',
        maxResults: 5
      })
    ]);

    const ch = (chData.items || [])[0];
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
    const uploads = searchData.items || [];

    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      { op: 'upsert', id: 'yt-ch-hero', type: 'hero', data: {
        title: `📺 ${s.title}`,
        subtitle: s.customUrl || s.description.substring(0, 100) || 'YouTube Channel',
        icon: '📺'
      }},
      { op: 'upsert', id: 'yt-ch-stats', type: 'stats', data: {
        title: 'Channel Stats',
        items: [
          { label: 'Subscribers', value: st.hiddenSubscriberCount ? 'Hidden' : this.formatCount(st.subscriberCount) },
          { label: 'Videos', value: this.formatCount(st.videoCount) },
          { label: 'Views', value: this.formatCount(st.viewCount) }
        ]
      }},
      { op: 'upsert', id: 'yt-ch-desc', type: 'card', data: {
        title: 'About',
        text: (s.description || 'No description').substring(0, 500)
      }},
      { op: 'upsert', id: 'yt-ch-link', type: 'link-card', data: {
        title: 'View on YouTube',
        description: s.title,
        url: `https://www.youtube.com/channel/${channelId}`,
        icon: '📺', color: ACCENT
      }}
    ];

    // Recent uploads as media-list (single op instead of N×(image+buttons))
    if (uploads.length > 0) {
      const listItems = uploads.map(item => {
        const videoId = item.id.videoId;
        const vs = item.snippet;
        return {
          id: videoId,
          title: vs.title,
          subtitle: `${vs.channelTitle} · ${this.relativeDate(vs.publishedAt)}`,
          image: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
          action: 'yt-play',
          context: { videoId }
        };
      });
      ops.push({
        op: 'upsert', id: 'yt-ch-uploads', type: 'media-list', data: {
          title: `🎬 Recent Uploads (${uploads.length})`,
          items: listItems
        }
      });
    }

    return { ops };
  }

  // ─── Music Search ─────────────────────────────────────

  async musicSearch(context) {
    const { query } = context || {};
    if (!query) {
      return { ops: [
        { op: 'clear' },
        ...this.nav('music'),
        { op: 'upsert', id: 'ytm-search-form', type: 'form', data: {
          id: 'ytm-search-form', title: '🎵 Search Music',
          fields: [
            { name: 'query', type: 'text', label: 'Search', required: true, placeholder: 'Artist, song, album...' }
          ],
          actions: [{ label: 'Search', action: 'ytm-search', style: 'primary' }]
        }}
      ]};
    }

    const data = await this.apiGet('/search', {
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      maxResults: 8
    });

    const items = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('music'),
      { op: 'upsert', id: 'ytm-header', type: 'hero', data: {
        title: `🎵 "${query}"`, subtitle: `${items.length} music results`, icon: '🎶'
      }}
    ];

    if (items.length > 0) {
      // Single media-list op for all results
      const listItems = items.map(item => {
        const videoId = item.id.videoId;
        const s = item.snippet;
        return {
          id: videoId,
          title: s.title,
          subtitle: `🎵 ${s.channelTitle} · ${this.relativeDate(s.publishedAt)}`,
          image: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
          action: 'yt-play',
          context: { videoId }
        };
      });
      ops.push({
        op: 'upsert', id: 'ytm-results', type: 'media-list', data: {
          items: listItems
        }
      });
    } else {
      ops.push({ op: 'upsert', id: 'ytm-no-results', type: 'card', data: {
        title: 'No results', text: `No music found for "${query}". Try a different search.`
      }});
    }

    return { ops };
  }

  // ─── Music Playlists ──────────────────────────────────

  async musicPlaylists() {
    // Search for popular music playlists
    const data = await this.apiGet('/search', {
      part: 'snippet',
      q: 'top music hits 2025',
      type: 'playlist',
      maxResults: 8
    });

    const items = data.items || [];
    const ops = [
      { op: 'clear' },
      ...this.nav('playlists'),
      { op: 'upsert', id: 'ytm-pl-header', type: 'hero', data: {
        title: '🎶 Music Playlists', subtitle: 'Popular playlists', icon: '📋'
      }}
    ];

    if (items.length > 0) {
      // Single carousel op for all playlists
      const carouselItems = items.map(item => {
        const playlistId = item.id.playlistId;
        const s = item.snippet;
        const thumb = (s.thumbnails && s.thumbnails.medium) ? s.thumbnails.medium.url : null;
        return {
          title: s.title,
          subtitle: `${s.channelTitle} · Playlist`,
          image: thumb,
          action: 'yt-open-playlist',
          context: { playlistId },
          tag: '🎶'
        };
      });
      ops.push({
        op: 'upsert', id: 'ytm-pl-carousel', type: 'carousel', data: {
          title: 'Browse Playlists',
          items: carouselItems
        }
      });
    } else {
      ops.push({ op: 'upsert', id: 'ytm-pl-empty', type: 'card', data: {
        title: 'No playlists', text: 'Could not fetch playlists right now.'
      }});
    }

    return { ops };
  }

  // ─── Play (Embed) ─────────────────────────────────────

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

    // Fetch video info for the player component
    const data = await this.apiGet('/videos', {
      part: 'snippet,contentDetails',
      id: videoId
    });

    const v = (data.items || [])[0];
    const title = v ? v.snippet.title : 'YouTube Video';
    const channel = v ? v.snippet.channelTitle : '';
    const duration = v ? this.parseDuration(v.contentDetails.duration) : '';
    const thumb = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

    const ops = [
      { op: 'clear' },
      ...this.nav('search'),
      // Player component with video metadata
      { op: 'upsert', id: 'yt-player', type: 'player', data: {
        title,
        subtitle: channel + (duration ? ` · ${duration}` : ''),
        cover: thumb,
        status: 'playing',
        progress: { value: 0, max: 0, label: '' },
        controls: [
          { id: 'details', icon: 'ℹ️', action: 'yt-video', context: { videoId } },
          { id: 'play', icon: '▶️', action: 'yt-play', style: 'primary', size: 'lg', context: { videoId } },
          { id: 'channel', icon: '📺', action: 'yt-channel', context: { channelId: v ? v.snippet.channelId : '' } }
        ],
        options: [
          { icon: '🔍', action: 'yt-search' },
          { icon: '🔥', action: 'yt-trending' }
        ]
      }},
      // Link card to open on YouTube
      { op: 'upsert', id: 'yt-player-link', type: 'link-card', data: {
        title: 'Watch on YouTube',
        description: title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        icon: '▶️', color: ACCENT
      }}
    ];

    return { ops };
  }

  // ─── API Helper ───────────────────────────────────────

  apiGet(endpoint, params = {}) {
    params.key = this.apiKey;
    const qs = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${API_BASE}${endpoint}?${qs}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.error) {
              reject(new Error(`YouTube API: ${json.error.message} (${json.error.code})`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Failed to parse YouTube API response: ${e.message}`));
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ─── Formatting Helpers ───────────────────────────────

  formatCount(n) {
    if (n == null) return '—';
    const num = Number(n);
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return String(num);
  }

  parseDuration(iso) {
    if (!iso) return '—';
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return iso;
    const h = m[1] ? `${m[1]}h ` : '';
    const min = m[2] ? `${m[2]}m ` : '';
    const s = m[3] ? `${m[3]}s` : '';
    return (h + min + s).trim() || '0s';
  }

  relativeDate(isoDate) {
    if (!isoDate) return '';
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(diff / 60000);
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
