// web/facade.js: the era facades (#33). What the table must be for the picture gate and for the wall to read as a
// facade, asserted: glass darker than plaster, no era's plinth near-black, the era blends continuous, and the GLSL that
// app.js compiles carries this table's own numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FACADE_ERAS, SILL, ERA_BLEND, GLASS_MIX, SHOP_DARK, PLINTH_M, PLINTH_M as PLINTH,
  FACADE_GLSL, ERA_GLSL, SKIN_GLSL, eraOf } from '../facade.js';

const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const f = n => n.toFixed(6);

test('four eras, ordered by their years, each with sane metres', () => {
  assert.equal(FACADE_ERAS.length, 4);
  for (let i = 1; i < FACADE_ERAS.length; i++) {
    assert.ok(FACADE_ERAS[i].from > FACADE_ERAS[i - 1].from, `${FACADE_ERAS[i].key} starts after ${FACADE_ERAS[i - 1].key}`);
  }
  for (const e of FACADE_ERAS) {
    assert.ok(e.bay >= 2.4 && e.bay <= 4.5, `${e.key}: a bay is 2.4 to 4.5 m, got ${e.bay}`);
    assert.ok(e.floor >= 2.8 && e.floor <= 4.2, `${e.key}: a floor is 2.8 to 4.2 m, got ${e.floor}`);
    assert.ok(e.top > SILL + 0.2, `${e.key}: the window's top is above its sill`);
    assert.ok(e.right > 0.3 && e.right < 0.98, `${e.key}: the window's right edge stays inside the bay`);
  }
});

test('a window is a dark opening: glass well below the plaster in every era', () => {
  for (const e of FACADE_ERAS) {
    // the shader's own mix: plaster * 0.30 half-way towards the era's glass
    const glass = [0, 1, 2].map(i => 0.5 * 0.30 + 0.5 * e.glass[i]);
    assert.ok(lum(glass) < 0.45, `${e.key}: glass luminance ${lum(glass).toFixed(2)} must stay dark`);
    assert.ok(lum(glass) > 0.10, `${e.key}: and never black`);
  }
});

test('the plinth darkens the foot without swallowing it, and the last era keeps a bright one', () => {
  for (const e of FACADE_ERAS) assert.ok(e.plinth >= 0.78 && e.plinth <= 1, `${e.key}: plinth ${e.plinth}`);
  assert.ok(FACADE_ERAS[0].plinth < FACADE_ERAS[3].plinth, 'the historic plinth is the deepest');
  assert.ok(PLINTH > 0.8 && PLINTH < 3, 'a plinth is a metre or two, not a storey');
});

test('no era glazes its whole wall: the plaster always shows', () => {
  for (const e of FACADE_ERAS) {
    const glassShare = (e.right - 0.20) * (e.top - SILL);
    assert.ok(glassShare > 0.08 && glassShare < 0.62, `${e.key}: windows take ${(glassShare * 100).toFixed(0)}% of the wall`);
  }
  assert.ok(GLASS_MIX > 0.5 && GLASS_MIX < 1, 'a window is glass, not a tint');
  assert.ok(SHOP_DARK > 0.2 && SHOP_DARK < 0.9, 'the shopfront band is darker than the wall, not black');
});

test('the era is continuous and monotone in the year', () => {
  let last = -1;
  for (let y = 1700; y <= 2030; y += 5) {
    const e = eraOf(y);
    assert.ok(e >= last - 1e-9, `era at ${y} (${e.toFixed(3)}) may not fall as the year rises`);
    assert.ok(e >= 0 && e <= 3, `era at ${y} out of range: ${e}`);
    last = e;
  }
  assert.equal(eraOf(1750), 0);
  assert.ok(Math.abs(eraOf(2030) - 3) < 1e-9);
  // halfway into an era at its own `from`, so a street built across a boundary has no seam
  for (let i = 1; i < FACADE_ERAS.length; i++) {
    assert.ok(Math.abs(eraOf(FACADE_ERAS[i].from) - (i - 0.5)) < 1e-9, `${FACADE_ERAS[i].key} at its own from year`);
    assert.ok(Math.abs(eraOf(FACADE_ERAS[i].from - ERA_BLEND) - (i - 1)) < 1e-9, 'a full blend before it: the era below');
  }
});

test('eraIn (the vertex shader) agrees with eraOf (the tests) at every boundary', () => {
  // the shader's twin, evaluated here from the same table: three clamped ramps summed
  const shader = year => FACADE_ERAS.slice(1).reduce((sum, e) =>
    sum + Math.max(0, Math.min(1, (year - e.from) / ERA_BLEND + 0.5)), 0);
  for (const y of [1600, 1780, 1795, 1850, 1895, 1900, 1948, 1949, 1955, 1992, 2000, 2026, 2100]) {
    assert.ok(Math.abs(shader(y) - eraOf(y)) < 1e-9, `year ${y}: shader ${shader(y)} vs js ${eraOf(y)}`);
  }
  assert.ok(ERA_GLSL.includes(f(FACADE_ERAS[1].from)) && ERA_GLSL.includes(f(ERA_BLEND)), 'the GLSL carries the years');
});

test('the compiled GLSL carries this table\'s numbers, so the table is the shader', () => {
  for (const e of FACADE_ERAS) {
    for (const v of [e.bay, e.floor, e.right, e.top]) {
      assert.ok(FACADE_GLSL.includes(f(v)), `${e.key}: ${v} is missing from FACADE_GLSL`);
    }
    for (const v of e.glass) assert.ok(FACADE_GLSL.includes(f(v)), `${e.key}: glass channel ${v} is missing`);
    assert.ok(FACADE_GLSL.includes(f(e.plinth)), `${e.key}: plinth ${e.plinth} is missing`);
  }
  assert.ok(FACADE_GLSL.includes(f(SILL)) && FACADE_GLSL.includes(f(PLINTH_M)), 'the sill and the plinth height too');
  assert.ok(FACADE_GLSL.includes('eraFacade(') && ERA_GLSL.includes('eraIn('));
  // the shader must not measure a derivative itself: fwidth inside a branch is undefined, so the caller measures it
  assert.ok(!/fwidth/.test(FACADE_GLSL), 'FACADE_GLSL takes the pixel size as an argument, it never calls fwidth');
  assert.ok(FACADE_GLSL.includes('cellPx'), 'and reads it from that argument');
});

test('the skin dissolves before it can alias, and costs nothing far away', () => {
  assert.ok(SKIN_GLSL.includes('0.11') && SKIN_GLSL.includes('0.30'), 'gone where a cell falls under a tenth of a pixel');
  assert.ok(SKIN_GLSL.includes('300.0') && SKIN_GLSL.includes('850.0'), 'gone past 850 m');
  const skin = (aa, d) => {
    const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    return (1 - ss(0.11, 0.30, aa)) * (1 - ss(300, 850, d));
  };
  assert.equal(skin(0.02, 50), 1, 'up close the skin is fully drawn');
  assert.equal(skin(0.5, 50), 0, 'where the grid is under a tenth of a pixel, nothing is drawn');
  assert.equal(skin(0.02, 900), 0, 'the far city keeps the period colour alone');
});
