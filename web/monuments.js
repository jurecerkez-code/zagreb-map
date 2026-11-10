// Monuments: Zagreb's statues, busts, columns, obelisks, fountains and memorials (data/<version>/monuments.json,
// pipeline/s05_zagreb_monuments.py, from OpenStreetMap, Wikidata, Commons and Wikipedia). The 3D city model has
// buildings only, so a square like Trg bana Jelačića reads empty without them. Each monument is a small low-poly
// shape of its kind (a figure on a pedestal, a bust on a pillar, a column, an obelisk, a basin, a stele), built here
// once per kind and drawn as one InstancedMesh per kind: about ten draw calls for every monument in the city. The ban
// Jelačić statue gets its own equestrian figure (rider on a horse with raised sabre on a stone pedestal).
// Sizes: the tagged height (OSM or Wikidata P2048), else a typical height for the kind (pipeline side).
// The timeline: a monument shows from its year (unveiling), and not in a `removed` span ([[1947, 1989]] for Jelačić);
// one without a year always shows. Colours: bronze, stone and metal per look (MATERIALS), lit by the map's sun.
import { DISPLAY_FOG_GLSL } from './display-fog.js';
import { SUN_LIGHT } from './themes.js';

export const MONUMENTS_KEY = 'hfh-monuments';
export const monumentsOnFrom = stored => stored !== 'off';   // on by default

// Per look: bronze, stone, metal (a figure's material), water (a fountain's basin). Unknown looks fall back to arg.
// Foto shares Arg's woven materials because the two looks share their authored palette.
const ARG_MATERIALS = { bronze: '#5f5340', stone: '#cdc6b8', metal: '#8c949a', gold: '#b8963e', water: '#4f8197' };
export const MATERIALS = {
  arg: ARG_MATERIALS,
  foto: ARG_MATERIALS,
  kalk: { bronze: '#6a4f35', stone: '#e0d4bd', metal: '#8f969c', gold: '#bf9a45', water: '#7fa2b0' },
  blatimme: { bronze: '#a98656', stone: '#8d93a0', metal: '#a3afbf', gold: '#e6c066', water: '#3c6f9e' },
  paper: { bronze: '#57514b', stone: '#dddad2', metal: '#8f969a', gold: '#b39445', water: '#9fb9b8' },
};
MATERIALS.foto = { ...MATERIALS.arg };
MATERIALS.lab = { ...MATERIALS.blatimme, gold: '#d8b55a' };
const MAT_INDEX = { bronze: 0, stone: 1, metal: 2 };
// Nominal height (m) each kind's shape is built at; an instance is scaled to its own height.
export const NOMINAL = { equestrian: 9, statue: 7, bust: 3, column: 12, obelisk: 6, fountain: 2.5, sculpture: 3.5,
  memorial: 3.5, stele: 2.2, cross: 3 };
export const KINDS = Object.keys(NOMINAL);
// Where each kind's figure starts (m, at its nominal height): a monument on the city model's own plinth (`plinth`, m,
// pipeline/s05_zagreb_monuments.py) is lifted so its figure stands on that plinth's top rather than inside it.
const PEDESTALLED = new Set(['equestrian', 'statue', 'bust', 'column']);
export const FIGURE_AT = { equestrian: 4.6, statue: 3.3, bust: 1.77, column: 1.6, obelisk: 0.75, fountain: 0, sculpture: 0.25,
  memorial: 0.3, stele: 0.05, cross: 0.2 };

// Shown at `year` (the timeline's upper handle)? Pure, tested by the check script.
export function shownAt(m, year, yearMax) {
  if (year >= yearMax) return !(m.removed || []).some(([a, b]) => b >= yearMax);
  if (m.year && year < m.year) return false;
  return !(m.removed || []).some(([a, b]) => year >= a && year <= b);
}

