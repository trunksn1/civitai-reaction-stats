/**
 * Civitai Reaction Stats - Service Worker
 * Handles Gist reads, OAuth/PKCE, token rotation, and direct Civitai title writes.
 */

importScripts('lib/civitai-oauth.js');

const OAUTH_SESSION_KEY = 'civitaiOAuthSession';
const OAUTH_CLIENT_SETTING = 'civitaiOAuthClientId';
const OAUTH_RULE_IDS = { 'civitai.com': 9701, 'civitai.red': 9702 };
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

let oauthRefreshPromise = null;
let titleWriteQueue = Promise.resolve();
let trpcRequestQueue = Promise.resolve();

protectLocalStorage();
const oauthRuleCleanupPromise = removeOAuthHeaderRules()
  .catch(error => console.warn('Could not clear stale OAuth header rules:', error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'openStatsPage':
      openStatsPage();
      sendResponse({ success: true });
      break;

    case 'fetchGistData':
      respondAsync(fetchGistData(), sendResponse, data => ({ success: true, data }));
      return true;

    case 'getSettings':
      respondAsync(getSettings(), sendResponse, settings => ({ success: true, settings }));
      return true;

    case 'saveSettings':
      respondAsync(saveSettings(message.settings), sendResponse, () => ({ success: true }));
      return true;

    case 'connectCivitaiOAuth':
      respondAsync(connectCivitaiOAuth(message.clientId), sendResponse, result => ({ success: true, ...result }));
      return true;

    case 'disconnectCivitaiOAuth':
      respondAsync(disconnectCivitaiOAuth(), sendResponse, status => ({ success: true, status }));
      return true;

    case 'updateCivitaiPostTitle':
      respondAsync(queueTitleWrite(message), sendResponse, result => ({ success: true, ...result }));
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
});

function respondAsync(promise, sendResponse, onSuccess) {
  promise
    .then(value => sendResponse(onSuccess(value)))
    .catch(error => sendResponse({ success: false, error: error.message }));
}

function protectLocalStorage() {
  if (typeof chrome.storage.local.setAccessLevel !== 'function') return;
  Promise.resolve(chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .catch(error => console.warn('Could not restrict local storage access:', error));
}

function storageGet(area, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].get(keys, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function storageSet(area, values) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].set(values, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function storageRemove(area, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function openStatsPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('stats-page/stats.html') });
}

