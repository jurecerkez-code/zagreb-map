// Streets as geometry, away from the main thread (issue #27): makeRoads used to build 951 road tiles on the main
// thread and froze the map for 3.8 s while it did. Everything here is pure JS over typed arrays: the request is the
// points, the ways and the terrain's (t, cut) texture; the answer, per tile, is transferable arrays — positions,
// aU (signed metres across the ribbon), aHalf (asphalt half-width), aCls (u8 class index), aT and aCut (the terrain
// pair the vertex shader reads as aT * uRelief - aCut * uCutK + lift, exactly like the buildings) and the index list
// with the tertiary-and-above ways first, so a far tile draws only its second index range.
//
// One ribbon per way now, not three (pavement, kerb, asphalt, painted in the fragment shader by distance from the
// centreline): the same street drawn once instead of three overlapping times.
export const TILE = 1200;          // metres: the buildings' own tile size
export const KERB = 3.4;           // metres of pavement each side of a carriageway
export const EDGE_W = 0.6;         // metres of kerbstone showing on each side of a carriageway
export const LIFT = 0.18;          // metres above the ground: over the terrain, under nothing else

// The classes the pipeline writes, indexed once here (the shader's palette is laid out in this order, app-side).
export const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified',
  'living_street', 'service', 'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'tram'];
// The five above: the only bands a far tile keeps (the other index range is the whole tile).
export const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
// Pavement-class ways are their own surface, not a carriageway in a pavement band.
export const PAVEMENT = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian']);
const CLS_INDEX = new Map(CLASSES.map((c, i) => [c, i]));

// The ground the streets are laid on (web/terrain.js makeGround, the same bilinear over the node's (t, cut)):
// exactly the pair the page's surfaceAt reports at the point — no cell guard. The street then lifts by the same
// two uniforms as the buildings (aT * uRelief - aCut * uCutK), so the relief test of the issue can hold a vertex
// against surfaceAt to 0.3 m and the Hills slider moves uniforms, not geometry.
export function groundAt(makeGroundLike, x, z) {
  return [makeGroundLike.tAt(x, z), makeGroundLike.cutAt(x, z)];
}

// One way as vertices {x, z} per point: its own width at each point's averaged tangent, two vertices per point.
// Returns a packed triple for the tile-bucket writer: [Float32Array(2n) lr, wide class-html, major boolean].
function wayMajor(way) { return MAJOR.has(way.cls); }

