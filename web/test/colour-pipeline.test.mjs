// #24: the colour pipeline built in this round, kept standing by shape, not by pixel-matching.
//
//   1. colour management is on, exactly once, and nobody calls convertSRGBToLinear anywhere under web/ (the
//      renderer's colour management does the conversion; a manual call would convert twice),
//   2. every scene fragment shader ends its colour with the renderer's own display transform: the
//      tonemapping_fragment + colorspace_fragment tail. The display-side passes — the poster ink pass (web/
//      poster.js) — are the allowed exception, commented as such in their own files,
//   3. each sRGB-authored texture carries colourSpace: SRGBColorSpace (the fence sits next to its creator),
//   4. the labels are interface, not film: toneMapped is off on labelMaterial,
//   5. the sun knows its four modes and golden is the default boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const app = read('app.js');

test('colour management is enabled once and nothing converts by hand', () => {
  assert.equal(app.match(/ColorManagement\.enabled = (true|false)/)[1], 'true');
  for (const f of readdirSync(new URL('..', import.meta.url)).filter(f => f.endsWith('.js'))) {
    if (f.startsWith('vendor')) continue;
    assert.doesNotMatch(read(f), /convertSRGBToLinear\(/, `${f} converts by hand: colour management already does it`);
  }
});

// Every ShaderMaterial's fragmentShader must end its colour path with both chunks, once per colour-writing stretch
// of it. The count is the file's own shape, fixed here: app.js has the buildings' faint branch, buildings' main
// branch and the ground's main branch; ferries smoke the hull and the wake; the poster pass is exempt: it re-inks
// display bytes by design (its comment says so) and is not in this table.
const TAILS = { 'app.js': 3, 'veg.js': 1, 'roads-layer.js': 1, 'roofyears.js': 1, 'weather.js': 1, 'highlight.js': 1,
  'monuments.js': 1, 'ferries-layer.js': 2 };
for (const [f, n] of Object.entries(TAILS)) {
  test(`${f}: carries the display tail at its ${n} colour stretch(es)`, () => {
    const src = read(f);
    assert.equal((src.match(/#include <tonemapping_fragment>/g) || []).length, n, `${f}: tone tail count`);
    assert.equal((src.match(/#include <colorspace_fragment>/g) || []).length, n, `${f}: colourspace tail count`);
  });
}

test('sRGB-authored textures are tagged SRGBColorSpace', () => {
  // the roof/ground photographs and the label canvas in app.js
  // one tagging site covers both photographs (mk() in loadPhotoColours), one the label canvas
  assert.equal((app.match(/colorSpace = THREE\.SRGBColorSpace/g) || []).length, 2,
    'app.js: the photo-texture maker and the label canvas are expected tagged');
  for (const [f, n] of [['veg.js', 2], ['roads-layer.js', 1]]) {
    assert.equal((read(f).match(/colorSpace = THREE\.SRGBColorSpace/g) || []).length, n,
      `${f}: its sRGB texture tags`);
  }
});

test('labels keep their own ink: toneMapped off, texture tagged', () => {
  assert.match(app, /m\.toneMapped = false;/);
});

test('golden is the default sun mode and the four modes stand', () => {
  assert.match(app, /\['golden', 'live', 'day', 'night'\]\.includes\(QUERY\.get\('sunmode'\)\) \? QUERY\.get\('sunmode'\) : 'golden'/);
  assert.match(app, /const SUN_EXPOSURE = \{ golden: 1\.15, day: 1\.15, night: 1\.3 \}/);
  // live low sun: under 6 degrees the Night look takes over
  assert.match(app, /mode === 'live' && sunState\.elevation < 6\) night = true/);
  // tone mapping is the renderer's: AgX, display sRGB
  assert.match(app, /renderer\.toneMapping = THREE\.AgXToneMapping;/);
  assert.match(app, /renderer\.outputColorSpace = THREE\.SRGBColorSpace;/);
});
