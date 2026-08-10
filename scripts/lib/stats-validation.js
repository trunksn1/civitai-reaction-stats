import SnapshotCodec from '../../extension/lib/snapshot-codec.js';

const { FIELDS, resolveAt } = SnapshotCodec;

function invariant(condition, message) {
  if (!condition) throw new Error(`Stats validation failed: ${message}`);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateResolvedSnapshot(snapshot, label) {
  invariant(validTimestamp(snapshot.timestamp), `${label} has an invalid timestamp`);
  for (const [field] of FIELDS) {
    const value = snapshot[field] || 0;
    invariant(Number.isFinite(value), `${label}.${field} is not finite`);
    invariant(value >= 0, `${label}.${field} is negative`);
  }
}

export function inspectStatsData(data) {
  invariant(data && typeof data === 'object' && !Array.isArray(data), 'root must be an object');
  invariant(Array.isArray(data.totalSnapshots), 'totalSnapshots must be an array');
  invariant(Array.isArray(data.images), 'images must be an array');
  invariant(data.postTitles == null ||
    (typeof data.postTitles === 'object' && !Array.isArray(data.postTitles)),
  'postTitles must be an object when present');

  const ids = new Set();
  let imageSnapshots = 0;
  for (const image of data.images) {
    const id = String(image?.id ?? '');
    invariant(id.length > 0, 'an image has no id');
    invariant(!ids.has(id), `duplicate image id ${id}`);
    ids.add(id);
    invariant(Array.isArray(image.snapshots) && image.snapshots.length > 0,
      `image ${id} has no snapshots`);
    imageSnapshots += image.snapshots.length;
    validateResolvedSnapshot(
      resolveAt(image.snapshots, image.snapshots.length - 1),
      `image ${id} latest snapshot`
    );
  }

  if (data.totalSnapshots.length > 0) {
    validateResolvedSnapshot(
      resolveAt(data.totalSnapshots, data.totalSnapshots.length - 1),
      'latest total snapshot'
    );
  }

  return {
    images: data.images.length,
    imageSnapshots,
    totalSnapshots: data.totalSnapshots.length,
    postTitles: Object.keys(data.postTitles || {}).length
  };
}

/**
 * The collector carries missing images forward, so a candidate write must
 * never drop an existing image or its entire history. Retention may reduce the
 * number of snapshots, and clamp resets may reduce counters, so those are
 * intentionally validated elsewhere rather than forbidden here.
 */
export function assertSafeTransition(before, after) {
  const beforeSummary = inspectStatsData(before);
  const afterSummary = inspectStatsData(after);
  const afterById = new Map(after.images.map(image => [String(image.id), image]));

  for (const image of before.images) {
    const candidate = afterById.get(String(image.id));
    invariant(candidate, `candidate dropped image ${image.id}`);
    assertSnapshotHistoryPreserved(
      image.snapshots,
      candidate.snapshots,
      `image ${image.id}`
    );
  }
  assertSnapshotHistoryPreserved(before.totalSnapshots, after.totalSnapshots, 'total history');
  const afterPostTitles = after.postTitles || {};
  for (const postId of Object.keys(before.postTitles || {})) {
    invariant(postId in afterPostTitles, `candidate dropped post-title cache entry ${postId}`);
  }
  invariant(afterSummary.postTitles >= beforeSummary.postTitles,
    `candidate dropped post-title cache entries (${beforeSummary.postTitles} -> ${afterSummary.postTitles})`);

  return { before: beforeSummary, after: afterSummary };
}

function assertSnapshotHistoryPreserved(beforeSnapshots, afterSnapshots, label) {
  const beforeResolved = SnapshotCodec.resolveAll(beforeSnapshots);
  const afterResolved = SnapshotCodec.resolveAll(afterSnapshots);

  invariant(afterResolved.length >= beforeResolved.length,
    `${label} lost snapshots (${beforeResolved.length} -> ${afterResolved.length})`);

  for (let index = 0; index < beforeResolved.length; index++) {
    const snapshot = beforeResolved[index];
    const candidate = afterResolved[index];
    invariant(candidate.timestamp === snapshot.timestamp,
      `${label} changed snapshot order/timestamp at index ${index}`);
    for (const [field] of FIELDS) {
      invariant((candidate[field] || 0) === (snapshot[field] || 0),
        `${label} changed ${field} at ${snapshot.timestamp}`);
    }
    if (snapshot.imageCount != null) {
      invariant(candidate.imageCount === snapshot.imageCount,
        `${label} changed imageCount at ${snapshot.timestamp}`);
    }
  }
}
