// The streets drawn on the map (issue #27: the mesher lives in web/roads-worker.js, typed arrays in as typed
// arrays out; this file is the orchestrator). One ribbon per way, painted by the fragment shader into pavement,
// kerbstone and asphalt bands by distance from the centreline — the old map drew three overlapping ribbons where
// one does the work now. The ribbons lift like the buildings do: aT * uRelief - aCut * uCutK, so the Hills slider
// moves two uniforms and nothing is rebuilt (roads.rebuild() is gone; only the lamps still re-seat themselves).
//
// pipeline/s17_zagreb_roads.py writes the ways (OpenStreetMap, ODbL): roads.json the index, roads.bin.gz the
// points, lamps.bin.gz the 5,821 mapped street lamps lit at night.
import { gunzip } from './veg.js';
import { TILE, KERB, EDGE_W, LIFT, CLASSES, PAVEMENT } from './roads-worker.js';
import { nearestStreetDirection } from './monument-forms.js';
import { DISPLAY_FOG_GLSL } from './display-fog.js';
import { SUN_LIGHT } from './themes.js';
import { chooseDataFile, decodeRoads2, ROADS2_FORMAT } from './compact-data.js';

async function dataJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`data ${response.status}: ${url}`);
  return response.json();
}

// Name fetched here, not in a global config pointer: config belongs to this exact version. Old folders make the same
// requests as before. A v2 index may name only roads0.bin beside itself, never a parent or another version.
export async function loadStreetData(base, config = null) {
  const packed = config?.roads2 && typeof config.roads2 === 'object' ? config.roads2 : null;
  const file = chooseDataFile(config, 'roads2', 'roads.json', 'roads2.json');
  const meta = packed ?? await dataJson(`${base}${file}`);
  const compact = meta.format === ROADS2_FORMAT;
  if (compact && !['roads0.bin', 'roads2.bin.gz'].includes(meta.file)) throw new Error('roads2: bad sibling file');
  const [ptsBuf, lampBuf] = await Promise.all([compact ? meta.file : 'roads.bin.gz', 'lamps.bin.gz']
    .map(async name => {
      const response = await fetch(`${base}${name}`);
      if (!response.ok) throw new Error(`data ${response.status}: ${name}`);
      const bytes = await response.arrayBuffer();
      return name.endsWith('.gz') ? gunzip(bytes) : bytes;
    }));
  if (compact) {
    const decoded = decodeRoads2(meta, ptsBuf);
    return { meta: { ...meta, ways: decoded.ways }, pts: decoded.pts, xyz: decoded.xyz, lampPts: new Float32Array(lampBuf) };
  }
  return { meta, pts: new Float32Array(ptsBuf), xyz: null, lampPts: new Float32Array(lampBuf) };
}

// The class palette: asphalt greys for the carriageway, warmer greys for the pavements: measured off Zagreb
// (#4f5450 asphalt, #8d908e kerb side pavement), the motorway the darkest, a service lane the lightest. The row
// is laid out in roads-worker.js's CLASSES order — one vec3 per class index.
const COLOUR = {
  motorway: '#4a4e4b', trunk: '#4b4f4c', primary: '#4c504d', secondary: '#4e524f', tertiary: '#4f5350',
  residential: '#4f5450', unclassified: '#515652', living_street: '#545955', service: '#575c58', pedestrian: '#7d817b',
  footway: '#8d908e', path: '#9a9791', steps: '#8a8781', cycleway: '#8b8f8c', tram: '#4d524e',
};
const SIDEWALK = '#8d908e';   // the pavements a carriageway sits between, painted by proximity like the kerb
const EDGE = '#c9ccc9';       // kerbstone: the dressed granite between a Zagreb pavement and its asphalt reads near-white
const POOL_R = 12, POOL_Y = 0.14, LAMP_H = 7.0;
const NIGHT_TINT = 'vec3(0.30, 0.36, 0.56)';   // the walls' own night cooling (app.js FRAG)
const NEAR_M = 1500;          // tiles under this draw every class; past it only tertiary and above

