// watch-now/scanner.js
// Fetches the entire Watch Later playlist.
//
// Architecture (hybrid):
//   Page 1  — extracted from ytInitialData, which YouTube embeds in the HTML
//             of the authenticated /playlist?list=WL page.  This sidesteps
//             the InnerTube browseId authentication problem entirely: the page
//             fetch carries the user's cookies, so the response is always the
//             full authenticated playlist page.
//   Pages 2+ — InnerTube /browse continuation API, same as before.
//
// Public API:
//   WatchNowScanner.scan(onProgress, onFirstBatch)
//     onProgress(pct, message)  — 0-100 progress updates
//     onFirstBatch(videos)      — fired after page 1 so the UI can render
//                                 immediately without waiting for full load
//     Returns: Promise<{ videos: VideoRecord[] }>

window.WatchNowScanner = (() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const BROWSE_URL     = 'https://www.youtube.com/youtubei/v1/browse';
  const PLAYLIST_URL   = 'https://www.youtube.com/playlist?list=WL';
  const CLIENT_NAME    = 'WEB';
  const CLIENT_VER     = '2.20240101.00.00';
  const MAX_PAGES      = 500;   // 500 × ~100 = up to 50 000 videos
  const PAGE_DELAY_MS  = 100;   // polite delay between requests (ms)

  // Visitor-id improves continuation-request reliability.
  // Sending null/undefined would be rejected, so we only include it when set.
  const VISITOR_DATA =
    window.ytcfg?.get?.('VISITOR_DATA') ||
    window.yt?.config_?.VISITOR_DATA    ||
    null;

  // ─── Public entry point ────────────────────────────────────────────────────

  async function scan(onProgress, onFirstBatch) {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};

    // ── Page 1: read ytInitialData ─────────────────────────────────────────────
    // We do NOT call browsePost({ browseId:'VLWL' }) for the first page.
    // That endpoint returns a restricted response (only alerts/topbar/microformat)
    // when the request lacks the session binding that a real browser page load
    // carries.  Instead we fetch the actual playlist page; because the fetch uses
    // credentials:'include' the user's cookies travel with it, and YouTube returns
    // the full authenticated playlist HTML which embeds ytInitialData with the
    // first ~100 videos already inside it.

    progress(5, 'Reading Watch Later playlist…');

    const firstData = await getInitialData();

    if (!firstData) {
      throw new Error(
        'Could not read Watch Later playlist. ' +
        'Make sure you are signed in to YouTube and try again.'
      );
    }

    progress(12, 'Parsing playlist…');

    console.log('[WatchLaterNow] First data (ytInitialData):', firstData);

    const firstBatch = extractVideos(firstData);
    const firstToken = extractContinuation(firstData);

    if (firstBatch.length === 0 && !firstToken) {
      throw new Error(
        'Watch Later playlist appears empty or is not accessible. ' +
        'Make sure you are signed in to YouTube.'
      );
    }

    console.log(
      '[WatchLaterNow] First page:', firstBatch.length, 'videos |',
      'continuation token:', firstToken ? 'found ✓' : 'none (playlist fits on one page)'
    );

    // Stamp addedAt for first batch (index 0 = most recently added).
    stampAddedAt(firstBatch, 0);

    // ── Render first batch immediately ────────────────────────────────────────
    if (typeof onFirstBatch === 'function') {
      onFirstBatch([...firstBatch]);
    }

    progress(18, `Got ${firstBatch.length} videos — fetching remaining pages…`);

    // ── Pagination loop (InnerTube continuation) ──────────────────────────────
    const allVideos = [...firstBatch];
    const seenIds   = new Set(allVideos.map(v => v.videoId));
    let   token     = firstToken;
    let   page      = 0;

    while (token && page < MAX_PAGES) {
      page++;
      const pct = Math.min(18 + page * 7, 92);
      progress(pct, `Loading… ${allVideos.length} videos so far (page ${page})`);

      let result;
      try {
        const data = await browsePost({ continuation: token });
        result = {
          videos:       extractVideos(data),
          continuation: extractContinuation(data)
        };
      } catch (e) {
        console.warn('[WatchLaterNow] Page', page, 'failed —', e.message, '— stopping');
        break;
      }

      if (!result) break;

      let added = 0;
      for (const video of result.videos) {
        if (!seenIds.has(video.videoId)) {
          allVideos.push(video);
          seenIds.add(video.videoId);
          added++;
        }
      }

      console.log(
        '[WatchLaterNow] Page', page, '—',
        result.videos.length, 'videos (' + added + ' new),',
        'next token:', result.continuation ? '✓' : 'none (end of playlist)'
      );

      token = result.continuation;
      await sleep(PAGE_DELAY_MS);
    }

    // Re-stamp with final order so sort-by-date is correct.
    stampAddedAt(allVideos, 0);

    progress(96, `Loaded ${allVideos.length} videos — saving…`);
    console.log('[WatchLaterNow] Scan complete:', allVideos.length, 'videos total');
    return { videos: allVideos };
  }

  // ─── Initial data extraction ────────────────────────────────────────────────
  //
  // Retrieves the ytInitialData object that YouTube embeds in the playlist page.
  // Two strategies, tried in order:
  //
  //   1. window.ytInitialData — already a parsed JS object; only valid if the
  //      user is currently browsing /playlist?list=WL (unlikely during normal
  //      Watch Now usage, but costs nothing to check first).
  //
  //   2. Fetch /playlist?list=WL with credentials:'include' and extract
  //      ytInitialData from the HTML.  The cookie-authenticated fetch returns
  //      the full playlist page, which embeds the first ~100 videos as JSON.
  //
  // Note on the spec's regex approach:
  //   /ytInitialData\s*=\s*(\{.*?\});/s  uses non-greedy .*? which stops at
  //   the very first "};" inside the JSON, producing invalid truncated JSON.
  //   We use extractBalancedJson() (character-level brace counter) instead,
  //   which reliably handles any size of embedded JSON object.

  async function getInitialData() {
    // Strategy 1 — current page already has Watch Later data
    if (window.ytInitialData && typeof window.ytInitialData === 'object') {
      const sample = findObjectsByKey(window.ytInitialData, 'playlistVideoRenderer');
      if (sample.length > 0) {
        console.log('[WatchLaterNow] getInitialData: using window.ytInitialData');
        return window.ytInitialData;
      }
    }

    // Strategy 2 — fetch the Watch Later playlist page
    console.log('[WatchLaterNow] getInitialData: fetching', PLAYLIST_URL);
    const html = await fetchHtml(PLAYLIST_URL);
    if (!html) {
      console.warn('[WatchLaterNow] getInitialData: page fetch returned null');
      return null;
    }

    // Locate the ytInitialData assignment in the page HTML
    const marker   = 'ytInitialData';
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
      console.warn('[WatchLaterNow] getInitialData: marker not found in HTML');
      return null;
    }

    const braceIdx = html.indexOf('{', markerIdx);
    if (braceIdx === -1) return null;

    const jsonStr = extractBalancedJson(html, braceIdx);
    if (!jsonStr) {
      console.warn('[WatchLaterNow] getInitialData: balanced-JSON extraction failed');
      return null;
    }

    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('[WatchLaterNow] getInitialData: JSON.parse failed —', e.message);
      return null;
    }
  }

  // ─── Recursive tree search ──────────────────────────────────────────────────
  //
  // Collects every value stored under `key` anywhere in the object tree.
  // Nesting-agnostic: YouTube can restructure response wrapper layers without
  // breaking extraction.

  function findObjectsByKey(obj, key, results = []) {
    if (!obj || typeof obj !== 'object') return results;

    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      results.push(obj[key]);
    }

    for (const k of Object.keys(obj)) {
      findObjectsByKey(obj[k], key, results);
    }

    return results;
  }

  // ─── Video extractor ────────────────────────────────────────────────────────

  function extractVideos(data) {
    const renderers = findObjectsByKey(data, 'playlistVideoRenderer');

    const videos = [];
    for (const v of renderers) {
      if (!v?.videoId) continue;

      const title = getText(v.title);
      // Skip genuinely unavailable videos (no title, no thumbnail)
      if (!title && !v.thumbnail?.thumbnails?.length) continue;

      videos.push({
        videoId:   v.videoId,
        title:     title || 'Untitled',
        channel:   getText(v.shortBylineText) || getText(v.longBylineText) || '',
        duration:  v.lengthText?.simpleText   || getText(v.lengthText)     || '',
        thumbnail: bestThumbnail(v.thumbnail?.thumbnails, v.videoId),
        videoUrl:  `https://www.youtube.com/watch?v=${v.videoId}`
      });
    }

    return videos;
  }

  // ─── Continuation token extractor ───────────────────────────────────────────

  function extractContinuation(data) {
    // Primary: continuationItemRenderer (modern format)
    const items = findObjectsByKey(data, 'continuationItemRenderer');
    for (const cont of items) {
      const tok =
        cont?.continuationEndpoint?.continuationCommand?.token ||
        cont?.button?.buttonRenderer?.command?.continuationCommand?.token;
      if (tok) return tok;
    }

    // Legacy fallback: plr.continuations[].nextContinuationData.continuation
    const legacyArrays = findObjectsByKey(data, 'continuations');
    for (const arr of legacyArrays) {
      const tok = extractLegacyToken(arr);
      if (tok) return tok;
    }

    return null;
  }

  // ─── Core API call (continuation pages only) ────────────────────────────────

  async function browsePost(bodyExtra) {
    const body = {
      context: {
        client: {
          clientName:    CLIENT_NAME,
          clientVersion: CLIENT_VER,
          hl:            'en',
          gl:            'US'
        }
      },
      ...bodyExtra
    };

    const resp = await fetch(BROWSE_URL, {
      method:      'POST',
      credentials: 'include',
      headers: {
        'Content-Type':             'application/json',
        'X-YouTube-Client-Name':    '1',
        'X-YouTube-Client-Version': CLIENT_VER,
        ...(VISITOR_DATA ? { 'X-Goog-Visitor-Id': VISITOR_DATA } : {}),
        'Origin':                   'https://www.youtube.com',
        'Referer':                  PLAYLIST_URL
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      throw new Error(`YouTube API returned HTTP ${resp.status}`);
    }

    return resp.json();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  // Fetch a URL as text with the user's cookies.
  async function fetchHtml(url) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept-Language': 'en-US,en;q=0.9' }
      });
      if (!resp.ok) {
        console.warn('[WatchLaterNow] fetchHtml: HTTP', resp.status, 'for', url);
        return null;
      }
      return resp.text();
    } catch (e) {
      console.error('[WatchLaterNow] fetchHtml failed:', e.message);
      return null;
    }
  }

  // Character-level brace/bracket counter that reliably extracts a complete
  // JSON object or array from a larger string, regardless of its size.
  // Much more reliable than regex for deeply nested JSON (like ytInitialData).
  function extractBalancedJson(str, startIndex) {
    let depth    = 0;
    let inString = false;
    let escape   = false;

    for (let i = startIndex; i < str.length; i++) {
      const ch = str[i];

      if (escape)                   { escape = false; continue; }
      if (ch === '\\' && inString)  { escape = true;  continue; }
      if (ch === '"')               { inString = !inString; continue; }
      if (inString)                 continue;

      if (ch === '{' || ch === '[') { depth++; }
      else if (ch === '}' || ch === ']') {
        if (--depth === 0) return str.slice(startIndex, i + 1);
      }
    }
    return null;
  }

  // Legacy continuations[] token format.
  function extractLegacyToken(continuations) {
    if (!Array.isArray(continuations)) return null;
    for (const c of continuations) {
      const tok =
        c?.nextContinuationData?.continuation ||
        c?.nextRadioContinuationData?.continuation;
      if (tok) return tok;
    }
    return null;
  }

  // Plain text from YouTube's text object shapes.
  function getText(obj) {
    if (!obj)                    return '';
    if (typeof obj === 'string') return obj;
    if (obj.simpleText)          return obj.simpleText;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  // Thumbnail URL closest to 320px wide (mqdefault quality).
  function bestThumbnail(thumbs, videoId) {
    const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    if (!thumbs?.length) return fallback;
    const sorted = [...thumbs].sort(
      (a, b) => Math.abs((a.width || 0) - 320) - Math.abs((b.width || 0) - 320)
    );
    return sorted[0]?.url || fallback;
  }

  // Stamp addedAt by playlist position (index 0 = most recently added).
  function stampAddedAt(videos, startIndex) {
    const now = Date.now();
    videos.forEach((v, i) => {
      v.addedAt = now - (startIndex + i) * 1000;
    });
  }

  // Recursive deep object search — returns first match only.
  function deepFind(obj, key, depth = 0) {
    if (depth > 50 || obj === null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k of Object.keys(obj)) {
      const r = deepFind(obj[k], key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  return { scan };
})();
