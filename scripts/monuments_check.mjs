// Monuments (web/monuments.js): headless check of the served viewer.
//   node scripts/monuments_check.mjs [baseUrl] [outDir]
// Flies low over Trg bana Jelačića towards the ban Jelačić statue, screenshots with the monuments on and off (the
// pixel difference around the statue is measured by the caller), clicks the statue (the card opens through the
// layer's own hit test), prints the card's text and whether its photo loaded, the timeline at 1950 (statue hidden:
// removed 1947, back 1990) and 1866/1900 (shown), the Look switch off (none drawn), console errors and failed requests.
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:8648/';
const outDir = process.argv[3] || '../docs/screens';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [], failed = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', r => failed.push(`FAILED ${r.failure()?.errorText}: ${r.url()}`));
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
await page.addInitScript(() => { try { localStorage.removeItem('hfh-monuments'); } catch {} });
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
await page.waitForFunction(() => { const t = window.__dbg?.terrain?.(); return !t || !t.source || t.state === 'ready' || t.state === 'failed'; }, null, { timeout: 120_000 });
await page.waitForFunction(() => !!window.__dbg.monuments, null, { timeout: 60_000 });

const frames = (n = 3) => page.evaluate(n => new Promise(ok => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : ok()); f(); }), n);
// The camera `dist` m from the statue, `el` degrees up, from azimuth `az` (0 = from the south, 90 = from the east).
const view = ({ dist = 55, el = 21, az = 55 } = {}) => page.evaluate(({ dist, el, az }) => {
  const d = window.__dbg, M = d.monuments, j = M.list.find(m => m.qid === 'Q121636557');
  const y = d.surfaceAt(j.x, j.z) + 4.5, e = el * Math.PI / 180, a = az * Math.PI / 180;
  d.controls.target.set(j.x, y, j.z);
  d.camera.position.set(j.x + dist * Math.cos(e) * Math.sin(a), y + dist * Math.sin(e), j.z + dist * Math.cos(e) * Math.cos(a));
  d.controls.update(); d.camera.updateMatrixWorld(); M.place();
  return { x: j.x, z: j.z, cam: d.camera.position.toArray().map(Math.round) };
}, { dist, el, az });
const at = () => page.evaluate(() => { const M = window.__dbg.monuments; return M.screenAt(M.list.find(m => m.qid === 'Q121636557')); });
const shot = async name => { await frames(4); await page.waitForTimeout(800); await frames(2); await page.screenshot({ path: `${outDir}/${name}` }); };

const out = {};
out.loaded = await page.evaluate(() => { const M = window.__dbg.monuments;
  const kinds = {}; for (const m of M.list) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
  return { total: M.list.length, shownToday: M.shownCount(), drawCalls: M.draws(), on: M.on, kinds }; });
out.view = await view();
await page.waitForTimeout(3000);
await view();
// The statue's facing: its shape's front (+x) in the world (x east, z south); it faces south today (hr Wikipedia).
out.jelacicFacing = await page.evaluate(() => { const M = window.__dbg.monuments, g = M.group.children.find(c => c.userData.kind === 'equestrian');
  const m = new (g.matrix.constructor)(); g.getMatrixAt(0, m); const e = m.elements, s = Math.hypot(e[0], e[1], e[2]);
  return { front: [e[0] / s, e[2] / s].map(v => +v.toFixed(2)), lift: +(e[13] - window.__dbg.surfaceAt(e[12], e[14])).toFixed(2) }; });
out.statueScreen = await at();
await shot('monument_jelacic.png');
// the same frame with the layer off, for the caller's pixel difference
await page.evaluate(() => window.__dbg.setMonuments(false));
await shot('monument_jelacic_off.png');
out.offShown = await page.evaluate(() => window.__dbg.monuments.shownCount());
out.lookSwitch = await page.evaluate(() => !!document.getElementById('monuments-on') || 'panel closed');
await page.evaluate(() => window.__dbg.setMonuments(true));
await frames(3);
// The Look panel's switch, clicked as a visitor would: off -> none drawn, on again.
await page.click('.look-open');
await page.waitForSelector('#monuments-on', { timeout: 10_000 }).catch(() => {});
out.lookPanel = await page.evaluate(() => { const el = document.getElementById('monuments-on');
  return el ? { found: true, checked: el.checked ?? el.getAttribute('aria-checked'), label: el.closest('label')?.textContent?.trim() || el.parentElement?.textContent?.trim() } : { found: false }; });
