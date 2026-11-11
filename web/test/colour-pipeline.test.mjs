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
import { sunVector } from '../sun.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const app = read('app.js');

test('colour management is enabled once and nothing converts by hand', () => {
  assert.equal(app.match(/ColorManagement\.enabled = (true|false)/)[1], 'true');
  for (const f of readdirSync(new URL('..', import.meta.url)).filter(f => f.endsWith('.js'))) {
    if (f.startsWith('vendor')) continue;
    assert.doesNotMatch(read(f), /convertSRGBToLinear\(/, `${f} converts by hand: colour management already does it`);
  }
});

test('every real ShaderMaterial writes the required ordered display tail', () => {
  const blocks = [
    ['app.js', 'const FRAG =', 'fragmentShader: FRAG', 2, 'outColor'],
    ['app.js', 'const TERRAIN_FRAG =', 'fragmentShader: TERRAIN_FRAG', 1, 'outColor'],
    ['ferries-layer.js', 'const hullFrag', 'fragmentShader: hullFrag(fadeGlsl)', 1, 'outColor'],
    ['ferries-layer.js', 'const wakeFrag', 'fragmentShader: wakeFrag(fadeGlsl)', 1, 'outColor'],
    ['weather.js', 'const FLAKE_FRAG =', 'fragmentShader: FLAKE_FRAG', 1, 'outColor'],
    ['highlight.js', 'const FRAG =', 'fragmentShader: FRAG', 1, 'outColor'],
    ['veg.js', 'fragmentShader:', 'new THREE.ShaderMaterial', 1, 'gl_FragColor'],
    ['roads-layer.js', 'fragmentShader:', 'new THREE.ShaderMaterial', 1, 'gl_FragColor'],
    ['roofyears.js', 'fragmentShader:', 'new THREE.ShaderMaterial', 1, 'gl_FragColor'],
    ['monuments.js', 'fragmentShader:', 'new THREE.ShaderMaterial', 1, 'gl_FragColor'],
    // #33: the sky dome is the background, drawn in display sRGB already (it replaces the clear colour, which carries no
    // tone curve either), so it is a raw display-byte pass like the poster's: no tail, and its horizon is the fog colour
    // itself.
    ['air.js', 'const SKY_FRAG =', 'fragmentShader: SKY_FRAG', 0, 'gl_FragColor'],
  ];
  // Discover new shader-bearing files, not just new include calls. Raw display-byte passes are registered explicitly.
  const covered = new Set([...blocks.map(b => b[0]), 'poster.js']);
  for (const file of readdirSync(new URL('..', import.meta.url)).filter(f => f.endsWith('.js'))) {
    if (read(file).includes('new THREE.ShaderMaterial')) assert.ok(covered.has(file), `${file}: register each shader/raw pass here`);
  }
  const shaders = new Map();
  for (const [file, marker, usage, outputs, destination] of blocks) {
    const src = read(file);
    const where = src.indexOf(marker);
    assert.ok(where >= 0 && src.includes(usage), `${file}/${marker}: the real block is referenced by a material`);
    const start = src.indexOf('`', where);
    assert.ok(start > where, `${file}/${marker}: template start`);
    let end = start + 1;
    while (end < src.length && (src[end] !== '`' || src[end - 1] === '\\')) end++;
    assert.ok(end < src.length, `${file}/${marker}: template end`);
    const shader = src.slice(start + 1, end);
    shaders.set(file + marker, shader);
    const actual = [...shader.matchAll(/#include <(tonemapping_fragment|colorspace_fragment)>/g)].map(m => m[1]);
    assert.deepEqual(actual, Array.from({ length: outputs }, () => ['tonemapping_fragment', 'colorspace_fragment']).flat(),
      `${file}/${marker}: ordered tone + sRGB pairs with no raw-pass pollution`);
    for (const include of shader.matchAll(/#include <tonemapping_fragment>/g)) {
      const before = shader.slice(0, include.index);
      assert.ok(before.lastIndexOf(`${destination} =`) >= 0, `${file}/${marker}: colour written before its display tail`);
    }
  }
  const building = shaders.get('app.jsconst FRAG =');
  const pick = building.slice(building.indexOf('#ifdef PICK'), building.indexOf('#elif defined(FAINT)'));
  assert.match(pick, /outColor = vec4\(mod\(id, 256\.0\)/);
  assert.doesNotMatch(pick, /tonemapping_fragment|colorspace_fragment|linearToDisplay/);
  const poster = read('poster.js');
  assert.match(poster, /display bytes/);
  assert.doesNotMatch(poster, /#include <(?:tonemapping_fragment|colorspace_fragment)>/);
});

test('every sRGB-authored CanvasTexture is tagged next to its creation', () => {
  for (const f of readdirSync(new URL('..', import.meta.url)).filter(f => f.endsWith('.js'))) {
    if (f.startsWith('vendor')) continue;
    const src = read(f);
    for (const hit of src.matchAll(/new\s+THREE\.CanvasTexture\s*\(/g)) {
      const line = src.slice(0, hit.index).split('\n').length;
      const creation = src.slice(hit.index, hit.index + 320);
      if (creation.includes('#24: data texture, not display colour')) continue;
      assert.match(creation, /\.colorSpace\s*=\s*THREE\.SRGBColorSpace\s*;/,
        `${f}:${line}: this authored CanvasTexture must be tagged SRGBColorSpace at creation`);
    }
  }
});

test('labels keep their own ink: toneMapped off, texture tagged', () => {
  assert.match(app, /m\.toneMapped = false;/);
});

test('colour probe cannot pass with sparse roof coverage', () => {
  const probe = readFileSync(new URL('../../scripts/colour_probe.mjs', import.meta.url), 'utf8');
  assert.match(probe, /tried\.length >= 2 && good\.length >= 2/,
    'roof comparison needs at least two valid reads and two passing roofs');
  assert.match(probe, /valid: tried\.length/,
    'the JSON report must say how many roofs were actually sampled');
  assert.match(probe, /if \(tried\.length < 2\) throw new Error/,
    'empty or one-sample roof measurements must fail explicitly');
  assert.match(probe, /const DE_MAX_ROAD = 10;/,
    'the street floor is the issue limit, not a relaxed twelve-point tolerance');
});

test('perf gate captures shader warnings and makes the run invalid', () => {
  const perf = readFileSync(new URL('../../scripts/perf.mjs', import.meta.url), 'utf8');
  assert.match(perf, /m\.type\(\) === 'warning'[^\n]*warnings\.push\(text\)/);
  assert.match(perf, /warnings: warnings\.length/);
  assert.match(perf, /if \(warnings\.length\)[\s\S]*?process\.exit\(2\)/,
    'relevant shader warnings invalidate the run with exit 2');
});

test('picture comparisons pin the drawing buffer, not the adaptive quality scale', () => {
  const shots = readFileSync(new URL('../../scripts/shots.mjs', import.meta.url), 'utf8');
  assert.match(shots, /renderer\.setPixelRatio\(1\)/);
  assert.match(shots, /domElement\.width !== innerWidth \|\| renderer\.domElement\.height !== innerHeight/);
});

test('stats exposes actual remaining tile assets for readiness probes', () => {
  const start = app.indexOf('function stats()');
  const end = app.indexOf("if (new URLSearchParams(location.search).has('debug'))", start);
  const stats = app.slice(start, end);
  assert.match(stats, /assets: Math\.max\(0, config\.tiles\.length - loaded\)/);
});

test('display output is sRGB after the whole renderer setup', () => {
  const assignments = [...app.matchAll(/renderer\.outputColorSpace = THREE\.(\w+);/g)].map(m => m[1]);
  assert.deepEqual(assignments, ['SRGBColorSpace']);
});

test('golden uses the real 225 degree south-west vector, not a mirrored x', () => {
  const actual = sunVector({ elevation: 38, azimuth: 225 });
  const expected = [-0.557208, 0.615661, 0.557208];
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `component ${i}: ${v}`));
  assert.match(app, /\.set\(\.\.\.sunVector\(\{ elevation: 38, azimuth: 225 \}\)\)/);
});

test('golden is the default sun mode and the four modes stand', () => {
  assert.match(app, /\['golden', 'live', 'day', 'night'\]\.includes\(QUERY\.get\('sunmode'\)\) \? QUERY\.get\('sunmode'\) : 'golden'/);
  assert.match(app, /const SUN_EXPOSURE = \{ golden: 1, day: 1, night: 1 \}/);
  // live low sun: under 6 degrees the computed Night look takes over
  assert.match(app, /const night = sunIsNight\(mode, sunState\.elevation\)/);

  // #24: the neutral curve (mid-tones passed, highlights rolled off) at unit exposure, display in sRGB.
  assert.match(app, /renderer\.toneMapping = THREE\.NeutralToneMapping;/);
  assert.match(app, /renderer\.toneMappingExposure = 1;/);
  assert.match(app, /renderer\.outputColorSpace = THREE\.SRGBColorSpace;/);
});

test('photographed ground keeps alpha and wins over synthetic green in Foto', () => {
  const body = app.slice(app.indexOf('const TERRAIN_FRAG ='), app.indexOf('function terrainMaterial'));
  assert.match(body, /vec4 photoGround = vec4\(0\.0\);/,
    'start with no photographed coverage');
  assert.match(body, /photoGround = texture\(uGround,/,
    'sample the photographed ground as RGBA, not only RGB');
  assert.match(body, /c = mix\(c, photoGround\.rgb, photoGround\.a\);/,
    'use the actual coverage of the photographed ground');
  assert.match(body, /if \(uVegOn > 0\.5 && \(uFotoGround < 0\.5 \|\| photoGround\.a < 0\.5\)\)/,
    'retain the mapped fallback when the look is not Foto or a texel has no photograph');
  assert.ok(body.indexOf('vec4 photoGround = vec4(0.0)') < body.indexOf('if (uFoto > 0.5 && uFotoGround > 0.5)'),
    'initialize coverage before sampling the ground');
});
