import SnapshotCodec from '../../extension/lib/snapshot-codec.js';
import { applyRetentionPolicy } from './retention.js';

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
 * never drop an existing image or its entire history. When a retention
 * reference time is supplied, only observations superseded by the documented
 * retention policy may disappear; every required survivor is value-checked.
 */
export function assertSafeTransition(before, after, options = {}) {
  const retentionReferenceTime = options.retentionReferenceTime ?? null;
  const candidateTimestamp = options.candidateTimestamp ?? null;
  const beforeSummary = inspectStatsData(before);
  const afterSummary = inspectStatsData(after);
  const beforeById = new Map(before.images.map(image => [String(image.id), image]));
  const afterById = new Map(after.images.map(image => [String(image.id), image]));

  for (const image of before.images) {
    const candidate = afterById.get(String(image.id));
    invariant(candidate, `candidate dropped image ${image.id}`);
    assertSnapshotHistoryPreserved(
      image.snapshots,
      candidate.snapshots,
      `image ${image.id}`,
      { retentionReferenceTime, candidateTimestamp }
    );
  }
  for (const image of after.images) {
    if (beforeById.has(String(image.id)) || candidateTimestamp == null) continue;
    invariant(image.snapshots.length === 1,
      `new image ${image.id} has unexpected historical snapshots`);
    invariant(image.snapshots[0].timestamp === candidateTimestamp,
      `new image ${image.id} has an unexpected snapshot timestamp`);
  }
  assertSnapshotHistoryPreserved(
    before.totalSnapshots,
    after.totalSnapshots,
    'total history',
    { retentionReferenceTime, candidateTimestamp }
  );
  const afterPostTitles = after.postTitles || {};
  for (const postId of Object.keys(before.postTitles || {})) {
    invariant(postId in afterPostTitles, `candidate dropped post-title cache entry ${postId}`);
  }
  invariant(afterSummary.postTitles >= beforeSummary.postTitles,
    `candidate dropped post-title cache entries (${beforeSummary.postTitles} -> ${afterSummary.postTitles})`);

  return { before: beforeSummary, after: afterSummary };
}

function assertSnapshotHistoryPreserved(beforeSnapshots, afterSnapshots, label, options) {
  const beforeResolved = resolveSnapshotsWithMetadata(beforeSnapshots);
  const afterResolved = resolveSnapshotsWithMetadata(afterSnapshots);
  const requiredBefore = options.retentionReferenceTime == null
    ? beforeResolved
    : applyRetentionPolicy(beforeResolved, options.retentionReferenceTime);
  const beforeByTimestamp = uniqueSnapshotsByTimestamp(beforeResolved, `${label} before`);
  const afterByTimestamp = uniqueSnapshotsByTimestamp(afterResolved, `${label} candidate`);

  invariant(afterResolved.length >= requiredBefore.length,
    `${label} lost snapshots beyond retention ` +
    `(${requiredBefore.length} required, ${afterResolved.length} candidate)`);

  for (const snapshot of requiredBefore) {
    const candidate = afterByTimestamp.get(snapshot.timestamp);
    invariant(candidate, `${label} dropped required snapshot ${snapshot.timestamp}`);
    assertSnapshotValuesEqual(snapshot, candidate, label);
  }

  for (const candidate of afterResolved) {
    const previous = beforeByTimestamp.get(candidate.timestamp);
    if (previous) {
      assertSnapshotValuesEqual(previous, candidate, label);
    } else if (options.candidateTimestamp != null) {
      invariant(candidate.timestamp === options.candidateTimestamp,
        `${label} introduced unexpected snapshot ${candidate.timestamp}`);
    }
  }
}

function resolveSnapshotsWithMetadata(snapshots) {
  const resolved = SnapshotCodec.resolveAll(snapshots);
  for (let index = 0; index < resolved.length; index++) {
    if (snapshots[index]?.imageCount != null) {
      resolved[index].imageCount = snapshots[index].imageCount;
    }
  }
  return resolved;
}

function uniqueSnapshotsByTimestamp(snapshots, label) {
  const byTimestamp = new Map();
  for (const snapshot of snapshots) {
    invariant(!byTimestamp.has(snapshot.timestamp),
      `${label} has duplicate timestamp ${snapshot.timestamp}`);
    byTimestamp.set(snapshot.timestamp, snapshot);
  }
  return byTimestamp;
}

function assertSnapshotValuesEqual(expected, actual, label) {
  for (const [field] of FIELDS) {
    invariant((actual[field] || 0) === (expected[field] || 0),
      `${label} changed ${field} at ${expected.timestamp}`);
  }
  if (expected.imageCount != null) {
    invariant(actual.imageCount === expected.imageCount,
      `${label} changed imageCount at ${expected.timestamp}`);
  }
}
