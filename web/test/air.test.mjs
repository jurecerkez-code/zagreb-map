// web/air.js: the sky dome (#33). The picture gate's own rules, as assertions: the sky can only lighten the frame, it
// joins the fog's colour at the horizon, its halo sits at the sun and dies at night, and the shader is generated from
// the same numbers the JS mirror uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKY_FRAG, SKY_VERT, SKY_TINT, SKY_CURVE, SKY_GLOW, SKY_WARM, SKY_FLAT, skyColourAt, hexRgb, rgbHex } from '../air.js';

const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const SKY = '#d9dfe3';       // the foto look's own sky
const SUN = [0, 1, 0];

test('the zenith tint only ever lightens: every channel is above 1 and the luminance rises', () => {
  for (const v of SKY_TINT) assert.ok(v > 1, `channel ${v} must brighten`);
  assert.ok(lum(SKY_TINT) > 1.02, 'the tint adds more than 2% luminance at the zenith');
  assert.ok(lum(SKY_TINT) < 1.20, 'and less than 20%: a pale wash, not a white dome');
});

test('the horizon is the fog colour exactly, in every channel', () => {
  const base = hexRgb(SKY);
  const at = skyColourAt({ sky: SKY, dir: [0, 0, 1], sun: SUN });
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(at[i] - base[i]) < 1e-9, `channel ${i}: ${at[i]} vs ${base[i]}`);
});

test('the gradient climbs with the height and never falls below the flat sky it replaces', () => {
  const base = lum(hexRgb(SKY));
  let last = -1;
  for (const up of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    const l = lum(skyColourAt({ sky: SKY, dir: [0, up, Math.sqrt(1 - up * up)], sun: SUN }));
    assert.ok(l > last, `luminance at up=${up} (${l.toFixed(2)}) must be above the one below (${last.toFixed(2)})`);
    assert.ok(l >= base - 1e-9, `luminance at up=${up} must not fall below the flat sky's ${base.toFixed(2)}`);
    last = l;
  }
  // the whole dome's mean, the number that reaches the picture gate
  let sum = 0;
  for (let i = 0; i <= 64; i++) {
    const up = i / 64;
    sum += lum(skyColourAt({ sky: SKY, dir: [0, up, Math.sqrt(Math.max(0, 1 - up * up))], sun: [0, 1, 0] }));
  }
  assert.ok(sum / 65 >= base, 'the sky as a whole is never darker than the clear colour');
});

test('the halo is the sun\'s: brightest towards it, gone at night', () => {
  const atSun = lum(skyColourAt({ sky: SKY, dir: [0, 1, 0], sun: [0, 1, 0] }));
  const away = lum(skyColourAt({ sky: SKY, dir: [0.6, 0.8, 0], sun: [0, 1, 0] }));
  assert.ok(atSun > away, 'the halo brightens the sun\'s own direction');
  const night = skyColourAt({ sky: SKY, dir: [0, 1, 0], sun: [0, 1, 0], night: true });
  const nightFlat = skyColourAt({ sky: SKY, dir: [0, 0, 1], sun: [0, 1, 0], night: true });
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(night[i] - nightFlat[i]) < 1e-9, 'at night the dome is the flat sky');
  assert.deepEqual(SKY_FLAT, [1, 1, 1], 'and its zenith tint is 1, so there is no gradient at all');
});

test('the halo is small: it may not flatten the gradient into a white dome', () => {
  const peak = skyColourAt({ sky: SKY, dir: [0, 1, 0], sun: [0, 1, 0] });
  const base = hexRgb(SKY);
  for (let i = 0; i < 3; i++) assert.ok(peak[i] - base[i] < 0.25, `channel ${i} rises ${(peak[i] - base[i]).toFixed(3)} at the sun`);
  assert.ok(SKY_GLOW.wide + SKY_GLOW.core < 0.2, 'the two lobes together stay under a fifth of the sky');
});

test('the shader is built from the constants, and the mirror is the shader\'s arithmetic', () => {
  assert.ok(SKY_FRAG.includes(SKY_CURVE.toFixed(6)), 'the gradient exponent reaches the GLSL');
  for (const v of SKY_WARM) assert.ok(SKY_FRAG.includes(v.toFixed(6)), `the halo's warm channel ${v} reaches the GLSL`);
  assert.ok(SKY_FRAG.includes(SKY_GLOW.wide.toFixed(6)) && SKY_FRAG.includes(SKY_GLOW.core.toFixed(6)));
  assert.ok(SKY_FRAG.includes('uFogColor') && SKY_FRAG.includes('uSun') && SKY_FRAG.includes('uNight'),
    'the dome reads the scene own fog, sun and night uniforms');
  assert.ok(SKY_FRAG.includes('gl_FragColor'), 'GLSL1: the material is not GLSL3, so it writes gl_FragColor');
  assert.ok(SKY_VERT.includes('.xyww'), 'every vertex sits on the far plane, so the dome cannot clip');
});

test('hex <-> rgb round-trips for the looks\' sky colours', () => {
  for (const hex of ['#d9dfe3', '#dbe5e9', '#e4e8ea', '#000000', '#ffffff']) {
    assert.equal(rgbHex(hexRgb(hex)), hex);
  }
});
