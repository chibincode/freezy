// Freezy — routes the toolbar click and the keyboard command to the content script.
//
// The shortcut is handled here rather than in the page, because chrome.commands fires at the
// browser level and can't be swallowed by a page that captures keyboard events.

async function toggle(tab) {
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId == null) return;
  try {
    // No frameId: every frame gets the message, so dropdowns inside iframes freeze too.
    await chrome.tabs.sendMessage(tabId, { type: 'freezy:toggle' });
  } catch {
    // No content script on this page (chrome://, the web store, a PDF viewer). Nothing to do.
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-freeze') toggle(tab);
});

chrome.action.onClicked.addListener((tab) => toggle(tab));

// Cross-origin stylesheets are fetched here, not in the content script. A content script's
// fetch runs with the page's origin and is subject to CORS, so any CDN that doesn't send
// Access-Control-Allow-Origin would silently return nothing. The service worker fetches under
// the extension's own origin, where host_permissions apply instead of CORS.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'freezy:fetch-css') {
    fetch(message.href, { credentials: 'omit' })
      .then((response) => (response.ok ? response.text() : null))
      .then((css) => sendResponse({ css }))
      .catch(() => sendResponse({ css: null }));
    return true; // keep the channel open for the async response
  }

  // The toolbar is the only place a "still frozen" signal can live permanently: it is browser
  // chrome, so it never appears in a page screenshot. The in-page toast is deliberately
  // short-lived, which would otherwise leave the user with no way to tell a frozen page from a
  // broken one.
  //
  // The badge takes TEXT and nothing else — no SVG, no image — so the snowflake has to be a
  // character. U+FE0E after it asks for the text presentation, without which some platforms
  // substitute a colour emoji and the badge stops matching the rest of the UI.
  if (message?.type === 'freezy:state') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    chrome.action.setBadgeText({ tabId, text: message.frozen ? '❄︎' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f9fe8' });
    chrome.action.setTitle({
      tabId,
      title: message.frozen ? 'Frozen — Esc or click to release' : 'Freeze hover state (⌥⇧F)',
    });
  }
});
