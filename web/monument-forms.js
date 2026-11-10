// Low-cost, instanced human monuments. A compact `depicts`/{pose,hair,gender,beard} is evidence, never biometric
// inference; name rules cover Juraj+dragon and named women. Instancing stays one draw per visible variant.
// Only position/normal/aPart are needed by monuments.js; the local merge avoids another vendored module.

export const FIGURE_VARIANTS = Object.freeze({
  statue: Object.freeze(['standing', 'seated', 'raised_arm', 'group']),
  bust: Object.freeze(['short_hair', 'beard', 'bob', 'updo']),
});
export const FIGURE_HEIGHT = Object.freeze({ statue: 7, bust: 3 });

const textOf = m => `${m?.name || ''} ${m?.name_en || ''}`.toLocaleLowerCase('hr')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const evidenceOf = m => {
  const d = m?.depicts;
  const values = Array.isArray(d) ? d : d && typeof d === 'object' ? [d] : [];
  return Object.assign({}, ...values.filter(x => x && typeof x === 'object'),
    typeof m?.evidence === 'object' && m.evidence ? m.evidence : {});
};
const flag = v => v === true || /^(yes|true|female|f|zena)$/i.test(String(v ?? ''));

export function monumentVariant(m) {
  if (!FIGURE_VARIANTS[m?.kind]) return '';
  const text = textOf(m), evidence = evidenceOf(m);
  if (m.kind === 'statue') {
    const pose = `${m.pose || ''} ${m.osm_tags?.pose || ''} ${m.osm_tags?.['artwork:pose'] || ''} ${evidence.pose || ''}`;
    if (new RegExp(`seated|sitting|sjede|sjedeci`, 'i').test(`${pose} ${text}`)) return 'seated';
    if ((Array.isArray(m.depicts) && m.depicts.length > 1)
      || /\b(group|two|three|dva|dvije|troje|grupa|obitelj|family)\b/i.test(text)) return 'group';
    if (/\b(raised|uzdignut\w*|podignut\w*|george|zmaj\w*|dragon)\b/i.test(`${pose} ${text}`)
      || /\bsvet\w*\s+jur\w*/i.test(text)) return 'raised_arm';
    return 'standing';
  }
  const gender = String(evidence.gender || evidence.sex || evidence.P21 || '').toLowerCase();
  const female = /female|f\b|zena|q6581072/.test(gender)
    || /\b(marija|djevica|zagorka|katarina|ivanka|vlasta|bosa|baka|gospa)\b/.test(text);
  if (female) return /updo|bun|punja|pundja/i.test(`${evidence.hair || evidence.hairstyle || ''} ${text}`) ? 'updo' : 'bob';
  return flag(evidence.beard) || /\b(brada|bearded)\b/.test(text) ? 'beard' : 'short_hair';
}

// Nearest segment, not nearest polyline vertex: square plazas and curved roads otherwise bias the front quite badly.
export function nearestStreetDirection(x, z, ways = [], points = new Float32Array()) {
  let best = Infinity, target = null;
  for (const way of ways || []) {
    const count = Number(way?.c), offset = Number(way?.o);
    if (!Number.isInteger(count) || !Number.isInteger(offset) || count < 2 || offset < 0) continue;
    for (let j = 0; j < count - 1; j++) {
      const a = (offset + j) * 2, b = a + 2;
      if (b + 1 >= points.length) continue;
      const ax = points[a], az = points[a + 1], dx = points[b] - ax, dz = points[b + 1] - az;
      const length2 = dx * dx + dz * dz;
      if (!Number.isFinite(length2) || length2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
      const px = ax + t * dx, pz = az + t * dz, distance2 = (px - x) ** 2 + (pz - z) ** 2;
      if (distance2 < best) { best = distance2; target = [px - x, pz - z]; }
    }
  }
  if (!target) return { vector: [0, -1], distance: null, source: 'default' };
  const distance = Math.sqrt(best);
  const clean = v => Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e6) / 1e6;
  return { vector: target.map(v => clean(v / (distance || 1))), distance, source: 'street' };
}

