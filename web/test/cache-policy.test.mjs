import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { showNewVersion, makeMapUpdateMonitor, makeMapUpdateChip } from '../cache-update.js';

const CURRENT_URL = 'https://example.test/map/data/current.json';
function workerContext({ current = 'v20261108-live', currentFails = false, scope = 'https://example.test/map/' } = {}) {
  const events = {}, requests = [], writes = [], deleted = [], cachesByName = new Map();
  let offline = false, responseStatus = 200;
  const openCache = name => {
    if (!cachesByName.has(name)) cachesByName.set(name, new Map());
    const entries = cachesByName.get(name);
    return {
      match: request => Promise.resolve(entries.get(request.url)),
      put: async (request, response) => {
        if (response.status === 206) throw new TypeError('partial responses cannot be cached');
        entries.set(request.url, response);
        writes.push({ cache: name, url: request.url });
      },
    };
  };
  const context = {
    URL, Request, Response,
    location: { origin: 'https://example.test' },
    registration: { scope },
    addEventListener: (name, callback) => { events[name] = callback; },
    caches: {
      open: async name => openCache(name),
      keys: async () => ['zagreb-map-data-v20261101-old', 'zagreb-map-data-v20261108-live', 'unrelated-cache'],
      delete: async key => { deleted.push(key); return true; },
    },
    fetch: async (request, init) => {
      const url = typeof request === 'string' ? request : request.url;
      requests.push({ url, cache: init?.cache ?? (typeof request === 'object' ? request.cache : undefined) });
      if (url === CURRENT_URL) {
        if (currentFails) throw new Error('offline');
        return Response.json({ version: current });
      }
      if (offline) throw new Error('offline');
      if (url.endsWith('/zagreb.json')) return Response.json({ version: current, revealPacks: 4,
        packs: ['pack0.bin.gz', 'pack1.bin.gz', 'pack2.bin.gz', 'pack3.bin.gz', 'pack4.bin.gz', 'pack5.bin.gz'] });
      return new Response('from network', { status: responseStatus });
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), context);
  return {
    events, requests, writes, deleted, cachesByName,
    setOffline: value => { offline = value; },
    setResponseStatus: value => { responseStatus = value; },
    fetchEvent(request) {
      let response;
      events.fetch({ request, respondWith: value => { response = value; } });
      return response;
    },
  };
}

test('versioned map data is cached per version after one network fetch, including while offline', async () => {
  const c = workerContext();
  const request = new Request('https://example.test/map/data/v20261108-live/city_height.bin.gz');
  const first = await c.fetchEvent(request);
  assert.equal(first.status, 200);
  assert.deepEqual(c.writes, [{ cache: 'zagreb-map-data-v20261108-live', url: request.url }]);
  c.setOffline(true);
  const second = await c.fetchEvent(request);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'from network');
  assert.equal(c.requests.length, 1);
});

test('a worker at the site root still caches its versioned data offline', async () => {
  const c = workerContext({ scope: 'https://example.test/' });
  const request = new Request('https://example.test/data/v20261108-live/pack0.bin.gz');
  assert.equal((await c.fetchEvent(request)).status, 200);
  c.setOffline(true);
  assert.equal(await (await c.fetchEvent(request)).text(), 'from network');
  assert.equal(c.writes.length, 1);
  assert.equal(c.requests.length, 1);
});

test('only same-origin GET data files are intercepted; unsuccessful and partial responses are not cached', async () => {
  const c = workerContext();
  for (const request of [
    new Request('https://example.test/map/data/current.json'),
    new Request('https://example.test/map/rt'),
    new Request('https://other.test/map/data/v20261108-live/pack0.bin.gz'),
    new Request('https://example.test/elsewhere/data/v20261108-live/pack0.bin.gz'),
    new Request('https://example.test/map/data/v20261108-live/a..b/pack0.bin.gz'),
    new Request('https://example.test/map/data/v20261108-live/pack0.bin.gz', { method: 'POST' }),
  ]) assert.equal(c.fetchEvent(request), undefined);
  for (const status of [404, 206]) {
    c.setResponseStatus(status);
    const request = new Request(`https://example.test/map/data/v20261108-live/status-${status}.bin`);
    const response = await c.fetchEvent(request);
    assert.equal(response.status, status);
  }
  assert.equal(c.writes.length, 0);
});

test('install precaches config and reveal packs so the next navigation is offline-ready', async () => {
  const c = workerContext();
  let installing;
  c.events.install({ waitUntil: promise => { installing = promise; } });
  await installing;
  const cached = ['zagreb.json', 'pack0.bin.gz', 'pack1.bin.gz', 'pack2.bin.gz', 'pack3.bin.gz']
    .map(name => `https://example.test/map/data/v20261108-live/${name}`);
  assert.deepEqual(c.writes.map(row => row.url).sort(), cached.toSorted());
  c.setOffline(true);
  const beforeSecondNavigation = c.requests.length;
  for (const url of cached) {
    const response = await c.fetchEvent(new Request(url));
    if (url.endsWith('/zagreb.json')) assert.equal((await response.json()).version, 'v20261108-live');
    else assert.equal(await response.text(), 'from network');
  }
  assert.equal(c.requests.length, beforeSecondNavigation, 'second navigation must hit the installed cache, not network');
  assert.equal(c.writes.some(row => row.url.endsWith('pack4.bin.gz')), false, 'noncritical packs do not hold install');
});