// ---------- Geometry: parts tagged 0 = pedestal stone, 1 = the figure (its material), 2 = water, 3 = gold
function shapes(THREE) {
  const parts = [];
  const add = (g, part, m) => { if (m) g.applyMatrix4(m); parts.push([g.index ? g.toNonIndexed() : g, part]); };
  const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
  const box = (w, h, d, x, y, z, part, rx = 0, ry = 0, rz = 0) => add(new THREE.BoxGeometry(w, h, d), part, M(x, y + h / 2, z, rx, ry, rz));
  const cyl = (r0, r1, h, x, y, z, part, seg = 8, rx = 0, rz = 0, ry = 0) =>
    add(new THREE.CylinderGeometry(r1, r0, h, seg), part, M(x, y, z, rx, ry, rz).multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0)));
  const ball = (r, x, y, z, part, sx = 1, sy = 1, sz = 1) => add(new THREE.IcosahedronGeometry(r, 1), part, M(x, y, z, 0, 0, 0, sx, sy, sz));
  const lathe = (pts, part, seg = 10, m = null) => add(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg), part, m);
  // A stepped pedestal: plinth, die, cornice; returns its top.
  const pedestal = (w, d, h) => {
    box(w * 1.18, h * 0.12, d * 1.18, 0, -0.3, 0, 0);
    box(w, h * 0.74, d, 0, h * 0.12 - 0.3, 0, 0);
    box(w * 1.1, h * 0.14, d * 1.1, 0, h * 0.86 - 0.3, 0, 0);
    return h - 0.3;
  };
  // A standing figure (front +x) of height s from y0: legs, coat, arms, head.
  const figure = (y0, s, part = 1, gesture = false) => {
    cyl(0.07 * s, 0.06 * s, 0.46 * s, 0, y0, -0.07 * s, part, 6);
    cyl(0.07 * s, 0.06 * s, 0.46 * s, 0.03 * s, y0, 0.07 * s, part, 6);
    lathe([[0, 0], [0.2 * s, 0.02 * s], [0.17 * s, 0.2 * s], [0.13 * s, 0.38 * s], [0.15 * s, 0.44 * s], [0.06 * s, 0.5 * s], [0, 0.5 * s]], part, 8,
      M(0, y0 + 0.36 * s, 0, 0, 0, 0, 1, 1, 0.8));
    cyl(0.045 * s, 0.04 * s, 0.34 * s, 0, y0 + 0.84 * s, -0.17 * s, part, 5, 0.12, 0);
    if (gesture) cyl(0.045 * s, 0.035 * s, 0.36 * s, 0.02 * s, y0 + 0.82 * s, 0.17 * s, part, 5, -0.5, -0.9);
    else cyl(0.045 * s, 0.04 * s, 0.34 * s, 0, y0 + 0.84 * s, 0.17 * s, part, 5, -0.12, 0);
    cyl(0.05 * s, 0.045 * s, 0.06 * s, 0, y0 + 0.86 * s, 0, part, 6);
    ball(0.075 * s, 0.01 * s, y0 + 0.95 * s, 0, part, 1, 1.15, 1);
  };
  const kinds = {};
  const take = () => { const p = parts.splice(0); return p; };

  // Statue on a pedestal (7 m): pedestal 3.3 m, figure 3.7 m.
  figure(pedestal(1.9, 1.9, 3.6), 3.7, 1, true); kinds.statue = take();
  // Bust (3 m): a pillar and a bust.
  box(0.95, 0.18, 0.95, 0, -0.3, 0, 0); box(0.62, 1.75, 0.62, 0, -0.12, 0, 0); box(0.74, 0.14, 0.74, 0, 1.63, 0, 0);
  lathe([[0, 0], [0.42, 0.02], [0.4, 0.3], [0.3, 0.52], [0.12, 0.6], [0, 0.6]], 1, 10, M(0, 1.77, 0, 0, 0, 0, 0.75, 1, 1));
  cyl(0.12, 0.1, 0.16, 0, 2.3, 0, 1, 6); ball(0.21, 0.02, 2.62, 0, 1, 1, 1.2, 0.95); kinds.bust = take();
  // Column (12 m): base, shaft, capital, a gilded figure on top.
  box(2.2, 0.5, 2.2, 0, -0.3, 0, 0); box(1.6, 1.4, 1.6, 0, 0.2, 0, 0);
  cyl(0.42, 0.34, 7.4, 0, 1.6, 0, 0, 12); box(1.0, 0.45, 1.0, 0, 9.0, 0, 0);
  figure(9.45, 2.55, 3); kinds.column = take();
  // Obelisk (6 m): base, tapering shaft, pyramidion.
  box(1.5, 0.35, 1.5, 0, -0.3, 0, 0); box(1.05, 0.7, 1.05, 0, 0.05, 0, 0);
  cyl(0.5, 0.33, 4.4, 0, 0.75, 0, 1, 4, 0, 0, Math.PI / 4); cyl(0.33, 0.0, 0.85, 0, 5.15, 0, 1, 4, 0, 0, Math.PI / 4);
  kinds.obelisk = take();
  // Fountain (2.5 m): a round basin with a rim, water, and a central pillar with a bowl.
  lathe([[2.6, -0.3], [2.6, 0.55], [2.35, 0.6], [2.3, 0.3], [0, 0.3]], 0, 20);
  add(new THREE.CircleGeometry(2.3, 20), 2, M(0, 0.42, 0, -Math.PI / 2));
  cyl(0.3, 0.22, 1.5, 0, 0.3, 0, 0, 8); lathe([[0, 0], [0.75, 0.2], [0.8, 0.3], [0.6, 0.25], [0, 0.22]], 0, 12, M(0, 1.8, 0));
  cyl(0.12, 0.05, 0.45, 0, 2.05, 0, 1, 6); kinds.fountain = take();
  // Sculpture (3.5 m): a low plinth and a smooth upright form.
  box(1.4, 0.55, 1.4, 0, -0.3, 0, 0);
  lathe([[0, 0], [0.42, 0.05], [0.55, 0.7], [0.35, 1.5], [0.5, 2.2], [0.28, 2.8], [0, 2.95]], 1, 9, M(0, 0.25, 0, 0, 0, 0.12, 1, 1, 0.7));
  kinds.sculpture = take();
  // Memorial (3.5 m): two steps and an upright stone slab.
  box(2.6, 0.3, 1.9, 0, -0.3, 0, 0); box(2.1, 0.3, 1.4, 0, 0, 0, 0); box(1.5, 3.2, 0.42, 0, 0.3, 0, 1, 0, Math.PI / 2, 0);
  kinds.memorial = take();
  // Stele (2.2 m): a slab on a low base.
  box(1.3, 0.35, 0.8, 0, -0.3, 0, 0); box(0.9, 2.15, 0.25, 0, 0.05, 0, 1, 0, Math.PI / 2, 0); kinds.stele = take();
  // Cross (3 m).
  box(1.0, 0.5, 1.0, 0, -0.3, 0, 0); box(0.22, 2.8, 0.22, 0, 0.2, 0, 1); box(0.22, 0.22, 1.2, 0, 2.15, 0, 1); kinds.cross = take();

  // Equestrian (9 m, front +x): long pedestal 4.6 m; horse and rider with a raised sabre.
  {
    const t = pedestal(3.4, 1.9, 4.9);   // top ≈ 4.6
    const hb = t + 1.25;                 // horse belly height
    add(new THREE.CylinderGeometry(0.42, 0.46, 1.9, 10), 1, M(0.05, hb + 0.35, 0, 0, 0, Math.PI / 2, 1, 1, 0.82));
    ball(0.46, 0.95, hb + 0.38, 0, 1, 1, 0.95, 0.82); ball(0.48, -0.85, hb + 0.36, 0, 1, 1, 0.95, 0.85);
    cyl(0.3, 0.2, 1.05, 1.05, hb + 0.45, 0, 1, 8, 0, -0.62);            // neck, raised forward
    add(new THREE.CylinderGeometry(0.13, 0.2, 0.72, 7), 1, M(1.78, hb + 1.18, 0, 0, 0, -2.05));  // head, nose down-forward
    box(0.08, 0.5, 0.1, 1.38, hb + 0.95, 0, 1, 0, 0, -0.62);          // mane
    // legs: hind pair planted, front left raised and bent
    for (const [x, z, a] of [[-1.05, -0.24, 0.12], [-1.0, 0.24, 0.05], [0.88, 0.24, -0.06]]) cyl(0.11, 0.075, 1.32, x, t - 0.02, z, 1, 6, 0, a);
    cyl(0.11, 0.08, 0.66, 0.95, hb - 0.08, -0.24, 1, 6, 0, -2.5); cyl(0.08, 0.07, 0.58, 1.35, hb - 0.61, -0.24, 1, 6, 0, 2.84);
    cyl(0.12, 0.05, 1.0, -1.25, hb + 0.62, 0, 1, 6, 0, 2.45);           // tail
    // rider: thighs over the barrel, torso, head with a cap, left arm on the reins, right arm and sabre raised forward
    const ry = hb + 0.82;
    for (const z of [-0.36, 0.36]) cyl(0.11, 0.09, 0.85, 0.32, ry - 0.62, z, 1, 6, 0, 0.35);
    lathe([[0, 0], [0.26, 0.02], [0.24, 0.4], [0.17, 0.72], [0.07, 0.8], [0, 0.8]], 1, 8, M(0.0, ry - 0.05, 0, 0, 0, -0.08, 1, 1, 0.82));
    ball(0.15, 0.06, ry + 0.95, 0, 1, 1, 1.15, 1); cyl(0.15, 0.13, 0.16, 0.06, ry + 1.06, 0, 1, 7);
    cyl(0.06, 0.05, 0.58, 0.1, ry + 0.6, -0.24, 1, 5, -0.25, -2.0);      // left arm to the reins
    cyl(0.065, 0.05, 0.62, 0.1, ry + 0.68, 0.3, 1, 5, 0, -0.93);      // right arm, raised forward
    add(new THREE.BoxGeometry(0.04, 1.25, 0.07), 1, M(0.62, ry + 1.05, 0.3, 0, 0, -0.5)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0.625, 0)));       // sabre
    kinds.equestrian = take();
  }
  // Merge each kind into one non-indexed geometry with a per-vertex part.
  const out = {};
  for (const [k, list] of Object.entries(kinds)) {
    let n = 0;
    for (const [g] of list) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), part = new Float32Array(n);
    let o = 0;
    for (const [g, p] of list) {
      if (!g.attributes.normal) g.computeVertexNormals();
      pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
      part.fill(p, o, o + g.attributes.position.count);
      o += g.attributes.position.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    g.computeBoundingSphere();
    out[k] = g;
  }
  return out;
}