// The whole build, pure: pts is Float32Array of x,z pairs; ways are {o, c, w, cls} into it; groundOf(x, z) -> [t, c].
// Returns { tiles: Map<key, {pos, aU, aHalf, aCls, aT, aCut, idx, majorIdx, tris}>, tris total, ways drawn }.
export function buildRoads(pts, ways, groundOf) {
  const tiles = new Map();
  let tris = 0, drawn = 0;
  for (const way of ways) {
    const n = way.c;
    if (n < 2 || way.o + n > pts.length / 2) continue;
    drawn++;
    const o = way.o;
    const mid = o + (n >> 1);
    const key = `${Math.floor(pts[mid * 2] / TILE)},${Math.floor(pts[mid * 2 + 1] / TILE)}`;
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, tile = { pos: [], aU: [], aHalf: [], aCls: [], aT: [], aCut: [], hi: [], lo: [], v: 0 });
    const pave = PAVEMENT.has(way.cls);
    const width = pave ? Math.max(way.w, 1.6) : way.w + 2 * (EDGE_W + KERB);
    const half = width / 2, aHalf = way.w / 2, cls = CLS_INDEX.get(way.cls) ?? CLS_INDEX.get('unclassified');
    const base = tile.v;
    const major = wayMajor(way);
    for (let i = 0; i < n; i++) {
      const x = pts[(o + i) * 2], z = pts[(o + i) * 2 + 1];
      // The direction through this point: the segment, or the average of the two at a joint, so a bend stays closed.
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let dx = pts[(o + i1) * 2] - pts[(o + i0) * 2], dz = pts[(o + i1) * 2 + 1] - pts[(o + i0) * 2 + 1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const nx = -dz * half, nz = dx * half;
      const [t, c] = groundOf(x, z);
      tile.pos.push(x + nx, 0, z + nz, x - nx, 0, z - nz);
      tile.aU.push(half, -half);
      tile.aHalf.push(aHalf, aHalf);
      tile.aCls.push(cls, cls);
      tile.aT.push(t, t);
      tile.aCut.push(c, c);
    }
    const bucket = major ? tile.hi : tile.lo;
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      // Wound so the face looks UP: three culls a clockwise face, and a street drawn clockwise was a sliver at a
      // grazing angle and nothing from above (the old map went through this once already).
      bucket.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      tris += 2;
    }
    tile.v += n * 2;
  }
  for (const [key, t] of tiles) {
    const idx = new Uint32Array(t.hi.length + t.lo.length);
    idx.set(t.hi); idx.set(t.lo, t.hi.length);
    // The extents and the culling sphere are computed here, at worker time: the main thread's addTile is array
    // wrangling and nothing else (computeBoundingSphere on the page's thread was the 600 ms after the mesher left).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxT = 0;
    for (let i = 0; i < t.pos.length; i += 3) {
      const x = t.pos[i], z = t.pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      const ground = t.aT[i / 3];
      if (ground > maxT) maxT = ground;
    }
    const sphere = {
      x: (minX + maxX) / 2, y: (maxT * 2.5) / 2, z: (minZ + maxZ) / 2,
      r: Math.hypot((maxX - minX) / 2, (maxZ - minZ) / 2, maxT * 2.5 + LIFT),
    };
    // Trim the scratch arrays and freeze the tile as typed arrays, ready to transfer.
    tiles.set(key, {
      pos: new Float32Array(t.pos), aU: new Float32Array(t.aU), aHalf: new Float32Array(t.aHalf),
      aCls: new Uint8Array(t.aCls), aT: new Float32Array(t.aT), aCut: new Float32Array(t.aCut),
      idx, hiCount: t.hi.length, tris: idx.length / 3, sphere,
    });
  }
  return { tiles, tris, ways: drawn };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  // The main thread sends {pts, ways, tex, grid}; the ground is the terrain's own texture read bilinearly, with the
  // CROSS guard above taken against its (t, cut) channels. Answers per tile, all buffers transferred.
  self.onmessage = ({ data: { pts, ways, tex, grid } }) => {
    const points = pts instanceof Float32Array ? pts : new Float32Array(pts);
    const height = tex instanceof Float32Array ? tex : new Float32Array(tex || 0);
    const cell = grid?.cell || 1, x0 = grid?.x0 || 0, z0 = grid?.z0 || 0;
    const nx = grid?.nx || 1, nz = grid?.nz || 1;
    const node = (o, i, j) => height[2 * (Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))) + o] || 0;
    const bil = (o, x, z) => {
      const gx = (x - x0) / cell, gz = (z - z0) / cell, fx = Math.floor(gx), fz = Math.floor(gz), tx = gx - fx, tz = gz - fz;
      const top = node(o, fx, fz) * (1 - tx) + node(o, fx + 1, fz) * tx;
      const bottom = node(o, fx, fz + 1) * (1 - tx) + node(o, fx + 1, fz + 1) * tx;
      return top * (1 - tz) + bottom * tz;
    };
    const ground = { tAt: (x, z) => bil(0, x, z), cutAt: (x, z) => bil(1, x, z) };
    const out = buildRoads(points, ways, (x, z) => groundAt(ground, x, z));
    const transfers = [];
    const tiles = {};
    for (const [k, t] of out.tiles) {
      tiles[k] = t;
      transfers.push(t.pos.buffer, t.aU.buffer, t.aHalf.buffer, t.aCls.buffer, t.aT.buffer, t.aCut.buffer, t.idx.buffer);
    }
    self.postMessage({ tiles, tris: out.tris, ways: out.ways }, transfers);
  };
}
