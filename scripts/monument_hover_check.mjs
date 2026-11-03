// Monuments hover tip (app.js monTipShow): a statue under the mouse shows its photo, name and year without a click.
//   node scripts/monument_hover_check.mjs [baseUrl]
// Prints JSON: the tip at the statue (visible, photo loaded, text), after moving away (hidden), after a click
// (hidden, the card opens instead), console errors and failed requests.
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

// A visitor's view of the square, the statue small in frame.
await page.evaluate(() => {
  const d = window.__dbg, M = d.monuments, j = M.list.find(m => m.qid === 'Q121636557');
  const y = d.surfaceAt(j.x, j.z) + 4.5, e = 30 * Math.PI / 180, a = 55 * Math.PI / 180, dist = 220;
  d.controls.target.set(j.x, y, j.z);
  d.camera.position.set(j.x + dist * Math.cos(e) * Math.sin(a), y + dist * Math.sin(e), j.z + dist * Math.cos(e) * Math.cos(a));
  d.controls.update(); d.camera.updateMatrixWorld(); M.place();
});
await page.waitForTimeout(2500);
const at = await page.evaluate(() => window.__dbg.monuments.screenAt(window.__dbg.monuments.list.find(m => m.qid === 'Q121636557')));

const tip = () => page.evaluate(() => {
  const t = document.querySelector('.mon-tip');
  if (!t) return { exists: false };
  const img = t.querySelector('img');
  return { exists: true, hidden: t.hidden, text: t.innerText.replace(/\s+/g, ' ').trim(),
    photo: img ? img.complete && img.naturalWidth > 0 : null, src: img?.getAttribute('src') || '' };
});

const out = { statueAt: at, errors: [], failed };
await page.mouse.move(at[0] - 40, at[1] - 40);
await page.mouse.move(at[0], at[1], { steps: 4 });
await page.waitForTimeout(500);
out.onStatue = await tip();
await page.mouse.move(at[0] + 300, at[1] + 200, { steps: 6 });
await page.waitForTimeout(400);
out.away = await tip();
await page.mouse.move(at[0], at[1], { steps: 4 });
await page.waitForTimeout(400);
await page.mouse.click(at[0], at[1]);
await page.waitForTimeout(700);
out.afterClick = await tip();
out.cardOpen = await page.evaluate(() => { const c = document.querySelector('#card, .card');
  return c ? { monument: c.classList.contains('monument'), hidden: c.hidden } : null; });
out.errors = errors;
await browser.close();
console.log(JSON.stringify(out, null, 1));
