// The streets drawn on the map: every mapped highway as a ribbon of its own width at the ground's height, the pavements
// as their own thinner ribbons, and at night the 5,821 mapped street lamps as a glow with a pool of light under it.
// pipeline/s17_zagreb_roads.py writes them (OpenStreetMap, ODbL): roads.json is the index, roads.bin.gz the points.
//
// The ribbons are laid in 1,200 m tiles, the same size the buildings tile at, so the far ones are culled instead of
// drawn: 95,754 ways over 601,179 points is about 2.4M triangles, and only the tiles in view cost anything.
// A way is 2 vertices per point with the normals averaged at the joints, so a bend does not open a wedge.
//
// The colours are unlit (a road does not need the sun's shading) but they fade into the fog like the ground does, and
// they cool towards blue at night exactly as the walls do, because a bright street in a dark city would read as a lie.
import { gunzip } from './veg.js';

const TILE = 1200;          // metres: the buildings' own tile size
const LIFT = 0.12;          // metres above the ground: over the terrain, under nothing else
const KERB_LIFT = 0.06;     // the pavement band, just under the asphalt: one polygon each, no z-fighting between them
const KERB = 3.4;           // metres of pavement each side of a carriageway
const POOL_R = 12;          // metres of the light pool a lamp throws on the pavement
const POOL_Y = 0.14;        // metres above the ground, under the road at LIFT? no: pools lie on the pavement
const LAMP_H = 7.0;         // metres: the head of a Zagreb street lamp
const NIGHT_TINT = 'vec3(0.30, 0.36, 0.56)';   // the walls' own night cooling (app.js FRAG)

// The class palette: asphalt greys for the carriageway, warmer greys for the pavements, so a street reads from a
// pavement without either shouting. The motorway is the darkest, a service lane the lightest.
const COLOUR = {
  motorway: '#5b606a', trunk: '#61666f', primary: '#666b74', secondary: '#6c717a', tertiary: '#737880',
  residential: '#787d85', unclassified: '#7d828a', living_street: '#82878e', service: '#888d94', pedestrian: '#a29a8e',
  footway: '#b6b2ab', path: '#bdb9b2', steps: '#b0aba3', cycleway: '#b2afa9',
};
const PAVEMENT = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian']);
const SIDEWALK = '#b9b4ac';   // the band a carriageway sits in: the pavements on both sides, at a glance

