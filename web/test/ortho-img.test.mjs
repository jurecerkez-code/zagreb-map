import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHDRGrid, decodeRGBAHeader, loadOrthoData } from '../ortho-img.js';

const one = (rgb, slope = 0, spatial = [0, 0, 30]) => {
  const b = new ArrayBuffer(18), v = new DataView(b);
  spatial.forEach((x, i) => v.setInt32(i * 4, x, true));
  rgb.forEach((x, i) => v.setUint8(12 + i, x));
  v.setUint8(15, 1); v.setUint16(16, slope, true);
  return b;
};
const view = () => {
  const doc = { version: 2, format: 'zagreb-ground2', file: 'ground0.bin', w: 2, h: 1, x0: 0, z0: 0, cell: 40,
    palette: [{ index: 1, name: 'city orthophoto' }], count: 2 };
  const buf = new ArrayBuffer(36);
  new Uint8Array(buf).set(new Uint8Array(one([1, 2, 3])), 0);
  new Uint8Array(buf).set(new Uint8Array(one([4, 5, 6], 12345, [400, 0, 30])), 18);
  return { doc, buf };
};

test('HDR ground grid retains exact measured RGB and returns bound annotations', () => {
  const { doc, buf } = view();
  const got = decodeHDRGrid(doc, buf);
  assert.deepEqual([...got.rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.equal(got.slope[1], 12.345);
  for (const patch of [{ count: 3 }, { w: 3 }, { x0: 1 }, { version: 1 },
    { palette: [{ index: 0, name: 'an invented source' }] }]) {
    assert.throws(() => decodeHDRGrid({ ...doc, ...patch }, buf), /grid|palette|format|count/);
  }
  assert.throws(() => decodeHDRGrid(doc, buf.slice(0, 35)), /length/);
});

test('legacy RGBA is still accepted, including alpha=0 for an unsampled building', () => {
  const b = new ArrayBuffer(16), v = new DataView(b);
  v.setUint32(0, 2, true); v.setUint32(4, 1, true);
  new Uint8Array(b).set([1, 2, 3, 0, 4, 5, 6, 255], 8);
  const got = decodeRGBAHeader(b);
  assert.deepEqual([got.w, got.h], [2, 1]);
  assert.deepEqual([...got.rgba], [1, 2, 3, 0, 4, 5, 6, 255]);
  assert.throws(() => decodeRGBAHeader(b.slice(0, 15)), /length/);
});

test('foto loader picks only names in this exact version, never a speculative ground2 fetch', async () => {
  const legacy = new ArrayBuffer(16), legacyView = new DataView(legacy);
  legacyView.setUint32(0, 2, true); legacyView.setUint32(4, 1, true);
  new Uint8Array(legacy).set([1, 2, 3, 0, 4, 5, 6, 255], 8);
  const grid = view();
  // One function below makes ground fixtures; name the buffer separately from the DataView above.
  const source = grid.buf;
  const files = new Map([['roof_rgb.bin', legacy], ['ground_rgb.bin', legacy],
    ['ground2.json', JSON.stringify(grid.doc)], ['ground0.bin', source]]);
  async function run(config) {
    const requested = [];
    const fetchImpl = async name => {
      requested.push(name.replace('base/', ''));
      const body = files.get(name.replace('base/', ''));
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    };
    return { requested, result: await loadOrthoData('base/', config, fetchImpl) };
  }
  const old = await run({});
  assert.deepEqual(old.requested, ['roof_rgb.bin', 'ground_rgb.bin']);
  assert.equal(old.result.roof.rgba[3], 0);
  const fresh = await run({ ground2: 'ground2.json' });
  assert.deepEqual(fresh.requested, ['roof_rgb.bin', 'ground2.json', 'ground0.bin']);
  assert.deepEqual([...fresh.result.ground.rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
});
