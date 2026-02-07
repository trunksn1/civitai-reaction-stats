/**
 * Civitai Reaction Stats - Popup Script
 * Handles settings configuration and status display
 */

const gistUrlInput = document.getElementById('gistUrl');
const saveBtn = document.getElementById('saveBtn');
const openStatsBtn = document.getElementById('openStatsBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const messageEl = document.getElementById('message');

/**
 * Initialize popup
 */
async function init() {
  // Load current settings
  const response = await chrome.runtime.sendMessage({ action: 'getSettings' });

  if (response.success) {
    gistUrlInput.value = response.settings.gistUrl || '';
    updateStatusIndicator(!!response.settings.gistUrl);
  }
}

/**
 * Update the status indicator
 */
function updateStatusIndicator(isConfigured) {
  statusIndicator.className = 'status-indicator ' + (isConfigured ? 'configured' : 'not-configured');
  statusText.textContent = isConfigured ? 'Configured' : 'Not configured';
}

/**
 * Show a message
 */
function showMessage(text, type = 'success') {
  messageEl.textContent = text;
  messageEl.className = 'message ' + type;

  // Auto-hide after 3 seconds
  setTimeout(() => {
    messageEl.className = 'message';
  }, 3000);
}

/**
 * Validate Gist URL format
 */
function isValidGistUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return parsed.hostname === 'gist.githubusercontent.com' ||
           parsed.hostname === 'gist.github.com';
  } catch {
    return false;
  }
}

/**
 * Save settings
 */
async function saveSettings() {
  const gistUrl = gistUrlInput.value.trim();

  if (gistUrl && !isValidGistUrl(gistUrl)) {
    showMessage('Please enter a valid Gist URL', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveSettings',
      settings: { gistUrl }
    });

    if (response.success) {
      showMessage('Settings saved!', 'success');
      updateStatusIndicator(!!gistUrl);
    } else {
      showMessage('Failed to save: ' + response.error, 'error');
    }
  } catch (error) {
    showMessage('Error: ' + error.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

/**
 * Open stats page
 */
async function openStats() {
  const gistUrl = gistUrlInput.value.trim();

  if (!gistUrl) {
    showMessage('Please configure a Gist URL first', 'error');
    return;
  }

  await chrome.runtime.sendMessage({ action: 'openStatsPage' });
  window.close();
}

// Event listeners
saveBtn.addEventListener('click', saveSettings);
openStatsBtn.addEventListener('click', openStats);

// Allow Enter to save
gistUrlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    saveSettings();
  }
});

// Initialize
init();
