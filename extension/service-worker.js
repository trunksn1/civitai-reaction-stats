/**
 * Civitai Reaction Stats - Service Worker
 * Handles background tasks, message routing, and cross-origin fetches
 */

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'openStatsPage':
      openStatsPage();
      sendResponse({ success: true });
      break;

    case 'fetchGistData':
      fetchGistData()
        .then(data => sendResponse({ success: true, data }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response

    case 'getSettings':
      getSettings()
        .then(settings => sendResponse({ success: true, settings }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'saveSettings':
      saveSettings(message.settings)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    case 'updateCivitaiPostTitle':
      updateCivitaiPostTitle(message)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
});

/**
 * Open the stats page in a new tab
 */
function openStatsPage() {
  const statsUrl = chrome.runtime.getURL('stats-page/stats.html');
  chrome.tabs.create({ url: statsUrl });
}

/**
 * Fetch data from the configured Gist
 */
async function fetchGistData() {
  const settings = await getSettings();

  if (!settings.gistUrl) {
    throw new Error('Gist URL not configured. Please set it in the extension popup.');
  }

  // Add cache-busting parameter to get fresh data
  const url = new URL(settings.gistUrl);
  url.searchParams.set('_t', Date.now());

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Failed to fetch Gist: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Get settings from storage
 */
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['gistUrl', 'chartColors'], (result) => {
      resolve({
        gistUrl: result.gistUrl || '',
        chartColors: result.chartColors || null
      });
    });
  });
}

/**
 * Save settings to storage
 */
async function saveSettings(settings) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Change one public Civitai post title through an already signed-in Civitai
 * tab. The extension never receives or stores session cookies. The page makes
 * the same-origin request, first checks the authoritative current title, then
 * re-reads it after the mutation so a successful response cannot be mistaken
 * for a successful update.
 */
async function updateCivitaiPostTitle(message) {
  const postId = Number(message.postId);
  const host = message.host === 'red' ? 'civitai.red' : 'civitai.com';
  const title = message.title == null || message.title === '' ? null : String(message.title).trim();
  const expectedPreviousTitle = message.expectedPreviousTitle == null
    ? null
    : String(message.expectedPreviousTitle);

  if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error('Invalid Civitai post id.');
  if (title != null && title.length > 200) throw new Error('The post title is too long.');

  const tabs = await chrome.tabs.query({ url: [`https://${host}/*`] });
  const tab = tabs.find(item => item.active) || tabs[0];
  if (!tab?.id) {
    throw new Error(`Open ${host} in a signed-in tab, then try again.`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [postId, title, expectedPreviousTitle],
    func: async (targetPostId, nextTitle, expectedTitle) => {
      function decodeReferenceTable(table) {
        if (!Array.isArray(table) || !table.length) return table;
        const decoded = new Map();
        function decode(index) {
          if (!Number.isInteger(index)) return index;
          if (index < 0) return null;
          if (index >= table.length) throw new Error('Civitai returned an invalid reference table.');
          if (decoded.has(index)) return decoded.get(index);
          const value = table[index];
          if (Array.isArray(value)) {
            const result = [];
            decoded.set(index, result);
            for (const item of value) result.push(Number.isInteger(item) ? decode(item) : item);
            return result;
          }
          if (value && typeof value === 'object') {
            const result = {};
            decoded.set(index, result);
            for (const [key, item] of Object.entries(value)) {
              result[key] = Number.isInteger(item) ? decode(item) : item;
            }
            return result;
          }
          decoded.set(index, value);
          return value;
        }
        return decode(0);
      }

      function payload(body) {
        if (Array.isArray(body) && body.length === 1) return payload(body[0]);
        if (body?.error) throw new Error(body.error?.json?.message || body.error?.message || 'Civitai rejected the request.');
        const data = body?.result?.data;
        if (typeof data === 'string') {
          const parsed = JSON.parse(data);
          return Array.isArray(parsed) ? decodeReferenceTable(parsed) : parsed;
        }
        return data && typeof data === 'object' && 'json' in data ? data.json : data;
      }

      async function trpcGet() {
        const input = encodeURIComponent(JSON.stringify({ json: { id: targetPostId } }));
        const response = await fetch(`/api/trpc/post.get?input=${input}&_t=${Date.now()}`, {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error?.json?.message || `Civitai post read failed (HTTP ${response.status}).`);
        }
        return payload(body);
      }

      const before = await trpcGet();
      const currentTitle = before?.title || null;
      if (currentTitle !== expectedTitle) {
        return { conflict: true, currentTitle, previousTitle: currentTitle, title: currentTitle };
      }

      const response = await fetch('/api/trpc/post.update', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ json: { id: targetPostId, title: nextTitle } })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.json?.message || `Civitai title update failed (HTTP ${response.status}).`);
      }
      payload(body);

      const after = await trpcGet();
      const verifiedTitle = after?.title || null;
      if (verifiedTitle !== nextTitle) {
        throw new Error('Civitai responded, but the title could not be verified after the update.');
      }
      return { conflict: false, previousTitle: currentTitle, title: verifiedTitle };
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('The signed-in Civitai tab did not return an update result.');
  return result;
}

// Log when service worker starts
console.log('Civitai Reaction Stats service worker initialized');
