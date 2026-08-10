import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const oauth = require('../extension/lib/civitai-oauth.js');

assert.equal(oauth.REQUIRED_SCOPE, 97);
assert.equal(oauth.parseScope(97), 97);
assert.equal(oauth.parseScope('97'), 97);
assert.equal(oauth.parseScope(['97']), 97);
assert.equal(oauth.parseScope('1 32 64'), null);
assert.equal(oauth.hasRequiredScope(97), true);
assert.equal(oauth.hasRequiredScope(65), false);

const challenge = await oauth.pkceChallenge(
  'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', webcrypto
);
assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

const authorize = new URL(oauth.buildAuthorizationUrl({
  clientId: 'public-client',
  redirectUri: 'https://abcdefghijklmnop.chromiumapp.org/oauth2',
  state: 'state-value',
  challenge
}));
assert.equal(authorize.origin + authorize.pathname, oauth.AUTHORIZE_URL);
assert.equal(authorize.searchParams.get('client_id'), 'public-client');
assert.equal(authorize.searchParams.get('redirect_uri'), 'https://abcdefghijklmnop.chromiumapp.org/oauth2');
assert.equal(authorize.searchParams.get('response_type'), 'code');
assert.equal(authorize.searchParams.get('scope'), '97');
assert.equal(authorize.searchParams.get('state'), 'state-value');
assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

const codeBody = new URLSearchParams(oauth.buildTokenBody({
  grantType: 'authorization_code',
  clientId: 'public-client',
  code: 'one-time-code',
  redirectUri: 'https://abcdefghijklmnop.chromiumapp.org/oauth2',
  verifier: 'verifier'
}));
assert.equal(codeBody.get('client_id'), 'public-client');
assert.equal(codeBody.get('code_verifier'), 'verifier');
assert.equal(codeBody.has('client_secret'), false);

const refreshBody = new URLSearchParams(oauth.buildTokenBody({
  grantType: 'refresh_token', clientId: 'public-client', refreshToken: 'rotating-token'
}));
assert.equal(refreshBody.get('refresh_token'), 'rotating-token');
assert.equal(refreshBody.has('client_secret'), false);

const tokens = oauth.normalizeTokenResponse({
  access_token: 'access',
  refresh_token: 'replacement-refresh',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: '97'
}, 1_000);
assert.deepEqual(tokens, {
  accessToken: 'access',
  refreshToken: 'replacement-refresh',
  tokenType: 'Bearer',
  scope: 97,
  expiresAt: 3_601_000
});
assert.throws(() => oauth.normalizeTokenResponse({
  access_token: 'access', expires_in: 3600, scope: 97
}), /rotated refresh token/);
assert.throws(() => oauth.normalizeTokenResponse({
  access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 33
}), /required OAuth permissions/);

const rule = oauth.buildHeaderRule({
  id: 9701, hostname: 'civitai.com', extensionId: 'abcdefghijklmnop'
});
assert.equal(rule.action.type, 'modifyHeaders');
assert.deepEqual(rule.condition.requestDomains, ['civitai.com']);
assert.deepEqual(rule.condition.initiatorDomains, ['abcdefghijklmnop']);
assert.equal(
  rule.condition.regexFilter,
  '^https://civitai\\.com/api/trpc/(post\\.get|post\\.update|user\\.getCreator)\\?crs_oauth=1(&.*)?$'
);
assert.deepEqual(rule.action.requestHeaders, [
  { header: 'Origin', operation: 'set', value: 'https://civitai.com' },
  { header: 'Referer', operation: 'set', value: 'https://civitai.com/' }
]);
assert.throws(() => oauth.buildHeaderRule({
  id: 1, hostname: 'example.com', extensionId: 'abcdefghijklmnop'
}), /Unsupported Civitai host/);

assert.deepEqual(oauth.decodeReferenceTable([{ title: 1, tags: 2 }, 'Hello', [3], 'tag']), {
  title: 'Hello', tags: ['tag']
});
assert.deepEqual(oauth.trpcPayload({ result: { data: { json: { title: 'Hello' } } } }), { title: 'Hello' });
assert.throws(() => oauth.trpcPayload({ error: { json: { message: 'Denied' } } }), /Denied/);

console.log('All OAuth client tests passed');
