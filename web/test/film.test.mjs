import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filmOrbit } from '../timeline.js';

const { filmYear, filmOrbitProgress, filmTimeAtYear } = await import('../timeline.js');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const filmSpec = readFileSync(new URL('../../e2e/film.spec.mjs', import.meta.url), 'utf8');

const histogram = {
  1200: [4, 0], 1300: [8, 0], 1600: [30, 0], 1700: [10, 0],
  1800: [900, 0], 1900: [1000, 0], 2026: [1200, 0],
};
const functionSource = (from, to) => {
  const start = app.indexOf(`function ${from}(`);
  const end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `cannot isolate ${from} from app.js`);
  return app.slice(start, end);
};
const startSource = functionSource('startPlay', 'function stopPlay(');
const stopSource = functionSource('stopPlay', 'playBtn.onclick =');
const playStateBody = app.match(/playState: \(\) => \(\{([^}]+)\}\)/)?.[1];
assert.ok(playStateBody, 'cannot isolate playState from app.js');

// Execute the actual application lifecycle functions with only their DOM/camera dependencies stubbed. This catches
// scan-order and shared-state bugs without starting a browser or replacing the production logic with a test model.
function filmLifecycle(year = 1976.6, orbitT = 0.31) {
  const events = [], microtasks = [];
  const env = {
    events, microtasks,
    uniforms: { uYear: { value: year }, uYearFrom: { value: 1199 }, uPlaying: { value: 1 }, uRise: { value: 2 } },
    config: { histogram, yearMax: 2026 }, T0: 1200, FROM_REST: 1199,
    playing: true, playT0: 0.8,
    filmOrbitFrame: { azimuth: 0.1, horizontal: 500, orbitT0: 0, orbitT },
    camera: { position: { x: 300, z: 400 } },
    controls: { target: { x: 0, z: 0 }, getAzimuthalAngle: () => 0.4 },
    calm: { matches: false }, filmOrbit,
    filmTimeAtYear: (...args) => { events.push('inverse'); return filmTimeAtYear(...args); },
    playYear: t => { events.push('year'); return filmYear(t, histogram, 1200, 2026); },
    performance: { now: () => { events.push('now'); return 1000 + events.length; } },
    setHandle: (which, value) => { env.uniforms[which].value = value; },
    playIcon: { setAttribute() {} }, playBtn: { setAttribute() {} }, T: id => id,
    drawHist: () => events.push('draw'), clearTimeout() {}, filmNote: { hidden: true },
    queueMicrotask: callback => microtasks.push(callback),
  };
  const factory = new Function('env', `
    const { uniforms, config, T0, FROM_REST, camera, controls, calm, filmOrbit, filmTimeAtYear, playYear,
      performance, setHandle, playIcon, playBtn, T, drawHist, clearTimeout, filmNote, queueMicrotask } = env;
    let playing = env.playing, playT0 = env.playT0, playStart = 0, pausedFilmYear = null, pausedFilm = null;
    let filmOrbitFrame = env.filmOrbitFrame, frameDue = 0, arrivalTimer = null;
    ${startSource}
    ${stopSource}
    return {
      startPlay, stopPlay, events: env.events, uniforms,
      playState: () => ({ ${playStateBody} }),
      get filmOrbitFrame() { return filmOrbitFrame; },
      flush() { for (const callback of env.microtasks.splice(0)) callback(); },
      advance(year, t, orbitT) { playing = true; uniforms.uYear.value = year; playT0 = t; filmOrbitFrame.orbitT = orbitT; },
    };
  `);
  return factory(env);
}

test('a manual pause retains exact resume year and orbit while its display is floored', () => {
  const film = filmLifecycle();
  film.stopPlay(true);
  assert.equal(film.uniforms.uYear.value, 1976.6, 'the click itself still sees the injected fractional year');
  assert.equal(film.playState().year, 1976.6);
  film.flush();
  assert.equal(film.uniforms.uYear.value, 1976, 'only the displayed handle/map year is floored');
  assert.equal(film.playState().year, 1976.6, 'the exact paused year remains observable for resume');
  film.startPlay();
  assert.equal(film.uniforms.uYear.value, 1976.6, 'resume restores the exact year, not its display floor');
  assert.equal(film.filmOrbitFrame.orbitT, 0.31, 'the separate exact orbit clock has not moved');
  const restored = filmYear(film.playState().playT0, histogram, 1200, 2026);
  assert.ok(Math.abs(restored - 1976.6) < 1e-6, `resume time restored ${restored}`);
});

test('boundary and repeated pauses do not accumulate year or orbit jumps', () => {
  const film = filmLifecycle();
  const cases = [
    { year: 1300.25, orbit: 0.1 }, { year: 1613.5, orbit: 0.44 },
    { year: 1700.75, orbit: 0.65 }, { year: 1850.5, orbit: 0.72 }, { year: 1976.6, orbit: 0.91 },
  ];
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const item of cases) {
      film.advance(item.year, 0.5, item.orbit);
      film.stopPlay(true);
      film.flush();
      assert.equal(film.uniforms.uYear.value, Math.floor(item.year));
      assert.equal(film.playState().year, item.year);
      film.startPlay();
      assert.equal(film.uniforms.uYear.value, item.year);
      assert.equal(film.filmOrbitFrame.orbitT, item.orbit);
      const restored = filmYear(film.playState().playT0, histogram, 1200, 2026);
      assert.ok(Math.abs(restored - item.year) < 1e-6, `${item.year} restored as ${restored}`);
    }
  }
});

test('a resumed clock starts only after bounded year inversion and initialization', () => {
  const film = filmLifecycle(1613.5);
  film.stopPlay(true);
  film.flush();
  film.events.length = 0;
  film.startPlay();
  assert.deepEqual(film.events.slice(-2), ['draw', 'now'],
    'the wall clock starts after the inverse, orbit setup and first display initialization');
  assert.ok(film.events.includes('inverse'), 'resume uses the bounded inverse');
});

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
