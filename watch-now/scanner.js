// watch-now/scanner.js
// Fetches the user's entire Watch Later playlist using YouTube's InnerTube API.
// Supports 1000+ videos via continuation token pagination.

window.WatchNowScanner = (() => {
  'use strict';

  const PLAYLIST_URL   = 'https://www.youtube.com/playlist?list=WL';
  const INNERTUBE_URL  = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
  const MAX_PAGES      = 500;  // 500 pages × ~100 videos = up to 50 000 videos
  const PAGE_DELAY_MS  = 80;   // polite delay between continuation requests

  // ─── Public entry point ────────────────────────────────────────────────────

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

    // ── Step 2: Extract InnerTube config ──────────────────────────────────────
    const config = extractInnertubeConfig(html);
    progress(10, 'Parsing first batch of videos…');

    // ── Step 3: Extract first ~100 videos from ytInitialData ─────────────────
    const ytData = extractYtInitialData(html);
    if (!ytData) {
      throw new Error(
        'Could not parse playlist data. Visit youtube.com/playlist?list=WL in a tab and try again.'
      );
    }

    const { videos: firstBatch, continuation: firstToken } = extractVideosAndToken(ytData);

    const allVideos = [...firstBatch];
    const seenIds   = new Set(allVideos.map(v => v.videoId));

    progress(15, `Got ${allVideos.length} videos — fetching remaining pages…`);
    console.log(
      '[WatchLaterNow] Initial page:', allVideos.length, 'videos,',
      'token:', firstToken ? 'found ✓' : 'NONE — playlist may be fully loaded or token missing'
    );

    // ── Step 4: Follow continuation tokens until all videos are loaded ────────
    let token = firstToken;
    let page  = 0;

    while (token && page < MAX_PAGES) {
      page++;
      const pct = Math.min(15 + page * 8, 88);
      progress(pct, `Loading… ${allVideos.length} videos so far (page ${page})`);

      const result = await fetchContinuationPage(config, token);

      if (!result) {
        console.warn('[WatchLaterNow] Continuation page', page, 'failed — stopping');
        break;
      }

      // Deduplicate: skip videos already seen (prevents doubles on retry)
      let added = 0;
      for (const video of result.videos) {
        if (!seenIds.has(video.videoId)) {
          allVideos.push(video);
          seenIds.add(video.videoId);
          added++;
        }
      }

      console.log(
        '[WatchLaterNow] Page', page, ':', result.videos.length,
        'videos (' + added + ' new), next token:', result.continuation ? 'found ✓' : 'none (end)'
      );

      token = result.continuation; // null → loop exits
      await sleep(PAGE_DELAY_MS);
    }

    // ── Step 5: Stamp addedAt from playlist position ──────────────────────────
    // Index 0 = most recently added to Watch Later.
    const now = Date.now();
    allVideos.forEach((video, index) => {
      video.addedAt = now - index * 1000;
    });

    progress(95, `Loaded ${allVideos.length} videos — saving…`);
    return { videos: allVideos };
  }

  // ─── InnerTube config extraction ──────────────────────────────────────────

  function extractInnertubeConfig(html) {
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
    const marker    = 'var ytInitialData = ';
    const startIdx  = html.indexOf(marker);
    if (startIdx === -1) return null;

    const jsonStr = extractBalancedJson(html, startIdx + marker.length);
    if (!jsonStr) return null;

    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('[WatchLaterNow] ytInitialData JSON parse failed:', e);
      return null;
    }
  }

  function extractBalancedJson(str, startIndex) {
    let depth    = 0;
    let inString = false;
    let escape   = false;

    for (let i = startIndex; i < str.length; i++) {
      const ch = str[i];
      if (escape)                       { escape = false; continue; }
      if (ch === '\\' && inString)      { escape = true;  continue; }
      if (ch === '"')                   { inString = !inString; continue; }
      if (inString)                     continue;
      if (ch === '{' || ch === '[')     depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return str.slice(startIndex, i + 1);
      }
    }
    return null;
  }

  // ─── Extract videos from ytInitialData (first page) ───────────────────────
  //
  // BUG 3 FIX — three-path token search:
  //
  // YouTube stores the continuation token in one of three locations depending
  // on client version and playlist type:
  //
  //   Path A: continuationItemRenderer embedded as the last element of
  //     plRenderer.contents[].  Handled by parseItems().
  //
  //   Path B: plRenderer.continuations[].nextContinuationData.continuation
  //     A separate array next to contents[].  This is the legacy format still
  //     used for Watch Later on many YouTube configurations.
  //
  //   Path C: deepFind(plRenderer, 'continuationCommand').token
  //     Fallback deep-search scoped to the playlist renderer.  Catches any
  //     variant not covered by A or B (e.g. wrapped in extra renderer layers).
  //
  // Without B + C, the while-loop in scan() never executes for playlists whose
  // initial page only has a Path B or C token — loading just the first ~100.

  function extractVideosAndToken(ytData) {
    const plRenderer = deepFind(ytData, 'playlistVideoListRenderer');
    if (!plRenderer) {
      console.warn('[WatchLaterNow] playlistVideoListRenderer not found in ytInitialData');
      return { videos: [], continuation: null };
    }

    const { videos, continuation: pathA } = parseItems(plRenderer.contents || []);

    // Path B
    const pathB = extractContinuationFromLegacyArray(plRenderer.continuations);

    // Path C — deepFind scoped to plRenderer (avoids picking up unrelated tokens)
    let pathC = null;
    if (!pathA && !pathB) {
      const cmd = deepFind(plRenderer, 'continuationCommand');
      if (cmd?.token) pathC = cmd.token;
    }

    const continuation = pathA || pathB || pathC || null;

    console.log(
      '[WatchLaterNow] Token source:',
      pathA ? 'Path A (continuationItemRenderer)' :
      pathB ? 'Path B (plRenderer.continuations[])' :
      pathC ? 'Path C (deepFind)' : 'none found'
    );

    return { videos, continuation };
  }

  function extractContinuationFromLegacyArray(continuations) {
    if (!Array.isArray(continuations) || continuations.length === 0) return null;
    for (const c of continuations) {
      const token =
        c?.nextContinuationData?.continuation        ||
        c?.nextRadioContinuationData?.continuation   ||
        c?.liveChatReplayContinuationData?.continuation;
      if (token) return token;
    }
    return null;
  }

  // ─── Continuation page fetch ───────────────────────────────────────────────
  //
  // BUG 3 FIX — fourth response shape:
  //
  // YouTube's browse endpoint returns one of four shapes:
  //
  //   Shape 1 (standard): onResponseReceivedActions[].appendContinuationItemsAction
  //     .continuationItems  — handled by existing Path 1 code.
  //
  //   Shape 2: top-level continuationItems array — handled by Path 2.
  //
  //   Shape 3: deep-search fallback — handled by Path 3.
  //
  //   Shape 4 (Watch Later on many YouTube configs): response.continuationContents
  //     .playlistVideoListContinuation.{contents, continuations}
  //     This was MISSING and caused early termination for 608-video playlists.
  //
  // Also: removed `?key=...` from the URL.  Newer YouTube versions return HTTP
  // 400 when an API key is present in the URL query string.  The key is still
  // sent via the X-Goog-Api-Key header (which YouTube does accept).

  async function fetchContinuationPage(config, token) {
    // API key must be in the URL query string.  YouTube returns HTTP 400 when
    // the key is absent, even if it is also present in the X-Goog-Api-Key
    // header.  Without a 200 response the loop breaks after page 1 (~100 videos).
    const url = `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;

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
      const resp = await fetch(INNERTUBE_URL, {
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
        console.warn('[WatchLaterNow] Continuation request failed HTTP', resp.status);
        return null;
      }

      const data = await resp.json();

      // ── Shape 4 (BUG 3 FIX) ───────────────────────────────────────────────
      // Check this FIRST because it's the most specific shape — if it matches
      // we know exactly what to do without any ambiguity.
      const plCont = data?.continuationContents?.playlistVideoListContinuation;
      if (plCont) {
        const { videos, continuation: pathA } = parseItems(plCont.contents || []);
        const pathB = extractContinuationFromLegacyArray(plCont.continuations);
        return { videos, continuation: pathA || pathB || null };
      }

      // ── Shape 1: onResponseReceivedActions ────────────────────────────────
      let items = null;
      const actions = data?.onResponseReceivedActions || [];
      for (const action of actions) {
        const ci =
          action?.appendContinuationItemsAction?.continuationItems ||
          action?.reloadContinuationItemsCommand?.continuationItems;
        if (ci) { items = ci; break; }
      }

      // ── Shape 2: top-level continuationItems ─────────────────────────────
      if (!items && Array.isArray(data?.continuationItems)) {
        items = data.continuationItems;
      }

      // ── Shape 3: deep-search fallback ─────────────────────────────────────
      if (!items) items = deepFind(data, 'continuationItems');

      if (!items || !Array.isArray(items)) {
        return { videos: [], continuation: null };
      }

      return parseItems(items);

    } catch (e) {
      console.error('[WatchLaterNow] Continuation fetch error:', e);
      return null;
    }
  }

  // ─── Parse a list of playlist items ───────────────────────────────────────

  function parseItems(items) {
    const videos = [];
    let continuation = null;

    for (const item of items) {
      // Video entry
      const v = item?.playlistVideoRenderer;
      if (v?.videoId) {
        // Skip unavailable videos (no title / marked as private/deleted)
        const title = getText(v.title) || '';
        if (!title && !v.thumbnail?.thumbnails?.length) continue; // truly unavailable

        videos.push({
          videoId:  v.videoId,
          title:    title || 'Untitled',
          channel:  getText(v.shortBylineText) || getText(v.longBylineText) || '',
          duration: v.lengthText?.simpleText || v.lengthText?.runs?.[0]?.text || '',
          thumbnail: bestThumbnail(v.thumbnail?.thumbnails, v.videoId),
          videoUrl:  `https://www.youtube.com/watch?v=${v.videoId}`
        });
      }

      // Continuation token
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

  function getText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (obj.simpleText) return obj.simpleText;
    if (obj.runs) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  function bestThumbnail(thumbs, videoId) {
    const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    if (!thumbs || thumbs.length === 0) return fallback;
    const sorted = [...thumbs].sort(
      (a, b) => Math.abs((a.width || 0) - 320) - Math.abs((b.width || 0) - 320)
    );
    return sorted[0]?.url || fallback;
  }

  function deepFind(obj, key, depth = 0) {
    if (depth > 50 || obj === null || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const k of Object.keys(obj)) {
      const r = deepFind(obj[k], key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

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

  return { scan };
})();
