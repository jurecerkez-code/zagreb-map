// Vegetation and the cable car: real OpenStreetMap data (data/<version>/veg.json, veg_trees.bin, veg_mask.bin.gz,
// cable.bin; pipeline/s07_zagreb_veg.py).
//
// - Trees: 42,002 symbols at mapped coordinates (individual `natural=tree` nodes plus a nominal 8 m fill of the
//   mapped `natural=tree_row` lines). A crown is two overlapping blobs with baked vertex shading; size and hue vary
//   per tree (a look, not data).
// - Green cover: a 16 m class mask (grass, meadow, forest, wood, scrub, orchard, park, garden, allotments, ...)
//   rasterized from the real polygons and painted into the TERRAIN by its shader, so it follows every hill by
//   construction. Never geometry: a kilometre-wide triangle sinks under a slope and whole forests disappear.
// - Cable car: the mapped `aerialway=cable_car` way, drawn as its line with the terrain heights, cabins moving along
//   it at a speed derived from the mapped trip duration, and the two mapped stations.
export const VEG_COLOURS = {
  arg: {
    grass: '#93b06b', meadow: '#a0bb76', forest: '#527a3c', wood: '#4a7038', scrub: '#6f9251', grassland: '#a6bd80',
    heath: '#82985f', orchard: '#7d9f52', park: '#8aad62', garden: '#97b271', allotments: '#a59f6d',
    trunk: '#6b5844', crown: '#4e7538',
  },
  kalk: {
    grass: '#bcc78d', meadow: '#c3cd97', forest: '#77904f', wood: '#6d8549', scrub: '#93a668', grassland: '#c8d1a0',
    heath: '#a6ab7c', orchard: '#93a95f', park: '#aabb7d', garden: '#b2c08e', allotments: '#bdb489',
    trunk: '#7a6250', crown: '#6d8a45',
  },
  blatimme: {
    grass: '#22322c', meadow: '#25352e', forest: '#182722', wood: '#162420', scrub: '#1f2f28', grassland: '#26362f',
    heath: '#232f29', orchard: '#1e2d24', park: '#22332b', garden: '#24352c', allotments: '#2a3128',
    trunk: '#5a4c42', crown: '#1c3326',
  },
  paper: {
    grass: '#b9c39b', meadow: '#bfc9a1', forest: '#7f9569', wood: '#748a60', scrub: '#9aab84', grassland: '#c4cda8',
    heath: '#a7ae94', orchard: '#93ab74', park: '#aebc94', garden: '#b6c29e', allotments: '#bdb795',
    trunk: '#7d6a58', crown: '#75905b',
  },
  foto: {
    grass: '#8fb163', meadow: '#9cba72', forest: '#43683a', wood: '#3d6136', scrub: '#6f9455', grassland: '#a2c07a',
    heath: '#87a066', orchard: '#7ba34f', park: '#84ad5c', garden: '#95b56c', allotments: '#a5a273',
    trunk: '#5d4c3a', crown: '#3a5f31',
  },
};

