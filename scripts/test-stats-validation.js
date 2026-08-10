import assert from 'node:assert/strict';
import { assertSafeTransition, inspectStatsData } from './lib/stats-validation.js';

function image(id, likes = 1) {
  return {
    id: String(id),
    snapshots: [{ timestamp: '2026-08-10T00:00:00.000Z', likes }]
  };
}

const before = {
  username: 'test',
  totalSnapshots: [{ timestamp: '2026-08-10T00:00:00.000Z', likes: 1 }],
  images: [image(1)],
  postTitles: { 10: { title: 'Test', fetchedAt: '2026-08-10T00:00:00.000Z' } }
};
const after = {
  ...before,
  totalSnapshots: [
    ...before.totalSnapshots,
    { timestamp: '2026-08-10T01:00:00.000Z', dl: 1 }
  ],
  images: [{
    ...image(1),
    snapshots: [
      ...image(1).snapshots,
      { timestamp: '2026-08-10T01:00:00.000Z', dl: 1 }
    ]
  }, image(2)],
  postTitles: { ...before.postTitles, 20: { title: null, fetchedAt: '2026-08-10T01:00:00.000Z' } }
};

assert.equal(inspectStatsData(before).images, 1);
assert.equal(assertSafeTransition(before, after).after.images, 2);
assert.throws(
  () => assertSafeTransition(after, { ...after, images: [after.images[0]] }),
  /candidate dropped image 2/
);
assert.throws(
  () => assertSafeTransition(before, { ...before, images: [image(1, 2)] }),
  /changed likes/
);
assert.throws(
  () => assertSafeTransition(after, {
    ...after,
    images: [{ ...after.images[0], snapshots: after.images[0].snapshots.slice(1) }, image(2)]
  }),
  /lost snapshots/
);
assert.throws(
  () => assertSafeTransition(
    before,
    { ...before, postTitles: { 20: { title: null, fetchedAt: '2026-08-10T01:00:00.000Z' } } }
  ),
  /candidate dropped post-title cache entry 10/
);
assert.throws(
  () => inspectStatsData({ ...before, images: [image(1), image(1)] }),
  /duplicate image id 1/
);
assert.throws(
  () => inspectStatsData({ ...before, images: [{ id: '1', snapshots: [] }] }),
  /image 1 has no snapshots/
);

console.log('All stats-validation tests passed');
