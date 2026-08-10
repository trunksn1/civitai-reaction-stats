import assert from 'node:assert/strict';
import {
  appendCreatorSnapshot,
  applyRetentionPolicy,
  determineRefreshTier,
  extractCreatorFollowers,
  extractPostTitleFromHtml,
  processImages,
  retryAfterDelayMs
} from './fetch-stats.js';

assert.equal(
  extractCreatorFollowers({ stats: { followerCountAllTime: 123 } }),
  123
);
assert.equal(
  extractCreatorFollowers({ stats: { followerCountAllTime: 0 } }),
  0,
  'a real zero is different from a missing response value'
);
assert.throws(() => extractCreatorFollowers({ stats: {} }), /unexpected user.getCreator/);
assert.throws(
  () => extractCreatorFollowers({ stats: { followerCountAllTime: -1 } }),
  /unexpected user.getCreator/
);

const creatorSnapshotResult = appendCreatorSnapshot(
  [{ timestamp: '2026-08-09T00:00:00.000Z', followers: 50 }],
  '2026-08-10T00:00:00.000Z',
  48,
  Date.parse('2026-08-10T00:00:00.000Z')
);
assert.deepEqual(creatorSnapshotResult.snapshots, [
  { timestamp: '2026-08-09T00:00:00.000Z', followers: 50 },
  { timestamp: '2026-08-10T00:00:00.000Z', followers: 48 }
]);

assert.equal(determineRefreshTier(new Date('2026-07-01T00:00:00Z')), 'quarterly');
assert.equal(determineRefreshTier(new Date('2026-07-01T01:00:00Z')), 'daily');
assert.equal(determineRefreshTier(new Date('2026-08-01T00:00:00Z')), 'monthly');
assert.equal(determineRefreshTier(new Date('2026-08-02T00:00:00Z')), 'daily');
assert.equal(determineRefreshTier(new Date('2026-08-02T00:00:00Z'), 'quarterly'), 'quarterly');
assert.throws(
  () => determineRefreshTier(new Date('2026-08-02T00:00:00Z'), 'weekly'),
  /Invalid refresh tier/
);

const now = Date.parse('2026-08-10T12:00:00Z');
const snapshots = [];
for (let daysAgo = 40; daysAgo >= 0; daysAgo--) {
  for (const hour of [0, 3, 6, 9, 12, 15, 18, 21]) {
    snapshots.push({
      timestamp: new Date(now - daysAgo * 86400000 + hour * 3600000).toISOString(),
      likes: snapshots.length
    });
  }
}
const retained = applyRetentionPolicy(snapshots, now);
assert.ok(retained.length < snapshots.length, 'retention removes older detail');
assert.ok(retained.some(s => Date.parse(s.timestamp) >= now - 7 * 86400000), 'recent snapshots remain');

const processed = processImages([{
  id: 'retention-test',
  stats: { likeCount: 3 },
  meta: {},
  url: 'https://example.invalid/image.jpg',
  createdAt: '2026-07-01T00:00:00.000Z',
  host: 'com'
}], [{
  id: 'retention-test',
  snapshots: [
    { timestamp: '2026-07-10T01:00:00.000Z', likes: 1 },
    { timestamp: '2026-07-10T20:00:00.000Z', likes: 2 },
    { timestamp: '2026-08-09T01:00:00.000Z', likes: 3 }
  ]
}], new Date(now));
assert.equal(processed.snapshotsAdded, 0);
assert.equal(processed.retentionRemoved, 1);
assert.equal(processed.images[0].snapshots.length, 2);

const payload = {
  props: {
    pageProps: {
      trpcState: {
        json: {
          queries: [
            { state: { data: { id: 999, title: 'Banner' } } },
            { state: { data: { id: 123, title: 'Correct title' } } }
          ]
        }
      }
    }
  }
};
const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
assert.deepEqual(extractPostTitleFromHtml(html, 123), { ok: true, title: 'Correct title' });
assert.equal(retryAfterDelayMs('4', 1000), 4000);
assert.equal(retryAfterDelayMs('invalid', 1000), 1000);

console.log('All collector-core tests passed');