// gzip in transit, inflated here (see app.js): the mask is 6.4 MB raw and 231 KB gzipped, because most 16 m cells
// of a city are bare. DecompressionStream, no library.
export async function gunzip(buf) {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export async function makeVeg({ THREE, base, scene, uniforms, on = true }) {
  const meta = await (await fetch(`${base}veg.json`)).json();
  const [treeBuf, maskBuf] = await Promise.all([
    fetch(`${base}veg_trees.bin`).then(r => r.arrayBuffer()),
    fetch(`${base}veg_mask.bin.gz`).then(r => r.arrayBuffer()).then(b => gunzip(b)),
  ]);
  const trees = new Float32Array(treeBuf);
  const nTrees = trees.length / 3;
  const mask = new Uint8Array(maskBuf);
  const m = meta.green.mask;
  const classes = meta.green.classes;

  const group = new THREE.Group();
  group.name = 'veg';

  // ---- trees: two crown blobs and a trunk, baked vertex shading (the map's materials are unlit)
  function shaded(geo, tint, lowY, highY, low = 0.62) {
    const pos = geo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, (pos.getY(i) - lowY) / (highY - lowY)));
      c.copy(tint).multiplyScalar(low + (1 - low) * t);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }
  const trunkGeo = shaded(new THREE.CylinderGeometry(0.14, 0.26, 3.4, 6, 1, true), new THREE.Color(0xffffff), -1.7, 1.7, 0.55);
  const crownLow = shaded(new THREE.IcosahedronGeometry(2.9, 1), new THREE.Color(0xffffff), -2.9, 2.9, 0.68);
  const crownTop = shaded(new THREE.IcosahedronGeometry(1.9, 1), new THREE.Color(0xffffff), -1.9, 1.9, 0.72);
  const trunkMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const crownMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, nTrees);
  const crowns = new THREE.InstancedMesh(crownLow, crownMat, nTrees);
  const tops = new THREE.InstancedMesh(crownTop, crownMat, nTrees);
  const mtx = new THREE.Matrix4();
  const tintC = new THREE.Color();
  for (let i = 0; i < nTrees; i++) {
    const x = trees[i * 3], y = trees[i * 3 + 1], z = trees[i * 3 + 2];
    mtx.makeTranslation(x, y + 1.7, z);
    trunks.setMatrixAt(i, mtx);
    const s = 0.88 + ((i * 7) % 11) * 0.028;
    const h = 0.86 + ((i * 13) % 17) * 0.0125;
    mtx.compose(new THREE.Vector3(x, y + 5.6 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s * 1.12, s));
    crowns.setMatrixAt(i, mtx);
    mtx.compose(new THREE.Vector3(x + 0.5 * s, y + 7.4 * s, z - 0.3 * s), new THREE.Quaternion(), new THREE.Vector3(s, s * 1.05, s));
    tops.setMatrixAt(i, mtx);
    tintC.setRGB(h, h * 1.04, h * 0.92);
    crowns.setColorAt(i, tintC); tops.setColorAt(i, tintC);
  }
  trunks.instanceMatrix.needsUpdate = crowns.instanceMatrix.needsUpdate = tops.instanceMatrix.needsUpdate = true;
  crowns.instanceColor.needsUpdate = tops.instanceColor.needsUpdate = true;
  trunks.frustumCulled = crowns.frustumCulled = tops.frustumCulled = false;
  group.add(trunks, crowns, tops);

  // ---- the cable car: its mapped line, cabins moving along it, the two mapped stations
  let cable = null;
  if (meta.cable && meta.cable.points > 1) {
    const cb = new Float32Array(await (await fetch(`${base}cable.bin`)).arrayBuffer());
    const pts = [];
    for (let i = 0; i < cb.length; i += 3) pts.push(new THREE.Vector3(cb[i], cb[i + 1] + 0.6, cb[i + 2]));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3a3a3a, transparent: true, opacity: 0.9 });
    const wire = new THREE.Line(lineGeo, lineMat);
    wire.frustumCulled = false;
    group.add(wire);
    const cabinGeo = new THREE.BoxGeometry(2.2, 2.6, 2.2);
    const cabinMat = new THREE.MeshBasicMaterial({ color: 0xd8dde1 });
    const cabins = [];
    for (let i = 0; i < 6; i++) { const c = new THREE.Mesh(cabinGeo, cabinMat); group.add(c); cabins.push(c); }
    // cumulative length for even motion; the loop advances them by the mapped trip duration
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    const at = u => {
      const d = u * total;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const f = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return pts[i - 1].clone().lerp(pts[i], f);
    };
    cable = { total, at, cabins, meta: meta.cable, phase: 0 };
    const placeCabins = () => cabins.forEach((c, i) => {
      const u = (cable.phase + i / cabins.length) % 1;
      c.position.copy(cable.at(u < 0.5 ? u * 2 : (1 - u) * 2));      // up one way, down the other, as a ropeway runs
    });
    cable.place = placeCabins;
    placeCabins();
  }

  // ---- green cover painted into the terrain
  const lut = new Uint8Array(256 * 3);
  const tmpCol = new THREE.Color();
  let greenTexture = null;
  let nightOn = false;                       // the Night mode: unlit materials are not shaded, so they are darkened here
  const NIGHT = 0.36;
  function paintMask(look) {
    const c = VEG_COLOURS[look] || VEG_COLOURS.arg;
    const k = nightOn ? NIGHT : 1;
    for (let i = 1; i <= classes.length; i++) {
      tmpCol.set(c[classes[i - 1]] || c.grass).multiplyScalar(k);
      lut[i * 3] = Math.round(tmpCol.r * 255); lut[i * 3 + 1] = Math.round(tmpCol.g * 255); lut[i * 3 + 2] = Math.round(tmpCol.b * 255);
    }
    const rgba = new Uint8Array(m.w * m.h * 4);
    for (let k = 0, o = 0; k < mask.length; k++, o += 4) {
      const v = mask[k];
      if (!v) continue;
      rgba[o] = lut[v * 3]; rgba[o + 1] = lut[v * 3 + 1]; rgba[o + 2] = lut[v * 3 + 2]; rgba[o + 3] = 255;
    }
    greenTexture?.dispose();
    greenTexture = new THREE.DataTexture(rgba, m.w, m.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    greenTexture.colorSpace = THREE.SRGBColorSpace;
    greenTexture.minFilter = greenTexture.magFilter = THREE.LinearFilter;
    greenTexture.needsUpdate = true;
    uniforms.uVegTex.value = greenTexture;
    uniforms.uVegN.value.set(m.w, m.h);
    uniforms.uVegOrigin.value.set(m.x0, m.z0);
    uniforms.uVegCell.value = m.cell;
    uniforms.uVegOn.value = show ? 1 : 0;
  }

  let show = on;
  group.visible = show;
  const retheme = look => {
    const c = VEG_COLOURS[look] || VEG_COLOURS.arg;
    const k = nightOn ? NIGHT : 1;
    trunkMat.color.set(c.trunk).multiplyScalar(k);
    crownMat.color.set(c.crown).multiplyScalar(k);
    paintMask(look);
  };

  scene.add(group);
  return {
    group, trees: nTrees, maskCells: m.w * m.h, classes,
    setOn(v) {
      show = !!v;
      group.visible = show;
      uniforms.uVegOn.value = show ? 1 : 0;
    },
    get on() { return show; },
    retheme,
    // The trees and the green cover are unlit: at night they are darkened by hand, or they would glow.
    setNight(v, look) {
      nightOn = !!v;
      retheme(look);
    },
    // the animation a render loop can call: the cabinets move along the mapped line
    step(dt) {
      if (!cable) return;
      const trip = Math.max(60, (cable.meta.duration_min || 16.5) * 60);
      cable.phase = (cable.phase + dt / trip) % 1;
      cable.place();
    },
    get cable() { return cable; },
  };
}
