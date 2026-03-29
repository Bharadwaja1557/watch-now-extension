/**
 * background.js
 * Service worker for Watch Now extension.
 * Handles message routing between popup and content scripts.
 */

// ─── Message Listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FIND_WATCH_LATER_TAB") {
    findWatchLaterTab().then(sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === "START_SCRAPE") {
    startScrapeOnTab(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === "OPEN_VIDEO") {
    chrome.tabs.create({ url: message.url, active: true });
    sendResponse({ ok: true });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Finds the first tab whose URL matches the Watch Later playlist.
 * Returns { tabId, found } to the caller.
 */
async function findWatchLaterTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: "https://www.youtube.com/playlist?list=WL*",
    });
    if (tabs.length > 0) {
      return { found: true, tabId: tabs[0].id };
    }
    return { found: false, tabId: null };
  } catch (err) {
    console.error("[Watch Now] findWatchLaterTab error:", err);
    return { found: false, tabId: null };
  }
}

/**
 * Sends the START_SCRAPE message to the content script on the given tab.
 * Ensures the content script is injected if it hasn't run yet.
 */
async function startScrapeOnTab(tabId) {
  if (!tabId) return { ok: false, error: "No tabId provided" };

  try {
    // Inject content script defensively in case it wasn't already active.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (_) {
    // Already injected — safe to ignore this error.
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "START_SCRAPE",
    });
    return response ?? { ok: true };
  } catch (err) {
    console.error("[Watch Now] startScrapeOnTab error:", err);
    return { ok: false, error: err.message };
  }
}
