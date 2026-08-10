import SnapshotCodec from '../../extension/lib/snapshot-codec.js';
import { applyRetentionPolicy } from './retention.js';

const { FIELDS, resolveAt } = SnapshotCodec;
export const CURRENT_FORMAT_VERSION = 1;

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
  invariant(data.formatVersion == null || data.formatVersion === CURRENT_FORMAT_VERSION,
    `unsupported formatVersion ${String(data.formatVersion)}`);
  invariant(Array.isArray(data.totalSnapshots), 'totalSnapshots must be an array');
  invariant(Array.isArray(data.images), 'images must be an array');
  invariant(data.creatorSnapshots == null || Array.isArray(data.creatorSnapshots),
    'creatorSnapshots must be an array when present');
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

  const creatorTimestamps = new Set();
  let previousCreatorTime = -Infinity;
  for (const [index, snapshot] of (data.creatorSnapshots || []).entries()) {
    invariant(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
      `creator snapshot ${index} must be an object`);
    invariant(validTimestamp(snapshot.timestamp), `creator snapshot ${index} has an invalid timestamp`);
    invariant(!creatorTimestamps.has(snapshot.timestamp),
      `creatorSnapshots has duplicate timestamp ${snapshot.timestamp}`);
    creatorTimestamps.add(snapshot.timestamp);
    const creatorTime = Date.parse(snapshot.timestamp);
    invariant(creatorTime > previousCreatorTime,
      `creatorSnapshots is not chronological at ${snapshot.timestamp}`);
    previousCreatorTime = creatorTime;
    invariant(Number.isFinite(snapshot.followers),
      `creator snapshot ${index}.followers is not finite`);
    invariant(snapshot.followers >= 0, `creator snapshot ${index}.followers is negative`);
    invariant(Number.isInteger(snapshot.followers),
      `creator snapshot ${index}.followers is not an integer`);
  }

  return {
    formatVersion: data.formatVersion ?? CURRENT_FORMAT_VERSION,
    images: data.images.length,
    imageSnapshots,
    totalSnapshots: data.totalSnapshots.length,
    creatorSnapshots: (data.creatorSnapshots || []).length,
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
  assertCreatorHistoryPreserved(
    before.creatorSnapshots || [],
    after.creatorSnapshots || [],
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

function assertCreatorHistoryPreserved(beforeSnapshots, afterSnapshots, options) {
  const requiredBefore = options.retentionReferenceTime == null
    ? beforeSnapshots
    : applyRetentionPolicy(beforeSnapshots, options.retentionReferenceTime);
  const beforeByTimestamp = uniqueSnapshotsByTimestamp(beforeSnapshots, 'creator history before');
  const afterByTimestamp = uniqueSnapshotsByTimestamp(afterSnapshots, 'creator history candidate');

  invariant(afterSnapshots.length >= requiredBefore.length,
    `creator history lost snapshots beyond retention ` +
    `(${requiredBefore.length} required, ${afterSnapshots.length} candidate)`);

  for (const snapshot of requiredBefore) {
    const candidate = afterByTimestamp.get(snapshot.timestamp);
    invariant(candidate, `creator history dropped required snapshot ${snapshot.timestamp}`);
    invariant(candidate.followers === snapshot.followers,
      `creator history changed followers at ${snapshot.timestamp}`);
  }

  for (const candidate of afterSnapshots) {
    const previous = beforeByTimestamp.get(candidate.timestamp);
    if (previous) {
      invariant(candidate.followers === previous.followers,
        `creator history changed followers at ${candidate.timestamp}`);
    } else if (options.candidateTimestamp != null) {
      invariant(candidate.timestamp === options.candidateTimestamp,
        `creator history introduced unexpected snapshot ${candidate.timestamp}`);
    }
  }
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
