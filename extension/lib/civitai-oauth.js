/**
 * Pure helpers for Civitai OAuth/PKCE and its tRPC wire format.
 *
 * This file intentionally has no Chrome API calls so the security-sensitive
 * URL, scope, token, and header-rule behavior can be unit tested in Node.
 */
(function exposeCivitaiOAuth(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CivitaiOAuth = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCivitaiOAuth() {
  'use strict';

  const AUTHORIZE_URL = 'https://auth.civitai.com/api/auth/oauth/authorize';
  const TOKEN_URL = 'https://auth.civitai.com/api/auth/oauth/token';
  const USERINFO_URL = 'https://auth.civitai.com/api/auth/oauth/userinfo';
  const REQUIRED_SCOPE = 1 | 32 | 64; // identity read + media read + media write
  const OAUTH_MARKER = 'crs_oauth=1';

  function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function randomBase64Url(cryptoApi, byteCount = 32) {
    const bytes = new Uint8Array(byteCount);
    cryptoApi.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function pkceChallenge(verifier, cryptoApi) {
    const bytes = new TextEncoder().encode(verifier);
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return base64Url(new Uint8Array(digest));
  }

  function buildAuthorizationUrl({ clientId, redirectUri, state, challenge }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', String(REQUIRED_SCOPE));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  function buildTokenBody(values) {
    const body = new URLSearchParams();
    body.set('grant_type', values.grantType);
    body.set('client_id', values.clientId);
    if (values.grantType === 'authorization_code') {
      body.set('code', values.code);
      body.set('redirect_uri', values.redirectUri);
      body.set('code_verifier', values.verifier);
    } else if (values.grantType === 'refresh_token') {
      body.set('refresh_token', values.refreshToken);
    } else {
      throw new Error('Unsupported OAuth grant type.');
    }
    return body.toString();
  }

  function parseScope(value) {
    if (Array.isArray(value) && value.length === 1) return parseScope(value[0]);
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    return null;
  }

  function hasRequiredScope(scope) {
    const parsed = parseScope(scope);
    return parsed !== null && (parsed & REQUIRED_SCOPE) === REQUIRED_SCOPE;
  }

  function normalizeTokenResponse(body, now = Date.now(), fallbackScope = null) {
    if (!body || typeof body !== 'object') throw new Error('Civitai returned an invalid token response.');
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('Civitai did not return an access token.');
    }
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
      throw new Error('Civitai did not return the required rotated refresh token.');
    }
    const expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Civitai returned an invalid access-token lifetime.');
    }
    const scope = parseScope(body.scope) ?? parseScope(fallbackScope);
    if (!hasRequiredScope(scope)) {
      throw new Error(`Civitai did not grant the required OAuth permissions (granted scope: ${scope ?? 'unknown'}).`);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      tokenType: typeof body.token_type === 'string' && body.token_type ? body.token_type : 'Bearer',
      scope,
      expiresAt: now + Math.floor(expiresIn * 1000)
    };
  }

  /**
   * Civitai's tRPC auth currently rejects a bearer token unless Origin and
   * Referer match the target host. Chrome JavaScript cannot set those forbidden
   * headers, so the service worker installs this tightly scoped session rule
   * only while it performs a marked request.
   */
  function buildHeaderRule({ id, hostname, extensionId }) {
    if (!['civitai.com', 'civitai.red'].includes(hostname)) throw new Error('Unsupported Civitai host.');
    const escapedHostname = hostname.replace(/\./g, '\\.');
    return {
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: `https://${hostname}` },
          { header: 'Referer', operation: 'set', value: `https://${hostname}/` }
        ]
      },
      condition: {
        regexFilter: `^https://${escapedHostname}/api/trpc/(post\\.get|post\\.update|user\\.getCreator)\\?${OAUTH_MARKER}(&.*)?$`,
        requestDomains: [hostname],
        initiatorDomains: [extensionId],
        resourceTypes: ['xmlhttprequest']
      }
    };
  }

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

  function trpcPayload(body) {
    if (Array.isArray(body) && body.length === 1) return trpcPayload(body[0]);
    if (body?.error) {
      throw new Error(body.error?.json?.message || body.error?.message || 'Civitai rejected the request.');
    }
    const data = body?.result?.data;
    if (typeof data === 'string') {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? decodeReferenceTable(parsed) : parsed;
    }
    return data && typeof data === 'object' && 'json' in data ? data.json : data;
  }

  return {
    AUTHORIZE_URL,
    TOKEN_URL,
    USERINFO_URL,
    REQUIRED_SCOPE,
    OAUTH_MARKER,
    base64Url,
    randomBase64Url,
    pkceChallenge,
    buildAuthorizationUrl,
    buildTokenBody,
    parseScope,
    hasRequiredScope,
    normalizeTokenResponse,
    buildHeaderRule,
    decodeReferenceTable,
    trpcPayload
  };
}));
