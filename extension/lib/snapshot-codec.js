/**
 * Snapshot codec — SINGLE source of truth for the delta-encoded snapshot format.
 *
 * Used by BOTH sides of the project:
 *   - collector: scripts/fetch-stats.js  (Node, imports this file directly)
 *   - extension: stats-page/stats.js     (loaded as a plain script before stats.js)
 *
 * It lives under extension/lib/ because Chrome cannot load files from outside
 * the extension root; Node has no such restriction and imports it from here.
 *
 * Format:
 *   - An ABSOLUTE snapshot stores plain field values: { timestamp, likes, hearts, ... }
 *   - A DELTA snapshot stores only non-zero changes under short keys:
 *     { timestamp, dl: +2, dh: +1 } — or { timestamp, _d: 1 } when nothing changed
 *     (the _d marker prevents a zero-change delta from being mistaken for absolute).
 *   - The FIRST snapshot in a series is always absolute; the rest are deltas.
 *
 * Adding a new stat field = adding ONE row to FIELDS below.
 */
(function (global) {
  'use strict';

  // [absolute key, delta key]
  const FIELDS = [
    ['likes', 'dl'],
    ['hearts', 'dh'],
    ['laughs', 'dla'],
    ['cries', 'dc'],
    ['comments', 'dco'],
    ['buzz', 'dbu'],
    ['collects', 'dcol'],
    ['views', 'dvi']
  ];

  function emptyValues() {
    const v = {};
    for (const [key] of FIELDS) v[key] = 0;
    return v;
  }

  /**
   * A snapshot is a delta if it carries any delta key (or the zero-change marker).
   */
  function isDelta(snapshot) {
    if (!snapshot) return false;
    if ('_d' in snapshot) return true;
    for (const [, dKey] of FIELDS) {
      if (dKey in snapshot) return true;
    }
    return false;
  }

  function applyDelta(base, snapshot) {
    const next = {};
    for (const [key, dKey] of FIELDS) {
      next[key] = (base[key] || 0) + (snapshot[dKey] || 0);
    }
    return next;
  }

  function readAbsolute(snapshot) {
    const v = {};
    for (const [key] of FIELDS) {
      v[key] = snapshot[key] || 0;
    }
    return v;
  }

  /**
   * Resolve every snapshot in a series to absolute values.
   * Returns new objects: { timestamp, likes, hearts, ... } — extra properties on
   * the stored snapshots (e.g. imageCount) are NOT carried over.
   */
  function resolveAll(snapshots) {
    if (!snapshots || snapshots.length === 0) return [];
    const result = [];
    let current = emptyValues();
    for (const s of snapshots) {
      current = isDelta(s) ? applyDelta(current, s) : readAbsolute(s);
      result.push({ timestamp: s.timestamp, ...current });
    }
    return result;
  }

  /**
   * Resolve the snapshot at `index` to absolute values by walking backward to
   * the nearest absolute snapshot and applying deltas forward from there.
   */
  function resolveAt(snapshots, index) {
    let base = emptyValues();
    let startIdx = 0;

    for (let i = index; i >= 0; i--) {
      if (!isDelta(snapshots[i])) {
        base = readAbsolute(snapshots[i]);
        startIdx = i + 1;
        break;
      }
    }

    for (let i = startIdx; i <= index; i++) {
      if (isDelta(snapshots[i])) {
        base = applyDelta(base, snapshots[i]);
      }
    }

    return { timestamp: snapshots[index].timestamp, ...base };
  }

  /**
   * Encode a series of absolute snapshots as deltas.
   * The first element is kept AS-IS (including any extra properties on it);
   * every following element becomes { timestamp, ...non-zero delta keys },
   * or { timestamp, _d: 1 } when nothing changed.
   */
  function encodeAsDeltas(absoluteSnapshots) {
    if (!absoluteSnapshots || absoluteSnapshots.length === 0) return [];
    const result = [absoluteSnapshots[0]];
    for (let i = 1; i < absoluteSnapshots.length; i++) {
      const prev = absoluteSnapshots[i - 1];
      const curr = absoluteSnapshots[i];
      const delta = { timestamp: curr.timestamp };
      let changed = false;
      for (const [key, dKey] of FIELDS) {
        const diff = (curr[key] || 0) - (prev[key] || 0);
        if (diff) {
          delta[dKey] = diff;
          changed = true;
        }
      }
      if (!changed) {
        delta._d = 1;
      }
      result.push(delta);
    }
    return result;
  }

  /**
   * Per-point gains from a RESOLVED (absolute) series.
   * Each point becomes the difference from the previous point; negative diffs
   * are clamped to 0 (API caching artifacts). The first point is dropped.
   */
  function computeDeltas(resolvedSnapshots) {
    if (!resolvedSnapshots || resolvedSnapshots.length < 2) return [];
    const result = [];
    for (let i = 1; i < resolvedSnapshots.length; i++) {
      const prev = resolvedSnapshots[i - 1];
      const curr = resolvedSnapshots[i];
      const point = { timestamp: curr.timestamp };
      for (const [key] of FIELDS) {
        point[key] = Math.max(0, (curr[key] || 0) - (prev[key] || 0));
      }
      result.push(point);
    }
    return result;
  }

  const SnapshotCodec = {
    FIELDS,
    isDelta,
    resolveAll,
    resolveAt,
    encodeAsDeltas,
    computeDeltas
  };

  // Node (CJS) — scripts/fetch-stats.js imports this file directly
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SnapshotCodec;
  }
  // Browser — stats.js reads the global
  global.SnapshotCodec = SnapshotCodec;
})(typeof globalThis !== 'undefined' ? globalThis : this);
