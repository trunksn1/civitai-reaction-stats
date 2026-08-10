import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('../extension/stats-page/stats.html', 'utf8');
const script = await readFile('../extension/stats-page/stats.js', 'utf8');
const manifest = JSON.parse(await readFile('../extension/manifest.json', 'utf8'));
const popupHtml = await readFile('../extension/popup/popup.html', 'utf8');
const popupScript = await readFile('../extension/popup/popup.js', 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const literalLookups = [...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
  .map(match => match[1]);
for (const id of literalLookups) {
  assert.ok(htmlIds.has(id), `stats.js expects #${id}, but stats.html does not define it`);
}

const codecIndex = html.indexOf('../lib/snapshot-codec.js');
const analyticsIndex = html.indexOf('../lib/insights-analytics.js');
const statsIndex = html.indexOf('src="stats.js"');
assert.ok(codecIndex >= 0 && analyticsIndex > codecIndex && statsIndex > analyticsIndex,
  'snapshot and analytics helpers must load before stats.js');
assert.ok(manifest.permissions.includes('identity'),
  'independent OAuth requires the MV3 identity permission');
assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'),
  'OAuth tRPC calls require narrowly scoped Origin/Referer rules');
assert.ok(!manifest.permissions.includes('scripting'),
  'OAuth title write-back must not depend on injecting a signed-in tab');
assert.ok(manifest.host_permissions.includes('https://auth.civitai.com/*'));
assert.ok(htmlIds.has('renameDialog') && htmlIds.has('undoTitleBtn'));
assert.match(script, /validateStatsFormat\(response\.data\)/);
assert.match(script, /publicCheckbox\.checked = false/);

const popupIds = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const popupLookups = [...popupScript.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
  .map(match => match[1]);
for (const id of popupLookups) {
  assert.ok(popupIds.has(id), `popup.js expects #${id}, but popup.html does not define it`);
}
assert.ok(popupIds.has('oauthClientId') && popupIds.has('oauthRedirectUri'));

console.log('All UI contract tests passed');
