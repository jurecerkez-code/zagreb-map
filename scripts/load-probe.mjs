import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { NETWORK_4MBIT, loadProbeFailures } from './load-gates.mjs';

const base = process.env.PROBE_BASE || 'http://127.0.0.1:8684/';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [], missing = [], rejected = [];
const started = Date.now();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', NETWORK_4MBIT);
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('THREE.')) errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) missing.push({ status: r.status(), url: r.url() }); });
page.on('requestfailed', r => rejected.push({ url: r.url(), reason: r.failure()?.errorText }));
page.on('requestfinished', async r => {
  try { r.__response = await r.response(); } catch { /* already closed */ }
});
const result = { base, network: '4 Mbit/s CDP', phases: {}, errors, missing, rejected };
await context.addInitScript(() => {
  window.__loadAudit = { revealedAt: null, requests: [] };
  const sample = () => {
    const loader = document.getElementById('loading');
    if (!loader?.hidden || window.__loadAudit.revealedAt !== null) return;
    window.__loadAudit.revealedAt = performance.now();
    window.__loadAudit.requests = performance.getEntriesByType('resource').filter(entry => entry.startTime <= window.__loadAudit.revealedAt)
      .map(entry => ({ name: entry.name, bytes: entry.transferSize }));
  };
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(sample).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
    sample();
  }, { once: true });
});
try {
  await page.goto(`${base}?weather=none`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180_000 });
  result.phases.revealMs = Date.now() - started;
  result.phases.criticalRequests = await page.evaluate(() => window.__loadAudit.requests);
  result.phases.criticalBytes = result.phases.criticalRequests.reduce((n, row) => n + row.bytes, 0);
  await page.waitForFunction(() => {
    const s = window.__dbg?.stats();
    return s && s.tiles >= s.tilesTotal && s.terrain === 'ready';
  }, null, { timeout: 240_000 });
  result.phases.fullMs = Date.now() - started;
  result.stats = await page.evaluate(() => window.__dbg.stats());
  await page.waitForTimeout(3000);
  const reloadAt = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180_000 });
  result.phases.cachedRevealMs = Date.now() - reloadAt;
  result.phases.cachedRequests = await page.evaluate(() => window.__loadAudit.requests);
  result.phases.cachedCriticalBytes = result.phases.cachedRequests.reduce((n, row) => n + row.bytes, 0);
  result.worker = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.getRegistration();
    return { supported: true, active: !!reg?.active, scope: reg?.scope };
  });
} catch (error) {
  result.fatal = error.stack || String(error);
  process.exitCode = 1;
} finally {
  const failures = loadProbeFailures(result);
  if (failures.length) {
    result.failures = failures;
    for (const failure of failures) console.error(`LOAD BUDGET: ${failure}`);
    process.exitCode = 1;
  }
  fs.mkdirSync('shots', { recursive: true });
  fs.writeFileSync(`shots/load-${new URL(base).port}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, phases: { ...result.phases, criticalRequests: result.phases.criticalRequests?.length } }, null, 2));
  await browser.close();
}
