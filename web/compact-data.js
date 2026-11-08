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

function decodeRoads0(doc, bytes) {
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

export function decodeRoads2(doc, bytes) {
  if (doc?.version !== 2 || doc.format !== ROADS2_FORMAT) throw new RangeError('roads2 format/version');
  if (doc.file !== 'roads2.bin.gz') return decodeRoads0(doc, bytes);
  const v = viewOf(bytes, 1);
  if (v.byteLength < 20 || v.getUint8(0) !== 0x5a || v.getUint8(1) !== 0x47
      || v.getUint8(2) !== 0x52 || v.getUint8(3) !== 0x32) throw new RangeError('ZGR2 header');
  const nWays = v.getUint32(4, true), nPts = v.getUint32(8, true);
  if ((doc.nWays !== undefined && doc.nWays !== nWays) || (doc.count !== undefined && doc.count !== nPts)
      || nWays > nPts || 20 + 4 * nWays > v.byteLength) throw new RangeError('ZGR2 counts/indexes');
  const clsAt = 20, widthAt = clsAt + nWays, countAt = widthAt + nWays;
  const ways = new Array(nWays), pts = new Float32Array(nPts * 2);
  let at = countAt + 2 * nWays, pointOffset = 0;
  for (let w = 0; w < nWays; w++) {
    const n = v.getUint16(countAt + w * 2, true);
    if (n < 1) throw new RangeError('ZGR2 empty way');
    ways[w] = { o: pointOffset, c: n, w: v.getUint8(widthAt + w) / 4, cls: v.getUint8(clsAt + w) };
    if (ways[w].cls >= doc.classes.length) throw new RangeError('ZGR2 class');
    const need = size => { if (at + size > v.byteLength) throw new RangeError('ZGR2 truncated absolute/delta pair'); };
    let x, z;
    need(4);
    const firstX = v.getInt16(at, true), firstZ = v.getInt16(at + 2, true);
    at += 4;
    if (firstX === -32768 || firstZ === -32768) {
      need(8);
      x = v.getFloat32(at, true); z = v.getFloat32(at + 4, true); at += 8;
    } else {
      x = Math.fround(v.getFloat32(12, true) + firstX * 1.6);
      z = Math.fround(v.getFloat32(16, true) + firstZ * 1.6);
    }
    for (let j = 0; j < n; j++) {
      if (j) {
        need(4);
        const dx = v.getInt16(at, true), dz = v.getInt16(at + 2, true);
        at += 4;
        if (dx === -32768 || dz === -32768) {
          need(8);
          x = v.getFloat32(at, true); z = v.getFloat32(at + 4, true); at += 8;
        } else {
          x = Math.fround(x + Math.fround(dx / 10));
          z = Math.fround(z + Math.fround(dz / 10));
        }
      }
      pts[pointOffset * 2] = x; pts[pointOffset * 2 + 1] = z;
      pointOffset++;
    }
  }
  if (at !== v.byteLength || pointOffset !== nPts) throw new RangeError('ZGR2 point count/chunk length');
  return { ways, pts, xyz: null };
}

function decodeVeg0(doc, bytes) {
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

export function decodeVeg2(doc, bytes, ground = null) {
  if (doc?.version !== 2 || doc.format !== VEG2_FORMAT) throw new RangeError('veg2 format/version');
  if (doc.file !== 'veg2.bin.gz') return decodeVeg0(doc, bytes);
  if (typeof ground !== 'function') throw new TypeError('veg2 terrain sampler is required');
  const v = viewOf(bytes, 1), n = integer(doc.count, 'vegetation count', 1, 0xffffffff);
  if (v.byteLength < 8 + 7 * n || v.getUint8(0) !== 0x5a || v.getUint8(1) !== 0x47
      || v.getUint8(2) !== 0x56 || v.getUint8(3) !== 0x32 || v.getUint32(4, true) !== n) {
    throw new RangeError('ZGV2 header/count');
  }
  const trees = new Float32Array(n * 3), scales = new Float32Array(n), items = new Array(n);
  const quantum = doc.size_quantum_m ?? 0.25, displayHeight = doc.height_m ?? 17.2;
  let at = 8, previousX = null, previousZ = null;
  for (let i = 0; i < n; i++) {
    if (at + (i === 0 ? 11 : 7) > v.byteLength) throw new RangeError('ZGV2 record length');
    let x, z, attrs;
    if (i === 0) {
      x = v.getInt32(at, true); z = v.getInt32(at + 4, true); attrs = at + 8;
    } else {
      const dx = v.getInt16(at, true), dz = v.getInt16(at + 2, true);
      if (dx === -32768 || dz === -32768) {
        if (at + 15 > v.byteLength) throw new RangeError('ZGV2 absolute cell escape');
        x = v.getInt32(at + 4, true); z = v.getInt32(at + 8, true); attrs = at + 12;
      } else {
        x = previousX + dx; z = previousZ + dz; attrs = at + 4;
      }
    }
    if (previousX !== null && (x < previousX || (x === previousX && z < previousZ))) {
      throw new RangeError('ZGV2 cells are not sorted');
    }
    const species = v.getUint8(attrs), heightCode = v.getUint8(attrs + 1), radiusCode = v.getUint8(attrs + 2);
    if (!heightCode || !radiusCode) throw new RangeError('ZGV2 display dimensions');
    const worldX = x / 2, worldZ = z / 2, y = ground(worldX, worldZ);
    if (!Number.isFinite(y)) throw new RangeError('ZGV2 terrain height');
    const height = heightCode * quantum, radius = radiusCode * quantum, scale = height / displayHeight;
    trees.set([worldX, y, worldZ], i * 3);
    scales[i] = scale;
    items[i] = { kind: doc.kind, species: species === 255 ? -1 : interned(doc.speciesNames ?? [], species),
      width: scale * doc.metresPerScale, height, radius, year: 0, scale };
    at = attrs + 3; previousX = x; previousZ = z;
  }
  if (at !== v.byteLength) throw new RangeError('ZGV2 trailing bytes');
  return { trees, scales, items, meta: doc };
}

// AoS 18 bytes: i32 x/z/y dm (12), u8 RGB (3), u8 ortho palette index (1), u16 milli-degree slope (2).
export function decodeHDR18(bytes) {
  const v = viewOf(bytes, 18), out = [];
  for (let at = 0; at < v.byteLength; at += 18) {
    const encoded = v.getUint16(at + 16, true);
    if (encoded !== 65535 && encoded > 45000) throw new RangeError('HDR18 slope');
    const slope = encoded === 65535 ? null : encoded / 1000;
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
    if (milli !== 65535 && milli > 45000) throw new RangeError('UTF16 slope');
    out.push({ ortho, slope: milli === 65535 ? null : milli / 1000 });
  }
  return out;
}
