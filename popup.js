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
 *  - Handle sort (New / Old / Shuffle) client-side.
 *  - Handle Surprise Me — open a random video in a new tab.
 *  - Ensure exactly ONE view is visible at all times.
 *
 * Render pipeline (non-mutating):
 *   allVideos → applySearch() → applySort() → renderGrid()
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

  const loadingCountEl = document.getElementById("loading-count");
  const gridContainer  = document.getElementById("grid-container");
  const noResultsEl    = document.getElementById("no-results");
  const searchInput    = document.getElementById("search-input");
  const sortSelect     = document.getElementById("sort-select");
  const surpriseBtn    = document.getElementById("surprise-btn");
  const rescanBtn      = document.getElementById("rescan-btn");
  const errorOpenBtn   = document.getElementById("error-open-btn");

  // ─── State ──────────────────────────────────────────────────────────────────

  let pollInterval = null;
  let allVideos    = [];   // master list, never mutated after load
  let currentTabId = null;

  // ─── View management ────────────────────────────────────────────────────────
  // Only ONE view may be active at a time.
  // Header controls visibility is also managed here.

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("active", key === name);
    });

    const isGrid = name === "videoGrid";

    // Controls that only make sense when the grid is showing
    searchInput.style.display  = isGrid ? "" : "none";
    sortSelect.style.display   = isGrid ? "" : "none";
    surpriseBtn.style.display  = isGrid ? "" : "none";

    // Rescan is also useful on error / empty states
    rescanBtn.style.display =
      isGrid || name === "error" || name === "empty" ? "" : "none";
  }

  // ─── Sorting ─────────────────────────────────────────────────────────────────

  /**
   * Fisher-Yates shuffle — returns a NEW array, does not mutate input.
   */
  function shuffled(array) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Apply the currently selected sort to an array.
   * Returns a NEW array — never mutates the input.
   *
   * Each video carries an `index` field (position in scrape order,
   * 0 = first in Watch Later = newest).
   */
  function applySort(videos) {
    const mode = sortSelect.value;

    if (mode === "new") {
      // index ascending → newest first (Watch Later top = index 0)
      return videos.slice().sort((a, b) => a.index - b.index);
    }

    if (mode === "old") {
      // index descending → oldest first
      return videos.slice().sort((a, b) => b.index - a.index);
    }

    if (mode === "shuffle") {
      return shuffled(videos);
    }

    return videos.slice();
  }

  // ─── Search filtering ────────────────────────────────────────────────────────

  /**
   * Filter allVideos by the current search query.
   * Returns a NEW array — never mutates allVideos.
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

  // ─── Main render pipeline ────────────────────────────────────────────────────
  // Order: allVideos → search filter → sort → render

  function updateGrid() {
    const filtered = applySearch(allVideos);
    const sorted   = applySort(filtered);
    renderGrid(sorted);
  }

  // ─── Render video grid ──────────────────────────────────────────────────────

  function renderGrid(videos) {
    // Clear existing cards
    gridContainer.innerHTML = "";
    noResultsEl.classList.add("hidden");

    if (videos.length === 0) {
      noResultsEl.classList.remove("hidden");
      return;
    }

    // Build all cards into a fragment — one DOM write
    const fragment = document.createDocumentFragment();
    videos.forEach((video) => {
      fragment.appendChild(buildCard(video));
    });
    gridContainer.appendChild(fragment);
  }

  // ─── Build a single video card ───────────────────────────────────────────────

  function buildCard(video) {
    const card = document.createElement("div");
    card.className = "video-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Watch ${video.title}`);
    card.dataset.videoId = video.videoId;

    // ── Thumbnail wrapper (locked 16:9 via padding trick) ──
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

    // ── Card meta ──
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

    // ── Open video on click / Enter / Space ──
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

  // ─── Open a video URL in a new tab ──────────────────────────────────────────

  function openVideoUrl(url) {
    chrome.runtime.sendMessage({ type: "OPEN_VIDEO", url });
  }

  // ─── Surprise Me ────────────────────────────────────────────────────────────
  // Pick a random video from the CURRENTLY FILTERED list (respects search),
  // but ignores sort order — random is already random.

  function surpriseMe() {
    const pool = applySearch(allVideos);
    if (pool.length === 0) return;

    const pick = pool[Math.floor(Math.random() * pool.length)];
    openVideoUrl(pick.videoUrl);
  }

  surpriseBtn.addEventListener("click", surpriseMe);

  // ─── Sort change ─────────────────────────────────────────────────────────────

  sortSelect.addEventListener("change", () => {
    if (allVideos.length > 0) updateGrid();
  });

  // ─── Search change ───────────────────────────────────────────────────────────

  searchInput.addEventListener("input", () => {
    if (allVideos.length > 0) updateGrid();
  });

  // ─── Rescan button ───────────────────────────────────────────────────────────

  rescanBtn.addEventListener("click", async () => {
    stopPolling();
    allVideos = [];
    searchInput.value = "";
    sortSelect.value  = "new";
    gridContainer.innerHTML = "";

    await chrome.storage.local.set({
      [KEY_STATUS]: "idle",
      [KEY_COUNT]:  0,
      [KEY_VIDEOS]: [],
    });

    init();
  });

  // ─── Error view: open Watch Later ────────────────────────────────────────────

  errorOpenBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.youtube.com/playlist?list=WL" });
  });

  // ─── Storage polling ─────────────────────────────────────────────────────────

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
      // Stamp each video with its scrape-order index so sorting works correctly
      allVideos = (data[KEY_VIDEOS] ?? []).map((v, i) => ({ ...v, index: i }));

      if (allVideos.length === 0) {
        showView("empty");
      } else {
        updateGrid();
        showView("videoGrid");
      }
      return;
    }

    if (status === "error") {
      stopPolling();
      showView("error");
    }
  }

  // ─── Initialise ──────────────────────────────────────────────────────────────

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

    // Already have finished results — show immediately
    if (stored[KEY_STATUS] === "done" && (stored[KEY_VIDEOS] ?? []).length > 0) {
      allVideos = (stored[KEY_VIDEOS] ?? []).map((v, i) => ({ ...v, index: i }));
      updateGrid();
      showView("videoGrid");
      return;
    }

    // Scrape already in progress in another context — just poll
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

  // ─── Boot ────────────────────────────────────────────────────────────────────

  init();
})();
