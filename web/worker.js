// Turns one binary tile into an extruded mesh. Positions stay in decimetres from the tile origin.
import { ShapeUtils, Vector2 } from './vendor/three.core.js';
import { parse, ATTR_FLOATS } from './tile.js';

// In decimetres a 500 m block's winding sum can pass 2^31 — always use float doubles here.
const shoelace2 = (xz, s, e) => {
  let sum = 0;
  for (let i = s; i < e; i++) {
    const j = i + 1 === e ? s : i + 1;
    sum += xz[2 * i] * xz[2 * j + 1] - xz[2 * j] * xz[2 * i + 1];
  }
  return sum;
};
// Issue #27: ring winding is not normalised. The walls the quad order emits face OUT of the footprint exactly when
// an exterior ring reads negative area, and point into the courtyard when a hole reads positive. If a tile comes
// the other way (or mixed, as some land), write it out again reversed — anything else and FrontSide culls wrong.
function normaliseRing(xz, r, hole, vertStart) {
  const s = vertStart[r], e = vertStart[r + 1], n = e - s;
  if (n < 3) return;
  const area = shoelace2(xz, s, e);
  const wrong = hole ? area < 0 : area > 0;
  if (!wrong || area === 0) return;
  for (let i = 0; i < n >> 1; i++) {
    const a = s + i, b = s + (n - 1 - i);
    for (let k = 0; k < 2; k++) { const t = xz[2 * a + k]; xz[2 * a + k] = xz[2 * b + k]; xz[2 * b + k] = t; }
  }
}

// Exported for web/test/worker.test.mjs; the page only talks to the worker through messages.
export function build(t) {
  if (t.v === 2 && t.roofs?.some(Boolean)) return buildV2(t);
  return buildV1(t);
}

function writeAttrs(t, pos, bld, idx, top) {
  const attr = new Float32Array(t.nB * ATTR_FLOATS);
  let gMin = Infinity, gMax = -Infinity;
  for (let b = 0; b < t.nB; b++) {
    attr.set([t.year[b], t.period[b] + 16 * t.yflag[b], t.floors[b], t.gid[b],
      t.lay0[b] & 0xffff, t.lay0[b] >>> 16, t.lay1[b] & 0xffff, t.lay1[b] >>> 16, t.ground[b], 0, 0, 0], b * ATTR_FLOATS);
    gMin = Math.min(gMin, t.ground[b]); gMax = Math.max(gMax, t.ground[b]);
  }
  return { pos, bld, idx, attr, origin: t.origin, nB: t.nB, gMin: t.nB ? gMin : 0, gMax: t.nB ? gMax : 0, top };
}

