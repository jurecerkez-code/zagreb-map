import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const app = read('app.js');
const theme = read('themes.js');

test('the neutral view keeps the renderer display stage and per-mode exposures', () => {
  assert.match(app, /renderer\.toneMapping = THREE\.NeutralToneMapping;/);
  assert.match(app, /renderer\.outputColorSpace = THREE\.SRGBColorSpace;/);
  assert.match(app, /renderer\.toneMappingExposure = 1;/);
  assert.match(app, /const SUN_EXPOSURE = \{ golden: 1, day: 1, night: 1 \}/);
  assert.match(app, /const night = sunIsNight\(mode, sunState\.elevation\)/);
  assert.match(app, /mode === 'live' && !night/);
  assert.match(app, /#include <tonemapping_fragment>/);
  assert.match(app, /#include <colorspace_fragment>/);
});

test('direct sun and ambient fill are shared by all lighting receivers', () => {
  assert.match(theme, /export const SUN_LIGHT = \{ direct: 1\.8, skyFill: 0\.2 \};/);
  assert.match(app, /\$\{glf\(SUN_LIGHT\.direct\)\} \* visibility/);
  assert.match(app, /\$\{glf\(SUN_LIGHT\.skyFill\)\}\);/);

  const boats = read('ferries-layer.js');
  assert.match(boats, /vec3 direct = uSunCol \* \(max\(dot\(n, uSun\), 0\.0\) \* \$\{SUN_LIGHT\.direct\.toFixed\(1\)\}\);/);
  assert.match(boats, /vec3 ambient = uSkyCol \* \(mix\(0\.6, 1\.0, n\.y \* 0\.5 \+ 0\.5\) \* \$\{SUN_LIGHT\.skyFill\.toFixed\(1\)\}\);/);

  const monuments = read('monuments.js');
  assert.match(monuments, /vec3 direct = uSunCol \* \(max\(dot\(n, normalize\(uSun\)\), 0\.0\) \* \$\{SUN_LIGHT\.direct\.toFixed\(1\)\}\);/);
  assert.match(monuments, /vec3 ambient = uSkyCol \* \(mix\(0\.6, 1\.0, n\.y \* 0\.5 \+ 0\.5\) \* \$\{SUN_LIGHT\.skyFill\.toFixed\(1\)\}\);/);
});

test('roads also receive the scene sun and shadows through the same palette', () => {
  const roads = read('roads-layer.js');
  for (const key of ['uSun', 'uSunCol', 'uSkyCol', 'uHgt', 'uHgtN', 'uHgtO', 'uHgtCell', 'uHgtOn']) {
    assert.match(roads, new RegExp(`${key}: uniforms\\.${key}`));
  }
  assert.match(roads, /vec3 lighting\(vec3 n, float visibility\)/);
  assert.match(roads, /float visibility = mix\(0\.58, 1\.0, sunShadow\(vWorld\)\);/);
  assert.match(roads, /c \*= lighting\(n, visibility\);/);
});
