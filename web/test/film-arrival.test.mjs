import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { easeShown, prefAfterClick, unknownShown } from '../unknown.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = (startMarker, endMarker) => {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `cannot isolate ${startMarker}`);
  return app.slice(start, end);
};
const showArrivalSource = source('function showFilmArrival()', 'function startPlay(');
const unknownNowSource = source('function unknownNow()', 'uniforms.uShowUnknown.value =');
const stepUnknownSource = source('function stepUnknown(dt)', '// The switch changes in place');
const flipUnknownSource = source('function flipUnknown()', '// ---------- Facing north');
const rateSource = source('  const fast = now < dirtyUntil', '  updateLods();');

// Drive the actual unknown and rate-decision functions through the production frame order. renderer.render is the
// observational seam: reaching uShowUnknown = 1 in cheap steps after the last due frame does not satisfy these tests.
function unknownDrawLifecycle({ playing = true, pref = 'auto', shown = 0 } = {}) {
  const env = {
    uniforms: { uYearFrom: { value: 1199 }, uYear: { value: 2026 }, uShowUnknown: { value: shown } },
    config: { yearMin: 1200, yearMax: 2026 }, maskTarget: [true],
    calm: { matches: false }, easeShown, prefAfterClick, unknownShown,
    filmNote: { hidden: true, textContent: '' }, T: id => id,
    store: {}, writePref() {}, syncUnknownSwitch() {}, drawHist() {},
    clearTimeout() {}, setTimeout() { return 1; },
    postcard: { on: false }, camera: {}, trams: null, ride: null,
    quality: { frame() {} }, stepHoverTips() {},
    draws: [],
  };
  const factory = new Function('env', `
    const { uniforms, config, maskTarget, calm, easeShown, prefAfterClick, unknownShown, filmNote, T, store, writePref,
      syncUnknownSwitch, drawHist, clearTimeout, setTimeout, postcard, camera, trams, ride, quality,
      stepHoverTips, draws } = env;
    let playing = ${playing}, unknownPref = ${JSON.stringify(pref)}, unknownSolo = false, unknownWas = null;
    let arrivalTimer = null, dirtyUntil = 0, frameDue = -1, weatherMoved = false, lastDueAt = 0;
    let now = 0, lastFrameAt = null;
    const performance = { now: () => now };
    const invalidate = (ms = 0) => { dirtyUntil = Math.max(dirtyUntil, performance.now() + ms); };
    ${unknownNowSource}
    ${stepUnknownSource}
    ${showArrivalSource}
    ${flipUnknownSource}
    const renderer = { render() {
      draws.push({ at: now, unknown: uniforms.uShowUnknown.value, playing });
    } };
    function frame(at) {
      now = at;
      const dt = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
      lastFrameAt = now;
      stepUnknown(dt);
      if (playing) {
        if (now >= 1000) { playing = false; showFilmArrival(); }
        else invalidate(150); // the final film orbit's normal controls-change wake-up
      }
      ${rateSource}
      renderer.render();
    }
    let elapsed = 0;
    frame(elapsed);
    return { uniforms, draws, flipUnknown,
      run(ms) {
        const end = elapsed + ms;
        while (elapsed < end - 1e-9) { elapsed = Math.min(end, elapsed + 1000 / 60); frame(elapsed); }
      },
      get dirtyUntil() { return dirtyUntil; }, get frameDue() { return frameDue; },
    };
  `);
  return factory(env);
}

test('a natural film arrival draws the final undated rise, not only its offscreen uniform', () => {
  const film = unknownDrawLifecycle();
  film.run(3000);
  const last = film.draws.at(-1);
  assert.equal(film.uniforms.uShowUnknown.value, 1, 'cheap steps settle the value even after the map idles');
  assert.equal(last.playing, false, 'the film completed naturally');
  assert.equal(last.unknown, 1,
    `the last actual render must show the completed rise; last draw ${JSON.stringify(last)}`);
});

test('unknown switches wake an idle map through both the sink and the rise', () => {
  const map = unknownDrawLifecycle({ playing: false, pref: 'show', shown: 1 });
  map.run(100);
  assert.equal(map.frameDue, Infinity, 'start from a genuinely idle scheduler');
  map.flipUnknown();
  map.run(1200);
  assert.equal(map.draws.at(-1).unknown, 0, 'renderer.render draws the fully hidden state');
  map.flipUnknown();
  map.run(1600);
  assert.equal(map.draws.at(-1).unknown, 1, 'renderer.render draws the fully risen state');
});
