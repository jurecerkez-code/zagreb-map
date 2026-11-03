// The scene player's pure parts (web/scene-player.js): beat timing and lat/lon to the viewer's local frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_BEAT_S, beatDuration, timing, playedS, remainingS, fmtClock, prevBeat, clampBeat, flightS, ease,
  toLocal, polyline, nearestOn, pointAt, routeLegs, askedScene } from '../scene-player.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('a beat lasts its duration_s, else the default', () => {
  assert.equal(beatDuration({ duration_s: 6 }), 6);
  assert.equal(beatDuration({}), DEFAULT_BEAT_S);
  assert.equal(beatDuration({ duration_s: 0 }), DEFAULT_BEAT_S);
  assert.equal(beatDuration({ duration_s: 'x' }), DEFAULT_BEAT_S);
});

test('timing: starts, total, played and remaining', () => {
  const tm = timing([{ duration_s: 6 }, {}, { duration_s: 4 }]);
  assert.deepEqual(tm.durations, [6, 8, 4]);
  assert.deepEqual(tm.offsets, [0, 6, 14]);
  assert.equal(tm.total, 18);
  assert.equal(playedS(tm, 1, 3), 9);
  assert.equal(playedS(tm, 1, 99), 14, 'a beat never counts past its own end');
  assert.equal(remainingS(tm, 0, 0), 18);
  assert.equal(remainingS(tm, 2, 4), 0);
  assert.equal(fmtClock(65.2), '1:06');
  assert.equal(fmtClock(0), '0:00');
});

test('the Gradec and Kaptol story runs 65 s over 8 beats', () => {
  const s = JSON.parse(fs.readFileSync(new URL('../scenes/two-hills.json', import.meta.url)));
  const tm = timing(s.beats);
  assert.equal(tm.durations.length, 8);
  assert.equal(tm.total, 65);
  assert.equal(tm.offsets[7], 57);
});

test('previous restarts a beat after 1.5 s, else goes back; beats stay in range', () => {
  assert.equal(prevBeat(3, 2), 3);
  assert.equal(prevBeat(3, 1), 2);
  assert.equal(prevBeat(0, 0), 0);
  assert.equal(clampBeat(-1, 8), 0);
  assert.equal(clampBeat(9, 8), 7);
});

test('the flight takes half a beat, at most 3 s, eased from 0 to 1', () => {
  assert.equal(flightS(4), 2);
  assert.equal(flightS(13), 3);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(0.5), 0.5);
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
  assert.ok(ease(0.1) < 0.1 && ease(0.9) > 0.9, 'slow in and out');
});

test('the local frame: HTRS96/TM (web/sweref.js), x east of the origin, z south of it (pipeline/city.py to_local)', () => {
  // reference: pyproj Transformer.from_crs(4326, 3765, always_xy=True), Zagreb Cathedral 45.8144444 N 15.9797222 E
  const origin = [459370.1, 5074937.5];
  const [x, z] = toLocal(45.8144444, 15.9797222, origin);
  near(x, 459567.116 - origin[0], 0.01, 'x');
  near(z, -(5075085.609 - origin[1]), 0.01, 'z');
  const [xn, zn] = toLocal(45.82, 15.99, origin);
  assert.ok(xn > x && zn < z, 'further north-east is +x, -z');
});

test('routes: nearest point, a point along, and the legs the marker runs per beat', () => {
  const line = polyline([[0, 0], [100, 0], [100, 100]]);
  assert.equal(line.length, 200);
  assert.deepEqual(nearestOn(line, [50, 10]), { s: 50, d: 10 });
  assert.deepEqual(pointAt(line, 150), [100, 50]);
  assert.deepEqual(pointAt(line, 999), [100, 100]);
  // beat 0 is off the route; beat 2 is behind beat 1 on it, so the marker waits rather than going back
  const legs = routeLegs(line, [[500, 500], [100, 20], [60, 0], [100, 100]]);
  assert.deepEqual(legs, [null, { from: 120, to: 120 }, { from: 120, to: 120 }, { from: 120, to: 200 }]);
});

