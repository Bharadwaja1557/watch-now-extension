// watch-now/video-grid.js
// Renders the video grid with lazy loading (batched by scroll position).
// No inline event handlers (CSP compliant).
// No category tags.

window.WatchNowVideoGrid = (() => {
  'use strict';

  const BATCH_SIZE  = 40; // cards rendered per batch

  // Module-level scroll state — one grid active at a time.
  let _scrollEl      = null;
  let _scrollHandler = null;
  let _gridEl        = null;
  let _videos        = [];
  let _rendered      = 0;
  let _busy          = false;
  let _onMarkWatched = null;

  // ─── Public: render ────────────────────────────────────────────────────────

  // videos           — full sorted+filtered VideoRecord[]
  // onMarkWatched    — async (videoId, watched: boolean) => void
  // scrollContainer  — element whose scroll event drives lazy loading
  //
  // Returns a wrapper div to append into the page.
  function render(videos, onMarkWatched, scrollContainer) {
    // Tear down previous scroll listener
    teardownScroll();

    _videos        = videos;
    _rendered      = 0;
    _busy          = false;
    _onMarkWatched = onMarkWatched;

    const wrapper = document.createElement('div');
    wrapper.id = 'wln-grid-wrapper';

    if (videos.length === 0) {
      wrapper.appendChild(buildEmptyState());
      return wrapper;
    }

    _gridEl = document.createElement('div');
    _gridEl.id = 'wln-video-grid';
    wrapper.appendChild(_gridEl);

    // First batch
    _rendered = renderBatch(_gridEl, videos, 0, BATCH_SIZE);

    // Setup infinite scroll
    setupScroll(scrollContainer);

    return wrapper;
  }

  // ─── Public: updateCard ────────────────────────────────────────────────────

  // Update a single card's visual state without re-rendering the whole grid.
  function updateCard(videoId, watched) {
    const card = document.querySelector(`.wln-video-card[data-video-id="${videoId}"]`);
    if (!card) return;

    card.classList.toggle('wln-watched',   watched);
    card.classList.toggle('wln-unwatched', !watched);

    // Watched badge
    const existingBadge = card.querySelector('.wln-watched-badge');
    if (watched && !existingBadge) {
      const thumbWrap = card.querySelector('.wln-thumb-wrap');
      if (thumbWrap) {
        const badge = document.createElement('div');
        badge.className = 'wln-watched-badge';
        const span = document.createElement('span');
        span.textContent = '✓ Watched';
        badge.appendChild(span);
        thumbWrap.appendChild(badge);
      }
    } else if (!watched && existingBadge) {
      existingBadge.remove();
    }

    // Toggle button text
    const btn = card.querySelector('.wln-mark-btn');
    if (btn) {
      btn.textContent   = watched ? '↩ Mark Unwatched' : '✓ Mark Watched';
      btn.dataset.watched = String(watched);
    }
  }

  // ─── Card builder ──────────────────────────────────────────────────────────

  function buildCard(video) {
    const card = document.createElement('div');
    card.className       = `wln-video-card ${video.watched ? 'wln-watched' : 'wln-unwatched'}`;
    card.dataset.videoId = video.videoId;

    // ── Thumbnail wrapper ──────────────────────────────────────────────────
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'wln-thumb-wrap';

    const img = document.createElement('img');
    img.className = 'wln-thumb';
    img.alt     = video.title || '';
    img.loading = 'lazy';
    img.src     = video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
    // Fallback on error — NO inline onerror attribute (CSP violation)
    img.addEventListener('error', () => {
      img.src = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
    }, { once: true });
    thumbWrap.appendChild(img);

    // Duration badge
    if (video.duration) {
      const dur = document.createElement('div');
      dur.className   = 'wln-duration-badge';
      dur.textContent = video.duration;
      thumbWrap.appendChild(dur);
    }

    // Play overlay (shown on hover via CSS)
    const overlay = document.createElement('div');
    overlay.className = 'wln-watch-overlay';
    overlay.innerHTML =
      '<svg viewBox="0 0 24 24" width="48" height="48" fill="white"><path d="M8 5v14l11-7z"/></svg>';
    thumbWrap.appendChild(overlay);

    // Watched badge
    if (video.watched) {
      const badge = document.createElement('div');
      badge.className = 'wln-watched-badge';
      const span = document.createElement('span');
      span.textContent = '✓ Watched';
      badge.appendChild(span);
      thumbWrap.appendChild(badge);
    }

    card.appendChild(thumbWrap);

    // ── Info area ──────────────────────────────────────────────────────────
    const info = document.createElement('div');
    info.className = 'wln-card-info';

    const title = document.createElement('div');
    title.className   = 'wln-card-title';
    title.textContent = video.title || 'Untitled';
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'wln-card-meta';

    const channel = document.createElement('span');
    channel.className   = 'wln-channel';
    channel.textContent = video.channel || '';
    meta.appendChild(channel);

    info.appendChild(meta);

    // Mark watched button
    const actions = document.createElement('div');
    actions.className = 'wln-card-actions';

    const markBtn = document.createElement('button');
    markBtn.className      = 'wln-mark-btn';
    markBtn.textContent    = video.watched ? '↩ Mark Unwatched' : '✓ Mark Watched';
    markBtn.dataset.videoId = video.videoId;
    markBtn.dataset.watched = String(video.watched);
    markBtn.addEventListener('click', handleMarkClick);
    actions.appendChild(markBtn);

    info.appendChild(actions);
    card.appendChild(info);

    // ── Card click → open video in new tab ────────────────────────────────
    card.addEventListener('click', handleCardClick);

    return card;
  }

  // ─── Event handlers ────────────────────────────────────────────────────────

  function handleCardClick(e) {
    // Don't navigate if the mark-watched button was clicked
    if (e.target.closest('.wln-mark-btn')) return;
    const card    = e.currentTarget;
    const videoId = card.dataset.videoId;
    if (videoId) window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
  }

  function handleMarkClick(e) {
    e.stopPropagation();
    const btn     = e.currentTarget;
    const videoId = btn.dataset.videoId;
    const watched = btn.dataset.watched === 'true';
    if (_onMarkWatched && videoId) _onMarkWatched(videoId, !watched);
  }

  // ─── Batch renderer ────────────────────────────────────────────────────────

  function renderBatch(grid, videos, start, count) {
    const frag = document.createDocumentFragment();
    const end  = Math.min(start + count, videos.length);
    for (let i = start; i < end; i++) {
      frag.appendChild(buildCard(videos[i]));
    }
    grid.appendChild(frag);
    return end;
  }

  // ─── Infinite scroll ───────────────────────────────────────────────────────

  function setupScroll(scrollContainer) {
    if (!scrollContainer) return;
    _scrollEl = scrollContainer;

    _scrollHandler = () => {
      if (_busy || _rendered >= _videos.length) return;

      const { scrollTop, scrollHeight, clientHeight } = _scrollEl;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      if (distanceFromBottom < 800) {
        _busy     = true;
        _rendered = renderBatch(_gridEl, _videos, _rendered, BATCH_SIZE);
        _busy     = false;
      }
    };

    _scrollEl.addEventListener('scroll', _scrollHandler, { passive: true });
  }

  function teardownScroll() {
    if (_scrollEl && _scrollHandler) {
      _scrollEl.removeEventListener('scroll', _scrollHandler);
    }
    _scrollEl      = null;
    _scrollHandler = null;
    _gridEl        = null;
  }

  // ─── Empty state ───────────────────────────────────────────────────────────

  function buildEmptyState(message) {
    const wrap = document.createElement('div');
    wrap.className = 'wln-empty-state';

    const icon = document.createElement('div');
    icon.className   = 'wln-empty-icon';
    icon.textContent = '📭';

    const title = document.createElement('div');
    title.className   = 'wln-empty-title';
    title.textContent = 'No videos found';

    const sub = document.createElement('div');
    sub.className   = 'wln-empty-sub';
    sub.textContent = message || 'Try adjusting your filters or rescanning your playlist';

    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(sub);
    return wrap;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return { render, updateCard };
})();
