/**
 * popup.js
 * Controls the Watch Now popup UI.
 *
 * Responsibilities:
 *  - Check for an open Watch Later tab.
 *  - Trigger scraping via background.js → content.js.
 *  - Poll chrome.storage.local for progress and show live count.
 *  - Render the video grid when scanning is complete.
 *  - Handle search filtering client-side.
 *  - Ensure exactly ONE view is visible at all times.
 */

(() => {
  "use strict";

  // ─── Storage keys (must match content.js) ──────────────────────────────────

  const KEY_VIDEOS = "watchNow_videos";
  const KEY_STATUS = "watchNow_status";
  const KEY_COUNT  = "watchNow_scrapingCount";

  // ─── DOM references ─────────────────────────────────────────────────────────

  const views = {
    loading:   document.getElementById("loadingView"),
    error:     document.getElementById("errorView"),
    empty:     document.getElementById("emptyView"),
    videoGrid: document.getElementById("videoGrid"),
  };

  const loadingCountEl  = document.getElementById("loading-count");
  const gridContainer   = document.getElementById("grid-container");
  const noResultsEl     = document.getElementById("no-results");
  const searchInput     = document.getElementById("search-input");
  const rescanBtn       = document.getElementById("rescan-btn");
  const errorOpenBtn    = document.getElementById("error-open-btn");
  const searchControls  = document.querySelector(".header-controls");

  // ─── State ──────────────────────────────────────────────────────────────────

  let pollInterval   = null;
  let allVideos      = [];
  let currentTabId   = null;

  // ─── View management: only ONE view visible at a time ───────────────────────

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("active", key === name);
    });

    // Show search + rescan only when grid is visible
    const isGrid = name === "videoGrid";
    searchInput.style.display  = isGrid ? "block" : "none";
    rescanBtn.style.display    = isGrid ? "inline-flex" : "none";

    // Show rescan in error/empty too for convenience
    if (name === "error" || name === "empty") {
      rescanBtn.style.display = "inline-flex";
    }
  }

  // ─── Initialise popup ───────────────────────────────────────────────────────

  async function init() {
    showView("loading");
    loadingCountEl.textContent = "Looking for Watch Later tab…";

    // Check for an existing Watch Later tab
    const { found, tabId } = await chrome.runtime.sendMessage({
      type: "FIND_WATCH_LATER_TAB",
    });

    if (!found) {
      showView("error");
      return;
    }

    currentTabId = tabId;

    // Check if we already have completed results in storage
    const stored = await chrome.storage.local.get([KEY_STATUS, KEY_VIDEOS, KEY_COUNT]);

    if (stored[KEY_STATUS] === "done" && Array.from(stored[KEY_VIDEOS] ?? []).length > 0) {
      allVideos = stored[KEY_VIDEOS];
      renderGrid(allVideos);
      showView("videoGrid");
      return;
    }

    if (stored[KEY_STATUS] === "scraping") {
      // A scrape is already in progress — just watch storage for updates
      startPolling();
      showView("loading");
      return;
    }

    // No existing results — kick off a fresh scrape
    await chrome.storage.local.set({
      [KEY_STATUS]: "idle",
      [KEY_COUNT]:  0,
      [KEY_VIDEOS]: [],
    });

    const result = await chrome.runtime.sendMessage({
      type: "START_SCRAPE",
      tabId: currentTabId,
    });

    if (!result?.ok && !result?.already) {
      console.warn("[Watch Now] START_SCRAPE failed:", result?.error);
    }

    startPolling();
    showView("loading");
  }

  // ─── Poll storage for progress ──────────────────────────────────────────────

  function startPolling() {
    stopPolling();
    pollInterval = setInterval(checkProgress, 500);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  async function checkProgress() {
    const data = await chrome.storage.local.get([KEY_STATUS, KEY_VIDEOS, KEY_COUNT]);
    const status = data[KEY_STATUS];
    const count  = data[KEY_COUNT] ?? 0;

    if (status === "scraping") {
      loadingCountEl.textContent = `${count} video${count === 1 ? "" : "s"} found`;
      showView("loading");
      return;
    }

    if (status === "done") {
      stopPolling();
      allVideos = data[KEY_VIDEOS] ?? [];

      if (allVideos.length === 0) {
        showView("empty");
      } else {
        renderGrid(allVideos);
        showView("videoGrid");
      }
      return;
    }

    if (status === "error") {
      stopPolling();
      showView("error");
    }
  }

  // ─── Render video grid ──────────────────────────────────────────────────────

  function renderGrid(videos) {
    gridContainer.innerHTML = "";
    noResultsEl.classList.add("hidden");

    if (videos.length === 0) {
      noResultsEl.classList.remove("hidden");
      return;
    }

    const fragment = document.createDocumentFragment();

    videos.forEach((video) => {
      const card = buildCard(video);
      fragment.appendChild(card);
    });

    gridContainer.appendChild(fragment);
  }

  function buildCard(video) {
    const card = document.createElement("div");
    card.className = "video-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Watch ${video.title}`);
    card.dataset.videoId = video.videoId;

    // Thumbnail wrapper — fixed aspect ratio via padding trick
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "thumb-wrap";

    const img = document.createElement("img");
    img.className  = "thumb-img";
    img.src        = video.thumbnail;
    img.alt        = video.title;
    img.loading    = "lazy";
    img.decoding   = "async";
    // Fallback if thumbnail fails to load
    img.onerror    = () => {
      img.src = `https://i.ytimg.com/vi/${video.videoId}/sddefault.jpg`;
    };

    const durationBadge = document.createElement("span");
    durationBadge.className   = "duration-badge";
    durationBadge.textContent = video.duration || "";

    thumbWrap.appendChild(img);
    if (video.duration) thumbWrap.appendChild(durationBadge);

    // Card meta
    const meta = document.createElement("div");
    meta.className = "card-meta";

    const titleEl = document.createElement("p");
    titleEl.className   = "card-title";
    titleEl.textContent = video.title || "Untitled";

    const channelEl = document.createElement("p");
    channelEl.className   = "card-channel";
    channelEl.textContent = video.channel || "";

    meta.appendChild(titleEl);
    meta.appendChild(channelEl);

    card.appendChild(thumbWrap);
    card.appendChild(meta);

    // Click / keyboard opens video in new tab
    const openVideo = () => {
      chrome.runtime.sendMessage({
        type: "OPEN_VIDEO",
        url:  video.videoUrl,
      });
    };

    card.addEventListener("click", openVideo);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openVideo();
      }
    });

    return card;
  }

  // ─── Search filtering ───────────────────────────────────────────────────────

  function filterVideos(query) {
    if (!query.trim()) {
      renderGrid(allVideos);
      return;
    }

    const q = query.toLowerCase();
    const filtered = allVideos.filter(
      (v) =>
        v.title.toLowerCase().includes(q) ||
        v.channel.toLowerCase().includes(q)
    );

    renderGrid(filtered);
  }

  searchInput.addEventListener("input", (e) => {
    filterVideos(e.target.value);
  });

  // ─── Rescan button ──────────────────────────────────────────────────────────

  rescanBtn.addEventListener("click", async () => {
    stopPolling();
    allVideos = [];
    searchInput.value = "";
    gridContainer.innerHTML = "";

    // Clear stored data so content script starts fresh
    await chrome.storage.local.set({
      [KEY_STATUS]: "idle",
      [KEY_COUNT]:  0,
      [KEY_VIDEOS]: [],
    });

    init();
  });

  // ─── Error view: open Watch Later button ────────────────────────────────────

  errorOpenBtn.addEventListener("click", () => {
    chrome.tabs.create({
      url: "https://www.youtube.com/playlist?list=WL",
    });
  });

  // ─── Boot ───────────────────────────────────────────────────────────────────

  init();
})();
