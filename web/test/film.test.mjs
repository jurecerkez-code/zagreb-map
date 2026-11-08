import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filmOrbit } from '../timeline.js';

const { filmOrbitProgress } = await import('../timeline.js');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const filmSpec = readFileSync(new URL('../../e2e/film.spec.mjs', import.meta.url), 'utf8');

test('a resumed film preserves its exact orbit and completes the original twenty degrees', () => {
  const prePlayAzimuth = 0.7;
  const pausedOrbitT = 0.1234;
  const quantizedResumeT = 0.1240000000000001;

  const atResume = filmOrbitProgress?.(quantizedResumeT, quantizedResumeT, pausedOrbitT);
  assert.ok(Math.abs(atResume - pausedOrbitT) < 1e-12,
    'quantizing the year clock must not move the paused camera');

  const atEnd = filmOrbitProgress?.(1, quantizedResumeT, pausedOrbitT);
  assert.equal(atEnd, 1);
  const finalAzimuth = prePlayAzimuth + filmOrbit(atEnd, false);
  assert.ok(Math.abs(finalAzimuth - (prePlayAzimuth + filmOrbit(1, false))) < 1e-12,
    'the resumed film must finish the original orbit, not the quantized remainder');
  assert.match(app, /filmOrbitProgress\(t, playT0, filmOrbitFrame\.orbitT0\)/,
    'the animation loop must use the separate orbit clock');
});

test('the final film tally comes from the ended 2026 state, not a playing sample', () => {
  assert.match(app, /const filmTally = playing \|\| !filmNote\.hidden;/,
    'natural completion must retain the dated tally while the film arrival note is up');
  assert.match(app, /document\.getElementById\('count'\)\.textContent = filmTally\r?\n\s+\? T\('ui\.film\.known'/,
    'stopping the clock must not replace the final dated tally with the ordinary Today total');
  assert.match(filmSpec, /const ended = await page\.evaluate\(\(\) => \(\{[\s\S]*?count: document\.getElementById\('count'\)\.textContent/,
    'the ended snapshot must capture the tally after playing becomes false');
  assert.match(filmSpec, /\}, 2026\);/, 'the expected count must be evaluated at 2026');
  assert.match(filmSpec, /expect\(ended\.count\)\.toBe\(tally\.text\)/);
  assert.doesNotMatch(filmSpec, /started\.at\(-1\)\.(?:year|count)/,
    'a scheduling-dependent playing sample must not select or carry the final tally');
});
