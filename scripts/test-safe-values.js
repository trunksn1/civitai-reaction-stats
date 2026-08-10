import assert from 'node:assert/strict';
import SafeValues from '../extension/lib/safe-values.js';

assert.equal(
  SafeValues.escapeHtml('x" onerror="alert(1) & <tag>'),
  'x&quot; onerror=&quot;alert(1) &amp; &lt;tag&gt;'
);
assert.equal(
  SafeValues.safeCivitaiUrl('https://image.civitai.com/path/image.jpeg'),
  'https://image.civitai.com/path/image.jpeg'
);
assert.equal(SafeValues.safeCivitaiUrl('javascript:alert(1)'), '#');
assert.equal(SafeValues.safeCivitaiUrl('https://example.com/image.jpeg'), '#');
assert.equal(SafeValues.safeCivitaiUrl('not a url'), '#');

console.log('All safe-value tests passed');
