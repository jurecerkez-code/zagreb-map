// Issue #27's building-side test (web/worker.js): ring normalisation and pinned roof winding, proven on a unit
// square, a square with a courtyard hole, and both possible input orientations.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let build;
before(async () => {
  globalThis.self ??= {};   // worker.js sets self.onmessage when it loads
  ({ build } = await import('../worker.js'));
});

// A single building with one part: an exterior square d decimetres across (decimetre ints) plus an optional
// courtyard square, each ring possibly wound 'pos' (its xz-chart shoelace sum > 0) or 'neg' (< 0) on arrival.
function squareTile({ d = 100, inner = 40, hole = false, extWay = 'pos', holeWay = 'pos', heightM = 3 } = {}) {
  const sum = pts => pts.reduce((s, [x, z], i) => { const [x2, z2] = pts[(i + 1) % pts.length]; return s + x * z2 - x2 * z; }, 0);
  const flip = pts => [...pts].reverse();
  const wind = (pts, way) => (way === 'pos' ? sum(pts) > 0 : sum(pts) < 0) ? pts : flip(pts);
  const ext = wind([[0, 0], [d, 0], [d, d], [0, d]], extWay);
  const rings = [ext];
  const holeFlag = [0];
  if (hole) { rings.push(wind([[inner, inner], [d - inner, inner], [d - inner, d - inner], [inner, d - inner]], holeWay)); holeFlag.push(1); }
  const nR = rings.length, verts = rings.flat(2);
  return {
    nB: 1,
    partStart: new Uint32Array([0, 1]),            // nB + 1
    ringStart: new Uint32Array([0, nR]),           // nP + 1
    hole: new Uint8Array(holeFlag),                // nR
    vertStart: new Uint32Array(nR === 1 ? [0, 4] : [0, 4, 8]),  // nR + 1
    xz: new Int16Array(verts),
    height: new Float32Array([heightM]),           // metres per part (build multiplies by 10)
    year: new Float32Array([1900]), period: new Float32Array([1]), floors: new Float32Array([2]),
    gid: new Float32Array([7]), yflag: new Float32Array([0]), lay0: new Uint32Array([0]), lay1: new Uint32Array([0]),
    ground: new Float32Array([0]),
    origin: [0, 0],
  };
}

const triNormal = (pos, i0, i1, i2) => {
  const u = [pos[3 * i1] - pos[3 * i0], pos[3 * i1 + 1] - pos[3 * i0 + 1], pos[3 * i1 + 2] - pos[3 * i0 + 2]];
  const v = [pos[3 * i2] - pos[3 * i0], pos[3 * i2 + 1] - pos[3 * i0 + 1], pos[3 * i2 + 2] - pos[3 * i0 + 2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};
const edgeMid = (pos, i0, i1) => [(pos[3 * i0] + pos[3 * i1]) / 2, (pos[3 * i0 + 2] + pos[3 * i1 + 2]) / 2];

test('walls out, whoever writes the ring: every wall normal of the square points away from its footprint', () => {
  for (const extWay of ['pos', 'neg']) {
    const t = squareTile({ extWay });
    const out = build(t);
    const nEdge = 4;
    assert.equal(out.idx.length / 3, nEdge * 2 + 2, 'four wall quads + two roof triangles');
    const c = 50;
    for (let q = 0; q < nEdge; q++) {
      for (const half of [q * 6, q * 6 + 3]) {
        const n = triNormal(out.pos, out.idx[half], out.idx[half + 1], out.idx[half + 2]);
        const m = edgeMid(out.pos, out.idx[half], out.idx[half + 1]);
        const away = n[0] * (m[0] - c) + n[2] * (m[1] - c);
        assert.ok(away > 0, `wall ${q} normal points inward (${extWay})`);
      }
    }
  }
});

test('hole walls face the courtyard: flipped hole rings, not flipped exterior', () => {
  for (const [extWay, holeWay] of [['pos', 'pos'], ['neg', 'neg'], ['neg', 'pos']]) {
    const t = squareTile({ hole: true, extWay, holeWay });
    const out = build(t);
    // eight wall quads: the outer square first, then the hole's four (ts.hole marks order)
    const c = 50;
    for (let q = 0; q < 8; q++) {
      const n = triNormal(out.pos, out.idx[q * 6], out.idx[q * 6 + 1], out.idx[q * 6 + 2]);
      const m = edgeMid(out.pos, out.idx[q * 6], out.idx[q * 6 + 1]);
      const away = n[0] * (m[0] - c) + n[2] * (m[1] - c);
      if (q < 4) assert.ok(away > 0, `exterior wall ${q} in (${extWay}/${holeWay})`);
      else assert.ok(away < 0, `hole wall ${q} should face the courtyard (${extWay}/${holeWay})`);
    }
  }
});

test("every roof triangle's normal climbs (+y), whatever the input winding", () => {
  for (const [hole, extWay, holeWay] of [[false, 'pos', 'pos'], [false, 'neg', 'neg'], [true, 'pos', 'pos'], [true, 'neg', 'neg']]) {
    const t = squareTile({ hole, extWay, holeWay });
    const out = build(t);
    const nWallTris = 8 * (hole ? 2 : 1);
    assert.ok(out.idx.length > nWallTris * 3, 'a roof exists');
    for (let k = nWallTris * 3; k < out.idx.length; k += 3) {
      const n = triNormal(out.pos, out.idx[k], out.idx[k + 1], out.idx[k + 2]);
      assert.ok(n[1] > 0, `roof triangle under ${[hole, extWay, holeWay]} points down`);
    }
  }
});
