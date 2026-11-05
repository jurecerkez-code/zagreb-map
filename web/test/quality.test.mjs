import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianFps, nextStep, shouldBoost, makeQuality, STEPS, BOOST_MS, LOW, HIGH, WINDOW_MS, COOLDOWN_MS } from '../quality.js';

// Frames of constant gaps at `fps`, ending at `now`.
function gapsAt(fps, n = 60, now = 100000) {
  const dt = 1000 / fps;
  const gaps = [];
  for (let i = n; i > 0; i--) gaps.push({ t: now - i * dt, dt });
  return gaps;
}

test('no verdict before two dozen frames: early judgment is a guess, never a change', () => {
  assert.equal(medianFps([{ t: 1000, dt: 33 }], 1016), null);
  // 19 frames, all terrible: still no verdict.
  assert.equal(medianFps(gapsAt(12, 19), 100000), null);
});

test('the median ignores the background-tab stalls (those read as 250 ms frames on an idle machine)', () => {
  // 40 quick frames, then 8 minutes-in-the-background gaps.
  const gaps = [...gapsAt(30, 40), ...gapsAt(2, 8)];
  const fps = medianFps(gaps, 100000);
  assert.ok(Math.abs(fps - 30) < 2, `≈30, got ${fps}`);
});

test('old frames say nothing: the window is the window', () => {
  const old = gapsAt(12, 60, 1000);              // long ago
  const fps = medianFps(old, 100000);
  assert.equal(fps, null);
});

test('the ladder only moves on evidence: down below LOW with history, up above HIGH with cooldown', () => {
  // Below LOW, window passed: down one.
  assert.equal(nextStep(0, LOW - 1, WINDOW_MS + 1), 1);
  // Same low fps but no time since the last change: hold.
  assert.equal(nextStep(1, LOW - 1, WINDOW_MS - 1), 1);
  // Bottom of the ladder: never walks off the end.
  assert.equal(nextStep(STEPS.length - 1, LOW - 1, 1e9), STEPS.length - 1);
  // Feels fine again and the cooldown from the last change is over: recover one.
  assert.equal(nextStep(2, HIGH + 5, COOLDOWN_MS + 1), 1);
  // Recovery too soon: hold — a fast spell while the rise shader runs must not undo the drop.
  assert.equal(nextStep(2, HIGH + 5, COOLDOWN_MS - 1), 2);
  // The middle band is a dead zone on purpose: 24 fps is not a lie, 44 fps is not a promise.
  assert.equal(nextStep(1, (LOW + HIGH) / 2, 1e9), 1);
  // No fps at all: no decision.
  assert.equal(nextStep(1, null, 1e9), 1);
});

test('the page owner applies the ladder through setPixelRatio and says what it did', () => {
  const scales = [];
  const said = [];
  const renderer = { setPixelRatio: s => scales.push(s) };
  const q = makeQuality({ renderer, base: 1, say: (...a) => said.push(a.join(' ')) });
  let t = 0;
  for (let i = 0; i < 40; i++) q.frame(t += 20);                       // warm up at 50 fps
  // 12 fps sustained: the page's measured worst case. A drop every full slow window → eventually the bottom.
  for (let i = 0; i < 300; i++) q.frame(t += 83.333);                  // ~25 s
  assert.equal(q.step, STEPS.length - 1);
  assert.equal(q.step > 0 && said.length > 0, true);
  assert.match(said[0], /pixel ratio/);
  assert.match(said[0], /fps/);
  assert.deepEqual([...new Set(scales)], STEPS.slice(1));
  // No spare cycles wasted between verdicts: a frame budget of one test guards an O(n) frame() against the days
  // the gaps array got large.
  // Now 50 fps sustained: back up one step per cooldown, until full resolution again.
  for (let i = 0; i < 1000; i++) q.frame(t += 20);                     // ~20 s brisk
  assert.equal(q.step, 0);
  // And the ladder ends flat: pinned at fine speed, nothing else happens.
  for (let i = 0; i < 300; i++) q.frame(t += 83.333);
  assert.equal(q.step, STEPS.length - 1, 'sustained lag always descends again');
});

test('issue #23 boost: full dpr only after BOOST_MS of median frames under 8 ms', () => {
  // shouldBoost, pure: 200 fps sustained over the whole window (1000 frames at 5 ms = 5 s) → boost; 60 fps → never.
  assert.equal(shouldBoost(gapsAt(200, 1000), 100000), true);
  assert.equal(shouldBoost(gapsAt(60, 60), 100000), false);
  // Plenty fast but too fresh (no BOOST_MS of evidence): hold, exactly like the early-frames rule.
  assert.equal(shouldBoost(gapsAt(200, 30), 100000), false);

  const scales = [];
  const renderer = { setPixelRatio: s => scales.push(s) };
  const q = makeQuality({ renderer, base: 1.5, boost: 2, say: () => {} });
  let t = 0;
  for (let i = 0; i < 900; i++) q.frame(t += 5);                       // 200 fps for 4.5 s: the window is full
  assert.equal(q.boosted, true);
  assert.equal(scales.at(-1), 2);
  // A slow spell after the boost hands the run back to the ladder, un-boosted.
  for (let i = 0; i < 300; i++) q.frame(t += 83.333);
  assert.equal(q.boosted, false);
  assert.equal(scales.at(-1), 1.5 * STEPS[STEPS.length - 1]);
});

test('startStep opens the ladder one notch down (weak GPUs), never below the bottom', () => {
  const renderer = { setPixelRatio: () => {} };
  assert.equal(makeQuality({ renderer, base: 1.5, startStep: 1 }).step, 1);
  assert.equal(makeQuality({ renderer, base: 1.5, startStep: 99 }).step, STEPS.length - 1);
  assert.equal(makeQuality({ renderer, base: 1.5, startStep: -3 }).step, 0);
});