function ribbon(tile, pts, o, n, w, colour, surfaceAt, lift = LIFT) {
  const half = w / 2;
  const base = tile.v;
  for (let i = 0; i < n; i++) {
    const x = pts[(o + i) * 2], z = pts[(o + i) * 2 + 1];
    // The direction through this point: the segment, or the average of the two at a joint, so a bend stays closed.
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let dx = pts[(o + i1) * 2] - pts[(o + i0) * 2], dz = pts[(o + i1) * 2 + 1] - pts[(o + i0) * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz * half, nz = dx * half;
    const y = surfaceAt(x, z) + lift;
    tile.pos.push(x + nx, y, z + nz, x - nx, y, z - nz);
    tile.col.push(colour[0], colour[1], colour[2], colour[0], colour[1], colour[2]);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    tile.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  tile.v += n * 2;
}

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

export async function makeRoads({ THREE, base, scene, surfaceAt, uniforms, on = true }) {
  const meta = await (await fetch(`${base}roads.json`)).json();
  const [ptsBuf, lampBuf] = await Promise.all(['roads.bin.gz', 'lamps.bin.gz']
    .map(f => fetch(`${base}${f}`).then(r => r.arrayBuffer()).then(gunzip)));
  const pts = new Float32Array(ptsBuf);
  const lampPts = new Float32Array(lampBuf);

  const group = new THREE.Group();
  group.name = 'roads';
  group.renderOrder = -1;          // under everything: a road is the floor of the scene

  const tiles = new Map();
  const colourCache = new Map();
  for (const way of meta.ways) {
    const n = way.c;
    if (n < 2) continue;
    const mid = way.o + (n >> 1);
    const key = `${Math.floor(pts[mid * 2] / TILE)},${Math.floor(pts[mid * 2 + 1] / TILE)}`;
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, tile = { pos: [], col: [], idx: [], v: 0 });
    let colour = colourCache.get(way.cls);
    if (!colour) {
      const c = new THREE.Color(COLOUR[way.cls] || '#94989c').convertSRGBToLinear();
      colourCache.set(way.cls, colour = [c.r, c.g, c.b]);
    }
    // A carriageway sits in its pavements: one wider band in the pavement colour under it, so every street has its
    // kerbs without a second dataset. A footway, a path, the steps and a cycleway are their own surface, not a road.
    if (!PAVEMENT.has(way.cls)) {
      let kerb = colourCache.get('__kerb');
      if (!kerb) {
        const c = new THREE.Color(SIDEWALK).convertSRGBToLinear();
        colourCache.set('__kerb', kerb = [c.r, c.g, c.b]);
      }
      ribbon(tile, pts, way.o, n, way.w + 2 * KERB, kerb, surfaceAt, KERB_LIFT);
    }
    ribbon(tile, pts, way.o, n, PAVEMENT.has(way.cls) ? Math.max(way.w, 1.6) : way.w, colour, surfaceAt);
  }

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uFog: uniforms.uFog,           // the ground's own fog, shared: the street fades with it
      uFogColor: uniforms.uFogColor,
      uNight: uniforms.uNight,
    },
    vertexShader: /* glsl */`
      attribute vec3 aColour;
      varying vec3 vColour;
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vColour = aColour;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uFogColor;
      uniform vec2 uFog;
      uniform float uNight;
      varying vec3 vColour;
      varying float vDepth;
      void main() {
        vec3 c = mix(vColour, vColour * ${NIGHT_TINT}, uNight);
        c = mix(c, uFogColor, smoothstep(uFog.x, uFog.y, vDepth));
        gl_FragColor = vec4(c, 1.0);
      }`,
    polygonOffset: true,             // the terrain writes its own depth at the same height: pull the street forward
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  let tris = 0;
  for (const tile of tiles.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(tile.pos, 3));
    geo.setAttribute('aColour', new THREE.Float32BufferAttribute(tile.col, 3));
    geo.setIndex(tile.idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    group.add(mesh);
    tris += tile.idx.length / 3;
  }

  // ---- street lamps: dark by day, and at night a warm head with a pool under it
  const lamps = new THREE.Group();
  lamps.name = 'streetlamps';
  lamps.visible = false;
  const glowTex = radialTexture(THREE, [[0, 0.95], [0.35, 0.45], [1, 0]]);
  const glowGeo = new THREE.BufferGeometry();
  const lampPos = new Float32Array((lampPts.length / 2) * 3);
  for (let i = 0; i < lampPts.length / 2; i++) {
    lampPos[i * 3] = lampPts[i * 2];
    lampPos[i * 3 + 1] = surfaceAt(lampPts[i * 2], lampPts[i * 2 + 1]) + LAMP_H;
    lampPos[i * 3 + 2] = lampPts[i * 2 + 1];
  }
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
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), v3 = new THREE.Vector3();
  for (let i = 0; i < lampPts.length / 2; i++) {
    const x = lampPts[i * 2], z = lampPts[i * 2 + 1];
    v3.set(x, surfaceAt(x, z) + POOL_Y, z);
    m.compose(v3, q, s);
    pools.setMatrixAt(i, m);
  }
  pools.instanceMatrix.needsUpdate = true;
  pools.frustumCulled = false;
  lamps.add(pools);
  group.add(lamps);

  scene.add(group);

  const api = {
    group,
    get drawn() { return { tiles: tiles.size, triangles: tris, lamps: lampPts.length / 2 }; },
    setNight(night) {
      lamps.visible = !!night && on;
    },
    setVisible(v) { group.visible = !!v && on; },
  };
  api.setNight(false);
  return api;
}
