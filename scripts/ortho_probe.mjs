#!/usr/bin/env node
// What the orthophoto clipmap (issue #36) costs: the tile bytes it pulls per minute standing still and while flying, and
// what the three extra texture levels do to a frame. Runs one camera twice — with the tile base and with the mean colours
// only — on one server of this checkout:
//   python3 scripts/serve.py 8653
//   node scripts/ortho_probe.mjs [--ortho /data/ortho/] [--at 0,0] [--dist 300] [--seconds 20]
// The still run measures two windows: the first also catches whatever of the opening burst is still arriving, the second
// is the steady state, which must pull nothing. Headless Chromium renders on SwiftShader, so the frame rates are software
// ones (about one frame a second at a full screen of terrain): the delta between the runs is the number to read.
import { chromium } from '@playwright/test';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const base = arg('--url', 'http://127.0.0.1:8653/');
const ortho = arg('--ortho', '/data/ortho/');
const [atX, atZ] = arg('--at', '0,0').split(',').map(Number);
const dist = Number(arg('--dist', 300));
const seconds = Number(arg('--seconds', 20));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});

// One window of frames at a standing camera. The tile counts are the clipmap's own (its worker posts each tile's bytes:
// a Worker's fetches reach neither the page's resource timeline nor its CDP network session), differenced across the
// window. The renderer's own render is wrapped so a frame's submit time is measured on the real call, and every animation
// frame wakes the scheduler, which otherwise sleeps at frameDue = Infinity and measures nothing.
async function still(page, seconds) {
  const before = await page.evaluate(() => window.__dbg.clipStats());
  const f0 = await page.evaluate(() => { window.__frames = []; return window.__dbg.renderer.info.render.frame; });
  const start = Date.now();
  await page.waitForTimeout(seconds * 1000);
  const elapsed = (Date.now() - start) / 1000;
  const out = await page.evaluate(() => {
    const frames = window.__frames.slice().sort((a, b) => a - b);
    const at = p => (frames.length ? frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] : 0);
    const s = window.__dbg.stats();
    return { frames: window.__dbg.renderer.info.render.frame, ms: frames, calls: s.calls, triangles: s.triangles,
      textures: s.textures, clip: window.__dbg.clipStats() };
  });
  const ms = out.ms.slice().sort((a, b) => a - b);
  const at = p => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : 0);
  const from = before || { loaded: 0, bytes: 0 }, to = out.clip || { loaded: 0, bytes: 0 };
  return {
    seconds: Math.round(elapsed), tileRequests: to.loaded - from.loaded, tileBytes: to.bytes - from.bytes,
    clipReady: !!out.clip,
    frames: out.frames - f0, fps: Math.round((out.frames - f0) / elapsed * 10) / 10,
    renderMs: { mean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length * 10) / 10 : 0,
      p50: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10 },
    calls: out.calls, triangles: out.triangles, textures: out.textures, clip: out.clip,
  };
}

