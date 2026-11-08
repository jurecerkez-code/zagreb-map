// Dense legacy RGBA and v2 HDR18 ground-grid readers. Photos are real samples; a zero-alpha pixel stays unsampled.
import { decodeHDR18 } from './compact-data.js';

const size = value => Number.isSafeInteger(value) && value > 0 && value <= 65535;

export function decodeHDRGrid(doc, bytes) {
  if (doc?.version !== 2 || doc.format !== 'zagreb-ground2' || !size(doc.w) || !size(doc.h)
      || doc.count !== doc.w * doc.h || !Number.isFinite(doc.cell) || doc.cell <= 0
      || !Number.isFinite(doc.x0) || !Number.isFinite(doc.z0)) {
    throw new RangeError('HDR grid format, count or dimensions');
  }
  if (bytes.byteLength !== doc.count * 18) throw new RangeError('HDR grid length');
  const palette = new Set(Array.isArray(doc.palette) ? doc.palette.map(p => p.index) : []);
  if (!palette.has(1)) throw new RangeError('HDR grid has no measured orthophoto palette entry');
  const rows = decodeHDR18(bytes), rgba = new Uint8Array(doc.count * 4), slope = new Float64Array(doc.count);
  const xyz = new Float64Array(doc.count * 3);
  rows.forEach((r, i) => {
    if (r.ortho !== 1) throw new RangeError('HDR grid palette index');
    const row = Math.floor(i / doc.w), col = i % doc.w;
    // Census is regular and global, including both tile seams. Coordinates never come from a floating x/cell cast.
    if (r.x !== Math.round((doc.x0 + col * doc.cell) * 10) / 10
        || r.z !== Math.round((doc.z0 + row * doc.cell) * 10) / 10) {
      throw new RangeError('HDR grid coordinate/order differs from its metadata');
    }
    xyz.set([r.x, r.y, r.z], i * 3);
    rgba.set([r.r, r.g, r.b, 255], i * 4);
    slope[i] = r.slope;
  });
  return { w: doc.w, h: doc.h, rgba, xyz, slope, palette: doc.palette };
}

export async function loadOrthoData(base, config = null, fetchImpl = globalThis.fetch) {
  const bytes = async name => {
    const response = await fetchImpl(`${base}${name}`);
    if (!response.ok) throw new Error(`orthophoto ${response.status}: ${name}`);
    return response.arrayBuffer();
  };
  // Roof metadata has no proven v2 writer yet: never quietly invent missing roof slope/source observations.
  const roofPromise = bytes('roof_rgb.bin');
  let ground;
  if (config?.ground2 === 'ground2.json') {
    const response = await fetchImpl(`${base}ground2.json`);
    if (!response.ok) throw new Error(`orthophoto ground index ${response.status}`);
    const doc = await response.json();
    if (doc.file !== 'ground0.bin') throw new Error('ground2: bad sibling file');
    ground = decodeHDRGrid(doc, await bytes('ground0.bin'));
  } else {
    ground = decodeRGBAHeader(await bytes('ground_rgb.bin'));
  }
  return { roof: decodeRGBAHeader(await roofPromise), ground };
}

export function decodeRGBAHeader(bytes) {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 8) throw new RangeError('RGBA header length');
  const v = new DataView(bytes);
  const w = v.getUint32(0, true), h = v.getUint32(4, true);
  if (!size(w) || !size(h) || bytes.byteLength !== 8 + w * h * 4) throw new RangeError('RGBA dimensions/length');
  return { w, h, rgba: new Uint8Array(bytes.slice(8)) };
}
