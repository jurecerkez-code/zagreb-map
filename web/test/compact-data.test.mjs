import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseDataFile, decodeRoads2, decodeVeg2, decodeHDR18, decodeUTF16, legacyError,
} from '../compact-data.js';

const le = (type, values) => {
  const view = new DataView(new ArrayBuffer(values.length * type.BYTES_PER_ELEMENT));
  const put = type === Uint32Array ? 'setUint32' : type === Int32Array ? 'setInt32'
    : type === Uint16Array ? 'setUint16' : 'setFloat32';
  values.forEach((v, i) => view[put](i * type.BYTES_PER_ELEMENT, v, true));
  return view.buffer;
};
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
  return out.buffer;
};

test('exact version config selects compact names, old configs need no new request', () => {
  assert.equal(chooseDataFile({ roads2: 'roads2.json' }, 'roads2', 'roads.json', 'roads2.json'), 'roads2.json');
  for (const cfg of [{}, { roads2: true }, { roads2: 'other.json' }, null]) {
    assert.equal(chooseDataFile(cfg, 'roads2', 'roads.json', 'roads2.json'), 'roads.json');
  }
});

test('roads2 decodes little-endian count/xyz dm and preserves a full-width way id', () => {
  const doc = { version: 2, format: 'zagreb-roads2', file: 'roads0.bin',
    classes: ['primary', 'residential'], names: ['Ilica'],
    ways: [{ id: 4300000000, name: 0, cls: 1, w: 65, n: 2 }, { id: 65, name: -1, cls: 0, w: 100, n: 1 }], count: 3 };
  const xyz = le(Int32Array, [100, -30, 20, 101, -29, 21, 110, -31, 30]);
  const bytes = concat([le(Uint32Array, [2]), xyz.slice(0, 24), le(Uint32Array, [1]), xyz.slice(24)]);
  const got = decodeRoads2(doc, bytes);
  assert.deepEqual(got.ways, [{ o: 0, c: 2, cls: 'residential', w: 6.5, id: 4300000000, name: 'Ilica' },
    { o: 2, c: 1, cls: 'primary', w: 10, id: 65, name: -1 }]);
  assert.deepEqual([...got.pts], [10, -3, Math.fround(10.1), Math.fround(-2.9), 11, Math.fround(-3.1)]);
  assert.deepEqual([...got.xyz], [10, 2, -3, 10.1, 2.1, -2.9, 11, 3, -3.1]);
  assert.ok(legacyError([10.1, -2.9], [101, -29]) < 0.1);
  assert.throws(() => decodeRoads2(doc, bytes.slice(0, bytes.byteLength - 1)), /length/);
  assert.throws(() => decodeRoads2(doc, bytes.slice(1)), /length|aligned/);
  assert.throws(() => decodeRoads2(doc, concat([le(Uint32Array, [0xFFFFFFFF]), xyz])), /length/);
  assert.throws(() => decodeRoads2(doc, bytes.slice(0, 27)), /length/);
});

test('veg2 decodes 18-byte records; unknown attribute sentinels are not fabricated measurements', () => {
  const doc = { version: 2, format: 'zagreb-veg2', file: 'veg0.bin', green: { mask: {} },
    kind: 'trees', speciesByItem: [-1, 2], speciesNames: ['', '', 'Quercus robur'], count: 2, metresPerScale: 11.8 };
  // Records are contiguous: x/z/y, scale and year, never a columnar concatenation.
  const interleaved = new ArrayBuffer(36), view = new DataView(interleaved);
  const rows = [[100025, -5000, 1780, 0.88, 0], [10010, -4975, 1800, 1, 2024]];
  rows.forEach((r, i) => {
    r.slice(0, 3).forEach((v, j) => view.setInt32(i * 18 + j * 4, v, true));
    view.setFloat32(i * 18 + 12, r[3], true);
    view.setUint16(i * 18 + 16, r[4], true);
  });
  const got = decodeVeg2(doc, interleaved);
  assert.deepEqual([...got.trees], [10002.5, 178, -500, 1001, 180, -497.5]);
  assert.deepEqual([...got.scales], [Math.fround(rows[0][3]), rows[1][3]]);
  assert.deepEqual(got.items.map(i => [i.kind, i.species, i.year]),
    [['trees', -1, 0], ['trees', 'Quercus robur', 2024]]);
  assert.ok(Math.abs(got.items[0].width - Math.fround(0.88) * 11.8) < 1e-6);
  assert.equal(got.items[1].width, 11.8);
  assert.equal(got.meta, doc);
  assert.throws(() => decodeVeg2(doc, interleaved.slice(0, 35)), /length/);
});

test('HDR18 and UTF16 check coordinates, bounds and exact input lengths', () => {
  const hdr = new ArrayBuffer(18), v = new DataView(hdr);
  [12, -23, 134].forEach((x, i) => v.setInt32(i * 4, x, true));
  [1, 2, 3].forEach((x, i) => v.setUint8(12 + i, x));
  v.setUint8(15, 1); v.setUint16(16, 12345, true);
  assert.deepEqual(decodeHDR18(hdr), [{ x: 1.2, z: -2.3, y: 13.4,
    r: 1, g: 2, b: 3, ortho: 1, slope: 12.345 }]);
  assert.throws(() => decodeHDR18(hdr.slice(0, 17)), /length/);
  const utf = le(Uint16Array, [1, 0, 1, 12346, 0, 45000]);
  assert.deepEqual(decodeUTF16(utf), [{ ortho: 1, slope: 0 }, { ortho: 1, slope: 12.346 }, { ortho: 0, slope: 45 }]);
  assert.throws(() => decodeUTF16(le(Uint16Array, [0, 45001])), /slope/);
  assert.throws(() => decodeUTF16(new ArrayBuffer(3)), /length/);
  assert.ok(legacyError([0.99, -0.99], [10, -10]) < 0.1);
  assert.ok(legacyError([1, -1], [12, -12]) >= 0.1);
});
