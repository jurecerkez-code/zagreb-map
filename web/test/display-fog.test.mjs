import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { readFileSync } from 'node:fs';
import { syncDisplaySky, DISPLAY_FOG_GLSL } from '../display-fog.js';

test('the display fog uses the same sRGB components as the unlit clear background', () => {
  THREE.ColorManagement.enabled = true;
  const uniforms = {
    uFogColor: { value: new THREE.Color('#d9dfe3') },
    uFogDisplay: { value: new THREE.Vector3() },
  };
  const expected = uniforms.uFogColor.value.getRGB({}, THREE.SRGBColorSpace);
  syncDisplaySky(THREE, uniforms);
  assert.deepEqual(uniforms.uFogDisplay.value.toArray(), [expected.r, expected.g, expected.b]);
});

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function shaderOf(file, marker) {
  const src = read(file);
  const mark = src.indexOf(marker);
  assert.ok(mark >= 0, `${file}: ${marker} must exist`);
  const start = src.indexOf('`', mark);
  let end = start + 1;
  while (end < src.length && (src[end] !== '`' || src[end - 1] === '\\')) end++;
  return src.slice(start + 1, end);
}

test('every fogging shader mixes the display background after its own display transform', () => {
  assert.match(DISPLAY_FOG_GLSL, /uniform vec3 uFogDisplay;/);
  assert.match(DISPLAY_FOG_GLSL, /return mix\(uFogDisplay, colour, edge \* \(1\.0 - smoothstep\(uFog\.x, uFog\.y, range\)\)\);/);
  const app = read('app.js');
  assert.match(app, /uFogDisplay: \{ value: new THREE\.Vector3\(\) \}/);
  for (const name of ['applySky', 'applyNightSky']) {
    const start = app.indexOf(`function ${name}`);
    const end = app.slice(start).search(/\r?\n\}\r?\n/);
    assert.ok(start >= 0 && end >= 0, `${name} exists`);
    assert.match(app.slice(start, start + end), /syncDisplaySky\(THREE, uniforms\);/);
  }
  for (const [file, marker] of [
    ['app.js', 'const FRAG ='], ['app.js', 'const TERRAIN_FRAG ='],
    ['ferries-layer.js', 'const hullFrag'], ['ferries-layer.js', 'const wakeFrag'],
    ['roads-layer.js', 'fragmentShader:'], ['monuments.js', 'fragmentShader:'],
  ]) {
    const shader = shaderOf(file, marker);
    assert.ok(shader.includes('${DISPLAY_FOG_GLSL}'), `${file}: one shared fog helper`);
    assert.match(shader, /(?:outColor|gl_FragColor)\.rgb = displayFog\(/, `${file}: post-display fog call`);
    assert.ok(shader.lastIndexOf('#include <colorspace_fragment>') < shader.lastIndexOf('displayFog('),
      `${file}: fog must follow tone mapping and sRGB`);
    assert.doesNotMatch(shader, /mix\(\s*uFogColor|mix\([^,]+,\s*uFogColor\s*,/,
      `${file}: do not blend linear fog while the background is unlit sRGB`);
  }
  for (const file of ['ferries-layer.js', 'roads-layer.js', 'monuments.js']) {
    assert.ok(read(file).includes('uFogDisplay: uniforms.uFogDisplay'), `${file}: shared uniform is wired`);
  }
});

test('already dimmed night fog is not tinted a second time', () => {
  for (const marker of ['const FRAG =', 'const TERRAIN_FRAG =']) {
    const shader = shaderOf('app.js', marker);
    const night = /outColor\.rgb = mix\(outColor\.rgb, outColor\.rgb \* vec3\(0\.30, 0\.36, 0\.56\), uNight\);/.exec(shader);
    assert.ok(night, `${marker}: material's night tint exists`);
    assert.ok(shader.lastIndexOf('#include <colorspace_fragment>') < night.index,
      `${marker}: apply night to the material's display output`);
    assert.ok(night.index < shader.lastIndexOf('displayFog('),
      `${marker}: the dimmed clear background must not be multiplied again`);
  }
});

  // uniform wiring is asserted in the integration test above.
