import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadStreetData } from '../roads-layer.js';
import { loadVegetationData } from '../veg.js';

const bytes = new Uint8Array(28), dv = new DataView(bytes.buffer);
dv.setUint32(0, 2, true);
[10, -20, 30, 11, -21, 31].forEach((v, i) => dv.setInt32(4 + i * 4, v, true));
const road2 = { version: 2, format: 'zagreb-roads2', file: 'roads0.bin', classes: ['residential'], names: [],
  ways: [{ id: 4300000000, cls: 0, name: -1, w: 65, n: 2 }], count: 2 };

async function mocked(files, fn) {
  const requested = [];
  const old = globalThis.fetch;
  globalThis.fetch = async url => {
    const key = String(url).replace('base/', '');
    requested.push(key);
    if (!files.has(key)) return new Response(null, { status: 404 });
    return new Response(files.get(key));
  };
  try { return { requested, result: await fn() }; } finally { globalThis.fetch = old; }
}

test('roads old schema and exact-current-config roads2, with no speculative old request', async () => {
  const oldMeta = { classes: ['residential'], ways: [{ o: 0, c: 1, cls: 'residential', w: 6.5 }], lamps: {} };
  const map = new Map([
    ['roads.json', JSON.stringify(oldMeta)], ['roads2.json', JSON.stringify(road2)],
    ['roads.bin.gz', gzipSync(new Uint8Array(new Float32Array([1, 2]).buffer))],
    ['roads0.bin', bytes], ['lamps.bin.gz', gzipSync(new Uint8Array(new Float32Array([3, 4]).buffer))],
  ]);
  const old = await mocked(map, () => loadStreetData('base/', {}));
  assert.deepEqual(old.requested, ['roads.json', 'roads.bin.gz', 'lamps.bin.gz']);
  assert.deepEqual([...old.result.pts], [1, 2]);
  assert.deepEqual(old.result.meta.ways, oldMeta.ways);
  const fresh = await mocked(map, () => loadStreetData('base/', { roads2: 'roads2.json' }));
  assert.deepEqual(fresh.requested, ['roads2.json', 'roads0.bin', 'lamps.bin.gz']);
  assert.deepEqual([...fresh.result.pts], [1, -2, Math.fround(1.1), Math.fround(-2.1)]);
  assert.equal(fresh.result.meta.ways[0].id, 4300000000);
  assert.deepEqual([...fresh.result.xyz], [1, 3, -2, 1.1, 3.1, -2.1]);
  assert.deepEqual([...fresh.result.lampPts], [3, 4]);
});

test('roads2 never falls to another version or escapes the version directory', async () => {
  const bad = { ...road2, file: '../secret' };
  await assert.rejects(mocked(new Map([['roads2.json', JSON.stringify(bad)]]),
    () => loadStreetData('base/', { roads2: 'roads2.json' })), /file|ortho|format/);
});

test('vegetation old fallback and compact record loading keep masks and display scales', async () => {
  const meta = { trees: { count: 1 }, green: { mask: { w: 1, h: 1, x0: 0, z0: 0, cell: 16 } }, cable: null };
  const doc = { ...meta, version: 2, format: 'zagreb-veg2', file: 'veg0.bin', count: 1, kind: 'trees',
    metresPerScale: 11.8, speciesByItem: [-1], speciesNames: [] };
  const v = new DataView(new ArrayBuffer(18));
  [100, -200, 30].forEach((x, i) => v.setInt32(i * 4, x, true));
  v.setFloat32(12, 0.88, true); v.setUint16(16, 0, true);
  const files = new Map([
    ['veg.json', JSON.stringify(meta)], ['veg2.json', JSON.stringify(doc)],
    ['veg_trees.bin', new Float32Array([1, 2, 3]).buffer], ['veg0.bin', v.buffer],
    ['veg_mask.bin.gz', gzipSync(Uint8Array.of(2))],
  ]);
  const old = await mocked(files, () => loadVegetationData('base/', {}));
  assert.deepEqual(old.requested, ['veg.json', 'veg_trees.bin', 'veg_mask.bin.gz']);
  assert.deepEqual([...old.result.trees], [1, 2, 3]);
  assert.equal(old.result.scales, null);
  assert.deepEqual([...old.result.mask], [2]);
  const fresh = await mocked(files, () => loadVegetationData('base/', { veg2: 'veg2.json' }));
  assert.deepEqual(fresh.requested, ['veg2.json', 'veg0.bin', 'veg_mask.bin.gz']);
  assert.deepEqual([...fresh.result.trees], [10, 3, -20]);
  assert.deepEqual([...fresh.result.scales], [Math.fround(0.88)]);
  assert.equal(fresh.result.items[0].year, 0);
  assert.equal(fresh.result.items[0].species, -1);
});
