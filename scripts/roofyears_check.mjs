// Years on the roofs (web/roofyears.js): headless check of the served viewer.
//   node scripts/roofyears_check.mjs [baseUrl] [outDir]
// Flies close over Trg bana Jelačića, screenshots, and prints JSON: console errors, failed requests, how many labels
// show, a sample of their texts against each building's card year line, a private house's decade, frame times with the
// labels on and off, the timeline at 1900 (no label of a later building) and the switch off (no label).
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:8646/';
const outDir = process.argv[3] || '../docs/screens';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [], failed = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', r => failed.push(`FAILED ${r.failure()?.errorText}: ${r.url()}`));
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
// A fresh visit's default (on): the stored choice goes on the first load only, so the reload below reads it back.
await page.addInitScript(() => { try { if (!sessionStorage.getItem('rc')) { localStorage.removeItem('hfh-roof-years'); sessionStorage.setItem('rc', '1'); } } catch {} });
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
await page.waitForFunction(() => { const t = window.__dbg?.terrain?.(); return !t || !t.source || t.state === 'ready' || t.state === 'failed'; }, null, { timeout: 120_000 });

// Over Trg bana Jelačića (45.8130 N, 15.9772 E), looking north-west, 420 m from the square, 50° down.
const view = async ({ dist = 420, el = 50, az = 200, theme } = {}) => page.evaluate(async ({ dist, el, az }) => {
  const { latLonToLocal } = await import('./sweref.js');
  const { version } = await (await fetch('data/current.json')).json();
  const cfg = await (await fetch(`data/${version}/zagreb.json`)).json();
  const [x, z] = latLonToLocal(45.8130, 15.9772, cfg.origin);
  const d = window.__dbg, y = d.surfaceAt(x, z), e = el * Math.PI / 180, a = az * Math.PI / 180;
  d.controls.target.set(x, y, z);
  d.camera.position.set(x + dist * Math.cos(e) * Math.sin(a), y + dist * Math.sin(e), z + dist * Math.cos(e) * Math.cos(a));
  d.controls.update();
  return { x: Math.round(x), z: Math.round(z) };
}, { dist, el, az });
const settle = ms => page.waitForTimeout(ms);
// The loop picks the labels every 6th frame, and swiftshader draws about one frame a second: the check picks them
// itself for the camera as it is now (state), then lets frames draw them before a screenshot (frames).
const state = () => page.evaluate(() => { const d = window.__dbg; d.controls.update(); d.camera.updateMatrixWorld();
  d.roofYears.update(); return d.roofYears.state(); });
const frames = (n = 3) => page.evaluate(n => new Promise(ok => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : ok()); f(); }), n);
const shot = async name => { await state(); await frames(3); await page.screenshot({ path: `${outDir}/${name}` }); };
const fps = async () => { await settle(2500); return page.evaluate(() => window.__dbg.stats().fps); };

const square = await view();
await page.waitForFunction(() => window.__dbg.roofYears.state().shown > 0, null, { timeout: 60_000 }).catch(() => {});
await shot('roofyears_trg.png');
const s1 = await state();
// Each label's text against its building's card year line (web/card.js yearLine, as the card prints it).
const checked = await page.evaluate(async labels => {
  const { yearLine } = await import('./card.js');
  const { makeT } = await import('./i18n.js');
  const T = makeT({ en: await (await fetch('i18n/en.json')).json() }, 'en');
  return labels.map(l => { const b = window.__dbg.building(l.gid);
    return { gid: l.gid, text: l.text, card: yearLine(b, '', T), year: b.year, yflag: b.yflag, private: b.private, top: l.top }; });
}, s1.labels);
const mismatch = checked.filter(c => c.text !== c.card);
const privates = checked.filter(c => c.private);
const exactPrivate = privates.filter(c => /^\d{4}$/.test(c.text.replace('≈ ', '')));

// A private house: the nearest one dated to a decade that is not a century's first (so its text reads "1950s"), flown over.
let privateSample = null;
{
  const near = await page.evaluate(({ x, z }) => {
    const d = window.__dbg; let best = -1, bd = Infinity;
    for (let g = 0; g < d.attrTally.unknown + 400000 && g < 400000; g++) {
      let b; try { b = d.building(g); } catch { break; }
      if (!b.private || b.yflag === 7 || b.yflag === 6 || b.year % 100 < 10) continue;
      const q = (b.x - x) ** 2 + (b.z - z) ** 2; if (q < bd) { bd = q; best = g; }
    }
    return best >= 0 ? { gid: best, ...d.building(best) } : null;
  }, square);
  if (near) {
    await page.evaluate(({ x, z }) => { const d = window.__dbg, y = d.surfaceAt(x, z);
      d.controls.target.set(x, y, z); d.camera.position.set(x + 120, y + 260, z + 160); d.controls.update(); }, near);
    await settle(4000);
    await shot('roofyears_private.png');
    const sp = await state();
    const hit = sp.labels.find(l => l.gid === near.gid);
    const all = await page.evaluate(labels => labels.map(l => ({ ...l, private: window.__dbg.building(l.gid).private })), sp.labels);
    privateSample = { gid: near.gid, year: near.year, yflag: near.yflag, label: hit?.text ?? null,
      privatesShown: all.filter(l => l.private).slice(0, 6).map(l => `${l.gid}: ${l.text}`),
      privateExact: all.filter(l => l.private && /^\d{4}$/.test(l.text.replace('≈ ', ''))).length };
  }
}

