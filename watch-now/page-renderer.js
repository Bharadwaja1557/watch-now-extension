// watch-now/page-renderer.js
// Orchestrates the Watch Now page:
//   - Builds the DOM structure
//   - Wires up controls (search, sort, filter)
//   - Runs the scanner and saves results
//   - Delegates grid rendering to WatchNowVideoGrid

window.WatchNowPage = (() => {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────────────

  let db       = null;
  let scanning = false;

  const state = {
    query:       '',
    sortBy:      'newest',
    watchStatus: 'all'
  };

  // ─── Mount / Unmount ───────────────────────────────────────────────────────

  async function mount() {
    db = await WatchNowDB.load();
    buildPageStructure();
    attachControlListeners();

    if (WatchNowDB.getAllVideos(db).length === 0) {
      showEmptyPrompt();
    } else {
      renderVideos();
    }
  }

  function unmount() {
    const page = document.getElementById('wln-page');
    if (page) page.remove();
  }

  // ─── DOM construction ──────────────────────────────────────────────────────

  function buildPageStructure() {
    // Remove any existing instance
    const existing = document.getElementById('wln-page');
    if (existing) existing.remove();

    // ── BUG 1 FIX: measure vertical offset ───────────────────────────────────
    // We cannot use navbar.getBoundingClientRect().height because the YouTube
    // topics/chips bar (ytd-feed-filter-chip-bar-renderer) lives BELOW the
    // navbar with position:sticky and is NOT part of #masthead-container.
    // Instead we read #page-manager.getBoundingClientRect().top — this always
    // equals the distance from the viewport top to where real content begins,
    // naturally accounting for the navbar AND any sticky bars below it.
    const pm = document.getElementById('page-manager');
    const navH = pm
      ? Math.max(Math.round(pm.getBoundingClientRect().top), 56)
      : 56;

    // ── BUG 2 FIX: measure horizontal offset ─────────────────────────────────
    // YouTube's #page-manager always has margin-left:72px (mini-guide width).
    // When the FULL 240px guide drawer is open it overlays #page-manager at a
    // higher z-index — pm.getBoundingClientRect().left stays at 72px even
    // though the guide covers 0-240px.  We must read the guide drawer's actual
    // right edge so our overlay never starts underneath the sidebar.
    const contentLeft = measureGuideRight();

    // Root page element (fixed overlay starting after the sidebar)
    const page = document.createElement('div');
    page.id           = 'wln-page';
    page.style.top    = navH + 'px';
    page.style.left   = contentLeft + 'px';

    // ── Top bar ──────────────────────────────────────────────────────────────
    const topbar = document.createElement('div');
    topbar.id = 'wln-topbar';

    // Controls row
    const controlsRow = document.createElement('div');
    controlsRow.id = 'wln-controls-row';

    // Search
    const searchWrap = document.createElement('div');
    searchWrap.id = 'wln-search-wrap';

    const searchIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    searchIcon.setAttribute('class', 'wln-search-icon');
    searchIcon.setAttribute('viewBox', '0 0 24 24');
    searchIcon.setAttribute('width', '18');
    searchIcon.setAttribute('height', '18');
    const searchPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    searchPath.setAttribute('fill', 'currentColor');
    searchPath.setAttribute('d',
      'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 ' +
      '3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 ' +
      '9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'
    );
    searchIcon.appendChild(searchPath);
    searchWrap.appendChild(searchIcon);

    const searchInput = document.createElement('input');
    searchInput.id          = 'wln-search';
    searchInput.type        = 'text';
    searchInput.placeholder = 'Search titles and channels…';
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);

    const clearBtn = document.createElement('button');
    clearBtn.id          = 'wln-search-clear';
    clearBtn.type        = 'button';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.textContent = '✕';
    searchWrap.appendChild(clearBtn);

    controlsRow.appendChild(searchWrap);

    // Right controls
    const rightControls = document.createElement('div');
    rightControls.id = 'wln-right-controls';

    // Sort dropdown
    const sortSelect = document.createElement('select');
    sortSelect.id = 'wln-sort';
    const sortOptions = [
      { value: 'newest',  label: 'Newest first'  },
      { value: 'oldest',  label: 'Oldest first'  },
      { value: 'shortest', label: 'Shortest first' },
      { value: 'longest', label: 'Longest first'  },
      { value: 'alpha',   label: 'Alphabetical'  },
      { value: 'random',  label: 'Randomize'     }
    ];
    for (const opt of sortOptions) {
      const o = document.createElement('option');
      o.value       = opt.value;
      o.textContent = opt.label;
      sortSelect.appendChild(o);
    }
    rightControls.appendChild(sortSelect);

    // Watch status toggle
    const toggle = document.createElement('div');
    toggle.id = 'wln-watch-toggle';
    for (const [status, label] of [['all', 'All'], ['unwatched', 'Unwatched'], ['watched', 'Watched']]) {
      const btn = document.createElement('button');
      btn.type              = 'button';
      btn.className         = 'wln-toggle-btn' + (status === 'all' ? ' active' : '');
      btn.dataset.status    = status;
      btn.textContent       = label;
      toggle.appendChild(btn);
    }
    rightControls.appendChild(toggle);

    // Rescan button
    const rescanBtn = document.createElement('button');
    rescanBtn.id          = 'wln-rescan-btn';
    rescanBtn.type        = 'button';
    rescanBtn.textContent = '↻ Rescan';
    rightControls.appendChild(rescanBtn);

    controlsRow.appendChild(rightControls);
    topbar.appendChild(controlsRow);

    // Stats row
    const statsRow = document.createElement('div');
    statsRow.id = 'wln-stats-row';
    const counter = document.createElement('span');
    counter.id = 'wln-video-counter';
    statsRow.appendChild(counter);
    topbar.appendChild(statsRow);

    page.appendChild(topbar);

    // ── Content area (scroll container) ──────────────────────────────────────
    const contentArea = document.createElement('div');
    contentArea.id = 'wln-content-area';
    page.appendChild(contentArea);

    document.body.appendChild(page);
  }

  // ─── Video rendering ───────────────────────────────────────────────────────

  function renderVideos() {
    const area = document.getElementById('wln-content-area');
    if (!area) return;

    const allVideos = WatchNowDB.getAllVideos(db);
    const filtered  = WatchNowFilters.applyAll(allVideos, state);

    // Counter
    const counter = document.getElementById('wln-video-counter');
    if (counter) {
      const stats = WatchNowDB.getStats(db);
      counter.textContent =
        `${filtered.length} video${filtered.length !== 1 ? 's' : ''} ` +
        `(${stats.total} total · ${stats.watched} watched · ${stats.unwatched} unwatched)`;
    }

    // Replace grid content
    area.innerHTML = '';
    const grid = WatchNowVideoGrid.render(filtered, handleMarkWatched, area);
    area.appendChild(grid);
  }

  async function handleMarkWatched(videoId, watched) {
    db = WatchNowDB.markWatched(db, videoId, watched);
    await WatchNowDB.save(db);
    WatchNowVideoGrid.updateCard(videoId, watched);

    // Update counter without re-rendering the whole grid
    const counter = document.getElementById('wln-video-counter');
    if (counter) {
      const allVideos = WatchNowDB.getAllVideos(db);
      const filtered  = WatchNowFilters.applyAll(allVideos, state);
      const stats     = WatchNowDB.getStats(db);
      counter.textContent =
        `${filtered.length} video${filtered.length !== 1 ? 's' : ''} ` +
        `(${stats.total} total · ${stats.watched} watched · ${stats.unwatched} unwatched)`;
    }
  }

  // ─── Empty / first-run prompt ──────────────────────────────────────────────

  function showEmptyPrompt() {
    const area = document.getElementById('wln-content-area');
    if (!area) return;

    area.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'wln-empty-state';

    const icon = document.createElement('div');
    icon.className   = 'wln-empty-icon';
    icon.textContent = '📋';

    const title = document.createElement('div');
    title.className   = 'wln-empty-title';
    title.textContent = 'Watch Later not scanned yet';

    const sub = document.createElement('div');
    sub.className   = 'wln-empty-sub';
    sub.textContent = 'Import your Watch Later playlist to get started';

    const btn = document.createElement('button');
    btn.id          = 'wln-initial-scan-btn';
    btn.type        = 'button';
    btn.className   = 'wln-cta-btn';
    btn.textContent = '↻ Scan Watch Later';
    btn.addEventListener('click', startScan);

    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(sub);
    wrap.appendChild(btn);
    area.appendChild(wrap);
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  function attachControlListeners() {
    // Search — debounced 250ms
    let searchTimer;
    document.getElementById('wln-search')?.addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = e.target.value;
        renderVideos();
      }, 250);
    });

    // Clear search
    document.getElementById('wln-search-clear')?.addEventListener('click', () => {
      const input = document.getElementById('wln-search');
      if (input) input.value = '';
      state.query = '';
      renderVideos();
    });

    // Sort
    document.getElementById('wln-sort')?.addEventListener('change', e => {
      state.sortBy = e.target.value;
      renderVideos();
    });

    // Watch status toggle
    document.getElementById('wln-watch-toggle')?.addEventListener('click', e => {
      const btn = e.target.closest('.wln-toggle-btn');
      if (!btn) return;
      document.querySelectorAll('.wln-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.watchStatus = btn.dataset.status;
      renderVideos();
    });

    // Rescan
    document.getElementById('wln-rescan-btn')?.addEventListener('click', startScan);
  }

  // ─── Scan orchestration ────────────────────────────────────────────────────

  async function startScan() {
    if (scanning) return;
    scanning = true;

    const rescanBtn = document.getElementById('wln-rescan-btn');
    const initBtn   = document.getElementById('wln-initial-scan-btn');

    if (rescanBtn) { rescanBtn.disabled = true; rescanBtn.textContent = '↻ Scanning…'; }
    if (initBtn)   { initBtn.disabled   = true; initBtn.textContent   = '↻ Scanning…'; }

    showProgress(5, 'Starting…');

    try {
      const { videos } = await WatchNowScanner.scan((pct, msg) => showProgress(pct, msg));

      if (!db) db = await WatchNowDB.load();
      db = WatchNowDB.replaceAll(db, videos);
      await WatchNowDB.save(db);

      showProgress(100, `Complete — ${videos.length} videos loaded`);
      showToast(`✓ Loaded ${videos.length} videos`);
      setTimeout(hideProgress, 900);

      renderVideos();
    } catch (err) {
      console.error('[WatchLaterNow] Scan failed:', err);
      showToast('Scan failed: ' + err.message);
      hideProgress();
    }

    scanning = false;
    if (rescanBtn) { rescanBtn.disabled = false; rescanBtn.textContent = '↻ Rescan'; }
  }

  // ─── Progress bar ──────────────────────────────────────────────────────────

  function showProgress(pct, message) {
    let bar = document.getElementById('wln-scan-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'wln-scan-progress';

      const text = document.createElement('div');
      text.id        = 'wln-scan-text';
      text.className = 'wln-scan-text';

      const track = document.createElement('div');
      track.className = 'wln-progress-track';

      const fill = document.createElement('div');
      fill.id        = 'wln-progress-fill';
      fill.className = 'wln-progress-fill';

      track.appendChild(fill);
      bar.appendChild(text);
      bar.appendChild(track);

      const topbar = document.getElementById('wln-topbar');
      if (topbar) topbar.appendChild(bar);
    }

    const text = document.getElementById('wln-scan-text');
    const fill = document.getElementById('wln-progress-fill');
    if (text) text.textContent = message;
    if (fill) fill.style.width = pct + '%';
  }

  function hideProgress() {
    const bar = document.getElementById('wln-scan-progress');
    if (bar) {
      bar.style.transition = 'opacity 0.4s';
      bar.style.opacity    = '0';
      setTimeout(() => bar.remove(), 450);
    }
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg) {
    document.querySelector('.wln-toast')?.remove();
    const toast = document.createElement('div');
    toast.className   = 'wln-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('wln-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('wln-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ─── Layout measurement helpers ────────────────────────────────────────────

  // Returns the pixel offset from the left viewport edge at which our content
  // should begin — i.e. the right edge of whatever sidebar YouTube is showing.
  //
  // YouTube has two guide modes that run simultaneously:
  //   • tp-yt-app-drawer  — full 240px drawer, position:fixed, can be open/closed
  //   • #mini-guide       — 72px mini bar, always visible when guide is enabled
  //
  // #page-manager always has margin-left:72px regardless of drawer state, so
  // pm.getBoundingClientRect().left is NOT a reliable source for the full guide.
  function measureGuideRight() {
    // Full guide drawer: getBoundingClientRect() accounts for CSS transforms,
    // so when it is translated off-screen its .right is ≤ 0.
    const drawer = document.querySelector('tp-yt-app-drawer');
    if (drawer) {
      const r = drawer.getBoundingClientRect();
      if (r.right > 10) return Math.round(r.right); // drawer is open
    }

    // Mini guide fallback (72px)
    const mini =
      document.querySelector('#mini-guide') ||
      document.querySelector('ytd-mini-guide-renderer');
    if (mini) {
      const r = mini.getBoundingClientRect();
      if (r.right > 0) return Math.round(r.right);
    }

    // Last resort: page-manager left edge
    const pm = document.getElementById('page-manager');
    if (pm) return Math.round(pm.getBoundingClientRect().left);

    return 0;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return { mount, unmount };
})();
