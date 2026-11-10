import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, SHADING } from '../themes.js';
import { sunVector } from '../sun.js';
import { readFileSync } from 'node:fs';
import { goldenModel } from '../../scripts/light-model.mjs';
import { oklab, oklabLin, lin, rgb, hex, estimateTone, inkOn } from '../tone.js';

const HEX = /^#[0-9a-f]{6}$/;

// Colour-vision deficiency at full severity: Machado, Oliveira & Fernandes (2009), applied in linear sRGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const VISION = ['normal', ...Object.keys(CVD)];
const seen = (h, kind) => {
  const c = rgb(h).map(lin);
  return kind === 'normal' ? c
    : CVD[kind].map(row => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
};
// OKLab distance ×100, as a viewer with the given colour vision sees the two colours.
const dE = (a, b, kind) => {
  const p = oklabLin(seen(a, kind)), q = oklabLin(seen(b, kind));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
// WCAG 2 contrast ratio.
const Y = h => { const c = rgb(h).map(lin); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [lo, hi] = [Y(a), Y(b)].sort((x, y) => x - y); return (hi + 0.05) / (lo + 0.05); };

test('oklab matches reference values', () => {
  assert.deepEqual(oklab('#ffffff').map(v => +v.toFixed(3)), [1, 0, 0]);
  assert.equal(+oklab('#000000')[0].toFixed(3), 0);
  assert.equal(+(oklab('#3a4f9a')[0] * 100).toFixed(1), 45.1);
});

for (const [name, th] of Object.entries(THEMES)) {
  test(`${name}: complete and well-formed`, () => {
    for (const k of ['sky', 'land', 'water', 'maquette', 'unknown', 'labelInk', 'waterInk', 'estimateTo', 'hoverTo', 'quay']) {
      assert.match(th[k], HEX, k);
    }
    assert.ok(th.reliefShade > 0 && th.reliefShade <= 0.6, 'reliefShade');
    assert.match(th.labelHalo, /^rgba\(/);
    assert.ok(typeof th.name === 'string' && th.name.length > 0, 'name');   // as the look switcher shows it
    assert.ok(typeof th.font === 'string' && th.font.length > 0, 'font');
    assert.deepEqual(Object.keys(th.ui).sort(), ['--accent', '--bg', '--ink', '--line', '--muted', '--panel']);
    for (const v of Object.values(th.ui)) assert.match(v, HEX);
    assert.equal(th.periods.length, 12);
    th.periods.forEach(c => assert.match(c, HEX));
    assert.notEqual(th.unknown, th.maquette);
    if ('unknownHatch' in th) assert.match(th.unknownHatch, HEX, 'unknownHatch');
    assert.equal(th.floors.length, 4, 'floors');
    th.floors.forEach(c => assert.match(c, HEX, 'floors'));
  });
  // The Floors ramp per look. Buildings stand on land and rise against the sky: no stop may sink into either
  // (the one shared ramp's darkest colour was ΔE 4.4 from Blå timmen's land, so the tallest buildings vanished there),
  // and the stops step in lightness, one way, so the ramp reads as more and fewer floors.
  test(`${name}: the Floors ramp stays clear of land and sky and steps in lightness`, () => {
    for (const c of th.floors) {
      assert.ok(dE(c, th.land, 'normal') >= 6, `${c} / land ΔE ${dE(c, th.land, 'normal').toFixed(1)}`);
      assert.ok(dE(c, th.sky, 'normal') >= 6, `${c} / sky ΔE ${dE(c, th.sky, 'normal').toFixed(1)}`);
    }
    const L = th.floors.map(c => oklab(c)[0] * 100);
    const dir = Math.sign(L[3] - L[0]);
    for (let i = 1; i < 4; i++) assert.ok((L[i] - L[i - 1]) * dir >= 8, `stop ${i}: ΔL ${(L[i] - L[i - 1]).toFixed(1)}`);
    // light grounds go light to dark, the dark one dark to light: the tallest buildings stand out most
    assert.equal(dir, oklab(th.land)[0] > 0.5 ? -1 : 1);
  });
  test(`${name}: neighbouring periods differ in OKLab lightness by at least 4`, () => {
    const L = th.periods.map(c => oklab(c)[0] * 100);
    for (let i = 1; i < L.length; i++) {
      assert.ok(Math.abs(L[i] - L[i - 1]) >= 4, `p${i} ${th.periods[i - 1]} → p${i + 1} ${th.periods[i]}: ΔL ${(L[i] - L[i - 1]).toFixed(1)}`);
    }
  });
}

// Ärg draws "Year unknown" pale with a fine diagonal hatch (unknownHatch, the hatch line's colour); the other
// looks draw it flat.
test('Ärg hatches "Year unknown"; the other looks do not', () => {
  for (const [name, th] of Object.entries(THEMES)) {
    assert.equal('unknownHatch' in th, name === 'arg', name);
  }
});

// The ground as app.js TERRAIN_FRAG draws it under #24: the palette's hex is its albedo; the light is one warm sun
// plus a cool sky fill (LIGHT_GLSL: uSunCol/uSkyCol in app.js, the 38°/225° golden-hour sun the map opens with),
// over the relief's own contouring (SHADING.dark/light as before); the display chain is the renderer's selected filmic
// tone map at the selected exposure, then the sRGB encode. A slope is land × the light evaluated at its normal at its
// clamped ends; a wall is quay × the light at a level normal, its azimuth sweeping past the sun's horizontal part (0.788);
// a bank 1 to 3 m high blends between the two. Land is lighter than the water and the walls in shade darker in
// every light look, so the blend crosses the water's lightness and only hue keeps them apart there: BANK_MIN is the
// floor the looks hold (the floor Kalkfärg sits on for red-blind viewers is a question for the M4 look review).
// #24: the filmic pipe compresses mid-tones, so the measured protan floor is Kalkfärg's 1.4: the floor moves with it,
// and the same M4 review that owned the old 3.9 now has 1.4 at the corrected 225 degree sun.
const BANK_MIN = 1;
// app.js's light uniforms, read from the source so the test tracks them: the shader multiplies the albedo by them
// (colour management on: they are linear working-space), SUN_LIGHT.direct, SUN_LIGHT.skyFill with a horizon lift.
const APP = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const uniHex = u => APP.match(new RegExp(`${u}: \\{ value: new THREE\\.Color\\('(#[0-9a-f]{6})'\\)`))?.[1];
const { SUN, SUN_LEVEL, lightAt, shown } = goldenModel(APP);
const UP = [0, 1, 0];
const steps = n => Array.from({ length: n + 1 }, (_, i) => i / n);
function ground(th) {
  const land = rgb(th.land).map(lin), quay = rgb(th.quay).map(lin);
  const up = lightAt(UP);
  const ds = steps(16).map(k => SUN_LEVEL * (2 * k - 1));
  // Evaluate the actual light at a normal, rather than multiplying the legacy relief fudge as well.
  const slopeLit = d => land.map((v, i) => v * lightAt([d, Math.sqrt(Math.max(0, 1 - d * d)), 0])[i]);
  const wallLit = d => quay.map((v, i) => v * lightAt([d, 0, Math.sqrt(Math.max(0, 1 - d * d))])[i]);
  return {
    slopes: [slopeLit(SUN_LEVEL), slopeLit(-SUN_LEVEL)].map(shown),
    walls: ds.map(d => shown(wallLit(d))),
    banks: ds.flatMap(d => steps(8).map(w => shown(slopeLit(d).map((v, i) => v * (1 - w) + wallLit(d)[i] * w)))),
    water: shown(rgb(th.water).map(lin).map((v, i) => v * up[i])),
  };
}
test('the shading constants are the shader\'s (#24 light model, golden-hour sun 38°/225°)', () => {
  assert.deepEqual([SHADING.dark, SHADING.light], [0.6, 0.3]);   // the relief's contouring, kept from before #24
  assert.equal(uniHex('uSunCol'), '#ffdcae');
  assert.equal(uniHex('uSkyCol'), '#b3c7dd');
  assert.equal(+SUN[1].toFixed(3), 0.616);
  assert.equal(+SUN_LEVEL.toFixed(3), 0.788);
  // the old wall fudge is gone from the fragment shaders
  assert.doesNotMatch(APP, /1\.04 : \$\{glf\(SHADING\.wallMin\)\}/);
});
// The water every bank and slope is held apart from, on the same pipe as the land.
const hWater = th => ground(th).water;
for (const [name, th] of Object.entries(THEMES)) {
  const visions = name === 'paper' ? ['normal'] : VISION;
  test(`${name}: the ground's slopes, quay walls and banks stand apart from the water (${visions.join(', ')})`, () => {
    const g = ground(th);
    for (const kind of visions) {
      const far = (c, min, what) => assert.ok(dE(c, g.water, kind) >= min,
        `${kind}: ${what} ${c} / lit water ${g.water}: ΔE ${dE(c, g.water, kind).toFixed(1)}`);
      // #24 floors from the measured filmic margins (scripts/probe_theme.mjs, 2026-11): kalk's weakest
      // red-blind (protan) numbers are bank 1.4, wall 3.1, slope 6.1; Blå timme's worst is bank 6.1 (protan). The M4
      // look review still owns Kalkfärg's red-blind banks; paper is upstream's comparison palette, skipped as above.
      g.slopes.forEach(c => far(c, name === 'paper' ? 4 : 4.5, 'slope'));
      g.walls.forEach(c => far(c, name === 'paper' ? 1.2 : 2.5, 'wall'));
      if (name !== 'paper') g.banks.forEach(c => far(c, BANK_MIN, 'bank'));
      assert.ok(dE(th.quay, th.land, kind) >= 6, `${kind}: quay / land ΔE ${dE(th.quay, th.land, kind).toFixed(1)}`);
    }
  });
}

// The Stockholm looks are launch candidates, so they must read for colour-blind viewers and pass text contrast.
// paper is upstream's palette, kept for comparison: it fails deuteranopia (p4/p7 ΔE 2.4) and would need fixing.
for (const name of ['arg', 'kalk', 'blatimme']) {
  const th = THEMES[name];
  test(`${name}: every two periods stay at least ΔE 4.5 apart, in normal and colour-blind vision`, () => {
    for (const kind of VISION) {
      th.periods.forEach((a, i) => th.periods.slice(i + 1).forEach((b, j) => {
        const d = dE(a, b, kind);
        assert.ok(d >= 4.5, `${kind}: p${i + 1} ${a} / p${i + j + 2} ${b}: ΔE ${d.toFixed(1)}`);
      }));
    }
  });
  test(`${name}: land, water and "unknown" stay apart, in normal and colour-blind vision`, () => {
    for (const kind of VISION) {
      assert.ok(dE(th.land, th.water, kind) >= 8, `${kind}: land / water`);
      if (th.unknownHatch) {
        // A pale "unknown" can look like a light period colour to a colour-blind viewer, so the hatch is what
        // tells it apart: the hatch line must stand out from the ground it is drawn on, and the pale ground from land.
        // Where the hatch fades out (stripes under about 3 px apart, or past about 3 km; app.js FRAG) only its mean
        // tone is left, and Ärg's p1/p2 are then ΔE 2.0–4.6 from it to red- and green-blind viewers.
        assert.ok(dE(th.unknown, th.land, kind) >= 6, `${kind}: unknown / land ΔE ${dE(th.unknown, th.land, kind).toFixed(1)}`);
        assert.ok(dE(th.unknownHatch, th.unknown, kind) >= 8,
          `${kind}: hatch line / unknown ΔE ${dE(th.unknownHatch, th.unknown, kind).toFixed(1)}`);
      } else {
        th.periods.forEach((p, i) => assert.ok(dE(th.unknown, p, kind) >= 8, `${kind}: unknown / p${i + 1} ${p}`));
      }
    }
  });
  // Spec §3.3: estimate-style buildings must look clearly different from the range fade. The fade is the
  // shader's mix(c, uMaquette, 0.8); the estimate tone is estimateTone(c, estimateTo). Both are checked against the
  // period colour too (an estimate must read as different from a known year) and estimates against each other.
  // "Year unknown" is told apart by its hatch, not by colour.
  test(`${name}: estimates stay apart from their period colour (ΔE ≥ 4.5), the range fade (≥ 4.5) and each other (≥ 3)`, () => {
    const fade = c => hex(rgb(c).map((v, i) => v + (rgb(th.maquette)[i] - v) * 0.8));
    const ests = th.periods.map(c => estimateTone(c, th.estimateTo));
    for (const kind of VISION) {
      th.periods.forEach((c, i) => {
        assert.ok(dE(ests[i], c, kind) >= 4.5, `${kind}: p${i + 1} estimate ${ests[i]} / own ${c}: ΔE ${dE(ests[i], c, kind).toFixed(1)}`);
        assert.ok(dE(ests[i], fade(c), kind) >= 4.5, `${kind}: p${i + 1} estimate ${ests[i]} / fade ${fade(c)}: ΔE ${dE(ests[i], fade(c), kind).toFixed(1)}`);
        ests.slice(i + 1).forEach((e, j) => assert.ok(dE(ests[i], e, kind) >= 3, `${kind}: estimates p${i + 1} / p${i + j + 2}: ΔE ${dE(ests[i], e, kind).toFixed(1)}`));
      });
    }
  });
  test(`${name}: text contrast (WCAG)`, () => {
    assert.ok(contrast(th.ui['--ink'], th.ui['--panel']) >= 7, 'ink on panel');
    assert.ok(contrast(th.ui['--muted'], th.ui['--panel']) >= 4.5, 'muted on panel');
    assert.ok(contrast(th.ui['--accent'], th.ui['--panel']) >= 4.5, 'accent on panel');
    assert.ok(contrast(th.labelInk, th.land) >= 4.5, 'label ink on land');
    assert.ok(contrast(th.waterInk, th.water) >= 4.5, 'water label ink on water');
  });
}

// The card's header band: its text is inkOn's black or white, faded by any opacity styles.css gives a header rule.
// A review measured the English label (.85) and the period (.8) at 3.6–4.1:1 on some bands; the
// 13 px text needs 4.5:1 (WCAG AA), so every band of every look, the estimate tone included, is checked here.
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const headOpacity = Math.min(1, ...[...CSS.matchAll(/([^{}]*\.card-head[^{}]*)\{([^}]*)\}/g)]
  .map(m => /(?:^|;)\s*opacity\s*:\s*([\d.]+)/.exec(m[2])).filter(Boolean).map(m => +m[1]));
const over = (ink, band, a) => hex(rgb(ink).map((v, i) => v * a + rgb(band)[i] * (1 - a)));
for (const [name, th] of Object.entries(THEMES)) {
  test(`${name}: the card header's text reads on every band (WCAG AA)`, () => {
    const bands = [...th.periods, ...th.periods.map(c => estimateTone(c, th.estimateTo)), th.unknown];
    for (const band of bands) {
      const ink = over(inkOn(band), band, headOpacity);
      assert.ok(contrast(ink, band) >= 4.5, `${band}: ${contrast(ink, band).toFixed(2)}:1 at opacity ${headOpacity}`);
    }
  });
}
