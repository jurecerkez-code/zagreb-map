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
// The statue is a few pixels at this distance, and its screen point moves while the ground rises: find a pixel the
// layer itself answers for, rather than trusting the projected centre.
const findHit = () => page.evaluate(() => {
  const M = window.__dbg.monuments, j = M.list.find(m => m.qid === 'Q121636557');
  const p = M.screenAt(j);
  for (let r = 0; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = Math.round(p[0] + dx), y = Math.round(p[1] + dy);
      if (M.under(x, y)?.id === j.id) return [x, y];
    }
  }
  return null;
});
const at = await findHit();
if (!at) throw new Error('the Jelačić statue is not on screen');

const tip = () => page.evaluate(() => {
  const t = document.querySelector('.mon-tip');
  if (!t) return { exists: false };
  const img = t.querySelector('img');
  return { exists: true, hidden: t.hidden, text: t.innerText.replace(/\s+/g, ' ').trim(),
    photo: img ? img.complete && img.naturalWidth > 0 : null, src: img?.getAttribute('src') || '' };
});

// The pointer must rest on it for a beat: pointermove asks monuments.under at most every 110 ms, so a move that lands
// inside that window is dropped (a visitor's steady hand still gets an answer nine times a second).
const hover = async ([x, y]) => {
  await page.mouse.move(x - 40, y - 40);
  await page.waitForTimeout(200);
  await page.mouse.move(x, y, { steps: 2 });
  await page.waitForTimeout(200);
  await page.mouse.move(x + 1, y + 1);
  await page.waitForTimeout(400);
};

const out = { statueAt: at, errors: [], failed };
await hover(at);
out.onStatue = await tip();
await page.mouse.move(at[0] + 300, at[1] + 200, { steps: 6 });
await page.waitForTimeout(400);
out.away = await tip();
await page.mouse.move(at[0] - 1, at[1] - 1);
await page.waitForTimeout(300);
await page.mouse.click(at[0], at[1]);
await page.waitForTimeout(700);
out.afterClick = await tip();
out.cardOpen = await page.evaluate(() => { const c = document.querySelector('#card, .card');
  return c ? { monument: c.classList.contains('monument'), hidden: c.hidden } : null; });
out.errors = errors;
await browser.close();
console.log(JSON.stringify(out, null, 1));
