// Pure readers for Zagreb's v2 data. Strict little-endian integer decimetres, never legacy float truncation;
// no network or DOM, so fixture tests need no server. Type and exact chunk length are checked before any scan.
export const ROADS2_FORMAT = 'zagreb-roads2';
export const VEG2_FORMAT = 'zagreb-veg2';

export function chooseDataFile(config, key, oldName, newName) {
  // Only this exact version's config opts in. No speculative parallel network check and no older-version lookup.
  return config?.[key] === newName ? newName : oldName;
}

export function legacyError(metres, integerDm) {
  if (!Array.isArray(metres) || !Array.isArray(integerDm) || metres.length !== integerDm.length
      || metres.some(v => !Number.isFinite(v)) || integerDm.some(v => !Number.isSafeInteger(v))) {
    throw new RangeError('legacy/integer point arrays disagree');
  }
  return metres.reduce((max, v, i) => Math.max(max, Math.abs(v - integerDm[i] / 10)), 0);
}

function viewOf(bytes, recordBytes = 1) {
  const buffer = bytes instanceof ArrayBuffer ? bytes
    : ArrayBuffer.isView(bytes) ? bytes.buffer : null;
  if (buffer === null) throw new TypeError('expected an ArrayBuffer or typed-array view');
  const offset = bytes instanceof ArrayBuffer ? 0 : bytes.byteOffset;
  const length = bytes.byteLength;
  if (offset % 4 || length % recordBytes) throw new RangeError('chunk is not aligned or has an invalid length');
  return new DataView(buffer, offset, length);
}

const integer = (v, what, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RangeError(`${what} is out of bounds`);
  return v;
};

function interned(table, index) {
  if (index === -1) return -1;
  integer(index, 'table index', 0, table.length - 1);
  if (typeof table[index] !== 'string') throw new RangeError('table item is not a string');
  return table[index];
}

export function decodeRoads2(doc, bytes) {
  if (doc?.version !== 2 || doc.format !== ROADS2_FORMAT) throw new RangeError('roads2 format/version');
  const v = viewOf(bytes, 4), nWays = doc.ways?.length;
  if (!Number.isSafeInteger(nWays) || !Array.isArray(doc.classes) || !Array.isArray(doc.names)) {
    throw new RangeError('roads2 tables/ways');
  }
  // Preflight every header before allocating. The second pass writes typed arrays once; it does not grow
  // JavaScript-number arrays for millions of vertices or trust a forged total count.
  let at = 0, total = 0;
  for (const w of doc.ways) {
    if (at + 4 > v.byteLength) throw new RangeError('chunk length ends at a way header');
    const n = v.getUint32(at, true);
    if (n !== integer(w.n, 'way points', 1) || n > Math.floor((v.byteLength - at - 4) / 12)) {
      throw new RangeError('chunk length or way point count');
    }
    at += 4 + n * 12;
    total += n;
  }
  if (at !== v.byteLength || doc.count !== total || total > 0xffffffff) {
    throw new RangeError('chunk length or total point count');
  }
  const ways = [];
  const xyz = new Float64Array(total * 3), pts = new Float32Array(total * 2);
  at = 0;
  let offset = 0;
  for (const w of doc.ways) {
    if (at + 4 > v.byteLength) throw new RangeError('chunk length ends at a way header');
    const n = v.getUint32(at, true);
    if (n !== integer(w.n, 'way points', 1) || n > Math.floor((v.byteLength - at - 4) / 12)) {
      throw new RangeError('chunk length or way point count');
    }
    at += 4;
    const id = integer(w.id, 'way id');
    const cls = doc.classes[integer(w.cls, 'class', 0, doc.classes.length - 1)];
    if (typeof cls !== 'string') throw new RangeError('class is not a string');
    const width = integer(w.w, 'width dm', 0, 0x7fffffff) / 10;
    const name = interned(doc.names, w.name);
    ways.push({ o: offset, c: n, cls, w: width, id, name, ...(w.z === undefined ? {} : { z: w.z }) });
    for (let i = 0; i < n; i++, at += 12) {
      const x = v.getInt32(at, true) / 10, z = v.getInt32(at + 4, true) / 10, y = v.getInt32(at + 8, true) / 10;
      xyz.set([x, y, z], offset * 3);
      pts.set([x, z], offset * 2);
      offset++;
    }
  }
  if (at !== v.byteLength || (doc.count !== undefined && doc.count !== offset)) {
    throw new RangeError('chunk length or total point count');
  }
  return { ways, pts, xyz };
}

export function decodeVeg2(doc, bytes) {
  if (doc?.version !== 2 || doc.format !== VEG2_FORMAT) throw new RangeError('veg2 format/version');
  const v = viewOf(bytes, 18), n = integer(doc.count, 'vegetation count', 0, 0xffffffff);
  if (v.byteLength !== n * 18) throw new RangeError('veg2 chunk length is not count * 18');
  if (!Array.isArray(doc.speciesByItem) || doc.speciesByItem.length !== n || !Array.isArray(doc.speciesNames)
      || !['trees', 'bushes', 'grass'].includes(doc.kind) || !Number.isFinite(doc.metresPerScale)) {
    throw new RangeError('veg2 species/kind/width table');
  }
  const trees = new Float32Array(n * 3), scales = new Float32Array(n), items = [];
  for (let i = 0, at = 0; i < n; i++, at += 18) {
    // 12 bytes xyz, 4 bytes scale, 2 bytes year: exactly 18.
    const x = v.getInt32(at, true) / 10, z = v.getInt32(at + 4, true) / 10, y = v.getInt32(at + 8, true) / 10;
    const scale = v.getFloat32(at + 12, true), year = v.getUint16(at + 16, true);
    if (!Number.isFinite(scale)) throw new RangeError('vegetation scale');
    trees.set([x, y, z], i * 3);
    scales[i] = scale;
    items.push({ kind: doc.kind, species: interned(doc.speciesNames, doc.speciesByItem[i]),
      width: scale * doc.metresPerScale, year, scale });
  }
  return { trees, scales, items, meta: doc };
}

// AoS 18 bytes: i32 x/z/y dm (12), u8 RGB (3), u8 ortho palette index (1), u16 milli-degree slope (2).
export function decodeHDR18(bytes) {
  const v = viewOf(bytes, 18), out = [];
  for (let at = 0; at < v.byteLength; at += 18) {
    const slope = v.getUint16(at + 16, true) / 1000;
    if (slope && (slope < 1.001 || slope > 45)) throw new RangeError('HDR18 slope');
    out.push({ x: v.getInt32(at, true) / 10, z: v.getInt32(at + 4, true) / 10, y: v.getInt32(at + 8, true) / 10,
      r: v.getUint8(at + 12), g: v.getUint8(at + 13), b: v.getUint8(at + 14), ortho: v.getUint8(at + 15), slope });
  }
  return out;
}

// Optional annotation: no RGBA or spatial data, just u16 source index + u16 milli-degree slope.
export function decodeUTF16(bytes) {
  const v = viewOf(bytes, 4), out = [];
  for (let at = 0; at < v.byteLength; at += 4) {
    const ortho = v.getUint16(at, true), milli = v.getUint16(at + 2, true);
    if (milli && (milli < 1001 || milli > 45000)) throw new RangeError('UTF16 slope');
    out.push({ ortho, slope: milli / 1000 });
  }
  return out;
}
