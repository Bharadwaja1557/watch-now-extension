// watch-now/filters.js
// Pure functions for search, sort, and watch-status filtering.
// No side effects. Each function returns a new array.

window.WatchNowFilters = (() => {
  'use strict';

  // ─── Duration parser ───────────────────────────────────────────────────────

  // Converts "1:23:45" → 5025, "12:34" → 754, "0:45" → 45
  function parseDuration(str) {
    if (!str || typeof str !== 'string') return 0;
    const parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  // ─── Filter by watch status ────────────────────────────────────────────────

  function filterByWatchStatus(videos, status) {
    if (!status || status === 'all') return videos;
    if (status === 'unwatched') return videos.filter(v => !v.watched);
    if (status === 'watched')   return videos.filter(v =>  v.watched);
    return videos;
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  function search(videos, query) {
    if (!query || !query.trim()) return videos;
    const q = query.toLowerCase().trim();
    return videos.filter(v =>
      (v.title   && v.title.toLowerCase().includes(q)) ||
      (v.channel && v.channel.toLowerCase().includes(q))
    );
  }

  // ─── Sort ──────────────────────────────────────────────────────────────────

  // sortBy values:
  //   'newest'      → addedAt DESC  (playlist order — most recently added first)
  //   'oldest'      → addedAt ASC   (least recently added first)
  //   'shortest'    → duration ASC
  //   'longest'     → duration DESC
  //   'alpha'       → title A→Z
  //   'random'      → Fisher-Yates shuffle

  function sort(videos, sortBy) {
    const arr = [...videos]; // never mutate input

    switch (sortBy) {
      case 'newest':
        return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

      case 'oldest':
        return arr.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

      case 'shortest':
        return arr.sort((a, b) => parseDuration(a.duration) - parseDuration(b.duration));

      case 'longest':
        return arr.sort((a, b) => parseDuration(b.duration) - parseDuration(a.duration));

      case 'alpha':
        return arr.sort((a, b) =>
          (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
        );

      case 'random': {
        // Fisher-Yates
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      }

      default:
        return arr;
    }
  }

  // ─── Combined pipeline ─────────────────────────────────────────────────────

  // Apply all filters/sort in sequence.
  // Order: watch-status filter → search → sort
  function applyAll(videos, { watchStatus, query, sortBy }) {
    let result = filterByWatchStatus(videos, watchStatus || 'all');
    result = search(result, query || '');
    result = sort(result, sortBy || 'newest');
    return result;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    parseDuration,
    filterByWatchStatus,
    search,
    sort,
    applyAll
  };
})();
