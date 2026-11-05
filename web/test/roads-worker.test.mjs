// The streets' pure geometry (web/roads-worker.js buildRoads): widths per class, joints that stay closed, the
// major-first index layout for the far range, the ground pair per vertex, and triangles that face up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoads, groundAt, CLASSES, EDGE_W, KERB, LIFT } from '../roads-worker.js';

const flatGround = { tAt: () => 0, cutAt: () => 0 };
const of = (t, c) => (() => [t, c]);
const flat = () => of(0, 0);

// A five-point way along +x then down (+z), the turn at the middle point.
function lWay(cls = 'residential', w = 6) {
  const pts = new Float32Array([0, 0, 10, 0, 20, 0, 20, 10, 20, 20]);
  return { pts, ways: [{ o: 0, c: 5, w, cls }] };
}

const yCross = (pos, ia, ib, ic) => {
  const a = [pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]];
  const b = [pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]];
  const c = [pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return u[2] * v[0] - u[0] * v[2];   // y of u x v
};

test('widths: a carriageway carries its pavement band and kerbs, a footway its own width (1.6 m floor)', () => {
  for (const [cls, w, expect] of [['residential', 6, 6 + 2 * (EDGE_W + KERB)], ['footway', 1.0, 1.6], ['footway', 4.0, 4.0]]) {
    const { pts, ways } = lWay(cls, w);
    const out = buildRoads(pts, ways, flat());
    const tile = [...out.tiles.values()][0];
    const half = expect / 2;
    assert.ok(Math.abs(tile.aU[0] - half) < 1e-5, `${cls} half width ${tile.aU[0]} ≈ ${half}`);
    assert.ok(Math.abs(tile.aU[1] + half) < 1e-5);
    // the asphalt half-width travels with the vertex (the fragment bands read it)
    for (const h of tile.aHalf) assert.equal(h, w / 2);
  }
});

test('counts: two vertices per point, two triangles per segment, no wedges at the turn', () => {
  const { pts, ways } = lWay();
  const out = buildRoads(pts, ways, flat());
  const tile = [...out.tiles.values()][0];
  assert.equal(tile.pos.length / 3, 10);          // 5 points x 2 verts
  assert.equal(tile.idx.length, (5 - 1) * 2 * 3); // 4 segments x 2 tris x 3 idx
  assert.equal(out.tris, (5 - 1) * 2);
  // every emitted triangle faces UP (the old clockwise-wound streets vanished from above)
  for (let t = 0; t < tile.idx.length; t += 3) assert.ok(yCross(tile.pos, tile.idx[t], tile.idx[t + 1], tile.idx[t + 2]) > 0, `tri ${t / 3} up`);
  // the turn's shared edge is ONE vertex pair: quad i's end verts (2i+2, 2i+3) are quad i+1's start verts, so the
  // boundary at each point of the way is a single shared edge and never a gap or an overlap
  for (let i = 0; i < 3; i++) {
    const quad = Array.from(tile.idx.slice(i * 6, i * 6 + 6)), next = Array.from(tile.idx.slice(i * 6 + 6, i * 6 + 12));
    for (const edge of [2 * i + 2, 2 * i + 3]) {
      assert.ok(quad.includes(edge) && next.includes(edge), `edge vertex ${edge} shared`);
    }
  }
});

test('classes: major ways lead the index so the far range draws only them', () => {
  const { pts } = lWay();
  const ways = [
    { o: 0, c: 5, w: 6, cls: 'residential' },      // minor: body of the tile
    { o: 0, c: 5, w: 6, cls: 'primary' },          // major: must come first in the index
  ];
  const out = buildRoads(pts, ways, flat());
  const tile = [...out.tiles.values()][0];
  assert.equal(tile.hiCount, (5 - 1) * 2 * 3, 'primary alone in the first range');
  assert.equal(tile.idx.length / 3, 16, 'all classes in the full index');
  // and the class index of residences sits where CLASSES puts it
  const cI = CLASSES.indexOf('primary');
  for (const c of tile.aCls) assert.ok(c === cI || c === CLASSES.indexOf('residential'));
});

test('ground pair: exactly the point\'s (t, cut) — the issue\'s 0.3 m relief test reads surfaceAt, nothing else', () => {
  const g = { tAt: (x, z) => x + z / 10, cutAt: (x, z) => x / 2 };
  for (const [x, z] of [[10, 0], [-1000, -1000], [42.5, 7.25]]) {
    const [t, c] = groundAt(g, x, z);
    assert.equal(t, g.tAt(x, z));
    assert.equal(c, g.cutAt(x, z));
  }
});

test('triangle count per way matches the spec: 2 * (n - 1), ways with <2 points skipped', () => {
  const pts = new Float32Array([0, 0, 10, 0, 20, 0, 30, 0]);
  const out = buildRoads(pts, [{ o: 0, c: 4, w: 6, cls: 'primary' }, { o: 2, c: 1, w: 6, cls: 'primary' }], flat());
  assert.equal(out.tris, 6);
  assert.equal(out.ways, 1);
});

test('LIFT stays a shader-side constant here (positions do not bake it)', () => {
  const { pts, ways } = lWay();
  const out = buildRoads(pts, ways, () => [55, 1]);
  const tile = [...out.tiles.values()][0];
  for (let i = 1; i < tile.pos.length; i += 3) assert.equal(tile.pos[i], 0, 'y stays 0; the vertex shader lifts');
  for (const t of tile.aT) assert.equal(t, 55);
});
