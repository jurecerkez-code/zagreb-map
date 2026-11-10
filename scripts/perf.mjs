#!/usr/bin/env node
// Measures what the map costs: triangles and draw calls at three distances, bytes before the reveal and in total,
// 404s, and the main-thread builders (performance.measure). Optional --budget file: exits 1 when a number is over.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { numericBudgetFailures } from './load-gates.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8643/';
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const budget = arg('--budget') ? JSON.parse(readFileSync(arg('--budget'), 'utf8')) : null;
const out = arg('--out');

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Optional by design on a plain file server (and on Pages): the trams' live proxy and the deploy-stamped build
// card. The page falls back for both. The 404 budget counts everything else, so a mistyped fetch path fails at 1.
const OPTIONAL_404 = new Set(['rt', 'build.json']);
let bytesBeforeReveal = null, http404 = 0, optional404 = 0;
const files = [], notFound = [];
// A page warning is as good as a log line here — a stalled pack lane was last seen silent (run 42011722454).
// #24: a broken shader fails the gate, loudly: three logs its compile errors on the console and the picture would
// degrade quietly otherwise.
const shaderErrors = [], warnings = [];
page.on('console', m => {
  const text = m.text();
  if (m.type() === 'warning' || m.type() === 'error') console.log(`[page] ${text}`);
  if (m.type() === 'error' && /Shader Error|WebGLProgram|validateStatus/.test(text)) shaderErrors.push(text);
  if (m.type() === 'warning' && /shader|WebGL/i.test(text)) warnings.push(text);
});
page.on('response', async r => {
  if (r.status() === 404) {
    const path = r.url().replace(url, '');
    if (OPTIONAL_404.has(path)) optional404++; else { http404++; notFound.push(path); }
  }
  const len = Number((await r.allHeaders().catch(() => ({})))['content-length'] || 0);
  files.push([len, r.url().replace(url, '')]);
});
const t0 = Date.now();
// The reveal's own byte count comes from the browser's resource timing, not from the response handler above: those
// race the reveal (a pack that is half in when the overlay hides lands on whichever side the loop is on) and count
// a response twice when the service worker precaches what the page has already fetched. The load probe reads the
// same entries, so the two gates agree on one number.
await page.addInitScript(() => {
  window.__revealAudit = { at: null, bytes: 0 };
  document.addEventListener('DOMContentLoaded', () => {
    const sample = () => {
      if (!document.getElementById('loading')?.hidden || window.__revealAudit.at !== null) return;
      window.__revealAudit.at = performance.now();
      window.__revealAudit.bytes = performance.getEntriesByType('resource')
        .filter(e => e.startTime <= window.__revealAudit.at).reduce((n, e) => n + e.transferSize, 0);
    };
    new MutationObserver(sample).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
    sample();
  }, { once: true });
});
// Measure the city, not its weather: ?weather=none keeps snowfall off the byte budget.
await page.goto(`${url}?debug=1&weather=none`);
await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180000 });
bytesBeforeReveal = await page.evaluate(() => window.__revealAudit.bytes);
const msReveal = Date.now() - t0;
// Throughput is capped by software-GL rendering: at the trams-in-view tier the map holds 20 fps while tiles stream,
// so a full city on SwiftShader can need a quarter hour. Say so while waiting (the silence reads as a hang).
const progress = setInterval(async () => {
  try { const s = await page.evaluate(() => window.__dbg?.stats?.() ?? {}); console.log(`[perf] tiles ${s.tiles ?? '?'}/${s.tilesTotal ?? '?'} (terrain ${s.terrain ?? '?'})`); } catch { /* page mid-nav */ }
}, 30_000);
await page.waitForFunction(() => { const s = window.__dbg?.stats(); return s && s.tiles >= s.tilesTotal && s.terrain === 'ready'; },
  null, { timeout: 900000 });
clearInterval(progress);
await page.waitForTimeout(8000);

const sample = () => page.evaluate(() => {
  const { renderer, scene, camera } = window.__dbg;
  renderer.info.autoReset = false; renderer.info.reset();
  renderer.render(scene, camera);
  const all = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  const groups = {};
  const tops = scene.children, vis = tops.map(o => o.visible);
  tops.forEach((o, i) => {
    if (!vis[i]) return;
    tops.forEach((p, j) => { p.visible = i === j; });
    renderer.info.reset(); renderer.render(scene, camera);
    const name = o.name || o.type;
    groups[name] = (groups[name] || 0) + renderer.info.render.triangles;
  });
  tops.forEach((o, i) => { o.visible = vis[i]; });
  renderer.info.autoReset = true;
  return { ...all, groups };
});
const at = async d => {
  await page.evaluate(d => { d === 'home' ? window.__dbg.goHome() : window.__dbg.viewAt(d); window.__dbg.invalidate?.(2000); }, d);
  await page.waitForTimeout(3000);
  // A view change streams new packs, and slow machines measure the map half-loaded while fast ones measure it whole
  // (first run: 25.0 M vs 35.5 M triangles at 20 km, laptop vs CI). Measure steady state: re-sample while the count
  // still moves by more than 1%, at most 6 samples.
  let a = await sample();
  for (let k = 0; k < 5; k++) {
    await page.waitForTimeout(4000);
    const b = await sample();
    if (Math.abs(b.triangles - a.triangles) <= a.triangles * 0.01) return b;
    a = b;
  }
  return a;
};
const home = await at('home'), near = await at(400), far = await at(20000);
const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('measure').map(m => [m.name, Math.round(m.duration)])));
// The whole city from the same source, for the same reason: one entry per resource, no response event counted twice.
const bytesTotal = await page.evaluate(() =>
  performance.getEntriesByType('resource').reduce((n, e) => n + e.transferSize, 0));
const result = {
  url, msReveal, bytesBeforeReveal, bytesTotal, requests: files.length, http404, optional404, notFound,
  heaviest: files.sort((a, b) => b[0] - a[0]).slice(0, 15).map(([n, f]) => `${(n / 1e6).toFixed(2)} MB ${f}`),
  home, near, far, builders: marks, warnings: warnings.length,
};
console.log(JSON.stringify(result, null, 1));
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
await browser.close();

if (shaderErrors.length) {
  console.error(`shader errors on the page: ${shaderErrors.length} (the first: ${shaderErrors[0].slice(0, 300)})`);
  process.exit(1);
}
if (warnings.length) {
  console.error(`shader/WebGL warnings on the page: ${warnings.length} (the first: ${warnings[0].slice(0, 300)})`);
  process.exit(2);
}

if (budget) {
  const get = k => k.split('.').reduce((o, p) => o?.[p], result);
  const measured = Object.fromEntries(Object.keys(budget).map(key => [key, get(key)]));
  const over = numericBudgetFailures(measured, budget);
  for (const failure of over) console.error(`over budget: ${failure}`);
  process.exit(over.length ? 1 : 0);
}