async function fetchGistData() {
  const settings = await getSettings();
  if (!settings.gistUrl) {
    throw new Error('Gist URL not configured. Please set it in the extension popup.');
  }

  const url = new URL(settings.gistUrl);
  url.searchParams.set('_t', Date.now());
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Failed to fetch Gist: ${response.status} ${response.statusText}`);
  return response.json();
}

async function getSettings() {
  const result = await storageGet('sync', ['gistUrl', 'chartColors', OAUTH_CLIENT_SETTING]);
  return {
    gistUrl: result.gistUrl || '',
    chartColors: result.chartColors || null,
    oauthClientId: result[OAUTH_CLIENT_SETTING] || '',
    oauthRedirectUri: chrome.identity.getRedirectURL('oauth2'),
    oauthStatus: await getOAuthStatus()
  };
}

async function saveSettings(settings) {
  const safe = {};
  if (Object.hasOwn(settings || {}, 'gistUrl')) safe.gistUrl = String(settings.gistUrl || '').trim();
  if (Object.hasOwn(settings || {}, 'chartColors')) safe.chartColors = settings.chartColors || null;
  if (Object.hasOwn(settings || {}, 'oauthClientId')) {
    const clientId = String(settings.oauthClientId || '').trim();
    if (clientId.length > 500) throw new Error('The OAuth client ID is too long.');
    const current = await storageGet('sync', [OAUTH_CLIENT_SETTING]);
    safe[OAUTH_CLIENT_SETTING] = clientId;
    if ((current[OAUTH_CLIENT_SETTING] || '') !== clientId) {
      await storageRemove('local', OAUTH_SESSION_KEY);
    }
  }
  if (Object.keys(safe).length) await storageSet('sync', safe);
}

function displayIdentity(identity) {
  return identity?.username || identity?.preferred_username || identity?.name || null;
}

async function getOAuthStatus() {
  const result = await storageGet('local', OAUTH_SESSION_KEY);
  const session = result[OAUTH_SESSION_KEY];
  const connected = Boolean(
    session?.accessToken && session?.refreshToken && CivitaiOAuth.hasRequiredScope(session?.scope)
  );
  return {
    connected,
    username: connected ? displayIdentity(session.identity) : null,
    expiresAt: connected ? session.expiresAt : null,
    scope: connected ? session.scope : null
  };
}

function launchWebAuthFlow(details) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(details, redirectUrl => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!redirectUrl) reject(new Error('Civitai did not return an OAuth redirect.'));
      else resolve(redirectUrl);
    });
  });
}

async function connectCivitaiOAuth(rawClientId) {
  const clientId = String(rawClientId || '').trim();
  if (!clientId) throw new Error('Enter the public Civitai OAuth client ID first.');
  if (clientId.length > 500) throw new Error('The OAuth client ID is too long.');

  await saveSettings({ oauthClientId: clientId });
  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  const verifier = CivitaiOAuth.randomBase64Url(crypto, 32);
  const state = CivitaiOAuth.randomBase64Url(crypto, 24);
  const challenge = await CivitaiOAuth.pkceChallenge(verifier, crypto);
  const authUrl = CivitaiOAuth.buildAuthorizationUrl({ clientId, redirectUri, state, challenge });
  const redirect = new URL(await launchWebAuthFlow({ url: authUrl, interactive: true }));
  const expectedRedirect = new URL(redirectUri);

  if (redirect.origin !== expectedRedirect.origin || redirect.pathname !== expectedRedirect.pathname) {
    throw new Error('Civitai returned to an unexpected OAuth redirect URL.');
  }

  if (redirect.searchParams.get('state') !== state) {
    throw new Error('OAuth state mismatch. The Civitai connection was canceled for safety.');
  }
  if (redirect.searchParams.has('error')) {
    throw new Error(redirect.searchParams.get('error_description') || redirect.searchParams.get('error'));
  }
  const code = redirect.searchParams.get('code');
  if (!code) throw new Error('Civitai did not return an authorization code.');

  const tokens = await exchangeToken(CivitaiOAuth.buildTokenBody({
    grantType: 'authorization_code', clientId, code, redirectUri, verifier
  }));
  let identity;
  try {
    identity = await fetchUserInfo(tokens.accessToken);
  } catch (error) {
    // A completed exchange must never leave an older account looking connected
    // when the identity belonging to the replacement token cannot be verified.
    await storageRemove('local', OAUTH_SESSION_KEY);
    throw error;
  }
  const session = { ...tokens, identity, connectedAt: new Date().toISOString() };
  await storageSet('local', { [OAUTH_SESSION_KEY]: session });

  let warning = null;
  const username = identity?.username || identity?.preferred_username;
  if (username) {
    try {
      await oauthTrpcRequest('civitai.com', 'user.getCreator', 'GET', { username });
    } catch (error) {
      warning = `OAuth connected, but the Civitai API check failed: ${error.message}`;
    }
  }

  return { status: await getOAuthStatus(), warning };
}

async function disconnectCivitaiOAuth() {
  await storageRemove('local', OAUTH_SESSION_KEY);
  await removeOAuthHeaderRules();
  return getOAuthStatus();
}

async function exchangeToken(formBody) {
  const response = await fetch(CivitaiOAuth.TOKEN_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error_description || body?.error || `OAuth token request failed (HTTP ${response.status}).`);
  }
  return CivitaiOAuth.normalizeTokenResponse(body);
}

async function fetchUserInfo(accessToken) {
  const response = await fetch(CivitaiOAuth.USERINFO_URL, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error(body?.error_description || body?.error || `OAuth user-info request failed (HTTP ${response.status}).`);
  }
  return body;
}

async function getValidOAuthSession(forceRefresh = false) {
  const stored = await storageGet('local', OAUTH_SESSION_KEY);
  const session = stored[OAUTH_SESSION_KEY];
  if (!session?.accessToken || !session?.refreshToken) {
    throw new Error('Connect this extension to Civitai with OAuth from its popup first.');
  }
  if (!CivitaiOAuth.hasRequiredScope(session.scope)) {
    await storageRemove('local', OAUTH_SESSION_KEY);
    throw new Error('The saved Civitai authorization lacks the required permissions. Connect again.');
  }
  if (!forceRefresh && Number(session.expiresAt) > Date.now() + TOKEN_EXPIRY_BUFFER_MS) return session;
  return refreshOAuthSession();
}

async function refreshOAuthSession() {
  if (oauthRefreshPromise) return oauthRefreshPromise;
  oauthRefreshPromise = performOAuthRefresh().finally(() => { oauthRefreshPromise = null; });
  return oauthRefreshPromise;
}

async function performOAuthRefresh() {
  const [stored, settings] = await Promise.all([
    storageGet('local', OAUTH_SESSION_KEY),
    storageGet('sync', [OAUTH_CLIENT_SETTING])
  ]);
  const previous = stored[OAUTH_SESSION_KEY];
  const clientId = settings[OAUTH_CLIENT_SETTING];
  if (!previous?.refreshToken || !clientId) {
    await storageRemove('local', OAUTH_SESSION_KEY);
    throw new Error('The saved Civitai authorization is incomplete. Connect again.');
  }

  let response;
  try {
    response = await fetch(CivitaiOAuth.TOKEN_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: CivitaiOAuth.buildTokenBody({
        grantType: 'refresh_token', clientId, refreshToken: previous.refreshToken
      })
    });
  } catch (error) {
    throw new Error(`Civitai token refresh could not connect: ${error.message}`);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) await storageRemove('local', OAUTH_SESSION_KEY);
    throw new Error(body?.error_description || body?.error || `OAuth refresh failed (HTTP ${response.status}).`);
  }
  const tokens = CivitaiOAuth.normalizeTokenResponse(body, Date.now(), previous.scope);
  const next = { ...previous, ...tokens };

  // Civitai rotates refresh tokens. Persist the replacement before returning it
  // to any waiting caller so two title operations cannot invalidate each other.
  await storageSet('local', { [OAUTH_SESSION_KEY]: next });
  return next;
}

async function removeOAuthHeaderRules() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: Object.values(OAUTH_RULE_IDS)
  });
}

async function withOAuthHeaderRule(hostname, operation) {
  await oauthRuleCleanupPromise;
  const id = OAUTH_RULE_IDS[hostname];
  if (!id) throw new Error('Unsupported Civitai host.');
  const rule = CivitaiOAuth.buildHeaderRule({ id, hostname, extensionId: chrome.runtime.id });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
  try {
    return await operation();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  }
}

async function oauthTrpcRequest(hostname, procedure, method, input) {
  const run = () => performOAuthTrpcRequest(hostname, procedure, method, input);
  const result = trpcRequestQueue.then(run, run);
  trpcRequestQueue = result.catch(() => undefined);
  return result;
}

async function performOAuthTrpcRequest(hostname, procedure, method, input) {
  return withOAuthHeaderRule(hostname, async () => {
    let session = await getValidOAuthSession();
    let result = await fetchTrpcOnce(hostname, procedure, method, input, session.accessToken);
    if (result.response.status === 401) {
      session = await getValidOAuthSession(true);
      result = await fetchTrpcOnce(hostname, procedure, method, input, session.accessToken);
    }
    if (!result.response.ok) {
      const message = result.body?.error?.json?.message || result.body?.error?.message;
      throw new Error(message || `Civitai ${procedure} failed (HTTP ${result.response.status}).`);
    }
    return CivitaiOAuth.trpcPayload(result.body);
  });
}

async function fetchTrpcOnce(hostname, procedure, method, input, accessToken) {
  const url = new URL(`https://${hostname}/api/trpc/${procedure}`);
  url.searchParams.set('crs_oauth', '1');
  const options = {
    method,
    cache: 'no-store',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  };
  if (method === 'GET') {
    url.searchParams.set('input', JSON.stringify({ json: input }));
  } else {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ json: input });
  }
  const response = await fetch(url.toString(), options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function queueTitleWrite(message) {
  const run = () => updateCivitaiPostTitle(message);
  const result = titleWriteQueue.then(run, run);
  titleWriteQueue = result.catch(() => undefined);
  return result;
}

/**
 * Change one public Civitai post title using the extension's OAuth grant.
 * The authoritative pre-read detects stale dashboard data; the post-write
 * re-read prevents an accepted-but-ignored mutation from looking successful.
 */
async function updateCivitaiPostTitle(message) {
  const postId = Number(message.postId);
  const hostname = message.host === 'red' ? 'civitai.red' : 'civitai.com';
  const title = String(message.title || '').trim();
  const expectedPreviousTitle = message.expectedPreviousTitle == null
    ? null
    : String(message.expectedPreviousTitle);

  if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error('Invalid Civitai post id.');
  if (!title) {
    throw new Error('Civitai currently cannot reliably clear a public post title. Enter a title or uncheck the public-title option.');
  }
  if (title.length > 200) throw new Error('The post title is too long.');

  const before = await oauthTrpcRequest(hostname, 'post.get', 'GET', { id: postId });
  const currentTitle = typeof before?.title === 'string' && before.title ? before.title : null;
  if (currentTitle !== expectedPreviousTitle) {
    return { conflict: true, currentTitle, previousTitle: currentTitle, title: currentTitle };
  }

  await oauthTrpcRequest(hostname, 'post.update', 'POST', { id: postId, title });
  const after = await oauthTrpcRequest(hostname, 'post.get', 'GET', { id: postId });
  const verifiedTitle = typeof after?.title === 'string' && after.title ? after.title : null;
  if (verifiedTitle !== title) {
    throw new Error('Civitai responded, but the title could not be verified after the update.');
  }
  return {
    conflict: false,
    previousTitle: currentTitle,
    title: verifiedTitle,
    undoAvailable: currentTitle !== null
  };
}

console.log('Civitai Reaction Stats service worker initialized');