test('?scene= opens a scene only when features.scenes is on', () => {
  assert.equal(askedScene(true, '?scene=two-hills'), 'two-hills');
  assert.equal(askedScene(true, '?lang=sv'), null);
  assert.equal(askedScene(false, '?scene=two-hills'), null, 'off: the URL is ignored');
  assert.equal(askedScene(undefined, '?scene=two-hills'), null, 'a config without the switch counts as off');
});

test('ghosts: shown from their beat to their last; the hull is 69 m long and 12 m wide', async () => {
  const { ghostShown, hullOutline } = await import('../scene-player.js');
  assert.equal(ghostShown({ from: 2 }, 0), false);
  assert.equal(ghostShown({ from: 2 }, 1), true);
  assert.equal(ghostShown({ from: 1, until: 4 }, 4), false);
  const xs = hullOutline().map(p => p[0]), zs = hullOutline().map(p => p[1]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 69);
  assert.equal(Math.max(...zs) - Math.min(...zs), 12);
});

// The Zagreb stories: 6 to 10 beats, every camera looks down on its target at 25 deg or more (flat ground), every beat
// has its own year (timeline_year), a caption in both slots with no dashes, and a source; 2 to 5 photos.
import { beatYear, sceneLayers } from '../scene-player.js';
const index = JSON.parse(fs.readFileSync(new URL('../scenes/index.json', import.meta.url)));

test('the index lists the five Zagreb stories, all ready, and no Stockholm one', () => {
  assert.deepEqual(index.scenes.map(s => s.id), ['two-hills', 'earthquake-1880', 'green-horseshoe', 'interwar-estates', 'across-the-sava']);
  assert.ok(index.scenes.every(s => s.ready));
});

for (const { id } of index.scenes) {
  test(`${id}: 6 to 10 beats, cameras at 25 deg or more, a year, captions and a source per beat, 2 to 5 photos`, () => {
    const s = JSON.parse(fs.readFileSync(new URL(`../scenes/${id}.json`, import.meta.url)));
    assert.equal(s.ready, true);
    assert.ok(s.beats.length >= 6 && s.beats.length <= 10, `${id}: ${s.beats.length} beats`);
    const origin = [459370.1, 5074937.5];
    for (const b of s.beats) {
      const [cx, cz] = toLocal(b.camera.lat, b.camera.lon, origin), [tx, tz] = toLocal(b.target.lat, b.target.lon, origin);
      const down = Math.atan2(b.camera.height_m, Math.hypot(cx - tx, cz - tz)) * 180 / Math.PI;
      assert.ok(down >= 25, `${id} beat ${b.n}: ${down.toFixed(1)}°`);
      assert.ok(Math.hypot(cx, cz) < 15000, `${id} beat ${b.n}: camera inside Zagreb`);
      assert.ok(Number.isInteger(b.year) && b.year >= 1200 && b.year <= 2026, `${id} beat ${b.n}: its own year`);
      for (const t of [b.caption.en, b.caption.sv]) assert.ok(t && !/[\u2013\u2014]/.test(t), `${id} beat ${b.n}: caption, no dashes`);
      assert.ok(b.sources.length, `${id} beat ${b.n}: a source`);
    }
    const photos = s.beats.filter(b => b.photo).length;
    assert.ok(photos >= 2 && photos <= 5, `${id}: ${photos} photos`);
    assert.deepEqual(sceneLayers(s), []);
    assert.ok(!(s.overlays || []).some(o => o.type === 'ghost'), `${id}: no ghosts without a sourced footprint`);
  });
}

test('beatYear: the beat\'s own year, else the scene\'s; sceneLayers keeps only known layers', () => {
  const s = { year: 1950, beats: [{ year: 1952 }, {}] };
  assert.equal(beatYear(s, 0), 1952);
  assert.equal(beatYear(s, 1), 1950);
  assert.deepEqual(sceneLayers({ layers: ['metro', 'trams'] }), ['metro']);
  assert.deepEqual(sceneLayers({}), []);
});
