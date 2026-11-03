// Monuments: click tolerance check (web/monuments.js `under`). A visitor clicks what they SEE: the horse, the flag,
// the plinth, the edge of the silhouette. Every one of those must open the monument's card, not the building behind.
//   node scripts/monument_pick_check.mjs [baseUrl]
// Prints JSON: per click point, which card opened (monument flag + title). Pass: every point on the statue gives the
// monument card. Console errors and failed requests are listed.
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:8642/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [], failed = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
await page.addInitScript(() => { try { localStorage.removeItem('hfh-monuments'); } catch {} });
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
await page.waitForFunction(() => !!window.__dbg?.monuments, null, { timeout: 60_000 });

// A visitor's view of the square: mid height, the statue small in frame (dist metres, el degrees up, az from south).
const view = (dist, el, az) => page.evaluate(({ dist, el, az }) => {
  const d = window.__dbg, M = d.monuments, j = M.list.find(m => m.qid === 'Q121636557');
  const y = d.surfaceAt(j.x, j.z) + 4.5, e = el * Math.PI / 180, a = az * Math.PI / 180;
  d.controls.target.set(j.x, y, j.z);
  d.camera.position.set(j.x + dist * Math.cos(e) * Math.sin(a), y + dist * Math.sin(e), j.z + dist * Math.cos(e) * Math.cos(a));
  d.controls.update(); d.camera.updateMatrixWorld(); M.place();
}, { dist, el, az });
const frames = (n = 3) => page.evaluate(n => new Promise(ok => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : ok()); f(); }), n);
const at = () => page.evaluate(() => window.__dbg.monuments.screenAt(window.__dbg.monuments.list.find(m => m.qid === 'Q121636557')));

const out = { errors: [], failed, clicks: [] };
for (const dist of [55, 220, 700]) {
  await view(dist, dist < 100 ? 21 : 30, 55);
  await page.waitForTimeout(2500);
  await view(dist, dist < 100 ? 21 : 30, 55);
  await frames(4);
  const [sx, sy] = await at();
  // what a visitor aims at: the middle of the statue, its top (rider/flag), its base, and just beside it.
  // Offsets scale with distance: at 700 m the whole statue is about 10 px tall.
  const points = dist < 100 ? [[0, 0], [0, -18], [0, 12], [-14, 0], [14, 0], [-10, -14], [10, -14]]
    : dist < 400 ? [[0, 0], [0, -14], [0, 10], [-12, 0], [12, 0], [-8, -10], [8, -10]]
      : [[0, 0], [0, -8], [0, 8], [-8, 0], [8, 0], [-6, -6], [6, -6]];
  for (const [dx, dy] of points) {
    await page.evaluate(() => { if (window.__dbg.pinCard) window.__dbg.pinCard(-1); });
    await page.mouse.click(sx + dx, sy + dy);
    await page.waitForTimeout(450);
    const card = await page.evaluate(() => {
      const c = document.querySelector('.card') || document.querySelector('#card');
      const t = (c?.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      return { monument: !!c?.classList.contains('monument'), pinned: !!c?.classList.contains('pinned'),
        title: t.find(s => s !== '×' && !s.startsWith('Photo:')) || '' };
    });
    out.clicks.push({ dist, dx, dy, ...card });
  }
}
out.errors = errors;
await browser.close();
console.log(JSON.stringify(out, null, 1));
