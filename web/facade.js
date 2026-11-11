// The facades (#33, part 3): a wall's windows weighted by the era it was built in.
//
// The map already draws windows on every wall (FRAG's skin): a grid in metres along the wall and above its own foot, so
// they are the same real size on every building. That grid is the same on a baroque palace and on a 1970s block, which is
// the one place the city still reads as one material. This file gives the four eras their own proportions — the tall
// narrow bays of the historic city, the wider and lower secession bays, the horizontal window bands of the socialist
// blocks, the wide flat glazing of the last thirty years — and a plinth that darkens the wall above its own foot, which
// on the terrain means the band follows the ground under each building rather than a global sea level (vRel is measured
// from the building's base, FRAG).
//
// Numbers here are metres and fractions of the window cell; the colours are display sRGB, as the rest of the skin's are.
// The GLSL is generated from this table, so a change of proportion is a change of one number, and the unit tests hold the
// table to the picture gate's rules: glass darker than plaster (windows read as openings), plinth never near-black, and
// no era's band so wide that a wall loses its plaster.

// from: the year the era's bays start to appear. The weights blend over about fifteen years either side (eraFacade at
// the foot of this file), so a street built along a century has no seam at a boundary.
export const FACADE_ERAS = [
  { key: 'historic', from: 1780, bay: 3.0, floor: 3.5, right: 0.76, top: 0.80, glass: [0.40, 0.43, 0.47], plinth: 0.80, cornice: 0.06, shop: 1 },
  { key: 'secession', from: 1895, bay: 3.3, floor: 3.4, right: 0.72, top: 0.82, glass: [0.43, 0.46, 0.50], plinth: 0.82, cornice: 0.05, shop: 1 },
  { key: 'modern', from: 1948, bay: 3.6, floor: 3.0, right: 0.86, top: 0.74, glass: [0.47, 0.51, 0.56], plinth: 0.88, cornice: 0.03, shop: 1 },
  { key: 'contemporary', from: 1992, bay: 3.4, floor: 3.3, right: 0.90, top: 0.70, glass: [0.54, 0.59, 0.65], plinth: 0.94, cornice: 0, shop: 0 },
];
// A window's bottom edge, as a fraction of the floor's height: a sill, the same in every era.
export const SILL = 0.38;
// The years the weights blend across: a building dated at `from` is halfway into its era.
export const ERA_BLEND = 15;
// How strongly a window takes the glass colour, and the shopfront band's own darkening.
export const GLASS_MIX = 0.85;
export const SHOP_DARK = 0.5;
// The plinth's height above the building's own foot, in metres.
export const PLINTH_M = 1.4;

// The era as a real number, 0 historic to 3 contemporary, for the shader: a building of 1900 sits between the first two.
export function eraOf(year) {
  let e = 0;
  for (let i = 1; i < FACADE_ERAS.length; i++) {
    const t = (year - FACADE_ERAS[i].from) / ERA_BLEND + 0.5;
    e += Math.max(0, Math.min(1, t));
  }
  return e;
}

const f = n => n.toFixed(6);
const v3 = a => `vec3(${a.map(f).join(', ')})`;
const v4 = a => `vec4(${a.map(f).join(', ')})`;

// The era as a real number, 0 to 3, for the vertex shader: the shader's twin of eraOf(), from the same table. Each era
// fades in over ERA_BLEND years centred on its `from`, so a building dated 1900 sits between the first two.
export const ERA_GLSL = /* glsl */`
  float eraIn(float year) {
    return clamp((year - ${f(FACADE_ERAS[1].from)}) / ${f(ERA_BLEND)} + 0.5, 0.0, 1.0)
      + clamp((year - ${f(FACADE_ERAS[2].from)}) / ${f(ERA_BLEND)} + 0.5, 0.0, 1.0)
      + clamp((year - ${f(FACADE_ERAS[3].from)}) / ${f(ERA_BLEND)} + 0.5, 0.0, 1.0);
  }
`;