const CARDINAL = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
export function monumentFront(m, streets = {}) {
  const raw = m?.dir ?? m?.direction ?? m?.osm_tags?.direction;
  const degrees = typeof raw === 'string' && raw.toUpperCase() in CARDINAL ? CARDINAL[raw.toUpperCase()] : Number(raw);
  const clean = v => Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e6) / 1e6;
  if (raw !== null && raw !== '' && Number.isFinite(degrees)) {
    const radians = degrees * Math.PI / 180;
    return { vector: [clean(Math.sin(radians)), clean(-Math.cos(radians))], source: 'direction' };
  }
  if (typeof streets.nearestStreet === 'function') {
    const found = streets.nearestStreet(m?.x || 0, m?.z || 0);
    if (found?.vector) return { vector: [...found.vector], source: 'street' };
  }
  const nearest = nearestStreetDirection(m?.x || 0, m?.z || 0, streets.ways, streets.points);
  return { vector: nearest.vector, source: nearest.source };
}

// A part's matrix is baked before the merge. All eight canonical geometries are then independently normalized to the
// exact configured artwork height (7 m statue / 3 m bust). makeMonuments scales this by h, including the plinth.
export function makeFigureGeometry(T, kind, variant) {
  if (!FIGURE_VARIANTS[kind]?.includes(variant)) throw new Error(`unknown ${kind}/${variant} monument form`);
  const parts = [], attrs = [];
  const add = (geometry, at, scale, part = 1, rotate = null) => {
    geometry.scale(...scale);
    if (rotate) { geometry.rotateX(rotate[0]); geometry.rotateY(rotate[1]); geometry.rotateZ(rotate[2]); }
    geometry.translate(...at);
    parts.push(geometry); attrs.push(part);
  };
  const box = (at, scale, part = 0, rotate) => add(new T.BoxGeometry(1, 1, 1), at, scale, part, rotate);
  const ball = (at, scale, part = 1) => add(new T.SphereGeometry(1, 8, 4), at, scale, part);
  const cylinder = (at, scale, part = 1) => add(new T.CylinderGeometry(1, 1, 1, 8, 1), at, scale, part);
  const tapered = (at, top, bottom, height) => add(new T.CylinderGeometry(top, bottom, height, 8, 1), at, [1, 1, 1], 0);
  const pedestal = (bust = false) => {
    box([0, 0.13, 0], [bust ? 2.5 : 3.8, 0.26, bust ? 2.5 : 3.8]);
    box([0, bust ? 0.6 : 0.65, 0], [bust ? 1.75 : 2.7, bust ? 0.94 : 0.82, bust ? 1.75 : 2.7]);
    box([0, bust ? 1.1 : 1.12, 0], [bust ? 2 : 3.1, 0.18, bust ? 2 : 3.1]);
  };
  const head = (x, y, scale = 1, hair = 'short') => {
    ball([x, y, 0], [0.37 * scale, 0.48 * scale, 0.34 * scale]);
    ball([x, y + 0.36 * scale, -0.025], [0.38 * scale, 0.18 * scale, 0.35 * scale]); // hair, not a featureless ball
    ball([x, y - 0.02 * scale, 0.33 * scale], [0.09 * scale, 0.12 * scale, 0.13 * scale]); // nose
    if (hair === 'bob') {
      ball([x - 0.34 * scale, y - 0.05, 0], [0.12 * scale, 0.43 * scale, 0.34 * scale]);
      ball([x + 0.34 * scale, y - 0.05, 0], [0.12 * scale, 0.43 * scale, 0.34 * scale]);
    } else if (hair === 'updo') {
      ball([x, y + 0.58 * scale, -0.06], [0.23 * scale, 0.25 * scale, 0.23 * scale]);
    } else if (hair === 'beard') {
      ball([x, y - 0.35 * scale, 0.16 * scale], [0.31 * scale, 0.32 * scale, 0.24 * scale]);
      tapered([x, y - 0.58 * scale, 0.17 * scale], 0.24, 0.035, 0.36);
    }
  };
  const arm = (a, length) => cylinder(a, [0.13, length, 0.13], 1);
  const torso = (x, base, height, width = 0.52) => {
    cylinder([x, base + height / 2, 0], [width, height, width * 0.78]);
    box([x, base + 0.1, 0], [width * 1.8, 0.22, 0.64]);
  };

  if (kind === 'statue') {
    pedestal();
    if (variant === 'seated') {
      box([0, 1.65, -0.1], [1.75, 0.38, 1.55]);
      box([0, 2.35, -0.68], [1.65, 1.65, 0.22]);
      torso(0, 1.75, 2.35, 0.62);
      for (const side of [-1, 1]) {
        box([side * 0.36, 1.95, 0.72], [0.45, 0.44, 1.65]);   // thighs forward from the chair
        box([side * 0.36, 1.25, 1.32], [0.36, 1.10, 0.40]);    // seated shins
        arm([side * 0.75, 2.63, 0.42], 1.3);
      }
      head(0, 4.55, 1.05);
    } else if (variant === 'group') {
      for (const side of [-1, 1]) {
        const x = side * 0.64, height = side < 0 ? 3.55 : 3.15;
        for (const leg of [-1, 1]) box([x + leg * 0.19, 1.5, 0], [0.29, 1.8, 0.37]);
        torso(x, 2.0, height - 1.2, side < 0 ? 0.44 : 0.50);
        head(x, height + 1.6, side < 0 ? 0.92 : 0.84, side > 0 ? 'bob' : 'short');
      }
      // The linked shoulders/arms and two distinct silhouettes make the pair legible from the city map.
      box([0, 3.63, 0.12], [1.58, 0.24, 0.27], 1);
    } else {
      const raised = variant === 'raised_arm';
      for (const side of [-1, 1]) box([side * 0.32, 1.75, 0], [0.38, 2.0, 0.47]);
      tapered([0, 3.25, 0], 0.48, 0.88, 2.8);                  // long coat / robe, faceted in low silhouette
      torso(0, 4.35, 1.3, 0.58);
      head(0, 6.25, 1.0);
      arm([-0.78, 4.65, 0], 1.75);
      if (raised) {
        cylinder([0.80, 5.65, 0], [0.15, 2.0, 0.15], 1);        // unmistakable raised arm
        ball([0.80, 6.78, 0], [0.18, 0.19, 0.18]);
        cylinder([1.0, 5.65, 0.08], [0.045, 6.0, 0.045], 0);   // St George's / victor's staff
        box([-0.10, 1.4, 1.65], [2.5, 0.55, 1.5], 0);           // the low dragon / defeated form
      } else {
        arm([0.78, 4.65, 0], 1.75);
        box([0, 4.82, 0.52], [0.9, 0.7, 0.12], 0);              // a book/stone tablet in front
      }
    }
  } else {
    pedestal(true);
    if (variant === 'bob') {
      ball([0, 1.55, 0], [0.76, 0.48, 0.48]);
      cylinder([0, 1.76, 0], [0.22, 0.5, 0.22]);
      head(0, 2.34, 1.25, 'bob');
    } else if (variant === 'updo') {
      tapered([0, 1.47, 0], 0.34, 0.82, 0.68);                 // shoulders and draped dress
      ball([0, 1.67, 0], [0.62, 0.33, 0.40]);
      cylinder([0, 1.91, 0], [0.20, 0.48, 0.20]);
      head(0, 2.47, 1.12, 'updo');
    } else {
      box([0, 1.43, 0], [1.36, 0.50, 0.75], 1);                 // shoulders
      tapered([0, 1.47, 0], 0.46, 0.78, 0.58);
      cylinder([0, 1.82, 0], [0.23, 0.48, 0.23]);
      head(0, 2.36, 1.18, variant === 'beard' ? 'beard' : 'short');
      if (variant === 'short_hair') box([0, 1.50, 0.4], [0.16, 0.50, 0.10], 0); // lapels / tie
    }
  }
  const expanded = parts.map(g => g.index ? g.toNonIndexed() : g);
  const count = expanded.reduce((n, g) => n + g.attributes.position.count, 0);
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), part = new Float32Array(count);
  let at = 0;
  for (let i = 0; i < expanded.length; i++) {
    const g = expanded[i], n = g.attributes.position.count;
    position.set(g.attributes.position.array, at * 3);
    normal.set(g.attributes.normal.array, at * 3);
    part.fill(attrs[i], at, at + n);
    at += n;
    g.dispose();
    if (g !== parts[i]) parts[i].dispose();
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new T.BufferAttribute(normal, 3));
  geometry.setAttribute('aPart', new T.BufferAttribute(part, 1));
  const Index = count > 65_535 ? Uint32Array : Uint16Array;
  geometry.setIndex(new T.BufferAttribute(Index.from({ length: count }, (_, i) => i), 1));
  geometry.rotateY(Math.PI / 2); // local front is +x, the convention used by makeMonuments' yaw
  geometry.computeBoundingBox();
  const b = geometry.boundingBox, factor = FIGURE_HEIGHT[kind] / (b.max.y - b.min.y);
  geometry.translate(0, -b.min.y, 0);
  geometry.scale(factor, factor, factor);
  geometry.computeBoundingBox();
  return geometry;
}
