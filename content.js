/**
 * content.js
 * Runs on all YouTube pages (injected by manifest / background.js).
 *
 * When on the Watch Later playlist it scrapes every video by scrolling the
 * WINDOW (not the inner container) — that is what triggers YouTube's lazy
 * loader to fetch the next batch of video nodes.
 *
 * Strategy
 * ─────────
 * 1. Scroll window to the very bottom (instant — no smooth animation lag).
 * 2. Wait for YouTube to load + render the next batch (1 200 ms).
 * 3. Sweep all currently-visible ytd-playlist-video-renderer nodes into a
 *    Map<videoId, videoData> (deduplicates automatically).
 * 4. If the map grew → reset idle counter, continue.
 *    If the map did NOT grow → increment idle counter.
 *    If idle counter reaches STABLE_THRESHOLD → playlist is fully loaded, stop.
 * 5. Hard cap of MAX_SCROLL_ATTEMPTS prevents any infinite loop.
 *
 * Storage keys (must stay in sync with popup.js)
 * ───────────────────────────────────────────────
 *   watchNow_status       'idle' | 'scraping' | 'done' | 'error'
 *   watchNow_scrapingCount  number  (live progress for popup)
 *   watchNow_videos         VideoObject[]  (written once, on completion)
 */

(() => {
  "use strict";

  // ─── Storage keys ──────────────────────────────────────────────────────────

  const KEY_VIDEOS = "watchNow_videos";
  const KEY_STATUS = "watchNow_status";
  const KEY_COUNT  = "watchNow_scrapingCount";

  // ─── Tuning constants ───────────────────────────────────────────────────────

  /**
   * How long to wait after each scroll before reading the DOM.
   * YouTube fires a network request, receives JSON, and hydrates nodes.
   * 1 200 ms is safe for most connections; increase if on a slow link.
   */
  const SCROLL_WAIT_MS = 1200;

  /**
   * How many consecutive scrolls must produce zero new videos before we
   * conclude the playlist is fully loaded.
   * 5 is conservative — 3 would work for most playlists.
   */
  const STABLE_THRESHOLD = 5;

  /**
   * Absolute maximum number of scroll attempts.
   * At 1 200 ms/scroll this caps the scrape at ~4 minutes for 200 attempts.
   * A 2 000-video playlist needs ~40 scrolls; 200 is a generous safety net.
   */
  const MAX_SCROLL_ATTEMPTS = 200;

  // ─── Selectors ──────────────────────────────────────────────────────────────

  const VIDEO_NODE_SELECTOR = "ytd-playlist-video-renderer";

  /**
   * Optional: YouTube renders the total playlist count in this element.
   * We read it as a cross-check to know when we have everything.
   * Example text: "174 videos" or "1,024 videos"
   */
  const PLAYLIST_COUNT_SELECTOR =
    "yt-formatted-string.ytd-playlist-sidebar-primary-info-renderer, " +
    ".metadata-stats yt-formatted-string, " +
    "ytd-playlist-sidebar-renderer #stats yt-formatted-string";

  // ─── Module state ───────────────────────────────────────────────────────────

  let scraping = false;
  let videoMap = new Map(); // videoId → VideoObject

  // ─── Guard: is this the Watch Later playlist? ───────────────────────────────

  function isWatchLaterPage() {
    return location.href.includes("youtube.com/playlist?list=WL");
  }

  // ─── Async sleep ────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Read the declared playlist total from the sidebar (optional) ───────────

  function readDeclaredTotal() {
    const els = document.querySelectorAll(PLAYLIST_COUNT_SELECTOR);
    for (const el of els) {
      const text = el.textContent || "";
      // Match "174 videos", "1,024 videos", "videos: 56" etc.
      const match = text.match(/([\d,]+)\s*video/i);
      if (match) {
        const n = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return null; // not found — rely on stable-count alone
  }

  // ─── Extract data from a single ytd-playlist-video-renderer node ────────────

  function extractVideo(node) {
    try {
      // ── Video ID + URL ──
      const linkEl = node.querySelector("a#video-title");
      if (!linkEl) return null;

      const href      = linkEl.href || "";
      const qIndex    = href.indexOf("?");
      const params    = new URLSearchParams(qIndex !== -1 ? href.slice(qIndex + 1) : "");
      const videoId   = params.get("v");
      if (!videoId) return null;

      // ── Title ──
      const title = (linkEl.title || linkEl.textContent || "").trim();

      // ── Channel ──
      // Try several selector patterns YouTube has used across versions.
      const channelEl = node.querySelector(
        "ytd-channel-name yt-formatted-string, " +
        "#channel-name yt-formatted-string,     " +
        "#byline-container #text,               " +
        "#channel-name a"
      );
      const channel = channelEl ? channelEl.textContent.trim() : "Unknown";

      // ── Duration ──
      // The time badge sits inside ytd-thumbnail-overlay-time-status-renderer.
      const durationEl = node.querySelector(
        "ytd-thumbnail-overlay-time-status-renderer span[aria-label], " +
        "ytd-thumbnail-overlay-time-status-renderer span,             " +
        "span.ytd-thumbnail-overlay-time-status-renderer"
      );
      const duration = durationEl ? durationEl.textContent.trim() : "";

      // ── Thumbnail ──
      // Build from videoId — always available even while the img is lazy-loading.
      const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

      // ── Final URL ──
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      return { videoId, title, channel, duration, thumbnail, videoUrl };
    } catch (err) {
      console.warn("[Watch Now] extractVideo error:", err);
      return null;
    }
  }

  // ─── Sweep all currently-rendered nodes into videoMap ──────────────────────

  function collectVisibleNodes() {
    const nodes = document.querySelectorAll(VIDEO_NODE_SELECTOR);
    let added = 0;
    nodes.forEach((node) => {
      const video = extractVideo(node);
      if (video && !videoMap.has(video.videoId)) {
        videoMap.set(video.videoId, video);
        added++;
      }
    });
    return added;
  }

  // ─── Scroll window to the very bottom ──────────────────────────────────────

  function scrollToBottom() {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "instant", // avoid animation delay eating into our wait budget
    });
  }

  // ─── Reset state fully ──────────────────────────────────────────────────────

  async function resetState() {
    scraping = false;
    videoMap = new Map();
    await chrome.storage.local.set({
      [KEY_STATUS]: "idle",
      [KEY_COUNT]:  0,
      [KEY_VIDEOS]: [],
    });
  }

  // ─── Main scraping coroutine ────────────────────────────────────────────────

  async function startScraping() {
    if (scraping) {
      console.log("[Watch Now] Already scraping — ignoring duplicate START_SCRAPE.");
      return { ok: true, already: true };
    }
    if (!isWatchLaterPage()) {
      return { ok: false, error: "Not on Watch Later page" };
    }

    scraping = true;
    videoMap = new Map();

    // Signal to popup that we have started
    await chrome.storage.local.set({
      [KEY_STATUS]: "scraping",
      [KEY_COUNT]:  0,
      [KEY_VIDEOS]: [],
    });

    console.log("[Watch Now] Scraping started.");

    // ── Optional: read the declared total so we can stop early ──
    const declaredTotal = readDeclaredTotal();
    if (declaredTotal) {
      console.log(`[Watch Now] Playlist declares ${declaredTotal} videos.`);
    }

    // ── Collect whatever is already visible before the first scroll ──
    collectVisibleNodes();
    await chrome.storage.local.set({ [KEY_COUNT]: videoMap.size });

    let scrollAttempts  = 0;
    let stableCount     = 0;
    let previousMapSize = videoMap.size;

    // ── Main scroll loop ──
    while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
      scrollAttempts++;

      // 1. Scroll window to bottom to trigger YouTube's lazy loader
      scrollToBottom();

      // 2. Wait for the network request + DOM hydration
      await sleep(SCROLL_WAIT_MS);

      // 3. Sweep newly rendered nodes
      collectVisibleNodes();

      const currentMapSize = videoMap.size;

      // 4. Publish live progress to popup
      await chrome.storage.local.set({ [KEY_COUNT]: currentMapSize });

      console.log(
        `[Watch Now] Scroll ${scrollAttempts}: ${currentMapSize} unique videos collected` +
        (declaredTotal ? ` / ${declaredTotal}` : "")
      );

      // 5. Early-exit if we've matched the declared total
      if (declaredTotal && currentMapSize >= declaredTotal) {
        console.log("[Watch Now] Reached declared total — stopping.");
        break;
      }

      // 6. Stable-count check — did we get any new videos this cycle?
      if (currentMapSize > previousMapSize) {
        // Progress made → reset idle counter
        stableCount = 0;
        previousMapSize = currentMapSize;
      } else {
        // No new videos this cycle
        stableCount++;
        console.log(
          `[Watch Now] No new videos (stable ${stableCount}/${STABLE_THRESHOLD}).`
        );
        if (stableCount >= STABLE_THRESHOLD) {
          console.log("[Watch Now] Stable threshold reached — playlist fully loaded.");
          break;
        }
      }
    }

    if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
      console.warn(
        `[Watch Now] Hit MAX_SCROLL_ATTEMPTS (${MAX_SCROLL_ATTEMPTS}). ` +
        `Stopped with ${videoMap.size} videos.`
      );
    }

    // ── Final sweep: capture any nodes rendered in the last wait ──
    collectVisibleNodes();

    scraping = false;

    const finalVideos = Array.from(videoMap.values());

    await chrome.storage.local.set({
      [KEY_STATUS]: "done",
      [KEY_COUNT]:  finalVideos.length,
      [KEY_VIDEOS]: finalVideos,
    });

    console.log(`[Watch Now] Done. ${finalVideos.length} videos stored.`);
    return { ok: true };
  }

  // ─── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "START_SCRAPE") {
      startScraping().then(sendResponse).catch((err) => {
        console.error("[Watch Now] startScraping threw:", err);
        sendResponse({ ok: false, error: err.message });
      });
      return true; // keep message channel open for async response
    }
  });

  // ─── SPA navigation reset ───────────────────────────────────────────────────
  // YouTube fires yt-navigate-finish on every client-side page transition.
  // Reset so a fresh scrape can be triggered when the user re-opens the popup.

  window.addEventListener("yt-navigate-finish", () => {
    console.log("[Watch Now] SPA navigation — resetting scrape state.");
    resetState();
  });

  console.log("[Watch Now] Content script ready.");
})();
