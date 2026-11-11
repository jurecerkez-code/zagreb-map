// web/veg.js seasons and wind (#33). The invariant the picture gate depends on: no season may darken the canopy, so
// autumn and winter are hue shifts and a thinner silhouette, never a dimmer tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEASONS, seasonOf, WIND } from '../veg.js';

const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('four seasons cover the twelve months, each exactly once', () => {
  const seen = new Map();
  for (const s of SEASONS) for (const m of s.months) {
    assert.ok(m >= 1 && m <= 12, `${s.key}: month ${m}`);
    assert.ok(!seen.has(m), `month ${m} belongs to ${seen.get(m)} and ${s.key}`);
    seen.set(m, s.key);
    assert.equal(seasonOf(m).key, s.key);
  }
  assert.equal(seen.size, 12);
});

test('no season darkens the canopy: every tint is hue-only, luminance at or above 1', () => {
  for (const s of SEASONS) {
    assert.ok(lum(s.tint) >= 1, `${s.key}'s tint luminance is ${lum(s.tint).toFixed(3)}, must be at least 1`);
    assert.ok(lum(s.tint) < 1.15, `${s.key}'s tint brightens by ${(lum(s.tint) * 100 - 100).toFixed(0)}%, too much for a tree`);
    for (const c of s.tint) assert.ok(c > 0.6 && c < 1.3, `${s.key}: channel ${c} stays a shift, not a repaint`);
  }
});

test('summer is the look\'s own colour: the default must not tint the map', () => {
  const summer = SEASONS.find(s => s.key === 'summer');
  assert.deepEqual(summer.tint, [1, 1, 1]);
  assert.equal(summer.bare, 0);
  assert.equal(seasonOf(7).key, 'summer');
});

test('autumn is warmer, winter is barer, and only winter thins the canopy', () => {
  const [winter, , , autumn] = ['winter', 'spring', 'summer', 'autumn'].map(k => SEASONS.find(s => s.key === k));
  assert.ok(autumn.tint[0] > autumn.tint[2], 'autumn leans red over blue');
  assert.ok(winter.tint[0] >= winter.tint[2], 'winter leans brown over blue');
  assert.ok(winter.bare > autumn.bare, 'the November tree loses more crown than the October one');
  for (const s of [SEASONS[1], SEASONS[2], autumn]) assert.ok(s.bare <= 0.15, `${s.key} keeps its canopy`);
  assert.ok(winter.bare >= 0.3 && winter.bare <= 0.6, 'winter cuts a third to a half of the sprite away, no more');
});

test('an unknown month falls back to summer, never to nothing', () => {
  for (const m of [undefined, null, 0, 13, -1, 'x', NaN]) assert.equal(seasonOf(m).key, 'summer');
  assert.equal(seasonOf('11').key, 'autumn', 'a query string month works');
});

test('the wind leans the crown, not the trunk line, and is bounded', () => {
  assert.ok(WIND > 0 && WIND <= 1, 'the default wind is a breeze');
  // the shader's own lean: sin() * 0.06 * uWind * (position.y + 0.5), and position.y of a plane is -0.5..0.5
  const lean = (y, t, phase, wind = WIND) => Math.sin(t * 1.6 + phase * 6.2831853) * 0.06 * wind * Math.max(0, y + 0.5);
  assert.equal(Math.abs(lean(-0.5, 1, 0.3)), 0, 'the trunk base never moves');
  let peak = 0;
  for (let i = 0; i < 200; i++) peak = Math.max(peak, Math.abs(lean(0.5, i * 0.05, i * 0.01)));
  assert.ok(peak > 0.005, 'the crown does move');
  assert.ok(peak < 0.035, `and never more than ${(peak * 8.6).toFixed(2)} m at the top of an 8.6 m canopy`);
});
