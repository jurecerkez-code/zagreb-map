// Years on the roofs: the year a building's card shows (card.js yearLine: a private house only its decade, an estimate
// with "≈"), written over the top of its roof once the camera comes close. One glyph atlas (digits, "≈", "–", "s" and
// the Swedish "-talet"), drawn in the look's font, ink and panel colours, and one instanced quad per glyph: two draw
// calls for every label on screen (the halo under all of them, then the ink), whatever their number. update() picks
// the labels every few frames (nearest and tallest first, at most MAX, none overlapping on screen); step() eases them
// in and out each frame; the shader keeps them on their roofs as the camera and the relief move.
export const ROOF_YEARS_KEY = 'hfh-roof-years';
export const roofYearsOnFrom = stored => stored !== 'off';   // on by default

export const NEAR_M = 600, FAR_M = 900;   // full strength within NEAR_M of the camera, gone at FAR_M
export const MAX = 220;
const CELL_M = 100;            // the spatial index's cells
const LIFT_M = 1.5;            // above the top of the tallest part
const PULL_M = 10;             // drawn this much towards the camera, so its own roof never cuts the label
const ATLAS_PX = 64;           // glyph cell height in the atlas
const FONT_EM = 0.62;          // the font's size in a cell
const CHARS = '0123456789≈–-s talet~?';
const FADE_S = 0.35;

// Font size in CSS pixels at camera distance d: larger close up, smaller towards FAR_M.
export const sizeAt = d => 17 - 5 * Math.min(1, Math.max(0, (d - 120) / (FAR_M - 120)));

