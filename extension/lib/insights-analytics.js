(function (global) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const REACTION_FIELDS = ['likes', 'hearts', 'laughs', 'cries'];

  function reactionTotal(snapshot) {
    return REACTION_FIELDS.reduce((sum, field) => sum + (Number(snapshot?.[field]) || 0), 0);
  }

  function utcDayKey(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }

  function sortedCreatorSnapshots(snapshots) {
    return [...(snapshots || [])]
      .filter(snapshot => Number.isFinite(Date.parse(snapshot?.timestamp)) &&
        Number.isFinite(snapshot?.followers))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  function buildDailySeries(statsData, days = 365, now = Date.now()) {
    const endDay = Math.floor(now / DAY_MS) * DAY_MS;
    const startDay = endDay - (Math.max(1, days) - 1) * DAY_MS;
    const rows = [];
    const byDay = new Map();

    for (let timestamp = startDay; timestamp <= endDay; timestamp += DAY_MS) {
      const day = utcDayKey(timestamp);
      const row = {
        day,
        timestamp,
        reactions: 0,
        netFollowers: 0,
        publishedImages: 0,
        publishedPosts: 0,
        newContentReactions: 0,
        backCatalogReactions: 0
      };
      rows.push(row);
      byDay.set(day, row);
    }

    const totals = global.SnapshotCodec.resolveAll(statsData?.totalSnapshots || []);
    for (let index = 1; index < totals.length; index++) {
      const row = byDay.get(utcDayKey(totals[index].timestamp));
      if (row) row.reactions += reactionTotal(totals[index]) - reactionTotal(totals[index - 1]);
    }

    const creators = sortedCreatorSnapshots(statsData?.creatorSnapshots);
    for (let index = 1; index < creators.length; index++) {
      const row = byDay.get(utcDayKey(creators[index].timestamp));
      if (row) row.netFollowers += creators[index].followers - creators[index - 1].followers;
    }

    const postsByDay = new Map();
    for (const image of statsData?.images || []) {
      const createdDay = utcDayKey(image.createdAt);
      const createdRow = byDay.get(createdDay);
      if (createdRow) {
        createdRow.publishedImages++;
        if (image.postId != null) {
          if (!postsByDay.has(createdDay)) postsByDay.set(createdDay, new Set());
          postsByDay.get(createdDay).add(String(image.postId));
        }
      }

      const createdAt = Date.parse(image.createdAt);
      const resolved = global.SnapshotCodec.resolveAll(image.snapshots || []);
      for (let index = 1; index < resolved.length; index++) {
        const currentTime = Date.parse(resolved[index].timestamp);
        const row = byDay.get(utcDayKey(currentTime));
        if (!row) continue;
        const gain = reactionTotal(resolved[index]) - reactionTotal(resolved[index - 1]);
        if (Number.isFinite(createdAt) && currentTime - createdAt <= 30 * DAY_MS) {
          row.newContentReactions += gain;
        } else {
          row.backCatalogReactions += gain;
        }
      }
    }

    for (const [day, postIds] of postsByDay) byDay.get(day).publishedPosts = postIds.size;
    return rows;
  }

  function observedGainSince(resolved, cutoff) {
    let gain = 0;
    for (let index = 1; index < resolved.length; index++) {
      if (Date.parse(resolved[index].timestamp) >= cutoff) {
        gain += reactionTotal(resolved[index]) - reactionTotal(resolved[index - 1]);
      }
    }
    return gain;
  }

  function aggregatePosts(statsData, now = Date.now()) {
    const groups = new Map();
    for (const image of statsData?.images || []) {
      const key = image.postId == null ? `image:${image.id}` : `post:${image.postId}`;
      if (!groups.has(key)) {
        const cached = image.postId == null ? null : statsData?.postTitles?.[String(image.postId)];
        groups.set(key, {
          key,
          postId: image.postId == null ? null : String(image.postId),
          title: cached?.title || image.baseModel || `Image ${image.id}`,
          imageCount: 0,
          reactions: 0,
          gained7d: 0,
          gained30d: 0,
          thumbnailUrl: image.thumbnailUrl || '',
          url: image.url || '',
          createdAt: image.createdAt || null
        });
      }
      const group = groups.get(key);
      const resolved = global.SnapshotCodec.resolveAll(image.snapshots || []);
      group.imageCount++;
      group.reactions += reactionTotal(resolved[resolved.length - 1]);
      group.gained7d += observedGainSince(resolved, now - 7 * DAY_MS);
      group.gained30d += observedGainSince(resolved, now - 30 * DAY_MS);
      if (Date.parse(image.createdAt) < Date.parse(group.createdAt)) group.createdAt = image.createdAt;
    }
    return [...groups.values()].sort((a, b) => b.reactions - a.reactions);
  }

  function longestPositiveStreak(rows, field) {
    let current = 0;
    let best = 0;
    for (const row of rows) {
      current = row[field] > 0 ? current + 1 : 0;
      best = Math.max(best, current);
    }
    return best;
  }

  function bestWindow(rows, field, width) {
    let sum = 0;
    let best = null;
    for (let index = 0; index < rows.length; index++) {
      sum += rows[index][field] || 0;
      if (index >= width) sum -= rows[index - width][field] || 0;
      if (index >= width - 1 && (!best || sum > best.value)) {
        best = { value: sum, day: rows[index].day };
      }
    }
    return best;
  }

  function nextMilestone(value) {
    const current = Math.max(0, Number(value) || 0);
    for (let exponent = 0; exponent < 12; exponent++) {
      const scale = 10 ** exponent;
      for (const multiple of [1, 2.5, 5]) {
        const target = multiple * scale;
        if (target > current) return target;
      }
    }
    return null;
  }

  function buildRecords(statsData, dailyRows) {
    const totals = global.SnapshotCodec.resolveAll(statsData?.totalSnapshots || []);
    const latestTotal = reactionTotal(totals[totals.length - 1]);
    const creators = sortedCreatorSnapshots(statsData?.creatorSnapshots);
    const latestFollowers = creators[creators.length - 1]?.followers ?? null;
    const posts = aggregatePosts(statsData);
    const images = (statsData?.images || []).map(image => {
      const resolved = global.SnapshotCodec.resolveAll(image.snapshots || []);
      return {
        image,
        current: reactionTotal(resolved[resolved.length - 1]),
        gained7d: observedGainSince(resolved, Date.now() - 7 * DAY_MS)
      };
    });
    images.sort((a, b) => b.gained7d - a.gained7d);

    return {
      bestReactionDay: bestWindow(dailyRows, 'reactions', 1),
      bestReactionWeek: bestWindow(dailyRows, 'reactions', 7),
      bestFollowerDay: bestWindow(dailyRows, 'netFollowers', 1),
      bestFollowerWeek: bestWindow(dailyRows, 'netFollowers', 7),
      reactionStreak: longestPositiveStreak(dailyRows, 'reactions'),
      followerStreak: longestPositiveStreak(dailyRows, 'netFollowers'),
      topPost: posts[0] || null,
      oldestStillGaining: images
        .filter(entry => entry.gained7d > 0)
        .sort((a, b) => Date.parse(a.image.createdAt) - Date.parse(b.image.createdAt))[0] || null,
      reactionMilestone: { current: latestTotal, target: nextMilestone(latestTotal) },
      followerMilestone: latestFollowers == null
        ? null
        : { current: latestFollowers, target: nextMilestone(latestFollowers) }
    };
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function valueAtOrBefore(resolved, time) {
    let value = null;
    for (const snapshot of resolved) {
      if (Date.parse(snapshot.timestamp) > time) break;
      value = reactionTotal(snapshot);
    }
    return value;
  }

  function buildPublishCohorts(statsData) {
    const groups = new Map();
    const ages = [1, 7, 30, 90];
    let eligible = 0;
    for (const image of statsData?.images || []) {
      const createdAt = Date.parse(image.createdAt);
      const resolved = global.SnapshotCodec.resolveAll(image.snapshots || []);
      if (!Number.isFinite(createdAt) || !resolved.length) continue;
      const firstSeen = Date.parse(resolved[0].timestamp);
      // Honest age curves need collection to have begun close to publication.
      if (firstSeen < createdAt - DAY_MS || firstSeen > createdAt + 36 * 60 * 60 * 1000) continue;
      eligible++;
      const month = new Date(createdAt).toISOString().slice(0, 7);
      if (!groups.has(month)) groups.set(month, { month, images: 0, values: {} });
      const group = groups.get(month);
      group.images++;
      for (const age of ages) {
        const value = valueAtOrBefore(resolved, createdAt + age * DAY_MS);
        if (value == null) continue;
        if (!group.values[age]) group.values[age] = [];
        group.values[age].push(value);
      }
    }

    const cohorts = [...groups.values()]
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(group => ({
        month: group.month,
        images: group.images,
        day1: median(group.values[1] || []),
        day7: median(group.values[7] || []),
        day30: median(group.values[30] || []),
        day90: median(group.values[90] || [])
      }));
    return { eligible, total: statsData?.images?.length || 0, cohorts };
  }

  const api = {
    DAY_MS,
    aggregatePosts,
    buildDailySeries,
    buildPublishCohorts,
    buildRecords,
    nextMilestone,
    reactionTotal,
    sortedCreatorSnapshots,
    utcDayKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.InsightsAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