function buildV1(t) {
  let nVert = 0, nIdx = 0;
  for (let r = 0; r < t.hole.length; r++) {
    const n = t.vertStart[r + 1] - t.vertStart[r];
    // Walls: 4 vertices and 6 indices per edge. Roof: n vertices and one triangle per vertex, plus 2h - 2 for a
    // ring with h holes, so 3n indices plus 6 per ring always suffice.
    nVert += n * 5; nIdx += n * 9 + 6;
  }
  const pos = new Int16Array(nVert * 3), bld = new Uint16Array(nVert), idx = new Uint32Array(nIdx);
  let v = 0, k = 0;
  for (let b = 0; b < t.nB; b++) {
    // Every part of building b (its footprint, then any laser tower) gets bld = b: one building to the shader,
    // the picker and the highlight
    for (let p = t.partStart[b]; p < t.partStart[b + 1]; p++) {
      const roof = Math.round(t.height[p] * 10);   // decimetres
      const r0 = t.ringStart[p], r1 = t.ringStart[p + 1];
      const shapes = []; // one roof per exterior ring: a MultiPolygon part has several
      // Walls
      for (let r = r0; r < r1; r++) {
        normaliseRing(t.xz, r, t.hole[r], t.vertStart);
        const s = t.vertStart[r], e = t.vertStart[r + 1], n = e - s;
        const ring = [];
        for (let i = 0; i < n; i++) {
          const a = s + i, c = s + ((i + 1) % n);
          const ax = t.xz[2 * a], az = t.xz[2 * a + 1], cx = t.xz[2 * c], cz = t.xz[2 * c + 1];
          pos.set([ax, 0, az, cx, 0, cz, cx, roof, cz, ax, roof, az], v * 3);
          bld.fill(b, v, v + 4);
          idx.set([v, v + 1, v + 2, v, v + 2, v + 3], k);
          v += 4; k += 6;
          ring.push(new Vector2(ax, az));
        }
        if (!t.hole[r]) shapes.push({ contour: ring, holes: [] });
        else if (shapes.length) shapes[shapes.length - 1].holes.push(ring);
      }
      // Roofs
      for (const { contour, holes } of shapes) {
        const roofStart = v;
        for (const pt of contour.concat(...holes)) { pos.set([pt.x, roof, pt.y], v * 3); bld[v] = b; v++; }
        for (const tri of ShapeUtils.triangulateShape(contour, holes)) {
          // The normals the pick and the sun both read from the winding: with the ring normalised the triangulator
          // is free to reverse a ring (it does — ShapeUtils flips CW contours), so lose the guess: every roof
          // triangle's normal must climb (+y) or it is wound the wrong way once the map culls back faces (#27).
          const [a, b2, c] = tri.map(i => roofStart + i);
          let [t0, t1, t2] = [a, b2, c];
          const ux = pos[3 * t1] - pos[3 * t0], uz = pos[3 * t1 + 2] - pos[3 * t0 + 2];
          const vx = pos[3 * t2] - pos[3 * t0], vz = pos[3 * t2 + 2] - pos[3 * t0 + 2];
          if (uz * vx - ux * vz < 0) { const d = t1; t1 = t2; t2 = d; }   // wrong way round: flip, not hide
          idx.set([t0, t1, t2], k); k += 3;
        }
      }
    }
  }
  let top = 0;
  for (let p = 0; p < t.height.length; p++) top = Math.max(top, Math.round(t.height[p] * 10));
  return writeAttrs(t, pos.subarray(0, v * 3), bld.subarray(0, v), idx.subarray(0, k), top);
}

