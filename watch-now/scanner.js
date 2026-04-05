// watch-now/scanner.js
// Fetches the entire Watch Later playlist via YouTube's InnerTube browse API.
//
// Architecture:
//   • NO HTML fetching.  NO ytInitialData parsing.  NO regex.
//   • First call: POST /browse with browseId:"VLWL" → first ~100 videos
//   • Continuation calls: POST /browse with continuation token → next pages
//   • Repeats until continuation is null (playlist fully loaded)
//
// Public API:
//   WatchNowScanner.scan(onProgress, onFirstBatch)
//     onProgress(pct, message)  — 0-100 progress updates
//     onFirstBatch(videos)      — called immediately after page 1 so the UI
//                                 can render the first batch without waiting
//                                 for the full playlist to load
//     Returns: Promise<{ videos: VideoRecord[] }>

window.WatchNowScanner = (() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const BROWSE_URL    = 'https://www.youtube.com/youtubei/v1/browse';
  const CLIENT_NAME   = 'WEB';
  const CLIENT_VER    = '2.20240101.00.00';
  const MAX_PAGES     = 500;   // 500 × ~100 = up to 50 000 videos
  const PAGE_DELAY_MS = 100;   // polite delay between requests (ms)

  // ─── Public entry point ────────────────────────────────────────────────────

  async function scan(onProgress, onFirstBatch) {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};

    // ── Page 1: browseId request (no HTML involved) ───────────────────────────
    progress(5, 'Connecting to YouTube Watch Later…');

    let firstData;
    try {
      firstData = await browsePost({ browseId: 'VLWL' });
    } catch (e) {
      throw new Error(
        'Could not reach YouTube. Make sure you are signed in, then try again. (' + e.message + ')'
      );
    }

    progress(12, 'Parsing playlist…');

    const { videos: firstBatch, continuation: firstToken } =
      parseFirstResponse(firstData);

    if (firstBatch.length === 0 && !firstToken) {
      throw new Error(
        'Watch Later playlist appears empty or is not accessible. ' +
        'Make sure you are signed in to YouTube.'
      );
    }

    // Stamp addedAt for first batch based on playlist position (0 = newest).
    stampAddedAt(firstBatch, 0);

    // ── Render first batch immediately ────────────────────────────────────────
    // Fire the callback with a copy so the caller can save/render right away
    // without waiting for the full pagination loop to finish.
    if (typeof onFirstBatch === 'function') {
      onFirstBatch([...firstBatch]);
    }

    progress(18, `Got ${firstBatch.length} videos — fetching remaining pages…`);

    // ── Pagination loop ───────────────────────────────────────────────────────
    const allVideos = [...firstBatch];
    const seenIds   = new Set(allVideos.map(v => v.videoId));
    let   token     = firstToken;
    let   page      = 0;

    while (token && page < MAX_PAGES) {
      page++;
      // Progress bar: grow from 18% toward 92% as pages load
      const pct = Math.min(18 + page * 7, 92);
      progress(pct, `Loading… ${allVideos.length} videos so far (page ${page})`);

      let result;
      try {
        result = await fetchContinuation(token);
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

      token = result.continuation; // null → loop exits naturally
      await sleep(PAGE_DELAY_MS);
    }

    // Re-stamp all addedAt values now that we have the final order.
    // Index 0 = most recently added to Watch Later.
    stampAddedAt(allVideos, 0);

    progress(96, `Loaded ${allVideos.length} videos — saving…`);
    console.log('[WatchLaterNow] Scan complete:', allVideos.length, 'videos total');
    return { videos: allVideos };
  }

  // ─── First response parser ──────────────────────────────────────────────────
  //
  // The browse?browseId=VLWL response wraps the playlist several layers deep:
  //
  //   data.contents
  //     .twoColumnBrowseResultsRenderer.tabs[0]
  //     .tabRenderer.content
  //     .sectionListRenderer.contents[0]
  //     .itemSectionRenderer.contents[0]
  //     .playlistVideoListRenderer
  //       .contents  ← videos + optional continuationItemRenderer
  //       .continuations  ← legacy token array (alternate path)
  //
  // We use deepFind() so nesting changes don't break us.

  function parseFirstResponse(data) {
    const plr = deepFind(data, 'playlistVideoListRenderer');
    if (!plr) {
      console.warn('[WatchLaterNow] playlistVideoListRenderer not found in browse response.');
      console.warn('[WatchLaterNow] Response keys:', Object.keys(data || {}));
      return { videos: [], continuation: null };
    }

    const { videos, continuation: tokenA } = parseItems(plr.contents || []);

    // Token can be in plr.continuations[] (legacy/alternate format)
    const tokenB = extractLegacyToken(plr.continuations);

    // Last-resort: deep search inside the playlist renderer itself
    let tokenC = null;
    if (!tokenA && !tokenB) {
      const cmd = deepFind(plr, 'continuationCommand');
      if (cmd?.token) tokenC = cmd.token;
    }

    const continuation = tokenA || tokenB || tokenC || null;

    console.log(
      '[WatchLaterNow] First page:', videos.length, 'videos |',
      'token:', continuation
        ? (tokenA ? 'Path A (continuationItemRenderer)'
          : tokenB ? 'Path B (plr.continuations[])'
          : 'Path C (deepFind)')
        : 'NONE — playlist may be fully loaded'
    );

    return { videos, continuation };
  }

  // ─── Continuation fetch ─────────────────────────────────────────────────────
  //
  // Continuation responses come in one of four shapes.  We check the most
  // specific first (Shape A) and fall back to progressively broader searches.

  async function fetchContinuation(token) {
    const data = await browsePost({ continuation: token });

    // Shape A — continuationContents.playlistVideoListContinuation
    // Most specific; commonly returned for Watch Later.
    const plc = data?.continuationContents?.playlistVideoListContinuation;
    if (plc) {
      const { videos, continuation: tokenA } = parseItems(plc.contents || []);
      const tokenB = extractLegacyToken(plc.continuations);
      return { videos, continuation: tokenA || tokenB || null };
    }

    // Shape B — onResponseReceivedActions[].appendContinuationItemsAction
    const actions = data?.onResponseReceivedActions || [];
    for (const action of actions) {
      const items =
        action?.appendContinuationItemsAction?.continuationItems ||
        action?.reloadContinuationItemsCommand?.continuationItems;
      if (items) return parseItems(items);
    }

    // Shape C — top-level continuationItems
    if (Array.isArray(data?.continuationItems)) {
      return parseItems(data.continuationItems);
    }

    // Shape D — deep search (last resort)
    const items = deepFind(data, 'continuationItems');
    if (Array.isArray(items)) return parseItems(items);

    // No items found — signals end of playlist
    return { videos: [], continuation: null };
  }

  // ─── Item parser ────────────────────────────────────────────────────────────
  //
  // Walks a raw contents[] array and extracts:
  //   • VideoRecord objects from playlistVideoRenderer entries
  //   • The next continuation token from continuationItemRenderer

  function parseItems(items) {
    const videos = [];
    let continuation = null;

    for (const item of items) {
      // ── Video ──────────────────────────────────────────────────────────────
      const v = item?.playlistVideoRenderer;
      if (v?.videoId) {
        const title = getText(v.title);
        // Skip videos with no title AND no thumbnail (private/deleted)
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

      // ── Continuation token ─────────────────────────────────────────────────
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

  // ─── Core API call ──────────────────────────────────────────────────────────
  //
  // All requests share the same context block.  Extra fields (browseId or
  // continuation) are spread in by the caller.
  //
  // credentials:'include' sends the user's YouTube session cookies so the
  // Watch Later playlist (which is private) is accessible.

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
        'Origin':                   'https://www.youtube.com',
        'Referer':                  'https://www.youtube.com/'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      throw new Error(`YouTube API returned HTTP ${resp.status}`);
    }

    return resp.json();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  // Extract a token from the legacy continuations[] array format.
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

  // Extract plain text from YouTube's various text object shapes.
  function getText(obj) {
    if (!obj)                    return '';
    if (typeof obj === 'string') return obj;
    if (obj.simpleText)          return obj.simpleText;
    if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  // Pick the thumbnail URL closest to 320px wide (mqdefault quality).
  function bestThumbnail(thumbs, videoId) {
    const fallback = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    if (!thumbs?.length) return fallback;
    const sorted = [...thumbs].sort(
      (a, b) => Math.abs((a.width || 0) - 320) - Math.abs((b.width || 0) - 320)
    );
    return sorted[0]?.url || fallback;
  }

  // Stamp addedAt timestamps by playlist position.
  // index 0 = most recently added (newest first in the default sort).
  function stampAddedAt(videos, startIndex) {
    const now = Date.now();
    videos.forEach((v, i) => {
      v.addedAt = now - (startIndex + i) * 1000;
    });
  }

  // Recursive deep object search for a key, capped at depth 50.
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