// eraFacade: the wall's colour at (ux metres along the wall, rel metres above its own foot). `d` is the distance to the
// camera and `aa` the cell's size in pixels: past a few hundred metres, or where a cell falls under a tenth of a pixel,
// the skin dissolves into the wall's own colour, so the far city neither shimmers nor costs anything.
export const FACADE_GLSL = /* glsl */`
  // The era's proportions, the four archetypes blended by the building's own year.
  vec4 eraBands(float era) {
    vec4 p0 = ${v4([FACADE_ERAS[0].bay, FACADE_ERAS[0].floor, FACADE_ERAS[0].right, FACADE_ERAS[0].top])};
    vec4 p1 = ${v4([FACADE_ERAS[1].bay, FACADE_ERAS[1].floor, FACADE_ERAS[1].right, FACADE_ERAS[1].top])};
    vec4 p2 = ${v4([FACADE_ERAS[2].bay, FACADE_ERAS[2].floor, FACADE_ERAS[2].right, FACADE_ERAS[2].top])};
    vec4 p3 = ${v4([FACADE_ERAS[3].bay, FACADE_ERAS[3].floor, FACADE_ERAS[3].right, FACADE_ERAS[3].top])};
    return era < 1.0 ? mix(p0, p1, clamp(era, 0.0, 1.0))
      : era < 2.0 ? mix(p1, p2, clamp(era - 1.0, 0.0, 1.0)) : mix(p2, p3, clamp(era - 2.0, 0.0, 1.0));
  }
  vec3 eraGlass(float era) {
    vec3 g0 = ${v3(FACADE_ERAS[0].glass)};
    vec3 g1 = ${v3(FACADE_ERAS[1].glass)};
    vec3 g2 = ${v3(FACADE_ERAS[2].glass)};
    vec3 g3 = ${v3(FACADE_ERAS[3].glass)};
    return era < 1.0 ? mix(g0, g1, clamp(era, 0.0, 1.0))
      : era < 2.0 ? mix(g1, g2, clamp(era - 1.0, 0.0, 1.0)) : mix(g2, g3, clamp(era - 2.0, 0.0, 1.0));
  }
  float eraLerp(float era, float a, float b, float c, float d) {
    return era < 1.0 ? mix(a, b, clamp(era, 0.0, 1.0))
      : era < 2.0 ? mix(b, c, clamp(era - 1.0, 0.0, 1.0)) : mix(c, d, clamp(era - 2.0, 0.0, 1.0));
  }
  // One wall's skin. base: plaster; ux: metres along the wall; rel: metres above the building's own foot; gid seeds the
  // building's own rhythm; night lights the windows; era weights the proportions (0 to 3); cellPx is a pixel's size in
  // metres each way, taken by the caller outside any branch (a derivative inside one is undefined).
  vec3 eraFacade(vec3 base, float ux, float rel, float gid, float d, float night, float era, vec2 cellPx) {
    // The building's own sway in bay width: 19c rows sit close, later walls breathe wider, and never the same on two
    // neighbours. One hash from the gid, so the rhythm is stable on every load.
    float sway = 0.85 + 0.33 * fract(sin(gid * 78.233) * 43758.5453);
    vec4 P = eraBands(era);
    vec2 step2 = vec2(P.x, P.y) * sway;
    vec2 g = vec2(ux, rel) / step2;
    vec2 aa = cellPx / step2 + 1e-5;   // cells per pixel, each way
    vec2 cell = fract(g);
    float wx = smoothstep(0.20 - aa.x, 0.20 + aa.x, cell.x) * (1.0 - smoothstep(P.z - aa.x, P.z + aa.x, cell.x));
    float wy = smoothstep(${f(SILL)} - aa.y, ${f(SILL)} + aa.y, cell.y) * (1.0 - smoothstep(P.w - aa.y, P.w + aa.y, cell.y));
    float win = wx * wy;
    // The plinth: a darker band over the first PLINTH_M metres of the wall's own foot, so it steps with the terrain.
    float plinth = 1.0 - smoothstep(0.0, ${f(PLINTH_M)}, rel);
    // The cornice: a thin shadow line on each floor's own seam, only where the bays are still resolved.
    float cornice = eraLerp(era, ${FACADE_ERAS.map(e => f(e.cornice)).join(', ')});
    float seam = (1.0 - smoothstep(0.0, 0.04 + aa.y, cell.y)) * cornice;
    vec3 glass = mix(base * 0.30, eraGlass(era), 0.45);
    glass = mix(glass, vec3(0.86, 0.78, 0.55), night * 0.55);   // windows lit after dark
    base = mix(base, glass, win * ${f(GLASS_MIX)});
    // The shopfront band at the foot: wider openings, below 4 m, and gone from the last era's glazed ground floors.
    float shopW = eraLerp(era, ${FACADE_ERAS.map(e => f(e.shop)).join(', ')});
    float shop = shopW * (1.0 - smoothstep(0.06 - aa.y, 0.06 + aa.y, cell.y)) * (1.0 - smoothstep(0.62, 0.70, abs(cell.y - 0.45)));
    base = mix(base, base * 0.42, shop * ${f(SHOP_DARK)});
    base *= mix(1.0, eraLerp(era, ${FACADE_ERAS.map(e => f(e.plinth)).join(', ')}), plinth);
    base *= 1.0 - seam * 0.5;
    // A building's own grain: a few percent, fixed to the wall.
    float gr = fract(sin(dot(floor(vec2(ux, rel) * 2.0), vec2(12.9898, 78.233))) * 43758.5453);
    return base * (1.0 + (gr - 0.5) * 0.07);
  }
`;

// Where the skin is drawn at all: the plaster grain and the window grid both dissolve where a cell falls under a tenth of
// a pixel (aliasing) and past 850 m (the far city keeps the period colour and costs nothing extra).
export const SKIN_GLSL = /* glsl */`
  float facadeSkin(float aaMax, float d) {
    return (1.0 - smoothstep(0.11, 0.30, aaMax)) * (1.0 - smoothstep(300.0, 850.0, d));
  }
`;
