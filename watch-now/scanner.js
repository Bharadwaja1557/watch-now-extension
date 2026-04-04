// watch-now/scanner.js
// Fetches the user's entire Watch Later playlist using YouTube's InnerTube API.
// Supports 1000+ videos via continuation token pagination.
// No category fetching — that system has been removed.

window.WatchNowScanner = (() => {
  'use strict';

  const PLAYLIST_URL  = 'https://www.youtube.com/playlist?list=WL';
  // API key is appended dynamically from the extracted config so requests are
  // authenticated correctly.  prettyPrint=false reduces response size.
  const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1/browse';
  const MAX_PAGES     = 500; // 500 pages × ~100 videos = up to 50 000 videos
  const PAGE_DELAY_MS = 80;  // polite delay between continuation requests

  // ─── Public entry point ────────────────────────────────────────────────────

  // onProgress(pct: 0-100, message: string) — called throughout the scan
  // Returns { videos: VideoRecord[] }
  async function scan(onProgress) {
    const progress = onProgress || (() => {});

    // ── Step 1: Fetch the playlist HTML page ─────────────────────────────────
    progress(5, 'Fetching Watch Later playlist…');

    const html = await safeFetch(PLAYLIST_URL);
    if (!html) {
      throw new Error(
        'Could not load Watch Later. Make sure you are signed in to YouTube and try again.'
      );
    }

    // ── Step 2: Extract InnerTube config (API key, client version) ────────────
    const config = extractInnertubeConfig(html);
    progress(10, 'Parsing first batch of videos…');

    // ── Step 3: Extract first ~100 videos from embedded ytInitialData ─────────
    const ytData = extractYtInitialData(html);
    if (!ytData) {
      throw new Error(
        'Could not parse playlist data. Visit youtube.com/playlist?list=WL in a tab and try again.'
      );
    }

    const { videos: firstBatch, continuation: firstToken } =
      extractVideosAndToken(ytData, 'initial');

    const allVideos = [...firstBatch];
    progress(15, `Got ${allVideos.length} videos — fetching remaining pages…`);

    // ── Step 4: Follow continuation tokens until all videos are loaded ────────
    let token = firstToken;
    let page  = 0;

    while (token && page < MAX_PAGES) {
      page++;
      // Progress: grow from 15% to 90% — use a per-page increment so the bar
      // advances visibly even for small playlists (avoids the old formula that
      // used MAX_PAGES=500 as denominator and barely moved for 600 videos).
      const pct = Math.min(15 + page * 8, 88);
      progress(pct, `Loading… ${allVideos.length} videos so far`);

      const result = await fetchContinuationPage(config, token);

      // ── BUG 3 FIX: break only on a hard network failure, NOT on an empty
      // video list.  A continuation page can legitimately return 0 playable
      // videos (all items were unavailable/deleted) yet still carry a token
      // pointing to the next page.  The old `result.videos.length === 0` break
      // condition caused the loop to abort after the first such page.
      // Token exhaustion (result.continuation === null) is the correct signal
      // that the playlist end has been reached — that is handled by the while
      // condition on the next iteration.
      if (!result) break; // genuine network / parse failure → stop

      allVideos.push(...result.videos);
      token = result.continuation; // null when no more pages → loop exits naturally

      await sleep(PAGE_DELAY_MS);
    }

    // ── Step 5: Stamp addedAt based on playlist position ──────────────────────
    // Index 0 = most recently added to Watch Later.
    // We derive timestamps so that sort-by-date gives correct playlist order.
    const now = Date.now();
    allVideos.forEach((video, index) => {
      video.addedAt = now - index * 1000; // 1 second apart is enough for stable sort
    });

    progress(95, `Loaded ${allVideos.length} videos — saving…`);
    return { videos: allVideos };
  }

  // ─── InnerTube config extraction ──────────────────────────────────────────

  function extractInnertubeConfig(html) {
    // Sensible defaults (may be slightly stale, YouTube accepts them)
    const cfg = {
      apiKey:        'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
      clientVersion: '2.20240101.00.00',
      visitorData:   ''
    };

    const ak = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (ak) cfg.apiKey = ak[1];

    const cv = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
    if (cv) cfg.clientVersion = cv[1];

    const vd = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
    if (vd) cfg.visitorData = vd[1];

    return cfg;
  }

  // ─── ytInitialData extraction ──────────────────────────────────────────────

  function extractYtInitialData(html) {
    // YouTube embeds the data as:  var ytInitialData = {...};
    const marker = 'var ytInitialData = ';
    const startIndex = html.indexOf(marker);
    if (startIndex === -1) return null;

    const jsonStart = startIndex + marker.length;
    const jsonStr = extractBalancedJson(html, jsonStart);
    if (!jsonStr) return null;

    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('[WatchLaterNow] ytInitialData JSON parse failed:', e);
      return null;
    }
  }

  // Extract a complete JSON object/array starting at startIndex.
  // Uses a character-level state machine — safe on minified JS.
  function extractBalancedJson(str, startIndex) {
    let depth    = 0;
    let inString = false;
    let escape   = false;

    for (let i = startIndex; i < str.length; i++) {
      const ch = str[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return str.slice(startIndex, i + 1);
      }
    }
    return null;
  }

  // ─── Extract videos from ytInitialData (first page) ───────────────────────

  function extractVideosAndToken(ytData, _source) {
    // The playlist renderer can be nested at varying depths — use a deep search.
    const plRenderer = deepFind(ytData, 'playlistVideoListRenderer');
    if (!plRenderer) {
      console.warn('[WatchLaterNow] playlistVideoListRenderer not found in ytInitialData');
      return { videos: [], continuation: null };
    }
    return parseItems(plRenderer.contents || []);
  }

  // ─── Continuation page fetch ───────────────────────────────────────────────

  async function fetchContinuationPage(config, token) {
    // Include the API key in the URL — required in some regions / YouTube
    // account states.  Without it the endpoint can return 401/403.
    const url = `${INNERTUBE_BASE}?key=${config.apiKey}&prettyPrint=false`;

    const body = {
      context: {
        client: {
          clientName:    'WEB',
          clientVersion: config.clientVersion,
          hl:            'en',
          gl:            'US',
          ...(config.visitorData ? { visitorData: config.visitorData } : {})
        }
      },
      continuation: token
    };

    try {
      const resp = await fetch(url, {
        method:      'POST',
        credentials: 'include',
        headers: {
          'Content-Type':             'application/json',
          'X-YouTube-Client-Name':    '1',
          'X-YouTube-Client-Version': config.clientVersion,
          'X-Goog-Api-Key':           config.apiKey,
          'Origin':                   'https://www.youtube.com',
          'Referer':                  PLAYLIST_URL
        },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        console.warn('[WatchLaterNow] continuation request failed:', resp.status);
        return null;
      }

      const data = await resp.json();

      // ── Path 1: onResponseReceivedActions (standard continuation response) ─
      let items = null;
      const actions = data?.onResponseReceivedActions || [];
      for (const action of actions) {
        const ci =
          action?.appendContinuationItemsAction?.continuationItems ||
          action?.reloadContinuationItemsCommand?.continuationItems;
        if (ci) { items = ci; break; }
      }

      // ── Path 2: direct continuationItems at top level ─────────────────────
      if (!items && Array.isArray(data?.continuationItems)) {
        items = data.continuationItems;
      }

      // ── Path 3: deep search fallback ──────────────────────────────────────
      if (!items) items = deepFind(data, 'continuationItems');

      if (!items || !Array.isArray(items)) {
        // No items found — treat as end of playlist (return empty, no token)
        return { videos: [], continuation: null };
      }

      return parseItems(items);
    } catch (e) {
      console.error('[WatchLaterNow] continuation fetch error:', e);
      return null;
    }
  }

  // ─── Parse a list of playlist items into videos + next continuation token ──

  function parseItems(items) {
    const videos = [];
    let continuation = null;

    for (const item of items) {
      // ── Video entry ──────────────────────────────────────────────────────
      const v = item?.playlistVideoRenderer;
      if (v?.videoId) {
        const videoId = v.videoId;
        videos.push({
          videoId,
          title:     getText(v.title)    || 'Untitled',
          channel:   getText(v.shortBylineText) || getText(v.longBylineText) || '',
          duration:  v.lengthText?.simpleText || v.lengthText?.runs?.[0]?.text || '',
          thumbnail: bestThumbnail(v.thumbnail?.thumbnails, videoId),
          videoUrl:  `https://www.youtube.com/watch?v=${videoId}`
        });
      }

      // ── Continuation token ────────────────────────────────────────────────
      const cont = item?.continuationItemRenderer;
      if (cont) {
        const tok =
          cont?.continuationEndpoint?.continuationCommand?.token ||
          cont?.button?.buttonRenderer?.command?.continuationCommand?.token;
        if (tok) continuation = tok;
      }
    }

    return { videos, continuation };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // Extracts plain text from YouTube's text objects (runs or simpleText).
  function getText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (obj.simpleText) return obj.simpleText;
    if (obj.runs) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  // Pick the thumbnail closest to 320px wide (mqdefault quality).
  function bestThumbnail(thumbs, videoId) {
    const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    if (!thumbs || thumbs.length === 0) return fallback;
    const sorted = [...thumbs].sort(
      (a, b) => Math.abs((a.width || 0) - 320) - Math.abs((b.width || 0) - 320)
    );
    return sorted[0]?.url || fallback;
  }

  // Deep-search an object for a key, stopping at depth 30.
  function deepFind(obj, key, depth = 0) {
    if (depth > 30 || obj === null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k of Object.keys(obj)) {
      const r = deepFind(obj[k], key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  // Fetch with user credentials and language header; returns text or null on error.
  async function safeFetch(url) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept-Language': 'en-US,en;q=0.9' }
      });
      if (!resp.ok) return null;
      return await resp.text();
    } catch (e) {
      console.error('[WatchLaterNow] safeFetch failed:', url, e);
      return null;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return { scan };
})();
