import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sunIsNight } from '../sun.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const apply = app.slice(app.indexOf('function applySunMode('), app.indexOf('const sunLabel ='));
const sync = app.slice(app.indexOf('function syncVegNight('), app.indexOf("// ---------- The sun's button ----------"));

test('live below six degrees is night, other modes keep their own light', () => {
  assert.equal(sunIsNight('night', 70), true);
  assert.equal(sunIsNight('live', 5.99), true);
  assert.equal(sunIsNight('live', 6), false);
  assert.equal(sunIsNight('day', -30), false);
  assert.equal(sunIsNight('golden', -30), false);
});

test('computed live night replaces the grazing vector and controls every receiver', () => {
  const nightDecision = apply.indexOf('const night = sunIsNight(mode, sunState.elevation)');
  const nightVector = apply.indexOf('if (night) {');
  const nightFlag = apply.indexOf('uniforms.uNight.value = night ? 1 : 0;');
  assert.ok(nightDecision >= 0 && nightDecision < nightVector && nightVector < nightFlag);
  assert.match(apply, /uniforms\.uSun\.value\.set\(0\.0, 0\.62, -0\.78\)\.normalize\(\);\s*sunState = \{ \.\.\.sunState, elevation: -6, azimuth: 0, clamped: true, mode \};/);
  for (const id of ['veg', 'trams', 'roads']) {
    assert.match(sync, new RegExp(`${id}\\??\\.setNight\\(!!uniforms\\.uNight\\.value`), id);
  }
  assert.doesNotMatch(sync, /sunMode === 'night'/);
});