async function load(withTiles) {
  const query = new URLSearchParams({ weather: 'none', at: `${atX},${atZ}`, dist: String(dist) });
  if (withTiles) query.set('ortho', ortho);
  const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [], notFound = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) notFound.push(`${r.status()} ${r.url().replace(base, '')}`); });
  await page.goto(`${base}?${query}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
  await page.waitForTimeout(2000);   // the flight to the square is 1.4 s
  await page.evaluate(() => {
    const r = window.__dbg.renderer, original = r.render.bind(r);
    window.__frames = [];
    r.render = (...args) => { const t0 = performance.now(); const out = original(...args); window.__frames.push(performance.now() - t0); return out; };
    const pump = () => { window.__dbg.wake(); window.__dbg.invalidate(); requestAnimationFrame(pump); };
    requestAnimationFrame(pump);
  });
  return { context, page, errors, notFound };
}

// The tiles of the three levels are requested by afterReveal's 'ortho' lane, which waits for the roof and ground colours,
// and each arrival waits for a frame (a level redraw + upload) that this software rasteriser gives at about one a second:
// the wait here is for the burst to be complete, so the still window after it measures the steady state honestly.
const on = await load(true);
const burst = await on.page.waitForFunction(() => {
  const s = window.__dbg?.clipStats?.();
  return !!s && s.loaded > 0 && s.loaded === s.asked && s.flying === 0;
}, null, { timeout: 240_000, polling: 500 }).then(() => true).catch(() => false);
const stillSteady = await still(on.page, seconds);
const clipAfter = await on.page.evaluate(() => window.__dbg.clipStats());
// The flying camera, through the map's own flight (flyTo), so it is the real camera path: 200 m out, a quarter turn
// every 3 s, at the same 300 m.
await on.page.evaluate(() => {
  let i = 0;
  window.__dbg.flyTo(200, 0, null, 300);
  window.__flight = setInterval(() => { const a = (i++ * Math.PI) / 2; window.__dbg.flyTo(Math.cos(a) * 200, Math.sin(a) * 200, null, 300); }, 3000);
});
const moving = await still(on.page, seconds);
const movingClip = await on.page.evaluate(() => { clearInterval(window.__flight); return window.__dbg.clipStats(); });
await on.context.close();

const off = await load(false);
const offStill = await still(off.page, seconds);
const offSteady = await still(off.page, seconds);
await off.page.evaluate(() => {
  let i = 0;
  window.__dbg.flyTo(200, 0, null, 300);
  window.__flight = setInterval(() => { const a = (i++ * Math.PI) / 2; window.__dbg.flyTo(Math.cos(a) * 200, Math.sin(a) * 200, null, 300); }, 3000);
});
const offMoving = await still(off.page, seconds);
await off.context.close();
await browser.close();

const perMin = (run, n) => Math.round(n / run.seconds * 60);
console.log(JSON.stringify({
  point: { x: atX, z: atZ, distM: dist }, ortho, viewport: '640x360, SwiftShader', windowSeconds: seconds,
  tiles: {
    burstDone: burst,
    openingBurst: { requests: stillSteady.clip ? clipAfter.loaded : 0, bytes: clipAfter ? clipAfter.bytes : 0,
      levelTotals: clipAfter && { index: clipAfter.indexBytes, indexLevels: clipAfter.levels.map(l => [l.res, l.tiles, l.bytes]) } },
    still: { requests: stillSteady.tileRequests, bytes: stillSteady.tileBytes, bytesPerMin: perMin(stillSteady, stillSteady.tileBytes) },
    moving: { requests: moving.tileRequests, bytes: moving.tileBytes, bytesPerMin: perMin(moving, moving.tileBytes),
      tilesPerMin: perMin(moving, moving.tileRequests),
      meanTileBytes: moving.tileRequests ? Math.round(moving.tileBytes / moving.tileRequests) : 0 },
    movingTotal: { asked: movingClip.asked, loaded: movingClip.loaded, bytes: movingClip.bytes, failed: movingClip.failed },
  },
  frame: {
    fps: { stillOn: stillSteady.fps, stillOff: offSteady.fps, movingOn: moving.fps, movingOff: offMoving.fps },
    frames: { stillOn: stillSteady.frames, stillOff: offSteady.frames, movingOn: moving.frames, movingOff: offMoving.frames },
    renderMs: { stillOn: stillSteady.renderMs, stillOff: offSteady.renderMs, movingOn: moving.renderMs, movingOff: offMoving.renderMs },
    calls: { on: stillSteady.calls, off: offSteady.calls }, triangles: { on: stillSteady.triangles, off: offSteady.triangles },
    textures: { on: stillSteady.textures, off: offSteady.textures },
  },
  credit: clipAfter?.credit, errors: [...on.errors, ...off.errors], notFound: on.notFound,
}, null, 2));
