import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeStartupQueue, localRtAllowed, buildInfoAllowed } from '../startup-load.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

test('optional work really waits for reveal, runs once in order and uses one idle per layer', async () => {
  const events = [];
  const queue = makeStartupQueue({
    idle: () => { events.push('idle'); return Promise.resolve(); },
    onError: (error, key) => { throw error; },
  });
  for (const name of ['terrain', 'roads', 'trees', 'foto', 'cityHeight', 'monuments', 'facts', 'funicular', 'tour', 'trams']) {
    queue.add(name, () => { events.push(name); });
  }
  await turn();
  assert.deepEqual(events, [], 'a microtask before reveal must not fetch optional layers');
  await queue.release();
  assert.deepEqual(events, [
    'idle', 'terrain', 'idle', 'roads', 'idle', 'trees', 'idle', 'foto', 'idle', 'cityHeight',
    'idle', 'monuments', 'idle', 'facts', 'idle', 'funicular', 'idle', 'tour', 'idle', 'trams',
  ]);
  assert.equal(queue.add('terrain', () => { events.push('duplicate terrain'); }), queue.add('terrain', () => { events.push('duplicate again'); }));
  queue.add('attributes', () => { events.push('attributes'); });
  await queue.release();
  assert.deepEqual(events.slice(-2), ['idle', 'attributes'], 'work registered after reveal still gets its own idle slot');
  assert.equal(events.filter(event => event === 'terrain').length, 1);
  assert.ok(!events.some(event => String(event).startsWith('duplicate')));
});

test('an optional failure is logged and cannot block later layers', async () => {
  const errors = [], events = [];
  const queue = makeStartupQueue({ idle: () => Promise.resolve(), onError: (error, key) => errors.push(key) });
  queue.add('trees', () => Promise.reject(new Error('missing vegetation')));
  queue.add('foto', () => { events.push('foto'); });
  await turn();
  assert.deepEqual(events, []);
  const settled = await queue.release();
  assert.deepEqual(errors, ['trees']);
  assert.deepEqual(events, ['foto']);
  assert.equal(settled.length, 2);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'fulfilled');
});

test('declared layer order wins over registration order and optional layers take no idle slot', async () => {
  const events = [];
  const queue = makeStartupQueue({
    idle: () => { events.push('idle'); },
    order: ['terrain', 'attributes', 'roads', 'trees', 'foto', 'cityHeight', 'monuments', 'facts', 'funicular', 'tour', 'trams'],
  });
  for (const name of ['trams', 'trees', 'roads', 'attributes', 'terrain']) {
    queue.add(name, () => { events.push(name); });
  }
  await queue.release();
  assert.deepEqual(events, ['idle', 'terrain', 'idle', 'attributes', 'idle', 'roads', 'idle', 'trees', 'idle', 'trams']);
});

test('app wires attributes directly after terrain, and source workers are deployable beside a bundle', () => {
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const terrain = app.indexOf("afterReveal.add('terrain'");
  const attrs = app.indexOf("afterReveal.add('attributes'");
  const roads = app.indexOf("afterReveal.add('roads'");
  assert.ok(terrain >= 0 && terrain < attrs && attrs < roads, 'terrain → attributes → roads registration is required');
  const start = app.indexOf('mapRevealed = true');
  const end = app.indexOf('foldCreditSoon();', start);
  assert.ok(start >= 0 && end > start, 'the reveal block must be present');
  const reveal = app.slice(start, end);
  assert.ok(!reveal.includes("afterReveal.add('attributes'"), 'attributes must not bypass the queue at reveal');
});

test('only local development asks /rt, and only the real Pages URL asks for the build stamp', () => {
  for (const host of ['localhost', '127.0.0.1']) assert.equal(localRtAllowed(host), true, host);
  for (const host of ['[::1]', '::1', 'jurecerkez-code.github.io', 'preview.example', 'husforhus.se']) assert.equal(localRtAllowed(host), false, host);
  assert.equal(buildInfoAllowed('jurecerkez-code.github.io'), true);
  assert.equal(buildInfoAllowed('JURECERKEZ-CODE.GITHUB.IO'), true);
  assert.equal(buildInfoAllowed('localhost'), false);
  assert.equal(buildInfoAllowed('example.github.io'), false);
});

test('app wires the reveal gate to the specified work and starts the service worker only then', () => {
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const plan = src.slice(src.indexOf('function scheduleDeferredLayers()'), src.indexOf('// ?at=x,z'));
  const names = [...plan.matchAll(/afterReveal\.add\('([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(names, ['terrain', 'attributes', 'roads', 'trees', 'foto', 'cityHeight', 'monuments', 'facts', 'funicular', 'tour', 'trams']);
  assert.ok(plan.indexOf('await loadTerrain(base);') < plan.indexOf("afterReveal.add('roads'"), 'roads wait for the terrain attempt');
  assert.ok(plan.indexOf("afterReveal.add('attributes'") > plan.indexOf('try { await loadTerrain(base); }'), 'attributes wait for terrain');
  assert.match(src, /if \(name === 'foto'\) afterReveal\.add\('foto', loadPhotoColours\);/, 'switching to Foto later still requests its colours');
  assert.ok(src.indexOf('scheduleDeferredLayers();') < src.indexOf('renderer.setAnimationLoop('));
  const reveal = src.indexOf('mapRevealed = true;');
  assert.ok(reveal >= 0);
  assert.ok(src.indexOf('afterReveal.release();', reveal) > reveal);
  const updates = src.indexOf('startMapUpdates();', reveal);
  assert.ok(updates > src.indexOf('afterReveal.release();', reveal));
  assert.match(src, /serviceWorker:\s*navigator\.serviceWorker/);
});
