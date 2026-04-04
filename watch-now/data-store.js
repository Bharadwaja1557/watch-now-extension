// watch-now/data-store.js
// Persistent storage for Watch Later Now.
// Stores videos keyed by videoId with watched state.
// No category system.

window.WatchNowDB = (() => {
  'use strict';

  const STORAGE_KEY = 'wln_db_v2';

  // ─── Schema ────────────────────────────────────────────────────────────────

  function emptyDB() {
    return {
      videoById: {},    // { [videoId]: VideoRecord }
      videoOrder: [],   // videoId[] in playlist order (index 0 = most recently added)
      lastScanTimestamp: null
    };
  }

  // VideoRecord shape:
  // {
  //   videoId: string
  //   title: string
  //   channel: string
  //   duration: string      e.g. "12:34" or "1:23:45"
  //   thumbnail: string     URL
  //   videoUrl: string
  //   addedAt: number       epoch ms — derived from playlist position so sort works
  //   watched: boolean
  // }

  // ─── I/O ───────────────────────────────────────────────────────────────────

  async function load() {
    return new Promise(resolve => {
      chrome.storage.local.get(STORAGE_KEY, result => {
        resolve(result[STORAGE_KEY] || emptyDB());
      });
    });
  }

  async function save(db) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [STORAGE_KEY]: db }, resolve);
    });
  }

  async function clear() {
    const db = emptyDB();
    await save(db);
    return db;
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  // Upsert a video. Preserves the watched flag if the video already exists.
  function upsertVideo(db, videoData) {
    const { videoId } = videoData;
    if (!videoId) return db;

    const existing = db.videoById[videoId];
    if (existing) {
      db.videoById[videoId] = {
        ...existing,
        ...videoData,
        watched: existing.watched // never overwrite watched flag during rescan
      };
    } else {
      db.videoById[videoId] = {
        watched: false,
        ...videoData
      };
      if (!db.videoOrder.includes(videoId)) {
        db.videoOrder.push(videoId);
      }
    }
    return db;
  }

  // Replace all videos with a fresh list (full rescan).
  // Watched flags are preserved for videos that survive the rescan.
  function replaceAll(db, videos) {
    const previousWatched = {};
    for (const [id, v] of Object.entries(db.videoById)) {
      if (v.watched) previousWatched[id] = true;
    }

    db.videoById = {};
    db.videoOrder = [];

    for (const video of videos) {
      db.videoById[video.videoId] = {
        watched: previousWatched[video.videoId] || false,
        ...video
      };
      db.videoOrder.push(video.videoId);
    }

    db.lastScanTimestamp = Date.now();
    return db;
  }

  function markWatched(db, videoId, watched) {
    if (db.videoById[videoId]) {
      db.videoById[videoId] = { ...db.videoById[videoId], watched };
    }
    return db;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  function getAllVideos(db) {
    return db.videoOrder
      .filter(id => db.videoById[id])
      .map(id => db.videoById[id]);
  }

  function getStats(db) {
    const all = getAllVideos(db);
    const watched = all.filter(v => v.watched).length;
    return { total: all.length, watched, unwatched: all.length - watched };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    load,
    save,
    clear,
    upsertVideo,
    replaceAll,
    markWatched,
    getAllVideos,
    getStats
  };
})();