// Pseudo-random facing for a monument without a tagged direction: stable per id.
function hashAngle(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 360); }

export function makeMonuments(THREE, { list, uniforms, surfaceAt, camera, renderer, look, yearMax }) {
  const group = new THREE.Group();
  group.name = 'monuments';
  const geos = shapes(THREE);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uYear: uniforms.uYear, uSun: uniforms.uSun, uSunCol: uniforms.uSunCol, uSkyCol: uniforms.uSkyCol,
      uNight: uniforms.uNight, uFog: uniforms.uFog, uFogColor: uniforms.uFogColor,
      uFogDisplay: uniforms.uFogDisplay,
      uYearMax: { value: yearMax }, uStone: { value: new THREE.Color() }, uFig: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
      uWater: { value: new THREE.Color() }, uGold: { value: new THREE.Color() } },
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float aPart;
      attribute vec4 aSpan;   // from year, hidden from, hidden to, material index
      uniform float uYear, uYearMax;
      varying vec3 vN; varying float vPart, vMat, vDEye, vY;
      void main() {
        bool hidden = (aSpan.x > 0.0 && uYear < aSpan.x) || (uYear >= aSpan.y && uYear <= aSpan.z) || (uYear >= uYearMax && aSpan.z >= uYearMax);
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vPart = aPart; vMat = aSpan.w; vY = position.y;
        vec4 mv = viewMatrix * w;
        vDEye = length(mv.xyz);
        gl_Position = hidden ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uSun, uSunCol, uSkyCol, uFogColor, uStone, uFig[3], uWater, uGold;
      uniform float uNight;
      uniform vec2 uFog;
      ${DISPLAY_FOG_GLSL}
      varying vec3 vN; varying float vPart, vMat, vDEye, vY;
      void main() {
        vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 c = vPart < 0.5 ? uStone : vPart < 1.5 ? uFig[int(vMat + 0.5)] : vPart < 2.5 ? uWater : uGold;
        float spec = vPart > 0.5 && vPart < 1.5 && vMat < 0.5 ? pow(max(dot(reflect(-normalize(uSun), n), vec3(0.0, 1.0, 0.0)), 0.0), 12.0) * 0.18 : 0.0;
        vec3 direct = uSunCol * (max(dot(n, normalize(uSun)), 0.0) * ${SUN_LIGHT.direct.toFixed(1)});
        vec3 ambient = uSkyCol * (mix(0.6, 1.0, n.y * 0.5 + 0.5) * ${SUN_LIGHT.skyFill.toFixed(1)});
        c = c * (direct + ambient) + spec;
        c = mix(c, c * vec3(0.30, 0.36, 0.56), uNight);
        gl_FragColor = vec4(c, 1.0);
        // #24: the display transform is the renderer's own tail
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb = displayFog(gl_FragColor.rgb, vDEye, 1.0);
      }`,
  });
  // One InstancedMesh per kind.
  const byKind = {};
  list.forEach((m, i) => { const k = NOMINAL[m.kind] ? m.kind : 'memorial'; (byKind[k] ||= []).push(i); });
  const meshes = [], slot = new Array(list.length);
  for (const [k, idx] of Object.entries(byKind)) {
    const g = geos[k].clone();
    const span = new Float32Array(idx.length * 4);
    idx.forEach((i, j) => {
      const m = list[i], r = (m.removed || [])[0];
      span.set([m.year || 0, r ? r[0] : 1e5, r ? r[1] : -1e5, MAT_INDEX[m.mat] ?? 0], j * 4);
      slot[i] = [meshes.length, j];
    });
    g.setAttribute('aSpan', new THREE.InstancedBufferAttribute(span, 4));
    const mesh = new THREE.InstancedMesh(g, mat, idx.length);
    mesh.userData = { kind: k, idx };
    mesh.frustumCulled = false;   // instances span the city; the per-kind bounds are not computed per instance
    meshes.push(mesh);
    group.add(mesh);
  }
  const scale = m => Math.min(3, Math.max(0.4, (m.h || NOMINAL[m.kind] || 3) / (NOMINAL[m.kind] || 3)));
  const lift = m => (m.plinth && m.plinth <= 7 && PEDESTALLED.has(m.kind) ? Math.max(0, m.plinth - FIGURE_AT[m.kind] * scale(m)) : 0);
  const yaw = m => THREE.MathUtils.degToRad(90 - (m.dir ?? hashAngle(m.id)));
  const ys = new Float32Array(list.length).fill(NaN);
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), s3 = new THREE.Vector3(), mx = new THREE.Matrix4();
  // Place every monument on the ground as drawn now (the relief slider moves it); only what moved is written.
  function place() {
    let moved = false;
    list.forEach((m, i) => {
      const y = surfaceAt(m.x, m.z) + lift(m);
      if (Math.abs(y - ys[i]) < 0.01) return;
      ys[i] = y; moved = true;
      const [k, j] = slot[i], sc = scale(m);
      meshes[k].setMatrixAt(j, mx.compose(v.set(m.x, y, m.z), q.setFromAxisAngle(up, yaw(m)), s3.set(sc, sc, sc)));
    });
    if (moved) for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }
  function retheme() {
    const C = MATERIALS[look()] || MATERIALS.arg;
    mat.uniforms.uStone.value.set(C.stone);
    mat.uniforms.uFig.value[0].set(C.bronze); mat.uniforms.uFig.value[1].set(C.stone); mat.uniforms.uFig.value[2].set(C.metal);
    mat.uniforms.uWater.value.set(C.water); mat.uniforms.uGold.value.set(C.gold);
  }
  let on = true;
  function setOn(v) { on = !!v; group.visible = on; }
  // The monument under the screen point (x, y), or null: its projected box (base to top, at least 14 px wide),
  // nearest to the camera first. Only shown ones within 2.5 km count.
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  function under(x, y) {
    if (!group.visible) return null;
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight, year = uniforms.uYear.value;
    let best = null, bestD = Infinity;
    list.forEach((m, i) => {
      if (!shownAt(m, year, yearMax) || Number.isNaN(ys[i])) return;
      const d = Math.hypot(m.x - camera.position.x, m.z - camera.position.z);
      if (d > 2500 || d >= bestD) return;
      const H = (m.h || NOMINAL[m.kind]) , R = Math.max(1.2, H * 0.28);
      a.set(m.x, ys[i], m.z).project(camera); b.set(m.x, ys[i] + H, m.z).project(camera);
      if (a.z > 1 || b.z > 1) return;
      const ax = (a.x + 1) / 2 * w, ay = (1 - a.y) / 2 * h, bx = (b.x + 1) / 2 * w, by = (1 - b.y) / 2 * h;
      const projH = Math.abs(ay - by);   // the statue's projected height: the grab box scales with it
      // A visitor clicks what they see: the horse, the flag, the plinth edge. The old box (7 px half, 4 px slack)
      // missed those at viewing distance and the building block behind answered (check: monument_pick_check.mjs).
      const half = Math.max(16, R / Math.max(1, d) * h * 0.9, projH * 0.5);
      const slack = Math.max(10, projH * 0.25);
      if (x < Math.min(ax, bx) - half || x > Math.max(ax, bx) + half || y < Math.min(ay, by) - slack || y > Math.max(ay, by) + slack) return;
      best = m; bestD = d;
    });
    return best;
  }
  // Where a monument stands on screen (its middle), for checks: [x, y] in CSS pixels, or null behind the camera.
  function screenAt(m) {
    const i = list.indexOf(m);
    if (i < 0 || Number.isNaN(ys[i])) return null;
    a.set(m.x, ys[i] + (m.h || 3) * 0.6, m.z).project(camera);
    if (a.z > 1) return null;
    return [(a.x + 1) / 2 * renderer.domElement.clientWidth, (1 - a.y) / 2 * renderer.domElement.clientHeight];
  }
  const shownCount = () => !group.visible ? 0 : list.filter(m => shownAt(m, uniforms.uYear.value, yearMax)).length;
  retheme();
  return { group, list, place, retheme, setOn, under, screenAt, shownCount, get on() { return on; }, draws: () => meshes.length };
}

// The monument's card: name, kind, year (unveiling; removal and return), sculptor, material, height, photo with its
// credit, the Wikipedia excerpt (the page's language, else Croatian, the language of nearly every article), links.
export function monumentCard(m, { T, esc, link, lang, photoHtml }) {
  const kind = T(`monument.type.${m.kind}`);
  const year = m.year ? T('monument.unveiled', { year: m.year }) : T('monument.noYear');
  const removed = (m.removed || []).map(([a, b]) => T('monument.removed', { from: a, to: b + 1 })).join('; ');
  const facts = [
    m.by?.length && [esc(T(m.by.length > 1 ? 'monument.sculptors' : 'monument.sculptor')), m.by.map(esc).join(', ')],
    [esc(T('monument.material')), esc(T(`monument.mat.${m.mat}`))],
    [esc(T('monument.height')), esc(m.hsrc && !/estimate/.test(m.hsrc) ? T('monument.height.m', { m: m.h }) : T('monument.height.est', { m: m.h }))],
    m.ins && [esc(T('monument.inscription')), `<q>${esc(m.ins)}</q>`],
  ].filter(Boolean);
  const exLang = m.ex?.[lang] ? lang : m.ex?.hr ? 'hr' : m.ex?.en ? 'en' : null;
  const ex = exLang && m.ex[exLang];
  const excerpt = ex ? `<section class="extract" lang="${exLang}"><p>${esc(ex.t)}</p>
      <p class="credit">${T('card.extract.credit', { wikipedia: link(`https://${exLang}.wikipedia.org/w/index.php?oldid=${+ex.r}`, 'Wikipedia'),
        licence: link('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0') })}</p></section>` : '';
  const links = [
    ...Object.entries(m.wp || {}).map(([l, t]) => [`https://${l}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`, `Wikipedia (${l})`]),
    m.qid && [`https://www.wikidata.org/wiki/${m.qid}`, 'Wikidata'],
    m.osm && [`https://www.openstreetmap.org/${m.osm}`, 'OpenStreetMap'],
  ].filter(Boolean);
  return `
    <button class="card-close" aria-label="${esc(T('card.close'))}">×</button>
    ${photoHtml || ''}
    <header class="card-head" style="--band:var(--panel);--band-ink:var(--ink)">
      <h3 id="card-title">${esc(m.name || kind)}</h3>
      ${m.en && lang === 'en' ? `<p class="en">${esc(m.en)}</p>` : ''}
      <div class="when"><span class="y">${esc(m.year || '')}</span><span class="period">${esc(T('monument.kind'))} · ${esc(kind)}</span></div>
    </header>
    <p class="dating">${esc(year)}${removed ? ` · ${esc(removed)}` : ''}</p>
    <section><dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
    ${excerpt}
    ${links.length ? `<section class="sources"><h4>${esc(T('card.readmore'))}</h4><p>${links.map(([h, t]) => link(h, t)).join(' · ')}</p></section>` : ''}
    <p class="credit monument-credit">${esc(T('monument.credit'))}</p>`;
}
