import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NETWORK_4MBIT, loadProbeFailures, numericBudgetFailures } from '../scripts/load-gates.mjs';

const clean = { errors: [], missing: [], rejected: [], fatal: null };
const phases = (criticalBytes, cachedCriticalBytes, cachedRevealMs) => ({
  criticalBytes, criticalRequests: [], cachedCriticalBytes, cachedRequests: [], cachedRevealMs,
});

test('load probe explicitly emulates 4 Mbit/s rather than calling local throughput 4 Mbit', () => {
  assert.equal(NETWORK_4MBIT.offline, false);
  assert.equal(NETWORK_4MBIT.downloadThroughput, 500_000);
  assert.ok(NETWORK_4MBIT.uploadThroughput > 0);
});

test('first-load bytes, cached second-load time and browser failures are hard gates', () => {
  assert.deepEqual(loadProbeFailures({ ...clean, phases: phases(6_000_000, 0, 1499) }), []);
  assert.deepEqual(loadProbeFailures({ ...clean, phases: phases(6_000_001, 0, 1499) }),
    ['first-load bytesBeforeReveal 6000001 exceeds 6000000']);
  assert.deepEqual(loadProbeFailures({ ...clean, phases: phases(1, 0, 1500) }),
    ['second-load reveal 1500 ms must be under 1500 ms at 4 Mbit/s']);
  assert.match(loadProbeFailures({ ...clean, errors: ['boom'], phases: phases(1, 0, 1) })[0], /page errors/);
  assert.match(loadProbeFailures({ ...clean, missing: [{ status: 404 }], phases: phases(1, 0, 1) })[0], /404/);
  assert.match(loadProbeFailures({ ...clean, rejected: [{ reason: 'offline' }], phases: phases(1, 0, 1) })[0], /failed requests/);
  assert.match(loadProbeFailures({ ...clean, phases: { ...phases(1, 0, 1), cachedCriticalBytes: null } })[0], /second-load/);
});

test('the checked-in perf enforcement is 6 MB and truthful about the unmeasured total', async () => {
  const budget = JSON.parse(await readFile(new URL('../scripts/perf-budget.json', import.meta.url), 'utf8'));
  assert.equal(budget.bytesBeforeReveal, 6_000_000);
  assert.equal(budget.bytesTotal, null);
  assert.match(budget.bytesTotalStatus, /pending/);
  const perf = await readFile(new URL('../scripts/perf.mjs', import.meta.url), 'utf8');
  const probe = await readFile(new URL('../scripts/load-probe.mjs', import.meta.url), 'utf8');
  assert.match(perf, /numericBudgetFailures/);
  assert.match(probe, /Network\.emulateNetworkConditions/);
  assert.match(probe, /loadProbeFailures/);
});


test('the real CI and Pages commands split the bundle and run the second-load probe', async () => {
  const pages = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const workflow of [pages, ci]) {
    assert.match(workflow, /web\/app\.js --bundle --format=esm --minify --splitting --outdir=web\/dist/);
    assert.match(workflow, /web\/worker\.js web\/terrain-worker\.js web\/roads-worker\.js --bundle --format=esm --minify --splitting --outdir=web\/dist/);
  }
  assert.match(ci, /PROBE_BASE=http:\/\/127\.0\.0\.1:8684\/ npm run load:probe/);
  assert.match(ci, /shots\/load-8684\.json/);
  assert.match(pages, /uses: actions\/upload-pages-artifact@v3/);
});

test('performance budget skips an explicitly unmeasured total but never relaxes measured limits', () => {
  const budget = { bytesBeforeReveal: 6_000_000, bytesTotal: null, bytesTotalStatus: 'pending real probe' };
  assert.deepEqual(numericBudgetFailures({ bytesBeforeReveal: 6_000_000, bytesTotal: 48_000_000 }, budget), []);
  assert.deepEqual(numericBudgetFailures({ bytesBeforeReveal: 6_000_001, bytesTotal: 1 }, budget),
    ['bytesBeforeReveal=6000001 > 6000000']);
});

test('nothing outside the reveal packs is on the wire before the map opens', async () => {
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  // Two queues: a lane takes the reveal packs' tiles, and the periphery's only once the reveal has happened.
  assert.match(app, /const queue = config\.tiles\.filter\(t => revealNames\.has\(packOf\(t\)\)\)/);
  assert.match(app, /const restQueue = config\.tiles\.filter\(t => !revealNames\.has\(packOf\(t\)\)\)/);
  assert.match(app, /queue\.shift\(\) \?\? \(mapRevealed \? restQueue\.shift\(\) : undefined\)/);
  assert.match(app, /for \(const pump of pumpers\) pump\(\)/);
  // The prewarm is an idle job after the reveal, and the first one: it raced the reveal for the line before.
  assert.match(app, /afterReveal\.add\('restPacks', fetchRestPacks\)/);
  assert.match(app, /order: \['restPacks', 'terrain'/);
  // addTile runs on the first tile, before the map opens: a prewarm there put every pack on the wire first.
  const addTile = app.slice(app.indexOf('function addTile('), app.indexOf('// Tiles come in gzip packs'));
  assert.doesNotMatch(addTile, /fetchRestPacks\(\);/);
});
