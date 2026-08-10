import assert from 'node:assert/strict';

await import('../extension/lib/snapshot-codec.js');
await import('../extension/lib/insights-analytics.js');

const Analytics = globalThis.InsightsAnalytics;
const now = Date.parse('2026-08-10T12:00:00.000Z');
const stats = {
  totalSnapshots: [
    { timestamp: '2026-08-08T12:00:00.000Z', likes: 10 },
    { timestamp: '2026-08-09T12:00:00.000Z', dl: 3, dh: 2 },
    { timestamp: '2026-08-10T12:00:00.000Z', dl: 1 }
  ],
  creatorSnapshots: [
    { timestamp: '2026-08-08T12:00:00.000Z', followers: 20 },
    { timestamp: '2026-08-09T12:00:00.000Z', followers: 23 },
    { timestamp: '2026-08-10T12:00:00.000Z', followers: 21 }
  ],
  postTitles: { 100: { title: 'Test post' } },
  images: [{
    id: '1',
    postId: 100,
    createdAt: '2026-08-09T10:00:00.000Z',
    thumbnailUrl: 'https://example.invalid/1.jpg',
    snapshots: [
      { timestamp: '2026-08-09T12:00:00.000Z', likes: 4 },
      { timestamp: '2026-08-10T12:00:00.000Z', dl: 2 }
    ]
  }]
};

const daily = Analytics.buildDailySeries(stats, 3, now);
assert.equal(daily.length, 3);
assert.equal(daily[1].reactions, 5);
assert.equal(daily[1].netFollowers, 3);
assert.equal(daily[2].netFollowers, -2, 'net unfollows remain visible');
assert.equal(daily[1].publishedImages, 1);
assert.equal(daily[1].publishedPosts, 1);
assert.equal(daily[2].newContentReactions, 2);

const posts = Analytics.aggregatePosts(stats, now);
assert.equal(posts[0].title, 'Test post');
assert.equal(posts[0].reactions, 6);
assert.equal(posts[0].gained7d, 2);

assert.equal(Analytics.nextMilestone(101), 250);
assert.equal(Analytics.nextMilestone(1000), 2500);

const cohorts = Analytics.buildPublishCohorts(stats);
assert.equal(cohorts.eligible, 1);
assert.equal(cohorts.cohorts[0].month, '2026-08');
assert.equal(cohorts.cohorts[0].day1, 4);

console.log('All insights-analytics tests passed');