export function makeRoofYears(THREE, { attrs, stride, count, camera, renderer, uniforms, textOf, hidden, blocked,
  priority, theme, font, fontReady }) {
  const group = new THREE.Group();
  group.name = 'roof-years';
  let on = true;
  // Per gid, from the tiles as they load: ground (true metres, lifted by the relief) and the drawn top (metres).
  const ground = new Float32Array(count), top = new Float32Array(count).fill(-1);
  const yflagOf = gid => attrs.getUint8(gid * stride + 3);
  const xOf = gid => attrs.getFloat32(gid * stride + 12, true), zOf = gid => attrs.getFloat32(gid * stride + 16, true);

  function addTile(m) {
    const n = m.nB, F = m.attr.length / Math.max(1, n);
    const local = new Float32Array(n);
    for (let v = 0; v < m.bld.length; v++) { const y = m.pos[3 * v + 1]; if (y > local[m.bld[v]]) local[m.bld[v]] = y; }
    for (let b = 0; b < n; b++) {
      const gid = m.attr[b * F + 3];
      if (gid >= 0 && gid < count) { ground[gid] = m.attr[b * F + 8] / 10; top[gid] = local[b] / 10; }
    }
  }

  // The spatial index over every building with a year, built on first use: CSR over CELL_M cells.
  let index = null;
  function buildIndex() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let g = 0; g < count; g++) {
      const x = xOf(g), z = zOf(g);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const nx = Math.max(1, Math.ceil((x1 - x0) / CELL_M) + 1), nz = Math.max(1, Math.ceil((z1 - z0) / CELL_M) + 1);
    const cellOf = new Int32Array(count), start = new Int32Array(nx * nz + 1);
    for (let g = 0; g < count; g++) {
      const f = yflagOf(g);
      if (f === 7 || f === 6) { cellOf[g] = -1; continue; }   // Year unknown, or a period only: no year to write
      const c = Math.floor((xOf(g) - x0) / CELL_M) + nx * Math.floor((zOf(g) - z0) / CELL_M);
      cellOf[g] = c; start[c + 1]++;
    }
    for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
    const fill = start.slice(0, -1), gids = new Int32Array(start[nx * nz]);
    for (let g = 0; g < count; g++) if (cellOf[g] >= 0) gids[fill[cellOf[g]]++] = g;
    index = { x0, z0, nx, nz, start, gids };
  }

  // ---- The glyph atlas: red = the ink's coverage, green = the halo's.
  const canvas = document.createElement('canvas');
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  let glyphs = new Map(), chars = CHARS, atlasFor = null, pad = 0;
  function drawAtlas() {
    const f = `600 ${Math.round(ATLAS_PX * FONT_EM)}px ${font()}, sans-serif`;
    const m = document.createElement('canvas').getContext('2d');
    m.font = f;
    const halo = ATLAS_PX * 0.2;
    pad = Math.ceil(halo / 2 + 2);
    const list = [...new Set(chars)];
    const adv = list.map(c => m.measureText(c).width);
    const cellW = adv.map(a => Math.ceil(a) + 2 * pad);
    const W = 1024, rows = [];
    let x = 0, row = 0;
    const at = list.map((c, i) => { if (x + cellW[i] > W) { x = 0; row++; } const p = [x, row]; x += cellW[i]; return p; });
    const H = THREE.MathUtils.ceilPowerOfTwo((row + 1) * ATLAS_PX);
    const layer = stroke => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.font = f; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.fillStyle = ctx.strokeStyle = '#fff';
      ctx.lineWidth = halo;
      list.forEach((ch, i) => {
        const [cx, r] = at[i], y = r * ATLAS_PX + ATLAS_PX / 2;
        if (stroke) ctx.strokeText(ch, cx + pad, y);
        ctx.fillText(ch, cx + pad, y);
      });
      return ctx.getImageData(0, 0, W, H).data;
    };
    const ink = layer(false), glow = layer(true);
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = ink[i + 3]; img.data[i + 1] = glow[i + 3]; img.data[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    glyphs = new Map(list.map((c, i) => [c, { adv: adv[i] / ATLAS_PX, w: cellW[i] / ATLAS_PX,
      u0: at[i][0] / W, u1: (at[i][0] + cellW[i]) / W, v0: 1 - (at[i][1] + 1) * ATLAS_PX / H, v1: 1 - at[i][1] * ATLAS_PX / H }]));
    tex.dispose();
    tex.needsUpdate = true;
    atlasFor = font();
    dirty = true;
  }

  // ---- The instanced quads: one per glyph.
  const GLYPHS_MAX = MAX * 2 * 10;   // fading-out labels as well as the shown ones, up to 10 glyphs each
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(GLYPHS_MAX * 4), 4);   // x, top, z, ground
  const aUv = new THREE.InstancedBufferAttribute(new Float32Array(GLYPHS_MAX * 4), 4);    // u0, v0, u1, v1
  const aOff = new THREE.InstancedBufferAttribute(new Float32Array(GLYPHS_MAX * 4), 4);   // left (em), width (em), px, alpha
  for (const a of [aPos, aUv, aOff]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', aPos); geo.setAttribute('aUv', aUv); geo.setAttribute('aOff', aOff);
  geo.instanceCount = 0;
  const shared = { uAtlas: { value: tex }, uViewport: { value: new THREE.Vector2(1, 1) }, uRelief: uniforms.uRelief,
    uFog: uniforms.uFog, uInk: { value: new THREE.Color() }, uHalo: { value: new THREE.Color() } };
  const vertexShader = /* glsl */`
    attribute vec4 aPos, aUv, aOff;
    uniform vec2 uViewport;
    uniform float uRelief;
    uniform vec2 uFog;
    varying vec2 vUv;
    varying float vA;
    void main() {
      vec4 mv = viewMatrix * vec4(aPos.x, aPos.w * uRelief + aPos.y + ${LIFT_M.toFixed(1)}, aPos.z, 1.0);
      float d = length(mv.xyz);
      mv.xyz *= max(d - ${PULL_M.toFixed(1)}, 1.0) / d;
      vec4 clip = projectionMatrix * mv;
      float px = aOff.z / ${FONT_EM};
      vec2 o = vec2(aOff.x + position.x * aOff.y, position.y - 0.5) * px;
      clip.xy += o * 2.0 / uViewport * clip.w;
      gl_Position = clip;
      vUv = mix(aUv.xy, aUv.zw, position.xy);
      vA = aOff.w * (1.0 - smoothstep(${NEAR_M.toFixed(1)}, ${FAR_M.toFixed(1)}, d)) * (1.0 - smoothstep(uFog.x, uFog.y, d));
    }`;
  const material = halo => new THREE.ShaderMaterial({
    uniforms: shared, vertexShader, transparent: true, depthWrite: false, depthTest: true,
    fragmentShader: /* glsl */`
      uniform sampler2D uAtlas;
      uniform vec3 uInk, uHalo;
      varying vec2 vUv;
      varying float vA;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        float a = ${halo ? 't.g * 0.92' : 't.r'} * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(${halo ? 'uHalo' : 'uInk'}, a);
      }`,
  });
  const haloMesh = new THREE.Mesh(geo, material(true)), inkMesh = new THREE.Mesh(geo, material(false));
  haloMesh.renderOrder = 5; inkMesh.renderOrder = 6;
  haloMesh.frustumCulled = inkMesh.frustumCulled = false;
  group.add(haloMesh, inkMesh);

  // ---- Labels: gid -> {gid, text, a (alpha), t (target), px}
  const live = new Map();
  let dirty = true, shown = 0, lastPicked = [];
  const v = new THREE.Vector3();
  const layout = text => {
    let w = 0;
    for (const ch of text) { if (!glyphs.has(ch)) { chars += ch; atlasFor = null; } w += glyphs.get(ch)?.adv || 0.5; }
    return w;
  };

  function update() {
    if (!on || blocked()) { for (const l of live.values()) l.t = 0; shown = 0; lastPicked = []; return; }
    if (!fontReady()) return;
    if (!index) buildIndex();
    const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const relief = uniforms.uRelief.value;
    const { x0, z0, nx, nz, start, gids } = index;
    const i0 = Math.max(0, Math.floor((cx - FAR_M - x0) / CELL_M)), i1 = Math.min(nx - 1, Math.floor((cx + FAR_M - x0) / CELL_M));
    const j0 = Math.max(0, Math.floor((cz - FAR_M - z0) / CELL_M)), j1 = Math.min(nz - 1, Math.floor((cz + FAR_M - z0) / CELL_M));
    const cand = [];
    const first = new Set(priority().filter(g => g >= 0));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = i + nx * j;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const g = gids[k];
        if (top[g] < 0) continue;   // its tile is not in yet
        const x = xOf(g), z = zOf(g), y = ground[g] * relief + top[g] + LIFT_M;
        const d = Math.hypot(x - cx, y - cy, z - cz);
        if (d > FAR_M) continue;
        v.set(x, y, z).project(camera);
        if (v.z > 1 || v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.05) continue;
        if (hidden(g) && !first.has(g)) continue;
        cand.push({ g, d, sx: (v.x + 1) * W / 2, sy: (1 - v.y) * H / 2, s: first.has(g) ? -1e9 : d - 2.5 * top[g] });
      }
    }
    cand.sort((a, b) => a.s - b.s);
    // Greedy: a label goes only where no accepted one's box (with a margin) overlaps it, in a screen grid of 80 px.
    const taken = new Map(), G = 80, picked = [];
    for (const c of cand) {
      if (picked.length >= MAX) break;
      let l = live.get(c.g);
      const text = l?.text ?? textOf(c.g);
      if (!text) continue;
      const px = sizeAt(c.d), w = layout(text) * px / FONT_EM + 6, h = px * 1.25 + 4;
      const bx0 = c.sx - w / 2, bx1 = c.sx + w / 2, by0 = c.sy - h / 2, by1 = c.sy + h / 2;
      let free = true;
      for (let gy = Math.floor(by0 / G); free && gy <= Math.floor(by1 / G); gy++) {
        for (let gx = Math.floor(bx0 / G); free && gx <= Math.floor(bx1 / G); gx++) {
          for (const r of taken.get(gx + ',' + gy) || []) if (r[0] < bx1 && r[1] > bx0 && r[2] < by1 && r[3] > by0) { free = false; break; }
        }
      }
      if (!free) continue;
      const box = [bx0, bx1, by0, by1];
      for (let gy = Math.floor(by0 / G); gy <= Math.floor(by1 / G); gy++) {
        for (let gx = Math.floor(bx0 / G); gx <= Math.floor(bx1 / G); gx++) {
          const key = gx + ',' + gy;
          if (!taken.has(key)) taken.set(key, []);
          taken.get(key).push(box);
        }
      }
      if (!l) { l = { gid: c.g, text, a: 0, t: 1, px }; live.set(c.g, l); }
      l.px = px; l.t = 1; l.keep = true;
      picked.push(c.g);
    }
    for (const l of live.values()) { if (!l.keep) l.t = 0; l.keep = false; }
    shown = picked.length;
    lastPicked = picked;
    dirty = true;
  }

  function write() {
    let n = 0;
    const P = aPos.array, U = aUv.array, O = aOff.array;
    for (const l of live.values()) {
      if (l.a <= 0) continue;
      const w = layout(l.text);
      let left = -w / 2;
      const x = xOf(l.gid), z = zOf(l.gid);
      for (const ch of l.text) {
        const gl = glyphs.get(ch);
        if (!gl) { left += 0.5; continue; }
        if (n >= GLYPHS_MAX) break;
        const p = pad / ATLAS_PX;
        P.set([x, top[l.gid], z, ground[l.gid]], 4 * n);
        U.set([gl.u0, gl.v0, gl.u1, gl.v1], 4 * n);
        O.set([left - p, gl.w, l.px, l.a], 4 * n);
        left += gl.adv; n++;
      }
    }
    geo.instanceCount = n;
    for (const a of [aPos, aUv, aOff]) { a.needsUpdate = true; a.clearUpdateRanges?.(); a.addUpdateRange?.(0, n * 4); }
  }

  function step(dt) {
    if (fontReady() && atlasFor !== font()) drawAtlas();
    renderer.getDrawingBufferSize(shared.uViewport.value);
    const ratio = renderer.getPixelRatio();
    shared.uViewport.value.divideScalar(ratio);   // offsets are CSS pixels
    for (const l of live.values()) {
      if (l.a === l.t) continue;
      l.a = l.t > l.a ? Math.min(l.t, l.a + dt / FADE_S) : Math.max(l.t, l.a - dt / FADE_S);
      if (l.a <= 0 && l.t === 0) live.delete(l.gid);
      dirty = true;
    }
    if (dirty) { dirty = false; write(); }
    group.visible = on && geo.instanceCount > 0;
  }

  function retheme() {
    const th = theme();
    shared.uInk.value.set(th.ui['--ink']);
    shared.uHalo.value.set(th.ui['--panel']);
    atlasFor = null;   // drawn again in the new font once it is in (step)
  }
  function relang() { for (const l of live.values()) l.text = textOf(l.gid) || l.text; dirty = true; }
  function setOn(value) { on = !!value; if (!on) { live.clear(); shown = 0; lastPicked = []; dirty = true; } }

  // What the headless check reads: the labels shown now, their texts and screen positions.
  function state() {
    const list = [];
    for (const g of lastPicked) {
      const l = live.get(g);
      const y = ground[g] * uniforms.uRelief.value + top[g] + LIFT_M;
      v.set(xOf(g), y, zOf(g)).project(camera);
      list.push({ gid: g, text: l?.text, alpha: Math.round((l?.a ?? 0) * 100) / 100,
        x: Math.round((v.x + 1) * renderer.domElement.clientWidth / 2), y: Math.round((1 - v.y) * renderer.domElement.clientHeight / 2),
        top: Math.round(top[g] * 10) / 10 });
    }
    return { on, shown, glyphs: geo.instanceCount, live: live.size, labels: list };
  }

  return { group, addTile, update, step, retheme, relang, setOn, state, get on() { return on; }, get shown() { return shown; } };
}
