import assert from 'node:assert/strict';
import { assertSafeTransition, inspectStatsData } from './lib/stats-validation.js';
import { applyRetentionPolicy } from './lib/retention.js';

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
  () => assertSafeTransition(
    { ...before, totalSnapshots: [{ ...before.totalSnapshots[0], imageCount: 1 }] },
    { ...before, totalSnapshots: [{ ...before.totalSnapshots[0], imageCount: 2 }] }
  ),
  /changed imageCount/
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

const retentionReferenceTime = Date.parse('2026-08-10T12:00:00.000Z');
const candidateTimestamp = '2026-08-10T12:00:00.000Z';
const retentionHistory = [
  { timestamp: '2026-07-10T01:00:00.000Z', likes: 1 },
  { timestamp: '2026-07-10T20:00:00.000Z', likes: 2 },
  { timestamp: '2026-08-01T01:00:00.000Z', likes: 3 },
  { timestamp: '2026-08-01T02:00:00.000Z', likes: 4 },
  { timestamp: '2026-08-09T01:00:00.000Z', likes: 5 }
];
const retainedHistory = applyRetentionPolicy(retentionHistory, retentionReferenceTime);
const candidateHistory = [
  ...retainedHistory,
  { timestamp: candidateTimestamp, likes: 6 }
];
const retentionBefore = {
  username: 'test',
  totalSnapshots: retentionHistory,
  images: [{ id: 'retained', snapshots: retentionHistory }],
  postTitles: {}
};
const retentionAfter = {
  ...retentionBefore,
  lastUpdated: candidateTimestamp,
  totalSnapshots: candidateHistory,
  images: [{ id: 'retained', snapshots: candidateHistory }]
};

assert.throws(
  () => assertSafeTransition(retentionBefore, retentionAfter),
  /lost snapshots/
);
assert.equal(
  assertSafeTransition(retentionBefore, retentionAfter, {
    retentionReferenceTime,
    candidateTimestamp
  }).after.imageSnapshots,
  candidateHistory.length
);
assert.throws(
  () => assertSafeTransition(retentionBefore, {
    ...retentionAfter,
    images: [{ id: 'retained', snapshots: candidateHistory.slice(1) }]
  }, { retentionReferenceTime, candidateTimestamp }),
  /dropped required snapshot/
);
assert.throws(
  () => assertSafeTransition(retentionBefore, {
    ...retentionAfter,
    images: [{
      id: 'retained',
      snapshots: [...candidateHistory, { timestamp: '2026-08-05T00:00:00.000Z', likes: 6 }]
    }]
  }, { retentionReferenceTime, candidateTimestamp }),
  /introduced unexpected snapshot/
);

console.log('All stats-validation tests passed');
