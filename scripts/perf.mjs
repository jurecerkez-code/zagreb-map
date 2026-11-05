#!/usr/bin/env node
// Measures what the map costs: triangles and draw calls at three distances, bytes before the reveal and in total,
// 404s, and the main-thread builders (performance.measure). Optional --budget file: exits 1 when a number is over.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

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
let bytes = 0, bytesBeforeReveal = null, http404 = 0, optional404 = 0;
const files = [], notFound = [];
page.on('response', async r => {
  if (r.status() === 404) {
    const path = r.url().replace(url, '');
    if (OPTIONAL_404.has(path)) optional404++; else { http404++; notFound.push(path); }
  }
  const len = Number((await r.allHeaders().catch(() => ({})))['content-length'] || 0);
  bytes += len;
  files.push([len, r.url().replace(url, '')]);
});
const t0 = Date.now();
await page.goto(`${url}?debug=1`);
await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180000 });
bytesBeforeReveal = bytes;
const msReveal = Date.now() - t0;
await page.waitForFunction(() => { const s = window.__dbg?.stats(); return s && s.tiles >= s.tilesTotal && s.terrain === 'ready'; },
  null, { timeout: 300000 });
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
const result = {
  url, msReveal, bytesBeforeReveal, bytesTotal: bytes, requests: files.length, http404, optional404, notFound,
  heaviest: files.sort((a, b) => b[0] - a[0]).slice(0, 15).map(([n, f]) => `${(n / 1e6).toFixed(2)} MB ${f}`),
  home, near, far, builders: marks,
};
console.log(JSON.stringify(result, null, 1));
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
await browser.close();

if (budget) {
  const get = k => k.split('.').reduce((o, p) => o?.[p], result);
  const over = Object.entries(budget).filter(([k, v]) => get(k) != null && get(k) > v);
  for (const [k, v] of over) console.error(`over budget: ${k} = ${get(k)} > ${v}`);
  process.exit(over.length ? 1 : 0);
}
