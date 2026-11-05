// Vegetation and the cable car: real OpenStreetMap data (data/<version>/veg.json, veg_trees.bin, veg_mask.bin.gz,
// cable.bin; pipeline/s07_zagreb_veg.py).
//
// - Trees: 144,878 symbols at mapped coordinates (individual `natural=tree` nodes plus a nominal 8 m fill of the
//   mapped `natural=tree_row` lines). Each is one camera-facing quad with an alpha-tested baked sprite (#21:
//   172 triangles per tree could not stay); size and hue vary per tree (a look, not data).
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

  // ---- trees: one camera-facing quad per tree (2 triangles), alpha-tested against a baked sprite.
  // The issue: 144,878 trees at 172 triangles each (two ico crowns + trunk) = 24.9 M triangles, 93% of the map.
  // 144,878 quads = 289,756, inside the 400,000 this issue allows. A crossed-quads pair would take 579,512.
  // The sprite is white-on-alpha so the theme tints it like the blobs were tinted, and its luminance keeps the
  // baked bottom-dark shading of the old crowns so the picture gate still recognizes the views.
  function treeSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const img = g.createImageData(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const dx = (x - 32) / 26, dy = (y - 26) / 24;
        const r = dx * dx + dy * dy;
        let a = 0, l = 0;
        if (r < 1) {
          // canopy: slightly lumpy disc, brighter at the top like the old gradient
          const lump = 0.92 + 0.08 * Math.sin(x * 1.7) * Math.cos(y * 1.3);
          a = r < lump * 0.94 ? 255 : 0;
          l = Math.round(255 * (0.62 + 0.38 * (1 - y / 52)));
        } else if (y >= 44 && y < 62 && Math.abs(x - 32) <= 2) {
          a = 255;                                  // trunk sliver under the canopy, darkest part of the sprite
          l = 96;
        }
        const o = (y * 64 + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = l;
        img.data[o + 3] = a;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }
  const treeMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: treeSprite() }, uTint: { value: new THREE.Color(0xffffff) } },
    vertexShader: /* glsl */`
      attribute vec3 iOffset;
      attribute float iScale;
      attribute vec3 iColor;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        vColor = iColor;
        // Spherical billboard in the view matrix's own axes: the map is seen from above, where a merely
        // vertical billboard foreshortens into a standing sticker. Facing the camera whole keeps one canopy
        // disc from every angle the orbit controls allow. The centre sits at blob height (4.3*s).
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 centre = iOffset + vec3(0.0, 4.3 * iScale, 0.0);
        vec3 wp = centre + right * position.x * (5.9 * iScale) + up * position.y * (8.6 * iScale);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      uniform vec3 uTint;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uTex, vUv);
        if (t.a < 0.5) discard;
        gl_FragColor = vec4(t.rgb * uTint * vColor, 1.0);
      }`,
  });
  const plane = new THREE.PlaneGeometry(1, 1);
  const treeGeo = new THREE.InstancedBufferGeometry();
  treeGeo.index = plane.index;
  treeGeo.setAttribute('position', plane.getAttribute('position'));
  treeGeo.setAttribute('uv', plane.getAttribute('uv'));
  const offsets = new Float32Array(nTrees * 3);
  const scales = new Float32Array(nTrees);
  const colors = new Float32Array(nTrees * 3);
  for (let i = 0; i < nTrees; i++) {
    offsets[i * 3] = trees[i * 3];
    offsets[i * 3 + 1] = trees[i * 3 + 1];
    offsets[i * 3 + 2] = trees[i * 3 + 2];
    scales[i] = 0.88 + ((i * 7) % 11) * 0.028;          // the same size walk the blobs had
    const h = 0.86 + ((i * 13) % 17) * 0.0125;          // ... and the same per-tree hue
    colors[i * 3] = h; colors[i * 3 + 1] = h * 1.04; colors[i * 3 + 2] = h * 0.92;
  }
  treeGeo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  treeGeo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scales, 1));
  treeGeo.setAttribute('iColor', new THREE.InstancedBufferAttribute(colors, 3));
  treeGeo.instanceCount = nTrees;
  const treeQuads = new THREE.Mesh(treeGeo, treeMat);
  treeQuads.frustumCulled = false;
  group.add(treeQuads);

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
    // the sprite bakes the trunk darker, so the crown colour tints the whole tree like the old blobs did
    treeMat.uniforms.uTint.value.set(c.crown).multiplyScalar(k);
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