// A soft round light: a radial falloff in a texture, so 5,821 of them cost two draw calls and no per-pixel maths.
function radialTexture(THREE, stops) {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [at, a] of stops) grad.addColorStop(at, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The fetch lands as early as it can (the page hands the layer in at boot); the grid lands when the terrain
// answers. The worker starts on the later of the two.
export async function makeRoads({ THREE, base, baseGrid = null, scene, surfaceAt, uniforms, on = true, config = null }) {
  const { meta, pts, lampPts } = await loadStreetData(base, config);
  // A card may be opened after the mesher transfers pts.buffer. Keep a small CPU copy for that later nearest-street view.
  const nearestPts = pts.slice();

  const group = new THREE.Group();
  group.name = 'roads';
  group.renderOrder = -1;          // under everything: a road is the floor of the scene

  // The shader: one draw per tile. Bands by signed distance across the ribbon; the class's own grey on the asphalt,
  // the pavement and kerb stones by proximity for a carriageway, the class's colour down the whole width for a
  // pavement way. Fog and the night's cooling exactly as before.
  const myUniforms = {
    uFog: uniforms.uFog,
    uFogColor: uniforms.uFogColor,
    uFogDisplay: uniforms.uFogDisplay,
    uNight: uniforms.uNight,
    uRelief: uniforms.uRelief,
    uCutK: uniforms.uCutK,
    uSun: uniforms.uSun,
    uSunCol: uniforms.uSunCol,
    uSkyCol: uniforms.uSkyCol,
    uHgt: uniforms.uHgt,
    uHgtN: uniforms.uHgtN,
    uHgtO: uniforms.uHgtO,
    uHgtCell: uniforms.uHgtCell,
    uHgtOn: uniforms.uHgtOn,
    uLift: { value: LIFT },
    uCls: { value: CLASSES.map(c => new THREE.Color(COLOUR[c] || '#94989c')) },
    uSide: { value: new THREE.Color(SIDEWALK) },
    uEdge: { value: new THREE.Color(EDGE) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: myUniforms,
    vertexShader: /* glsl */`
      attribute float aU, aHalf, aCls, aT, aCut;
      uniform float uRelief, uCutK, uLift;
      varying float vU, vHalf, vCls, vDepth;
      varying vec3 vWorld;
      void main() {
        vec4 w = vec4(position.x, aT * uRelief - aCut * uCutK + uLift, position.z, 1.0);
        vec4 mv = modelViewMatrix * w;
        vWorld = (modelMatrix * w).xyz;
        vU = aU; vHalf = aHalf; vCls = aCls; vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uFogColor;
      uniform vec2 uFog;
      uniform float uNight;
      uniform vec3 uCls[${CLASSES.length}], uSide, uEdge;
      uniform vec3 uSun, uSunCol, uSkyCol;
      uniform sampler2D uHgt;
      uniform vec2 uHgtN, uHgtO;
      uniform float uHgtCell, uHgtOn;
      ${DISPLAY_FOG_GLSL}
      varying float vU, vHalf, vCls, vDepth;
      varying vec3 vWorld;
      float cityHeight(vec2 xz) {
        vec2 uv = (xz - uHgtO) / (uHgtCell * uHgtN);
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -500.0;
        vec4 s = texture(uHgt, uv);
        return (s.r * 65280.0 + s.g * 255.0) * 0.1;
      }
      float sunShadow(vec3 p) {
        if (uHgtOn < 0.5 || uNight > 0.5) return 1.0;
        float horizontal = length(uSun.xz);
        if (horizontal < 0.06) return 1.0;
        vec2 dir = uSun.xz / horizontal;
        float rise = uSun.y / horizontal;
        float t = 10.0;
        for (int i = 0; i < 20; i++) {
          if (cityHeight(p.xz + dir * t) > p.y + t * rise + 1.5) return 0.0;
          t += 14.0 + float(i) * 6.0;
        }
        return 1.0;
      }
      vec3 lighting(vec3 n, float visibility) {
        vec3 direct = uSunCol * (max(dot(n, uSun), 0.0) * ${SUN_LIGHT.direct.toFixed(1)} * visibility);
        vec3 ambient = uSkyCol * (mix(0.6, 1.0, n.y * 0.5 + 0.5) * ${SUN_LIGHT.skyFill.toFixed(1)});
        return direct + ambient;
      }
      void main() {
        vec3 c = uCls[int(vCls + 0.5)];
        // A carriageway's bands by distance from the centreline: asphalt out to aHalf, the kerb just past it, the
        // pavement's tone at the flanks; fwidth anti-aliases the edges. A pavement way is solid across.
        float a = abs(vU);
        float fw = max(fwidth(a), 1e-4);
        float pave = (vCls >= ${CLASSES.indexOf('pedestrian')}.5 && vCls <= ${CLASSES.indexOf('cycleway')}.5) ? 1.0 : 0.0;
        float kerb = smoothstep(vHalf - fw, vHalf + fw, a) * (1.0 - smoothstep(vHalf + ${EDGE_W.toFixed(2)} - fw, vHalf + ${EDGE_W.toFixed(2)} + fw, a));
        float side = smoothstep(vHalf + ${EDGE_W.toFixed(2)} - fw, vHalf + ${EDGE_W.toFixed(2)} + fw, a);
        c = mix(c, uEdge, kerb * (1.0 - pave));
        c = mix(c, uSide, side * (1.0 - pave));
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        float visibility = mix(0.58, 1.0, sunShadow(vWorld));
        c *= lighting(n, visibility);
        gl_FragColor = vec4(c, 1.0);
        // #24: the display transform, then one Night dim and the display-space fog.
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * ${NIGHT_TINT}, uNight);
        gl_FragColor.rgb = displayFog(gl_FragColor.rgb, vDepth, 1.0);
      }`,
    polygonOffset: true,             // the terrain writes its own depth at the same height: pull the street forward
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  // ---- street lamps: dark by day, and at night a warm head with a pool under it (relift() now does only these
  // two draws — the streets themselves ride uRelief like the buildings, so there is nothing to rebuild)
  const lamps = new THREE.Group();
  lamps.name = 'streetlamps';
  lamps.visible = false;
  const glowTex = radialTexture(THREE, [[0, 0.95], [0.35, 0.45], [1, 0]]);
  const glowGeo = new THREE.BufferGeometry();
  const lampPos = new Float32Array((lampPts.length / 2) * 3);
  const seatLamp = i => {
    const x = lampPts[i * 2], z = lampPts[i * 2 + 1];
    lampPos[i * 3] = x; lampPos[i * 3 + 1] = surfaceAt(x, z) + LAMP_H; lampPos[i * 3 + 2] = z;
  };
  for (let i = 0; i < lampPts.length / 2; i++) seatLamp(i);
  glowGeo.setAttribute('position', new THREE.BufferAttribute(lampPos, 3));
  const glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({
    map: glowTex, color: 0xffd7a4, size: 11, sizeAttenuation: true, transparent: true, opacity: 0.92,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.frustumCulled = false;
  lamps.add(glow);

  const poolGeo = new THREE.PlaneGeometry(POOL_R * 2, POOL_R * 2).rotateX(-Math.PI / 2);
  const pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffc98a, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending,
    depthWrite: false,
  }), lampPts.length / 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), v3 = new THREE.Vector3();
  const seatPool = i => {
    v3.set(lampPts[i * 2], surfaceAt(lampPts[i * 2], lampPts[i * 2 + 1]) + POOL_Y, lampPts[i * 2 + 1]);
    m4.compose(v3, q, s1);
    pools.setMatrixAt(i, m4);
  };
  for (let i = 0; i < lampPts.length / 2; i++) seatPool(i);
  pools.instanceMatrix.needsUpdate = true;
  pools.frustumCulled = false;
  lamps.add(pools);
  group.add(lamps);
  scene.add(group);

  function relift() {
    for (let i = 0; i < lampPts.length / 2; i++) { seatLamp(i); seatPool(i); }
    glowGeo.attributes.position.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
  }

  // The worker's tiles land: one geometry per tile with the major classes leading the index (roads-worker.js
  // guarantees it), so a tile beyond 1.5 km draws only its first range, set by update(camera) each due frame.
  const meshes = [];
  let drawnTris = 0;

  function addTile(t) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
    geo.setAttribute('aU', new THREE.BufferAttribute(t.aU, 1));
    geo.setAttribute('aHalf', new THREE.BufferAttribute(t.aHalf, 1));
    geo.setAttribute('aCls', new THREE.BufferAttribute(t.aCls, 1));
    geo.setAttribute('aT', new THREE.BufferAttribute(t.aT, 1));
    geo.setAttribute('aCut', new THREE.BufferAttribute(t.aCut, 1));
    geo.setIndex(new THREE.BufferAttribute(t.idx, 1));
    // The culling sphere arrives computed (roads-worker.js): the main thread is array wrangling, not scans.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(t.sphere.x, t.sphere.y, t.sphere.z), t.sphere.r);
    geo.userData = { hiCount: t.hiCount, full: t.idx.length };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    group.add(mesh);
    meshes.push(mesh);
    drawnTris += t.tris;
  }

  function update(camera) {
    for (const m of meshes) {
      const b = m.geometry.boundingSphere;
      const far = b && (camera.position.x - b.center.x) ** 2 + (camera.position.z - b.center.z) ** 2 > NEAR_M * NEAR_M;
      const u = m.geometry.userData;
      const count = far && u.hiCount ? u.hiCount : u.full;
      if (m.geometry.drawRange.count !== count) m.geometry.setDrawRange(0, count);
    }
  }

  const api = {
    group, update,
    get drawn() { return { tiles: meshes.length, triangles: drawnTris, lamps: lampPts.length / 2 }; },
    relift,   // the streets ride uRelief like the buildings; only the lamps' seats are one breath of CPU
    nearestStreet: (x, z) => nearestStreetDirection(x, z, meta.ways, nearestPts),
    setNight(night) { lamps.visible = !!night && on; },
    setVisible(v) { group.visible = !!v && on; },
  };
  api.setNight(false);

  if (!baseGrid) return api;   // no terrain in this build: the streets stand flat at their lift, as before

  // The terrain is in: kick the worker with everything it needs, then build the tile meshes on the main thread.
  // The points transfer; the (t, cut) texture stays put for the ground's own shader, so it goes by clone. The
  // worker's round trip gets its own measure, reachable from perf.json as builders['roads-worker'].
  performance.mark('roads-worker-start');
  const worker = new Worker(new URL('roads-worker.js', import.meta.url), { type: 'module' });
  const answer = await new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = e => reject(e);
    worker.postMessage({ pts: pts.buffer, ways: meta.ways, tex: baseGrid.tex, grid: { x0: baseGrid.x0, z0: baseGrid.z0, cell: baseGrid.cell, nx: baseGrid.nx, nz: baseGrid.nz } },
      [pts.buffer]);
  });
  worker.terminate();
  performance.measure('roads-worker', 'roads-worker-start');   // fetch + bake on the other thread, wall time

  let mainMs = 0;
  for (const t of Object.values(answer.tiles)) {
    // Per-tile attribution: the stream is still flying (buildings' GL uploads own most of this thread right now),
    // so a single wall-clock measure of the loop reads contention, not roads. The sum of the tiles' own segments
    // is the main-thread cost issue #27 budgets (≤ 50 ms).
    const a = performance.now();
    addTile(t);
    mainMs += performance.now() - a;
  }
  performance.measure('roads', { start: performance.now() - mainMs, end: performance.now() });   // the loop's own time
  console.log(`[roads] ${meshes.length} tiles, ${drawnTris} tris, main thread ${Math.round(mainMs)} ms`);
  return api;
}
