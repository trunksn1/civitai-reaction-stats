import assert from 'node:assert/strict';
import { createTrpcHeaders, decodeReferenceTable, extractTrpcPayload } from './lib/trpc.js';

const legacy = { result: { data: { json: { id: 42, stats: { likeCountAllTime: 7 } } } } };
assert.deepEqual(extractTrpcPayload(legacy), { id: 42, stats: { likeCountAllTime: 7 } });

const table = [
  { items: 1, nextCursor: 2 },
  [3],
  42,
  { id: 4, title: 5 },
  7,
  'A title'
];
assert.deepEqual(decodeReferenceTable(table), {
  items: [{ id: 7, title: 'A title' }],
  nextCursor: 42
});
assert.deepEqual(
  extractTrpcPayload({ result: { data: JSON.stringify(table) } }),
  { items: [{ id: 7, title: 'A title' }], nextCursor: 42 }
);
assert.deepEqual(extractTrpcPayload([{ result: { data: { json: { ok: true } } } }]), { ok: true });
assert.throws(() => decodeReferenceTable([{ bad: 99 }]), /outside a table/);
assert.throws(() => extractTrpcPayload({ result: { data: 'not json' } }), /Could not parse/);

const headers = createTrpcHeaders('https://civitai.red/path', 'token-placeholder');
assert.equal(headers.Origin, 'https://civitai.red');
assert.equal(headers.Referer, 'https://civitai.red/');
assert.equal(headers.Authorization, 'Bearer token-placeholder');

console.log('All tRPC helper tests passed');
