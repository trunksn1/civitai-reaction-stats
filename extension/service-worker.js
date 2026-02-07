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
    chrome.storage.sync.get(['gistUrl'], (result) => {
      resolve({
        gistUrl: result.gistUrl || ''
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

// Log when service worker starts
console.log('Civitai Reaction Stats service worker initialized');
