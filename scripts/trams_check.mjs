// The trams on the map (web/trams-layer.js): how many are drawn, that the layer costs no console error, that a tram
// under the pointer says which line, where it is headed and its next stop, and what the binaries weigh on the wire.
// Screenshots go to web/data/trams_check.png (the close view) and trams_check_tip.png (under the pointer).
//   node scripts/trams_check.mjs [baseUrl]
// Prints JSON: counts, first-load bytes of the tram files, the tooltip's text at a tram and away from it, errors and
// failed requests. Headless draws the city in software, a few frames a second, so every wait is a poll, not a sleep.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://127.0.0.1:8653/';
const shot = fileURLToPath(new URL('../web/data/trams_check.png', import.meta.url));
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [], failed = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message} @ ${(e.stack || '').split('\n')[1] || '?'}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 240_000 });
await page.waitForFunction(() => !!window.__dbg?.trams, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__dbg.trams.vehicles > 0 || window.__dbg.trams.liveAt > 0, null, { timeout: 60_000 })
  .catch(() => {});   // a feed that is down leaves the timetable running; the counts say so

const counts = await page.evaluate(() => {
  const t = window.__dbg.trams;
  return { ...t.drawn, liveVehiclesInFeed: t.vehicles, liveAt: t.liveAt, on: t.on,
    tripsInSchedule: t.net.nTrips, lines: t.net.trams.lines.length, vehicle: t.net.trams.vehicle };
});
const bytes = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter(e => /trams_(shapes|trips|stops|rails)\.bin\.gz|trams\.json/.test(e.name))
  .map(e => ({ file: e.name.split('/').pop(), transferSize: e.transferSize, encoded: e.encodedBodySize })));

// A tram fills the frame: a live one if the feed has any, else the first the timetable puts on the street. The app's
// own flight moves the camera; it has landed when it stands on the tram and the camera has stopped.
const at = await page.evaluate(() => {
  const d = window.__dbg, list = d.trams.list;
  const pickOne = list.find(o => o.live) || list[0];
  if (!pickOne) return null;
  d.flyTo(pickOne.x, pickOne.z, null, 200);
  return { trip: pickOne.trip, live: pickOne.live, x: Math.round(pickOne.x), z: Math.round(pickOne.z) };
});
await page.waitForFunction(p => {
  const d = window.__dbg, tgt = d.controls.target;
  return Math.hypot(tgt.x - p[0], tgt.z - p[1]) < 20 && d.camera.position.distanceTo(tgt) < 260;
}, [at.x, at.z], { timeout: 240_000, polling: 500 });
await page.waitForTimeout(2000);   // a frame or two where it landed

// The tram's own pixels: every drawn tram is projected again and the one nearest the middle of the frame whose
// middle pixel and four neighbours all hit is the spot the pointer goes to (a live tram can move a hundred metres
// between two feeds, so this is done again right before each hover).
const findTram = () => page.evaluate(() => {
  const d = window.__dbg, t = d.trams, w = innerWidth, h = innerHeight;
  let best = null;
  for (const o of t.list) {
    const v = d.camera.position.clone().set(o.x, d.surfaceAt(o.x, o.z) + 1.6, o.z).project(d.camera);
    if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) continue;
    const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
    const hit = t.hitAt(x, y, w, h);
    if (!hit) continue;
    if (![[3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dy]) => t.hitAt(x + dx, y + dy, w, h))) continue;
    const score = Math.hypot(x - w / 2, y - h / 2);
    if (!best || score < best.score) best = { x: Math.round(x), y: Math.round(y), trip: hit.trip, live: hit.live, depth: Math.round(hit.depth), score };
  }
  return best || { x: null, drawn: t.drawn, visible: t.group.visible };
});
let seen = await findTram();
await page.screenshot({ path: shot, timeout: 180_000 });

const tip = () => page.evaluate(() => {
  const el = document.querySelector('#tram-tip');
  const r = el.getBoundingClientRect();
  return { hidden: el.hidden, text: el.innerText.replace(/\s+/g, ' ').trim(), box: [r.x, r.y, r.width, r.height].map(Math.round) };
});

const out = { counts, bytes, tram: at, seen, errors: [], failed };
for (let i = 0; i < 3 && !out.onTram; i++) {          // three goes: the feed may move the tram between scan and hover
  if (i) { seen = await findTram(); out.attempts = i + 1; }
  if (seen.x === null) { await page.waitForTimeout(4000); continue; }
  await page.mouse.move(seen.x + 120, seen.y - 90);
  await page.mouse.move(seen.x, seen.y, { steps: 2 });
  await page.waitForFunction(() => !document.querySelector('#tram-tip').hidden, null, { timeout: 25_000, polling: 200 })
    .catch(() => {});
  const t = await tip();
  if (!t.hidden) out.onTram = t;
}
if (out.onTram) {
  out.seenAtTip = seen;
  await page.screenshot({ path: shot.replace('.png', '_tip.png'), timeout: 180_000 });
  await page.mouse.move(seen.x + 420, seen.y + 280, { steps: 2 });
  await page.waitForFunction(() => document.querySelector('#tram-tip').hidden, null, { timeout: 40_000, polling: 250 })
    .catch(() => {});
  out.away = await tip();
  out.screenshot = shot;
}
out.errors = errors;
console.log(JSON.stringify(out, null, 2));
await browser.close();
