// background.js — Watch Later Now service worker
// Kept minimal. All logic runs in the content script.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[WatchLaterNow] Extension installed / updated.');
});
