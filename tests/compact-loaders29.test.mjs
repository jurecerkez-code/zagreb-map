import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { loadStreetData } from '../web/roads-layer.js';
import { loadVegetationData } from '../web/veg.js';
import { loadOrthoData } from '../web/ortho-img.js';
import { ROADS2_FORMAT, VEG2_FORMAT } from '../web/compact-data.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/compact-wire.json', import.meta.url), 'utf8'));
const bytes = key => Buffer.from(fixture[key], 'hex');
const gz = raw => gzipSync(Buffer.from(raw));

function rgba(r, g, b, a = 255) {
  const raw = Buffer.alloc(12);
  raw.writeUint32LE(1, 0); raw.writeUint32LE(1, 4);
  raw.set([r, g, b, a], 8);
  return raw;
}

test('runtime loads only the specified gzip roads, trees and RGB names without JSON sidecars', async () => {
  const roads = { version: 2, format: ROADS2_FORMAT, file: 'roads2.bin.gz', nWays: 2, count: 4,
    classes: ['residential', 'service'], groups: [] };
  const veg = { version: 2, format: VEG2_FORMAT, file: 'veg2.bin.gz', count: 2, kind: 'trees',
    metresPerScale: 11.8, height_m: 17.2, radius_m: 5.9, size_quantum_m: 0.25, speciesNames: [],
    green: { mask: { w: 1, h: 1, x0: 0, z0: 0, cell: 16 }, classes: ['grass'] } };
  const payloads = new Map([
    ['roads2.bin.gz', gz(bytes('zgr2_hex'))], ['lamps.bin.gz', gz(new Float32Array([1, 2]).buffer)],
    ['veg2.bin.gz', gz(bytes('zgv2_hex'))], ['veg_mask.bin.gz', gz(new Uint8Array([1]))],
    ['roof_rgb.bin.gz', gz(rgba(10, 20, 30))], ['ground_rgb.bin.gz', gz(rgba(30, 40, 50))],
  ]);
  const requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    requests.push(url);
    const name = url.split('/').pop();
    if (!payloads.has(name)) return new Response(null, { status: 404 });
    return new Response(payloads.get(name));
  };
  try {
    const street = await loadStreetData('/data/v1/', { roads2: roads });
    const pts = Array.from(street.pts);
    assert.deepEqual(pts.slice(0, 6), [0, 0, Math.fround(0.1), Math.fround(-0.1),
      Math.fround(0.03), Math.fround(-0.07)]);
    assert.ok(Math.abs(pts[6] - 1000) <= 0.05 && Math.abs(pts[7] - 1000) <= 0.05,
      `the far corner stays on its decimetre grid, got ${pts[6]}, ${pts[7]}`);
    assert.deepEqual(street.meta.ways.map(way => way.cls), ['residential', 'service']);
    const trees = await loadVegetationData('/data/v1/', { veg2: veg }, () => 12.5);
    assert.deepEqual(Array.from(trees.trees), [0, 12.5, 0, 1, 12.5, 2]);
    const photos = await loadOrthoData('/data/v1/', { orthoGz: true });
    assert.deepEqual(Array.from(photos.roof.rgba), [10, 20, 30, 255]);
    assert.deepEqual(Array.from(photos.ground.rgba), [30, 40, 50, 255]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests.map(url => url.split('/').pop()).sort(), [...payloads.keys()].sort());
});
