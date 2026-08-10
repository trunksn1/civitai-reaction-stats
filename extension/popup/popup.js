/**
 * Civitai Reaction Stats - Popup Script
 * Configures the Gist and the independent Civitai OAuth connection.
 */

const gistUrlInput = document.getElementById('gistUrl');
const oauthClientIdInput = document.getElementById('oauthClientId');
const oauthRedirectUriInput = document.getElementById('oauthRedirectUri');
const saveBtn = document.getElementById('saveBtn');
const openStatsBtn = document.getElementById('openStatsBtn');
const connectOAuthBtn = document.getElementById('connectOAuthBtn');
const disconnectOAuthBtn = document.getElementById('disconnectOAuthBtn');
const copyRedirectBtn = document.getElementById('copyRedirectBtn');
const gistStatusIndicator = document.getElementById('gistStatusIndicator');
const gistStatusText = document.getElementById('gistStatusText');
const oauthStatusIndicator = document.getElementById('oauthStatusIndicator');
const oauthStatusText = document.getElementById('oauthStatusText');
const messageEl = document.getElementById('message');

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (!response.success) throw new Error(response.error || 'Settings could not be loaded.');
    gistUrlInput.value = response.settings.gistUrl || '';
    oauthClientIdInput.value = response.settings.oauthClientId || '';
    oauthRedirectUriInput.value = response.settings.oauthRedirectUri || '';
    updateGistStatus(Boolean(response.settings.gistUrl));
    updateOAuthStatus(response.settings.oauthStatus);
  } catch (error) {
    showMessage(error.message, 'error', 0);
    updateGistStatus(false);
    updateOAuthStatus({ connected: false });
  }
}

function updateGistStatus(isConfigured) {
  gistStatusIndicator.className = `status-indicator ${isConfigured ? 'configured' : 'not-configured'}`;
  gistStatusText.textContent = isConfigured ? 'Stats Gist configured' : 'Stats Gist not configured';
}

function updateOAuthStatus(status, warning = null) {
  const connected = Boolean(status?.connected);
  oauthStatusIndicator.className = `status-indicator ${warning ? 'warning' : connected ? 'configured' : 'not-configured'}`;
  oauthStatusText.textContent = warning
    ? 'Connected, but API check needs attention'
    : connected
      ? `Connected${status.username ? ` as ${status.username}` : ''}`
      : 'Civitai OAuth not connected';
  connectOAuthBtn.textContent = connected ? 'Reconnect Civitai' : 'Connect Civitai';
  disconnectOAuthBtn.disabled = !connected;
}

function showMessage(text, type = 'success', timeout = 5000) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  if (timeout) {
    setTimeout(() => {
      messageEl.className = 'message';
    }, timeout);
  }
}

function isValidGistUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'gist.githubusercontent.com';
  } catch {
    return false;
  }
}

async function saveSettings() {
  const gistUrl = gistUrlInput.value.trim();
  const oauthClientId = oauthClientIdInput.value.trim();
  if (gistUrl && !isValidGistUrl(gistUrl)) {
    showMessage('Enter the raw gist.githubusercontent.com stats.json URL.', 'error');
    return false;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveSettings', settings: { gistUrl, oauthClientId }
    });
    if (!response.success) throw new Error(response.error || 'Settings could not be saved.');
    updateGistStatus(Boolean(gistUrl));
    const latest = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (latest.success) updateOAuthStatus(latest.settings.oauthStatus);
    showMessage('Settings saved.');
    return true;
  } catch (error) {
    showMessage(`Failed to save: ${error.message}`, 'error');
    return false;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save settings';
  }
}

async function connectOAuth() {
  const clientId = oauthClientIdInput.value.trim();
  if (!clientId) {
    showMessage('Enter the public Civitai OAuth client ID first.', 'error');
    return;
  }

  connectOAuthBtn.disabled = true;
  connectOAuthBtn.textContent = 'Connecting...';
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'connectCivitaiOAuth', clientId
    });
    if (!response.success) throw new Error(response.error || 'Civitai OAuth connection failed.');
    updateOAuthStatus(response.status, response.warning);
    showMessage(response.warning || 'Civitai OAuth connected.', response.warning ? 'warning' : 'success', response.warning ? 0 : 5000);
  } catch (error) {
    showMessage(`Civitai connection failed: ${error.message}`, 'error', 0);
  } finally {
    connectOAuthBtn.disabled = false;
    if (connectOAuthBtn.textContent === 'Connecting...') connectOAuthBtn.textContent = 'Connect Civitai';
  }
}

async function disconnectOAuth() {
  disconnectOAuthBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'disconnectCivitaiOAuth' });
    if (!response.success) throw new Error(response.error || 'Could not disconnect Civitai OAuth.');
    updateOAuthStatus(response.status);
    showMessage('Local OAuth tokens removed. Revoke the grant in Civitai settings if desired.');
  } catch (error) {
    showMessage(`Disconnect failed: ${error.message}`, 'error', 0);
  } finally {
    disconnectOAuthBtn.disabled = !(
      oauthStatusIndicator.classList.contains('configured') || oauthStatusIndicator.classList.contains('warning')
    );
  }
}

async function copyRedirectUri() {
  try {
    await navigator.clipboard.writeText(oauthRedirectUriInput.value);
    showMessage('Redirect URL copied.');
  } catch {
    oauthRedirectUriInput.select();
    showMessage('Copy was blocked; the redirect URL is selected.', 'error');
  }
}

async function openStats() {
  if (!gistUrlInput.value.trim()) {
    showMessage('Configure a Gist URL first.', 'error');
    return;
  }
  await chrome.runtime.sendMessage({ action: 'openStatsPage' });
  window.close();
}

saveBtn.addEventListener('click', saveSettings);
openStatsBtn.addEventListener('click', openStats);
connectOAuthBtn.addEventListener('click', connectOAuth);
disconnectOAuthBtn.addEventListener('click', disconnectOAuth);
copyRedirectBtn.addEventListener('click', copyRedirectUri);
gistUrlInput.addEventListener('keypress', event => {
  if (event.key === 'Enter') saveSettings();
});
oauthClientIdInput.addEventListener('keypress', event => {
  if (event.key === 'Enter') connectOAuth();
});

init();
