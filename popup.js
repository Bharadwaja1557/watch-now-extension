/**
 * popup.js
 * Controls the Watch Now popup UI.
 *
 * Render pipeline (non-mutating, applied in order):
 *   allVideos → applyFilter() → applySearch() → applySort() → renderGrid()
 *
 * State:
 *   allVideos   — master list loaded from storage, never mutated
 *   filterMode  — "all" | "unwatched"
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

  const loadingCountEl     = document.getElementById("loading-count");
  const gridContainer      = document.getElementById("grid-container");
  const noResultsEl        = document.getElementById("no-results");
  const searchInput        = document.getElementById("search-input");
  const sortSelect         = document.getElementById("sort-select");
  const surpriseBtn        = document.getElementById("surprise-btn");
  const rescanBtn          = document.getElementById("rescan-btn");
  const errorOpenBtn       = document.getElementById("error-open-btn");
  const unwatchedCounter   = document.getElementById("unwatched-counter");
  const headerRowSearch    = document.getElementById("header-row-search");
  const headerRowActions   = document.getElementById("header-row-actions");
  const filterBtns         = document.querySelectorAll(".filter-btn");

  // ─── Module state ────────────────────────────────────────────────────────────

  let pollInterval = null;
  let allVideos    = [];      // master list — never mutated
  let currentTabId = null;
  let filterMode   = "all";  // "all" | "unwatched"

  // ─── View management ─────────────────────────────────────────────────────────
  // Exactly ONE view is active at a time.
  // Rows 2 and 3 of the header are only shown when the grid is visible.

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("active", key === name);
    });

    const isGrid = name === "videoGrid";

    // Rows 2 + 3 are grid-only
    headerRowSearch.style.display  = isGrid ? "" : "none";
    headerRowActions.style.display = isGrid ? "" : "none";

    // Rescan stays visible on error and empty too
    rescanBtn.style.display =
      isGrid || name === "error" || name === "empty" ? "" : "none";
  }

  // ─── Counter ─────────────────────────────────────────────────────────────────

  function updateCounter() {
    if (allVideos.length === 0) {
      unwatchedCounter.textContent = "";
      return;
    }
    const unwatched = allVideos.filter((v) => !v.watched).length;
    unwatchedCounter.textContent = `Unwatched ${unwatched} / ${allVideos.length}`;
  }

  // ─── Filter ──────────────────────────────────────────────────────────────────

  /**
   * Apply the active filter mode.
   * Returns a NEW array — never mutates the input.
   */
  function applyFilter(videos) {
    if (filterMode === "unwatched") {
      return videos.filter((v) => !v.watched);
    }
    return videos.slice(); // "all" — return a copy, no filtering
  }

  /** Sync the visual state of the filter toggle buttons. */
  function syncFilterButtons() {
    filterBtns.forEach((btn) => {
      const active = btn.dataset.filter === filterMode;
      btn.classList.toggle("filter-btn--active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  // ─── Sort ────────────────────────────────────────────────────────────────────

  /** Fisher-Yates shuffle — returns a NEW array. */
  function shuffled(array) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Apply the selected sort mode.
   * Returns a NEW array — never mutates the input.
   * index 0 = top of Watch Later = newest.
   */
  function applySort(videos) {
    const mode = sortSelect.value;

    if (mode === "new")     return videos.slice().sort((a, b) => a.index - b.index);
    if (mode === "old")     return videos.slice().sort((a, b) => b.index - a.index);
    if (mode === "shuffle") return shuffled(videos);

    return videos.slice();
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  /**
   * Filter by the current search query.
   * Returns a NEW array — never mutates the input.
   */
  function applySearch(videos) {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return videos.slice();
    return videos.filter(
      (v) =>
        (v.title   || "").toLowerCase().includes(q) ||
        (v.channel || "").toLowerCase().includes(q)
    );
  }

  // ─── Render pipeline ─────────────────────────────────────────────────────────
  // Order: allVideos → filter → search → sort → render

  function updateGrid() {
    const filtered  = applyFilter(allVideos);
    const searched  = applySearch(filtered);
    const sorted    = applySort(searched);
    renderGrid(sorted);
  }

  // ─── Render grid ─────────────────────────────────────────────────────────────

  function renderGrid(videos) {
    gridContainer.innerHTML = "";
    noResultsEl.classList.add("hidden");

    if (videos.length === 0) {
      noResultsEl.classList.remove("hidden");
      return;
    }

    const fragment = document.createDocumentFragment();
    videos.forEach((video) => {
      fragment.appendChild(buildCard(video));
    });
    gridContainer.appendChild(fragment);
  }

  // ─── Build a single card ──────────────────────────────────────────────────────

  function buildCard(video) {
    const card = document.createElement("div");
    // Add .is-watched class so CSS can dim the thumbnail
    card.className = video.watched ? "video-card is-watched" : "video-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Watch ${video.title}`);
    card.dataset.videoId = video.videoId;

    // ── Thumbnail (locked 16:9) ──
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "thumb-wrap";

    const img = document.createElement("img");
    img.className = "thumb-img";
    img.src       = video.thumbnail;
    img.alt       = video.title;
    img.loading   = "lazy";
    img.decoding  = "async";
    img.onerror   = () => {
      img.src = `https://i.ytimg.com/vi/${video.videoId}/sddefault.jpg`;
    };
    thumbWrap.appendChild(img);

    if (video.duration) {
      const badge = document.createElement("span");
      badge.className   = "duration-badge";
      badge.textContent = video.duration;
      thumbWrap.appendChild(badge);
    }

    // Watched indicator overlay on the thumbnail
    if (video.watched) {
      const watchedBadge = document.createElement("span");
      watchedBadge.className   = "watched-badge";
      watchedBadge.textContent = "Watched";
      thumbWrap.appendChild(watchedBadge);
    }

    // ── Meta ──
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

    // ── Interaction ──
    const openVideo = () => openVideoUrl(video.videoUrl);
    card.addEventListener("click", openVideo);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openVideo();
      }
    });

    return card;
  }

  // ─── Open video in new tab ────────────────────────────────────────────────────

  function openVideoUrl(url) {
    chrome.runtime.sendMessage({ type: "OPEN_VIDEO", url });
  }

  // ─── Surprise Me ─────────────────────────────────────────────────────────────
  // Respects the active filter and search — picks from what's currently visible.

  function surpriseMe() {
    const filtered = applyFilter(allVideos);
    const searched = applySearch(filtered);
    if (searched.length === 0) return;
    const pick = searched[Math.floor(Math.random() * searched.length)];
    openVideoUrl(pick.videoUrl);
  }

  // ─── Event listeners ─────────────────────────────────────────────────────────

  // Filter toggle
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterMode = btn.dataset.filter;
      syncFilterButtons();
      if (allVideos.length > 0) updateGrid();
    });
  });

  // Search
  searchInput.addEventListener("input", () => {
    if (allVideos.length > 0) updateGrid();
  });

  // Sort
  sortSelect.addEventListener("change", () => {
    if (allVideos.length > 0) updateGrid();
  });

  // Surprise Me
  surpriseBtn.addEventListener("click", surpriseMe);

  // Rescan
  rescanBtn.addEventListener("click", async () => {
    stopPolling();
    allVideos    = [];
    filterMode   = "all";
    searchInput.value = "";
    sortSelect.value  = "new";
    gridContainer.innerHTML = "";
    unwatchedCounter.textContent = "";
    syncFilterButtons();

    await chrome.storage.local.set({
      [KEY_STATUS]: "idle",
      [KEY_COUNT]:  0,
      [KEY_VIDEOS]: [],
    });

    init();
  });

  // Error view open-tab button
  errorOpenBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.youtube.com/playlist?list=WL" });
  });

  // ─── Polling ─────────────────────────────────────────────────────────────────

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
    const data   = await chrome.storage.local.get([KEY_STATUS, KEY_VIDEOS, KEY_COUNT]);
    const status = data[KEY_STATUS];
    const count  = data[KEY_COUNT] ?? 0;

    if (status === "scraping") {
      loadingCountEl.textContent = `${count} video${count === 1 ? "" : "s"} found`;
      showView("loading");
      return;
    }

    if (status === "done") {
      stopPolling();
      loadVideosFromStorage(data[KEY_VIDEOS] ?? []);
      return;
    }

    if (status === "error") {
      stopPolling();
      showView("error");
    }
  }

  // ─── Load + display videos from storage data ──────────────────────────────────

  function loadVideosFromStorage(rawVideos) {
    // Stamp each with a stable scrape-order index; spread to avoid mutating storage obj
    allVideos = rawVideos.map((v, i) => ({ ...v, index: i }));

    if (allVideos.length === 0) {
      showView("empty");
      return;
    }

    updateCounter();
    syncFilterButtons();
    updateGrid();
    showView("videoGrid");
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    showView("loading");
    loadingCountEl.textContent = "Looking for Watch Later tab…";

    const { found, tabId } = await chrome.runtime.sendMessage({
      type: "FIND_WATCH_LATER_TAB",
    });

    if (!found) {
      showView("error");
      return;
    }

    currentTabId = tabId;

    const stored = await chrome.storage.local.get([KEY_STATUS, KEY_VIDEOS, KEY_COUNT]);

    // Already have complete results — show instantly
    if (stored[KEY_STATUS] === "done" && (stored[KEY_VIDEOS] ?? []).length > 0) {
      loadVideosFromStorage(stored[KEY_VIDEOS]);
      return;
    }

    // Scrape already running elsewhere — just poll
    if (stored[KEY_STATUS] === "scraping") {
      startPolling();
      showView("loading");
      return;
    }

    // Fresh scrape
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

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  init();
})();
