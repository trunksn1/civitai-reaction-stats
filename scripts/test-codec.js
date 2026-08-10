/**
 * Tests for the shared snapshot codec (extension/lib/snapshot-codec.js).
 * Plain node asserts, no framework. Run: node test-codec.js  (or npm test)
 */
import assert from 'node:assert/strict';
import SnapshotCodec from '../extension/lib/snapshot-codec.js';

const { FIELDS, isDelta, resolveAll, resolveAt, encodeAsDeltas, computeDeltas } = SnapshotCodec;

function abs(timestamp, values = {}) {
  const s = { timestamp };
  for (const [key] of FIELDS) s[key] = values[key] || 0;
  return s;
}

// --- isDelta ---------------------------------------------------------------
assert.equal(isDelta(null), false, 'null is not a delta');
assert.equal(isDelta({ timestamp: 't', likes: 5 }), false, 'absolute is not a delta');
assert.equal(isDelta({ timestamp: 't', dl: 1 }), true, 'dl marks a delta');
assert.equal(isDelta({ timestamp: 't', dvi: 2 }), true, 'dvi marks a delta');
assert.equal(isDelta({ timestamp: 't', _d: 1 }), true, '_d marks a zero-change delta');

// --- resolveAll ------------------------------------------------------------
assert.deepEqual(resolveAll(null), [], 'resolveAll(null) is []');
assert.deepEqual(resolveAll([]), [], 'resolveAll([]) is []');

const series = [
  abs('t1', { likes: 10, hearts: 5 }),
  { timestamp: 't2', dl: 2, dh: 1 },
  { timestamp: 't3', _d: 1 },
  { timestamp: 't4', dl: -1, dbu: 100 } // negative deltas are legal (clamp resets)
];
const resolved = resolveAll(series);
assert.equal(resolved.length, 4);
assert.equal(resolved[0].likes, 10);
assert.equal(resolved[1].likes, 12);
assert.equal(resolved[1].hearts, 6);
assert.equal(resolved[2].likes, 12, '_d snapshot changes nothing');
assert.equal(resolved[3].likes, 11, 'negative delta applies');
assert.equal(resolved[3].buzz, 100);
assert.equal(resolved[3].timestamp, 't4');

// An absolute snapshot mid-series resets the running values
const resetSeries = [
  abs('t1', { likes: 10 }),
  { timestamp: 't2', dl: 5 },
  abs('t3', { likes: 3 }), // absolute overrides accumulated 15
  { timestamp: 't4', dl: 1 }
];
const resetResolved = resolveAll(resetSeries);
assert.equal(resetResolved[2].likes, 3, 'mid-series absolute resets');
assert.equal(resetResolved[3].likes, 4);

// --- resolveAt -------------------------------------------------------------
assert.equal(resolveAt(series, 0).likes, 10);
assert.equal(resolveAt(series, 3).likes, 11);
assert.equal(resolveAt(resetSeries, 3).likes, 4, 'resolveAt walks back to nearest absolute');
for (let i = 0; i < series.length; i++) {
  assert.deepEqual(resolveAt(series, i), resolved[i], `resolveAt(${i}) matches resolveAll`);
}

// --- encodeAsDeltas + round trip --------------------------------------------
assert.deepEqual(encodeAsDeltas([]), []);
assert.deepEqual(encodeAsDeltas(null), []);

const absolutes = [
  abs('t1', { likes: 10, hearts: 5 }),
  abs('t2', { likes: 12, hearts: 5 }),
  abs('t3', { likes: 12, hearts: 5 }), // unchanged -> _d marker
  abs('t4', { likes: 11, hearts: 9, views: 3 })
];
const encoded = encodeAsDeltas(absolutes);
assert.equal(encoded[0].likes, 10, 'first stays absolute');
assert.equal(encoded[1].dl, 2);
assert.equal('dh' in encoded[1], false, 'zero diffs omitted');
assert.equal(encoded[2]._d, 1, 'zero-change snapshot gets _d marker');
assert.equal(encoded[3].dl, -1, 'decreases encode as negative deltas');
assert.equal(encoded[3].dh, 4);
assert.equal(encoded[3].dvi, 3);

const roundTrip = resolveAll(encoded);
for (let i = 0; i < absolutes.length; i++) {
  for (const [key] of FIELDS) {
    assert.equal(roundTrip[i][key], absolutes[i][key], `round trip [${i}].${key}`);
  }
  assert.equal(roundTrip[i].timestamp, absolutes[i].timestamp);
}

// First element keeps extra properties (main() relies on this for imageCount)
const withExtra = [{ ...abs('t1', { likes: 1 }), imageCount: 42 }, abs('t2', { likes: 2 })];
assert.equal(encodeAsDeltas(withExtra)[0].imageCount, 42, 'extra props on first element survive');

// --- computeDeltas -----------------------------------------------------------
assert.deepEqual(computeDeltas(null), []);
assert.deepEqual(computeDeltas([abs('t1')]), [], 'single point has no deltas');

const gains = computeDeltas([
  abs('t1', { likes: 10 }),
  abs('t2', { likes: 14, hearts: 2 }),
  abs('t3', { likes: 13 }) // decrease -> clamped to 0
]);
assert.equal(gains.length, 2, 'first point dropped');
assert.equal(gains[0].likes, 4);
assert.equal(gains[0].hearts, 2);
assert.equal(gains[1].likes, 0, 'negative diff clamped to 0');
assert.equal(gains[1].timestamp, 't3');

// --- unknown keys are tolerated ----------------------------------------------
const foreign = resolveAll([{ timestamp: 't1', likes: 5, someFutureField: 9 }]);
assert.equal(foreign[0].likes, 5, 'unknown keys ignored, no crash');

console.log('All snapshot codec tests passed ✓');