if (out.lookPanel.found) {
  await page.click('#monuments-on');
  await frames(2);
  out.lookPanel.afterClick = await page.evaluate(() => ({ on: window.__dbg.monuments.on, shown: window.__dbg.monuments.shownCount(),
    stored: localStorage.getItem('hfh-monuments') }));
  await page.click('#monuments-on');
  await frames(2);
  out.lookPanel.afterSecondClick = await page.evaluate(() => ({ on: window.__dbg.monuments.on, shown: window.__dbg.monuments.shownCount() }));
}
await page.keyboard.press('Escape');
await page.evaluate(() => document.getElementById('look')?.close?.());
await view();
await frames(3);

// A real click on the statue: the layer's hit test opens its card.
const [sx, sy] = out.statueScreen;
await page.mouse.click(sx, sy);
await page.waitForTimeout(500);
out.cardByClick = await page.evaluate(() => { const c = document.getElementById('card');
  return { hidden: c.hidden, monument: c.classList.contains('monument'), title: c.querySelector('#card-title')?.textContent }; });
if (!out.cardByClick.monument) {
  await page.evaluate(() => { const M = window.__dbg.monuments; window.__dbg.pinMonument(M.list.find(m => m.qid === 'Q121636557'), 900, 120); });
}
await page.waitForFunction(() => { const i = document.querySelector('#card .photo img'); return !i || (i.complete && i.naturalWidth > 0); }, null, { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(1500);
out.card = await page.evaluate(() => { const c = document.getElementById('card'), i = c.querySelector('.photo img');
  return { text: c.innerText, photo: !!i && i.complete && i.naturalWidth > 0, photoSrc: i?.getAttribute('src') || null }; });
await page.screenshot({ path: `${outDir}/monument_jelacic_card.png` });
await page.evaluate(() => window.__dbg.pinCard(-1));

// The timeline: hidden 1947–1989, shown from 1866.
const year = async y => page.evaluate(y => { const d = window.__dbg, M = d.monuments; d.uniforms.uYear.value = y;
  const j = M.list.find(m => m.qid === 'Q121636557'); const [sx, sy] = M.screenAt(j);
  return { year: y, shown: M.shownCount(), jelacicShown: M.under(sx, sy)?.qid === 'Q121636557' }; }, y);
out.timeline = [];
for (const y of [1950, 1866, 1900, 1990]) {
  out.timeline.push(await year(y));
  if (y === 1950 || y === 1900) await shot(`monument_jelacic_${y}.png`);
}
await page.evaluate(() => { const d = window.__dbg; d.uniforms.uYear.value = 1e9; }).catch(() => {});
await page.evaluate(async () => { const d = window.__dbg; const cfg = await (await fetch(`data/${(await (await fetch('data/current.json')).json()).version}/zagreb.json`)).json(); d.uniforms.uYear.value = cfg.yearMax; });

// Cost: CPU ms of place() and a readPixels-synced render with the layer on and off.
out.cost = await page.evaluate(() => { const d = window.__dbg, M = d.monuments, r = d.renderer, px = new Uint8Array(4);
  const t0 = performance.now(); for (let k = 0; k < 20; k++) M.place(); const place = (performance.now() - t0) / 20;
  const render = on => { M.group.visible = on; const t = performance.now(); for (let k = 0; k < 3; k++) { r.render(r.__scene || d.scene || M.group.parent, d.camera); r.getContext().readPixels(0, 0, 1, 1, r.getContext().RGBA, r.getContext().UNSIGNED_BYTE, px); } return (performance.now() - t) / 3; };
  const off = render(false), on = render(true); M.group.visible = true;
  return { placeMs: +place.toFixed(3), renderOffMs: +off.toFixed(1), renderOnMs: +on.toFixed(1) }; });
out.errors = errors;
out.failed = failed;
console.log(JSON.stringify(out, null, 1));
await browser.close();
