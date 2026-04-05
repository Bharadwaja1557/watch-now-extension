// content-script.js
// YouTube integration for Watch Later Now.
//
// Responsibilities:
//   1. Detect yt-navigate-finish events and render/teardown the Watch Now page
//   2. Inject the "Watch Now" sidebar button (🔥) below "Watch Later"
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
      injectSidebarButtonWhenReady();
    });
  }

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
    document.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);

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
    // Mount on the next animation frame so the CSS class (which hides ytd-browse
    // and therefore the chips bar) has been committed to layout before
    // page-renderer.js injects into #page-manager and reads its dimensions.
    requestAnimationFrame(() => WatchNowPage.mount());
  }

  function deactivateWatchNow() {
    document.body.classList.remove('wln-active');
    WatchNowPage.unmount();
  }

  // ─── Sidebar button injection ──────────────────────────────────────────────

  function injectSidebarButtonWhenReady() {
    if (document.getElementById('wln-sidebar-btn')) return;

    const watchLaterItem = findWatchLaterGuideItem();
    if (!watchLaterItem) {
      waitForElement('ytd-guide-entry-renderer', () => {
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
    else setTimeout(attemptSidebarInjection, 1000);
  }

  function findWatchLaterGuideItem() {
    const wlLink = document.querySelector('a[href*="playlist?list=WL"]');
    if (wlLink) {
      const entry = wlLink.closest('ytd-guide-entry-renderer');
      if (entry) return entry;
    }

    const entries = document.querySelectorAll('ytd-guide-entry-renderer');
    for (const entry of entries) {
      if (entry.textContent.includes('Watch later')) return entry;
    }

    return null;
  }

  function injectAfter(watchLaterItem) {
    if (document.getElementById('wln-sidebar-btn')) return;

    const parent = watchLaterItem.parentNode;
    if (!parent) return;

    const container = document.createElement('div');
    container.id = 'wln-sidebar-btn';

    const anchor = document.createElement('a');
    anchor.href      = WATCH_NOW_URL;
    anchor.className = 'wln-guide-anchor';

    anchor.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = WATCH_NOW_URL;
    });

    const inner = document.createElement('div');
    inner.className = 'wln-guide-inner';

    // BUG 5 FIX — use 🔥 emoji instead of SVG play icon
    const iconWrap = document.createElement('div');
    iconWrap.className   = 'wln-guide-icon';
    iconWrap.textContent = '🔥';

    const label = document.createElement('span');
    label.className   = 'wln-guide-label';
    label.textContent = 'Watch Now';

    inner.appendChild(iconWrap);
    inner.appendChild(label);
    anchor.appendChild(inner);
    container.appendChild(anchor);

    parent.insertBefore(container, watchLaterItem.nextSibling);
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
