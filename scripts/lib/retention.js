export const HOURLY_RETENTION_DAYS = 7;
export const SIX_HOUR_RETENTION_DAYS = 30;

/**
 * Group snapshots into UTC-aligned intervals and keep the last observation in
 * each interval. Callers must pass resolved absolute snapshots.
 */
export function aggregateSnapshots(snapshots, intervalHours) {
  if (snapshots.length === 0) return [];

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const aggregated = [];
  let currentBucket = null;
  let currentBucketStart = null;

  for (const snapshot of snapshots) {
    const timestamp = Date.parse(snapshot.timestamp);
    const bucketStart = Math.floor(timestamp / intervalMs) * intervalMs;

    if (currentBucketStart !== bucketStart) {
      if (currentBucket) aggregated.push(currentBucket);
      currentBucketStart = bucketStart;
    }
    currentBucket = snapshot;
  }

  if (currentBucket) aggregated.push(currentBucket);
  return aggregated;
}

/**
 * Preserve full detail for 7 days, one point per six-hour UTC bucket through
 * day 30, and one point per UTC day thereafter.
 */
export function applyRetentionPolicy(snapshots, now = Date.now()) {
  const hourlyThreshold = now - (HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const sixHourThreshold = now - (SIX_HOUR_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const hourlySnapshots = [];
  const sixHourSnapshots = [];
  const dailySnapshots = [];

  for (const snapshot of snapshots) {
    const timestamp = Date.parse(snapshot.timestamp);
    if (timestamp >= hourlyThreshold) hourlySnapshots.push(snapshot);
    else if (timestamp >= sixHourThreshold) sixHourSnapshots.push(snapshot);
    else dailySnapshots.push(snapshot);
  }

  const result = [
    ...aggregateSnapshots(dailySnapshots, 24),
    ...aggregateSnapshots(sixHourSnapshots, 6),
    ...hourlySnapshots
  ];
  result.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return result;
}
