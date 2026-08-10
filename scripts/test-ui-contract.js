import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('../extension/stats-page/stats.html', 'utf8');
const script = await readFile('../extension/stats-page/stats.js', 'utf8');
const manifest = JSON.parse(await readFile('../extension/manifest.json', 'utf8'));

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
assert.ok(manifest.permissions.includes('scripting'),
  'same-origin title verification requires the MV3 scripting permission');
assert.ok(htmlIds.has('renameDialog') && htmlIds.has('undoTitleBtn'));
assert.match(script, /validateStatsFormat\(response\.data\)/);

console.log('All UI contract tests passed');
