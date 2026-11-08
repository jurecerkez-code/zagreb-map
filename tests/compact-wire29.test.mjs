import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeRoads2, decodeVeg2, ROADS2_FORMAT, VEG2_FORMAT } from '../web/compact-data.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/compact-wire.json', import.meta.url), 'utf8'));
const bytes = key => {
  const b = Buffer.from(fixture[key], 'hex');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

test('ZGR2 shared bytes preserve way order and exact absolute escapes', () => {
  const doc = { version: 2, format: ROADS2_FORMAT, file: 'roads2.bin.gz', count: 4,
    classes: ['residential', 'service'] };
  const got = decodeRoads2(doc, bytes('zgr2_hex'));
  assert.deepEqual(got.ways.map(w => [w.o, w.c, w.w, w.cls]), [[0, 2, 1.5, 0], [2, 2, 2.25, 1]]);
  assert.deepEqual(Array.from(got.pts), [0, 0, Math.fround(0.1), Math.fround(-0.1),
    Math.fround(0.03), Math.fround(-0.07), 1000, 1000]);
  assert.equal(got.xyz, null);
  assert.throws(() => decodeRoads2(doc, bytes('zgr2_hex').slice(0, -1)), /absolute|length/);
});

test('ZGV2 shared bytes are sorted, carry display dimensions, and sample terrain', () => {
  const doc = { version: 2, format: VEG2_FORMAT, file: 'veg2.bin.gz', count: 2, kind: 'trees',
    height_m: 17.2, radius_m: 5.9, size_quantum_m: 0.25 };
  const got = decodeVeg2(doc, bytes('zgv2_hex'), () => 12.5);
  assert.deepEqual(Array.from(got.trees), [0, 12.5, 0, 1, 12.5, 2]);
  assert.deepEqual(Array.from(got.scales), [Math.fround(62 * 0.25 / 17.2), Math.fround(61 * 0.25 / 17.2)]);
  assert.deepEqual(got.items.map(row => [row.species, row.height, row.radius, row.year]),
    [[-1, 15.5, 5.25, 0], [-1, 15.25, 5.25, 0]]);
  assert.throws(() => decodeVeg2(doc, bytes('zgv2_hex')), /terrain/);
});