test('activation reads current.json with no-store and deletes only old map-version caches', async () => {
  const c = workerContext();
  let activated;
  c.events.activate({ waitUntil: promise => { activated = promise; } });
  await activated;
  assert.deepEqual(c.requests, [{ url: CURRENT_URL, cache: 'no-store' }]);
  assert.deepEqual(c.deleted, ['zagreb-map-data-v20261101-old']);
});

test('activation keeps every cache when the current pointer cannot be fetched or is unsafe', async () => {
  for (const options of [{ currentFails: true }, { current: '../escape' }, { current: null }]) {
    const c = workerContext(options);
    let activated;
    c.events.activate({ waitUntil: promise => { activated = promise; } });
    await activated;
    assert.deepEqual(c.deleted, []);
  }
});

test('version offers are validated and ordered without lexicographic date or suffix mistakes', () => {
  assert.equal(showNewVersion({ current: 'v20261108-live', offered: 'v20261108-live' }), false);
  assert.equal(showNewVersion({ current: 'v20261108-live', offered: 'v20261109-live' }), true);
  assert.equal(showNewVersion({ current: 'v20261109-live', offered: 'v20261108-live' }), false);
  assert.equal(showNewVersion({ current: 'v20261109-live', offered: 'v20261110-live' }), true);
  assert.equal(showNewVersion({ current: 'v20261103-lite', offered: 'v20261103-fix' }), true);
  for (const offered of ['v20260230', 'v20261110-bad..suffix', 'v10', '../v20261110', 'v20261110/../../x', '', null, undefined, 20261110]) {
    assert.equal(showNewVersion({ current: 'v20261108-live', offered }), false, String(offered));
  }
  assert.equal(showNewVersion({ current: 'not-a-version', offered: 'v20261110-live' }), false);
});

test('monitor registers sw.js, polls current.json without caching, and offers one chip per publication', async () => {
  const registrations = [], calls = [], offers = [], timers = [];
  let offered = 'v20261108-live';
  const monitor = makeMapUpdateMonitor({
    currentVersion: 'v20261108-live',
    serviceWorker: { register: async (...args) => { registrations.push(args); return { scope: '/map/' }; } },
    fetchJson: async (...args) => { calls.push(args); return { version: offered }; },
    onNewVersion: version => offers.push(version),
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  await monitor.start();
  assert.deepEqual(registrations, [['sw.js']]);
  assert.deepEqual(calls, [['data/current.json', { cache: 'no-store' }]]);
  assert.deepEqual(offers, []);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  offered = 'v20261109-live';
  assert.equal(await monitor.check(), true);
  assert.deepEqual(offers, ['v20261109-live']);
  assert.equal(await monitor.check(), false);
  assert.deepEqual(offers, ['v20261109-live']);
});

test('monitor survives offline polls and an unavailable service-worker API', async () => {
  const calls = [];
  const monitor = makeMapUpdateMonitor({
    currentVersion: 'v20261108-live', serviceWorker: null,
    fetchJson: async () => { calls.push(1); throw new Error('offline'); },
    onNewVersion: () => { throw new Error('must not offer'); },
    schedule: () => {},
  });
  await monitor.start();
  assert.equal(await monitor.check(), false);
  assert.equal(calls.length, 2);
});

test('a registration policy failure is logged and does not stop update checks', async () => {
  const offers = [], errors = [], timers = [];
  const failure = new Error('registration blocked');
  const monitor = makeMapUpdateMonitor({
    currentVersion: 'v20261108-live',
    serviceWorker: { register: async () => { throw failure; } },
    fetchJson: async () => ({ version: 'v20261109-live' }),
    onNewVersion: version => offers.push(version),
    onError: error => errors.push(error),
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  await monitor.start();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(offers, ['v20261109-live']);
  assert.deepEqual(timers.map(timer => timer.ms), [60_000]);
});

test('update chip is explicit and reloads only when clicked', () => {
  const listeners = {}, appended = [];
  const button = { hidden: true, dataset: {}, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const document = { createElement: tag => { assert.equal(tag, 'button'); return button; }, body: { append: el => appended.push(el) } };
  let reloads = 0;
  const show = makeMapUpdateChip({ document, reload: () => { reloads++; } });
  show('v20261109-live');
  assert.equal(button.textContent, 'Nova verzija karte · Osvježi');
  assert.equal(button.hidden, false);
  assert.equal(button.dataset.version, 'v20261109-live');
  assert.deepEqual(appended, [button]);
  assert.equal(reloads, 0);
  listeners.click();
  assert.equal(reloads, 1);
});