// How many show at other distances from the square.
const byDistance = {};
for (const dist of [250, 420, 700, 1200, 3000]) { await view({ dist }); await settle(1500); byDistance[dist] = (await state()).shown; }
// Frame times at the square: labels on, then off (swiftshader, so only the difference means anything): the loop's fps,
// and one render forced to finish (readPixels), median of 15, with the labels' group shown and hidden.
await view();
await settle(2500);
const fpsOn = await fps();
const renderMs = await page.evaluate(() => {
  const d = window.__dbg, r = d.renderer, gl = r.getContext(), px = new Uint8Array(4), g = d.roofYears.group;
  const time = vis => { const t = []; for (let i = 0; i < 15; i++) { g.visible = vis; const t0 = performance.now();
    r.render(d.scene, d.camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0); }
    t.sort((a, b) => a - b); return Math.round(t[7] * 10) / 10; };
  const on = time(true), off = time(false); g.visible = true;
  return { on, off, calls: r.info.render.calls };
});
await page.evaluate(() => window.__dbg.setRoofYears(false));
const fpsOff = await fps();
await page.evaluate(() => window.__dbg.setRoofYears(true));
await settle(2500);
// CPU cost of one pick (every 6th frame) and of one step (every frame), measured in the page.
const updateMs = await page.evaluate(() => { const r = window.__dbg.roofYears, t0 = performance.now();
  for (let i = 0; i < 20; i++) r.update(); const u = (performance.now() - t0) / 20, t1 = performance.now();
  for (let i = 0; i < 200; i++) r.step(0.016); const s = (performance.now() - t1) / 200;
  return { update: Math.round(u * 100) / 100, step: Math.round(s * 1000) / 1000 }; });

// The timeline at 1900: no label of a building from after 1900.
await page.evaluate(() => { window.__dbg.uniforms.uYear.value = 1900; });
await shot('roofyears_1900.png');
const s1900 = await state();
const after1900 = await page.evaluate(labels => labels.filter(l => window.__dbg.building(l.gid).year > 1900).map(l => `${l.gid}: ${l.text}`), s1900.labels);
const yearMax = await page.evaluate(async () => { const { version } = await (await fetch('data/current.json')).json();
  return (await (await fetch(`data/${version}/zagreb.json`)).json()).yearMax; });
await page.evaluate(y => { window.__dbg.uniforms.uYear.value = y; }, yearMax);
await settle(1500);

// Every look: the labels still draw (texture rebuilt in the look's font), screenshot of the dark one.
const looks = {};
for (const th of ['kalk', 'blatimme', 'paper', 'arg']) {
  await page.locator('.look-open').click();
  await page.locator(`[data-look="${th}"]`).click();
  await page.keyboard.press('Escape');
  await settle(1500);
  if (th === 'blatimme') await shot('roofyears_blatimme.png');
  looks[th] = (await state()).shown;
}

// The Look panel's switch: off gives no label (and is remembered), on brings them back.
await page.locator('.look-open').click();
const switchLabel = await page.locator('#roof-years-on').innerText();
await page.locator('#roof-years-on').click();
await page.keyboard.press('Escape');
await shot('roofyears_off.png');
const off = await state();
const stored = await page.evaluate(() => localStorage.getItem('hfh-roof-years'));
await page.reload();
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
const afterReload = await page.evaluate(() => window.__dbg.roofYears.on);
await page.evaluate(() => window.__dbg.setRoofYears(true));

console.log(JSON.stringify({
  errors, failed, square,
  shown: s1.shown, glyphs: s1.glyphs,
  sample: checked.slice(0, 15).map(c => `${c.gid}: "${c.text}" (card "${c.card}", yflag ${c.yflag}${c.private ? ', private' : ''}, top ${c.top} m)`),
  mismatch: mismatch.slice(0, 10), privatesInView: privates.length, exactPrivate: exactPrivate.length, privateSample,
  fps: { on: fpsOn, off: fpsOff }, renderMs, cpuMs: updateMs, byDistance,
  timeline1900: { shown: s1900.shown, after1900 },
  looks, switch: { label: switchLabel, shownOff: off.shown, glyphsOff: off.glyphs, stored, onAfterReload: afterReload },
}, null, 1));
await browser.close();
