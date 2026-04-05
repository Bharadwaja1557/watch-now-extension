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

    const firstBatch = extractVideos(firstData);
    const firstToken = extractContinuation(firstData);

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

  // ─── Recursive tree search ──────────────────────────────────────────────────
  //
  // Collects every value stored under `key` anywhere in the object tree,
  // no matter how deeply nested.  This makes all parsing nesting-agnostic:
  // YouTube can restructure its response wrapper layers without breaking us.
  //
  // Uses Object.keys() (own enumerable only) rather than for…in to avoid
  // iterating inherited prototype properties.

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
  //
  // Finds every `playlistVideoRenderer` in the response tree and maps each
  // to a VideoRecord.  Skips entries that have neither a title nor a thumbnail
  // (private / deleted videos that YouTube still lists as placeholders).

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
  //
  // Finds every `continuationItemRenderer` in the response tree.
  // There is normally exactly one per response; we take the first.
  //
  // Two token paths exist inside continuationItemRenderer:
  //   Primary:   continuationEndpoint.continuationCommand.token
  //   Secondary: button.buttonRenderer.command.continuationCommand.token
  //
  // Additionally, some Watch Later responses store the token in a legacy
  // `continuations[]` array at the playlistVideoListRenderer level.
  // We check that as a final fallback.

  function extractContinuation(data) {
    // Primary path via continuationItemRenderer (all modern responses)
    const items = findObjectsByKey(data, 'continuationItemRenderer');
    for (const cont of items) {
      const tok =
        cont?.continuationEndpoint?.continuationCommand?.token ||
        cont?.button?.buttonRenderer?.command?.continuationCommand?.token;
      if (tok) return tok;
    }

    // Legacy fallback: plr.continuations[].nextContinuationData.continuation
    // Still returned by some Watch Later configurations.
    const legacyArrays = findObjectsByKey(data, 'continuations');
    for (const arr of legacyArrays) {
      const tok = extractLegacyToken(arr);
      if (tok) return tok;
    }

    return null;
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
