// content-script.js
// YouTube integration for Watch Later Now.
//
// Responsibilities:
//   1. Detect yt-navigate-finish events and render/teardown the Watch Now page
//   2. Inject the "Watch Now" sidebar button below "Watch Later"
//   3. Keep YouTube's native sidebar and header completely intact

(function () {
  'use strict';

  const WATCH_NOW_PARAM = 'app=watch-now';
  const WATCH_NOW_URL   = 'https://www.youtube.com/?app=watch-now';

  let isWatchNowActive = false;

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    waitForElement('ytd-app', () => {
      setupNavigationListener();
      checkAndActivate();

      // Inject sidebar button after YouTube's guide has rendered
      injectSidebarButtonWhenReady();
    });
  }

  // Poll until selector appears, then call callback.
  function waitForElement(selector, callback, maxMs = 15000) {
    const el = document.querySelector(selector);
    if (el) { callback(el); return; }

    const started = Date.now();
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found || Date.now() - started > maxMs) {
        obs.disconnect();
        if (found) callback(found);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  function setupNavigationListener() {
    // YouTube's primary SPA navigation event
    document.addEventListener('yt-navigate-finish', onNavigate);
    // Fallback for popstate / hashchange
    window.addEventListener('popstate', onNavigate);

    // URL-polling fallback (some YouTube navigations don't fire the above)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
      }
    }, 400);
  }

  function onNavigate() {
    const nowOnPage = isWatchNowPage();

    if (nowOnPage && !isWatchNowActive) {
      isWatchNowActive = true;
      activateWatchNow();
    } else if (!nowOnPage && isWatchNowActive) {
      isWatchNowActive = false;
      deactivateWatchNow();
    }

    // Re-inject sidebar button after YouTube re-renders its guide
    setTimeout(injectSidebarButtonWhenReady, 800);
  }

  function isWatchNowPage() {
    return location.search.includes(WATCH_NOW_PARAM);
  }

  function checkAndActivate() {
    if (isWatchNowPage()) {
      isWatchNowActive = true;
      activateWatchNow();
    }
  }

  // ─── Watch Now page activation ─────────────────────────────────────────────

  function activateWatchNow() {
    document.body.classList.add('wln-active');
    WatchNowPage.mount();
  }

  function deactivateWatchNow() {
    document.body.classList.remove('wln-active');
    WatchNowPage.unmount();
  }

  // ─── Sidebar button injection ──────────────────────────────────────────────

  // Try to inject the sidebar button; if the guide isn't rendered yet, retry.
  function injectSidebarButtonWhenReady() {
    if (document.getElementById('wln-sidebar-btn')) return; // already injected

    const watchLaterItem = findWatchLaterGuideItem();
    if (!watchLaterItem) {
      // Guide not rendered yet — wait for it
      waitForElement('ytd-guide-entry-renderer', () => {
        // Give YouTube a moment to finish rendering the full list
        setTimeout(attemptSidebarInjection, 300);
      }, 8000);
      return;
    }

    injectAfter(watchLaterItem);
  }

  function attemptSidebarInjection() {
    if (document.getElementById('wln-sidebar-btn')) return;
    const item = findWatchLaterGuideItem();
    if (item) injectAfter(item);
    else setTimeout(attemptSidebarInjection, 1000); // keep retrying
  }

  // Find the ytd-guide-entry-renderer that corresponds to "Watch Later".
  function findWatchLaterGuideItem() {
    // Strategy 1: find via the WL playlist link
    const wlLink = document.querySelector('a[href*="playlist?list=WL"]');
    if (wlLink) {
      const entry = wlLink.closest('ytd-guide-entry-renderer');
      if (entry) return entry;
    }

    // Strategy 2: scan guide entry text content
    const entries = document.querySelectorAll('ytd-guide-entry-renderer');
    for (const entry of entries) {
      if (entry.textContent.includes('Watch later')) return entry;
    }

    return null;
  }

  // Build and insert the "Watch Now" sidebar entry directly after watchLaterItem.
  function injectAfter(watchLaterItem) {
    if (document.getElementById('wln-sidebar-btn')) return;

    const parent = watchLaterItem.parentNode;
    if (!parent) return;

    // Build a <div> that mimics ytd-guide-entry-renderer visually
    const container = document.createElement('div');
    container.id = 'wln-sidebar-btn';

    // Anchor — clicking navigates to the Watch Now page
    const anchor = document.createElement('a');
    anchor.href      = WATCH_NOW_URL;
    anchor.className = 'wln-guide-anchor';

    // Prevent YouTube's router from intercepting the click on a custom element
    anchor.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = WATCH_NOW_URL;
    });

    // Inner layout: icon + label (mirrors YouTube's guide entry structure)
    const inner = document.createElement('div');
    inner.className = 'wln-guide-inner';

    // Play icon (matching YouTube's 24×24 icon size in the guide)
    const iconWrap = document.createElement('div');
    iconWrap.className = 'wln-guide-icon';
    iconWrap.innerHTML =
      '<svg viewBox="0 0 24 24" width="24" height="24" focusable="false">' +
        '<path fill="currentColor" d="M8 5v14l11-7z"/>' +
      '</svg>';

    const label = document.createElement('span');
    label.className   = 'wln-guide-label';
    label.textContent = 'Watch Now';

    inner.appendChild(iconWrap);
    inner.appendChild(label);
    anchor.appendChild(inner);
    container.appendChild(anchor);

    // Insert directly after the Watch Later item
    parent.insertBefore(container, watchLaterItem.nextSibling);
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