// Issue #32: a v2 building carries its real LoD2 roof triangles. The near mesh keeps the walls and puts those
// triangles on top; the flat roof is kept only for the far LOD, where a pitched roof is below a pixel. The near
// index also fills the gable ends: every roof edge that lies on the boundary (used by one triangle) and climbs
// gets one vertical triangle down to its lower end, so a gable end is closed rather than open to the sky.
function buildV2(t) {
  let v1Verts = 0, v1Idx = 0, extraVerts = 0, extraIdx = 0;
  for (let r = 0; r < t.hole.length; r++) {
    const n = t.vertStart[r + 1] - t.vertStart[r];
    v1Verts += n * 5; v1Idx += n * 9 + 6;
  }
  for (let b = 0; b < t.nB; b++) {
    const r = t.roofs[b];
    if (!r) continue;
    extraVerts += r.rxz.length / 2;
    extraIdx += r.rtri.length;
    const edges = new Map();
    for (let i = 0; i < r.rtri.length; i += 3) {
      for (const [a, c] of [[r.rtri[i], r.rtri[i + 1]], [r.rtri[i + 1], r.rtri[i + 2]], [r.rtri[i + 2], r.rtri[i]]]) {
        const key = a < c ? `${a},${c}` : `${c},${a}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    for (const key of edges.keys()) {
      const [a, c] = key.split(',').map(Number);
      if (r.ry[a] !== r.ry[c]) { extraVerts += 1; extraIdx += 6; }
    }
  }
  const pos = new Int16Array((v1Verts + extraVerts) * 3), bld = new Uint16Array(v1Verts + extraVerts);
  const idx = new Uint32Array(v1Idx + extraIdx * 2), flatIdx = new Uint32Array(v1Idx);
  let v = 0, k = 0, fk = 0;
  for (let b = 0; b < t.nB; b++) {
    const real = t.roofs[b];
    for (let p = t.partStart[b]; p < t.partStart[b + 1]; p++) {
      const roof = Math.round(t.height[p] * 10);
      const r0 = t.ringStart[p], r1 = t.ringStart[p + 1];
      const shapes = [];
      for (let r = r0; r < r1; r++) {
        normaliseRing(t.xz, r, t.hole[r], t.vertStart);
        const s = t.vertStart[r], e = t.vertStart[r + 1], n = e - s;
        const ring = [];
        for (let i = 0; i < n; i++) {
          const a = s + i, c = s + ((i + 1) % n);
          const ax = t.xz[2 * a], az = t.xz[2 * a + 1], cx = t.xz[2 * c], cz = t.xz[2 * c + 1];
          pos.set([ax, 0, az, cx, 0, cz, cx, roof, cz, ax, roof, az], v * 3);
          bld.fill(b, v, v + 4);
          idx.set([v, v + 1, v + 2, v, v + 2, v + 3], k);
          flatIdx.set([v, v + 1, v + 2, v, v + 2, v + 3], fk);
          v += 4; k += 6; fk += 6;
          ring.push(new Vector2(ax, az));
        }
        if (!t.hole[r]) shapes.push({ contour: ring, holes: [] });
        else if (shapes.length) shapes[shapes.length - 1].holes.push(ring);
      }
      for (const { contour, holes } of shapes) {
        const start = v;
        for (const pt of contour.concat(...holes)) { pos.set([pt.x, roof, pt.y], v * 3); bld[v] = b; v++; }
        for (const tri of ShapeUtils.triangulateShape(contour, holes)) {
          const [a, b2, c] = tri.map(i => start + i);
          let [t0, t1, t2] = [a, b2, c];
          const ux = pos[3 * t1] - pos[3 * t0], uz = pos[3 * t1 + 2] - pos[3 * t0 + 2];
          const vx = pos[3 * t2] - pos[3 * t0], vz = pos[3 * t2 + 2] - pos[3 * t0 + 2];
          if (uz * vx - ux * vz < 0) { const d = t1; t1 = t2; t2 = d; }
          flatIdx.set([t0, t1, t2], fk); fk += 3;
          if (!real) { idx.set([t0, t1, t2], k); k += 3; }
        }
      }
    }
    if (!real) continue;
    const start = v;
    for (let i = 0; i < real.rxz.length; i += 2) {
      pos.set([real.rxz[i], real.ry[i / 2], real.rxz[i + 1]], v * 3); bld[v] = b; v++;
    }
    const edges = new Map();
    for (let i = 0; i < real.rtri.length; i += 3) {
      const tri = [real.rtri[i], real.rtri[i + 1], real.rtri[i + 2]];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], c = tri[(e + 1) % 3];
        const key = a < c ? `${a},${c}` : `${c},${a}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
      let [t0, t1, t2] = tri.map(i => start + i);
      const ux = pos[3 * t1] - pos[3 * t0], uz = pos[3 * t1 + 2] - pos[3 * t0 + 2];
      const vx = pos[3 * t2] - pos[3 * t0], vz = pos[3 * t2 + 2] - pos[3 * t0 + 2];
      if (uz * vx - ux * vz < 0) { const d = t1; t1 = t2; t2 = d; }
      idx.set([t0, t1, t2], k); k += 3;
    }
    for (const [key, count] of edges) {
      if (count !== 1) continue;
      const [a, c] = key.split(',').map(Number);
      if (real.ry[a] === real.ry[c]) continue;
      const hi = real.ry[a] > real.ry[c] ? a : c;
      const lo = hi === a ? c : a;
      const base = v;
      pos.set([real.rxz[2 * hi], real.ry[lo], real.rxz[2 * hi + 1]], v * 3); bld[v] = b; v++;
      // Both windings: a gable is seen from either side and the front-face cull must never open a hole in it.
      idx.set([start + a, start + c, base, start + c, start + a, base], k); k += 6;
    }
  }
  let top = 0;
  for (let p = 0; p < t.height.length; p++) top = Math.max(top, Math.round(t.height[p] * 10));
  for (let b = 0; b < t.nB; b++) if (t.roofs[b]) for (const y of t.roofs[b].ry) top = Math.max(top, y);
  const out = writeAttrs(t, pos.subarray(0, v * 3), bld.subarray(0, v), idx.subarray(0, k), top);
  out.flatIdx = flatIdx.subarray(0, fk);
  return out;
}

self.onmessage = ({ data: { buf, id } }) => {
  const m = build(parse(buf));
  const transfer = [m.pos.buffer, m.bld.buffer, m.idx.buffer, m.attr.buffer];
  if (m.flatIdx) transfer.push(m.flatIdx.buffer);
  self.postMessage({ id, ...m }, transfer);
};
