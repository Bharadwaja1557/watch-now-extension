/**
 * content.js
 * Runs on all YouTube pages.
 * When on the Watch Later playlist, scrapes all videos by scrolling the
 * playlist container and collecting ytd-playlist-video-renderer nodes.
 *
 * Architecture:
 *  - Listens for START_SCRAPE messages from the popup (via background.js).
 *  - Scrolls the playlist container (not window) deterministically.
 *  - Deduplicates via a Map keyed by video id.
 *  - Writes progress + results to chrome.storage.local.
 *  - Resets cleanly on SPA navigation (yt-navigate-finish).
 */

(() => {
  "use strict";

  // ─── Constants ─────────────────────────────────────────────────────────────

  const STORAGE_KEY_VIDEOS = "watchNow_videos";
  const STORAGE_KEY_STATUS = "watchNow_status"; // 'idle' | 'scraping' | 'done' | 'error'
  const STORAGE_KEY_COUNT  = "watchNow_scrapingCount";

  const SCROLL_STEP_PX        = 800;   // pixels per scroll tick
  const SCROLL_INTERVAL_MS    = 600;   // ms between scrolls
  const MAX_IDLE_SCROLLS      = 6;     // stop after this many scrolls with no new videos
  const MAX_TOTAL_SCROLLS     = 400;   // hard safety cap (~400 × 800px = 320,000px)

  // Selectors
  const CONTAINER_SELECTOR    = "ytd-playlist-video-list-renderer #contents";
  const VIDEO_NODE_SELECTOR   = "ytd-playlist-video-renderer";

  // ─── State ─────────────────────────────────────────────────────────────────

  let scraping       = false;
  let videoMap       = new Map();  // videoId → videoObject
  let scrollTimer    = null;

  // ─── Utility: is this the Watch Later page? ─────────────────────────────────

  function isWatchLaterPage() {
    return location.href.includes("youtube.com/playlist?list=WL");
  }

  // ─── Utility: write state to storage ───────────────────────────────────────

  async function persistProgress(status) {
    await chrome.storage.local.set({
      [STORAGE_KEY_STATUS]: status,
      [STORAGE_KEY_COUNT]:  videoMap.size,
      [STORAGE_KEY_VIDEOS]: status === "done" ? Array.from(videoMap.values()) : [],
    });
  }

  // ─── Utility: reset all scraping state ─────────────────────────────────────

  async function resetState() {
    scraping  = false;
    videoMap  = new Map();
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    await chrome.storage.local.set({
      [STORAGE_KEY_STATUS]: "idle",
      [STORAGE_KEY_COUNT]:  0,
      [STORAGE_KEY_VIDEOS]: [],
    });
  }

  // ─── Video extraction from a single renderer node ──────────────────────────

  function extractVideo(node) {
    try {
      // Video URL / ID
      const linkEl = node.querySelector("a#video-title");
      if (!linkEl) return null;

      const href = linkEl.href || "";
      const urlParams = new URLSearchParams(href.split("?")[1] ?? "");
      const videoId   = urlParams.get("v");
      if (!videoId) return null;

      // Title
      const title = (linkEl.title || linkEl.textContent || "").trim();

      // Channel name
      const channelEl = node.querySelector(
        "ytd-channel-name yt-formatted-string, " +
        "#channel-name yt-formatted-string, " +
        "#byline-container #text"
      );
      const channel = channelEl ? channelEl.textContent.trim() : "Unknown";

      // Duration
      const durationEl = node.querySelector(
        "ytd-thumbnail-overlay-time-status-renderer span, " +
        "span.ytd-thumbnail-overlay-time-status-renderer"
      );
      const duration = durationEl ? durationEl.textContent.trim() : "";

      // Thumbnail — prefer high-res mqdefault, fall back to sddefault
      const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

      // Video watch URL
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      return { videoId, title, channel, duration, thumbnail, videoUrl };
    } catch (err) {
      console.warn("[Watch Now] extractVideo error:", err);
      return null;
    }
  }

  // ─── Collect all currently-rendered video nodes ────────────────────────────

  function collectVisibleVideos() {
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

  // ─── Main scraping loop ─────────────────────────────────────────────────────

  async function startScraping() {
    if (scraping) return { ok: true, already: true };
    if (!isWatchLaterPage()) {
      return { ok: false, error: "Not on Watch Later page" };
    }

    scraping   = true;
    videoMap   = new Map();

    await chrome.storage.local.set({
      [STORAGE_KEY_STATUS]: "scraping",
      [STORAGE_KEY_COUNT]:  0,
      [STORAGE_KEY_VIDEOS]: [],
    });

    // Find the scrollable playlist container
    const container = document.querySelector(CONTAINER_SELECTOR);
    if (!container) {
      await chrome.storage.local.set({ [STORAGE_KEY_STATUS]: "error" });
      scraping = false;
      return { ok: false, error: "Playlist container not found" };
    }

    let idleScrolls  = 0;
    let totalScrolls = 0;

    // Collect whatever is already visible before any scrolling
    collectVisibleVideos();

    await new Promise((resolve) => {
      scrollTimer = setInterval(async () => {
        totalScrolls++;

        // Safety cap — never run forever
        if (totalScrolls >= MAX_TOTAL_SCROLLS) {
          clearInterval(scrollTimer);
          scrollTimer = null;
          resolve();
          return;
        }

        // Scroll the container, not the window
        const prevScrollTop = container.scrollTop;
        container.scrollBy({ top: SCROLL_STEP_PX, behavior: "smooth" });

        // Wait a tick for DOM to update after scroll
        await new Promise((r) => setTimeout(r, 150));

        const newCount = collectVisibleVideos();

        // Update storage with live count so popup can show progress
        chrome.storage.local.set({
          [STORAGE_KEY_COUNT]: videoMap.size,
        });

        // Check stopping conditions
        const atBottom =
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 50;

        const noMovement = container.scrollTop === prevScrollTop;

        if (newCount === 0) {
          idleScrolls++;
        } else {
          idleScrolls = 0;
        }

        if (atBottom || noMovement || idleScrolls >= MAX_IDLE_SCROLLS) {
          clearInterval(scrollTimer);
          scrollTimer = null;
          resolve();
        }
      }, SCROLL_INTERVAL_MS);
    });

    // Final collect pass at the bottom
    collectVisibleVideos();

    scraping = false;

    // Persist final results
    await chrome.storage.local.set({
      [STORAGE_KEY_STATUS]: "done",
      [STORAGE_KEY_COUNT]:  videoMap.size,
      [STORAGE_KEY_VIDEOS]: Array.from(videoMap.values()),
    });

    console.log(`[Watch Now] Scraping complete. ${videoMap.size} videos found.`);
    return { ok: true };
  }

  // ─── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "START_SCRAPE") {
      startScraping().then(sendResponse);
      return true; // async response
    }
  });

  // ─── SPA navigation reset ───────────────────────────────────────────────────
  // YouTube fires yt-navigate-finish after every in-app navigation.
  // Reset scraping state so a fresh scan can be triggered on the new page.

  window.addEventListener("yt-navigate-finish", async () => {
    console.log("[Watch Now] SPA navigation detected — resetting state.");
    await resetState();
  });

  console.log("[Watch Now] Content script ready.");
})();
